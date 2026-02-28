/**
 * Hand-rolled BM25 scorer operating on the inverted index tables.
 *
 * Uses the classic BM25 formula with normalisation to [0,1]:
 *   BM25_norm = BM25_raw / S_max
 * where S_max = sum(IDF(t) * (k1 + 1)) for all query terms.
 *
 * This guarantees a perfect full-text match scores 1.0 and partial matches
 * score proportionally, making scores directly comparable to cosine similarity.
 *
 * Tables used (V2 schema):
 *   - terms(id, term, doc_freq)
 *   - postings(term_id, chunk_id, term_freq)
 *   - chunks(id, token_count)
 *   - meta: corpus_chunk_count, corpus_avg_token_count
 */

import type { SiloDatabase } from '../store/types';

// ── BM25 Parameters ──────────────────────────────────────────────────────────

/** Term frequency saturation constant. */
const K1 = 1.2;

/** Document length normalisation constant. */
const B = 0.75;

// ── Types ────────────────────────────────────────────────────────────────────

export interface Bm25ChunkScore {
  /** Normalised BM25 score in [0, 1]. */
  score: number;
  /** Raw (un-normalised) BM25 score. */
  rawBm25: number;
}

// ── Scorer ───────────────────────────────────────────────────────────────────

/**
 * Compute BM25 scores for all chunks that contain at least one query token.
 *
 * @param db           Silo database handle (better-sqlite3, synchronous).
 * @param queryTokens  Pre-tokenised query (lowercase, no stemming).
 * @returns Map from chunk ID to normalised BM25 score.
 */
export function scoreBm25(
  db: SiloDatabase,
  queryTokens: string[],
): Map<number, Bm25ChunkScore> {
  const results = new Map<number, Bm25ChunkScore>();
  if (queryTokens.length === 0) return results;

  // Deduplicate query tokens (multiple occurrences of same term don't change IDF)
  const uniqueTokens = [...new Set(queryTokens)];

  // ── Corpus stats ──────────────────────────────────────────────────────────
  const corpusRow = db.prepare(
    `SELECT
       (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'corpus_chunk_count') AS N,
       (SELECT CAST(value AS REAL) FROM meta WHERE key = 'corpus_avg_token_count') AS avgdl`,
  ).get() as { N: number | null; avgdl: number | null } | undefined;

  const N = corpusRow?.N ?? 0;
  const avgdl = corpusRow?.avgdl ?? 1;
  if (N === 0) return results;

  // ── Fetch doc-freq for each query term ────────────────────────────────────
  const getDocFreq = db.prepare(`SELECT doc_freq FROM terms WHERE term = ?`);

  interface TermInfo { term: string; idf: number }
  const termInfos: TermInfo[] = [];

  for (const term of uniqueTokens) {
    const row = getDocFreq.get(term) as { doc_freq: number } | undefined;
    const df = row?.doc_freq ?? 0;
    if (df === 0) continue; // term not in corpus — contributes nothing

    // IDF: ln((N - df + 0.5) / (df + 0.5))
    // Clamp to 0 to avoid negative IDF for very common terms
    const idf = Math.max(0, Math.log((N - df + 0.5) / (df + 0.5)));
    termInfos.push({ term, idf });
  }

  if (termInfos.length === 0) return results;

  // ── Theoretical maximum score (all query terms present with high TF) ──────
  // S_max = sum(IDF(t) * (k1 + 1)) for each query term.
  // This is the score a chunk would get if every term appeared with saturated
  // frequency and the chunk had average length.
  const S_max = termInfos.reduce((sum, ti) => sum + ti.idf * (K1 + 1), 0);
  if (S_max <= 0) return results;

  // ── Fetch postings for all query terms at once ────────────────────────────
  // Build a map: chunkId → { term → tf }
  // V2: postings uses term_id FK — join through terms table to match by term text
  const chunkTermFreqs = new Map<number, Map<string, number>>();

  const placeholders = termInfos.map(() => '?').join(',');
  const postingsRows = db.prepare(
    `SELECT t.term, p.chunk_id, p.term_freq
     FROM postings p
     JOIN terms t ON t.id = p.term_id
     WHERE t.term IN (${placeholders})`,
  ).all(...termInfos.map((ti) => ti.term)) as Array<{
    term: string;
    chunk_id: number;
    term_freq: number;
  }>;

  for (const row of postingsRows) {
    let freqs = chunkTermFreqs.get(row.chunk_id);
    if (!freqs) {
      freqs = new Map();
      chunkTermFreqs.set(row.chunk_id, freqs);
    }
    freqs.set(row.term, row.term_freq);
  }

  if (chunkTermFreqs.size === 0) return results;

  // ── Fetch token counts for matching chunks ────────────────────────────────
  const chunkIds = Array.from(chunkTermFreqs.keys());
  // Use temp table for efficient bulk lookup
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS _bm25_ids (id INTEGER PRIMARY KEY)`);
  db.exec(`DELETE FROM _bm25_ids`);
  const insertId = db.prepare(`INSERT INTO _bm25_ids (id) VALUES (?)`);
  for (const id of chunkIds) {
    insertId.run(id);
  }

  const tokenCountRows = db.prepare(
    `SELECT c.id, c.token_count FROM chunks c JOIN _bm25_ids b ON b.id = c.id`,
  ).all() as Array<{ id: number; token_count: number }>;

  const tokenCounts = new Map<number, number>();
  for (const row of tokenCountRows) {
    tokenCounts.set(row.id, row.token_count);
  }

  // ── Score each chunk ──────────────────────────────────────────────────────
  for (const [chunkId, freqs] of chunkTermFreqs) {
    const dl = tokenCounts.get(chunkId) ?? 0;
    let rawBm25 = 0;

    for (const ti of termInfos) {
      const tf = freqs.get(ti.term) ?? 0;
      if (tf === 0) continue;

      // BM25 per-term contribution:
      // IDF * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl))
      const numerator = tf * (K1 + 1);
      const denominator = tf + K1 * (1 - B + B * dl / avgdl);
      rawBm25 += ti.idf * (numerator / denominator);
    }

    if (rawBm25 > 0) {
      results.set(chunkId, {
        score: Math.min(rawBm25 / S_max, 1.0),
        rawBm25,
      });
    }
  }

  return results;
}
