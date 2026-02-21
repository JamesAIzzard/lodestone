/**
 * Per-silo vector store using SQLite + sqlite-vec + FTS5.
 *
 * Each silo has its own SQLite database file with:
 *   - `chunks` table for chunk data
 *   - `chunks_fts` FTS5 virtual table for BM25 keyword search
 *   - `vec_chunks` sqlite-vec virtual table for vector similarity search
 *   - `mtimes` table for file modification times
 *   - `meta` table for silo metadata
 *
 * All functions are synchronous (better-sqlite3 is sync).
 * Callers that `await` them still work fine.
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import path from 'node:path';
import type { ChunkRecord } from './pipeline-types';

// ── Portable Path Utilities ──────────────────────────────────────────────────

/**
 * Convert an absolute file path to a portable stored key.
 * Format: "{dirIndex}:{relPath}" with forward slashes.
 * Throws if the path is not under any configured directory.
 */
export function makeStoredKey(absPath: string, directories: string[]): string {
  for (let i = 0; i < directories.length; i++) {
    const dir = directories[i];
    const rel = path.relative(dir, absPath);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return `${i}:${rel.replace(/\\/g, '/')}`;
    }
  }
  throw new Error(`Path not under any silo directory: ${absPath}`);
}

/**
 * Resolve a stored key back to an absolute path using the silo's configured directories.
 */
