/**
 * MemoryManager — lifecycle and operations for Claude's memory database.
 *
 * Manages a single SQLite memory database: connecting, setting up,
 * and exposing the memory operations through the IMemoryService interface.
 *
 * Embedding is an internal concern — callers provide an EmbeddingProvider
 * at setup time rather than passing an EmbeddingService per-call.
 *
 * Unlike SiloManager there is no file watching or indexing queue.
 * All writes happen inline — memory entries are small and infrequent.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { EmbeddingService } from './embedding';
import type { MemoryRecord, MemoryStatus, MemoryStatusValue, PriorityLevel, RelatedMemoryResult, MemorySearchResult } from '../shared/types';
import { formatDateISO, syncStatusAndCompletedOn } from '../shared/memory-utils';
import { MEMORY_MODEL } from './memory-store';
import {
  createMemoryDatabase,
  openMemoryDatabase,
  validateMemoryDatabase,
  insertMemory,
  updateMemory,
  deleteMemory,
  getRecentActiveMemories,
  getMemoriesByActionDateRange,
  getActiveUpcomingMemories,
  getOverdueMemories,
  getMemory,
  findSimilarMemory,
  findRelatedMemories,
  getMemoryCount,
  getMemoryDatabaseSizeBytes,
  type MemoryDatabase,
} from './memory-store';
import { searchMemory, type MemorySearchMode, type MemoryDateFilters } from './memory-search';
import { advanceRecurrence, type DateRangeResult } from './date-parser';
import type {
  IMemoryService,
  RememberParams,
  RememberResult,
  RecallParams,
  ReviseParams,
  ReviseResult,
  SkipResult,
  AgendaParams,
  AgendaResult,
} from './memory-service';

// Re-export for backwards compatibility
export type { MemoryStatus, AgendaResult };
export type { IMemoryService, RememberParams, RememberResult, RecallParams, ReviseParams, ReviseResult, SkipResult, AgendaParams };

// ── Embedding Provider ───────────────────────────────────────────────────────

/**
 * Factory that returns a ready-to-use embedding service.
 * The provider is responsible for lazy creation and calling ensureReady().
 */
export type EmbeddingProvider = () => Promise<EmbeddingService>;

// ── Manager ──────────────────────────────────────────────────────────────────

/** Default poll interval for detecting external DB changes (30 seconds). */
const POLL_INTERVAL_MS = 30_000;

export class MemoryManager implements IMemoryService {
  private db: MemoryDatabase | null = null;
  private dbPath: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastPollMtimeMs = 0;
  private onChange: (() => void) | null = null;
  private embeddingProvider: EmbeddingProvider | null = null;

  // ── Embedding ──────────────────────────────────────────────────────────────

  /**
   * Set the embedding provider. Must be called before any operation that
   * requires embedding (remember, recall, revise, skip).
   */
  setEmbeddingProvider(provider: EmbeddingProvider): void {
    this.embeddingProvider = provider;
  }

  /** Embed text as a document (for storage). */
  private async embedDocument(text: string): Promise<number[]> {
    const service = await this.requireEmbeddingService();
    const prefix = service.modelName === MEMORY_MODEL ? 'search_document: ' : '';
    return service.embed(prefix + text);
  }

  /** Embed text as a query (for search). */
  private async embedQuery(text: string): Promise<number[]> {
    const service = await this.requireEmbeddingService();
    const prefix = service.modelName === MEMORY_MODEL ? 'search_query: ' : '';
    return service.embed(prefix + text);
  }

  private async requireEmbeddingService(): Promise<EmbeddingService> {
    if (!this.embeddingProvider) throw new Error('Embedding provider not set — call setEmbeddingProvider() first');
    return this.embeddingProvider();
  }

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

  // ── External Change Detection ──────────────────────────────────────────────

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

  // ── IMemoryService Operations ─────────────────────────────────────────────

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
  async remember(params: RememberParams): Promise<RememberResult> {
    this.assertConnected();

    const {
      topic,
      body,
      confidence = 1.0,
      contextHint = null,
      force = false,
      actionDate = null,
      recurrence = null,
      priority = null,
      completedOn: rawCompletedOn = null,
    } = params;
    let { status: memStatus = null } = params;
    let completedOn = rawCompletedOn;

    // Sync status ↔ completedOn before writing
    const synced = syncStatusAndCompletedOn(memStatus, completedOn);
    memStatus = synced.status;
    completedOn = synced.completedOn;

    const embedding = await this.embedDocument(body);

    // Dedup check (skipped when force is true)
    if (!force) {
      const match = findSimilarMemory(this.db!, embedding);
      if (match) {
        console.log(`[memory] Similar memory found: m${match.record.id} (${Math.round(match.similarity * 100)}% similarity)`);
        return { status: 'duplicate', existing: match.record, similarity: match.similarity };
      }
    }

    const id = insertMemory(this.db!, topic, body, confidence, contextHint, embedding, actionDate, recurrence, priority, memStatus, completedOn);
    console.log(`[memory] Created new memory ${id} [${topic}]`);
    return { status: 'created', id };
  }

