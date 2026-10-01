/**
 * The WINDOWED chat-load payload (Task 436). Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/session/transport/timelineWindow.test.ts
 *
 * Three things are pinned here, all on a long fixture:
 * - the snapshot carries a bounded tail that starts at a TURN boundary, plus the
 *   totals a client needs to know what precedes it;
 * - the turn-stats seed makes a windowed transcript agree, turn for turn, with
 *   the full projection — the whole point of shipping it;
 * - `loadTimelineRange` answers with the exact preceding slice and a seed that
 *   keeps the already-rendered rows unchanged, and a cached RANGE (one that
 *   starts mid-timeline) still earns the tail-only answer.
 *
 * Sections 7 and 8 pin the renderability floor on BOTH paths a client can be
 * answered on: the budget walk (Task 449) and an accepted cache anchor
 * (Task 450).
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ContextInfo,
  ServerMessage,
  SessionState,
} from "@assistant/shared";
import type {
  ClientTimelineEntry,
  TimelineCacheDescriptor,
} from "@assistant/shared/runtime";
import {
  describeTimelineCache,
  SNAPSHOT_TIMELINE_MIN_ENTRIES,
  SNAPSHOT_TIMELINE_WINDOW_BYTES,
  SNAPSHOT_TIMELINE_WINDOW_ENTRIES,
} from "@assistant/shared/runtime";
import { entriesToDisplayMessages } from "@assistant/shared/display";
import {
  groupTurns,
  turnTotals,
  type SessionTotals,
  type TurnStatsSeed,
} from "@assistant/shared/turnStats";

const tmp = mkdtempSync(join(tmpdir(), "timeline-window-test-"));
process.env.ASSISTANT_CWD = tmp;

const { SessionLog } = await import("../log/store.ts");
const { createMemoryLogPersistence } = await import("../log/persistence.ts");
const { RuntimeTransport } = await import("./gateway.ts");
type LiveSession = ConstructorParameters<typeof RuntimeTransport>[1];

const TURNS = 200;

/** What the slice actually costs on the wire. */
function jsonBytes(entries: readonly ClientTimelineEntry[]): number {
  return Buffer.byteLength(JSON.stringify(entries));
}

/** A long session: 200 turns of user → assistant(tool) → result → assistant. */
function longLog() {
  const log = new SessionLog("long", createMemoryLogPersistence());
  for (let turn = 0; turn < TURNS; turn += 1) {
    log.append({
      type: "message",
      role: "user",
      origin: { kind: "human" },
      content: [{ type: "text", text: `prompt ${turn}` }],
    });
    const call = log.append({
      type: "message",
      role: "assistant",
      content: [
        { type: "text", text: `working on ${turn}` },
        {
          type: "toolCall",
          toolCallId: `tc-${turn}`,
          name: "bash",
          input: { cmd: "ls" },
        },
      ],
    });
    log.append({
      type: "message",
      role: "toolResult",
      toolCallId: `tc-${turn}`,
      content: [{ type: "text", text: `output ${turn}` }],
      isError: false,
    });
    log.append({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: `answer ${turn}` }],
      model: "opus",
      usage: {
        inputTokens: 10 + turn,
        outputTokens: 5,
        cacheReadTokens: 100 + turn,
        cacheCreationTokens: 2,
        costUSD: 0.01,
        contextTokens: 1000 + turn * 10,
      },
    });
    assert.ok(call.id, "assistant entry appended");
  }
  return log;
}

/**
 * The shape both renderability-floor sections need: entry 0 a prompt, entry 1 the
 * assistant entry declaring `CALLS` tool calls (too fat for the byte budget),
 * then one result per call — so `[2, 2 + CALLS)` is nothing but orphans.
 */
const CALLS = 226;
function toolLoopLog(calls = CALLS) {
  const log = new SessionLog("loop", createMemoryLogPersistence());
  log.append({
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [{ type: "text", text: "one very long tool loop" }],
  });
  log.append({
    type: "message",
    role: "assistant",
    content: Array.from({ length: calls }, (_, i) => ({
      type: "toolCall" as const,
      toolCallId: `tc-${i}`,
      name: "bash",
      input: { cmd: `step ${i}: ${"x".repeat(300)}` },
    })),
  });
  for (let i = 0; i < calls; i += 1) {
    log.append({
      type: "message",
      role: "toolResult",
      toolCallId: `tc-${i}`,
      content: [{ type: "text", text: `output ${i}: ${"y".repeat(400)}` }],
      isError: false,
    });
  }
  return log;
}

