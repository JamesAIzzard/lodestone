/**
 * Semantic signal — cosine similarity via sqlite-vec.
 *
 * Runs a KNN query against the vec_chunks virtual table (configured with
 * distance_metric=cosine), then aggregates chunk-level cosine similarities
 * to file-level scores (max per file).
 * Tracks the best-matching chunk per file for the hint.
 */

import type { Signal, SignalContext, SignalResult, SignalHint } from './signal';
import { extractRelPath } from '../store/paths';
import { quantizeInt8 } from '../store/compression';
import { fetchChunkMeta } from '../store/operations';

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
    const quantized = quantizeInt8(ctx.queryVector);

    let vecRows: Array<{ rowid: number; distance: number }>;
    try {
      vecRows = ctx.db.prepare(`
        SELECT v.rowid, v.distance
        FROM vec_chunks v
        WHERE v.embedding MATCH vec_int8(?)
          AND k = ?
        ORDER BY v.distance
      `).all(quantized, chunkLimit) as Array<{
        rowid: number;
        distance: number;
      }>;
    } catch (err) {
      console.error('[semantic-signal] KNN MATCH error:', err);
      return { scores, hints };
    }

    if (vecRows.length === 0) return { scores, hints };

    // vec_chunks uses distance_metric=cosine, so distance is cosine distance
    // in [0, 2].  Cosine similarity = 1 - cosine_distance, clamped to [0, 1].
    const chunkSims = new Map<number, number>();
    const chunkIds = new Set<number>();
    for (const row of vecRows) {
      const sim = Math.max(0, 1 - row.distance);
      chunkSims.set(row.rowid, sim);
      chunkIds.add(row.rowid);
    }

    // ── Fetch chunk metadata ───────────────────────────────────────────
    const chunkMeta = fetchChunkMeta(ctx.db, chunkIds);

    // ── Aggregate to file level ────────────────────────────────────────
    type ChunkEntry = { sim: number; meta: typeof chunkMeta extends Map<number, infer V> ? V : never };
    const fileChunks = new Map<string, ChunkEntry[]>();

    for (const [chunkId, sim] of chunkSims) {
      const meta = chunkMeta.get(chunkId);
      if (!meta) continue;

      // Apply filters
      if (ctx.startPath && !meta.stored_key.startsWith(ctx.startPath)) continue;
      if (ctx.filePatternRe && !ctx.filePatternRe.test(extractRelPath(meta.stored_key))) continue;

      const arr = fileChunks.get(meta.stored_key);
      if (arr) {
        arr.push({ sim, meta });
      } else {
        fileChunks.set(meta.stored_key, [{ sim, meta }]);
      }
    }

    // Build output maps
    const allHints = new Map<string, SignalHint[]>();

    for (const [filePath, chunks] of fileChunks) {
      // Sort descending by similarity
      chunks.sort((a, b) => b.sim - a.sim);

      const best = chunks[0];
      scores.set(filePath, best.sim);
      hints.set(filePath, {
        locationHint: best.meta.location_hint ? JSON.parse(best.meta.location_hint) : null,
        sectionPath: JSON.parse(best.meta.section_path),
      });

      // Collect all chunk hints with scores
      allHints.set(filePath, chunks.map(({ sim, meta }) => ({
        locationHint: meta.location_hint ? JSON.parse(meta.location_hint) : null,
        sectionPath: JSON.parse(meta.section_path),
        score: sim,
      })));
    }

    return { scores, hints, allHints };
  },
};
