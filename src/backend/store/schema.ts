/**
 * V2 schema DDL and database creation.
 *
 * Key changes from V1:
 *   - files absorbs mtimes (mtime_ms column) — one fewer table
 *   - chunks.file_id INTEGER FK instead of chunks.file_path TEXT
 *   - chunks.text stored as zlib-compressed BLOB (3-5x smaller)
 *   - chunks.content_hash stored as raw SHA-256 BLOB (32 vs 64 bytes)
 *   - vec_chunks uses int8[N] instead of float[N] (4x smaller vectors)
 *   - postings.term_id INTEGER FK instead of postings.term TEXT
 *   - terms table has auto-increment id + UNIQUE term
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import path from 'node:path';
import type { SiloDatabase } from './types';
import { SCHEMA_VERSION } from './types';

// sqlite-vec extension path — rewrite ASAR path for production builds.
// SQLite's loadExtension() calls the OS's LoadLibrary/dlopen which can't
// read from inside an ASAR archive. The actual DLL/dylib/so is unpacked
// to app.asar.unpacked.
const vecExtPath = sqliteVec.getLoadablePath().replace(
  /app\.asar([\\/])/,
  'app.asar.unpacked$1',
);

/**
 * Detect whether an existing database file has a stale (pre-V2) schema.
 *
 * `CREATE TABLE IF NOT EXISTS` silently preserves old table structures,
 * so a V1 database opened with V2 DDL retains its V1 columns. The V2
 * BM25 scorer then queries non-existent columns (terms.id, postings.term_id)
 * and silently produces no results.
 *
 * We detect this by checking structural markers (V2-specific columns) and
 * the stored schema version in the meta table.
 */
function isStaleSchema(dbPath: string): boolean {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });

    // Check if the files table exists at all (fresh DB has no tables yet)
    const filesTable = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='files'",
    ).get();
    if (!filesTable) return false;

    // V2 structural marker: files.stored_key (V1 had files.file_path)
    const fileCols = db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>;
    if (!fileCols.some((c) => c.name === 'stored_key')) return true;

    // V2 structural marker: chunks.file_id (V1 had chunks.file_path)
    const chunkCols = db.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>;
    if (!chunkCols.some((c) => c.name === 'file_id')) return true;

    // V2 structural marker: postings.term_id (V1 had postings.term)
    const postCols = db.prepare('PRAGMA table_info(postings)').all() as Array<{ name: string }>;
    if (!postCols.some((c) => c.name === 'term_id')) return true;

    // Check stored schema version for future bumps (V2 → V3, etc.)
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
        | { value: string }
        | undefined;
      if (row && parseInt(row.value, 10) < SCHEMA_VERSION) return true;
    } catch {
      // meta table might not exist yet — that's OK for a fresh DB
    }

    return false;
  } catch {
    // Can't open or read the database at all — treat as stale
    return true;
  } finally {
    try { db?.close(); } catch { /* best-effort */ }
  }
}

/**
 * Open or create a V2 SQLite database for a silo.
 * Loads sqlite-vec, creates all tables, and enables WAL mode.
 *
 * If the database file exists but has a stale (V1) schema, it is
 * automatically deleted and recreated. The silo will re-index from
 * scratch on next reconciliation.
 */
export function createSiloDatabase(dbPath: string, dimensions: number): SiloDatabase {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  // Guard against CREATE TABLE IF NOT EXISTS silently preserving old schemas.
  // If the file exists with an outdated structure, nuke it for a clean rebuild.
  if (fs.existsSync(dbPath) && isStaleSchema(dbPath)) {
    console.log(`[schema] Stale schema detected at ${path.basename(dbPath)} — deleting for clean V2 rebuild`);
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* OK if missing */ }
    }
  }

  const db = new Database(dbPath);
  db.loadExtension(vecExtPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- Files (merged with mtimes — mtime_ms is nullable for new/empty files)
    CREATE TABLE IF NOT EXISTS files (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      stored_key    TEXT UNIQUE NOT NULL,
      file_name     TEXT NOT NULL,
      mtime_ms      REAL,
      file_metadata TEXT NOT NULL DEFAULT '{}'
    );

    -- Chunks (file_id FK, compressed text as BLOB, binary content hash)
    -- File-level metadata (frontmatter, PDF title/author) lives on files.file_metadata.
    CREATE TABLE IF NOT EXISTS chunks (
      id            INTEGER PRIMARY KEY,
      file_id       INTEGER NOT NULL REFERENCES files(id),
      chunk_index   INTEGER NOT NULL,
      section_path  TEXT NOT NULL,
      text          BLOB NOT NULL,
      location_hint TEXT,
      content_hash  BLOB NOT NULL,
      token_count   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);

    -- BM25 inverted index (normalized — integer FK instead of text term)
    CREATE TABLE IF NOT EXISTS terms (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      term     TEXT UNIQUE NOT NULL,
      doc_freq INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS postings (
      term_id   INTEGER NOT NULL,
      chunk_id  INTEGER NOT NULL,
      term_freq INTEGER NOT NULL,
      PRIMARY KEY (term_id, chunk_id)
    );
    CREATE INDEX IF NOT EXISTS idx_postings_chunk ON postings(chunk_id);

    -- Directory structure
    CREATE TABLE IF NOT EXISTS directories (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      dir_path     TEXT UNIQUE NOT NULL,
      dir_name     TEXT NOT NULL,
      depth        INTEGER NOT NULL,
      file_count   INTEGER NOT NULL DEFAULT 0,
      subdir_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_directories_depth ON directories(depth);

    -- Metadata (model info, corpus stats, config blob)
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Stamp schema version early so future opens can detect stale schemas
  // even before saveMeta() runs (which happens later during reconciliation).
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)')
    .run('version', String(SCHEMA_VERSION));

  // sqlite-vec virtual table — CREATE VIRTUAL TABLE IF NOT EXISTS doesn't
  // work reliably for vec0, so check first.
  const vecTableExists = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='vec_chunks'`,
  ).get();

  if (!vecTableExists) {
    db.exec(`CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding int8[${dimensions}] distance_metric=cosine)`);
  }

  return db;
}
