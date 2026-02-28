/**
 * BM25 signal — keyword-based chunk scoring.
 *
 * Reuses the existing scoreBm25() function from bm25.ts, then aggregates
 * chunk-level BM25 scores to file-level scores (max per file).
 * Tracks the best-matching chunk per file for the hint.
 */

import type { Signal, SignalContext, SignalResult, SignalHint } from './signal';
import type { ChunkMeta } from '../store/types';
import { extractRelPath } from '../store/paths';
import { fetchChunkMeta } from '../store/operations';
import { scoreBm25 } from './bm25';

export const bm25Signal: Signal = {
  name: 'bm25',

  scoreAll(ctx: SignalContext): SignalResult {
    const scores = new Map<string, number>();
    const hints = new Map<string, SignalHint>();

    if (ctx.queryTokens.length === 0) return { scores, hints };

    // ── Run BM25 scoring (chunk-level) ─────────────────────────────────
    const bm25Scores = scoreBm25(ctx.db, ctx.queryTokens);
    if (bm25Scores.size === 0) return { scores, hints };

    // ── Fetch chunk metadata ───────────────────────────────────────────
    const chunkIds = new Set(bm25Scores.keys());
    const chunkMeta = fetchChunkMeta(ctx.db, chunkIds);

    // ── Aggregate to file level ────────────────────────────────────────
    const fileChunks = new Map<string, Array<{ score: number; meta: ChunkMeta }>>();

    for (const [chunkId, bm25Result] of bm25Scores) {
      const meta = chunkMeta.get(chunkId);
      if (!meta) continue;

      // Apply filters
      if (ctx.startPath && !meta.stored_key.startsWith(ctx.startPath)) continue;
      if (ctx.filePatternRe && !ctx.filePatternRe.test(extractRelPath(meta.stored_key))) continue;

      const arr = fileChunks.get(meta.stored_key);
      if (arr) {
        arr.push({ score: bm25Result.score, meta });
      } else {
        fileChunks.set(meta.stored_key, [{ score: bm25Result.score, meta }]);
      }
    }

    // Build output maps
    const allHints = new Map<string, SignalHint[]>();

    for (const [filePath, chunks] of fileChunks) {
      // Sort descending by score
      chunks.sort((a, b) => b.score - a.score);

      const best = chunks[0];
      scores.set(filePath, best.score);
      hints.set(filePath, {
        locationHint: best.meta.location_hint ? JSON.parse(best.meta.location_hint) : null,
        sectionPath: JSON.parse(best.meta.section_path),
      });

      // Collect all chunk hints with scores
      allHints.set(filePath, chunks.map(({ score, meta }) => ({
        locationHint: meta.location_hint ? JSON.parse(meta.location_hint) : null,
        sectionPath: JSON.parse(meta.section_path),
        score,
      })));
    }

    return { scores, hints, allHints };
  },
};
