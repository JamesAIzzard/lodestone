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
 * Result of pre-open schema inspection.
 *
 * - `fresh`     — file is missing or has no tables yet; create from scratch.
 * - `current`   — schema already at {@link SCHEMA_VERSION}; open as-is.
 * - `migrate`   — V2/V3/V4 database; bring forward in place via {@link migrateSchema}
 *                 and preserve the existing index data.
 * - `incompatible` — pre-V2 (V1) layout; structural columns differ from
 *                 anything we know how to migrate, so the file gets deleted
 *                 and re-indexed from disk on the next reconcile.
 */
type SchemaCheck =
  | { kind: 'fresh' }
  | { kind: 'current' }
  | { kind: 'migrate'; from: number }
  | { kind: 'incompatible' };

/**
 * Inspect an existing database file and decide how to bring it up to the
 * current schema version.
 *
 * The structural-marker checks (`stored_key`, `file_id`, `term_id`) gate
 * incompatible-V1: those columns were renamed across the V1→V2 break, so a
 * V1 file in V2 DDL would silently retain its old shape and the V2 scorers
 * would query non-existent columns. A missing structural marker therefore
 * means we cannot migrate — only rebuild.
 *
 * Once V2-or-later structure is confirmed, the version stamp in `meta`
 * picks `current` vs `migrate`. Reads happen through a temporary readonly
 * connection so the caller can decide whether to delete the file (V1) or
 * open it for an in-place migration (V2-V4).
 */
function checkSchema(dbPath: string): SchemaCheck {
  if (!fs.existsSync(dbPath)) return { kind: 'fresh' };
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });

    // Fresh-but-empty file: no `files` table → treat as fresh and let
    // CREATE TABLE IF NOT EXISTS populate it.
    const filesTable = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='files'",
    ).get();
    if (!filesTable) return { kind: 'fresh' };

    // V2 structural markers — renamed between V1 and V2. If any are missing
    // we can't migrate, only rebuild.
    const fileCols = db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>;
    if (!fileCols.some((c) => c.name === 'stored_key')) return { kind: 'incompatible' };
    const chunkCols = db.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>;
    if (!chunkCols.some((c) => c.name === 'file_id')) return { kind: 'incompatible' };
    const postCols = db.prepare('PRAGMA table_info(postings)').all() as Array<{ name: string }>;
    if (!postCols.some((c) => c.name === 'term_id')) return { kind: 'incompatible' };

    // Read the stored version, defaulting to V2 (the version at which the
    // marker columns above became stable).
    let storedVersion = 2;
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
        | { value: string }
        | undefined;
      if (row) storedVersion = parseInt(row.value, 10);
    } catch {
      // meta table might not exist on the very oldest V2 builds — that's OK,
      // we already know structurally it's at least V2.
    }

    if (storedVersion >= SCHEMA_VERSION) return { kind: 'current' };
    return { kind: 'migrate', from: storedVersion };
  } catch {
    return { kind: 'incompatible' };
  } finally {
    try { db?.close(); } catch { /* best-effort */ }
  }
}

/**
 * Migrate an open V2-V4 database in place to {@link SCHEMA_VERSION}.
 *
 * Each step is idempotent (guarded by `PRAGMA table_info`) so a partial
 * run can be safely retried. Steps that don't require DDL (V2→V3 corpus
 * stats keys, V3→V4 activity_log table) are no-ops here: corpus stats are
 * recomputed lazily by {@link updateCorpusStats}, and the activity_log
 * table is added by the `CREATE TABLE IF NOT EXISTS` block in
 * {@link createSiloDatabase} that runs after this function returns.
 *
 * Wrapped in a transaction so a mid-migration failure leaves the file in
 * its pre-migration state. The version stamp is bumped at the end so the
 * next boot won't re-attempt a half-done migration.
 */
function migrateSchema(db: SiloDatabase, from: number): void {
  console.log(`[schema] Migrating database in place: V${from} → V${SCHEMA_VERSION}`);
  const tx = db.transaction(() => {
    // V4 → V5: per-chunk metadata column moved to a single per-file column
    // (commit fdd9f1f — eliminates 16 GB → 23 MB duplication on large PDFs).
    if (from < 5) {
      const fileCols = db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>;
      if (!fileCols.some((c) => c.name === 'file_metadata')) {
        db.exec(`ALTER TABLE files ADD COLUMN file_metadata TEXT NOT NULL DEFAULT '{}'`);
      }
      const chunkCols = db.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>;
      if (chunkCols.some((c) => c.name === 'metadata')) {
        db.exec(`ALTER TABLE chunks DROP COLUMN metadata`);
      }
    }

    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run('version', String(SCHEMA_VERSION));
  });
  tx();
}

/**
 * Open or create a SQLite database for a silo.
 * Loads sqlite-vec, creates all tables, and enables WAL mode.
 *
 * If the file exists with a V2-V4 schema it is migrated in place via
 * {@link migrateSchema}, preserving the existing index. Only pre-V2 (V1)
 * layouts are deleted and rebuilt — there the column renames make a
 * straight migration impossible.
 */
export function createSiloDatabase(dbPath: string, dimensions: number): SiloDatabase {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const check = checkSchema(dbPath);

  // V1 → V2 changed primary-column names (file_path → stored_key etc.), so
  // the only safe path is to delete and re-index from disk.
  if (check.kind === 'incompatible') {
    console.log(`[schema] Pre-V2 (V1) schema detected at ${path.basename(dbPath)} — deleting for clean rebuild`);
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* OK if missing */ }
    }
  }

  const db = new Database(dbPath);
  db.loadExtension(vecExtPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  if (check.kind === 'migrate') {
    migrateSchema(db, check.from);
  }

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

    -- Activity log (rolling, capped per settings)
    CREATE TABLE IF NOT EXISTS activity_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp     TEXT NOT NULL,
      event_type    TEXT NOT NULL,
      file_path     TEXT NOT NULL,
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity_log(timestamp DESC);
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
