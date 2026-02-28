/**
 * Search runner — the new decaying-sum pipeline.
 *
 * A mode is just a list of signals. The runner executes all signals for the
 * mode, collects file-level scores, applies the decaying sum for convergence,
 * picks the best hint, and returns ranked file results.
 *
 * No axis concept. No recipes. No FuseFn. One composition mechanism everywhere.
 */

import type { SiloDatabase } from './store/types';
import { globToRegex } from './store/paths';
import type { SearchParams, LocationHint, ChunkHint } from '../shared/types';
import type { Signal, SignalContext, SignalHint } from './scorers/signal';
import { summariseDecay } from './scorers/decaying-sum';
import { semanticSignal } from './scorers/semantic-signal';
import { bm25Signal } from './scorers/bm25-signal';
import { filepathSignal } from './scorers/filepath-signal';
import { regexSignal } from './scorers/regex-signal';
import { tokenise } from './tokeniser';

// ── Mode → Signal mapping ───────────────────────────────────────────────────

const MODE_SIGNALS: Record<string, Signal[]> = {
  hybrid:   [semanticSignal, bm25Signal, filepathSignal],
  semantic: [semanticSignal],
  bm25:     [bm25Signal],
  filepath: [filepathSignal],
  regex:    [regexSignal],
};

// ── Result type ─────────────────────────────────────────────────────────────

/** Per-silo file result from the new search pipeline. */
export interface FileResult {
  /** Stored key (silo-relative). Resolved to absolute path by silo-manager. */
  filePath: string;
  /** Final decaying-sum score [0, 1]. */
  score: number;
  /** Human-readable label: signal name or "convergence". */
  scoreLabel: string;
  /** Per-signal raw scores. */
  signals: Record<string, number>;
  /** Best-chunk hint from the highest-scoring signal that has one. */
  hint?: {
    locationHint: LocationHint;
    sectionPath?: string[];
  };
  /** All significant matching chunks across signals (when ≥ 2 unique locations). */
  chunks?: ChunkHint[];
}

// ── Multi-chunk hint helpers ────────────────────────────────────────────────

/** Max chunks to return per file. */
const MAX_CHUNKS_PER_FILE = 10;

/** Minimum relative score (vs best chunk) to keep a chunk. */
const MIN_RELATIVE_SCORE = 0.5;

/** Identity key for deduplication — same location = same chunk. */
function locationKey(hint: LocationHint): string {
  if (!hint) return 'null';
  switch (hint.type) {
    case 'lines': return `lines:${hint.start}-${hint.end}`;
    case 'page':  return `page:${hint.page}`;
    case 'slide': return `slide:${hint.slide}`;
  }
}

/**
 * Deduplicate, filter, and rank chunk hints from all signals.
 *
 * - Deduplicates by locationHint identity (keeps higher score)
 * - Filters by relative threshold (≥ 50% of best chunk score)
 * - Caps at 10 chunks
 * - Scales relevance by the file's overall score (best chunk = fileScore%)
 * - Returns undefined if fewer than 2 unique chunks
 */
function collectChunks(
  allChunks: Array<{ score: number; locationHint: LocationHint; sectionPath?: string[] }>,
  fileScore: number,
): ChunkHint[] | undefined {
  if (allChunks.length === 0) return undefined;

  // Deduplicate by location — keep the higher score
  const byLocation = new Map<string, { score: number; locationHint: LocationHint; sectionPath?: string[] }>();
  for (const chunk of allChunks) {
    const key = locationKey(chunk.locationHint);
    const existing = byLocation.get(key);
    if (!existing || chunk.score > existing.score) {
      byLocation.set(key, chunk);
    }
  }

  // Sort descending by score
  const deduped = [...byLocation.values()].sort((a, b) => b.score - a.score);

  if (deduped.length < 2) return undefined;

  // Filter by relative threshold
  const bestScore = deduped[0].score;
  const threshold = bestScore * MIN_RELATIVE_SCORE;
  const filtered = deduped.filter(c => c.score >= threshold);

  if (filtered.length < 2) return undefined;

  // Cap and convert to absolute relevance (scaled by file score)
  const capped = filtered.slice(0, MAX_CHUNKS_PER_FILE);
  const filePercent = fileScore * 100;
  return capped.map(c => ({
    locationHint: c.locationHint,
    sectionPath: c.sectionPath,
    relevance: bestScore > 0
      ? Math.round((c.score / bestScore) * filePercent)
      : Math.round(filePercent),
  }));
}

