import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChunkRecord } from './pipeline-types';
import { listByDate } from './search-listing';
import { flushPreparedFiles } from './store/operations';
import { createSiloDatabase } from './store/schema';
import { TermCache } from './store/term-cache';
import type { FlushUpsert, SiloDatabase } from './store/types';

const DIMS = 4;

let db: SiloDatabase;
let termCache: TermCache;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-search-listing-'));
  db = createSiloDatabase(path.join(tmpDir, 'test.db'), DIMS);
  termCache = new TermCache();
  termCache.warmFromDb(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function upsert(storedKey: string, dateMs?: number): FlushUpsert {
  const chunk: ChunkRecord = {
    filePath: storedKey,
    chunkIndex: 0,
    sectionPath: ['Test'],
    text: storedKey,
    locationHint: { type: 'lines', start: 1, end: 1 },
    contentHash: Buffer.from(storedKey).toString('hex').padEnd(64, '0').slice(0, 64),
  };
  return {
    storedKey,
    chunks: [chunk],
    embeddings: [[1, 0, 0, 0]],
    mtimeMs: dateMs,
  };
}

function seed(): void {
  flushPreparedFiles(
    db,
    termCache,
    [
      upsert('0:old.md', 500),
      upsert('0:notes/alpha.md', 1000),
      upsert('0:notes/beta.md', 2000),
      upsert('0:notes/gamma.txt', 3000),
      upsert('0:new.md', 4000),
      upsert('0:newest.md', 5000),
      upsert('0:null.md'),
    ],
    [],
  );
}

describe('date-ordered listing', () => {
  it('returns every dated file in the window newest first and excludes null dates', () => {
    seed();

    const listing = listByDate(db, { dateFromMs: 1000, dateToMs: 3000, limit: 10 });

    expect(listing.total).toBe(3);
    expect(listing.results.map((result) => result.filePath)).toEqual([
      '0:notes/gamma.txt',
      '0:notes/beta.md',
      '0:notes/alpha.md',
    ]);
  });

  it('breaks equal-date ties by stored key', () => {
    flushPreparedFiles(db, termCache, [upsert('0:z.md', 1000), upsert('0:a.md', 1000)], []);

    expect(listByDate(db, {}).results.map((result) => result.filePath)).toEqual([
      '0:a.md',
      '0:z.md',
    ]);
  });

  it('limits returned rows without reducing the total', () => {
    seed();

    const listing = listByDate(db, { dateFromMs: 1000, dateToMs: 3000, limit: 2 });

    expect(listing.results.map((result) => result.filePath)).toEqual([
      '0:notes/gamma.txt',
      '0:notes/beta.md',
    ]);
    expect(listing.total).toBe(3);
  });

  it('returns offset plus limit rows for the cross-silo merge', () => {
    seed();

    const listing = listByDate(db, {
      dateFromMs: 1000,
      dateToMs: 3000,
      offset: 1,
      limit: 1,
    });

    expect(listing.results).toHaveLength(2);
    expect(listing.total).toBe(3);
  });

  it('applies path and pattern filters to both results and total', () => {
    seed();

    const byPath = listByDate(db, { startPath: '0:notes/', limit: 10 });
    const byPattern = listByDate(db, { filePattern: '**/*.md', limit: 10 });

    expect(byPath.total).toBe(3);
    expect(byPath.results).toHaveLength(3);
    expect(byPattern.total).toBe(2);
    expect(byPattern.results.map((result) => result.filePath)).toEqual([
      '0:notes/beta.md',
      '0:notes/alpha.md',
    ]);
  });

  it('returns listing marker results without ranked-search detail', () => {
    seed();

    expect(listByDate(db, { dateFromMs: 2000, dateToMs: 2000 }).results).toEqual([
      {
        filePath: '0:notes/beta.md',
        dateMs: 2000,
        score: 1,
        scoreLabel: 'date',
        signals: { date: 1 },
      },
    ]);
  });

  it('supports either inclusive one-sided date bound', () => {
    seed();

    expect(listByDate(db, { dateFromMs: 4000 }).results.map((result) => result.dateMs)).toEqual([
      5000, 4000,
    ]);
    expect(listByDate(db, { dateToMs: 1000 }).results.map((result) => result.dateMs)).toEqual([
      1000, 500,
    ]);
  });
});
