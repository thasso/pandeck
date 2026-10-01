import { describe, expect, it } from "vitest";
import type { IdleWriterEnv } from "./idleWriter.ts";
import {
  createTranscriptScrollMemory,
  nextRowEstimate,
  nextScrollMode,
  parseTranscriptScrollMemory,
  positionToRemember,
  rememberTranscriptScroll,
  restorableTranscriptPosition,
  ROW_ESTIMATE_DEFAULT_PX,
  ROW_ESTIMATE_MAX_PX,
  ROW_ESTIMATE_MIN_PX,
  rowHeightSample,
  shouldPublishRowEstimate,
  TRANSCRIPT_SCROLL_KEY,
  TRANSCRIPT_SCROLL_LIMIT,
  transcriptTailKey,
  type TranscriptScrollAnchor,
  type TranscriptScrollMemoryEntry,
  type TranscriptScrollStorage,
} from "./transcriptScroll.ts";

interface FakeEnv extends IdleWriterEnv {
  advance(ms: number): void;
  runIdle(): void;
}

function fakeEnv(): FakeEnv {
  let now = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  let idle: Array<() => void> = [];
  return {
    now: () => now,
    setTimer: (run, ms) => {
      const handle = nextHandle++;
      timers.set(handle, { at: now + ms, run });
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle);
    },
    whenIdle: (run) => {
      idle.push(run);
    },
    advance(ms: number) {
      now += ms;
      for (const [handle, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(handle);
        timer.run();
      }
    },
    runIdle() {
      const due = idle;
      idle = [];
      for (const run of due) run();
    },
  };
}

function fakeStorage(
  initial?: string,
): TranscriptScrollStorage & { writes: string[]; value: string | null } {
  let value = initial ?? null;
  const writes: string[] = [];
  return {
    get value() {
      return value;
    },
    writes,
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
      writes.push(next);
    },
  };
}

const anchor: TranscriptScrollAnchor = {
  messageId: "m-42",
  offset: -120,
  rowsFromEnd: 18,
};
const atBottomMetrics = {
  scrollTop: 900,
  scrollHeight: 1500,
  clientHeight: 600,
};
const scrolledUpMetrics = {
  scrollTop: 100,
  scrollHeight: 1500,
  clientHeight: 600,
};

