import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChunkRecord } from './pipeline-types';
import { search } from './search';
import { flushPreparedFiles } from './store/operations';
import { createSiloDatabase } from './store/schema';
import { TermCache } from './store/term-cache';
import type { FlushUpsert, SiloDatabase } from './store/types';

const DIMS = 4;

let db: SiloDatabase;
let termCache: TermCache;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-search-date-'));
  db = createSiloDatabase(path.join(tmpDir, 'test.db'), DIMS);
  termCache = new TermCache();
  termCache.warmFromDb(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fakeHash(label: string): string {
  return Buffer.from(label).toString('hex').padEnd(64, '0').slice(0, 64);
}

function vectorAt(angle: number): number[] {
  return [Math.cos(angle), Math.sin(angle), 0, 0];
}

function upsert(storedKey: string, text: string, dateMs?: number, angle = 0): FlushUpsert {
  const chunk: ChunkRecord = {
    filePath: storedKey,
    chunkIndex: 0,
    sectionPath: ['Test'],
    text,
    locationHint: { type: 'lines', start: 1, end: 1 },
    contentHash: fakeHash(storedKey),
  };
  return {
    storedKey,
    chunks: [chunk],
    embeddings: [vectorAt(angle)],
    mtimeMs: dateMs,
  };
}

function seedWindowFiles(): void {
  flushPreparedFiles(
    db,
    termCache,
    [
      upsert('0:early-window.md', 'needle bm25term common', 500, 0),
      upsert('0:inside-window.md', 'needle bm25term common', 1500, 0.2),
      upsert('0:late-window.md', 'needle common', 2500, 0.4),
      upsert('0:null-window.md', 'needle common', undefined, 0.6),
      upsert('0:filler-one.md', 'unrelated text', 3000, 0.8),
      upsert('0:filler-two.md', 'different words', 3500, 1),
    ],
    [],
  );
}

describe('date-filtered search', () => {
  it('pre-filters semantic KNN candidates so a low-similarity in-window file is found', () => {
    const files = Array.from({ length: 20 }, (_, index) => {
      const key = index === 19 ? '0:in-window.md' : `0:file-${String(index).padStart(2, '0')}.md`;
      return upsert(key, 'shared', index === 19 ? 1500 : 0, index * 0.06);
    });
    flushPreparedFiles(db, termCache, files, []);

    const results = search(db, vectorAt(0), {
      query: 'shared',
      mode: 'semantic',
      limit: 1,
      dateFromMs: 1000,
      dateToMs: 2000,
    });

    expect(results.map((result) => result.filePath)).toEqual(['0:in-window.md']);
    expect(results[0].dateMs).toBe(1500);
  });

  it('preserves unbounded semantic and hybrid result order', () => {
    const files = Array.from({ length: 20 }, (_, index) =>
      upsert(`0:file-${String(index).padStart(2, '0')}.md`, 'shared', index * 100, index * 0.06),
    );
    flushPreparedFiles(db, termCache, files, []);
    const expected = [
      '0:file-00.md',
      '0:file-01.md',
      '0:file-02.md',
      '0:file-03.md',
      '0:file-04.md',
    ];

    expect(
      search(db, vectorAt(0), { query: 'shared', mode: 'semantic', limit: 5 }).map(
        (r) => r.filePath,
      ),
    ).toEqual(expected);
    expect(
      search(db, vectorAt(0), { query: 'shared', mode: 'hybrid', limit: 5 }).map((r) => r.filePath),
    ).toEqual(expected);
  });

  it('filters BM25 without changing the retained file score', () => {
    seedWindowFiles();
    const unbounded = search(db, [], { query: 'bm25term', mode: 'bm25', limit: 10 });
    const bounded = search(db, [], {
      query: 'bm25term',
      mode: 'bm25',
      limit: 10,
      dateFromMs: 1000,
      dateToMs: 2000,
    });

    expect(bounded.map((result) => result.filePath)).toEqual(['0:inside-window.md']);
    expect(bounded[0].score).toBe(
      unbounded.find((result) => result.filePath === '0:inside-window.md')?.score,
    );
  });

  it.each([
    ['filepath', 'window'],
    ['regex', 'needle'],
  ] as const)('filters %s results and returns the stored date', (mode, query) => {
    seedWindowFiles();

    const results = search(db, [], {
      query,
      mode,
      limit: 10,
      dateFromMs: 1000,
      dateToMs: 2000,
    });

    expect(results.map((result) => [result.filePath, result.dateMs])).toEqual([
      ['0:inside-window.md', 1500],
    ]);
  });

  it('supports either one-sided bound and excludes null dates only when bounded', () => {
    seedWindowFiles();

    const from = search(db, [], { query: 'needle', mode: 'regex', limit: 10, dateFromMs: 1000 });
    const to = search(db, [], { query: 'needle', mode: 'regex', limit: 10, dateToMs: 2000 });
    const unbounded = search(db, [], { query: 'needle', mode: 'regex', limit: 10 });

    expect(from.map((result) => result.filePath)).toEqual([
      '0:inside-window.md',
      '0:late-window.md',
    ]);
    expect(to.map((result) => result.filePath)).toEqual([
      '0:early-window.md',
      '0:inside-window.md',
    ]);
    expect(unbounded.map((result) => result.dateMs)).toEqual([500, 1500, 2500, null]);
  });
});
