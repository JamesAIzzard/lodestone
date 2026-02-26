/**
 * Text signals — pure (query, candidate) → score functions.
 *
 * Each signal is a stateless TextSignal object that can be composed into
 * recipes for different scoring axes (filename, directory name, etc.).
 *
 * All scores are normalised to [0,1].
 */

import { tokenise } from '../tokeniser';

// ── Signal Interface ────────────────────────────────────────────────────────

export interface TextSignal {
  /** Unique signal name (appears in FusedScore.signals and UI labels). */
  name: string;
  /** Pure scoring function: (query, candidate) → [0,1]. */
  score(query: string, candidate: string): number;
}

// ── Utility Functions ───────────────────────────────────────────────────────

/**
 * Generate character trigrams from a string.
 * e.g. "store" → {"sto", "tor", "ore"}
 */
export function computeTrigrams(s: string): Set<string> {
  const trigrams = new Set<string>();
  for (let i = 0; i <= s.length - 3; i++) {
    trigrams.add(s.slice(i, i + 3));
  }
  return trigrams;
}

/**
 * Compute Jaccard similarity between two sets: |A ∩ B| / |A ∪ B|.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  for (const item of smaller) {
    if (larger.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Compute the Levenshtein edit distance between two strings.
 * O(m*n) time and O(min(m,n)) space — fine for short strings (filenames).
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure a is the shorter string for O(min(m,n)) space
  if (a.length > b.length) {
    [a, b] = [b, a];
  }

  const m = a.length;
  const n = b.length;

  // Single-row DP: prev[j] holds the distance for (i-1, j)
  let prev = new Array<number>(m + 1);
  let curr = new Array<number>(m + 1);

  for (let j = 0; j <= m; j++) prev[j] = j;

  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[j - 1] === b[i - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,       // deletion
        curr[j - 1] + 1,   // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[m];
}

// ── Signal Definitions ──────────────────────────────────────────────────────

/**
 * Levenshtein similarity: 1 - editDistance / max(|query|, |candidate|).
 * Best for queries that approximate the full candidate string.
 */
export const levenshteinSimilarity: TextSignal = {
  name: 'levenshtein',
  score(query: string, candidate: string): number {
    const maxLen = Math.max(query.length, candidate.length);
    if (maxLen === 0) return 1.0;
    const dist = levenshteinDistance(query, candidate);
    return 1 - dist / maxLen;
  },
};

/**
 * Token coverage: fraction of query tokens that appear in the candidate.
 * Immune to the length asymmetry that penalises Levenshtein when the query
 * is a short subset of a long candidate.
 */
export const tokenCoverage: TextSignal = {
  name: 'tokenCoverage',
  score(query: string, candidate: string): number {
    const queryTokens = tokenise(query);
    if (queryTokens.length === 0) return 0;
    const candidateTokenSet = new Set(tokenise(candidate));
    let matched = 0;
    for (const qt of queryTokens) {
      if (candidateTokenSet.has(qt)) matched++;
    }
    return matched / queryTokens.length;
  },
};
