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
import type { SiloSearchResultChunk } from './store';
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

/** Raw per-directory result from a single silo, before cross-silo calibration. */
export interface RawDirectoryResult extends SiloDirectorySearchResult {
  siloName: string;
}

/** Merged directory result with calibrated score. */
export interface MergedDirectoryResult extends RawDirectoryResult {
  qualityScore: number;
}

/**
 * Run a directory explore query across multiple silos, grouping by embedding
 * model so the query is only embedded once per model.
 */
export async function dispatchExplore(
  params: DirectorySearchParams,
  managers: Iterable<[string, SiloManager]>,
  resolveService: (model: string) => EmbeddingService | null,
): Promise<RawDirectoryResult[]> {
  const byModel = groupByModel(managers);

  const raw: RawDirectoryResult[] = [];
  const isEmptyQuery = !params.query || params.query.trim().length === 0;

  for (const [model, group] of byModel) {
    let queryEmbedding: number[] | undefined;

    if (!isEmptyQuery) {
      const service = resolveService(model);
      if (!service) continue;
      queryEmbedding = await service.embed(params.query!);
    }

    for (const [name, manager] of group) {
      try {
        const siloResults = manager.exploreDirectories(params, queryEmbedding);
        for (const r of siloResults) {
          raw.push({ ...r, siloName: name });
        }
      } catch (err) {
        console.error(`[explore] Error in silo "${name}":`, err);
      }
    }
  }

  return raw;
}

/**
 * Calibrate and merge directory results from multiple silos.
 *
 * Simpler than file calibration — uses mean cosine per silo when cross-silo,
 * and computes quality scores from cosine + signal agreement.
 */
export function calibrateAndMergeDirectories(raw: RawDirectoryResult[]): MergedDirectoryResult[] {
  const crossSilo = new Set(raw.map((r) => r.siloName)).size > 1;
  const siloMeanCosine = crossSilo ? computeSiloMeanCosines(raw) : new Map<string, number>();

  return raw.map((r) => ({
    ...r,
    score: crossSilo ? r.score * (siloMeanCosine.get(r.siloName) ?? 0) : r.score,
    qualityScore: computeQualityScore(r.bestCosineSimilarity, r.breakdown, DIR_SIGNAL_COUNT),
  }));
}
