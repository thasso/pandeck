/**
 * The wire-level timeline window: which entries a snapshot carries, which ones a
 * "load earlier" answers with, and what a browser's cached RANGE has to match to
 * earn a tail-only snapshot.
 *
 * These are pure decisions with a user-visible failure mode on each side —
 * ship too much and opening a long session costs megabytes, ship a mis-anchored
 * range and the transcript is spliced with someone else's rows.
 */
import { describe, expect, test } from "vitest";
import {
  describeTimelineCache,
  describeTimelineRange,
  timelineEntryStartsTurn,
  timelineMatchesCacheDescriptor,
  timelineRangeIsRenderable,
  timelineRangeStart,
  timelineWindowStart,
  SNAPSHOT_TIMELINE_MIN_ENTRIES,
  SNAPSHOT_TIMELINE_WINDOW_BYTES,
  SNAPSHOT_TIMELINE_WINDOW_ENTRIES,
  type ClientTimelineEntry,
} from "./runtimeEvents.ts";
import { entriesToDisplayMessages } from "./displayMapping.ts";

function userEntry(seq: number, text = "hi"): ClientTimelineEntry {
  return {
    id: `e${seq}`,
    seq,
    createdAt: "2026-01-01T00:00:00.000Z",
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [{ type: "text", text }],
  };
}

function assistantEntry(seq: number, text = "ok"): ClientTimelineEntry {
  return {
    id: `e${seq}`,
    seq,
    createdAt: "2026-01-01T00:00:00.000Z",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
  };
}

/** `turns` turns of one prompt + `perTurn` assistant entries of `size` bytes. */
function timeline(
  turns: number,
  perTurn = 3,
  size = 10,
): ClientTimelineEntry[] {
  const out: ClientTimelineEntry[] = [];
  for (let t = 0; t < turns; t += 1) {
    out.push(userEntry(out.length));
    for (let i = 0; i < perTurn; i += 1)
      out.push(assistantEntry(out.length, "x".repeat(size)));
  }
  return out;
}

/**
 * One prompt + ONE assistant entry declaring `calls` tool calls + `calls`
 * results — the persisted shape of a long tool loop, where every result's
 * declaring entry is the single assistant entry.
 */
function toolLoopTurn(calls: number): ClientTimelineEntry[] {
  const out: ClientTimelineEntry[] = [userEntry(0)];
  out.push({
    id: "e1",
    seq: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    type: "message",
    role: "assistant",
    content: Array.from({ length: calls }, (_, i) => ({
      type: "toolCall",
      toolCallId: `tc-${i}`,
      name: "bash",
      input: { cmd: `ls step-${i} in some long working directory` },
    })),
  });
  for (let i = 0; i < calls; i += 1)
    out.push({
      id: `e${2 + i}`,
      seq: 2 + i,
      createdAt: "2026-01-01T00:00:00.000Z",
      type: "message",
      role: "toolResult",
      toolCallId: `tc-${i}`,
      content: [{ type: "text", text: `output of step ${i} padded a bit` }],
      isError: false,
    });
  return out;
}

/** Bytes of the slice a start index produces — what actually goes on the wire. */
function sliceBytes(
  entries: readonly ClientTimelineEntry[],
  start: number,
  end = entries.length,
): number {
  return entries
    .slice(start, end)
    .reduce((sum, entry) => sum + JSON.stringify(entry).length, 0);
}

describe("timelineRangeIsRenderable", () => {
  // The gate every slice handed to a client passes, whichever path produced it:
  // the budget walk extends an unrenderable one, an accepted cache anchor is
  // dropped for one (Task 450). It has to agree with the projection to be either.
  test("agrees with the display projection about what shows a row", () => {
    const full = toolLoopTurn(140);
    const cases: [number, number][] = [
      [0, full.length], // the whole thing
      [2, full.length], // nothing but orphan results
      [1, full.length], // the declaring assistant entry and its results
      [0, 1], // one visible prompt
      [5, 5], // an empty range
      [full.length - 1, full.length], // one trailing orphan
    ];
    for (const [start, end] of cases)
      expect([start, end, timelineRangeIsRenderable(full, start, end)]).toEqual(
        [
          start,
          end,
          entriesToDisplayMessages(full.slice(start, end)).length > 0,
        ],
      );
  });

  test("a hidden prompt starts no rendered turn, so it renders nothing", () => {
    const hidden: ClientTimelineEntry = {
      ...(userEntry(0) as Extract<ClientTimelineEntry, { role: "user" }>),
      hidden: true,
    };
    expect(timelineRangeIsRenderable([hidden])).toBe(false);
    expect(entriesToDisplayMessages([hidden])).toHaveLength(0);
    expect(timelineRangeIsRenderable([hidden, assistantEntry(1)])).toBe(true);
  });

  test("defaults to the whole timeline and clamps a negative start", () => {
    expect(timelineRangeIsRenderable(timeline(2))).toBe(true);
    expect(timelineRangeIsRenderable([])).toBe(false);
    expect(timelineRangeIsRenderable(timeline(2), -3)).toBe(true);
  });
});

