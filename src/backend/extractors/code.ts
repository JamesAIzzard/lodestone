/**
 * Code file extractor — passthrough for source files.
 *
 * Returns the file content unchanged so chunk line numbers map directly to
 * raw-file coordinates. Shebang lines (e.g. `#!/usr/bin/env python3`) are
 * kept in the body; tree-sitter handles them gracefully.
 */

import type { ExtractionResult } from '../pipeline-types';

export function extractCode(content: string): ExtractionResult {
  return { body: content, metadata: {} };
}
