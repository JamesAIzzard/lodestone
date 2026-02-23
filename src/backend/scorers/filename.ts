/**
 * Filename axis scorer: trigram Jaccard filter + Levenshtein similarity.
 *
 * Two-stage pipeline:
 *   1. Scan all files in the silo, compute trigram Jaccard similarity between
 *      the query and each basename, filtering out candidates below the
 *      threshold (0.2).
 *   2. Score remaining candidates with normalised Levenshtein distance against
 *      the basename (file_name), producing a [0,1] score per file.
 *
 * File tables are small enough (thousands of rows) that scanning all basenames
 * with trigram Jaccard is fast — no FTS5 prefilter needed. This ensures fuzzy
 * matches are never missed (e.g. "classsical mechnics" → "Classical Mechanics.md").
 */

import type { SiloDatabase } from '../store';

// ── Constants ────────────────────────────────────────────────────────────────

/** Minimum Jaccard similarity to pass the prefilter. */
const JACCARD_THRESHOLD = 0.2;

// ── Types ────────────────────────────────────────────────────────────────────

export interface FilenameScore {
  /** Normalised Levenshtein similarity in [0, 1]. */
  score: number;
  /** Raw Levenshtein edit distance. */
  levenshtein: number;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Score filenames against a query using trigram Jaccard + Levenshtein.
 *
 * @param db     Silo database handle.
 * @param query  Raw search query string.
 * @returns Map from stored file_path to filename score.
 */
export function scoreFilenames(
  db: SiloDatabase,
  query: string,
): Map<string, FilenameScore> {
  const results = new Map<string, FilenameScore>();
  const queryLower = query.toLowerCase().trim();
  if (queryLower.length === 0) return results;

  const queryTrigrams = computeTrigrams(queryLower);
  if (queryTrigrams.size === 0) return results;

  // Scan all files — file tables are small enough (thousands of rows) that
  // computing trigram Jaccard against every basename is fast.
  const allFiles = db.prepare(
    `SELECT file_path, file_name FROM files`,
  ).all() as Array<{ file_path: string; file_name: string }>;

  for (const { file_path, file_name } of allFiles) {
    // Strip extension before scoring — users search for document names, not ".md"
    const nameLower = stripExtension(file_name).toLowerCase();
    const candidateTrigrams = computeTrigrams(nameLower);

    if (candidateTrigrams.size === 0) continue;
    const jaccard = jaccardSimilarity(queryTrigrams, candidateTrigrams);
    if (jaccard < JACCARD_THRESHOLD) continue;

    const dist = levenshteinDistance(queryLower, nameLower);
    const maxLen = Math.max(queryLower.length, nameLower.length);
    const score = maxLen === 0 ? 1.0 : 1 - dist / maxLen;

    results.set(file_path, { score, levenshtein: dist });
  }

  return results;
}

// ── Utility Functions ────────────────────────────────────────────────────────

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

/** Remove the file extension from a filename (e.g. "foo.md" → "foo"). */
function stripExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}

