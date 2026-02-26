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
  getMemoriesByActionDateRange,
  getMemory,
  findSimilarMemory,
  getMemoryCount,
  getMemoryDatabaseSizeBytes,
  type MemoryDatabase,
  type MemoryRecord,
  type SimilarMemoryResult,
} from './memory-store';
import { searchMemory, type MemorySearchResult, type MemorySearchMode, type MemoryDateFilters } from './memory-search';
import { advanceRecurrence } from './date-parser';

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
      // Reconnect to pick up external changes (WAL checkpoints, Google Drive syncs)
      this.reconnect();
      this.onChange?.();
    }
  }

  /**
   * Close and reopen the current database connection.
   * This ensures we see changes made externally (WAL mode connections
   * may not see external writes until the connection is refreshed).
   */
  private reconnect(): void {
    if (!this.db || !this.dbPath) return;
    try { this.db.close(); } catch { /* ignore */ }
    this.db = openMemoryDatabase(this.dbPath);
    if (this.db) {
      console.log(`[memory] Reconnected to database (external change detected)`);
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

  /** Result of a remember operation. */
  // - created: new memory inserted
  // - duplicate: similar memory found, returned for LLM to decide
  //   (existing record + similarity score, nothing was written)

  /**
   * Write a new memory, or detect a near-duplicate and surface it.
   *
   * When `force` is false (default), checks cosine similarity against all
   * existing memories. If a closely related entry is found (similarity >=
   * DEDUP_THRESHOLD), the existing memory is returned **without modification**
   * so the caller can prompt the LLM to decide whether to update or force-create.
   *
   * When `force` is true, skips the dedup check entirely and always inserts.
   */
  async remember(
    topic: string,
    body: string,
    confidence: number,
    contextHint: string | null,
    embeddingService: EmbeddingService,
    force = false,
    actionDate: string | null = null,
    recurrence: string | null = null,
    priority: number | null = null,
  ): Promise<
    | { status: 'created'; id: number }
    | { status: 'duplicate'; existing: MemoryRecord; similarity: number }
  > {
    this.assertConnected();

    const prefix = embeddingService.modelName === MEMORY_MODEL
      ? 'search_document: '
      : '';
    const embedding = await embeddingService.embed(prefix + body);

    // Dedup check (skipped when force is true)
    if (!force) {
      const match = findSimilarMemory(this.db!, embedding);
      if (match) {
        console.log(`[memory] Similar memory found: m${match.record.id} (${Math.round(match.similarity * 100)}% similarity)`);
        return { status: 'duplicate', existing: match.record, similarity: match.similarity };
      }
    }

    const id = insertMemory(this.db!, topic, body, confidence, contextHint, embedding, actionDate, recurrence, priority);
    console.log(`[memory] Created new memory ${id} [${topic}]`);
    return { status: 'created', id };
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
    dateFilters?: MemoryDateFilters,
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

    return searchMemory(this.db!, queryVector, query, maxResults, mode, dateFilters);
  }

  /**
   * Explicitly update a specific memory by id.
   * If body is changed, re-embeds and re-syncs the vec table.
   */
  async revise(
    id: number,
    updates: {
      body?: string;
      confidence?: number;
      contextHint?: string | null;
      actionDate?: string | null;
      recurrence?: string | null;
      priority?: number | null;
      topic?: string;
    },
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
   * Return the N most recently updated memories, plus any with upcoming action dates.
   *
   * 1. Auto-advance recurring memories whose action_date is in the past.
   * 2. Fetch memories with action_date in [today, today+7], ordered by action_date ASC.
   * 3. Fetch the most recently updated memories.
   * 4. Merge the two sets (action-date memories first, sorted by priority), deduplicated by id.
   * 5. Return up to maxResults entries.
   */
  orient(maxResults: number): MemoryRecord[] {
    this.assertConnected();

    const today = new Date();
    const todayStr = formatDateISO(today);
    const nextWeek = new Date(today);
    nextWeek.setDate(nextWeek.getDate() + 7);
    const nextWeekStr = formatDateISO(nextWeek);

    // Auto-advance recurring memories before fetching upcoming
    this.autoAdvanceRecurringMemories(today, todayStr);

    // Upcoming action-date memories (prioritised)
    const upcoming = getMemoriesByActionDateRange(this.db!, todayStr, nextWeekStr, maxResults);

    // Sort upcoming: higher priority first, then by action_date ASC
    upcoming.sort((a, b) => {
      const pa = a.priority ?? 0;
      const pb = b.priority ?? 0;
      if (pb !== pa) return pb - pa; // higher priority first
      return (a.actionDate ?? '').localeCompare(b.actionDate ?? '');
    });

    // Recent memories (existing behaviour)
    const recent = getRecentMemories(this.db!, maxResults);

    // Merge: action-date memories first, then recent, deduplicated
    const seen = new Set<number>();
    const merged: MemoryRecord[] = [];

    for (const m of upcoming) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        merged.push(m);
      }
    }
    for (const m of recent) {
      if (!seen.has(m.id) && merged.length < maxResults) {
        seen.add(m.id);
        merged.push(m);
      }
    }

    return merged;
  }

  /**
   * Auto-advance recurring memories whose action_date has fallen behind today.
   * Computes the next valid occurrence and persists the updated action_date.
   */
  private autoAdvanceRecurringMemories(today: Date, todayStr: string): void {
    if (!this.db) return;

    const stale = this.db.prepare(
      `SELECT * FROM memories WHERE recurrence IS NOT NULL AND action_date IS NOT NULL AND action_date < ?`,
    ).all(todayStr) as Record<string, unknown>[];

    for (const row of stale) {
      try {
        const id = row.id as number;
        const oldDate = row.action_date as string;
        const rule = row.recurrence as string;
        const newDate = advanceRecurrence(oldDate, rule, today);
        if (newDate !== oldDate) {
          updateMemory(this.db!, id, { actionDate: newDate });
          console.log(`[memory] Auto-advanced recurring memory m${id}: ${oldDate} → ${newDate} (${rule})`);
        }
      } catch (err) {
        const id = row.id ?? '?';
        console.error(`[memory] Failed to auto-advance memory m${id}:`, err);
      }
    }
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

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Format a Date as ISO 8601 date string (YYYY-MM-DD). */
function formatDateISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
