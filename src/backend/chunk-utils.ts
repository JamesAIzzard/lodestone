/**
 * Shared utilities for chunking: token estimation, hashing, text splitting.
 *
 * These are format-agnostic and used by all chunker implementations.
 */

import { createHash } from 'node:crypto';

/**
 * Rough token estimate: ~4 characters per token for English text.
 * This is a heuristic — exact tokenisation depends on the model's tokenizer.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * SHA-256 hash of text (for content change detection).
 */
export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Split oversized text into smaller chunks.
 *
 * Progressive strategy — each level handles text the previous level couldn't break:
 *   1. Paragraph boundaries (\n\n)  — prose, markdown
 *   2. Sentence boundaries (.!?)    — prose without paragraph breaks
 *   3. Line boundaries (\n)         — JSON, code, structured data
 *   4. Character boundaries         — minified files with no newlines at all
 *
 * Level 3 is critical: formats like JSON and minified code lack both paragraph
 * breaks and sentence-ending punctuation, so without it the entire file becomes
 * a single enormous chunk that crashes the ONNX tokenizer.
 */
export function subSplitText(text: string, maxTokens: number): string[] {
  // Try paragraph-level splitting first
  const paragraphs = text.split(/\n\n+/);
  const chunks = mergeUpTo(paragraphs, maxTokens, '\n\n');

  const result: string[] = [];
  for (const chunk of chunks) {
    if (estimateTokens(chunk) <= maxTokens) {
      result.push(chunk);
      continue;
    }

    // Level 2: sentence boundaries
    const sentences = chunk.split(/(?<=[.!?])\s+/);
    const sentenceMerged = mergeUpTo(sentences, maxTokens, ' ');

    for (const sc of sentenceMerged) {
      if (estimateTokens(sc) <= maxTokens) {
        result.push(sc);
        continue;
      }

      // Level 3: single newlines — handles JSON, code, structured text
      const lines = sc.split('\n');
      const lineMerged = mergeUpTo(lines, maxTokens, '\n');

      for (const lc of lineMerged) {
        if (estimateTokens(lc) <= maxTokens) {
          result.push(lc);
        } else {
          // Level 4: hard character split — last resort for very long single lines
          result.push(...hardSplitByChars(lc, maxTokens));
        }
      }
    }
  }

  return result;
}

/**
 * Hard-split text at character boundaries to fit within the token estimate.
 * Last-resort fallback for text without any usable split points (e.g. minified JS).
 */
function hardSplitByChars(text: string, maxTokens: number): string[] {
  const maxChars = maxTokens * 4; // matches estimateTokens heuristic (4 chars/token)
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    chunks.push(text.slice(i, i + maxChars));
  }
  return chunks;
}

/**
 * Greedily merge segments into chunks that fit within maxTokens.
 */
export function mergeUpTo(segments: string[], maxTokens: number, separator: string): string[] {
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
