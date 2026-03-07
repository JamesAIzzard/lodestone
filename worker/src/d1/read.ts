/**
 * D1 memory store read operations — async equivalents of memory-store/read.ts.
 *
 * All functions take a D1Database and return Promises.
 * D1 quirk: `.all()` returns `{ results: Row[] }`, not a bare array.
 */

import type { MemoryRecord, ProjectRecord, ProjectWithCounts } from '../shared/types';
import { rowToRecord, rowToProject } from './helpers';

/** Get a single memory record by id. Returns null if not found. */
export async function getMemory(db: D1Database, id: number): Promise<MemoryRecord | null> {
  const row = await db.prepare(`SELECT * FROM memories WHERE id = ?`).bind(id).first();
  return row ? rowToRecord(row as Record<string, unknown>) : null;
}

/** Count active (non-deleted) memories. */
export async function getMemoryCount(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) as cnt FROM memories WHERE deleted_at IS NULL`).first();
  return (row as Record<string, unknown>)?.cnt as number ?? 0;
}

/** Return N most recently updated active memories. */
export async function getRecentMemories(db: D1Database, maxResults: number): Promise<MemoryRecord[]> {
  const { results } = await db.prepare(
    `SELECT * FROM memories WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?`,
  ).bind(maxResults).all();
  return results.map((r) => rowToRecord(r as Record<string, unknown>));
}

/**
 * Return memories with action_date in the given range, ordered by action_date ASC.
 * Used by orient to surface upcoming deadlines.
 */
export async function getMemoriesByActionDateRange(
  db: D1Database,
  fromDate: string,
  toDate: string,
  maxResults: number,
): Promise<MemoryRecord[]> {
  const { results } = await db.prepare(
    `SELECT * FROM memories
     WHERE deleted_at IS NULL
       AND action_date IS NOT NULL
       AND action_date >= ?
       AND action_date <= ?
     ORDER BY action_date ASC
     LIMIT ?`,
  ).bind(fromDate, toDate, maxResults).all();
  return results.map((r) => rowToRecord(r as Record<string, unknown>));
}

/**
 * Return the set of memory IDs that match the given date-range filters.
 * Used to pre-filter candidates before the search pipeline runs.
 * Returns null if no date filters are active (meaning "no restriction").
 */
export async function filterMemoryIdsByDate(
  db: D1Database,
  filters: {
    updatedAfter?: string;
    updatedBefore?: string;
    actionAfter?: string;
    actionBefore?: string;
    completedAfter?: string;
    completedBefore?: string;
    dueAfter?: string;
    dueBefore?: string;
    status?: MemoryRecord['status'];
    projectId?: number;
    includeArchived?: boolean;
  },
): Promise<Set<number> | null> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters.updatedAfter) {
    clauses.push(`m.updated_at >= ?`);
    params.push(filters.updatedAfter);
  }
  if (filters.updatedBefore) {
    // Add a day to make the comparison inclusive for date-only values
    // since updated_at is a datetime like "2026-02-26T15:30:00.000Z"
    clauses.push(`m.updated_at <= ? || ' 23:59:59'`);
    params.push(filters.updatedBefore);
  }
  if (filters.actionAfter) {
    clauses.push(`m.action_date IS NOT NULL AND m.action_date >= ?`);
    params.push(filters.actionAfter);
  }
  if (filters.actionBefore) {
    clauses.push(`m.action_date IS NOT NULL AND m.action_date <= ?`);
    params.push(filters.actionBefore);
  }
  if (filters.completedAfter) {
    clauses.push(`m.completed_on IS NOT NULL AND m.completed_on >= ?`);
    params.push(filters.completedAfter);
  }
  if (filters.completedBefore) {
    clauses.push(`m.completed_on IS NOT NULL AND m.completed_on <= ?`);
    params.push(filters.completedBefore);
  }
  if (filters.dueAfter) {
    clauses.push(`m.due_date IS NOT NULL AND m.due_date >= ?`);
    params.push(filters.dueAfter);
  }
  if (filters.dueBefore) {
    clauses.push(`m.due_date IS NOT NULL AND m.due_date <= ?`);
    params.push(filters.dueBefore);
  }
  if (filters.status !== undefined) {
    if (filters.status === 'completed') {
      clauses.push(`(m.status = 'completed' OR m.completed_on IS NOT NULL)`);
    } else if (filters.status === null) {
      clauses.push(`(m.status IS NULL AND m.completed_on IS NULL)`);
    } else {
      clauses.push(`m.status = ?`);
      params.push(filters.status);
    }
  }
  if (filters.projectId !== undefined) {
    clauses.push(`m.project_id = ?`);
    params.push(filters.projectId);
  }

  // When not including archived, filter out memories belonging to archived projects
  if (!filters.includeArchived) {
    clauses.push(`(m.project_id IS NULL OR p.archived_at IS NULL)`);
  }

  if (clauses.length === 0) return null; // no filters active

  const needsJoin = !filters.includeArchived;
  const fromClause = needsJoin
    ? `memories m LEFT JOIN projects p ON m.project_id = p.id`
    : `memories m`;
  const sql = `SELECT m.id FROM ${fromClause} WHERE m.deleted_at IS NULL AND ${clauses.join(' AND ')}`;

  // D1 doesn't support spread args like better-sqlite3 — we chain .bind() with all params
  let stmt = db.prepare(sql);
  if (params.length > 0) {
    stmt = stmt.bind(...params);
  }

  const { results } = await stmt.all();
  return new Set(results.map((r) => (r as Record<string, unknown>).id as number));
}

/** Return memories with action_date before today that are not completed or cancelled.
 *  Used by agenda to surface overdue items. Excludes memories in archived projects. */
export async function getOverdueMemories(
  db: D1Database,
  beforeDate: string,
  maxResults: number,
): Promise<MemoryRecord[]> {
  const { results } = await db.prepare(
    `SELECT m.* FROM memories m
     LEFT JOIN projects p ON m.project_id = p.id
     WHERE m.deleted_at IS NULL
       AND m.action_date IS NOT NULL
       AND m.action_date < ?
       AND m.completed_on IS NULL
       AND (m.status IS NULL OR m.status = 'open')
       AND (m.project_id IS NULL OR p.archived_at IS NULL)
     ORDER BY COALESCE(m.priority, 0) DESC, m.action_date ASC
     LIMIT ?`,
  ).bind(beforeDate, maxResults).all();
  return results.map((r) => rowToRecord(r as Record<string, unknown>));
}

/** Return upcoming memories (action_date in range) excluding completed and cancelled.
 *  Used by agenda and orient. Excludes memories in archived projects. */
export async function getActiveUpcomingMemories(
  db: D1Database,
  fromDate: string,
  toDate: string,
  maxResults: number,
): Promise<MemoryRecord[]> {
  const { results } = await db.prepare(
    `SELECT m.* FROM memories m
     LEFT JOIN projects p ON m.project_id = p.id
     WHERE m.deleted_at IS NULL
       AND m.action_date IS NOT NULL
       AND m.action_date >= ?
       AND m.action_date <= ?
       AND m.completed_on IS NULL
       AND (m.status IS NULL OR m.status = 'open')
       AND (m.project_id IS NULL OR p.archived_at IS NULL)
     ORDER BY m.action_date ASC
     LIMIT ?`,
  ).bind(fromDate, toDate, maxResults).all();
  return results.map((r) => rowToRecord(r as Record<string, unknown>));
}

/** Return all non-deleted tasks ordered by action_date ASC (nulls last),
 *  then priority DESC. Used by the Tasks GUI.
 *  Only includes memories that have an explicit status (excludes pure knowledge memories). */
export async function getAllTasks(
  db: D1Database,
  opts: { includeCompleted: boolean; includeCancelled: boolean; projectId?: number },
  limit: number,
): Promise<MemoryRecord[]> {
  let query = `SELECT * FROM memories
     WHERE deleted_at IS NULL
       AND status IS NOT NULL`;
  const binds: unknown[] = [];
  if (!opts.includeCancelled) {
    query += ` AND status != 'cancelled'`;
  }
  if (!opts.includeCompleted) {
    query += ` AND status != 'completed' AND completed_on IS NULL`;
  }
  if (opts.projectId !== undefined) {
    query += ` AND project_id = ?`;
    binds.push(opts.projectId);
  }
  query += ` ORDER BY
       CASE WHEN action_date IS NULL THEN 1 ELSE 0 END,
       action_date ASC,
       COALESCE(priority, 0) DESC
     LIMIT ?`;
  binds.push(limit);
  const { results } = await db.prepare(query).bind(...binds).all();
  return results.map((r) => rowToRecord(r as Record<string, unknown>));
}

/** Return N most recently updated memories, excluding completed and cancelled.
 *  Used by orient. */
export async function getRecentActiveMemories(
  db: D1Database,
  maxResults: number,
): Promise<MemoryRecord[]> {
  const { results } = await db.prepare(
    `SELECT * FROM memories
     WHERE deleted_at IS NULL
       AND completed_on IS NULL
       AND (status IS NULL OR status = 'open')
     ORDER BY updated_at DESC
     LIMIT ?`,
  ).bind(maxResults).all();
  return results.map((r) => rowToRecord(r as Record<string, unknown>));
}

// ── Project reads ─────────────────────────────────────────────────────────────

/** Return all active projects ordered by name. When includeArchived is false (default), excludes archived projects. */
export async function getAllProjects(db: D1Database, includeArchived = false): Promise<ProjectRecord[]> {
  const archiveClause = includeArchived ? '' : ' AND archived_at IS NULL';
  const { results } = await db.prepare(
    `SELECT * FROM projects WHERE deleted_at IS NULL${archiveClause} ORDER BY name COLLATE NOCASE`,
  ).all();
  return results.map((r) => rowToProject(r as Record<string, unknown>));
}

/** Get a single project by id. Returns null if not found or deleted. */
export async function getProjectById(db: D1Database, id: number): Promise<ProjectRecord | null> {
  const row = await db.prepare(
    `SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL`,
  ).bind(id).first();
  return row ? rowToProject(row as Record<string, unknown>) : null;
}

/** Get a project by name (case-insensitive). Returns null if not found.
 *  When opts.archived is true, searches only archived projects. */
export async function getProjectByName(db: D1Database, name: string, opts?: { archived?: boolean }): Promise<ProjectRecord | null> {
  const archiveClause = opts?.archived ? ' AND archived_at IS NOT NULL' : '';
  const row = await db.prepare(
    `SELECT * FROM projects WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL${archiveClause}`,
  ).bind(name).first();
  return row ? rowToProject(row as Record<string, unknown>) : null;
}

/** Return per-project task counts (open, completed, total) for all active projects.
 *  When includeArchived is true, includes archived projects (marked in output). */
export async function getProjectTaskCounts(db: D1Database, includeArchived = false): Promise<ProjectWithCounts[]> {
  const archiveClause = includeArchived ? '' : ' AND p.archived_at IS NULL';
  const { results } = await db.prepare(`
    SELECT
      p.*,
      COALESCE(SUM(CASE WHEN m.status IN ('open', 'in_progress', 'blocked') THEN 1 ELSE 0 END), 0) AS open_count,
      COALESCE(SUM(CASE WHEN m.status = 'completed' OR m.completed_on IS NOT NULL THEN 1 ELSE 0 END), 0) AS completed_count,
      COALESCE(COUNT(m.id), 0) AS total_count
    FROM projects p
    LEFT JOIN memories m ON m.project_id = p.id AND m.deleted_at IS NULL AND m.status IS NOT NULL
    WHERE p.deleted_at IS NULL${archiveClause}
    GROUP BY p.id
    ORDER BY p.name COLLATE NOCASE
  `).all();
  return results.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      ...rowToProject(row),
      openCount: (row.open_count as number) ?? 0,
      completedCount: (row.completed_count as number) ?? 0,
      totalCount: (row.total_count as number) ?? 0,
    };
  });
}
