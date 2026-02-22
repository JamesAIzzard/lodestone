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

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Maximum number of chunks sent to the embedding service in one call.
 * Caps peak ONNX memory usage and gives GC a chance to reclaim between batches.
 */
const MAX_EMBED_BATCH_SIZE = 32;

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
  mtimeMs?: number,
): Promise<IndexFileResult> {
  const start = performance.now();

  // Read the file
  const content = fs.readFileSync(absolutePath, 'utf-8');

  // Dispatch to the right extractor + chunker
  const { extractor, chunker, asyncChunker } = getProcessor(absolutePath);
  const extraction = extractor(content);

  // Use async chunker if available, otherwise sync.
  // Use chunkTokens (not maxTokens) — the chunker target size is intentionally
  // smaller than the model's technical context window for better retrieval precision
  // and lower ONNX peak memory.
  const chunks = asyncChunker
    ? await asyncChunker(absolutePath, extraction, embeddingService.chunkTokens)
    : chunker(absolutePath, extraction, embeddingService.chunkTokens);

  if (chunks.length === 0) {
    // Empty file or only metadata — remove any stale chunks
    await deleteFileChunks(db, storedKey, mtimeMs !== undefined);
    return { filePath: storedKey, chunkCount: 0, durationMs: performance.now() - start };
  }

  // Rewrite chunk filePaths to stored key before persisting
  const storedChunks = chunks.map((c) => ({ ...c, filePath: storedKey }));

  // Embed chunks in capped batches — avoids unbounded peak ONNX memory
  // for files with many chunks, and lets GC reclaim between batches.
  const texts = storedChunks.map((c) => c.text);
  const embeddings: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_EMBED_BATCH_SIZE);
    const batchEmbeddings = await embeddingService.embedBatch(batch);
    embeddings.push(...batchEmbeddings);
  }

  // Store (atomic upsert: removes old chunks, inserts new, persists mtime if provided)
  await upsertFileChunks(db, storedKey, storedChunks, embeddings, mtimeMs);

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
export async function removeFile(filePath: string, db: SiloDatabase, deleteMtimeEntry?: boolean): Promise<void> {
  await deleteFileChunks(db, filePath, deleteMtimeEntry);
}