  /**
   * Search memories using the decaying-sum signal pipeline.
   * Supports mode selection: hybrid (default), semantic, bm25.
   */
  async recall(params: RecallParams): Promise<MemorySearchResult[]> {
    this.assertConnected();

    const { query, maxResults = 5, mode = 'hybrid', dateFilters } = params;

    // BM25 mode doesn't need an embedding vector
    let queryVector: number[] = [];
    if (mode !== 'bm25') {
      queryVector = await this.embedQuery(query);
    }

    return searchMemory(this.db!, queryVector, query, maxResults, mode as MemorySearchMode, dateFilters);
  }

  /**
   * Explicitly update a specific memory by id.
   * If body is changed, re-embeds and re-syncs the vec table.
   *
   * Special case — recurring completion:
   * When status is set to 'completed' on a memory that has a recurrence rule,
   * the server automatically:
   *   1. Creates an immutable completion record referencing this memory.
   *   2. Resets the recurring memory to status='open', clears completed_on, and
   *      advances action_date to the next occurrence.
   * All three writes happen in a single DB transaction. Returns the completion
   * record id and next action date when this path is taken.
   */
  async revise(params: ReviseParams): Promise<ReviseResult> {
    this.assertConnected();

    const { id, ...fields } = params;
    const updates: {
      body?: string;
      confidence?: number;
      contextHint?: string | null;
      actionDate?: string | null;
      recurrence?: string | null;
      priority?: PriorityLevel | null;
      topic?: string;
      status?: MemoryStatusValue | null;
      completedOn?: string | null;
    } = { ...fields };

    // Sync status ↔ completedOn before writing
    if (updates.status !== undefined || updates.completedOn !== undefined) {
      const synced = syncStatusAndCompletedOn(updates.status, updates.completedOn);
      updates.status = synced.status;
      updates.completedOn = synced.completedOn;
    }

    let embedding: number[] | undefined;
    if (updates.body !== undefined) {
      embedding = await this.embedDocument(updates.body);
    }

    // ── Recurring completion: auto-advance + create completion record ────────
    if (updates.status === 'completed') {
      const existing = getMemory(this.db!, id);
      if (existing?.recurrence && existing.actionDate) {
        const today = formatDateISO(new Date());
        // Use tomorrow as reference so the date always advances past today,
        // even when completing on the same day as the action_date.
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const nextActionDate = advanceRecurrence(existing.actionDate, existing.recurrence, tomorrow);
        const completionBody = `Completed occurrence of m${id} (${existing.topic}) on ${today}.`;
        const completionEmbedding = await this.embedDocument(completionBody);

        // Override: recurring task resets to open with advanced date rather than staying completed
        updates.status = 'open';
        updates.completedOn = null;
        updates.actionDate = nextActionDate;

        // Atomic: revise recurring task + insert completion record in one transaction
        const completionRecordId = this.db!.transaction(() => {
          updateMemory(this.db!, id, updates, embedding);
          return insertMemory(
            this.db!,
            `COMPLETED: ${existing.topic}`,
            completionBody,
            1.0,
            null,
            completionEmbedding,
            null, null, null,
            'completed',
            today,
          );
        })() as number;

        console.log(`[memory] Completed recurring memory m${id}: completion record m${completionRecordId}, next occurrence ${nextActionDate}`);
        return { completionRecordId, nextActionDate };
      }
    }

    // ── Standard revise ──────────────────────────────────────────────────────
    updateMemory(this.db!, id, updates, embedding);
    console.log(`[memory] Revised memory ${id}`);
    return {};
  }

  /**
   * Soft-delete a memory by id. The row is retained but marked deleted_at,
   * making it invisible to all queries while still readable via lodestone_read.
   */
  async forget(id: number, reason?: string): Promise<void> {
    this.assertConnected();
    deleteMemory(this.db!, id, reason);
    console.log(`[memory] Soft-deleted memory ${id}${reason ? ` (${reason})` : ''}`);
  }

