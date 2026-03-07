/**
 * D1MemoryService — IMemoryService implementation on Cloudflare D1 + Vectorize.
 *
 * Memory storage in D1, embedding vectors in Vectorize, inference via Workers AI.
 * All operations are async (D1/Vectorize APIs). Gracefully degrades to BM25-only
 * when AI or Vectorize bindings are unavailable.
 */

import type {
  MemoryRecord,
  MemorySearchResult,
  MemoryStatus,
  MemoryStatusValue,
  PriorityLevel,
  ProjectRecord,
  ProjectWithCounts,
  RelatedMemoryResult,
} from './shared/types';
import { formatDateISO, syncStatusAndCompletedOn } from './shared/memory-utils';
import { advanceRecurrence, type DateRangeResult } from './date-parser';
import { searchMemory, type MemorySearchMode, type MemoryDateFilters } from './memory-search';
import { getMemory, getMemoryCount, getRecentActiveMemories, getActiveUpcomingMemories, getOverdueMemories, getMemoriesByActionDateRange, getAllProjects, getProjectById, getProjectByName, getProjectTaskCounts } from './d1/read';
import { insertMemory, updateMemory, deleteMemory, insertProject, updateProject, deleteProject, mergeProjects } from './d1/write';
import { embedDocument, embedQuery } from './embedding';
import { rowToRecord } from './d1/helpers';

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
  projectId?: number | null;
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
  projectId?: number | null;
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

/** Cosine similarity threshold for dedup (from desktop similarity.ts). */
const DEDUP_THRESHOLD = 0.80;

// ── Service ─────────────────────────────────────────────────────────────────

export class D1MemoryService {
  constructor(
    private db: D1Database,
    private ai?: Ai,
    private vectorize?: Vectorize,
  ) {}

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
   * Write a new memory with optional dedup check via Vectorize.
   * When `force` is false and AI/Vectorize are available, checks for
   * similar existing memories before inserting.
   */
  async remember(params: RememberParams): Promise<RememberResult> {
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
      projectId = null,
    } = params;
    let { status: memStatus = null } = params;
    let completedOn = rawCompletedOn;

    // Sync status ↔ completedOn before writing
    const synced = syncStatusAndCompletedOn(memStatus, completedOn);
    memStatus = synced.status as MemoryStatusValue | null;
    completedOn = synced.completedOn as string | null;

    // Embed the document (used for both dedup and storage)
    let embedding: number[] | undefined;
    if (this.ai) {
      embedding = await embedDocument(this.ai, topic, body);
    }

    // Dedup check: find similar memory via Vectorize KNN
    if (!force && embedding && this.vectorize) {
      const results = await this.vectorize.query(embedding, { topK: 1 });
      if (results.matches.length > 0) {
        const best = results.matches[0];
        if (best.score >= DEDUP_THRESHOLD) {
          const existingId = parseInt(best.id, 10);
          const existing = await getMemory(this.db, existingId);
          if (existing) {
            return { status: 'duplicate', existing, similarity: best.score };
          }
        }
      }
    }

    const id = await insertMemory(
      this.db, topic, body, confidence, contextHint,
      actionDate, recurrence, priority, memStatus, completedOn,
      projectId, this.vectorize, embedding,
    );

