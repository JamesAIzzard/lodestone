/**
 * WatcherCoordinator — owns the live file watcher and its dedup against the
 * global IndexingQueue.
 *
 * Replaces the pre-refactor triple of `pendingWatcherEnqueue`,
 * `cancelWatcherEnqueue`, and `watcherIndexingDone` private fields on
 * SiloManager, plus the `startWatcher`, `handleWatcherEvent`, and
 * `scheduleWatcherIndexing` private methods.
 *
 * Behaviour preserved:
 *   - Bursts of file changes during an in-flight watcher run produce at most
 *     one queued IndexingQueue slot. Items accumulate in the watcher's
 *     internal queue and drain when the slot runs.
 *   - On every `'indexed'` event, the silo's mtime cache is refreshed
 *     (in-memory + DB) via `MtimeIndex`. On `'deleted'`, the entry is
 *     removed.
 *   - Every event is appended to the activity log.
 *   - State transitions follow the IndexingQueue lifecycle:
 *     `waiting` (only fires when something else holds the lock) → `indexing`
 *     → `ready` (only when the watcher's queue is empty after the run).
 *   - On a successful run that returns to `ready`, the manager's
 *     errorMessage is cleared via the injected `onIdle` callback.
 */

import fs from 'node:fs';
import type { EmbeddingService } from '../embedding';
import type { ResolvedSiloConfig } from '../config';
import type { IndexingQueue } from '../indexing-queue';
import {
  type SiloWatcherLike,
  type SiloWatcherFactory,
  type WatcherEvent,
  type WatcherStoreOps,
} from '../watcher';
import { makeStoredKey } from '../store/paths';
import type { MtimeIndex } from './mtime-index';
import type { ActivityLog } from './activity-log';
import type { SiloLifecycle } from './silo-lifecycle';

/**
 * Snapshot of indexing progress shared between SiloManager (writer for
 * doStart's reconcile) and WatcherCoordinator (writer for the watcher run).
 * Must structurally match the `reconcileProgress` field on SiloManager so
 * `getStatus()` can emit it unchanged.
 */
export interface ReconcileProgressSnapshot {
  current: number;
  total: number;
  batchChunks?: number;
  batchChunkLimit?: number;
  filePath?: string;
  fileSize?: number;
  fileStage?: string;
  elapsedMs?: number;
  embedDone?: number;
  embedTotal?: number;
}

export interface WatcherCoordinatorDeps {
  lifecycle: SiloLifecycle;
  mtimes: MtimeIndex;
  activity: ActivityLog;
  indexingQueue: IndexingQueue;
  watcherFactory: SiloWatcherFactory;
  /** Live config snapshot. Re-read on every relevant call (config can mutate). */
  getConfig: () => ResolvedSiloConfig;
  /** Live embedding handle. `null` when stopped or before `doStart` wires it. */
  getEmbedding: () => EmbeddingService | null;
  /** Build a fresh WatcherStoreOps bound to the current siloId. */
  makeStoreOps: () => WatcherStoreOps;
  /** Called with progress snapshots during an in-flight run, or `undefined` when idle. */
  onProgress: (progress: ReconcileProgressSnapshot | undefined) => void;
  /** Fired after a successful watcher run returns the silo to `'ready'`. */
  onIdle: () => void;
}

export class WatcherCoordinator {
  private watcher: SiloWatcherLike | null = null;

  /** True while a queue slot is queued or in-flight. Prevents duplicate enqueue. */
  private pendingEnqueue = false;
  /** Cancel function for the active queue slot. Cleared once the task starts. */
  private cancelEnqueue: (() => void) | null = null;
  /** Resolves when the in-flight queue task finishes. */
  private indexingDone: Promise<void> | null = null;

  constructor(private readonly deps: WatcherCoordinatorDeps) {}

  /**
   * Create the watcher and start it. No-op if no embedding service is ready
   * (matches the pre-refactor `startWatcher` guard).
   */
  start(): void {
    if (this.watcher) return;
    const embedding = this.deps.getEmbedding();
    if (!embedding) return;

    const config = this.deps.getConfig();
    this.watcher = this.deps.watcherFactory(
      config,
      embedding,
      this.deps.makeStoreOps(),
    );
    this.watcher.setQueueFilledHandler(() => this.scheduleIndexing());
    this.watcher.on((event) => this.handleEvent(event));
    this.watcher.start();
  }

  /**
   * Cancel any queued-but-not-yet-running IndexingQueue slot. Synchronous so
   * SiloManager.stop() can free the queue early — before awaiting startPromise
   * — and unblock other silos waiting for a turn.
   *
   * If the slot was cancelled before the task started, the in-flight promise
   * dangles (the task's resolver is never called). We discard it here so
   * `awaitInFlight()` returns immediately.
   */
  cancelPending(): void {
    if (this.cancelEnqueue) {
      this.cancelEnqueue();
      this.cancelEnqueue = null;
      this.pendingEnqueue = false;
      this.indexingDone = null;
    }
  }