// ── Search function ─────────────────────────────────────────────────────────

/**
 * Run a search across a single silo using the decaying-sum pipeline.
 *
 * @param db          Silo database handle.
 * @param queryVector Pre-computed query embedding (empty for bm25/regex modes).
 * @param params      Search parameters (query, mode, filePattern, etc.).
 * @returns Ranked file results, truncated to params.limit.
 */
export function search(
  db: SiloDatabase,
  queryVector: number[],
  params: SearchParams,
): FileResult[] {
  const mode = params.mode ?? 'hybrid';
  const signals = MODE_SIGNALS[mode] ?? MODE_SIGNALS.hybrid;
  const maxResults = params.limit ?? 10;

  const ctx: SignalContext = {
    db,
    query: params.query,
    queryVector,
    queryTokens: tokenise(params.query),
    filePatternRe: params.filePattern ? globToRegex(params.filePattern) : null,
    startPath: params.startPath,
    maxResults,
    regexFlags: params.regexFlags,
  };

  // ── Run all signals ────────────────────────────────────────────────
  const signalResults = signals.map(s => ({
    name: s.name,
    ...s.scoreAll(ctx),
  }));

  // ── Collect all file IDs that appear in any signal ─────────────────
  const allFiles = new Set<string>();
  for (const sr of signalResults) {
    for (const key of sr.scores.keys()) allFiles.add(key);
  }

  if (allFiles.size === 0) return [];

  // ── Compose per-file scores via decaying sum ──────────────────────
  const results: FileResult[] = [];

  for (const filePath of allFiles) {
    // Gather per-signal scores for this file
    const perSignal: Record<string, number> = {};
    for (const sr of signalResults) {
      const s = sr.scores.get(filePath);
      if (s === undefined) continue;
      if (s < 0 || s > 1) {
        console.warn(`[search] Signal "${sr.name}" returned out-of-range score ${s.toFixed(4)} for ${filePath.slice(-40)} — expected [0, 1]. Possible bug in signal or distance conversion.`);
      }
      if (s > 0) perSignal[sr.name] = s;
    }

    const summary = summariseDecay(perSignal);
    if (summary.score <= 0) continue;

    // Pick the best hint: from the highest-scoring signal that has a hint
    let bestHint: SignalHint | undefined;
    let bestHintScore = -1;
    for (const sr of signalResults) {
      const score = sr.scores.get(filePath) ?? 0;
      const hint = sr.hints.get(filePath);
      if (hint && hint.locationHint && score > bestHintScore) {
        bestHint = hint;
        bestHintScore = score;
      }
    }

    // Collect all chunk hints from all signals for multi-chunk display
    const rawChunks: Array<{ score: number; locationHint: LocationHint; sectionPath?: string[] }> = [];
    for (const sr of signalResults) {
      const fileHints = sr.allHints?.get(filePath);
      if (!fileHints) continue;
      for (const h of fileHints) {
        if (h.locationHint) {
          rawChunks.push({
            score: h.score ?? 0,
            locationHint: h.locationHint,
            sectionPath: h.sectionPath,
          });
        }
      }
    }

    results.push({
      filePath,
      score: summary.score,
      scoreLabel: summary.label,
      signals: perSignal,
      hint: bestHint?.locationHint ? {
        locationHint: bestHint.locationHint,
        sectionPath: bestHint.sectionPath,
      } : undefined,
      chunks: collectChunks(rawChunks, summary.score),
    });
  }

  // ── Sort and truncate ─────────────────────────────────────────────
  // Regex mode: sort alphabetically for deterministic ordering (matches are all 1.0)
  if (mode === 'regex') {
    results.sort((a, b) => a.filePath.localeCompare(b.filePath));
  } else {
    results.sort((a, b) => b.score - a.score);
  }

  if (results.length > maxResults) results.length = maxResults;
  return results;
}
