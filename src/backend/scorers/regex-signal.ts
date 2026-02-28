/**
 * Regex signal — full-table scan with JS RegExp.
 *
 * Binary match/no-match: all matching files receive score 1.0.
 * Scans chunk text and file paths. Collects all matching chunks
 * per file for multi-chunk hints.
 *
 * V2: chunk text is stored as a zlib-compressed BLOB, so we decompress
 * each chunk before applying the regex. The file path is resolved via
 * a JOIN through the files table (chunks have file_id FK, not file_path).
 */

import type { Signal, SignalContext, SignalResult, SignalHint } from './signal';
import { extractRelPath } from '../store/paths';
import { decompressText } from '../store/compression';

export const regexSignal: Signal = {
  name: 'regex',

  scoreAll(ctx: SignalContext): SignalResult {
    const scores = new Map<string, number>();
    const hints = new Map<string, SignalHint>();

    const flags = ctx.regexFlags ?? 'i';
    let re: RegExp;
    try {
      re = new RegExp(ctx.query, flags);
    } catch {
      return { scores, hints };
    }

    // ── Pass 1: scan chunk text ──────────────────────────────────────
    const rows = ctx.db.prepare(`
      SELECT c.id, f.stored_key, c.section_path, c.location_hint, c.text
      FROM chunks c
      JOIN files f ON f.id = c.file_id
    `).all() as Array<{
      id: number;
      stored_key: string;
      section_path: string;
      location_hint: string | null;
      text: Buffer;
    }>;

    // Collect all matching chunks per file for multi-chunk hints
    const fileChunks = new Map<string, SignalHint[]>();

    for (const row of rows) {
      if (ctx.startPath && !row.stored_key.startsWith(ctx.startPath)) continue;
      if (ctx.filePatternRe && !ctx.filePatternRe.test(extractRelPath(row.stored_key))) continue;

      // Decompress zlib BLOB to string for regex matching
      const text = decompressText(row.text);
      if (!re.test(text)) continue;

      const hint: SignalHint = {
        locationHint: row.location_hint ? JSON.parse(row.location_hint) : null,
        sectionPath: JSON.parse(row.section_path),
        score: 1.0,
      };

      scores.set(row.stored_key, 1.0);

      // Best hint: keep the first match
      if (!hints.has(row.stored_key)) {
        hints.set(row.stored_key, hint);
      }

      // All hints: collect every match
      const arr = fileChunks.get(row.stored_key);
      if (arr) {
        arr.push(hint);
      } else {
        fileChunks.set(row.stored_key, [hint]);
      }
    }

    // ── Pass 2: scan file paths ──────────────────────────────────────
    const allFiles = ctx.db.prepare(`SELECT stored_key FROM files`).all() as Array<{ stored_key: string }>;
    for (const { stored_key } of allFiles) {
      if (scores.has(stored_key)) continue; // already matched by content
      if (ctx.startPath && !stored_key.startsWith(ctx.startPath)) continue;
      if (ctx.filePatternRe && !ctx.filePatternRe.test(extractRelPath(stored_key))) continue;
      if (re.test(extractRelPath(stored_key))) {
        scores.set(stored_key, 1.0);
        // No chunk hint for path-only matches
      }
    }

    // Build allHints from collected chunks (only for content matches)
    const allHints = fileChunks.size > 0 ? fileChunks : undefined;

    return { scores, hints, allHints };
  },
};
