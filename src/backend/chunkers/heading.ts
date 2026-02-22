/**
 * Heading-based chunker — splits text on Markdown headings using remark AST.
 *
 * This correctly handles # inside code blocks, blockquotes, and other edge
 * cases that regex-based splitters get wrong. Each heading + its content until
 * the next heading of equal or lesser depth forms one section.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { toString } from 'mdast-util-to-string';
import type { Root, Content, Heading } from 'mdast';
import type { ExtractionResult, ChunkRecord } from '../pipeline-types';
import { estimateTokens, hashText, subSplitText } from '../chunk-utils';

interface RawSection {
  sectionPath: string[];
  depth: number;
  nodes: Content[];
  startLine: number;
  endLine: number;
}

/**
 * Chunk extracted text by Markdown heading boundaries.
 *
 * Parses the body into a remark AST and groups nodes by heading hierarchy.
 * Oversized sections are sub-split on paragraph/sentence boundaries.
 */
export function chunkByHeading(
  filePath: string,
  extraction: ExtractionResult,
  maxChunkTokens: number,
): ChunkRecord[] {
  const { body, metadata, metadataLineCount } = extraction;

  if (body.length === 0) {
    return [];
  }

  const tree = unified().use(remarkParse).parse(body) as Root;
  const sections = splitByHeadings(tree, filePath);

  const chunks: ChunkRecord[] = [];
  for (const section of sections) {
    const text = nodesToText(section.nodes).trim();
    if (text.length === 0) continue;

    const estimatedTokens = estimateTokens(text);

    const tagsText = flattenMetadataForSearch(metadata);

    if (estimatedTokens <= maxChunkTokens) {
      chunks.push({
        filePath,
        chunkIndex: chunks.length,
        sectionPath: section.sectionPath,
        text,
        startLine: section.startLine + metadataLineCount,
        endLine: section.endLine + metadataLineCount,
        metadata,
        contentHash: hashText(text),
        headingDepth: section.depth,
        tagsText,
      });
    } else {
      // Sub-split oversized chunks
      const subChunks = subSplitText(text, maxChunkTokens);
      for (const sub of subChunks) {
        chunks.push({
          filePath,
          chunkIndex: chunks.length,
          sectionPath: section.sectionPath,
          text: sub,
          startLine: section.startLine + metadataLineCount,
          endLine: section.endLine + metadataLineCount,
          metadata,
          contentHash: hashText(sub),
          headingDepth: section.depth,
          tagsText,
        });
      }
    }
  }

  return chunks;
}

/**
 * Walk the AST and group nodes by heading boundaries.
 * Content before the first heading uses the filename as the section name.
 */
function splitByHeadings(tree: Root, filePath: string): RawSection[] {
  const sections: RawSection[] = [];
  const headingStack: string[] = [];
  let currentSection: RawSection | null = null;

  const filename = filePath.split(/[/\\]/).pop() ?? filePath;

  for (const node of tree.children) {
    if (node.type === 'heading') {
      const heading = node as Heading;
      const headingText = toString(heading);
      const depth = heading.depth;

      // Flush any current section
      if (currentSection && currentSection.nodes.length > 0) {
        sections.push(currentSection);
      }

      // Adjust heading stack: pop back to parent level
      while (headingStack.length >= depth) {
        headingStack.pop();
      }
      headingStack.push(headingText);

      currentSection = {
        sectionPath: [...headingStack],
        depth,
        nodes: [node],
        startLine: node.position?.start.line ?? 1,
        endLine: node.position?.end.line ?? 1,
      };
    } else {
      if (!currentSection) {
        // Content before any heading — use filename as section name
        currentSection = {
          sectionPath: [filename],
          depth: 0,
          nodes: [],
          startLine: node.position?.start.line ?? 1,
          endLine: node.position?.end.line ?? 1,
        };
      }
      currentSection.nodes.push(node);
      if (node.position) {
        currentSection.endLine = Math.max(currentSection.endLine, node.position.end.line);
      }
    }
  }

  // Flush final section
  if (currentSection && currentSection.nodes.length > 0) {
    sections.push(currentSection);
  }

  return sections;
}

/**
 * Convert AST nodes back to plain text for embedding.
 */
function nodesToText(nodes: Content[]): string {
  return nodes.map((n) => toString(n)).join('\n\n');
}

/**
 * Flatten YAML frontmatter metadata into a single searchable string.
 * Extracts title, aliases, and tags so they appear in the metadata FTS index.
 */
function flattenMetadataForSearch(metadata: Record<string, unknown>): string {
  const parts: string[] = [];

  if (typeof metadata.title === 'string') {
    parts.push(metadata.title);
  }

  if (Array.isArray(metadata.aliases)) {
    for (const a of metadata.aliases) {
      if (typeof a === 'string') parts.push(a);
    }
  } else if (typeof metadata.aliases === 'string') {
    parts.push(metadata.aliases);
  }

  if (Array.isArray(metadata.tags)) {
    for (const t of metadata.tags) {
      if (typeof t === 'string') parts.push(t);
    }
  } else if (typeof metadata.tags === 'string') {
    parts.push(metadata.tags);
  }

  return parts.join(' ');
}
