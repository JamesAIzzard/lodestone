/**
 * Silo Manager — top-level orchestrator for a single silo.
 *
 * Ties together the embedding service, vector database, file watcher,
 * and configuration for one silo. The Electron main process interacts
 * with this class for all silo operations.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ResolvedSiloConfig } from './config';
import { createEmbeddingService, type EmbeddingService } from './embedding';
import {
  createSiloDatabase,
  loadDatabase,
  persistDatabase,
  searchSilo,
  getChunkCount,
  loadMtimes,
  saveMtimes,
  loadMeta,
  saveMeta,
  type SiloDatabase,
  type SiloSearchResult,
} from './store';
import { LEGACY_MODEL } from './model-registry';
import { SiloWatcher, type WatcherEvent } from './watcher';
import { reconcile, type ReconcileProgressHandler } from './reconcile';
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
}

// ── SiloManager ──────────────────────────────────────────────────────────────

const PERSIST_INTERVAL_MS = 30_000; // 30 seconds
const MAX_ACTIVITY_EVENTS = 200;

export class SiloManager {
  private embeddingService: EmbeddingService | null = null;
  private db: SiloDatabase | null = null;
  private watcher: SiloWatcher | null = null;
  private persistTimer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;
  private lastUpdated: Date | null = null;
  private activityLog: WatcherEvent[] = [];
  private watcherState: WatcherState = 'idle';
  private errorMessage?: string;
  private reconcileProgress?: { current: number; total: number };
  private lastKnownSizeBytes = 0;
  private lastPersistedChunkCount = 0;
  private mtimes = new Map<string, number>();
  private cachedFileCount = 0;
  private cachedChunkCount = 0;
  /** True when meta.json model differs from configured model */
  private modelMismatch = false;

  /** Set to true when stop() is called, checked by start() at each await. */
  private stopped = false;
  /** Tracks the in-flight start() so stop() can wait for it to settle. */
  private startPromise: Promise<void> | null = null;

  /** External listener for watcher events (used by main process for renderer forwarding). */
  private eventListener?: (event: WatcherEvent) => void;

  constructor(
    private config: ResolvedSiloConfig,
    private readonly ollamaUrl: string,
    private readonly modelCacheDir: string,
    private readonly userDataDir: string,
  ) {}

  /** Register a listener for watcher events. Only one listener is supported. */
  onEvent(listener: (event: WatcherEvent) => void): void {
    this.eventListener = listener;
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

    // Re-check mismatch against meta.json
    const meta = loadMeta(this.resolveMetaPath());
    if (meta) {
      this.modelMismatch = meta.model !== model;
    } else if (this.db) {
      // No meta.json but DB exists — legacy index, always mismatched
      this.modelMismatch = true;
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
    // 1. Create embedding service
    this.embeddingService = createEmbeddingService({
      model: this.config.model,
      ollamaUrl: this.ollamaUrl,
      modelCacheDir: this.modelCacheDir,
    });

    // 2. Load or create the database
    const dbPath = this.resolveDbPath();
    const existing = await loadDatabase(dbPath, this.embeddingService.dimensions);
    if (this.stopped) return;

    if (existing) {
      this.db = existing;
      console.log(`[silo:${this.config.name}] Loaded database from ${dbPath}`);

      // Check meta.json for model mismatch
      const meta = loadMeta(this.resolveMetaPath());
      if (meta) {
        if (meta.model !== this.config.model) {
          this.modelMismatch = true;
          console.warn(
            `[silo:${this.config.name}] Model mismatch: index built with "${meta.model}" but config uses "${this.config.model}". Rebuild required.`,
          );
        }
      } else {
        // No meta.json but database exists — legacy index (pre-Phase 3)
        this.modelMismatch = true;
        console.warn(
          `[silo:${this.config.name}] No meta.json found for existing database — legacy index (${LEGACY_MODEL}). Rebuild required.`,
        );
      }
    } else {
      this.db = await createSiloDatabase(this.embeddingService.dimensions);
      this.modelMismatch = false;
      console.log(`[silo:${this.config.name}] Created new database`);
    }

    // 3. Load file modification times for offline change detection
    this.mtimes = loadMtimes(this.resolveMtimesPath());

    // 4. Seed cached size from existing file on disk (if any)
    this.lastKnownSizeBytes = this.readFileSizeFromDisk();
    if (this.lastKnownSizeBytes > 0) {
      this.lastPersistedChunkCount = await getChunkCount(this.db);
    }

    // 5. Start periodic persistence BEFORE reconciliation so the
    //    on-disk file (and cached size) updates during long index builds.
    this.persistTimer = setInterval(() => this.persistIfDirty(), PERSIST_INTERVAL_MS);

    // 6. Run startup reconciliation
    if (this.stopped) return;
    this.watcherState = 'indexing';
    try {
      const result = await reconcile(
        this.config,
        this.embeddingService,
        this.db,
        this.mtimes,
        this.onReconcileProgress,
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

    // 7. Bail if stop() was called during reconciliation
    if (this.stopped) return;
    this.watcherState = 'idle';

    // 8. Force an immediate persist so the size is accurate the
    //    moment the UI sees the "Idle" state.
    await this.persistIfDirty();

    // 9. Create and start the file watcher
    if (this.stopped) return;
    this.watcher = new SiloWatcher(this.config, this.embeddingService, this.db);
    this.watcher.on((event) => this.handleWatcherEvent(event));
    this.watcher.start();

    console.log(`[silo:${this.config.name}] Started (watching ${this.config.directories.join(', ')})`);
  }

  /** Graceful shutdown: stop watcher, persist database, dispose embedding service. */
  async stop(): Promise<void> {
    this.stopped = true;

    // Wait for start() to finish so we don't tear down underneath it.
    if (this.startPromise) {
      await this.startPromise.catch(() => {});
      this.startPromise = null;
    }

    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }

    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }

    // Final persist
    await this.persistIfDirty();

    if (this.embeddingService) {
      await this.embeddingService.dispose();
      this.embeddingService = null;
    }

    this.db = null;
    this.mtimes.clear();
    console.log(`[silo:${this.config.name}] Stopped`);
  }

  /** Put the silo to sleep: persist data, release all resources from RAM. */
  async sleep(): Promise<void> {
    // Cache stats before releasing resources
    this.cachedFileCount = this.mtimes.size;
    this.cachedChunkCount = this.db ? await getChunkCount(this.db) : 0;
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

    // Delete the database, meta, and mtimes files from disk
    for (const filePath of [
      this.resolveDbPath(),
      this.resolveMetaPath(),
      this.resolveMtimesPath(),
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
    this.lastKnownSizeBytes = 0;
    this.lastPersistedChunkCount = 0;
    this.cachedFileCount = 0;
    this.cachedChunkCount = 0;

    // Restart — this will create a fresh database and run full reconciliation
    await this.start();
    console.log(`[silo:${this.config.name}] Rebuild complete`);
  }

  /**
   * Load minimal status for a sleeping silo without starting it.
   * Reads mtimes.json for file count and stats the DB file for size.
   */
  loadSleepingStatus(): void {
    this.watcherState = 'sleeping';
    this.mtimes = loadMtimes(this.resolveMtimesPath());
    this.cachedFileCount = this.mtimes.size;
    this.mtimes.clear(); // Don't hold in memory — just needed the count
    this.lastKnownSizeBytes = this.readFileSizeFromDisk();
  }

  /**
   * Load minimal status for a silo that is queued but not yet started.
   * Same lightweight approach as loadSleepingStatus() — reads file count
   * and DB size from disk without loading the database into memory.
   */
  loadWaitingStatus(): void {
    this.watcherState = 'waiting';
    this.mtimes = loadMtimes(this.resolveMtimesPath());
    this.cachedFileCount = this.mtimes.size;
    this.mtimes.clear();
    this.lastKnownSizeBytes = this.readFileSizeFromDisk();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Whether this silo is currently sleeping. */
  get isSleeping(): boolean {
    return this.watcherState === 'sleeping';
  }

  /** Embed a query and search the silo database. */
  async search(query: string, maxResults: number = 10): Promise<SiloSearchResult[]> {
    if (!this.embeddingService || !this.db) return [];
    const queryVector = await this.embeddingService.embed(query);
    return searchSilo(this.db, queryVector, maxResults);
  }

  /** Get the current status of this silo. */
  async getStatus(): Promise<SiloManagerStatus> {
    if (this.watcherState === 'sleeping' || this.watcherState === 'waiting') {
      return {
        name: this.config.name,
        indexedFileCount: this.cachedFileCount,
        chunkCount: this.cachedChunkCount,
        lastUpdated: this.lastUpdated,
        databaseSizeBytes: this.lastKnownSizeBytes,
        watcherState: this.watcherState,
      };
    }

    const chunks = this.db ? await getChunkCount(this.db) : 0;
    const dbSize = this.estimateDatabaseSizeBytes(chunks);

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
    };
  }

  /** Get recent activity events. */
  getActivityFeed(limit: number = 50): WatcherEvent[] {
    return this.activityLog.slice(-limit);
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

  /** Mark the database as dirty (needs persist). */
  markDirty(): void {
    this.dirty = true;
  }

  /** Force a database and mtimes persist to disk now. */
  async persist(): Promise<void> {
    if (!this.db) return;
    const dbPath = this.resolveDbPath();
    await persistDatabase(this.db, dbPath);
    await saveMtimes(this.mtimes, this.resolveMtimesPath());
    // Write meta.json sidecar — records which model built this index
    if (this.embeddingService) {
      saveMeta(this.resolveMetaPath(), this.config.model, this.embeddingService.dimensions);
    }
    this.dirty = false;
    this.lastKnownSizeBytes = this.readFileSizeFromDisk();
    this.lastPersistedChunkCount = await getChunkCount(this.db);
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private onReconcileProgress: ReconcileProgressHandler = (progress) => {
    if (progress.phase === 'scanning') return;
    if (progress.phase === 'done') {
      this.reconcileProgress = undefined;
      return;
    }
    this.dirty = true;
    this.reconcileProgress = { current: progress.current, total: progress.total };
    if (progress.total > 0 && progress.current % 10 === 0) {
      console.log(`[silo:${this.config.name}] Reconcile: ${progress.current}/${progress.total}`);
    }
  };

  private handleWatcherEvent(event: WatcherEvent): void {
    this.activityLog.push(event);
    if (this.activityLog.length > MAX_ACTIVITY_EVENTS) {
      this.activityLog = this.activityLog.slice(-MAX_ACTIVITY_EVENTS);
    }

    this.lastUpdated = event.timestamp;
    this.dirty = true;

    // Notify external listener (main process → renderer forwarding)
    this.eventListener?.(event);

    // Update file modification times so offline edits are detected on restart
    if (event.eventType === 'indexed') {
      try {
        const stat = fs.statSync(event.filePath);
        this.mtimes.set(event.filePath, stat.mtimeMs);
      } catch {
        // File vanished between indexing and stat — rare but harmless
      }
    } else if (event.eventType === 'deleted') {
      this.mtimes.delete(event.filePath);
    }

    // Update watcher state
    if (event.eventType === 'error') {
      this.watcherState = 'error';
      this.errorMessage = event.errorMessage;
    } else if (this.watcher?.isProcessing) {
      this.watcherState = 'indexing';
    } else {
      this.watcherState = 'idle';
      this.errorMessage = undefined;
    }
  }

  private async persistIfDirty(): Promise<void> {
    if (!this.dirty || !this.db) return;
    try {
      await this.persist();
      console.log(`[silo:${this.config.name}] Database persisted to disk`);
    } catch (err) {
      console.error(`[silo:${this.config.name}] Failed to persist database:`, err);
    }
  }

  private resolveDbPath(): string {
    // If db_path is relative, resolve against userDataDir
    if (path.isAbsolute(this.config.dbPath)) {
      return this.config.dbPath;
    }
    return path.join(this.userDataDir, this.config.dbPath);
  }

  private resolveMtimesPath(): string {
    return path.join(path.dirname(this.resolveDbPath()), 'mtimes.json');
  }

  private resolveMetaPath(): string {
    return path.join(path.dirname(this.resolveDbPath()), 'meta.json');
  }

  /**
   * Estimate the current database size in bytes.
   *
   * When the DB matches what's on disk, returns the exact persisted size.
   * When dirty (in-memory changes not yet written), extrapolates from the
   * last-known bytes-per-chunk ratio so the UI shows the size growing
   * live during indexing rather than sitting at 0 or a stale value.
   */
  private estimateDatabaseSizeBytes(currentChunkCount: number): number {
    if (!this.dirty && this.watcherState !== 'indexing') return this.lastKnownSizeBytes;

    // We have a baseline from a previous persist — extrapolate
    if (this.lastPersistedChunkCount > 0 && this.lastKnownSizeBytes > 0) {
      const bytesPerChunk = this.lastKnownSizeBytes / this.lastPersistedChunkCount;
      return Math.round(currentChunkCount * bytesPerChunk);
    }

    // Brand-new silo, never persisted — rough estimate.
    // Orama JSON with 384-dim embeddings typically runs ~13 KB/chunk.
    if (currentChunkCount > 0) {
      return currentChunkCount * 13_000;
    }

    return 0;
  }

  private readFileSizeFromDisk(): number {
    try {
      const stat = fs.statSync(this.resolveDbPath());
      return stat.size;
    } catch {
      return 0;
    }
  }
}
