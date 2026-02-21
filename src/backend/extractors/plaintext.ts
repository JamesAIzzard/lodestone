/**
 * Plaintext extractor — passthrough with no parsing.
 *
 * Used for file types that don't have structured metadata wrappers
 * (e.g. .txt, .py, .js, .rs, .go, etc.). Returns the content as-is.
 */

import type { ExtractionResult } from '../pipeline-types';

/**
 * Extract text from a plain/unstructured file.
 * No metadata is parsed — the body is the entire content.
 */
export function extractPlaintext(content: string): ExtractionResult {
  return {
    body: content.trim(),
    metadata: {},
    metadataLineCount: 0,
  };
}
