/**
 * Cross-silo search result merging and calibration.
 *
 * When search results come from multiple silos, RRF scores are not directly
 * comparable — the top result in every silo scores near 1.0 regardless of
 * actual relevance. This module provides calibration and merging logic
 * shared by the main process IPC handler and the MCP server.
 */

import type { MatchType, SearchWeights, ScoreBreakdown } from '../shared/types';
import { DEFAULT_SEARCH_WEIGHTS } from '../shared/types';
import type { EmbeddingService } from './embedding';
import type { SiloManager } from './silo-manager';
import type { SiloSearchResultChunk } from './store';

// ── Types ────────────────────────────────────────────────────────────────────

/** Raw per-file result from a single silo, before cross-silo calibration. */
export interface RawSiloResult {
  filePath: string;
  rrfScore: number;
  bestCosineSimilarity: number;
  matchType: MatchType;
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

/**
 * Compute a display-friendly "goodness of fit" quality score (0–0.99).
 *
 * Anchored on cosine similarity (a real 0-1 quality measure).
 * Each additional matching signal adds an agreement bonus.
 * For keyword-only results (no cosine) a moderate baseline is used.
 */
export function computeQualityScore(
  bestCosine: number,
  breakdown?: ScoreBreakdown,
): number {
  const matchCount = breakdown
    ? SIGNAL_KEYS.filter((k) => (breakdown[k]?.rank ?? 0) > 0).length
    : 0;
  const base = bestCosine > 0 ? bestCosine : 0.35;
  const agreementBonus = Math.max(0, matchCount - 1) * 0.05;
  return Math.min(base + agreementBonus, 0.99);
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

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
): Promise<RawSiloResult[]> {
  const byModel = new Map<string, Array<[string, SiloManager]>>();
  for (const [name, manager] of managers) {
    const model = manager.getConfig().model;
    let group = byModel.get(model);
    if (!group) { group = []; byModel.set(model, group); }
    group.push([name, manager]);
  }

  const raw: RawSiloResult[] = [];
  for (const [model, group] of byModel) {
    const service = resolveService(model);
    if (!service) continue;

    const queryVector = await service.embed(query);
    for (const [name, manager] of group) {
      try {
        const siloResults = manager.searchWithVector(queryVector, query, limit, weights);
        for (const r of siloResults) {
          raw.push({
            filePath: r.filePath,
            rrfScore: r.score,
            bestCosineSimilarity: r.bestCosineSimilarity,
            matchType: r.matchType,
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
  const silosWithResults = new Set(raw.map((r) => r.siloName));
  const crossSilo = silosWithResults.size > 1;

  const siloMeanCosine = new Map<string, number>();
  if (crossSilo) {
    const siloSums = new Map<string, { sum: number; count: number }>();
    for (const r of raw) {
      if (r.bestCosineSimilarity <= 0) continue;
      const entry = siloSums.get(r.siloName) ?? { sum: 0, count: 0 };
      entry.sum += r.bestCosineSimilarity;
      entry.count++;
      siloSums.set(r.siloName, entry);
    }
    for (const [name, { sum, count }] of siloSums) {
      siloMeanCosine.set(name, sum / count);
    }
  }

  return raw.map((r) => ({
    ...r,
    score: crossSilo ? r.rrfScore * (siloMeanCosine.get(r.siloName) ?? 0) : r.rrfScore,
    qualityScore: computeQualityScore(r.bestCosineSimilarity, r.breakdown),
  }));
}
