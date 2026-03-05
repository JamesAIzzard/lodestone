/**
 * Memory store read operations — queries and filters.
 */

import type { MemoryRecord } from '../../shared/types';
import type { MemoryDatabase } from './helpers';
import { rowToRecord } from './helpers';

/** Get a single memory record by id. Returns null if not found. */
export function getMemory(db: MemoryDatabase, id: number): MemoryRecord | null {
  const row = db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToRecord(row) : null;
}

/** Count active (non-deleted) memories. */
export function getMemoryCount(db: MemoryDatabase): number {
  const row = db.prepare(`SELECT COUNT(*) as cnt FROM memories WHERE deleted_at IS NULL`).get() as { cnt: number };
  return row.cnt;
}

/** Return N most recently updated active memories. */
export function getRecentMemories(db: MemoryDatabase, maxResults: number): MemoryRecord[] {
  const rows = db.prepare(
    `SELECT * FROM memories WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?`,
  ).all(maxResults) as Record<string, unknown>[];
  return rows.map(rowToRecord);
}

/**
 * Return memories with action_date in the given range, ordered by action_date ASC.
 * Used by orient to surface upcoming deadlines.
 */
export function getMemoriesByActionDateRange(
  db: MemoryDatabase,
  fromDate: string,
  toDate: string,
  maxResults: number,
): MemoryRecord[] {
  const rows = db.prepare(
    `SELECT * FROM memories
     WHERE deleted_at IS NULL
       AND action_date IS NOT NULL
       AND action_date >= ?
       AND action_date <= ?
     ORDER BY action_date ASC
     LIMIT ?`,
  ).all(fromDate, toDate, maxResults) as Record<string, unknown>[];
  return rows.map(rowToRecord);
}

/**
 * Return the set of memory IDs that match the given date-range filters.
 * Used to pre-filter candidates before the search pipeline runs.
 * Returns null if no date filters are active (meaning "no restriction").
 */
export function filterMemoryIdsByDate(
  db: MemoryDatabase,
  filters: {
    updatedAfter?: string;
    updatedBefore?: string;
    actionAfter?: string;
    actionBefore?: string;
    completedAfter?: string;
    completedBefore?: string;
    status?: MemoryRecord['status'];
  },
): Set<number> | null {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters.updatedAfter) {
    clauses.push(`updated_at >= ?`);
    params.push(filters.updatedAfter);
  }
  if (filters.updatedBefore) {
    // Add a day to make the comparison inclusive for date-only values
    // since updated_at is a datetime like "2026-02-26 15:30:00"
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
  const rows = db.prepare(sql).all(...params) as Array<{ id: number }>;
  return new Set(rows.map(r => r.id));
}

/** Return memories with action_date before today that are not completed or cancelled.
 *  Used by agenda to surface overdue items. */
export function getOverdueMemories(
  db: MemoryDatabase,
  beforeDate: string,
  maxResults: number,
): MemoryRecord[] {
  const rows = db.prepare(
    `SELECT * FROM memories
     WHERE deleted_at IS NULL
       AND action_date IS NOT NULL
       AND action_date < ?
       AND completed_on IS NULL
       AND (status IS NULL OR status = 'open')
     ORDER BY COALESCE(priority, 0) DESC, action_date ASC
     LIMIT ?`,
  ).all(beforeDate, maxResults) as Record<string, unknown>[];
  return rows.map(rowToRecord);
}

/** Return upcoming memories (action_date in range) excluding completed and cancelled.
 *  Used by agenda and orient. */
export function getActiveUpcomingMemories(
  db: MemoryDatabase,
  fromDate: string,
  toDate: string,
  maxResults: number,
): MemoryRecord[] {
  const rows = db.prepare(
    `SELECT * FROM memories
     WHERE deleted_at IS NULL
       AND action_date IS NOT NULL
       AND action_date >= ?
       AND action_date <= ?
       AND completed_on IS NULL
       AND (status IS NULL OR status = 'open')
     ORDER BY action_date ASC
     LIMIT ?`,
  ).all(fromDate, toDate, maxResults) as Record<string, unknown>[];
  return rows.map(rowToRecord);
}

/** Return N most recently updated memories, excluding completed and cancelled.
 *  Used by orient. */
export function getRecentActiveMemories(
  db: MemoryDatabase,
  maxResults: number,
): MemoryRecord[] {
  const rows = db.prepare(
    `SELECT * FROM memories
     WHERE deleted_at IS NULL
       AND completed_on IS NULL
       AND (status IS NULL OR status = 'open')
     ORDER BY updated_at DESC
     LIMIT ?`,
  ).all(maxResults) as Record<string, unknown>[];
  return rows.map(rowToRecord);
}
