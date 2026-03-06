/**
 * Memory search — async D1 decaying-sum signal pipeline for memory recall.
 *
 * Modes:
 *   hybrid   = [semantic, bm25]  — Vectorize KNN + BM25 fused via decaying-sum
 *   semantic = [semantic]         — Vectorize KNN only
 *   bm25     = [bm25]            — pure keyword matching
 *
 * When Vectorize/queryVector are unavailable, semantic signal gracefully
 * returns empty and hybrid degrades to BM25-only.
 */

import { getMemoryCount, filterMemoryIdsByDate } from './d1/read';
import { rowToRecord } from './d1/helpers';
import { summariseDecay } from './decaying-sum';
import { tokenise } from './tokeniser';
import type { MemorySearchResult, MemoryStatusValue } from './shared/types';

// ── Types ───────────────────────────────────────────────────────────────────

export type { MemorySearchResult };
export type MemorySearchMode = 'hybrid' | 'semantic' | 'bm25';

/** Optional date-range filters applied before the search pipeline runs. */
export interface MemoryDateFilters {
  updatedAfter?: string;
  updatedBefore?: string;
  actionAfter?: string;
  actionBefore?: string;
  completedAfter?: string;
  completedBefore?: string;
  /** Filter by status. Use 'completed' to match completed_on IS NOT NULL too. Null = unclassified. */
  status?: MemoryStatusValue | null;
}

/** Everything a memory signal needs to produce its scores. */
interface MemorySignalContext {
  db: D1Database;
  query: string;
  queryTokens: string[];
  maxResults: number;
  /** If non-null, only these memory IDs are candidates. */
  allowedIds: Set<number> | null;
  /** Pre-computed query embedding vector (Phase 3). */
  queryVector?: number[];
  /** Vectorize index binding (Phase 3). */
  vectorize?: Vectorize;
}

/** A scoring signal that produces per-memory scores (async for D1). */
interface MemorySignal {
  name: string;
  scoreAll(ctx: MemorySignalContext): Promise<Map<number, number>>;
}

// ── Signals ─────────────────────────────────────────────────────────────────

/** Candidate fanout: fetch k * FANOUT candidates to ensure coverage after filtering. */
const CANDIDATE_FANOUT = 5;
const MIN_CANDIDATES = 20;

/**
 * Semantic signal — Vectorize KNN search with cosine similarity.
 * Returns empty Map gracefully when Vectorize/queryVector are unavailable.
 */
const memorySemanticSignal: MemorySignal = {
  name: 'semantic',
  async scoreAll(ctx: MemorySignalContext): Promise<Map<number, number>> {
    const scores = new Map<number, number>();
    if (!ctx.vectorize || !ctx.queryVector) return scores;

    const k = Math.min(Math.max(ctx.maxResults * CANDIDATE_FANOUT, MIN_CANDIDATES), 100);
    const results = await ctx.vectorize.query(ctx.queryVector, { topK: k });

    for (const match of results.matches) {
      const memId = parseInt(match.id, 10);
      if (isNaN(memId)) continue;
      // Respect date-range pre-filter
      if (ctx.allowedIds !== null && !ctx.allowedIds.has(memId)) continue;
      // Vectorize cosine metric returns similarity [0,1] directly
      if (match.score > 0) scores.set(memId, match.score);
    }

    return scores;
  },
};

/** BM25 parameters (same as silo scorer). */
const K1 = 1.2;
const B = 0.75;