/** The running Session cumulative after each turn, exactly as the transcript renders it. */
function cumulativePerTurn(
  entries: readonly ClientTimelineEntry[],
  seed?: TurnStatsSeed,
): SessionTotals[] {
  const cum: SessionTotals = seed
    ? { ...seed.cumulative }
    : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const rows: SessionTotals[] = [];
  for (const turn of groupTurns(entriesToDisplayMessages(entries))) {
    const totals = turnTotals(turn);
    cum.input += totals.input;
    cum.output += totals.output;
    cum.cacheRead += totals.cacheRead;
    cum.cacheWrite += totals.cacheWrite;
    cum.cost += totals.cost;
    rows.push({ ...cum });
  }
  return rows;
}

const stubState = () => ({ sessionId: "long" }) as SessionState;
const stubContext = () => ({}) as ContextInfo;

function attach(
  log: InstanceType<typeof SessionLog>,
  timelineCache?: TimelineCacheDescriptor,
) {
  const sent: ServerMessage[] = [];
  const session = {
    subscribe: () => () => {},
    getSnapshot: () => ({ runState: "idle", streaming: [] }),
    clientTimeline: (opts: { lazyBodies?: boolean } = {}) =>
      log.clientTimeline(opts),
    clientTimelineForSnapshot: (bodiesFrom?: number) =>
      log.clientTimelineForSnapshot(bodiesFrom),
  } as unknown as LiveSession;
  new RuntimeTransport(
    "long",
    session,
    { send: (m) => sent.push(m) },
    {
      buildState: stubState,
      buildContextInfo: stubContext,
      ...(timelineCache ? { timelineCache } : {}),
    },
  ).attach();
  const message = sent[0];
  assert.ok(message?.type === "snapshot", "attach sends a snapshot");
  return message.snapshot;
}

/** Scenarios 1–4 all read one long session opened with no cache. */
function uncachedOpen() {
  const log = longLog();
  const full = log.clientTimeline({ lazyBodies: true });
  const snapshot = attach(log);
  return { log, full, snapshot };
}

/* ------------- 1. an uncached open is bounded and turn-aligned ------------ */
test("an uncached open is bounded and turn-aligned", () => {
  const { full, snapshot } = uncachedOpen();

  assert.equal(
    snapshot.totalEntryCount,
    full.length,
    "the snapshot states the full projection's size",
  );
  assert.ok(
    snapshot.timelineStart > 0,
    "a long session is not sent from entry zero",
  );
  assert.equal(
    snapshot.timeline.length,
    full.length - snapshot.timelineStart,
    "the window runs to the live tail",
  );
  assert.ok(
    snapshot.timeline.length <= SNAPSHOT_TIMELINE_WINDOW_ENTRIES,
    "the window never exceeds the entry budget, boundary snap included",
  );
  assert.ok(
    snapshot.timeline.length > SNAPSHOT_TIMELINE_WINDOW_ENTRIES / 2,
    "and still fills most of it on a session of ordinary turns",
  );
  assert.ok(
    jsonBytes(snapshot.timeline) <= SNAPSHOT_TIMELINE_WINDOW_BYTES,
    "and stays within the byte budget these small entries never reach",
  );
  const first = snapshot.timeline[0]!;
  assert.ok(
    first.type === "message" && first.role === "user",
    "the window starts where a turn starts",
  );
  assert.equal(
    snapshot.turnStatsSeed?.partialTurn,
    undefined,
    "a turn-aligned window is not a fragment",
  );
  assert.deepEqual(
    snapshot.timeline.map((entry) => entry.id),
    full.slice(snapshot.timelineStart).map((entry) => entry.id),
    "the window is an exact suffix of the projection",
  );
  assert.deepEqual(
    snapshot.timelineCache,
    describeTimelineCache(snapshot.timeline, snapshot.timelineStart),
    "the persist anchor describes the RANGE, start offset included",
  );
});

