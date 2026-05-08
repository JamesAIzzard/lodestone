/**
 * Unit tests for SiloConfigStore.
 *
 * Persistence is verified by spying on the `saveConfigBlob` call rather
 * than reading the meta table back through the facade — `StoreFacade`
 * intentionally doesn't expose a config-blob read method (the worker
 * loads config blobs through a separate path that isn't part of the
 * facade surface).
 */

import { describe, it, expect } from 'vitest';
import type { ResolvedSiloConfig } from '../config';
import type { StoreFacade } from '../store-facade';
import type { StoredSiloConfig } from '../store/types';
import { SiloConfigStore } from './silo-config-store';

// ── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ResolvedSiloConfig = {
  name: 'test-silo',
  indexedDirectories: ['/tmp/files'],
  indexDbPath: '/tmp/db/test.db',
  indexedFileExtensions: ['.md'],
  ignoredFolderPatterns: [],
  ignoredFilePatterns: [],
  embeddingModelKey: 'stub-model',
  fileChangeDelaySeconds: 1,
  maxActivityLogEntries: 200,
  isStopped: false,
  contentDescription: '',
  accentColor: 'blue',
  iconName: 'database',
};

interface SaveCall {
  siloId: string;
  blob: StoredSiloConfig;
}

interface SpyStore {
  facade: StoreFacade;
  saved: SaveCall[];
  /** Set to a function to fail saveConfigBlob with a custom rejection. */
  fail?: (siloId: string) => Error | undefined;
}

/**
 * Build a minimal `StoreFacade` whose only meaningful method is
 * `saveConfigBlob` — the rest throw if called, since `SiloConfigStore`
 * never invokes them. Captures every `saveConfigBlob` invocation so
 * tests can assert on the persisted blob shape.
 */
function makeSpyStore(): SpyStore {
  const saved: SaveCall[] = [];
  const facade: Partial<StoreFacade> = {
    saveConfigBlob: async (siloId: string, blob: StoredSiloConfig) => {
      const fail = state.fail?.(siloId);
      if (fail) throw fail;
      saved.push({ siloId, blob });
    },
  };
  const handler: ProxyHandler<Partial<StoreFacade>> = {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (value === undefined) {
        return () => {
          throw new Error(
            `[SpyStore] StoreFacade.${String(prop)} was called but the spy does not implement it.`,
          );
        };
      }
      return value;
    },
  };
  const state: SpyStore = {
    facade: new Proxy(facade, handler) as StoreFacade,
    saved,
  };
  return state;
}

function makeStore(
  config: ResolvedSiloConfig = DEFAULT_CONFIG,
  canPersist = true,
): { store: SiloConfigStore; spy: SpyStore } {
  const spy = makeSpyStore();
  const store = new SiloConfigStore(config, spy.facade, () => canPersist);
  return { store, spy };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SiloConfigStore — reader surface', () => {
  it('current returns the construction-time config', () => {
    const { store } = makeStore();
    expect(store.current).toEqual(DEFAULT_CONFIG);
  });

  it('siloId matches current.name', () => {
    const { store } = makeStore();
    expect(store.siloId).toBe('test-silo');
  });

  it('current is the live snapshot — references update after apply', () => {
    const { store } = makeStore();
    expect(store.current.contentDescription).toBe('');
    store.apply({ contentDescription: 'updated' });
    expect(store.current.contentDescription).toBe('updated');
  });
});

