/**
 * Silo Manager — top-level orchestrator for a single silo.
 *
 * Ties together the embedding service, SQLite database, file watcher,
 * and configuration for one silo. The Electron main process interacts
 * with this class for all silo operations.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { ResolvedSiloConfig } from './config';
import type { EmbeddingService } from './embedding';
import {
  createSiloDatabase,
  hybridSearchSilo,
  getChunkCount,
  loadMtimes,
  setMtime,
  deleteMtime,
  loadMeta,
  saveMeta,
  makeStoredKey,
  resolveStoredKey,
  type SiloDatabase,
  type SiloSearchResult,
} from './store';
import { SiloWatcher, type WatcherEvent } from './watcher';
import { reconcile, type ReconcileProgressHandler, type ReconcileEventHandler } from './reconcile';
import { PauseToken } from './pause-token';
import type { WatcherState } from '../shared/types';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SiloManagerStatus {
  name: string;
  indexedFileCount: number;
  chunkCount: number;
  lastUpdated: Date | null;
  databaseSizeBytes: number;
  watcherState: WatcherState;
  errorMessage?: string;
  reconcileProgress?: { current: number; total: number };
  /** True when the configured model differs from the model used to build the index */
  modelMismatch?: boolean;
  /** True when indexing is paused */
  paused?: boolean;
  /** Absolute path to the silo's SQLite database file */
  resolvedDbPath: string;
}

// ── SiloManager ──────────────────────────────────────────────────────────────

const MAX_ACTIVITY_EVENTS = 200;

export class SiloManager {
  private embeddingService: EmbeddingService | null = null;
  private db: SiloDatabase | null = null;
  private watcher: SiloWatcher | null = null;
  private lastUpdated: Date | null = null;
  private activityLog: WatcherEvent[] = [];
  private _watcherState: WatcherState = 'idle';
  private stateChangeListener?: () => void;
  private errorMessage?: string;
  private reconcileProgress?: { current: number; total: number };
  private mtimes = new Map<string, number>();
  private cachedFileCount = 0;
  private cachedChunkCount = 0;
  private cachedSizeBytes = 0;
  /** True when meta model differs from configured model */
  private modelMismatch = false;
  private pauseToken = new PauseToken();
  private _paused = false;

  private set watcherState(value: WatcherState) {
    if (this._watcherState !== value) {
      this._watcherState = value;
      this.stateChangeListener?.();
    }
  }

  private get watcherState(): WatcherState {
    return this._watcherState;
  }

  /** Set to true when stop() is called, checked by start() at each await. */
  private stopped = false;
  /** Tracks the in-flight start() so stop() can wait for it to settle. */
  private startPromise: Promise<void> | null = null;

  /** External listener for watcher events (used by main process for renderer forwarding). */
  private eventListener?: (event: WatcherEvent) => void;

  constructor(
    private config: ResolvedSiloConfig,
    private sharedEmbeddingService: EmbeddingService,
    private readonly userDataDir: string,
  ) {}

