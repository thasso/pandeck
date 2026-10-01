import { afterEach, describe, expect, it } from "vitest";
import {
  perfSnapshot,
  recordRender,
  recordServerMessage,
  recordSessionLoadMark,
  setPerfStatsEnabled,
  utf8Length,
} from "./perfStats.ts";

afterEach(() => setPerfStatsEnabled(false));

describe("perfStats", () => {
  it("records nothing while disabled", () => {
    recordServerMessage("sessions", 1000);
    recordRender("Sidebar");
    const snapshot = perfSnapshot();
    expect(snapshot.totalCount).toBe(0);
    expect(snapshot.renders).toEqual([]);
  });

  it("aggregates per message type and per component, heaviest first", () => {
    setPerfStatsEnabled(true);
    recordServerMessage("sessions", 10_000);
    recordServerMessage("sessions", 10_000);
    recordServerMessage("event", 200);
    recordRender("Sidebar");
    recordRender("MessageList");
    recordRender("MessageList");

    const snapshot = perfSnapshot();
    expect(snapshot.totalCount).toBe(3);
    expect(snapshot.totalBytes).toBe(20_200);
    expect(snapshot.messages.map((stat) => stat.type)).toEqual([
      "sessions",
      "event",
    ]);
    expect(snapshot.messages[0]).toEqual({
      type: "sessions",
      count: 2,
      bytes: 20_000,
      parseMs: 0,
    });
    expect(snapshot.renders).toEqual([
      { name: "MessageList", count: 2, durationMs: 0 },
      { name: "Sidebar", count: 1, durationMs: 0 },
    ]);
  });

  it("sums parse time and render duration when measured", () => {
    setPerfStatsEnabled(true);
    recordServerMessage("snapshot", 500_000, 12.5);
    recordServerMessage("snapshot", 100_000, 2.5);
    recordRender("Transcript", 8);
    recordRender("Transcript", 4);
    const snapshot = perfSnapshot();
    expect(snapshot.totalParseMs).toBe(15);
    expect(snapshot.messages[0]).toMatchObject({ parseMs: 15 });
    expect(snapshot.renders).toEqual([
      { name: "Transcript", count: 2, durationMs: 12 },
    ]);
  });

  it("counts wire bytes as UTF-8, not UTF-16 code units", () => {
    expect(utf8Length("abc")).toBe(3);
    expect(utf8Length("é")).toBe(2);
    expect(utf8Length("€")).toBe(3);
    expect(utf8Length("😀")).toBe(4);
    expect(utf8Length("aé€😀")).toBe(new TextEncoder().encode("aé€😀").length);
  });

  it("traces one session load in order and ignores marks out of order", () => {
    setPerfStatsEnabled(true);
    recordSessionLoadMark("committed", "s1", 5);
    expect(perfSnapshot().sessionLoad).toBeNull();
    recordSessionLoadMark("request", "s1", 10);
    // A commit before the snapshot is an older transcript, not this load's.
    recordSessionLoadMark("committed", "s1", 12);
    recordSessionLoadMark("snapshotParsed", "s2", 15);
    recordSessionLoadMark("snapshotParsed", "s1", 20);
    recordSessionLoadMark("committed", "s1", 30);
    recordSessionLoadMark("committed", "s1", 35);
    recordSessionLoadMark("painted", "s1", 40);
    expect(perfSnapshot().sessionLoad).toEqual({
      sessionId: "s1",
      requestAt: 10,
      snapshotParsedAt: 20,
      committedAt: 30,
      paintedAt: 40,
    });
  });

  it("drops samples older than the window", () => {
    setPerfStatsEnabled(true);
    recordServerMessage("taskList", 150_000);
    expect(perfSnapshot(Date.now() + 5_000).totalCount).toBe(0);
  });
});
