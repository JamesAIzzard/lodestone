/**
 * Phase 1 regression suite for SiloManager.
 *
 * Pins the *current* behaviour of the manager before any structural
 * refactor lands. Every test here is a load-bearing claim about how the
 * manager behaves today — Phase 2 onward must keep them green.
 *
 * Conventions:
 *   - Tests use the production schema (`createSiloDatabase` + the
 *     operations layer) via `LocalStoreFacade`. No mocks.
 *   - Lifecycle tests use the temp-dir facade so on-disk behaviour
 *     (`peekFileCount`, `readFileSizeFromDisk`, `rebuild()`'s unlink +
 *     re-create) is exercised faithfully.
 *   - The watcher is faked via `FakeSiloWatcher` so we can drive
 *     synthetic events into `handleWatcherEvent` (private) through the
 *     public `on(...)` listener it registers.
 *   - The embedding service is stubbed with deterministic unit vectors
 *     — search-quality is not asserted, only behaviour preservation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ResolvedSiloConfig } from './config';
import { IndexingQueue } from './indexing-queue';
import { SiloManager } from './silo-manager';
import {
  LocalStoreFacade,
  createTempDirStoreFacade,
} from './test-helpers/local-store-facade';
import { FakeSiloWatcher } from './test-helpers/fake-watcher';
import { createStubEmbedding } from './test-helpers/stub-embedding';
import { makeStoredKey } from './store/paths';

// ── Test harness ─────────────────────────────────────────────────────────────

interface TestSilo {
  manager: SiloManager;
  store: LocalStoreFacade;
  watcher: FakeSiloWatcher;
  queue: IndexingQueue;
  workDir: string;
  fileDir: string;
  dbDir: string;
  dbPath: string;
  config: ResolvedSiloConfig;
  cleanup: () => void;
}

interface TestSiloOptions {
  name?: string;
  files?: Record<string, string>; // relative path → contents
  configOverrides?: Partial<ResolvedSiloConfig>;
  /** When true, returns the same store instance and a fresh manager wired to a different config (used for model-mismatch test). */
  reuseStore?: LocalStoreFacade;
  /** Provide a pre-built embedding service (e.g. failing one). */
  embedding?: ReturnType<typeof createStubEmbedding>;
  /** Share an IndexingQueue across silos (used to force queueing during cancellation tests). */
  queue?: IndexingQueue;
}

let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try { fn(); } catch { /* best-effort */ }
  }
});