/* ---------------- 2. the seed makes the windowed rows honest ------------- */
test("the seed makes the windowed rows honest", () => {
  const { full, snapshot } = uncachedOpen();
  const seed = snapshot.turnStatsSeed;
  assert.ok(seed, "a windowed snapshot carries a turn-stats seed");
  const fullRows = cumulativePerTurn(full);
  const windowRows = cumulativePerTurn(snapshot.timeline, seed);
  assert.deepEqual(
    windowRows,
    fullRows.slice(fullRows.length - windowRows.length),
    "every turn in the window shows the cumulative the full list would",
  );
  assert.equal(
    seed.usageTurnCount,
    fullRows.length - windowRows.length,
    "the seed counts the usage turns that precede the window",
  );
});

/* -------------- 3. loading older entries keeps those rows ---------------- */
test("loading older entries keeps those rows", () => {
  const { log, full, snapshot } = uncachedOpen();
  const first = snapshot.timeline[0]!;
  const fullRows = cumulativePerTurn(full);
  const windowRows = cumulativePerTurn(
    snapshot.timeline,
    snapshot.turnStatsSeed,
  );
  const range = log.clientTimelineRange(first.seq, 240);
  assert.ok(range, "the anchor resolves to a range");
  assert.deepEqual(
    range.entries.map((entry) => entry.id),
    full
      .slice(range.timelineStart, snapshot.timelineStart)
      .map((entry) => entry.id),
    "the range is the exact slice before the window",
  );
  assert.equal(range.totalEntryCount, full.length);
  const grown = [...range.entries, ...snapshot.timeline];
  const grownRows = cumulativePerTurn(grown, range.turnStatsSeed);
  assert.deepEqual(
    grownRows.slice(grownRows.length - windowRows.length),
    windowRows,
    "prepending older entries does not move an already-rendered turn row",
  );
  assert.deepEqual(
    grownRows,
    fullRows.slice(fullRows.length - grownRows.length),
    "the grown transcript still agrees with the full projection",
  );
});

/* ------- 4. reaching the session start ends with a zero-seed range ------- */
test("reaching the session start ends with a zero-seed range", () => {
  const { log, snapshot } = uncachedOpen();
  const range = log.clientTimelineRange(snapshot.timeline[0]!.seq, 240)!;
  const grown = [...range.entries, ...snapshot.timeline];
  let cursor = grown[0]!.seq;
  let start = range.timelineStart;
  while (start > 0) {
    const older = log.clientTimelineRange(cursor, 240);
    assert.ok(older, "each anchor keeps resolving");
    assert.ok(
      older.timelineStart < start,
      "each range moves the transcript start back",
    );
    start = older.timelineStart;
    cursor = older.entries[0]!.seq;
  }
  assert.equal(
    log.clientTimelineRange(cursor, 240)!.turnStatsSeed,
    undefined,
    "nothing precedes the session start, so no seed is sent",
  );
});

/* ------------- 5. a cached RANGE earns the tail-only answer -------------- */
test("a cached RANGE earns the tail-only answer", () => {
  const log = longLog();
  const full = log.clientTimeline({ lazyBodies: true });
  const windowStart = attach(log).timelineStart;
  const cachedRange = full.slice(windowStart);

  const tailOnly = attach(log, describeTimelineCache(cachedRange, windowStart));
  assert.equal(
    tailOnly.timeline.length,
    0,
    "an unchanged cached range transfers no entries",
  );
  assert.equal(tailOnly.timelineStart, full.length);
  assert.deepEqual(
    tailOnly.timelineBase,
    describeTimelineCache(cachedRange, windowStart),
    "the accepted anchor is echoed for the client's splice check",
  );
  assert.ok(
    tailOnly.turnStatsSeed,
    "the seed follows the RENDERED start, not the sent tail",
  );

  // A corrupt anchor is never spliced: it falls back to a fresh window.
  const corrupt = attach(log, {
    ...describeTimelineCache(cachedRange, windowStart),
    fingerprint: "bogus",
  });
  assert.equal(corrupt.timelineBase, undefined, "no anchor was accepted");
  assert.equal(
    corrupt.timelineStart,
    windowStart,
    "the fallback is a windowed snapshot, not the whole timeline",
  );

  // An anchor claiming a range the projection does not have, likewise.
  const outOfRange = attach(log, {
    ...describeTimelineCache(cachedRange, windowStart + 5),
  });
  assert.equal(outOfRange.timelineStart, windowStart);

  // The client's "my local copy is gone" empty descriptor is a MISS, so it is
  // answered with a window rather than the full timeline it used to get.
  const empty = attach(log, describeTimelineCache([]));
  assert.equal(empty.timelineStart, windowStart);
  assert.ok(empty.turnStatsSeed, "and it is seeded like any other window");
});

