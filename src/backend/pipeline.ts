/**
 * Indexing pipeline — wires extraction, chunking, and embedding together.
 *
 * Uses a registry of FileProcessors keyed by file extension to dispatch
 * each file to the appropriate extractor + chunker + reader triple.
 *
 * V2: The pipeline only prepares files (read → extract → chunk → embed).
 * Database writes happen via the store proxy, never directly in the pipeline.
 * Consumers call prepareFile() and then proxy.flush() for batched writes.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FileProcessor, ExtractionResult } from './pipeline-types';
import { CancellationError } from './pipeline-types';
import { extractMarkdown } from './extractors/markdown';
import { extractPlaintext } from './extractors/plaintext';
import { extractCode } from './extractors/code';
import { chunkByHeading } from './chunkers/heading';
import { chunkPlaintext } from './chunkers/plaintext';
import { chunkCodeAsync, CODE_EXTENSIONS } from './chunkers/code';
import { extractPdf } from './extractors/pdf';
import { chunkPdf } from './chunkers/pdf';
import { readTextLines } from './readers/text';
import { readPdfPage } from './readers/pdf';
import type { EmbeddingService } from './embedding';
import type { ChunkRecord } from './pipeline-types';
import type { FlushUpsert } from './store/types';

// ── Processor Registry ───────────────────────────────────────────────────────

/**
 * Maps file extensions to their extractor + chunker + reader triple.
 * Extensions not in this map fall back to the default processor.
 */
const processors = new Map<string, FileProcessor>([
  // Markdown — heading-based chunking, line-based reading
  ['.md',       { extractor: extractMarkdown,  chunker: chunkByHeading, reader: readTextLines }],
  ['.markdown', { extractor: extractMarkdown,  chunker: chunkByHeading, reader: readTextLines }],
  ['.mdx',      { extractor: extractMarkdown,  chunker: chunkByHeading, reader: readTextLines }],
]);

// Code files — Tree-sitter AST-based chunking (async), line-based reading
const codeProcessor: FileProcessor = {
  extractor: extractCode,
  asyncChunker: chunkCodeAsync,
  reader: readTextLines,
};

for (const ext of CODE_EXTENSIONS) {
  processors.set(ext, codeProcessor);
}

// PDF — async Buffer-based extraction + page-aware chunking + page-based reading
processors.set('.pdf', { asyncExtractor: extractPdf, chunker: chunkPdf, asyncReader: readPdfPage });

