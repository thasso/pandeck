/**
 * The state topic kernel (`docs/state-sync.md`, Server contract): everything a
 * migrated domain's topic does between "a write committed these ids" and the
 * wire, written once. A domain supplies only a {@link StateTopicDescriptor};
 * the kernel owns pending ids, the debounce, publishing from reported ids, the
 * missing-summary retry, `seq`, frame splitting, the subscribe answer, items by
 * id and the post-publish listeners. It imports no domain module.
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
  /** The full subscribe/resync answer, carrying `seq`. */
  snapshot(seq: number): Snapshot;
  /** Declared only when the live projection is small enough to digest. */
  digest?: () => StateDigestEntry[];
  /** The most events one `stateEvents` frame may carry. */
  batchMax: number;
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
   * flushes included. Cross-domain effects live here, outside the kernel.
   */
  onPublished(listener: () => void): void;
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
  const listeners: Array<() => void> = [];

  /** `undefined` only for a live row whose summary is missing. */
  const eventFor = (
    id: string,
    entry: { revision: number; live: boolean },
  ): StateEvent<Item> | undefined => {
    if (!entry.live) return { kind: "delete", id, revision: entry.revision };
    const item = descriptor.summary(id);
    return item === undefined
      ? undefined
      : { kind: "upsert", id, revision: entry.revision, item };
  };

  /**
   * Publish exactly the reported ids, in first-report order. Every write stamps
   * a fresh revision on each row it touches and reports those ids after
   * COMMIT, so an unreported row cannot have moved. A reported live row
   * upserts; a reported row that left membership deletes, even one that joined
   * and left inside one window, because a subscribe in between may have
   * snapshotted it.
   */
  const flush = (): void => {
    const ids = [...pending];
    pending = new Set();
    const index = descriptor.revisions(ids);
    const events: StateEvent<Item>[] = [];
    for (const id of ids) {
      const entry = index.get(id);
      if (!entry) continue;
      const event = eventFor(id, entry);
      if (event) {
        events.push(event);
        continue;
      }
      // Keep the id for the next flush, which any later report schedules,
      // rather than lose its event. Never reschedule from here: a summary that
      // stays missing would spin a timer forever.
      console.warn(
        `[${topic}] no summary for live item ${id}; event deferred.`,
      );
      pending.add(id);
    }
    // One write may report every row an owner ever had, so a flush is cut into
    // frames no larger than `batchMax`, each an ordinary batch with the next
    // `seq`, sent in order.
    for (let start = 0; start < events.length; start += descriptor.batchMax) {
      seq += 1;
      broadcast?.(topic, {
        type: "stateEvents",
        topic,
        seq,
        events: events.slice(start, start + descriptor.batchMax),
      });
    }
    for (const listener of listeners) {
      try {
        listener();
      } catch (err) {
        // The frames are out; one effect failing must not silence the others.
        console.error(`[${topic}] post-publish listener failed:`, err);
      }
    }
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
      const unique = [...new Set(ids)];
      const index = descriptor.revisions(unique);
      const events: StateEvent<Item>[] = [];
      for (const id of unique) {
        const entry = index.get(id);
        const event = entry && eventFor(id, entry);
        if (event) events.push(event);
      }
      return events;
    },
    onPublished(listener) {
      listeners.push(listener);
    },
  };
}
