/**
 * PDF chunker — splits PDF content into page-based chunks.
 *
 * Iterates the per-page texts stored in `metadata.pageTexts` by the PDF
 * extractor. Each page is sub-chunked using the plaintext paragraph splitter
 * when it exceeds the token limit. The locationHint for every chunk is a
 * page reference rather than a line range.
 */

import type { ExtractionResult, ChunkRecord } from '../pipeline-types';
import { chunkPlaintext } from './plaintext';

/**
 * Chunk PDF extraction result into page-based ChunkRecords.
 *
 * Uses plaintext paragraph splitting for oversized pages, then replaces
 * the line-based locationHint with `{ type: 'page', page: N }`.
 */
export function chunkPdf(
  filePath: string,
  extraction: ExtractionResult,
  maxChunkTokens: number,
): ChunkRecord[] {
  const pageTexts = extraction.metadata.pageTexts as string[];
  const chunks: ChunkRecord[] = [];

  for (let i = 0; i < pageTexts.length; i++) {
    const pageText = pageTexts[i]?.trim();
    if (!pageText) continue;

    // Reuse plaintext paragraph splitting for oversized pages
    const sub = chunkPlaintext(
      filePath,
      { body: pageText, metadata: extraction.metadata },
      maxChunkTokens,
    );

    for (const c of sub) {
      chunks.push({
        ...c,
        chunkIndex:   chunks.length,
        locationHint: { type: 'page', page: i + 1 },
      });
    }
  }

  return chunks;
}
