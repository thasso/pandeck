/**
 * The replica contract against a fake topic: what a snapshot, an event batch, a
 * digest and an item answer do to the fields a descriptor lends it, which
 * object identities survive, and what the transport sends: the gap and failure
 * resubscribe, the item fetches it tracks, and the one subscribe composer. Each
 * domain's own policy is tested with that domain (e.g.
 * `hooks/backgroundWorkStateSync.test.ts`, `hooks/initiativeStateSync.test.ts`).
 *   pnpm --filter @assistant/web test src/lib/stateReplica.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BroadcastTopic,
  ClientMessage,
  StateDigestEntry,
  StateDigestMessage,
  StateEvent,
  StateEventsMessage,
} from "@assistant/shared";
import {
  applyTopicMessage,
  createReplicaTransport,
  STATE_ITEMS_TIMEOUT_MS,
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
  /** The digest descriptor's baseline answer. */
  safe?: boolean;
  /** What the digest hooks were last told. */
  digested?: readonly string[];
  itemsAdopted?: boolean;
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

/**
 * A topic that asks for digests, with every hook recording what it saw, and is
 * resubscribed only while held.
 */
const afterEventsSpy = vi.fn(
  (state: FakeState, _applied: readonly StateEvent<Row>[]) => state,
);
const digestFake: TopicDescriptor<FakeState, Row, FakeList> = {
  ...fake,
  afterEvents: (state, applied) => afterEventsSpy(state, applied),
  digest: {
    baseline: (state) => state.safe === true,
    adoptDigest: (state, _message, changedIds) => ({
      ...state,
      digested: changedIds,
    }),
    adoptItems: (state) => ({ ...state, itemsAdopted: true }),
  },
  resubscribeOnlyWhileHeld: true,
};

const digest = (
  entries: StateDigestEntry[],
  seq = 1,
  topic: "projects" | "initiatives" = "projects",
): StateDigestMessage<"projects" | "initiatives"> => ({
  type: "stateDigest",
  topic,
  seq,
  entries,
});

const at = (id: string, revision: number): StateDigestEntry => ({
  id,
  revision,
});

