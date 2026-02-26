/**
 * Cross-silo merging for the search and directory exploration pipelines.
 *
 * All scores in both pipelines are absolute [0,1] values, so no cross-silo
 * calibration is needed — results are simply flattened, sorted, and truncated.
 */

import type { EmbeddingService } from './embedding';
import type { SiloManager } from './silo-manager';
import type { SearchHint } from '../shared/types';
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

// ── Search Pipeline ─────────────────────────────────────────────────────────

/** Per-file result from the decaying-sum pipeline with silo name attached. */
export interface SiloSearchResult {
  filePath: string;
  siloName: string;
  score: number;
  scoreLabel: string;
  signals: Record<string, number>;
  hint?: SearchHint;
}

/**
 * Run a search across multiple silos using the decaying-sum pipeline.
 *
 * Groups silos by embedding model so the query is only embedded once per model.
 * For 'bm25' and 'regex' modes, embedding is skipped entirely.
 */
export async function dispatchSearch(
  params: SearchParams,
  managers: Iterable<[string, SiloManager]>,
  resolveService: (model: string) => EmbeddingService | null,
): Promise<SiloSearchResult[]> {
  const skipEmbedding = params.mode === 'bm25' || params.mode === 'filepath' || params.mode === 'regex';
  const byModel = groupByModel(managers);

  const raw: SiloSearchResult[] = [];
  for (const [model, group] of byModel) {
    let queryVector: number[];
    if (skipEmbedding) {
      queryVector = [];
    } else {
      const service = resolveService(model);
      if (!service) continue;
      queryVector = await service.embed(params.query);
    }

    for (const [name, manager] of group) {
      try {
        const siloResults = manager.search(queryVector, params);
        for (const r of siloResults) {
          raw.push({
            filePath: r.filePath,
            siloName: name,
            score: r.score,
            scoreLabel: r.scoreLabel,
            signals: r.signals,
            hint: r.hint,
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
 * Merge search results from the decaying-sum pipeline across silos.
 * Scores are absolute [0,1] — just flatten, sort, truncate.
 */
export function mergeSearchResults(
  raw: SiloSearchResult[],
  limit: number,
): SiloSearchResult[] {
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
