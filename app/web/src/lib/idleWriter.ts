/**
 * Coalescing, idle-deferred writer for best-effort browser caches.
 *
 * A cache write that is cheap in isolation becomes a main-thread stall when it
 * rides a broadcast: the app shell cache is a `JSON.stringify` of the whole
 * session list plus the Task list (~217 KB against production data) followed by
 * a blocking `localStorage.setItem`, and the sessions list alone is rebroadcast
 * up to ~4x/second while any agent streams. This defers the write past the
 * burst (only the LAST value is ever written), waits for an idle callback so it
 * never competes with a frame, and can be flushed synchronously when the page
 * is going away — which is the only moment the write is actually urgent.
 */

export interface IdleWriterEnv {
  now(): number;
  setTimer(run: () => void, ms: number): number;
  clearTimer(handle: number): void;
  /** Run `run` when the main thread is idle, or after `timeoutMs` at the latest. */
  whenIdle(run: () => void, timeoutMs: number): void;
}

export interface IdleWriterOptions {
  /** Quiet period a value must survive before it is written. */
  delayMs: number;
  /** Ceiling on how long later values may keep deferring the pending write. */
  maxDelayMs: number;
  /** How long an idle callback may wait before the write runs anyway. */
  idleTimeoutMs: number;
  env?: IdleWriterEnv;
}

export interface IdleWriter<T> {
  /** Remember `value` as the one to write and (re)arm the deferral. */
  schedule(value: T): void;
  /** Write any pending value now, synchronously. */
  flush(): void;
  /** Drop any pending value without writing it. */
  cancel(): void;
  readonly pending: boolean;
}

function browserIdleWriterEnv(): IdleWriterEnv {
  const idle =
    typeof window !== "undefined" ? window.requestIdleCallback : undefined;
  return {
    now: () => Date.now(),
    setTimer: (run, ms) => window.setTimeout(run, ms),
    clearTimer: (handle) => window.clearTimeout(handle),
    whenIdle: idle
      ? (run, timeoutMs) => {
          idle.call(window, () => run(), { timeout: timeoutMs });
        }
      : (run) => {
          window.setTimeout(run, 0);
        },
  };
}

export function createIdleWriter<T>(
  write: (value: T) => void,
  options: IdleWriterOptions,
): IdleWriter<T> {
  const env = options.env ?? browserIdleWriterEnv();
  let pendingValue: { value: T } | null = null;
  let armedAt: number | null = null;
  let timer: number | null = null;
  let idleQueued = false;

  const clearTimer = () => {
    if (timer === null) return;
    env.clearTimer(timer);
    timer = null;
  };

  const runWrite = () => {
    const pending = pendingValue;
    pendingValue = null;
    armedAt = null;
    if (!pending) return;
    write(pending.value);
  };

  const onDelayElapsed = () => {
    timer = null;
    if (!pendingValue || idleQueued) return;
    idleQueued = true;
    env.whenIdle(() => {
      idleQueued = false;
      runWrite();
    }, options.idleTimeoutMs);
  };

  return {
    get pending() {
      return pendingValue !== null;
    },
    schedule(value: T) {
      pendingValue = { value };
      if (armedAt === null) armedAt = env.now();
      // An unbroken stream of updates must not defer the write forever, so the
      // quiet period is capped by what is left of the ceiling.
      const remaining = Math.max(0, armedAt + options.maxDelayMs - env.now());
      clearTimer();
      timer = env.setTimer(
        onDelayElapsed,
        Math.min(options.delayMs, remaining),
      );
    },
    flush() {
      clearTimer();
      runWrite();
    },
    cancel() {
      clearTimer();
      pendingValue = null;
      armedAt = null;
    },
  };
}
