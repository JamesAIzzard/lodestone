/**
 * Store-internal types for the V2 indexing system.
 *
 * These types define the data structures that flow between the main thread
 * (via StoreProxy) and the store worker thread. They must be serializable
 * via structured clone (no functions, class instances, or native handles).
 */

import type Database from 'better-sqlite3';
import type { ChunkRecord } from '../pipeline-types';

// ── Database Handle ─────────────────────────────────────────────────────────

export type SiloDatabase = Database.Database;

// ── Flush Types ─────────────────────────────────────────────────────────────

/** A prepared file ready for batch flushing to the database. */
export interface FlushUpsert {
  /** Stored key (e.g. "0:src/backend/store.ts") */
  storedKey: string;
  /** Chunk records from the pipeline (text is uncompressed, hash is hex) */
  chunks: ChunkRecord[];
  /** Embedding vectors (float64 number arrays from embedding worker) */
  embeddings: number[][];
  /** File modification time in milliseconds */
  mtimeMs?: number;
  /** File-level metadata (frontmatter, PDF title/author, etc.) — stored once per file, not per chunk */
  fileMetadata?: Record<string, unknown>;
}

/** A file to delete during a batch flush. */
export interface FlushDelete {
  /** Stored key */
  storedKey: string;
  /** Whether to also remove the mtime entry */
  deleteMtime: boolean;
}

/** Result of a batch flush operation. */
export interface FlushResult {
  /** Number of files upserted (with chunks) */
  upserted: number;
  /** Number of files cleared (kept file row, removed chunks) */
  cleared: number;
  /** Number of files deleted */
  deleted: number;
  /** Total wall time in milliseconds */
  durationMs: number;
}

// ── Metadata Types ──────────────────────────────────────────────────────────

export interface SiloMeta {
  /** Model identifier used to build this index */
  model: string;
  /** Vector dimensions of the model */
  dimensions: number;
  /** ISO timestamp of when the index was first created */
  createdAt: string;
  /** Schema version for forward compatibility */
  version: number;
}

/**
 * Configuration snapshot stored inside the database for portable reconnection.
 * When a user reconnects an existing .db file on a new machine, this blob
 * provides the original silo settings so the wizard can pre-populate fields.
 */
export interface StoredSiloConfig {
  name: string;
  description?: string;
  directories: string[];
  extensions: string[];
  ignore: string[];
  ignoreFiles: string[];
  model: string;
  color?: string;
  icon?: string;
}

// ── Chunk Metadata (for signal implementations) ─────────────────────────────

/** Minimal chunk metadata needed by signal implementations for hints. */
export interface ChunkMeta {
  id: number;
  file_id: number;
  stored_key: string;
  section_path: string;
  location_hint: string | null;
}

// ── Directory Types ─────────────────────────────────────────────────────────

export interface DirEntry {
  dirPath: string;
  dirName: string;
  depth: number;
}

// ── Worker RPC Protocol ─────────────────────────────────────────────────────

/** Message from main thread → store worker. */
export interface StoreRequest {
  id: number;
  method: string;
  siloId: string;
  args: unknown[];
}

/** Message from store worker → main thread. */
export interface StoreResponse {
  id: number;
  result?: unknown;
  error?: string;
}

/** Schema version — bump this when the schema changes in a breaking way. */
export const SCHEMA_VERSION = 5;
