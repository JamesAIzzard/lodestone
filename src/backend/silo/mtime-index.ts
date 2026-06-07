/**
 * In-memory cache of stored-key → mtime for a single silo, kept consistent
 * with the `files.mtime_ms` column in the silo's database.
 *
 * Why this exists: today the same conceptual operation ("update mtime
 * after a successful write") happens at four sites in `silo-manager.ts` /
 * `reconcile.ts`, each with subtly different patterns (some rely on
 * `flush(..., {mtimeMs})` to persist via the upsert, some call
 * `setMtime` explicitly, one uses `deleteMtime: true` on the flush, one
 * calls `deleteMtime` directly). `MtimeIndex` is the single owner of
 * that invariant.
 *
 * Two write paths, deliberately:
 *
 *   - **Sync `record*` (the `MtimeSink` interface)**: in-memory only. Used
 *     when the caller has already arranged for the DB to be written —
 *     e.g. reconcile's `onBatchFlushed`, where the flush itself wrote
 *     `mtime_ms` as part of each upsert. A second DB write would be
 *     redundant. These methods are sync because `pipeline.ts:
 *     onBatchFlushed` is a sync callback; making the sink async would
 *     ripple into the indexing pipeline contract, which is out of scope
 *     for Phase 2a.
 *
 *   - **Async `indexed` / `deleted`**: in-memory + DB write. Used by
 *     callers that need both — the watcher event handler in
 *     `SiloManager.handleWatcherEvent`, and `reindexFile`. The DB call
 *     is awaited (callers can swallow the error if they want
 *     fire-and-forget semantics by adding their own `.catch`).
 *
 * Note on identity: this class captures `siloId` at construction.
 * `updateName()` mutating `config.name` mid-flight is already a known
 * latent issue (see the rename regression baseline); fixing it is out
 * of scope for Phase 2 and will be a separate ticket.
 */

import type { StoreFacade } from '../store-facade';

/** Read-only view onto the mtime map. */
export interface MtimeReader {
  has(storedKey: string): boolean;
  keys(): IterableIterator<string>;
  get(storedKey: string): number | undefined;
  readonly size: number;
}

/**
 * Sync write-only sink. Each call updates the in-memory map; the DB is
 * the caller's responsibility. Use this from sites where a flush (or
 * other DB write) has *already* recorded the new state and we just need
 * to keep the in-memory cache aligned.
 */
export interface MtimeSink {
  recordIndexed(storedKey: string, mtimeMs: number): void;
  recordDeleted(storedKey: string): void;
}

/** Combined read + sync-write surface. Reconcile takes this. */
export type MtimeView = MtimeReader & MtimeSink;

export class MtimeIndex implements MtimeView {
  private map = new Map<string, number>();

  constructor(
    private readonly siloId: string,
    private readonly store: StoreFacade,
  ) {}

  // ── Reader ────────────────────────────────────────────────────────────────

  has(storedKey: string): boolean {
    return this.map.has(storedKey);
  }

  keys(): IterableIterator<string> {
    return this.map.keys();
  }

  get(storedKey: string): number | undefined {
    return this.map.get(storedKey);
  }

  get size(): number {
    return this.map.size;
  }

  // ── Sync sink (in-memory only) ────────────────────────────────────────────

  recordIndexed(storedKey: string, mtimeMs: number): void {
    this.map.set(storedKey, mtimeMs);
  }

  recordDeleted(storedKey: string): void {
    this.map.delete(storedKey);
  }

  // ── Async write-through (in-memory + DB) ──────────────────────────────────

  /** Record an indexed file: update the in-memory map and persist to the DB. */
  async indexed(storedKey: string, mtimeMs: number): Promise<void> {
    this.map.set(storedKey, mtimeMs);
    await this.store.setMtime(this.siloId, storedKey, mtimeMs);
  }

  /** Record a deletion: remove from the in-memory map and persist to the DB. */
  async deleted(storedKey: string): Promise<void> {
    this.map.delete(storedKey);
    await this.store.deleteMtime(this.siloId, storedKey);
  }

  // ── Bulk operations ───────────────────────────────────────────────────────

  /** Replace the in-memory map with a fresh snapshot from the store. */
  async loadFromStore(): Promise<void> {
    this.map = await this.store.loadMtimes(this.siloId);
  }

  /** Drop all in-memory state. Used by `stop()` to release memory; the DB is untouched. */
  clear(): void {
    this.map.clear();
  }

  /** Snapshot for tests and assertions. The returned Map is the live one — do not mutate. */
  asMap(): ReadonlyMap<string, number> {
    return this.map;
  }
}
