/**
 * Unit tests for SiloLifecycle.
 *
 * The class has no I/O or external dependencies — these are pure
 * state-machine tests plus listener / cancellation-token coverage.
 */

import { describe, it, expect } from 'vitest';
import {
  SiloLifecycle,
  toWatcherState,
  type SiloLifecyclePhase,
} from './silo-lifecycle';
import type { WatcherState } from '../../shared/types';

describe('SiloLifecycle — initial state', () => {
  it('starts in phase "created"', () => {
    const lc = new SiloLifecycle();
    expect(lc.phase()).toBe('created');
  });

  it('projects "created" to external WatcherState "ready"', () => {
    const lc = new SiloLifecycle();
    expect(lc.watcherState()).toBe('ready');
  });

  it('starts with stopRequested false', () => {
    const lc = new SiloLifecycle();
    expect(lc.stopRequested).toBe(false);
  });
});

describe('SiloLifecycle — phase → external WatcherState mapping', () => {
  // Pinned exhaustive mapping. If a new phase is added, this must be
  // updated alongside `toWatcherState`.
  const cases: ReadonlyArray<readonly [SiloLifecyclePhase, WatcherState]> = [
    ['created', 'ready'],
    ['waiting', 'waiting'],
    ['indexing', 'indexing'],
    ['maintenance', 'indexing'],
    ['ready', 'ready'],
    ['stopped', 'stopped'],
    ['error', 'error'],
  ];

  for (const [phase, expected] of cases) {
    it(`${phase} → ${expected}`, () => {
      expect(toWatcherState(phase)).toBe(expected);
    });
  }
});

describe('SiloLifecycle — legal transitions succeed', () => {
  // Pinned legal transition graph. Every entry here corresponds to a real
  // code path traced through `silo-manager.ts` in the Phase 4 audit.
  const legal: ReadonlyArray<readonly [SiloLifecyclePhase, SiloLifecyclePhase]> = [
    // From 'created' (registerManager priming, fresh start)
    ['created', 'waiting'],
    ['created', 'indexing'],
    ['created', 'stopped'],
    ['created', 'error'],
    // From 'waiting' (IndexingQueue admits, error during start)
    ['waiting', 'indexing'],
    ['waiting', 'ready'],
    ['waiting', 'stopped'],
    ['waiting', 'error'],
    // From 'indexing' (reconcile→maintenance, simple finish, error, stop)
    ['indexing', 'maintenance'],
    ['indexing', 'ready'],
    ['indexing', 'stopped'],
    ['indexing', 'error'],
    ['indexing', 'waiting'],
    // From 'maintenance' (back to indexing during line 444→466 window, ready, stop, error)
    ['maintenance', 'indexing'],
    ['maintenance', 'ready'],
    ['maintenance', 'stopped'],
    ['maintenance', 'error'],
    // From 'ready' (config-update reconcile, stop, error)
    ['ready', 'waiting'],
    ['ready', 'indexing'],
    ['ready', 'stopped'],
    ['ready', 'error'],
    // From 'stopped' (wake → loadWaitingStatus, rebuild → start)
    ['stopped', 'waiting'],
    ['stopped', 'indexing'],
    ['stopped', 'ready'],
    // From 'error' (recovery via start/wake/rebuild)
    ['error', 'waiting'],
    ['error', 'indexing'],
    ['error', 'ready'],
    ['error', 'stopped'],
  ];

  for (const [from, to] of legal) {
    it(`${from} → ${to}`, () => {
      const lc = new SiloLifecycle();
      driveTo(lc, from);
      lc.transition(to);
      expect(lc.phase()).toBe(to);
    });
  }
});

describe('SiloLifecycle — illegal transitions throw', () => {
  // The strictest invariant: 'maintenance' may *only* be entered from
  // 'indexing'. Other guards are looser by design (the production code
  // legitimately reaches many phases from many sources during rebuild,
  // wake, error recovery, etc.).
  const illegal: ReadonlyArray<readonly [SiloLifecyclePhase, SiloLifecyclePhase]> = [
    ['created', 'maintenance'],
    ['created', 'ready'],
    ['waiting', 'maintenance'],
    ['ready', 'maintenance'],
    ['stopped', 'maintenance'],
    ['stopped', 'error'],
    ['error', 'maintenance'],
  ];

  for (const [from, to] of illegal) {
    it(`${from} → ${to} throws`, () => {
      const lc = new SiloLifecycle();
      driveTo(lc, from);
      expect(() => lc.transition(to)).toThrow(
        /Illegal SiloLifecycle transition/,
      );
      // Phase should be unchanged after an illegal attempt.
      expect(lc.phase()).toBe(from);
    });
  }
});

describe('SiloLifecycle — same-phase transitions are no-ops', () => {
  it('transition to current phase does not throw', () => {
    const lc = new SiloLifecycle();
    expect(() => lc.transition('created')).not.toThrow();
    expect(lc.phase()).toBe('created');
  });

  it('does not fire listener on same-phase transition', () => {
    const lc = new SiloLifecycle();
    let calls = 0;
    lc.onChange(() => {
      calls++;
    });
    lc.transition('created');
    expect(calls).toBe(0);
  });

  it('does not fire listener even after a real transition', () => {
    const lc = new SiloLifecycle();
    lc.transition('waiting');
    let calls = 0;
    lc.onChange(() => {
      calls++;
    });
    lc.transition('waiting'); // no-op
    expect(calls).toBe(0);
  });
});

