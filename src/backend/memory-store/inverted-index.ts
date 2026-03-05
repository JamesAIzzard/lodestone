/**
 * Memory store inverted index — BM25 scoring support.
 *
 * Maintains a hand-rolled inverted index (memory_terms + memory_postings)
 * that mirrors the silo store pattern. Used by the search pipeline for
 * keyword-based scoring alongside semantic similarity.
 */

import { tokenise } from '../tokeniser';
import type { MemoryDatabase } from './helpers';

/**
 * Add a memory's body text to the inverted index.
 * Tokenises the text, computes term frequencies, upserts into postings/terms,
 * and updates the memory's token_count.
 */
export function addToInvertedIndex(db: MemoryDatabase, memoryId: number, body: string): void {
  const tokens = tokenise(body);

  db.prepare(`UPDATE memories SET token_count = ? WHERE id = ?`).run(tokens.length, memoryId);

  const termFreqs = new Map<string, number>();
  for (const token of tokens) {
    termFreqs.set(token, (termFreqs.get(token) ?? 0) + 1);
  }

  const upsertTerm = db.prepare(
    `INSERT INTO memory_terms (term, doc_freq) VALUES (?, 1)
     ON CONFLICT(term) DO UPDATE SET doc_freq = doc_freq + 1`,
  );
  const insertPosting = db.prepare(
    `INSERT OR REPLACE INTO memory_postings (term, memory_id, term_freq) VALUES (?, ?, ?)`,
  );

  for (const [term, freq] of termFreqs) {
    upsertTerm.run(term);
    insertPosting.run(term, memoryId, freq);
  }
}

/**
 * Remove a memory from the inverted index.
 * Decrements doc_freq in memory_terms and deletes terms that reach 0.
 */
export function removeFromInvertedIndex(db: MemoryDatabase, memoryId: number): void {
  const affectedTerms = db.prepare(
    `SELECT DISTINCT term FROM memory_postings WHERE memory_id = ?`,
  ).all(memoryId) as Array<{ term: string }>;

  db.prepare(`DELETE FROM memory_postings WHERE memory_id = ?`).run(memoryId);

  for (const { term } of affectedTerms) {
    const remaining = db.prepare(
      `SELECT COUNT(*) as cnt FROM memory_postings WHERE term = ?`,
    ).get(term) as { cnt: number };

    if (remaining.cnt === 0) {
      db.prepare(`DELETE FROM memory_terms WHERE term = ?`).run(term);
    } else {
      db.prepare(`UPDATE memory_terms SET doc_freq = ? WHERE term = ?`).run(remaining.cnt, term);
    }
  }
}

/**
 * Recompute corpus-level BM25 statistics and store in memory_metadata.
 */
export function updateMemoryCorpusStats(db: MemoryDatabase): void {
  const stats = db.prepare(
    `SELECT COUNT(*) AS cnt, COALESCE(AVG(token_count), 0) AS avg_tc FROM memories WHERE deleted_at IS NULL`,
  ).get() as { cnt: number; avg_tc: number };

  const upsert = db.prepare(
    `INSERT OR REPLACE INTO memory_metadata (key, value) VALUES (?, ?)`,
  );
  upsert.run('corpus_memory_count', String(stats.cnt));
  upsert.run('corpus_avg_token_count', String(stats.avg_tc));
}

/**
 * Backfill inverted index for existing memories that predate this schema.
 * Runs inside a single transaction for efficiency.
 */
export function backfillInvertedIndex(db: MemoryDatabase): void {
  const allMemories = db.prepare(`SELECT id, body FROM memories`).all() as Array<{ id: number; body: string }>;

  db.transaction(() => {
    for (const mem of allMemories) {
      addToInvertedIndex(db, mem.id, mem.body);
    }
    updateMemoryCorpusStats(db);
  })();
}
