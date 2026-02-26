/**
 * Memory store — SQLite persistence for Claude's memory system.
 *
 * Tables:
 *   - memories         — canonical record store
 *   - memories_vec     — sqlite-vec virtual table for cosine similarity search
 *   - memory_terms     — inverted index: term → doc_freq (for hand-rolled BM25)
 *   - memory_postings  — inverted index: (term, memory_id) → term_freq
 *   - memory_metadata  — model/dimensions/corpus stats
 *
 * All functions are synchronous (better-sqlite3).
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import path from 'node:path';
import { tokenise } from './tokeniser';

// ── Extension Path ────────────────────────────────────────────────────────────
// Production ASAR builds need the .dll/.so unpacked from app.asar.
const vecExtPath = sqliteVec.getLoadablePath().replace(
  /app\.asar([\\/])/,
  'app.asar.unpacked$1',
);

// ── Constants ─────────────────────────────────────────────────────────────────

export const MEMORY_MODEL = 'nomic-embed-text-v1.5';
export const MEMORY_DIMENSIONS = 768;

/** Cosine similarity threshold for dedup check in lodestone_remember. */
export const DEDUP_THRESHOLD = 0.80;

/** Equivalent vec0 distance upper bound for DEDUP_THRESHOLD.
 *  vec0 stores cosine distance where cosine_sim = 1 - distance/2. */
const DEDUP_MAX_DISTANCE = 2 * (1 - DEDUP_THRESHOLD); // 0.40

export type MemoryDatabase = Database.Database;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MemoryRecord {
  id: number;
  topic: string;
  body: string;
  confidence: number;
  contextHint: string | null;
  actionDate: string | null;
  recurrence: string | null;
  priority: number | null;
  status: string | null;
  completedOn: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Pack a float[] into a Float32Array buffer for sqlite-vec. */
export function float32Buffer(values: number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer);
}

