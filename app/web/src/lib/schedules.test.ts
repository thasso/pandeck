import { describe, expect, it } from "vitest";
import type { ScheduleSummary } from "@assistant/shared/schedules";
import { idle, loading, ready } from "./loadState.ts";
import {
  describeScheduleTiming,
  formatScheduleDate,
  historyRequestNeeded,
  needsAttentionCount,
  NO_SCHEDULE_CLAIMS,
  nextRepeatingForSession,
  scheduleClaimedKeys,
  scheduleDraftPatch,
  scheduleDraftTimingError,
  scheduleFailureReason,
  scheduleNextLabel,
  schedulesForSession,
  visibleSchedules,
  withScheduleClaim,
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

describe("schedulesForSession (AC11)", () => {
  it("keeps only the Schedules targeting the session, in list order", () => {
    const list = [
      summary({ id: "a" }),
      summary({ id: "b", target: { kind: "session", sessionId: "s2" } }),
      summary({ id: "c", doneAtMs: 5 }),
    ];
    expect(schedulesForSession(list, "s1").map((item) => item.id)).toEqual([
      "a",
      "c",
    ]);
    expect(schedulesForSession(list, "s3")).toEqual([]);
  });
});

describe("nextRepeatingForSession (AC12)", () => {
  const weekly = {
    kind: "weekly" as const,
    days: ["mon" as const],
    time: "11:00",
    timeZone: "Europe/Berlin",
  };
  it("is the earliest enabled repeating Schedule with a next occurrence", () => {
    const later = summary({ id: "later", nextDueAtMs: 2_000 });
    const earlier = summary({
      id: "earlier",
      timing: weekly,
      nextDueAtMs: 1_000,
    });
    const list = [later, earlier];
    // The replica's own row, so a memoized chip keeps its props.
    expect(nextRepeatingForSession(list, "s1")).toBe(earlier);
  });

  it("never a once, disabled, done or next-less Schedule, nor another session's", () => {
    const once = summary({
      id: "once",
      timing: {
        kind: "once",
        date: "2026-12-01",
        time: "11:00",
        timeZone: "Europe/Berlin",
      },
      nextDueAtMs: 1,
    });
    const off = summary({ id: "off", enabled: false, nextDueAtMs: 2 });
    const done = summary({ id: "done", doneAtMs: 3, nextDueAtMs: 3 });
    const noNext = summary({ id: "none" });
    const elsewhere = summary({
      id: "elsewhere",
      target: { kind: "session", sessionId: "s2" },
      nextDueAtMs: 4,
    });
    expect(
      nextRepeatingForSession([once, off, done, noNext, elsewhere], "s1"),
    ).toBeUndefined();
    const daily = summary({ id: "daily", nextDueAtMs: 9 });
    expect(
      nextRepeatingForSession(
        [once, off, done, noNext, elsewhere, daily],
        "s1",
      ),
    ).toBe(daily);
  });
});

describe("scheduleNextLabel", () => {
  it("says Done, Off, the due time, or none", () => {
    expect(scheduleNextLabel(summary({ doneAtMs: 1 }))).toBe("Done");
    expect(scheduleNextLabel(summary({ enabled: false }))).toBe("Off");
    expect(scheduleNextLabel(summary())).toBe("—");
    expect(
      scheduleNextLabel(summary({ nextDueAtMs: Date.UTC(2026, 9, 19, 9, 0) })),
    ).toBe("Mon 19 Oct 11:00");
  });
});

describe("per-surface Schedule claims", () => {
  it("keeps each surface's report apart and unions them", () => {
    let claims = withScheduleClaim(NO_SCHEDULE_CLAIMS, "inspector", [
      "a:enabled",
    ]);
    claims = withScheduleClaim(claims, "page", ["a:enabled", "b:enabled"]);
    expect(scheduleClaimedKeys(claims)).toEqual(["a:enabled", "b:enabled"]);
    // The page leaving clears only its own keys.
    claims = withScheduleClaim(claims, "page", []);
    expect(scheduleClaimedKeys(claims)).toEqual(["a:enabled"]);
    claims = withScheduleClaim(claims, "detail", ["a:update"]);
    expect(scheduleClaimedKeys(claims).sort()).toEqual([
      "a:enabled",
      "a:update",
    ]);
  });

  it("returns the same object for an unchanged report", () => {
    const claims = withScheduleClaim(NO_SCHEDULE_CLAIMS, "phone", ["x"]);
    expect(withScheduleClaim(claims, "phone", ["x"])).toBe(claims);
    expect(withScheduleClaim(NO_SCHEDULE_CLAIMS, "page", [])).toBe(
      NO_SCHEDULE_CLAIMS,
    );
  });
});
