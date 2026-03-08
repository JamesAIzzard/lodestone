/**
 * Decaying sum — universal composition mechanism for Lodestone search.
 *
 * Given a sorted (descending) list of scores, the combined score is:
 *
 *   score = s₁ + d·s₂ + d²·s₃ + d³·s₄ + …
 *
 * Where d is the damping factor (default 0.25). Each additional contribution
 * is worth a quarter of the previous one. The result is clamped to [0, 1].
 *
 * Applied fractally:
 *   - Within the filepath signal (path segments combined)
 *   - Across all signals (convergence boosting)
 */

/** Default damping factor — second signal contributes 25% of its score. */
export const DEFAULT_DAMPING = 0.25;

/**
 * Minimum bonus (above the base max) for a result to be labelled "convergence"
 * rather than the dominant signal name.
 */
const CONVERGENCE_THRESHOLD = 0.02;

/**
 * Compute the decaying sum of a set of scores.
 *
 * Sorts descending internally, so caller order doesn't matter.
 * Returns a value in [0, 1].
 */
export function decayingSum(scores: number[], d: number = DEFAULT_DAMPING): number {
  if (scores.length === 0) return 0;
  if (scores.length === 1) return Math.min(scores[0], 1);

  const sorted = [...scores].sort((a, b) => b - a);
  let result = 0;
  let weight = 1;
  for (const s of sorted) {
    result += weight * s;
    weight *= d;
  }
  return Math.min(result, 1);
}

// ── Summary ──────────────────────────────────────────────────────────────────

/** Describes the outcome of a decaying sum composition. */
export interface DecaySummary {
  /**
   * Human-readable label:
   *   - A signal name (e.g. "semantic") when one signal dominates
   *   - "convergence" when multiple signals contributed meaningfully
   */
  label: string;
  /** Sorted (descending) entries: [signalName, rawScore][]. */
  breakdown: [string, number][];
  /** The decaying-sum result [0, 1]. */
  score: number;
}

/**
 * Compute a decaying sum from named signal scores and produce a human-readable
 * summary describing whether one signal dominated or convergence occurred.
 */
export function summariseDecay(
  signalScores: Record<string, number>,
  d: number = DEFAULT_DAMPING,
): DecaySummary {
  const entries = Object.entries(signalScores)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]) as [string, number][];

  if (entries.length === 0) {
    return { label: 'none', breakdown: [], score: 0 };
  }

  const scores = entries.map(([, v]) => v);
  const score = decayingSum(scores, d);

  // If the bonus from secondary signals is negligible, report the dominant signal.
  if (entries.length === 1 || score - entries[0][1] < CONVERGENCE_THRESHOLD) {
    return { label: entries[0][0], breakdown: entries, score };
  }

  return { label: 'convergence', breakdown: entries, score };
}
