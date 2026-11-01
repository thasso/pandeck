/**
 * The state topic kernel (`docs/state-sync.md`, Server contract): everything a
 * migrated domain's topic does between "a write committed these ids" and the
 * wire, written once. A domain supplies only a {@link StateTopicDescriptor};
 * the kernel owns pending ids, the debounce, publishing from reported ids, the
 * missing-summary retry, `seq`, frame splitting, the subscribe answer, items by
 * id, the post-publish listeners and the failure boundary between a committed
 * write and its publication. It imports no domain module.
 */
import type {
  BroadcastTopic,
  StateDigestEntry,
  StateDigestMessage,
  StateEvent,
  StateEventsMessage,
} from "@assistant/shared";

/** The read half a domain supplies for its topic. */
export interface StateTopicDescriptor<
  Topic extends BroadcastTopic,
  Item,
  Snapshot,
> {
  topic: Topic;
  /**
   * `{revision, live}` for exactly these ids, read by primary key. An id the
   * read does not return produces no event.
   */
  revisions(
    ids: readonly string[],
  ): Map<string, { revision: number; live: boolean }>;
  /** The summary projection of one live row. */
  summary(id: string): Item | undefined;
  /**
   * Batch form of `summary` for the ids `revisions` marked live: an item,
   * `null` for "not a member now" (published as `delete` at the stored
   * revision), absent for "summary missing" (stays pending). When declared,
   * a flush and an `items` read call it once instead of `summary` per id.
   */
  summaries?(ids: readonly string[]): Map<string, Item | null>;
  /** The full subscribe/resync answer, carrying `seq`. */
  snapshot(seq: number): Snapshot;
  /** Declared only when the live projection is small enough to digest. */
  digest?: () => StateDigestEntry[];
  /** The most events one `stateEvents` frame may carry. */
  batchMax: number;
}

/**
 * What one flush did, handed to every post-publish listener: the events it
 * published, and whether every read and every frame succeeded.
 */
interface StateTopicPublication<Item> {
  events: readonly StateEvent<Item>[];
  delivered: boolean;
}

const INVARIANT_BRAND = Symbol.for("pandeck.stateTopicInvariant");
const INVARIANT_LEDGER = Symbol.for("pandeck.stateTopicInvariants");

/**
 * The one store of recorded violations per process (a test worker), keyed on
 * `globalThis` so every kernel instance shares it, including one a test
 * re-imported after `vi.resetModules()`.
 */
function invariantLedger(): Error[] {
  const store = globalThis as unknown as Record<symbol, Error[] | undefined>;
  return (store[INVARIANT_LEDGER] ??= []);
}

/**
 * A published projection disagrees with what its writes reported — a missed
 * reporter. Only a test-mode audit constructs one. Constructing it records it
 * in the shared ledger at once, so the test fails through
 * {@link failOnStateTopicInvariantsForTests} whatever catch converts the throw
 * on its way out. Recognise it with {@link isStateTopicInvariant}, never
 * `instanceof`: a re-imported module defines a second class.
 */
export class StateTopicInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateTopicInvariantError";
    (this as unknown as Record<symbol, boolean>)[INVARIANT_BRAND] = true;
    invariantLedger().push(this);
  }
}

/** True for a {@link StateTopicInvariantError} from any kernel instance. */
export function isStateTopicInvariant(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as Record<symbol, unknown>)[INVARIANT_BRAND] === true
  );
}

/** Test seam: the violations recorded so far, leaving the ledger empty. */
export function takeStateTopicInvariantsForTests(): Error[] {
  return invariantLedger().splice(0);
}

/**
 * Test seam: fail with every violation recorded and not taken. The server test
 * setup calls this after each test.
 */
export function failOnStateTopicInvariantsForTests(): void {
  const violations = takeStateTopicInvariantsForTests();
  if (violations.length === 0) return;
  throw new Error(
    `state topic invariant violated (${violations.length}): ${violations
      .map((violation) => violation.message)
      .join(" | ")}`,
  );
}

export interface StateTopic<Topic extends BroadcastTopic, Item, Answer> {
  /** Start publishing. Before this, reports are dropped and nothing is timed. */
  attach(
    broadcast: (topic: Topic, message: StateEventsMessage<Topic, Item>) => void,
  ): void;
  /**
   * Committed writes touched these ids. Restarts the trailing debounce even
   * for none: an empty report still owes a flush (a deferred id's retry, and
   * the post-publish listeners).
   */
  report(ids: readonly string[]): void;
  /** Test seam: run a SCHEDULED flush now. With none scheduled, nothing. */
  flushNow(): void;
  seq(): number;
  /** A digest when the topic declares one and the client asked; else the snapshot. */
  subscribeAnswer(digestRequested: boolean): Answer;
  /** Flush-shaped events for these ids, read fresh; touches neither `seq` nor pending. */
  items(ids: readonly string[]): StateEvent<Item>[];
  /**
   * Run `listener` once after every flush, after its frames were sent, empty
   * and failed flushes included. Cross-domain effects live here, outside the
   * kernel.
   */
  onPublished(listener: (outcome: StateTopicPublication<Item>) => void): void;
}

const DEFAULT_DEBOUNCE_MS = 25;

