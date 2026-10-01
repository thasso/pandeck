import { describe, expect, test } from "vitest";
import type {
  CalendarDayRunHealth,
  CalendarDaySourceHealth,
} from "@assistant/shared";
import {
  minutesSummaryLabel,
  sourceHealthLabel,
  summarizeDayHealth,
} from "./dayHealth.ts";

function source(
  over: Partial<CalendarDaySourceHealth>,
): CalendarDaySourceHealth {
  return { key: "jira", label: "Jira", disposition: "attempted", ...over };
}

function run(
  sources: CalendarDaySourceHealth[],
  changes = 0,
): CalendarDayRunHealth {
  return {
    runId: "r1",
    asOf: "2026-07-13T14:20:00.000Z",
    schemaVersion: 1,
    sources,
    changesSinceLastRun: changes,
  };
}

describe("summarizeDayHealth", () => {
  test("skipped sources are never counted as failures", () => {
    const summary = summarizeDayHealth(
      run([
        source({ key: "jira", result: "complete" }),
        source({ key: "github-events", result: "complete" }),
        source({
          key: "tempo",
          disposition: "skipped",
          skipReason: "unconfigured",
        }),
      ]),
    );
    expect(summary?.fresh).toBe(2);
    expect(summary?.attempted).toBe(2);
    expect(summary?.skipped).toBe(1);
    expect(summary?.failed).toBe(0);
    expect(summary?.tone).toBe("fresh");
    expect(summary?.headline).toBe("2/2 sources fresh · 1 skipped");
  });

  test("a partial source degrades the tone; a failed source dominates it", () => {
    const partial = summarizeDayHealth(
      run([
        source({ result: "complete" }),
        source({ key: "gh", result: "partial" }),
      ]),
    );
    expect(partial?.tone).toBe("partial");
    const failed = summarizeDayHealth(
      run([
        source({ result: "partial" }),
        source({ key: "gh", result: "failed" }),
      ]),
    );
    expect(failed?.tone).toBe("failed");
    expect(failed?.headline).toContain("1 failed");
  });

  test("null run yields no summary", () => {
    expect(summarizeDayHealth(null)).toBeNull();
  });
});

describe("minutesSummaryLabel", () => {
  test("null when no minutes were discovered", () => {
    expect(minutesSummaryLabel(undefined)).toBeNull();
    expect(
      minutesSummaryLabel({
        discovered: 0,
        processed: 0,
        cached: 0,
        deferred: 0,
        failed: 0,
        tasksCreated: 0,
      }),
    ).toBeNull();
  });

  test("summarizes processed/tasks/cached/deferred, omitting zeros", () => {
    expect(
      minutesSummaryLabel({
        discovered: 4,
        processed: 2,
        cached: 2,
        deferred: 0,
        failed: 0,
        tasksCreated: 1,
      }),
    ).toBe("2 processed · 1 task · 2 cached");
  });

  test("falls back to a discovered count when everything else is zero", () => {
    expect(
      minutesSummaryLabel({
        discovered: 3,
        processed: 0,
        cached: 0,
        deferred: 0,
        failed: 0,
        tasksCreated: 0,
      }),
    ).toBe("3 discovered");
  });
});

describe("sourceHealthLabel", () => {
  test("skipped shows its reason; attempted shows result + deltas", () => {
    expect(
      sourceHealthLabel(
        source({ disposition: "skipped", skipReason: "disabled" }),
      ),
    ).toBe("skipped (disabled)");
    expect(
      sourceHealthLabel(source({ result: "complete", added: 2, changed: 1 })),
    ).toBe("complete · +2/~1");
    expect(sourceHealthLabel(source({ result: "failed", error: "boom" }))).toBe(
      "failed — boom",
    );
  });
});
