import { describe, expect, it } from "vitest";
import type { ScheduleSummary } from "@assistant/shared/schedules";
import { idle, loading, ready } from "./loadState.ts";
import {
  describeScheduleTiming,
  formatScheduleDate,
  historyRequestNeeded,
  needsAttentionCount,
  scheduleDraftPatch,
  scheduleDraftTimingError,
  scheduleFailureReason,
  visibleSchedules,
} from "./schedules.ts";

function summary(overrides: Partial<ScheduleSummary> = {}): ScheduleSummary {
  return {
    id: "a",
    name: "Daily check",
    prompt: "Check the build",
    enabled: true,
    timing: { kind: "daily", time: "11:00", timeZone: "Europe/Berlin" },
    target: { kind: "session", sessionId: "s1" },
    createdBy: { kind: "user" },
    controlledBy: { kind: "user" },
    cardless: false,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

const failedLast = {
  id: "o",
  scheduleId: "a",
  state: "failed" as const,
  dueAtMs: 1,
};

describe("needsAttentionCount (R3)", () => {
  it("counts every live Schedule whose last occurrence failed, done and disabled included", () => {
    expect(
      needsAttentionCount([
        summary({ id: "a", lastOccurrence: failedLast }),
        summary({ id: "b", enabled: false, lastOccurrence: failedLast }),
        summary({ id: "c", doneAtMs: 5, lastOccurrence: failedLast }),
        summary({
          id: "d",
          lastOccurrence: { ...failedLast, state: "delivered" },
        }),
        summary({ id: "e" }),
      ]),
    ).toBe(3);
  });
});

describe("visibleSchedules (U5)", () => {
  it("keeps Active and Done exclusive, a disabled one that is not done under Active", () => {
    const rows = [
      summary({ id: "on" }),
      summary({ id: "off", enabled: false }),
      summary({ id: "done", doneAtMs: 5, enabled: false }),
    ];
    expect(visibleSchedules(rows, "active").map((row) => row.id)).toEqual([
      "on",
      "off",
    ]);
    expect(visibleSchedules(rows, "done").map((row) => row.id)).toEqual([
      "done",
    ]);
  });
});

describe("describeScheduleTiming (U8)", () => {
  it("states each kind in its own wall time, with the repeat window", () => {
    expect(formatScheduleDate("2026-11-25")).toBe("Wed 25 Nov 2026");
    expect(
      describeScheduleTiming({
        kind: "once",
        date: "2026-11-25",
        time: "15:45",
      }),
    ).toBe("Once on Wed 25 Nov 2026 at 15:45");
    expect(describeScheduleTiming({ kind: "daily", time: "11:00" })).toBe(
      "Daily at 11:00",
    );
    expect(describeScheduleTiming({ kind: "weekdays", time: "11:00" })).toBe(
      "Weekdays at 11:00",
    );
    expect(
      describeScheduleTiming({
        kind: "weekly",
        days: ["thu", "mon"],
        time: "11:00",
      }),
    ).toBe("Weekly on Mon, Thu at 11:00");
    expect(
      describeScheduleTiming({
        kind: "monthly",
        day: 31,
        time: "09:00",
        startsOn: "2026-12-01",
        endsOn: "2027-06-30",
      }),
    ).toBe(
      "Monthly on day 31 at 09:00 from Tue 1 Dec 2026 until Wed 30 Jun 2027",
    );
  });
});

describe("scheduleDraftPatch (R4)", () => {
  it("sends only the fields that differ from what the server holds now", () => {
    const stored = summary();
    expect(
      scheduleDraftPatch(stored, {
        prompt: "Check the build",
        timing: { kind: "daily", time: "11:00" },
        targetSessionId: "s1",
      }),
    ).toEqual({});
    expect(
      scheduleDraftPatch(stored, {
        prompt: "Check the deploy",
        timing: { kind: "daily", time: "11:00" },
      }),
    ).toEqual({ prompt: "Check the deploy" });
    expect(scheduleDraftPatch(stored, { targetSessionId: "s2" })).toEqual({
      targetSessionId: "s2",
    });
  });

  it("treats an invalid timing as changed, so the editor can refuse it", () => {
    expect(
      scheduleDraftPatch(summary(), { timing: { kind: "daily", time: "" } }),
    ).toEqual({ timing: { kind: "daily", time: "" } });
  });
});

describe("scheduleDraftTimingError (AC8)", () => {
  const spent = summary({
    doneAtMs: 5,
    timing: {
      kind: "once",
      date: "2020-01-01",
      time: "11:00",
      timeZone: "Europe/Berlin",
    },
  });
  const now = Date.UTC(2026, 9, 15);

  it("does not judge an untouched expired timing, so a prompt-only edit of a done Schedule saves", () => {
    const patch = scheduleDraftPatch(spent, {
      prompt: "Another prompt",
      timing: { kind: "once", date: "2020-01-01", time: "11:00" },
    });
    expect(patch).toEqual({ prompt: "Another prompt" });
    expect(scheduleDraftTimingError(spent, patch, now)).toBeNull();
  });

  it("refuses a changed timing with no future occurrence with the contract text", () => {
    const patch = scheduleDraftPatch(spent, {
      timing: { kind: "once", date: "2021-01-01", time: "11:00" },
    });
    expect(scheduleDraftTimingError(spent, patch, now)).toBe(
      "Schedule timing has no future occurrence",
    );
  });
});

describe("scheduleFailureReason", () => {
  it("drops the server's own lead so the approved note does not repeat it", () => {
    expect(
      scheduleFailureReason("Failed to delete Schedule: database is locked"),
    ).toBe("database is locked");
    expect(
      scheduleFailureReason("Failed to save Schedules settings: disk full"),
    ).toBe("disk full");
    expect(scheduleFailureReason("The server did not answer. Try again.")).toBe(
      "The server did not answer. Try again.",
    );
  });
});

describe("historyRequestNeeded (F006)", () => {
  it("asks for a new entry, and for a revision newer than the one held", () => {
    expect(historyRequestNeeded({ load: idle() }, 2, true)).toBe(true);
    expect(
      historyRequestNeeded({ load: ready([]), revision: 2 }, 2, true),
    ).toBe(false);
    expect(
      historyRequestNeeded({ load: ready([]), revision: 2 }, 3, true),
    ).toBe(true);
  });

  it("never asks offline, while a read is in flight, or for a gone Schedule", () => {
    expect(historyRequestNeeded({ load: idle() }, 2, false)).toBe(false);
    expect(
      historyRequestNeeded(
        {
          load: loading(),
          attempt: { requestId: "r", generation: 2, status: "inflight" },
        },
        3,
        true,
      ),
    ).toBe(false);
    expect(historyRequestNeeded({ load: ready(null) }, 9, true)).toBe(false);
  });

  it("holds a failed attempt's barrier up to its generation", () => {
    const failed = {
      load: ready([]),
      revision: 2,
      attempt: { requestId: "r", generation: 3, status: "failed" as const },
    };
    expect(historyRequestNeeded(failed, 3, true)).toBe(false);
    expect(historyRequestNeeded(failed, 4, true)).toBe(true);
  });
});
