/**
 * Unit tests for WatcherCoordinator.
 *
 * The coordinator is wired against real collaborators (MtimeIndex, ActivityLog,
 * SiloLifecycle, IndexingQueue) backed by an in-memory StoreFacade, plus a
 * FakeSiloWatcher whose `runQueueImpl` tests can replace to drive timing.
 *
 * Coverage groups:
 *   1. start() / disposeWatcher() lifecycle
 *   2. handleEvent (mtime + activity side effects)
 *   3. scheduleIndexing dedup + cancelPending
 *   4. awaitInFlight + lifecycle transitions around a queue slot
 *   5. onProgress + onIdle callback fan-out
 *   6. stopRequested suppression
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ResolvedSiloConfig } from '../config';
import { LocalStoreFacade, createInMemoryStoreFacade } from '../test-helpers/local-store-facade';
import { FakeSiloWatcher } from '../test-helpers/fake-watcher';
import { createStubEmbedding } from '../test-helpers/stub-embedding';
import { IndexingQueue } from '../indexing-queue';
import { MtimeIndex } from './mtime-index';
import { ActivityLog } from './activity-log';
import { SiloLifecycle } from './silo-lifecycle';
import {
  WatcherCoordinator,
  type ReconcileProgressSnapshot,
  type WatcherCoordinatorDeps,
} from './watcher-coordinator';
import type { FlushUpsert } from '../store/types';
import type { ChunkRecord } from '../pipeline-types';
import type { IndexLoopProgress } from '../pipeline';
import { makeStoredKey } from '../store/paths';

// ── Helpers ──────────────────────────────────────────────────────────────────

const SILO = 'watcher-coord-test';
const DIMS = 4;
const CAP = 50;

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

/** Pre-seed a file row in the store so subsequent `setMtime` UPDATEs land. */
async function seedFile(
  store: LocalStoreFacade,
  storedKey: string,
  mtimeMs: number,
): Promise<void> {
  const upsert: FlushUpsert = {
    storedKey,
    chunks: [makeChunk(storedKey, 0, 'seed')],
    embeddings: [[1, 0, 0, 0]],
    mtimeMs,
  };
  await store.flush(SILO, [upsert], []);
}

const flushMicrotasks = () => new Promise<void>((r) => setImmediate(r));

interface Harness {
  coord: WatcherCoordinator;
  watcher: FakeSiloWatcher;
  lifecycle: SiloLifecycle;
  mtimes: MtimeIndex;
  activity: ActivityLog;
  queue: IndexingQueue;
  store: LocalStoreFacade;
  config: ResolvedSiloConfig;
  workDir: string;
  fileDir: string;
  progressCalls: Array<ReconcileProgressSnapshot | undefined>;
  idleCount: number;
  /** Forces `getEmbedding()` to return null — for the no-embedding test. */
  withoutEmbedding(): void;
}

let harnesses: Harness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    try {
      await h.store.close(SILO);
    } catch {
      /* may already be closed */
    }
    try {
      fs.rmSync(h.workDir, { recursive: true, force: true });
    } catch {
      /* harmless on Windows if a handle lingers */
    }
  }
});

