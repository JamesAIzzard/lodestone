/**
 * Store facade — the worker-mediated subset of operations that SiloManager
 * (and the watcher/reconcile adapters it owns) consume.
 *
 * Why this exists: SiloManager today imports `* as storeProxy from
 * './store-proxy'` and the proxy is a module-level singleton. That makes
 * SiloManager untestable without spinning up the real store-worker thread.
 * `StoreFacade` is the same surface, but as an interface — production wires
 * the proxy-backed implementation, tests wire in-memory or temp-dir backed
 * implementations that share the real schema and SQL paths.
 *
 * Behaviour parity is non-negotiable. Every method's signature mirrors
 * the corresponding `store-proxy` export *exactly*. If you add a method
 * to the proxy, add it here and update both implementations. `tsc` will
 * catch drift; behaviour drift is your problem.
 *
 * Note: `peekFileCount` is intentionally **not** on this facade. It opens
 * its own `better-sqlite3` connection on the main thread, deliberately
 * bypassing the worker for read-only access to stopped silos. Keep that
 * import direct — see `store/peek.ts`.
 */

import * as storeProxy from './store-proxy';
import type {
  FlushUpsert,
  FlushDelete,
  FlushResult,
  SiloMeta,
  StoredSiloConfig,
  DirEntry,
} from './store/types';
import type { ActivityRow } from './store/operations';
import type { SearchParams, DirectoryTreeNode } from '../shared/types';
import type { FileResult } from './search';
import type {
  DirectorySearchParams,
  SiloDirectorySearchResult,
} from './directory-search';

export interface StoreFacade {
  // ── Lifecycle ─────────────────────────────────────────────────────────────
  open(siloId: string, dbPath: string, dimensions: number): Promise<void>;
  close(siloId: string): Promise<void>;

  // ── Bulk write ────────────────────────────────────────────────────────────
  flush(siloId: string, upserts: FlushUpsert[], deletes: FlushDelete[]): Promise<FlushResult>;

  // ── Mtimes ────────────────────────────────────────────────────────────────
  loadMtimes(siloId: string): Promise<Map<string, number>>;
  setMtime(siloId: string, storedKey: string, mtimeMs: number): Promise<void>;
  deleteMtime(siloId: string, storedKey: string): Promise<void>;

  // ── Meta ──────────────────────────────────────────────────────────────────
  loadMeta(siloId: string): Promise<SiloMeta | null>;
  saveMeta(siloId: string, model: string, dimensions: number): Promise<void>;

  // ── Config blob ───────────────────────────────────────────────────────────
  saveConfigBlob(siloId: string, blob: StoredSiloConfig): Promise<void>;

  // ── Activity ──────────────────────────────────────────────────────────────
  loadActivity(siloId: string, limit: number): Promise<ActivityRow[]>;
  logActivity(
    siloId: string,
    timestamp: string,
    eventType: string,
    filePath: string,
    errorMessage: string | null,
    maxRows: number,
  ): Promise<void>;

  // ── Stats / maintenance ───────────────────────────────────────────────────
  getChunkCount(siloId: string): Promise<number>;
  checkpoint(siloId: string, mode?: string): Promise<void>;
  vacuum(siloId: string): Promise<void>;

  // ── Search ────────────────────────────────────────────────────────────────
  search(siloId: string, queryVector: number[], params: SearchParams): Promise<FileResult[]>;
  directorySearch(
    siloId: string,
    params: DirectorySearchParams,
  ): Promise<SiloDirectorySearchResult[]>;
  expandTree(
    siloId: string,
    rootPath: string,
    rootDepth: number,
    maxDepth: number,
    fullContents?: boolean,
  ): Promise<DirectoryTreeNode[]>;
  getFilesInDirectory(
    siloId: string,
    dirStoredKey: string,
  ): Promise<Array<{ filePath: string; fileName: string }>>;

  // ── Directory entries ─────────────────────────────────────────────────────
  insertDirEntry(siloId: string, dirPath: string): Promise<boolean>;
  deleteDirEntry(siloId: string, dirPath: string): Promise<number | null>;
  syncDirectoriesWithDisk(siloId: string, diskDirPaths: DirEntry[]): Promise<string[]>;
  recomputeDirectoryCounts(siloId: string): Promise<void>;
}

/**
 * Default production `StoreFacade` — a thin object literal that delegates
 * every method to the corresponding `store-proxy` export.
 *
 * No behaviour change: every call still goes to the same store-worker
 * thread, the same crash-recovery logic, the same singleton state.
 */
export const proxyStoreFacade: StoreFacade = {
  open: storeProxy.open,
  close: storeProxy.close,
  flush: storeProxy.flush,
  loadMtimes: storeProxy.loadMtimes,
  setMtime: storeProxy.setMtime,
  deleteMtime: storeProxy.deleteMtime,
  loadMeta: storeProxy.loadMeta,
  saveMeta: storeProxy.saveMeta,
  saveConfigBlob: storeProxy.saveConfigBlob,
  loadActivity: storeProxy.loadActivity,
  logActivity: storeProxy.logActivity,
  getChunkCount: storeProxy.getChunkCount,
  checkpoint: storeProxy.checkpoint,
  vacuum: storeProxy.vacuum,
  search: storeProxy.search,
  directorySearch: storeProxy.directorySearch,
  expandTree: storeProxy.expandTree,
  getFilesInDirectory: storeProxy.getFilesInDirectory,
  insertDirEntry: storeProxy.insertDirEntry,
  deleteDirEntry: storeProxy.deleteDirEntry,
  syncDirectoriesWithDisk: storeProxy.syncDirectoriesWithDisk,
  recomputeDirectoryCounts: storeProxy.recomputeDirectoryCounts,
};
