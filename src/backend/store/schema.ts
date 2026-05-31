/**
 * SQLite schema creation for Lodestone's derived search index.
 *
 * Index validity is decided by `peekIndexState` before this module opens a
 * file for writes. Schema/model changes rebuild the index instead of running
 * in-place migrations, so creation is intentionally straight-line.
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import path from 'node:path';
import type { SiloDatabase } from './types';
import { SCHEMA_VERSION } from './types';
import { EMBEDDING_MODEL } from '../embedding-model';

// sqlite-vec extension path: rewrite ASAR path for production builds.
// SQLite's loadExtension() calls the OS loader, which cannot read from an
// ASAR archive. The native library is unpacked to app.asar.unpacked.
const vecExtPath = sqliteVec.getLoadablePath().replace(
  /app\.asar([\\/])/,
  'app.asar.unpacked$1',
);

/**
 * Open or create a SQLite database for a silo.
 * Loads sqlite-vec, creates all tables, stamps identity metadata, and enables
 * WAL mode. Existing usable databases pass through the IF NOT EXISTS DDL as
 * no-ops; unusable databases are deleted before this function is called.
 */
export function createSiloDatabase(dbPath: string, dimensions: number): SiloDatabase {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.loadExtension(vecExtPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      stored_key    TEXT UNIQUE NOT NULL,
      file_name     TEXT NOT NULL,
      mtime_ms      REAL,
      file_metadata TEXT NOT NULL DEFAULT '{}'
    );

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

    CREATE TABLE IF NOT EXISTS directories (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      dir_path     TEXT UNIQUE NOT NULL,
      dir_name     TEXT NOT NULL,
      depth        INTEGER NOT NULL,
      file_count   INTEGER NOT NULL DEFAULT 0,
      subdir_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_directories_depth ON directories(depth);

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp     TEXT NOT NULL,
      event_type    TEXT NOT NULL,
      file_path     TEXT NOT NULL,
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity_log(timestamp DESC);
  `);

  const upsertIdentity = db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)');
  const createdAt = new Date().toISOString();
  db.transaction(() => {
    upsertIdentity.run('model', EMBEDDING_MODEL.key);
    upsertIdentity.run('dimensions', String(dimensions));
    upsertIdentity.run('createdAt', createdAt);
    upsertIdentity.run('version', String(SCHEMA_VERSION));
  })();

  // sqlite-vec virtual table: CREATE VIRTUAL TABLE IF NOT EXISTS does not
  // work reliably for vec0, so check first.
  const vecTableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='vec_chunks'",
  ).get();

  if (!vecTableExists) {
    db.exec(`CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding int8[${dimensions}] distance_metric=cosine)`);
  }

  return db;
}
