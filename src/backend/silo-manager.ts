/**
 * Silo Manager — top-level orchestrator for a single silo.
 *
 * Ties together the embedding service, store proxy, file watcher,
 * and configuration for one silo. The Electron main process interacts
 * with this class for all silo operations.
 *
 * SQLite operations route asynchronously through the store proxy to the
 * store worker thread, keeping database I/O off the main process.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ResolvedSiloConfig } from './config';
import type { EmbeddingService } from './embedding';
import { type StoreFacade, proxyStoreFacade } from './store-facade';
import { makeStoredKey, makeStoredDirKey, resolveStoredKey } from './store/paths';
import { peekFileCount } from './store/peek';
import type { FlushUpsert } from './store/types';
import { prepareFile } from './pipeline';
import {
  type SiloWatcherFactory,
  type WatcherEvent,
  type WatcherStoreOps,
  defaultSiloWatcherFactory,
} from './watcher';
import {
  reconcile,
  type ReconcileProgressHandler,
  type ReconcileEventHandler,
  type ReconcileResult,
  type ReconcileStoreOps,
} from './reconcile';
import type { WatcherState, SearchParams } from '../shared/types';
import type { FileResult } from './search';
import type { DirectorySearchParams, SiloDirectorySearchResult } from './directory-search';
import { IndexingQueue } from './indexing-queue';
import { MtimeIndex } from './silo/mtime-index';
import { ActivityLog } from './silo/activity-log';
import { SiloConfigStore } from './silo/silo-config-store';
import { SiloLifecycle } from './silo/silo-lifecycle';
import {
  WatcherCoordinator,
  type ReconcileProgressSnapshot,
} from './silo/watcher-coordinator';
import { DirectoryExplorer } from './silo/directory-explorer';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SiloManagerStatus {
  name: string;
  indexedFileCount: number;
  chunkCount: number;
  lastUpdated: Date | null;
  databaseSizeBytes: number;
  watcherState: WatcherState;
  errorMessage?: string;
  reconcileProgress?: {
    current: number;
    total: number;
    batchChunks?: number;
    batchChunkLimit?: number;
    filePath?: string;
    fileStage?: string;
    elapsedMs?: number;
    embedDone?: number;
    embedTotal?: number;
  };
  /** True when the configured model differs from the model used to build the index */
  modelMismatch?: boolean;
  /** Absolute path to the silo's SQLite database file */
  resolvedDbPath: string;
}

// ── SiloManager ──────────────────────────────────────────────────────────────

const MAX_ACTIVITY_EVENTS = 200;

export class SiloManager {
  private embeddingService: EmbeddingService | null = null;
  /** True when this silo has an open database in the store worker. */
  private dbOpen = false;
  /**
   * Lifecycle FSM + cancellation token. Phase reads/writes go through
   * `lifecycle.phase()` / `transition()`; cancellation reads via
   * `lifecycle.stopRequested`.
   */
  private readonly lifecycle = new SiloLifecycle();
  private stateChangeListener?: () => void;
  /** Last external WatcherState fired to `stateChangeListener` — used to filter no-op edges. */
  private lastFiredWatcherState: WatcherState;
  private errorMessage?: string;
  private reconcileProgress?: ReconcileProgressSnapshot;
  private readonly mtimes: MtimeIndex;
  private readonly activity: ActivityLog;
  private readonly configStore: SiloConfigStore;
  /** Owns the live file watcher, the queue-dedup triple, and the watcher-event handler. */
  private readonly watcherCoord: WatcherCoordinator;
  /** Owns directory exploration: empty-query roots + abs-path/stored-key translation. */
  private readonly explorer: DirectoryExplorer;
  private cachedFileCount = 0;
  private cachedChunkCount = 0;
  private cachedSizeBytes = 0;
  /** True when meta model differs from configured model */
  private modelMismatch = false;

  /** Tracks the in-flight start() so stop() can wait for it to settle. */
  private startPromise: Promise<void> | null = null;

