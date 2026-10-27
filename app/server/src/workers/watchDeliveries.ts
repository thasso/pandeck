/**
 * The server's side of Worker watch deliveries: each connection's watch
 * subscriptions, its id counter, and the server's handler for
 * `watch.events`, the server's first handler table (`docs/workers.md`).
 *
 * The server allocates every subscription id, a positive integer never reused
 * on its connection, and registers it as pending before `watch.subscribe`
 * goes out, so deliveries that precede the answer reach the callback exactly
 * as a live subscription's do. A delivery for an id this side does not hold,
 * or holds only to prove a subscribe's outcome, is acknowledged and dropped.
 *
 * Loss follows the Worker's release: once a connection has ended and its
 * Worker holds no native watch any more, each live subscription gets
 * `onLost` once. The server never frees a subscription's slot while a native
 * subscription of it may still be live. In-process the server observes the
 * release directly; an out-of-process Worker (phase 2) needs fencing instead.
 *
 * Imports no connection acquisition, so `inProcessWorker.ts` can wire it.
 */
import type {
  MethodHandlers,
  WorkerConnection,
} from "../workerProtocol/connection.ts";
import { WATCH_METHODS, decodeEvents } from "../workerProtocol/watchMethods.ts";

/** A watch callback: an error, or the events of one native callback. */
export type WatchCallback = (
  err: Error | null,
  events: ReadonlyArray<{ path: string }>,
) => void;

export interface WatchListeners {
  callback: WatchCallback;
  /** The Worker's queue overflowed: batches were lost, treat it as bulk. */
  onOverflow: () => void;
  /** The connection ended and the Worker released the native subscription. */
  onLost: () => void;
}

/**
 * - `pending`: `watch.subscribe` is unanswered; deliveries reach it.
 * - `live`: subscribed; deliveries reach it, and loss is reported.
 * - `unsubscribing`: its holder released it; deliveries reach it until then.
 * - `abandoning`: its subscribe's outcome is being proven; deliveries drop.
 */
type WatchState = "pending" | "live" | "unsubscribing" | "abandoning";

interface WatchEntry extends WatchListeners {
  state: WatchState;
}

/** The watch subscriptions of one Worker connection. */
export class ConnectionWatches {
  private nextId = 1;
  private readonly entries = new Map<number, WatchEntry>();
  /**
   * Resolves once the connection has ended and its Worker holds no native
   * watch; every subscription that was live is lost by then.
   */
  readonly gone: Promise<void>;

  constructor(connection: WorkerConnection, released: Promise<void>) {
    this.gone = connection.ended.then(() => released);
    void this.gone.then(() => {
      for (const [id, entry] of this.entries)
        if (entry.state === "live") {
          this.entries.delete(id);
          entry.onLost();
        }
    });
  }

  /** Registers a pending subscription under a fresh id. */
  add(listeners: WatchListeners): number {
    const id = this.nextId++;
    this.entries.set(id, { ...listeners, state: "pending" });
    return id;
  }

  setState(id: number, state: WatchState): void {
    const entry = this.entries.get(id);
    if (entry) entry.state = state;
  }

  remove(id: number): void {
    this.entries.delete(id);
  }

  deliver(id: number, run: (entry: WatchListeners) => void): void {
    const entry = this.entries.get(id);
    if (entry && entry.state !== "abandoning") run(entry);
  }
}

const watchesByConnection = new WeakMap<WorkerConnection, ConnectionWatches>();

/** The watch subscriptions of `connection`, if it delivers watches. */
export function watchesOn(
  connection: WorkerConnection,
): ConnectionWatches | undefined {
  return watchesByConnection.get(connection);
}

/** What a test recorder keeps of one delivery. */
interface DeliveryRecord {
  id: number;
  batchCounts: number[];
  overflow: boolean;
}

let deliveryHold: Promise<void> | undefined;
/** The armed test recorders; with none armed, deliveries leave no record. */
const recorders = new Set<DeliveryRecord[]>();

/**
 * The server's handler table for one Worker connection, and `attach`, which
 * binds it to the connection it was accepted with and to that Worker's
 * watch release.
 */
export function watchDeliveries(): {
  handlers: MethodHandlers;
  attach(connection: WorkerConnection, released: Promise<void>): void;
} {
  let watches: ConnectionWatches | undefined;
  return {
    handlers: {
      // Callbacks only schedule work, so the acknowledgement follows their
      // synchronous effects.
      [WATCH_METHODS.events]: async (payload) => {
        const delivery = decodeEvents(payload);
        if (recorders.size > 0) {
          const record: DeliveryRecord = {
            id: delivery.id,
            batchCounts: delivery.batches.map((batch) =>
              batch.error !== undefined ? 1 : batch.paths.length,
            ),
            overflow: delivery.overflow,
          };
          for (const records of recorders) records.push(record);
        }
        watches?.deliver(delivery.id, (entry) => {
          for (const batch of delivery.batches)
            if (batch.error !== undefined)
              entry.callback(new Error(batch.error), []);
            else
              entry.callback(
                null,
                batch.paths.map((path) => ({ path })),
              );
          if (delivery.overflow) entry.onOverflow();
        });
        const hold = deliveryHold;
        if (hold) await hold;
        return { json: {} };
      },
    },
    attach(connection, released) {
      watches = new ConnectionWatches(connection, released);
      watchesByConnection.set(connection, watches);
    },
  };
}

/**
 * Test seam: deliveries still run their callbacks, but their
 * acknowledgements wait until the returned release.
 */
export function holdWatchDeliveriesForTests(): () => void {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  deliveryHold = hold;
  return () => {
    if (deliveryHold === hold) deliveryHold = undefined;
    release();
  };
}

/**
 * Test seam: from now until `stop()`, one record per delivery the server
 * handles, in order. Recorders are independent; a stopped one keeps what it
 * recorded and records nothing more.
 */
export function recordWatchDeliveriesForTests(): {
  records(): readonly DeliveryRecord[];
  stop(): void;
} {
  const records: DeliveryRecord[] = [];
  recorders.add(records);
  return {
    records: () => [...records],
    stop: () => {
      recorders.delete(records);
    },
  };
}
