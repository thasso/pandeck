import { describe, expect, test } from "vitest";
import type { DisplayBlock, DisplayMessage } from "./protocol.ts";
import type { AgentUsage } from "./session/index.ts";
import { entriesToDisplayMessages } from "./displayMapping.ts";
import {
  timelineRangeStart,
  timelineWindowStart,
  type ClientTimelineEntry,
} from "./runtimeEvents.ts";
import {
  accumulateTurnStats,
  EMPTY_TURN_STATS_SEED,
  finalResponseBoundary,
  groupTurns,
  turnStatsSeedForMessages,
  turnStatsSeedForWindow,
  promptCacheHitRatio,
  turnRuns,
  turnTotals,
  type Turn,
} from "./turnStats.ts";

function user(id: string, text = "hi"): DisplayMessage {
  return { id, role: "user", blocks: [{ kind: "text", text }] };
}

function assistant(
  id: string,
  blocks: DisplayBlock[],
  extra: Partial<DisplayMessage> = {},
): DisplayMessage {
  return { id, role: "assistant", blocks, ...extra };
}

const text = (t: string): DisplayBlock => ({ kind: "text", text: t });
const tool = (toolId: string): DisplayBlock => ({
  kind: "tool",
  toolId,
  name: "bash",
  args: {},
  output: "",
  isError: false,
  done: true,
});
const usage = (u: AgentUsage): Partial<DisplayMessage> => ({ usage: u });

/** Grab a turn by index, asserting it exists (satisfies noUncheckedIndexedAccess). */
function turnAt(turns: Turn[], i: number): Turn {
  const turn = turns[i];
  if (!turn) throw new Error(`expected a turn at index ${i}`);
  return turn;
}

describe("groupTurns", () => {
  test("splits at each user message and tracks the last assistant id", () => {
    const messages = [
      user("u1"),
      assistant("a1", [text("one")]),
      assistant("a2", [text("two")]),
      user("u2"),
      assistant("a3", [text("three")]),
    ];
    const turns = groupTurns(messages);
    expect(turns).toHaveLength(2);
    expect(turnAt(turns, 0).assistantMessages.map((m) => m.id)).toEqual([
      "a1",
      "a2",
    ]);
    expect(turnAt(turns, 0).lastAssistantId).toBe("a2");
    expect(turnAt(turns, 1).lastAssistantId).toBe("a3");
  });

  test("a turn with a streaming message is not complete", () => {
    const turns = groupTurns([
      user("u1"),
      assistant("live", [text("…")], { streaming: true }),
    ]);
    expect(turnAt(turns, 0).complete).toBe(false);
  });

  test("assistant messages before any user form a leading turn", () => {
    const turns = groupTurns([
      assistant("a0", [text("intro")]),
      user("u1"),
      assistant("a1", [text("hi")]),
    ]);
    expect(turns).toHaveLength(2);
    expect(turnAt(turns, 0).assistantMessages.map((m) => m.id)).toEqual(["a0"]);
  });
});