  constructor(
    config: ResolvedSiloConfig,
    private sharedEmbeddingService: EmbeddingService,
    private readonly userDataDir: string,
    private readonly indexingQueue: IndexingQueue,
    private readonly store: StoreFacade = proxyStoreFacade,
    private readonly watcherFactory: SiloWatcherFactory = defaultSiloWatcherFactory,
  ) {
    this.configStore = new SiloConfigStore(config, this.store, () => this.dbOpen);
    this.mtimes = new MtimeIndex(config.name, this.store);
    this.activity = new ActivityLog(
      config.name,
      this.store,
      () => this.config.name,
      MAX_ACTIVITY_EVENTS,
      () => this.config.activityLogLimit,
    );
    this.explorer = new DirectoryExplorer(
      config.name,
      this.store,
      () => this.config.directories,
    );
    this.watcherCoord = new WatcherCoordinator({
      lifecycle: this.lifecycle,
      mtimes: this.mtimes,
      activity: this.activity,
      indexingQueue: this.indexingQueue,
      watcherFactory: this.watcherFactory,
      getConfig: () => this.config,
      getEmbedding: () => this.embeddingService,
      makeStoreOps: () => this.makeWatcherStoreOps(),
      onProgress: (progress) => {
        this.reconcileProgress = progress;
      },
      onIdle: () => {
        this.errorMessage = undefined;
      },
    });
    // Forward only external-WatcherState changes to the registered listener.
    // Internal phase edges that map to the same wire value (e.g.
    // 'indexing' ↔ 'maintenance') are not visible to the renderer, so
    // surfacing them would be a behaviour change.
    this.lastFiredWatcherState = this.lifecycle.watcherState();
    this.lifecycle.onChange(() => {
      const next = this.lifecycle.watcherState();
      if (next === this.lastFiredWatcherState) return;
      this.lastFiredWatcherState = next;
      try {
        this.stateChangeListener?.();
      } catch (err) {
        console.error(`[silo:${this.config.name}] Error in state change listener:`, err);
      }
    });
  }

  /** Live config snapshot. Reads delegate to the configStore collaborator. */
  private get config(): ResolvedSiloConfig {
    return this.configStore.current;
  }

  /** The silo ID used for all store proxy calls. */
  private get siloId(): string {
    return this.configStore.siloId;
  }

  /** Register a listener for watcher events. Only one listener is supported. */
  onEvent(listener: (event: WatcherEvent) => void): void {
    this.activity.setListener(listener);
  }

  /** Register a listener for watcher state transitions. Only one listener is supported. */
  onStateChange(listener: () => void): void {
    this.stateChangeListener = listener;
  }

  /**
   * Update the configured model for this silo and re-check for mismatch.
   *
   * This does NOT restart the silo or change the running embedding service —
   * it just updates the config so that:
   *  1. silos:list returns the new model
   *  2. modelMismatch is set if the new model differs from what built the index
   *
   * The user must rebuild the index for the new model to take effect.
   */
  async updateModel(model: string): Promise<void> {
    this.configStore.apply({ model });

    // Re-check mismatch against stored meta
    if (this.dbOpen) {
      const meta = await this.store.loadMeta(this.siloId);
      if (meta) {
        this.modelMismatch = meta.model !== model;
      } else {
        // No meta but DB exists — legacy or corrupt, flag mismatch
        this.modelMismatch = true;
      }
    }
    await this.configStore.persist();
  }

  /** Update the silo description and persist to DB config blob. */
  async updateDescription(description: string): Promise<void> {
    this.configStore.apply({ description });
    await this.configStore.persist();
  }

  /** Update the silo display name and persist to DB config blob. */
  async updateName(name: string): Promise<void> {
    this.configStore.apply({ name });
    await this.configStore.persist();
  }

  /**
   * Replace the shared embedding service.
   * Call this before rebuild() when the configured model has changed,
   * so the new index is built with the correct model and dimensions.
   */
  updateEmbeddingService(service: EmbeddingService): void {
    this.sharedEmbeddingService = service;
  }

  // ── Config hot-swap ────────────────────────────────────────────────────

  /**
   * Update ignore patterns, re-reconcile to remove now-ignored files, and restart the watcher.
   */
  async updateIgnorePatterns(ignore: string[], ignoreFiles: string[]): Promise<void> {
    this.configStore.apply({ ignore, ignoreFiles });
    await this.reconcileAndRestartWatcher('ignore pattern');
  }

  /**
   * Update file extensions, re-reconcile to index/remove files, and restart the watcher.
   */
  async updateExtensions(extensions: string[]): Promise<void> {
    this.configStore.apply({ extensions });
    await this.reconcileAndRestartWatcher('extension');
  }

