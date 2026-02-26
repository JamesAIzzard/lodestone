/**
 * Filename axis scorer — recipe-based pipeline.
 *
 * Runs the FILENAME_RECIPE (Levenshtein + token coverage) against every
 * file basename in the silo, with a trigram Jaccard + token coverage
 * prefilter to skip obvious non-matches.
 *
 * File tables are small enough (thousands of rows) that scanning all
 * basenames is fast — no FTS5 prefilter needed.
 */

import type { SiloDatabase } from '../store';
import type { FusedScore } from '../../shared/types';
import { computeTrigrams, jaccardSimilarity, tokenCoverage as tokenCoverageSignal } from './text-signals';
import { runTextRecipe, FILENAME_RECIPE } from './recipes';

// ── Constants ────────────────────────────────────────────────────────────────

/** Minimum Jaccard similarity for the fuzzy-match prefilter. */
const JACCARD_THRESHOLD = 0.2;

/**
 * Minimum token coverage to pass the partial-match prefilter.
 * 0.4 requires at least 2 of 4 (or 1 of 2) query tokens to appear in the
 * filename — low enough to catch real partial titles, high enough to filter
 * noise from ubiquitous stopwords like "and"/"of" appearing alone.
 */
const TOKEN_COVERAGE_THRESHOLD = 0.4;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Score filenames against a query using the FILENAME_RECIPE.
 *
 * Prefilter: a candidate passes if jaccard ≥ JACCARD_THRESHOLD OR
 *   tokenCoverage ≥ TOKEN_COVERAGE_THRESHOLD.
 *
 * @param db     Silo database handle.
 * @param query  Raw search query string.
 * @returns Map from stored file_path to FusedScore.
 */
export function scoreFilenames(
  db: SiloDatabase,
  query: string,
): Map<string, FusedScore> {
  const results = new Map<string, FusedScore>();
  const queryLower = query.toLowerCase().trim();
  if (queryLower.length === 0) return results;

  const queryTrigrams = computeTrigrams(queryLower);

  // Scan all files — file tables are small enough that computing both
  // prefilter signals against every basename is fast.
  const allFiles = db.prepare(
    `SELECT file_path, file_name FROM files`,
  ).all() as Array<{ file_path: string; file_name: string }>;

  for (const { file_path, file_name } of allFiles) {
    // Strip extension before scoring — users search for document names, not ".md"
    const nameLower = stripExtension(file_name).toLowerCase();

    // ── Prefilter: cheap checks to skip obvious non-matches ──────────────

    // Token coverage is the cheaper O(tokens) check
    const quickTokenCoverage = tokenCoverageSignal.score(queryLower, nameLower);

    // Jaccard on trigrams
    const candidateTrigrams = computeTrigrams(nameLower);
    const jaccard = candidateTrigrams.size > 0
      ? jaccardSimilarity(queryTrigrams, candidateTrigrams)
      : 0;

    // Pass if either signal indicates a plausible match
    if (jaccard < JACCARD_THRESHOLD && quickTokenCoverage < TOKEN_COVERAGE_THRESHOLD) continue;

    // ── Full recipe scoring ──────────────────────────────────────────────
    const fusedScore = runTextRecipe(FILENAME_RECIPE, queryLower, nameLower);
    results.set(file_path, fusedScore);
  }

  return results;
}

// ── Utility ──────────────────────────────────────────────────────────────────

/** Remove the file extension from a filename (e.g. "foo.md" → "foo"). */
function stripExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}
