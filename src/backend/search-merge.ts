/**
 * Cross-silo search result merging and calibration.
 *
 * When search results come from multiple silos, RRF scores are not directly
 * comparable — the top result in every silo scores near 1.0 regardless of
 * actual relevance. This module provides calibration and merging logic
 * shared by the main process IPC handler and the MCP server.
 */

import type { MatchType, SearchWeights, ScoreBreakdown, ScoreSource } from '../shared/types';
import { DEFAULT_SEARCH_WEIGHTS } from '../shared/types';
import type { EmbeddingService } from './embedding';
import type { SiloManager } from './silo-manager';
import type { SiloSearchResultChunk, TwoAxisFileResult, TwoAxisScoreSource, TwoAxisChunk } from './store';
import { RRF_K } from './store';
import type { DirectorySearchParams, SiloDirectorySearchResult } from './directory-search';

// ── Types ────────────────────────────────────────────────────────────────────

/** Raw per-file result from a single silo, before cross-silo calibration. */
export interface RawSiloResult {
  filePath: string;
  rrfScore: number;
  bestCosineSimilarity: number;
  matchType: MatchType;
  scoreSource: ScoreSource;
  siloName: string;
  chunks: SiloSearchResultChunk[];
  weights: SearchWeights;
  breakdown: ScoreBreakdown;
}

/** Merged result with calibrated score. */
export interface MergedResult extends RawSiloResult {
  score: number;
  qualityScore: number;
}

// ── Quality score ───────────────────────────────────────────────────────────

const SIGNAL_KEYS = ['semantic', 'bm25', 'trigram', 'filepath', 'tags'] as const;

/** Number of scoring signals active in directory search (semantic, trigram, filepath). */
const DIR_SIGNAL_COUNT = 3;

/**
 * Compute a display-friendly "goodness of fit" quality score (0–0.99).
 *
 * Anchored on cosine similarity (a real 0-1 quality measure).
 * Each additional matching signal adds an agreement bonus, normalised against
 * the number of signals that were *available* for this search type so that
 * directory results (3 active signals) are not penalised vs file results (5).
 * For keyword-only results (no cosine) a moderate baseline is used.
 *
 * @param availableSignals  How many signals are active for this search type
 *                          (default 5 for file search, 3 for directory search).
 */
