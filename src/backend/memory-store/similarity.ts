/**
 * Memory store similarity — dedup check and related memory hints.
 *
 * sqlite-vec dependent: these functions use the vec0 virtual table for
 * cosine similarity search. In the Worker migration (Phase 3), these
 * operations will be replaced by Vectorize queries.
 */

import type { MemoryRecord, RelatedMemoryResult } from '../../shared/types';
import type { MemoryDatabase } from './helpers';
import { float32Buffer, rowToRecord } from './helpers';
import { getMemoryCount } from './read';

/** Cosine similarity threshold for dedup check in lodestone_remember. */
export const DEDUP_THRESHOLD = 0.80;

/** Equivalent vec0 distance upper bound for DEDUP_THRESHOLD.
 *  vec0 stores cosine distance where cosine_sim = 1 - distance/2. */
const DEDUP_MAX_DISTANCE = 2 * (1 - DEDUP_THRESHOLD); // 0.40

/** Result of a dedup similarity check. */
export interface SimilarMemoryResult {
  record: MemoryRecord;
  /** Cosine similarity in [0, 1] (1 = identical). */
  similarity: number;
}

/**
 * Find an existing memory that is closely similar to the given embedding.
 * Uses vec0 cosine distance — returns the closest match with similarity
 * score if it is within DEDUP_THRESHOLD, otherwise null.
 */
export function findSimilarMemory(
  db: MemoryDatabase,
  embedding: number[],
): SimilarMemoryResult | null {
  const count = getMemoryCount(db);
  if (count === 0) return null;

  const vecRow = db.prepare(`
    SELECT rowid, distance
    FROM memories_vec
    WHERE embedding MATCH ?
      AND k = 1
  `).get(float32Buffer(embedding)) as { rowid: number; distance: number } | undefined;

  if (!vecRow || vecRow.distance > DEDUP_MAX_DISTANCE) return null;

  // Join back to active memories via vec_rowid (not id — they differ after embedding updates).
  // Soft-deleted memories are excluded so dedup never surfaces a deleted entry.
  const memRow = db.prepare(`SELECT * FROM memories WHERE vec_rowid = ? AND deleted_at IS NULL`).get(vecRow.rowid) as Record<string, unknown> | undefined;
  if (!memRow) return null;

  // Convert vec0 cosine distance to similarity: sim = 1 - distance/2
  const similarity = 1 - vecRow.distance / 2;
  return { record: rowToRecord(memRow), similarity };
}

/**
 * Find the top-N most similar active memories to a given memory, by cosine
 * similarity. Uses the stored vec0 embedding directly — no re-embedding needed.
 * Excludes the source memory itself and any soft-deleted memories.
 */
export function findRelatedMemories(
  db: MemoryDatabase,
  memoryId: number,
  topN = 5,
): RelatedMemoryResult[] {
  // Get the vec_rowid for this memory
  const mem = db.prepare(
    `SELECT vec_rowid FROM memories WHERE id = ?`,
  ).get(memoryId) as { vec_rowid: number | null } | undefined;
  if (!mem?.vec_rowid) return [];

  // Fetch the stored embedding blob from vec0 (direct rowid lookup)
  const vecRow = db.prepare(
    `SELECT embedding FROM memories_vec WHERE rowid = ?`,
  ).get(mem.vec_rowid) as { embedding: Buffer } | undefined;
  if (!vecRow) return [];

  // KNN search — fetch topN + 1 to have room to exclude self
  let candidates: Array<{ rowid: number; distance: number }>;
  try {
    candidates = db.prepare(`
      SELECT rowid, distance
      FROM memories_vec
      WHERE embedding MATCH ?
        AND k = ?
    `).all(vecRow.embedding, topN + 1) as Array<{ rowid: number; distance: number }>;
  } catch {
    return []; // vec0 may fail if table is near-empty
  }

  if (candidates.length === 0) return [];

  // Map vec_rowids → active memory records, excluding self
  const vecRowids = candidates.map(r => r.rowid);
  const ph = vecRowids.map(() => '?').join(', ');
  const mappings = db.prepare(
    `SELECT id, vec_rowid, topic FROM memories WHERE vec_rowid IN (${ph}) AND deleted_at IS NULL AND id != ?`,
  ).all(...vecRowids, memoryId) as Array<{ id: number; vec_rowid: number; topic: string }>;

  if (mappings.length === 0) return [];

  const distMap = new Map(candidates.map(r => [r.rowid, r.distance]));
  return mappings
    .map(m => ({
      id: m.id,
      topic: m.topic,
      similarity: 1 - (distMap.get(m.vec_rowid) ?? 2) / 2,
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topN);
}
