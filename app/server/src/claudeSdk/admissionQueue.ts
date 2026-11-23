/**
 * First-in, first-out admission for one Claude session
 * (`docs/session-runtime-switching.md`). Model and effort changes, a prompt
 * admitted behind them, provider-initiated turns and account switches each
 * take a PLACE, in call order. `enter()` takes it synchronously, so there is no
 * gap between checking the queue and joining it. A place is ready only once
 * every earlier place was released, and its holder keeps the queue until it
 * releases, so whatever it awaits meanwhile (native controls, admission) runs
 * before any later place.
 */

export interface AdmissionPlace {
  /** Resolves once every earlier place was released, or the queue closed. */
  readonly ready: Promise<void>;
  /** Give the place up: idempotent, and allowed before `ready` (a cancel). */
  release(): void;
}

export class AdmissionQueue {
  private tail: Promise<void> = Promise.resolve();
  private places = 0;
  private closed = false;
  private signalClosed: () => void = () => undefined;
  private readonly closedSignal = new Promise<void>((resolve) => {
    this.signalClosed = resolve;
  });

  /** Whether any place is taken: waiting or held. */
  get busy(): boolean {
    return this.places > 0;
  }

  enter(): AdmissionPlace {
    this.places += 1;
    let released = false;
    let signal: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const turn = this.tail;
    this.tail = turn.then(() => done);
    return {
      ready: this.closed
        ? Promise.resolve()
        : Promise.race([turn, this.closedSignal]),
      release: () => {
        if (released) return;
        released = true;
        this.places -= 1;
        signal();
      },
    };
  }

  /**
   * The session is gone: every place is ready at once, so no waiter hangs
   * on a holder that never releases. Holders then find the session disposed.
   */
  close(): void {
    this.closed = true;
    this.signalClosed();
  }
}