describe("turnTotals", () => {
  test("sums usage across the turn's requests and counts tool blocks", () => {
    const turns = groupTurns([
      user("u1"),
      assistant(
        "a1",
        [tool("t1")],
        usage({
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheCreationTokens: 200,
          costUSD: 0.01,
          contextWindowTokens: 200_000,
        }),
      ),
      assistant("a2", [text("done")], {
        ...usage({
          inputTokens: 300,
          outputTokens: 20,
          cacheReadTokens: 280,
          cacheCreationTokens: 0,
          costUSD: 0.02,
        }),
        model: "claude",
        startedAt: "2026-07-15T10:00:00.000Z",
        completedAt: "2026-07-15T10:00:05.000Z",
      }),
    ]);
    const totals = turnTotals(turnAt(turns, 0));
    expect(totals.input).toBe(400);
    expect(totals.output).toBe(30);
    expect(totals.cacheRead).toBe(280);
    expect(totals.cacheWrite).toBe(200);
    expect(totals.cost).toBeCloseTo(0.03, 5);
    expect(totals.toolCalls).toBe(1);
    expect(totals.runCount).toBe(2);
    expect(totals.model).toBe("claude");
    // Context size = the LAST run's prompt tokens (input + cacheRead + cacheWrite).
    expect(totals.contextSize).toBe(300 + 280 + 0);
    expect(totals.contextSizeIsEstimate).toBe(true);
    // Hit ratio counts cache WRITES as misses: cacheRead / (input + read + write).
    expect(totals.cacheHitRatio).toBeCloseTo(280 / (400 + 280 + 200), 5);
  });

  test("keeps context occupancy and capacity separate from billed input", () => {
    const turns = groupTurns([
      user("u1"),
      // Per-turn usage sums the tool loop's requests (5 × ~40k prompt each), so the
      // billed-input sum wildly exceeds the real context; the snapshot wins.
      assistant(
        "a1",
        [text("done")],
        usage({
          inputTokens: 500,
          outputTokens: 50,
          cacheReadTokens: 200_000,
          contextTokens: 42_000,
          contextWindowTokens: 1_000_000,
        }),
      ),
    ]);
    const totals = turnTotals(turnAt(turns, 0));
    expect(totals.contextSize).toBe(42_000);
    expect(totals.contextSizeIsEstimate).toBe(false);
    expect(totals.contextWindow).toBe(1_000_000);
    expect(totals.input + totals.cacheRead + totals.cacheWrite).toBe(200_500);
  });

  test("the estimate flag follows the LAST run's reporting", () => {
    // A reported snapshot early in the turn does not make a later fallback exact.
    const reportedThenNot = groupTurns([
      user("u1"),
      assistant("a1", [tool("t1")], usage({ contextTokens: 42_000 })),
      assistant("a2", [text("done")], usage({ inputTokens: 500 })),
    ]);
    expect(turnTotals(turnAt(reportedThenNot, 0)).contextSizeIsEstimate).toBe(
      true,
    );

    const notThenReported = groupTurns([
      user("u1"),
      assistant("a1", [tool("t1")], usage({ inputTokens: 500 })),
      assistant("a2", [text("done")], usage({ contextTokens: 42_000 })),
    ]);
    const totals = turnTotals(turnAt(notThenReported, 0));
    expect(totals.contextSizeIsEstimate).toBe(false);
    expect(totals.contextSize).toBe(42_000);
  });

  test("cacheHitRatio is null when the turn had no prompt tokens", () => {
    const turns = groupTurns([
      user("u1"),
      assistant("a1", [text("hi")], usage({ outputTokens: 5 })),
    ]);
    expect(turnTotals(turnAt(turns, 0)).cacheHitRatio).toBeNull();
  });

  test("a write-heavy first turn is not reported as a cache hit", () => {
    // Seeding the cache is a MISS: 1k uncached + 100k read + 20k written is an
    // 83% hit rate, not the ~99% the read-only denominator would claim.
    const turns = groupTurns([
      user("u1"),
      assistant(
        "a1",
        [text("done")],
        usage({
          inputTokens: 1_000,
          cacheReadTokens: 100_000,
          cacheCreationTokens: 20_000,
        }),
      ),
    ]);
    const ratio = turnTotals(turnAt(turns, 0)).cacheHitRatio;
    expect(ratio).toBeCloseTo(100_000 / 121_000, 5);
    expect(ratio).toBeLessThan(0.85);
  });

  test("derives duration across the turn's request timing", () => {
    const turns = groupTurns([
      user("u1"),
      assistant("a1", [tool("t1")], {
        ...usage({ inputTokens: 1 }),
        startedAt: "2026-07-15T10:00:00.000Z",
        completedAt: "2026-07-15T10:00:02.000Z",
      }),
      assistant("a2", [text("done")], {
        ...usage({ inputTokens: 1 }),
        startedAt: "2026-07-15T10:00:03.000Z",
        completedAt: "2026-07-15T10:00:09.000Z",
      }),
    ]);
    expect(turnTotals(turnAt(turns, 0)).durationMs).toBe(9000);
  });
});

describe("promptCacheHitRatio", () => {
  test("ignores no prompt-token bucket", () => {
    // Zero writes: reads over reads + uncached input.
    expect(
      promptCacheHitRatio({ input: 1_000, cacheRead: 9_000, cacheWrite: 0 }),
    ).toBeCloseTo(0.9, 5);
    // All written, nothing read: a full miss.
    expect(
      promptCacheHitRatio({ input: 0, cacheRead: 0, cacheWrite: 20_000 }),
    ).toBe(0);
    // Mixed.
    expect(
      promptCacheHitRatio({
        input: 500,
        cacheRead: 30_000,
        cacheWrite: 9_500,
      }),
    ).toBeCloseTo(30_000 / 40_000, 5);
  });

  test("is null without prompt tokens", () => {
    expect(
      promptCacheHitRatio({ input: 0, cacheRead: 0, cacheWrite: 0 }),
    ).toBeNull();
  });
});

