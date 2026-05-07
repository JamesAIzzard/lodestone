/**
 * Test double for SiloWatcher.
 *
 * Implements `SiloWatcherLike` and lets tests:
 *   - Inspect what `SiloManager` registered (`onEvent`, `onQueueFilled`)
 *   - Emit synthetic `WatcherEvent`s into the manager via `emit(...)`
 *   - Control `queueLength` and how `runQueue()` resolves
 *
 * The point is to drive `SiloManager.handleWatcherEvent` (which is
 * private) through the public listener it registers via `on(...)`, so
 * we can assert on mtime updates and activity-log writes without
 * piercing the private boundary.
 */

import type {
  SiloWatcherLike,
  WatcherEvent,
  WatcherEventHandler,
  IndexLoopProgress,
} from '../watcher';

export class FakeSiloWatcher implements SiloWatcherLike {
  /** Handler registered via `on(...)`. Tests use `emit(...)` to invoke it. */
  private handler: WatcherEventHandler | null = null;
  /** Callback registered via `setQueueFilledHandler(...)`. */
  queueFilledHandler: (() => void) | null = null;
  /** Whether `start()` has been called. */
  started = false;
  /** Whether `stop()` has been called. */
  stopped = false;
  /** Mutable so tests can drive the "no items left" branch in scheduleWatcherIndexing. */
  queueLength = 0;
  /**
   * Override to control how `runQueue()` resolves. Default: resolves immediately.
   * Tests that want to drive progress can replace this.
   */
  runQueueImpl: (
    onProgress?: (p: IndexLoopProgress) => void,
    shouldStop?: () => boolean,
  ) => Promise<void> = async () => undefined;

  on(handler: WatcherEventHandler): void {
    this.handler = handler;
  }

  setQueueFilledHandler(fn: () => void): void {
    this.queueFilledHandler = fn;
  }

  start(): void {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async runQueue(
    onProgress?: (p: IndexLoopProgress) => void,
    shouldStop?: () => boolean,
  ): Promise<void> {
    return this.runQueueImpl(onProgress, shouldStop);
  }

  /** Emit a synthetic event into the manager's registered handler. */
  emit(event: WatcherEvent): void {
    if (!this.handler) throw new Error('No event handler registered yet');
    this.handler(event);
  }

  /** Convenience: emit an `'indexed'` event for an absolute path. */
  emitIndexed(filePath: string, siloName: string): void {
    this.emit({
      timestamp: new Date(),
      siloName,
      filePath,
      eventType: 'indexed',
    });
  }

  /** Convenience: emit a `'deleted'` event for an absolute path. */
  emitDeleted(filePath: string, siloName: string): void {
    this.emit({
      timestamp: new Date(),
      siloName,
      filePath,
      eventType: 'deleted',
    });
  }
}