  /** Register a listener for watcher events. Only one listener is supported. */
  onEvent(listener: (event: WatcherEvent) => void): void {
    this.eventListener = listener;
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
  updateModel(model: string): void {
    this.config = { ...this.config, model };

    // Re-check mismatch against stored meta
    if (this.db) {
      const meta = loadMeta(this.db);
      if (meta) {
        this.modelMismatch = meta.model !== model;
      } else {
        // No meta but DB exists — legacy or corrupt, flag mismatch
        this.modelMismatch = true;
      }
    }
  }

  /**
   * Replace the shared embedding service.
   * Call this before rebuild() when the configured model has changed,
   * so the new index is built with the correct model and dimensions.
   */
  updateEmbeddingService(service: EmbeddingService): void {
    this.sharedEmbeddingService = service;
  }

  // ── Pause / Resume ───────────────────────────────────────────────────────

  /** Pause indexing. Queue processing and reconciliation suspend at the next yield point. */
  pause(): void {
    if (this._paused) return;
    this._paused = true;
    this.pauseToken.pause();
    console.log(`[silo:${this.config.name}] Paused`);
    this.stateChangeListener?.();
  }

  /** Resume indexing from where it was paused. */
  resume(): void {
    if (!this._paused) return;
    this._paused = false;
    this.pauseToken.resume();
    console.log(`[silo:${this.config.name}] Resumed`);
    this.stateChangeListener?.();
  }

  /** Whether indexing is currently paused. */
  get isPaused(): boolean {
    return this._paused;
  }

  // ── Config hot-swap ────────────────────────────────────────────────────

  /**
   * Update ignore patterns, re-reconcile to remove now-ignored files, and restart the watcher.
   */
  async updateIgnorePatterns(ignore: string[], ignoreFiles: string[]): Promise<void> {
    this.config = { ...this.config, ignore, ignoreFiles };
    await this.reconcileAndRestartWatcher('ignore pattern');
  }

  /**
   * Update file extensions, re-reconcile to index/remove files, and restart the watcher.
   */
  async updateExtensions(extensions: string[]): Promise<void> {
    this.config = { ...this.config, extensions };
    await this.reconcileAndRestartWatcher('extension');
  }

  /**
   * Stop the watcher, re-reconcile the database against disk using the current config,
   * then restart the watcher. Used after config changes that affect which files are indexed.
   */
  private async reconcileAndRestartWatcher(reason: string): Promise<void> {
    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }

    if (this.embeddingService && this.db && !this.stopped) {
      this.watcherState = 'indexing';
      try {
        const result = await reconcile(
          this.config,
          this.embeddingService,
          this.db,
          this.mtimes,
          this.onReconcileProgress,
          this.onReconcileEvent,
          this.pauseToken,
        );
        const changes = [
          result.filesAdded > 0 && `+${result.filesAdded}`,
          result.filesRemoved > 0 && `-${result.filesRemoved}`,
          result.filesUpdated > 0 && `~${result.filesUpdated}`,
        ].filter(Boolean).join(' ');
        if (changes) {
          console.log(`[silo:${this.config.name}] ${reason} change: ${changes} files`);
        }
      } catch (err) {
        if (!this.stopped) {
          console.error(`[silo:${this.config.name}] Re-reconciliation after ${reason} change failed:`, err);
        }
      }
      this.reconcileProgress = undefined;

      if (!this.stopped) {
        this.watcherState = 'idle';
        this.watcher = new SiloWatcher(this.config, this.embeddingService, this.db, this.pauseToken);
        this.watcher.on((event) => this.handleWatcherEvent(event));
        this.watcher.start();
        console.log(`[silo:${this.config.name}] Watcher restarted after ${reason} change`);
      }
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Initialize all subsystems and start watching. */
  async start(): Promise<void> {
    this.stopped = false;
    this.startPromise = this.doStart();
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    // 1. Use the shared embedding service
    this.embeddingService = this.sharedEmbeddingService;

    // 2. Open or create the SQLite database
    const dbPath = this.resolveDbPath();
    this.db = createSiloDatabase(dbPath, this.embeddingService.dimensions);
    console.log(`[silo:${this.config.name}] Opened database at ${dbPath}`);

    // 3. Check meta for model mismatch
    const meta = loadMeta(this.db);
    if (meta) {
      if (meta.model !== this.config.model) {
        this.modelMismatch = true;
        console.warn(
          `[silo:${this.config.name}] Model mismatch: index built with "${meta.model}" but config uses "${this.config.model}". Rebuild required.`,
        );
      }
    } else {
      // First run or fresh DB — write meta now
      saveMeta(this.db, this.config.model, this.embeddingService.dimensions);
      this.modelMismatch = false;
    }

    // 4. Load file modification times for offline change detection
    this.mtimes = loadMtimes(this.db);

    // 5. Run startup reconciliation
    if (this.stopped) return;
    this.watcherState = 'indexing';
    try {
      const result = await reconcile(
        this.config,
        this.embeddingService,
        this.db,
        this.mtimes,
        this.onReconcileProgress,
        this.onReconcileEvent,
        this.pauseToken,
      );
      if (result.filesAdded > 0 || result.filesRemoved > 0 || result.filesUpdated > 0) {
        console.log(
          `[silo:${this.config.name}] Reconciliation: +${result.filesAdded} -${result.filesRemoved} ~${result.filesUpdated} (${(result.durationMs / 1000).toFixed(1)}s)`,
        );
      } else {
        console.log(`[silo:${this.config.name}] Reconciliation: index up to date`);
      }
    } catch (err) {
      if (this.stopped) return; // expected during shutdown
      console.error(`[silo:${this.config.name}] Reconciliation failed:`, err);
    }
    this.reconcileProgress = undefined;

    // 6. Bail if stop() was called during reconciliation
    if (this.stopped) return;
    this.watcherState = 'idle';

    // 7. Create and start the file watcher
    if (this.stopped) return;
    this.watcher = new SiloWatcher(this.config, this.embeddingService, this.db, this.pauseToken);
    this.watcher.on((event) => this.handleWatcherEvent(event));
    this.watcher.start();

    console.log(`[silo:${this.config.name}] Started (watching ${this.config.directories.join(', ')})`);
  }

  /** Graceful shutdown: stop watcher, close database, dispose embedding service. */
  async stop(): Promise<void> {
    this.stopped = true;
    // If paused, resume so in-flight loops can notice `stopped` and exit.
    if (this._paused) {
      this._paused = false;
      this.pauseToken.resume();
    }

    // Wait for start() to finish so we don't tear down underneath it.
    if (this.startPromise) {
      await this.startPromise.catch(() => {});
      this.startPromise = null;
    }

    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }

    if (this.db) {
      try {
        this.db.close();
      } catch {
        // Already closed or failed — harmless
      }
      this.db = null;
    }

    // Don't dispose the embedding service — it's shared across silos.
    // The main process manages its lifecycle.
    this.embeddingService = null;

    this.mtimes.clear();
    console.log(`[silo:${this.config.name}] Stopped`);
  }

  /** Put the silo to sleep: cache stats, release all resources. */
  async sleep(): Promise<void> {
    // Cache stats before releasing resources
    this.cachedFileCount = this.mtimes.size;
    this.cachedChunkCount = this.db ? getChunkCount(this.db) : 0;
    this.cachedSizeBytes = this.readFileSizeFromDisk();
    await this.stop();
    this.watcherState = 'sleeping';
    console.log(`[silo:${this.config.name}] Sleeping`);
  }

  /** Wake the silo: reload database, reconcile, start watching. */
  async wake(): Promise<void> {
    this.watcherState = 'idle';
    await this.start();
  }

  /**
   * Rebuild the entire index from scratch.
   * Stops the silo, deletes the database file on disk, clears mtimes,
   * then restarts (which triggers a full reconciliation).
   */
  async rebuild(): Promise<void> {
    console.log(`[silo:${this.config.name}] Rebuild requested`);
    const wasSleeping = this.isSleeping;

    // Stop everything gracefully
    if (!wasSleeping) {
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

  /** Load minimal status for an offline silo (sleeping or waiting) without starting it. */
  loadSleepingStatus(): void { this.loadOfflineStatus('sleeping'); }
  loadWaitingStatus(): void { this.loadOfflineStatus('waiting'); }

  private loadOfflineStatus(state: 'sleeping' | 'waiting'): void {
    this.watcherState = state;
    this.cachedSizeBytes = this.readFileSizeFromDisk();

    const dbPath = this.resolveDbPath();
    if (fs.existsSync(dbPath)) {
      try {
        const db = new Database(dbPath, { readonly: true });
        try {
          const row = db.prepare(`SELECT COUNT(*) as cnt FROM mtimes`).get() as { cnt: number };
          this.cachedFileCount = row.cnt;
        } catch {
          this.cachedFileCount = 0;
        }
        db.close();
      } catch {
        this.cachedFileCount = 0;
      }
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Whether this silo is currently sleeping. */
  get isSleeping(): boolean {
    return this.watcherState === 'sleeping';
  }

  /** Embed a query and search the silo database using hybrid search. */
  async search(query: string, maxResults: number = 10): Promise<SiloSearchResult[]> {
    if (!this.embeddingService || !this.db) return [];
    const queryVector = await this.embeddingService.embed(query);
    const results = hybridSearchSilo(this.db, queryVector, query, maxResults);
    return this.resolveResultPaths(results);
  }

  /**
   * Search with a pre-computed query vector.
   * Used by the main process to embed the query once and share the
   * vector across all silos, avoiding redundant ONNX inference calls.
   */
  searchWithVector(queryVector: number[], queryText: string, maxResults: number = 10): SiloSearchResult[] {
    if (!this.db) return [];
    const results = hybridSearchSilo(this.db, queryVector, queryText, maxResults);
    return this.resolveResultPaths(results);
  }

  /** Resolve stored keys in search results back to absolute file paths. */
  private resolveResultPaths(results: SiloSearchResult[]): SiloSearchResult[] {
    return results.map((r) => ({
      ...r,
      filePath: resolveStoredKey(r.filePath, this.config.directories),
    }));
  }

  /** Get the current status of this silo. */
  getStatus(): SiloManagerStatus {
    if (this.watcherState === 'sleeping' || this.watcherState === 'waiting') {
      return {
        name: this.config.name,
        indexedFileCount: this.cachedFileCount,
        chunkCount: this.cachedChunkCount,
        lastUpdated: this.lastUpdated,
        databaseSizeBytes: this.cachedSizeBytes,
        watcherState: this.watcherState,
        resolvedDbPath: this.resolveDbPath(),
      };
    }

    const chunks = this.db ? getChunkCount(this.db) : 0;
    const dbSize = this.readFileSizeFromDisk();

    return {
      name: this.config.name,
      indexedFileCount: this.mtimes.size,
      chunkCount: chunks,
      lastUpdated: this.lastUpdated,
      databaseSizeBytes: dbSize,
      watcherState: this.watcherState,
      errorMessage: this.errorMessage,
      reconcileProgress: this.reconcileProgress,
      modelMismatch: this.modelMismatch || undefined,
      paused: this._paused || undefined,
      resolvedDbPath: this.resolveDbPath(),
    };
  }

  /** Get recent activity events. */
  getActivityFeed(limit: number = 50): WatcherEvent[] {
    return this.activityLog.slice(-limit);
  }

  /** Whether the index was built with a different model than currently configured. */
  hasModelMismatch(): boolean {
    return this.modelMismatch;
  }

  /** Get the resolved silo config. */
  getConfig(): ResolvedSiloConfig {
    return this.config;
  }

  /** Get the underlying database (for reconciliation). */
  getDatabase(): SiloDatabase | null {
    return this.db;
  }

  /** Get the embedding service (for reconciliation). */
  getEmbeddingService(): EmbeddingService | null {
    return this.embeddingService;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private onReconcileProgress: ReconcileProgressHandler = (progress) => {
    if (progress.phase === 'scanning') return;
    if (progress.phase === 'done') {
      this.reconcileProgress = undefined;
      return;
    }
    this.reconcileProgress = { current: progress.current, total: progress.total };
    if (progress.total > 0 && progress.current % 10 === 0) {
      console.log(`[silo:${this.config.name}] Reconcile: ${progress.current}/${progress.total}`);
    }
  };

  private onReconcileEvent: ReconcileEventHandler = (event) => {
    // Only add to activity log and forward to renderer.
    // Don't touch watcherState (stays 'indexing') or mtimes
    // (reconcile() manages those itself). Individual file errors
    // during reconciliation shouldn't mark the whole silo as errored.
    const watcherEvent: WatcherEvent = {
      timestamp: new Date(),
      siloName: this.config.name,
      filePath: event.filePath,
      eventType: event.eventType,
      errorMessage: event.errorMessage,
    };

    this.activityLog.push(watcherEvent);
    if (this.activityLog.length > MAX_ACTIVITY_EVENTS) {
      this.activityLog = this.activityLog.slice(-MAX_ACTIVITY_EVENTS);
    }
    this.lastUpdated = watcherEvent.timestamp;
    this.eventListener?.(watcherEvent);
  };

  private handleWatcherEvent(event: WatcherEvent): void {
    this.activityLog.push(event);
    if (this.activityLog.length > MAX_ACTIVITY_EVENTS) {
      this.activityLog = this.activityLog.slice(-MAX_ACTIVITY_EVENTS);
    }

    this.lastUpdated = event.timestamp;

    // Notify external listener (main process → renderer forwarding)
    this.eventListener?.(event);

    // Update file modification times directly in SQLite
    // event.filePath is an absolute path from the watcher — convert to stored key
    if (event.eventType === 'indexed' && this.db) {
      try {
        const storedKey = makeStoredKey(event.filePath, this.config.directories);
        const stat = fs.statSync(event.filePath);
        this.mtimes.set(storedKey, stat.mtimeMs);
        setMtime(this.db, storedKey, stat.mtimeMs);
      } catch {
        // File vanished between indexing and stat — rare but harmless
      }
    } else if (event.eventType === 'deleted' && this.db) {
      try {
        const storedKey = makeStoredKey(event.filePath, this.config.directories);
        this.mtimes.delete(storedKey);
        deleteMtime(this.db, storedKey);
      } catch {
        // Path outside configured directories — harmless
      }
    }

    // Update watcher state.
    // Note: check queueLength rather than isProcessing — the event is emitted
    // from inside processQueue() while `processing` is still true, so for the
    // last item isProcessing would incorrectly keep us in 'indexing'.
    if (event.eventType === 'error') {
      this.watcherState = 'error';
      this.errorMessage = event.errorMessage;
    } else if (this.watcher && this.watcher.queueLength > 0) {
      this.watcherState = 'indexing';
    } else {
      this.watcherState = 'idle';
      this.errorMessage = undefined;
    }
  }

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
