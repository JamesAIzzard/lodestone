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
 * Strategy: first try paragraph boundaries (blank lines), then sentence boundaries.
 */
export function subSplitText(text: string, maxTokens: number): string[] {
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