  /** Re-walk directories and index new/changed/removed files without deleting the DB. */
  async rescan(): Promise<void> {
    await this.reconcileAndRestartWatcher('manual rescan');
  }

  /**
   * Stop the watcher, re-reconcile the database against disk using the current config,
   * then restart the watcher. Used after config changes that affect which files are indexed.
   */
  private async reconcileAndRestartWatcher(reason: string): Promise<void> {
    await this.watcherCoord.disposeWatcher();

    if (this.embeddingService && this.dbOpen && !this.lifecycle.stopRequested) {
      await new Promise<void>((resolve) => {
        this.indexingQueue.enqueue(
          this.config.name,
          () => {
            if (!this.lifecycle.stopRequested) this.lifecycle.transition('waiting');
          },
          () => {
            if (!this.lifecycle.stopRequested) this.lifecycle.transition('indexing');
          },
          async () => {
            if (this.lifecycle.stopRequested) {
              resolve();
              return;
            }
            try {
              const result = await reconcile(
                this.config,
                this.embeddingService!,
                this.makeReconcileStoreOps(),
                this.mtimes,
                this.onReconcileProgress,
                this.onReconcileEvent,
              );
              const changes = [
                result.filesAdded > 0 && `+${result.filesAdded}`,
                result.filesRemoved > 0 && `-${result.filesRemoved}`,
                result.filesUpdated > 0 && `~${result.filesUpdated}`,
              ]
                .filter(Boolean)
                .join(' ');
              if (changes) {
                console.log(`[silo:${this.config.name}] ${reason} change: ${changes} files`);
              }
            } catch (err) {
              if (!this.lifecycle.stopRequested) {
                console.error(
                  `[silo:${this.config.name}] Re-reconciliation after ${reason} change failed:`,
                  err,
                );
              }
            }
            this.reconcileProgress = undefined;
            resolve();
          },
        );
      });

      if (!this.lifecycle.stopRequested) {
        await this.configStore.persist();
        this.lifecycle.transition('ready');
        this.watcherCoord.start();
        console.log(`[silo:${this.config.name}] Watcher restarted after ${reason} change`);
      }
    }
  }

  /** Update the silo colour and persist to DB config blob. */
  async updateColor(color: string): Promise<void> {
    this.configStore.apply({ color });
    await this.configStore.persist();
  }

