/**
 * SiloLifecycle — FSM + cancellation token for a single silo.
 *
 * Owns two orthogonal concerns:
 *
 * 1. **Phase** — what the silo is currently doing. The internal phase set is
 *    richer than the external `WatcherState` wire format: the FSM separates
 *    'maintenance' (checkpoint/VACUUM) from 'indexing', and adds 'created'
 *    for the just-constructed window before any priming or `start()`.
 *    Both internal phases map to the same external `WatcherState`, so the
 *    renderer keeps seeing today's shape.
 *
 * 2. **Stop request** — a simple boolean cancellation token, checked by
 *    `reconcile()` and the watcher loop at every yield point. This is *not*
 *    a phase: while a stop is pending, the silo can simultaneously be in
 *    phase 'indexing' (running reconcile) *and* have cancellation requested
 *    (so reconcile bails at its next yield). Compressing these into one
 *    phase would lose information. Keep orthogonal.
 *
 * Transitions are validated. A `transition(target)` call that isn't in the
 * allowed-source set for the target throws — surfacing FSM bugs immediately
 * rather than allowing silent drift. Same-phase calls are explicit no-ops
 * (the listener does not fire).
 */
import type { WatcherState } from '../../shared/types';

export type SiloLifecyclePhase =
  | 'created'
  | 'waiting'
  | 'indexing'
  | 'maintenance'
  | 'ready'
  | 'stopped'
  | 'error';

/**
 * Allowed source phases for each target. The FSM rejects any transition not
 * listed here. Source-keyed for caller readability.
 */
const ALLOWED_TRANSITIONS: ReadonlyMap<
  SiloLifecyclePhase,
  ReadonlySet<SiloLifecyclePhase>
> = new Map([
  ['created', new Set<SiloLifecyclePhase>(['waiting', 'indexing', 'stopped', 'error'])],
  ['waiting', new Set<SiloLifecyclePhase>(['indexing', 'ready', 'stopped', 'error'])],
  ['indexing', new Set<SiloLifecyclePhase>(['maintenance', 'ready', 'stopped', 'error', 'waiting'])],
  ['maintenance', new Set<SiloLifecyclePhase>(['indexing', 'ready', 'stopped', 'error'])],
  ['ready', new Set<SiloLifecyclePhase>(['waiting', 'indexing', 'stopped', 'error'])],
  ['stopped', new Set<SiloLifecyclePhase>(['waiting', 'indexing', 'ready'])],
  ['error', new Set<SiloLifecyclePhase>(['waiting', 'indexing', 'ready', 'stopped'])],
]);

/**
 * Map an internal FSM phase to the external `WatcherState` consumed by the
 * renderer over IPC. The mapping preserves today's wire format exactly:
 *
 *  - 'created' → 'ready' (matches the pre-refactor literal default for a
 *    just-constructed manager that hasn't been primed)
 *  - 'maintenance' → 'indexing' (today, `_watcherState` stays at 'indexing'
 *    while `maintenanceInProgress` is true)
 *  - all other phases map 1:1 to the existing wire values.
 */
export function toWatcherState(phase: SiloLifecyclePhase): WatcherState {
  switch (phase) {
    case 'created':
      return 'ready';
    case 'waiting':
      return 'waiting';
    case 'indexing':
    case 'maintenance':
      return 'indexing';
    case 'ready':
      return 'ready';
    case 'stopped':
      return 'stopped';
    case 'error':
      return 'error';
  }
}

export class SiloLifecycle {
  private _phase: SiloLifecyclePhase = 'created';
  private _stopRequested = false;
  private listener?: (phase: SiloLifecyclePhase) => void;

  /** Current FSM phase. */
  phase(): SiloLifecyclePhase {
    return this._phase;
  }

  /** Current external (IPC) state — the renderer-facing projection. */
  watcherState(): WatcherState {
    return toWatcherState(this._phase);
  }

  /**
   * Validated transition to a new phase.
   *
   * - Same-phase calls are silent no-ops (listener does not fire).
   * - Otherwise, the source must be in the allowed-source set for the target,
   *   else throws.
   * - On success, the listener (if registered) fires exactly once.
   */
  transition(target: SiloLifecyclePhase): void {
    if (this._phase === target) return;
    const allowed = ALLOWED_TRANSITIONS.get(this._phase);
    if (!allowed || !allowed.has(target)) {
      throw new Error(
        `Illegal SiloLifecycle transition: ${this._phase} → ${target}`,
      );
    }
    this._phase = target;
    if (this.listener) {
      try {
        this.listener(target);
      } catch (err) {
        console.error('[SiloLifecycle] Listener threw:', err);
      }
    }
  }

  /**
   * Register a phase-change listener. Only one listener is supported; calling
   * twice replaces the previous registration. Listener exceptions are caught
   * so a misbehaving consumer can't break the FSM.
   */
  onChange(listener: (phase: SiloLifecyclePhase) => void): void {
    this.listener = listener;
  }

  /** Request that any in-flight indexing bail at its next yield point. */
  requestStop(): void {
    this._stopRequested = true;
  }

  /**
   * Clear the stop-request flag. Called at the start of `start()` so a fresh
   * run isn't pre-cancelled by a previous stop.
   */
  resetStopRequest(): void {
    this._stopRequested = false;
  }

  /** True when `requestStop()` has been called and not yet reset. */
  get stopRequested(): boolean {
    return this._stopRequested;
  }
}