async function makeHarness(
  opts: { configOverrides?: Partial<ResolvedSiloConfig> } = {},
): Promise<Harness> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-coord-'));
  const fileDir = path.join(workDir, 'files');
  fs.mkdirSync(fileDir, { recursive: true });

  const store = createInMemoryStoreFacade();
  await store.open(SILO, ':ignored:', DIMS);

  const config: ResolvedSiloConfig = {
    name: SILO,
    indexedDirectories: [fileDir],
    indexDbPath: path.join(workDir, 'db.sqlite'),
    indexedFileExtensions: ['.md'],
    ignoredFolderPatterns: [],
    ignoredFilePatterns: [],
    embeddingModelKey: 'stub-model',
    fileChangeDelaySeconds: 1,
    maxActivityLogEntries: 100,
    isStopped: false,
    contentDescription: '',
    accentColor: 'blue',
    iconName: 'database',
    ...opts.configOverrides,
  };

  const lifecycle = new SiloLifecycle();
  const mtimes = new MtimeIndex(SILO, store);
  const activity = new ActivityLog(
    SILO,
    store,
    () => config.name,
    CAP,
    () => 100,
  );
  const queue = new IndexingQueue();
  const watcher = new FakeSiloWatcher();
  const embedding = createStubEmbedding({ dimensions: DIMS });

  const progressCalls: Array<ReconcileProgressSnapshot | undefined> = [];
  let idleCount = 0;
  let embeddingHandle: typeof embedding | null = embedding;

  const deps: WatcherCoordinatorDeps = {
    lifecycle,
    mtimes,
    activity,
    indexingQueue: queue,
    watcherFactory: () => watcher,
    getConfig: () => config,
    getEmbedding: () => embeddingHandle,
    makeStoreOps: () => ({
      flush: (upserts, deletes) => store.flush(SILO, upserts, deletes),
      insertDirEntry: (dirPath) => store.insertDirEntry(SILO, dirPath),
      deleteDirEntry: (dirPath) => store.deleteDirEntry(SILO, dirPath),
    }),
    onProgress: (snapshot) => {
      progressCalls.push(snapshot);
    },
    onIdle: () => {
      idleCount += 1;
    },
  };

  const coord = new WatcherCoordinator(deps);

  // Mirror production preconditions: doStart's step 7 transitions the
  // lifecycle to 'ready' before `watcherCoord.start()` runs. Tests that
  // exercise scheduleIndexing assume that starting state. The FSM has no
  // direct created → ready edge, so we route via 'indexing' (the path doStart
  // actually takes through the IndexingQueue's onStart callback).
  lifecycle.transition('indexing');
  lifecycle.transition('ready');

  const h: Harness = {
    coord,
    watcher,
    lifecycle,
    mtimes,
    activity,
    queue,
    store,
    config,
    workDir,
    fileDir,
    progressCalls,
    get idleCount() {
      return idleCount;
    },
    withoutEmbedding() {
      embeddingHandle = null;
    },
  };
  harnesses.push(h);
  return h;
}

// ── Group 1: start() and disposeWatcher() ────────────────────────────────────

describe('WatcherCoordinator — start / disposeWatcher', () => {
  it('start() is a no-op when no embedding service is available', async () => {
    const h = await makeHarness();
    h.withoutEmbedding();
    h.coord.start();
    expect(h.coord.isStarted).toBe(false);
    expect(h.watcher.started).toBe(false);
    expect(h.watcher.queueFilledHandler).toBeNull();
  });

  it('start() creates the watcher, wires handlers, and starts it', async () => {
    const h = await makeHarness();
    h.coord.start();
    expect(h.coord.isStarted).toBe(true);
    expect(h.watcher.started).toBe(true);
    expect(h.watcher.queueFilledHandler).not.toBeNull();
  });

  it('start() is idempotent — second call is a no-op', async () => {
    const h = await makeHarness();
    h.coord.start();
    h.coord.start();
    // FakeSiloWatcher's `started` flag stays true; no second factory invocation.
    expect(h.coord.isStarted).toBe(true);
    expect(h.watcher.started).toBe(true);
  });

  it('disposeWatcher() stops the watcher and clears it; idempotent', async () => {
    const h = await makeHarness();
    h.coord.start();
    expect(h.coord.isStarted).toBe(true);

    await h.coord.disposeWatcher();
    expect(h.coord.isStarted).toBe(false);
    expect(h.watcher.stopped).toBe(true);

    // Idempotent — calling again does not throw.
    await h.coord.disposeWatcher();
    expect(h.coord.isStarted).toBe(false);
  });
});

// ── Group 2: handleEvent ─────────────────────────────────────────────────────

