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
import type { SiloDatabase } from './store';
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
  private queue: Array<{ filePath: string; type: 'upsert' | 'delete' }> = [];
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

    const globs = this.config.directories.flatMap((dir) =>
      this.config.extensions.map((ext) => path.join(dir, '**', `*${ext}`)),
    );

    this.watcher = watch(globs, {
      ignored: this.config.ignore.map((pattern) => `**/${pattern}/**`),
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

  /** Whether the watcher is currently processing files. */
  get isProcessing(): boolean {
    return this.processing;
  }

  /** Number of files waiting in the queue. */
  get queueLength(): number {
    return this.queue.length;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private debounce(filePath: string, type: 'upsert' | 'delete', delayMs: number): void {
    const normalized = path.resolve(filePath);

    // Clear any existing timer for this file
    const existing = this.debounceTimers.get(normalized);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(normalized);
      this.enqueue(normalized, type);
    }, delayMs);

    this.debounceTimers.set(normalized, timer);
  }

  private enqueue(filePath: string, type: 'upsert' | 'delete'): void {
    // Deduplicate: remove any existing entry for this file
    this.queue = this.queue.filter((item) => item.filePath !== filePath);
    this.queue.push({ filePath, type });
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;

      try {
        if (item.type === 'delete') {
          await removeFile(item.filePath, this.db);
          this.emit({
            timestamp: new Date(),
            siloName: this.config.name,
            filePath: item.filePath,
            eventType: 'deleted',
          });
        } else {
          const result = await indexFile(item.filePath, this.embeddingService, this.db);
          this.emit({
            timestamp: new Date(),
            siloName: this.config.name,
            filePath: item.filePath,
            eventType: 'indexed',
            chunkCount: result.chunkCount,
            durationMs: result.durationMs,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[watcher] Error processing ${item.filePath}:`, message);
        this.emit({
          timestamp: new Date(),
          siloName: this.config.name,
          filePath: item.filePath,
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
