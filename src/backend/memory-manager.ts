/**
 * MemoryManager — lifecycle and operations for Claude's memory database.
 *
 * Manages a single SQLite memory database: connecting, setting up,
 * and exposing the five memory operations (remember, recall, revise,
 * forget, orient).
 *
 * Unlike SiloManager there is no file watching or indexing queue.
 * All writes happen inline — memory entries are small and infrequent.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { EmbeddingService } from './embedding';
import { MEMORY_MODEL } from './memory-store';
import {
  createMemoryDatabase,
  openMemoryDatabase,
  validateMemoryDatabase,
  insertMemory,
  updateMemory,
  deleteMemory,
  getRecentMemories,
  getMemory,
  findSimilarMemory,
  getMemoryCount,
  getMemoryDatabaseSizeBytes,
  type MemoryDatabase,
  type MemoryRecord,
} from './memory-store';
import { searchMemory, type MemorySearchResult, type MemorySearchMode } from './memory-search';

// ── Status ────────────────────────────────────────────────────────────────────

export interface MemoryStatus {
  connected: boolean;
  dbPath: string | null;
  memoryCount: number;
  databaseSizeBytes: number;
}

// ── Manager ───────────────────────────────────────────────────────────────────

/** Default poll interval for detecting external DB changes (30 seconds). */
const POLL_INTERVAL_MS = 30_000;

export class MemoryManager {
  private db: MemoryDatabase | null = null;
  private dbPath: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastPollMtimeMs = 0;
  private onChange: (() => void) | null = null;

  // ── Connection ─────────────────────────────────────────────────────────────

  /**
   * Create a fresh memory database at the given absolute path, then connect.
   * Throws if creation fails.
   */
  setup(dbPath: string): void {
    this.disconnectQuiet();
    this.db = createMemoryDatabase(dbPath);
    this.dbPath = dbPath;
    console.log(`[memory] Set up new database at ${dbPath}`);
  }

  /**
   * Connect to an existing memory database.
   * Throws if the file doesn't exist, isn't valid, or can't be opened.
   */
  connect(dbPath: string): void {
    if (!validateMemoryDatabase(dbPath)) {
      throw new Error(`Not a valid memory database: ${dbPath}`);
    }
    this.disconnectQuiet();
    const db = openMemoryDatabase(dbPath);
    if (!db) throw new Error(`Failed to open memory database: ${dbPath}`);

    // Apply any schema additions for forward compatibility
    const migrationDb = createMemoryDatabase(dbPath); // idempotent — only creates missing tables
    migrationDb.close();
    db.close();
    this.db = openMemoryDatabase(dbPath)!;
    this.dbPath = dbPath;
    console.log(`[memory] Connected to database at ${dbPath}`);
  }

  /**
   * Disconnect from the current database. Safe to call when not connected.
   */
  disconnect(): void {
    this.disconnectQuiet();
  }

  isConnected(): boolean {
    return this.db !== null;
  }

  getStatus(): MemoryStatus {
    if (!this.db || !this.dbPath) {
      return { connected: false, dbPath: null, memoryCount: 0, databaseSizeBytes: 0 };
    }
    return {
      connected: true,
      dbPath: this.dbPath,
      memoryCount: getMemoryCount(this.db),
      databaseSizeBytes: getMemoryDatabaseSizeBytes(this.dbPath),
    };
  }

  getDbPath(): string | null {
    return this.dbPath;
  }

  // ── External Change Detection ─────────────────────────────────────────────

  /**
   * Start polling for external changes to the memory database file.
   * Detects Google Drive syncs, other processes, etc. by checking the file's
   * mtime. Calls `onChange` when a change is detected.
   */
  startPolling(onChange: () => void): void {
    this.stopPolling();
    this.onChange = onChange;
    this.lastPollMtimeMs = this.getDbMtimeMs();
    this.pollTimer = setInterval(() => this.pollForChanges(), POLL_INTERVAL_MS);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.onChange = null;
  }

  private pollForChanges(): void {
    if (!this.dbPath) return;
    const currentMtime = this.getDbMtimeMs();
    if (currentMtime !== this.lastPollMtimeMs) {
      this.lastPollMtimeMs = currentMtime;
      this.onChange?.();
    }
  }