describe('WatcherCoordinator — handleEvent', () => {
  it('an `indexed` event refreshes the mtime and appends to activity', async () => {
    const h = await makeHarness();
    h.coord.start();

    const filePath = path.join(h.fileDir, 'live.md');
    fs.writeFileSync(filePath, '# Live\n');
    const storedKey = makeStoredKey(filePath, h.config.indexedDirectories);

    // Pre-seed file row + stat to a known mtime so the UPDATE lands.
    const initialMtime = Date.now() - 60_000;
    await seedFile(h.store, storedKey, initialMtime);
    fs.utimesSync(filePath, new Date(initialMtime + 30_000), new Date(initialMtime + 30_000));

    h.watcher.emitIndexed(filePath, SILO);
    await flushMicrotasks();

    const mtimes = await h.store.loadMtimes(SILO);
    expect(mtimes.has(storedKey)).toBe(true);
    expect(mtimes.get(storedKey)).toBeGreaterThan(initialMtime);

    const recent = h.activity.recent(10);
    expect(recent.length).toBe(1);
    expect(recent[0].eventType).toBe('indexed');
    expect(recent[0].filePath).toBe(filePath);
  });

  it('a `deleted` event removes the mtime and appends to activity', async () => {
    const h = await makeHarness();
    h.coord.start();

    const filePath = path.join(h.fileDir, 'gone.md');
    const storedKey = makeStoredKey(filePath, h.config.indexedDirectories);
    await seedFile(h.store, storedKey, Date.now());
    expect((await h.store.loadMtimes(SILO)).has(storedKey)).toBe(true);

    h.watcher.emitDeleted(filePath, SILO);
    await flushMicrotasks();

    const mtimes = await h.store.loadMtimes(SILO);
    expect(mtimes.has(storedKey)).toBe(false);

    const recent = h.activity.recent(10);
    expect(recent.length).toBe(1);
    expect(recent[0].eventType).toBe('deleted');
  });

  it('an `indexed` event for a vanished file is harmless — still appends activity', async () => {
    const h = await makeHarness();
    h.coord.start();

    const phantomPath = path.join(h.fileDir, 'phantom.md');
    // Don't create the file. statSync inside handleEvent will throw.
    expect(() => h.watcher.emitIndexed(phantomPath, SILO)).not.toThrow();
    await flushMicrotasks();

    const recent = h.activity.recent(10);
    expect(recent.length).toBe(1);
    expect(recent[0].eventType).toBe('indexed');
  });

  it('an `error` event goes to activity only — does not touch mtimes', async () => {
    const h = await makeHarness();
    h.coord.start();

    const filePath = path.join(h.fileDir, 'broken.md');
    const storedKey = makeStoredKey(filePath, h.config.indexedDirectories);
    const seedMtime = Date.now();
    await seedFile(h.store, storedKey, seedMtime);

    h.watcher.emit({
      timestamp: new Date(),
      siloName: SILO,
      filePath,
      eventType: 'error',
      errorMessage: 'parse failed',
    });
    await flushMicrotasks();

    // Mtime untouched.
    const mtimes = await h.store.loadMtimes(SILO);
    expect(mtimes.get(storedKey)).toBe(seedMtime);
    // Activity recorded.
    const recent = h.activity.recent(10);
    expect(recent.length).toBe(1);
    expect(recent[0].eventType).toBe('error');
    expect(recent[0].errorMessage).toBe('parse failed');
  });
});

// ── Group 3: scheduleIndexing dedup + cancelPending ──────────────────────────

