/**
 * Indexing pipeline — wires extraction, chunking, embedding, and storage together.
 *
 * The two main operations:
 *   indexFile  — read file → extract → chunk → embed → store
 *   removeFile — delete all chunks for a file from the store
 */

import fs from 'node:fs';
import { chunkMarkdown } from './chunker';
import type { EmbeddingService } from './embedding';
import { upsertFileChunks, deleteFileChunks, type SiloDatabase } from './store';

// ── Types ────────────────────────────────────────────────────────────────────

export interface IndexFileResult {
  filePath: string;
  chunkCount: number;
  durationMs: number;
}

// ── Index ────────────────────────────────────────────────────────────────────

/**
 * Index a single file: read, extract, chunk, embed, and store.
 *
 * Returns the number of chunks produced.
 * Throws on unrecoverable errors (file not readable, embedding service down).
 */
export async function indexFile(
  filePath: string,
  embeddingService: EmbeddingService,
  db: SiloDatabase,
): Promise<IndexFileResult> {
  const start = performance.now();

  // Read the file
  const content = fs.readFileSync(filePath, 'utf-8');

  // Chunk by headings (maxChunkTokens adapts to the model)
  const chunks = chunkMarkdown(filePath, content, embeddingService.maxTokens);

  if (chunks.length === 0) {
    // Empty file or only frontmatter — remove any stale chunks
    await deleteFileChunks(db, filePath);
    return { filePath, chunkCount: 0, durationMs: performance.now() - start };
  }

  // Embed all chunks in a single batch
  const texts = chunks.map((c) => c.text);
  const embeddings = await embeddingService.embedBatch(texts);

  // Store (atomic upsert: removes old chunks, inserts new)
  await upsertFileChunks(db, filePath, chunks, embeddings);

  return {
    filePath,
    chunkCount: chunks.length,
    durationMs: performance.now() - start,
  };
}

// ── Remove ───────────────────────────────────────────────────────────────────

/**
 * Remove all chunks for a file from the store.
 */
export async function removeFile(filePath: string, db: SiloDatabase): Promise<void> {
  await deleteFileChunks(db, filePath);
}
