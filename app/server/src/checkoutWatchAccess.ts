/**
 * The native watch subscriptions of the checkouts on one side, made where
 * that side's git runs (`docs/workers.md`, "Watches"). The worktree watcher is
 * the only consumer: it passes the row's typed side (`checkoutSideOf`), so the
 * Knowledge Base row subscribes on the server and every other checkout on its
 * Worker.
 *
 * - `"server"`: the local `@parcel/watcher`. Any rejection is an answered
 *   filesystem failure; `onLost` and `onOverflow` never fire.
 * - A Worker side: `watch.subscribe` through `workers/watchClient.ts`. An
 *   answered native failure is a filesystem failure, anything else a Worker
 *   failure (`checkoutFailureOf`). The subscription is lost with its
 *   connection, after the Worker released it, and a queue overflow arrives as
 *   `onOverflow` in place of the batches it absorbed.
 *
 * Both sides call parcel through its default export object, so a spy on it
 * sees every native subscription.
 */
import { markFilesystemFailure } from "./checkoutFileAccess.ts";
import watcher from "./parcelWatcher.ts";
import { subscribeOnWorker } from "./workers/watchClient.ts";
import { checkoutSideKey, type CheckoutSide } from "./workers/placement.ts";

/** An error, or the event paths of one native callback. */
export type CheckoutWatchCallback = (
  err: Error | null,
  events: ReadonlyArray<{ path: string }>,
) => void;

export interface CheckoutWatchOptions {
  ignore: readonly string[];
  /** Batches were lost to the Worker's queue bound: react as to a bulk one. */
  onOverflow: () => void;
  /** The subscription is gone with its connection; it delivers no more. */
  onLost: () => void;
}

export interface CheckoutWatchSubscription {
  /** Resolves once the native subscription is released. */
  unsubscribe(): Promise<void>;
}

export interface CheckoutWatch {
  subscribe(
    root: string,
    path: string,
    callback: CheckoutWatchCallback,
    options: CheckoutWatchOptions,
  ): Promise<CheckoutWatchSubscription>;
}

function marked(error: unknown): unknown {
  return error instanceof Error ? markFilesystemFailure(error) : error;
}

const server: CheckoutWatch = {
  async subscribe(_root, path, callback, { ignore }) {
    try {
      // Called through the module object, so spies on it see the native call.
      return await watcher.subscribe(path, callback, { ignore: [...ignore] });
    } catch (error) {
      throw marked(error);
    }
  },
};

const watchesBySide = new Map<string, CheckoutWatch>();

/** The checkout watches on `side`, one instance per side. */
export function checkoutWatchOn(side: CheckoutSide): CheckoutWatch {
  if (side === "server") return server;
  const key = checkoutSideKey(side);
  let watches = watchesBySide.get(key);
  if (!watches) {
    const workerId = side.workerId;
    watches = {
      subscribe: (_root, path, callback, { ignore, onOverflow, onLost }) =>
        subscribeOnWorker({ workerId, path }, ignore, callback, {
          onOverflow,
          onLost,
        }),
    };
    watchesBySide.set(key, watches);
  }
  return watches;
}