const memoryBm25Signal: MemorySignal = {
  name: 'bm25',

  async scoreAll(ctx: MemorySignalContext): Promise<Map<number, number>> {
    const scores = new Map<number, number>();
    if (ctx.queryTokens.length === 0) return scores;

    // ── Corpus stats ──────────────────────────────────────────────────
    const corpusRow = await ctx.db.prepare(
      `SELECT
         (SELECT value FROM memory_metadata WHERE key = 'corpus_memory_count') AS N,
         (SELECT value FROM memory_metadata WHERE key = 'corpus_avg_token_count') AS avgdl`,
    ).first() as { N: string | null; avgdl: string | null } | null;

    const N = parseInt(corpusRow?.N ?? '0', 10);
    const avgdl = parseFloat(corpusRow?.avgdl ?? '1');
    if (N === 0) return scores;

    // ── Doc-freq and IDF per query term ───────────────────────────────
    const uniqueTokens = [...new Set(ctx.queryTokens)];

    interface TermInfo { term: string; idf: number }
    const termInfos: TermInfo[] = [];

    // Fetch doc_freq for all query terms in a single query
    const termPh = uniqueTokens.map(() => '?').join(',');
    const { results: termRows } = await ctx.db.prepare(
      `SELECT term, doc_freq FROM memory_terms WHERE term IN (${termPh})`,
    ).bind(...uniqueTokens).all();

    const docFreqMap = new Map<string, number>();
    for (const row of termRows) {
      const r = row as Record<string, unknown>;
      docFreqMap.set(r.term as string, r.doc_freq as number);
    }

    for (const term of uniqueTokens) {
      const df = docFreqMap.get(term) ?? 0;
      if (df === 0) continue;

      // BM25+ IDF variant (Lv & Zhai 2011): log(1 + ...) ensures IDF > 0
      // when the term exists, avoiding the small-corpus failure where standard
      // BM25 IDF goes to 0 for terms appearing in every document.
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      termInfos.push({ term, idf });
    }

    if (termInfos.length === 0) return scores;

    // ── Theoretical maximum score (S_max) ─────────────────────────────
    const S_max = termInfos.reduce((sum, ti) => sum + ti.idf * (K1 + 1), 0);
    if (S_max <= 0) return scores;

    // ── Fetch postings for all query terms ────────────────────────────
    const postingsPh = termInfos.map(() => '?').join(',');
    const { results: postingsRows } = await ctx.db.prepare(
      `SELECT term, memory_id, term_freq FROM memory_postings WHERE term IN (${postingsPh})`,
    ).bind(...termInfos.map(ti => ti.term)).all();

    const memTermFreqs = new Map<number, Map<string, number>>();
    for (const row of postingsRows) {
      const r = row as Record<string, unknown>;
      const memId = r.memory_id as number;
      const term = r.term as string;
      const tf = r.term_freq as number;

      let freqs = memTermFreqs.get(memId);
      if (!freqs) {
        freqs = new Map();
        memTermFreqs.set(memId, freqs);
      }
      freqs.set(term, tf);
    }

    if (memTermFreqs.size === 0) return scores;

    // ── Fetch token counts for matching memories ──────────────────────
    const memIds = Array.from(memTermFreqs.keys());
    const memPh = memIds.map(() => '?').join(',');
    const { results: tokenCountRows } = await ctx.db.prepare(
      `SELECT id, token_count FROM memories WHERE id IN (${memPh})`,
    ).bind(...memIds).all();

    const tokenCounts = new Map<number, number>();
    for (const row of tokenCountRows) {
      const r = row as Record<string, unknown>;
      tokenCounts.set(r.id as number, r.token_count as number);
    }

    // ── Score each memory ─────────────────────────────────────────────
    for (const [memId, freqs] of memTermFreqs) {
      const dl = tokenCounts.get(memId) ?? 0;
      let rawBm25 = 0;

      for (const ti of termInfos) {
        const tf = freqs.get(ti.term) ?? 0;
        if (tf === 0) continue;

        const numerator = tf * (K1 + 1);
        const denominator = tf + K1 * (1 - B + B * dl / avgdl);
        rawBm25 += ti.idf * (numerator / denominator);
      }

      if (rawBm25 > 0) {
        scores.set(memId, Math.min(rawBm25 / S_max, 1.0));
      }
    }

    return scores;
  },
};

