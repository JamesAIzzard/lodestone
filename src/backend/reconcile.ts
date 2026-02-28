/**
 * Startup reconciliation — ensures the database is in sync with disk.
 *
 * Walks the silo's directories, compares against the database,
 * and queues files for indexing or removal as needed.
 *
 * V2: The reconciler no longer touches the database directly. All store
 * operations are performed via async callbacks that route through the
 * store proxy to the worker thread. Database writes are batched: files
 * are prepared (read, extracted, chunked, embedded) one at a time, then
 * flushed via the proxy in bulk every BATCH_SIZE files.
 */

import fs from 'node:fs';
import path from 'node:path';
import { prepareFile, type PreparedFile, type FileStage } from './pipeline';
import { makeStoredKey, resolveStoredKey } from './store/paths';
import type { FlushUpsert, FlushDelete, FlushResult, DirEntry } from './store/types';
import type { EmbeddingService } from './embedding';
import type { ResolvedSiloConfig } from './config';
import type { ActivityEventType } from '../shared/types';
import { matchesAnyPattern } from './pattern-match';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ReconcileProgress {
  phase: 'scanning' | 'indexing' | 'removing' | 'done';
  current: number;
  total: number;
  filePath?: string;
  /** Chunks accumulated in the current batch (resets to 0 after each flush). */
  batchChunks?: number;
  /** The chunk-count threshold that triggers a batch flush. */
  batchChunkLimit?: number;
  /** Pipeline stage for the current file (reading → extracting → chunking → embedding → flushing). */
  fileStage?: FileStage | 'flushing';
  /** Size of the current file in bytes. */
  fileSize?: number;
  /** Elapsed time since reconciliation started, in milliseconds. */
  elapsedMs?: number;
}

export type ReconcileProgressHandler = (progress: ReconcileProgress) => void;

/** Emitted for each file successfully processed or errored during reconciliation. */
export interface ReconcileEvent {
  filePath: string;
  eventType: ActivityEventType;
  errorMessage?: string;
}

export type ReconcileEventHandler = (event: ReconcileEvent) => void;

export interface ReconcileResult {
  filesAdded: number;
  filesRemoved: number;
  filesUpdated: number;
  durationMs: number;
}

/** Async store operations provided by SiloManager (routed through the store proxy). */
export interface ReconcileStoreOps {
  flush(upserts: FlushUpsert[], deletes: FlushDelete[]): Promise<FlushResult>;
  syncDirectoriesWithDisk(diskDirPaths: DirEntry[]): Promise<string[]>;
  recomputeDirectoryCounts(): Promise<void>;
  checkpoint(mode?: string): Promise<void>;
}

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Maximum chunks to accumulate before flushing to the database in one
 * transaction. ~100 chunks keeps each synchronous SQLite transaction under
 * ~200–400 ms, preventing noticeable UI freezes while still amortising
 * transaction overhead.
 *
 * For small files (~3–10 chunks each) this naturally batches ~10–33 files.
 * For large PDFs (~100 chunks each) it flushes after each file.
 */
const BATCH_CHUNK_LIMIT = 100;

// ── Timing helper ────────────────────────────────────────────────────────────

const TAG = '[reconcile]';

function ms(start: number): string {
  return `${(performance.now() - start).toFixed(1)}ms`;
}

// ── Reconcile ────────────────────────────────────────────────────────────────

/**
 * Reconcile the database with the files on disk.
 *
 * - Files on disk but not in mtimes → index (new files)
 * - Files in mtimes but not on disk → remove (deleted files)
 * - Files where disk mtime differs from stored mtime → re-index (offline edits)
 *
 * The mtimes map is mutated in place: entries are added after successful
 * indexing and removed after successful deletion. The caller is responsible
 * for persisting the updated map to disk.
 */