describe("the replica data half: digests, item answers and lost baselines", () => {
  beforeEach(() => afterEventsSpy.mockClear());

  const seeded = (rows: Row[], revision = 1): FakeState => ({
    ...applyTopicMessage(digestFake, initial(), list(rows, revision)),
    safe: true,
  });

  it("returns the identical state for a snapshot the descriptor refuses", () => {
    const refusing: TopicDescriptor<FakeState, Row, FakeList> = {
      ...fake,
      snapshot: () => null,
    };
    const start = seeded([row("a")]);
    expect(applyTopicMessage(refusing, start, list([row("b")]))).toBe(start);
  });

  it("prunes what a digest leaves out, keeps held rows and never advances revisions", () => {
    const [a, b, c] = [row("a"), row("b"), row("c")];
    const start = seeded([a, b, c]);
    const next = applyTopicMessage(digestFake, start, {
      ...digest([at("c", 2), at("a", 1), at("d", 1)]),
    });
    expect(next.rows).toEqual([a, c]);
    expect(next.rows[0]).toBe(a);
    expect(next.rows[1]).toBe(c);
    // `c` keeps the revision held, `d` gets none: their events still apply.
    expect(next.revs).toEqual({ a: 1, c: 1 });
    expect(next.digested).toEqual(["c", "d"]);

    const unchanged = applyTopicMessage(
      digestFake,
      start,
      digest([at("a", 1), at("b", 1), at("c", 1)]),
    );
    expect(unchanged).not.toBe(start);
    expect(unchanged.rows).toBe(start.rows);
    expect(unchanged.digested).toEqual([]);
  });

  it("returns the identical state for a digest without a baseline or with an invalid entry list", () => {
    const start = seeded([row("a")]);
    const unsafe = { ...start, safe: false };
    expect(applyTopicMessage(digestFake, unsafe, digest([]))).toBe(unsafe);
    expect(
      applyTopicMessage(digestFake, start, digest([at("a", 1), at("a", 2)])),
    ).toBe(start);
    // A topic that declares no digest never takes one.
    expect(applyTopicMessage(fake, start, digest([]))).toBe(start);
  });

  it("applies catch-up items as a batch, then sets the topic's flags even when all were stale", () => {
    const start = seeded([row("a")], 3);
    const stale = applyTopicMessage(digestFake, start, {
      kind: "items",
      purpose: "catchUp",
      events: [upsert(row("a", "older"), 2)],
    });
    expect(stale.rows).toBe(start.rows);
    expect(stale.itemsAdopted).toBe(true);
    expect(afterEventsSpy).not.toHaveBeenCalled();

    const fresh = applyTopicMessage(digestFake, start, {
      kind: "items",
      purpose: "catchUp",
      events: [upsert(row("a", "newer"), 4)],
    });
    expect(fresh.rows).toEqual([row("a", "newer")]);
    expect(fresh.revs).toEqual({ a: 4 });
    expect(fresh.itemsAdopted).toBe(true);
  });

  it("applies recovery items over the held revision and sets no flags", () => {
    const start = seeded([row("a", "optimistic"), row("b")]);
    const next = applyTopicMessage(digestFake, start, {
      kind: "items",
      purpose: "recovery",
      events: [upsert(row("a", "restored"), 1)],
    });
    expect(next.rows[0]).toEqual(row("a", "restored"));
    expect(next.rows[1]).toBe(start.rows[1]);
    expect(next.revs).toEqual({ a: 1, b: 1 });
    expect(next.itemsAdopted).toBeUndefined();
  });

  it("tells the topic exactly the events that applied, in order, and nothing for a stale batch", () => {
    const start = seeded([row("a"), row("b")], 2);
    const first = upsert(row("c"), 1);
    const second = remove("a", 3);
    applyTopicMessage(
      digestFake,
      start,
      batch([first, upsert(row("b", "stale"), 2), second]),
    );
    expect(afterEventsSpy).toHaveBeenCalledTimes(1);
    expect(afterEventsSpy.mock.calls[0]![1]).toEqual([first, second]);

    afterEventsSpy.mockClear();
    expect(applyTopicMessage(digestFake, start, batch([remove("a", 1)]))).toBe(
      start,
    );
    expect(afterEventsSpy).not.toHaveBeenCalled();
  });

  it("forgets exactly the named revisions when a baseline is lost, keeping every row", () => {
    const start = seeded([row("a"), row("b")]);
    const next = applyTopicMessage(digestFake, start, {
      kind: "baselineLost",
      ids: ["a", "z"],
    });
    expect(next.revs).toEqual({ b: 1 });
    expect(next.rows).toBe(start.rows);
    expect(
      applyTopicMessage(digestFake, start, {
        kind: "baselineLost",
        ids: ["z"],
      }),
    ).toBe(start);
  });
});

describe("the replica data half: the held replica and settles", () => {
  const seeded = (rows: Row[]): FakeState => ({
    ...applyTopicMessage(digestFake, initial(), list(rows)),
    safe: true,
  });

  it("hands each adopt hook the replica held before the write", () => {
    const seen: Array<[string, Row[]]> = [];
    const watching: TopicDescriptor<FakeState, Row, FakeList> = {
      ...digestFake,
      adoptSnapshot: (state, _message, held) => {
        seen.push(["snapshot", held.items]);
        return state;
      },
      afterEvents: (state, _applied, held) => {
        seen.push(["events", held.items]);
        return state;
      },
      digest: {
        ...digestFake.digest!,
        adoptDigest: (state, _message, _changedIds, held) => {
          seen.push(["digest", held.items]);
          return state;
        },
      },
    };
    const start = seeded([row("a"), row("b")]);
    const results = [
      applyTopicMessage(watching, start, list([row("c")])),
      applyTopicMessage(watching, start, batch([upsert(row("c"), 2)])),
      applyTopicMessage(watching, start, digest([at("a", 1)])),
    ];
    expect(seen.map(([path]) => path)).toEqual([
      "snapshot",
      "events",
      "digest",
    ]);
    for (const [index, [, items]] of seen.entries()) {
      expect(items).toBe(start.rows);
      expect(results[index]!.rows).not.toBe(start.rows);
    }
  });

  it("routes a settled input to the topic's settle hook alone", () => {
    const settle = vi.fn((state: FakeState, settled: { item: Row | null }) => ({
      ...state,
      rows: settled.item ? [settled.item] : [],
    }));
    const start = seeded([row("tmp")]);
    const input = {
      kind: "settled",
      localId: "tmp",
      id: "a",
      item: row("a", "saved"),
    } as const;
    afterEventsSpy.mockClear();
    const next = applyTopicMessage({ ...digestFake, settle }, start, input);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0]![1]).toEqual(input);
    expect(next).toBe(settle.mock.results[0]!.value);
    // Revisions belong to events: nothing generic runs, and no sidecar moves.
    expect(next.revs).toBe(start.revs);
    expect(afterEventsSpy).not.toHaveBeenCalled();
    expect(applyTopicMessage(digestFake, start, input)).toBe(start);
  });
});

