/**
 * Code file extractor — strips shebang lines from source files.
 *
 * Most code files have no metadata wrapper (unlike Markdown's YAML frontmatter),
 * so this is close to a passthrough. The one case it handles is shebang lines
 * (e.g. `#!/usr/bin/env python3`) which are not meaningful content for embedding.
 *
 * When a shebang is present, `metadataLineCount` is set to 1 so that chunk
 * line numbers from the chunker still map correctly to the original file.
 */

import type { ExtractionResult } from '../pipeline-types';

/**
 * Extract text from a source code file.
 * Strips shebang lines; returns everything else as-is.
 */
export function extractCode(content: string): ExtractionResult {
  // Shebang line: starts with #! at the very beginning of the file
  if (content.startsWith('#!')) {
    const firstNewline = content.indexOf('\n');
    if (firstNewline === -1) {
      // Entire file is a shebang line — no body content
      return { body: '', metadata: {}, metadataLineCount: 1 };
    }
    return {
      body: content.slice(firstNewline + 1).trim(),
      metadata: {},
      metadataLineCount: 1,
    };
  }

  return {
    body: content.trim(),
    metadata: {},
    metadataLineCount: 0,
  };
}