export function resolveStoredKey(storedKey: string, directories: string[]): string {
  const colonIdx = storedKey.indexOf(':');
  if (colonIdx === -1) return storedKey; // legacy absolute path — return as-is
  const dirIndex = parseInt(storedKey.slice(0, colonIdx), 10);
  const relPath = storedKey.slice(colonIdx + 1);
  return path.join(directories[dirIndex], relPath);
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface SiloSearchResultChunk {
  sectionPath: string[];
  text: string;
  startLine: number;
  endLine: number;
  score: number;
}

export type MatchType = 'semantic' | 'keyword' | 'both';

export interface SiloSearchResult {
  filePath: string;
  score: number;
  matchType: MatchType;
  chunks: SiloSearchResultChunk[];
  /** Best raw cosine similarity (0–1) among the file's vector-matched chunks.
   *  Used to calibrate RRF scores for cross-silo merging.
   *  0 for results with no vector match (keyword-only). */
  bestCosineSimilarity: number;
}

export type SiloDatabase = Database.Database;

// ── Silo Meta ────────────────────────────────────────────────────────────────

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

const META_VERSION = 2;

// ── Create ───────────────────────────────────────────────────────────────────

/**
 * Open or create a SQLite database for a silo.
 * Loads the sqlite-vec extension, creates tables if needed, and sets WAL mode.
 */
export function createSiloDatabase(dbPath: string, dimensions: number): SiloDatabase {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  sqliteVec.load(db);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id          INTEGER PRIMARY KEY,
      file_path   TEXT    NOT NULL,
      chunk_index INTEGER NOT NULL,
      section_path TEXT   NOT NULL,
      text        TEXT    NOT NULL,
      start_line  INTEGER NOT NULL,
      end_line    INTEGER NOT NULL,
      metadata    TEXT    NOT NULL DEFAULT '{}',
      content_hash TEXT   NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path);

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text,
      content=chunks,
      content_rowid=id
    );

    CREATE TABLE IF NOT EXISTS mtimes (
      file_path TEXT PRIMARY KEY,
      mtime_ms  REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // sqlite-vec virtual table — must be created separately because
  // CREATE VIRTUAL TABLE IF NOT EXISTS doesn't work reliably for vec0.
  // Check if it exists first.
  const vecTableExists = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='vec_chunks'`,
  ).get();

  if (!vecTableExists) {
    db.exec(`CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[${dimensions}])`);
  }

  return db;
}

// ── Upsert / Delete ──────────────────────────────────────────────────────────

/**
 * Remove all existing chunks for a file and insert new ones.
 * Wraps the entire operation in a transaction for atomicity.
 */
export function upsertFileChunks(
  db: SiloDatabase,
  filePath: string,
  chunks: ChunkRecord[],
  embeddings: number[][],
): void {
  const transaction = db.transaction(() => {
    // 1. Fetch existing chunks for FTS5 sync (external content requires old text for delete)
    const existingRows = db.prepare(
      `SELECT id, text FROM chunks WHERE file_path = ?`,
    ).all(filePath) as Array<{ id: number; text: string }>;

    // 2. Remove from FTS5 (external content: must supply old values)
    const ftsDelete = db.prepare(
      `INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', ?, ?)`,
    );
    for (const row of existingRows) {
      ftsDelete.run(row.id, row.text);
    }

    // 3. Remove from vec_chunks
    const vecDelete = db.prepare(`DELETE FROM vec_chunks WHERE rowid = ?`);
    for (const row of existingRows) {
      vecDelete.run(row.id);
    }

    // 4. Remove from chunks
    db.prepare(`DELETE FROM chunks WHERE file_path = ?`).run(filePath);

    // 5. Insert new chunks
    //    Insert into vec_chunks first (auto-assigns rowid), then use that
    //    rowid as the explicit id in the chunks and FTS5 tables.
    //    This works around sqlite-vec not accepting explicit rowid on INSERT.
    const insertVec = db.prepare(
      `INSERT INTO vec_chunks(embedding) VALUES (?)`,
    );
    const insertChunk = db.prepare(`
      INSERT INTO chunks (id, file_path, chunk_index, section_path, text, start_line, end_line, metadata, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = db.prepare(
      `INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)`,
    );

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      // Insert vector first to get the auto-assigned rowid
      const vecResult = insertVec.run(float32Buffer(embeddings[i]));
      const rowid = Number(vecResult.lastInsertRowid);
      // Use that rowid as the chunk's explicit id
      insertChunk.run(
        rowid,
        chunk.filePath,
        chunk.chunkIndex,
        JSON.stringify(chunk.sectionPath),
        chunk.text,
        chunk.startLine,
        chunk.endLine,
        JSON.stringify(chunk.metadata),
        chunk.contentHash,
      );
      insertFts.run(rowid, chunk.text);
    }
  });

  transaction();
}

/**
 * Remove all chunks belonging to a file.
 */
export function deleteFileChunks(db: SiloDatabase, filePath: string): void {
  const transaction = db.transaction(() => {
    // Fetch existing for FTS5 sync
    const existingRows = db.prepare(
      `SELECT id, text FROM chunks WHERE file_path = ?`,
    ).all(filePath) as Array<{ id: number; text: string }>;

    // Remove from FTS5
    const ftsDelete = db.prepare(
      `INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', ?, ?)`,
    );
    for (const row of existingRows) {
      ftsDelete.run(row.id, row.text);
    }

    // Remove from vec_chunks
    const vecDelete = db.prepare(`DELETE FROM vec_chunks WHERE rowid = ?`);
    for (const row of existingRows) {
      vecDelete.run(row.id);
    }

    // Remove from chunks
    db.prepare(`DELETE FROM chunks WHERE file_path = ?`).run(filePath);
  });

  transaction();
}

// ── Search ───────────────────────────────────────────────────────────────────

/**
 * Search the silo database with a query vector (vector-only search).
 * Results are aggregated by file — each file's score is its best chunk score.
 */
export function searchSilo(
  db: SiloDatabase,
  queryVector: number[],
  maxResults: number = 10,
): SiloSearchResult[] {
  const chunkLimit = maxResults * 5;

  const rows = db.prepare(`
    SELECT c.id, c.file_path, c.chunk_index, c.section_path, c.text,
           c.start_line, c.end_line, c.metadata, c.content_hash, v.distance
    FROM vec_chunks v
    JOIN chunks c ON c.id = v.rowid
    WHERE v.embedding MATCH ?
      AND k = ?
    ORDER BY v.distance
  `).all(float32Buffer(queryVector), chunkLimit) as Array<{
    id: number;
    file_path: string;
    chunk_index: number;
    section_path: string;
    text: string;
    start_line: number;
    end_line: number;
    metadata: string;
    content_hash: string;
    distance: number;
  }>;

  return aggregateByFile(rows, maxResults);
}

/**
 * Hybrid search: combines vector similarity (sqlite-vec) and BM25 keyword search (FTS5)
 * using Reciprocal Rank Fusion (RRF).
 */
