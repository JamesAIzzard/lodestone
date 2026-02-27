/**
 * Code file extractor — passthrough for source files.
 *
 * Returns the full file content as-is so that chunk line numbers map
 * directly to raw-file coordinates. Shebang lines (e.g. `#!/usr/bin/env python3`)
 * are kept in the body; tree-sitter handles them gracefully.
 */

import type { ExtractionResult } from '../pipeline-types';

/**
 * Extract text from a source code file.
 * Returns the full content unchanged — no metadata parsing needed.
 */
export function extractCode(content: string): ExtractionResult {
  return {
    body: content.trim(),
    metadata: {},
  };
}