describe("turnRuns", () => {
  test("emits one indexed row per usage-bearing provider run, exposing its cache split", () => {
    const turns = groupTurns([
      user("u1"),
      assistant(
        "a1",
        [tool("t1")],
        usage({ inputTokens: 5000, cacheReadTokens: 0 }),
      ),
      assistant(
        "a2",
        [text("done")],
        usage({ inputTokens: 200, cacheReadTokens: 5100 }),
      ),
    ]);
    const rows = turnRuns(turnAt(turns, 0));
    expect(rows.map((r) => r.index)).toEqual([1, 2]);
    expect(rows[0]?.cacheRead).toBe(0); // cold first request — the cache-miss signal
    expect(rows[1]?.cacheRead).toBe(5100);
  });

  test("skips assistant messages with no usage (e.g. cards)", () => {
    const turns = groupTurns([user("u1"), assistant("card", [text("card")])]);
    expect(turnRuns(turnAt(turns, 0))).toHaveLength(0);
  });
});

describe("finalResponseBoundary", () => {
  test("points before the first text after the last tool, within one message", () => {
    const turns = groupTurns([
      user("u1"),
      assistant("a1", [tool("t1"), text("answer")]),
    ]);
    expect(finalResponseBoundary(turnAt(turns, 0))).toEqual({
      messageId: "a1",
      blockIndex: 1,
    });
  });

  test("resolves across message boundaries", () => {
    const turns = groupTurns([
      user("u1"),
      assistant("a1", [text("thinking out loud"), tool("t1")]),
      assistant("a2", [text("final answer")]),
    ]);
    expect(finalResponseBoundary(turnAt(turns, 0))).toEqual({
      messageId: "a2",
      blockIndex: 0,
    });
  });

  test("null when the turn had no tool activity", () => {
    const turns = groupTurns([
      user("u1"),
      assistant("a1", [text("just an answer")]),
    ]);
    expect(finalResponseBoundary(turnAt(turns, 0))).toBeNull();
  });

  test("null when the turn ended on a tool with no trailing answer", () => {
    const turns = groupTurns([
      user("u1"),
      assistant("a1", [text("prep"), tool("t1")]),
    ]);
    expect(finalResponseBoundary(turnAt(turns, 0))).toBeNull();
  });
});

describe("seeded running stats (windowed transcript)", () => {
  /** Ten turns, each one prompt + one usage-bearing answer with growing context. */
  const conversation = Array.from({ length: 10 }, (_, i) => [
    user(`u${i}`),
    assistant(`a${i}`, [tool(`t${i}`), text(`answer ${i}`)], {
      ...usage({
        inputTokens: 10 + i,
        outputTokens: 5,
        cacheReadTokens: 100 + i,
        cacheCreationTokens: 2,
        costUSD: 0.01,
        contextTokens: 1000 + i * 10,
      }),
      model: "opus",
    }),
  ]).flat();

  test("a seeded window renders exactly the rows the full list would", () => {
    const full = accumulateTurnStats(conversation);
    // The transcript only holds the last four turns (eight messages).
    const window = conversation.slice(-8);
    const seed = turnStatsSeedForMessages(conversation.slice(0, -8));
    const seeded = accumulateTurnStats(window, seed);

    expect(seeded).toHaveLength(4);
    expect(seeded.map((row) => row.cumulative)).toEqual(
      full.slice(-4).map((row) => row.cumulative),
    );
    expect(seeded.map((row) => row.contextDelta)).toEqual(
      full.slice(-4).map((row) => row.contextDelta),
    );
    expect(seeded.every((row) => row.showSessionCumulative)).toBe(true);
  });

  test("an unseeded window under-counts — which is what the seed exists to fix", () => {
    const window = conversation.slice(-8);
    const unseeded = accumulateTurnStats(window);
    const seeded = accumulateTurnStats(
      window,
      turnStatsSeedForMessages(conversation.slice(0, -8)),
    );
    expect(unseeded[0]!.cumulative.input).toBeLessThan(
      seeded[0]!.cumulative.input,
    );
    // Without a seed the first rendered turn claims the whole context as growth.
    expect(unseeded[0]!.contextDelta).toBeGreaterThan(seeded[0]!.contextDelta);
  });

  test("loading an older range moves the seed back, leaving rendered rows put", () => {
    const window = conversation.slice(-8);
    const seed = turnStatsSeedForMessages(conversation.slice(0, -8));
    const rendered = accumulateTurnStats(window, seed);

    // The reader loads two more turns: the new seed covers less history, and the
    // rows that were already on screen must be unchanged.
    const grown = conversation.slice(-12);
    const grownSeed = turnStatsSeedForMessages(conversation.slice(0, -12));
    const regrown = accumulateTurnStats(grown, grownSeed);

    expect(regrown.slice(-4).map((row) => row.cumulative)).toEqual(
      rendered.map((row) => row.cumulative),
    );
    expect(regrown.slice(-4).map((row) => row.contextDelta)).toEqual(
      rendered.map((row) => row.contextDelta),
    );
  });

  test("the empty seed is the identity", () => {
    expect(accumulateTurnStats(conversation, EMPTY_TURN_STATS_SEED)).toEqual(
      accumulateTurnStats(conversation),
    );
  });
});

