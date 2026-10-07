import { afterEach, describe, expect, it, vi } from "vitest";
import { addDays, isoWeekday, todayIso } from "./taskDates.ts";

afterEach(() => vi.useRealTimers());

describe("task dates", () => {
  it("resolves today in the user's zone rather than the browser's", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T00:30:00Z"));
    expect(todayIso("Europe/Berlin")).toBe("2026-07-06");
    expect(todayIso("America/Los_Angeles")).toBe("2026-07-05");
  });

  it("adds date-only days across month, leap-year and DST boundaries", () => {
    expect(addDays("2026-03-29", 1)).toBe("2026-03-30");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
  });

  it("uses Monday-first ISO weekdays for Focus planning", () => {
    expect(isoWeekday("2026-07-06")).toBe(1);
    expect(isoWeekday("2026-07-05")).toBe(7);
  });
});