describe('SiloLifecycle — listener fires exactly once per real transition', () => {
  it('fires once per change, with the new phase', () => {
    const lc = new SiloLifecycle();
    const events: SiloLifecyclePhase[] = [];
    lc.onChange((phase) => events.push(phase));

    lc.transition('waiting');
    lc.transition('indexing');
    lc.transition('maintenance');
    lc.transition('indexing');
    lc.transition('ready');

    expect(events).toEqual(['waiting', 'indexing', 'maintenance', 'indexing', 'ready']);
  });

  it('does not fire on illegal transition attempts', () => {
    const lc = new SiloLifecycle();
    let calls = 0;
    lc.onChange(() => {
      calls++;
    });
    expect(() => lc.transition('maintenance')).toThrow();
    expect(calls).toBe(0);
  });

  it('replacing the listener stops the previous one from firing', () => {
    const lc = new SiloLifecycle();
    let firstCalls = 0;
    let secondCalls = 0;
    lc.onChange(() => {
      firstCalls++;
    });
    lc.transition('waiting');
    lc.onChange(() => {
      secondCalls++;
    });
    lc.transition('indexing');
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
  });

  it('listener exceptions do not break the FSM', () => {
    const lc = new SiloLifecycle();
    lc.onChange(() => {
      throw new Error('listener boom');
    });
    expect(() => lc.transition('waiting')).not.toThrow();
    expect(lc.phase()).toBe('waiting');
  });
});

describe('SiloLifecycle — stop request (cancellation token)', () => {
  it('requestStop sets stopRequested', () => {
    const lc = new SiloLifecycle();
    lc.requestStop();
    expect(lc.stopRequested).toBe(true);
  });

  it('stopRequested is visible to a `() => stopRequested` callback', () => {
    const lc = new SiloLifecycle();
    const shouldStop = (): boolean => lc.stopRequested;
    expect(shouldStop()).toBe(false);
    lc.requestStop();
    expect(shouldStop()).toBe(true);
  });

  it('survives subsequent phase transitions', () => {
    const lc = new SiloLifecycle();
    lc.transition('waiting');
    lc.transition('indexing');
    lc.requestStop();
    lc.transition('stopped');
    expect(lc.stopRequested).toBe(true);
    // Even after entering 'stopped' phase, the request flag is
    // independent — caller resets it on the next start().
  });

  it('resetStopRequest clears the flag', () => {
    const lc = new SiloLifecycle();
    lc.requestStop();
    expect(lc.stopRequested).toBe(true);
    lc.resetStopRequest();
    expect(lc.stopRequested).toBe(false);
  });

  it('phase and stopRequested are orthogonal: stop can be requested in any phase', () => {
    const lc = new SiloLifecycle();
    lc.transition('waiting');
    lc.requestStop();
    expect(lc.phase()).toBe('waiting'); // phase did not change
    expect(lc.stopRequested).toBe(true);
  });
});

describe('SiloLifecycle — full lifecycle round-trips', () => {
  it('happy path: created → waiting → indexing → maintenance → indexing → ready', () => {
    const lc = new SiloLifecycle();
    const events: SiloLifecyclePhase[] = [];
    lc.onChange((p) => events.push(p));

    lc.transition('waiting');
    lc.transition('indexing');
    lc.transition('maintenance');
    lc.transition('indexing'); // line 444 → external still 'indexing'
    lc.transition('ready');

    expect(events).toEqual(['waiting', 'indexing', 'maintenance', 'indexing', 'ready']);
    expect(lc.watcherState()).toBe('ready');
  });

  it('freeze/wake round-trip: ready → stopped → waiting → indexing → ready', () => {
    const lc = new SiloLifecycle();
    lc.transition('waiting');
    lc.transition('indexing');
    lc.transition('ready');

    // freeze
    lc.transition('stopped');
    expect(lc.watcherState()).toBe('stopped');

    // wake → loadWaitingStatus → start
    lc.transition('waiting');
    lc.transition('indexing');
    lc.transition('ready');
    expect(lc.phase()).toBe('ready');
  });

  it('rebuild without prior freeze: ready → indexing → ready (stop call does not transition)', () => {
    const lc = new SiloLifecycle();
    lc.transition('waiting');
    lc.transition('indexing');
    lc.transition('ready');

    // rebuild calls stop(); stop() requests cancellation but does not
    // transition the phase. After in-flight work drains, start() is
    // called — phase transitions resume.
    lc.requestStop();
    expect(lc.phase()).toBe('ready'); // stop() does not change phase

    lc.resetStopRequest();
    lc.transition('indexing');
    lc.transition('ready');
    expect(lc.phase()).toBe('ready');
  });

  it('error recovery: indexing → error → indexing → ready', () => {
    const lc = new SiloLifecycle();
    lc.transition('waiting');
    lc.transition('indexing');
    lc.transition('error');
    expect(lc.watcherState()).toBe('error');
    lc.transition('indexing');
    lc.transition('ready');
    expect(lc.phase()).toBe('ready');
  });
});

/**
 * Drive a fresh lifecycle to the requested phase via legal intermediates.
 * Used by the legal/illegal transition tables so each test starts from a
 * clean instance and reaches the desired source phase reliably.
 */
function driveTo(lc: SiloLifecycle, target: SiloLifecyclePhase): void {
  switch (target) {
    case 'created':
      return;
    case 'waiting':
      lc.transition('waiting');
      return;
    case 'indexing':
      lc.transition('waiting');
      lc.transition('indexing');
      return;
    case 'maintenance':
      lc.transition('waiting');
      lc.transition('indexing');
      lc.transition('maintenance');
      return;
    case 'ready':
      lc.transition('waiting');
      lc.transition('indexing');
      lc.transition('ready');
      return;
    case 'stopped':
      lc.transition('stopped');
      return;
    case 'error':
      lc.transition('waiting');
      lc.transition('error');
      return;
  }
}
