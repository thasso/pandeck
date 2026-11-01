/**
 * The state topic kernel's contract (`docs/state-sync.md`, Server contract),
 * once for every topic that runs on it: publishing against an in-memory fake
 * topic, and the change set against the real test database. Domains keep only
 * "this write reports these ids" and their summary projection.
 *   pnpm --filter @assistant/server exec vitest run src/stateTopicKernel.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { BroadcastTopic, StateEventsMessage } from "@assistant/shared";
import {
  setStateChangeSink,
  touchStateTopic,
  withChangeSet,
  type StateTopicWrites,
} from "./db/changeSet.ts";
import { getDb, withDbTransaction } from "./db/index.ts";
import {
  createStateTopic,
  failOnStateTopicInvariantsForTests,
  isStateTopicInvariant,
  StateTopicInvariantError,
  takeStateTopicInvariantsForTests,
} from "./stateTopicKernel.ts";

const DEBOUNCE_MS = 25;

interface FakeRow {
  revision: number;
  live: boolean;
  summary?: string;
  /** Batch summaries answer `null`: a candidate live row that is no member. */
  member?: false;
}

type LogEntry =
  | { type: "frame"; message: StateEventsMessage<"tasks", string> }
  | { type: "listener"; name: string };

/**
 * A topic whose rows live in a map, attached to a broadcaster that logs.
 * `batch` declares the `summaries` hook; `faults` makes a read or a frame send
 * throw; `calls` records every summary read.
 */
function fakeTopic(
  options: {
    batchMax?: number;
    digest?: boolean;
    attach?: boolean;
    batch?: boolean;
  } = {},
) {
  const rows = new Map<string, FakeRow>();
  const log: LogEntry[] = [];
  const calls = { summary: [] as string[], summaries: [] as string[][] };
  const faults: {
    read?: (() => void) | undefined;
    send?: ((seq: number) => void) | undefined;
  } = {};
  const base = {
    topic: "tasks" as const,
    revisions: (ids: readonly string[]) => {
      faults.read?.();
      return new Map(
        ids.flatMap((id) => {
          const row = rows.get(id);
          return row
            ? [[id, { revision: row.revision, live: row.live }] as const]
            : [];
        }),
      );
    },
    summary: (id: string) => {
      calls.summary.push(id);
      return rows.get(id)?.summary;
    },
    ...(options.batch && {
      summaries: (ids: readonly string[]) => {
        calls.summaries.push([...ids]);
        const items = new Map<string, string | null>();
        for (const id of ids) {
          const row = rows.get(id);
          if (row?.member === false) items.set(id, null);
          else if (row?.summary !== undefined) items.set(id, row.summary);
        }
        return items;
      },
    }),
    snapshot: (seq: number) => ({ type: "fakeSnapshot" as const, seq }),
    batchMax: options.batchMax ?? 200,
  };
  const kernel = options.digest
    ? createStateTopic(
        {
          ...base,
          digest: () =>
            [...rows]
              .filter(([, row]) => row.live)
              .map(([id, row]) => ({ id, revision: row.revision })),
        },
        { debounceMs: DEBOUNCE_MS },
      )
    : createStateTopic(base, { debounceMs: DEBOUNCE_MS });
  if (options.attach !== false)
    kernel.attach((_topic, message) => {
      faults.send?.(message.seq);
      log.push({ type: "frame", message });
    });
  const frames = () =>
    log.flatMap((entry) => (entry.type === "frame" ? [entry.message] : []));
  const events = () =>
    frames().flatMap((frame) =>
      frame.events.map((event) => [event.kind, event.id, event.revision]),
    );
  /** Every listener outcome, as `[delivered, [kind, id, revision][]]`. */
  const outcomes: Array<[boolean, Array<[string, string, number]>]> = [];
  kernel.onPublished(({ events, delivered }) =>
    outcomes.push([
      delivered,
      events.map((event) => [event.kind, event.id, event.revision]),
    ]),
  );
  return { rows, log, calls, faults, outcomes, kernel, frames, events };
}