  /**
   * Await the in-flight queue task if one is running. Used by SiloManager.stop()
   * to ensure the watcher's runQueue exits cleanly (between embedding batches)
   * before the database is closed underneath it.
   */
  async awaitInFlight(): Promise<void> {
    if (!this.indexingDone) return;
    await this.indexingDone.catch((): void => undefined);
    this.indexingDone = null;
  }

  /**
   * Stop and discard the running watcher. Idempotent. Used both by
   * SiloManager.stop() (after cancelPending + awaitInFlight) and by
   * reconcileAndRestartWatcher (which restarts a fresh watcher afterward).
   */
  async disposeWatcher(): Promise<void> {
    if (!this.watcher) return;
    await this.watcher.stop();
    this.watcher = null;
  }

  /** True while a queue slot is queued or in-flight. Exposed for tests. */
  get hasPending(): boolean {
    return this.pendingEnqueue;
  }

  /** True while a watcher is active. Exposed for tests. */
  get isStarted(): boolean {
    return this.watcher !== null;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private handleEvent(event: WatcherEvent): void {
    this.deps.activity.append(event);

    // Update mtimes via MtimeIndex (fire-and-forget — never block the watcher).
    // event.filePath is an absolute path from the watcher; convert to stored key.
    const directories = this.deps.getConfig().indexedDirectories;
    if (event.eventType === 'indexed') {
      try {
        const storedKey = makeStoredKey(event.filePath, directories);
        const stat = fs.statSync(event.filePath);
        this.deps.mtimes.indexed(storedKey, stat.mtimeMs).catch((): void => undefined);
      } catch {
        // File vanished between indexing and stat — rare but harmless.
      }
    } else if (event.eventType === 'deleted') {
      try {
        const storedKey = makeStoredKey(event.filePath, directories);
        this.deps.mtimes.deleted(storedKey).catch((): void => undefined);
      } catch {
        // Path outside configured directories — harmless.
      }
    }

    // File-level errors (extraction failures, parse errors, etc.) are logged
    // to the activity feed only; they don't change the silo's overall state.
    // State transitions are managed by scheduleIndexing().
  }

  /**
   * Request a turn on the global IndexingQueue to drain the watcher's file queue.
   * Deduplicates: if a turn is already queued, does nothing — items accumulate
   * in the watcher's internal queue and will be processed when the turn arrives.
   */
  private scheduleIndexing(): void {
    if (this.pendingEnqueue) return;
    this.pendingEnqueue = true;

    // Track the in-flight task so SiloManager.stop() can await it before
    // closing resources.
    let resolveIndexingDone!: () => void;
    this.indexingDone = new Promise<void>((r) => {
      resolveIndexingDone = r;
    });

    const config = this.deps.getConfig();
    this.cancelEnqueue = this.deps.indexingQueue.enqueue(
      config.name,
      () => {
        if (!this.deps.lifecycle.stopRequested) this.deps.lifecycle.transition('waiting');
      },
      () => {
        if (!this.deps.lifecycle.stopRequested) this.deps.lifecycle.transition('indexing');
      },
      async () => {
        this.pendingEnqueue = false;
        this.cancelEnqueue = null;
        try {
          if (this.watcher && !this.deps.lifecycle.stopRequested) {
            await this.watcher.runQueue(
              (progress) => {
                this.deps.onProgress({
                  current: progress.current,
                  total: progress.total,
                  filePath: progress.filePath,
                  fileSize: progress.fileSize,
                  fileStage: progress.fileStage,
                  batchChunks: progress.batchChunks,
                  batchChunkLimit: progress.batchChunkLimit,
                  embedDone: progress.embedDone,
                  embedTotal: progress.embedTotal,
                });
              },
              () => this.deps.lifecycle.stopRequested,
            );
          }
        } catch (err) {
          // Log but don't propagate — guarantees we always reach the recovery below.
          console.error(`[silo:${config.name}] Watcher runQueue error:`, err);
        }
        this.deps.onProgress(undefined);
        this.indexingDone = null;
        resolveIndexingDone();
        // runQueue() re-fires onQueueFilled if items arrived mid-run, which
        // schedules another turn. Set ready only if truly idle.
        if (
          !this.deps.lifecycle.stopRequested &&
          (!this.watcher || this.watcher.queueLength === 0)
        ) {
          this.deps.lifecycle.transition('ready');
          this.deps.onIdle();
        }
      },
    );
  }
}
