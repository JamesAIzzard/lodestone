/**
 * Memory search — decaying-sum signal pipeline for memory recall.
 *
 * Mirrors the silo search pipeline (search.ts) but operates on the memory
 * database schema. Memories are atomic (no chunks), so signals return
 * per-memory scores directly — no chunk→file aggregation needed.
 *
 * Modes:
 *   hybrid   = [semantic, bm25]  — convergence-boosted (default)
 *   semantic = [semantic]         — pure vector similarity
 *   bm25     = [bm25]            — pure keyword matching
 */

import type { MemoryDatabase } from './memory-store';
import { float32Buffer, getMemoryCount, rowToRecord, filterMemoryIdsByDate } from './memory-store';
import { summariseDecay } from './scorers/decaying-sum';
import { tokenise } from './tokeniser';
import type { MemorySearchResult, MemoryStatusValue } from '../shared/types';

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
  db: MemoryDatabase;
  query: string;
  queryVector: number[];
  queryTokens: string[];
  maxResults: number;
  /** If non-null, only these memory IDs are candidates. */
  allowedIds: Set<number> | null;
}

/** A scoring signal that produces per-memory scores. */
interface MemorySignal {
  name: string;
  scoreAll(ctx: MemorySignalContext): Map<number, number>;
}

// ── Signals ─────────────────────────────────────────────────────────────────

/** Fan-out factor: query more candidates than needed to ensure coverage. */
const CANDIDATE_FANOUT = 5;

const memorySemanticSignal: MemorySignal = {
  name: 'semantic',

  scoreAll(ctx: MemorySignalContext): Map<number, number> {
    const scores = new Map<number, number>();
    if (ctx.queryVector.length === 0) return scores;

    const k = Math.max(ctx.maxResults * CANDIDATE_FANOUT, 20);

    // KNN vector search against memories_vec
    let vecRows: Array<{ rowid: number; distance: number }>;
    try {
      vecRows = ctx.db.prepare(`
        SELECT rowid, distance
        FROM memories_vec
        WHERE embedding MATCH ?
          AND k = ?
      `).all(float32Buffer(ctx.queryVector), k) as Array<{ rowid: number; distance: number }>;
    } catch {
      return scores; // vec0 may fail if table is empty
    }

    if (vecRows.length === 0) return scores;

    // Map vec_rowid → memories.id, excluding soft-deleted memories.
    const vecRowids = vecRows.map(r => r.rowid);
    const ph = vecRowids.map(() => '?').join(', ');
    const mappings = ctx.db.prepare(
      `SELECT id, vec_rowid FROM memories WHERE vec_rowid IN (${ph}) AND deleted_at IS NULL`,
    ).all(...vecRowids) as Array<{ id: number; vec_rowid: number }>;

    const vecDistMap = new Map(vecRows.map(r => [r.rowid, r.distance]));
    for (const m of mappings) {
      const dist = vecDistMap.get(m.vec_rowid) ?? 2;
      scores.set(m.id, 1 - dist / 2); // cosine similarity [0, 1]
    }

    return scores;
  },
};

/** BM25 parameters (same as silo scorer). */
const K1 = 1.2;
const B = 0.75;