describe("publishing from reported ids", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("a reported live id upserts with its revision and summary", () => {
    const topic = fakeTopic();
    topic.rows.set("a", { revision: 3, live: true, summary: "A" });
    topic.kernel.report(["a"]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    assert.deepEqual(topic.frames(), [
      {
        type: "stateEvents",
        topic: "tasks",
        seq: 1,
        events: [{ kind: "upsert", id: "a", revision: 3, item: "A" }],
      },
    ]);
  });

  test("a reported known non-member deletes at its stored revision", () => {
    const topic = fakeTopic();
    topic.rows.set("gone", { revision: 9, live: false });
    topic.kernel.report(["gone"]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    assert.deepEqual(topic.events(), [["delete", "gone", 9]]);
  });

  test("an unreported row never publishes, even when it changed", () => {
    const topic = fakeTopic();
    topic.rows.set("a", { revision: 1, live: true, summary: "A" });
    topic.rows.set("b", { revision: 2, live: true, summary: "B" });
    topic.kernel.report(["a"]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    assert.deepEqual(topic.events(), [["upsert", "a", 1]]);
  });

  test("a reported id the revision read does not return publishes nothing", () => {
    const topic = fakeTopic();
    topic.kernel.report(["never"]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    assert.deepEqual(topic.frames(), []);
    assert.equal(topic.kernel.seq(), 0);
  });

  test("a live id with no summary stays pending until a later report's flush", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const topic = fakeTopic();
    topic.rows.set("x", { revision: 4, live: true });
    topic.kernel.report(["x"]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    assert.deepEqual(topic.frames(), []);
    assert.equal(warn.mock.calls.length, 1);
    assert.match(String(warn.mock.calls[0]?.[0]), /\[tasks\].*\bx\b/);

    // The kernel never reschedules itself.
    vi.advanceTimersByTime(DEBOUNCE_MS * 10);
    assert.deepEqual(topic.frames(), []);
    assert.equal(vi.getTimerCount(), 0);

    // Any later report, even an empty one, schedules the retry.
    topic.rows.set("x", { revision: 4, live: true, summary: "X" });
    topic.kernel.report([]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    assert.deepEqual(topic.events(), [["upsert", "x", 4]]);
    assert.equal(warn.mock.calls.length, 1);
  });

  test("events keep first-report order, one per id however often it was reported", () => {
    const topic = fakeTopic();
    for (const id of ["a", "b", "c"])
      topic.rows.set(id, { revision: 1, live: true, summary: id });
    topic.kernel.report(["c", "a"]);
    topic.kernel.report(["b", "a"]);
    topic.kernel.report(["c"]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    assert.equal(topic.frames().length, 1);
    assert.deepEqual(
      topic.events().map(([, id]) => id),
      ["c", "a", "b"],
    );
  });

  test("seq moves once per sent frame and never for a flush that sent nothing", () => {
    const topic = fakeTopic();
    topic.rows.set("a", { revision: 1, live: true, summary: "A" });
    topic.kernel.report(["a"]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    assert.equal(topic.kernel.seq(), 1);
    topic.kernel.report([]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    assert.equal(topic.frames().length, 1);
    assert.equal(topic.kernel.seq(), 1);
    topic.kernel.report(["a"]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    assert.deepEqual(
      topic.frames().map((frame) => frame.seq),
      [1, 2],
    );
  });

  test("a flush is cut into frames of at most batchMax with consecutive seq", () => {
    const topic = fakeTopic({ batchMax: 2 });
    const ids = ["e", "d", "c", "b", "a"];
    for (const id of ids)
      topic.rows.set(id, { revision: 1, live: true, summary: id });
    topic.kernel.report(ids);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    assert.deepEqual(
      topic
        .frames()
        .map((frame) => [frame.seq, frame.events.map((event) => event.id)]),
      [
        [1, ["e", "d"]],
        [2, ["c", "b"]],
        [3, ["a"]],
      ],
    );
  });

  test("flushNow runs only a scheduled flush, and clears its timer", () => {
    const topic = fakeTopic();
    let calls = 0;
    topic.kernel.onPublished(() => {
      calls += 1;
    });
    topic.kernel.flushNow();
    assert.deepEqual(topic.frames(), []);
    assert.equal(calls, 0);

    topic.rows.set("a", { revision: 1, live: true, summary: "A" });
    topic.kernel.report(["a"]);
    topic.kernel.flushNow();
    assert.deepEqual(topic.events(), [["upsert", "a", 1]]);
    assert.equal(calls, 1);
    vi.advanceTimersByTime(DEBOUNCE_MS * 2);
    assert.equal(topic.frames().length, 1);
    assert.equal(calls, 1);
  });

  test("an unattached kernel schedules nothing", () => {
    const topic = fakeTopic({ attach: false });
    topic.rows.set("a", { revision: 1, live: true, summary: "A" });
    const before = vi.getTimerCount();
    topic.kernel.report(["a"]);
    assert.equal(vi.getTimerCount(), before);
  });

  test("subscribe answers a digest only when declared and asked, else the snapshot", () => {
    const digesting = fakeTopic({ digest: true });
    digesting.rows.set("a", { revision: 5, live: true, summary: "A" });
    digesting.rows.set("gone", { revision: 6, live: false });
    digesting.kernel.report(["a"]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    assert.deepEqual(digesting.kernel.subscribeAnswer(true), {
      type: "stateDigest",
      topic: "tasks",
      seq: 1,
      entries: [{ id: "a", revision: 5 }],
    });
    assert.deepEqual(digesting.kernel.subscribeAnswer(false), {
      type: "fakeSnapshot",
      seq: 1,
    });

    const plain = fakeTopic();
    assert.deepEqual(plain.kernel.subscribeAnswer(true), {
      type: "fakeSnapshot",
      seq: 0,
    });
  });

  test("items reads flush-shaped events without touching seq or pending", () => {
    const topic = fakeTopic();
    topic.rows.set("a", { revision: 2, live: true, summary: "A" });
    topic.rows.set("gone", { revision: 3, live: false });
    topic.rows.set("bare", { revision: 4, live: true });
    topic.kernel.report(["a"]);
    assert.deepEqual(topic.kernel.items(["gone", "a", "never", "bare", "a"]), [
      { kind: "delete", id: "gone", revision: 3 },
      { kind: "upsert", id: "a", revision: 2, item: "A" },
    ]);
    assert.equal(topic.kernel.seq(), 0);
    assert.deepEqual(topic.frames(), []);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    assert.deepEqual(topic.events(), [["upsert", "a", 2]]);
  });

  test("listeners run once after an empty flush, and nothing is sent", () => {
    const topic = fakeTopic();
    topic.kernel.onPublished(() =>
      topic.log.push({ type: "listener", name: "one" }),
    );
    topic.kernel.report([]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    assert.deepEqual(topic.log, [{ type: "listener", name: "one" }]);
  });

  test("listeners run once each, after the last frame", () => {
    const topic = fakeTopic({ batchMax: 1 });
    topic.rows.set("a", { revision: 1, live: true, summary: "A" });
    topic.rows.set("b", { revision: 1, live: true, summary: "B" });
    topic.kernel.onPublished(() =>
      topic.log.push({ type: "listener", name: "one" }),
    );
    topic.kernel.onPublished(() =>
      topic.log.push({ type: "listener", name: "two" }),
    );
    topic.kernel.report(["a", "b"]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    assert.deepEqual(
      topic.log.map((entry) =>
        entry.type === "frame" ? `frame ${entry.message.seq}` : entry.name,
      ),
      ["frame 1", "frame 2", "one", "two"],
    );
  });

  test("a throwing listener is logged and silences neither frames nor other listeners", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const topic = fakeTopic();
    topic.rows.set("a", { revision: 1, live: true, summary: "A" });
    topic.kernel.onPublished(() => {
      throw new Error("listener broke");
    });
    topic.kernel.onPublished(() =>
      topic.log.push({ type: "listener", name: "second" }),
    );
    topic.kernel.report(["a"]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    assert.deepEqual(
      topic.log.map((entry) => entry.type),
      ["frame", "listener"],
    );
    assert.equal(error.mock.calls.length, 1);
    assert.match(
      String((error.mock.calls[0]?.[1] as Error | undefined)?.message),
      /listener broke/,
    );
  });

  test("several reports inside one window are one flush and one listener call", () => {
    const topic = fakeTopic();
    let calls = 0;
    topic.kernel.onPublished(() => {
      calls += 1;
    });
    topic.rows.set("a", { revision: 1, live: true, summary: "A" });
    topic.kernel.report(["a"]);
    vi.advanceTimersByTime(DEBOUNCE_MS - 1);
    topic.kernel.report([]);
    vi.advanceTimersByTime(DEBOUNCE_MS - 1);
    topic.kernel.report(["a"]);
    assert.equal(calls, 0);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    assert.equal(calls, 1);
    assert.equal(topic.frames().length, 1);
  });
});

describe("the change set", () => {
  const SEQUENCE_A = "test_change_set_a";
  const SEQUENCE_B = "test_change_set_b";
  const stamped = (topic: string) =>
    getDb()
      .prepare(
        "SELECT id, revision FROM temp.change_set_stamps WHERE topic = ? ORDER BY rowid",
      )
      .all(topic)
      .map((row) => [row.id, row.revision]);
  const counter = (sequence: string) =>
    (
      getDb()
        .prepare("SELECT next_id FROM sequences WHERE entity_type = ?")
        .get(sequence) as { next_id: number }
    ).next_id;
  const writes = (
    topic: BroadcastTopic,
    sequence: string,
  ): StateTopicWrites => ({
    topic,
    sequence,
    stamp: (ids, revision) => {
      const insert = getDb().prepare(
        `INSERT INTO temp.change_set_stamps (topic, id, revision) VALUES (?, ?, ?)
         ON CONFLICT (topic, id) DO UPDATE SET revision = excluded.revision`,
      );
      for (const id of ids) insert.run(topic, id, revision);
    },
  });
  const a = writes("tasks", SEQUENCE_A);
  const b = writes("projects", SEQUENCE_B);
  let reports: Array<[BroadcastTopic, readonly string[]]> = [];

  beforeEach(() => {
    const db = getDb();
    db.exec(
      `CREATE TEMP TABLE IF NOT EXISTS change_set_stamps (
         topic TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
         PRIMARY KEY (topic, id))`,
    );
    db.exec("DELETE FROM temp.change_set_stamps");
    db.prepare("DELETE FROM sequences WHERE entity_type IN (?, ?)").run(
      SEQUENCE_A,
      SEQUENCE_B,
    );
    db.prepare(
      "INSERT INTO sequences (entity_type, next_id) VALUES (?, 10), (?, 20)",
    ).run(SEQUENCE_A, SEQUENCE_B);
    reports = [];
    setStateChangeSink((topic, ids) => reports.push([topic, ids]));
  });
  afterEach(() => {
    setStateChangeSink(undefined);
  });

  test("stamps inside the transaction, from each topic's own sequence, and reports after commit", () => {
    withChangeSet((changes) => {
      assert.equal(changes.touch(a, ["a1", "a2"]), 11);
      assert.equal(changes.touch(b, ["b1"]), 21);
      // A second touch of one topic shares the transaction's revision.
      assert.equal(changes.touch(a, ["a3", "a1"]), 11);
      assert.deepEqual(stamped("tasks"), [
        ["a1", 11],
        ["a2", 11],
        ["a3", 11],
      ]);
      assert.deepEqual(stamped("projects"), [["b1", 21]]);
      assert.deepEqual(reports, [], "nobody hears of a write before COMMIT");
    });
    assert.deepEqual(reports, [
      ["tasks", ["a1", "a2", "a3"]],
      ["projects", ["b1"]],
    ]);

    reports = [];
    withChangeSet((changes) => {
      assert.equal(changes.touch(a, ["a1"]), 12);
      assert.equal(changes.touch(b, ["b1"]), 22);
    });
    assert.deepEqual(reports, [
      ["tasks", ["a1"]],
      ["projects", ["b1"]],
    ]);
  });

  test("revision without a touch enlists the topic with no ids", () => {
    withChangeSet((changes) => {
      assert.equal(changes.revision(a), 11);
    });
    assert.deepEqual(reports, [["tasks", []]]);
    assert.equal(counter(SEQUENCE_A), 11);
  });

  test("touching no ids enlists nothing and mints nothing", () => {
    withChangeSet((changes) => {
      assert.equal(changes.touch(a, []), undefined);
    });
    assert.deepEqual(reports, []);
    assert.equal(counter(SEQUENCE_A), 10);
  });

  test("a throw rolls back stamps and sequences and reports nothing", () => {
    assert.throws(
      () =>
        withChangeSet((changes) => {
          changes.touch(a, ["a1"]);
          changes.touch(b, ["b1"]);
          throw new Error("write failed");
        }),
      /write failed/,
    );
    assert.deepEqual(stamped("tasks"), []);
    assert.deepEqual(stamped("projects"), []);
    assert.equal(counter(SEQUENCE_A), 10);
    assert.equal(counter(SEQUENCE_B), 20);
    assert.deepEqual(reports, []);
  });

  test("a touch inside a change set joins it: its revision, reported after its commit", () => {
    withChangeSet((changes) => {
      changes.touch(a, ["a1"]);
      touchStateTopic(b, ["b1"]);
      touchStateTopic(b, ["b2"]);
      assert.deepEqual(stamped("projects"), [
        ["b1", 21],
        ["b2", 21],
      ]);
      assert.deepEqual(reports, []);
    });
    assert.deepEqual(reports, [
      ["tasks", ["a1"]],
      ["projects", ["b1", "b2"]],
    ]);
  });

  test("a touch inside a change set that throws rolls back and reports nothing", () => {
    assert.throws(
      () =>
        withChangeSet(() => {
          touchStateTopic(b, ["b1"]);
          throw new Error("write failed");
        }),
      /write failed/,
    );
    assert.deepEqual(stamped("projects"), []);
    assert.equal(counter(SEQUENCE_B), 20);
    assert.deepEqual(reports, []);
  });

  test("a touch inside a foreign transaction stamps there and reports at once", () => {
    const order: string[] = [];
    setStateChangeSink((topic, ids) => {
      order.push(`report ${topic}`);
      reports.push([topic, ids]);
    });
    withDbTransaction(() => {
      touchStateTopic(b, ["b1"]);
      assert.deepEqual(stamped("projects"), [["b1", 21]]);
      order.push("transaction ends");
    });
    assert.deepEqual(order, ["report projects", "transaction ends"]);
    assert.deepEqual(reports, [["projects", ["b1"]]]);

    // Its rollback takes the stamp and the sequence back; the report stands,
    // and the flush that follows reads the committed state.
    reports = [];
    assert.throws(
      () =>
        withDbTransaction(() => {
          touchStateTopic(b, ["b1"]);
          throw new Error("caller failed");
        }),
      /caller failed/,
    );
    assert.deepEqual(stamped("projects"), [["b1", 21]]);
    assert.equal(counter(SEQUENCE_B), 21);
    assert.deepEqual(reports, [["projects", ["b1"]]]);
  });

  test("a touch with no transaction opens its own change set", () => {
    let inTransaction: boolean | undefined;
    setStateChangeSink((topic, ids) => {
      inTransaction = getDb().isTransaction;
      reports.push([topic, ids]);
    });
    touchStateTopic(b, ["b1"]);
    assert.deepEqual(stamped("projects"), [["b1", 21]]);
    assert.deepEqual(reports, [["projects", ["b1"]]]);
    assert.equal(inTransaction, false);
  });

  test("a touch made by the sink after a commit opens its own change set", () => {
    setStateChangeSink((topic, ids) => {
      reports.push([topic, ids]);
      if (topic === "tasks") touchStateTopic(b, ["b1"]);
    });
    withChangeSet((changes) => {
      changes.touch(a, ["a1"]);
    });
    assert.deepEqual(stamped("projects"), [["b1", 21]]);
    assert.deepEqual(reports, [
      ["tasks", ["a1"]],
      ["projects", ["b1"]],
    ]);
  });

  test("a touch with no ids does nothing, wherever it stands", () => {
    touchStateTopic(b, []);
    withDbTransaction(() => touchStateTopic(b, []));
    withChangeSet(() => touchStateTopic(b, []));
    assert.deepEqual(stamped("projects"), []);
    assert.equal(counter(SEQUENCE_B), 20);
    assert.deepEqual(reports, []);
  });

  test("a change set refuses to open inside an open transaction", () => {
    let ran = false;
    withDbTransaction(() => {
      assert.throws(
        () =>
          withChangeSet(() => {
            ran = true;
          }),
        /open database transaction/,
      );
    });
    assert.equal(ran, false);
    assert.deepEqual(reports, []);
  });
});

describe("the batch summaries hook", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("without the hook, a flush and items read one summary per live id", () => {
    const topic = fakeTopic();
    topic.rows.set("a", { revision: 1, live: true, summary: "A" });
    topic.rows.set("gone", { revision: 2, live: false });
    topic.rows.set("b", { revision: 3, live: true, summary: "B" });
    topic.kernel.report(["a", "gone", "b", "never"]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    assert.deepEqual(topic.calls.summary, ["a", "b"]);
    assert.deepEqual(topic.events(), [
      ["upsert", "a", 1],
      ["delete", "gone", 2],
      ["upsert", "b", 3],
    ]);
    topic.kernel.items(["b", "gone"]);
    assert.deepEqual(topic.calls.summary, ["a", "b", "b"]);
  });

  test("with the hook, one call per flush and per items read, with the candidate live ids", () => {
    const topic = fakeTopic({ batch: true });
    topic.rows.set("a", { revision: 1, live: true, summary: "A" });
    topic.rows.set("gone", { revision: 2, live: false });
    topic.rows.set("b", { revision: 3, live: true, summary: "B" });
    topic.kernel.report(["a", "gone", "b", "never"]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    assert.deepEqual(topic.calls.summaries, [["a", "b"]]);
    assert.deepEqual(topic.calls.summary, []);
    assert.deepEqual(topic.events(), [
      ["upsert", "a", 1],
      ["delete", "gone", 2],
      ["upsert", "b", 3],
    ]);
    assert.deepEqual(topic.kernel.items(["b", "gone", "a", "b"]), [
      { kind: "upsert", id: "b", revision: 3, item: "B" },
      { kind: "delete", id: "gone", revision: 2 },
      { kind: "upsert", id: "a", revision: 1, item: "A" },
    ]);
    assert.deepEqual(topic.calls.summaries, [
      ["a", "b"],
      ["b", "a"],
    ]);
  });

  test("a null entry deletes at the stored revision, in flushes and items", () => {
    const topic = fakeTopic({ batch: true });
    topic.rows.set("hidden", { revision: 7, live: true, member: false });
    topic.kernel.report(["hidden"]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    assert.deepEqual(topic.events(), [["delete", "hidden", 7]]);
    assert.deepEqual(topic.kernel.items(["hidden"]), [
      { kind: "delete", id: "hidden", revision: 7 },
    ]);
  });

  test("an absent entry stays pending with the warning, and publishes on a later report", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const topic = fakeTopic({ batch: true });
    topic.rows.set("x", { revision: 4, live: true });
    topic.kernel.report(["x"]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    assert.deepEqual(topic.frames(), []);
    assert.equal(warn.mock.calls.length, 1);
    assert.match(String(warn.mock.calls[0]?.[0]), /\[tasks\].*\bx\b/);
    assert.deepEqual(topic.kernel.items(["x"]), []);

    topic.rows.set("x", { revision: 4, live: true, summary: "X" });
    topic.kernel.report([]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    assert.deepEqual(topic.events(), [["upsert", "x", 4]]);
    assert.deepEqual(topic.calls.summaries, [["x"], ["x"], ["x"]]);
  });
});

describe("the failure boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("a delivered flush hands listeners its events, and an empty one none", () => {
    const topic = fakeTopic();
    topic.rows.set("a", { revision: 1, live: true, summary: "A" });
    topic.rows.set("gone", { revision: 2, live: false });
    topic.kernel.report(["a", "gone"]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    topic.kernel.report([]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    assert.deepEqual(topic.outcomes, [
      [
        true,
        [
          ["upsert", "a", 1],
          ["delete", "gone", 2],
        ],
      ],
      [true, []],
    ]);
  });

  for (const stage of ["revisions", "summary", "summaries"] as const)
    test(`a throwing ${stage} read in a timer flush is logged, sends nothing and keeps its ids`, () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const topic = fakeTopic({ batch: stage === "summaries" });
      let fail = true;
      topic.rows.set("a", { revision: 1, live: true, summary: "A" });
      topic.rows.set("b", {
        revision: 2,
        live: true,
        get summary(): string {
          if (fail && stage !== "revisions")
            throw new Error("row build failed");
          return "B";
        },
      });
      topic.faults.read = () => {
        if (fail && stage === "revisions")
          throw new Error("database is locked");
      };
      topic.kernel.report(["a", "b"]);
      vi.advanceTimersByTime(DEBOUNCE_MS);
      assert.deepEqual(topic.frames(), []);
      assert.equal(topic.kernel.seq(), 0);
      assert.deepEqual(topic.outcomes, [[false, []]]);
      assert.equal(error.mock.calls.length, 1);
      assert.match(String(error.mock.calls[0]?.[0]), /\[tasks\] flush failed/);

      // Nothing reschedules; the next report retries the kept ids first.
      vi.advanceTimersByTime(DEBOUNCE_MS * 10);
      assert.equal(vi.getTimerCount(), 0);
      fail = false;
      topic.rows.set("c", { revision: 3, live: true, summary: "C" });
      topic.kernel.report(["c"]);
      vi.advanceTimersByTime(DEBOUNCE_MS);
      assert.deepEqual(topic.events(), [
        ["upsert", "a", 1],
        ["upsert", "b", 2],
        ["upsert", "c", 3],
      ]);
      assert.equal(topic.outcomes.at(-1)?.[0], true);
      assert.deepEqual(takeStateTopicInvariantsForTests(), []);
    });

  test("a throwing frame send is logged, the remaining frames still go, and every id is kept", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const topic = fakeTopic({ batchMax: 1 });
    for (const [id, revision] of [
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ] as const)
      topic.rows.set(id, { revision, live: true, summary: id.toUpperCase() });
    topic.faults.send = (seq) => {
      if (seq === 2) throw new Error("socket closed");
    };
    topic.kernel.report(["a", "b", "c"]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    // Frame 2 spent its seq; frames 1 and 3 went out.
    assert.deepEqual(
      topic.frames().map((frame) => frame.seq),
      [1, 3],
    );
    assert.equal(topic.kernel.seq(), 3);
    assert.deepEqual(topic.outcomes, [
      [
        false,
        [
          ["upsert", "a", 1],
          ["upsert", "b", 2],
          ["upsert", "c", 3],
        ],
      ],
    ]);
    assert.equal(error.mock.calls.length, 1);
    assert.match(
      String(error.mock.calls[0]?.[0]),
      /\[tasks\] frame 2 delivery failed/,
    );

    // A later ordinary report republishes every id of the failed flush at
    // its same revision, ahead of the new one.
    topic.faults.send = undefined;
    topic.rows.set("d", { revision: 4, live: true, summary: "D" });
    topic.kernel.report(["d"]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    assert.deepEqual(
      topic.frames().map((frame) => [frame.seq, frame.events[0]?.id]),
      [
        [1, "a"],
        [3, "c"],
        [4, "a"],
        [5, "b"],
        [6, "c"],
        [7, "d"],
      ],
    );
    assert.equal(topic.outcomes.at(-1)?.[0], true);
  });

  test("flushNow never throws an ordinary read or send failure", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const topic = fakeTopic();
    topic.rows.set("a", { revision: 1, live: true, summary: "A" });
    topic.faults.read = () => {
      throw new Error("read failed");
    };
    topic.kernel.report(["a"]);
    topic.kernel.flushNow();
    topic.faults.read = undefined;
    topic.faults.send = () => {
      throw new Error("send failed");
    };
    topic.kernel.report([]);
    topic.kernel.flushNow();
    assert.deepEqual(
      topic.outcomes.map(([delivered]) => delivered),
      [false, false],
    );
  });

  test("an invariant escapes flushNow and a timer flush, with its ids kept and recorded", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const topic = fakeTopic();
    topic.rows.set("a", { revision: 1, live: true, summary: "A" });
    topic.faults.read = () => {
      throw new StateTopicInvariantError("unreported row change: a");
    };
    topic.kernel.report(["a"]);
    assert.throws(() => topic.kernel.flushNow(), /unreported row change: a/);
    topic.kernel.report([]);
    assert.throws(
      () => vi.advanceTimersByTime(DEBOUNCE_MS),
      /unreported row change: a/,
    );
    assert.deepEqual(topic.frames(), []);
    assert.deepEqual(topic.outcomes, [], "no listener runs for an invariant");
    assert.equal(error.mock.calls.length, 0, "an invariant is not logged");
    assert.deepEqual(
      takeStateTopicInvariantsForTests().map((violation) => violation.message),
      ["unreported row change: a", "unreported row change: a"],
    );

    topic.faults.read = undefined;
    topic.kernel.report([]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    assert.deepEqual(topic.events(), [["upsert", "a", 1]]);
  });

  test("a listener's throw, invariant or not, is logged and silences no other listener", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const topic = fakeTopic();
    topic.kernel.onPublished(() => {
      throw new StateTopicInvariantError("audit at publication");
    });
    let after = 0;
    topic.kernel.onPublished(() => {
      after += 1;
    });
    topic.kernel.report([]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    assert.equal(after, 1);
    assert.equal(error.mock.calls.length, 1);
    // The ledger, not the exception, fails the test.
    assert.equal(takeStateTopicInvariantsForTests().length, 1);
  });
});

describe("the invariant ledger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a violation is recorded at construction, so the checker fails even after a catch", () => {
    try {
      throw new StateTopicInvariantError("unreported session row change: s1");
    } catch (err) {
      assert.ok(isStateTopicInvariant(err));
    }
    assert.throws(
      () => failOnStateTopicInvariantsForTests(),
      /state topic invariant violated \(1\): unreported session row change: s1/,
    );
    // Checking takes the ledger: the next check is quiet.
    failOnStateTopicInvariantsForTests();
  });

  test("only the brand counts", () => {
    assert.equal(isStateTopicInvariant(new Error("ordinary")), false);
    assert.equal(isStateTopicInvariant(undefined), false);
    assert.equal(isStateTopicInvariant("unreported"), false);
    const violation = new StateTopicInvariantError("branded");
    assert.equal(violation.name, "StateTopicInvariantError");
    assert.equal(isStateTopicInvariant(violation), true);
    assert.deepEqual(takeStateTopicInvariantsForTests(), [violation]);
  });

  test("the server test setup checks the ledger after every test", () => {
    const setup = readFileSync(
      new URL("./test/setup.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      setup,
      /^afterEach\(\(\) => failOnStateTopicInvariantsForTests\(\)\);$/m,
    );
  });

  test("a module reset shares one brand and one ledger across kernel instances", async () => {
    vi.resetModules();
    const other = await import("./stateTopicKernel.ts");
    assert.notEqual(
      other.StateTopicInvariantError,
      StateTopicInvariantError,
      "the re-import is a second instance",
    );

    // A violation from the second instance: this instance recognises it and
    // its checker fails on it, though `instanceof` cannot see it.
    const foreign = new other.StateTopicInvariantError("from instance B");
    assert.equal(foreign instanceof StateTopicInvariantError, false);
    assert.equal(isStateTopicInvariant(foreign), true);
    assert.throws(
      () => failOnStateTopicInvariantsForTests(),
      /from instance B/,
    );
    failOnStateTopicInvariantsForTests();

    // And the reverse.
    const local = new StateTopicInvariantError("from instance A");
    assert.equal(other.isStateTopicInvariant(local), true);
    assert.throws(
      () => other.failOnStateTopicInvariantsForTests(),
      /from instance A/,
    );

    // This instance's kernel rethrows a violation the other constructed,
    // rather than logging it as an ordinary failure.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const topic = fakeTopic();
    topic.rows.set("a", { revision: 1, live: true, summary: "A" });
    topic.faults.read = () => {
      throw new other.StateTopicInvariantError("raised in B");
    };
    topic.kernel.report(["a"]);
    assert.throws(() => topic.kernel.flushNow(), /raised in B/);
    assert.equal(error.mock.calls.length, 0);
    assert.equal(takeStateTopicInvariantsForTests().length, 1);
    failOnStateTopicInvariantsForTests();

    // An ordinary publication failure in the other instance records nothing.
    const plain = other.createStateTopic({
      topic: "tasks",
      revisions: () => {
        throw new Error("database is closed");
      },
      summary: () => undefined,
      snapshot: (seq: number) => ({ seq }),
      batchMax: 10,
    });
    plain.attach(() => {});
    plain.report(["a"]);
    plain.flushNow();
    assert.equal(error.mock.calls.length, 1);
    assert.deepEqual(other.takeStateTopicInvariantsForTests(), []);
  });
});
