/**
 * Startup reconciliation — ensures the database is in sync with disk.
 *
 * Walks the silo's directories, compares against the database,
 * and queues files for indexing or removal as needed.
 *
 * Database writes are batched: files are prepared (read, extracted, chunked,
 * embedded) one at a time, then flushed to SQLite in bulk every BATCH_SIZE
 * files. This dramatically reduces transaction overhead and main-thread blocking.
 */

import fs from 'node:fs';
import path from 'node:path';
import { prepareFile, type PreparedFile } from './pipeline';
import { makeStoredKey, resolveStoredKey, flushPreparedFiles, type SiloDatabase } from './store';
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

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Number of files to prepare before flushing to the database in one transaction.
 * 50 files × ~10 chunks each ≈ 500 chunks ≈ 1,500 SQL statements per flush.
 */
const BATCH_SIZE = 50;

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
  db: SiloDatabase,
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

  // 1. Scan disk for all matching files
  onProgress?.({ phase: 'scanning', current: 0, total: 0 });
  const diskAbsPaths = new Map<string, number>(); // absPath → mtimeMs

  for (const dir of config.directories) {
    walkDirectory(dir, config.extensions, config.ignore, config.ignoreFiles, diskAbsPaths);
  }

  // 2. Build storedKey → { absPath, mtime } map from disk scan
  const diskStored = new Map<string, { absPath: string; mtime: number }>();
  for (const [absPath, mtime] of diskAbsPaths) {
    try {
      const key = makeStoredKey(absPath, config.directories);
      diskStored.set(key, { absPath, mtime });
    } catch {
      // path outside all directories — shouldn't happen with correct globs
    }
  }

  // 3. Determine which files are already indexed from the mtimes map (keyed by stored keys)
  const indexedKeys = new Set(mtimes.keys());

  // 4. Find files to add or update
  const filesToIndex: Array<{ absPath: string; storedKey: string; mtime: number }> = [];
  for (const [storedKey, { absPath, mtime }] of diskStored) {
    if (!indexedKeys.has(storedKey)) {
      filesToIndex.push({ absPath, storedKey, mtime });
    } else {
      const storedMtime = mtimes.get(storedKey)!;
      if (mtime !== storedMtime) {
        filesToIndex.push({ absPath, storedKey, mtime });
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

  // Total reflects all disk files so the UI shows overall progress,
  // not just remaining work.  Already-indexed files count as done.
  const alreadyDone = diskStored.size - filesToIndex.length;
  const totalWork = diskStored.size + filesToRemove.length;

  // 6. Index new and modified files — prepare in a loop, flush in batches
  let progress = alreadyDone;

  // Track prepared files and their metadata for the current batch
  let batch: Array<{ prepared: PreparedFile; absPath: string; isUpdate: boolean }> = [];

  const flushBatch = () => {
    if (batch.length === 0) return;

    flushPreparedFiles(
      db,
      batch.map((b) => ({
        filePath: b.prepared.storedKey,
        chunks: b.prepared.chunks,
        embeddings: b.prepared.embeddings,
        mtimeMs: b.prepared.mtimeMs,
      })),
    );

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
  };

  for (let i = 0; i < filesToIndex.length; i++) {
    if (shouldStop?.()) {
      // Flush any work already prepared, then bail out
      flushBatch();
      console.log(`[reconcile] Stopped early after ${i} / ${filesToIndex.length} files`);
      break;
    }

    const { absPath, storedKey, mtime } = filesToIndex[i];

    onProgress?.({
      phase: 'indexing',
      current: ++progress,
      total: totalWork,
      filePath: absPath,
    });

    try {
      const prepared = await prepareFile(absPath, storedKey, embeddingService, mtime);
      const isUpdate = indexedKeys.has(storedKey);
      batch.push({ prepared, absPath, isUpdate });

      if (batch.length >= BATCH_SIZE) {
        flushBatch();
        // Yield to the event loop after each flush so MCP/IPC can serve requests
        await new Promise<void>((r) => setImmediate(r));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[reconcile] Failed to index ${absPath}:`, message);
      onEvent?.({ filePath: absPath, eventType: 'error', errorMessage: message });
    }
  }

  // Flush any remaining prepared files
  flushBatch();

  // 7. Remove stale files — batch all deletes into a single transaction
  if (filesToRemove.length > 0 && !shouldStop?.()) {
    const deleteEntries: Array<{ filePath: string; deleteMtime: boolean }> = [];

    for (const storedKey of filesToRemove) {
      const absPath = resolveStoredKey(storedKey, config.directories);
      onProgress?.({
        phase: 'removing',
        current: ++progress,
        total: totalWork,
        filePath: absPath,
      });
      deleteEntries.push({ filePath: storedKey, deleteMtime: true });
    }

    flushPreparedFiles(db, [], deleteEntries);

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

  onProgress?.({ phase: 'done', current: totalWork, total: totalWork });

  return {
    filesAdded,
    filesRemoved,
    filesUpdated,
    durationMs: performance.now() - start,
  };
}

// ── Directory Walking ────────────────────────────────────────────────────────

function walkDirectory(
  dir: string,
  extensions: string[],
  ignoreFolders: string[],
  ignoreFiles: string[],
  result: Map<string, number>,
): void {
  if (!fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (matchesAnyPattern(entry.name, ignoreFolders)) continue;
      walkDirectory(fullPath, extensions, ignoreFolders, ignoreFiles, result);
    } else if (entry.isFile()) {
      if (matchesAnyPattern(entry.name, ignoreFiles)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (extensions.includes(ext)) {
        try {
          const stat = fs.statSync(fullPath);
          result.set(path.resolve(fullPath), stat.mtimeMs);
        } catch {
          // Skip files we can't stat
        }
      }
    }
  }
}
