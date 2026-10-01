import { describe, expect, test } from "vitest";
import {
  addDaysToDate,
  addLocalDays,
  localDateOf,
  localDayBoundsMs,
  localWallTimeMs,
} from "./zonedTime.ts";

const HOUR_MS = 3_600_000;

/** Fixed expected instants: none of these depend on the host's zone. */
const DAYS: Array<[zone: string, date: string, start: string, end: string]> = [
  ["UTC", "2026-07-13", "2026-07-13T00:00:00.000Z", "2026-07-14T00:00:00.000Z"],
  [
    "Europe/Berlin",
    "2026-03-29", // spring forward 02:00 → 03:00
    "2026-03-28T23:00:00.000Z",
    "2026-03-29T22:00:00.000Z",
  ],
  [
    "Europe/Berlin",
    "2026-10-25", // fall back 03:00 → 02:00
    "2026-10-24T22:00:00.000Z",
    "2026-10-25T23:00:00.000Z",
  ],
  [
    "Pacific/Auckland",
    "2026-09-27", // spring forward 02:00 → 03:00; midnight is still +12
    "2026-09-26T12:00:00.000Z",
    "2026-09-27T11:00:00.000Z",
  ],
  [
    "Pacific/Auckland",
    "2026-04-05", // fall back 03:00 → 02:00; midnight is still +13
    "2026-04-04T11:00:00.000Z",
    "2026-04-05T12:00:00.000Z",
  ],
  [
    "America/Havana",
    "2026-03-08", // spring forward AT midnight: 00:00 → 01:00 never exists
    "2026-03-08T05:00:00.000Z",
    "2026-03-09T04:00:00.000Z",
  ],
  [
    "America/Havana",
    "2026-11-01", // fall back 01:00 → 00:00: midnight's first occurrence
    "2026-11-01T04:00:00.000Z",
    "2026-11-02T05:00:00.000Z",
  ],
  [
    "America/New_York",
    "2026-03-08",
    "2026-03-08T05:00:00.000Z",
    "2026-03-09T04:00:00.000Z",
  ],
  [
    "America/New_York",
    "2026-11-01",
    "2026-11-01T04:00:00.000Z",
    "2026-11-02T05:00:00.000Z",
  ],
  [
    "Pacific/Kiritimati", // UTC+14
    "2026-07-13",
    "2026-07-12T10:00:00.000Z",
    "2026-07-13T10:00:00.000Z",
  ],
];

describe("local day bounds", () => {
  for (const [zone, date, start, end] of DAYS) {
    test(`${zone} ${date} is [${start}, ${end})`, () => {
      const { startMs, endMs } = localDayBoundsMs(date, zone);
      expect(new Date(startMs).toISOString()).toBe(start);
      expect(new Date(endMs).toISOString()).toBe(end);
      // The window is exactly the instants whose local date is `date`.
      expect(localDateOf(startMs, zone)).toBe(date);
      expect(localDateOf(startMs - 1, zone)).not.toBe(date);
      expect(localDateOf(endMs - 1, zone)).toBe(date);
      expect(localDateOf(endMs, zone)).toBe(addDaysToDate(date, 1));
    });
  }

  test("DST days are 23 and 25 hours long", () => {
    const hours = (zone: string, date: string) => {
      const { startMs, endMs } = localDayBoundsMs(date, zone);
      return (endMs - startMs) / HOUR_MS;
    };
    expect(hours("America/Havana", "2026-03-08")).toBe(23);
    expect(hours("America/Havana", "2026-11-01")).toBe(25);
    expect(hours("Pacific/Auckland", "2026-09-27")).toBe(23);
    expect(hours("Pacific/Auckland", "2026-04-05")).toBe(25);
  });
});

describe("local wall times", () => {
  const iso = (date: string, time: string, zone: string) =>
    new Date(localWallTimeMs(date, time, zone)).toISOString();

  test("an ordinary time maps to its one instant", () => {
    expect(iso("2026-03-08", "07:00", "America/Havana")).toBe(
      "2026-03-08T11:00:00.000Z",
    );
    expect(iso("2026-07-13", "09:30", "Pacific/Kiritimati")).toBe(
      "2026-07-12T19:30:00.000Z",
    );
  });

  test("a skipped time resolves to the end of the gap", () => {
    expect(iso("2026-03-08", "00:30", "America/Havana")).toBe(
      "2026-03-08T05:00:00.000Z",
    );
    expect(iso("2026-03-29", "02:30", "Europe/Berlin")).toBe(
      "2026-03-29T01:00:00.000Z",
    );
  });

  test("an ambiguous time resolves to its first occurrence", () => {
    expect(iso("2026-11-01", "01:30", "America/New_York")).toBe(
      "2026-11-01T05:30:00.000Z",
    );
    expect(iso("2026-10-25", "02:30", "Europe/Berlin")).toBe(
      "2026-10-25T00:30:00.000Z",
    );
  });

  test("malformed input is rejected", () => {
    expect(() => localWallTimeMs("2026-7-13", "00:00", "UTC")).toThrow();
    expect(() => localWallTimeMs("2026-07-13", "24:00", "UTC")).toThrow();
  });
});

describe("calendar-day shifts", () => {
  const shift = (base: string, days: number, zone: string) =>
    new Date(addLocalDays(Date.parse(base), days, zone)).toISOString();

  test("the local time of day survives a DST change in between", () => {
    // Auckland 26 Sep 00:30 (+12) → 27 Sep 00:30, still +12 before the 02:00 jump.
    expect(shift("2026-09-25T12:30:00.000Z", 1, "Pacific/Auckland")).toBe(
      "2026-09-26T12:30:00.000Z",
    );
    // Auckland 4 Apr 00:30 (+13) → 5 Apr 00:30, still +13 before the 03:00 fall-back.
    expect(shift("2026-04-03T11:30:00.000Z", 1, "Pacific/Auckland")).toBe(
      "2026-04-04T11:30:00.000Z",
    );
    // Berlin across the spring change, a week out.
    expect(shift("2026-03-25T08:00:00.000Z", 7, "Europe/Berlin")).toBe(
      "2026-04-01T07:00:00.000Z",
    );
  });

  test("a time the target day skips lands where the gap ends", () => {
    // Havana 7 Mar 00:30 (-5) → 8 Mar 00:30 never exists; the day starts 01:00 (-4).
    expect(shift("2026-03-07T05:30:00.000Z", 1, "America/Havana")).toBe(
      "2026-03-08T05:00:00.000Z",
    );
  });

  test("milliseconds and negative shifts are exact", () => {
    expect(shift("2026-07-13T09:15:42.123Z", -3, "America/New_York")).toBe(
      "2026-07-10T09:15:42.123Z",
    );
    expect(shift("2026-07-13T09:15:42.123Z", 0, "Pacific/Kiritimati")).toBe(
      "2026-07-13T09:15:42.123Z",
    );
  });
});
