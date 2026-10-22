/**
 * The replica contract against a fake topic: what a snapshot and an event batch
 * do to the fields a descriptor lends it, which object identities survive, and
 * when the transport asks to resubscribe. Each domain's own policy is tested
 * with that domain (e.g. `hooks/backgroundWorkStateSync.test.ts`).
 *   pnpm --filter @assistant/web test src/lib/stateReplica.test.ts
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BroadcastTopic,
  StateDigestEntry,
  StateEvent,
  StateEventsMessage,
} from "@assistant/shared";
import {
  applyTopicMessage,
  createReplicaTransport,
  type TopicDescriptor,
} from "./stateReplica.ts";

interface Row {
  id: string;
  label: string;
}

interface FakeState {
  rows: Row[];
  revs?: Record<string, number>;
  flag: boolean;
  other: { untouched: true };
}

interface FakeList {
  type: "fakeList";
  rows: Row[];
  revisions: StateDigestEntry[];
  flag?: boolean;
}

// The replica never reads the topic name, so the fake borrows one that carries
// no state-change events.
const TOPIC = "workflow";

const fake: TopicDescriptor<FakeState, Row, FakeList> = {
  read: (state) => ({ items: state.rows, revisions: state.revs ?? {} }),
  write: (state, replica) => ({
    ...state,
    rows: replica.items,
    revs: replica.revisions,
  }),
  snapshot: (message) => ({
    items: message.rows,
    revisions: message.revisions,
  }),
  // Appending, where Background prepends: placement is the topic's choice.
  place: (items, item) => [...items, item],
  adoptSnapshot: (state, message) => ({
    ...state,
    flag: message.flag === true,
  }),
};

const row = (id: string, label = `row ${id}`): Row => ({ id, label });

const initial = (): FakeState => ({
  rows: [],
  flag: false,
  other: { untouched: true },
});

const list = (rows: Row[], revision = 1, flag?: boolean): FakeList => ({
  type: "fakeList",
  rows,
  revisions: rows.map(({ id }) => ({ id, revision })),
  ...(flag === undefined ? {} : { flag }),
});

const batch = (
  events: StateEvent<Row>[],
  seq = 1,
  topic: BroadcastTopic = TOPIC,
): StateEventsMessage<BroadcastTopic, Row> => ({
  type: "stateEvents",
  topic,
  seq,
  events,
});

const upsert = (item: Row, revision: number): StateEvent<Row> => ({
  kind: "upsert",
  id: item.id,
  revision,
  item,
});

const remove = (id: string, revision: number): StateEvent<Row> => ({
  kind: "delete",
  id,
  revision,
});

const apply = (
  state: FakeState,
  message: FakeList | StateEventsMessage<BroadcastTopic, Row>,
) => applyTopicMessage(fake, state, message);

describe("the replica data half", () => {
  it("adopts a snapshot as given and runs the snapshot hook on the written state", () => {
    const a = row("a");
    const b = row("b");
    const state = apply(initial(), list([a, b], 3, true));
    expect(state.rows).toEqual([a, b]);
    expect(state.rows[0]).toBe(a);
    expect(state.revs).toEqual({ a: 3, b: 3 });
    expect(state.flag).toBe(true);

    // An untrustworthy sidecar adopts the rows with no revisions at all.
    const invalid = apply(initial(), {
      type: "fakeList",
      rows: [a],
      revisions: [
        { id: "a", revision: 1 },
        { id: "a", revision: 2 },
      ],
    });
    expect(invalid.rows).toEqual([a]);
    expect(invalid.revs).toEqual({});
    expect(invalid.flag).toBe(false);
  });

  it("returns the identical state for a batch that applies nothing", () => {
    const seeded = apply(initial(), list([row("a")], 2));
    const stale = apply(
      seeded,
      batch([upsert(row("a", "stale"), 2), remove("a", 1)]),
    );
    expect(stale).toBe(seeded);

    // An absent sidecar reads as a fresh `{}`; that must not defeat the no-op.
    const bare = initial();
    expect(apply(bare, batch([]))).toBe(bare);
  });

  it("advances only the revision for a value-equal echo", () => {
    const a = row("a");
    const b = row("b");
    const seeded = apply(initial(), list([a, b]));
    const next = apply(seeded, batch([upsert({ ...a }, 2)]));
    expect(next).not.toBe(seeded);
    expect(next.revs).toEqual({ a: 2, b: 1 });
    expect(next.rows).toBe(seeded.rows);
    expect(next.rows[0]).toBe(a);
    expect(next.rows[1]).toBe(b);
  });

  it("replaces only the changed row", () => {
    const a = row("a");
    const b = row("b");
    const seeded = apply(initial(), list([a, b]));
    const next = apply(seeded, batch([upsert(row("b", "changed"), 2)]));
    expect(next.rows).not.toBe(seeded.rows);
    expect(next.rows[0]).toBe(a);
    expect(next.rows[1]).toEqual(row("b", "changed"));
    expect(next.revs).toEqual({ a: 1, b: 2 });
  });

  it("places a row it has not held through the descriptor", () => {
    const seeded = apply(initial(), list([row("a")]));
    const next = apply(seeded, batch([upsert(row("c"), 1)]));
    expect(next.rows.map(({ id }) => id)).toEqual(["a", "c"]);
    expect(next.revs).toEqual({ a: 1, c: 1 });
  });

  it("removes a deleted row and remembers the revision even when it was absent", () => {
    const seeded = apply(initial(), list([row("a")]));
    const removed = apply(seeded, batch([remove("a", 2)]));
    expect(removed.rows).toEqual([]);
    expect(removed.revs).toEqual({ a: 2 });

    const absent = apply(seeded, batch([remove("z", 4)]));
    expect(absent.rows).toBe(seeded.rows);
    expect(absent.revs).toEqual({ a: 1, z: 4 });
  });

  it("judges a later event in one batch against the earlier one's revision", () => {
    const seeded = apply(initial(), list([row("a")]));
    const next = apply(
      seeded,
      batch([
        upsert(row("a", "second"), 3),
        upsert(row("a", "older"), 2),
        remove("a", 3),
      ]),
    );
    expect(next.rows).toEqual([row("a", "second")]);
    expect(next.revs).toEqual({ a: 3 });
  });

  it("keeps every slice it does not own by reference", () => {
    const start = initial();
    const snapshotted = apply(start, list([row("a")]));
    expect(snapshotted.other).toBe(start.other);
    const evented = apply(snapshotted, batch([upsert(row("b"), 1)]));
    expect(evented.other).toBe(start.other);
  });
});

describe("the replica transport", () => {
  afterEach(() => vi.restoreAllMocks());

  const warnSpy = () => vi.spyOn(console, "warn").mockImplementation(() => {});

  it("stays quiet without a baseline and while batches continue", () => {
    const warn = warnSpy();
    const transport = createReplicaTransport([TOPIC]);
    expect(transport.eventsReceived(batch([], 7))).toEqual([]);
    expect(transport.eventsReceived(batch([], 8))).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("asks to resubscribe on a gap, loudly, and baselines on the new seq", () => {
    const warn = warnSpy();
    const transport = createReplicaTransport([TOPIC]);
    transport.eventsReceived(batch([], 4));
    expect(transport.eventsReceived(batch([], 6))).toEqual([
      { type: "unsubscribe", topics: [TOPIC] },
      { type: "subscribe", topics: [TOPIC] },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `[state-sync] ${TOPIC} event gap: expected seq 5, got 6; resubscribing.`,
    );
    expect(transport.eventsReceived(batch([], 7))).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("takes a snapshot's seq as the baseline over any held one", () => {
    const warn = warnSpy();
    const transport = createReplicaTransport([TOPIC]);
    transport.eventsReceived(batch([], 4));
    transport.snapshotReceived(TOPIC, 10);
    // Without the rebaseline, 11 would be judged against 5.
    expect(transport.eventsReceived(batch([], 11))).toEqual([]);
    expect(warn).not.toHaveBeenCalled();

    const fresh = createReplicaTransport([TOPIC]);
    fresh.snapshotReceived(TOPIC, 3);
    expect(fresh.eventsReceived(batch([], 5))).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("owns only the topics it was given and keeps their seqs apart", () => {
    warnSpy();
    const transport = createReplicaTransport([TOPIC, "usage"]);
    expect(transport.owns(TOPIC)).toBe(true);
    expect(transport.owns("usage")).toBe(true);
    expect(transport.owns("tasks")).toBe(false);
    transport.snapshotReceived(TOPIC, 1);
    transport.snapshotReceived("usage", 20);
    expect(transport.eventsReceived(batch([], 2, TOPIC))).toEqual([]);
    expect(transport.eventsReceived(batch([], 21, "usage"))).toEqual([]);
  });
});
