/**
 * D1 memory store read operations — async equivalents of memory-store/read.ts.
 *
 * All functions take a D1Database and return Promises.
 * D1 quirk: `.all()` returns `{ results: Row[] }`, not a bare array.
 */

import type { MemoryRecord } from '../shared/types';
import { rowToRecord } from './helpers';

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
    status?: MemoryRecord['status'];
  },
): Promise<Set<number> | null> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters.updatedAfter) {
    clauses.push(`updated_at >= ?`);
    params.push(filters.updatedAfter);
  }
  if (filters.updatedBefore) {
    // Add a day to make the comparison inclusive for date-only values
    // since updated_at is a datetime like "2026-02-26T15:30:00.000Z"
    clauses.push(`updated_at <= ? || ' 23:59:59'`);
    params.push(filters.updatedBefore);
  }
  if (filters.actionAfter) {
    clauses.push(`action_date IS NOT NULL AND action_date >= ?`);
    params.push(filters.actionAfter);
  }
  if (filters.actionBefore) {
    clauses.push(`action_date IS NOT NULL AND action_date <= ?`);
    params.push(filters.actionBefore);
  }
  if (filters.completedAfter) {
    clauses.push(`completed_on IS NOT NULL AND completed_on >= ?`);
    params.push(filters.completedAfter);
  }
  if (filters.completedBefore) {
    clauses.push(`completed_on IS NOT NULL AND completed_on <= ?`);
    params.push(filters.completedBefore);
  }
  if (filters.status !== undefined) {
    if (filters.status === 'completed') {
      clauses.push(`(status = 'completed' OR completed_on IS NOT NULL)`);
    } else if (filters.status === null) {
      clauses.push(`(status IS NULL AND completed_on IS NULL)`);
    } else {
      clauses.push(`status = ?`);
      params.push(filters.status);
    }
  }

  if (clauses.length === 0) return null; // no filters active

  const sql = `SELECT id FROM memories WHERE deleted_at IS NULL AND ${clauses.join(' AND ')}`;

  // D1 doesn't support spread args like better-sqlite3 — we chain .bind() with all params
  let stmt = db.prepare(sql);
  if (params.length > 0) {
    stmt = stmt.bind(...params);
  }

  const { results } = await stmt.all();
  return new Set(results.map((r) => (r as Record<string, unknown>).id as number));
}

/** Return memories with action_date before today that are not completed or cancelled.
 *  Used by agenda to surface overdue items. */
export async function getOverdueMemories(
  db: D1Database,
  beforeDate: string,
  maxResults: number,
): Promise<MemoryRecord[]> {
  const { results } = await db.prepare(
    `SELECT * FROM memories
     WHERE deleted_at IS NULL
       AND action_date IS NOT NULL
       AND action_date < ?
       AND completed_on IS NULL
       AND (status IS NULL OR status = 'open')
     ORDER BY COALESCE(priority, 0) DESC, action_date ASC
     LIMIT ?`,
  ).bind(beforeDate, maxResults).all();
  return results.map((r) => rowToRecord(r as Record<string, unknown>));
}

/** Return upcoming memories (action_date in range) excluding completed and cancelled.
 *  Used by agenda and orient. */
export async function getActiveUpcomingMemories(
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
       AND completed_on IS NULL
       AND (status IS NULL OR status = 'open')
     ORDER BY action_date ASC
     LIMIT ?`,
  ).bind(fromDate, toDate, maxResults).all();
  return results.map((r) => rowToRecord(r as Record<string, unknown>));
}

/** Return all non-deleted tasks ordered by action_date ASC (nulls last),
 *  then priority DESC. Used by the Tasks GUI.
 *  Only includes memories that have an explicit status (excludes pure knowledge memories). */
export async function getAllTasks(
  db: D1Database,
  opts: { includeCompleted: boolean; includeCancelled: boolean },
  limit: number,
): Promise<MemoryRecord[]> {
  let query = `SELECT * FROM memories
     WHERE deleted_at IS NULL
       AND status IS NOT NULL`;
  if (!opts.includeCancelled) {
    query += ` AND status != 'cancelled'`;
  }
  if (!opts.includeCompleted) {
    query += ` AND status != 'completed' AND completed_on IS NULL`;
  }
  query += ` ORDER BY
       CASE WHEN action_date IS NULL THEN 1 ELSE 0 END,
       action_date ASC,
       COALESCE(priority, 0) DESC
     LIMIT ?`;
  const { results } = await db.prepare(query).bind(limit).all();
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