  /** Update the silo icon and persist to DB config blob. */
  async updateIcon(icon: string): Promise<void> {
    this.configStore.apply({ icon });
    await this.configStore.persist();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Initialize all subsystems and start watching. */
  async start(): Promise<void> {
    this.lifecycle.resetStopRequest();
    this.startPromise = this.doStart().catch((err) => {
      if (!this.lifecycle.stopRequested) {
        // Transition to 'error' from whatever phase the throw landed in.
        this.lifecycle.transition('error');
        this.errorMessage = err instanceof Error ? err.message : String(err);
        this.reconcileProgress = undefined;
      }
      throw err;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    await this.initEmbedding();
    await this.openDatabase();
    await this.checkAndPersistMeta();
    await this.loadInitialState();
    if (this.lifecycle.stopRequested) return;
    await this.runStartupReconcile();
    await this.configStore.persist();
    if (this.lifecycle.stopRequested) return;
    this.lifecycle.transition('ready');
    this.watcherCoord.start();
    console.log(
      `[silo:${this.config.name}] Started (watching ${this.config.directories.join(', ')})`,
    );
  }

  /** Step 1 — point at the shared embedding service and wait for it to load. */
  private async initEmbedding(): Promise<void> {
    this.embeddingService = this.sharedEmbeddingService;
    await this.embeddingService.ensureReady();
  }

  /** Step 2 — open (or create) the SQLite database via the store worker. */
  private async openDatabase(): Promise<void> {
    const dbPath = this.resolveDbPath();
    await this.store.open(this.siloId, dbPath, this.embeddingService!.dimensions);
    this.dbOpen = true;
    console.log(`[silo:${this.config.name}] Opened database at ${dbPath}`);
  }

  /** Step 3 — check the meta row for model mismatch; write meta on first run. */
  private async checkAndPersistMeta(): Promise<void> {
    const meta = await this.store.loadMeta(this.siloId);
    if (meta) {
      if (meta.model !== this.config.model) {
        this.modelMismatch = true;
        console.warn(
          `[silo:${this.config.name}] Model mismatch: index built with "${meta.model}" but config uses "${this.config.model}". Rebuild required.`,
        );
      }
    } else {
      // First run or fresh DB — write meta now
      await this.store.saveMeta(this.siloId, this.config.model, this.embeddingService!.dimensions);
      this.modelMismatch = false;
    }
  }

  /** Step 4 — load mtimes (for offline change detection) and the activity log. */
  private async loadInitialState(): Promise<void> {
    await this.mtimes.loadFromStore();
    await this.activity.loadFromStore();
  }

  /**
   * Step 5 — reconcile the index against disk via the global IndexingQueue
   * (only one silo embeds at a time), then run WAL maintenance while the
   * queue slot is still held. The queue boundary spans both reconcile and
   * maintenance so that other silos don't slip in between checkpoint and
   * VACUUM. {@link runWalMaintenance} is called from the closure rather
   * than at the doStart level to preserve that boundary.
   */
  private async runStartupReconcile(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.indexingQueue.enqueue(
        this.config.name,
        () => {
          if (!this.lifecycle.stopRequested) this.lifecycle.transition('waiting');
        },
        () => {
          if (!this.lifecycle.stopRequested) this.lifecycle.transition('indexing');
        },
        async () => {
          if (this.lifecycle.stopRequested) {
            resolve();
            return;
          }
          try {
            const result = await reconcile(
              this.config,
              this.embeddingService!,
              this.makeReconcileStoreOps(),
              this.mtimes,
              this.onReconcileProgress,
              this.onReconcileEvent,
              () => this.lifecycle.stopRequested,
            );
            if (result.filesAdded > 0 || result.filesRemoved > 0 || result.filesUpdated > 0) {
              console.log(
                `[silo:${this.config.name}] Reconciliation: +${result.filesAdded} -${result.filesRemoved} ~${result.filesUpdated} (${(result.durationMs / 1000).toFixed(1)}s)`,
              );
            } else {
              console.log(`[silo:${this.config.name}] Reconciliation: index up to date`);
            }
            // Cache chunk count before maintenance so getStatus() can respond
            // without hitting the worker (which will be blocked by VACUUM).
            this.cachedChunkCount = await this.store.getChunkCount(this.siloId);
            this.lifecycle.transition('maintenance');

            // Show compacting stage in the UI during maintenance
            this.reconcileProgress = {
              current: this.mtimes.size,
              total: this.mtimes.size,
              fileStage: 'compacting',
            };

            // Yield so the renderer can process the "done" state before the
            // potentially expensive WAL checkpoint blocks the event loop.
            await new Promise<void>((r) => setImmediate(r));

            await this.runWalMaintenance(result);

            // Back to 'indexing' so getStatus() returns live data during
            // the gap before the 'ready' transition — the worker is no
            // longer blocked by VACUUM.
            this.lifecycle.transition('indexing');
          } catch (err) {
            if (this.lifecycle.stopRequested) {
              resolve();
              return;
            }
            console.error(`[silo:${this.config.name}] Reconciliation failed:`, err);
            this.lifecycle.transition('error');
            this.errorMessage = err instanceof Error ? err.message : String(err);
          }
          this.reconcileProgress = undefined;
          resolve();
        },
      );
    });
  }

  /**
   * Step 5b — checkpoint the WAL (TRUNCATE) and conditionally VACUUM. Runs
   * inside the IndexingQueue slot held by {@link runStartupReconcile}; the
   * caller is responsible for the surrounding 'maintenance' / 'indexing'
   * transitions and for clearing reconcileProgress on completion.
   *
   * VACUUM is skipped after pure-insert reconciliations (initial index) —
   * there are no free pages to reclaim, so VACUUM just rewrites the entire
   * DB for nothing.
   */
  private async runWalMaintenance(result: ReconcileResult): Promise<void> {
    const sizeBefore = this.readFileSizeFromDisk();

    const tCheckpoint = performance.now();
    await this.store.checkpoint(this.siloId, 'TRUNCATE');
    const sizeAfterCkpt = this.readFileSizeFromDisk();
    console.log(
      `[silo:${this.config.name}] Post-reconcile: WAL checkpoint(TRUNCATE) took ${(performance.now() - tCheckpoint).toFixed(1)}ms` +
        ` — ${(sizeBefore / 1048576).toFixed(1)}MB → ${(sizeAfterCkpt / 1048576).toFixed(1)}MB`,
    );

    if (result.filesRemoved > 0 || result.filesUpdated > 0) {
      const tVacuum = performance.now();
      await this.store.vacuum(this.siloId);
      const sizeAfterVac = this.readFileSizeFromDisk();
      console.log(
        `[silo:${this.config.name}] Post-reconcile: VACUUM took ${(performance.now() - tVacuum).toFixed(1)}ms` +
          ` — ${(sizeAfterCkpt / 1048576).toFixed(1)}MB → ${(sizeAfterVac / 1048576).toFixed(1)}MB`,
      );
    }
  }

  /** Graceful shutdown: stop watcher, close database. */
  async stop(): Promise<void> {
    this.lifecycle.requestStop();

    // Cancel any queued-but-not-yet-running watcher enqueue so it doesn't
    // block the IndexingQueue for other silos while we're shutting down.
    this.watcherCoord.cancelPending();

    // Wait for start() to finish so we don't tear down underneath it.
    if (this.startPromise) {
      await this.startPromise.catch((): void => undefined);
      this.startPromise = null;
    }

    // Wait for any in-flight watcher indexing task to wind down.
    // The task checks shouldStop (→ this.lifecycle.stopRequested) between
    // embedding batches and will exit quickly — at most one batch duration.
    await this.watcherCoord.awaitInFlight();

    await this.watcherCoord.disposeWatcher();

    if (this.dbOpen) {
      try {
        await this.store.checkpoint(this.siloId, 'TRUNCATE');
        await this.store.close(this.siloId);
      } catch {
        // Already closed or failed — harmless
      }
      this.dbOpen = false;
    }

    // Don't dispose the embedding service — it's shared across silos.
    // The main process manages its lifecycle.
    this.embeddingService = null;

    this.mtimes.clear();
    console.log(`[silo:${this.config.name}] Stopped`);
  }

  /** Stop the silo and mark it as stopped (persisted by the caller via config). */
  async freeze(): Promise<void> {
    // Cache stats before releasing resources
    this.cachedFileCount = this.mtimes.size;
    this.cachedChunkCount = this.dbOpen ? await this.store.getChunkCount(this.siloId) : 0;
    this.cachedSizeBytes = this.readFileSizeFromDisk();
    // stop() handles cancelling any pending watcher queue slot and
    // awaiting in-flight indexing before closing resources.
    await this.stop();
    this.lifecycle.transition('stopped');
  }

  /** Restart a stopped silo: reload database, reconcile, start watching. */
  async wake(): Promise<void> {
    // Load cached stats and set 'waiting' state so the card shows useful info
    // while the silo waits in the IndexingQueue before reconciliation starts.
    this.loadWaitingStatus();
    await this.start();
  }

  /**
   * Rebuild the entire index from scratch.
   * Stops the silo, deletes the database file on disk, clears mtimes,
   * then restarts (which triggers a full reconciliation).
   */
  async rebuild(): Promise<void> {
    console.log(`[silo:${this.config.name}] Rebuild requested`);
    const wasStopped = this.isStopped;

    // Stop everything gracefully
    if (!wasStopped) {
      await this.stop();
    }

    // Delete the database file and WAL/SHM companion files
    const dbPath = this.resolveDbPath();
    for (const filePath of [
      dbPath,
      dbPath + '-wal',
      dbPath + '-shm',
      // Also clean up any leftover Orama-era sidecar files
      path.join(path.dirname(dbPath), 'mtimes.json'),
      path.join(path.dirname(dbPath), 'meta.json'),
    ]) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (err) {
        console.error(`[silo:${this.config.name}] Failed to delete ${filePath}:`, err);
      }
    }

    // Clear in-memory state
    this.modelMismatch = false;
    this.cachedFileCount = 0;
    this.cachedChunkCount = 0;
    this.cachedSizeBytes = 0;

    // Restart — this will create a fresh database and run full reconciliation
    await this.start();
    console.log(`[silo:${this.config.name}] Rebuild complete`);
  }

