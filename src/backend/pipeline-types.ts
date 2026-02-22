/**
 * Shared types for the pluggable extraction + chunking pipeline.
 *
 * Two separate interfaces compose per file type:
 *   Extractor — raw file content → structured text + metadata
 *   Chunker   — structured text → semantic pieces under a token limit
 */

// ── Extraction ───────────────────────────────────────────────────────────────

/**
 * Result of extracting structured text from a raw file.
 * The extractor strips format-specific wrappers (YAML frontmatter, PDF headers, etc.)
 * and returns clean body text plus any metadata discovered.
 */
export interface ExtractionResult {
  /** Clean body text (format-specific wrappers removed) */
  body: string;
  /** Extracted metadata (YAML frontmatter, PDF properties, etc.) */
  metadata: Record<string, unknown>;
  /** Number of lines the metadata occupies in the original file (for line-number offsetting) */
  metadataLineCount: number;
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
  /** Start line in the source file (1-based) */
  startLine: number;
  /** End line in the source file (1-based, inclusive) */
  endLine: number;
  /** Extracted metadata from the file (shared across all chunks of the same file) */
  metadata: Record<string, unknown>;
  /** SHA-256 hash of the chunk text (for change detection) */
  contentHash: string;
  /** Heading depth of the section this chunk belongs to (1–6 for h1–h6, 0 for no heading) */
  headingDepth: number;
  /** Flattened tags/aliases/title for metadata FTS indexing */
  tagsText: string;
}

// ── Pluggable interfaces ─────────────────────────────────────────────────────

/**
 * An extractor turns raw file content into structured text + metadata.
 * Each file format has its own extractor implementation.
 */
export type Extractor = (content: string) => ExtractionResult;

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
 * Processors can provide either a sync `chunker` or an async `asyncChunker`.
 * If `asyncChunker` is present, it takes priority. The sync `chunker` is
 * optional when an async chunker is provided (set to a dummy that throws).
 */
export interface FileProcessor {
  extractor: Extractor;
  chunker: Chunker;
  /** Async chunker — takes priority over sync chunker when present. */
  asyncChunker?: AsyncChunker;
}