describe('WatcherCoordinator — scheduleIndexing dedup + cancelPending', () => {
  it('rapid queue-filled callbacks produce a single queue slot', async () => {
    const h = await makeHarness();
    h.coord.start();

    // Hold the runQueue open so the slot stays in-flight while we trigger
    // additional queue-filled callbacks.
    let resolveRun!: () => void;
    const runHeld = new Promise<void>((r) => {
      resolveRun = r;
    });
    h.watcher.runQueueImpl = async () => runHeld;

    // Burst: three rapid callbacks.
    h.watcher.queueFilledHandler!();
    h.watcher.queueFilledHandler!();
    h.watcher.queueFilledHandler!();
    expect(h.coord.hasPending).toBe(true);

    // Let microtasks settle so the queue's `then` runs onStart and starts the task.
    await flushMicrotasks();
    await flushMicrotasks();
    expect(h.lifecycle.phase()).toBe('indexing');

    // Resolve the run, then await — exactly one runQueue invocation should occur
    // for the burst.
    resolveRun();
    await h.coord.awaitInFlight();

    // After the run, hasPending is cleared and the lifecycle returned to ready.
    expect(h.coord.hasPending).toBe(false);
    expect(h.lifecycle.phase()).toBe('ready');
  });

  it('cancelPending() frees the queue slot before it runs', async () => {
    const h = await makeHarness();
    h.coord.start();
    const runImpl = vi.fn(async () => undefined);
    h.watcher.runQueueImpl = runImpl;

    h.watcher.queueFilledHandler!();
    expect(h.coord.hasPending).toBe(true);

    // Cancel before the queue's `then` runs the task.
    h.coord.cancelPending();
    expect(h.coord.hasPending).toBe(false);

    // Let the queue resolve — the cancelled task should not invoke runQueue.
    await flushMicrotasks();
    await flushMicrotasks();
    expect(runImpl).not.toHaveBeenCalled();
    // Lifecycle stays at its initial 'ready' (no transition fired).
    expect(h.lifecycle.phase()).toBe('ready');
  });

  it('after cancelPending(), a new queue-filled callback schedules a fresh slot', async () => {
    const h = await makeHarness();
    h.coord.start();
    const runImpl = vi.fn(async () => undefined);
    h.watcher.runQueueImpl = runImpl;

    h.watcher.queueFilledHandler!();
    h.coord.cancelPending();
    expect(h.coord.hasPending).toBe(false);

    h.watcher.queueFilledHandler!();
    expect(h.coord.hasPending).toBe(true);
    await h.coord.awaitInFlight();
    expect(runImpl).toHaveBeenCalledTimes(1);
  });
});

// ── Group 4: awaitInFlight + lifecycle transitions ───────────────────────────

