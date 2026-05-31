/**
 * Local in-process StoreFacade — used by SiloManager tests.
 *
 * Mirrors the dispatch in `store-worker.ts` exactly, but runs synchronously
 * on the calling thread (with each call wrapped in `Promise.resolve()`).
 * Same schema, same SQL operations, same `TermCache` warming on open —
 * just no `worker_threads` boundary.
 *
 * Two factory functions are exported:
 *   - `createInMemoryStoreFacade()` — always opens `:memory:` regardless of
 *     the `dbPath` argument. For tests that don't care about on-disk
 *     behaviour. Fast.
 *   - `createTempDirStoreFacade()` — respects the `dbPath` argument,
 *     supporting close-and-reopen cycles. Required for tests of `freeze()`,
 *     `wake()`, the unusable-index gate, and `getStatus()` size assertions.
 *
 * Why one class, not two: the dispatch logic for all 22 methods is
 * identical — only `open()` differs in how it picks the path. Factoring
 * the dispatch twice would be pure duplication.
 *
 * Naming note: `SiloDirectorySearchResult` is the *per-silo* result shape
 * (no `siloName`); the facade returns it as-is, matching the production
 * proxy. `dispatchExplore` (in `search-merge.ts`) is what wraps each
 * result with a silo name above this layer.
 */

import {
  flushPreparedFiles,
  loadMtimes, setMtime, deleteMtime,
  loadMeta, saveMeta, saveConfigBlob,
  getChunkCount,
  insertDirEntry, deleteDirEntry, getFilesInDirectory,
  syncDirectoriesWithDisk, recomputeDirectoryCounts,
  insertActivityEvent, loadActivityLog,
} from '../store/operations';
import { createSiloDatabase } from '../store/schema';
import { TermCache } from '../store/term-cache';
import type {
  FlushUpsert, FlushDelete, FlushResult,
  SiloMeta, StoredSiloConfig, DirEntry,
  SiloDatabase,
} from '../store/types';
import type { ActivityRow } from '../store/operations';
import type { SearchParams, DirectoryTreeNode } from '../../shared/types';
import { search, type FileResult } from '../search';
import {
  directorySearchSilo,
  expandTree as expandTreeImpl,
  type DirectorySearchParams,
  type SiloDirectorySearchResult,
} from '../directory-search';
import type { StoreFacade } from '../store-facade';

interface SiloState {
  db: SiloDatabase;
  termCache: TermCache;
}

/**
 * In-process StoreFacade. Constructor takes an optional `dbPathOverride`;
 * when set, every `open()` call ignores the path the caller provided and
 * uses this instead (used by the in-memory factory).
 */
export class LocalStoreFacade implements StoreFacade {
  private silos = new Map<string, SiloState>();

  constructor(private readonly dbPathOverride?: string) {}

  /** For tests: list silo ids currently open. */
  openSiloIds(): string[] {
    return Array.from(this.silos.keys());
  }

