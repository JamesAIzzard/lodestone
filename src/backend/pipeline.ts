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
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FileProcessor, ExtractionResult } from './pipeline-types';
import { extractMarkdown } from './extractors/markdown';
import { extractPlaintext } from './extractors/plaintext';
import { extractCode } from './extractors/code';
import { chunkByHeading } from './chunkers/heading';
import { chunkPlaintext } from './chunkers/plaintext';
import { chunkCodeAsync, CODE_EXTENSIONS } from './chunkers/code';
import { extractPdf } from './extractors/pdf';
import { chunkPdf } from './chunkers/pdf';
import type { EmbeddingService } from './embedding';
import type { ChunkRecord } from './pipeline-types';
import { upsertFileChunks, deleteFileChunks, flushPreparedFiles, type SiloDatabase } from './store';

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
const codeProcessor: FileProcessor = {
  extractor: extractCode,
  asyncChunker: chunkCodeAsync,
};

for (const ext of CODE_EXTENSIONS) {
  processors.set(ext, codeProcessor);
}

// PDF — async Buffer-based extraction + page-aware chunking
processors.set('.pdf', { asyncExtractor: extractPdf, chunker: chunkPdf });

/** Default processor for unregistered extensions. */
const defaultProcessor: FileProcessor = {
  extractor: extractPlaintext,
  chunker: chunkPlaintext,
};

/**
 * Look up the processor for a file based on its extension.
 */
export function getProcessor(filePath: string): FileProcessor {
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

/** Result of preparing a file for storage (everything except the DB write). */
export interface PreparedFile {
  storedKey: string;
  chunks: ChunkRecord[];
  embeddings: number[][];
  mtimeMs?: number;
}

/** Pipeline stage reported via the onStage callback during file preparation. */
export type FileStage = 'reading' | 'extracting' | 'chunking' | 'embedding';

// ── Prepare ──────────────────────────────────────────────────────────────────

/**
 * Read, extract, chunk, and embed a single file — without writing to the database.
 *
 * Returns the prepared chunks and embeddings so the caller can batch multiple
 * files into a single database transaction. An empty `chunks` array means the
 * file had no indexable content (empty file or metadata only).
 *
 * The optional `onStage` callback fires at each pipeline transition so callers
 * can report granular progress (e.g. "Extracting report.pdf").
 */
export async function prepareFile(
  absolutePath: string,
  storedKey: string,
  embeddingService: EmbeddingService,
  mtimeMs?: number,
  onStage?: (stage: FileStage) => void,
): Promise<PreparedFile> {
  const processor = getProcessor(absolutePath);
  const { chunker, asyncChunker } = processor;

  onStage?.('reading');
  let extraction: ExtractionResult;
  if (processor.asyncExtractor) {
    const buffer = await fsp.readFile(absolutePath);
    onStage?.('extracting');
    extraction = await processor.asyncExtractor(buffer);
  } else {
    const content = await fsp.readFile(absolutePath, 'utf-8');
    onStage?.('extracting');
    extraction = processor.extractor!(content);
  }

  if (!asyncChunker && !chunker) {
    return { storedKey, chunks: [], embeddings: [], mtimeMs };
  }

  onStage?.('chunking');
  const chunks = asyncChunker
    ? await asyncChunker(absolutePath, extraction, embeddingService.chunkTokens)
    : chunker!(absolutePath, extraction, embeddingService.chunkTokens);

  if (chunks.length === 0) {
    return { storedKey, chunks: [], embeddings: [], mtimeMs };
  }

  const storedChunks = chunks.map((c) => ({ ...c, filePath: storedKey }));

  onStage?.('embedding');
  const texts = storedChunks.map((c) => c.text);
  const embeddings: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_EMBED_BATCH_SIZE);
    const batchEmbeddings = await embeddingService.embedBatch(batch);
    embeddings.push(...batchEmbeddings);
    // Yield to the event loop between embedding batches so IPC,
    // rendering, and other async work can progress.
    if (i + MAX_EMBED_BATCH_SIZE < texts.length) {
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  return { storedKey, chunks: storedChunks, embeddings, mtimeMs };
}

// ── Index ────────────────────────────────────────────────────────────────────

/**
 * Index a single file: read, extract, chunk, embed, and store.
 *
 * Convenience wrapper around prepareFile() + single-file DB write. Prefer
 * prepareFile() + flushPreparedFiles() when processing multiple files so
 * writes can be batched into fewer transactions.
 */
export async function indexFile(
  absolutePath: string,
  storedKey: string,
  embeddingService: EmbeddingService,
  db: SiloDatabase,
  mtimeMs?: number,
): Promise<IndexFileResult> {
  const start = performance.now();

  const prepared = await prepareFile(absolutePath, storedKey, embeddingService, mtimeMs);

  if (prepared.chunks.length === 0) {
    deleteFileChunks(db, storedKey, mtimeMs !== undefined);
    return { filePath: storedKey, chunkCount: 0, durationMs: performance.now() - start };
  }

  upsertFileChunks(db, storedKey, prepared.chunks, prepared.embeddings, mtimeMs);

  return {
    filePath: storedKey,
    chunkCount: prepared.chunks.length,
    durationMs: performance.now() - start,
  };
}

// ── Remove ───────────────────────────────────────────────────────────────────

/**
 * Remove all chunks for a file from the store.
 */
export function removeFile(filePath: string, db: SiloDatabase, deleteMtimeEntry?: boolean): void {
  deleteFileChunks(db, filePath, deleteMtimeEntry);
}

// Re-export for convenience
export { flushPreparedFiles } from './store';
