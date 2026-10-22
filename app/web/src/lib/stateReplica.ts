/**
 * The client half of state-change events (`docs/state-sync.md`): one topic's
 * replica, kept from snapshots, revisioned event batches, digests and item
 * fetches.
 *
 * Two halves, both framework-free. The DATA half is a pure reducer step that
 * reads and writes the topic's existing `UIState` fields through a descriptor's
 * lenses. The TRANSPORT half is the per-hook-instance bookkeeping beside it:
 * the last `seq` per topic, the open item requests and their timeouts, and the
 * one snapshot fallback. `useAssistant` stays the one owner of both; this
 * module only decides.
 */
import type {
  BroadcastTopic,
  ClientMessage,
  StateDigestEntry,
  StateDigestMessage,
  StateEvent,
  StateEventsMessage,
  StateItemsMessage,
} from "@assistant/shared";
import { createClientId } from "./clientId.ts";
import { wireValueEqual } from "./wireValueEqual.ts";

/**
 * How long an item fetch may stay unanswered before it fails like an
 * incomplete answer: it degrades to the snapshot instead of hanging stale.
 */
export const STATE_ITEMS_TIMEOUT_MS = 10_000;

/** The topics a digest and `getStateItems` serve, in subscribe-digest order. */
type ItemTopic = Extract<ClientMessage, { type: "getStateItems" }>["topic"];
const DIGEST_ORDER: readonly ItemTopic[] = ["tasks", "projects", "initiatives"];

/** Why an item fetch is open: a digest's catch-up, or an edit's recovery. */
export type RequestPurpose = "catchUp" | "recovery";

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

/** What a topic that asks for digests adds: when it may, and its flags. */
interface TopicDigest<State> {
  /** Whether the held objects are a baseline a digest may be diffed against. */
  baseline(state: State): boolean;
  /** Topic fields for an applied digest, on the already pruned state. */
  adoptDigest(
    state: State,
    message: StateDigestMessage,
    changedIds: readonly string[],
  ): State;
  /** Topic fields for a complete catch-up, after its events applied. */
  adoptItems(state: State): State;
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
  /**
   * The snapshot input for a list message, or `null` when the message is not
   * this topic's snapshot (a filtered Project list). `held` lets a topic keep
   * value-equal rows.
   */
  snapshot(
    message: Snapshot,
    held: TopicReplica<Item>,
  ): ReplicaSnapshot<Item> | null;
  /** Where a member this replica has not held yet goes. */
  place(items: Item[], item: Item): Item[];
  /** Topic-specific snapshot fields, applied to the already written state. */
  adoptSnapshot?(state: State, message: Snapshot): State;
  /**
   * Topic policy for the events that applied, in order, on the written state;
   * not called when none applied.
   */
  afterEvents?(state: State, applied: readonly StateEvent<Item>[]): State;
  digest?: TopicDigest<State>;
  /**
   * The snapshot resubscribe is sent only while the client holds the topic, so
   * a dropped one is never revived. Without it, it is always sent.
   */
  resubscribeOnlyWhileHeld?: boolean;
}

/**
 * The replica's own inputs beside the server messages, told apart by having no
 * `type`: an answered item fetch, and the objects whose held revision a failed
 * recovery can no longer vouch for.
 */
type ReplicaInput<Item> =
  | {
      kind: "items";
      purpose: RequestPurpose;
      events: readonly StateEvent<Item>[];
    }
  | { kind: "baselineLost"; ids: readonly string[] };

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
 * The digest ids to fetch, in entry order: those not held, or held at another
 * revision. `null` when the digest itself cannot be trusted.
 */
export function digestChanges(
  held: {
    items: readonly { id: string }[];
    revisions: Readonly<Record<string, number>>;
  },
  entries: readonly StateDigestEntry[],
): string[] | null {
  if (!revisionSidecar(entries)) return null;
  const ids = new Set(held.items.map((item) => item.id));
  return entries
    .filter(
      (entry) =>
        !ids.has(entry.id) || held.revisions[entry.id] !== entry.revision,
    )
    .map((entry) => entry.id);
}

/**
 * Drop the held objects a digest leaves out, keeping the array when none goes.
 * Held revisions survive for digest ids only and never advance to the digest's:
 * the ordinary event carrying that revision must still apply.
 */
export function pruneToDigest<Item extends { id: string }>(
  held: TopicReplica<Item>,
  entries: readonly StateDigestEntry[],
): TopicReplica<Item> {
  const live = new Set(entries.map((entry) => entry.id));
  const items = held.items.filter((item) => live.has(item.id));
  const revisions: Record<string, number> = {};
  for (const entry of entries) {
    const current = held.revisions[entry.id];
    if (current !== undefined) revisions[entry.id] = current;
  }
  return {
    items: items.length === held.items.length ? held.items : items,
    revisions,
  };
}

