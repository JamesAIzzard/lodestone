/**
 * PDF extractor — extracts text from PDF files using pdfjs-dist.
 *
 * Uses the legacy Node.js-compatible build of pdfjs-dist. In v5, the library
 * detects Node.js and automatically disables real Web Workers, running the
 * parser in the main thread via a "fake worker" that loads the worker source
 * through dynamic import().
 *
 * Scanned-image PDFs (no embedded text layer) throw a clear error so the
 * activity log shows a meaningful message rather than indexing empty content.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import type { ExtractionResult } from '../pipeline-types';
import { CancellationError } from '../pipeline-types';

/** A paragraph extracted from the PDF with its source page number. */
export interface PdfParagraph {
  text: string;
  page: number;
}

/** Resolved once on first call — absolute path to pdfjs-dist/standard_fonts/. */
let standardFontDataUrl: string | undefined;

/**
 * Extract text from a PDF file buffer.
 *
 * Reconstructs paragraph structure from pdfjs-dist TextItem.hasEOL signals:
 * - Items with hasEOL → append newline (line break)
 * - Items without hasEOL → append space (continuation)
 * - Consecutive blank lines → paragraph boundary
 *
 * Returns both paragraph-level data (for the chunker) and page-level text
 * (for the reader) in metadata.
 *
 * Throws if the PDF has no embedded text (scanned image PDF).
 */
export async function extractPdf(content: Buffer, shouldStop?: () => boolean): Promise<ExtractionResult> {
  // Dynamic import keeps the heavy pdfjs-dist module out of the startup bundle
  // for non-PDF workloads.
  const { getDocument, GlobalWorkerOptions } = await import(
    'pdfjs-dist/legacy/build/pdf.mjs' as string
  ) as typeof import('pdfjs-dist');

  // pdfjs-dist v5 detects Node.js and disables real Web Workers automatically.
  // The fake-worker setup loads the worker source via dynamic import(), so we
  // point workerSrc at the full package path that Node.js can resolve.
  GlobalWorkerOptions.workerSrc = 'pdfjs-dist/legacy/build/pdf.worker.mjs';

  // Resolve the standard font data directory once. The NodeStandardFontDataFactory
  // reads fonts via fs.readFile(baseUrl + filename), so we need an absolute path.
  if (!standardFontDataUrl) {
    const require = createRequire(import.meta.url);
    const pkgDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
    standardFontDataUrl = path.join(pkgDir, 'standard_fonts') + '/';
  }

  const data = new Uint8Array(content);
  const doc  = await getDocument({ data, standardFontDataUrl }).promise;

  // Accumulate raw lines across all pages, tracking which page each line is on.
  // A "line" is the text between consecutive hasEOL markers.
  const allLines: Array<{ text: string; page: number }> = [];
  const pageTexts: string[] = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page    = await doc.getPage(p);
    const content = await page.getTextContent();

    // Build page text using hasEOL to reconstruct line breaks.
    // Also collect lines with page numbers for paragraph detection.
    let pageText = '';
    let currentLine = '';

    for (const item of content.items) {
      if (!('str' in item)) continue;
      const str = String((item as Record<string, unknown>).str);
      const hasEOL = Boolean((item as Record<string, unknown>).hasEOL);

      if (hasEOL) {
        currentLine += str;
        const trimmed = currentLine.trim();
        if (trimmed) {
          allLines.push({ text: trimmed, page: p });
        } else {
          // Empty line — push a blank marker for paragraph boundary detection
          allLines.push({ text: '', page: p });
        }
        pageText += currentLine + '\n';
        currentLine = '';
      } else {
        // Continuation on the same line — add space if needed
        currentLine += (currentLine && str) ? ' ' + str : str;
      }
    }

    // Flush any remaining text (last line on page may lack hasEOL)
    if (currentLine.trim()) {
      allLines.push({ text: currentLine.trim(), page: p });
      pageText += currentLine;
    }

    pageTexts.push(pageText.trim());

    // pdfjs-dist awaits resolve as micro-tasks, so they don't yield to the
    // event loop. Yield every 5 pages so IPC/rendering stay responsive.
    if (p % 5 === 0) {
      await new Promise<void>((r) => setImmediate(r));
      if (shouldStop?.()) throw new CancellationError('PDF extraction cancelled');
    }
  }

  const totalText = pageTexts.join('').trim();
  if (!totalText) {
    throw new Error(
      'PDF contains no embedded text layer. This is likely a scanned image PDF. ' +
      'OCR is required to index this file and is not currently supported.',
    );
  }

  // Group lines into paragraphs. A paragraph boundary is a blank line OR a
  // page change. Page-boundary flushing is critical: pdfjs-dist rarely
  // produces blank-line markers, so without it ALL lines merge into one
  // giant paragraph tagged with the first page number.
  const paragraphs: PdfParagraph[] = [];
  let currentParaLines: string[] = [];
  let currentParaPage = 1;

  for (const line of allLines) {
    if (line.text === '') {
      // Blank line — flush current paragraph if any
      if (currentParaLines.length > 0) {
        paragraphs.push({
          text: currentParaLines.join(' '),
          page: currentParaPage,
        });
        currentParaLines = [];
      }
    } else {
      // Page boundary — flush before starting content from a new page
      if (currentParaLines.length > 0 && line.page !== currentParaPage) {
        paragraphs.push({
          text: currentParaLines.join(' '),
          page: currentParaPage,
        });
        currentParaLines = [];
      }
      if (currentParaLines.length === 0) {
        currentParaPage = line.page;
      }
      currentParaLines.push(line.text);
    }
  }
  // Flush final paragraph
  if (currentParaLines.length > 0) {
    paragraphs.push({
      text: currentParaLines.join(' '),
      page: currentParaPage,
    });
  }

  const infoResult = await doc.getMetadata().catch(() => ({ info: {} }));
  const info = (infoResult as Record<string, unknown>).info as Record<string, unknown> ?? {};

  return {
    body: paragraphs.map(p => p.text).join('\n\n'),
    metadata: {
      paragraphs,
      pageTexts,
      pageCount: doc.numPages,
      ...(info.Title  ? { title:  String(info.Title)  } : {}),
      ...(info.Author ? { author: String(info.Author) } : {}),
    },
  };
}