/* ---- 6. one turn bigger than the budget: bounded, and honest about it ---- */
test("one turn bigger than the budget: bounded, and honest about it", () => {
  // A single turn of 900 fat runs. There is no turn boundary to start at that
  // the budget can pay for, so the window opens INSIDE the turn — which is the
  // one case the payload bound must still hold and the seed must declare.
  const log = new SessionLog("heavy", createMemoryLogPersistence());
  log.append({
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [{ type: "text", text: "one enormous task" }],
  });
  for (let i = 0; i < 900; i += 1) {
    log.append({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: `step ${i} ${"x".repeat(2000)}` }],
      model: "opus",
      usage: {
        inputTokens: 10,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUSD: 0.01,
        contextTokens: 5_000 + i,
      },
    });
  }

  const heavy = attach(log);
  assert.ok(
    heavy.timelineStart > 0,
    "the heavy turn is not shipped from its prompt",
  );
  assert.ok(
    heavy.timeline.length <= SNAPSHOT_TIMELINE_WINDOW_ENTRIES,
    "the entry budget holds inside a turn",
  );
  assert.ok(
    // The entry floor is the only over-run in play here (no tool results), and
    // it is what these 2 KB entries hit; nothing else may add to the payload.
    heavy.timeline.length <= SNAPSHOT_TIMELINE_MIN_ENTRIES ||
      jsonBytes(heavy.timeline) <= SNAPSHOT_TIMELINE_WINDOW_BYTES,
    `the byte budget holds inside a turn (sent ${jsonBytes(heavy.timeline)} B)`,
  );
  assert.equal(
    heavy.turnStatsSeed?.partialTurn,
    true,
    "a mid-turn window declares its leading fragment",
  );
  const heavyRange = log.clientTimelineRange(heavy.timeline[0]!.seq, 240);
  assert.equal(
    heavyRange?.turnStatsSeed?.partialTurn,
    true,
    "and so does a range that is still inside that turn",
  );
});

/* -- 7. a tool-loop turn whose declarer breaks the budget still renders ---- */
test("a tool-loop turn whose declarer breaks the budget still renders", () => {
  // Task 449: ONE assistant entry declares 226 calls, followed by 226 results.
  // The results fit the byte budget, the declaring entry does not, so the
  // budget walk used to open the window right after it — a snapshot of nothing
  // but orphan tool results, which projects to ZERO display messages and made
  // the client canonicalize the session to the new-session page. The
  // renderability floor must pull the declaring entry into the window.
  const log = toolLoopLog();

  const snapshot = attach(log);
  assert.ok(
    snapshot.timelineStart > 0,
    "the turn is over budget, so the window does not open at entry zero",
  );
  const first = snapshot.timeline[0]!;
  assert.ok(
    first.type === "message" && first.role === "assistant",
    "the window opens at the entry that DECLARES the tool calls in it",
  );
  assert.ok(
    entriesToDisplayMessages(snapshot.timeline).length >= 1,
    "a windowed snapshot always projects at least one display message",
  );
  assert.equal(
    snapshot.turnStatsSeed?.partialTurn,
    true,
    "the window is still a mid-turn fragment and says so",
  );
});

