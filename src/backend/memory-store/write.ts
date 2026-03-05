/**
 * Memory store write operations — insert, update, soft-delete.
 */

import type { MemoryRecord } from '../../shared/types';
import type { MemoryDatabase } from './helpers';
import { float32Buffer } from './helpers';
import { addToInvertedIndex, removeFromInvertedIndex, updateMemoryCorpusStats } from './inverted-index';

/**
 * Insert a new memory record and sync FTS + vec tables.
 * Returns the new row's id.
 */
export function insertMemory(
  db: MemoryDatabase,
  topic: string,
  body: string,
  confidence: number,
  contextHint: string | null,
  embedding: number[],
  actionDate: string | null = null,
  recurrence: string | null = null,
  priority: MemoryRecord['priority'] = null,
  status: MemoryRecord['status'] = null,
  completedOn: string | null = null,
): number {
  const result = db.transaction(() => {
    // Insert into vec0 first — it auto-assigns a rowid. Store that rowid in
    // memories.vec_rowid so we can re-sync the vec entry on future updates.
    // (vec0 rejects explicit rowid inserts — same pattern as store.ts / vec_chunks.)
    const vecResult = db.prepare(
      `INSERT INTO memories_vec(embedding) VALUES (?)`,
    ).run(float32Buffer(embedding));
    const vecRowid = Number(vecResult.lastInsertRowid);

    // Insert into main table; id is auto-assigned by AUTOINCREMENT.
    const memResult = db.prepare(
      `INSERT INTO memories (vec_rowid, topic, body, confidence, context_hint, action_date, recurrence, priority, status, completed_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(vecRowid, topic, body, confidence, contextHint, actionDate, recurrence, priority, status, completedOn);
    const id = Number(memResult.lastInsertRowid);

    // Build inverted index for BM25 scoring
    addToInvertedIndex(db, id, body);
    updateMemoryCorpusStats(db);

    return id;
  })();

  return result as number;
}

/**
 * Update an existing memory by id. Only supplied fields are changed.
 * If body changes, re-syncs FTS. If embedding is supplied, re-syncs vec.
 */
export function updateMemory(
  db: MemoryDatabase,
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
  embedding?: number[],
): void {
  db.transaction(() => {
    const sets: string[] = ['updated_at = datetime(\'now\')'];
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
    db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

    // Re-sync inverted index if body changed
    if (updates.body !== undefined) {
      removeFromInvertedIndex(db, id);
      addToInvertedIndex(db, id, updates.body);
      updateMemoryCorpusStats(db);
    }

    // Re-sync vec if embedding provided: delete old vec row, insert new one,
    // then update the vec_rowid pointer in memories.
    if (embedding !== undefined) {
      const memRow = db.prepare(`SELECT vec_rowid FROM memories WHERE id = ?`).get(id) as { vec_rowid: number | null } | undefined;
      if (memRow?.vec_rowid != null) {
        db.prepare(`DELETE FROM memories_vec WHERE rowid = ?`).run(memRow.vec_rowid);
      }
      const vecResult = db.prepare(`INSERT INTO memories_vec(embedding) VALUES (?)`).run(float32Buffer(embedding));
      const newVecRowid = Number(vecResult.lastInsertRowid);
      db.prepare(`UPDATE memories SET vec_rowid = ? WHERE id = ?`).run(newVecRowid, id);
    }
  })();
}

/**
 * Soft-delete a memory by id. Sets deleted_at to the current timestamp and
 * stores an optional reason. Removes the memory from the inverted index so
 * BM25 corpus stats stay accurate. The vec0 entry is retained (the join-back
 * query filters by deleted_at IS NULL, so it is never surfaced).
 */
export function deleteMemory(db: MemoryDatabase, id: number, reason?: string): void {
  db.transaction(() => {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE memories SET deleted_at = ?, deletion_reason = ? WHERE id = ?`,
    ).run(now, reason ?? null, id);
    removeFromInvertedIndex(db, id);
    updateMemoryCorpusStats(db);
  })();
}