  /** Get the DB file's mtime in ms, or 0 if unavailable. */
  private getDbMtimeMs(): number {
    if (!this.dbPath) return 0;
    try {
      return fs.statSync(this.dbPath).mtimeMs;
    } catch {
      return 0;
    }
  }

  /**
   * Mark the current mtime as "seen" — call after local writes to avoid
   * a spurious change notification on the next poll cycle.
   */
  touchPollBaseline(): void {
    this.lastPollMtimeMs = this.getDbMtimeMs();
  }

  // ── Memory Operations ──────────────────────────────────────────────────────

  /**
   * Write a new memory or update an existing similar one.
   *
   * Before inserting, checks cosine similarity against all existing memories.
   * If a closely related entry is found (similarity >= DEDUP_THRESHOLD),
   * that entry is updated instead of a new one being created.
   *
   * Returns { id, updated: true } if an existing memory was updated,
   *         { id, updated: false } if a new memory was created.
   */
  async remember(
    topic: string,
    body: string,
    confidence: number,
    contextHint: string | null,
    embeddingService: EmbeddingService,
  ): Promise<{ id: number; updated: boolean }> {
    this.assertConnected();

    const prefix = embeddingService.modelName === MEMORY_MODEL
      ? 'search_document: '
      : '';
    const embedding = await embeddingService.embed(prefix + body);

    // Dedup check
    const existing = findSimilarMemory(this.db!, embedding);
    if (existing) {
      updateMemory(this.db!, existing.id, { body, confidence, contextHint }, embedding);
      console.log(`[memory] Updated memory ${existing.id} (similar entry found)`);
      return { id: existing.id, updated: true };
    }

    const id = insertMemory(this.db!, topic, body, confidence, contextHint, embedding);
    console.log(`[memory] Created new memory ${id} [${topic}]`);
    return { id, updated: false };
  }

  /**
   * Search memories using the decaying-sum signal pipeline.
   * Supports mode selection: hybrid (default), semantic, bm25.
   */
  async recall(
    query: string,
    maxResults: number,
    embeddingService: EmbeddingService,
    mode: MemorySearchMode = 'hybrid',
  ): Promise<MemorySearchResult[]> {
    this.assertConnected();

    // BM25 mode doesn't need an embedding vector
    let queryVector: number[] = [];
    if (mode !== 'bm25') {
      const prefix = embeddingService.modelName === MEMORY_MODEL
        ? 'search_query: '
        : '';
      queryVector = await embeddingService.embed(prefix + query);
    }

    return searchMemory(this.db!, queryVector, query, maxResults, mode);
  }

  /**
   * Explicitly update a specific memory by id.
   * If body is changed, re-embeds and re-syncs the vec table.
   */
  async revise(
    id: number,
    updates: { body?: string; confidence?: number; contextHint?: string | null },
    embeddingService: EmbeddingService,
  ): Promise<void> {
    this.assertConnected();

    let embedding: number[] | undefined;
    if (updates.body !== undefined) {
      const prefix = embeddingService.modelName === MEMORY_MODEL
        ? 'search_document: '
        : '';
      embedding = await embeddingService.embed(prefix + updates.body);
    }

    updateMemory(this.db!, id, updates, embedding);
    console.log(`[memory] Revised memory ${id}`);
  }

  /**
   * Delete a memory by id.
   */
  forget(id: number): void {
    this.assertConnected();
    deleteMemory(this.db!, id);
    console.log(`[memory] Forgot memory ${id}`);
  }

  /**
   * Return the N most recently updated memories.
   * Used for orientation at the start of a conversation.
   */
  orient(maxResults: number): MemoryRecord[] {
    this.assertConnected();
    return getRecentMemories(this.db!, maxResults);
  }

  /**
   * Fetch a single memory by its primary key.
   * Used by lodestone_read to resolve m-prefixed puids.
   */
  getById(id: number): MemoryRecord | null {
    this.assertConnected();
    return getMemory(this.db!, id);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private disconnectQuiet(): void {
    this.stopPolling();
    if (this.db) {
      try { this.db.close(); } catch { /* ignore */ }
      this.db = null;
      this.dbPath = null;
    }
  }

  private assertConnected(): void {
    if (!this.db) throw new Error('No memory database connected');
  }
}