describe("a turn longer than the wire budget", () => {
  /** One assistant entry with usage; `n` of them make a single very long turn. */
  function assistantEntry(seq: number, input: number, context: number) {
    return {
      id: `a${seq}`,
      seq,
      createdAt: "2026-01-01T00:00:00.000Z",
      type: "message",
      role: "assistant",
      model: "opus",
      content: [{ type: "text", text: "step" }],
      usage: {
        inputTokens: input,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUSD: 0.01,
        contextTokens: context,
      },
    } as ClientTimelineEntry;
  }

  function userEntry(seq: number) {
    return {
      id: `u${seq}`,
      seq,
      createdAt: "2026-01-01T00:00:00.000Z",
      type: "message",
      role: "user",
      origin: { kind: "human" },
      content: [{ type: "text", text: "go" }],
    } as ClientTimelineEntry;
  }

  // Three ordinary turns, then one turn of 900 usage-bearing runs — longer than
  // any window budget, so the window must open INSIDE it.
  const full: ClientTimelineEntry[] = [
    ...[0, 1, 2].flatMap((t) => [
      userEntry(t * 2),
      assistantEntry(t * 2 + 1, 100, 1_000 + t),
    ]),
    userEntry(1_000),
    ...Array.from({ length: 900 }, (_, i) =>
      assistantEntry(1_001 + i, 10, 5_000 + i),
    ),
  ];

  const rowsFor = (start: number) =>
    accumulateTurnStats(
      entriesToDisplayMessages(full.slice(start)),
      turnStatsSeedForWindow(full, start),
    );

  test("the window opens mid-turn and the seed says so", () => {
    const start = timelineWindowStart(full);
    // Past the long turn's prompt (index 6), i.e. inside the turn itself.
    expect(start).toBeGreaterThan(6);
    const seed = turnStatsSeedForWindow(full, start);
    expect(seed?.partialTurn).toBe(true);
    expect(rowsFor(start)[0]!.partial).toBe(true);
  });

  test("the fragment's own totals are NOT the turn's, which is why it is flagged", () => {
    const start = timelineWindowStart(full);
    const fragment = rowsFor(start)[0]!;
    const wholeTurn = accumulateTurnStats(entriesToDisplayMessages(full)).at(
      -1,
    )!;
    // Renderers must not draw this row: its input is a fraction of the turn's,
    // and it would grow with every "load earlier".
    expect(fragment.totals.input).toBeLessThan(wholeTurn.totals.input);
    expect(fragment.partial).toBe(true);
    expect(wholeTurn.partial).toBe(false);
  });

  test("loading an older range leaves every DRAWN row exactly as it was", () => {
    const start = timelineWindowStart(full);
    const older = timelineRangeStart(full, start);
    expect(older).toBeLessThan(start);

    const drawn = (rows: ReturnType<typeof accumulateTurnStats>) =>
      rows.filter((row) => !row.partial);
    const before = drawn(rowsFor(start));
    const after = drawn(rowsFor(older));

    // Nothing that was on screen moved: same rows, same numbers. The fragment is
    // the only row that changes, and it is not drawn while it is one.
    expect(after.slice(after.length - before.length)).toEqual(before);
    // The running cumulative still matches the unwindowed transcript (cost is
    // summed in a different order, so compare it to the cent).
    const fullRows = accumulateTurnStats(entriesToDisplayMessages(full));
    const windowed = rowsFor(older).at(-1)!.cumulative;
    const unwindowed = fullRows.at(-1)!.cumulative;
    expect({ ...windowed, cost: windowed.cost.toFixed(2) }).toEqual({
      ...unwindowed,
      cost: unwindowed.cost.toFixed(2),
    });
  });

  test("the fragment does not double-count its turn in the Session threshold", () => {
    const start = timelineWindowStart(full);
    const rows = rowsFor(start);
    const seed = turnStatsSeedForWindow(full, start)!;
    // The seed already counted the turn this fragment belongs to.
    expect(rows[0]!.showSessionCumulative).toBe(seed.usageTurnCount > 1);
  });
});