describe("nextScrollMode", () => {
  it("opens a transcript at its end when nothing is remembered", () => {
    expect(nextScrollMode("free", { kind: "session-opened" })).toBe("bottom");
    expect(
      nextScrollMode("free", {
        kind: "session-opened",
        remembered: { atBottom: true },
      }),
    ).toBe("bottom");
    // A remembered position without an anchor row cannot be restored.
    expect(
      nextScrollMode("free", {
        kind: "session-opened",
        remembered: { atBottom: false },
      }),
    ).toBe("bottom");
  });

  it("restores a remembered reading position", () => {
    expect(
      nextScrollMode("bottom", {
        kind: "session-opened",
        remembered: { atBottom: false, anchor },
      }),
    ).toBe("anchor");
  });

  it("pins to the bottom on this browser's own submit, wherever the reader was", () => {
    expect(nextScrollMode("free", { kind: "pin-requested" })).toBe("bottom");
    expect(nextScrollMode("anchor", { kind: "pin-requested" })).toBe("bottom");
  });

  it("hands the position back on any scroll the controller did not cause", () => {
    // Including a momentum fling, which fires scroll with no pointer event.
    expect(
      nextScrollMode("anchor", { kind: "user-scrolled", nearBottom: false }),
    ).toBe("free");
    expect(
      nextScrollMode("anchor", { kind: "user-scrolled", nearBottom: true }),
    ).toBe("free");
    expect(
      nextScrollMode("bottom", { kind: "user-scrolled", nearBottom: false }),
    ).toBe("free");
    expect(
      nextScrollMode("free", { kind: "user-scrolled", nearBottom: true }),
    ).toBe("bottom");
  });

  it("lets no mode be changed by a scroll the layout caused", () => {
    // The phone submit: the keyboard closes and the composer collapses into the
    // dock row, and the browser's own clamping reports a position far from the
    // end. That must not hand the position to the reader, or the turn's Thinking
    // row is left under the bottom card.
    expect(
      nextScrollMode("bottom", {
        kind: "user-scrolled",
        nearBottom: false,
        duringLayoutShift: true,
      }),
    ).toBe("bottom");
    // A restore is holding a row against exactly this: prepending rows the
    // browser has never measured moves the offset by hundreds of px per frame as
    // the estimates resolve, and abandoning the hold on the first of those left
    // the reader wherever the churn happened to stop.
    expect(
      nextScrollMode("anchor", {
        kind: "user-scrolled",
        nearBottom: true,
        duringLayoutShift: true,
      }),
    ).toBe("anchor");
    // And a reader reading history is not put back on the end because content
    // above them shrank enough to clamp the view there.
    expect(
      nextScrollMode("free", {
        kind: "user-scrolled",
        nearBottom: true,
        duringLayoutShift: true,
      }),
    ).toBe("free");
  });

  it("obeys the reader even mid-resize once an input backs the scroll", () => {
    // A wheel, a touch or a key during the churn is not the churn: whatever the
    // layout is doing, the reader asked for this one.
    expect(
      nextScrollMode("anchor", {
        kind: "user-scrolled",
        nearBottom: false,
        fromReaderInput: true,
        duringLayoutShift: true,
      }),
    ).toBe("free");
    expect(
      nextScrollMode("bottom", {
        kind: "user-scrolled",
        nearBottom: false,
        fromReaderInput: true,
        duringLayoutShift: true,
      }),
    ).toBe("free");
    // Scrolled back to the end by hand: follow new content again.
    expect(
      nextScrollMode("free", {
        kind: "user-scrolled",
        nearBottom: true,
        fromReaderInput: true,
        duringLayoutShift: true,
      }),
    ).toBe("bottom");
  });

  it("releases only a restore when the layout settles", () => {
    expect(nextScrollMode("anchor", { kind: "settled" })).toBe("free");
    expect(nextScrollMode("bottom", { kind: "settled" })).toBe("bottom");
    expect(nextScrollMode("free", { kind: "settled" })).toBe("free");
  });

  it("takes a deliberate anchor for load-earlier and cross-pane jumps", () => {
    expect(nextScrollMode("bottom", { kind: "anchor-requested" })).toBe(
      "anchor",
    );
  });
});

describe("positionToRemember", () => {
  it("records nothing while a restore is in flight", () => {
    expect(positionToRemember("anchor", scrolledUpMetrics, anchor)).toBeNull();
  });

  it("records the bottom while pinned, and while merely near it", () => {
    expect(positionToRemember("bottom", scrolledUpMetrics, anchor)).toEqual({
      atBottom: true,
    });
    expect(positionToRemember("free", atBottomMetrics, anchor)).toEqual({
      atBottom: true,
    });
  });

  it("records the anchor row while the reader owns the position", () => {
    expect(positionToRemember("free", scrolledUpMetrics, anchor)).toEqual({
      atBottom: false,
      anchor,
    });
    // No row to anchor on (an empty or unmeasured list) degrades to the end.
    expect(positionToRemember("free", scrolledUpMetrics, null)).toEqual({
      atBottom: true,
    });
  });
});

