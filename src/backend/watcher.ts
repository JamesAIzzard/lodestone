/**
 * File watcher for a single silo.
 *
 * Watches configured directories for file changes, debounces events,
 * and dispatches to the indexing pipeline. Files are processed sequentially
 * to avoid overwhelming the embedding service.
 */

import { watch, type FSWatcher } from 'chokidar';
import path from 'node:path';
import type { EmbeddingService } from './embedding';
import { indexFile, removeFile } from './pipeline';
import { makeStoredKey, type SiloDatabase } from './store';
import type { ResolvedSiloConfig } from './config';
import type { ActivityEventType } from '../shared/types';

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

  constructor(
    private readonly config: ResolvedSiloConfig,
    private readonly embeddingService: EmbeddingService,
    private readonly db: SiloDatabase,
  ) {}

  /** Register a listener for watcher events (activity feed). */
  on(handler: WatcherEventHandler): void {
    this.onEvent = handler;
  }

  /** Start watching the silo directories. */
  start(): void {
    if (this.watcher) return;

    // chokidar v4+ removed glob support — watch directories directly and
    // filter by extension + ignore patterns via the `ignored` callback.
    const extSet = new Set(this.config.extensions.map((e) => e.toLowerCase()));
    const ignoreSet = new Set(this.config.ignore.map((p) => p.toLowerCase()));

    this.watcher = watch(this.config.directories, {
      ignored: (filePath, stats) => {
        const base = path.basename(filePath).toLowerCase();
        // Always allow directories through so chokidar recurses into them,
        // but skip ignored directory names.
        if (!stats || stats.isDirectory()) {
          return ignoreSet.has(base);
        }
        // For files, reject unless the extension is in the configured set.
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
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;

      try {
        if (item.type === 'delete') {
          await removeFile(item.storedKey, this.db);
          this.emit({
            timestamp: new Date(),
            siloName: this.config.name,
            filePath: item.absPath,
            eventType: 'deleted',
          });
        } else {
          const result = await indexFile(item.absPath, item.storedKey, this.embeddingService, this.db);
          this.emit({
            timestamp: new Date(),
            siloName: this.config.name,
            filePath: item.absPath,
            eventType: 'indexed',
            chunkCount: result.chunkCount,
            durationMs: result.durationMs,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[watcher] Error processing ${item.absPath}:`, message);
        this.emit({
          timestamp: new Date(),
          siloName: this.config.name,
          filePath: item.absPath,
          eventType: 'error',
          errorMessage: message,
        });
      }
    }

    this.processing = false;
  }

  private emit(event: WatcherEvent): void {
    if (this.onEvent) this.onEvent(event);
  }
}
