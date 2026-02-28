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

// sqlite-vec extension path — rewrite ASAR path for production builds.
// SQLite's loadExtension() calls the OS's LoadLibrary/dlopen which can't
// read from inside an ASAR archive. The actual DLL/dylib/so is unpacked
// to app.asar.unpacked.
const vecExtPath = sqliteVec.getLoadablePath().replace(
  /app\.asar([\\/])/,
  'app.asar.unpacked$1',
);

/**
 * Open or create a V2 SQLite database for a silo.
 * Loads sqlite-vec, creates all tables, and enables WAL mode.
 */
export function createSiloDatabase(dbPath: string, dimensions: number): SiloDatabase {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.loadExtension(vecExtPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- Files (merged with mtimes — mtime_ms is nullable for new/empty files)
    CREATE TABLE IF NOT EXISTS files (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      stored_key TEXT UNIQUE NOT NULL,
      file_name  TEXT NOT NULL,
      mtime_ms   REAL
    );

    -- Chunks (file_id FK, compressed text as BLOB, binary content hash)
    CREATE TABLE IF NOT EXISTS chunks (
      id            INTEGER PRIMARY KEY,
      file_id       INTEGER NOT NULL REFERENCES files(id),
      chunk_index   INTEGER NOT NULL,
      section_path  TEXT NOT NULL,
      text          BLOB NOT NULL,
      location_hint TEXT,
      metadata      TEXT NOT NULL DEFAULT '{}',
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
