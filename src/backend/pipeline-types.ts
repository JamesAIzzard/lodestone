/**
 * Shared types for the pluggable extraction + chunking pipeline.
 *
 * Three separate interfaces compose per file type:
 *   Extractor — raw file content → structured text + metadata
 *   Chunker   — structured text → semantic pieces under a token limit
 *   Reader    — LocationHint → content for that region of the file
 */

import type { LocationHint } from '../shared/types';

// ── Extraction ───────────────────────────────────────────────────────────────

/**
 * Result of extracting structured text from a raw file.
 * The extractor returns the full file body plus any structured metadata discovered.
 * Body coordinates are identical to raw-file coordinates for all text formats.
 */
export interface ExtractionResult {
  /** Body text (full file content for text formats; extracted text for binary formats) */
  body: string;
  /** Extracted metadata (YAML frontmatter fields, PDF properties, etc.) */
  metadata: Record<string, unknown>;
}

// ── Chunking ─────────────────────────────────────────────────────────────────

/**
 * Identity of the file being chunked, derived from its path by the pipeline
 * driver. Chunkers receive this instead of the raw path so they don't need
 * to do filesystem-path parsing themselves.
 */
export interface FileInfo {
  /** Lowercased file extension including the dot, e.g. ".ts" */
  extension: string;
  /** Filename without directory, e.g. "code.ts" */
  basename: string;
}

/**
 * A single chunk produced by a chunker, ready for embedding and storage.
 */
export interface ChunkRecord {
  /** Source file path (absolute) */
  filePath: string;
  /** Chunk index within the file (0-based) */
  chunkIndex: number;
  /** Section hierarchy path, e.g. ["Architecture", "File Processing Pipeline"] */
  sectionPath: string[];
  /** The chunk text content (for embedding) */
  text: string;
  /** Location of this chunk within the source file. */
  locationHint: LocationHint;
  /** SHA-256 hash of the chunk text (for change detection) */
  contentHash: string;
}

/**
 * What a chunker actually produces. The pipeline driver stamps `filePath`
 * onto these to form complete `ChunkRecord`s — chunkers don't see the path
 * because they don't need it.
 */
export type ChunkOutput = Omit<ChunkRecord, 'filePath'>;

// ── Pluggable interfaces ─────────────────────────────────────────────────────

/**
 * An extractor turns raw file content into structured text + metadata.
 * Each file format has its own extractor implementation.
 */
export type Extractor = (content: string) => ExtractionResult;

/**
 * An async extractor — same contract as Extractor but takes a Buffer and
 * returns a Promise. Used for binary formats (e.g. PDF) that require
 * async parsing libraries.
 *
 * The optional `shouldStop` callback allows the caller to request early
 * cancellation (e.g. user clicked "Stop indexing"). Extractors that accept
 * it should check periodically and throw `CancellationError` to bail out.
 */
export type AsyncExtractor = (content: Buffer, shouldStop?: () => boolean) => Promise<ExtractionResult>;

/**
 * Lightweight error thrown when a pipeline operation is cancelled via shouldStop.
 * Callers catch this to distinguish cancellation from real failures.
 */
export class CancellationError extends Error {
  constructor(message = 'Cancelled') {
    super(message);
    this.name = 'CancellationError';
  }
}

/**
 * A chunker splits extracted text into semantic pieces under a token limit.
 * Different chunking strategies suit different document structures.
 *
 * Chunkers are pure with respect to filesystem paths — they receive the
 * file's identity via `FileInfo` and return path-free `ChunkOutput`s. The
 * pipeline driver stamps `filePath` onto the returned records.
 */
export type Chunker = (
  extraction: ExtractionResult,
  fileInfo: FileInfo,
  maxChunkTokens: number,
) => ChunkOutput[];

/**
 * An async chunker — same contract as Chunker but returns a Promise.
 * Used for chunkers that require async initialization (e.g. Tree-sitter WASM).
 */
export type AsyncChunker = (
  extraction: ExtractionResult,
  fileInfo: FileInfo,
  maxChunkTokens: number,
) => Promise<ChunkOutput[]>;

// ── Reading ──────────────────────────────────────────────────────────────────

/**
 * A reader retrieves content from a specific region of a file.
 * Given a file path and a LocationHint, it returns the text for that region.
 * When hint is null, the reader returns the full file body.
 */
export type Reader = (filePath: string, hint: LocationHint) => string;

/**
 * An async reader — same contract as Reader but returns a Promise.
 * Used for binary formats (e.g. PDF) that require async parsing.
 */
export type AsyncReader = (filePath: string, hint: LocationHint) => Promise<string>;

// ── File processor ──────────────────────────────────────────────────────────

/**
 * A file processor pairs an extractor, chunker, and reader.
 * The pipeline registry maps file extensions to these triples.
 *
 * Provide either `extractor` (sync, string) or `asyncExtractor` (async, Buffer).
 * Provide either `chunker` (sync) or `asyncChunker` (async).
 * Provide either `reader` (sync) or `asyncReader` (async).
 * When both are present, async variants take priority.
 */
export interface FileProcessor {
  extractor?: Extractor;
  asyncExtractor?: AsyncExtractor;
  chunker?: Chunker;
  asyncChunker?: AsyncChunker;
  reader?: Reader;
  asyncReader?: AsyncReader;
}
