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
import { extractCode } from './extractors/code';
import { chunkByHeading } from './chunkers/heading';
import { chunkPlaintext } from './chunkers/plaintext';
import { chunkCodeAsync, CODE_EXTENSIONS } from './chunkers/code';
import type { EmbeddingService } from './embedding';
import { upsertFileChunks, deleteFileChunks, type SiloDatabase } from './store';

// ── Processor Registry ───────────────────────────────────────────────────────

/**
 * Maps file extensions to their extractor + chunker pair.
 * Extensions not in this map fall back to the default processor.
 */
const processors = new Map<string, FileProcessor>([
  // Markdown — heading-based chunking
  ['.md',       { extractor: extractMarkdown,  chunker: chunkByHeading }],
  ['.markdown', { extractor: extractMarkdown,  chunker: chunkByHeading }],
  ['.mdx',      { extractor: extractMarkdown,  chunker: chunkByHeading }],
]);

// Code files — Tree-sitter AST-based chunking (async)
// The dummy sync chunker is never called because asyncChunker takes priority.
const codeProcessor: FileProcessor = {
  extractor: extractCode,
  chunker: chunkPlaintext, // sync fallback (not used when asyncChunker is present)
  asyncChunker: chunkCodeAsync,
};

for (const ext of CODE_EXTENSIONS) {
  processors.set(ext, codeProcessor);
}

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
 * @param absolutePath — on-disk path used for file I/O and processor dispatch
 * @param storedKey — portable key ("{dirIndex}:{relPath}") used in the database
 *
 * Dispatches to the appropriate extractor + chunker based on file extension.
 * Supports both sync and async chunkers (async chunkers are used for
 * Tree-sitter code parsing which requires WASM grammar loading).
 *
 * Returns the number of chunks produced.
 * Throws on unrecoverable errors (file not readable, embedding service down).
 */
export async function indexFile(
  absolutePath: string,
  storedKey: string,
  embeddingService: EmbeddingService,
  db: SiloDatabase,
): Promise<IndexFileResult> {
  const start = performance.now();

  // Read the file
  const content = fs.readFileSync(absolutePath, 'utf-8');

  // Dispatch to the right extractor + chunker
  const { extractor, chunker, asyncChunker } = getProcessor(absolutePath);
  const extraction = extractor(content);

  // Use async chunker if available, otherwise sync
  const chunks = asyncChunker
    ? await asyncChunker(absolutePath, extraction, embeddingService.maxTokens)
    : chunker(absolutePath, extraction, embeddingService.maxTokens);

  if (chunks.length === 0) {
    // Empty file or only metadata — remove any stale chunks
    await deleteFileChunks(db, storedKey);
    return { filePath: storedKey, chunkCount: 0, durationMs: performance.now() - start };
  }

  // Rewrite chunk filePaths to stored key before persisting
  const storedChunks = chunks.map((c) => ({ ...c, filePath: storedKey }));

  // Embed all chunks in a single batch
  const texts = storedChunks.map((c) => c.text);
  const embeddings = await embeddingService.embedBatch(texts);

  // Store (atomic upsert: removes old chunks, inserts new)
  await upsertFileChunks(db, storedKey, storedChunks, embeddings);

  return {
    filePath: storedKey,
    chunkCount: storedChunks.length,
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
