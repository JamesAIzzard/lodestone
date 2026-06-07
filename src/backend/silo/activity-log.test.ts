/**
 * Unit tests for ActivityLog.
 *
 * Uses the in-memory StoreFacade — the activity-log table behaves the
 * same on disk and in memory, and these tests don't care about on-disk
 * size or close/reopen cycles.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  LocalStoreFacade,
  createInMemoryStoreFacade,
} from '../test-helpers/local-store-facade';
import { ActivityLog } from './activity-log';
import type { WatcherEvent } from '../watcher';
import type { StoreFacade } from '../store-facade';

const SILO = 'activity-test';
const SILO_NAME = 'activity-test';
const DIMS = 4;
const CAP = 5;
const LOG_LIMIT = 100;

function makeEvent(filePath: string, ms = 1000): WatcherEvent {
  return {
    timestamp: new Date(ms),
    siloName: SILO_NAME,
    filePath,
    eventType: 'indexed',
  };
}

/** Wait one microtask turn so fire-and-forget DB writes settle. */
const flushMicrotasks = () => Promise.resolve();

let store: LocalStoreFacade;

beforeEach(async () => {
  store = createInMemoryStoreFacade();
  await store.open(SILO, ':ignored:', DIMS);
});

afterEach(async () => {
  await store.close(SILO);
});

function makeLog(facade: StoreFacade = store, name = () => SILO_NAME): ActivityLog {
  return new ActivityLog(SILO, facade, name, CAP, () => LOG_LIMIT);
}

/**
 * Build a `StoreFacade` that delegates everything to `base`, except for the
 * methods listed in `override`. Needed because `LocalStoreFacade` keeps its
 * methods on the prototype — a plain `{...base, override}` spread produces
 * an object missing all the class methods.
 */
function storeWith(base: StoreFacade, override: Partial<StoreFacade>): StoreFacade {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop in override) {
        return Reflect.get(override, prop, receiver);
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ActivityLog — reader surface', () => {
  it('starts empty with null lastUpdated', () => {
    const log = makeLog();
    expect(log.recent(10)).toEqual([]);
    expect(log.lastUpdated).toBeNull();
  });

  it('recent(limit) returns the most recent N events, oldest-first', () => {
    const log = makeLog();
    log.append(makeEvent('a.md', 1));
    log.append(makeEvent('b.md', 2));
    log.append(makeEvent('c.md', 3));

    const last2 = log.recent(2);
    expect(last2.map((e) => e.filePath)).toEqual(['b.md', 'c.md']);
  });

  it('recent returns a fresh copy — caller mutation does not affect internal buffer', () => {
    const log = makeLog();
    log.append(makeEvent('a.md', 1));
    const snapshot = log.recent(10);
    snapshot.length = 0;
    expect(log.recent(10).length).toBe(1);
  });
});

describe('ActivityLog — append', () => {
  it('updates lastUpdated to the event timestamp', () => {
    const log = makeLog();
    expect(log.lastUpdated).toBeNull();

    const e = makeEvent('a.md', 5000);
    log.append(e);
    expect(log.lastUpdated).toEqual(new Date(5000));
  });

  it('persists to the store via fire-and-forget — visible after a microtask turn', async () => {
    const log = makeLog();
    log.append(makeEvent('a.md', 1));
    log.append(makeEvent('b.md', 2));

    await flushMicrotasks();

    const rows = await store.loadActivity(SILO, 10);
    expect(rows.map((r) => r.file_path).sort()).toEqual(['a.md', 'b.md']);
  });

  it('drops oldest events once cap is exceeded', () => {
    const log = makeLog();
    for (let i = 0; i < CAP + 3; i++) {
      log.append(makeEvent(`f${i}.md`, i + 1));
    }

    const all = log.recent(100);
    expect(all.length).toBe(CAP);
    // Oldest CAP+3 entries dropped — the surviving ones are the most-recent.
    expect(all.map((e) => e.filePath)).toEqual(['f3.md', 'f4.md', 'f5.md', 'f6.md', 'f7.md']);
  });

  it('reads logLimit lazily via the provider, not at construction', async () => {
    let limit = 50;
    const log = new ActivityLog(SILO, store, () => SILO_NAME, CAP, () => limit);

    log.append(makeEvent('a.md', 1));
    await flushMicrotasks();
    // Provider was queried at append time. Bump the limit and append again —
    // the new value should be used.
    limit = 200;
    log.append(makeEvent('b.md', 2));
    await flushMicrotasks();

    // Both rows persisted.
    const rows = await store.loadActivity(SILO, 10);
    expect(rows.length).toBe(2);
  });
});

