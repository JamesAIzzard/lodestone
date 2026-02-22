/**
 * IndexingQueue — global serializer for embedding/indexing work.
 *
 * Only one silo may hold the indexing lock at a time. All other silos
 * that need to index queue behind the current holder and surface
 * 'waiting' state to the UI until their turn arrives.
 *
 * The queue is a plain promise chain: when a task completes (or is
 * cancelled), the next item in the chain runs automatically.
 */

export class IndexingQueue {
  private chain: Promise<void> = Promise.resolve();
  private _queuedCount = 0;
  private _currentHolder: string | null = null;

  /** True when a task is running or waiting to run. */
  get hasQueuedWork(): boolean {
    return this._queuedCount > 0 || this._currentHolder !== null;
  }

  /** The silo name currently holding the lock, or null if idle. */
  get currentHolder(): string | null {
    return this._currentHolder;
  }

  /**
   * Enqueue indexing work for a silo. Returns a cancel function.
   *
   * - `onWaiting` is called immediately only if the queue is already busy
   *   (avoids a spurious 'waiting' flash when the queue is idle).
   * - `onStart` is called when the lock is acquired and the task begins.
   * - Calling the returned cancel function causes the slot to be skipped
   *   when it reaches the front of the queue (e.g. silo was stopped).
   */
  enqueue(
    siloName: string,
    onWaiting: () => void,
    onStart: () => void,
    task: () => Promise<void>,
  ): () => void {
    let cancelled = false;

    // Only signal 'waiting' if something is already running/queued
    if (this.hasQueuedWork) {
      onWaiting();
    }

    this._queuedCount++;

    this.chain = this.chain.then(async () => {
      this._queuedCount--;
      if (cancelled) return;

      this._currentHolder = siloName;
      onStart();
      try {
        await task();
      } finally {
        this._currentHolder = null;
      }
    });

    return () => {
      cancelled = true;
    };
  }
}
