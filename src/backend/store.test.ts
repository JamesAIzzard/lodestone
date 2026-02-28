import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  flushPreparedFiles,
  getChunkCount,
  getFileCount,
  loadMtimes,
  setMtime,
  deleteMtime,
  countMtimes,
  loadMeta,
  saveMeta,
} from './store/operations';
import { createSiloDatabase } from './store/schema';
import { TermCache } from './store/term-cache';
import type { SiloDatabase, FlushUpsert, FlushDelete } from './store/types';
import { search } from './search';
import type { ChunkRecord } from './pipeline-types';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIMS = 4; // Use tiny vectors for tests

let tmpDir: string;

/** Pad a hex string to 64 hex chars (32 bytes = SHA-256 length). */
function fakeHash(label: string): string {
  const hex = Buffer.from(label).toString('hex');
  return hex.padEnd(64, '0').slice(0, 64);
}

function makeChunk(filePath: string, index: number, text: string): ChunkRecord {
  return {
    filePath,
    chunkIndex: index,
    sectionPath: ['Section'],
    text,
    locationHint: { type: 'lines', start: 1, end: 5 },
    contentHash: fakeHash(`hash-${filePath}-${index}`),
  };
}

function makeVector(seed: number): number[] {
  // Deterministic vector based on seed
  const v = [Math.sin(seed), Math.cos(seed), Math.sin(seed * 2), Math.cos(seed * 2)];
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

function makeUpsert(storedKey: string, chunks: ChunkRecord[], embeddings: number[][], mtimeMs?: number): FlushUpsert {
  return { storedKey, chunks, embeddings, mtimeMs };
}

describe('store (V2)', () => {
  let db: SiloDatabase;
  let termCache: TermCache;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    db = createSiloDatabase(dbPath, DIMS);
    termCache = new TermCache();
    termCache.warmFromDb(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Basic CRUD ──────────────────────────────────────────────────────────

  it('inserts and counts chunks', () => {
    const chunks = [makeChunk('0:a.md', 0, 'Hello'), makeChunk('0:a.md', 1, 'World')];
    const embeddings = [makeVector(1), makeVector(2)];

    flushPreparedFiles(db, termCache, [makeUpsert('0:a.md', chunks, embeddings)], []);
    expect(getChunkCount(db)).toBe(2);
    expect(getFileCount(db)).toBe(1);
  });

  it('upsert replaces existing chunks for a file', () => {
    const chunks1 = [makeChunk('0:a.md', 0, 'Original')];
    const chunks2 = [makeChunk('0:a.md', 0, 'Updated'), makeChunk('0:a.md', 1, 'New chunk')];

    flushPreparedFiles(db, termCache, [makeUpsert('0:a.md', chunks1, [makeVector(1)])], []);
    expect(getChunkCount(db)).toBe(1);

    flushPreparedFiles(db, termCache, [makeUpsert('0:a.md', chunks2, [makeVector(3), makeVector(4)])], []);
    expect(getChunkCount(db)).toBe(2);
  });

  it('deletes chunks for a file without affecting others', () => {
    flushPreparedFiles(db, termCache, [
      makeUpsert('0:a.md', [makeChunk('0:a.md', 0, 'A')], [makeVector(1)]),
      makeUpsert('0:b.md', [makeChunk('0:b.md', 0, 'B')], [makeVector(2)]),
    ], []);

    expect(getChunkCount(db)).toBe(2);

    const deletes: FlushDelete[] = [{ storedKey: '0:a.md', deleteMtime: true }];
    flushPreparedFiles(db, termCache, [], deletes);
    expect(getChunkCount(db)).toBe(1);

    // Verify b.md's data is intact and a.md's is gone
    const remaining = db.prepare(
      `SELECT f.stored_key FROM chunks c JOIN files f ON f.id = c.file_id`,
    ).all() as Array<{ stored_key: string }>;
    expect(remaining.map((r) => r.stored_key)).toEqual(['0:b.md']);
  });

  // ── Search (Decaying Sum Pipeline) ─────────────────────────────────────

  it('search returns results aggregated by file', () => {
    flushPreparedFiles(db, termCache, [
      makeUpsert('0:close.md', [makeChunk('0:close.md', 0, 'Close match')], [makeVector(1)]),
      makeUpsert('0:far.md', [makeChunk('0:far.md', 0, 'Far match')], [makeVector(2)]),
    ], []);

    // Search with vector identical to makeVector(1) — close.md should rank higher
    const results = search(db, makeVector(1), { query: 'close', limit: 10 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].filePath).toBe('0:close.md');

    if (results.length > 1) {
      expect(results[0].score).toBeGreaterThan(results[1].score);
    }
  });

  it('search returns hint with line range', () => {
    const chunk = makeChunk('0:a.md', 0, 'Test content');
    chunk.sectionPath = ['Architecture', 'Pipeline'];
    chunk.locationHint = { type: 'lines', start: 10, end: 20 };
    flushPreparedFiles(db, termCache, [makeUpsert('0:a.md', [chunk], [makeVector(1)])], []);

    const results = search(db, makeVector(1), { query: 'test', limit: 10 });
    expect(results.length).toBe(1);
    // Hint should contain the location from the matched chunk
    if (results[0].hint) {
      expect(results[0].hint.locationHint).toEqual({ type: 'lines', start: 10, end: 20 });
    }
  });

  it('search returns scoreLabel and signals', () => {
    flushPreparedFiles(db, termCache, [
      makeUpsert('0:a.md', [makeChunk('0:a.md', 0, 'Some searchable content')], [makeVector(1)]),
    ], []);

    const results = search(db, makeVector(1), { query: 'searchable', limit: 10 });
    expect(results.length).toBe(1);
    expect(results[0].scoreLabel).toBeDefined();
    expect(typeof results[0].signals).toBe('object');
  });

  // ── Inverted Index ─────────────────────────────────────────────────────

  it('inverted index is synced after upsert and delete', () => {
    flushPreparedFiles(db, termCache, [
      makeUpsert('0:a.md', [makeChunk('0:a.md', 0, 'uniqueword alpha')], [makeVector(1)]),
    ], []);

    // The inverted index should have the term
    const termResult = db.prepare(
      `SELECT doc_freq FROM terms WHERE term = ?`,
    ).get('uniqueword') as { doc_freq: number } | undefined;
    expect(termResult).toBeDefined();
    expect(termResult!.doc_freq).toBe(1);

    // After delete, the term should be gone (zero-freq cleanup)
    flushPreparedFiles(db, termCache, [], [{ storedKey: '0:a.md', deleteMtime: true }]);
    const termAfter = db.prepare(
      `SELECT doc_freq FROM terms WHERE term = ?`,
    ).get('uniqueword') as { doc_freq: number } | undefined;
    // Zero-freq terms are cleaned up by TermCache
    expect(termAfter).toBeUndefined();
  });

  it('inverted index is synced correctly after upsert replaces content', () => {
    flushPreparedFiles(db, termCache, [
      makeUpsert('0:a.md', [makeChunk('0:a.md', 0, 'oldterm specialword')], [makeVector(1)]),
    ], []);

    // Replace with different text
    flushPreparedFiles(db, termCache, [
      makeUpsert('0:a.md', [makeChunk('0:a.md', 0, 'newterm differentword')], [makeVector(2)]),
    ], []);

    // Old term should not be findable (zero-freq cleanup)
    const oldResult = db.prepare(
      `SELECT doc_freq FROM terms WHERE term = ?`,
    ).get('oldterm');
    expect(oldResult).toBeUndefined();

    // New term should be findable
    const newResult = db.prepare(
      `SELECT doc_freq FROM terms WHERE term = ?`,
    ).get('newterm') as { doc_freq: number } | undefined;
    expect(newResult).toBeDefined();
    expect(newResult!.doc_freq).toBe(1);
  });

  // ── Mtime Persistence ──────────────────────────────────────────────────

  it('round-trips mtimes via files table', () => {
    // V2 stores mtime_ms in the files table. flushPreparedFiles sets it when provided.
    flushPreparedFiles(db, termCache, [
      makeUpsert('0:a.md', [makeChunk('0:a.md', 0, 'A')], [makeVector(1)], 1000),
      makeUpsert('0:b.md', [makeChunk('0:b.md', 0, 'B')], [makeVector(2)], 2000),
    ], []);

    const loaded = loadMtimes(db);
    expect(loaded.size).toBe(2);
    expect(loaded.get('0:a.md')).toBe(1000);
    expect(loaded.get('0:b.md')).toBe(2000);
  });

  it('sets and deletes individual mtimes', () => {
    // Create file rows first
    flushPreparedFiles(db, termCache, [
      makeUpsert('0:a.md', [makeChunk('0:a.md', 0, 'A')], [makeVector(1)], 1000),
      makeUpsert('0:b.md', [makeChunk('0:b.md', 0, 'B')], [makeVector(2)], 2000),
    ], []);
    expect(countMtimes(db)).toBe(2);

    deleteMtime(db, '0:a.md');
    expect(countMtimes(db)).toBe(1);

    const loaded = loadMtimes(db);
    expect(loaded.has('0:a.md')).toBe(false);
    expect(loaded.get('0:b.md')).toBe(2000);
  });

  it('setMtime updates existing entries', () => {
    // Create file row first
    flushPreparedFiles(db, termCache, [
      makeUpsert('0:a.md', [makeChunk('0:a.md', 0, 'A')], [makeVector(1)], 1000),
    ], []);

    setMtime(db, '0:a.md', 2000);
    expect(countMtimes(db)).toBe(1);

    const loaded = loadMtimes(db);
    expect(loaded.get('0:a.md')).toBe(2000);
  });

  // ── Meta Persistence ───────────────────────────────────────────────────

  it('round-trips meta', () => {
    saveMeta(db, 'arctic-xs', 384);

    const meta = loadMeta(db);
    expect(meta).not.toBeNull();
    expect(meta!.model).toBe('arctic-xs');
    expect(meta!.dimensions).toBe(384);
    expect(meta!.version).toBe(5); // V2 schema version (bumped: removed chunks.metadata column)
    expect(meta!.createdAt).toBeTruthy();
  });

  it('preserves createdAt on meta update', () => {
    saveMeta(db, 'arctic-xs', 384);
    const first = loadMeta(db)!;

    saveMeta(db, 'nomic-v1.5', 768);
    const second = loadMeta(db)!;

    expect(second.model).toBe('nomic-v1.5');
    expect(second.dimensions).toBe(768);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('loadMeta returns null for empty database', () => {
    expect(loadMeta(db)).toBeNull();
  });

  // ── Database Properties ────────────────────────────────────────────────

  it('database uses WAL journal mode', () => {
    const mode = db.pragma('journal_mode', { simple: true }) as string;
    expect(mode).toBe('wal');
  });

  it('reopening an existing database preserves data', () => {
    flushPreparedFiles(db, termCache, [
      makeUpsert('0:a.md', [makeChunk('0:a.md', 0, 'Persisted')], [makeVector(1)], 1234),
    ], []);
    saveMeta(db, 'test-model', DIMS);

    const dbPath = path.join(tmpDir, 'test.db');
    db.close();

    // Reopen
    const db2 = createSiloDatabase(dbPath, DIMS);
    const tc2 = new TermCache();
    tc2.warmFromDb(db2);
    expect(getChunkCount(db2)).toBe(1);
    expect(loadMtimes(db2).get('0:a.md')).toBe(1234);
    expect(loadMeta(db2)!.model).toBe('test-model');

    const results = search(db2, makeVector(1), { query: 'persisted', limit: 10 });
    expect(results.length).toBe(1);
    expect(results[0].filePath).toBe('0:a.md');

    db2.close();
    // Reassign so afterEach doesn't try to close the already-closed handle
    db = createSiloDatabase(path.join(tmpDir, 'dummy.db'), DIMS);
  });

  // ── Batch Operations ──────────────────────────────────────────────────

  it('flush handles multiple files in one batch', () => {
    const upserts: FlushUpsert[] = [
      makeUpsert('0:a.md', [makeChunk('0:a.md', 0, 'File A')], [makeVector(1)]),
      makeUpsert('0:b.md', [makeChunk('0:b.md', 0, 'File B')], [makeVector(2)]),
      makeUpsert('0:c.md', [makeChunk('0:c.md', 0, 'File C')], [makeVector(3)]),
    ];

    const result = flushPreparedFiles(db, termCache, upserts, []);
    expect(result.upserted).toBe(3);
    expect(getChunkCount(db)).toBe(3);
    expect(getFileCount(db)).toBe(3);
  });

  it('flush handles mixed upserts and deletes', () => {
    // First insert some files
    flushPreparedFiles(db, termCache, [
      makeUpsert('0:keep.md', [makeChunk('0:keep.md', 0, 'Keep')], [makeVector(1)]),
      makeUpsert('0:delete.md', [makeChunk('0:delete.md', 0, 'Delete')], [makeVector(2)]),
    ], []);
    expect(getChunkCount(db)).toBe(2);

    // Now upsert a new file and delete an existing one in the same batch
    const result = flushPreparedFiles(
      db,
      termCache,
      [makeUpsert('0:new.md', [makeChunk('0:new.md', 0, 'New')], [makeVector(3)])],
      [{ storedKey: '0:delete.md', deleteMtime: true }],
    );
    expect(result.upserted).toBe(1);
    expect(result.deleted).toBe(1);
    expect(getChunkCount(db)).toBe(2); // keep + new
  });
});
