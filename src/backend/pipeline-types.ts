/**
 * Shared types for the pluggable extraction + chunking pipeline.
 *
 * Two separate interfaces compose per file type:
 *   Extractor — raw file content → structured text + metadata
 *   Chunker   — structured text → semantic pieces under a token limit
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
  /** Extracted metadata from the file (shared across all chunks of the same file) */
  metadata: Record<string, unknown>;
  /** SHA-256 hash of the chunk text (for change detection) */
  contentHash: string;
}

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
 */
export type AsyncExtractor = (content: Buffer) => Promise<ExtractionResult>;

/**
 * A chunker splits extracted text into semantic pieces under a token limit.
 * Different chunking strategies suit different document structures.
 */
export type Chunker = (
  filePath: string,
  extraction: ExtractionResult,
  maxChunkTokens: number,
) => ChunkRecord[];

/**
 * An async chunker — same contract as Chunker but returns a Promise.
 * Used for chunkers that require async initialization (e.g. Tree-sitter WASM).
 */
export type AsyncChunker = (
  filePath: string,
  extraction: ExtractionResult,
  maxChunkTokens: number,
) => Promise<ChunkRecord[]>;

/**
 * A file processor pairs an extractor with a chunker.
 * The pipeline registry maps file extensions to these pairs.
 *
 * Provide either `extractor` (sync, string) or `asyncExtractor` (async, Buffer).
 * Provide either `chunker` (sync) or `asyncChunker` (async).
 * When both are present, async variants take priority.
 */
export interface FileProcessor {
  extractor?: Extractor;
  asyncExtractor?: AsyncExtractor;
  chunker?: Chunker;
  asyncChunker?: AsyncChunker;
}
