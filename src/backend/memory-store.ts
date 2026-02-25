/**
 * Memory store — SQLite persistence for Claude's memory system.
 *
 * Single database file with three parallel tables:
 *   - memories        — canonical record store
 *   - memories_fts    — FTS5 trigram index for BM25 search (manually synced)
 *   - memories_vec    — sqlite-vec virtual table for cosine similarity search
 *   - memory_metadata — model/dimensions at initialisation time
 *
 * All functions are synchronous (better-sqlite3).
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import path from 'node:path';

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
export const DEDUP_THRESHOLD = 0.88;

/** Equivalent vec0 distance upper bound for DEDUP_THRESHOLD.
 *  vec0 stores cosine distance where cosine_sim = 1 - distance/2. */
const DEDUP_MAX_DISTANCE = 2 * (1 - DEDUP_THRESHOLD); // 0.24

export type MemoryDatabase = Database.Database;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MemoryRecord {
  id: number;
  topic: string;
  body: string;
  confidence: number;
  contextHint: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemorySearchResult extends MemoryRecord {
  score: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Pack a float[] into a Float32Array buffer for sqlite-vec. */
function float32Buffer(values: number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer);
}

/** Convert a raw DB row to a typed MemoryRecord. */
function rowToRecord(row: Record<string, unknown>): MemoryRecord {
  return {
    id: row.id as number,
    topic: row.topic as string,
    body: row.body as string,
    confidence: row.confidence as number,
    contextHint: (row.context_hint as string | null) ?? null,
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

  // FTS5 trigram table — manually synced with memories.
  // Non-content table: body stored here independently (minimal overhead for
  // short memory entries, avoids external-content sync complexity).
  const ftExists = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='memories_fts'`,
  ).get();
  if (!ftExists) {
    db.exec(`CREATE VIRTUAL TABLE memories_fts USING fts5(body, tokenize='trigram')`);
  }

  // vec0 — must be created conditionally (CREATE VIRTUAL TABLE IF NOT EXISTS
  // is unreliable for vec0).
  const vecExists = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='memories_vec'`,
  ).get();
  if (!vecExists) {
    db.exec(`CREATE VIRTUAL TABLE memories_vec USING vec0(embedding float[${MEMORY_DIMENSIONS}])`);
  }

  // Store model metadata on first creation (idempotent).
  db.prepare(`INSERT OR IGNORE INTO memory_metadata (key, value) VALUES (?, ?)`)
    .run('model', MEMORY_MODEL);
  db.prepare(`INSERT OR IGNORE INTO memory_metadata (key, value) VALUES (?, ?)`)
    .run('dimensions', String(MEMORY_DIMENSIONS));

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
      `INSERT INTO memories (vec_rowid, topic, body, confidence, context_hint) VALUES (?, ?, ?, ?, ?)`,
    ).run(vecRowid, topic, body, confidence, contextHint);
    const id = Number(memResult.lastInsertRowid);

    // Sync FTS using the memories id as rowid
    db.prepare(`INSERT INTO memories_fts(rowid, body) VALUES (?, ?)`).run(id, body);

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
  updates: { body?: string; confidence?: number; contextHint?: string | null },
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

    vals.push(id);
    db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

    // Re-sync FTS if body changed
    if (updates.body !== undefined) {
      db.prepare(`DELETE FROM memories_fts WHERE rowid = ?`).run(id);
      db.prepare(`INSERT INTO memories_fts(rowid, body) VALUES (?, ?)`).run(id, updates.body);
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
    db.prepare(`DELETE FROM memories_fts WHERE rowid = ?`).run(id);
    db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
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

// ── Dedup Check ───────────────────────────────────────────────────────────────

/**
 * Find an existing memory that is closely similar to the given embedding.
 * Uses vec0 cosine distance — returns the closest match if it is within
 * DEDUP_THRESHOLD, otherwise null.
 */
export function findSimilarMemory(
  db: MemoryDatabase,
  embedding: number[],
): MemoryRecord | null {
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
  return memRow ? rowToRecord(memRow) : null;
}

// ── Hybrid Search ─────────────────────────────────────────────────────────────

/**
 * Hybrid search over memories: BM25 (FTS5) + cosine (vec0), fused by weighted-max.
 *
 * Mirrors the two-axis approach used in silo search:
 *   content score = max(normalised_cosine, normalised_bm25) per memory.
 *
 * Returns up to maxResults memories sorted by score descending.
 */
export function hybridSearchMemory(
  db: MemoryDatabase,
  queryVector: number[],
  query: string,
  maxResults: number,
): MemorySearchResult[] {
  const count = getMemoryCount(db);
  if (count === 0) return [];

  const k = Math.max(maxResults * 5, 20);

  // ── Cosine scores from vec0 → mapped to memories.id ─────────────────────
  // vec0 returns vec_rowid; look up memories.id via the vec_rowid column.
  const cosineById = new Map<number, number>();
  try {
    const vecRows = db.prepare(`
      SELECT rowid, distance
      FROM memories_vec
      WHERE embedding MATCH ?
        AND k = ?
    `).all(float32Buffer(queryVector), k) as Array<{ rowid: number; distance: number }>;

    if (vecRows.length > 0) {
      const vecRowids = vecRows.map((r) => r.rowid);
      const ph = vecRowids.map(() => '?').join(', ');
      const mappings = db.prepare(
        `SELECT id, vec_rowid FROM memories WHERE vec_rowid IN (${ph})`,
      ).all(...vecRowids) as Array<{ id: number; vec_rowid: number }>;

      const vecDistMap = new Map(vecRows.map((r) => [r.rowid, r.distance]));
      for (const m of mappings) {
        const dist = vecDistMap.get(m.vec_rowid) ?? 2;
        cosineById.set(m.id, 1 - dist / 2);
      }
    }
  } catch {
    // vec0 may fail if table is empty or query is malformed — continue with BM25 only
  }

  // ── BM25 scores from FTS5 (keyed by memories.id = FTS rowid) ─────────────
  const bm25Scores = new Map<number, number>();
  try {
    const sanitisedQuery = query.trim().replace(/["*()]/g, ' ').trim();
    if (sanitisedQuery.length >= 3) {
      const ftsRows = db.prepare(`
        SELECT rowid, -bm25(memories_fts) AS raw_bm25
        FROM memories_fts
        WHERE memories_fts MATCH ?
        ORDER BY raw_bm25 DESC
        LIMIT ?
      `).all(`"${sanitisedQuery}"`, k) as Array<{ rowid: number; raw_bm25: number }>;

      if (ftsRows.length > 0) {
        const maxBm25 = ftsRows[0].raw_bm25;
        if (maxBm25 > 0) {
          for (const row of ftsRows) {
            bm25Scores.set(row.rowid, Math.min(row.raw_bm25 / maxBm25, 1.0));
          }
        }
      }
    }
  } catch {
    // FTS5 query may fail on unusual input — continue with cosine only
  }

  // ── Fuse scores by memories.id ────────────────────────────────────────────
  const allIds = new Set([...cosineById.keys(), ...bm25Scores.keys()]);
  if (allIds.size === 0) return [];

  const scored: Array<{ id: number; score: number }> = [];
  for (const id of allIds) {
    const cosine = cosineById.get(id) ?? 0;
    const bm25 = bm25Scores.get(id) ?? 0;
    scored.push({ id, score: Math.max(cosine, bm25) });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, maxResults);

  // ── Fetch full records by memories.id ─────────────────────────────────────
  if (top.length === 0) return [];

  const placeholders = top.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT * FROM memories WHERE id IN (${placeholders})`,
  ).all(...top.map((r) => r.id)) as Record<string, unknown>[];

  const rowMap = new Map(rows.map((r) => [r.id as number, r]));

  return top
    .filter((r) => rowMap.has(r.id))
    .map((r) => ({
      ...rowToRecord(rowMap.get(r.id)!),
      score: r.score,
    }));
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
