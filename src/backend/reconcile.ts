/**
 * Startup reconciliation — ensures the database is in sync with disk.
 *
 * Walks the silo's directories, compares against the database,
 * and queues files for indexing or removal as needed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { indexFile, removeFile } from './pipeline';
import { setMtime, deleteMtime, makeStoredKey, resolveStoredKey, type SiloDatabase } from './store';
import type { EmbeddingService } from './embedding';
import type { ResolvedSiloConfig } from './config';
import type { ActivityEventType } from '../shared/types';
import { matchesAnyPattern } from './pattern-match';
import type { PauseToken } from './pause-token';

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
  pauseToken?: PauseToken,
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
  const filesToIndex: Array<{ absPath: string; storedKey: string }> = [];
  for (const [storedKey, { absPath, mtime }] of diskStored) {
    if (!indexedKeys.has(storedKey)) {
      // New file — not yet in the database
      filesToIndex.push({ absPath, storedKey });
    } else {
      // Existing file — check if modified while app was closed
      const storedMtime = mtimes.get(storedKey)!;
      if (mtime !== storedMtime) {
        filesToIndex.push({ absPath, storedKey });
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

  // 6. Index new and modified files
  let progress = alreadyDone;
  for (const { absPath, storedKey } of filesToIndex) {
    if (pauseToken) await pauseToken.waitIfPaused();
    onProgress?.({
      phase: 'indexing',
      current: ++progress,
      total: totalWork,
      filePath: absPath,
    });
    try {
      await indexFile(absPath, storedKey, embeddingService, db);
      const isUpdate = indexedKeys.has(storedKey);
      if (isUpdate) {
        filesUpdated++;
      } else {
        filesAdded++;
      }
      // Resolve back to absolute path for UI display
      onEvent?.({ filePath: absPath, eventType: isUpdate ? 'reindexed' : 'indexed' });
      // Record the current mtime so we detect future changes
      try {
        const stat = fs.statSync(absPath);
        mtimes.set(storedKey, stat.mtimeMs);
        setMtime(db, storedKey, stat.mtimeMs);
      } catch {
        // File vanished between indexing and stat — rare but possible
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[reconcile] Failed to index ${absPath}:`, message);
      onEvent?.({ filePath: absPath, eventType: 'error', errorMessage: message });
    }
  }

  // 7. Remove stale files
  for (const storedKey of filesToRemove) {
    if (pauseToken) await pauseToken.waitIfPaused();
    const absPath = resolveStoredKey(storedKey, config.directories);
    onProgress?.({
      phase: 'removing',
      current: ++progress,
      total: totalWork,
      filePath: absPath,
    });
    try {
      await removeFile(storedKey, db);
      mtimes.delete(storedKey);
      deleteMtime(db, storedKey);
      filesRemoved++;
      onEvent?.({ filePath: absPath, eventType: 'deleted' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[reconcile] Failed to remove ${absPath}:`, message);
      onEvent?.({ filePath: absPath, eventType: 'error', errorMessage: message });
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
