/**
 * Plaintext chunker — splits text on paragraph and sentence boundaries.
 *
 * Suitable for unstructured text files (.txt), source code, and any format
 * where heading-based splitting doesn't apply. Uses the filename as the
 * section path for all chunks.
 */

import type { ExtractionResult, ChunkRecord } from '../pipeline-types';
import { estimateTokens, hashText, subSplitText, mergeUpTo } from '../chunk-utils';

/**
 * Chunk extracted text by paragraph boundaries.
 *
 * Splits on blank lines, then greedily merges paragraphs up to the token limit.
 * Oversized paragraphs are further split on sentence boundaries.
 */
export function chunkPlaintext(
  filePath: string,
  extraction: ExtractionResult,
  maxChunkTokens: number,
): ChunkRecord[] {
  const { body, metadata, metadataLineCount } = extraction;

  if (body.length === 0) {
    return [];
  }

  const filename = filePath.split(/[/\\]/).pop() ?? filePath;

  // If the whole file fits in one chunk, return it directly
  if (estimateTokens(body) <= maxChunkTokens) {
    const lineCount = body.split('\n').length;
    return [{
      filePath,
      chunkIndex: 0,
      sectionPath: [filename],
      text: body,
      startLine: 1 + metadataLineCount,
      endLine: lineCount + metadataLineCount,
      metadata,
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

  // Build ChunkRecords with approximate line numbers
  const chunks: ChunkRecord[] = [];
  let lineOffset = 1 + metadataLineCount;

  for (const text of segments) {
    const lineCount = text.split('\n').length;
    chunks.push({
      filePath,
      chunkIndex: chunks.length,
      sectionPath: [filename],
      text,
      startLine: lineOffset,
      endLine: lineOffset + lineCount - 1,
      metadata,
      contentHash: hashText(text),
    });
    // Advance by lines used + blank line separator
    lineOffset += lineCount + 1;
  }

  return chunks;
}
