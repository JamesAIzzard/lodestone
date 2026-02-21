/**
 * Per-silo vector store using Orama.
 *
 * Each silo has its own Orama database instance with vector search support.
 * The database is stored at the silo's configured db_path.
 */

import {
  create,
  insert,
  remove,
  search,
  searchVector,
  count,
  type AnyOrama,
} from '@orama/orama';
import { persist, restore } from '@orama/plugin-data-persistence';
import fs from 'node:fs';
import path from 'node:path';
import type { ChunkRecord } from './pipeline-types';

// ── Types ────────────────────────────────────────────────────────────────────

export interface StoredChunk {
  filePath: string;
  chunkIndex: number;
  sectionPath: string;      // JSON-encoded string[] (Orama doesn't support arrays of strings natively)
  text: string;
  startLine: number;
  endLine: number;
  metadata: string;         // JSON-encoded Record<string, unknown>
  contentHash: string;
  embedding: number[];
}

export interface SiloSearchResultChunk {
  sectionPath: string[];
  text: string;
  startLine: number;
  endLine: number;
  score: number;
}

export interface SiloSearchResult {
  filePath: string;
  score: number;
  chunks: SiloSearchResultChunk[];
}

export type SiloDatabase = AnyOrama;

// ── Create ───────────────────────────────────────────────────────────────────

/**
 * Create a new in-memory Orama database for a silo.
 * @param dimensions Vector dimensionality (e.g. 384 for MiniLM)
 */
export async function createSiloDatabase(dimensions: number): Promise<SiloDatabase> {
  return create({
    schema: {
      filePath: 'string',
      chunkIndex: 'number',
      sectionPath: 'string',
      text: 'string',
      startLine: 'number',
      endLine: 'number',
      metadata: 'string',
      contentHash: 'string',
      embedding: `vector[${dimensions}]`,
    } as const,
  });
}

// ── Upsert / Delete ──────────────────────────────────────────────────────────

/**
 * Remove all existing chunks for a file and insert new ones.
 * This is the atomic unit for file updates — always replaces all chunks for a file.
 */
export async function upsertFileChunks(
  db: SiloDatabase,
  filePath: string,
  chunks: ChunkRecord[],
  embeddings: number[][],
): Promise<void> {
  // First remove any existing chunks for this file
  await deleteFileChunks(db, filePath);

  // Insert new chunks
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    await insert(db, {
      filePath: chunk.filePath,
      chunkIndex: chunk.chunkIndex,
      sectionPath: JSON.stringify(chunk.sectionPath),
      text: chunk.text,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      metadata: JSON.stringify(chunk.metadata),
      contentHash: chunk.contentHash,
      embedding: embeddings[i],
    });
  }
}

/**
 * Remove all chunks belonging to a file.
 *
 * Uses full-text search on the filePath property to find candidates,
 * then an exact === check to filter out false positives from tokenisation.
 * This is safe because no single file can produce enough chunks to exceed
 * the 10,000 result limit.
 */
export async function deleteFileChunks(db: SiloDatabase, filePath: string): Promise<void> {
  const results = await search(db, {
    term: filePath,
    properties: ['filePath'],
    limit: 10000,
    threshold: 0,
  });

  for (const hit of results.hits) {
    if ((hit.document as unknown as StoredChunk).filePath === filePath) {
      await remove(db, hit.id);
    }
  }
}

// ── Search ───────────────────────────────────────────────────────────────────

/**
 * Search the silo database with a query vector.
 * Results are aggregated by file — each file's score is its best chunk score.
 * Returns a ranked list of files.
 */