describe('SiloConfigStore — apply (in-memory mutation)', () => {
  it('apply({ name }) updates current.name and siloId together', () => {
    const { store } = makeStore();
    store.apply({ name: 'renamed' });
    expect(store.current.name).toBe('renamed');
    expect(store.siloId).toBe('renamed');
  });

  it('apply({ description }) updates only description', () => {
    const { store } = makeStore();
    store.apply({ contentDescription: 'a description' });
    expect(store.current.contentDescription).toBe('a description');
    expect(store.current.name).toBe(DEFAULT_CONFIG.name);
    expect(store.current.accentColor).toBe(DEFAULT_CONFIG.accentColor);
  });

  it('apply({ model }) updates the model verbatim — no validation', () => {
    const { store } = makeStore();
    store.apply({ embeddingModelKey: 'new-model' });
    expect(store.current.embeddingModelKey).toBe('new-model');
  });

  it('apply({ color }) accepts a valid palette colour', () => {
    const { store } = makeStore();
    store.apply({ accentColor: 'emerald' });
    expect(store.current.accentColor).toBe('emerald');
  });

  it('apply({ color }) silently falls back to the default for invalid values', () => {
    // Pre-refactor behaviour — `validateSiloColor` returns the default ('blue')
    // for unknown colours rather than throwing. Pinned to keep silo update
    // semantics identical to before the extraction.
    const { store } = makeStore();
    store.apply({ accentColor: 'puce-pomegranate' });
    expect(store.current.accentColor).toBe('blue');
  });

  it('apply({ icon }) accepts a valid icon name', () => {
    const { store } = makeStore();
    store.apply({ iconName: 'book-open' });
    expect(store.current.iconName).toBe('book-open');
  });

  it('apply({ icon }) silently falls back to the default for invalid values', () => {
    // Same silent-fallback contract as colour. The Phase 1 regression suite
    // captured a real surprise here — the pre-refactor test originally tried
    // 'book' and got 'database' back, which prompted the icon-name correction.
    const { store } = makeStore();
    store.apply({ iconName: 'book' }); // not in SILO_ICON_NAMES — 'book-open' is
    expect(store.current.iconName).toBe('database');
  });

  it('apply({ ignore, ignoreFiles }) updates both at once', () => {
    const { store } = makeStore();
    store.apply({ ignoredFolderPatterns: ['*.tmp'], ignoredFilePatterns: ['drop.md'] });
    expect(store.current.ignoredFolderPatterns).toEqual(['*.tmp']);
    expect(store.current.ignoredFilePatterns).toEqual(['drop.md']);
  });

  it('apply({ extensions }) updates extensions', () => {
    const { store } = makeStore();
    store.apply({ indexedFileExtensions: ['.md', '.txt'] });
    expect(store.current.indexedFileExtensions).toEqual(['.md', '.txt']);
  });

  it('apply with multiple fields applies all of them in one mutation', () => {
    const { store } = makeStore();
    store.apply({ contentDescription: 'multi', accentColor: 'rose', indexedFileExtensions: ['.md', '.org'] });
    expect(store.current.contentDescription).toBe('multi');
    expect(store.current.accentColor).toBe('rose');
    expect(store.current.indexedFileExtensions).toEqual(['.md', '.org']);
  });

  it('apply does not auto-persist — store.saveConfigBlob is never called', () => {
    const { store, spy } = makeStore();
    store.apply({ contentDescription: 'changed' });
    store.apply({ accentColor: 'amber' });
    expect(spy.saved).toEqual([]);
  });

  it('apply preserves untouched fields verbatim', () => {
    // The pre-refactor pattern was `{ ...this.config, X: value }` — a shallow
    // spread that preserves every other field. This pins that contract.
    const { store } = makeStore();
    const before = store.current;
    store.apply({ contentDescription: 'changed' });
    const after = store.current;

    expect(after.indexedDirectories).toBe(before.indexedDirectories);
    expect(after.indexDbPath).toBe(before.indexDbPath);
    expect(after.indexedFileExtensions).toBe(before.indexedFileExtensions);
    expect(after.ignoredFolderPatterns).toBe(before.ignoredFolderPatterns);
    expect(after.maxActivityLogEntries).toBe(before.maxActivityLogEntries);
  });
});

describe('SiloConfigStore — persist', () => {
  it('writes a StoredSiloConfig blob mirroring the current ResolvedSiloConfig', async () => {
    const { store, spy } = makeStore();
    store.apply({ contentDescription: 'persisted', accentColor: 'emerald', iconName: 'book-open' });
    await store.persist();

    expect(spy.saved.length).toBe(1);
    const { siloId, blob } = spy.saved[0];
    expect(siloId).toBe('test-silo');
    expect(blob).toEqual({
      name: 'test-silo',
      contentDescription: 'persisted',
      indexedDirectories: DEFAULT_CONFIG.indexedDirectories,
      indexedFileExtensions: DEFAULT_CONFIG.indexedFileExtensions,
      ignoredFolderPatterns: DEFAULT_CONFIG.ignoredFolderPatterns,
      ignoredFilePatterns: DEFAULT_CONFIG.ignoredFilePatterns,
      embeddingModelKey: DEFAULT_CONFIG.embeddingModelKey,
      accentColor: 'emerald',
      iconName: 'book-open',
    });
  });

  it('writes description as undefined when the current value is empty string', async () => {
    // Pre-refactor behaviour: `contentDescription: this.config.contentDescription || undefined`.
    // Storing the empty string would round-trip through JSON differently from
    // unset, so the original code coerced empties to undefined. Pinned.
    const { store, spy } = makeStore();
    await store.persist();
    expect(spy.saved.length).toBe(1);
    expect(spy.saved[0].blob.contentDescription).toBeUndefined();
  });

  it('is a no-op when canPersist() returns false', async () => {
    const { store, spy } = makeStore(DEFAULT_CONFIG, /* canPersist */ false);
    await store.persist();
    expect(spy.saved).toEqual([]);
  });

  it('persists against the current name after apply({ name }) — pins rename baseline', async () => {
    // The store-worker keys silos by string id. The pre-refactor
    // `persistConfigBlob` sent `saveConfigBlob(this.siloId, blob)` where
    // `this.siloId` returned the *current* `config.name`. After
    // `apply({ name: 'new' })`, persist must call `saveConfigBlob('new', ...)`
    // — even though the worker likely has the silo open under the old name.
    // That mismatch is exactly what the manager's rename regression test
    // pins; SiloConfigStore must preserve the cause of it.
    const { store, spy } = makeStore();
    store.apply({ name: 'new-slug' });
    await store.persist();
    expect(spy.saved.length).toBe(1);
    expect(spy.saved[0].siloId).toBe('new-slug');
    expect(spy.saved[0].blob.name).toBe('new-slug');
  });

  it('propagates store rejections to the caller', async () => {
    const { store, spy } = makeStore();
    spy.fail = () => new Error('disk full');
    await expect(store.persist()).rejects.toThrow('disk full');
  });
});
