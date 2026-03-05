/**
 * D1MemoryService — IMemoryService implementation on Cloudflare D1.
 *
 * Phase 1 port of MemoryManager. Key differences:
 *   - Constructor takes D1Database instead of file path + EmbeddingService
 *   - No embedding/vec operations (Phase 3 — Vectorize)
 *   - Dedup check stubbed: remember() always inserts
 *   - findRelated() stubbed: returns empty array
 *   - All operations are async (D1 API)
 *   - No connection lifecycle or polling (serverless — stateless per-request)
 */

import type {
  MemoryRecord,
  MemorySearchResult,
  MemoryStatus,
  MemoryStatusValue,
  PriorityLevel,
  RelatedMemoryResult,
} from './shared/types';
import { formatDateISO, syncStatusAndCompletedOn } from './shared/memory-utils';
import { advanceRecurrence, type DateRangeResult } from './date-parser';
import { searchMemory, type MemorySearchMode, type MemoryDateFilters } from './memory-search';
import { getMemory, getMemoryCount, getRecentActiveMemories, getActiveUpcomingMemories, getOverdueMemories, getMemoriesByActionDateRange } from './d1/read';
import { insertMemory, updateMemory, deleteMemory } from './d1/write';

// ── Param & Result Types ────────────────────────────────────────────────────

export interface RememberParams {
  topic: string;
  body: string;
  confidence?: number;
  contextHint?: string | null;
  force?: boolean;
  actionDate?: string | null;
  recurrence?: string | null;
  priority?: PriorityLevel | null;
  status?: MemoryStatusValue | null;
  completedOn?: string | null;
}

export type RememberResult =
  | { status: 'created'; id: number }
  | { status: 'duplicate'; existing: MemoryRecord; similarity: number };

export interface RecallParams {
  query: string;
  maxResults?: number;
  mode?: 'hybrid' | 'semantic' | 'bm25';
  dateFilters?: MemoryDateFilters;
}

export interface ReviseParams {
  id: number;
  body?: string;
  confidence?: number;
  contextHint?: string | null;
  actionDate?: string | null;
  recurrence?: string | null;
  priority?: PriorityLevel | null;
  topic?: string;
  status?: MemoryStatusValue | null;
  completedOn?: string | null;
}

export interface ReviseResult {
  completionRecordId?: number;
  nextActionDate?: string;
}

export interface SkipResult {
  nextActionDate: string;
}

export interface AgendaParams {
  when: DateRangeResult;
  includeCompleted?: boolean;
  maxResults?: number;
}

export interface AgendaResult {
  overdue: MemoryRecord[];
  upcoming: MemoryRecord[];
}

// ── Service ─────────────────────────────────────────────────────────────────

export class D1MemoryService {
  constructor(private db: D1Database) {}

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  isConnected(): boolean {
    return true; // D1 is always "connected" — it's a binding
  }

  async getStatus(): Promise<MemoryStatus> {
    const count = await getMemoryCount(this.db);
    return {
      connected: true,
      dbPath: null,  // no filesystem path — D1 database
      memoryCount: count,
      databaseSizeBytes: 0,  // D1 doesn't expose file size
    };
  }

  // ── Operations ────────────────────────────────────────────────────────────

  /**
   * Write a new memory. Dedup is STUBBED in Phase 1 (no embeddings).
   * Always inserts regardless of `force` flag.
   */
  async remember(params: RememberParams): Promise<RememberResult> {
    const {
      topic,
      body,
      confidence = 1.0,
      contextHint = null,
      actionDate = null,
      recurrence = null,
      priority = null,
      completedOn: rawCompletedOn = null,
    } = params;
    let { status: memStatus = null } = params;
    let completedOn = rawCompletedOn;

    // Sync status ↔ completedOn before writing
    const synced = syncStatusAndCompletedOn(memStatus, completedOn);
    memStatus = synced.status as MemoryStatusValue | null;
    completedOn = synced.completedOn as string | null;

    const id = await insertMemory(
      this.db, topic, body, confidence, contextHint,
      actionDate, recurrence, priority, memStatus, completedOn,
    );

    return { status: 'created', id };
  }

  /**
   * Search memories using the D1 decaying-sum signal pipeline.
   * In Phase 1: hybrid/semantic modes degrade to BM25-only.
   */
  async recall(params: RecallParams): Promise<MemorySearchResult[]> {
    const { query, maxResults = 5, mode = 'hybrid', dateFilters } = params;
    return searchMemory(this.db, query, maxResults, mode as MemorySearchMode, dateFilters);
  }

  /**
   * Update a specific memory by id.
   *
   * Recurring completion: when status is set to 'completed' on a memory with
   * a recurrence rule, automatically creates an immutable completion record
   * and resets the recurring memory with an advanced action_date.
   */
  async revise(params: ReviseParams): Promise<ReviseResult> {
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
      updates.status = synced.status as MemoryStatusValue | null | undefined;
      updates.completedOn = synced.completedOn as string | null | undefined;
    }

