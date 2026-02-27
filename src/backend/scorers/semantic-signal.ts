/**
 * Semantic signal — cosine similarity via sqlite-vec.
 *
 * Runs a KNN query against the vec_chunks virtual table, then aggregates
 * chunk-level cosine similarities to file-level scores (max per file).
 * Tracks the best-matching chunk per file for the hint.
 */

import type { Signal, SignalContext, SignalResult, SignalHint } from './signal';
import { extractRelPath, float32Buffer, fetchChunkMeta } from '../store';

/** Fan-out factor: query more chunks than needed to ensure coverage. */
const CHUNK_FANOUT = 5;

export const semanticSignal: Signal = {
  name: 'semantic',

  scoreAll(ctx: SignalContext): SignalResult {
    const scores = new Map<string, number>();
    const hints = new Map<string, SignalHint>();

    if (ctx.queryVector.length === 0) return { scores, hints };

    const chunkLimit = ctx.maxResults * CHUNK_FANOUT;

    // ── KNN vector search ──────────────────────────────────────────────
    const vecRows = ctx.db.prepare(`
      SELECT v.rowid, v.distance
      FROM vec_chunks v
      WHERE v.embedding MATCH ?
        AND k = ?
      ORDER BY v.distance
    `).all(float32Buffer(ctx.queryVector), chunkLimit) as Array<{
      rowid: number;
      distance: number;
    }>;

    if (vecRows.length === 0) return { scores, hints };

    // Convert distance → cosine similarity [0, 1]
    const chunkSims = new Map<number, number>();
    const chunkIds = new Set<number>();
    for (const row of vecRows) {
      const sim = 1 - row.distance / 2;
      chunkSims.set(row.rowid, sim);
      chunkIds.add(row.rowid);
    }

    // ── Fetch chunk metadata ───────────────────────────────────────────
    const chunkMeta = fetchChunkMeta(ctx.db, chunkIds);

    // ── Aggregate to file level ────────────────────────────────────────
    // Track best chunk per file for hints
    const bestChunk = new Map<string, { sim: number; meta: typeof chunkMeta extends Map<number, infer V> ? V : never }>();

    for (const [chunkId, sim] of chunkSims) {
      const meta = chunkMeta.get(chunkId);
      if (!meta) continue;

      // Apply filters
      if (ctx.startPath && !meta.file_path.startsWith(ctx.startPath)) continue;
      if (ctx.filePatternRe && !ctx.filePatternRe.test(extractRelPath(meta.file_path))) continue;

      const existing = bestChunk.get(meta.file_path);
      if (!existing || sim > existing.sim) {
        bestChunk.set(meta.file_path, { sim, meta });
      }
    }

    // Build output maps
    for (const [filePath, { sim, meta }] of bestChunk) {
      scores.set(filePath, sim);
      hints.set(filePath, {
        locationHint: meta.location_hint ? JSON.parse(meta.location_hint) : null,
        sectionPath: JSON.parse(meta.section_path),
      });
    }

    return { scores, hints };
  },
};
