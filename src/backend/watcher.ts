/**
 * File watcher for a single silo.
 *
 * Watches configured directories for file changes, debounces events,
 * and dispatches to the indexing pipeline. Files are processed sequentially
 * to avoid overwhelming the embedding service.
 *
 * Database writes are batched: all queued files are prepared first, then
 * flushed to SQLite in a single transaction when the queue drains.
 */

import { watch, type FSWatcher } from 'chokidar';
import path from 'node:path';
import type { EmbeddingService } from './embedding';
import { prepareFile, type PreparedFile } from './pipeline';
import { makeStoredKey, flushPreparedFiles, type SiloDatabase } from './store';
import type { ResolvedSiloConfig } from './config';
import type { ActivityEventType } from '../shared/types';
import { matchesAnyPattern } from './pattern-match';

// ── Types ────────────────────────────────────────────────────────────────────

export interface WatcherEvent {
  timestamp: Date;
  siloName: string;
  filePath: string;
  eventType: ActivityEventType;
  chunkCount?: number;
  durationMs?: number;
  errorMessage?: string;
}

export type WatcherEventHandler = (event: WatcherEvent) => void;

// ── SiloWatcher ──────────────────────────────────────────────────────────────

export class SiloWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private processing = false;
  private queue: Array<{ absPath: string; storedKey: string; type: 'upsert' | 'delete' }> = [];
  private onEvent: WatcherEventHandler | null = null;
  private onQueueFilled?: () => void;

  constructor(
    private readonly config: ResolvedSiloConfig,
    private readonly embeddingService: EmbeddingService,
    private readonly db: SiloDatabase,
  ) {}

  /** Register a listener for watcher events (activity feed). */
  on(handler: WatcherEventHandler): void {
    this.onEvent = handler;
  }

  /**
   * Register a callback that fires when items are added to the queue.
   * SiloManager uses this to schedule a global-queue indexing run instead
   * of processing immediately (which would allow concurrent indexing).
   */
  setQueueFilledHandler(fn: () => void): void {
    this.onQueueFilled = fn;
  }

  /** Start watching the silo directories. */
  start(): void {
    if (this.watcher) return;

    // chokidar v4+ removed glob support — watch directories directly and
    // filter by extension + ignore patterns via the `ignored` callback.
    const extSet = new Set(this.config.extensions.map((e) => e.toLowerCase()));

    this.watcher = watch(this.config.directories, {
      ignored: (filePath, stats) => {
        const base = path.basename(filePath);
        if (!stats || stats.isDirectory()) {
          return matchesAnyPattern(base, this.config.ignore);
        }
        // For files, check file ignore patterns first, then extension whitelist.
        if (matchesAnyPattern(base, this.config.ignoreFiles)) return true;
        const ext = path.extname(filePath).toLowerCase();
        return !extSet.has(ext);
      },
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });

    const debounceMs = this.config.debounce * 1000;

    this.watcher.on('add', (filePath: string) => this.debounce(filePath, 'upsert', debounceMs));
    this.watcher.on('change', (filePath: string) => this.debounce(filePath, 'upsert', debounceMs));
    this.watcher.on('unlink', (filePath: string) => this.debounce(filePath, 'delete', debounceMs));
  }

  /** Stop watching and clear all pending timers. */
  async stop(): Promise<void> {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.queue = [];

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /** Number of files waiting in the queue. */
  get queueLength(): number {
    return this.queue.length;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private debounce(filePath: string, type: 'upsert' | 'delete', delayMs: number): void {
    const absPath = path.resolve(filePath);
    let storedKey: string;
    try {
      storedKey = makeStoredKey(absPath, this.config.directories);
    } catch {
      return; // file outside configured directories
    }

    // Clear any existing timer for this file
    const existing = this.debounceTimers.get(storedKey);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(storedKey);
      this.enqueue(absPath, storedKey, type);
    }, delayMs);

    this.debounceTimers.set(storedKey, timer);
  }

  private enqueue(absPath: string, storedKey: string, type: 'upsert' | 'delete'): void {
    // Deduplicate: remove any existing entry for this file
    this.queue = this.queue.filter((item) => item.storedKey !== storedKey);
    this.queue.push({ absPath, storedKey, type });
    // Notify SiloManager to schedule a global-queue run rather than processing
    // directly, so only one silo indexes at a time.
    this.onQueueFilled?.();
  }

  /**
   * Drain the queue: prepare all queued files, flush to DB, emit events.
   * Called by SiloManager when the global IndexingQueue grants this silo its turn.
   */
  async runQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    // Prepare all queued files, accumulating results for a single batched flush
    const upserts: Array<{ prepared: PreparedFile; absPath: string; durationMs: number }> = [];
    const deletes: Array<{ storedKey: string; absPath: string }> = [];
    const errors: WatcherEvent[] = [];

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;

      try {
        if (item.type === 'delete') {
          deletes.push({ storedKey: item.storedKey, absPath: item.absPath });
        } else {
          const start = performance.now();
          const prepared = await prepareFile(item.absPath, item.storedKey, this.embeddingService);
          upserts.push({ prepared, absPath: item.absPath, durationMs: performance.now() - start });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[watcher] Error processing ${item.absPath}:`, message);
        errors.push({
          timestamp: new Date(),
          siloName: this.config.name,
          filePath: item.absPath,
          eventType: 'error',
          errorMessage: message,
        });
      }
    }

    // Flush all prepared files + deletes in one transaction
    if (upserts.length > 0 || deletes.length > 0) {
      flushPreparedFiles(
        this.db,
        upserts.map((u) => ({
          filePath: u.prepared.storedKey,
          chunks: u.prepared.chunks,
          embeddings: u.prepared.embeddings,
        })),
        deletes.map((d) => ({ filePath: d.storedKey, deleteMtime: false })),
      );
    }

    // Emit events after the flush succeeds
    for (const u of upserts) {
      this.emit({
        timestamp: new Date(),
        siloName: this.config.name,
        filePath: u.absPath,
        eventType: 'indexed',
        chunkCount: u.prepared.chunks.length,
        durationMs: u.durationMs,
      });
    }
    for (const d of deletes) {
      this.emit({
        timestamp: new Date(),
        siloName: this.config.name,
        filePath: d.absPath,
        eventType: 'deleted',
      });
    }
    for (const e of errors) {
      this.emit(e);
    }

    this.processing = false;

    // If more items arrived while we were processing, notify again so
    // SiloManager can schedule another queue run via the IndexingQueue.
    if (this.queue.length > 0) {
      this.onQueueFilled?.();
    }
  }

  private emit(event: WatcherEvent): void {
    if (this.onEvent) this.onEvent(event);
  }
}