/** An item answer is complete iff its ids are unique and exactly the expected. */
export function itemsComplete(
  expectedIds: ReadonlySet<string>,
  events: readonly { id: string }[],
): boolean {
  const received = new Set(events.map((event) => event.id));
  return (
    received.size === events.length &&
    received.size === expectedIds.size &&
    [...expectedIds].every((id) => received.has(id))
  );
}

/**
 * Apply one replica input to a topic's fields. A batch that applies nothing
 * returns `state` itself; a value-equal echo advances only the sidecar and
 * keeps the item array and every row by identity. So does a message the topic
 * does not admit: a snapshot its descriptor refuses, or a digest without a
 * baseline or with an invalid entry list.
 */
export function applyTopicMessage<
  State,
  Item extends { id: string },
  Snapshot extends { type: string },
>(
  descriptor: TopicDescriptor<State, Item, Snapshot>,
  state: State,
  message:
    | StateEventsMessage<BroadcastTopic, Item>
    | StateDigestMessage
    | Snapshot
    | ReplicaInput<Item>,
): State {
  if (isReplicaInput(message)) {
    if (message.kind === "baselineLost")
      return forgetRevisions(descriptor, state, message.ids);
    if (message.purpose === "recovery")
      // Authoritative: the answer replaces the row even at the held revision.
      return applyBatch(
        descriptor,
        forgetRevisions(
          descriptor,
          state,
          message.events.map((event) => event.id),
        ),
        message.events,
      );
    const applied = applyBatch(descriptor, state, message.events);
    return descriptor.digest ? descriptor.digest.adoptItems(applied) : applied;
  }
  if (isEvents(message)) return applyBatch(descriptor, state, message.events);
  if (isDigest(message)) {
    const digest = descriptor.digest;
    if (!digest?.baseline(state)) return state;
    const held = descriptor.read(state);
    const changedIds = digestChanges(held, message.entries);
    if (!changedIds) return state;
    return digest.adoptDigest(
      descriptor.write(state, pruneToDigest(held, message.entries)),
      message,
      changedIds,
    );
  }
  const adopted = descriptor.snapshot(message, descriptor.read(state));
  if (!adopted) return state;
  const written = descriptor.write(state, {
    items: adopted.items,
    revisions: revisionSidecar(adopted.revisions) ?? {},
  });
  return descriptor.adoptSnapshot
    ? descriptor.adoptSnapshot(written, message)
    : written;
}

function isReplicaInput<Item>(
  message: ReplicaInput<Item> | { type: string },
): message is ReplicaInput<Item> {
  return !("type" in message);
}

function isEvents<Item>(
  message: StateEventsMessage<BroadcastTopic, Item> | { type: string },
): message is StateEventsMessage<BroadcastTopic, Item> {
  return message.type === "stateEvents";
}

function isDigest(
  message: StateDigestMessage | { type: string },
): message is StateDigestMessage {
  return message.type === "stateDigest";
}

function applyBatch<
  State,
  Item extends { id: string },
  Snapshot extends { type: string },
>(
  descriptor: TopicDescriptor<State, Item, Snapshot>,
  state: State,
  events: readonly StateEvent<Item>[],
): State {
  const current = descriptor.read(state);
  const applied: StateEvent<Item>[] = [];
  const next = applyEvents(current, events, descriptor.place, applied);
  // Compare against what `read` returned, not the state field: an absent
  // sidecar reads as a fresh `{}` every time.
  if (next === current) return state;
  const written = descriptor.write(state, next);
  return descriptor.afterEvents
    ? descriptor.afterEvents(written, applied)
    : written;
}

/** The sidecar without `ids`; `state` itself when it held none of them. */
function forgetRevisions<
  State,
  Item extends { id: string },
  Snapshot extends { type: string },
>(
  descriptor: TopicDescriptor<State, Item, Snapshot>,
  state: State,
  ids: readonly string[],
): State {
  const held = descriptor.read(state);
  if (!ids.some((id) => id in held.revisions)) return state;
  const revisions = { ...held.revisions };
  for (const id of ids) delete revisions[id];
  return descriptor.write(state, { items: held.items, revisions });
}

/**
 * Per event: apply iff its revision is above the one held for that id. The
 * events that applied are pushed onto `applied`, in order.
 */