describe('WatcherCoordinator — awaitInFlight + lifecycle', () => {
  it('awaitInFlight() resolves immediately when no slot is pending', async () => {
    const h = await makeHarness();
    h.coord.start();
    // No schedule fired — must return without blocking.
    await h.coord.awaitInFlight();
  });

  it('awaitInFlight() blocks until in-flight runQueue resolves', async () => {
    const h = await makeHarness();
    h.coord.start();

    let resolveRun!: () => void;
    h.watcher.runQueueImpl = async () => {
      await new Promise<void>((r) => {
        resolveRun = r;
      });
    };

    h.watcher.queueFilledHandler!();
    await flushMicrotasks();

    let resolved = false;
    const drainPromise = h.coord.awaitInFlight().then(() => {
      resolved = true;
    });

    // Without resolving the run, awaitInFlight must not have resolved.
    await flushMicrotasks();
    expect(resolved).toBe(false);

    resolveRun();
    await drainPromise;
    expect(resolved).toBe(true);
  });

  it('a successful run transitions the lifecycle indexing → ready and fires onIdle', async () => {
    const h = await makeHarness();
    h.coord.start();
    h.watcher.runQueueImpl = async () => undefined;

    expect(h.lifecycle.phase()).toBe('ready');
    h.watcher.queueFilledHandler!();
    await h.coord.awaitInFlight();

    expect(h.lifecycle.phase()).toBe('ready');
    expect(h.idleCount).toBe(1);
  });

  it('runQueue throwing does not propagate; lifecycle still returns to ready', async () => {
    const h = await makeHarness();
    h.coord.start();
    h.watcher.runQueueImpl = async () => {
      throw new Error('boom');
    };

    h.watcher.queueFilledHandler!();
    // No throw bubbles out.
    await expect(h.coord.awaitInFlight()).resolves.toBeUndefined();
    expect(h.lifecycle.phase()).toBe('ready');
    expect(h.idleCount).toBe(1);
  });

  it('does NOT transition to ready when watcher.queueLength > 0 after run', async () => {
    const h = await makeHarness();
    h.coord.start();
    // Simulate runQueue draining one batch but leaving items behind. The
    // coordinator's "set ready only if truly idle" branch keeps lifecycle
    // off ready so the next scheduleIndexing pass can take over.
    h.watcher.runQueueImpl = async () => undefined;
    h.watcher.queueLength = 5;

    h.watcher.queueFilledHandler!();
    await h.coord.awaitInFlight();
    // Still in 'indexing' (or whatever onStart left it at) since queueLength > 0.
    expect(h.lifecycle.phase()).toBe('indexing');
    expect(h.idleCount).toBe(0);
  });

  it('fires onWaiting only when another silo holds the queue lock', async () => {
    const h = await makeHarness();
    h.coord.start();

    // Hold the queue with a manually-enqueued task for a different silo.
    let releaseHolder!: () => void;
    const holderTask = new Promise<void>((r) => {
      releaseHolder = r;
    });
    h.queue.enqueue(
      'other-silo',
      () => undefined,
      () => undefined,
      () => holderTask,
    );

    h.watcher.runQueueImpl = async () => undefined;
    h.watcher.queueFilledHandler!();
    // Microtask flush: onWaiting fires inside enqueue if the queue was busy,
    // because hasQueuedWork was true at the moment we called.
    await flushMicrotasks();
    expect(h.lifecycle.phase()).toBe('waiting');

    releaseHolder();
    await h.coord.awaitInFlight();
    expect(h.lifecycle.phase()).toBe('ready');
  });
});

// ── Group 5: onProgress callback fan-out ─────────────────────────────────────

describe('WatcherCoordinator — onProgress', () => {
  it('forwards runQueue progress snapshots, then clears with undefined when done', async () => {
    const h = await makeHarness();
    h.coord.start();

    const sample: IndexLoopProgress = {
      current: 1,
      total: 3,
      filePath: '/tmp/x.md',
      fileSize: 42,
      fileStage: 'embedding',
      batchChunks: 2,
      batchChunkLimit: 8,
      embedDone: 1,
      embedTotal: 3,
    };

    h.watcher.runQueueImpl = async (onProgress) => {
      onProgress?.(sample);
    };
    h.watcher.queueFilledHandler!();
    await h.coord.awaitInFlight();

    // First call: snapshot derived from the IndexLoopProgress.
    expect(h.progressCalls.length).toBe(2);
    expect(h.progressCalls[0]).toMatchObject({
      current: 1,
      total: 3,
      filePath: '/tmp/x.md',
      fileSize: 42,
      fileStage: 'embedding',
      batchChunks: 2,
      batchChunkLimit: 8,
      embedDone: 1,
      embedTotal: 3,
    });
    // Final call: undefined to clear.
    expect(h.progressCalls[1]).toBeUndefined();
  });
});

// ── Group 6: stopRequested suppression ───────────────────────────────────────

describe('WatcherCoordinator — stopRequested suppression', () => {
  it('does not transition to indexing or run runQueue when stop has been requested', async () => {
    const h = await makeHarness();
    h.coord.start();
    const runImpl = vi.fn(async () => undefined);
    h.watcher.runQueueImpl = runImpl;

    h.watcher.queueFilledHandler!();
    h.lifecycle.requestStop();

    await h.coord.awaitInFlight();
    expect(runImpl).not.toHaveBeenCalled();
    // The slot ran but the body was skipped — onIdle did not fire (the ready
    // transition is gated on `!stopRequested`).
    expect(h.idleCount).toBe(0);
  });
});
