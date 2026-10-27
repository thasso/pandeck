/**
 * The server's side of the watch methods: a native subscription for a
 * checkout placed on a Worker is made by that Worker (`docs/workers.md`).
 *
 * A subscription is bound to the connection that made it; its id is
 * allocated and registered as pending before `watch.subscribe` is sent, so
 * events that precede the answer are delivered. A handle never redials.
 *
 * Outcomes of a subscribe:
 *
 * - `{}`: live.
 * - An answered native failure: rejected at once, marked as a filesystem
 *   failure (`checkoutFailureOf`).
 * - `unknown_method`: no handler ran; rejected at once as a Worker failure.
 * - The connection ended: rejected as a Worker failure once the Worker has
 *   released every native watch of that connection.
 * - Anything else on an open connection (a refusal, a `failed` response, a
 *   malformed answer) leaves the native outcome unknown. The subscribe stays
 *   unsettled while `watch.unsubscribe` proves absence; if that cleanup fails
 *   in any way, the connection is ended and the Worker's release awaited.
 *   Only then does it reject, so a caller holding a slot for it keeps the
 *   slot until no native subscription of it can be live.
 *
 * Every rejection that is not an answered native failure is branded as a
 * Worker failure.
 */
import { markFilesystemFailure } from "../checkoutFileAccess.ts";
import {
  UNKNOWN_METHOD,
  WorkerRequestError,
  type WorkerConnection,
} from "../workerProtocol/connection.ts";
import {
  AnsweredWatchFailure,
  WATCH_METHODS,
  decodeWatchOutcome,
  encodeSubscribe,
  encodeUnsubscribe,
  type WatchRef,
} from "../workerProtocol/watchMethods.ts";
import { workerConnection } from "./checkoutClient.ts";
import { brandWorkerFailure } from "./fileClient.ts";
import {
  watchesOn,
  type ConnectionWatches,
  type WatchCallback,
  type WatchListeners,
} from "./watchDeliveries.ts";

/** A subscription a Worker holds for this server. */
export interface WorkerWatchHandle {
  /**
   * Release it. Resolves once the Worker released it, or once its connection
   * ended and the Worker released every native watch.
   */
  unsubscribe(): Promise<void>;
}

/** The answer's outcome; throws what the answer carried or its malformation. */
async function ask(
  connection: WorkerConnection,
  method: string,
  payload: Parameters<WorkerConnection["request"]>[1],
): Promise<void> {
  decodeWatchOutcome(await connection.request(method, payload));
}

/** A rejection that is an answer is marked; any other is branded. */
function classified(error: unknown): unknown {
  return error instanceof AnsweredWatchFailure
    ? markFilesystemFailure(error)
    : brandWorkerFailure(error);
}

/**
 * Prove an uncertain subscribe absent: unsubscribe it, or end the
 * connection and await the Worker's release.
 */
async function abandon(
  connection: WorkerConnection,
  watches: ConnectionWatches,
  ref: WatchRef,
): Promise<void> {
  watches.setState(ref.id, "abandoning");
  try {
    await ask(connection, WATCH_METHODS.unsubscribe, encodeUnsubscribe(ref));
  } catch {
    connection.end("watch subscribe outcome unknown");
    await watches.gone;
  }
  watches.remove(ref.id);
}

export async function subscribeOnWorker(
  location: { workerId: string; path: string },
  ignore: readonly string[],
  callback: WatchCallback,
  listeners: Omit<WatchListeners, "callback">,
): Promise<WorkerWatchHandle> {
  let connection: WorkerConnection;
  try {
    connection = workerConnection(location.workerId);
  } catch (error) {
    throw brandWorkerFailure(error);
  }
  const watches = watchesOn(connection);
  if (!watches)
    throw brandWorkerFailure(
      new Error(`Worker "${location.workerId}" delivers no watches.`),
    );
  const ref: WatchRef = {
    workerId: location.workerId,
    id: watches.add({ callback, ...listeners }),
  };
  let failure: unknown;
  try {
    await ask(
      connection,
      WATCH_METHODS.subscribe,
      encodeSubscribe({ ...ref, path: location.path, ignore }),
    );
    if (!connection.isEnded) {
      watches.setState(ref.id, "live");
      return { unsubscribe: () => unsubscribe(connection, watches, ref) };
    }
    failure = new Error(
      `The Worker connection ended: ${await connection.ended}.`,
    );
  } catch (error) {
    failure = error;
  }
  if (failure instanceof AnsweredWatchFailure) {
    watches.remove(ref.id);
    throw markFilesystemFailure(failure);
  }
  if (connection.isEnded) {
    await watches.gone;
    watches.remove(ref.id);
  } else if (
    failure instanceof WorkerRequestError &&
    failure.code === UNKNOWN_METHOD
  )
    // The connection answers it before any handler runs.
    watches.remove(ref.id);
  else await abandon(connection, watches, ref);
  throw brandWorkerFailure(failure);
}

async function unsubscribe(
  connection: WorkerConnection,
  watches: ConnectionWatches,
  ref: WatchRef,
): Promise<void> {
  if (!connection.isEnded) {
    watches.setState(ref.id, "unsubscribing");
    try {
      await ask(connection, WATCH_METHODS.unsubscribe, encodeUnsubscribe(ref));
      watches.remove(ref.id);
      return;
    } catch (error) {
      if (!connection.isEnded) {
        // Kept, and still delivering, so a later attempt can address it.
        watches.setState(ref.id, "live");
        throw classified(error);
      }
    }
  }
  await watches.gone;
  watches.remove(ref.id);
}
