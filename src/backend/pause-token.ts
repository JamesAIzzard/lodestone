/**
 * Cooperative pause mechanism for long-running async operations.
 *
 * Consumers call `await token.waitIfPaused()` at safe yield points.
 * When paused, the returned promise blocks until `resume()` is called.
 */

export class PauseToken {
  private _paused = false;
  private _resumeResolve: (() => void) | null = null;

  get isPaused(): boolean {
    return this._paused;
  }

  pause(): void {
    this._paused = true;
  }

  resume(): void {
    this._paused = false;
    if (this._resumeResolve) {
      this._resumeResolve();
      this._resumeResolve = null;
    }
  }

  /** Blocks if paused; resolves immediately otherwise. */
  async waitIfPaused(): Promise<void> {
    if (!this._paused) return;
    return new Promise<void>((resolve) => {
      if (!this._paused) {
        resolve();
        return;
      }
      this._resumeResolve = resolve;
    });
  }
}
