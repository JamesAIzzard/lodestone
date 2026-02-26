/**
 * Cross-silo merging for the two-axis search and directory exploration pipelines.
 *
 * All scores in both pipelines are absolute [0,1] values, so no cross-silo
 * calibration is needed — results are simply flattened, sorted, and truncated.
 */

import type { EmbeddingService } from './embedding';
import type { SiloManager } from './silo-manager';
import type { TwoAxisChunk } from './store';
import type { FusedScore } from '../shared/types';
import type { DirectorySearchParams, SiloDirectorySearchResult } from './directory-search';
import type { SearchParams } from '../shared/types';

// ── Helpers ─────────────────────────────────────────────────────────────────

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

// ── Two-Axis Search ─────────────────────────────────────────────────────────

/** Per-file result from a single silo in the two-axis model. */
export interface TwoAxisSiloResult {
  filePath: string;
  siloName: string;
  score: number;
  scoreSource: string;
  /** Per-axis fused scores: { content: {...}, filename: {...} }. */
  axes: Record<string, FusedScore>;
  chunks: TwoAxisChunk[];
}

/**
 * Run a two-axis search query across multiple silos, grouping by embedding
 * model so the query is only embedded once per model.
 *
 * For 'bm25' mode the query vector is skipped entirely; all silos run with an
 * empty vector and the DB layer ignores it.
 */
export async function dispatchTwoAxisSearch(
  params: SearchParams,
  managers: Iterable<[string, SiloManager]>,
  resolveService: (model: string) => EmbeddingService | null,
): Promise<TwoAxisSiloResult[]> {
  const byModel = groupByModel(managers);

  const raw: TwoAxisSiloResult[] = [];
  for (const [model, group] of byModel) {
    // BM25-only mode: skip embedding entirely, use an empty vector
    let queryVector: number[];
    if (params.mode === 'bm25') {
      queryVector = [];
    } else {
      const service = resolveService(model);
      if (!service) continue;
      queryVector = await service.embed(params.query);
    }

    for (const [name, manager] of group) {
      try {
        const siloResults = manager.searchTwoAxis(queryVector, params);
        for (const r of siloResults) {
          raw.push({
            filePath: r.filePath,
            siloName: name,
            score: r.score,
            scoreSource: r.scoreSource,
            axes: r.axes,
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
 * Run a regex search across multiple silos synchronously.
 * No embeddings needed — full-table scan using JS RegExp.
 */
export function dispatchRegexSearch(
  params: SearchParams,
  managers: Iterable<[string, SiloManager]>,
): TwoAxisSiloResult[] {
  const raw: TwoAxisSiloResult[] = [];
  for (const [name, manager] of managers) {
    try {
      const siloResults = manager.searchRegex(params);
      for (const r of siloResults) {
        raw.push({
          filePath: r.filePath,
          siloName: name,
          score: r.score,
          scoreSource: r.scoreSource,
          axes: r.axes,
          chunks: r.chunks,
        });
      }
    } catch (err) {
      console.error(`[search] Error in regex search for silo "${name}":`, err);
    }
  }
  return raw;
}

/**
 * Merge two-axis results from multiple silos.
 *
 * No calibration needed — scores are absolute [0,1] values.
 * Just flatten, sort by score descending, and truncate.
 */
export function mergeTwoAxisResults(
  raw: TwoAxisSiloResult[],
  limit: number,
): TwoAxisSiloResult[] {
  return raw
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
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