describe("the replica transport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const warnSpy = () => vi.spyOn(console, "warn").mockImplementation(() => {});

  /**
   * A transport over a fake topic, `usage` and three digest-capable topics;
   * `tasks` reads its baseline from `flag`.
   */
  function harness() {
    const log: string[] = [];
    const sent: ClientMessage[] = [];
    const lost: Array<[BroadcastTopic, readonly string[]]> = [];
    const held = new Set<BroadcastTopic>([
      TOPIC,
      "usage",
      "tasks",
      "projects",
      "initiatives",
    ]);
    const transport = createReplicaTransport<FakeState>({
      topics: {
        [TOPIC]: fake,
        usage: fake,
        tasks: {
          read: fake.read,
          digest: { baseline: (state: FakeState) => state.flag },
          resubscribeOnlyWhileHeld: true,
        },
        projects: digestFake,
        initiatives: digestFake,
      },
      send: (message) => {
        sent.push(message);
        log.push(`send ${message.type}`);
      },
      holds: (topic) => held.has(topic),
      onResubscribe: (topic) => log.push(`resubscribe ${topic}`),
      onBaselineLost: (topic, ids) => lost.push([topic, ids]),
    });
    return { transport, sent, lost, held, log };
  }

  const safe = (rows: Row[] = [row("a")]): FakeState => ({
    ...applyTopicMessage(digestFake, initial(), list(rows)),
    safe: true,
    flag: true,
  });

  const pair = (topic: BroadcastTopic) => [
    { type: "unsubscribe", topics: [topic] },
    { type: "subscribe", topics: [topic] },
  ];

  /** Open a catch-up for `ids` (held at revision 1, now at 2) and return it. */
  function catchUp(
    transport: ReturnType<typeof harness>["transport"],
    ids: string[],
    topic: "projects" | "initiatives" = "projects",
  ) {
    const answer = transport.digestReceived(
      digest(
        ids.map((id) => at(id, 2)),
        1,
        topic,
      ),
      safe(ids.map((id) => row(id))),
    );
    const fetch = answer.send[0];
    if (fetch?.type !== "getStateItems") throw new Error("no item fetch");
    return fetch;
  }

  describe("the gap tripwire", () => {
    it("stays quiet without a baseline and while batches continue", () => {
      const warn = warnSpy();
      const { transport } = harness();
      expect(transport.eventsReceived(batch([], 7))).toEqual([]);
      expect(transport.eventsReceived(batch([], 8))).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });

    it("asks to resubscribe on a gap, loudly, and baselines on the new seq", () => {
      const warn = warnSpy();
      const { transport } = harness();
      transport.eventsReceived(batch([], 4));
      expect(transport.eventsReceived(batch([], 6))).toEqual(pair(TOPIC));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        `[state-sync] ${TOPIC} event gap: expected seq 5, got 6; resubscribing.`,
      );
      expect(transport.eventsReceived(batch([], 7))).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("never asks a gap's snapshot for a digest, even over a safe baseline", () => {
      warnSpy();
      const { transport, log } = harness();
      transport.snapshotReceived("projects", 1);
      expect(transport.eventsReceived(batch([], 3, "projects"))).toEqual(
        pair("projects"),
      );
      expect(log).toEqual(["resubscribe projects"]);
    });

    it("takes a snapshot's seq as the baseline over any held one", () => {
      const warn = warnSpy();
      const { transport } = harness();
      transport.eventsReceived(batch([], 4));
      transport.snapshotReceived(TOPIC, 10);
      // Without the rebaseline, 11 would be judged against 5.
      expect(transport.eventsReceived(batch([], 11))).toEqual([]);
      expect(warn).not.toHaveBeenCalled();

      const fresh = harness().transport;
      fresh.snapshotReceived(TOPIC, 3);
      expect(fresh.eventsReceived(batch([], 5))).toHaveLength(2);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("owns only the topics it was given and keeps their seqs apart", () => {
      warnSpy();
      const { transport } = harness();
      expect(transport.owns(TOPIC)).toBe(true);
      expect(transport.owns("usage")).toBe(true);
      expect(transport.owns("tasks")).toBe(true);
      expect(transport.owns("background")).toBe(false);
      transport.snapshotReceived(TOPIC, 1);
      transport.snapshotReceived("usage", 20);
      expect(transport.eventsReceived(batch([], 2, TOPIC))).toEqual([]);
      expect(transport.eventsReceived(batch([], 21, "usage"))).toEqual([]);
    });

    it("does not revive an unheld topic that resubscribes only while held", () => {
      const warn = warnSpy();
      const { transport, held, log } = harness();
      held.delete("projects");
      transport.snapshotReceived("projects", 1);
      expect(transport.eventsReceived(batch([], 3, "projects"))).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(log).toEqual([]);
    });

    it("resubscribes any other topic on a gap, held or not", () => {
      const warn = warnSpy();
      const { transport, held, log } = harness();
      held.delete(TOPIC);
      transport.snapshotReceived(TOPIC, 1);
      expect(transport.eventsReceived(batch([], 3))).toEqual(pair(TOPIC));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(log).toEqual([`resubscribe ${TOPIC}`]);
    });
  });

  describe("the item-request table", () => {
    it("fetches a digest's changed ids, and nothing when none changed", () => {
      const { transport } = harness();
      const fetch = catchUp(transport, ["a", "b"]);
      expect(fetch).toEqual({
        type: "getStateItems",
        topic: "projects",
        ids: ["a", "b"],
        requestId: expect.any(String),
      });
      expect(
        transport.digestReceived(digest([at("a", 1)]), safe([row("a")])),
      ).toEqual({ send: [], apply: true });
    });

    it("replaces a catch-up with a newer digest's, dropping the first answer", () => {
      const { transport, sent } = harness();
      const first = catchUp(transport, ["a"]);
      const second = catchUp(transport, ["b"]);
      expect(second.requestId).not.toBe(first.requestId);
      expect(
        transport.itemsReceived({
          type: "stateItems",
          topic: "projects",
          requestId: first.requestId,
          events: [upsert(row("a"), 2)],
        }),
      ).toBeNull();
      expect(sent).toEqual([]);
    });

    it("tags a complete answer with its purpose and closes it", () => {
      vi.useFakeTimers();
      const { transport, sent } = harness();
      const fetch = catchUp(transport, ["a"]);
      const recovery = transport.recoveryRequest("projects", ["b"]);
      expect(
        transport.itemsReceived({
          type: "stateItems",
          topic: "projects",
          requestId: fetch.requestId,
          events: [upsert(row("a"), 2)],
        }),
      ).toBe("catchUp");
      expect(
        transport.itemsReceived({
          type: "stateItems",
          topic: "projects",
          requestId: recovery.requestId,
          events: [upsert(row("b"), 2)],
        }),
      ).toBe("recovery");
      vi.advanceTimersByTime(STATE_ITEMS_TIMEOUT_MS);
      expect(sent).toEqual([]);
    });

    it("drops an answer to no open request and sends nothing", () => {
      const { transport, sent } = harness();
      catchUp(transport, ["a"]);
      expect(
        transport.itemsReceived({
          type: "stateItems",
          topic: "projects",
          requestId: "unknown",
          events: [upsert(row("a"), 2)],
        }),
      ).toBeNull();
      expect(sent).toEqual([]);
    });

    it.each([
      ["missing", []],
      ["duplicate", [upsert(row("a"), 2), upsert(row("a"), 2)]],
      ["extra", [upsert(row("a"), 2), upsert(row("z"), 2)]],
    ])(
      "falls back to the digest-less resubscribe for an answer with a %s id",
      (_label, events) => {
        const warn = warnSpy();
        const { transport, sent, lost } = harness();
        const fetch = catchUp(transport, ["a"]);
        expect(
          transport.itemsReceived({
            type: "stateItems",
            topic: "projects",
            requestId: fetch.requestId,
            events,
          }),
        ).toBeNull();
        expect(sent).toEqual(pair("projects"));
        expect(warn).toHaveBeenCalledWith(
          "[state-sync] projects digest fallback: targeted item response was incomplete",
        );
        expect(lost).toEqual([]);
      },
    );

    it("consumes an error stamped with an open request and fails it; others pass", () => {
      const warn = warnSpy();
      const { transport, sent } = harness();
      expect(transport.errorReceived({ message: "Unaddressed" })).toBe(false);
      const fetch = catchUp(transport, ["a"]);
      expect(
        transport.errorReceived({ requestId: "other", message: "Other" }),
      ).toBe(false);
      expect(sent).toEqual([]);
      expect(
        transport.errorReceived({
          requestId: fetch.requestId,
          message: "Lookup failed",
        }),
      ).toBe(true);
      expect(sent).toEqual(pair("projects"));
      expect(warn).toHaveBeenCalledWith(
        "[state-sync] projects digest fallback: Lookup failed",
      );
    });

    it("fails an unanswered fetch at the timeout, not before", () => {
      vi.useFakeTimers();
      const warn = warnSpy();
      const { transport, sent } = harness();
      catchUp(transport, ["a"]);
      vi.advanceTimersByTime(STATE_ITEMS_TIMEOUT_MS - 1);
      expect(sent).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(sent).toEqual(pair("projects"));
      expect(warn).toHaveBeenCalledWith(
        "[state-sync] projects digest fallback: targeted item fetch timed out",
      );
    });

    it("lets a snapshot cancel its topic's catch-up but not a recovery", () => {
      vi.useFakeTimers();
      const warn = warnSpy();
      const { transport, sent, lost } = harness();
      catchUp(transport, ["a"]);
      transport.recoveryRequest("projects", ["b"]);
      transport.snapshotReceived("projects", 7);
      vi.advanceTimersByTime(STATE_ITEMS_TIMEOUT_MS);
      expect(sent).toEqual(pair("projects"));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "[state-sync] projects recovery fallback: targeted item fetch timed out",
      );
      expect(lost).toEqual([["projects", ["b"]]]);
    });

    it("resubscribes only a held topic, telling the client first", () => {
      warnSpy();
      const { transport, sent, held, log } = harness();
      held.delete("projects");
      const unheld = catchUp(transport, ["a"]);
      transport.errorReceived({ requestId: unheld.requestId, message: "x" });
      expect(sent).toEqual([]);

      const fetch = catchUp(transport, ["a"], "initiatives");
      transport.errorReceived({ requestId: fetch.requestId, message: "x" });
      expect(log).toEqual([
        "resubscribe initiatives",
        "send unsubscribe",
        "send subscribe",
      ]);
    });

    it("drops every open request and timer on teardown, keeping the seqs", () => {
      vi.useFakeTimers();
      const warn = warnSpy();
      const { transport, sent } = harness();
      transport.snapshotReceived("projects", 4);
      catchUp(transport, ["a"]);
      transport.recoveryRequest("initiatives", ["b"]);
      transport.dropRequests();
      vi.advanceTimersByTime(STATE_ITEMS_TIMEOUT_MS);
      expect(sent).toEqual([]);
      // The digest rebaselined the seq to 1; teardown left it.
      expect(transport.eventsReceived(batch([], 2, "projects"))).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("a recovery that cannot complete", () => {
    it.each([true, false])(
      "loses its baseline (held: %s) until a snapshot re-seeds the topic",
      (isHeld) => {
        warnSpy();
        const { transport, sent, lost, held } = harness();
        if (!isHeld) held.delete("projects");
        const recovery = transport.recoveryRequest("projects", ["a", "b"]);
        transport.itemsReceived({
          type: "stateItems",
          topic: "projects",
          requestId: recovery.requestId,
          events: [upsert(row("a"), 2)],
        });
        expect(lost).toEqual([["projects", ["a", "b"]]]);
        expect(sent).toEqual(isHeld ? pair("projects") : []);

        const state = safe();
        expect(
          transport.subscribeRequest(["projects"], state, new Set()),
        ).toEqual({ type: "subscribe", topics: ["projects"] });
        // A digest that raced the failure is never diffed either.
        expect(
          transport.digestReceived(digest([at("a", 1)]), state).apply,
        ).toBe(false);
        transport.snapshotReceived("projects", 9);
        expect(
          transport.subscribeRequest(["projects"], state, new Set()),
        ).toEqual({
          type: "subscribe",
          topics: ["projects"],
          digests: ["projects"],
        });
      },
    );

    it("loses its baseline when torn down open, where a catch-up does not", () => {
      const { transport, lost } = harness();
      catchUp(transport, ["a"], "initiatives");
      transport.recoveryRequest("projects", ["b"]);
      transport.dropRequests();
      expect(lost).toEqual([["projects", ["b"]]]);
      const state = safe();
      expect(
        transport.subscribeRequest(
          ["projects", "initiatives"],
          state,
          new Set(),
        ),
      ).toEqual({
        type: "subscribe",
        topics: ["projects", "initiatives"],
        digests: ["initiatives"],
      });
    });
  });

  describe("the mutation resync", () => {
    const tasksDigest = (
      entries: StateDigestEntry[],
      seq = 1,
    ): StateDigestMessage<"tasks"> => ({
      type: "stateDigest",
      topic: "tasks",
      seq,
      entries,
    });

    it("sends the snapshot pair while held, silently, forgetting the ids", () => {
      const warn = warnSpy();
      const { transport, lost, log, sent } = harness();
      expect(transport.resync("tasks", ["a"])).toEqual(pair("tasks"));
      expect(lost).toEqual([["tasks", ["a"]]]);
      expect(log).toEqual(["resubscribe tasks"]);
      expect(sent).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });

    it("joins a pair still awaiting its answer, and still forgets the ids", () => {
      const { transport, lost, log } = harness();
      transport.resync("tasks", ["a"]);
      expect(transport.resync("tasks", ["b"])).toEqual([]);
      expect(lost).toEqual([
        ["tasks", ["a"]],
        ["tasks", ["b"]],
      ]);
      expect(log).toEqual(["resubscribe tasks"]);
    });

    it("sends a fresh pair once the awaited one was answered or dropped", () => {
      warnSpy();
      const { transport } = harness();
      transport.resync("tasks", ["a"]);
      transport.snapshotReceived("tasks", 1);
      expect(transport.resync("tasks", ["a"])).toEqual(pair("tasks"));
      transport.dropRequests();
      expect(transport.resync("tasks", ["a"])).toEqual(pair("tasks"));
    });

    it("joins a gap's pair as well", () => {
      warnSpy();
      const { transport, lost } = harness();
      transport.snapshotReceived("tasks", 1);
      expect(transport.eventsReceived(batch([], 3, "tasks"))).toEqual(
        pair("tasks"),
      );
      expect(transport.resync("tasks", ["a"])).toEqual([]);
      expect(lost).toEqual([["tasks", ["a"]]]);
    });

    it("ends the wait on a digest too, which a resync's due snapshot never diffs", () => {
      warnSpy();
      const { transport } = harness();
      const state = safe();
      // A gap pair awaits its answer without making the topic due a snapshot.
      transport.snapshotReceived("tasks", 1);
      expect(transport.eventsReceived(batch([], 3, "tasks"))).toEqual(
        pair("tasks"),
      );
      expect(
        transport.digestReceived(tasksDigest([at("a", 1)], 4), state).apply,
      ).toBe(true);
      expect(transport.resync("tasks", ["a"])).toEqual(pair("tasks"));
      // That resync made `tasks` due a snapshot: a digest answering it falls
      // back with a pair of its own, which the next resync joins.
      expect(
        transport.digestReceived(tasksDigest([at("a", 1)], 5), state),
      ).toEqual({ send: pair("tasks"), apply: false });
      expect(transport.resync("tasks", ["a"])).toEqual([]);
    });

    it("sends nothing while unheld, leaving the topic due a snapshot", () => {
      const { transport, lost, log, held } = harness();
      const state = safe();
      held.delete("tasks");
      expect(transport.resync("tasks", ["a"])).toEqual([]);
      expect(lost).toEqual([["tasks", ["a"]]]);
      expect(log).toEqual([]);
      expect(transport.subscribeRequest(["tasks"], state, new Set())).toEqual({
        type: "subscribe",
        topics: ["tasks"],
      });
      transport.snapshotReceived("tasks", 1);
      expect(transport.subscribeRequest(["tasks"], state, new Set())).toEqual({
        type: "subscribe",
        topics: ["tasks"],
        digests: ["tasks"],
      });
    });

    it("forgets nothing for a mutation without ids", () => {
      const { transport, lost } = harness();
      expect(transport.resync("tasks", [])).toEqual(pair("tasks"));
      expect(lost).toEqual([]);
    });

    it("releases only the wait when the awaited snapshot read fails", () => {
      vi.useFakeTimers();
      const warn = warnSpy();
      const { transport, sent, lost, log } = harness();
      const state = safe();
      // Without a wait it is a no-op.
      transport.snapshotFailed("projects");
      expect(
        transport.subscribeRequest(["projects"], state, new Set()),
      ).toEqual({
        type: "subscribe",
        topics: ["projects"],
        digests: ["projects"],
      });

      expect(transport.resync("tasks", ["a"])).toEqual(pair("tasks"));
      lost.length = 0;
      log.length = 0;
      expect(transport.snapshotFailed("tasks")).toBeUndefined();
      vi.advanceTimersByTime(STATE_ITEMS_TIMEOUT_MS + 1);
      // No retry: nothing sent, resubscribed or forgotten, now or later.
      expect(sent).toEqual([]);
      expect(log).toEqual([]);
      expect(lost).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      // Still due a snapshot.
      expect(transport.subscribeRequest(["tasks"], state, new Set())).toEqual({
        type: "subscribe",
        topics: ["tasks"],
      });
      // The next failure sends its own pair.
      expect(transport.resync("tasks", ["b"])).toEqual(pair("tasks"));
      transport.snapshotReceived("tasks", 1);
      expect(transport.subscribeRequest(["tasks"], state, new Set())).toEqual({
        type: "subscribe",
        topics: ["tasks"],
        digests: ["tasks"],
      });
    });
  });

  describe("the subscribe composer", () => {
    it("names topics only when none asks for a digest", () => {
      const { transport } = harness();
      expect(
        transport.subscribeRequest([TOPIC, "usage"], safe(), new Set()),
      ).toEqual({ type: "subscribe", topics: [TOPIC, "usage"] });
    });

    it("leaves out a topic whose baseline fails or that has a pending mutation", () => {
      const { transport } = harness();
      expect(
        transport.subscribeRequest(
          ["projects"],
          { ...safe(), safe: false },
          new Set(),
        ),
      ).toEqual({ type: "subscribe", topics: ["projects"] });
      expect(
        transport.subscribeRequest(
          ["tasks", "projects"],
          safe(),
          new Set(["projects"]),
        ),
      ).toEqual({
        type: "subscribe",
        topics: ["tasks", "projects"],
        digests: ["tasks"],
      });
    });

    it("orders digests tasks, projects, initiatives whatever the topic order", () => {
      const { transport } = harness();
      const topics: BroadcastTopic[] = [
        "initiatives",
        TOPIC,
        "projects",
        "tasks",
      ];
      expect(transport.subscribeRequest(topics, safe(), new Set())).toEqual({
        type: "subscribe",
        topics,
        digests: ["tasks", "projects", "initiatives"],
      });
    });

    it("never asks for a workflow digest", () => {
      const { transport } = harness();
      expect(
        transport.subscribeRequest(["workflow"], safe(), new Set()),
      ).toEqual({ type: "subscribe", topics: ["workflow"] });
    });

    it("takes a snapshot only for the topic that is due one", () => {
      warnSpy();
      const { transport } = harness();
      const recovery = transport.recoveryRequest("projects", ["a"]);
      transport.errorReceived({ requestId: recovery.requestId, message: "x" });
      expect(
        transport.subscribeRequest(
          ["tasks", "projects", "initiatives"],
          safe(),
          new Set(),
        ),
      ).toEqual({
        type: "subscribe",
        topics: ["tasks", "projects", "initiatives"],
        digests: ["tasks", "initiatives"],
      });
    });
  });
});
