/**
 * Plaintext chunker — splits text on paragraph and sentence boundaries.
 *
 * Suitable for unstructured text files (.txt), source code, and any format
 * where heading-based splitting doesn't apply. Uses the filename as the
 * section path for all chunks.
 */

import type { ExtractionResult, FileInfo, ChunkOutput } from '../pipeline-types';
import { estimateTokens, hashText, subSplitText, mergeUpTo } from '../chunk-utils';

/**
 * Chunk extracted text by paragraph boundaries.
 *
 * Splits on blank lines, then greedily merges paragraphs up to the token limit.
 * Oversized paragraphs are further split on sentence boundaries.
 */
export function chunkPlaintext(
  extraction: ExtractionResult,
  fileInfo: FileInfo,
  maxChunkTokens: number,
): ChunkOutput[] {
  const { body } = extraction;

  if (body.length === 0) {
    return [];
  }

  const { basename } = fileInfo;

  // If the whole file fits in one chunk, return it directly
  if (estimateTokens(body) <= maxChunkTokens) {
    const lineCount = body.split('\n').length;
    return [{
      chunkIndex: 0,
      sectionPath: [basename],
      text: body,
      locationHint: { type: 'lines', start: 1, end: lineCount },
      contentHash: hashText(body),
    }];
  }

  // Split into paragraphs and merge greedily
  const paragraphs = body.split(/\n\n+/);
  const merged = mergeUpTo(paragraphs, maxChunkTokens, '\n\n');

  // Sub-split any still-oversized chunks on sentence boundaries
  const segments: string[] = [];
  for (const chunk of merged) {
    if (estimateTokens(chunk) <= maxChunkTokens) {
      segments.push(chunk);
    } else {
      segments.push(...subSplitText(chunk, maxChunkTokens));
    }
  }

  // Build ChunkOutputs with approximate line numbers
  const chunks: ChunkOutput[] = [];
  let lineOffset = 1;

  for (const text of segments) {
    const lineCount = text.split('\n').length;
    chunks.push({
      chunkIndex: chunks.length,
      sectionPath: [basename],
      text,
      locationHint: { type: 'lines', start: lineOffset, end: lineOffset + lineCount - 1 },
      contentHash: hashText(text),
    });
    // Advance by lines used + blank line separator
    lineOffset += lineCount + 1;
  }

  return chunks;
}
