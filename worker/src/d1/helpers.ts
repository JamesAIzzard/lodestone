/**
 * D1 memory store helpers — row conversion utilities.
 *
 * Slimmed-down version of src/backend/memory-store/helpers.ts:
 *   - No float32Buffer (no vec operations in Phase 1)
 *   - No getMemoryDatabaseSizeBytes (no filesystem in Worker)
 */

import type { MemoryRecord, ProjectRecord } from '../shared/types';

/** Convert a raw D1 row to a typed MemoryRecord. */
export function rowToRecord(row: Record<string, unknown>): MemoryRecord {
  return {
    id: row.id as number,
    topic: row.topic as string,
    body: row.body as string,
    confidence: row.confidence as number,
    contextHint: (row.context_hint as string | null) ?? null,
    actionDate: (row.action_date as string | null) ?? null,
    dueDate: (row.due_date as string | null) ?? null,
    recurrence: (row.recurrence as string | null) ?? null,
    priority: (row.priority as MemoryRecord['priority']) ?? null,
    status: (row.status as MemoryRecord['status']) ?? null,
    completedOn: (row.completed_on as string | null) ?? null,
    projectId: (row.project_id as number | null) ?? null,
    dayOrderPosition: (row.day_order_position as number | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
    deletionReason: (row.deletion_reason as string | null) ?? null,
  };
}

/** Convert a raw D1 row to a typed ProjectRecord. */
export function rowToProject(row: Record<string, unknown>): ProjectRecord {
  return {
    id: row.id as number,
    name: row.name as string,
    color: row.color as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
    archivedAt: (row.archived_at as string | null) ?? null,
  };
}
