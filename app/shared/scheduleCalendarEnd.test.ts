import { describe, expect, test } from "vitest";
import { nextOccurrencesAfter, type ScheduleTiming } from "./schedules.ts";

/**
 * Recurrence at the end of the four-digit calendar (B-F002): 9999-12-31 is the
 * last date a timing may name, and a Fri. Every expected instant is a fixed
 * UTC string worked out by hand (Berlin is UTC+1 in December, Pago Pago
 * UTC-11 and Kiritimati UTC+14 all year), never computed with the code under
 * test. Asking for more than remain returns what remains.
 */
const at = (iso: string) => Date.parse(iso);
const iso = (values: number[]) => values.map((v) => new Date(v).toISOString());
const BERLIN = "Europe/Berlin";
const NOW = at("2026-11-25T07:00:00Z");

describe("nextOccurrencesAfter stops at the calendar's last day", () => {
  test("a repeat bounded to the last day yields that one day", () => {
    const timing: ScheduleTiming = {
      kind: "daily",
      time: "09:00",
      timeZone: BERLIN,
      startsOn: "9999-12-31",
      endsOn: "9999-12-31",
    };
    expect(iso(nextOccurrencesAfter(timing, NOW, 3))).toEqual([
      "9999-12-31T08:00:00.000Z",
    ]);
  });

  test("an unbounded repeat yields the days left, then none after the last", () => {
    const daily: ScheduleTiming = {
      kind: "daily",
      time: "09:00",
      timeZone: BERLIN,
    };
    expect(
      iso(nextOccurrencesAfter(daily, at("9999-12-29T12:00:00Z"), 5)),
    ).toEqual(["9999-12-30T08:00:00.000Z", "9999-12-31T08:00:00.000Z"]);
    // The clock's step past its final due.
    expect(nextOccurrencesAfter(daily, at("9999-12-31T08:00:00Z"), 1)).toEqual(
      [],
    );
    const weekdays: ScheduleTiming = { ...daily, kind: "weekdays" };
    expect(
      iso(nextOccurrencesAfter(weekdays, at("9999-12-30T12:00:00Z"), 3)),
    ).toEqual(["9999-12-31T08:00:00.000Z"]);
  });

  test("weekly and monthly keep their pattern up to the last day", () => {
    const weekly: ScheduleTiming = {
      kind: "weekly",
      days: ["mon", "fri"],
      time: "09:00",
      timeZone: BERLIN,
    };
    expect(
      iso(nextOccurrencesAfter(weekly, at("9999-12-21T00:00:00Z"), 5)),
    ).toEqual([
      "9999-12-24T08:00:00.000Z",
      "9999-12-27T08:00:00.000Z",
      "9999-12-31T08:00:00.000Z",
    ]);
    const monthly: ScheduleTiming = {
      kind: "monthly",
      day: 31,
      time: "09:00",
      timeZone: BERLIN,
      startsOn: "9999-12-01",
    };
    expect(iso(nextOccurrencesAfter(monthly, NOW, 3))).toEqual([
      "9999-12-31T08:00:00.000Z",
    ]);
  });

  test("a scan for a date that no longer comes stops at the last day", () => {
    // No Monday is left after Mon 27 Dec 9999, no 15th after 15 Dec.
    const monday: ScheduleTiming = {
      kind: "weekly",
      days: ["mon"],
      time: "09:00",
      timeZone: BERLIN,
    };
    expect(nextOccurrencesAfter(monday, at("9999-12-28T00:00:00Z"), 1)).toEqual(
      [],
    );
    const fifteenth: ScheduleTiming = {
      kind: "monthly",
      day: 15,
      time: "09:00",
      timeZone: BERLIN,
    };
    expect(
      nextOccurrencesAfter(fifteenth, at("9999-12-16T00:00:00Z"), 3),
    ).toEqual([]);
  });

  test("a once on the last day is its only occurrence", () => {
    const timing: ScheduleTiming = {
      kind: "once",
      date: "9999-12-31",
      time: "23:59",
      timeZone: BERLIN,
    };
    expect(iso(nextOccurrencesAfter(timing, NOW, 3))).toEqual([
      "9999-12-31T22:59:00.000Z",
    ]);
  });

  test("a zone behind UTC keeps its last local day, past the UTC year", () => {
    const pagoPago: ScheduleTiming = {
      kind: "daily",
      time: "23:59",
      timeZone: "Pacific/Pago_Pago",
    };
    expect(
      iso(nextOccurrencesAfter(pagoPago, at("9999-12-30T00:00:00Z"), 5)),
    ).toEqual([
      "9999-12-30T10:59:00.000Z",
      "9999-12-31T10:59:00.000Z",
      "+010000-01-01T10:59:00.000Z",
    ]);
    const kiritimati: ScheduleTiming = {
      kind: "daily",
      time: "00:00",
      timeZone: "Pacific/Kiritimati",
    };
    expect(
      nextOccurrencesAfter(kiritimati, at("9999-12-30T12:00:00Z"), 3),
    ).toEqual([]);
  });

  test("an instant already past the calendar's end has nothing after it", () => {
    const daily: ScheduleTiming = {
      kind: "daily",
      time: "09:00",
      timeZone: BERLIN,
    };
    expect(
      nextOccurrencesAfter(daily, at("+010000-01-02T00:00:00Z"), 3),
    ).toEqual([]);
  });
});
