/**
 * Filepath signal — path-segment scoring via decaying sum.
 *
 * Scores each segment of a file's path against the query, then combines
 * segment scores using the decaying sum. This replaces the old filename-axis
 * recipe (Levenshtein + token coverage on basename only) with a full-path
 * approach where directory names contribute to ranking.
 *
 * The same decaying sum mechanism is used fractally:
 *   - Here: across path segments within a single file
 *   - In the search runner: across signals for a single file
 */

import type { Signal, SignalContext, SignalResult } from './signal';
import { extractRelPath } from '../store/paths';
import { levenshteinSimilarity, tokenCoverage } from './text-signals';
import { decayingSum } from './decaying-sum';

/** Minimum max-segment score for a file to pass the prefilter. */
const SEGMENT_THRESHOLD = 0.4;

export const filepathSignal: Signal = {
  name: 'filepath',

  scoreAll(ctx: SignalContext): SignalResult {
    const scores = new Map<string, number>();
    // Filepath matches produce no chunk hints — the path *is* the hint.
    const hints = new Map<string, import('./signal').SignalHint>();

    const queryLower = ctx.query.toLowerCase().trim();
    if (queryLower.length === 0) return { scores, hints };

    // ── Scan all files ─────────────────────────────────────────────────
    const allFiles = ctx.db.prepare(
      `SELECT stored_key FROM files`,
    ).all() as Array<{ stored_key: string }>;

    for (const { stored_key } of allFiles) {
      // Apply filters
      if (ctx.startPath && !stored_key.startsWith(ctx.startPath)) continue;
      if (ctx.filePatternRe && !ctx.filePatternRe.test(extractRelPath(stored_key))) continue;

      const relPath = extractRelPath(stored_key);
      const segments = relPath.split('/').filter(Boolean);
      if (segments.length === 0) continue;

      // Score each segment — strip extension from the last one
      const segmentScores: number[] = [];
      let maxSegmentScore = 0;

      for (let i = 0; i < segments.length; i++) {
        let segment = segments[i].toLowerCase();
        // Strip extension from filename (last segment)
        if (i === segments.length - 1) {
          const dot = segment.lastIndexOf('.');
          if (dot > 0) segment = segment.slice(0, dot);
        }

        // Score as max(tokenCoverage, levenshtein) — tokenCoverage handles
        // multi-word queries well, levenshtein handles single-term fuzzy matching
        const tc = tokenCoverage.score(queryLower, segment);
        const lev = levenshteinSimilarity.score(queryLower, segment);
        const segScore = Math.max(tc, lev);

        segmentScores.push(segScore);
        if (segScore > maxSegmentScore) maxSegmentScore = segScore;
      }

      // Prefilter: skip if no segment scored above threshold
      if (maxSegmentScore < SEGMENT_THRESHOLD) continue;

      const fileScore = decayingSum(segmentScores);
      if (fileScore > 0) {
        scores.set(stored_key, fileScore);
      }
    }

    return { scores, hints };
  },
};
