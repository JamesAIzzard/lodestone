/**
 * Per-silo vector store using SQLite + sqlite-vec.
 *
 * Each silo has its own SQLite database file with:
 *   - `chunks` table for chunk data
 *   - `terms` / `postings` tables for hand-rolled BM25 scoring
 *   - `files` table tracking indexed file paths and basenames
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
import { tokenise } from './tokeniser';

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
 * Delete a single directory entry by stored dir-key.
 * Returns the deleted directory id, or null if not found.
 */
export function deleteDirEntry(db: SiloDatabase, dirPath: string): number | null {
  const row = db.prepare(`SELECT id FROM directories WHERE dir_path = ?`).get(dirPath) as { id: number } | undefined;
  if (!row) return null;
  db.prepare(`DELETE FROM directories WHERE id = ?`).run(row.id);
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

export type SiloDatabase = Database.Database;

/** Extract the relative-path portion from a stored key ("{dirIndex}:{relPath}"). */
export function extractRelPath(storedKey: string): string {
  const colon = storedKey.indexOf(':');
  return colon === -1 ? storedKey : storedKey.slice(colon + 1);
}

/**
 * Convert a glob pattern to a RegExp.
 *
 * Rules:
 *   **  → matches any sequence of characters including path separators
 *   *   → matches any sequence of characters within a single path segment
 *   ?   → matches any single character
 *
 * Uses a two-step approach: split on ** first to avoid double-replacement bugs.
 */
export function globToRegex(pattern: string, flags = 'i'): RegExp {
  const parts = pattern.split('**');
  const escapedParts = parts.map((part) =>
    // Within each segment (no **), escape regex chars then handle * and ?
    part
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/\\\\]*')
      .replace(/\?/g, '[^/\\\\]'),
  );
  return new RegExp(escapedParts.join('.*'), flags);
}

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
      location_hint TEXT,
      metadata      TEXT    NOT NULL DEFAULT '{}',
      content_hash  TEXT    NOT NULL,
      token_count   INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path);

    CREATE TABLE IF NOT EXISTS files (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT UNIQUE NOT NULL,
      file_name TEXT NOT NULL
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
  const hasTokenCount = db.prepare(
    `SELECT 1 FROM pragma_table_info('chunks') WHERE name='token_count'`,
  ).get();
  if (!hasTokenCount) {
    db.exec(`ALTER TABLE chunks ADD COLUMN token_count INTEGER NOT NULL DEFAULT 0`);
  }

  // Migrate start_line/end_line → location_hint (JSON discriminated union).
  const hasLocationHint = db.prepare(
    `SELECT 1 FROM pragma_table_info('chunks') WHERE name='location_hint'`,
  ).get();
  if (!hasLocationHint) {
    db.exec(`ALTER TABLE chunks ADD COLUMN location_hint TEXT`);
    // Migrate existing rows: convert integer pairs to JSON location hints
    const hasStartLine = db.prepare(
      `SELECT 1 FROM pragma_table_info('chunks') WHERE name='start_line'`,
    ).get();
    if (hasStartLine) {
      db.exec(`
        UPDATE chunks
        SET location_hint = json_object('type', 'lines', 'start', start_line, 'end', end_line)
        WHERE start_line IS NOT NULL
      `);
      db.exec(`ALTER TABLE chunks DROP COLUMN start_line`);
      db.exec(`ALTER TABLE chunks DROP COLUMN end_line`);
    }
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

  // Drop legacy FTS/vec tables if they exist (no longer used — search uses
  // plain table scans with application-side scoring)
  for (const legacy of ['files_fts', 'dirs_fts', 'dirs_vec']) {
    const exists = db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`,
    ).get(legacy);
    if (exists) db.exec(`DROP TABLE "${legacy}"`);
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
  // 1. Fetch existing chunk IDs for cleanup
  const existingIds = db.prepare(
    `SELECT id FROM chunks WHERE file_path = ?`,
  ).all(filePath) as Array<{ id: number }>;

  // 2. Remove from inverted index (postings + terms.doc_freq)
  if (existingIds.length > 0) {
    removeFromInvertedIndex(db, existingIds.map((r) => r.id));
  }

  // 3. Remove from vec_chunks
  const vecDelete = db.prepare(`DELETE FROM vec_chunks WHERE rowid = ?`);
  for (const row of existingIds) {
    vecDelete.run(row.id);
  }

  // 4. Remove from chunks
  db.prepare(`DELETE FROM chunks WHERE file_path = ?`).run(filePath);

  // 5. Ensure file entry exists in files table (insert once per unique path)
  db.prepare(
    `INSERT OR IGNORE INTO files (file_path, file_name) VALUES (?, ?)`,
  ).run(filePath, fileBasename(filePath));

  // 6. Insert new chunks
  //    Insert into vec_chunks first (auto-assigns rowid), then use that
  //    rowid as the explicit id in the chunks table.
  const insertVec = db.prepare(
    `INSERT INTO vec_chunks(embedding) VALUES (?)`,
  );
  const insertChunk = db.prepare(`
    INSERT INTO chunks (id, file_path, chunk_index, section_path, text, location_hint, metadata, content_hash, token_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

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
      JSON.stringify(chunk.locationHint),
      JSON.stringify(chunk.metadata),
      chunk.contentHash,
      tokenCount,
    );

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

  // 7. Maintain directories table (insert new dirs, recompute counts)
  maintainDirectoriesOnUpsert(db, filePath);
}

/**
 * Inner delete logic — runs inside a caller-provided transaction.
 */
function deleteFileInner(db: SiloDatabase, filePath: string, deleteMtimeEntry?: boolean): void {
  const existingIds = db.prepare(
    `SELECT id FROM chunks WHERE file_path = ?`,
  ).all(filePath) as Array<{ id: number }>;

  // Remove from inverted index (postings + terms.doc_freq)
  if (existingIds.length > 0) {
    removeFromInvertedIndex(db, existingIds.map((r) => r.id));
  }

  const vecDelete = db.prepare(`DELETE FROM vec_chunks WHERE rowid = ?`);
  for (const row of existingIds) {
    vecDelete.run(row.id);
  }

  db.prepare(`DELETE FROM chunks WHERE file_path = ?`).run(filePath);

  // Remove file entry
  db.prepare(`DELETE FROM files WHERE file_path = ?`).run(filePath);

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
 * Remove all chunks for a file but ensure it retains a row in the `files`
 * table (and `files_fts`) so it remains discoverable by filepath search.
 * Used for empty or un-chunkable files that still exist on disk.
 */
function clearChunksKeepFile(db: SiloDatabase, filePath: string, mtimeMs?: number): void {
  const existingIds = db.prepare(
    `SELECT id FROM chunks WHERE file_path = ?`,
  ).all(filePath) as Array<{ id: number }>;

  if (existingIds.length > 0) {
    removeFromInvertedIndex(db, existingIds.map((r) => r.id));
    const vecDelete = db.prepare(`DELETE FROM vec_chunks WHERE rowid = ?`);
    for (const row of existingIds) vecDelete.run(row.id);
  }
  db.prepare(`DELETE FROM chunks WHERE file_path = ?`).run(filePath);

  // Ensure file row exists (insert if missing)
  db.prepare(
    `INSERT OR IGNORE INTO files (file_path, file_name) VALUES (?, ?)`,
  ).run(filePath, fileBasename(filePath));

  // Persist mtime so the watcher knows the file is up to date
  if (mtimeMs !== undefined) {
    db.prepare(`INSERT OR REPLACE INTO mtimes (file_path, mtime_ms) VALUES (?, ?)`).run(filePath, mtimeMs);
  }

  updateCorpusStats(db);

  const dirPaths = extractDirectoryPaths(filePath);
  if (dirPaths.length > 0) {
    updateDirectoryCounts(db, dirPaths);
    maintainDirectoriesOnUpsert(db, filePath);
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
  const totalChunks = upserts.reduce((sum, f) => sum + f.chunks.length, 0);
  const tTx = performance.now();
  db.transaction(() => {
    for (const file of upserts) {
      if (file.chunks.length === 0) {
        // Empty file — remove chunks but keep the file row so it's findable by path
        clearChunksKeepFile(db, file.filePath, file.mtimeMs);
      } else {
        const tFile = performance.now();
        upsertFileInner(db, file.filePath, file.chunks, file.embeddings, file.mtimeMs);
        const fileMs = performance.now() - tFile;
        if (fileMs > 200) {
          console.log(`[flushPrepared]   SLOW upsert: ${file.filePath} (${file.chunks.length} chunks) → ${fileMs.toFixed(0)}ms`);
        }
      }
    }
    if (deletes) {
      for (const entry of deletes) {
        deleteFileInner(db, entry.filePath, entry.deleteMtime);
      }
    }
  })();
  const txMs = performance.now() - tTx;
  if (txMs > 300) {
    console.log(`[flushPrepared] Transaction: ${upserts.length} files, ${totalChunks} chunks, ${deletes?.length ?? 0} deletes → ${txMs.toFixed(0)}ms`);
  }
}

// ── Search (old two-axis functions removed — see search.ts) ─────────

// ── Chunk Metadata (shared by signal implementations) ───────────────────────

/** Minimal chunk metadata needed by signal implementations for hints. */
export interface ChunkMeta {
  id: number;
  file_path: string;
  section_path: string;
  location_hint: string | null;
}

/**
 * Fetch chunk metadata for a set of chunk IDs.
 * Uses a temp table for efficient batch lookup.
 */
export function fetchChunkMeta(db: SiloDatabase, chunkIds: Set<number>): Map<number, ChunkMeta> {
  const result = new Map<number, ChunkMeta>();
  if (chunkIds.size === 0) return result;

  db.exec(`CREATE TEMP TABLE IF NOT EXISTS _signal_ids (id INTEGER PRIMARY KEY)`);
  db.exec(`DELETE FROM _signal_ids`);
  const insert = db.prepare(`INSERT INTO _signal_ids (id) VALUES (?)`);
  for (const id of chunkIds) insert.run(id);

  const rows = db.prepare(`
    SELECT c.id, c.file_path, c.section_path, c.location_hint
    FROM chunks c
    JOIN _signal_ids t ON t.id = c.id
  `).all() as ChunkMeta[];

  for (const row of rows) result.set(row.id, row);
  return result;
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
export function float32Buffer(vec: number[]): Buffer {
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
 * List files directly inside a directory (not recursive).
 * Returns stored-key file paths and file names for files whose
 * stored key starts with the directory's stored key but has no
 * further '/' separators.
 *
 * @param dirStoredKey The stored directory key (e.g. "0:src/backend/") or
 *                     a silo root prefix (e.g. "0:") for root-level files.
 */
export function getFilesInDirectory(
  db: SiloDatabase,
  dirStoredKey: string,
): Array<{ filePath: string; fileName: string }> {
  return db.prepare(`
    SELECT file_path AS filePath, file_name AS fileName FROM files
    WHERE file_path LIKE ? || '%'
      AND file_path NOT LIKE ? || '%/%'
    ORDER BY file_name
  `).all(dirStoredKey, dirStoredKey) as Array<{ filePath: string; fileName: string }>;
}

/**
 * Sync the directories table structure with disk — inserts new directories
 * and removes orphaned ones. Fast transaction (no heavy scans).
 *
 * Count recomputation is handled separately by {@link recomputeDirectoryCounts}
 * so it can yield to the event loop between batches.
 *
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
    const deleteDir = db.prepare(`DELETE FROM directories WHERE id = ?`);
    for (const d of toRemove) {
      deleteDir.run(d.id);
    }

    return toRemove.map((d) => d.dir_path);
  })();
}

/**
 * Recompute file_count and subdir_count for all directories, in batches
 * of {@link DIRS_PER_BATCH} to avoid blocking the event loop.
 *
 * Each batch runs its own small transaction (~50 UPDATE statements with
 * correlated subqueries), keeping each synchronous block under ~200ms.
 */
const DIRS_PER_BATCH = 50;

export async function recomputeDirectoryCounts(db: SiloDatabase): Promise<void> {
  const allDirs = db.prepare(`SELECT id, dir_path, depth FROM directories`).all() as Array<{
    id: number;
    dir_path: string;
    depth: number;
  }>;

  if (allDirs.length === 0) {
    console.log(`[recomputeDirCounts] No directories to update`);
    return;
  }

  console.log(`[recomputeDirCounts] Updating ${allDirs.length} directories in batches of ${DIRS_PER_BATCH}...`);

  const updateFileCount = db.prepare(`
    UPDATE directories SET file_count = (
      SELECT COUNT(*) FROM files
      WHERE file_path LIKE ? || '%'
        AND file_path NOT LIKE ? || '%/%'
    ) WHERE id = ?
  `);

  const updateSubdirCount = db.prepare(`
    UPDATE directories SET subdir_count = (
      SELECT COUNT(*) FROM directories d2
      WHERE d2.dir_path LIKE ? || '%'
        AND d2.dir_path != ?
        AND d2.depth = ? + 1
    ) WHERE id = ?
  `);

  for (let i = 0; i < allDirs.length; i += DIRS_PER_BATCH) {
    const batch = allDirs.slice(i, i + DIRS_PER_BATCH);
    const tBatch = performance.now();

    db.transaction(() => {
      for (const dir of batch) {
        updateFileCount.run(dir.dir_path, dir.dir_path, dir.id);
        updateSubdirCount.run(dir.dir_path, dir.dir_path, dir.depth, dir.id);
      }
    })();

    const batchMs = performance.now() - tBatch;
    console.log(`[recomputeDirCounts]   batch ${Math.floor(i / DIRS_PER_BATCH) + 1}: dirs ${i + 1}-${Math.min(i + DIRS_PER_BATCH, allDirs.length)} → ${batchMs.toFixed(1)}ms`);

    // Yield between batches so IPC/rendering stay responsive
    if (i + DIRS_PER_BATCH < allDirs.length) {
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  console.log(`[recomputeDirCounts] Done`);
}

