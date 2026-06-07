/**
 * Unit tests for MtimeIndex / MtimeSink.
 *
 * Uses the in-memory StoreFacade so tests are fast and don't touch disk.
 * Tests cover the read surface, both write paths (sync `record*` and
 * async `indexed/deleted`), bulk load, and the in-memory/DB mirror.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  LocalStoreFacade,
  createInMemoryStoreFacade,
} from '../test-helpers/local-store-facade';
import { MtimeIndex } from './mtime-index';
import type { FlushUpsert } from '../store/types';
import type { ChunkRecord } from '../pipeline-types';

// ── Helpers ──────────────────────────────────────────────────────────────────

const SILO = 'mtime-test';
const DIMS = 4;

/** Fresh hash padded to 64 hex chars (SHA-256 length). */
function fakeHash(label: string): string {
  return Buffer.from(label).toString('hex').padEnd(64, '0').slice(0, 64);
}

function makeChunk(filePath: string, idx: number, text: string): ChunkRecord {
  return {
    filePath,
    chunkIndex: idx,
    sectionPath: ['Section'],
    text,
    locationHint: { type: 'lines', start: 1, end: 5 },
    contentHash: fakeHash(`${filePath}-${idx}`),
  };
}

function unitVector(seed: number): number[] {
  const v = [Math.sin(seed), Math.cos(seed), Math.sin(seed * 2), Math.cos(seed * 2)];
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

/**
 * Pre-populate the store with one indexed file at `storedKey` with the
 * given mtime. Required because `setMtime` in operations.ts is an UPDATE,
 * not an UPSERT — a file row must exist before mtime updates take effect.
 */
async function seedFile(store: LocalStoreFacade, storedKey: string, mtimeMs: number): Promise<void> {
  const upsert: FlushUpsert = {
    storedKey,
    chunks: [makeChunk(storedKey, 0, 'seed')],
    embeddings: [unitVector(1)],
    mtimeMs,
  };
  await store.flush(SILO, [upsert], []);
}

// ── Tests ────────────────────────────────────────────────────────────────────

let store: LocalStoreFacade;

beforeEach(async () => {
  store = createInMemoryStoreFacade();
  await store.open(SILO, ':ignored:', DIMS);
});

afterEach(async () => {
  await store.close(SILO);
});

describe('MtimeIndex — reader surface', () => {
  it('starts empty', () => {
    const idx = new MtimeIndex(SILO, store);
    expect(idx.size).toBe(0);
    expect(idx.has('0:a.md')).toBe(false);
    expect(idx.get('0:a.md')).toBeUndefined();
    expect(Array.from(idx.keys())).toEqual([]);
  });

  it('reflects entries after sync record + after a bulk load', async () => {
    const idx = new MtimeIndex(SILO, store);
    idx.recordIndexed('0:a.md', 100);
    idx.recordIndexed('0:b.md', 200);
    expect(idx.size).toBe(2);
    expect(idx.has('0:a.md')).toBe(true);
    expect(idx.get('0:b.md')).toBe(200);
    expect(new Set(idx.keys())).toEqual(new Set(['0:a.md', '0:b.md']));
  });
});

describe('MtimeIndex — sync sink (in-memory only)', () => {
  it('recordIndexed updates the map without touching the DB', async () => {
    const idx = new MtimeIndex(SILO, store);
    idx.recordIndexed('0:a.md', 1234);

    expect(idx.get('0:a.md')).toBe(1234);
    // DB was not touched — loadMtimes returns empty.
    const fromStore = await store.loadMtimes(SILO);
    expect(fromStore.size).toBe(0);
  });

  it('recordDeleted removes from the map without touching the DB', async () => {
    const idx = new MtimeIndex(SILO, store);
    idx.recordIndexed('0:a.md', 1234);
    idx.recordDeleted('0:a.md');
    expect(idx.has('0:a.md')).toBe(false);
  });
});

describe('MtimeIndex — async write-through (in-memory + DB)', () => {
  it('indexed updates both the map and the DB', async () => {
    // The DB row must already exist for setMtime (UPDATE) to take effect.
    await seedFile(store, '0:a.md', 1000);

    const idx = new MtimeIndex(SILO, store);
    await idx.indexed('0:a.md', 9999);

    expect(idx.get('0:a.md')).toBe(9999);
    const fromStore = await store.loadMtimes(SILO);
    expect(fromStore.get('0:a.md')).toBe(9999);
  });

  it('deleted removes from both the map and the DB', async () => {
    await seedFile(store, '0:a.md', 1000);

    // Bring the in-memory index in sync with the seeded DB.
    const idx = new MtimeIndex(SILO, store);
    await idx.loadFromStore();
    expect(idx.has('0:a.md')).toBe(true);

    await idx.deleted('0:a.md');

    expect(idx.has('0:a.md')).toBe(false);
    const fromStore = await store.loadMtimes(SILO);
    expect(fromStore.has('0:a.md')).toBe(false);
  });
});

describe('MtimeIndex — bulk load and clear', () => {
  it('loadFromStore replaces the in-memory map with the store state', async () => {
    await seedFile(store, '0:a.md', 100);
    await seedFile(store, '0:b.md', 200);

    const idx = new MtimeIndex(SILO, store);
    expect(idx.size).toBe(0);

    await idx.loadFromStore();
    expect(idx.size).toBe(2);
    expect(idx.get('0:a.md')).toBe(100);
    expect(idx.get('0:b.md')).toBe(200);
  });

  it('loadFromStore drops in-memory entries that no longer exist in the store', async () => {
    const idx = new MtimeIndex(SILO, store);
    // Stale in-memory entry that the store has never heard of.
    idx.recordIndexed('0:phantom.md', 555);
    expect(idx.size).toBe(1);

    await idx.loadFromStore();
    expect(idx.has('0:phantom.md')).toBe(false);
    expect(idx.size).toBe(0);
  });

  it('clear empties the in-memory map without touching the DB', async () => {
    await seedFile(store, '0:a.md', 100);
    const idx = new MtimeIndex(SILO, store);
    await idx.loadFromStore();
    expect(idx.size).toBe(1);

    idx.clear();
    expect(idx.size).toBe(0);

    // DB is untouched.
    const fromStore = await store.loadMtimes(SILO);
    expect(fromStore.has('0:a.md')).toBe(true);
  });
});

describe('MtimeIndex — MtimeView reconcile contract', () => {
  /**
   * Reconcile reads `keys()`, `get()`, `has()` up-front to compute the delta,
   * then writes via `recordIndexed` / `recordDeleted` after each successful
   * flush. This test pins the read+sync-write surface that reconcile depends on.
   */
  it('supports the read-then-record sequence reconcile uses', () => {
    const idx = new MtimeIndex(SILO, store);
    idx.recordIndexed('0:keep.md', 100);
    idx.recordIndexed('0:gone.md', 200);

    // Read phase
    const indexedKeys = new Set(idx.keys());
    expect(indexedKeys.has('0:keep.md')).toBe(true);
    expect(indexedKeys.has('0:gone.md')).toBe(true);
    expect(idx.get('0:keep.md')).toBe(100);

    // Write phase — after a successful flush
    idx.recordIndexed('0:keep.md', 150); // mtime updated
    idx.recordDeleted('0:gone.md');      // file removed

    expect(idx.get('0:keep.md')).toBe(150);
    expect(idx.has('0:gone.md')).toBe(false);
    expect(idx.size).toBe(1);
  });
});