describe("timelineWindowStart", () => {
  test("a short session is sent whole", () => {
    expect(timelineWindowStart(timeline(10))).toBe(0);
  });

  test("a long session is cut to the entry budget, at a turn boundary", () => {
    const full = timeline(400);
    const start = timelineWindowStart(full);
    expect(start).toBeGreaterThan(0);
    expect(full.length - start).toBeLessThanOrEqual(
      SNAPSHOT_TIMELINE_WINDOW_ENTRIES,
    );
    // Turn-aligned whenever a boundary fits the budget: cutting mid-turn drops
    // that turn's orphaned tool results and leaves a fragment the renderer then
    // has to suppress.
    expect(full[start]).toMatchObject({ role: "user" });
  });

  test("fat entries hit the byte budget first, down to the floor", () => {
    // 4 KB per entry: the entry budget would allow 400 of them (1.6 MB).
    const fat = timeline(200, 3, 4000);
    const start = timelineWindowStart(fat);
    const kept = fat.length - start;
    expect(kept).toBeLessThan(SNAPSHOT_TIMELINE_WINDOW_ENTRIES);
    expect(kept).toBeGreaterThanOrEqual(SNAPSHOT_TIMELINE_MIN_ENTRIES);
  });

  test("the byte budget holds even when turns are longer than it", () => {
    // Turn shapes that used to be answered with 515 KB and 1.2 MB: the snap to a
    // turn boundary ran AFTER the budget walk and paid no byte accounting.
    for (const [perTurn, size] of [
      [250, 2000],
      [300, 4000],
      [900, 2000],
    ] as const) {
      const full = timeline(6, perTurn, size);
      const start = timelineWindowStart(full);
      const kept = full.length - start;
      expect(kept).toBeLessThanOrEqual(SNAPSHOT_TIMELINE_WINDOW_ENTRIES);
      // The entry floor is the only over-run in play here (no tool results), so
      // bound the payload by what the floor's entries can cost rather than by
      // the byte budget alone.
      expect(sliceBytes(full, start)).toBeLessThanOrEqual(
        SNAPSHOT_TIMELINE_WINDOW_BYTES +
          SNAPSHOT_TIMELINE_MIN_ENTRIES * size * 2,
      );
    }
  });

  test("a turn longer than the budget yields a MID-TURN start", () => {
    // One 900-entry turn at the tail: starting at its prompt would put the whole
    // turn on the wire, so the window opens inside it — and says so through the
    // seed (`turnStatsSeedForWindow`), which is what suppresses the fragment row.
    const full = [
      ...timeline(3),
      userEntry(1000),
      ...Array.from({ length: 900 }, (_, i) => assistantEntry(1001 + i, "x")),
    ];
    const start = timelineWindowStart(full);
    expect(timelineEntryStartsTurn(full[start])).toBe(false);
    expect(full.length - start).toBeLessThanOrEqual(
      SNAPSHOT_TIMELINE_WINDOW_ENTRIES,
    );
  });

  test("a boundary too close to the tail loses to the entry floor", () => {
    // The last turn is two entries old; everything before it is one huge turn.
    // Starting at that boundary would render two rows, so the budget frontier
    // wins and the window is a fragment instead.
    const full = [
      userEntry(0),
      ...Array.from({ length: 500 }, (_, i) => assistantEntry(1 + i, "x")),
      userEntry(501),
      assistantEntry(502, "x"),
    ];
    const start = timelineWindowStart(full);
    expect(full.length - start).toBeGreaterThanOrEqual(
      SNAPSHOT_TIMELINE_MIN_ENTRIES,
    );
    expect(timelineEntryStartsTurn(full[start])).toBe(false);
  });

  test("an explicit budget bounds the window", () => {
    const full = timeline(100);
    expect(full.length - timelineWindowStart(full, 20)).toBeLessThanOrEqual(20);
  });

  test("a window never holds only orphan tool results (Task 449)", () => {
    // One turn: user + ONE assistant entry declaring 140 calls + 140 results.
    // The results fit the byte budget, the fat assistant entry does not, so the
    // budget walk breaks right after it — a window of nothing but tool results,
    // which the display projection renders as ZERO messages and the client
    // mistakes for an empty session. The renderability floor must pull the
    // declaring entry back in.
    const full = toolLoopTurn(140);
    expect(entriesToDisplayMessages(full.slice(2))).toHaveLength(0);

    const start = timelineWindowStart(full, 300, 40_000);
    expect(start).toBe(1);
    const messages = entriesToDisplayMessages(full.slice(start));
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0]).toMatchObject({ role: "assistant" });
  });

  test("the floor also covers a budget break INSIDE the results", () => {
    // A tighter byte budget breaks mid-results (the 019febcc shape: start deep
    // in the result run, not right after the assistant entry). The floor still
    // walks back to the one entry that declares the calls.
    const full = toolLoopTurn(140);
    const start = timelineWindowStart(full, 300, 20_000);
    expect(start).toBe(1);
    expect(
      entriesToDisplayMessages(full.slice(start)).length,
    ).toBeGreaterThanOrEqual(1);
  });

  test("one undeclared call does not defeat the floor", () => {
    // The slice's FIRST result was never declared (a truncated/compacted head),
    // but the rest were. Keying the floor on that one call would give up and
    // answer an unrenderable window; the floor must anchor on ANY of the
    // slice's calls instead.
    const full = toolLoopTurn(140).map((entry) =>
      entry.type === "message" && entry.role === "assistant"
        ? {
            ...entry,
            content: entry.content.filter(
              (c) => c.type !== "toolCall" || c.toolCallId !== "tc-0",
            ),
          }
        : entry,
    );
    const start = timelineWindowStart(full, 300, 40_000);
    expect(start).toBe(1);
    expect(
      entriesToDisplayMessages(full.slice(start)).length,
    ).toBeGreaterThanOrEqual(1);
  });

  test("a slice that already renders is never extended", () => {
    // The cut lands ON an assistant entry followed by another turn's orphan
    // results. The slice renders (the assistant entry is a message), so the
    // floor must stay out of it: the orphans are the documented mid-turn drop,
    // not a reason to pull the whole loop back in.
    const loop = toolLoopTurn(140);
    const full = [
      ...loop.slice(0, 102), // user, declarer, results tc-0..tc-99
      assistantEntry(102, "interim note"),
      ...loop.slice(102, 142), // results tc-100..tc-139, now after the note
    ];
    const start = timelineWindowStart(full, 41);
    expect(start).toBe(102);
    const messages = entriesToDisplayMessages(full.slice(start));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "assistant" });
  });

  test("results with no declarer anywhere leave the cut alone", () => {
    // A log corrupt enough to hold results whose call was never declared has
    // nothing to extend to; the floor must fall back to the budget frontier
    // rather than scanning forever or throwing.
    const full = toolLoopTurn(140).filter(
      (entry) => !(entry.type === "message" && entry.role === "assistant"),
    );
    const start = timelineWindowStart(full, 300, 20_000);
    expect(start).toBeGreaterThan(0);
  });
});

