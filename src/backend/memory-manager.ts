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
  type MemoryRecord,
  type SimilarMemoryResult,
  type RelatedMemoryResult,
} from './memory-store';
import { searchMemory, type MemorySearchResult, type MemorySearchMode, type MemoryDateFilters } from './memory-search';
import { advanceRecurrence, parseDateRange, type DateRangeResult } from './date-parser';

// ── Status ────────────────────────────────────────────────────────────────────

export interface MemoryStatus {
  connected: boolean;
  dbPath: string | null;
  memoryCount: number;
  databaseSizeBytes: number;
}

// ── Agenda ────────────────────────────────────────────────────────────────────

export interface AgendaResult {
  /** Items whose action_date is before today and are not completed or cancelled. */
  overdue: MemoryRecord[];
  /** Items whose action_date falls within the requested time window. */
  upcoming: MemoryRecord[];
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
    memStatus: string | null = null,
    completedOn: string | null = null,
  ): Promise<
    | { status: 'created'; id: number }
    | { status: 'duplicate'; existing: MemoryRecord; similarity: number }
  > {
    this.assertConnected();

    // Sync status ↔ completedOn before writing
    const synced = syncStatusAndCompletedOn(memStatus, completedOn);
    memStatus = synced.status;
    completedOn = synced.completedOn;

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

    const id = insertMemory(this.db!, topic, body, confidence, contextHint, embedding, actionDate, recurrence, priority, memStatus, completedOn);
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
      status?: string | null;
      completedOn?: string | null;
    },
    embeddingService: EmbeddingService,
  ): Promise<{ completionRecordId?: number; nextActionDate?: string }> {
    this.assertConnected();

    // Sync status ↔ completedOn before writing
    if (updates.status !== undefined || updates.completedOn !== undefined) {
      const synced = syncStatusAndCompletedOn(
        updates.status,
        updates.completedOn,
      );
      updates.status = synced.status;
      updates.completedOn = synced.completedOn;
    }

    const prefix = embeddingService.modelName === MEMORY_MODEL ? 'search_document: ' : '';

    let embedding: number[] | undefined;
    if (updates.body !== undefined) {
      embedding = await embeddingService.embed(prefix + updates.body);
    }

    // ── Recurring completion: auto-advance + create completion record ─────────
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
        const completionEmbedding = await embeddingService.embed(prefix + completionBody);

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

    // ── Standard revise ───────────────────────────────────────────────────────
    updateMemory(this.db!, id, updates, embedding);
    console.log(`[memory] Revised memory ${id}`);
    return {};
  }

  /**
   * Advance a recurring memory to its next occurrence without creating a
   * completion record. Covers the case where an occurrence is intentionally
   * skipped rather than completed.
   *
   * If reason is provided, appends a skip note to the memory body so there
   * is a lightweight audit trail without a separate record.
   */
  async skip(
    id: number,
    reason: string | undefined,
    embeddingService: EmbeddingService,
  ): Promise<{ nextActionDate: string }> {
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
      const prefix = embeddingService.modelName === MEMORY_MODEL ? 'search_document: ' : '';
      embedding = await embeddingService.embed(prefix + updates.body);
    }

    updateMemory(this.db!, id, updates, embedding);
    console.log(`[memory] Skipped recurring memory m${id}: next occurrence ${nextActionDate}`);
    return { nextActionDate };
  }

  /**
   * Soft-delete a memory by id. The row is retained but marked deleted_at,
   * making it invisible to all queries while still readable via lodestone_read.
   */
  forget(id: number, reason?: string): void {
    this.assertConnected();
    deleteMemory(this.db!, id, reason);
    console.log(`[memory] Soft-deleted memory ${id}${reason ? ` (${reason})` : ''}`);
  }

  /**
   * Return the N most recently updated memories, plus any with upcoming action dates.
   *
   * 1. Auto-advance recurring memories whose action_date is in the past.
   * 2. Fetch active (non-completed, non-cancelled) memories with action_date in [today, today+7].
   * 3. Fetch the most recently updated active memories.
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
  agenda(
    when: DateRangeResult,
    includeCompleted: boolean,
    maxResults: number,
  ): AgendaResult {
    this.assertConnected();

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
  getById(id: number): MemoryRecord | null {
    this.assertConnected();
    return getMemory(this.db!, id);
  }

  /**
   * Find the top-N most similar active memories to the given memory id.
   * Used by lodestone_read to append related-memory hints on single m-id reads.
   */
  findRelated(id: number, topN = 5): RelatedMemoryResult[] {
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

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Format a Date as ISO 8601 date string (YYYY-MM-DD). */
function formatDateISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Sync status and completedOn so they stay consistent:
 *   - completedOn set         → status forced to 'completed'
 *   - status='completed'      → completedOn auto-filled to today if not provided
 *   - status='open'           → completedOn cleared to null
 *   - completedOn=null        → status cleared to null (if not explicitly set)
 */
function syncStatusAndCompletedOn(
  status: string | null | undefined,
  completedOn: string | null | undefined,
): { status: string | null | undefined; completedOn: string | null | undefined } {
  const today = formatDateISO(new Date());
  let s = status;
  let co = completedOn;

  if (co !== undefined && co !== null) {
    // completedOn being set → must be completed
    s = 'completed';
  } else if (s === 'completed') {
    // status=completed but no completedOn provided → auto-fill today
    if (co === undefined) co = today;
  } else if (s === 'open') {
    // Reopening → clear completedOn
    co = null;
  } else if (co === null && s === undefined) {
    // Clearing completedOn without setting status → clear status too
    s = null;
  }

  return { status: s, completedOn: co };
}