export function computeQualityScore(
  bestCosine: number,
  breakdown?: ScoreBreakdown,
  availableSignals: number = SIGNAL_KEYS.length,
): number {
  // Content quality: cosine-anchored with signal agreement bonus
  const matchCount = breakdown
    ? SIGNAL_KEYS.filter((k) => (breakdown[k]?.rank ?? 0) > 0).length
    : 0;
  const base = bestCosine > 0 ? bestCosine : 0.35;
  // Bonus is normalised: full agreement always yields +0.20 regardless of
  // how many signals are available. For 5 signals this is identical to the
  // previous formula ((matchCount - 1) * 0.05).
  const maxSlots = Math.max(1, availableSignals - 1);
  const agreementBonus = (Math.max(0, matchCount - 1) / maxSlots) * 0.20;
  const contentQuality = Math.min(base + agreementBonus, 0.99);

  // Filename quality: RRF-style decay on filepath rank so an exact filename
  // match scores near 1.0, independently of whether the content matched.
  const filepathRank = breakdown?.filepath?.rank ?? 0;
  const filenameQuality = filepathRank > 0 ? (RRF_K + 1) / (RRF_K + filepathRank) : 0;

  return Math.min(Math.max(contentQuality, filenameQuality), 0.99);
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/** Group silo managers by their embedding model so each model is embedded once. */
function groupByModel(
  managers: Iterable<[string, SiloManager]>,
): Map<string, Array<[string, SiloManager]>> {
  const byModel = new Map<string, Array<[string, SiloManager]>>();
  for (const [name, manager] of managers) {
    const model = manager.getConfig().model;
    const group = byModel.get(model) ?? [];
    if (!byModel.has(model)) byModel.set(model, group);
    group.push([name, manager]);
  }
  return byModel;
}

/**
 * Run a search query across multiple silos, grouping by embedding model
 * so the query is only embedded once per model.
 *
 * Callers provide their own embedding service resolver so this works in
 * both the IPC context (services on AppContext) and MCP context (services
 * on each SiloManager).
 */
export async function dispatchSearch(
  query: string,
  managers: Iterable<[string, SiloManager]>,
  resolveService: (model: string) => EmbeddingService | null,
  limit: number,
  weights: SearchWeights,
  startPath?: string,
): Promise<RawSiloResult[]> {
  const byModel = groupByModel(managers);

  const raw: RawSiloResult[] = [];
  for (const [model, group] of byModel) {
    const service = resolveService(model);
    if (!service) continue;

    const queryVector = await service.embed(query);
    for (const [name, manager] of group) {
      try {
        const siloResults = manager.searchWithVector(queryVector, query, limit, weights, startPath);
        for (const r of siloResults) {
          raw.push({
            filePath: r.filePath,
            rrfScore: r.score,
            bestCosineSimilarity: r.bestCosineSimilarity,
            matchType: r.matchType,
            scoreSource: r.scoreSource,
            siloName: name,
            chunks: r.chunks,
            weights: r.weights,
            breakdown: r.breakdown,
          });
        }
      } catch (err) {
        console.error(`[search] Error in silo "${name}":`, err);
      }
    }
  }

  return raw;
}

// ── Calibration ──────────────────────────────────────────────────────────────

/**
 * Compute the mean cosine similarity per silo across a set of results.
 * Used for cross-silo score calibration: silos with low average cosine
 * are discounted so that a weakly-relevant silo can't dominate results.
 */
function computeSiloMeanCosines(
  raw: Array<{ siloName: string; bestCosineSimilarity: number }>,
): Map<string, number> {
  const siloSums = new Map<string, { sum: number; count: number }>();
  for (const r of raw) {
    if (r.bestCosineSimilarity <= 0) continue;
    const entry = siloSums.get(r.siloName) ?? { sum: 0, count: 0 };
    entry.sum += r.bestCosineSimilarity;
    entry.count++;
    siloSums.set(r.siloName, entry);
  }
  const means = new Map<string, number>();
  for (const [name, { sum, count }] of siloSums) {
    means.set(name, sum / count);
  }
  return means;
}

/**
 * Calibrate and merge search results from multiple silos.
 *
 * When results come from a single silo, the RRF score is used directly.
 * When results span multiple silos, each result's RRF score is multiplied
 * by the silo's mean cosine similarity to discount weakly-relevant silos.
 *
 * Mean cosine is more robust than max — it reflects overall silo relevance
 * rather than being dominated by a single strong outlier. The calibration
 * is silo-level (not per-file) so keyword-only results aren't zeroed out.
 */
export function calibrateAndMerge(raw: RawSiloResult[]): MergedResult[] {
  const crossSilo = new Set(raw.map((r) => r.siloName)).size > 1;
  const siloMeanCosine = crossSilo ? computeSiloMeanCosines(raw) : new Map<string, number>();

  return raw.map((r) => ({
    ...r,
    score: crossSilo ? r.rrfScore * (siloMeanCosine.get(r.siloName) ?? 0) : r.rrfScore,
    qualityScore: computeQualityScore(r.bestCosineSimilarity, r.breakdown),
  }));
}

// ── Directory Exploration ───────────────────────────────────────────────────

/** Per-directory result from a single silo with siloName attached. */
export interface RawDirectoryResult extends SiloDirectorySearchResult {
  siloName: string;
}

/**
 * Run a directory explore query across multiple silos.
 *
 * No embeddings needed — directory scoring uses segment Levenshtein
 * and token coverage, both of which operate on the query string directly.
 */
export async function dispatchExplore(
  params: DirectorySearchParams,
  managers: Iterable<[string, SiloManager]>,
): Promise<RawDirectoryResult[]> {
  const raw: RawDirectoryResult[] = [];

  for (const [name, manager] of managers) {
    try {
      const siloResults = manager.exploreDirectories(params);
      for (const r of siloResults) {
        raw.push({ ...r, siloName: name });
      }
    } catch (err) {
      console.error(`[explore] Error in silo "${name}":`, err);
    }
  }

  return raw;
}

/**
 * Merge directory results from multiple silos.
 *
 * No calibration needed — scores are absolute [0,1] values.
 * Just sort by score descending and truncate.
 */
export function mergeDirectoryResults(
  raw: RawDirectoryResult[],
  limit: number,
): RawDirectoryResult[] {
  return raw
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ── Two-Axis Search (replaces RRF pipeline) ─────────────────────────────────

/** Per-file result from a single silo in the two-axis model. */
export interface TwoAxisSiloResult {
  filePath: string;
  siloName: string;
  score: number;
  scoreSource: TwoAxisScoreSource;
  contentScore: number;
  filenameScore: number;
  chunks: TwoAxisChunk[];
}

/**
 * Run a two-axis search query across multiple silos, grouping by embedding
 * model so the query is only embedded once per model.
 *
 * No cross-silo calibration needed — all scores are absolute [0,1].
 */
export async function dispatchTwoAxisSearch(
  query: string,
  managers: Iterable<[string, SiloManager]>,
  resolveService: (model: string) => EmbeddingService | null,
  limit: number,
  startPath?: string,
): Promise<TwoAxisSiloResult[]> {
  const byModel = groupByModel(managers);

  const raw: TwoAxisSiloResult[] = [];
  for (const [model, group] of byModel) {
    const service = resolveService(model);
    if (!service) continue;

    const queryVector = await service.embed(query);
    for (const [name, manager] of group) {
      try {
        const siloResults = manager.searchTwoAxis(queryVector, query, limit, startPath);
        for (const r of siloResults) {
          raw.push({
            filePath: r.filePath,
            siloName: name,
            score: r.score,
            scoreSource: r.scoreSource,
            contentScore: r.contentScore,
            filenameScore: r.filenameScore,
            chunks: r.chunks,
          });
        }
      } catch (err) {
        console.error(`[search] Error in silo "${name}":`, err);
      }
    }
  }

  return raw;
}

/**
 * Merge two-axis results from multiple silos.
 *
 * Unlike the old RRF pipeline, no calibration is needed because scores are
 * absolute [0,1] values. We just flatten, sort by score, and take top results.
 */
export function mergeTwoAxisResults(
  raw: TwoAxisSiloResult[],
  limit: number,
): TwoAxisSiloResult[] {
  return raw
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