describe("content-versioned restoration", () => {
  const remembered = {
    atBottom: false,
    anchor,
    tailKey: "m-41\0m-42",
  } as const;

  it("restores an anchor only against the tail it was measured with", () => {
    expect(restorableTranscriptPosition(remembered, "m-41\0m-42")).toEqual(
      remembered,
    );
    expect(
      restorableTranscriptPosition(remembered, "m-42\0m-43"),
    ).toBeUndefined();
  });

  it("does not replay legacy unversioned anchors after a turn completed", () => {
    expect(
      restorableTranscriptPosition({ atBottom: false, anchor }, "m-41\0m-42"),
    ).toBeUndefined();
  });

  it("keeps an explicit end position independent of the tail", () => {
    expect(
      restorableTranscriptPosition({ atBottom: true }, "new-tail"),
    ).toEqual({ atBottom: true });
  });

  it("uses the penultimate row to distinguish reused live ids", () => {
    expect(transcriptTailKey([{ id: "user-1" }, { id: "live" }])).toBe(
      "user-1\0live",
    );
    expect(transcriptTailKey([{ id: "user-2" }, { id: "live" }])).toBe(
      "user-2\0live",
    );
    expect(transcriptTailKey([])).toBeUndefined();
  });
});

describe("row height estimate", () => {
  it("takes the median of the rows on screen, odd or even", () => {
    expect(rowHeightSample([100, 300, 200])).toBe(200);
    // The middle PAIR is averaged: taking the upper one made a 74/635 screenful
    // worth 635, which is the max, not a median.
    expect(rowHeightSample([635, 74])).toBe(354.5);
  });

  it("has nothing to say about no rows at all", () => {
    expect(rowHeightSample([])).toBeNull();
  });

  it("takes even a single row, which is the tall-row case", () => {
    // A transcript whose rows are taller than the viewport shows one row at a
    // time, and it is the one the 240px default is most wrong about: refusing
    // that sample left it uncalibrated exactly where a prepend needed it.
    expect(rowHeightSample([600])).toBe(600);
  });

  it("clamps a screenful that is one freak row", () => {
    // Measured on a real transcript: a 117px row beside a 5789px one.
    expect(rowHeightSample([117, 5789])).toBe(ROW_ESTIMATE_MAX_PX);
    expect(rowHeightSample([10, 20, 30])).toBe(ROW_ESTIMATE_MIN_PX);
  });

  it("converges on the transcript instead of settling short of it", () => {
    // The regression this guards: gating the ESTIMATE on the same threshold as
    // the CSS write left a true median of 300 unable to move off 240 at all, and
    // a true median of 700 frozen at 534. Every sample has to count.
    let estimate = ROW_ESTIMATE_DEFAULT_PX;
    for (let stop = 0; stop < 20; stop += 1)
      estimate = nextRowEstimate(estimate, 300);
    expect(estimate).toBeCloseTo(300, 1);

    estimate = ROW_ESTIMATE_DEFAULT_PX;
    for (let stop = 0; stop < 20; stop += 1)
      estimate = nextRowEstimate(estimate, 700);
    expect(estimate).toBeCloseTo(700, 1);
  });

  it("moves the estimate toward a sample without adopting it", () => {
    // No single screenful owns a session — including the first one.
    const once = nextRowEstimate(ROW_ESTIMATE_DEFAULT_PX, 800);
    expect(once).toBeGreaterThan(ROW_ESTIMATE_DEFAULT_PX);
    expect(once).toBeLessThan(800);
  });

  it("writes the placeholder only when the relayout is worth it", () => {
    expect(shouldPublishRowEstimate(240, 264)).toBe(false);
    expect(shouldPublishRowEstimate(240, 288)).toBe(true);
    expect(shouldPublishRowEstimate(240, 180)).toBe(true);
  });
});

