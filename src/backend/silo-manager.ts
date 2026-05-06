/**
 * Silo Manager — top-level orchestrator for a single silo.
 *
 * Ties together the embedding service, store proxy, file watcher,
 * and configuration for one silo. The Electron main process interacts
 * with this class for all silo operations.
 *
 * V2: The silo manager no longer holds a direct database handle.
 * All SQLite operations are routed asynchronously through the store
 * proxy to the store worker thread. This eliminates UI freezes from
 * database I/O on the main thread.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ResolvedSiloConfig } from './config';
import { validateSiloColor, validateSiloIcon } from '../shared/silo-appearance';
import type { EmbeddingService } from './embedding';
import * as storeProxy from './store-proxy';
import { makeStoredKey, makeStoredDirKey, resolveStoredKey } from './store/paths';
import { peekFileCount } from './store/peek';
import type { StoredSiloConfig, FlushUpsert, FlushDelete } from './store/types';
import { prepareFile } from './pipeline';
import { SiloWatcher, type WatcherEvent, type WatcherStoreOps } from './watcher';
import {
  reconcile,
  type ReconcileProgressHandler,
  type ReconcileEventHandler,
  type ReconcileStoreOps,
} from './reconcile';
import type { WatcherState, DirectoryTreeNode, SearchParams } from '../shared/types';
import type { FileResult } from './search';
import type { DirectorySearchParams, SiloDirectorySearchResult } from './directory-search';
import { IndexingQueue } from './indexing-queue';

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
  private watcher: SiloWatcher | null = null;
  private lastUpdated: Date | null = null;
  private activityLog: WatcherEvent[] = [];
  private _watcherState: WatcherState = 'ready';
  private stateChangeListener?: () => void;
  private errorMessage?: string;
  private reconcileProgress?: {
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
  };
  private mtimes = new Map<string, number>();
  private cachedFileCount = 0;
  private cachedChunkCount = 0;
  private cachedSizeBytes = 0;
  /** True during post-reconcile maintenance (checkpoint/VACUUM) when the worker is blocked. */
  private maintenanceInProgress = false;
  /** True when meta model differs from configured model */
  private modelMismatch = false;

  private set watcherState(value: WatcherState) {
    if (this._watcherState !== value) {
      this._watcherState = value;
      try {
        this.stateChangeListener?.();
      } catch (err) {
        console.error(`[silo:${this.config.name}] Error in state change listener:`, err);
      }
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

  /** Prevents duplicate enqueue for live watcher runs. */
  private pendingWatcherEnqueue = false;
  /** Cancel function for a pending live-watcher queue slot. */
  private cancelWatcherEnqueue: (() => void) | null = null;
  /** Resolves when the current watcher IndexingQueue task finishes. */
  private watcherIndexingDone: Promise<void> | null = null;

  constructor(
    private config: ResolvedSiloConfig,
    private sharedEmbeddingService: EmbeddingService,
    private readonly userDataDir: string,
    private readonly indexingQueue: IndexingQueue,
  ) {}

  /** The silo ID used for all store proxy calls. */
  private get siloId(): string {
    return this.config.name;
  }

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
  async updateModel(model: string): Promise<void> {
    this.config = { ...this.config, model };

    // Re-check mismatch against stored meta
    if (this.dbOpen) {
      const meta = await storeProxy.loadMeta(this.siloId);
      if (meta) {
        this.modelMismatch = meta.model !== model;
      } else {
        // No meta but DB exists — legacy or corrupt, flag mismatch
        this.modelMismatch = true;
      }
    }
    await this.persistConfigBlob();
  }

  /** Update the silo description and persist to DB config blob. */
  async updateDescription(description: string): Promise<void> {
    this.config = { ...this.config, description };
    await this.persistConfigBlob();
  }

  /** Update the silo display name and persist to DB config blob. */
  async updateName(name: string): Promise<void> {
    this.config = { ...this.config, name };
    await this.persistConfigBlob();
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

  /** Re-walk directories and index new/changed/removed files without deleting the DB. */
  async rescan(): Promise<void> {
    await this.reconcileAndRestartWatcher('manual rescan');
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

    if (this.embeddingService && this.dbOpen && !this.stopped) {
      await new Promise<void>((resolve) => {
        this.indexingQueue.enqueue(
          this.config.name,
          () => {
            if (!this.stopped) this.watcherState = 'waiting';
          },
          () => {
            if (!this.stopped) this.watcherState = 'indexing';
          },
          async () => {
            if (this.stopped) {
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
              if (!this.stopped) {
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

      if (!this.stopped) {
        await this.persistConfigBlob();
        this.watcherState = 'ready';
        this.startWatcher();
        console.log(`[silo:${this.config.name}] Watcher restarted after ${reason} change`);
      }
    }
  }

  /** Update the silo colour and persist to DB config blob. */
  async updateColor(color: string): Promise<void> {
    this.config = { ...this.config, color: validateSiloColor(color) };
    await this.persistConfigBlob();
  }

  /** Update the silo icon and persist to DB config blob. */
  async updateIcon(icon: string): Promise<void> {
    this.config = { ...this.config, icon: validateSiloIcon(icon) };
    await this.persistConfigBlob();
  }

  /** Build and persist the current config as a JSON blob in the database. */
  private async persistConfigBlob(): Promise<void> {
    if (!this.dbOpen) return;
    const blob: StoredSiloConfig = {
      name: this.config.name,
      description: this.config.description || undefined,
      directories: this.config.directories,
      extensions: this.config.extensions,
      ignore: this.config.ignore,
      ignoreFiles: this.config.ignoreFiles,
      model: this.config.model,
      color: this.config.color,
      icon: this.config.icon,
    };
    await storeProxy.saveConfigBlob(this.siloId, blob);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Initialize all subsystems and start watching. */
  async start(): Promise<void> {
    this.stopped = false;
    this.startPromise = this.doStart().catch((err) => {
      if (!this.stopped) {
        this.watcherState = 'error';
        this.errorMessage = err instanceof Error ? err.message : String(err);
        this.reconcileProgress = undefined;
        this.maintenanceInProgress = false;
      }
      throw err;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    // 1. Use the shared embedding service and ensure it's ready
    this.embeddingService = this.sharedEmbeddingService;
    await this.embeddingService.ensureReady();

    // 2. Open or create the SQLite database via the store worker
    const dbPath = this.resolveDbPath();
    await storeProxy.open(this.siloId, dbPath, this.embeddingService.dimensions);
    this.dbOpen = true;
    console.log(`[silo:${this.config.name}] Opened database at ${dbPath}`);

    // 3. Check meta for model mismatch
    const meta = await storeProxy.loadMeta(this.siloId);
    if (meta) {
      if (meta.model !== this.config.model) {
        this.modelMismatch = true;
        console.warn(
          `[silo:${this.config.name}] Model mismatch: index built with "${meta.model}" but config uses "${this.config.model}". Rebuild required.`,
        );
      }
    } else {
      // First run or fresh DB — write meta now
      await storeProxy.saveMeta(this.siloId, this.config.model, this.embeddingService.dimensions);
      this.modelMismatch = false;
    }

    // 4. Load file modification times for offline change detection
    this.mtimes = await storeProxy.loadMtimes(this.siloId);

    // 4b. Seed the in-memory activity log from persisted history
    try {
      const rows = await storeProxy.loadActivity(this.siloId, MAX_ACTIVITY_EVENTS);
      this.activityLog = rows.map((r) => ({
        timestamp: new Date(r.timestamp),
        siloName: this.config.name,
        filePath: r.file_path,
        eventType: r.event_type as WatcherEvent['eventType'],
        errorMessage: r.error_message ?? undefined,
      }));
    } catch {
      // First run — activity_log table may not exist yet in very old DBs
    }

    // 5. Run startup reconciliation via the global IndexingQueue so that
    //    only one silo embeds/indexes at a time.
    if (this.stopped) return;
    await new Promise<void>((resolve) => {
      this.indexingQueue.enqueue(
        this.config.name,
        () => {
          if (!this.stopped) this.watcherState = 'waiting';
        },
        () => {
          if (!this.stopped) this.watcherState = 'indexing';
        },
        async () => {
          if (this.stopped) {
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
              () => this.stopped,
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
            this.cachedChunkCount = await storeProxy.getChunkCount(this.siloId);
            this.maintenanceInProgress = true;

            // Show compacting stage in the UI during maintenance
            this.reconcileProgress = {
              current: this.mtimes.size,
              total: this.mtimes.size,
              fileStage: 'compacting',
            };

            // Yield so the renderer can process the "done" state before the
            // potentially expensive WAL checkpoint blocks the event loop.
            await new Promise<void>((r) => setImmediate(r));

            const sizeBefore = this.readFileSizeFromDisk();

            // Checkpoint and truncate the WAL after reconciliation.
            const tCheckpoint = performance.now();
            await storeProxy.checkpoint(this.siloId, 'TRUNCATE');
            const sizeAfterCkpt = this.readFileSizeFromDisk();
            console.log(
              `[silo:${this.config.name}] Post-reconcile: WAL checkpoint(TRUNCATE) took ${(performance.now() - tCheckpoint).toFixed(1)}ms` +
                ` — ${(sizeBefore / 1048576).toFixed(1)}MB → ${(sizeAfterCkpt / 1048576).toFixed(1)}MB`,
            );

            // VACUUM reclaims free pages left by deletions/updates. Skip after
            // pure-insert reconciliations (initial index) — there are no free
            // pages to reclaim, so VACUUM just rewrites the entire DB for nothing.
            if (result.filesRemoved > 0 || result.filesUpdated > 0) {
              const tVacuum = performance.now();
              await storeProxy.vacuum(this.siloId);
              const sizeAfterVac = this.readFileSizeFromDisk();
              console.log(
                `[silo:${this.config.name}] Post-reconcile: VACUUM took ${(performance.now() - tVacuum).toFixed(1)}ms` +
                  ` — ${(sizeAfterCkpt / 1048576).toFixed(1)}MB → ${(sizeAfterVac / 1048576).toFixed(1)}MB`,
              );
            }

            this.maintenanceInProgress = false;
          } catch (err) {
            if (this.stopped) {
              resolve();
              return;
            }
            console.error(`[silo:${this.config.name}] Reconciliation failed:`, err);
            this.watcherState = 'error';
            this.errorMessage = err instanceof Error ? err.message : String(err);
          }
          this.maintenanceInProgress = false;
          this.reconcileProgress = undefined;
          resolve();
        },
      );
    });

    // 6. Persist config blob for portable reconnection
    await this.persistConfigBlob();

    // 7. Bail if stop() was called during reconciliation
    if (this.stopped) return;
    this.watcherState = 'ready';

    // 8. Create and start the file watcher
    this.startWatcher();

    console.log(
      `[silo:${this.config.name}] Started (watching ${this.config.directories.join(', ')})`,
    );
  }

  /** Graceful shutdown: stop watcher, close database. */
  async stop(): Promise<void> {
    this.stopped = true;

    // Cancel any queued-but-not-yet-running watcher enqueue so it doesn't
    // block the IndexingQueue for other silos while we're shutting down.
    if (this.cancelWatcherEnqueue) {
      this.cancelWatcherEnqueue();
      this.cancelWatcherEnqueue = null;
      this.pendingWatcherEnqueue = false;
      // Task was still queued (never started), so there's nothing to await.
      this.watcherIndexingDone = null;
    }

    // Wait for start() to finish so we don't tear down underneath it.
    if (this.startPromise) {
      await this.startPromise.catch((): void => undefined);
      this.startPromise = null;
    }

    // Wait for any in-flight watcher indexing task to wind down.
    // The task checks shouldStop (→ this.stopped) between embedding
    // batches and will exit quickly — at most one batch duration.
    if (this.watcherIndexingDone) {
      await this.watcherIndexingDone.catch((): void => undefined);
      this.watcherIndexingDone = null;
    }

    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }

    if (this.dbOpen) {
      try {
        await storeProxy.checkpoint(this.siloId, 'TRUNCATE');
        await storeProxy.close(this.siloId);
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
    this.cachedChunkCount = this.dbOpen ? await storeProxy.getChunkCount(this.siloId) : 0;
    this.cachedSizeBytes = this.readFileSizeFromDisk();
    // stop() handles cancelling any pending watcher queue slot and
    // awaiting in-flight indexing before closing resources.
    await this.stop();
    this.watcherState = 'stopped';
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
    this.watcherState = state;
    this.cachedSizeBytes = this.readFileSizeFromDisk();
    this.cachedFileCount = peekFileCount(this.resolveDbPath());
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Whether this silo is currently stopped. */
  get isStopped(): boolean {
    return this.watcherState === 'stopped';
  }

  /** Current watcher state (synchronous — safe for tray menu, UI labels, etc.). */
  get currentState(): WatcherState {
    return this.watcherState;
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
    const results = await storeProxy.search(this.siloId, queryVector, {
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
    if (!this.embeddingService || !this.dbOpen || this.stopped) return;
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
    await storeProxy.flush(this.siloId, [upsert], []);
    // Update in-memory mtime
    this.mtimes.set(storedKey, stat.mtimeMs);
  }

  /**
   * Explore directory structure using segment Levenshtein and token coverage.
   * No embeddings needed — scoring operates on the query string directly.
   */
  async exploreDirectories(params: DirectorySearchParams): Promise<SiloDirectorySearchResult[]> {
    if (!this.dbOpen) return [];
    const isEmptyQuery = !params.query || params.query.trim().length === 0;
    // Empty query with no startPath → return the silo's configured root directories directly
    if (isEmptyQuery && !params.startPath) {
      return this.exploreRootDirectories(params.maxDepth ?? 2, params.fullContents);
    }
    // Convert absolute startPath → stored key for DB queries
    const resolvedParams = { ...params };
    if (params.startPath) {
      const key = makeStoredDirKey(params.startPath, this.config.directories);
      if (key) {
        resolvedParams.startPath = key;
      } else {
        // startPath may be a silo root or already a stored key
        const rootIdx = this.config.directories.indexOf(params.startPath);
        if (rootIdx >= 0) {
          resolvedParams.startPath = `${rootIdx}:`;
        }
        // Otherwise pass through as-is (may already be a stored key)
      }
    }
    const raw = await storeProxy.directorySearch(this.siloId, resolvedParams);
    return this.resolveDirectoryPaths(raw);
  }

  /** Synthesise explore results for the silo's configured root directories. */
  private async exploreRootDirectories(
    maxDepth: number,
    fullContents?: boolean,
  ): Promise<SiloDirectorySearchResult[]> {
    const results: SiloDirectorySearchResult[] = [];

    for (let i = 0; i < this.config.directories.length; i++) {
      const absPath = this.config.directories[i];
      const prefix = `${i}:`;

      // Get counts and tree from the worker via the proxy
      const [rawChildren, rawFiles] = await Promise.all([
        storeProxy.expandTree(this.siloId, prefix, 0, maxDepth, fullContents),
        fullContents
          ? storeProxy.getFilesInDirectory(this.siloId, prefix)
          : Promise.resolve(undefined),
      ]);

      // Count files and subdirs from the expanded tree data
      // For the root, we use the tree results to derive counts
      const fileCount = rawFiles?.length ?? 0;
      const subdirCount = rawChildren.length;

      results.push({
        dirPath: absPath,
        dirName: path.basename(absPath),
        score: 1.0,
        scoreSource: 'segment' as const,
        axes: {
          segment: {
            best: 0,
            bestSignal: 'levenshtein',
            signals: { levenshtein: 0, tokenCoverage: 0 },
          },
        },
        fileCount,
        subdirCount,
        depth: 0,
        children: resolveTreeNodes(rawChildren, this.config.directories),
        files: rawFiles?.map((f: { filePath: string; fileName: string }) => ({
          filePath: resolveStoredKey(f.filePath, this.config.directories),
          fileName: f.fileName,
        })),
      });
    }

    return results;
  }

  /** Resolve stored-key dir paths in explore results back to absolute filesystem paths. */
  private resolveDirectoryPaths(results: SiloDirectorySearchResult[]): SiloDirectorySearchResult[] {
    const dirs = this.config.directories;
    return results.map((r) => ({
      ...r,
      dirPath: resolveStoredKey(r.dirPath, dirs),
      children: resolveTreeNodes(r.children, dirs),
      files: r.files?.map((f) => ({
        filePath: resolveStoredKey(f.filePath, dirs),
        fileName: f.fileName,
      })),
    }));
  }

  /** Get the current status of this silo. */
  async getStatus(): Promise<SiloManagerStatus> {
    // When the worker is blocked (stopped, waiting, or maintenance), return
    // cached stats immediately to prevent the UI from hanging.
    if (
      this.watcherState === 'stopped' ||
      this.watcherState === 'waiting' ||
      this.maintenanceInProgress
    ) {
      return {
        name: this.config.name,
        indexedFileCount: this.maintenanceInProgress ? this.mtimes.size : this.cachedFileCount,
        chunkCount: this.cachedChunkCount,
        lastUpdated: this.lastUpdated,
        databaseSizeBytes: this.maintenanceInProgress
          ? this.readFileSizeFromDisk()
          : this.cachedSizeBytes,
        watcherState: this.watcherState,
        errorMessage: this.errorMessage,
        reconcileProgress: this.reconcileProgress,
        modelMismatch: this.modelMismatch || undefined,
        resolvedDbPath: this.resolveDbPath(),
      };
    }

    const chunks = this.dbOpen ? await storeProxy.getChunkCount(this.siloId) : 0;
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
      resolvedDbPath: this.resolveDbPath(),
    };
  }

  /** Get recent activity events. */
  getActivityFeed(limit = 50): WatcherEvent[] {
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
      flush: (upserts, deletes) => storeProxy.flush(id, upserts, deletes),
      insertDirEntry: (dirPath) => storeProxy.insertDirEntry(id, dirPath),
      deleteDirEntry: (dirPath) => storeProxy.deleteDirEntry(id, dirPath),
    };
  }

  /**
   * Create a ReconcileStoreOps implementation that routes through the store proxy.
   */
  private makeReconcileStoreOps(): ReconcileStoreOps {
    const id = this.siloId;
    return {
      flush: (upserts, deletes) => storeProxy.flush(id, upserts, deletes),
      syncDirectoriesWithDisk: (diskDirPaths) =>
        storeProxy.syncDirectoriesWithDisk(id, diskDirPaths),
      recomputeDirectoryCounts: () => storeProxy.recomputeDirectoryCounts(id),
      checkpoint: (mode) => storeProxy.checkpoint(id, mode),
    };
  }

  /** Create the watcher and start it. Shared by doStart() and reconcileAndRestartWatcher(). */
  private startWatcher(): void {
    if (!this.embeddingService) return;
    this.watcher = new SiloWatcher(this.config, this.embeddingService, this.makeWatcherStoreOps());
    this.watcher.setQueueFilledHandler(() => this.scheduleWatcherIndexing());
    this.watcher.on((event) => this.handleWatcherEvent(event));
    this.watcher.start();
  }

  private onReconcileProgress: ReconcileProgressHandler = (progress) => {
    if (progress.phase === 'done') {
      this.reconcileProgress = undefined;
      return;
    }
    // scanning, indexing, or removing — all surface as 'indexing' in the UI
    if (this._watcherState !== 'indexing') {
      this.watcherState = 'indexing';
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

    // Persist to SQLite (fire-and-forget — never block the pipeline)
    if (this.dbOpen) {
      storeProxy
        .logActivity(
          this.siloId,
          watcherEvent.timestamp.toISOString(),
          watcherEvent.eventType,
          watcherEvent.filePath,
          watcherEvent.errorMessage ?? null,
          this.config.activityLogLimit,
        )
        .catch((): void => undefined);
    }
  };

  private handleWatcherEvent(event: WatcherEvent): void {
    this.activityLog.push(event);
    if (this.activityLog.length > MAX_ACTIVITY_EVENTS) {
      this.activityLog = this.activityLog.slice(-MAX_ACTIVITY_EVENTS);
    }

    this.lastUpdated = event.timestamp;

    // Notify external listener (main process → renderer forwarding)
    this.eventListener?.(event);

    // Persist to SQLite (fire-and-forget — never block the watcher)
    if (this.dbOpen) {
      storeProxy
        .logActivity(
          this.siloId,
          event.timestamp.toISOString(),
          event.eventType,
          event.filePath,
          event.errorMessage ?? null,
          this.config.activityLogLimit,
        )
        .catch((): void => undefined);
    }

    // Update file modification times via the store proxy (fire-and-forget)
    // event.filePath is an absolute path from the watcher — convert to stored key
    if (event.eventType === 'indexed') {
      try {
        const storedKey = makeStoredKey(event.filePath, this.config.directories);
        const stat = fs.statSync(event.filePath);
        this.mtimes.set(storedKey, stat.mtimeMs);
        storeProxy.setMtime(this.siloId, storedKey, stat.mtimeMs).catch((): void => undefined);
      } catch {
        // File vanished between indexing and stat — rare but harmless
      }
    } else if (event.eventType === 'deleted') {
      try {
        const storedKey = makeStoredKey(event.filePath, this.config.directories);
        this.mtimes.delete(storedKey);
        storeProxy.deleteMtime(this.siloId, storedKey).catch((): void => undefined);
      } catch {
        // Path outside configured directories — harmless
      }
    }

    // File-level errors (extraction failures, parse errors, etc.) are logged to
    // the activity feed only — they don't change the silo's overall state.
    // State transitions (indexing ↔ ready) are managed by scheduleWatcherIndexing().
  }

  /**
   * Request a turn on the global IndexingQueue to drain the watcher's file queue.
   * Deduplicates: if a turn is already queued, does nothing — items accumulate in
   * the watcher's internal queue and will be processed when the turn arrives.
   */
  private scheduleWatcherIndexing(): void {
    if (this.pendingWatcherEnqueue) return;
    this.pendingWatcherEnqueue = true;

    // Track the in-flight task so stop() can await it before closing resources.
    let resolveIndexingDone!: () => void;
    this.watcherIndexingDone = new Promise<void>((r) => {
      resolveIndexingDone = r;
    });

    this.cancelWatcherEnqueue = this.indexingQueue.enqueue(
      this.config.name,
      () => {
        if (!this.stopped) this.watcherState = 'waiting';
      },
      () => {
        if (!this.stopped) this.watcherState = 'indexing';
      },
      async () => {
        this.pendingWatcherEnqueue = false;
        this.cancelWatcherEnqueue = null;
        try {
          if (this.watcher && !this.stopped) {
            await this.watcher.runQueue(
              (progress) => {
                this.reconcileProgress = {
                  current: progress.current,
                  total: progress.total,
                  filePath: progress.filePath,
                  fileSize: progress.fileSize,
                  fileStage: progress.fileStage,
                  batchChunks: progress.batchChunks,
                  batchChunkLimit: progress.batchChunkLimit,
                  embedDone: progress.embedDone,
                  embedTotal: progress.embedTotal,
                };
              },
              () => this.stopped,
            );
          }
        } catch (err) {
          // Log but don't propagate — ensures we always reach the state-recovery below
          console.error(`[silo:${this.config.name}] Watcher runQueue error:`, err);
        }
        this.reconcileProgress = undefined;
        this.watcherIndexingDone = null;
        resolveIndexingDone();
        // runQueue() re-fires onQueueFilled if items arrived mid-run,
        // which schedules another turn. Set ready only if truly idle.
        if (!this.stopped && (!this.watcher || this.watcher.queueLength === 0)) {
          this.watcherState = 'ready';
          this.errorMessage = undefined;
        }
      },
    );
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

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Recursively resolve stored-key paths in a directory tree to absolute paths. */
function resolveTreeNodes(nodes: DirectoryTreeNode[], directories: string[]): DirectoryTreeNode[] {
  return nodes.map((n) => ({
    ...n,
    path: resolveStoredKey(n.path, directories),
    children: resolveTreeNodes(n.children, directories),
    files: n.files?.map((f) => ({
      filePath: resolveStoredKey(f.filePath, directories),
      fileName: f.fileName,
    })),
  }));
}
