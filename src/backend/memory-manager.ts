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

import path from 'node:path';
import type { EmbeddingService } from './embedding';
import { MEMORY_MODEL } from './memory-store';
import {
  createMemoryDatabase,
  openMemoryDatabase,
  validateMemoryDatabase,
  hybridSearchMemory,
  insertMemory,
  updateMemory,
  deleteMemory,
  getRecentMemories,
  findSimilarMemory,
  getMemoryCount,
  getMemoryDatabaseSizeBytes,
  type MemoryDatabase,
  type MemoryRecord,
  type MemorySearchResult,
} from './memory-store';

// ── Status ────────────────────────────────────────────────────────────────────

export interface MemoryStatus {
  connected: boolean;
  dbPath: string | null;
  memoryCount: number;
  databaseSizeBytes: number;
}

// ── Manager ───────────────────────────────────────────────────────────────────

export class MemoryManager {
  private db: MemoryDatabase | null = null;
  private dbPath: string | null = null;

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
    createMemoryDatabase(dbPath); // idempotent — only creates missing tables
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
   * Hybrid search over memories: cosine + BM25 fused by weighted-max.
   * Returns up to maxResults memories sorted by relevance.
   */
  async recall(
    query: string,
    maxResults: number,
    embeddingService: EmbeddingService,
  ): Promise<MemorySearchResult[]> {
    this.assertConnected();

    const prefix = embeddingService.modelName === MEMORY_MODEL
      ? 'search_query: '
      : '';
    const queryVector = await embeddingService.embed(prefix + query);
    return hybridSearchMemory(this.db!, queryVector, query, maxResults);
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

  // ── Private ────────────────────────────────────────────────────────────────

  private disconnectQuiet(): void {
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
