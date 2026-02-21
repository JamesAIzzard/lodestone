/**
 * Indexing pipeline — wires extraction, chunking, embedding, and storage together.
 *
 * Uses a registry of FileProcessors keyed by file extension to dispatch
 * each file to the appropriate extractor + chunker pair.
 *
 * The two main operations:
 *   indexFile  — read file → extract → chunk → embed → store
 *   removeFile — delete all chunks for a file from the store
 */

import fs from 'node:fs';
import path from 'node:path';
import type { FileProcessor } from './pipeline-types';
import { extractMarkdown } from './extractors/markdown';
import { extractPlaintext } from './extractors/plaintext';
import { chunkByHeading } from './chunkers/heading';
import { chunkPlaintext } from './chunkers/plaintext';
import type { EmbeddingService } from './embedding';
import { upsertFileChunks, deleteFileChunks, type SiloDatabase } from './store';

// ── Processor Registry ───────────────────────────────────────────────────────

/**
 * Maps file extensions to their extractor + chunker pair.
 * Extensions not in this map fall back to the default processor.
 */
const processors = new Map<string, FileProcessor>([
  ['.md',       { extractor: extractMarkdown,  chunker: chunkByHeading }],
  ['.markdown', { extractor: extractMarkdown,  chunker: chunkByHeading }],
  ['.mdx',      { extractor: extractMarkdown,  chunker: chunkByHeading }],
]);

/** Default processor for unregistered extensions. */
const defaultProcessor: FileProcessor = {
  extractor: extractPlaintext,
  chunker: chunkPlaintext,
};

/**
 * Look up the processor for a file based on its extension.
 */
function getProcessor(filePath: string): FileProcessor {
  const ext = path.extname(filePath).toLowerCase();
  return processors.get(ext) ?? defaultProcessor;
}

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
 * Dispatches to the appropriate extractor + chunker based on file extension.
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

  // Dispatch to the right extractor + chunker
  const { extractor, chunker } = getProcessor(filePath);
  const extraction = extractor(content);
  const chunks = chunker(filePath, extraction, embeddingService.maxTokens);

  if (chunks.length === 0) {
    // Empty file or only metadata — remove any stale chunks
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
