/**
 * Markdown extractor — parses YAML frontmatter via gray-matter.
 */

import matter from 'gray-matter';
import type { ExtractionResult } from '../pipeline-types';

/**
 * Extract structured text from a Markdown file.
 *
 * Returns the full file content as the body so that YAML frontmatter
 * (tags, aliases, custom properties) is visible to the embedding and
 * BM25 index. The parsed YAML is also stored in `metadata` for
 * structured access elsewhere.
 */
export function extractMarkdown(content: string): ExtractionResult {
  const { data } = matter(content);
  return {
    body: content.trim(),
    metadata: data as Record<string, unknown>,
  };
}