/* ---- 8. an UNRENDERABLE cached range is dropped, not honoured ------------- */
test("an UNRENDERABLE cached range is dropped, not honoured", () => {
  // Task 450: a browser that cached the pre-449 window holds exactly the orphan
  // range `[2, 228)`. It is a legitimate, matching range of the projection, so
  // the anchor check accepts it — and the tail delta after it is EMPTY, leaving a
  // blank transcript on every open. The floor must apply to the accepted anchor
  // too: the cached range cannot be extended (the client holds only those
  // entries), so it is dropped in favour of the window.
  const log = toolLoopLog();
  const full = log.clientTimeline({ lazyBodies: true });
  const orphanRange = full.slice(2);
  assert.equal(orphanRange.length, CALLS, "the cached range is all results");
  assert.equal(
    entriesToDisplayMessages(orphanRange).length,
    0,
    "and on its own it renders nothing",
  );

  const poisoned = attach(log, describeTimelineCache(orphanRange, 2));
  assert.equal(
    poisoned.timelineBase,
    undefined,
    "the unrenderable anchor is not accepted",
  );
  assert.equal(
    poisoned.timelineStart,
    1,
    "the answer is the renderable window, which opens at the declaring entry",
  );
  assert.ok(
    entriesToDisplayMessages(poisoned.timeline).length >= 1,
    "so a browser holding the poisoned range renders without clearing it",
  );
  assert.ok(
    poisoned.timelineCache &&
      poisoned.timelineCache.startIndex === poisoned.timelineStart,
    "and the anchor it is told to persist describes that renderable range",
  );

  // The floor is about what the client RENDERS, not about the cached slice alone:
  // once a visible entry lands after it, the same range earns the tail delta.
  log.append({
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [{ type: "text", text: "and now something visible" }],
  });
  const revived = attach(log, describeTimelineCache(orphanRange, 2));
  assert.deepEqual(
    revived.timelineBase,
    describeTimelineCache(orphanRange, 2),
    "a range whose rendered result now holds a visible entry is honoured",
  );
  assert.equal(revived.timelineStart, 2 + CALLS, "and only the tail is sent");
});

/* ---- 9. the snapshot projection IS the full one, minus unused bodies ----- */
test("the snapshot projection IS the full one, minus unused bodies", () => {
  const log = longLog();
  const full = log.clientTimeline({ lazyBodies: true });
  const { timeline, contentFromRow } = log.clientTimelineForSnapshot();
  // Same rows, same identities, same order — that is what every index on the
  // wire (`timelineStart`, `totalEntryCount`, a cache descriptor) counts in.
  assert.equal(timeline.length, full.length, "row count is unchanged");
  assert.deepEqual(
    timeline.map((entry) => entry.id),
    full.map((entry) => entry.id),
    "row identities are unchanged",
  );
  // Everything the reader is actually sent is byte-for-byte the full projection.
  assert.deepEqual(
    timeline.slice(contentFromRow),
    full.slice(contentFromRow),
    "the bodied tail matches the full projection exactly",
  );
  // And the snapshot a viewer receives is the same one it always was.
  assert.deepEqual(attach(log), attach(log), "attach is deterministic");
  const snapshot = attach(log);
  assert.deepEqual(
    snapshot.timeline,
    full.slice(snapshot.timelineStart),
    "the window sent is the full projection's tail",
  );
});

/* -- 10. an orphan run LONGER than the bodied tail still finds its declarer -- */
test("an orphan run LONGER than the bodied tail still finds its declarer", () => {
  // The renderability floor searches BACKWARD for the assistant entry that
  // declared the orphan results in the window — by reading its `toolCall`
  // blocks. A snapshot projects bodies only for the tail, so a tool loop longer
  // than that tail puts the declaring entry in the bodyless region, where the
  // floor cannot recognise it: it gives up, the window opens on nothing but
  // orphan results, and the transcript renders EMPTY. Comparing the walk's
  // result against the bodied boundary does not catch this — the floor never
  // returns a bodyless row in the first place — so what is checked is the
  // OUTCOME: a window that renders nothing is re-projected in full.
  const log = toolLoopLog(1_400);
  const full = log.clientTimeline({ lazyBodies: true });
  const snapshot = attach(log);

  const first = snapshot.timeline[0]!;
  assert.ok(
    first.type === "message" && first.role === "assistant",
    "the window opens at the entry that declares its calls, however far back it is",
  );
  assert.ok(
    entriesToDisplayMessages(snapshot.timeline).length >= 1,
    "a windowed snapshot always projects at least one display message",
  );
  assert.deepEqual(
    snapshot.timeline,
    full.slice(snapshot.timelineStart),
    "and what it sends is still exactly the full projection's tail",
  );
});