    return { status: 'created', id };
  }

  /**
   * Search memories using the D1 decaying-sum signal pipeline.
   * When AI/Vectorize are available, embeds the query for semantic search.
   * Falls back to BM25-only when unavailable.
   */
  async recall(params: RecallParams): Promise<MemorySearchResult[]> {
    const { query, maxResults = 5, mode = 'hybrid', dateFilters } = params;

    // Embed query for semantic search (only if we have AI + Vectorize)
    let queryVector: number[] | undefined;
    if (this.ai && this.vectorize && mode !== 'bm25') {
      queryVector = await embedQuery(this.ai, query);
    }

    return searchMemory(
      this.db, query, maxResults, mode as MemorySearchMode, dateFilters,
      this.vectorize, queryVector,
    );
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

        // Re-embed if body changed
        let embedding: number[] | undefined;
        if (updates.body && this.ai) {
          embedding = await embedDocument(this.ai, updates.topic ?? existing.topic, updates.body);
        }

        // Revise the recurring task
        await updateMemory(this.db, id, updates, this.vectorize, embedding);

        // Embed and insert completion record
        let completionEmbedding: number[] | undefined;
        if (this.ai) {
          completionEmbedding = await embedDocument(this.ai, `COMPLETED: ${existing.topic}`, completionBody);
        }

        const completionRecordId = await insertMemory(
          this.db,
          `COMPLETED: ${existing.topic}`,
          completionBody,
          1.0,
          null,
          null, null, null,
          'completed',
          today,
          null, // completion records are not assigned to projects
          this.vectorize, completionEmbedding,
        );

        return { completionRecordId, nextActionDate };
      }
    }

    // ── Standard revise ──────────────────────────────────────────────────
    // Re-embed if body changed
    let embedding: number[] | undefined;
    if (updates.body && this.ai) {
      const existing = await getMemory(this.db, id);
      if (existing) {
        embedding = await embedDocument(this.ai, updates.topic ?? existing.topic, updates.body);
      }
    }

    await updateMemory(this.db, id, updates, this.vectorize, embedding);
    return {};
  }

  /**
   * Soft-delete a memory by id. Removes from both D1 inverted index and Vectorize.
   */
  async forget(id: number, reason?: string): Promise<void> {
    await deleteMemory(this.db, id, reason, this.vectorize);
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
   * Find related memories via Vectorize KNN using the memory's own embedding.
   * Returns empty array when Vectorize is unavailable.
   */
  async findRelated(id: number, topN = 5): Promise<RelatedMemoryResult[]> {
    if (!this.vectorize) return [];

    // Fetch the memory's own vector from Vectorize
    const vectors = await this.vectorize.getByIds([String(id)]);
    if (vectors.length === 0) return [];

    const vector = vectors[0].values;
    if (!vector) return [];

    // Query for topN+1 to exclude self
    const results = await this.vectorize.query(
      vector instanceof Float32Array || vector instanceof Float64Array
        ? Array.from(vector)
        : vector,
      { topK: topN + 1 },
    );

    // Filter out self and collect matches
    const matches = results.matches.filter(m => m.id !== String(id)).slice(0, topN);
    if (matches.length === 0) return [];

    // Fetch full records from D1
    const ids = matches.map(m => parseInt(m.id, 10));
    const placeholders = ids.map(() => '?').join(', ');
    const { results: rows } = await this.db.prepare(
      `SELECT * FROM memories WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
    ).bind(...ids).all();

    const rowMap = new Map(rows.map(r => [(r as Record<string, unknown>).id as number, r]));

    return matches
      .filter(m => rowMap.has(parseInt(m.id, 10)))
      .map(m => ({
        ...rowToRecord(rowMap.get(parseInt(m.id, 10))! as Record<string, unknown>),
        similarity: m.score,
      }));
  }

  // ── Project operations ──────────────────────────────────────────────────

  async listProjects(): Promise<ProjectRecord[]> {
    return getAllProjects(this.db);
  }

  async getProject(id: number): Promise<ProjectRecord | null> {
    return getProjectById(this.db, id);
  }

  async getProjectByName(name: string): Promise<ProjectRecord | null> {
    return getProjectByName(this.db, name);
  }

  async getProjectsWithCounts(): Promise<ProjectWithCounts[]> {
    return getProjectTaskCounts(this.db);
  }

  async createProject(name: string, color = 'blue'): Promise<number> {
    return insertProject(this.db, name, color);
  }

  async updateProject(id: number, updates: { name?: string; color?: string }): Promise<void> {
    return updateProject(this.db, id, updates);
  }

  async deleteProject(id: number): Promise<void> {
    return deleteProject(this.db, id);
  }

  /**
   * Merge source project into target. Returns the number of memories reassigned.
   */
  async mergeProjects(sourceId: number, targetId: number): Promise<number> {
    return mergeProjects(this.db, sourceId, targetId);
  }

  /**
   * Resolve a project name to its ID.
   *
   * Tries exact match first (case-insensitive). If not found, returns
   * fuzzy Levenshtein matches so the caller can suggest alternatives.
   */
  async resolveProjectName(name: string): Promise<
    | { status: 'found'; id: number }
    | { status: 'not_found'; suggestions: { name: string; id: number; distance: number }[] }
  > {
    // Try exact match (case-insensitive — SQLite COLLATE NOCASE on the column)
    const existing = await getProjectByName(this.db, name);
    if (existing) return { status: 'found', id: existing.id };

    // Fuzzy search: compute Levenshtein distance against all project names
    const allProjects = await getAllProjects(this.db);
    const scored = allProjects
      .map(p => ({ name: p.name, id: p.id, distance: levenshtein(name.toLowerCase(), p.name.toLowerCase()) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 5);

    return { status: 'not_found', suggestions: scored };
  }
}

// ── Levenshtein distance ────────────────────────────────────────────────────

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // Use single-row optimization
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}
