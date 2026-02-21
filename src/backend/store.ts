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
import type { ChunkRecord } from './chunker';

// ── Types ────────────────────────────────────────────────────────────────────

export interface StoredChunk {
  filePath: string;
  chunkIndex: number;
  headingPath: string;      // JSON-encoded string[] (Orama doesn't support arrays of strings natively)
  text: string;
  startLine: number;
  endLine: number;
  frontmatter: string;      // JSON-encoded Record<string, unknown>
  contentHash: string;
  embedding: number[];
}

export interface SiloSearchResult {
  filePath: string;
  score: number;
  sectionName: string | null;
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
      headingPath: 'string',
      text: 'string',
      startLine: 'number',
      endLine: 'number',
      frontmatter: 'string',
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
      headingPath: JSON.stringify(chunk.headingPath),
      text: chunk.text,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      frontmatter: JSON.stringify(chunk.frontmatter),
      contentHash: chunk.contentHash,
      embedding: embeddings[i],
    });
  }
}

/**
 * Remove all chunks belonging to a file.
 */
export async function deleteFileChunks(db: SiloDatabase, filePath: string): Promise<void> {
  // Search for all chunks with this file path
  const results = await search(db, {
    term: filePath,
    properties: ['filePath'],
    limit: 10000,
    threshold: 0, // exact match
  });

  // Remove each matching document
  for (const hit of results.hits) {
    // Double-check the file path matches exactly (search might be fuzzy)
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

  // Aggregate by file: keep best score per file
  const fileScores = new Map<string, { score: number; sectionName: string | null }>();

  for (const hit of results.hits) {
    const doc = hit.document as unknown as StoredChunk;
    const existing = fileScores.get(doc.filePath);
    if (!existing || hit.score > existing.score) {
      const headingPath: string[] = JSON.parse(doc.headingPath);
      fileScores.set(doc.filePath, {
        score: hit.score,
        sectionName: headingPath.length > 0 ? headingPath[headingPath.length - 1] : null,
      });
    }
  }

  // Sort by score descending and limit
  return Array.from(fileScores.entries())
    .map(([filePath, { score, sectionName }]) => ({ filePath, score, sectionName }))
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
 * Get the set of unique file paths in the database.
 */
export async function getIndexedFiles(db: SiloDatabase): Promise<Set<string>> {
  // Search for all documents (empty term matches everything)
  const results = await search(db, {
    term: '',
    limit: 100000,
  });
  const files = new Set<string>();
  for (const hit of results.hits) {
    files.add((hit.document as unknown as StoredChunk).filePath);
  }
  return files;
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
