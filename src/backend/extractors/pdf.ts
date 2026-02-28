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

/** Resolved once on first call — absolute path to pdfjs-dist/standard_fonts/. */
let standardFontDataUrl: string | undefined;

/**
 * Extract text from a PDF file buffer.
 *
 * Returns one body paragraph per page (joined by double newline), plus
 * page-level metadata so the PDF chunker can assign page-based locationHints.
 *
 * Throws if the PDF has no embedded text (scanned image PDF).
 */
export async function extractPdf(content: Buffer): Promise<ExtractionResult> {
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

  const pageTexts: string[] = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page    = await doc.getPage(p);
    const content = await page.getTextContent();
    const text    = content.items
      .map((item: Record<string, unknown>) => ('str' in item ? String(item.str) : ''))
      .join(' ')
      .trim();
    pageTexts.push(text);

    // pdfjs-dist awaits resolve as micro-tasks, so they don't yield to the
    // event loop. Yield every 5 pages so IPC/rendering stay responsive.
    if (p % 5 === 0) {
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  const totalText = pageTexts.join('').trim();
  if (!totalText) {
    throw new Error(
      'PDF contains no embedded text layer. This is likely a scanned image PDF. ' +
      'OCR is required to index this file and is not currently supported.',
    );
  }

  const infoResult = await doc.getMetadata().catch(() => ({ info: {} }));
  const info = (infoResult as Record<string, unknown>).info as Record<string, unknown> ?? {};

  return {
    body: pageTexts.join('\n\n'),
    metadata: {
      pageTexts,
      pageCount: doc.numPages,
      ...(info.Title  ? { title:  String(info.Title)  } : {}),
      ...(info.Author ? { author: String(info.Author) } : {}),
    },
  };
}
