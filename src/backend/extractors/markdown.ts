/**
 * Markdown extractor — strips YAML frontmatter via gray-matter.
 */

import matter from 'gray-matter';
import type { ExtractionResult } from '../pipeline-types';

/**
 * Extract structured text from a Markdown file.
 *
 * Strips YAML frontmatter (--- delimited) and returns the clean body
 * plus parsed metadata. The metadataLineCount tells callers how many
 * lines the frontmatter occupies, so chunk line numbers can be offset
 * to match the original file.
 */
export function extractMarkdown(content: string): ExtractionResult {
  const { data, content: body } = matter(content);

  // Count frontmatter lines: everything before the body in the original content.
  // gray-matter strips the --- delimiters and YAML block.
  let metadataLineCount = 0;
  if (content !== body) {
    const bodyStart = content.indexOf(body);
    if (bodyStart > 0) {
      metadataLineCount = content.substring(0, bodyStart).split('\n').length - 1;
    }
  }

  return {
    body: body.trim(),
    metadata: data as Record<string, unknown>,
    metadataLineCount,
  };
}
