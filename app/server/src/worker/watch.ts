/**
 * The Worker's watch methods: native `@parcel/watcher` subscriptions for one
 * connection, their delivery queues, and the release owner that holds every
 * native watch operation (`docs/workers.md`).
 *
 * Each subscription keeps one FIFO of batches, one per native callback, its
 * paths in parcel's order or the callback's error. While no `watch.events`
 * for it is in flight, everything queued goes at once as one request, batch
 * boundaries kept; there is no timer. A queue that would hold more than
 * {@link WATCH_QUEUE_BOUND} paths collapses into one overflow marker, which
 * absorbs every callback until it is delivered. The delivery in flight does
 * not count.
 *
 * The release owner alone holds native work: live subscriptions, subscribes
 * in progress and unsubscribes in progress. A handler only waits on the
 * owner's promise or its abort signal, whichever comes first, so on
 * connection end every handler settles at once and the Worker's request
 * quiescence never waits for a native watch call. On end the owner drops
 * every queue, unsubscribes every live subscription, and releases each
 * subscribe still in progress once it resolves; an unsubscribe failing after
 * end retries at {@link RELEASE_RETRY_BASE_MS} doubling to
 * {@link RELEASE_RETRY_MAX_MS} until it succeeds. `released` resolves once
 * the connection has ended and the owner holds nothing.
 */
import watcher, { type AsyncSubscription } from "../parcelWatcher.ts";
import {
  INVALID_PARAMS,
  WRONG_WORKER,
} from "../workerProtocol/checkoutMethods.ts";
import type { Payload } from "../workerProtocol/codec.ts";
import {
  WorkerMethodError,
  type MethodHandlers,
} from "../workerProtocol/connection.ts";
import {
  WATCH_METHODS,
  decodeSubscribe,
  decodeUnsubscribe,
  encodeEvents,
  encodeWatchDone,
  encodeWatchFailure,
  type WatchBatch,
} from "../workerProtocol/watchMethods.ts";

/**
 * The most paths one subscription queues: at least 4× the largest single
 * callback measured on packaged Bun (4,714 events), a factor of 4.24.
 */
const WATCH_QUEUE_BOUND = 20_000;
const RELEASE_RETRY_BASE_MS = 5_000;
const RELEASE_RETRY_MAX_MS = 60_000;

let queueBound = WATCH_QUEUE_BOUND;
let releaseRetryMs = RELEASE_RETRY_BASE_MS;

type NativeCallback = (
  err: Error | null,
  events: ReadonlyArray<{ path: string }>,
) => void;

interface Watch {
  readonly id: number;
  readonly path: string;
  readonly ignore: readonly string[];
  /** Settles when the native subscribe does; set while it runs. */
  subscribing: Promise<void> | undefined;
  /** The live native subscription. */
  subscription: AsyncSubscription | undefined;
  /** The native unsubscribe in progress; rejects when it fails. */
  unsubscribing: Promise<void> | undefined;
  /** No handler answers for it any more: the owner releases it, silently. */
  orphaned: boolean;
  /** The next post-end release retry's delay; unset before the first. */
  retryMs?: number;
  retry: ReturnType<typeof setTimeout> | undefined;
  queue: WatchBatch[];
  queuedPaths: number;
  overflow: boolean;
  inFlight: boolean;
}

/** One subscription as the Worker holds it, for tests. */
export interface WatchSnapshot {
  id: number;
  inFlight: boolean;
  queuedPaths: number;
  overflow: boolean;
}

export interface WatchTable {
  readonly handlers: MethodHandlers;
  /** The connection ended: stop deliveries and release every native watch. */
  end(): void;
  /** Resolves once {@link end} ran and the owner holds no native watch. */
  readonly released: Promise<void>;
  /** Test seam: the native subscriptions the owner holds. */
  snapshot(): WatchSnapshot[];
}

const ABORTED = Symbol("aborted");