/** Convert a raw DB row to a typed MemoryRecord. */
export function rowToRecord(row: Record<string, unknown>): MemoryRecord {
  return {
    id: row.id as number,
    topic: row.topic as string,
    body: row.body as string,
    confidence: row.confidence as number,
    contextHint: (row.context_hint as string | null) ?? null,
    actionDate: (row.action_date as string | null) ?? null,
    recurrence: (row.recurrence as string | null) ?? null,
    priority: (row.priority as number | null) ?? null,
    status: (row.status as string | null) ?? null,
    completedOn: (row.completed_on as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

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

// ── Inverted Index Helpers ─────────────────────────────────────────────────────

/**
 * Add a memory's body text to the inverted index.
 * Tokenises the text, computes term frequencies, upserts into postings/terms,
 * and updates the memory's token_count.
 */
function addToInvertedIndex(db: MemoryDatabase, memoryId: number, body: string): void {
  const tokens = tokenise(body);

  db.prepare(`UPDATE memories SET token_count = ? WHERE id = ?`).run(tokens.length, memoryId);

  const termFreqs = new Map<string, number>();
  for (const token of tokens) {
    termFreqs.set(token, (termFreqs.get(token) ?? 0) + 1);
  }

  const upsertTerm = db.prepare(
    `INSERT INTO memory_terms (term, doc_freq) VALUES (?, 1)
     ON CONFLICT(term) DO UPDATE SET doc_freq = doc_freq + 1`,
  );
  const insertPosting = db.prepare(
    `INSERT OR REPLACE INTO memory_postings (term, memory_id, term_freq) VALUES (?, ?, ?)`,
  );

  for (const [term, freq] of termFreqs) {
    upsertTerm.run(term);
    insertPosting.run(term, memoryId, freq);
  }
}

/**
 * Remove a memory from the inverted index.
 * Decrements doc_freq in memory_terms and deletes terms that reach 0.
 */
function removeFromInvertedIndex(db: MemoryDatabase, memoryId: number): void {
  const affectedTerms = db.prepare(
    `SELECT DISTINCT term FROM memory_postings WHERE memory_id = ?`,
  ).all(memoryId) as Array<{ term: string }>;

  db.prepare(`DELETE FROM memory_postings WHERE memory_id = ?`).run(memoryId);

  for (const { term } of affectedTerms) {
    const remaining = db.prepare(
      `SELECT COUNT(*) as cnt FROM memory_postings WHERE term = ?`,
    ).get(term) as { cnt: number };

    if (remaining.cnt === 0) {
      db.prepare(`DELETE FROM memory_terms WHERE term = ?`).run(term);
    } else {
      db.prepare(`UPDATE memory_terms SET doc_freq = ? WHERE term = ?`).run(remaining.cnt, term);
    }
  }
}

/**
 * Recompute corpus-level BM25 statistics and store in memory_metadata.
 */
function updateMemoryCorpusStats(db: MemoryDatabase): void {
  const stats = db.prepare(
    `SELECT COUNT(*) AS cnt, COALESCE(AVG(token_count), 0) AS avg_tc FROM memories`,
  ).get() as { cnt: number; avg_tc: number };

  const upsert = db.prepare(
    `INSERT OR REPLACE INTO memory_metadata (key, value) VALUES (?, ?)`,
  );
  upsert.run('corpus_memory_count', String(stats.cnt));
  upsert.run('corpus_avg_token_count', String(stats.avg_tc));
}

/**
 * Backfill inverted index for existing memories that predate this schema.
 * Runs inside a single transaction for efficiency.
 */
function backfillInvertedIndex(db: MemoryDatabase): void {
  const allMemories = db.prepare(`SELECT id, body FROM memories`).all() as Array<{ id: number; body: string }>;

  db.transaction(() => {
    for (const mem of allMemories) {
      addToInvertedIndex(db, mem.id, mem.body);
    }
    updateMemoryCorpusStats(db);
  })();
}

// ── Write Operations ──────────────────────────────────────────────────────────

/**
 * Insert a new memory record and sync FTS + vec tables.
 * Returns the new row's id.
 */
export function insertMemory(
  db: MemoryDatabase,
  topic: string,
  body: string,
  confidence: number,
  contextHint: string | null,
  embedding: number[],
  actionDate: string | null = null,
  recurrence: string | null = null,
  priority: number | null = null,
  status: string | null = null,
  completedOn: string | null = null,
): number {
  const result = db.transaction(() => {
    // Insert into vec0 first — it auto-assigns a rowid. Store that rowid in
    // memories.vec_rowid so we can re-sync the vec entry on future updates.
    // (vec0 rejects explicit rowid inserts — same pattern as store.ts / vec_chunks.)
    const vecResult = db.prepare(
      `INSERT INTO memories_vec(embedding) VALUES (?)`,
    ).run(float32Buffer(embedding));
    const vecRowid = Number(vecResult.lastInsertRowid);

    // Insert into main table; id is auto-assigned by AUTOINCREMENT.
    const memResult = db.prepare(
      `INSERT INTO memories (vec_rowid, topic, body, confidence, context_hint, action_date, recurrence, priority, status, completed_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(vecRowid, topic, body, confidence, contextHint, actionDate, recurrence, priority, status, completedOn);
    const id = Number(memResult.lastInsertRowid);

    // Build inverted index for BM25 scoring
    addToInvertedIndex(db, id, body);
    updateMemoryCorpusStats(db);

    return id;
  })();

  return result as number;
}

/**
 * Update an existing memory by id. Only supplied fields are changed.
 * If body changes, re-syncs FTS. If embedding is supplied, re-syncs vec.
 */
export function updateMemory(
  db: MemoryDatabase,
  id: number,
  updates: {
    body?: string;
    confidence?: number;
    contextHint?: string | null;
    actionDate?: string | null;
    recurrence?: string | null;
    priority?: number | null;
    topic?: string;
    status?: string | null;
    completedOn?: string | null;
  },
  embedding?: number[],
): void {
  db.transaction(() => {
    const sets: string[] = ['updated_at = datetime(\'now\')'];
    const vals: unknown[] = [];

    if (updates.body !== undefined) {
      sets.push('body = ?');
      vals.push(updates.body);
    }
    if (updates.confidence !== undefined) {
      sets.push('confidence = ?');
      vals.push(updates.confidence);
    }
    if (updates.contextHint !== undefined) {
      sets.push('context_hint = ?');
      vals.push(updates.contextHint);
    }
    if (updates.actionDate !== undefined) {
      sets.push('action_date = ?');
      vals.push(updates.actionDate);
    }
    if (updates.recurrence !== undefined) {
      sets.push('recurrence = ?');
      vals.push(updates.recurrence);
    }
    if (updates.priority !== undefined) {
      sets.push('priority = ?');
      vals.push(updates.priority);
    }
    if (updates.topic !== undefined) {
      sets.push('topic = ?');
      vals.push(updates.topic);
    }
    if (updates.status !== undefined) {
      sets.push('status = ?');
      vals.push(updates.status);
    }
    if (updates.completedOn !== undefined) {
      sets.push('completed_on = ?');
      vals.push(updates.completedOn);
    }

    vals.push(id);
    db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

    // Re-sync inverted index if body changed
    if (updates.body !== undefined) {
      removeFromInvertedIndex(db, id);
      addToInvertedIndex(db, id, updates.body);
      updateMemoryCorpusStats(db);
    }

    // Re-sync vec if embedding provided: delete old vec row, insert new one,
    // then update the vec_rowid pointer in memories.
    if (embedding !== undefined) {
      const memRow = db.prepare(`SELECT vec_rowid FROM memories WHERE id = ?`).get(id) as { vec_rowid: number | null } | undefined;
      if (memRow?.vec_rowid != null) {
        db.prepare(`DELETE FROM memories_vec WHERE rowid = ?`).run(memRow.vec_rowid);
      }
      const vecResult = db.prepare(`INSERT INTO memories_vec(embedding) VALUES (?)`).run(float32Buffer(embedding));
      const newVecRowid = Number(vecResult.lastInsertRowid);
      db.prepare(`UPDATE memories SET vec_rowid = ? WHERE id = ?`).run(newVecRowid, id);
    }
  })();
}

/**
 * Delete a memory by id and remove it from FTS + vec tables.
 */
export function deleteMemory(db: MemoryDatabase, id: number): void {
  db.transaction(() => {
    const memRow = db.prepare(`SELECT vec_rowid FROM memories WHERE id = ?`).get(id) as { vec_rowid: number | null } | undefined;
    if (memRow?.vec_rowid != null) {
      db.prepare(`DELETE FROM memories_vec WHERE rowid = ?`).run(memRow.vec_rowid);
    }
    removeFromInvertedIndex(db, id);
    db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
    updateMemoryCorpusStats(db);
  })();
}

// ── Read Operations ───────────────────────────────────────────────────────────

/** Get a single memory record by id. Returns null if not found. */
export function getMemory(db: MemoryDatabase, id: number): MemoryRecord | null {
  const row = db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToRecord(row) : null;
}

/** Count all memories. */
export function getMemoryCount(db: MemoryDatabase): number {
  const row = db.prepare(`SELECT COUNT(*) as cnt FROM memories`).get() as { cnt: number };
  return row.cnt;
}

/** Return N most recently updated memories (for lodestone_orient). */
export function getRecentMemories(db: MemoryDatabase, maxResults: number): MemoryRecord[] {
  const rows = db.prepare(
    `SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?`,
  ).all(maxResults) as Record<string, unknown>[];
  return rows.map(rowToRecord);
}

/**
 * Return memories with action_date in the given range, ordered by action_date ASC.
 * Used by orient to surface upcoming deadlines.
 */
export function getMemoriesByActionDateRange(
  db: MemoryDatabase,
  fromDate: string,
  toDate: string,
  maxResults: number,
): MemoryRecord[] {
  const rows = db.prepare(
    `SELECT * FROM memories
     WHERE action_date IS NOT NULL
       AND action_date >= ?
       AND action_date <= ?
     ORDER BY action_date ASC
     LIMIT ?`,
  ).all(fromDate, toDate, maxResults) as Record<string, unknown>[];
  return rows.map(rowToRecord);
}

/**
 * Return the set of memory IDs that match the given date-range filters.
 * Used to pre-filter candidates before the search pipeline runs.
 * Returns null if no date filters are active (meaning "no restriction").
 */
export function filterMemoryIdsByDate(
  db: MemoryDatabase,
  filters: {
    updatedAfter?: string;
    updatedBefore?: string;
    actionAfter?: string;
    actionBefore?: string;
    completedAfter?: string;
    completedBefore?: string;
    status?: string | null;
  },
): Set<number> | null {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters.updatedAfter) {
    clauses.push(`updated_at >= ?`);
    params.push(filters.updatedAfter);
  }
  if (filters.updatedBefore) {
    // Add a day to make the comparison inclusive for date-only values
    // since updated_at is a datetime like "2026-02-26 15:30:00"
    clauses.push(`updated_at <= ? || ' 23:59:59'`);
    params.push(filters.updatedBefore);
  }
  if (filters.actionAfter) {
    clauses.push(`action_date IS NOT NULL AND action_date >= ?`);
    params.push(filters.actionAfter);
  }
  if (filters.actionBefore) {
    clauses.push(`action_date IS NOT NULL AND action_date <= ?`);
    params.push(filters.actionBefore);
  }
  if (filters.completedAfter) {
    clauses.push(`completed_on IS NOT NULL AND completed_on >= ?`);
    params.push(filters.completedAfter);
  }
  if (filters.completedBefore) {
    clauses.push(`completed_on IS NOT NULL AND completed_on <= ?`);
    params.push(filters.completedBefore);
  }
  if (filters.status !== undefined) {
    if (filters.status === 'completed') {
      clauses.push(`(status = 'completed' OR completed_on IS NOT NULL)`);
    } else if (filters.status === null) {
      clauses.push(`(status IS NULL AND completed_on IS NULL)`);
    } else {
      clauses.push(`status = ?`);
      params.push(filters.status);
    }
  }

  if (clauses.length === 0) return null; // no filters active

  const sql = `SELECT id FROM memories WHERE ${clauses.join(' AND ')}`;
  const rows = db.prepare(sql).all(...params) as Array<{ id: number }>;
  return new Set(rows.map(r => r.id));
}

/** Return memories with action_date before today that are not completed or cancelled.
 *  Used by agenda to surface overdue items. */
export function getOverdueMemories(
  db: MemoryDatabase,
  beforeDate: string,
  maxResults: number,
): MemoryRecord[] {
  const rows = db.prepare(
    `SELECT * FROM memories
     WHERE action_date IS NOT NULL
       AND action_date < ?
       AND completed_on IS NULL
       AND (status IS NULL OR status = 'open')
     ORDER BY COALESCE(priority, 0) DESC, action_date ASC
     LIMIT ?`,
  ).all(beforeDate, maxResults) as Record<string, unknown>[];
  return rows.map(rowToRecord);
}

/** Return upcoming memories (action_date in range) excluding completed and cancelled.
 *  Used by agenda and orient. */
export function getActiveUpcomingMemories(
  db: MemoryDatabase,
  fromDate: string,
  toDate: string,
  maxResults: number,
): MemoryRecord[] {
  const rows = db.prepare(
    `SELECT * FROM memories
     WHERE action_date IS NOT NULL
       AND action_date >= ?
       AND action_date <= ?
       AND completed_on IS NULL
       AND (status IS NULL OR status = 'open')
     ORDER BY action_date ASC
     LIMIT ?`,
  ).all(fromDate, toDate, maxResults) as Record<string, unknown>[];
  return rows.map(rowToRecord);
}

/** Return N most recently updated memories, excluding completed and cancelled.
 *  Used by orient. */
export function getRecentActiveMemories(
  db: MemoryDatabase,
  maxResults: number,
): MemoryRecord[] {
  const rows = db.prepare(
    `SELECT * FROM memories
     WHERE completed_on IS NULL
       AND (status IS NULL OR status = 'open')
     ORDER BY updated_at DESC
     LIMIT ?`,
  ).all(maxResults) as Record<string, unknown>[];
  return rows.map(rowToRecord);
}

// ── Dedup Check ───────────────────────────────────────────────────────────────

/** Result of a dedup similarity check. */
export interface SimilarMemoryResult {
  record: MemoryRecord;
  /** Cosine similarity in [0, 1] (1 = identical). */
  similarity: number;
}

/**
 * Find an existing memory that is closely similar to the given embedding.
 * Uses vec0 cosine distance — returns the closest match with similarity
 * score if it is within DEDUP_THRESHOLD, otherwise null.
 */
export function findSimilarMemory(
  db: MemoryDatabase,
  embedding: number[],
): SimilarMemoryResult | null {
  const count = getMemoryCount(db);
  if (count === 0) return null;

  const vecRow = db.prepare(`
    SELECT rowid, distance
    FROM memories_vec
    WHERE embedding MATCH ?
      AND k = 1
  `).get(float32Buffer(embedding)) as { rowid: number; distance: number } | undefined;

  if (!vecRow || vecRow.distance > DEDUP_MAX_DISTANCE) return null;

  // Join back to memories via vec_rowid (not id — they differ after embedding updates)
  const memRow = db.prepare(`SELECT * FROM memories WHERE vec_rowid = ?`).get(vecRow.rowid) as Record<string, unknown> | undefined;
  if (!memRow) return null;

  // Convert vec0 cosine distance to similarity: sim = 1 - distance/2
  const similarity = 1 - vecRow.distance / 2;
  return { record: rowToRecord(memRow), similarity };
}

// ── Utility ───────────────────────────────────────────────────────────────────

/** Return the size of the database file in bytes. Returns 0 if file not found. */
export function getMemoryDatabaseSizeBytes(dbPath: string): number {
  try {
    return fs.statSync(dbPath).size;
  } catch {
    return 0;
  }
}
