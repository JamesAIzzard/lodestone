/**
 * Memory store helpers — shared utilities used across memory-store modules.
 */

import type Database from 'better-sqlite3';
import fs from 'node:fs';
import type { MemoryRecord } from '../../shared/types';

export type MemoryDatabase = Database.Database;

/** Pack a float[] into a Float32Array buffer for sqlite-vec. */
export function float32Buffer(values: number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer);
}

/** Convert a raw DB row to a typed MemoryRecord. */
export function rowToRecord(row: Record<string, unknown>): MemoryRecord {
  return {
    id: row.id as number,
    topic: row.topic as string,
    body: row.body as string,
    confidence: row.confidence as number,
    contextHint: (row.context_hint as string | null) ?? null,
    actionDate: (row.action_date as string | null) ?? null,
    recurrence: (row.recurrence as string | null) ?? null,
    priority: (row.priority as MemoryRecord['priority']) ?? null,
    status: (row.status as MemoryRecord['status']) ?? null,
    completedOn: (row.completed_on as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
    deletionReason: (row.deletion_reason as string | null) ?? null,
  };
}

/** Return the size of the database file in bytes. Returns 0 if file not found. */
export function getMemoryDatabaseSizeBytes(dbPath: string): number {
  try {
    return fs.statSync(dbPath).size;
  } catch {
    return 0;
  }
}