  /** Load minimal status for a stopped silo without starting it. */
  loadStoppedStatus(): void {
    this.loadOfflineStatus('stopped');
  }
  loadWaitingStatus(): void {
    this.loadOfflineStatus('waiting');
  }

  private loadOfflineStatus(state: 'stopped' | 'waiting'): void {
    this.lifecycle.transition(state);
    this.cachedSizeBytes = this.readFileSizeFromDisk();
    this.cachedFileCount = peekFileCount(this.resolveDbPath());
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Whether this silo is currently stopped. */
  get isStopped(): boolean {
    return this.lifecycle.phase() === 'stopped';
  }

  /** Current watcher state (synchronous — safe for tray menu, UI labels, etc.). */
  get currentState(): WatcherState {
    return this.lifecycle.watcherState();
  }

  /** Decaying-sum search with a pre-computed query vector. */
  async search(queryVector: number[], params: SearchParams): Promise<FileResult[]> {
    if (!this.dbOpen) return [];
    // Convert absolute startPath → stored key prefix for DB filtering
    let storedStartPath = params.startPath;
    if (params.startPath) {
      const key = makeStoredDirKey(params.startPath, this.config.directories);
      if (key) {
        storedStartPath = key;
      } else {
        const rootIdx = this.config.directories.indexOf(params.startPath);
        if (rootIdx >= 0) {
          storedStartPath = `${rootIdx}:`;
        }
      }
    }
    const results = await this.store.search(this.siloId, queryVector, {
      ...params,
      startPath: storedStartPath,
    });
    // Resolve stored keys back to absolute file paths
    return results.map((r) => ({
      ...r,
      filePath: resolveStoredKey(r.filePath, this.config.directories),
    }));
  }

  /**
   * Immediately re-index a single file after an edit.
   * Fire-and-forget — caller should catch errors.
   */
  async reindexFile(absolutePath: string): Promise<void> {
    if (!this.embeddingService || !this.dbOpen || this.lifecycle.stopRequested) return;
    const storedKey = makeStoredKey(absolutePath, this.config.directories);
    const stat = fs.statSync(absolutePath);
    const prepared = await prepareFile(
      absolutePath,
      storedKey,
      this.embeddingService,
      stat.mtimeMs,
    );
    const upsert: FlushUpsert = {
      storedKey: prepared.storedKey,
      chunks: prepared.chunks,
      embeddings: prepared.embeddings,
      mtimeMs: prepared.mtimeMs,
    };
    await this.store.flush(this.siloId, [upsert], []);
    // Flush persisted the new mtime via the upsert; sync the in-memory cache.
    this.mtimes.recordIndexed(storedKey, stat.mtimeMs);
  }

  /**
   * Explore directory structure using segment Levenshtein and token coverage.
   * No embeddings needed — scoring operates on the query string directly.
   */
  async exploreDirectories(params: DirectorySearchParams): Promise<SiloDirectorySearchResult[]> {
    if (!this.dbOpen) return [];
    return this.explorer.explore(params);
  }

  /** Get the current status of this silo. */
  async getStatus(): Promise<SiloManagerStatus> {
    const phase = this.lifecycle.phase();
    const inMaintenance = phase === 'maintenance';
    // When the worker is blocked (stopped, waiting, or maintenance), return
    // cached stats immediately to prevent the UI from hanging.
    if (phase === 'stopped' || phase === 'waiting' || inMaintenance) {
      return {
        name: this.config.name,
        indexedFileCount: inMaintenance ? this.mtimes.size : this.cachedFileCount,
        chunkCount: this.cachedChunkCount,
        lastUpdated: this.activity.lastUpdated,
        databaseSizeBytes: inMaintenance
          ? this.readFileSizeFromDisk()
          : this.cachedSizeBytes,
        watcherState: this.lifecycle.watcherState(),
        errorMessage: this.errorMessage,
        reconcileProgress: this.reconcileProgress,
        modelMismatch: this.modelMismatch || undefined,
        resolvedDbPath: this.resolveDbPath(),
      };
    }

    const chunks = this.dbOpen ? await this.store.getChunkCount(this.siloId) : 0;
    const dbSize = this.readFileSizeFromDisk();

    return {
      name: this.config.name,
      indexedFileCount: this.mtimes.size,
      chunkCount: chunks,
      lastUpdated: this.activity.lastUpdated,
      databaseSizeBytes: dbSize,
      watcherState: this.lifecycle.watcherState(),
      errorMessage: this.errorMessage,
      reconcileProgress: this.reconcileProgress,
      modelMismatch: this.modelMismatch || undefined,
      resolvedDbPath: this.resolveDbPath(),
    };
  }

  /** Get recent activity events. */
  getActivityFeed(limit = 50): WatcherEvent[] {
    return this.activity.recent(limit);
  }

  /** Whether the index was built with a different model than currently configured. */
  hasModelMismatch(): boolean {
    return this.modelMismatch;
  }

  /** Get the resolved silo config. */
  getConfig(): ResolvedSiloConfig {
    return this.config;
  }

  /** Get the embedding service (used by MCP mode for search dispatch). */
  getEmbeddingService(): EmbeddingService | null {
    return this.embeddingService;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  /**
   * Create a WatcherStoreOps implementation that routes through the store proxy.
   */
  private makeWatcherStoreOps(): WatcherStoreOps {
    const id = this.siloId;
    return {
      flush: (upserts, deletes) => this.store.flush(id, upserts, deletes),
      insertDirEntry: (dirPath) => this.store.insertDirEntry(id, dirPath),
      deleteDirEntry: (dirPath) => this.store.deleteDirEntry(id, dirPath),
    };
  }

  /**
   * Create a ReconcileStoreOps implementation that routes through the store proxy.
   */
  private makeReconcileStoreOps(): ReconcileStoreOps {
    const id = this.siloId;
    return {
      flush: (upserts, deletes) => this.store.flush(id, upserts, deletes),
      syncDirectoriesWithDisk: (diskDirPaths) =>
        this.store.syncDirectoriesWithDisk(id, diskDirPaths),
      recomputeDirectoryCounts: () => this.store.recomputeDirectoryCounts(id),
      checkpoint: (mode) => this.store.checkpoint(id, mode),
    };
  }

  private onReconcileProgress: ReconcileProgressHandler = (progress) => {
    if (progress.phase === 'done') {
      this.reconcileProgress = undefined;
      return;
    }
    // scanning, indexing, or removing — all surface as 'indexing' in the UI
    if (this.lifecycle.phase() !== 'indexing') {
      this.lifecycle.transition('indexing');
    }
    if (progress.phase !== 'scanning') {
      // Only track numeric progress for indexing/removing phases
      this.reconcileProgress = {
        current: progress.current,
        total: progress.total,
        batchChunks: progress.batchChunks,
        batchChunkLimit: progress.batchChunkLimit,
        filePath: progress.filePath,
        fileSize: progress.fileSize,
        fileStage: progress.fileStage,
        elapsedMs: progress.elapsedMs,
        embedDone: progress.embedDone,
        embedTotal: progress.embedTotal,
      };
      if (progress.total > 0 && progress.current % 10 === 0) {
        console.log(`[silo:${this.config.name}] Reconcile: ${progress.current}/${progress.total}`);
      }
    }
  };

  private onReconcileEvent: ReconcileEventHandler = (event) => {
    // Only add to activity log and forward to renderer.
    // Don't touch watcherState (stays 'indexing') or mtimes
    // (reconcile() manages those itself). Individual file errors
    // during reconciliation shouldn't mark the whole silo as errored.
    this.activity.append({
      timestamp: new Date(),
      siloName: this.config.name,
      filePath: event.filePath,
      eventType: event.eventType,
      errorMessage: event.errorMessage,
    });
  };

  private resolveDbPath(): string {
    if (path.isAbsolute(this.config.dbPath)) {
      return this.config.dbPath;
    }
    return path.join(this.userDataDir, this.config.dbPath);
  }

  private readFileSizeFromDisk(): number {
    try {
      const dbPath = this.resolveDbPath();
      let size = 0;
      // Include main DB + WAL file for accurate size
      if (fs.existsSync(dbPath)) {
        size += fs.statSync(dbPath).size;
      }
      const walPath = dbPath + '-wal';
      if (fs.existsSync(walPath)) {
        size += fs.statSync(walPath).size;
      }
      return size;
    } catch {
      return 0;
    }
  }
}

