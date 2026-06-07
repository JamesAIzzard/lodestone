/**
 * Bounded buffer of recent activity events for a single silo, with
 * fire-and-forget DB persistence. Replaces the duplicated 20-line append
 * blocks that used to live in `SiloManager.onReconcileEvent` and
 * `SiloManager.handleWatcherEvent` (Phase 2b of the refactor plan).
 *
 * The collaborator is intentionally *not* lifecycle-aware. The previous
 * `if (this.dbOpen)` gate around the store call turned out to be dead
 * code under the current `stop()` teardown ordering — every emitter that
 * could reach this layer is drained before `dbOpen` flips to false. If a
 * future stop() reorder ever broke that invariant, the worker's
 * "is not open" rejection is swallowed by the `.catch` here, producing
 * the same observable outcome the old gate did. See the docs/refactor
 * plan's Phase 2b notes for the full call-graph trace.
 */

import type { WatcherEvent } from '../watcher';
import type { StoreFacade } from '../store-facade';

export class ActivityLog {
  private events: WatcherEvent[] = [];
  private listener: ((event: WatcherEvent) => void) | null = null;
  private _lastUpdated: Date | null = null;

  constructor(
    private readonly siloId: string,
    private readonly store: StoreFacade,
    private readonly siloName: () => string,
    private readonly cap: number,
    private readonly logLimit: () => number,
  ) {}

  /**
   * Seed the in-memory buffer from persisted history. Swallows errors —
   * very old DBs may not have the activity_log table yet, and a load
   * failure should not prevent the silo from starting.
   *
   * Note: `_lastUpdated` is intentionally *not* set after load. This
   * preserves the pre-refactor behaviour where `getStatus().lastUpdated`
   * is null after a fresh restart until the first new event arrives,
   * even when historical events are present.
   */
  async loadFromStore(): Promise<void> {
    try {
      const rows = await this.store.loadActivity(this.siloId, this.cap);
      const name = this.siloName();
      this.events = rows.map((r) => ({
        timestamp: new Date(r.timestamp),
        siloName: name,
        filePath: r.file_path,
        eventType: r.event_type as WatcherEvent['eventType'],
        errorMessage: r.error_message ?? undefined,
      }));
    } catch {
      // First run — activity_log table may not exist yet in very old DBs
    }
  }

  /** A copy of the most recent `limit` events, oldest-first. */
  recent(limit: number): WatcherEvent[] {
    return this.events.slice(-limit);
  }

  /** Timestamp of the most recently appended event, or null if none. */
  get lastUpdated(): Date | null {
    return this._lastUpdated;
  }

  /** Register a single listener. Replaces any previous one. */
  setListener(listener: ((event: WatcherEvent) => void) | null): void {
    this.listener = listener;
  }

  /**
   * Push an event into the buffer, cap to `cap`, fire the listener, and
   * fire-and-forget a store write. Sync — never blocks the caller.
   *
   * A listener exception is logged and swallowed: the buffer is still
   * updated and the store write still happens. The pre-refactor code
   * would have let listener exceptions propagate up to chokidar /
   * reconcile; this hardens against that. Production listeners (renderer
   * forwarding) don't throw, so this is a no-op in normal use.
   */
  append(event: WatcherEvent): void {
    this.events.push(event);
    if (this.events.length > this.cap) {
      this.events = this.events.slice(-this.cap);
    }
    this._lastUpdated = event.timestamp;

    if (this.listener) {
      try {
        this.listener(event);
      } catch (err) {
        console.error(`[silo:${this.siloId}] activity listener threw:`, err);
      }
    }

    this.store
      .logActivity(
        this.siloId,
        event.timestamp.toISOString(),
        event.eventType,
        event.filePath,
        event.errorMessage ?? null,
        this.logLimit(),
      )
      .catch((): void => undefined);
  }
}
