/**
 * The client half of state-change events (`docs/state-sync.md`): one topic's
 * replica, kept from snapshots and revisioned event batches.
 *
 * Two halves, both framework-free. The DATA half is a pure reducer step that
 * reads and writes the topic's existing `UIState` fields through a descriptor's
 * lenses. The TRANSPORT half is the per-connection-lifetime bookkeeping beside
 * it: the last `seq` per topic and the resubscribe a gap asks for.
 * `useAssistant` stays the one owner of both; this module only decides.
 */
import type {
  BroadcastTopic,
  ClientMessage,
  StateDigestEntry,
  StateEvent,
  StateEventsMessage,
} from "@assistant/shared";
import { wireValueEqual } from "./wireValueEqual.ts";

/** One topic's held objects and the revision sidecar beside them. */
interface TopicReplica<Item extends { id: string }> {
  items: Item[];
  revisions: Record<string, number>;
}

/** A topic's snapshot answer, adapted out of its own list message. */
interface ReplicaSnapshot<Item> {
  items: Item[];
  revisions: readonly StateDigestEntry[];
}

/**
 * What a topic tells the replica about itself. `write` must keep every slice it
 * does not own by reference; per-topic policy lives in the hooks, never in the
 * generic loop.
 */
export interface TopicDescriptor<
  State,
  Item extends { id: string },
  Snapshot extends { type: string },
> {
  read(state: State): TopicReplica<Item>;
  write(state: State, replica: TopicReplica<Item>): State;
  snapshot(message: Snapshot): ReplicaSnapshot<Item>;
  /** Where a member this replica has not held yet goes. */
  place(items: Item[], item: Item): Item[];
  /** Topic-specific snapshot fields, applied to the already written state. */
  adoptSnapshot?(state: State, message: Snapshot): State;
}

/**
 * A revision sidecar as a record, or `null` when it cannot be trusted: an empty
 * id, a revision that is not a non-negative safe integer, or a duplicate id.
 */
export function revisionSidecar(
  entries: readonly StateDigestEntry[],
): Record<string, number> | null {
  const revisions: Record<string, number> = {};
  for (const entry of entries) {
    if (
      !entry.id ||
      !Number.isSafeInteger(entry.revision) ||
      entry.revision < 0 ||
      entry.id in revisions
    )
      return null;
    revisions[entry.id] = entry.revision;
  }
  return revisions;
}

/**
 * Apply one snapshot or event batch to a topic's fields. A batch that applies
 * nothing returns `state` itself; a value-equal echo advances only the sidecar
 * and keeps the item array and every row by identity.
 */
export function applyTopicMessage<
  State,
  Item extends { id: string },
  Snapshot extends { type: string },
>(
  descriptor: TopicDescriptor<State, Item, Snapshot>,
  state: State,
  message: StateEventsMessage<BroadcastTopic, Item> | Snapshot,
): State {
  if (isEvents(message)) {
    const current = descriptor.read(state);
    const next = applyEvents(current, message.events, descriptor.place);
    // Compare against what `read` returned, not the state field: an absent
    // sidecar reads as a fresh `{}` every time.
    return next === current ? state : descriptor.write(state, next);
  }
  const adopted = descriptor.snapshot(message);
  const written = descriptor.write(state, {
    items: adopted.items,
    revisions: revisionSidecar(adopted.revisions) ?? {},
  });
  return descriptor.adoptSnapshot
    ? descriptor.adoptSnapshot(written, message)
    : written;
}

function isEvents<Item>(
  message: StateEventsMessage<BroadcastTopic, Item> | { type: string },
): message is StateEventsMessage<BroadcastTopic, Item> {
  return message.type === "stateEvents";
}

/** Per event: apply iff its revision is above the one held for that id. */
function applyEvents<Item extends { id: string }>(
  current: TopicReplica<Item>,
  events: readonly StateEvent<Item>[],
  place: (items: Item[], item: Item) => Item[],
): TopicReplica<Item> {
  let revisions: Record<string, number> | null = null;
  let items = current.items;
  for (const event of events) {
    const known = revisions?.[event.id] ?? current.revisions[event.id] ?? -1;
    if (event.revision <= known) continue;
    revisions ??= { ...current.revisions };
    revisions[event.id] = event.revision;
    const index = items.findIndex((item) => item.id === event.id);
    if (event.kind === "delete") {
      if (index >= 0) items = items.filter((item) => item.id !== event.id);
    } else if (index < 0) {
      items = place(items, event.item);
    } else if (!wireValueEqual(items[index], event.item)) {
      const next = items.slice();
      next[index] = event.item;
      items = next;
    }
  }
  return revisions ? { items, revisions } : current;
}

export interface ReplicaTransport {
  owns(topic: BroadcastTopic): boolean;
  /** A snapshot's `seq` is the new baseline, whatever was held before. */
  snapshotReceived(topic: BroadcastTopic, seq: number): void;
  /**
   * The messages to send for this batch: none when it continues the last one,
   * otherwise an unsubscribe and a fresh subscribe. The batch itself still
   * applies either way.
   */
  eventsReceived(message: StateEventsMessage): ClientMessage[];
}

/**
 * The gap tripwire for the topics given. `seq` never replays anything: a batch
 * that does not continue the last one means an event was missed while
 * subscribed, so the topic resubscribes for a fresh snapshot, loudly, because
 * silence here is silent data loss. Nothing resets on disconnect; the next
 * snapshot rebaselines.
 */
export function createReplicaTransport(
  topics: readonly BroadcastTopic[],
): ReplicaTransport {
  const owned = new Set(topics);
  const lastSeq = new Map<BroadcastTopic, number>();
  return {
    owns: (topic) => owned.has(topic),
    snapshotReceived(topic, seq) {
      lastSeq.set(topic, seq);
    },
    eventsReceived(message) {
      const previous = lastSeq.get(message.topic);
      lastSeq.set(message.topic, message.seq);
      if (previous === undefined || message.seq === previous + 1) return [];
      console.warn(
        `[state-sync] ${message.topic} event gap: expected seq ${previous + 1}, got ${message.seq}; resubscribing.`,
      );
      return [
        { type: "unsubscribe", topics: [message.topic] },
        subscribeRequest([message.topic]),
      ];
    },
  };
}

/** No replica topic declares a digest yet, so a subscribe names topics only. */
function subscribeRequest(
  topics: BroadcastTopic[],
): Extract<ClientMessage, { type: "subscribe" }> {
  return { type: "subscribe", topics };
}
