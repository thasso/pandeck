import { describe, expect, test } from "vitest";
import {
  describeTimelineCache,
  type ClientSessionSnapshot,
  type ClientTimelineEntry,
} from "@assistant/shared/runtime";
import {
  cacheRecordForSnapshot,
  expandTimelineSnapshot,
  type SessionTimelineCacheRecord,
} from "./sessionTimelineCache.ts";

function entry(seq: number): ClientTimelineEntry {
  return {
    id: `e${seq}`,
    seq,
    createdAt: "2026-01-01T00:00:00.000Z",
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [{ type: "text", text: `message ${seq}` }],
  };
}

/** An orphan tool result: renders only through the assistant entry that declared it. */
function orphanResult(seq: number): ClientTimelineEntry {
  return {
    id: `e${seq}`,
    seq,
    createdAt: "2026-01-01T00:00:00.000Z",
    type: "message",
    role: "toolResult",
    toolCallId: `tc${seq}`,
    content: [{ type: "text", text: `output ${seq}` }],
    isError: false,
  };
}

function cached(
  timeline: ClientTimelineEntry[],
  startIndex = 0,
): SessionTimelineCacheRecord {
  return {
    version: 2,
    sessionId: "s1",
    timeline,
    descriptor: describeTimelineCache(timeline, startIndex),
    savedAt: 1,
  };
}

describe("session timeline cache", () => {
  test("reconstructs a delta snapshot from the matching durable range", () => {
    const prefix = [entry(0), entry(2)];
    const complete = [...prefix, entry(5)];
    const snapshot: ClientSessionSnapshot = {
      sessionId: "s1",
      runState: "idle",
      timeline: [complete[2]!],
      timelineStart: prefix.length,
      totalEntryCount: complete.length,
      timelineBase: describeTimelineCache(prefix),
      timelineCache: describeTimelineCache(complete),
      streaming: [],
    };

    const expanded = expandTimelineSnapshot(snapshot, cached(prefix));
    expect(expanded?.timeline.map((item) => item.id)).toEqual([
      "e0",
      "e2",
      "e5",
    ]);
    expect(expanded?.timelineStart).toBe(0);
    expect(cacheRecordForSnapshot(expanded!)?.descriptor.entryCount).toBe(3);
  });

  test("reconstructs a WINDOWED cached range, keeping its start offset", () => {
    // The browser only ever held entries 4..5 of a six-entry timeline.
    const cachedRange = [entry(4), entry(5)];
    const complete = [entry(0), entry(1), entry(2), entry(3), ...cachedRange];
    const tail = [entry(6)];
    const snapshot: ClientSessionSnapshot = {
      sessionId: "s1",
      runState: "idle",
      timeline: tail,
      timelineStart: 6,
      totalEntryCount: 7,
      timelineBase: describeTimelineCache(cachedRange, 4),
      timelineCache: describeTimelineCache([...cachedRange, ...tail], 4),
      turnStatsSeed: {
        cumulative: {
          input: 1,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0.5,
        },
        prevContextSize: 10,
        usageTurnCount: 2,
      },
      streaming: [],
    };

    const expanded = expandTimelineSnapshot(snapshot, cached(cachedRange, 4));
    expect(expanded?.timeline.map((item) => item.id)).toEqual([
      "e4",
      "e5",
      "e6",
    ]);
    expect(expanded?.timelineStart).toBe(4);
    expect(expanded?.turnStatsSeed?.prevContextSize).toBe(10);
    // What is persisted is the RANGE the browser now renders, start offset and
    // all — a descriptor read as a prefix from zero would splice wrong next time.
    const record = cacheRecordForSnapshot(expanded!);
    expect(record?.descriptor.startIndex).toBe(4);
    expect(record?.descriptor.entryCount).toBe(3);
    expect(complete.length).toBe(6);
  });

  test("rejects a delta when its local range is missing or has the wrong anchor", () => {
    const complete = [entry(0), entry(1)];
    const snapshot: ClientSessionSnapshot = {
      sessionId: "s1",
      runState: "idle",
      timeline: [complete[1]!],
      timelineStart: 1,
      totalEntryCount: 2,
      timelineBase: describeTimelineCache([complete[0]!]),
      timelineCache: describeTimelineCache(complete),
      streaming: [],
    };

    expect(expandTimelineSnapshot(snapshot, undefined)).toBeNull();
    expect(expandTimelineSnapshot(snapshot, cached([entry(9)]))).toBeNull();
    // Right entries, wrong place in the timeline.
    expect(
      expandTimelineSnapshot(snapshot, cached([complete[0]!], 3)),
    ).toBeNull();
  });

  // Task 450: the range a browser holds can be nothing but orphan tool results
  // (a window persisted before the server grew its renderability floor). Such a
  // range is well-formed and matches the projection, so nothing but these two
  // rules keeps it from rendering an empty transcript forever.
  test("never persists a range that renders nothing", () => {
    const orphans = [orphanResult(2), orphanResult(3)];
    const snapshot: ClientSessionSnapshot = {
      sessionId: "s1",
      runState: "idle",
      timeline: orphans,
      timelineStart: 2,
      totalEntryCount: 4,
      timelineCache: describeTimelineCache(orphans, 2),
      streaming: [],
    };
    // The window itself is authoritative and renders (blank) rather than looping.
    const expanded = expandTimelineSnapshot(snapshot, undefined);
    expect(expanded).not.toBeNull();
    // But it never becomes durable, so the next open is answered with a window.
    expect(cacheRecordForSnapshot(expanded!)).toBeNull();
  });

  test("refuses a splice whose reconstructed range renders nothing", () => {
    const orphans = [orphanResult(2), orphanResult(3)];
    const tail = [orphanResult(4)];
    const snapshot: ClientSessionSnapshot = {
      sessionId: "s1",
      runState: "idle",
      timeline: tail,
      timelineStart: 4,
      totalEntryCount: 5,
      timelineBase: describeTimelineCache(orphans, 2),
      timelineCache: describeTimelineCache([...orphans, ...tail], 2),
      streaming: [],
    };
    // Well-formed in every other respect — the anchor matches the local range.
    expect(expandTimelineSnapshot(snapshot, cached(orphans, 2))).toBeNull();

    // A visible entry in the reconstructed range is all it takes to be usable.
    const withPrompt = [...tail, entry(5)];
    const usable: ClientSessionSnapshot = {
      ...snapshot,
      timeline: withPrompt,
      totalEntryCount: 6,
      timelineCache: describeTimelineCache([...orphans, ...withPrompt], 2),
    };
    expect(
      expandTimelineSnapshot(usable, cached(orphans, 2))?.timelineStart,
    ).toBe(2);
  });

  test("accepts and caches a self-contained authoritative snapshot", () => {
    const timeline = [entry(0)];
    const snapshot: ClientSessionSnapshot = {
      sessionId: "s1",
      runState: "idle",
      timeline,
      timelineStart: 0,
      totalEntryCount: 1,
      timelineCache: describeTimelineCache(timeline),
      streaming: [],
    };
    const expanded = expandTimelineSnapshot(snapshot, undefined);
    expect(expanded?.timeline).toEqual(timeline);
    expect(cacheRecordForSnapshot(expanded!)?.timeline).toEqual(timeline);
  });
});
