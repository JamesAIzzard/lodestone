/**
 * D1 memory store write operations — async equivalents of memory-store/write.ts.
 *
 * Key differences from the desktop version:
 *   - Vectorize for embedding storage (not sqlite-vec)
 *   - Uses db.batch() for implicit transactions instead of .transaction()
 *   - All operations are async
 */

import type { MemoryRecord } from '../shared/types';
import { addToInvertedIndex, removeFromInvertedIndex, updateMemoryCorpusStats } from './inverted-index';

/**
 * Insert a new memory record, sync the inverted index, and optionally
 * upsert the embedding vector into Vectorize.
 * Returns the new row's id.
 */
export async function insertMemory(
  db: D1Database,
  topic: string,
  body: string,
  confidence: number,
  contextHint: string | null,
  actionDate: string | null = null,
  dueDate: string | null = null,
  recurrence: string | null = null,
  priority: MemoryRecord['priority'] = null,
  status: MemoryRecord['status'] = null,
  completedOn: string | null = null,
  projectId: number | null = null,
  vectorize?: Vectorize,
  embedding?: number[],
): Promise<number> {
  // Insert the memory row first to get its ID
  const result = await db.prepare(
    `INSERT INTO memories (topic, body, confidence, context_hint, action_date, due_date, recurrence, priority, status, completed_on, project_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(topic, body, confidence, contextHint, actionDate, dueDate, recurrence, priority, status, completedOn, projectId).run();

  const id = result.meta.last_row_id as number;

  // Build inverted index — must happen after we have the id
  await addToInvertedIndex(db, id, body);
  await updateMemoryCorpusStats(db);

  // Upsert embedding into Vectorize
  if (vectorize && embedding) {
    try {
      await vectorize.upsert([{ id: String(id), values: embedding }]);
    } catch (e) {
      // Log but don't fail — Vectorize upsert is best-effort
      console.error(`Vectorize upsert failed for m${id}:`, (e as Error).message);
    }
  }

  return id;
}

/**
 * Update an existing memory by id. Only supplied fields are changed.
 * If body changes, re-syncs the inverted index and optionally re-embeds.
 */
export async function updateMemory(
  db: D1Database,
  id: number,
  updates: {
    body?: string;
    confidence?: number;
    contextHint?: string | null;
    actionDate?: string | null;
    dueDate?: string | null;
    recurrence?: string | null;
    priority?: MemoryRecord['priority'];
    topic?: string;
    status?: MemoryRecord['status'];
    completedOn?: string | null;
    projectId?: number | null;
  },
  vectorize?: Vectorize,
  embedding?: number[],
): Promise<void> {
  const sets: string[] = [`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`];
  const vals: unknown[] = [];

  if (updates.body !== undefined) {
    sets.push('body = ?');
    vals.push(updates.body);
  }
  if (updates.confidence !== undefined) {
    sets.push('confidence = ?');
    vals.push(updates.confidence);
  }
  if (updates.contextHint !== undefined) {
    sets.push('context_hint = ?');
    vals.push(updates.contextHint);
  }
  if (updates.actionDate !== undefined) {
    sets.push('action_date = ?');
    vals.push(updates.actionDate);
  }
  if (updates.dueDate !== undefined) {
    sets.push('due_date = ?');
    vals.push(updates.dueDate);
  }
  if (updates.recurrence !== undefined) {
    sets.push('recurrence = ?');
    vals.push(updates.recurrence);
  }
  if (updates.priority !== undefined) {
    sets.push('priority = ?');
    vals.push(updates.priority);
  }
  if (updates.topic !== undefined) {
    sets.push('topic = ?');
    vals.push(updates.topic);
  }
  if (updates.status !== undefined) {
    sets.push('status = ?');
    vals.push(updates.status);
  }
  if (updates.completedOn !== undefined) {
    sets.push('completed_on = ?');
    vals.push(updates.completedOn);
  }
  if (updates.projectId !== undefined) {
    sets.push('project_id = ?');
    vals.push(updates.projectId);
  }

  vals.push(id);
  await db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();

  // Re-sync inverted index if body changed
  if (updates.body !== undefined) {
    await removeFromInvertedIndex(db, id);
    await addToInvertedIndex(db, id, updates.body);
    await updateMemoryCorpusStats(db);
  }

  // Re-sync embedding if provided
  if (vectorize && embedding) {
    await vectorize.upsert([{ id: String(id), values: embedding }]);
  }
}

/**
 * Soft-delete a memory by id. Sets deleted_at to the current timestamp and
 * stores an optional reason. Removes from both inverted index and Vectorize.
 */
export async function deleteMemory(db: D1Database, id: number, reason?: string, vectorize?: Vectorize): Promise<void> {
  const now = new Date().toISOString();

  // Batch the soft-delete and inverted index cleanup
  await db.prepare(
    `UPDATE memories SET deleted_at = ?, deletion_reason = ? WHERE id = ?`,
  ).bind(now, reason ?? null, id).run();

  await removeFromInvertedIndex(db, id);
  await updateMemoryCorpusStats(db);

  // Remove embedding from Vectorize
  if (vectorize) {
    await vectorize.deleteByIds([String(id)]);
  }
}

// ── Project writes ────────────────────────────────────────────────────────────

/** Create a new project. Returns the new project's id. */
export async function insertProject(db: D1Database, name: string, color: string = 'blue'): Promise<number> {
  const result = await db.prepare(
    `INSERT INTO projects (name, color) VALUES (?, ?)`,
  ).bind(name, color).run();
  return result.meta.last_row_id as number;
}

/** Update a project's name and/or color. */
export async function updateProject(
  db: D1Database,
  id: number,
  updates: { name?: string; color?: string },
): Promise<void> {
  const sets: string[] = [`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`];
  const vals: unknown[] = [];

  if (updates.name !== undefined) {
    sets.push('name = ?');
    vals.push(updates.name);
  }
  if (updates.color !== undefined) {
    sets.push('color = ?');
    vals.push(updates.color);
  }

  vals.push(id);
  await db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
}

/**
 * Soft-delete a project. Unassigns all memories from this project
 * (sets project_id = NULL) and marks the project as deleted.
 */
export async function deleteProject(db: D1Database, id: number): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE memories SET project_id = NULL WHERE project_id = ?`).bind(id),
    db.prepare(`UPDATE projects SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).bind(id),
  ]);
}

/**
 * Merge source project into target: reassign all memories, then soft-delete source.
 * Returns the number of memories reassigned.
 */
export async function mergeProjects(db: D1Database, sourceId: number, targetId: number): Promise<number> {
  // Count affected memories first
  const countRow = await db.prepare(
    `SELECT COUNT(*) as cnt FROM memories WHERE project_id = ? AND deleted_at IS NULL`,
  ).bind(sourceId).first();
  const count = (countRow as Record<string, unknown>)?.cnt as number ?? 0;

  await db.batch([
    db.prepare(`UPDATE memories SET project_id = ? WHERE project_id = ?`).bind(targetId, sourceId),
    db.prepare(`UPDATE projects SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).bind(sourceId),
  ]);

  return count;
}