export async function reconcile(
  config: ResolvedSiloConfig,
  embeddingService: EmbeddingService,
  storeOps: ReconcileStoreOps,
  mtimes: Map<string, number>,
  onProgress?: ReconcileProgressHandler,
  onEvent?: ReconcileEventHandler,
  /** Return true to abort reconciliation early (e.g. silo stop/delete). */
  shouldStop?: () => boolean,
): Promise<ReconcileResult> {
  const start = performance.now();
  let filesAdded = 0;
  let filesRemoved = 0;
  let filesUpdated = 0;

  // 1. Scan disk for all matching files and directories
  console.log(`${TAG} Phase 1: Scanning disk...`);
  const t1 = performance.now();
  onProgress?.({ phase: 'scanning', current: 0, total: 0 });
  const diskAbsPaths = new Map<string, { mtime: number; size: number }>(); // absPath → stat
  const diskDirAbsPaths = new Set<string>(); // all directory absolute paths on disk

  for (const dir of config.directories) {
    walkDirectory(dir, config.extensions, config.ignore, config.ignoreFiles, diskAbsPaths, diskDirAbsPaths);
  }
  console.log(`${TAG} Phase 1 done: ${diskAbsPaths.size} files, ${diskDirAbsPaths.size} dirs on disk (${ms(t1)})`);

  // 2. Build storedKey → { absPath, mtime, size } map from disk scan
  const t2 = performance.now();
  const diskStored = new Map<string, { absPath: string; mtime: number; size: number }>();
  for (const [absPath, { mtime, size }] of diskAbsPaths) {
    try {
      const key = makeStoredKey(absPath, config.directories);
      diskStored.set(key, { absPath, mtime, size });
    } catch {
      // path outside all directories — shouldn't happen with correct globs
    }
  }

  // 3. Determine which files are already indexed from the mtimes map (keyed by stored keys)
  const indexedKeys = new Set(mtimes.keys());

  // 4. Find files to add or update
  const filesToIndex: Array<{ absPath: string; storedKey: string; mtime: number; size: number }> = [];
  for (const [storedKey, { absPath, mtime, size }] of diskStored) {
    if (!indexedKeys.has(storedKey)) {
      filesToIndex.push({ absPath, storedKey, mtime, size });
    } else {
      const storedMtime = mtimes.get(storedKey)!;
      if (mtime !== storedMtime) {
        filesToIndex.push({ absPath, storedKey, mtime, size });
      }
    }
  }

  // 5. Find files to remove (in mtimes but no longer on disk)
  const filesToRemove: string[] = [];
  for (const indexedKey of indexedKeys) {
    if (!diskStored.has(indexedKey)) {
      filesToRemove.push(indexedKey);
    }
  }

  console.log(`${TAG} Phase 2-5: ${filesToIndex.length} to index, ${filesToRemove.length} to remove, ${diskStored.size - filesToIndex.length} already done (${ms(t2)})`);

  // Total reflects all disk files so the UI shows overall progress,
  // not just remaining work.  Already-indexed files count as done.
  const alreadyDone = diskStored.size - filesToIndex.length;
  const totalWork = diskStored.size + filesToRemove.length;

  // 6. Index new and modified files — prepare in a loop, flush in batches
  console.log(`${TAG} Phase 6: Indexing ${filesToIndex.length} files...`);
  const t6 = performance.now();
  let progress = alreadyDone;
  let totalFlushMs = 0;
  let totalWalCheckpointMs = 0;
  let totalPrepareMs = 0;
  let flushCount = 0;

  // Track prepared files and their metadata for the current batch
  let batch: Array<{ prepared: PreparedFile; absPath: string; isUpdate: boolean }> = [];
  let batchChunkCount = 0;

  const flushBatch = async () => {
    if (batch.length === 0) return;
    onProgress?.({
      phase: 'indexing',
      current: progress,
      total: totalWork,
      fileStage: 'flushing',
      batchChunks: batchChunkCount,
      batchChunkLimit: BATCH_CHUNK_LIMIT,
      elapsedMs: performance.now() - start,
    });

    const tFlush = performance.now();
    await storeOps.flush(
      batch.map((b) => ({
        storedKey: b.prepared.storedKey,
        chunks: b.prepared.chunks,
        embeddings: b.prepared.embeddings,
        mtimeMs: b.prepared.mtimeMs,
      })),
      [],
    );
    const flushMs = performance.now() - tFlush;
    totalFlushMs += flushMs;
    flushCount++;

    // Passive WAL checkpoint after each flush — keeps the WAL small so the
    // final TRUNCATE checkpoint at the end of reconciliation is near-instant
    // instead of flushing hundreds of MB in one blocking call.
    const tWal = performance.now();
    try { await storeOps.checkpoint('PASSIVE'); } catch { /* non-critical */ }
    const walMs = performance.now() - tWal;
    totalWalCheckpointMs += walMs;

    console.log(`${TAG}   flush #${flushCount}: ${batch.length} files, ${batchChunkCount} chunks → flush ${flushMs.toFixed(1)}ms, WAL checkpoint ${walMs.toFixed(1)}ms`);

    // Update in-memory mtime map and counters after successful flush
    for (const b of batch) {
      if (b.prepared.mtimeMs !== undefined) {
        mtimes.set(b.prepared.storedKey, b.prepared.mtimeMs);
      }
      if (b.isUpdate) {
        filesUpdated++;
      } else {
        filesAdded++;
      }
      onEvent?.({
        filePath: b.absPath,
        eventType: b.isUpdate ? 'reindexed' : 'indexed',
      });
    }

    batch = [];
    batchChunkCount = 0;
  };

  for (let i = 0; i < filesToIndex.length; i++) {
    if (shouldStop?.()) {
      // Flush any work already prepared, then bail out
      await flushBatch();
      console.log(`${TAG} Stopped early after ${i} / ${filesToIndex.length} files`);
      break;
    }

    const { absPath, storedKey, mtime, size: fileSize } = filesToIndex[i];
    const fileName = absPath.split(/[\\/]/).pop() ?? absPath;

    onProgress?.({
      phase: 'indexing',
      current: ++progress,
      total: totalWork,
      filePath: absPath,
      fileSize,
      fileStage: 'reading',
      batchChunks: batchChunkCount,
      batchChunkLimit: BATCH_CHUNK_LIMIT,
      elapsedMs: performance.now() - start,
    });

    try {
      const tPrep = performance.now();
      const prepared = await prepareFile(absPath, storedKey, embeddingService, mtime, (stage) => {
        onProgress?.({
          phase: 'indexing',
          current: progress,
          total: totalWork,
          filePath: absPath,
          fileSize,
          fileStage: stage,
          batchChunks: batchChunkCount,
          batchChunkLimit: BATCH_CHUNK_LIMIT,
          elapsedMs: performance.now() - start,
        });
      });
      const prepMs = performance.now() - tPrep;
      totalPrepareMs += prepMs;

      // Log slow files (>500ms) individually
      if (prepMs > 500) {
        console.log(`${TAG}   SLOW file: ${fileName} → ${prepMs.toFixed(0)}ms (${prepared.chunks.length} chunks)`);
      }

      const isUpdate = indexedKeys.has(storedKey);
      batch.push({ prepared, absPath, isUpdate });
      batchChunkCount += prepared.chunks.length;

      // Re-emit progress with updated batch chunk count so polling reads a fresh value
      onProgress?.({
        phase: 'indexing',
        current: progress,
        total: totalWork,
        filePath: absPath,
        fileSize,
        batchChunks: batchChunkCount,
        batchChunkLimit: BATCH_CHUNK_LIMIT,
        elapsedMs: performance.now() - start,
      });

      if (batchChunkCount >= BATCH_CHUNK_LIMIT) {
        await flushBatch();
        // Yield to the event loop after each flush so MCP/IPC can serve requests
        await new Promise<void>((r) => setImmediate(r));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${TAG} Failed to index ${absPath}:`, message);
      onEvent?.({ filePath: absPath, eventType: 'error', errorMessage: message });
    }

    // Yield periodically so IPC polls stay responsive between files
    if ((i + 1) % 5 === 0) {
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  // Flush any remaining prepared files
  console.log(`${TAG} Phase 6: Flushing final batch...`);
  await flushBatch();
  console.log(`${TAG} Phase 6 done: ${filesToIndex.length} files in ${ms(t6)} (prepare: ${totalPrepareMs.toFixed(0)}ms, flush: ${totalFlushMs.toFixed(0)}ms across ${flushCount} batches, WAL checkpoints: ${totalWalCheckpointMs.toFixed(0)}ms)`);

  // 7. Remove stale files — batch all deletes into a single transaction
  console.log(`${TAG} Phase 7: Removing ${filesToRemove.length} stale files...`);
  const t7 = performance.now();
  if (filesToRemove.length > 0 && !shouldStop?.()) {
    const deleteEntries: FlushDelete[] = [];

    for (const storedKey of filesToRemove) {
      const absPath = resolveStoredKey(storedKey, config.directories);
      onProgress?.({
        phase: 'removing',
        current: ++progress,
        total: totalWork,
        filePath: absPath,
      });
      deleteEntries.push({ storedKey, deleteMtime: true });
    }

    await storeOps.flush([], deleteEntries);

    // Update in-memory state after successful flush
    for (const storedKey of filesToRemove) {
      mtimes.delete(storedKey);
      filesRemoved++;
      onEvent?.({
        filePath: resolveStoredKey(storedKey, config.directories),
        eventType: 'deleted',
      });
    }
  }
  console.log(`${TAG} Phase 7 done (${ms(t7)})`);

  // 8. Sync directory entries with disk state
  console.log(`${TAG} Phase 8: Syncing directories...`);
  // Yield first so the renderer can process the final progress update
  await new Promise<void>((r) => setImmediate(r));
  console.log(`${TAG} Phase 8: yield done, starting dir sync`);

  if (!shouldStop?.()) {
    // Convert absolute directory paths to stored-key format for the directories table
    const t8a = performance.now();
    const diskDirEntries: DirEntry[] = [];

    for (const absDirPath of diskDirAbsPaths) {
      for (let dirIdx = 0; dirIdx < config.directories.length; dirIdx++) {
        const siloRoot = config.directories[dirIdx];
        const rel = path.relative(siloRoot, absDirPath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) continue;

        // rel is "" for the silo root itself — skip it (root is implicit)
        if (rel === '') continue;

        const segments = rel.replace(/\\/g, '/').split('/');
        const dirPath = `${dirIdx}:${segments.join('/')}/`;
        const dirName = segments[segments.length - 1];
        const depth = segments.length;
        diskDirEntries.push({ dirPath, dirName, depth });
        break; // matched a silo root — don't check others
      }
    }
    console.log(`${TAG} Phase 8a: built ${diskDirEntries.length} dir entries (${ms(t8a)})`);

    const t8b = performance.now();
    const removedDirKeys = await storeOps.syncDirectoriesWithDisk(diskDirEntries);
    console.log(`${TAG} Phase 8b: syncDirectoriesWithDisk → removed ${removedDirKeys.length} dirs (${ms(t8b)})`);

    if (removedDirKeys.length > 0) {
      console.log(`${TAG} Removed ${removedDirKeys.length} stale director${removedDirKeys.length === 1 ? 'y' : 'ies'}`);
      // Emit dir-removed events for each orphaned directory
      for (const dirPath of removedDirKeys) {
        onEvent?.({ filePath: resolveStoredKey(dirPath, config.directories), eventType: 'dir-removed' });
      }
    }

    const t8c = performance.now();
    await storeOps.recomputeDirectoryCounts();
    console.log(`${TAG} Phase 8c: recomputeDirectoryCounts (${ms(t8c)})`);
  }

  console.log(`${TAG} Phase 9: emitting done progress`);
  onProgress?.({ phase: 'done', current: totalWork, total: totalWork });

  const totalMs = performance.now() - start;
  console.log(`${TAG} ══ RECONCILE COMPLETE ══ total ${(totalMs / 1000).toFixed(1)}s`);

  return {
    filesAdded,
    filesRemoved,
    filesUpdated,
    durationMs: totalMs,
  };
}

// ── Directory Walking ────────────────────────────────────────────────────────

function walkDirectory(
  dir: string,
  extensions: string[],
  ignoreFolders: string[],
  ignoreFiles: string[],
  result: Map<string, { mtime: number; size: number }>,
  /** Collects all directory absolute paths encountered during the walk. */
  directories?: Set<string>,
): void {
  if (!fs.existsSync(dir)) return;

  // Record this directory itself (the silo root and every visited subdirectory)
  directories?.add(path.resolve(dir));

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (matchesAnyPattern(entry.name, ignoreFolders)) continue;
      walkDirectory(fullPath, extensions, ignoreFolders, ignoreFiles, result, directories);
    } else if (entry.isFile()) {
      if (matchesAnyPattern(entry.name, ignoreFiles)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (extensions.includes(ext)) {
        try {
          const stat = fs.statSync(fullPath);
          result.set(path.resolve(fullPath), { mtime: stat.mtimeMs, size: stat.size });
        } catch {
          // Skip files we can't stat
        }
      }
    }
  }
}
