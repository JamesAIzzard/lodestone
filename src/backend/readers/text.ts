/**
 * Text reader — retrieves content from text-based files by line range.
 *
 * Handles markdown, code, and plaintext files. Reads the raw file directly
 * (not through the extractor) because all text extractors preserve raw-file
 * coordinates, so line numbers in LocationHints map 1:1 to raw file lines.
 */

import fs from 'node:fs';
import type { LocationHint } from '../../shared/types';

/**
 * Read content from a text file, optionally restricted to a line range.
 *
 * - `null` hint → full file content
 * - `{ type: 'lines' }` → slice by 1-indexed line range
 * - Other hint types → fall back to full file
 */
export function readTextLines(filePath: string, hint: LocationHint): string {
  const body = fs.readFileSync(filePath, 'utf-8');
  if (!hint || hint.type !== 'lines') return body;

  const allLines = body.split('\n');
  const start = hint.start - 1;  // convert 1-indexed to 0-indexed
  const end = hint.end;          // slice end is exclusive; hint.end is inclusive
  return allLines.slice(start, end).join('\n');
}