  private state(siloId: string): SiloState {
    const s = this.silos.get(siloId);
    if (!s) throw new Error(`Silo "${siloId}" is not open in the store facade`);
    return s;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async open(siloId: string, dbPath: string, dimensions: number): Promise<void> {
    if (this.silos.has(siloId)) return; // idempotent, matches worker
    const path = this.dbPathOverride ?? dbPath;
    const db = createSiloDatabase(path, dimensions);
    const termCache = new TermCache();
    termCache.warmFromDb(db);
    this.silos.set(siloId, { db, termCache });
  }

  async close(siloId: string): Promise<void> {
    const s = this.silos.get(siloId);
    if (!s) return;
    try {
      s.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // Checkpoint failure is non-fatal — matches worker behaviour
    }
    s.db.close();
    s.termCache.clear();
    this.silos.delete(siloId);
  }

  // ── Bulk write ────────────────────────────────────────────────────────────

  async flush(
    siloId: string,
    upserts: FlushUpsert[],
    deletes: FlushDelete[],
  ): Promise<FlushResult> {
    const { db, termCache } = this.state(siloId);
    return flushPreparedFiles(db, termCache, upserts, deletes);
  }

  // ── Mtimes ────────────────────────────────────────────────────────────────

  async loadMtimes(siloId: string): Promise<Map<string, number>> {
    return loadMtimes(this.state(siloId).db);
  }

  async setMtime(siloId: string, storedKey: string, mtimeMs: number): Promise<void> {
    setMtime(this.state(siloId).db, storedKey, mtimeMs);
  }

  async deleteMtime(siloId: string, storedKey: string): Promise<void> {
    deleteMtime(this.state(siloId).db, storedKey);
  }

  // ── Meta ──────────────────────────────────────────────────────────────────

  async loadMeta(siloId: string): Promise<SiloMeta | null> {
    return loadMeta(this.state(siloId).db);
  }

  async saveMeta(siloId: string, model: string, dimensions: number): Promise<void> {
    saveMeta(this.state(siloId).db, model, dimensions);
  }

  // ── Config blob ───────────────────────────────────────────────────────────

  async saveConfigBlob(siloId: string, blob: StoredSiloConfig): Promise<void> {
    saveConfigBlob(this.state(siloId).db, blob);
  }

  // ── Activity ──────────────────────────────────────────────────────────────

  async loadActivity(siloId: string, limit: number): Promise<ActivityRow[]> {
    return loadActivityLog(this.state(siloId).db, limit);
  }

  async logActivity(
    siloId: string,
    timestamp: string,
    eventType: string,
    filePath: string,
    errorMessage: string | null,
    maxRows: number,
  ): Promise<void> {
    insertActivityEvent(
      this.state(siloId).db,
      timestamp, eventType, filePath, errorMessage, maxRows,
    );
  }

  // ── Stats / maintenance ───────────────────────────────────────────────────

  async getChunkCount(siloId: string): Promise<number> {
    return getChunkCount(this.state(siloId).db);
  }

  async checkpoint(siloId: string, mode?: string): Promise<void> {
    const m = mode ?? 'PASSIVE';
    this.state(siloId).db.pragma(`wal_checkpoint(${m})`);
  }

  async vacuum(siloId: string): Promise<void> {
    this.state(siloId).db.exec('VACUUM');
  }

  // ── Search ────────────────────────────────────────────────────────────────

  async search(
    siloId: string,
    queryVector: number[],
    params: SearchParams,
  ): Promise<FileResult[]> {
    return search(this.state(siloId).db, queryVector, params);
  }

  async directorySearch(
    siloId: string,
    params: DirectorySearchParams,
  ): Promise<SiloDirectorySearchResult[]> {
    return directorySearchSilo(this.state(siloId).db, params);
  }

  async expandTree(
    siloId: string,
    rootPath: string,
    rootDepth: number,
    maxDepth: number,
    fullContents?: boolean,
  ): Promise<DirectoryTreeNode[]> {
    return expandTreeImpl(this.state(siloId).db, rootPath, rootDepth, maxDepth, fullContents);
  }

  async getFilesInDirectory(
    siloId: string,
    dirStoredKey: string,
  ): Promise<Array<{ filePath: string; fileName: string }>> {
    return getFilesInDirectory(this.state(siloId).db, dirStoredKey);
  }

  // ── Directory entries ─────────────────────────────────────────────────────

  async insertDirEntry(siloId: string, dirPath: string): Promise<boolean> {
    return insertDirEntry(this.state(siloId).db, dirPath);
  }

  async deleteDirEntry(siloId: string, dirPath: string): Promise<number | null> {
    return deleteDirEntry(this.state(siloId).db, dirPath);
  }

  async syncDirectoriesWithDisk(siloId: string, diskDirPaths: DirEntry[]): Promise<string[]> {
    return syncDirectoriesWithDisk(this.state(siloId).db, diskDirPaths);
  }

  async recomputeDirectoryCounts(siloId: string): Promise<void> {
    recomputeDirectoryCounts(this.state(siloId).db);
  }
}

/**
 * Build a StoreFacade backed by `:memory:` SQLite — the `dbPath` passed to
 * `open()` is ignored. Use for tests where on-disk file behaviour is
 * irrelevant (most isolated collaborator tests, plus SiloManager tests
 * that don't touch `freeze`/`wake`/`rebuild`/file-size assertions).
 */
export function createInMemoryStoreFacade(): LocalStoreFacade {
  return new LocalStoreFacade(':memory:');
}

/**
 * Build a StoreFacade that respects the `dbPath` passed to `open()`. Pair
 * with `mkdtempSync` in the test for SiloManager lifecycle assertions
 * (`freeze`, `wake`, `rebuild`, `getStatus` size checks). Also required for
 * `peekFileCount` to find the file — it opens its own connection on the
 * main thread and bypasses this facade entirely.
 */
export function createTempDirStoreFacade(): LocalStoreFacade {
  return new LocalStoreFacade();
}