export async function searchSilo(
  db: SiloDatabase,
  queryVector: number[],
  maxResults: number = 10,
): Promise<SiloSearchResult[]> {
  // Search for more chunks than needed, then aggregate by file
  const chunkLimit = maxResults * 5;
  const results = await searchVector(db, {
    vector: { value: queryVector, property: 'embedding' },
    limit: chunkLimit,
    similarity: 0.0,
    mode: 'vector',
  });

  // Aggregate by file: collect top chunks per file
  const maxChunksPerFile = 5;
  const fileMap = new Map<string, { bestScore: number; chunks: SiloSearchResultChunk[] }>();

  for (const hit of results.hits) {
    const doc = hit.document as unknown as StoredChunk;
    const sectionPath: string[] = JSON.parse(doc.sectionPath);
    const chunk: SiloSearchResultChunk = {
      sectionPath,
      text: doc.text,
      startLine: doc.startLine,
      endLine: doc.endLine,
      score: hit.score,
    };

    const existing = fileMap.get(doc.filePath);
    if (existing) {
      existing.chunks.push(chunk);
      if (hit.score > existing.bestScore) existing.bestScore = hit.score;
    } else {
      fileMap.set(doc.filePath, { bestScore: hit.score, chunks: [chunk] });
    }
  }

  // Sort chunks within each file, keep top N
  for (const entry of fileMap.values()) {
    entry.chunks.sort((a, b) => b.score - a.score);
    if (entry.chunks.length > maxChunksPerFile) entry.chunks.length = maxChunksPerFile;
  }

  // Sort files by best score descending and limit
  return Array.from(fileMap.entries())
    .map(([filePath, { bestScore, chunks }]) => ({ filePath, score: bestScore, chunks }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

// ── Persistence ──────────────────────────────────────────────────────────────

/**
 * Save the database to disk at the given path.
 *
 * Writes to a temporary file first, then atomically renames it into place.
 * This prevents a crash mid-write from corrupting the only copy on disk.
 */
export async function persistDatabase(db: SiloDatabase, dbPath: string): Promise<void> {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const data = await persist(db, 'json');
  const tmpPath = dbPath + '.tmp';
  await fs.promises.writeFile(tmpPath, data as string);
  fs.renameSync(tmpPath, dbPath);
}

/**
 * Load a database from disk. Returns null if the file doesn't exist
 * or is corrupt (e.g. truncated by a crash).
 */
export async function loadDatabase(dbPath: string, _dimensions: number): Promise<SiloDatabase | null> {
  if (!fs.existsSync(dbPath)) return null;
  try {
    const raw = fs.readFileSync(dbPath, 'utf-8');
    return await (restore('json', raw) as Promise<SiloDatabase>);
  } catch (err) {
    console.error(`[store] Failed to load database from ${dbPath}, starting fresh:`, err);
    return null;
  }
}

// ── Stats ────────────────────────────────────────────────────────────────────

/**
 * Get the total number of chunks in the database.
 */
export async function getChunkCount(db: SiloDatabase): Promise<number> {
  return count(db);
}

/**
 * Get the content hash for a specific file's chunks (for change detection).
 * Returns null if the file is not in the database.
 */
export async function getFileHashes(
  db: SiloDatabase,
  filePath: string,
): Promise<string[] | null> {
  const results = await search(db, {
    term: filePath,
    properties: ['filePath'],
    limit: 10000,
    threshold: 0,
  });

  const hashes: string[] = [];
  for (const hit of results.hits) {
    const doc = hit.document as unknown as StoredChunk;
    if (doc.filePath === filePath) {
      hashes.push(doc.contentHash);
    }
  }

  return hashes.length > 0 ? hashes : null;
}

// ── Meta (Sidecar) ────────────────────────────────────────────────────────

/**
 * Sidecar metadata stored alongside the database file.
 * Records the model used to build the index, enabling mismatch detection
 * when the user changes their embedding model.
 */
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

const META_VERSION = 1;

/**
 * Load the silo meta sidecar from disk.
 * Returns null if the file doesn't exist or is corrupt.
 */
export function loadMeta(metaPath: string): SiloMeta | null {
  if (!fs.existsSync(metaPath)) return null;
  try {
    const raw = fs.readFileSync(metaPath, 'utf-8');
    const obj = JSON.parse(raw) as SiloMeta;
    if (typeof obj.model !== 'string' || typeof obj.dimensions !== 'number') {
      return null;
    }
    return obj;
  } catch {
    return null;
  }
}

/**
 * Save the silo meta sidecar to disk.
 * Uses atomic write (tmp + rename) to prevent corruption on crash.
 */
export function saveMeta(metaPath: string, model: string, dimensions: number): void {
  const existing = loadMeta(metaPath);
  const meta: SiloMeta = {
    model,
    dimensions,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    version: META_VERSION,
  };
  const dir = path.dirname(metaPath);
  fs.mkdirSync(dir, { recursive: true });
  const data = JSON.stringify(meta, null, 2);
  const tmpPath = metaPath + '.tmp';
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, metaPath);
}

// ── Mtime Persistence ─────────────────────────────────────────────────────

/**
 * Load the file-path → mtime map from disk.
 * Returns an empty map if the file doesn't exist or is corrupt.
 */
export function loadMtimes(mtimesPath: string): Map<string, number> {
  if (!fs.existsSync(mtimesPath)) return new Map();
  try {
    const raw = fs.readFileSync(mtimesPath, 'utf-8');
    const obj = JSON.parse(raw) as Record<string, number>;
    return new Map(Object.entries(obj));
  } catch (err) {
    console.error(`[store] Failed to load mtimes from ${mtimesPath}, starting fresh:`, err);
    return new Map();
  }
}

/**
 * Save the file-path → mtime map to disk.
 * Uses atomic write (tmp + rename) to prevent corruption on crash.
 */
export async function saveMtimes(mtimes: Map<string, number>, mtimesPath: string): Promise<void> {
  const dir = path.dirname(mtimesPath);
  fs.mkdirSync(dir, { recursive: true });
  const data = JSON.stringify(Object.fromEntries(mtimes));
  const tmpPath = mtimesPath + '.tmp';
  await fs.promises.writeFile(tmpPath, data);
  fs.renameSync(tmpPath, mtimesPath);
}
