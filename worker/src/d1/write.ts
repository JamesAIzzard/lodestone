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
  recurrence: string | null = null,
  priority: MemoryRecord['priority'] = null,
  status: MemoryRecord['status'] = null,
  completedOn: string | null = null,
  vectorize?: Vectorize,
  embedding?: number[],
): Promise<number> {
  // Insert the memory row first to get its ID
  const result = await db.prepare(
    `INSERT INTO memories (topic, body, confidence, context_hint, action_date, recurrence, priority, status, completed_on)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(topic, body, confidence, contextHint, actionDate, recurrence, priority, status, completedOn).run();

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
    recurrence?: string | null;
    priority?: MemoryRecord['priority'];
    topic?: string;
    status?: MemoryRecord['status'];
    completedOn?: string | null;
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
