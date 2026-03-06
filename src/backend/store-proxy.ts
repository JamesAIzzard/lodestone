/**
 * Store proxy — async RPC interface from the main thread to the store worker.
 *
 * All SQLite operations run on the store worker thread. This proxy sends
 * typed messages and returns Promises. Mirrors the embedding worker pattern:
 *   - Worker spawned lazily on first call
 *   - Message ID routing with pending promise map
 *   - Crash recovery: tracks open silos, re-opens on worker respawn
 *
 * Unlike the embedding proxy (one proxy per model), this is a singleton —
 * all silos share a single worker and a single proxy instance.
 */

import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type {
  StoreRequest,
  StoreResponse,
  FlushUpsert,
  FlushDelete,
  FlushResult,
  SiloMeta,
  StoredSiloConfig,
  DirEntry,
} from './store/types';
import type { SearchParams } from '../shared/types';
import type { FileResult } from './search';
import type {
  DirectorySearchParams,
  SiloDirectorySearchResult,
} from './directory-search';
import type { DirectoryTreeNode } from '../shared/types';

// ── Worker lifecycle ──────────────────────────────────────────────────────────

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (value: any) => void; reject: (err: Error) => void }>();

/**
 * Tracks open silos so they can be re-opened on worker respawn.
 * Key = siloId, Value = { dbPath, dimensions } needed for the 'open' call.
 */
const openSilos = new Map<string, { dbPath: string; dimensions: number }>();

function ensureWorker(): Worker {
  if (!worker) {
    const workerPath = path.join(__dirname, 'store-worker.js');
    worker = new Worker(workerPath);

    // Don't let the worker prevent the process from exiting.
    worker.unref();

    worker.on('message', (msg: StoreResponse) => {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new Error(msg.error));
      } else {
        entry.resolve(msg.result);
      }
    });

    worker.on('error', (err) => {
      for (const entry of pending.values()) entry.reject(err);
      pending.clear();
    });

    worker.on('exit', (code) => {
      if (code !== 0 && pending.size > 0) {
        const exitErr = new Error(`Store worker exited with code ${code}`);
        for (const entry of pending.values()) entry.reject(exitErr);
        pending.clear();
      }
      worker = null;
      // Don't auto-respawn here — the next call() triggers ensureWorker()
      // which will spawn a fresh worker and re-open tracked silos.
    });

    // If there are silos to re-open (worker crashed and respawned), do it now.
    // We fire these without awaiting — they'll be serialized in the worker's
    // message queue and complete before any subsequent calls for those silos.
    if (openSilos.size > 0) {
      for (const [siloId, { dbPath, dimensions }] of openSilos) {
        call<void>('open', siloId, dbPath, dimensions);
      }
    }
  }
  return worker;
}

function call<T>(method: string, siloId: string, ...args: unknown[]): Promise<T> {
  const w = ensureWorker();
  return new Promise<T>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const msg: StoreRequest = { id, method, siloId, args };
    w.postMessage(msg);
  });
}

// ── Typed proxy methods ───────────────────────────────────────────────────────

// ── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * Open a silo database in the worker thread.
 * Tracked for automatic re-open on worker respawn.
 */
export async function open(siloId: string, dbPath: string, dimensions: number): Promise<void> {
  openSilos.set(siloId, { dbPath, dimensions });
  await call<void>('open', siloId, dbPath, dimensions);
}

/**
 * Close a silo database in the worker thread.
 * Removes from crash-recovery tracking.
 */
export async function close(siloId: string): Promise<void> {
  openSilos.delete(siloId);
  try {
    await call<void>('close', siloId);
  } catch {
    // Worker may already be gone — that's fine, the DB was closed on exit.
  }
}

/**
 * Terminate the store worker. Called during app shutdown.
 */
export async function terminate(): Promise<void> {
  if (!worker) return;
  const w = worker;
  worker = null;
  openSilos.clear();
  // Reject any pending calls
  for (const entry of pending.values()) {
    entry.reject(new Error('Store worker terminated'));
  }
  pending.clear();
  await w.terminate();
}

// ── Batch write path ─────────────────────────────────────────────────────────

export function flush(
  siloId: string,
  upserts: FlushUpsert[],
  deletes: FlushDelete[],
): Promise<FlushResult> {
  return call<FlushResult>('flush', siloId, upserts, deletes);
}

