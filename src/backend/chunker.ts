/**
 * Markdown extraction and heading-based chunking.
 *
 * Uses gray-matter for frontmatter parsing and remark-parse (unified/mdast)
 * for AST-based splitting. This correctly handles # inside code blocks,
 * blockquotes, and other edge cases that regex-based splitters get wrong.
 */

import matter from 'gray-matter';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { toString } from 'mdast-util-to-string';
import { createHash } from 'node:crypto';
import type { Root, Content, Heading } from 'mdast';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ChunkRecord {
  /** Source file path (absolute) */
  filePath: string;
  /** Chunk index within the file (0-based) */
  chunkIndex: number;
  /** Heading hierarchy path, e.g. ["Architecture", "File Processing Pipeline"] */
  headingPath: string[];
  /** The chunk text content (for embedding) */
  text: string;
  /** Start line in the source file (1-based) */
  startLine: number;
  /** End line in the source file (1-based, inclusive) */
  endLine: number;
  /** Parsed frontmatter fields (from YAML header) */
  frontmatter: Record<string, unknown>;
  /** SHA-256 hash of the chunk text (for change detection) */
  contentHash: string;
}

export interface ExtractionResult {
  /** Markdown body (frontmatter stripped) */
  body: string;
  /** Parsed frontmatter key-value pairs */
  frontmatter: Record<string, unknown>;
  /** Line offset: number of lines the frontmatter occupies (so body line 1 = source line offset+1) */
  frontmatterLineCount: number;
}

// ── Extraction ───────────────────────────────────────────────────────────────

/**
 * Read markdown content, strip YAML frontmatter, and return the body + metadata.
 */
export function extractMarkdown(content: string): ExtractionResult {
  const { data, content: body } = matter(content);

  // Count frontmatter lines: everything before the body in the original content
  // gray-matter strips the --- delimiters and YAML block
  let frontmatterLineCount = 0;
  if (content !== body) {
    // Find where the body starts in the original content
    const bodyStart = content.indexOf(body);
    if (bodyStart > 0) {
      frontmatterLineCount = content.substring(0, bodyStart).split('\n').length - 1;
    }
  }

  return {
    body: body.trim(),
    frontmatter: data as Record<string, unknown>,
    frontmatterLineCount,
  };
}

// ── Chunking ─────────────────────────────────────────────────────────────────

interface RawSection {
  headingPath: string[];
  depth: number;
  nodes: Content[];
  startLine: number;
  endLine: number;
}

/**
 * Parse the markdown body into an AST and split on headings.
 * Returns chunk records ready for embedding.
 *
 * @param filePath  Absolute path to the source file (stored in chunk metadata)
 * @param content   Raw file content (with frontmatter)
 * @param maxChunkTokens  Maximum tokens per chunk — oversized chunks are sub-split.
 *                        Set based on the embedding model (128 for MiniLM, 8192 for nomic).
 */
export function chunkMarkdown(
  filePath: string,
  content: string,
  maxChunkTokens: number = 128,
): ChunkRecord[] {
  const { body, frontmatter, frontmatterLineCount } = extractMarkdown(content);

  if (body.length === 0) {
    return [];
  }

  const tree = unified().use(remarkParse).parse(body) as Root;
  const sections = splitByHeadings(tree, filePath);

  // Convert sections to chunks, sub-splitting oversized ones
  const chunks: ChunkRecord[] = [];
  for (const section of sections) {
    const text = nodesToText(section.nodes).trim();
    if (text.length === 0) continue;

    const estimatedTokens = estimateTokens(text);

    if (estimatedTokens <= maxChunkTokens) {
      chunks.push({
        filePath,
        chunkIndex: chunks.length,
        headingPath: section.headingPath,
        text,
        startLine: section.startLine + frontmatterLineCount,
        endLine: section.endLine + frontmatterLineCount,
        frontmatter,
        contentHash: hashText(text),
      });
    } else {
      // Sub-split oversized chunks
      const subChunks = subSplitText(text, maxChunkTokens);
      for (const sub of subChunks) {
        chunks.push({
          filePath,
          chunkIndex: chunks.length,
          headingPath: section.headingPath,
          text: sub,
          startLine: section.startLine + frontmatterLineCount,
          endLine: section.endLine + frontmatterLineCount,
          frontmatter,
          contentHash: hashText(sub),
        });
      }
    }
  }

  return chunks;
}

/**
 * Walk the AST and group nodes by heading boundaries.
 * Each heading + its content until the next heading of equal or lesser depth
 * forms one section. Content before the first heading uses the filename.
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
        headingPath: [...headingStack],
        depth,
        nodes: [node],
        startLine: node.position?.start.line ?? 1,
        endLine: node.position?.end.line ?? 1,
      };
    } else {
      if (!currentSection) {
        // Content before any heading — use filename as heading
        currentSection = {
          headingPath: [filename],
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

// ── Sub-splitting ────────────────────────────────────────────────────────────

/**
 * Split oversized text into smaller chunks.
 * Strategy: first try paragraph boundaries (blank lines), then sentence boundaries.
 */
function subSplitText(text: string, maxTokens: number): string[] {
  // Try paragraph-level splitting first
  const paragraphs = text.split(/\n\n+/);
  const chunks = mergeUpTo(paragraphs, maxTokens, '\n\n');

  // If any chunk is still oversized, split on sentences
  const result: string[] = [];
  for (const chunk of chunks) {
    if (estimateTokens(chunk) <= maxTokens) {
      result.push(chunk);
    } else {
      const sentences = chunk.split(/(?<=[.!?])\s+/);
      result.push(...mergeUpTo(sentences, maxTokens, ' '));
    }
  }

  return result;
}

/**
 * Greedily merge segments into chunks that fit within maxTokens.
 */
function mergeUpTo(segments: string[], maxTokens: number, separator: string): string[] {
  const chunks: string[] = [];
  let current = '';

  for (const seg of segments) {
    const candidate = current.length > 0 ? current + separator + seg : seg;
    if (estimateTokens(candidate) <= maxTokens && current.length > 0) {
      current = candidate;
    } else if (current.length > 0) {
      chunks.push(current);
      current = seg;
    } else {
      current = seg;
    }
  }
  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

// ── Utilities ────────────────────────────────────────────────────────────────

/**
 * Rough token estimate: ~4 characters per token for English text.
 * This is a heuristic — exact tokenisation depends on the model's tokenizer.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