function applyEvents<Item extends { id: string }>(
  current: TopicReplica<Item>,
  events: readonly StateEvent<Item>[],
  place: (items: Item[], item: Item) => Item[],
  applied: StateEvent<Item>[],
): TopicReplica<Item> {
  let revisions: Record<string, number> | null = null;
  let items = current.items;
  for (const event of events) {
    const known = revisions?.[event.id] ?? current.revisions[event.id] ?? -1;
    if (event.revision <= known) continue;
    revisions ??= { ...current.revisions };
    revisions[event.id] = event.revision;
    applied.push(event);
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

/** What the transport reads of a topic: its held objects and digest gate. */
interface TopicSource<State> {
  read(state: State): {
    items: readonly { id: string }[];
    revisions: Readonly<Record<string, number>>;
  };
  digest?: { baseline(state: State): boolean };
  resubscribeOnlyWhileHeld?: boolean;
}

interface ReplicaTransportConfig<State> {
  /** The topics whose `seq` and item requests this transport holds. */
  topics: Partial<Record<BroadcastTopic, TopicSource<State>>>;
  /** The Tasks digest gate, until Tasks have a descriptor of their own. */
  taskBaseline(state: State): boolean;
  /** Sends what a timer decides; synchronous answers are returned instead. */
  send(message: ClientMessage): void;
  /** Whether the client holds the topic now, for `resubscribeOnlyWhileHeld`. */
  holds(topic: BroadcastTopic): boolean;
  /** Called right before a topic is resubscribed for a snapshot. */
  onResubscribe(topic: BroadcastTopic): void;
  /** A recovery that could not complete: forget those ids' held revisions. */
  onBaselineLost(topic: ItemTopic, ids: readonly string[]): void;
}

type SubscribeMessage = Extract<ClientMessage, { type: "subscribe" }>;
type GetStateItemsMessage = Extract<ClientMessage, { type: "getStateItems" }>;

export interface ReplicaTransport<State> {
  owns(topic: BroadcastTopic): boolean;
  /**
   * The one subscribe composer. A topic asks for a digest when it declares
   * one, has no pending mutation, is not due a snapshot, and its baseline
   * holds; `digests` keeps a fixed order and is omitted when empty.
   */
  subscribeRequest(
    topics: BroadcastTopic[],
    state: State,
    pendingTopics: ReadonlySet<string>,
  ): SubscribeMessage;
  /**
   * A snapshot's `seq` is the new baseline, whatever was held before. It
   * cancels the topic's catch-up and its due snapshot; recoveries stay open.
   */
  snapshotReceived(topic: BroadcastTopic, seq: number): void;
  /**
   * The messages to send for this batch: none when it continues the last one,
   * otherwise the snapshot resubscribe. The batch itself still applies.
   */
  eventsReceived(message: StateEventsMessage): ClientMessage[];
  /**
   * Rebaselines `seq` and replaces any catch-up. `apply` is false when the
   * digest fell back, so the reducer never sees it.
   */
  digestReceived(
    message: StateDigestMessage<ItemTopic>,
    state: State,
  ): { send: ClientMessage[]; apply: boolean };
  /** Opens an edit recovery for `ids` and returns its fetch. */
  recoveryRequest(topic: ItemTopic, ids: string[]): GetStateItemsMessage;
  /** The purpose to apply a complete answer as, or `null` to drop it. */
  itemsReceived(message: StateItemsMessage<ItemTopic>): RequestPurpose | null;
  /** True when the error answers an open request, which it then fails. */
  errorReceived(message: { requestId?: string; message: string }): boolean;
  /**
   * Forgets every open request; the seqs stay. An open recovery can no longer
   * vouch for its rows, so its baseline is lost.
   */
  dropRequests(): void;
}

interface OpenRequest {
  topic: ItemTopic;
  purpose: RequestPurpose;
  expectedIds: ReadonlySet<string>;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The gap tripwire, the item-request table and the snapshot fallback for the
 * topics given. `seq` never replays anything: a batch that does not continue
 * the last one means an event was missed while subscribed, so the topic
 * resubscribes for a fresh snapshot, loudly, because silence here is silent
 * data loss. Nothing resets on disconnect; the next snapshot or digest
 * rebaselines.
 */
export function createReplicaTransport<State>(
  config: ReplicaTransportConfig<State>,
): ReplicaTransport<State> {
  const lastSeq = new Map<BroadcastTopic, number>();
  const requests = new Map<string, OpenRequest>();
  /** Topics whose next subscribe must take a snapshot, not a digest. */
  const snapshotRequired = new Set<BroadcastTopic>();

  const owns = (topic: BroadcastTopic) => config.topics[topic] !== undefined;

  /**
   * Re-subscribing a held topic answers nothing, so it is dropped first; and
   * the subscribe never carries `digests`, so the answer is a snapshot.
   */
  const resubscribeForSnapshot = (topic: BroadcastTopic): ClientMessage[] => {
    if (config.topics[topic]?.resubscribeOnlyWhileHeld && !config.holds(topic))
      return [];
    config.onResubscribe(topic);
    return [
      { type: "unsubscribe", topics: [topic] },
      { type: "subscribe", topics: [topic] },
    ];
  };

  const fallback = (
    topic: ItemTopic,
    purpose: RequestPurpose,
    reason: string,
  ): ClientMessage[] => {
    console.warn(
      `[state-sync] ${topic} ${purpose === "recovery" ? "recovery" : "digest"} fallback: ${reason}`,
    );
    return resubscribeForSnapshot(topic);
  };

  const close = (requestId: string): OpenRequest | undefined => {
    const request = requests.get(requestId);
    if (!request) return undefined;
    clearTimeout(request.timer);
    requests.delete(requestId);
    return request;
  };

  const loseBaseline = (request: OpenRequest) => {
    snapshotRequired.add(request.topic);
    config.onBaselineLost(request.topic, [...request.expectedIds]);
  };

  /** An incomplete, failed or timed-out fetch degrades to the snapshot. */
  const fail = (requestId: string, reason: string) => {
    const request = close(requestId);
    if (!request) return;
    if (request.purpose === "recovery") loseBaseline(request);
    for (const message of fallback(request.topic, request.purpose, reason))
      config.send(message);
  };

  const open = (
    topic: ItemTopic,
    purpose: RequestPurpose,
    ids: string[],
  ): GetStateItemsMessage => {
    const requestId = createClientId();
    requests.set(requestId, {
      topic,
      purpose,
      expectedIds: new Set(ids),
      timer: setTimeout(
        () => fail(requestId, "targeted item fetch timed out"),
        STATE_ITEMS_TIMEOUT_MS,
      ),
    });
    return { type: "getStateItems", topic, ids, requestId };
  };

  const cancelCatchUp = (topic: BroadcastTopic) => {
    for (const [requestId, request] of requests)
      if (request.topic === topic && request.purpose === "catchUp")
        close(requestId);
  };

  const baseline = (topic: ItemTopic, state: State) =>
    topic === "tasks"
      ? config.taskBaseline(state)
      : config.topics[topic]?.digest?.baseline(state) === true;

  return {
    owns,
    subscribeRequest(topics, state, pendingTopics) {
      const digests = DIGEST_ORDER.filter(
        (topic) =>
          topics.includes(topic) &&
          !pendingTopics.has(topic) &&
          !snapshotRequired.has(topic) &&
          baseline(topic, state),
      );
      return {
        type: "subscribe",
        topics,
        ...(digests.length ? { digests } : {}),
      };
    },
    snapshotReceived(topic, seq) {
      lastSeq.set(topic, seq);
      cancelCatchUp(topic);
      snapshotRequired.delete(topic);
    },
    eventsReceived(message) {
      const previous = lastSeq.get(message.topic);
      lastSeq.set(message.topic, message.seq);
      if (previous === undefined || message.seq === previous + 1) return [];
      console.warn(
        `[state-sync] ${message.topic} event gap: expected seq ${previous + 1}, got ${message.seq}; resubscribing.`,
      );
      return resubscribeForSnapshot(message.topic);
    },
    digestReceived(message, state) {
      const { topic } = message;
      lastSeq.set(topic, message.seq);
      cancelCatchUp(topic);
      const source = config.topics[topic];
      // The same gate and diff the reducer applies, read from the state the
      // effect last saw; a topic due a snapshot is never diffed.
      const changedIds =
        source && !snapshotRequired.has(topic) && baseline(topic, state)
          ? digestChanges(source.read(state), message.entries)
          : null;
      if (!changedIds)
        return {
          send: fallback(
            topic,
            "catchUp",
            "cached objects or revisions were invalid",
          ),
          apply: false,
        };
      return {
        send: changedIds.length ? [open(topic, "catchUp", changedIds)] : [],
        apply: true,
      };
    },
    recoveryRequest: (topic, ids) => open(topic, "recovery", ids),
    itemsReceived(message) {
      const request = requests.get(message.requestId);
      if (!request || request.topic !== message.topic) return null;
      if (!itemsComplete(request.expectedIds, message.events)) {
        fail(message.requestId, "targeted item response was incomplete");
        return null;
      }
      close(message.requestId);
      return request.purpose;
    },
    errorReceived(message) {
      // An ordinary error carries no requestId, and must never match one.
      if (!message.requestId || !requests.has(message.requestId)) return false;
      fail(message.requestId, message.message);
      return true;
    },
    dropRequests() {
      for (const requestId of [...requests.keys()]) {
        const request = close(requestId)!;
        // A dropped catch-up needs nothing: its changed ids still hold their
        // old revisions, so the next digest names them again.
        if (request.purpose === "recovery") loseBaseline(request);
      }
    },
  };
}