/** `work`'s outcome, or {@link ABORTED} once `signal` aborts first. */
function untilAborted<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof ABORTED> {
  return new Promise<T | typeof ABORTED>((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * The watch methods of the Worker `workerId` for one connection; `deliver`
 * sends a `watch.events` request and settles with its acknowledgement.
 */
export function watchHandlers(
  workerId: string,
  deliver: (payload: Payload) => Promise<Payload>,
): WatchTable {
  const table = new Map<number, Watch>();
  let ended = false;
  let resolveReleased!: () => void;
  const released = new Promise<void>((resolve) => {
    resolveReleased = resolve;
  });

  const holds = (watch: Watch): boolean =>
    watch.subscribing !== undefined ||
    watch.subscription !== undefined ||
    watch.unsubscribing !== undefined;

  /** Forget a watch nobody answers for once the owner holds nothing of it. */
  const settle = (watch: Watch): void => {
    if ((ended || watch.orphaned) && !holds(watch)) {
      clearTimeout(watch.retry);
      if (table.get(watch.id) === watch) table.delete(watch.id);
    }
    if (ended && table.size === 0) resolveReleased();
  };

  const dropQueue = (watch: Watch): void => {
    watch.queue = [];
    watch.queuedPaths = 0;
    watch.overflow = false;
  };

  const delivering = (watch: Watch): boolean =>
    !ended && !watch.orphaned && table.get(watch.id) === watch;

  const flush = (watch: Watch): void => {
    if (watch.inFlight || !delivering(watch)) return;
    if (watch.queue.length === 0 && !watch.overflow) return;
    const payload = encodeEvents({
      id: watch.id,
      batches: watch.overflow ? [] : watch.queue,
      overflow: watch.overflow,
    });
    dropQueue(watch);
    watch.inFlight = true;
    const next = () => {
      watch.inFlight = false;
      flush(watch);
    };
    deliver(payload).then(next, next);
  };

  const receive = (watch: Watch, batch: WatchBatch): void => {
    if (!delivering(watch) || watch.overflow) return;
    const count = batch.error !== undefined ? 1 : batch.paths.length;
    if (watch.queuedPaths + count > queueBound) {
      dropQueue(watch);
      watch.overflow = true;
    } else {
      watch.queue.push(batch);
      watch.queuedPaths += count;
    }
    flush(watch);
  };

  /** The owner's native unsubscribe of `watch`, joining one in progress. */
  const unsubscribeNative = (watch: Watch): Promise<void> => {
    if (watch.unsubscribing) return watch.unsubscribing;
    const subscription = watch.subscription;
    if (!subscription) return Promise.resolve();
    const unsubscribing = (async () => {
      await nativeUnsubscribe(subscription);
      if (watch.subscription === subscription) watch.subscription = undefined;
    })();
    watch.unsubscribing = unsubscribing;
    unsubscribing.then(
      () => {
        watch.unsubscribing = undefined;
        settle(watch);
      },
      () => {
        watch.unsubscribing = undefined;
        if (ended || watch.orphaned) retryRelease(watch);
        settle(watch);
      },
    );
    return unsubscribing;
  };

  /** Release a watch no handler addresses any more, retrying until it goes. */
  const release = (watch: Watch): void => {
    unsubscribeNative(watch).catch(() => undefined);
  };

  const retryRelease = (watch: Watch): void => {
    if (watch.retry !== undefined) return;
    const delay = watch.retryMs ?? releaseRetryMs;
    watch.retryMs = Math.min(delay * 2, RELEASE_RETRY_MAX_MS);
    watch.retry = setTimeout(() => {
      watch.retry = undefined;
      release(watch);
    }, delay);
    // The native subscription itself keeps the process alive meanwhile.
    watch.retry.unref?.();
  };

  /** The owner's native subscribe of `watch`; rejects with parcel's failure. */
  const subscribeNative = (watch: Watch): Promise<void> => {
    const subscribed = (async () => {
      watch.subscription = await nativeSubscribe(
        watch.path,
        (err, events) =>
          receive(
            watch,
            err
              ? { error: err.message }
              : { paths: events.map((event) => event.path) },
          ),
        watch.ignore,
      );
    })();
    const settled = subscribed.then(
      () => undefined,
      () => undefined,
    );
    watch.subscribing = settled;
    void settled.then(() => {
      watch.subscribing = undefined;
      if (watch.subscription && (ended || watch.orphaned)) release(watch);
      settle(watch);
    });
    return subscribed;
  };

  const here = (id: string): void => {
    if (id !== workerId)
      throw new WorkerMethodError(
        WRONG_WORKER,
        `The watch is on Worker "${id}", not "${workerId}".`,
      );
  };

  const handlers: MethodHandlers = {
    [WATCH_METHODS.subscribe]: async (payload, signal) => {
      const request = decodeSubscribe(payload);
      here(request.workerId);
      if (table.has(request.id))
        throw new WorkerMethodError(
          INVALID_PARAMS,
          `This Worker already holds watch ${request.id}.`,
        );
      const watch: Watch = {
        id: request.id,
        path: request.path,
        ignore: request.ignore,
        subscribing: undefined,
        subscription: undefined,
        unsubscribing: undefined,
        orphaned: false,
        retry: undefined,
        queue: [],
        queuedPaths: 0,
        overflow: false,
        inFlight: false,
      };
      // Registered before the native call: its callbacks may deliver at once.
      table.set(watch.id, watch);
      try {
        const outcome = await untilAborted(subscribeNative(watch), signal);
        if (outcome !== ABORTED) return encodeWatchDone();
      } catch (error) {
        if (table.get(watch.id) === watch) table.delete(watch.id);
        return encodeWatchFailure(error);
      }
      // A connection end or a cancel: the owner keeps the native subscribe
      // and releases it once it resolves; nothing delivers for it.
      watch.orphaned = true;
      dropQueue(watch);
      settle(watch);
      throw new Error(`Watch ${watch.id} was cancelled.`);
    },
    [WATCH_METHODS.unsubscribe]: async (payload, signal) => {
      const { workerId: id, id: watchId } = decodeUnsubscribe(payload);
      here(id);
      const watch = table.get(watchId);
      if (!watch) return encodeWatchDone();
      const released = (async () => {
        // A subscribe still running is joined: whatever its answer said,
        // only its native outcome tells whether anything is live.
        if (watch.subscribing) await watch.subscribing;
        await unsubscribeNative(watch);
      })();
      try {
        if ((await untilAborted(released, signal)) === ABORTED)
          throw new Error(`Unsubscribing watch ${watchId} was cancelled.`);
      } catch (error) {
        if (signal.aborted) throw error;
        // Kept, and still delivering, so a later attempt can address it.
        return encodeWatchFailure(error);
      }
      if (table.get(watchId) === watch && !holds(watch)) {
        table.delete(watchId);
        dropQueue(watch);
      }
      return encodeWatchDone();
    },
  };

  return {
    handlers,
    end() {
      if (ended) return;
      ended = true;
      for (const watch of table.values()) {
        dropQueue(watch);
        if (watch.subscription && !watch.unsubscribing) release(watch);
        settle(watch);
      }
      // A subscribe in progress is released when it resolves, an unsubscribe
      // in progress retries if it fails; `settle` resolves `released` after.
      if (table.size === 0) resolveReleased();
    },
    released,
    snapshot() {
      return [...table.values()]
        .filter((watch) => watch.subscription !== undefined)
        .map((watch) => ({
          id: watch.id,
          inFlight: watch.inFlight,
          queuedPaths: watch.queuedPaths,
          overflow: watch.overflow,
        }));
    },
  };
}

// --- Native calls and their test seams ------------------------------------

/** A substituted native subscription, driven by the test that armed it. */
export interface CapturedNativeWatch {
  /** Resolves with what the owner asked for once it subscribes. */
  readonly subscribed: Promise<{ path: string; ignore: readonly string[] }>;
  /** Resolve a held subscribe. */
  releaseSubscribe(): void;
  /** Reject a held subscribe with `message`, as parcel would. */
  rejectSubscribe(message: string): void;
  /** One native callback with these event paths. */
  emit(paths: readonly string[]): void;
  /** One native error callback. */
  emitError(message: string): void;
  /** How many times the owner unsubscribed it. */
  readonly unsubscribes: number;
}

interface CaptureOptions {
  holdSubscribe?: boolean;
  rejectUnsubscribeOnce?: boolean;
}

type NativeSubscribe = (
  path: string,
  callback: NativeCallback,
  ignore: readonly string[],
) => Promise<AsyncSubscription>;

const captures: NativeSubscribe[] = [];
const unsubscribeHolds: Promise<void>[] = [];

function nativeSubscribe(
  path: string,
  callback: NativeCallback,
  ignore: readonly string[],
): Promise<AsyncSubscription> {
  const capture = captures.shift();
  if (capture) return capture(path, callback, ignore);
  // Called through the module object, so spies on it see the native call.
  return watcher.subscribe(path, callback, { ignore: [...ignore] });
}

async function nativeUnsubscribe(
  subscription: AsyncSubscription,
): Promise<void> {
  const hold = unsubscribeHolds.shift();
  if (hold) await hold;
  await subscription.unsubscribe();
}

/** Test seam: the per-subscription queue bound; answers the previous one. */
export function setWatchQueueBoundForTests(bound: number): number {
  const previous = queueBound;
  queueBound = bound;
  return previous;
}

/** Test seam: the first post-end release retry's delay; answers the previous. */
export function setWatchReleaseRetryMsForTests(ms: number): number {
  const previous = releaseRetryMs;
  releaseRetryMs = ms;
  return previous;
}

/**
 * Test seam: the next native unsubscribe the owner makes waits for the
 * returned release, then runs the real call.
 */
export function holdNativeUnsubscribeForTests(): () => void {
  let release!: () => void;
  unsubscribeHolds.push(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  return release;
}

/**
 * Test seam: the next native subscribe the owner makes is a substitute the
 * test drives. Captures arm in order. Ids, queues, overflow, the release
 * owner and the codec stay real.
 */
export function captureNextNativeWatchForTests(
  options: CaptureOptions = {},
): CapturedNativeWatch {
  let callback: NativeCallback | undefined;
  let unsubscribes = 0;
  let rejectOnce = options.rejectUnsubscribeOnce === true;
  let settle: ((message?: string) => void) | undefined;
  let held: string | null | undefined;
  let announce!: (asked: { path: string; ignore: readonly string[] }) => void;
  const subscribed = new Promise<{ path: string; ignore: readonly string[] }>(
    (resolve) => {
      announce = resolve;
    },
  );
  const subscription: AsyncSubscription = {
    unsubscribe: async () => {
      unsubscribes += 1;
      if (rejectOnce) {
        rejectOnce = false;
        throw new Error("unsubscribe failed");
      }
      callback = undefined;
    },
  };
  captures.push((path, onEvents, ignore) => {
    callback = onEvents;
    announce({ path, ignore });
    if (!options.holdSubscribe) return Promise.resolve(subscription);
    return new Promise<AsyncSubscription>((resolve, reject) => {
      settle = (message) => {
        if (message === undefined) resolve(subscription);
        else {
          callback = undefined;
          reject(new Error(message));
        }
      };
      if (held !== undefined) settle(held ?? undefined);
    });
  });
  const finish = (message?: string): void => {
    if (settle) settle(message);
    else held = message ?? null;
  };
  return {
    subscribed,
    releaseSubscribe: () => finish(),
    rejectSubscribe: (message) => finish(message),
    emit: (paths) =>
      callback?.(
        null,
        paths.map((path) => ({ path })),
      ),
    emitError: (message) => callback?.(new Error(message), []),
    get unsubscribes() {
      return unsubscribes;
    },
  };
}