/** Default processor for unregistered extensions. */
const defaultProcessor: FileProcessor = {
  extractor: extractPlaintext,
  chunker: chunkPlaintext,
  reader: readTextLines,
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
 * files into a single database transaction via proxy.flush(). An empty `chunks`
 * array means the file had no indexable content (empty file or metadata only).
 *
 * The optional `onStage` callback fires at each pipeline transition so callers
 * can report granular progress (e.g. "Extracting report.pdf").
 *
 * The optional `shouldStop` callback is checked between embedding batches and
 * threaded to async extractors (e.g. PDF per-page extraction). When it returns
 * true, a `CancellationError` is thrown — the caller should catch it to
 * distinguish cancellation from real failures.
 */
export async function prepareFile(
  absolutePath: string,
  storedKey: string,
  embeddingService: EmbeddingService,
  mtimeMs?: number,
  onStage?: (stage: FileStage) => void,
  shouldStop?: () => boolean,
  onEmbedProgress?: (done: number, total: number) => void,
): Promise<PreparedFile> {
  const processor = getProcessor(absolutePath);
  const { chunker, asyncChunker } = processor;

  onStage?.('reading');
  let extraction: ExtractionResult;
  if (processor.asyncExtractor) {
    const buffer = await fsp.readFile(absolutePath);
    onStage?.('extracting');
    extraction = await processor.asyncExtractor(buffer, shouldStop);
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
    if (shouldStop?.()) throw new CancellationError('Embedding cancelled');
    const batch = texts.slice(i, i + MAX_EMBED_BATCH_SIZE);
    const batchEmbeddings = await embeddingService.embedBatch(batch);
    embeddings.push(...batchEmbeddings);
    onEmbedProgress?.(embeddings.length, texts.length);
    // Yield to the event loop between embedding batches so IPC,
    // rendering, and other async work can progress.
    if (i + MAX_EMBED_BATCH_SIZE < texts.length) {
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  return { storedKey, chunks: storedChunks, embeddings, mtimeMs };
}

// ── Index File Loop ───────────────────────────────────────────────────────────

/** A file to process in the shared index loop. */
export interface IndexJob {
  absPath: string;
  storedKey: string;
  mtimeMs?: number;
  fileSize?: number;
}

/** Progress info emitted during the index loop. */
export interface IndexLoopProgress {
  /** 1-based file index (includes progressOffset). */
  current: number;
  total: number;
  filePath: string;
  fileSize?: number;
  fileStage?: FileStage | 'flushing';
  batchChunks?: number;
  batchChunkLimit?: number;
  /** Chunks embedded so far for the current file (only during 'embedding' stage). */
  embedDone?: number;
  /** Total chunks to embed for the current file. */
  embedTotal?: number;
}

/** Info about a file that was successfully prepared and flushed. */
export interface IndexedFileInfo {
  absPath: string;
  storedKey: string;
  chunkCount: number;
  durationMs: number;
  mtimeMs?: number;
}

/** Aggregate stats from the index loop. */
export interface IndexLoopResult {
  filesProcessed: number;
  totalPrepareMs: number;
  totalFlushMs: number;
  flushCount: number;
  cancelled: boolean;
}

/** Options for indexFileLoop(). */
export interface IndexLoopOptions {
  embeddingService: EmbeddingService;
  /** Write a batch of prepared files to the store. */
  flush: (upserts: FlushUpsert[]) => Promise<void>;
  /** Max chunks per batch before flushing. Default: 100. */
  batchChunkLimit?: number;
  /** Called before/during each file's preparation and before flushes. */
  onProgress?: (info: IndexLoopProgress) => void;
  /** Called after each successful batch flush with the files that were in it. */
  onBatchFlushed?: (files: IndexedFileInfo[]) => void;
  /** Called for each file that errors during preparation. */
  onError?: (absPath: string, message: string) => void;
  /** Return true to abort early. Also passed to prepareFile for mid-file cancellation. */
  shouldStop?: () => boolean;
  /** Base offset added to progress.current (for reconcile's alreadyDone count). Default: 0. */
  progressOffset?: number;
  /** Override for progress.total (reconcile adds filesToRemove). If omitted, uses jobs.length + progressOffset. */
  progressTotal?: number;
}

/**
 * Shared prepare → batch → flush loop used by both reconcile and the watcher.
 *
 * For each file: prepareFile() → accumulate in batch → flush when batch is full.
 * Handles progress reporting, cancellation, error isolation, slow-file logging,
 * and periodic event-loop yielding.
 */
export async function indexFileLoop(
  jobs: IndexJob[],
  opts: IndexLoopOptions,
): Promise<IndexLoopResult> {
  const {
    embeddingService,
    flush,
    batchChunkLimit = 100,
    onProgress,
    onBatchFlushed,
    onError,
    shouldStop,
    progressOffset = 0,
  } = opts;
  const total = opts.progressTotal ?? (progressOffset + jobs.length);

  let totalPrepareMs = 0;
  let totalFlushMs = 0;
  let flushCount = 0;
  let filesProcessed = 0;
  let cancelled = false;

  // Current batch
  let batch: Array<{ upsert: FlushUpsert; info: IndexedFileInfo }> = [];
  let batchChunks = 0;

  const doFlush = async () => {
    if (batch.length === 0) return;
    onProgress?.({
      current: progressOffset + filesProcessed,
      total,
      filePath: '',
      fileStage: 'flushing',
      batchChunks,
      batchChunkLimit,
    });

    // Yield so the renderer can poll the "flushing" state before
    // the potentially long synchronous DB write blocks the worker.
    await new Promise<void>((r) => setImmediate(r));

    const tFlush = performance.now();
    await flush(batch.map((b) => b.upsert));
    totalFlushMs += performance.now() - tFlush;
    flushCount++;

    onBatchFlushed?.(batch.map((b) => b.info));
    batch = [];
    batchChunks = 0;
  };

  for (let i = 0; i < jobs.length; i++) {
    if (shouldStop?.()) {
      await doFlush();
      cancelled = true;
      break;
    }

    const { absPath, storedKey, mtimeMs, fileSize } = jobs[i];
    filesProcessed++;
    const current = progressOffset + filesProcessed;

    onProgress?.({ current, total, filePath: absPath, fileSize, fileStage: 'reading', batchChunks, batchChunkLimit });

    try {
      const tPrep = performance.now();
      const prepared = await prepareFile(
        absPath, storedKey, embeddingService, mtimeMs,
        (stage) => onProgress?.({ current, total, filePath: absPath, fileSize, fileStage: stage, batchChunks, batchChunkLimit }),
        shouldStop,
        (done, embedTotal) => onProgress?.({ current, total, filePath: absPath, fileSize, fileStage: 'embedding', batchChunks, batchChunkLimit, embedDone: done, embedTotal }),
      );
      const prepMs = performance.now() - tPrep;
      totalPrepareMs += prepMs;

      if (prepMs > 500) {
        const fileName = absPath.split(/[\\/]/).pop() ?? absPath;
        console.log(`[index]   SLOW file: ${fileName} → ${prepMs.toFixed(0)}ms (${prepared.chunks.length} chunks)`);
      }

      batch.push({
        upsert: { storedKey, chunks: prepared.chunks, embeddings: prepared.embeddings, mtimeMs: prepared.mtimeMs },
        info: { absPath, storedKey, chunkCount: prepared.chunks.length, durationMs: prepMs, mtimeMs: prepared.mtimeMs },
      });
      batchChunks += prepared.chunks.length;

      // Re-emit progress with updated batch chunk count
      onProgress?.({ current, total, filePath: absPath, fileSize, batchChunks, batchChunkLimit });

      if (batchChunks >= batchChunkLimit) {
        await doFlush();
        await new Promise<void>((r) => setImmediate(r));
      }
    } catch (err) {
      if (err instanceof CancellationError) {
        await doFlush();
        cancelled = true;
        break;
      }
      const message = err instanceof Error ? err.message : String(err);
      onError?.(absPath, message);
    }

    // Yield periodically so IPC stays responsive between files
    if ((i + 1) % 5 === 0) {
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  await doFlush();
  return { filesProcessed, totalPrepareMs, totalFlushMs, flushCount, cancelled };
}
