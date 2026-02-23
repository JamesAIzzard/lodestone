/**
 * Per-silo vector store using SQLite + sqlite-vec + FTS5.
 *
 * Each silo has its own SQLite database file with:
 *   - `chunks` table for chunk data (with heading_depth and tags_text columns)
 *   - `chunks_fts` FTS5 virtual table for BM25 keyword search (unicode61)
 *   - `chunks_trigram` FTS5 virtual table for trigram substring search
 *   - `chunks_meta_fts` FTS5 virtual table for tags/metadata keyword search
 *   - `files` table tracking indexed file paths and basenames
 *   - `files_fts` FTS5 virtual table for filepath/filename trigram search
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
import type { SearchWeights, ScoreBreakdown, ScoreSource } from '../shared/types';
import { DEFAULT_SEARCH_WEIGHTS } from '../shared/types';
import { tokenise } from './tokeniser';
import { scoreBm25 } from './scorers/bm25';
import { scoreFilenames } from './scorers/filename';

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
 * Convert an absolute directory path to a stored dir-key (like makeStoredKey but with trailing '/').
 * Returns null if the path is not under any configured directory or is a silo root itself.
 */
export function makeStoredDirKey(absDirPath: string, directories: string[]): string | null {
  for (let i = 0; i < directories.length; i++) {
    const dir = directories[i];
    if (absDirPath === dir) return null; // silo root — not tracked individually
    const rel = path.relative(dir, absDirPath);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return `${i}:${rel.replace(/\\/g, '/')}/`;
    }
  }
  return null;
}

/**
 * Insert a single directory entry (by stored dir-key) if it doesn't already exist.
 * Extracts dirName and depth from the stored key.
 */
/**
 * Returns true if the row was newly inserted, false if it already existed.
 */
export function insertDirEntry(db: SiloDatabase, dirPath: string): boolean {
  // dirPath looks like "0:src/backend/" — derive name and depth
  const colonIdx = dirPath.indexOf(':');
  if (colonIdx === -1) return false;
  const rel = dirPath.slice(colonIdx + 1, -1); // strip trailing '/'
  const segments = rel.split('/').filter(Boolean);
  if (segments.length === 0) return false;
  const dirName = segments[segments.length - 1];
  const depth = segments.length;
  const result = db.prepare(
    `INSERT OR IGNORE INTO directories (dir_path, dir_name, depth, file_count, subdir_count) VALUES (?, ?, ?, 0, 0)`,
  ).run(dirPath, dirName, depth);
  return result.changes > 0;
}

/**
 * Delete a single directory entry (and its vec/fts rows) by stored dir-key.
 * Returns the deleted directory id, or null if not found.
 */
export function deleteDirEntry(db: SiloDatabase, dirPath: string): number | null {
  const row = db.prepare(`SELECT id FROM directories WHERE dir_path = ?`).get(dirPath) as { id: number } | undefined;
  if (!row) return null;
  db.transaction(() => {
    try { db.prepare(`DELETE FROM dirs_fts WHERE rowid = ?`).run(row.id); } catch { /* ignore */ }
    db.prepare(`DELETE FROM directories WHERE id = ?`).run(row.id);
  })();
  return row.id;
}

/**
 * Resolve a stored key back to an absolute path using the silo's configured directories.
 */
export function resolveStoredKey(storedKey: string, directories: string[]): string {
  const colonIdx = storedKey.indexOf(':');
  if (colonIdx === -1) {
    console.warn(`[store] Legacy absolute path in stored key: ${storedKey}`);
    return storedKey;
  }
  const dirIndex = parseInt(storedKey.slice(0, colonIdx), 10);
  if (isNaN(dirIndex) || dirIndex < 0 || dirIndex >= directories.length) {
    console.warn(`[store] Invalid dirIndex ${dirIndex} in stored key "${storedKey}" (${directories.length} directories)`);
    return storedKey;
  }
  const relPath = storedKey.slice(colonIdx + 1);
  return path.join(directories[dirIndex], relPath);
}

// ── Types ────────────────────────────────────────────────────────────────────

export type MatchType = 'semantic' | 'keyword' | 'both';

export interface SiloSearchResultChunk {
  sectionPath: string[];
  text: string;
  startLine: number;
  endLine: number;
  score: number;
  /** Whether this chunk was found by semantic, keyword, or both search paths */
  matchType: MatchType;
  /** Cosine similarity to the query (0 for keyword-only chunks) */
  cosineSimilarity: number;
  /** Per-signal score breakdown */
  breakdown: ScoreBreakdown;
}

export interface SiloSearchResult {
  filePath: string;
  score: number;
  /** Whether the file's score was driven by a filename/path match or content signals */
  scoreSource: ScoreSource;
  matchType: MatchType;
  chunks: SiloSearchResultChunk[];
  /** Best raw cosine similarity (0–1) among the file's vector-matched chunks. */
  bestCosineSimilarity: number;
  /** The search weights used for this result */
  weights: SearchWeights;
  /** Best chunk's score breakdown */
  breakdown: ScoreBreakdown;
}

export type SiloDatabase = Database.Database;

// ── Search Constants ─────────────────────────────────────────────────────────

/** Reciprocal Rank Fusion smoothing constant (standard default from Cormack et al. 2009). */
export const RRF_K = 60;

/** Candidate fan-out: retrieve this many × maxResults chunks before aggregating by file. */
export const CHUNK_FANOUT = 5;

/** Maximum chunks returned per file in search results. */
export const MAX_CHUNKS_PER_FILE = 5;

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

// ── Stored Config Blob ──────────────────────────────────────────────────────

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

// ── sqlite-vec extension path ─────────────────────────────────────────────────
// sqlite-vec's getLoadablePath() computes a path via __dirname which, in a
// production ASAR build, points inside app.asar.  SQLite's loadExtension()
// calls the OS's LoadLibrary/dlopen which can't read from ASAR archives.
// The actual DLL/dylib/so is unpacked to app.asar.unpacked — rewrite the
// path so SQLite can find it.
const vecExtPath = sqliteVec.getLoadablePath().replace(
  /app\.asar([\\/])/,
  'app.asar.unpacked$1',
);

// ── Create ───────────────────────────────────────────────────────────────────

/**
 * Open or create a SQLite database for a silo.
 * Loads the sqlite-vec extension, creates tables if needed, and sets WAL mode.
 */