export function hybridSearchSilo(
  db: SiloDatabase,
  queryVector: number[],
  queryText: string,
  maxResults: number = 10,
  vectorWeight: number = 0.5,
): SiloSearchResult[] {
  const chunkLimit = maxResults * 5;
  const k = 60; // RRF constant

  // 1. Vector search
  const vecRows = db.prepare(`
    SELECT v.rowid, v.distance
    FROM vec_chunks v
    WHERE v.embedding MATCH ?
      AND k = ?
    ORDER BY v.distance
  `).all(float32Buffer(queryVector), chunkLimit) as Array<{
    rowid: number;
    distance: number;
  }>;

  // 2. BM25 keyword search
  const sanitised = sanitiseFtsQuery(queryText);
  let ftsRows: Array<{ rowid: number; rank: number }> = [];
  if (sanitised.length > 0) {
    try {
      ftsRows = db.prepare(`
        SELECT rowid, rank
        FROM chunks_fts
        WHERE chunks_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(sanitised, chunkLimit) as Array<{ rowid: number; rank: number }>;
    } catch {
      // FTS5 query syntax error — fall back to vector-only
    }
  }

  // 3. Build RRF scores
  const penaltyRank = chunkLimit + 1;
  const bm25Weight = 1 - vectorWeight;

  // Map chunk ID → cosine similarity (for cross-silo score calibration)
  const cosineSims = new Map<number, number>();
  for (const row of vecRows) {
    // sqlite-vec returns cosine distance (0 = identical, 2 = opposite)
    cosineSims.set(row.rowid, 1 - row.distance / 2);
  }

  // Map chunk ID → vector rank (1-based)
  const vecRankMap = new Map<number, number>();
  for (let i = 0; i < vecRows.length; i++) {
    vecRankMap.set(vecRows[i].rowid, i + 1);
  }

  // Map chunk ID → BM25 rank (1-based)
  const ftsRankMap = new Map<number, number>();
  for (let i = 0; i < ftsRows.length; i++) {
    ftsRankMap.set(ftsRows[i].rowid, i + 1);
  }

  // Union of all chunk IDs
  const allIds = new Set([...vecRankMap.keys(), ...ftsRankMap.keys()]);

  // Compute RRF scores, normalized so rank-1-in-both = 1.0
  const maxRrf = vectorWeight / (k + 1) + bm25Weight / (k + 1); // theoretical best
  const rrfScores = new Map<number, number>();
  for (const id of allIds) {
    const vr = vecRankMap.get(id) ?? penaltyRank;
    const fr = ftsRankMap.get(id) ?? penaltyRank;
    const raw = vectorWeight / (k + vr) + bm25Weight / (k + fr);
    rrfScores.set(id, raw / maxRrf);
  }

  // Sort by RRF score descending, take top chunks
  const sortedIds = Array.from(rrfScores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, chunkLimit)
    .map(([id]) => id);

  if (sortedIds.length === 0) return [];

  // 4. Fetch chunk data for the top IDs
  // Use a temp table to batch fetch
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS _rrf_ids (id INTEGER PRIMARY KEY, score REAL)`);
  db.exec(`DELETE FROM _rrf_ids`);
  const insertId = db.prepare(`INSERT INTO _rrf_ids (id, score) VALUES (?, ?)`);
  for (const id of sortedIds) {
    insertId.run(id, rrfScores.get(id)!);
  }

  const rows = db.prepare(`
    SELECT c.id, c.file_path, c.chunk_index, c.section_path, c.text,
           c.start_line, c.end_line, c.metadata, c.content_hash,
           r.score as rrf_score
    FROM chunks c
    JOIN _rrf_ids r ON r.id = c.id
    ORDER BY r.score DESC
  `).all() as Array<{
    id: number;
    file_path: string;
    chunk_index: number;
    section_path: string;
    text: string;
    start_line: number;
    end_line: number;
    metadata: string;
    content_hash: string;
    rrf_score: number;
  }>;

  return aggregateByFileRrf(rows, maxResults, new Set(vecRankMap.keys()), new Set(ftsRankMap.keys()), cosineSims);
}

// ── Stats ────────────────────────────────────────────────────────────────────

/**
 * Get the total number of chunks in the database.
 */
export function getChunkCount(db: SiloDatabase): number {
  const row = db.prepare(`SELECT COUNT(*) as cnt FROM chunks`).get() as { cnt: number };
  return row.cnt;
}

/**
 * Get the content hashes for a specific file's chunks.
 * Returns null if the file is not in the database.
 */
export function getFileHashes(db: SiloDatabase, filePath: string): string[] | null {
  const rows = db.prepare(
    `SELECT content_hash FROM chunks WHERE file_path = ?`,
  ).all(filePath) as Array<{ content_hash: string }>;
  return rows.length > 0 ? rows.map((r) => r.content_hash) : null;
}

// ── Mtime Persistence ────────────────────────────────────────────────────────

/**
 * Load the file-path → mtime map from the database.
 */
export function loadMtimes(db: SiloDatabase): Map<string, number> {
  const rows = db.prepare(`SELECT file_path, mtime_ms FROM mtimes`).all() as Array<{
    file_path: string;
    mtime_ms: number;
  }>;
  return new Map(rows.map((r) => [r.file_path, r.mtime_ms]));
}

/**
 * Bulk save mtimes (replace all entries).
 */
export function saveMtimes(db: SiloDatabase, mtimes: Map<string, number>): void {
  const transaction = db.transaction(() => {
    db.prepare(`DELETE FROM mtimes`).run();
    const insert = db.prepare(`INSERT INTO mtimes (file_path, mtime_ms) VALUES (?, ?)`);
    for (const [filePath, mtimeMs] of mtimes) {
      insert.run(filePath, mtimeMs);
    }
  });
  transaction();
}

/**
 * Set or update a single mtime entry.
 */
export function setMtime(db: SiloDatabase, filePath: string, mtimeMs: number): void {
  db.prepare(`INSERT OR REPLACE INTO mtimes (file_path, mtime_ms) VALUES (?, ?)`).run(filePath, mtimeMs);
}

/**
 * Delete a single mtime entry.
 */
export function deleteMtime(db: SiloDatabase, filePath: string): void {
  db.prepare(`DELETE FROM mtimes WHERE file_path = ?`).run(filePath);
}

/**
 * Count the number of mtime entries (used for sleeping/waiting status).
 */
export function countMtimes(db: SiloDatabase): number {
  const row = db.prepare(`SELECT COUNT(*) as cnt FROM mtimes`).get() as { cnt: number };
  return row.cnt;
}

// ── Meta Persistence ─────────────────────────────────────────────────────────

/**
 * Load silo metadata from the database.
 * Returns null if no metadata has been stored yet.
 */
export function loadMeta(db: SiloDatabase): SiloMeta | null {
  const rows = db.prepare(`SELECT key, value FROM meta`).all() as Array<{ key: string; value: string }>;
  if (rows.length === 0) return null;

  const map = new Map(rows.map((r) => [r.key, r.value]));
  const model = map.get('model');
  const dimensions = map.get('dimensions');
  if (!model || !dimensions) return null;

  return {
    model,
    dimensions: parseInt(dimensions, 10),
    createdAt: map.get('createdAt') ?? new Date().toISOString(),
    version: parseInt(map.get('version') ?? String(META_VERSION), 10),
  };
}

/**
 * Save silo metadata to the database.
 */
export function saveMeta(db: SiloDatabase, model: string, dimensions: number): void {
  const existing = loadMeta(db);
  const meta: SiloMeta = {
    model,
    dimensions,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    version: META_VERSION,
  };

  const upsert = db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`);
  const transaction = db.transaction(() => {
    upsert.run('model', meta.model);
    upsert.run('dimensions', String(meta.dimensions));
    upsert.run('createdAt', meta.createdAt);
    upsert.run('version', String(meta.version));
  });
  transaction();
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Convert a number[] to a Buffer wrapping a Float32Array.
 * better-sqlite3 requires Buffer (not Float32Array) for blob parameters.
 */
function float32Buffer(vec: number[]): Buffer {
  const f32 = new Float32Array(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/**
 * Sanitise a user query for FTS5 MATCH.
 * Wraps each term in double quotes for safe phrase matching.
 */
function sanitiseFtsQuery(query: string): string {
  return query
    .replace(/"/g, '""')
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term}"`)
    .join(' ');
}

/**
 * Aggregate vector search rows by file (for searchSilo).
 * Converts cosine distance to similarity score (higher = better).
 */
function aggregateByFile(
  rows: Array<{
    id: number;
    file_path: string;
    section_path: string;
    text: string;
    start_line: number;
    end_line: number;
    distance: number;
  }>,
  maxResults: number,
): SiloSearchResult[] {
  const maxChunksPerFile = 5;
  const fileMap = new Map<string, { bestScore: number; chunks: SiloSearchResultChunk[] }>();

  for (const row of rows) {
    // Convert cosine distance (0 = identical, 2 = opposite) to similarity score
    const score = 1 - row.distance / 2;
    const sectionPath: string[] = JSON.parse(row.section_path);
    const chunk: SiloSearchResultChunk = {
      sectionPath,
      text: row.text,
      startLine: row.start_line,
      endLine: row.end_line,
      score,
    };

    const existing = fileMap.get(row.file_path);
    if (existing) {
      existing.chunks.push(chunk);
      if (score > existing.bestScore) existing.bestScore = score;
    } else {
      fileMap.set(row.file_path, { bestScore: score, chunks: [chunk] });
    }
  }

  for (const entry of fileMap.values()) {
    entry.chunks.sort((a, b) => b.score - a.score);
    if (entry.chunks.length > maxChunksPerFile) entry.chunks.length = maxChunksPerFile;
  }

  return Array.from(fileMap.entries())
    .map(([filePath, { bestScore, chunks }]) => ({
      filePath, score: bestScore, matchType: 'semantic' as MatchType,
      bestCosineSimilarity: bestScore, chunks,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

/**
 * Aggregate hybrid search rows by file (for hybridSearchSilo).
 * RRF scores are already computed — just aggregate.
 * vecIds/ftsIds track which chunks were found by each method.
 */
function aggregateByFileRrf(
  rows: Array<{
    id: number;
    file_path: string;
    section_path: string;
    text: string;
    start_line: number;
    end_line: number;
    rrf_score: number;
  }>,
  maxResults: number,
  vecIds: Set<number>,
  ftsIds: Set<number>,
  cosineSims: Map<number, number>,
): SiloSearchResult[] {
  const maxChunksPerFile = 5;
  const fileMap = new Map<string, {
    bestScore: number;
    bestCosineSim: number;
    hasVec: boolean;
    hasFts: boolean;
    chunks: SiloSearchResultChunk[];
  }>();

  for (const row of rows) {
    const sectionPath: string[] = JSON.parse(row.section_path);
    const chunk: SiloSearchResultChunk = {
      sectionPath,
      text: row.text,
      startLine: row.start_line,
      endLine: row.end_line,
      score: row.rrf_score,
    };

    const inVec = vecIds.has(row.id);
    const inFts = ftsIds.has(row.id);
    const cosineSim = cosineSims.get(row.id) ?? 0;

    const existing = fileMap.get(row.file_path);
    if (existing) {
      existing.chunks.push(chunk);
      if (row.rrf_score > existing.bestScore) existing.bestScore = row.rrf_score;
      if (cosineSim > existing.bestCosineSim) existing.bestCosineSim = cosineSim;
      if (inVec) existing.hasVec = true;
      if (inFts) existing.hasFts = true;
    } else {
      fileMap.set(row.file_path, {
        bestScore: row.rrf_score,
        bestCosineSim: cosineSim,
        hasVec: inVec,
        hasFts: inFts,
        chunks: [chunk],
      });
    }
  }

  for (const entry of fileMap.values()) {
    entry.chunks.sort((a, b) => b.score - a.score);
    if (entry.chunks.length > maxChunksPerFile) entry.chunks.length = maxChunksPerFile;
  }

  return Array.from(fileMap.entries())
    .map(([filePath, { bestScore, bestCosineSim, hasVec, hasFts, chunks }]) => {
      let matchType: MatchType = 'semantic';
      if (hasVec && hasFts) matchType = 'both';
      else if (hasFts) matchType = 'keyword';
      return { filePath, score: bestScore, matchType, bestCosineSimilarity: bestCosineSim, chunks };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}