const memoryBm25Signal: MemorySignal = {
  name: 'bm25',

  scoreAll(ctx: MemorySignalContext): Map<number, number> {
    const scores = new Map<number, number>();
    if (ctx.queryTokens.length === 0) return scores;

    // ── Corpus stats ──────────────────────────────────────────────────
    const corpusRow = ctx.db.prepare(
      `SELECT
         (SELECT value FROM memory_metadata WHERE key = 'corpus_memory_count') AS N,
         (SELECT value FROM memory_metadata WHERE key = 'corpus_avg_token_count') AS avgdl`,
    ).get() as { N: string | null; avgdl: string | null } | undefined;

    const N = parseInt(corpusRow?.N ?? '0', 10);
    const avgdl = parseFloat(corpusRow?.avgdl ?? '1');
    if (N === 0) return scores;

    // ── Doc-freq and IDF per query term ───────────────────────────────
    const uniqueTokens = [...new Set(ctx.queryTokens)];
    const getDocFreq = ctx.db.prepare(`SELECT doc_freq FROM memory_terms WHERE term = ?`);

    interface TermInfo { term: string; idf: number }
    const termInfos: TermInfo[] = [];

    for (const term of uniqueTokens) {
      const row = getDocFreq.get(term) as { doc_freq: number } | undefined;
      const df = row?.doc_freq ?? 0;
      if (df === 0) continue;

      const idf = Math.max(0, Math.log((N - df + 0.5) / (df + 0.5)));
      termInfos.push({ term, idf });
    }

    if (termInfos.length === 0) return scores;

    // ── Theoretical maximum score (S_max) ─────────────────────────────
    const S_max = termInfos.reduce((sum, ti) => sum + ti.idf * (K1 + 1), 0);
    if (S_max <= 0) return scores;

    // ── Fetch postings for all query terms ────────────────────────────
    const memTermFreqs = new Map<number, Map<string, number>>();
    const ph = termInfos.map(() => '?').join(',');
    const postingsRows = ctx.db.prepare(
      `SELECT term, memory_id, term_freq FROM memory_postings WHERE term IN (${ph})`,
    ).all(...termInfos.map(ti => ti.term)) as Array<{
      term: string;
      memory_id: number;
      term_freq: number;
    }>;

    for (const row of postingsRows) {
      let freqs = memTermFreqs.get(row.memory_id);
      if (!freqs) {
        freqs = new Map();
        memTermFreqs.set(row.memory_id, freqs);
      }
      freqs.set(row.term, row.term_freq);
    }

    if (memTermFreqs.size === 0) return scores;

    // ── Fetch token counts for matching memories ──────────────────────
    const memIds = Array.from(memTermFreqs.keys());
    const memPh = memIds.map(() => '?').join(',');
    const tokenCountRows = ctx.db.prepare(
      `SELECT id, token_count FROM memories WHERE id IN (${memPh})`,
    ).all(...memIds) as Array<{ id: number; token_count: number }>;

    const tokenCounts = new Map<number, number>();
    for (const row of tokenCountRows) {
      tokenCounts.set(row.id, row.token_count);
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
 * Search memories using the decaying-sum signal pipeline.
 *
 * @param db          Memory database handle.
 * @param queryVector Pre-computed query embedding (empty array for bm25 mode).
 * @param query       Raw query string.
 * @param maxResults  Maximum results to return.
 * @param mode        Search mode (default: 'hybrid').
 * @param dateFilters Optional date-range filters applied before scoring.
 * @returns Ranked memory results with signal breakdown.
 */
export function searchMemory(
  db: MemoryDatabase,
  queryVector: number[],
  query: string,
  maxResults: number,
  mode: MemorySearchMode = 'hybrid',
  dateFilters?: MemoryDateFilters,
): MemorySearchResult[] {
  const count = getMemoryCount(db);
  if (count === 0) return [];

  // Pre-filter by date if any date constraints are active
  const allowedIds = dateFilters ? filterMemoryIdsByDate(db, dateFilters) : null;
  // If date filters were specified but no memories match, return empty
  if (allowedIds !== null && allowedIds.size === 0) return [];

  const signals = MODE_SIGNALS[mode] ?? MODE_SIGNALS.hybrid;

  const ctx: MemorySignalContext = {
    db,
    query,
    queryVector,
    queryTokens: tokenise(query),
    maxResults,
    allowedIds,
  };

  // ── Run all signals ────────────────────────────────────────────────
  const signalResults = signals.map(s => ({
    name: s.name,
    scores: s.scoreAll(ctx),
  }));

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
  const rows = db.prepare(
    `SELECT * FROM memories WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
  ).all(...scored.map(r => r.id)) as Record<string, unknown>[];

  const rowMap = new Map(rows.map(r => [r.id as number, r]));

  return scored
    .filter(r => rowMap.has(r.id))
    .map(r => ({
      ...rowToRecord(rowMap.get(r.id)!),
      score: r.score,
      scoreLabel: r.scoreLabel,
      signals: r.signals,
    }));
}