describe("transcript scroll memory storage", () => {
  it("drops corrupt, foreign and incomplete records instead of throwing", () => {
    expect(parseTranscriptScrollMemory(null)).toEqual([]);
    expect(parseTranscriptScrollMemory("{oh no")).toEqual([]);
    expect(
      parseTranscriptScrollMemory(JSON.stringify({ sessionId: "s" })),
    ).toEqual([]);
    expect(
      parseTranscriptScrollMemory(
        JSON.stringify([
          { sessionId: "", savedAt: 1, atBottom: true },
          { sessionId: "s1", savedAt: "soon", atBottom: true },
          {
            sessionId: "s2",
            savedAt: 2,
            atBottom: false,
            anchor: { messageId: "m", offset: "x", rowsFromEnd: 1 },
          },
          { sessionId: "s3", savedAt: 3, atBottom: false, anchor },
        ]),
      ),
    ).toEqual([
      // An unusable anchor is kept only as "at the end", never as a broken restore.
      { sessionId: "s2", savedAt: 2, atBottom: true },
      { sessionId: "s3", savedAt: 3, atBottom: false, anchor },
    ]);
  });

  it("keeps one entry per session, newest first, bounded", () => {
    let entries: TranscriptScrollMemoryEntry[] = [];
    for (let index = 0; index < TRANSCRIPT_SCROLL_LIMIT + 5; index += 1) {
      entries = rememberTranscriptScroll(entries, {
        sessionId: `s${index}`,
        savedAt: index,
        atBottom: true,
      });
    }
    entries = rememberTranscriptScroll(entries, {
      sessionId: "s34",
      savedAt: 99,
      atBottom: false,
      anchor,
    });
    expect(entries).toHaveLength(TRANSCRIPT_SCROLL_LIMIT);
    expect(entries[0]).toEqual({
      sessionId: "s34",
      savedAt: 99,
      atBottom: false,
      anchor,
    });
    expect(entries.filter((entry) => entry.sessionId === "s34")).toHaveLength(
      1,
    );
  });

  it("round-trips a reading position through storage", () => {
    const env = fakeEnv();
    const storage = fakeStorage();
    const memory = createTranscriptScrollMemory({
      storage,
      now: () => 7,
      writerEnv: env,
    });

    memory.save("s1", {
      atBottom: false,
      anchor,
      tailKey: "m-41\0m-42",
    });
    memory.flush();

    const reloaded = createTranscriptScrollMemory({
      storage,
      writerEnv: fakeEnv(),
    });
    expect(reloaded.read("s1")).toEqual({
      atBottom: false,
      anchor,
      tailKey: "m-41\0m-42",
    });
    expect(reloaded.read("unknown")).toBeUndefined();
  });

  it("writes once for a burst of scroll samples", () => {
    const env = fakeEnv();
    const storage = fakeStorage();
    const memory = createTranscriptScrollMemory({ storage, writerEnv: env });

    // One candidate per frame for a second of scrolling.
    for (let index = 0; index < 60; index += 1) {
      memory.save("s1", {
        atBottom: false,
        anchor: { ...anchor, offset: -index },
      });
      env.advance(16);
    }
    env.advance(400);
    env.runIdle();

    expect(storage.writes).toHaveLength(1);
    expect(memory.read("s1")).toEqual({
      atBottom: false,
      anchor: { ...anchor, offset: -59 },
    });
  });

  it("forgets a session without disturbing the others", () => {
    const env = fakeEnv();
    const storage = fakeStorage();
    const memory = createTranscriptScrollMemory({ storage, writerEnv: env });
    memory.save("s1", { atBottom: false, anchor });
    memory.save("s2", { atBottom: true });
    memory.forget("s1");
    memory.flush();

    expect(memory.read("s1")).toBeUndefined();
    expect(memory.read("s2")).toEqual({ atBottom: true });
    expect(storage.value).not.toContain("s1");
  });

  it("degrades to no memory when storage is unavailable", () => {
    const memory = createTranscriptScrollMemory({
      storage: null,
      writerEnv: fakeEnv(),
    });
    memory.save("s1", { atBottom: false, anchor });
    memory.flush();
    expect(memory.read("s1")).toEqual({ atBottom: false, anchor });
    expect(TRANSCRIPT_SCROLL_KEY).toBe("assistant.transcriptScroll.v1");
  });
});
