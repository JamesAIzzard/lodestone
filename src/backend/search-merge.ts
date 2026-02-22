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
  }));
}
