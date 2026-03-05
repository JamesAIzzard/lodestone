/**
 * Memory store schema — database creation, migrations, and metadata.
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import path from 'node:path';
import type { MemoryDatabase } from './helpers';
import { backfillInvertedIndex } from './inverted-index';

// ── Extension Path ────────────────────────────────────────────────────────────
// Production ASAR builds need the .dll/.so unpacked from app.asar.
const vecExtPath = sqliteVec.getLoadablePath().replace(
  /app\.asar([\\/])/,
  'app.asar.unpacked$1',
);

// ── Constants ─────────────────────────────────────────────────────────────────

export const MEMORY_MODEL = 'nomic-embed-text-v1.5';
export const MEMORY_DIMENSIONS = 768;

// ── Create / Open ─────────────────────────────────────────────────────────────

/**
 * Open or create a memory database at the given path.
 * Creates parent directories, applies schema, stores model metadata.
 */
export function createMemoryDatabase(dbPath: string): MemoryDatabase {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.loadExtension(vecExtPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      vec_rowid    INTEGER,
      topic        TEXT NOT NULL,
      body         TEXT NOT NULL,
      confidence   REAL NOT NULL DEFAULT 1.0,
      context_hint TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS memory_metadata (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Migration: add vec_rowid column to existing databases that predate this schema.
  try { db.exec(`ALTER TABLE memories ADD COLUMN vec_rowid INTEGER`); } catch { /* already exists */ }

  // Migration: drop legacy FTS5 table (replaced by hand-rolled BM25 with inverted index).
  const ftsExists = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='memories_fts'`,
  ).get();
  if (ftsExists) {
    db.exec(`DROP TABLE memories_fts`);
  }

  // vec0 — must be created conditionally (CREATE VIRTUAL TABLE IF NOT EXISTS
  // is unreliable for vec0).
  const vecExists = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='memories_vec'`,
  ).get();
  if (!vecExists) {
    db.exec(`CREATE VIRTUAL TABLE memories_vec USING vec0(embedding float[${MEMORY_DIMENSIONS}])`);
  }

  // Inverted index for hand-rolled BM25 scoring (mirrors silo store pattern).
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_terms (
      term     TEXT PRIMARY KEY,
      doc_freq INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_postings (
      term      TEXT    NOT NULL,
      memory_id INTEGER NOT NULL,
      term_freq INTEGER NOT NULL,
      PRIMARY KEY (term, memory_id)
    );

    CREATE INDEX IF NOT EXISTS idx_memory_postings_memory ON memory_postings(memory_id);
  `);

  // Migration: add token_count column to existing databases.
  try { db.exec(`ALTER TABLE memories ADD COLUMN token_count INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }

  // Migration: add action_date column for temporal/deadline tagging.
  try { db.exec(`ALTER TABLE memories ADD COLUMN action_date TEXT`); } catch { /* already exists */ }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_action_date ON memories(action_date) WHERE action_date IS NOT NULL`);

  // Migration: add recurrence and priority columns.
  try { db.exec(`ALTER TABLE memories ADD COLUMN recurrence TEXT`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE memories ADD COLUMN priority INTEGER`); } catch { /* already exists */ }

  // Migration: add status and completed_on columns.
  try { db.exec(`ALTER TABLE memories ADD COLUMN status TEXT`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE memories ADD COLUMN completed_on TEXT`); } catch { /* already exists */ }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status) WHERE status IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_completed_on ON memories(completed_on) WHERE completed_on IS NOT NULL`);

  // Migration: add soft-delete columns.
  try { db.exec(`ALTER TABLE memories ADD COLUMN deleted_at TEXT`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE memories ADD COLUMN deletion_reason TEXT`); } catch { /* already exists */ }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_deleted ON memories(deleted_at) WHERE deleted_at IS NOT NULL`);

  // Store model metadata on first creation (idempotent).
  db.prepare(`INSERT OR IGNORE INTO memory_metadata (key, value) VALUES (?, ?)`)
    .run('model', MEMORY_MODEL);
  db.prepare(`INSERT OR IGNORE INTO memory_metadata (key, value) VALUES (?, ?)`)
    .run('dimensions', String(MEMORY_DIMENSIONS));

  // Backfill: if there are memories but no postings, rebuild the inverted index.
  // This handles existing databases that predate the inverted index schema.
  const memCount = (db.prepare(`SELECT COUNT(*) as cnt FROM memories`).get() as { cnt: number }).cnt;
  const postCount = (db.prepare(`SELECT COUNT(*) as cnt FROM memory_postings`).get() as { cnt: number }).cnt;
  if (memCount > 0 && postCount === 0) {
    backfillInvertedIndex(db);
  }

  return db;
}

/**
 * Open an existing memory database (no schema creation).
 * Returns null if the file doesn't exist or can't be opened.
 */
export function openMemoryDatabase(dbPath: string): MemoryDatabase | null {
  if (!fs.existsSync(dbPath)) return null;
  try {
    const db = new Database(dbPath);
    db.loadExtension(vecExtPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return db;
  } catch {
    return null;
  }
}

/**
 * Validate that a .db file is a compatible memory database.
 * Opens read-only and checks for the memory_metadata table.
 */
export function validateMemoryDatabase(dbPath: string): boolean {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_metadata'`,
      ).get();
      return row !== undefined;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/**
 * Read the model/dimensions stored in a memory database without fully opening it.
 */
export function readMemoryMeta(dbPath: string): { model: string; dimensions: number } | null {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.prepare(
        `SELECT key, value FROM memory_metadata WHERE key IN ('model', 'dimensions')`,
      ).all() as Array<{ key: string; value: string }>;
      const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      if (!map.model || !map.dimensions) return null;
      return { model: map.model, dimensions: parseInt(map.dimensions, 10) };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