  /**
   * Advance a recurring memory to its next occurrence without creating a
   * completion record. Covers the case where an occurrence is intentionally
   * skipped rather than completed.
   *
   * If reason is provided, appends a skip note to the memory body so there
   * is a lightweight audit trail without a separate record.
   */
  async skip(id: number, reason?: string): Promise<SkipResult> {
    this.assertConnected();

    const existing = getMemory(this.db!, id);
    if (!existing) throw new Error(`Memory m${id} not found`);
    if (!existing.recurrence) throw new Error(`Memory m${id} is not a recurring memory`);
    if (!existing.actionDate) throw new Error(`Memory m${id} has no action_date to advance`);

    const today = formatDateISO(new Date());
    // Use the day after the action_date as reference so the date always advances
    // by at least one step — even if the action_date is in the future.
    const [y, m, d] = existing.actionDate.split('-').map(Number);
    const dayAfterAction = new Date(y, m - 1, d + 1);
    const nextActionDate = advanceRecurrence(existing.actionDate, existing.recurrence, dayAfterAction);

    const updates: { actionDate: string; body?: string } = { actionDate: nextActionDate };
    let embedding: number[] | undefined;

    if (reason) {
      const skipNote = `\n\nSkipped occurrence on ${today}: ${reason}.`;
      updates.body = existing.body + skipNote;
      embedding = await this.embedDocument(updates.body);
    }

    updateMemory(this.db!, id, updates, embedding);
    console.log(`[memory] Skipped recurring memory m${id}: next occurrence ${nextActionDate}`);
    return { nextActionDate };
  }

  /**
   * Return the N most recently updated memories, plus any with upcoming action dates.
   *
   * 1. Fetch active (non-completed, non-cancelled) memories with action_date in [today, today+7].
   * 2. Fetch the most recently updated active memories.
   * 3. Merge the two sets (action-date memories first, sorted by priority), deduplicated by id.
   * 4. Return up to maxResults entries.
   */
  async orient(maxResults = 10): Promise<MemoryRecord[]> {
    this.assertConnected();

    const today = new Date();
    const todayStr = formatDateISO(today);
    const nextWeek = new Date(today);
    nextWeek.setDate(nextWeek.getDate() + 7);
    const nextWeekStr = formatDateISO(nextWeek);

    // Upcoming active action-date memories (prioritised, excludes completed/cancelled)
    const upcoming = getActiveUpcomingMemories(this.db!, todayStr, nextWeekStr, maxResults);

    // Sort upcoming: higher priority first, then by action_date ASC
    upcoming.sort((a, b) => {
      const pa = a.priority ?? 0;
      const pb = b.priority ?? 0;
      if (pb !== pa) return pb - pa; // higher priority first
      return (a.actionDate ?? '').localeCompare(b.actionDate ?? '');
    });

    // Recent active memories (excludes completed/cancelled)
    const recent = getRecentActiveMemories(this.db!, maxResults);

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
   * Return agenda items: overdue memories + upcoming memories in the requested window.
   * Overdue = action_date before today, not completed, not cancelled.
   * Upcoming = action_date within the resolved date range.
   */
  async agenda(params: AgendaParams): Promise<AgendaResult> {
    this.assertConnected();

    const { when, includeCompleted = false, maxResults = 20 } = params;
    const today = new Date();
    const todayStr = formatDateISO(today);

    // Always fetch overdue items (active only)
    const overdue = getOverdueMemories(this.db!, todayStr, maxResults);
    overdue.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || (a.actionDate ?? '').localeCompare(b.actionDate ?? ''));

    // Fetch upcoming items for the requested window (unless "overdue" sentinel)
    let upcoming: MemoryRecord[] = [];
    if (!('overdue' in when)) {
      const { start, end } = when;
      if (includeCompleted) {
        // Use the raw date-range query (includes completed/cancelled)
        upcoming = getMemoriesByActionDateRange(this.db!, start, end, maxResults);
      } else {
        upcoming = getActiveUpcomingMemories(this.db!, start, end, maxResults);
      }
      upcoming.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || (a.actionDate ?? '').localeCompare(b.actionDate ?? ''));
    }

    return { overdue, upcoming };
  }

  /**
   * Fetch a single memory by its primary key.
   * Used by lodestone_read to resolve m-prefixed puids.
   */
  async getById(id: number): Promise<MemoryRecord | null> {
    this.assertConnected();
    return getMemory(this.db!, id);
  }

  /**
   * Find the top-N most similar active memories to the given memory id.
   * Used by lodestone_read to append related-memory hints on single m-id reads.
   */
  async findRelated(id: number, topN = 5): Promise<RelatedMemoryResult[]> {
    this.assertConnected();
    return findRelatedMemories(this.db!, id, topN);
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
