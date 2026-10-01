import { describe, expect, test } from "vitest";
import { localDayBoundsMs } from "@assistant/shared/zonedTime";
import {
  dayKey,
  formatFullDate,
  hm,
  minutesOfDay,
  rangeForView,
  sameDay,
} from "./calendarDates.ts";

// 22:30Z on 10 Aug is already 11 Aug in Berlin but still 10 Aug in New York.
const INSTANT = "2026-08-10T22:30:00Z";

describe("calendar dates resolve in the zone they are given", () => {
  test("day keys and wall-clock times follow the user's zone, not the browser's", () => {
    expect(dayKey(INSTANT, "Europe/Berlin")).toBe("2026-08-11");
    expect(dayKey(INSTANT, "America/New_York")).toBe("2026-08-10");
    expect(hm(INSTANT, "Europe/Berlin")).toBe("00:30");
    expect(hm(INSTANT, "America/New_York")).toBe("18:30");
    expect(minutesOfDay(INSTANT, "America/New_York")).toBe(18 * 60 + 30);
    expect(sameDay(INSTANT, "2026-08-10T12:00:00Z", "Europe/Berlin")).toBe(
      false,
    );
    expect(sameDay(INSTANT, "2026-08-10T12:00:00Z", "America/New_York")).toBe(
      true,
    );
  });

  test("range bounds sit at the zone's local midnight, DST-correct", () => {
    expect(rangeForView("day", "2026-03-29", "Europe/Berlin")).toEqual({
      from: "2026-03-28T23:00:00.000Z",
      to: "2026-03-29T22:00:00.000Z",
    });
    expect(rangeForView("day", "2026-07-13", "America/New_York")).toEqual({
      from: "2026-07-13T04:00:00.000Z",
      to: "2026-07-14T04:00:00.000Z",
    });
  });

  test("range bounds are the shared day bounds where DST shifts at midnight", () => {
    // Auckland's midnight keeps the old offset; Havana skips 00:00 entirely.
    expect(rangeForView("day", "2026-09-27", "Pacific/Auckland")).toEqual({
      from: "2026-09-26T12:00:00.000Z",
      to: "2026-09-27T11:00:00.000Z",
    });
    expect(rangeForView("day", "2026-03-08", "America/Havana")).toEqual({
      from: "2026-03-08T05:00:00.000Z",
      to: "2026-03-09T04:00:00.000Z",
    });
    const shared = localDayBoundsMs("2026-04-05", "Pacific/Auckland");
    expect(rangeForView("day", "2026-04-05", "Pacific/Auckland")).toEqual({
      from: new Date(shared.startMs).toISOString(),
      to: new Date(shared.endMs).toISOString(),
    });
  });

  test("labels name the date string itself in every zone", () => {
    expect(formatFullDate("2026-06-29")).toBe("Monday, 29 June 2026");
  });
});