describe("timelineRangeStart", () => {
  test("walks back a bounded slice and stops at the session start", () => {
    const full = timeline(100);
    const end = timelineWindowStart(full, 40);
    const start = timelineRangeStart(full, end, 40);
    expect(start).toBeLessThan(end);
    expect(end - start).toBeLessThanOrEqual(40);
    expect(full[start]).toMatchObject({ role: "user" });
    expect(timelineRangeStart(full, 10, 40)).toBe(0);
  });

  test("is defensive about the arguments its callers already validate", () => {
    const full = timeline(100);
    // A non-positive limit used to throw (it indexed `timeline[end]`) or answer
    // an empty range forever; an out-of-bounds end is clamped.
    expect(timelineRangeStart(full, 300, 0)).toBeLessThan(full.length);
    expect(timelineRangeStart(full, 300, -5)).toBeLessThan(full.length);
    expect(timelineRangeStart(full, -1)).toBe(0);
  });

  test("'load older' never answers an all-orphan slice (Task 449)", () => {
    // The client renders from mid-results and asks for what precedes it. A
    // byte-bounded answer would be more of the same tool results — orphans that
    // prepend NOTHING and make the button look dead. The floor extends the
    // range to the declaring assistant entry instead.
    const full = toolLoopTurn(140);
    const start = timelineRangeStart(full, 100, 240, 5_000);
    expect(start).toBe(1);
    expect(
      entriesToDisplayMessages(full.slice(start, 100)).length,
    ).toBeGreaterThanOrEqual(1);
  });
});

describe("cache descriptors describe a RANGE", () => {
  const full = timeline(20);

  test("a range in the middle matches only at its own start index", () => {
    const descriptor = describeTimelineRange(full, 30, 50);
    expect(descriptor.startIndex).toBe(30);
    expect(descriptor.entryCount).toBe(20);
    expect(timelineMatchesCacheDescriptor(full, descriptor)).toBe(true);
    expect(
      timelineMatchesCacheDescriptor(full, { ...descriptor, startIndex: 29 }),
    ).toBe(false);
  });

  test("a changed entry inside the range is caught by the fingerprint", () => {
    const descriptor = describeTimelineRange(full, 30, 50);
    const edited = [...full];
    edited[35] = assistantEntry(35, "rewritten");
    expect(timelineMatchesCacheDescriptor(edited, descriptor)).toBe(false);
  });

  test("a range claiming entries past the tail never matches", () => {
    const descriptor = describeTimelineRange(full, 30, 50);
    expect(timelineMatchesCacheDescriptor(full.slice(0, 45), descriptor)).toBe(
      false,
    );
  });

  test("the empty descriptor is only ever a start-of-timeline anchor", () => {
    const empty = describeTimelineCache([]);
    expect(empty.startIndex).toBe(0);
    expect(timelineMatchesCacheDescriptor(full, empty)).toBe(true);
    expect(
      timelineMatchesCacheDescriptor(full, { ...empty, startIndex: 5 }),
    ).toBe(false);
  });
});
