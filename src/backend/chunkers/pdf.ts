/**
 * PDF chunker — splits PDF content into paragraph-based, page-aligned chunks.
 *
 * Works on the `paragraphs` array produced by the PDF extractor, where
 * each paragraph carries its source page number. Paragraphs on the same
 * page are greedily merged up to the token limit. Page boundaries always
 * trigger a flush so that each chunk's locationHint accurately points to
 * the page its content actually lives on.
 */

import type { ExtractionResult, ChunkRecord } from '../pipeline-types';
import type { PdfParagraph } from '../extractors/pdf';
import { estimateTokens, hashText, subSplitText, mergeUpTo } from '../chunk-utils';

/**
 * Chunk PDF extraction result into paragraph-based ChunkRecords.
 *
 * Merges paragraphs across pages up to maxChunkTokens, then sub-splits
 * any oversized paragraphs on sentence/line boundaries.
 */
export function chunkPdf(
  filePath: string,
  extraction: ExtractionResult,
  maxChunkTokens: number,
): ChunkRecord[] {
  const paragraphs = extraction.metadata.paragraphs as PdfParagraph[] | undefined;
  const filename = filePath.split(/[/\\]/).pop() ?? filePath;

  // Fallback: if no paragraphs in metadata (shouldn't happen with updated
  // extractor, but defensive), fall back to body split
  if (!paragraphs || paragraphs.length === 0) {
    if (!extraction.body.trim()) return [];

    return [{
      filePath,
      chunkIndex: 0,
      sectionPath: [filename],
      text: extraction.body,
      locationHint: { type: 'page', page: 1 },

      contentHash: hashText(extraction.body),
    }];
  }

  // Greedily merge paragraphs on the SAME page up to the token limit.
  // Flush whenever the page changes so locationHint stays accurate.
  const merged: Array<{ text: string; page: number }> = [];
  let currentText = '';
  let currentPage = paragraphs[0].page;

  for (const para of paragraphs) {
    // Page boundary — flush before starting content from a new page
    if (currentText && para.page !== currentPage) {
      merged.push({ text: currentText, page: currentPage });
      currentText = para.text;
      currentPage = para.page;
      continue;
    }

    const candidate = currentText
      ? currentText + '\n\n' + para.text
      : para.text;

    if (currentText && estimateTokens(candidate) > maxChunkTokens) {
      // Current group is full — flush it
      merged.push({ text: currentText, page: currentPage });
      currentText = para.text;
      currentPage = para.page;
    } else {
      if (!currentText) currentPage = para.page;
      currentText = candidate;
    }
  }
  if (currentText) {
    merged.push({ text: currentText, page: currentPage });
  }

  // Sub-split any oversized groups, then build ChunkRecords
  const chunks: ChunkRecord[] = [];

  for (const group of merged) {
    if (estimateTokens(group.text) <= maxChunkTokens) {
      chunks.push({
        filePath,
        chunkIndex: chunks.length,
        sectionPath: [filename],
        text: group.text,
        locationHint: { type: 'page', page: group.page },
  
        contentHash: hashText(group.text),
      });
    } else {
      // Oversized single paragraph — sub-split on sentence/line boundaries
      const parts = subSplitText(group.text, maxChunkTokens);
      for (const part of parts) {
        chunks.push({
          filePath,
          chunkIndex: chunks.length,
          sectionPath: [filename],
          text: part,
          locationHint: { type: 'page', page: group.page },
    
          contentHash: hashText(part),
        });
      }
    }
  }

  return chunks;
}
