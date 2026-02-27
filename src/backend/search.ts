/**
 * Search runner — the new decaying-sum pipeline.
 *
 * A mode is just a list of signals. The runner executes all signals for the
 * mode, collects file-level scores, applies the decaying sum for convergence,
 * picks the best hint, and returns ranked file results.
 *
 * No axis concept. No recipes. No FuseFn. One composition mechanism everywhere.
 */

import type { SiloDatabase } from './store';
import { globToRegex } from './store';
import type { SearchParams, LocationHint } from '../shared/types';
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
      if (s !== undefined && s > 0) perSignal[sr.name] = s;
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

    results.push({
      filePath,
      score: summary.score,
      scoreLabel: summary.label,
      signals: perSignal,
      hint: bestHint?.locationHint ? {
        locationHint: bestHint.locationHint,
        sectionPath: bestHint.sectionPath,
      } : undefined,
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