// ── Mode → Signal mapping ───────────────────────────────────────────────────

const MODE_SIGNALS: Record<MemorySearchMode, MemorySignal[]> = {
  hybrid:   [memorySemanticSignal, memoryBm25Signal],
  semantic: [memorySemanticSignal],
  bm25:     [memoryBm25Signal],
};

// ── Search function ─────────────────────────────────────────────────────────

/**
 * Search memories using the async D1 decaying-sum signal pipeline.
 *
 * @param db          D1 database handle.
 * @param query       Raw query string.
 * @param maxResults  Maximum results to return.
 * @param mode        Search mode (default: 'hybrid').
 * @param dateFilters Optional date-range filters applied before scoring.
 * @param vectorize   Optional Vectorize binding for semantic search.
 * @param queryVector Optional pre-computed query embedding vector.
 * @returns Ranked memory results with signal breakdown.
 */
export async function searchMemory(
  db: D1Database,
  query: string,
  maxResults: number,
  mode: MemorySearchMode = 'hybrid',
  dateFilters?: MemoryDateFilters,
  vectorize?: Vectorize,
  queryVector?: number[],
): Promise<MemorySearchResult[]> {
  const count = await getMemoryCount(db);
  if (count === 0) return [];

  // Pre-filter by date if any date constraints are active
  const allowedIds = dateFilters ? await filterMemoryIdsByDate(db, dateFilters) : null;
  // If date filters were specified but no memories match, return empty
  if (allowedIds !== null && allowedIds.size === 0) return [];

  const signals = MODE_SIGNALS[mode] ?? MODE_SIGNALS.hybrid;

  const ctx: MemorySignalContext = {
    db,
    query,
    queryTokens: tokenise(query),
    maxResults,
    allowedIds,
    queryVector,
    vectorize,
  };

  // ── Run all signals ────────────────────────────────────────────────
  const signalResults = await Promise.all(
    signals.map(async (s) => ({
      name: s.name,
      scores: await s.scoreAll(ctx),
    })),
  );

  // ── Collect all memory IDs that appear in any signal ───────────────
  const allIds = new Set<number>();
  for (const sr of signalResults) {
    for (const id of sr.scores.keys()) {
      // Apply date-range pre-filter: only include IDs in the allowed set
      if (ctx.allowedIds === null || ctx.allowedIds.has(id)) {
        allIds.add(id);
      }
    }
  }

  if (allIds.size === 0) return [];

  // ── Compose per-memory scores via decaying sum ─────────────────────
  const scored: Array<{ id: number; score: number; scoreLabel: string; signals: Record<string, number> }> = [];

  for (const id of allIds) {
    const perSignal: Record<string, number> = {};
    for (const sr of signalResults) {
      const s = sr.scores.get(id);
      if (s !== undefined && s > 0) perSignal[sr.name] = s;
    }

    const summary = summariseDecay(perSignal);
    if (summary.score <= 0) continue;

    scored.push({
      id,
      score: summary.score,
      scoreLabel: summary.label,
      signals: perSignal,
    });
  }

  // ── Sort and truncate ─────────────────────────────────────────────
  scored.sort((a, b) => b.score - a.score);
  if (scored.length > maxResults) scored.length = maxResults;

  if (scored.length === 0) return [];

  // ── Fetch full records (exclude soft-deleted) ─────────────────────
  const placeholders = scored.map(() => '?').join(', ');
  const { results: rows } = await db.prepare(
    `SELECT * FROM memories WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
  ).bind(...scored.map(r => r.id)).all();

  const rowMap = new Map(rows.map(r => [(r as Record<string, unknown>).id as number, r]));

  return scored
    .filter(r => rowMap.has(r.id))
    .map(r => ({
      ...rowToRecord(rowMap.get(r.id)! as Record<string, unknown>),
      score: r.score,
      scoreLabel: r.scoreLabel,
      signals: r.signals,
    }));
}