function makeTestSilo(opts: TestSiloOptions = {}): TestSilo {
  const name = opts.name ?? 'test-silo';
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-regression-'));
  const fileDir = path.join(workDir, 'files');
  const dbDir = path.join(workDir, 'db');
  fs.mkdirSync(fileDir, { recursive: true });
  fs.mkdirSync(dbDir, { recursive: true });

  // Default file content if none provided
  const files = opts.files ?? { 'a.md': '# Hello\n\nWorld\n' };
  for (const [relPath, contents] of Object.entries(files)) {
    const abs = path.join(fileDir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }

  const dbPath = path.join(dbDir, `${name}.db`);

  const config: ResolvedSiloConfig = {
    name,
    directories: [fileDir],
    dbPath,
    extensions: ['.md'],
    ignore: [],
    ignoreFiles: [],
    model: 'stub-model',
    debounce: 1,
    activityLogLimit: 200,
    stopped: false,
    description: '',
    color: 'blue',
    icon: 'database',
    ...opts.configOverrides,
  };

  const store = opts.reuseStore ?? createTempDirStoreFacade();
  const watcher = new FakeSiloWatcher();
  const queue = opts.queue ?? new IndexingQueue();
  const embedding = opts.embedding ?? createStubEmbedding({ dimensions: 4 });

  const manager = new SiloManager(
    config,
    embedding,
    workDir,
    queue,
    store,
    () => watcher,
  );

  const cleanup = () => {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch { /* harmless on Windows if a handle lingers */ }
  };
  cleanups.push(cleanup);

  return { manager, store, watcher, queue, workDir, fileDir, dbDir, dbPath, config, cleanup };
}

/** Wait for the next microtask flush — useful after fire-and-forget ops. */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SiloManager — start lifecycle', () => {
  it('opens the DB, writes meta on first run, runs reconcile, and ends in ready', async () => {
    const t = makeTestSilo();

    await t.manager.start();
    const status = await t.manager.getStatus();

    expect(status.watcherState).toBe('ready');
    expect(t.store.openSiloIds()).toContain('test-silo');

    // Meta was written on first run with the configured model + dimensions.
    const meta = await t.store.loadMeta('test-silo');
    expect(meta).not.toBeNull();
    expect(meta!.model).toBe('stub-model');
    expect(meta!.dimensions).toBe(4);

    // Reconcile indexed the one .md file.
    expect(status.indexedFileCount).toBe(1);
    expect(status.chunkCount).toBeGreaterThan(0);

    // The watcher factory was invoked — the manager registered listeners on it.
    expect(t.watcher.started).toBe(true);
    expect(t.watcher.queueFilledHandler).not.toBeNull();

    await t.manager.stop();
  });

  it('detects model mismatch when meta records a different model than config', async () => {
    // First run: write meta with model A
    const a = makeTestSilo({ configOverrides: { model: 'model-a' } });
    await a.manager.start();
    expect(a.manager.hasModelMismatch()).toBe(false);
    await a.manager.stop();

    // Second run against the same on-disk DB but a different configured model.
    // We reuse the dbPath but build a fresh facade + manager to simulate
    // an app restart with mutated config.
    const freshStore = createTempDirStoreFacade();
    const watcher = new FakeSiloWatcher();
    const config: ResolvedSiloConfig = { ...a.config, model: 'model-b' };
    const manager = new SiloManager(
      config,
      createStubEmbedding({ dimensions: 4 }),
      a.workDir,
      new IndexingQueue(),
      freshStore,
      () => watcher,
    );

    await manager.start();
    expect(manager.hasModelMismatch()).toBe(true);
    const status = await manager.getStatus();
    expect(status.modelMismatch).toBe(true);
    await manager.stop();
  });
});

describe('SiloManager — freeze / wake round-trip', () => {
  it('preserves cached file count, chunk count, and size across freeze and wake', async () => {
    const t = makeTestSilo();
    await t.manager.start();

    const live = await t.manager.getStatus();
    expect(live.indexedFileCount).toBe(1);
    const liveChunks = live.chunkCount;
    const liveSize = live.databaseSizeBytes;
    expect(liveSize).toBeGreaterThan(0);

    await t.manager.freeze();
    const frozen = await t.manager.getStatus();
    expect(frozen.watcherState).toBe('stopped');
    // Cached values come from peekFileCount + on-disk size + getChunkCount-before-close.
    expect(frozen.indexedFileCount).toBe(1);
    expect(frozen.chunkCount).toBe(liveChunks);
    expect(frozen.databaseSizeBytes).toBe(liveSize);

    await t.manager.wake();
    const woken = await t.manager.getStatus();
    expect(woken.watcherState).toBe('ready');
    expect(woken.indexedFileCount).toBe(1);
    expect(woken.chunkCount).toBe(liveChunks);

    await t.manager.stop();
  });
});

describe('SiloManager — rebuild', () => {
  it('produces a fresh empty index after returning, then re-indexes on next start', async () => {
    const t = makeTestSilo();
    await t.manager.start();
    const before = await t.manager.getStatus();
    expect(before.indexedFileCount).toBe(1);
    expect(before.chunkCount).toBeGreaterThan(0);

    await t.manager.rebuild();

    // After rebuild() returns, start() has already run on a fresh DB —
    // index is freshly populated, not empty. The behaviour worth pinning
    // is that meta is fresh (no model mismatch) and the index reflects
    // the *current* config, not stale state.
    const after = await t.manager.getStatus();
    expect(after.watcherState).toBe('ready');
    expect(after.indexedFileCount).toBe(1);
    expect(t.manager.hasModelMismatch()).toBe(false);

    const meta = await t.store.loadMeta('test-silo');
    expect(meta).not.toBeNull();
    expect(meta!.model).toBe('stub-model');

    await t.manager.stop();
  });
});