export function createSiloDatabase(dbPath: string, dimensions: number): SiloDatabase {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.loadExtension(vecExtPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id            INTEGER PRIMARY KEY,
      file_path     TEXT    NOT NULL,
      chunk_index   INTEGER NOT NULL,
      section_path  TEXT    NOT NULL,
      text          TEXT    NOT NULL,
      start_line    INTEGER NOT NULL,
      end_line      INTEGER NOT NULL,
      metadata      TEXT    NOT NULL DEFAULT '{}',
      content_hash  TEXT    NOT NULL,
      heading_depth INTEGER NOT NULL DEFAULT 0,
      tags_text     TEXT    NOT NULL DEFAULT '',
      token_count   INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path);

    CREATE TABLE IF NOT EXISTS files (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT UNIQUE NOT NULL,
      file_name TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text,
      content=chunks,
      content_rowid=id
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram USING fts5(
      text,
      tokenize='trigram'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
      file_path,
      file_name,
      tokenize='trigram'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_meta_fts USING fts5(
      tags_text
    );

    CREATE TABLE IF NOT EXISTS directories (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      dir_path     TEXT UNIQUE NOT NULL,
      dir_name     TEXT NOT NULL,
      depth        INTEGER NOT NULL,
      file_count   INTEGER NOT NULL DEFAULT 0,
      subdir_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_directories_depth ON directories(depth);

    CREATE TABLE IF NOT EXISTS mtimes (
      file_path TEXT PRIMARY KEY,
      mtime_ms  REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Inverted index for hand-rolled BM25 scoring
    CREATE TABLE IF NOT EXISTS terms (
      term     TEXT PRIMARY KEY,
      doc_freq INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS postings (
      term      TEXT    NOT NULL,
      chunk_id  INTEGER NOT NULL,
      term_freq INTEGER NOT NULL,
      PRIMARY KEY (term, chunk_id)
    );

    CREATE INDEX IF NOT EXISTS idx_postings_chunk ON postings(chunk_id);
  `);

  // Add new columns to existing databases that predate this schema version.
  const hasHeadingDepth = db.prepare(
    `SELECT 1 FROM pragma_table_info('chunks') WHERE name='heading_depth'`,
  ).get();
  if (!hasHeadingDepth) {
    db.exec(`ALTER TABLE chunks ADD COLUMN heading_depth INTEGER NOT NULL DEFAULT 0`);
  }

  const hasTagsText = db.prepare(
    `SELECT 1 FROM pragma_table_info('chunks') WHERE name='tags_text'`,
  ).get();
  if (!hasTagsText) {
    db.exec(`ALTER TABLE chunks ADD COLUMN tags_text TEXT NOT NULL DEFAULT ''`);
  }

  const hasTokenCount = db.prepare(
    `SELECT 1 FROM pragma_table_info('chunks') WHERE name='token_count'`,
  ).get();
  if (!hasTokenCount) {
    db.exec(`ALTER TABLE chunks ADD COLUMN token_count INTEGER NOT NULL DEFAULT 0`);
  }

  // sqlite-vec virtual table — must be created separately because
  // CREATE VIRTUAL TABLE IF NOT EXISTS doesn't work reliably for vec0.
  // Check if it exists first.
  const vecTableExists = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='vec_chunks'`,
  ).get();

  if (!vecTableExists) {
    db.exec(`CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[${dimensions}])`);
  }

  // dirs_fts: trigram search on directory paths and names
  const dirsFtsExists = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='dirs_fts'`,
  ).get();
  if (!dirsFtsExists) {
    db.exec(`CREATE VIRTUAL TABLE dirs_fts USING fts5(dir_path, dir_name, tokenize='trigram')`);
  }

  // Drop legacy dirs_vec if it exists (no longer used — directory search uses string scorers)
  const dirsVecExists = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='dirs_vec'`,
  ).get();
  if (dirsVecExists) {
    db.exec(`DROP TABLE dirs_vec`);
  }

  return db;
}

// ── Upsert / Delete ──────────────────────────────────────────────────────────

/**
 * Inner upsert logic — runs inside a caller-provided transaction.
 * Removes old chunks for the file, inserts new ones, and optionally persists mtime.
 */
function upsertFileInner(
  db: SiloDatabase,
  filePath: string,
  chunks: ChunkRecord[],
  embeddings: number[][],
  mtimeMs?: number,
): void {
  // 1. Fetch existing chunks for FTS5 sync (external content requires old text for delete)
  const existingRows = db.prepare(
    `SELECT id, text FROM chunks WHERE file_path = ?`,
  ).all(filePath) as Array<{ id: number; text: string }>;

  // 2. Remove from chunks_fts (external content: must supply old values)
  const ftsDelete = db.prepare(
    `INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', ?, ?)`,
  );
  for (const row of existingRows) {
    ftsDelete.run(row.id, row.text);
  }

  // 3. Remove from contentless FTS5 tables (chunks_trigram, chunks_meta_fts)
  const trigramDelete = db.prepare(`DELETE FROM chunks_trigram WHERE rowid = ?`);
  const metaFtsDelete = db.prepare(`DELETE FROM chunks_meta_fts WHERE rowid = ?`);
  for (const row of existingRows) {
    trigramDelete.run(row.id);
    metaFtsDelete.run(row.id);
  }

  // 3b. Remove from inverted index (postings + terms.doc_freq)
  if (existingRows.length > 0) {
    removeFromInvertedIndex(db, existingRows.map((r) => r.id));
  }

  // 4. Remove from vec_chunks
  const vecDelete = db.prepare(`DELETE FROM vec_chunks WHERE rowid = ?`);
  for (const row of existingRows) {
    vecDelete.run(row.id);
  }

  // 5. Remove from chunks
  db.prepare(`DELETE FROM chunks WHERE file_path = ?`).run(filePath);

  // 6. Ensure file entry exists in files table (insert once per unique path)
  const fileResult = db.prepare(
    `INSERT OR IGNORE INTO files (file_path, file_name) VALUES (?, ?)`,
  ).run(filePath, fileBasename(filePath));
  if (fileResult.changes > 0) {
    const fileRow = db.prepare(`SELECT id FROM files WHERE file_path = ?`).get(filePath) as { id: number };
    db.prepare(`INSERT INTO files_fts(rowid, file_path, file_name) VALUES(?, ?, ?)`)
      .run(fileRow.id, filePath, fileBasename(filePath));
  }

  // 7. Insert new chunks
  //    Insert into vec_chunks first (auto-assigns rowid), then use that
  //    rowid as the explicit id in the chunks and FTS5 tables.
  const insertVec = db.prepare(
    `INSERT INTO vec_chunks(embedding) VALUES (?)`,
  );
  const insertChunk = db.prepare(`
    INSERT INTO chunks (id, file_path, chunk_index, section_path, text, start_line, end_line, metadata, content_hash, heading_depth, tags_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFts = db.prepare(
    `INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)`,
  );
  const insertTrigram = db.prepare(
    `INSERT INTO chunks_trigram(rowid, text) VALUES (?, ?)`,
  );
  const insertMetaFts = db.prepare(
    `INSERT INTO chunks_meta_fts(rowid, tags_text) VALUES (?, ?)`,
  );

  const insertPosting = db.prepare(
    `INSERT OR REPLACE INTO postings (term, chunk_id, term_freq) VALUES (?, ?, ?)`,
  );
  const upsertTerm = db.prepare(
    `INSERT INTO terms (term, doc_freq) VALUES (?, 1) ON CONFLICT(term) DO UPDATE SET doc_freq = doc_freq + 1`,
  );

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const tokens = tokenise(chunk.text);
    const tokenCount = tokens.length;

    const vecResult = insertVec.run(float32Buffer(embeddings[i]));
    const rowid = Number(vecResult.lastInsertRowid);
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
      chunk.headingDepth,
      chunk.tagsText,
    );
    // Store token count on the chunk row
    db.prepare(`UPDATE chunks SET token_count = ? WHERE id = ?`).run(tokenCount, rowid);

    insertFts.run(rowid, chunk.text);
    insertTrigram.run(rowid, chunk.text);
    if (chunk.tagsText) {
      insertMetaFts.run(rowid, chunk.tagsText);
    }

    // Build inverted index: compute term frequencies and write postings
    const termFreqs = new Map<string, number>();
    for (const token of tokens) {
      termFreqs.set(token, (termFreqs.get(token) ?? 0) + 1);
    }
    for (const [term, freq] of termFreqs) {
      upsertTerm.run(term);
      insertPosting.run(term, rowid, freq);
    }
  }

  // Update corpus-level BM25 stats
  updateCorpusStats(db);

  if (mtimeMs !== undefined) {
    db.prepare(`INSERT OR REPLACE INTO mtimes (file_path, mtime_ms) VALUES (?, ?)`).run(filePath, mtimeMs);
  }

  // 8. Maintain directories table (insert new dirs, recompute counts)
  maintainDirectoriesOnUpsert(db, filePath);
}

/**
 * Inner delete logic — runs inside a caller-provided transaction.
 */
function deleteFileInner(db: SiloDatabase, filePath: string, deleteMtimeEntry?: boolean): void {
  const existingRows = db.prepare(
    `SELECT id, text FROM chunks WHERE file_path = ?`,
  ).all(filePath) as Array<{ id: number; text: string }>;

  const ftsDelete = db.prepare(
    `INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', ?, ?)`,
  );
  for (const row of existingRows) {
    ftsDelete.run(row.id, row.text);
  }

  const trigramDelete = db.prepare(`DELETE FROM chunks_trigram WHERE rowid = ?`);
  const metaFtsDelete = db.prepare(`DELETE FROM chunks_meta_fts WHERE rowid = ?`);
  for (const row of existingRows) {
    trigramDelete.run(row.id);
    metaFtsDelete.run(row.id);
  }

  // Remove from inverted index (postings + terms.doc_freq)
  if (existingRows.length > 0) {
    removeFromInvertedIndex(db, existingRows.map((r) => r.id));
  }

  const vecDelete = db.prepare(`DELETE FROM vec_chunks WHERE rowid = ?`);
  for (const row of existingRows) {
    vecDelete.run(row.id);
  }

  db.prepare(`DELETE FROM chunks WHERE file_path = ?`).run(filePath);

  // Remove file entry from files + files_fts
  const fileRow = db.prepare(`SELECT id FROM files WHERE file_path = ?`).get(filePath) as { id: number } | undefined;
  if (fileRow) {
    db.prepare(`DELETE FROM files_fts WHERE rowid = ?`).run(fileRow.id);
    db.prepare(`DELETE FROM files WHERE file_path = ?`).run(filePath);
  }

  if (deleteMtimeEntry) {
    db.prepare(`DELETE FROM mtimes WHERE file_path = ?`).run(filePath);
  }

  // Update corpus-level BM25 stats
  updateCorpusStats(db);

  // Recompute directory counts (never remove dirs — lifecycle driven by reconciliation)
  const dirPaths = extractDirectoryPaths(filePath);
  if (dirPaths.length > 0) {
    updateDirectoryCounts(db, dirPaths);
  }
}

/**
 * Remove all existing chunks for a file and insert new ones.
 * Wraps the operation in a single transaction.
 */
export function upsertFileChunks(
  db: SiloDatabase,
  filePath: string,
  chunks: ChunkRecord[],
  embeddings: number[][],
  mtimeMs?: number,
): void {
  db.transaction(() => upsertFileInner(db, filePath, chunks, embeddings, mtimeMs))();
}

/**
 * Remove all chunks belonging to a file.
 */
export function deleteFileChunks(db: SiloDatabase, filePath: string, deleteMtimeEntry?: boolean): void {
  db.transaction(() => deleteFileInner(db, filePath, deleteMtimeEntry))();
}

/**
 * Flush a batch of prepared files to the database in a single transaction.
 *
 * Files with chunks are upserted; files with empty chunks (no indexable content)
 * have their stale chunks removed. Batching many files into one transaction
 * avoids per-file WAL fsync overhead and reduces total main-thread blocking.
 */
export function flushPreparedFiles(
  db: SiloDatabase,
  upserts: Array<{
    filePath: string;
    chunks: ChunkRecord[];
    embeddings: number[][];
    mtimeMs?: number;
  }>,
  deletes?: Array<{ filePath: string; deleteMtime: boolean }>,
): void {
  db.transaction(() => {
    for (const file of upserts) {
      if (file.chunks.length === 0) {
        deleteFileInner(db, file.filePath, file.mtimeMs !== undefined);
      } else {
        upsertFileInner(db, file.filePath, file.chunks, file.embeddings, file.mtimeMs);
      }
    }
    if (deletes) {
      for (const entry of deletes) {
        deleteFileInner(db, entry.filePath, entry.deleteMtime);
      }
    }
  })();
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
  const chunkLimit = maxResults * CHUNK_FANOUT;

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
 * Hybrid search: combines 5 signals via Reciprocal Rank Fusion (RRF).
 *
 * Signals:
 *   1. Semantic   — sqlite-vec cosine similarity (vector search)
 *   2. BM25       — FTS5 unicode61 full-text keyword search
 *   3. Trigram    — FTS5 trigram substring search on chunk text
 *   4. Filepath   — FTS5 trigram search on file_path + file_name
 *   5. Tags       — FTS5 unicode61 search on tags/metadata text
 *
 * BM25 and trigram contributions are boosted by heading depth:
 *   boost = depth === 0 ? 1.0 : 1.0 + 0.1 * (7 - depth)
 *   (h1 → 1.6×, h2 → 1.5×, ..., h6 → 1.1×, no heading → 1.0×)
 */
export function hybridSearchSilo(
  db: SiloDatabase,
  queryVector: number[],
  queryText: string,
  maxResults: number = 10,
  weights: SearchWeights = DEFAULT_SEARCH_WEIGHTS,
  startPath?: string,
): SiloSearchResult[] {
  const chunkLimit = maxResults * CHUNK_FANOUT;
  const k = RRF_K;
  const w = normalizeWeights(weights);

  // 1. Semantic: sqlite-vec cosine search
  const vecRows = db.prepare(`
    SELECT v.rowid, v.distance
    FROM vec_chunks v
    WHERE v.embedding MATCH ?
      AND k = ?
    ORDER BY v.distance
  `).all(float32Buffer(queryVector), chunkLimit) as Array<{ rowid: number; distance: number }>;

  // 2. BM25: FTS5 unicode61 full-text search
  const sanitisedBm25 = sanitiseFtsQuery(queryText);
  let bm25Rows: Array<{ rowid: number; rank: number }> = [];
  if (sanitisedBm25.length > 0) {
    try {
      bm25Rows = db.prepare(`
        SELECT rowid, rank FROM chunks_fts
        WHERE chunks_fts MATCH ?
        ORDER BY rank LIMIT ?
      `).all(sanitisedBm25, chunkLimit) as Array<{ rowid: number; rank: number }>;
    } catch {
      // FTS5 query syntax error — skip signal
    }
  }

  // 3. Trigram: FTS5 trigram substring search on chunk text
  const sanitisedTrigram = sanitiseTrigramQuery(queryText);
  let trigramRows: Array<{ rowid: number; rank: number }> = [];
  if (sanitisedTrigram.length > 0) {
    try {
      trigramRows = db.prepare(`
        SELECT rowid, rank FROM chunks_trigram
        WHERE chunks_trigram MATCH ?
        ORDER BY rank LIMIT ?
      `).all(sanitisedTrigram, chunkLimit) as Array<{ rowid: number; rank: number }>;
    } catch {
      // Trigram query error — skip signal
    }
  }

  // 4. Filepath/filename: FTS5 trigram search ordered by relevance.
  //    Each matched file gets a 1-based rank; all chunks from that file inherit
  //    the file's rank so a strong filename match boosts every chunk equally,
  //    letting the content signals (semantic, BM25) pick the best chunk within it.
  const filepathFileRanks = new Map<string, number>(); // file_path → 1-based file rank
  if (sanitisedTrigram.length > 0) {
    try {
      const matchingFiles = db.prepare(`
        SELECT f.file_path FROM files f
        JOIN files_fts ON files_fts.rowid = f.id
        WHERE files_fts MATCH ?
        ORDER BY files_fts.rank
        LIMIT ?
      `).all(sanitisedTrigram, chunkLimit) as Array<{ file_path: string }>;

      for (let i = 0; i < matchingFiles.length; i++) {
        filepathFileRanks.set(matchingFiles[i].file_path, i + 1);
      }
    } catch {
      // Skip filepath signal on error
    }
  }

  // 5. Tags/metadata: FTS5 unicode61 search on tags_text
  let tagsRows: Array<{ rowid: number; rank: number }> = [];
  if (sanitisedBm25.length > 0) {
    try {
      tagsRows = db.prepare(`
        SELECT rowid, rank FROM chunks_meta_fts
        WHERE chunks_meta_fts MATCH ?
        ORDER BY rank LIMIT ?
      `).all(sanitisedBm25, chunkLimit) as Array<{ rowid: number; rank: number }>;
    } catch {
      // Skip tags signal on error
    }
  }

  // Build rank maps (1-based) and raw score maps
  const cosineSims = new Map<number, number>();
  const vecRankMap = new Map<number, number>();
  const vecRawScores = new Map<number, number>();
  for (let i = 0; i < vecRows.length; i++) {
    const cosine = 1 - vecRows[i].distance / 2;
    cosineSims.set(vecRows[i].rowid, cosine);
    vecRankMap.set(vecRows[i].rowid, i + 1);
    vecRawScores.set(vecRows[i].rowid, cosine);
  }

  const bm25RankMap = new Map<number, number>();
  const bm25RawScores = new Map<number, number>();
  for (let i = 0; i < bm25Rows.length; i++) {
    bm25RankMap.set(bm25Rows[i].rowid, i + 1);
    bm25RawScores.set(bm25Rows[i].rowid, bm25Rows[i].rank);
  }

  const trigramRankMap = new Map<number, number>();
  const trigramRawScores = new Map<number, number>();
  for (let i = 0; i < trigramRows.length; i++) {
    trigramRankMap.set(trigramRows[i].rowid, i + 1);
    trigramRawScores.set(trigramRows[i].rowid, trigramRows[i].rank);
  }

  // Filepath signal: fetch all chunks from filepath-matched files and assign each
  // chunk its file's rank. Chunks from the best-matching file all get rank 1, so
  // the filepath signal correctly represents "this file's name/path matches",
  // rather than unfairly penalising later chunks within the same file.
  const filepathRankMap = new Map<number, number>();
  if (filepathFileRanks.size > 0) {
    try {
      const filePaths = Array.from(filepathFileRanks.keys());
      const placeholders = filePaths.map(() => '?').join(',');
      const chunkRows = db.prepare(
        `SELECT id, file_path FROM chunks WHERE file_path IN (${placeholders})`,
      ).all(...filePaths) as Array<{ id: number; file_path: string }>;
      for (const { id, file_path } of chunkRows) {
        const fileRank = filepathFileRanks.get(file_path);
        if (fileRank !== undefined) filepathRankMap.set(id, fileRank);
      }
    } catch {
      // Skip on error
    }
  }

  const tagsRankMap = new Map<number, number>();
  const tagsRawScores = new Map<number, number>();
  for (let i = 0; i < tagsRows.length; i++) {
    tagsRankMap.set(tagsRows[i].rowid, i + 1);
    tagsRawScores.set(tagsRows[i].rowid, tagsRows[i].rank);
  }

  // Union of all chunk IDs
  const allIds = new Set([
    ...vecRankMap.keys(),
    ...bm25RankMap.keys(),
    ...trigramRankMap.keys(),
    ...filepathRankMap.keys(),
    ...tagsRankMap.keys(),
  ]);

  if (allIds.size === 0) return [];

  // Fetch heading_depth for all candidate chunks (needed for boosting BM25/trigram)
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS _hybrid_ids (id INTEGER PRIMARY KEY)`);
  db.exec(`DELETE FROM _hybrid_ids`);
  const insertHybridId = db.prepare(`INSERT OR IGNORE INTO _hybrid_ids (id) VALUES (?)`);
  for (const id of allIds) {
    insertHybridId.run(id);
  }
  const headingDepthRows = db.prepare(`
    SELECT c.id, c.heading_depth FROM chunks c
    JOIN _hybrid_ids h ON h.id = c.id
  `).all() as Array<{ id: number; heading_depth: number }>;
  const headingDepths = new Map<number, number>();
  for (const row of headingDepthRows) {
    headingDepths.set(row.id, row.heading_depth);
  }

  // Compute RRF scores per chunk, applying heading depth boost to BM25 and trigram.
  // contentRrf excludes the filepath signal so we can compute file-level scores
  // independently from content signals (see aggregateByFileRrf for usage).
  const penaltyRank = chunkLimit + 1;
  const rrfScores = new Map<number, number>();
  const contentRrfScores = new Map<number, number>();
  const breakdowns = new Map<number, ScoreBreakdown>();

  for (const id of allIds) {
    const depth = headingDepths.get(id) ?? 0;
    const headingBoost = depth === 0 ? 1.0 : 1.0 + 0.1 * (7 - depth);

    const vecRank = vecRankMap.get(id) ?? penaltyRank;
    const bm25Rank = bm25RankMap.get(id) ?? penaltyRank;
    const trigramRank = trigramRankMap.get(id) ?? penaltyRank;
    const filepathRank = filepathRankMap.get(id) ?? penaltyRank;
    const tagsRank = tagsRankMap.get(id) ?? penaltyRank;

    const semanticContrib = w.semantic / (k + vecRank);
    const bm25Contrib = (w.bm25 / (k + bm25Rank)) * headingBoost;
    const trigramContrib = (w.trigram / (k + trigramRank)) * headingBoost;
    const filepathContrib = w.filepath / (k + filepathRank);
    const tagsContrib = w.tags / (k + tagsRank);

    const contentRrf = semanticContrib + bm25Contrib + trigramContrib + tagsContrib;
    const rrf = contentRrf + filepathContrib;
    rrfScores.set(id, rrf);
    contentRrfScores.set(id, contentRrf);
    breakdowns.set(id, {
      semantic:  { rank: vecRankMap.get(id) ?? 0,      rawScore: vecRawScores.get(id) ?? 0,      rrfContribution: semanticContrib },
      bm25:      { rank: bm25RankMap.get(id) ?? 0,     rawScore: bm25RawScores.get(id) ?? 0,     rrfContribution: bm25Contrib },
      trigram:   { rank: trigramRankMap.get(id) ?? 0,  rawScore: trigramRawScores.get(id) ?? 0,  rrfContribution: trigramContrib },
      filepath:  { rank: filepathRankMap.get(id) ?? 0, rawScore: 0,                              rrfContribution: filepathContrib },
      tags:      { rank: tagsRankMap.get(id) ?? 0,     rawScore: tagsRawScores.get(id) ?? 0,     rrfContribution: tagsContrib },
    });
  }

  // Sort by RRF score descending, take top chunks
  const sortedIds = Array.from(rrfScores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, chunkLimit)
    .map(([id]) => id);

  if (sortedIds.length === 0) return [];

  // Fetch chunk data for the top IDs using the existing temp table
  db.exec(`DELETE FROM _hybrid_ids`);
  for (const id of sortedIds) {
    insertHybridId.run(id);
  }

  let rows = db.prepare(`
    SELECT c.id, c.file_path, c.section_path, c.text,
           c.start_line, c.end_line
    FROM chunks c
    JOIN _hybrid_ids h ON h.id = c.id
  `).all() as Array<{
    id: number;
    file_path: string;
    section_path: string;
    text: string;
    start_line: number;
    end_line: number;
  }>;

  // Filter to startPath prefix if specified (stored-key prefix match)
  if (startPath) {
    rows = rows.filter((r) => r.file_path.startsWith(startPath));
    if (rows.length === 0) return [];
  }

  return aggregateByFileRrf(
    rows,
    maxResults,
    vecRankMap,
    bm25RankMap,
    trigramRankMap,
    filepathRankMap,
    tagsRankMap,
    cosineSims,
    rrfScores,
    contentRrfScores,
    breakdowns,
    weights,
    k,
  );
}

// ── Two-Axis Search ─────────────────────────────────────────────────────────

export interface TwoAxisChunkScore {
  /** Cosine similarity to query vector (0 if chunk not in semantic results). */
  semantic: number;
  /** Normalised BM25 score (0 if chunk has no query term matches). */
  bm25: number;
  /** max(semantic, bm25) — the winning content score for this chunk. */
  best: number;
  /** Which scorer produced the best score. */
  bestScorer: 'semantic' | 'bm25';
}

export interface TwoAxisChunk {
  sectionPath: string[];
  text: string;
  startLine: number;
  endLine: number;
  scores: TwoAxisChunkScore;
}

export type TwoAxisScoreSource = 'content' | 'filename';

export interface TwoAxisFileResult {
  filePath: string;
  /** Overall file score: max(contentScore, filenameScore). */
  score: number;
  /** Which axis drove the file's ranking. */
  scoreSource: TwoAxisScoreSource;
  /** Best chunk's content score (max of semantic/BM25 across chunks). */
  contentScore: number;
  /** Levenshtein filename similarity (0 if no filename match). */
  filenameScore: number;
  /** Top chunks sorted by content score descending. */
  chunks: TwoAxisChunk[];
}

/**
 * Two-axis search: replaces the 5-signal RRF pipeline.
 *
 * Content axis: max(cosine_similarity, normalised_bm25) per chunk.
 * Filename axis: Levenshtein similarity on file basenames (trigram prefiltered).
 * File score: max(best_chunk_content_score, filename_score).
 *
 * All scores are transparent [0,1] values.
 */
export function twoAxisSearch(
  db: SiloDatabase,
  queryVector: number[],
  queryText: string,
  maxResults: number = 10,
  startPath?: string,
): TwoAxisFileResult[] {
  const chunkLimit = maxResults * CHUNK_FANOUT;

  // ── Content Axis: Semantic ────────────────────────────────────────────────
  const vecRows = db.prepare(`
    SELECT v.rowid, v.distance
    FROM vec_chunks v
    WHERE v.embedding MATCH ?
      AND k = ?
    ORDER BY v.distance
  `).all(float32Buffer(queryVector), chunkLimit) as Array<{ rowid: number; distance: number }>;

  const cosineSims = new Map<number, number>();
  for (const row of vecRows) {
    cosineSims.set(row.rowid, 1 - row.distance / 2);
  }

  // ── Content Axis: BM25 ────────────────────────────────────────────────────
  const queryTokens = tokenise(queryText);
  const bm25Scores = scoreBm25(db, queryTokens);

  // ── Merge chunk IDs from both content signals ─────────────────────────────
  const allChunkIds = new Set([...cosineSims.keys(), ...bm25Scores.keys()]);
  if (allChunkIds.size === 0 && queryText.trim().length === 0) return [];

  // ── Filename Axis ─────────────────────────────────────────────────────────
  const filenameScores = scoreFilenames(db, queryText);

  // If we have no content matches and no filename matches, nothing to return
  if (allChunkIds.size === 0 && filenameScores.size === 0) return [];

  // ── Fetch chunk data for all content-matched chunks ───────────────────────
  const chunkDataMap = new Map<number, {
    file_path: string;
    section_path: string;
    text: string;
    start_line: number;
    end_line: number;
  }>();

  if (allChunkIds.size > 0) {
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS _twoaxis_ids (id INTEGER PRIMARY KEY)`);
    db.exec(`DELETE FROM _twoaxis_ids`);
    const insertId = db.prepare(`INSERT INTO _twoaxis_ids (id) VALUES (?)`);
    for (const id of allChunkIds) {
      insertId.run(id);
    }

    const chunkRows = db.prepare(`
      SELECT c.id, c.file_path, c.section_path, c.text, c.start_line, c.end_line
      FROM chunks c
      JOIN _twoaxis_ids t ON t.id = c.id
    `).all() as Array<{
      id: number;
      file_path: string;
      section_path: string;
      text: string;
      start_line: number;
      end_line: number;
    }>;

    for (const row of chunkRows) {
      chunkDataMap.set(row.id, row);
    }
  }

  // ── Build per-file aggregation ────────────────────────────────────────────
  const fileMap = new Map<string, {
    bestContentScore: number;
    chunks: TwoAxisChunk[];
  }>();

  for (const chunkId of allChunkIds) {
    const data = chunkDataMap.get(chunkId);
    if (!data) continue;

    // Apply startPath filter
    if (startPath && !data.file_path.startsWith(startPath)) continue;

    const semantic = cosineSims.get(chunkId) ?? 0;
    const bm25 = bm25Scores.get(chunkId)?.score ?? 0;
    const best = Math.max(semantic, bm25);
    const bestScorer: 'semantic' | 'bm25' = semantic >= bm25 ? 'semantic' : 'bm25';

    const chunk: TwoAxisChunk = {
      sectionPath: JSON.parse(data.section_path),
      text: data.text,
      startLine: data.start_line,
      endLine: data.end_line,
      scores: { semantic, bm25, best, bestScorer },
    };

    const existing = fileMap.get(data.file_path);
    if (existing) {
      existing.chunks.push(chunk);
      if (best > existing.bestContentScore) existing.bestContentScore = best;
    } else {
      fileMap.set(data.file_path, { bestContentScore: best, chunks: [chunk] });
    }
  }

  // Add filename-only files (matched by filename but no content chunks)
  for (const [filePath] of filenameScores) {
    if (startPath && !filePath.startsWith(startPath)) continue;
    if (!fileMap.has(filePath)) {
      fileMap.set(filePath, { bestContentScore: 0, chunks: [] });
    }
  }

  // ── Compute final file scores and sort ────────────────────────────────────
  const results: TwoAxisFileResult[] = [];

  for (const [filePath, { bestContentScore, chunks }] of fileMap) {
    const filenameScore = filenameScores.get(filePath)?.score ?? 0;
    const score = Math.max(bestContentScore, filenameScore);
    const scoreSource: TwoAxisScoreSource = filenameScore > bestContentScore ? 'filename' : 'content';

    // Sort chunks by content score descending, cap at MAX_CHUNKS_PER_FILE
    chunks.sort((a, b) => b.scores.best - a.scores.best);
    if (chunks.length > MAX_CHUNKS_PER_FILE) chunks.length = MAX_CHUNKS_PER_FILE;

    results.push({
      filePath,
      score,
      scoreSource,
      contentScore: bestContentScore,
      filenameScore,
      chunks,
    });
  }

  results.sort((a, b) => b.score - a.score);
  if (results.length > maxResults) results.length = maxResults;

  return results;
}

// ── Stats ────────────────────────────────────────────────────────────────────

/**
 * Get the total number of chunks in the database.
 */
export function getChunkCount(db: SiloDatabase): number {
  const row = db.prepare(`SELECT COUNT(*) as cnt FROM chunks`).get() as { cnt: number };
  return row.cnt;
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

/**
 * Peek at the file count in a silo database without fully opening it.
 * Opens a lightweight readonly connection — no sqlite-vec extension needed.
 * Returns 0 if the database doesn't exist or the table is missing.
 */
export function peekFileCount(dbPath: string): number {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare('SELECT COUNT(*) as cnt FROM mtimes').get() as { cnt: number };
      return row.cnt;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
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

// ── Config Blob ─────────────────────────────────────────────────────────────

/**
 * Save a silo configuration snapshot to the meta table as a JSON blob.
 */
export function saveConfigBlob(db: SiloDatabase, config: StoredSiloConfig): void {
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
    .run('config', JSON.stringify(config));
}

/**
 * Load the stored silo configuration from the meta table.
 * Returns null if no config blob has been stored yet.
 */
export function loadConfigBlob(db: SiloDatabase): StoredSiloConfig | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'config'`).get() as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as StoredSiloConfig;
  } catch {
    return null;
  }
}

/**
 * Open a database file read-only, read the config blob and meta, then close it.
 * Used by the wizard to peek at stored config when reconnecting an existing DB.
 * Does not load sqlite-vec since we only read the meta table.
 */
export function readConfigFromDbFile(dbPath: string): {
  config: StoredSiloConfig | null;
  meta: SiloMeta | null;
} | null {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const config = loadConfigBlob(db);
      const meta = loadMeta(db);
      return { config, meta };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

// ── Inverted Index Helpers ───────────────────────────────────────────────────

/**
 * Remove a set of chunk IDs from the inverted index.
 * Decrements doc_freq in the terms table and deletes terms that reach 0.
 * Must be called BEFORE deleting the chunk rows from the chunks table.
 */
function removeFromInvertedIndex(db: SiloDatabase, chunkIds: number[]): void {
  if (chunkIds.length === 0) return;

  // 1. Collect the terms that will be affected
  const placeholders = chunkIds.map(() => '?').join(',');
  const affectedTerms = db.prepare(
    `SELECT DISTINCT term FROM postings WHERE chunk_id IN (${placeholders})`,
  ).all(...chunkIds) as Array<{ term: string }>;

  // 2. Delete all postings for these chunks
  db.prepare(`DELETE FROM postings WHERE chunk_id IN (${placeholders})`).run(...chunkIds);

  // 3. Recompute doc_freq for each affected term from remaining postings.
  //    Delete terms that have no remaining postings.
  for (const { term } of affectedTerms) {
    const remaining = db.prepare(
      `SELECT COUNT(*) as cnt FROM postings WHERE term = ?`,
    ).get(term) as { cnt: number };

    if (remaining.cnt === 0) {
      db.prepare(`DELETE FROM terms WHERE term = ?`).run(term);
    } else {
      db.prepare(`UPDATE terms SET doc_freq = ? WHERE term = ?`).run(remaining.cnt, term);
    }
  }
}

/**
 * Recompute corpus-level BM25 statistics and store them in the meta table.
 * Called after every upsert or delete transaction.
 */
function updateCorpusStats(db: SiloDatabase): void {
  const stats = db.prepare(
    `SELECT COUNT(*) AS cnt, COALESCE(AVG(token_count), 0) AS avg_tc FROM chunks`,
  ).get() as { cnt: number; avg_tc: number };

  const upsertMeta = db.prepare(
    `INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`,
  );
  upsertMeta.run('corpus_chunk_count', String(stats.cnt));
  upsertMeta.run('corpus_avg_token_count', String(stats.avg_tc));
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
 * Extract the filename from a stored key (format: "{dirIndex}:{relPath}")
 * or a plain path. Uses forward-slash splitting since stored keys use forward slashes.
 */
function fileBasename(filePath: string): string {
  return filePath.split('/').pop() ?? filePath;
}

// ── Directory Helpers ────────────────────────────────────────────────────────

/**
 * Extract all ancestor directory paths from a stored key.
 * e.g. "0:src/backend/chunkers/foo.ts" → [
 *   { dirPath: "0:src/", dirName: "src", depth: 1 },
 *   { dirPath: "0:src/backend/", dirName: "backend", depth: 2 },
 *   { dirPath: "0:src/backend/chunkers/", dirName: "chunkers", depth: 3 },
 * ]
 */
export function extractDirectoryPaths(storedKey: string): Array<{ dirPath: string; dirName: string; depth: number }> {
  const colonIdx = storedKey.indexOf(':');
  if (colonIdx === -1) return [];

  const prefix = storedKey.slice(0, colonIdx + 1); // e.g. "0:"
  const relPath = storedKey.slice(colonIdx + 1);    // e.g. "src/backend/chunkers/foo.ts"
  const parts = relPath.split('/');

  // Remove the filename (last part)
  parts.pop();
  if (parts.length === 0) return [];

  const dirs: Array<{ dirPath: string; dirName: string; depth: number }> = [];
  for (let i = 0; i < parts.length; i++) {
    const dirPath = prefix + parts.slice(0, i + 1).join('/') + '/';
    const dirName = parts[i];
    dirs.push({ dirPath, dirName, depth: i + 1 });
  }
  return dirs;
}

/**
 * Maintain the directories table after a file upsert.
 * Ensures all ancestor directories exist and recomputes their counts.
 * Runs inside the caller's transaction.
 */
function maintainDirectoriesOnUpsert(db: SiloDatabase, filePath: string): void {
  const dirPaths = extractDirectoryPaths(filePath);
  if (dirPaths.length === 0) return;

  const insertDir = db.prepare(
    `INSERT OR IGNORE INTO directories (dir_path, dir_name, depth, file_count, subdir_count) VALUES (?, ?, ?, 0, 0)`,
  );
  for (const d of dirPaths) {
    insertDir.run(d.dirPath, d.dirName, d.depth);
  }

  updateDirectoryCounts(db, dirPaths);
}

/**
 * Recompute file_count and subdir_count for a set of directory paths.
 * Does NOT remove empty directories — lifecycle is driven by disk presence during reconciliation.
 */
function updateDirectoryCounts(
  db: SiloDatabase,
  dirPaths: Array<{ dirPath: string; depth: number }>,
): void {
  const updateFileCount = db.prepare(`
    UPDATE directories SET file_count = (
      SELECT COUNT(*) FROM files
      WHERE file_path LIKE ? || '%'
        AND file_path NOT LIKE ? || '%/%'
    ) WHERE dir_path = ?
  `);
  const updateSubdirCount = db.prepare(`
    UPDATE directories SET subdir_count = (
      SELECT COUNT(*) FROM directories
      WHERE dir_path LIKE ? || '%'
        AND dir_path != ?
        AND depth = ?
    ) WHERE dir_path = ?
  `);

  for (const d of dirPaths) {
    updateFileCount.run(d.dirPath, d.dirPath, d.dirPath);
    updateSubdirCount.run(d.dirPath, d.dirPath, d.depth + 1, d.dirPath);
  }
}

/**
 * Flush FTS entries for a batch of directories.
 * Called after directories are synced to ensure dirs_fts is up to date.
 */
export function flushDirectoryFts(
  db: SiloDatabase,
  entries: Array<{ id: number; dirPath: string; dirName: string }>,
): void {
  if (entries.length === 0) return;

  db.transaction(() => {
    const deleteOldFts = db.prepare(`DELETE FROM dirs_fts WHERE rowid = ?`);
    const insertFts = db.prepare(`INSERT INTO dirs_fts(rowid, dir_path, dir_name) VALUES (?, ?, ?)`);

    for (const entry of entries) {
      deleteOldFts.run(entry.id);
      insertFts.run(entry.id, entry.dirPath, entry.dirName);
    }
  })();
}

/**
 * Sync the directories table with a set of directory paths found on disk.
 * - Inserts any new directories not yet in the table
 * - Removes directories no longer present on disk
 * - Recomputes all counts
 * Returns the list of removed directory stored-key paths (for activity event emission).
 */
export function syncDirectoriesWithDisk(
  db: SiloDatabase,
  diskDirPaths: Array<{ dirPath: string; dirName: string; depth: number }>,
): string[] {
  const diskSet = new Set(diskDirPaths.map((d) => d.dirPath));

  return db.transaction(() => {
    // Insert any new directories
    const insertDir = db.prepare(
      `INSERT OR IGNORE INTO directories (dir_path, dir_name, depth, file_count, subdir_count) VALUES (?, ?, ?, 0, 0)`,
    );
    for (const d of diskDirPaths) {
      insertDir.run(d.dirPath, d.dirName, d.depth);
    }

    // Find directories in DB but not on disk
    const allDbDirs = db.prepare(`SELECT id, dir_path FROM directories`).all() as Array<{
      id: number;
      dir_path: string;
    }>;
    const toRemove = allDbDirs.filter((d) => !diskSet.has(d.dir_path));

    // Remove orphaned directories
    for (const d of toRemove) {
      db.prepare(`DELETE FROM dirs_fts WHERE rowid = ?`).run(d.id);
      db.prepare(`DELETE FROM directories WHERE id = ?`).run(d.id);
    }

    // Recompute all counts in one pass
    db.prepare(`
      UPDATE directories SET file_count = (
        SELECT COUNT(*) FROM files
        WHERE file_path LIKE directories.dir_path || '%'
          AND file_path NOT LIKE directories.dir_path || '%/%'
      )
    `).run();

    db.prepare(`
      UPDATE directories SET subdir_count = (
        SELECT COUNT(*) FROM directories d2
        WHERE d2.dir_path LIKE directories.dir_path || '%'
          AND d2.dir_path != directories.dir_path
          AND d2.depth = directories.depth + 1
      )
    `).run();

    return toRemove.map((d) => d.dir_path);
  })();
}

/**
 * Sanitise a user query for FTS5 unicode61 MATCH.
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
 * Sanitise a user query for FTS5 trigram MATCH.
 * Trigram requires terms of at least 3 characters; shorter terms are dropped.
 * Each qualifying term is wrapped in double quotes.
 */
function sanitiseTrigramQuery(query: string): string {
  return query
    .replace(/"/g, '""')
    .split(/\s+/)
    .filter((term) => term.length >= 3)
    .map((term) => `"${term}"`)
    .join(' ');
}

/**
 * Normalise search weights so they sum to 1.0.
 * Falls back to DEFAULT_SEARCH_WEIGHTS if all weights are zero.
 */
function normalizeWeights(weights: SearchWeights): SearchWeights {
  const total = weights.semantic + weights.bm25 + weights.trigram + weights.filepath + weights.tags;
  if (total === 0) return DEFAULT_SEARCH_WEIGHTS;
  if (Math.abs(total - 1.0) < 1e-6) return weights;
  return {
    semantic: weights.semantic / total,
    bm25: weights.bm25 / total,
    trigram: weights.trigram / total,
    filepath: weights.filepath / total,
    tags: weights.tags / total,
  };
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
  const zeroBreakdown: ScoreBreakdown = {
    semantic:  { rank: 0, rawScore: 0, rrfContribution: 0 },
    bm25:      { rank: 0, rawScore: 0, rrfContribution: 0 },
    trigram:   { rank: 0, rawScore: 0, rrfContribution: 0 },
    filepath:  { rank: 0, rawScore: 0, rrfContribution: 0 },
    tags:      { rank: 0, rawScore: 0, rrfContribution: 0 },
  };

  const fileMap = new Map<string, { bestScore: number; chunks: SiloSearchResultChunk[] }>();

  for (const row of rows) {
    const score = 1 - row.distance / 2;
    const sectionPath: string[] = JSON.parse(row.section_path);
    const chunk: SiloSearchResultChunk = {
      sectionPath,
      text: row.text,
      startLine: row.start_line,
      endLine: row.end_line,
      score,
      matchType: 'semantic',
      cosineSimilarity: score,
      breakdown: { ...zeroBreakdown, semantic: { rank: 1, rawScore: score, rrfContribution: score } },
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
    if (entry.chunks.length > MAX_CHUNKS_PER_FILE) entry.chunks.length = MAX_CHUNKS_PER_FILE;
  }

  return Array.from(fileMap.entries())
    .map(([filePath, { bestScore, chunks }]) => ({
      filePath,
      score: bestScore,
      scoreSource: 'content' as ScoreSource,
      matchType: 'semantic' as MatchType,
      bestCosineSimilarity: bestScore,
      chunks,
      weights: DEFAULT_SEARCH_WEIGHTS,
      breakdown: chunks[0]?.breakdown ?? zeroBreakdown,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

/**
 * Aggregate hybrid search rows by file.
 * RRF scores and breakdowns are already computed.
 */
function aggregateByFileRrf(
  rows: Array<{
    id: number;
    file_path: string;
    section_path: string;
    text: string;
    start_line: number;
    end_line: number;
  }>,
  maxResults: number,
  vecRankMap: Map<number, number>,
  bm25RankMap: Map<number, number>,
  trigramRankMap: Map<number, number>,
  filepathRankMap: Map<number, number>,
  tagsRankMap: Map<number, number>,
  cosineSims: Map<number, number>,
  rrfScores: Map<number, number>,
  contentRrfScores: Map<number, number>,
  breakdowns: Map<number, ScoreBreakdown>,
  weights: SearchWeights,
  k: number,
): SiloSearchResult[] {
  const zeroBreakdown: ScoreBreakdown = {
    semantic:  { rank: 0, rawScore: 0, rrfContribution: 0 },
    bm25:      { rank: 0, rawScore: 0, rrfContribution: 0 },
    trigram:   { rank: 0, rawScore: 0, rrfContribution: 0 },
    filepath:  { rank: 0, rawScore: 0, rrfContribution: 0 },
    tags:      { rank: 0, rawScore: 0, rrfContribution: 0 },
  };

  const fileMap = new Map<string, {
    bestContentScore: number;
    bestFilepathRank: number;   // 1-based; 0 = no filepath match
    bestCosineSim: number;
    bestBreakdown: ScoreBreakdown;
    hasVec: boolean;
    hasFts: boolean;
    chunks: SiloSearchResultChunk[];
  }>();

  for (const row of rows) {
    const sectionPath: string[] = JSON.parse(row.section_path);
    const inVec = vecRankMap.has(row.id);
    const inFts = bm25RankMap.has(row.id) || trigramRankMap.has(row.id) || filepathRankMap.has(row.id) || tagsRankMap.has(row.id);
    const cosineSim = cosineSims.get(row.id) ?? 0;
    const rrfScore = rrfScores.get(row.id) ?? 0;
    const contentScore = contentRrfScores.get(row.id) ?? 0;
    const breakdown = breakdowns.get(row.id) ?? zeroBreakdown;
    const chunkFilepathRank = filepathRankMap.get(row.id) ?? 0;

    let chunkMatchType: MatchType = 'semantic';
    if (inVec && inFts) chunkMatchType = 'both';
    else if (inFts && !inVec) chunkMatchType = 'keyword';

    const chunk: SiloSearchResultChunk = {
      sectionPath,
      text: row.text,
      startLine: row.start_line,
      endLine: row.end_line,
      score: rrfScore,
      matchType: chunkMatchType,
      cosineSimilarity: cosineSim,
      breakdown,
    };

    const existing = fileMap.get(row.file_path);
    if (existing) {
      existing.chunks.push(chunk);
      if (contentScore > existing.bestContentScore) {
        existing.bestContentScore = contentScore;
        existing.bestBreakdown = breakdown;
      }
      if (cosineSim > existing.bestCosineSim) existing.bestCosineSim = cosineSim;
      if (chunkFilepathRank > 0 && (existing.bestFilepathRank === 0 || chunkFilepathRank < existing.bestFilepathRank)) {
        existing.bestFilepathRank = chunkFilepathRank;
      }
      if (inVec) existing.hasVec = true;
      if (inFts) existing.hasFts = true;
    } else {
      fileMap.set(row.file_path, {
        bestContentScore: contentScore,
        bestFilepathRank: chunkFilepathRank,
        bestCosineSim: cosineSim,
        bestBreakdown: breakdown,
        hasVec: inVec,
        hasFts: inFts,
        chunks: [chunk],
      });
    }
  }

  for (const entry of fileMap.values()) {
    entry.chunks.sort((a, b) => b.score - a.score);
    if (entry.chunks.length > MAX_CHUNKS_PER_FILE) entry.chunks.length = MAX_CHUNKS_PER_FILE;
  }

  return Array.from(fileMap.entries())
    .map(([filePath, { bestContentScore, bestFilepathRank, bestCosineSim, bestBreakdown, hasVec, hasFts, chunks }]) => {
      // Filepath signal treated as an independent composite: if the filename is a
      // strong match, the file should surface even if content signals are weak.
      // Filepath score uses weight 1.0 (sole signal), so it's directly comparable
      // to the content-only composite (which also sums to ~1.0 across its signals).
      const filepathScore = bestFilepathRank > 0 ? 1.0 / (k + bestFilepathRank) : 0;
      const scoreSource: ScoreSource = filepathScore > bestContentScore ? 'filename' : 'content';
      const score = Math.max(bestContentScore, filepathScore);

      let matchType: MatchType = 'semantic';
      if (hasVec && hasFts) matchType = 'both';
      else if (hasFts && !hasVec) matchType = 'keyword';
      return {
        filePath,
        score,
        scoreSource,
        matchType,
        bestCosineSimilarity: bestCosineSim,
        chunks,
        weights,
        breakdown: bestBreakdown,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}
