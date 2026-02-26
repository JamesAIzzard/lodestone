/**
 * Scoring recipes — declarative composition of text signals into fused scores.
 *
 * A TextRecipe declares which TextSignal functions to run against a
 * candidate string and how to combine their individual [0,1] scores into
 * a single FusedScore.
 *
 * Currently used only by the directory-search pipeline (segment scoring).
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
  /** Axis name for this recipe (e.g. 'segment'). */
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

// ── Pre-built Recipes ───────────────────────────────────────────────────────

/** Directory name axis: Levenshtein + token coverage. */
export const DIRECTORY_NAME_RECIPE: TextRecipe = {
  axis: 'segment',
  signals: [levenshteinSimilarity, tokenCoverage],
};
