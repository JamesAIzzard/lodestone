/**
 * BM25 signal — keyword-based chunk scoring.
 *
 * Reuses the existing scoreBm25() function from bm25.ts, then aggregates
 * chunk-level BM25 scores to file-level scores (max per file).
 * Tracks the best-matching chunk per file for the hint.
 */

import type { Signal, SignalContext, SignalResult, SignalHint } from './signal';
import type { ChunkMeta } from '../store';
import { extractRelPath, fetchChunkMeta } from '../store';
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
    const bestChunk = new Map<string, { score: number; meta: ChunkMeta }>();

    for (const [chunkId, bm25Result] of bm25Scores) {
      const meta = chunkMeta.get(chunkId);
      if (!meta) continue;

      // Apply filters
      if (ctx.startPath && !meta.file_path.startsWith(ctx.startPath)) continue;
      if (ctx.filePatternRe && !ctx.filePatternRe.test(extractRelPath(meta.file_path))) continue;

      const existing = bestChunk.get(meta.file_path);
      if (!existing || bm25Result.score > existing.score) {
        bestChunk.set(meta.file_path, { score: bm25Result.score, meta });
      }
    }

    // Build output maps
    for (const [filePath, { score, meta }] of bestChunk) {
      scores.set(filePath, score);
      hints.set(filePath, {
        startLine: meta.start_line,
        endLine: meta.end_line,
        sectionPath: JSON.parse(meta.section_path),
      });
    }

    return { scores, hints };
  },
};
