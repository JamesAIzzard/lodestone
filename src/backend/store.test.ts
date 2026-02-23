import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createSiloDatabase,
  upsertFileChunks,
  deleteFileChunks,
  twoAxisSearch,
  getChunkCount,
  loadMtimes,
  setMtime,
  deleteMtime,
  countMtimes,
  loadMeta,
  saveMeta,
  type SiloDatabase,
} from './store';
import type { ChunkRecord } from './pipeline-types';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIMS = 4; // Use tiny vectors for tests

let tmpDir: string;

function makeChunk(filePath: string, index: number, text: string): ChunkRecord {
  return {
    filePath,
    chunkIndex: index,
    sectionPath: ['Section'],
    text,
    startLine: 1,
    endLine: 5,
    metadata: {},
    contentHash: `hash-${filePath}-${index}`,
  };
}

function makeVector(seed: number): number[] {
  // Deterministic vector based on seed
  const v = [Math.sin(seed), Math.cos(seed), Math.sin(seed * 2), Math.cos(seed * 2)];
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

describe('store', () => {
  let db: SiloDatabase;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    db = createSiloDatabase(dbPath, DIMS);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Basic CRUD ──────────────────────────────────────────────────────────

  it('inserts and counts chunks', () => {
    const chunks = [makeChunk('/a.md', 0, 'Hello'), makeChunk('/a.md', 1, 'World')];
    const embeddings = [makeVector(1), makeVector(2)];

    upsertFileChunks(db, '/a.md', chunks, embeddings);
    expect(getChunkCount(db)).toBe(2);
  });

  it('upsert replaces existing chunks for a file', () => {
    const chunks1 = [makeChunk('/a.md', 0, 'Original')];
    const chunks2 = [makeChunk('/a.md', 0, 'Updated'), makeChunk('/a.md', 1, 'New chunk')];

    upsertFileChunks(db, '/a.md', chunks1, [makeVector(1)]);
    expect(getChunkCount(db)).toBe(1);

    upsertFileChunks(db, '/a.md', chunks2, [makeVector(3), makeVector(4)]);
    expect(getChunkCount(db)).toBe(2);
  });

  it('deletes chunks for a file without affecting others', () => {
    upsertFileChunks(db, '/a.md', [makeChunk('/a.md', 0, 'A')], [makeVector(1)]);
    upsertFileChunks(db, '/b.md', [makeChunk('/b.md', 0, 'B')], [makeVector(2)]);

    expect(getChunkCount(db)).toBe(2);

    deleteFileChunks(db, '/a.md');
    expect(getChunkCount(db)).toBe(1);

    // Verify /b.md's data is intact and /a.md's is gone
    const remaining = db.prepare(`SELECT file_path FROM chunks`).all() as Array<{ file_path: string }>;
    expect(remaining.map((r) => r.file_path)).toEqual(['/b.md']);
  });

  // ── Two-Axis Search ─────────────────────────────────────────────────────

  it('twoAxisSearch returns results aggregated by file', () => {
    upsertFileChunks(
      db, '/close.md',
      [makeChunk('/close.md', 0, 'Close match')],
      [makeVector(1)],
    );
    upsertFileChunks(
      db, '/far.md',
      [makeChunk('/far.md', 0, 'Far match')],
      [makeVector(2)],
    );

    // Search with vector identical to makeVector(1) — /close.md should rank higher
    const results = twoAxisSearch(db, makeVector(1), 'close', 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].filePath).toBe('/close.md');

    if (results.length > 1) {
      expect(results[0].score).toBeGreaterThan(results[1].score);
    }
  });

  it('returns chunks with parsed sectionPath', () => {
    const chunk = makeChunk('/a.md', 0, 'Test content');
    chunk.sectionPath = ['Architecture', 'Pipeline'];
    upsertFileChunks(db, '/a.md', [chunk], [makeVector(1)]);

    const results = twoAxisSearch(db, makeVector(1), 'test', 10);
    expect(results[0].chunks[0].sectionPath).toEqual(['Architecture', 'Pipeline']);
  });

  it('limits chunks per file to 5', () => {
    // Insert 8 chunks for the same file
    const chunks: ChunkRecord[] = [];
    const embeddings: number[][] = [];
    for (let i = 0; i < 8; i++) {
      chunks.push(makeChunk('/many.md', i, `Chunk ${i}`));
      embeddings.push(makeVector(i + 1));
    }
    upsertFileChunks(db, '/many.md', chunks, embeddings);

    const results = twoAxisSearch(db, makeVector(1), 'chunk', 10);
    expect(results.length).toBe(1);
    expect(results[0].chunks.length).toBeLessThanOrEqual(5);
  });

  // ── Inverted Index ─────────────────────────────────────────────────────

  it('inverted index is synced after upsert and delete', () => {
    upsertFileChunks(
      db, '/a.md',
      [makeChunk('/a.md', 0, 'uniqueword alpha')],
      [makeVector(1)],
    );

    // The inverted index should have the term
    const termResult = db.prepare(
      `SELECT doc_freq FROM terms WHERE term = ?`,
    ).get('uniqueword') as { doc_freq: number } | undefined;
    expect(termResult).toBeDefined();
    expect(termResult!.doc_freq).toBe(1);

    // After delete, the term should be gone
    deleteFileChunks(db, '/a.md');
    const termAfter = db.prepare(
      `SELECT doc_freq FROM terms WHERE term = ?`,
    ).get('uniqueword');
    expect(termAfter).toBeUndefined();
  });

  it('inverted index is synced correctly after upsert replaces content', () => {
    upsertFileChunks(
      db, '/a.md',
      [makeChunk('/a.md', 0, 'oldterm specialword')],
      [makeVector(1)],
    );

    // Replace with different text
    upsertFileChunks(
      db, '/a.md',
      [makeChunk('/a.md', 0, 'newterm differentword')],
      [makeVector(2)],
    );

    // Old term should not be findable
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

  it('round-trips mtimes', () => {
    setMtime(db, '/a.md', 1000);
    setMtime(db, '/b.md', 2000);

    const loaded = loadMtimes(db);
    expect(loaded.size).toBe(2);
    expect(loaded.get('/a.md')).toBe(1000);
    expect(loaded.get('/b.md')).toBe(2000);
  });

  it('sets and deletes individual mtimes', () => {
    setMtime(db, '/a.md', 1000);
    setMtime(db, '/b.md', 2000);
    expect(countMtimes(db)).toBe(2);

    deleteMtime(db, '/a.md');
    expect(countMtimes(db)).toBe(1);

    const loaded = loadMtimes(db);
    expect(loaded.has('/a.md')).toBe(false);
    expect(loaded.get('/b.md')).toBe(2000);
  });

  it('setMtime updates existing entries', () => {
    setMtime(db, '/a.md', 1000);
    setMtime(db, '/a.md', 2000);
    expect(countMtimes(db)).toBe(1);

    const loaded = loadMtimes(db);
    expect(loaded.get('/a.md')).toBe(2000);
  });

  // ── Meta Persistence ───────────────────────────────────────────────────

  it('round-trips meta', () => {
    saveMeta(db, 'arctic-xs', 384);

    const meta = loadMeta(db);
    expect(meta).not.toBeNull();
    expect(meta!.model).toBe('arctic-xs');
    expect(meta!.dimensions).toBe(384);
    expect(meta!.version).toBe(1);
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
    upsertFileChunks(db, '/a.md', [makeChunk('/a.md', 0, 'Persisted')], [makeVector(1)]);
    setMtime(db, '/a.md', 1234);
    saveMeta(db, 'test-model', DIMS);

    const dbPath = path.join(tmpDir, 'test.db');
    db.close();

    // Reopen
    const db2 = createSiloDatabase(dbPath, DIMS);
    expect(getChunkCount(db2)).toBe(1);
    expect(loadMtimes(db2).get('/a.md')).toBe(1234);
    expect(loadMeta(db2)!.model).toBe('test-model');

    const results = twoAxisSearch(db2, makeVector(1), 'persisted', 10);
    expect(results.length).toBe(1);
    expect(results[0].filePath).toBe('/a.md');

    db2.close();
    // Reassign so afterEach doesn't try to close the already-closed handle
    db = createSiloDatabase(path.join(tmpDir, 'dummy.db'), DIMS);
  });

  // ── Transaction Atomicity ──────────────────────────────────────────────

  it('upsert is atomic — partial failure leaves no stale data', () => {
    // Insert initial data
    upsertFileChunks(db, '/a.md', [makeChunk('/a.md', 0, 'Initial')], [makeVector(1)]);
    expect(getChunkCount(db)).toBe(1);

    // Attempt upsert with mismatched vector dimensions (wrong size)
    // This should throw inside the transaction
    try {
      const badEmbedding = [1, 2]; // Wrong dimension count
      upsertFileChunks(db, '/a.md', [makeChunk('/a.md', 0, 'Bad')], [badEmbedding]);
    } catch {
      // Expected — vec_chunks rejects wrong-dimension vectors
    }

    // Original data should still be intact (transaction rolled back)
    expect(getChunkCount(db)).toBe(1);
    const rows = db.prepare(`SELECT content_hash FROM chunks WHERE file_path = ?`).all('/a.md') as Array<{ content_hash: string }>;
    expect(rows.map((r) => r.content_hash)).toEqual(['hash-/a.md-0']);
  });
});
