/**
 * File watcher for a single silo.
 *
 * Watches configured directories for file changes, debounces events,
 * and dispatches to the shared indexing loop. Files are processed
 * sequentially to avoid overwhelming the embedding service.
 *
 * V2: The watcher no longer touches the database directly. It feeds
 * queued file changes into indexFileLoop() which handles prepare →
 * batch → flush. Database writes are batched automatically.
 */

import { watch, type FSWatcher } from 'chokidar';
import fs from 'node:fs';
import path from 'node:path';
import type { EmbeddingService } from './embedding';
import { indexFileLoop, type IndexLoopProgress } from './pipeline';
import { makeStoredKey, makeStoredDirKey, resolveStoredKey } from './store/paths';
import type { FlushUpsert, FlushDelete, FlushResult } from './store/types';
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

/** Async store operations provided by SiloManager (routed through the store proxy). */
export interface WatcherStoreOps {
  flush(upserts: FlushUpsert[], deletes: FlushDelete[]): Promise<FlushResult>;
  insertDirEntry(dirPath: string): Promise<boolean>;
  deleteDirEntry(dirPath: string): Promise<number | null>;
}

// Re-export for the silo-manager's progress callback signature.
export type { IndexLoopProgress };

// ── SiloWatcher ──────────────────────────────────────────────────────────────

export class SiloWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private processing = false;
  private queue: Array<{ absPath: string; storedKey: string; type: 'upsert' | 'delete' }> = [];
  /** Pending directory additions (absolute paths). */
  private dirAddQueue: string[] = [];
  /** Pending directory removals (stored dir-key strings). */
  private dirRemoveQueue: string[] = [];
  private onEvent: WatcherEventHandler | null = null;
  private onQueueFilled?: () => void;

  constructor(
    private readonly config: ResolvedSiloConfig,
    private readonly embeddingService: EmbeddingService,
    private readonly storeOps: WatcherStoreOps,
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
    this.watcher.on('addDir', (dirPath: string) => this.debounceDir(dirPath, 'add', debounceMs));
    this.watcher.on('unlinkDir', (dirPath: string) => this.debounceDir(dirPath, 'remove', debounceMs));
  }

  /** Stop watching and clear all pending timers. */
  async stop(): Promise<void> {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.queue = [];
    this.dirAddQueue = [];
    this.dirRemoveQueue = [];

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /** Number of items (files + dirs) waiting in the queue. */
  get queueLength(): number {
    return this.queue.length + this.dirAddQueue.length + this.dirRemoveQueue.length;
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

  private debounceDir(absDirPath: string, type: 'add' | 'remove', delayMs: number): void {
    const absPath = path.resolve(absDirPath);
    // Use path-only key (no type) so that add→remove or remove→add within the
    // debounce window collapses to just the last event. This prevents spurious
    // dir-removed events when macOS/Windows creates "untitled folder" then
    // immediately renames it — the unlinkDir overwrites the addDir timer.
    const debounceKey = `dir:${absPath}`;

    const existing = this.debounceTimers.get(debounceKey);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(debounceKey);
      this.enqueueDir(absPath, type);
    }, delayMs);

    this.debounceTimers.set(debounceKey, timer);
  }

  private enqueueDir(absDirPath: string, type: 'add' | 'remove'): void {
    if (type === 'add') {
      // Deduplicate
      if (!this.dirAddQueue.includes(absDirPath)) {
        this.dirAddQueue.push(absDirPath);
      }
    } else {
      const storedDirKey = makeStoredDirKey(absDirPath, this.config.directories);
      if (storedDirKey && !this.dirRemoveQueue.includes(storedDirKey)) {
        this.dirRemoveQueue.push(storedDirKey);
      }
    }
    this.onQueueFilled?.();
  }

  /**
   * Drain the queue: index queued files via the shared loop, then handle
   * deletes and directory events.
   *
   * Called by SiloManager when the global IndexingQueue grants this silo
   * its turn. The optional `onProgress` callback enables the same
   * filename + stage UI that reconcile shows.
   */
  async runQueue(
    onProgress?: (progress: IndexLoopProgress) => void,
    shouldStop?: () => boolean,
  ): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      // Partition queue into upserts and deletes, stat files for size
      const upsertJobs: Array<{ absPath: string; storedKey: string; fileSize?: number }> = [];
      const deletes: Array<{ storedKey: string; absPath: string }> = [];

      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        if (item.type === 'delete') {
          deletes.push({ storedKey: item.storedKey, absPath: item.absPath });
        } else {
          let fileSize: number | undefined;
          try { fileSize = fs.statSync(item.absPath).size; } catch { /* vanished */ }
          upsertJobs.push({ absPath: item.absPath, storedKey: item.storedKey, fileSize });
        }
      }

      // Index upserts through the shared prepare → batch → flush loop
      if (upsertJobs.length > 0) {
        await indexFileLoop(upsertJobs, {
          embeddingService: this.embeddingService,
          shouldStop,
          flush: async (upserts) => {
            await this.storeOps.flush(upserts, []);
          },
          onProgress,
          onBatchFlushed: (files) => {
            for (const f of files) {
              this.emit({
                timestamp: new Date(),
                siloName: this.config.name,
                filePath: f.absPath,
                eventType: 'indexed',
                chunkCount: f.chunkCount,
                durationMs: f.durationMs,
              });
            }
          },
          onError: (absPath, message) => {
            console.error(`[watcher] Error processing ${absPath}:`, message);
            this.emit({
              timestamp: new Date(),
              siloName: this.config.name,
              filePath: absPath,
              eventType: 'error',
              errorMessage: message,
            });
          },
        });
      }

      // Flush deletes separately
      if (deletes.length > 0) {
        await this.storeOps.flush(
          [],
          deletes.map((d) => ({ storedKey: d.storedKey, deleteMtime: false })),
        );
        for (const d of deletes) {
          this.emit({
            timestamp: new Date(),
            siloName: this.config.name,
            filePath: d.absPath,
            eventType: 'deleted',
          });
        }
      }

      // Process queued directory additions
      const pendingDirAdds = this.dirAddQueue.splice(0);
      for (const absDirPath of pendingDirAdds) {
        const storedDirKey = makeStoredDirKey(absDirPath, this.config.directories);
        if (storedDirKey) {
          try {
            const inserted = await this.storeOps.insertDirEntry(storedDirKey);
            if (inserted) {
              this.emit({ timestamp: new Date(), siloName: this.config.name, filePath: absDirPath, eventType: 'dir-added' });
            }
          } catch { /* ignore */ }
        }
      }

      // Process queued directory removals
      const pendingDirRemoves = this.dirRemoveQueue.splice(0);
      for (const storedDirKey of pendingDirRemoves) {
        try {
          const deletedId = await this.storeOps.deleteDirEntry(storedDirKey);
          if (deletedId !== null) {
            const absPath = resolveStoredKey(storedDirKey, this.config.directories);
            this.emit({ timestamp: new Date(), siloName: this.config.name, filePath: absPath, eventType: 'dir-removed' });
          }
        } catch (err) {
          console.error(`[watcher] Error removing directory ${storedDirKey}:`, err);
        }
      }
    } finally {
      this.processing = false;
    }

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