    // ── Recurring completion: auto-advance + create completion record ────
    if (updates.status === 'completed') {
      const existing = await getMemory(this.db, id);
      if (existing?.recurrence && existing.actionDate) {
        const today = formatDateISO(new Date());
        // Use tomorrow as reference so the date always advances past today
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const nextActionDate = advanceRecurrence(existing.actionDate, existing.recurrence, tomorrow);
        const completionBody = `Completed occurrence of m${id} (${existing.topic}) on ${today}.`;

        // Override: recurring task resets to open with advanced date
        updates.status = 'open';
        updates.completedOn = null;
        updates.actionDate = nextActionDate;

        // Revise the recurring task
        await updateMemory(this.db, id, updates);

        // Insert completion record
        const completionRecordId = await insertMemory(
          this.db,
          `COMPLETED: ${existing.topic}`,
          completionBody,
          1.0,
          null,
          null, null, null,
          'completed',
          today,
        );

        return { completionRecordId, nextActionDate };
      }
    }

    // ── Standard revise ──────────────────────────────────────────────────
    await updateMemory(this.db, id, updates);
    return {};
  }

  /**
   * Soft-delete a memory by id.
   */
  async forget(id: number, reason?: string): Promise<void> {
    await deleteMemory(this.db, id, reason);
  }

  /**
   * Advance a recurring memory to its next occurrence without completing it.
   */
  async skip(id: number, reason?: string): Promise<SkipResult> {
    const existing = await getMemory(this.db, id);
    if (!existing) throw new Error(`Memory m${id} not found`);
    if (!existing.recurrence) throw new Error(`Memory m${id} is not a recurring memory`);
    if (!existing.actionDate) throw new Error(`Memory m${id} has no action_date to advance`);

    // Use the day after the action_date so the date always advances by at least one step
    const [y, m, d] = existing.actionDate.split('-').map(Number);
    const dayAfterAction = new Date(y, m - 1, d + 1);
    const nextActionDate = advanceRecurrence(existing.actionDate, existing.recurrence, dayAfterAction);

    const updates: { actionDate: string; body?: string } = { actionDate: nextActionDate };

    if (reason) {
      const today = formatDateISO(new Date());
      const skipNote = `\n\nSkipped occurrence on ${today}: ${reason}.`;
      updates.body = existing.body + skipNote;
    }

    await updateMemory(this.db, id, updates);
    return { nextActionDate };
  }

  /**
   * Return the N most recently updated memories, plus any with upcoming action dates.
   */
  async orient(maxResults = 10): Promise<MemoryRecord[]> {
    const today = new Date();
    const todayStr = formatDateISO(today);
    const nextWeek = new Date(today);
    nextWeek.setDate(nextWeek.getDate() + 7);
    const nextWeekStr = formatDateISO(nextWeek);

    // Upcoming active action-date memories (prioritised, excludes completed/cancelled)
    const upcoming = await getActiveUpcomingMemories(this.db, todayStr, nextWeekStr, maxResults);

    // Sort upcoming: higher priority first, then by action_date ASC
    upcoming.sort((a, b) => {
      const pa = a.priority ?? 0;
      const pb = b.priority ?? 0;
      if (pb !== pa) return pb - pa;
      return (a.actionDate ?? '').localeCompare(b.actionDate ?? '');
    });

    // Recent active memories (excludes completed/cancelled)
    const recent = await getRecentActiveMemories(this.db, maxResults);

    // Merge: action-date memories first, then recent, deduplicated
    const seen = new Set<number>();
    const merged: MemoryRecord[] = [];

    for (const mem of upcoming) {
      if (!seen.has(mem.id)) {
        seen.add(mem.id);
        merged.push(mem);
      }
    }
    for (const mem of recent) {
      if (!seen.has(mem.id) && merged.length < maxResults) {
        seen.add(mem.id);
        merged.push(mem);
      }
    }

    return merged;
  }

  /**
   * Return agenda items: overdue + upcoming in the requested window.
   */
  async agenda(params: AgendaParams): Promise<AgendaResult> {
    const { when, includeCompleted = false, maxResults = 20 } = params;
    const today = new Date();
    const todayStr = formatDateISO(today);

    // Always fetch overdue items (active only)
    const overdue = await getOverdueMemories(this.db, todayStr, maxResults);
    overdue.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || (a.actionDate ?? '').localeCompare(b.actionDate ?? ''));

    // Fetch upcoming items for the requested window (unless "overdue" sentinel)
    let upcoming: MemoryRecord[] = [];
    if (!('overdue' in when)) {
      const { start, end } = when;
      if (includeCompleted) {
        upcoming = await getMemoriesByActionDateRange(this.db, start, end, maxResults);
      } else {
        upcoming = await getActiveUpcomingMemories(this.db, start, end, maxResults);
      }
      upcoming.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || (a.actionDate ?? '').localeCompare(b.actionDate ?? ''));
    }

    return { overdue, upcoming };
  }

  /**
   * Fetch a single memory by its primary key.
   */
  async getById(id: number): Promise<MemoryRecord | null> {
    return getMemory(this.db, id);
  }

  /**
   * Find related memories — STUBBED in Phase 1 (no Vectorize).
   * Returns empty array. Phase 3 will implement real similarity search.
   */
  async findRelated(_id: number, _topN = 5): Promise<RelatedMemoryResult[]> {
    return [];
  }
}