describe('SiloManager — config update side effects', () => {
  it('updateIgnorePatterns triggers reconcile and ends in ready', async () => {
    const t = makeTestSilo({
      files: { 'keep.md': '# Keep\n', 'drop.md': '# Drop\n' },
    });
    await t.manager.start();
    const before = await t.manager.getStatus();
    expect(before.indexedFileCount).toBe(2);

    // Add an ignore pattern that matches drop.md
    await t.manager.updateIgnorePatterns([], ['drop.md']);

    const after = await t.manager.getStatus();
    expect(after.watcherState).toBe('ready');
    expect(after.indexedFileCount).toBe(1);

    await t.manager.stop();
  });

  it('updateColor and updateIcon persist without triggering reconcile', async () => {
    const t = makeTestSilo();
    await t.manager.start();

    // Reconcile would change indexedFileCount if extensions/ignore were touched.
    // For colour/icon, the value should round-trip and the index stays untouched.
    // NB: the icon name must be one of the validated `SILO_ICON_NAMES` set —
    // an unknown value silently falls back to the default `'database'`.
    await t.manager.updateColor('emerald');
    await t.manager.updateIcon('book-open');

    expect(t.manager.getConfig().color).toBe('emerald');
    expect(t.manager.getConfig().icon).toBe('book-open');

    const after = await t.manager.getStatus();
    expect(after.watcherState).toBe('ready');
    expect(after.indexedFileCount).toBe(1); // unchanged

    await t.manager.stop();
  });
});

describe('SiloManager — getStatus cached vs live paths', () => {
  it('returns cached stats when frozen (stopped state)', async () => {
    const t = makeTestSilo();
    await t.manager.start();
    const live = await t.manager.getStatus();
    await t.manager.freeze();

    const cached = await t.manager.getStatus();
    expect(cached.watcherState).toBe('stopped');
    // Cached path doesn't hit the worker; values are populated from peek + cache.
    expect(cached.indexedFileCount).toBe(live.indexedFileCount);
    expect(cached.chunkCount).toBe(live.chunkCount);
  });

  it('returns live stats during ready state', async () => {
    const t = makeTestSilo();
    await t.manager.start();
    const live = await t.manager.getStatus();
    expect(live.watcherState).toBe('ready');
    expect(live.indexedFileCount).toBe(1);
    expect(live.chunkCount).toBeGreaterThan(0);
    expect(live.databaseSizeBytes).toBeGreaterThan(0);
    await t.manager.stop();
  });
});

describe('SiloManager — watcher events drive mtime + activity', () => {
  /**
   * `setMtime` in operations.ts is `UPDATE files SET mtime_ms = ?
   * WHERE stored_key = ?` — it expects the file row to already exist.
   * In production, an `'indexed'` watcher event fires *after* the
   * indexing pipeline has already created that row via flush. So the
   * realistic precondition is: the file is present from start, gets
   * indexed by reconcile, and a later watcher event updates its mtime.
   */
  it('an indexed event refreshes the mtime and appends to activity feed', async () => {
    const t = makeTestSilo({ files: { 'live.md': '# Live\n' } });
    await t.manager.start();

    const liveAbs = path.join(t.fileDir, 'live.md');
    const storedKey = makeStoredKey(liveAbs, t.config.directories);
    const mtimesBefore = await t.store.loadMtimes('test-silo');
    expect(mtimesBefore.has(storedKey)).toBe(true);
    const originalMtime = mtimesBefore.get(storedKey)!;

    // Touch the file forward so the watcher event would carry a new stat.
    const newMtime = originalMtime + 60_000;
    fs.utimesSync(liveAbs, new Date(newMtime), new Date(newMtime));

    const beforeEvents = t.manager.getActivityFeed().length;
    t.watcher.emitIndexed(liveAbs, 'test-silo');
    await flushMicrotasks();

    // Activity feed grew.
    const feed = t.manager.getActivityFeed();
    expect(feed.length).toBe(beforeEvents + 1);
    expect(feed[feed.length - 1].eventType).toBe('indexed');
    expect(feed[feed.length - 1].filePath).toBe(liveAbs);

    // Mtime was refreshed.
    const mtimesAfter = await t.store.loadMtimes('test-silo');
    expect(mtimesAfter.has(storedKey)).toBe(true);
    expect(mtimesAfter.get(storedKey)).toBeGreaterThan(originalMtime);

    await t.manager.stop();
  });

  it('a deleted event removes the mtime', async () => {
    // Start with a file, index it via reconcile, then emit deleted.
    const t = makeTestSilo({ files: { 'gone.md': '# Gone\n' } });
    await t.manager.start();

    const goneAbs = path.join(t.fileDir, 'gone.md');
    const storedKey = makeStoredKey(goneAbs, t.config.directories);
    expect((await t.store.loadMtimes('test-silo')).has(storedKey)).toBe(true);

    t.watcher.emitDeleted(goneAbs, 'test-silo');
    await flushMicrotasks();

    const mtimes = await t.store.loadMtimes('test-silo');
    expect(mtimes.has(storedKey)).toBe(false);

    const feed = t.manager.getActivityFeed();
    expect(feed[feed.length - 1].eventType).toBe('deleted');

    await t.manager.stop();
  });
});

