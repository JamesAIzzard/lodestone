/**
 * PDF reader — retrieves content from PDF files by page number.
 *
 * Reuses the existing extractPdf infrastructure so the text returned here
 * is identical to what was indexed. For a `{ type: 'page' }` hint, returns
 * only that page's text.
 */

import type { LocationHint } from '../../shared/types';
import { extractPdf } from '../extractors/pdf';

/**
 * Read content from a PDF, optionally restricted to a specific page.
 *
 * - `null` hint → full extracted body (all pages joined)
 * - `{ type: 'page' }` → text for that specific page (1-indexed)
 */
export async function readPdfPage(filePath: string, hint: LocationHint): Promise<string> {
  const fsp = await import('node:fs/promises');
  const buffer = await fsp.readFile(filePath);
  const result = await extractPdf(buffer);

  if (!hint) return result.body;

  if (hint.type === 'page') {
    const pageTexts = result.metadata.pageTexts as string[];
    const pageIndex = hint.page - 1;
    if (pageIndex < 0 || pageIndex >= pageTexts.length) {
      throw new Error(`Page ${hint.page} out of range (PDF has ${pageTexts.length} pages)`);
    }
    return pageTexts[pageIndex];
  }

  // Unknown hint type — return full body
  return result.body;
}
