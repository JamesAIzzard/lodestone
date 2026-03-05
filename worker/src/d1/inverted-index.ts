/**
 * D1 memory inverted index — BM25 scoring support (async).
 *
 * Maintains a hand-rolled inverted index (memory_terms + memory_postings)
 * for keyword-based BM25 scoring alongside (future) semantic similarity.
 *
 * Key D1 differences from desktop:
 *   - All operations are async
 *   - Uses db.batch() to group multiple writes atomically
 *   - Uses ON CONFLICT ... DO UPDATE instead of INSERT OR REPLACE for compound keys
 */

import { tokenise } from '../tokeniser';

/**
 * Add a memory's body text to the inverted index.
 * Tokenises the text, computes term frequencies, upserts into postings/terms,
 * and updates the memory's token_count.
 *
 * Uses db.batch() to execute all statements in a single round-trip.
 */
export async function addToInvertedIndex(db: D1Database, memoryId: number, body: string): Promise<void> {
  const tokens = tokenise(body);

  const termFreqs = new Map<string, number>();
  for (const token of tokens) {
    termFreqs.set(token, (termFreqs.get(token) ?? 0) + 1);
  }

  // Build all statements for batch execution
  const stmts: D1PreparedStatement[] = [
    db.prepare(`UPDATE memories SET token_count = ? WHERE id = ?`).bind(tokens.length, memoryId),
  ];

  for (const [term, freq] of termFreqs) {
    // Upsert term: increment doc_freq if already exists
    stmts.push(
      db.prepare(
        `INSERT INTO memory_terms (term, doc_freq) VALUES (?, 1)
         ON CONFLICT(term) DO UPDATE SET doc_freq = doc_freq + 1`,
      ).bind(term),
    );
    // Upsert posting: replace term_freq if already exists
    stmts.push(
      db.prepare(
        `INSERT INTO memory_postings (term, memory_id, term_freq) VALUES (?, ?, ?)
         ON CONFLICT(term, memory_id) DO UPDATE SET term_freq = excluded.term_freq`,
      ).bind(term, memoryId, freq),
    );
  }

  await db.batch(stmts);
}

/**
 * Remove a memory from the inverted index.
 * Decrements doc_freq in memory_terms and deletes terms that reach 0.
 */
export async function removeFromInvertedIndex(db: D1Database, memoryId: number): Promise<void> {
  // First, get the affected terms
  const { results: affectedTerms } = await db.prepare(
    `SELECT DISTINCT term FROM memory_postings WHERE memory_id = ?`,
  ).bind(memoryId).all();

  if (affectedTerms.length === 0) return;

  // Delete all postings for this memory
  const stmts: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM memory_postings WHERE memory_id = ?`).bind(memoryId),
  ];

  // For each affected term: we need to check if it still has postings.
  // Since we're deleting in the same batch, we can't read-after-write.
  // Instead, decrement doc_freq and clean up zero-freq terms after.
  for (const row of affectedTerms) {
    const term = (row as Record<string, unknown>).term as string;
    stmts.push(
      db.prepare(`UPDATE memory_terms SET doc_freq = doc_freq - 1 WHERE term = ?`).bind(term),
    );
  }

  await db.batch(stmts);

  // Clean up terms with doc_freq <= 0
  await db.prepare(`DELETE FROM memory_terms WHERE doc_freq <= 0`).run();
}

/**
 * Recompute corpus-level BM25 statistics and store in memory_metadata.
 */
export async function updateMemoryCorpusStats(db: D1Database): Promise<void> {
  const stats = await db.prepare(
    `SELECT COUNT(*) AS cnt, COALESCE(AVG(token_count), 0) AS avg_tc FROM memories WHERE deleted_at IS NULL`,
  ).first() as { cnt: number; avg_tc: number } | null;

  if (!stats) return;

  await db.batch([
    db.prepare(
      `INSERT INTO memory_metadata (key, value) VALUES ('corpus_memory_count', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).bind(String(stats.cnt)),
    db.prepare(
      `INSERT INTO memory_metadata (key, value) VALUES ('corpus_avg_token_count', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).bind(String(stats.avg_tc)),
  ]);
}