// ── Mtime operations ─────────────────────────────────────────────────────────

export function loadMtimes(siloId: string): Promise<Map<string, number>> {
  return call<Map<string, number>>('loadMtimes', siloId);
}

export function setMtime(siloId: string, storedKey: string, mtimeMs: number): Promise<void> {
  return call<void>('setMtime', siloId, storedKey, mtimeMs);
}

export function deleteMtime(siloId: string, storedKey: string): Promise<void> {
  return call<void>('deleteMtime', siloId, storedKey);
}

export function countMtimes(siloId: string): Promise<number> {
  return call<number>('countMtimes', siloId);
}

// ── Meta operations ──────────────────────────────────────────────────────────

export function loadMeta(siloId: string): Promise<SiloMeta | null> {
  return call<SiloMeta | null>('loadMeta', siloId);
}

export function saveMeta(siloId: string, model: string, dimensions: number): Promise<void> {
  return call<void>('saveMeta', siloId, model, dimensions);
}

export function saveConfigBlob(siloId: string, config: StoredSiloConfig): Promise<void> {
  return call<void>('saveConfigBlob', siloId, config);
}

export function loadConfigBlob(siloId: string): Promise<StoredSiloConfig | null> {
  return call<StoredSiloConfig | null>('loadConfigBlob', siloId);
}

// ── Stats ────────────────────────────────────────────────────────────────────

export function getChunkCount(siloId: string): Promise<number> {
  return call<number>('getChunkCount', siloId);
}

export function getFileCount(siloId: string): Promise<number> {
  return call<number>('getFileCount', siloId);
}

// ── Directory operations ─────────────────────────────────────────────────────

export function insertDirEntry(siloId: string, dirPath: string): Promise<boolean> {
  return call<boolean>('insertDirEntry', siloId, dirPath);
}

export function deleteDirEntry(siloId: string, dirPath: string): Promise<number | null> {
  return call<number | null>('deleteDirEntry', siloId, dirPath);
}

export function getFilesInDirectory(
  siloId: string,
  dirStoredKey: string,
): Promise<Array<{ filePath: string; fileName: string }>> {
  return call<Array<{ filePath: string; fileName: string }>>('getFilesInDirectory', siloId, dirStoredKey);
}

export function syncDirectoriesWithDisk(
  siloId: string,
  diskDirPaths: DirEntry[],
): Promise<string[]> {
  return call<string[]>('syncDirectoriesWithDisk', siloId, diskDirPaths);
}

export function recomputeDirectoryCounts(siloId: string): Promise<void> {
  return call<void>('recomputeDirectoryCounts', siloId);
}

// ── Search ───────────────────────────────────────────────────────────────────

export function search(
  siloId: string,
  queryVector: number[],
  params: SearchParams,
): Promise<FileResult[]> {
  return call<FileResult[]>('search', siloId, queryVector, params);
}

export function directorySearch(
  siloId: string,
  params: DirectorySearchParams,
): Promise<SiloDirectorySearchResult[]> {
  return call<SiloDirectorySearchResult[]>('directorySearch', siloId, params);
}

export function expandTree(
  siloId: string,
  rootPath: string,
  rootDepth: number,
  maxDepth: number,
  fullContents?: boolean,
): Promise<DirectoryTreeNode[]> {
  return call<DirectoryTreeNode[]>('expandTree', siloId, rootPath, rootDepth, maxDepth, fullContents);
}

// ── Activity log ─────────────────────────────────────────────────────────────

import type { ActivityRow } from './store/operations';

export function logActivity(
  siloId: string,
  timestamp: string,
  eventType: string,
  filePath: string,
  errorMessage: string | null,
  maxRows: number,
): Promise<void> {
  return call<void>('logActivity', siloId, timestamp, eventType, filePath, errorMessage, maxRows);
}

export function loadActivity(siloId: string, limit: number): Promise<ActivityRow[]> {
  return call<ActivityRow[]>('loadActivity', siloId, limit);
}

// ── Maintenance ──────────────────────────────────────────────────────────────

export function checkpoint(siloId: string, mode?: string): Promise<void> {
  return call<void>('checkpoint', siloId, mode);
}

export function vacuum(siloId: string): Promise<void> {
  return call<void>('vacuum', siloId);
}