describe('ActivityLog — listener', () => {
  it('fires the listener exactly once per append, with the same event', () => {
    const log = makeLog();
    const seen: WatcherEvent[] = [];
    log.setListener((e) => seen.push(e));

    const e1 = makeEvent('a.md', 1);
    const e2 = makeEvent('b.md', 2);
    log.append(e1);
    log.append(e2);

    expect(seen).toEqual([e1, e2]);
  });

  it('a listener exception is swallowed — buffer still grows and DB still persists', async () => {
    const log = makeLog();
    log.setListener(() => {
      throw new Error('listener boom');
    });

    expect(() => log.append(makeEvent('a.md', 1))).not.toThrow();
    expect(log.recent(10).length).toBe(1);

    await flushMicrotasks();
    const rows = await store.loadActivity(SILO, 10);
    expect(rows.length).toBe(1);
  });

  it('setListener(null) clears the registration', () => {
    const log = makeLog();
    let calls = 0;
    log.setListener(() => calls++);
    log.append(makeEvent('a.md', 1));
    expect(calls).toBe(1);

    log.setListener(null);
    log.append(makeEvent('b.md', 2));
    expect(calls).toBe(1);
  });
});

describe('ActivityLog — store error robustness', () => {
  it('append does not throw when logActivity rejects (fire-and-forget)', async () => {
    const failingStore = storeWith(store, {
      logActivity: () => Promise.reject(new Error('store boom')),
    });
    const log = new ActivityLog(SILO, failingStore, () => SILO_NAME, CAP, () => LOG_LIMIT);

    expect(() => log.append(makeEvent('a.md', 1))).not.toThrow();
    // Buffer still grew.
    expect(log.recent(10).length).toBe(1);
    // The rejection is swallowed by the .catch — give the microtask queue a
    // turn so any unhandled-rejection would have surfaced by now.
    await flushMicrotasks();
  });

  it('loadFromStore returns empty when the store throws', async () => {
    const throwingStore = storeWith(store, {
      loadActivity: () => Promise.reject(new Error('table missing')),
    });
    const log = new ActivityLog(SILO, throwingStore, () => SILO_NAME, CAP, () => LOG_LIMIT);

    await log.loadFromStore();
    expect(log.recent(10)).toEqual([]);
  });
});

describe('ActivityLog — loadFromStore', () => {
  it('seeds the buffer from persisted history with the current siloName', async () => {
    // Seed the store directly via the facade.
    await store.logActivity(SILO, new Date(1000).toISOString(), 'indexed', 'a.md', null, LOG_LIMIT);
    await store.logActivity(SILO, new Date(2000).toISOString(), 'deleted', 'b.md', null, LOG_LIMIT);

    const log = makeLog(store, () => 'renamed-silo');
    await log.loadFromStore();

    const seen = log.recent(10);
    expect(seen.length).toBe(2);
    // siloName comes from the provider at load time, not from the persisted row
    // (the schema doesn't store siloName per-row — it's a runtime property).
    expect(seen.every((e) => e.siloName === 'renamed-silo')).toBe(true);
    expect(seen.map((e) => e.filePath).sort()).toEqual(['a.md', 'b.md']);
  });

  it('does not set lastUpdated — preserves pre-refactor behaviour', async () => {
    // Persist some history.
    await store.logActivity(SILO, new Date(1000).toISOString(), 'indexed', 'a.md', null, LOG_LIMIT);

    const log = makeLog();
    await log.loadFromStore();

    // Even though events are loaded, lastUpdated stays null until the next live append.
    expect(log.lastUpdated).toBeNull();

    log.append(makeEvent('b.md', 9999));
    expect(log.lastUpdated).toEqual(new Date(9999));
  });
});
