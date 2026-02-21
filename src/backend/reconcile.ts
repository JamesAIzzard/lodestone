/**
 * Startup reconciliation — ensures the database is in sync with disk.
 *
 * Walks the silo's directories, compares against the database,
 * and queues files for indexing or removal as needed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { indexFile, removeFile } from './pipeline';
import { setMtime, deleteMtime, type SiloDatabase } from './store';
import type { EmbeddingService } from './embedding';
import type { ResolvedSiloConfig } from './config';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ReconcileProgress {
  phase: 'scanning' | 'indexing' | 'removing' | 'done';
  current: number;
  total: number;
  filePath?: string;
}

export type ReconcileProgressHandler = (progress: ReconcileProgress) => void;

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
): Promise<ReconcileResult> {
  const start = performance.now();
  let filesAdded = 0;
  let filesRemoved = 0;
  let filesUpdated = 0;

  // 1. Scan disk for all matching files
  onProgress?.({ phase: 'scanning', current: 0, total: 0 });
  const diskFiles = new Map<string, number>(); // filePath → mtimeMs

  for (const dir of config.directories) {
    walkDirectory(dir, config.extensions, config.ignore, diskFiles);
  }

  // 2. Determine which files are already indexed from the mtimes map
  const indexedFiles = new Set(mtimes.keys());

  // 3. Find files to add or update
  const filesToIndex: string[] = [];
  for (const [filePath, diskMtime] of diskFiles) {
    if (!indexedFiles.has(filePath)) {
      // New file — not yet in the database
      filesToIndex.push(filePath);
    } else {
      // Existing file — check if modified while app was closed
      const storedMtime = mtimes.get(filePath)!;
      if (diskMtime !== storedMtime) {
        filesToIndex.push(filePath);
      }
    }
  }

  // 4. Find files to remove (in mtimes but no longer on disk)
  const filesToRemove: string[] = [];
  for (const indexedPath of indexedFiles) {
    if (!diskFiles.has(indexedPath)) {
      filesToRemove.push(indexedPath);
    }
  }

  // Total reflects all disk files so the UI shows overall progress,
  // not just remaining work.  Already-indexed files count as done.
  const alreadyDone = diskFiles.size - filesToIndex.length;
  const totalWork = diskFiles.size + filesToRemove.length;

  // 5. Index new and modified files
  let progress = alreadyDone;
  for (const filePath of filesToIndex) {
    onProgress?.({
      phase: 'indexing',
      current: ++progress,
      total: totalWork,
      filePath,
    });
    try {
      await indexFile(filePath, embeddingService, db);
      if (indexedFiles.has(filePath)) {
        filesUpdated++;
      } else {
        filesAdded++;
      }
      // Record the current mtime so we detect future changes
      try {
        const stat = fs.statSync(filePath);
        mtimes.set(filePath, stat.mtimeMs);
        setMtime(db, filePath, stat.mtimeMs);
      } catch {
        // File vanished between indexing and stat — rare but possible
      }
    } catch (err) {
      console.error(`[reconcile] Failed to index ${filePath}:`, err);
    }
  }

  // 6. Remove stale files
  for (const filePath of filesToRemove) {
    onProgress?.({
      phase: 'removing',
      current: ++progress,
      total: totalWork,
      filePath,
    });
    try {
      await removeFile(filePath, db);
      mtimes.delete(filePath);
      deleteMtime(db, filePath);
      filesRemoved++;
    } catch (err) {
      console.error(`[reconcile] Failed to remove ${filePath}:`, err);
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
  ignore: string[],
  result: Map<string, number>,
): void {
  if (!fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    // Check ignore patterns
    if (ignore.some((pattern) => entry.name === pattern)) continue;

    if (entry.isDirectory()) {
      walkDirectory(fullPath, extensions, ignore, result);
    } else if (entry.isFile()) {
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
