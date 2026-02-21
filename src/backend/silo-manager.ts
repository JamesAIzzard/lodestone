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
  type SiloDatabase,
  type SiloSearchResult,
} from './store';
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

  /** Set to true when stop() is called, checked by start() at each await. */
  private stopped = false;
  /** Tracks the in-flight start() so stop() can wait for it to settle. */
  private startPromise: Promise<void> | null = null;

  constructor(
    private readonly config: ResolvedSiloConfig,
    private readonly ollamaUrl: string,
    private readonly modelCacheDir: string,
    private readonly userDataDir: string,
  ) {}

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
    } else {
      this.db = await createSiloDatabase(this.embeddingService.dimensions);
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

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Embed a query and search the silo database. */
  async search(query: string, maxResults: number = 10): Promise<SiloSearchResult[]> {
    if (!this.embeddingService || !this.db) return [];
    const queryVector = await this.embeddingService.embed(query);
    return searchSilo(this.db, queryVector, maxResults);
  }

  /** Get the current status of this silo. */
  async getStatus(): Promise<SiloManagerStatus> {
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