describe('SiloManager — updateName rename behaviour (regression baseline)', () => {
  /**
   * BASELINE PIN — DO NOT CHANGE WITHOUT FILING A FOLLOW-UP.
   *
   * Today, `siloId === config.name` recomputed on every access
   * (silo-manager.ts:136). `updateName()` mutates `config.name` and
   * then calls `persistConfigBlob()` which sends `saveConfigBlob` against
   * the *new* slug — but the store has the silo open under the *old*
   * slug. The store throws "Silo \"<newSlug>\" is not open" because
   * the worker (and our LocalStoreFacade, which mirrors it) keys silos
   * by slug.
   *
   * This test pins exactly that: `updateName` rejects with the
   * "is not open" error. Whether that's the *desired* behaviour is a
   * separate question — see docs/silo-manager-refactor-plan.md
   * "Identity constraint" in Phase 3 and the out-of-scope list. If the
   * production behaviour is fixed, update this test as part of that
   * fix's PR.
   */
  it('throws "is not open" because the store still has the old slug open', async () => {
    const t = makeTestSilo({ name: 'old-slug' });
    await t.manager.start();
    expect(t.store.openSiloIds()).toContain('old-slug');

    await expect(t.manager.updateName('new-slug')).rejects.toThrow(/is not open/);

    // The old-slug entry is still there; new-slug was never opened.
    expect(t.store.openSiloIds()).toContain('old-slug');
    expect(t.store.openSiloIds()).not.toContain('new-slug');

    // Restore identity for clean shutdown — the manager has config.name = 'new-slug'
    // but the store has 'old-slug' open. stop() will try to close 'new-slug',
    // which is a no-op in the facade. Then we close 'old-slug' directly.
    await t.manager.stop();
    await t.store.close('old-slug');
  });
});

/**
 * Phase 6 — cancellation pins for the named-phase doStart.
 *
 * `doStart` has two explicit `if (stopRequested) return;` short-circuits
 * (between loadInitialState and runStartupReconcile, and between
 * configStore.persist and transition('ready')) plus one inside
 * runStartupReconcile's queue closure (top of the task body, before
 * reconcile is invoked). Each of these pre-existed in the pre-Phase-6
 * code path; Phase 6 just renamed the surrounding sequence and exposed
 * them. These tests pin that every short-circuit cleanly aborts the
 * remaining startup steps — no watcher started, no reconcile-driven
 * activity events, DB closed by stop().
 */
