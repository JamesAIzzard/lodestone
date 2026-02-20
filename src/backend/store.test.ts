import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSiloDatabase,
  upsertFileChunks,
  deleteFileChunks,
  searchSilo,
  getChunkCount,
  getIndexedFiles,
  persistDatabase,
  loadDatabase,
  type SiloDatabase,
} from './store';
import type { ChunkRecord } from './chunker';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIMS = 4; // Use tiny vectors for tests

function makeChunk(filePath: string, index: number, text: string): ChunkRecord {
  return {
    filePath,
    chunkIndex: index,
    headingPath: ['Section'],
    text,
    startLine: 1,
    endLine: 5,
    frontmatter: {},
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

  beforeEach(async () => {
    db = await createSiloDatabase(DIMS);
  });

  it('inserts and counts chunks', async () => {
    const chunks = [makeChunk('/a.md', 0, 'Hello'), makeChunk('/a.md', 1, 'World')];
    const embeddings = [makeVector(1), makeVector(2)];

    await upsertFileChunks(db, '/a.md', chunks, embeddings);
    expect(await getChunkCount(db)).toBe(2);
  });

  it('upsert replaces existing chunks for a file', async () => {
    const chunks1 = [makeChunk('/a.md', 0, 'Original')];
    const chunks2 = [makeChunk('/a.md', 0, 'Updated'), makeChunk('/a.md', 1, 'New chunk')];

    await upsertFileChunks(db, '/a.md', chunks1, [makeVector(1)]);
    expect(await getChunkCount(db)).toBe(1);

    await upsertFileChunks(db, '/a.md', chunks2, [makeVector(3), makeVector(4)]);
    expect(await getChunkCount(db)).toBe(2);
  });

  it('deletes chunks for a file without affecting others', async () => {
    await upsertFileChunks(
      db, '/a.md',
      [makeChunk('/a.md', 0, 'A')],
      [makeVector(1)],
    );
    await upsertFileChunks(
      db, '/b.md',
      [makeChunk('/b.md', 0, 'B')],
      [makeVector(2)],
    );

    expect(await getChunkCount(db)).toBe(2);

    await deleteFileChunks(db, '/a.md');
    expect(await getChunkCount(db)).toBe(1);

    const files = await getIndexedFiles(db);
    expect(files.has('/b.md')).toBe(true);
    expect(files.has('/a.md')).toBe(false);
  });

  it('searches and aggregates by file', async () => {
    // Insert chunks for two files with related but different vectors
    // Use vectors that are both in the positive hemisphere to ensure both return
    await upsertFileChunks(
      db, '/close.md',
      [makeChunk('/close.md', 0, 'Close match')],
      [makeVector(1)],
    );
    await upsertFileChunks(
      db, '/far.md',
      [makeChunk('/far.md', 0, 'Far match')],
      [makeVector(2)],
    );

    // Search with a vector identical to makeVector(1) — /close.md should rank higher
    const results = await searchSilo(db, makeVector(1), 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].filePath).toBe('/close.md');

    if (results.length > 1) {
      expect(results[0].score).toBeGreaterThan(results[1].score);
    }
  });

  it('returns indexed file set', async () => {
    await upsertFileChunks(db, '/x.md', [makeChunk('/x.md', 0, 'X')], [makeVector(1)]);
    await upsertFileChunks(db, '/y.md', [makeChunk('/y.md', 0, 'Y')], [makeVector(2)]);

    const files = await getIndexedFiles(db);
    expect(files.size).toBe(2);
    expect(files.has('/x.md')).toBe(true);
    expect(files.has('/y.md')).toBe(true);
  });

  it('persists to disk and reloads', async () => {
    await upsertFileChunks(
      db, '/a.md',
      [makeChunk('/a.md', 0, 'Persisted')],
      [makeVector(1)],
    );

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-test-'));
    const dbPath = path.join(tmpDir, 'test.db');

    await persistDatabase(db, dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);

    const loaded = await loadDatabase(dbPath, DIMS);
    expect(loaded).not.toBeNull();
    expect(await getChunkCount(loaded!)).toBe(1);

    // Search should work on the loaded db
    const results = await searchSilo(loaded!, makeVector(1), 10);
    expect(results.length).toBe(1);
    expect(results[0].filePath).toBe('/a.md');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('loadDatabase returns null for missing file', async () => {
    const result = await loadDatabase('/nonexistent/path.db', DIMS);
    expect(result).toBeNull();
  });
});