export function createStateTopic<Topic extends BroadcastTopic, Item, Snapshot>(
  descriptor: StateTopicDescriptor<Topic, Item, Snapshot> & {
    digest?: undefined;
  },
  options?: { debounceMs?: number },
): StateTopic<Topic, Item, Snapshot>;
export function createStateTopic<Topic extends BroadcastTopic, Item, Snapshot>(
  descriptor: StateTopicDescriptor<Topic, Item, Snapshot>,
  options?: { debounceMs?: number },
): StateTopic<Topic, Item, Snapshot | StateDigestMessage<Topic>>;
export function createStateTopic<Topic extends BroadcastTopic, Item, Snapshot>(
  descriptor: StateTopicDescriptor<Topic, Item, Snapshot>,
  { debounceMs = DEFAULT_DEBOUNCE_MS }: { debounceMs?: number } = {},
): StateTopic<Topic, Item, Snapshot | StateDigestMessage<Topic>> {
  const { topic } = descriptor;
  let broadcast:
    | ((topic: Topic, message: StateEventsMessage<Topic, Item>) => void)
    | undefined;
  let pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  const listeners: Array<(outcome: StateTopicPublication<Item>) => void> = [];

  /**
   * Flush-shaped events for `ids`, in their order, and the live ids whose
   * summary is missing. Reads only; a throw leaves no trace.
   */
  const read = (
    ids: readonly string[],
  ): { events: StateEvent<Item>[]; missing: string[] } => {
    const index = descriptor.revisions(ids);
    const batch = descriptor.summaries?.(
      ids.filter((id) => index.get(id)?.live),
    );
    const events: StateEvent<Item>[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const entry = index.get(id);
      if (!entry) continue;
      const item = !entry.live
        ? null
        : batch
          ? batch.get(id)
          : descriptor.summary(id);
      if (item === null)
        events.push({ kind: "delete", id, revision: entry.revision });
      else if (item === undefined) missing.push(id);
      else events.push({ kind: "upsert", id, revision: entry.revision, item });
    }
    return { events, missing };
  };

  const notify = (outcome: StateTopicPublication<Item>): void => {
    for (const listener of listeners) {
      try {
        listener(outcome);
      } catch (err) {
        // One effect failing must not silence the others, and the flush is
        // over either way.
        console.error(`[${topic}] post-publish listener failed:`, err);
      }
    }
  };

  /** Put a failed flush's ids back, ahead of any reported since. */
  const retain = (ids: readonly string[]): void => {
    pending = new Set([...ids, ...pending]);
  };

  /**
   * Publish exactly the reported ids, in first-report order. Every write stamps
   * a fresh revision on each row it touches and reports those ids after
   * COMMIT, so an unreported row cannot have moved. A reported live row
   * upserts; a reported row that left membership deletes, even one that joined
   * and left inside one window, because a subscribe in between may have
   * snapshotted it.
   *
   * The writes are committed by now, so a failed read or send never reaches
   * the caller (a timer, or a command's `flushNow`): it is logged, its ids
   * stay pending for the next report, and listeners hear `delivered: false`.
   * Only a branded invariant escapes, already recorded in the ledger.
   */
  const flush = (): void => {
    const ids = [...pending];
    pending = new Set();
    let events: StateEvent<Item>[];
    try {
      const result = read(ids);
      events = result.events;
      for (const id of result.missing) {
        // Keep the id for the next flush, which any later report schedules,
        // rather than lose its event. Never reschedule from here: a summary
        // that stays missing would spin a timer forever.
        console.warn(
          `[${topic}] no summary for live item ${id}; event deferred.`,
        );
        pending.add(id);
      }
    } catch (err) {
      retain(ids);
      if (isStateTopicInvariant(err)) throw err;
      console.error(`[${topic}] flush failed:`, err);
      notify({ events: [], delivered: false });
      return;
    }
    // One write may report every row an owner ever had, so a flush is cut into
    // frames no larger than `batchMax`, each an ordinary batch with the next
    // `seq`, sent in order. A failed frame still spends its `seq`: a connection
    // that missed it sees the gap on its next frame and resubscribes, and the
    // others ignore the retained events' repeat at the same revisions.
    let delivered = true;
    for (let start = 0; start < events.length; start += descriptor.batchMax) {
      seq += 1;
      try {
        broadcast?.(topic, {
          type: "stateEvents",
          topic,
          seq,
          events: events.slice(start, start + descriptor.batchMax),
        });
      } catch (err) {
        delivered = false;
        console.error(`[${topic}] frame ${seq} delivery failed:`, err);
      }
    }
    if (!delivered) retain(ids);
    notify({ events, delivered });
  };

  return {
    attach(next) {
      broadcast = next;
    },
    report(ids) {
      if (!broadcast) return;
      for (const id of ids) pending.add(id);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        flush();
      }, debounceMs);
    },
    flushNow() {
      if (!timer) return;
      clearTimeout(timer);
      timer = undefined;
      flush();
    },
    seq: () => seq,
    subscribeAnswer(digestRequested) {
      if (digestRequested && descriptor.digest)
        return {
          type: "stateDigest",
          topic,
          seq,
          entries: descriptor.digest(),
        };
      return descriptor.snapshot(seq);
    },
    items(ids) {
      return read([...new Set(ids)]).events;
    },
    onPublished(listener) {
      listeners.push(listener);
    },
  };
}