describe('SiloManager — start cancellation honoured at each yield point (Phase 6)', () => {
  it('stop() called immediately bails before runStartupReconcile is entered', async () => {
    const t = makeTestSilo();

    // start() schedules doStart; stop() is invoked synchronously before
    // any of doStart's awaits resolve. By the time doStart's microtasks
    // run, stopRequested is already true. doStart progresses through the
    // four prelude phases (initEmbedding/openDatabase/checkAndPersistMeta/
    // loadInitialState — all cheap against the local facade) and then
    // hits the explicit short-circuit after loadInitialState, returning
    // without ever entering runStartupReconcile.
    const startP = t.manager.start();
    const stopP = t.manager.stop();
    await Promise.all([startP.catch(() => {}), stopP]);

    // runStartupReconcile was not entered — no reconcile-driven events
    // landed in the activity feed.
    expect(t.manager.getActivityFeed().length).toBe(0);
    // The watcher start (step 8) sits past the second short-circuit; it
    // was not reached.
    expect(t.watcher.started).toBe(false);
    // openDatabase did run before the short-circuit; stop() then closed it.
    expect(t.store.openSiloIds()).not.toContain('test-silo');
  });

  it('stop() while runStartupReconcile is queued bails inside the task closure', async () => {
    // Saturate the IndexingQueue with a hung task so our manager's
    // startup-reconcile slot enqueues but cannot run. While it sits in
    // the queue, request stop. When the queue eventually admits our
    // task, the closure's first line (`if (stopRequested) { resolve(); return; }`)
    // fires — reconcile never runs. doStart then proceeds through
    // configStore.persist, hits YP5, and returns.
    const sharedQueue = new IndexingQueue();
    let releaseBusy!: () => void;
    let busyAdmitted!: () => void;
    const busyAdmittedP = new Promise<void>((r) => { busyAdmitted = r; });
    sharedQueue.enqueue(
      'busy',
      () => { /* onWaiting */ },
      () => busyAdmitted(),
      () => new Promise<void>((r) => { releaseBusy = r; }),
    );
    await busyAdmittedP;

    const t = makeTestSilo({ queue: sharedQueue });
    const startP = t.manager.start();

    // Wait for our manager's startup-reconcile slot to be queued —
    // observable via the lifecycle's 'waiting' transition (fired by the
    // queue's onWaiting callback when our task is admitted but blocked
    // behind the busy task).
    while (t.manager.currentState !== 'waiting') {
      await new Promise((r) => setImmediate(r));
    }

    // Stop sets stopRequested and awaits startPromise.
    const stopP = t.manager.stop();

    // Release the busy task. The queue admits ours next; the closure
    // sees stopRequested=true and bails before reconcile.
    releaseBusy();
    await Promise.all([startP.catch(() => {}), stopP]);

    // Reconcile did not run — activity feed empty.
    expect(t.manager.getActivityFeed().length).toBe(0);
    // YP5 fired after the closure resolved — watcher never started.
    expect(t.watcher.started).toBe(false);
  });

  it('stop() while configStore.persist is in flight bails before transition(\'ready\')', async () => {
    const t = makeTestSilo();

    // Gate saveConfigBlob so configStore.persist hangs at the moment it
    // executes inside doStart. Reconcile completes first (the queue task
    // resolves cleanly), then doStart awaits persist — which now hangs.
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((r) => { releaseSave = r; });
    let persistEntered!: () => void;
    const persistEnteredP = new Promise<void>((r) => { persistEntered = r; });
    const originalSave = t.store.saveConfigBlob.bind(t.store);
    t.store.saveConfigBlob = async (siloId, blob) => {
      persistEntered();
      await saveGate;
      return originalSave(siloId, blob);
    };

    const startP = t.manager.start();
    // Wait until persist actually begins — guarantees reconcile is done.
    await persistEnteredP;

    // Stop now. stopRequested is set; stop() awaits startPromise.
    const stopP = t.manager.stop();

    // Release persist. doStart resumes, hits YP5 (stopRequested=true),
    // returns without transitioning to 'ready' or starting the watcher.
    releaseSave();
    await Promise.all([startP.catch(() => {}), stopP]);

    // Reconcile DID run before the bail — the activity feed has at least
    // one reconcile-driven event for the indexed file.
    expect(t.manager.getActivityFeed().length).toBeGreaterThan(0);
    // YP5 fired — watcher never started.
    expect(t.watcher.started).toBe(false);
  });
});
