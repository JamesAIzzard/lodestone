/**
 * Regex signal — full-table scan with JS RegExp.
 *
 * Binary match/no-match: all matching files receive score 1.0.
 * Scans chunk text and file paths. Tracks the first matching chunk
 * per file for the hint.
 */

import type { Signal, SignalContext, SignalResult, SignalHint } from './signal';
import { extractRelPath } from '../store';

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
      SELECT c.id, c.file_path, c.section_path, c.start_line, c.end_line, c.text
      FROM chunks c
    `).all() as Array<{
      id: number;
      file_path: string;
      section_path: string;
      start_line: number;
      end_line: number;
      text: string;
    }>;

    for (const row of rows) {
      if (ctx.startPath && !row.file_path.startsWith(ctx.startPath)) continue;
      if (ctx.filePatternRe && !ctx.filePatternRe.test(extractRelPath(row.file_path))) continue;
      if (!re.test(row.text)) continue;

      // Only record the first matching chunk per file (for hint)
      if (!scores.has(row.file_path)) {
        scores.set(row.file_path, 1.0);
        hints.set(row.file_path, {
          startLine: row.start_line,
          endLine: row.end_line,
          sectionPath: JSON.parse(row.section_path),
        });
      }
    }

    // ── Pass 2: scan file paths ──────────────────────────────────────
    const allFiles = ctx.db.prepare(`SELECT file_path FROM files`).all() as Array<{ file_path: string }>;
    for (const { file_path } of allFiles) {
      if (scores.has(file_path)) continue; // already matched by content
      if (ctx.startPath && !file_path.startsWith(ctx.startPath)) continue;
      if (ctx.filePatternRe && !ctx.filePatternRe.test(extractRelPath(file_path))) continue;
      if (re.test(extractRelPath(file_path))) {
        scores.set(file_path, 1.0);
        // No chunk hint for path-only matches
      }
    }

    return { scores, hints };
  },
};
