/**
 * Scoring recipes — declarative composition of signals into fused scores.
 *
 * A recipe declares which signals to run for a given axis, and how to
 * combine their individual [0,1] scores into a single FusedScore.
 *
 * Two recipe types:
 *   - TextRecipe: runs pure TextSignal functions per candidate string.
 *   - ChunkRecipe: fuses pre-computed per-chunk signal maps (index-backed).
 *
 * Both produce the same FusedScore output, which flows opaquely through the
 * entire pipeline (search-merge, IPC, renderer) without per-signal knowledge.
 */

import type { FusedScore, SignalScores } from '../../shared/types';
import type { TextSignal } from './text-signals';
import { levenshteinSimilarity, tokenCoverage } from './text-signals';

// ── Fusion Function ─────────────────────────────────────────────────────────

type FuseFn = (scores: SignalScores) => { best: number; bestSignal: string };

/** Default fusion: take the maximum score across all signals. */
function fuseMax(scores: SignalScores): { best: number; bestSignal: string } {
  let best = 0;
  let bestSignal = '';
  for (const [name, value] of Object.entries(scores)) {
    if (value > best || bestSignal === '') {
      best = value;
      bestSignal = name;
    }
  }
  return { best, bestSignal };
}

// ── Text Recipe ─────────────────────────────────────────────────────────────

export interface TextRecipe {
  /** Axis name for this recipe (e.g. 'filename', 'segment'). */
  axis: string;
  /** Signals to run against each candidate. */
  signals: TextSignal[];
  /** How to combine signal scores. Defaults to fuseMax. */
  fuse?: FuseFn;
}

/**
 * Run a text recipe against a single candidate.
 * Each signal is evaluated with the (query, candidate) pair, then fused.
 */
export function runTextRecipe(recipe: TextRecipe, query: string, candidate: string): FusedScore {
  const signals: SignalScores = {};
  for (const signal of recipe.signals) {
    signals[signal.name] = signal.score(query, candidate);
  }
  const fuse = recipe.fuse ?? fuseMax;
  const { best, bestSignal } = fuse(signals);
  return { best, bestSignal, signals };
}

// ── Chunk Recipe ────────────────────────────────────────────────────────────

export interface ChunkRecipe {
  /** Axis name (e.g. 'content'). */
  axis: string;
  /** Signal names whose per-chunk maps are provided externally. */
  signalNames: string[];
  /** How to combine signal scores. Defaults to fuseMax. */
  fuse?: FuseFn;
}

/**
 * Fuse pre-computed per-chunk signal scores into a FusedScore.
 *
 * signalMaps is a record of signalName → Map<chunkId, score>.
 * Each chunk gets a FusedScore by looking up its score in each signal map.
 */
export function fuseChunkScores(
  recipe: ChunkRecipe,
  signalMaps: Record<string, Map<number, number>>,
  chunkId: number,
): FusedScore {
  const signals: SignalScores = {};
  for (const name of recipe.signalNames) {
    signals[name] = signalMaps[name]?.get(chunkId) ?? 0;
  }
  const fuse = recipe.fuse ?? fuseMax;
  const { best, bestSignal } = fuse(signals);
  return { best, bestSignal, signals };
}

// ── Pre-built Recipes ───────────────────────────────────────────────────────

/** Filename axis: Levenshtein + token coverage. */
export const FILENAME_RECIPE: TextRecipe = {
  axis: 'filename',
  signals: [levenshteinSimilarity, tokenCoverage],
};

/** Directory name axis: Levenshtein + token coverage (same signals, different axis label). */
export const DIRECTORY_NAME_RECIPE: TextRecipe = {
  axis: 'segment',
  signals: [levenshteinSimilarity, tokenCoverage],
};

/** Content axis: semantic (cosine) + BM25. */
export const CONTENT_RECIPE: ChunkRecipe = {
  axis: 'content',
  signalNames: ['semantic', 'bm25'],
};
