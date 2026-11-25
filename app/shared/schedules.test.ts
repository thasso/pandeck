import { describe, expect, test } from "vitest";
import {
  canonicalScheduleTiming,
  DEFAULT_SCHEDULE_SETTINGS,
  formatScheduleDue,
  formatScheduleInstant,
  SCHEDULE_OCCURRENCE_STATES,
  SCHEDULE_WEEKDAYS,
  nextOccurrencesAfter,
  normalizeScheduleSettings,
  scheduleTimingError,
  scheduleTimingsEqual,
  type ScheduleTiming,
  type ScheduleWeekday,
} from "./schedules.ts";

/**
 * Every expected instant below is a fixed UTC string worked out by hand from
 * the zone's published rules, never computed with the code under test.
 * Berlin: CET is UTC+1, CEST UTC+2; 2026 springs forward on 29 March at
 * 01:00Z (02:00 → 03:00 local) and falls back on 25 October at 01:00Z
 * (03:00 → 02:00 local).
 */
const at = (iso: string) => Date.parse(iso);
const iso = (values: number[]) => values.map((v) => new Date(v).toISOString());
const BERLIN = "Europe/Berlin";

describe("nextOccurrencesAfter", () => {
  test("daily keeps the local time across spring forward, never a fixed 24h step", () => {
    const timing: ScheduleTiming = {
      kind: "daily",
      time: "11:00",
      timeZone: BERLIN,
    };
    expect(
      iso(nextOccurrencesAfter(timing, at("2026-03-28T00:00:00Z"), 3)),
    ).toEqual([
      "2026-03-28T10:00:00.000Z",
      "2026-03-29T09:00:00.000Z",
      "2026-03-30T09:00:00.000Z",
    ]);
  });

  test("a time the spring-forward gap skips occurs when the gap ends", () => {
    const timing: ScheduleTiming = {
      kind: "once",
      date: "2026-03-29",
      time: "02:30",
      timeZone: BERLIN,
    };
    expect(
      iso(nextOccurrencesAfter(timing, at("2026-03-28T00:00:00Z"), 3)),
    ).toEqual(["2026-03-29T01:00:00.000Z"]);
  });

  test("a time the fall-back fold repeats occurs once, at the first pass", () => {
    const timing: ScheduleTiming = {
      kind: "daily",
      time: "02:30",
      timeZone: BERLIN,
    };
    expect(
      iso(nextOccurrencesAfter(timing, at("2026-10-24T12:00:00Z"), 2)),
    ).toEqual(["2026-10-25T00:30:00.000Z", "2026-10-26T01:30:00.000Z"]);
    // After the first pass, the second pass of the same day is not offered.
    expect(
      iso(nextOccurrencesAfter(timing, at("2026-10-25T00:30:00Z"), 1)),
    ).toEqual(["2026-10-26T01:30:00.000Z"]);
  });

  test("a gap at local midnight: Havana 2026-03-08 00:00 occurs at 01:00 local", () => {
    // Cuba springs forward at 00:00 (UTC-5 → UTC-4): 01:00 CDT is 05:00Z.
    const timing: ScheduleTiming = {
      kind: "once",
      date: "2026-03-08",
      time: "00:00",
      timeZone: "America/Havana",
    };
    expect(
      iso(nextOccurrencesAfter(timing, at("2026-03-07T00:00:00Z"), 1)),
    ).toEqual(["2026-03-08T05:00:00.000Z"]);
  });

  test("monthly on day 31 occurs on the last day of shorter months, leap years included", () => {
    const timing: ScheduleTiming = {
      kind: "monthly",
      day: 31,
      time: "11:00",
      timeZone: BERLIN,
    };
    expect(
      iso(nextOccurrencesAfter(timing, at("2027-01-31T10:00:00Z"), 3)),
    ).toEqual([
      "2027-02-28T10:00:00.000Z",
      "2027-03-31T09:00:00.000Z",
      "2027-04-30T09:00:00.000Z",
    ]);
    expect(
      iso(nextOccurrencesAfter(timing, at("2028-02-01T00:00:00Z"), 1)),
    ).toEqual(["2028-02-29T10:00:00.000Z"]);
  });

  test("weekdays skip Saturday and Sunday", () => {
    // 2026-11-27 is a Friday.
    const timing: ScheduleTiming = {
      kind: "weekdays",
      time: "09:00",
      timeZone: BERLIN,
    };
    expect(
      iso(nextOccurrencesAfter(timing, at("2026-11-27T08:00:00Z"), 3)),
    ).toEqual([
      "2026-11-30T08:00:00.000Z",
      "2026-12-01T08:00:00.000Z",
      "2026-12-02T08:00:00.000Z",
    ]);
  });

  test("weekly occurs on the chosen days only", () => {
    const days: ScheduleWeekday[] = ["mon", "thu"];
    const timing: ScheduleTiming = {
      kind: "weekly",
      days,
      time: "11:00",
      timeZone: BERLIN,
    };
    expect(
      iso(nextOccurrencesAfter(timing, at("2026-11-25T00:00:00Z"), 3)),
    ).toEqual([
      "2026-11-26T10:00:00.000Z",
      "2026-11-30T10:00:00.000Z",
      "2026-12-03T10:00:00.000Z",
    ]);
  });

  test("a once already past has no occurrence", () => {
    const timing: ScheduleTiming = {
      kind: "once",
      date: "2026-11-25",
      time: "15:45",
      timeZone: BERLIN,
    };
    expect(nextOccurrencesAfter(timing, at("2026-11-25T14:45:00Z"), 3)).toEqual(
      [],
    );
    expect(nextOccurrencesAfter(timing, at("2027-01-01T00:00:00Z"), 3)).toEqual(
      [],
    );
  });

  test("strictly after: afterMs = due - 1 returns due, afterMs = due excludes it", () => {
    const timing: ScheduleTiming = {
      kind: "once",
      date: "2026-11-25",
      time: "15:45",
      timeZone: BERLIN,
    };
    const due = at("2026-11-25T14:45:00Z");
    expect(nextOccurrencesAfter(timing, due - 1, 1)).toEqual([due]);
    expect(nextOccurrencesAfter(timing, due, 1)).toEqual([]);
  });

  test("startsOn and endsOn are inclusive local dates", () => {
    const timing: ScheduleTiming = {
      kind: "daily",
      time: "11:00",
      timeZone: BERLIN,
      startsOn: "2026-12-01",
      endsOn: "2026-12-03",
    };
    expect(
      iso(nextOccurrencesAfter(timing, at("2026-11-25T00:00:00Z"), 10)),
    ).toEqual([
      "2026-12-01T10:00:00.000Z",
      "2026-12-02T10:00:00.000Z",
      "2026-12-03T10:00:00.000Z",
    ]);
    // The endsOn date's occurrence is the last; the day after is not.
    expect(nextOccurrencesAfter(timing, at("2026-12-03T10:00:00Z"), 1)).toEqual(
      [],
    );
  });

  test("endsOn is a LOCAL date: 00:30 Tokyo on endsOn is still the previous UTC day", () => {
    const timing: ScheduleTiming = {
      kind: "daily",
      time: "00:30",
      timeZone: "Asia/Tokyo",
      endsOn: "2026-12-02",
    };
    expect(
      iso(nextOccurrencesAfter(timing, at("2026-11-30T00:00:00Z"), 5)),
    ).toEqual(["2026-11-30T15:30:00.000Z", "2026-12-01T15:30:00.000Z"]);
  });

  test("n bounds the count and n <= 0 returns nothing", () => {
    const timing: ScheduleTiming = {
      kind: "daily",
      time: "11:00",
      timeZone: "UTC",
    };
    expect(nextOccurrencesAfter(timing, 0, 3)).toHaveLength(3);
    expect(nextOccurrencesAfter(timing, 0, 0)).toEqual([]);
  });
});

describe("scheduleTimingError", () => {
  test("accepts every valid preset", () => {
    const valid: ScheduleTiming[] = [
      { kind: "once", date: "2026-12-01", time: "08:00", timeZone: BERLIN },
      { kind: "daily", time: "23:59", timeZone: "UTC", endsOn: "2027-01-01" },
      { kind: "weekdays", time: "00:00", timeZone: "America/Havana" },
      {
        kind: "weekly",
        days: [...SCHEDULE_WEEKDAYS],
        time: "11:00",
        timeZone: BERLIN,
      },
      { kind: "monthly", day: 31, time: "11:00", timeZone: BERLIN },
    ];
    for (const timing of valid) expect(scheduleTimingError(timing)).toBeNull();
  });

  test.each([
    [null, "timing must be an object"],
    [{ kind: "daily", time: "24:00", timeZone: "UTC" }, "timing.time"],
    [{ kind: "daily", time: "9:00", timeZone: "UTC" }, "timing.time"],
    [
      { kind: "daily", time: "09:00", timeZone: "Mars/Base" },
      "timing.timeZone",
    ],
    [{ kind: "hourly", time: "09:00", timeZone: "UTC" }, "timing.kind"],
    [
      { kind: "once", date: "2026-02-30", time: "09:00", timeZone: "UTC" },
      "timing.date",
    ],
    [
      { kind: "weekly", days: [], time: "09:00", timeZone: "UTC" },
      "timing.days",
    ],
    [
      { kind: "weekly", days: ["mon", "mon"], time: "09:00", timeZone: "UTC" },
      "timing.days",
    ],
    [
      { kind: "monthly", day: 32, time: "09:00", timeZone: "UTC" },
      "timing.day",
    ],
    [
      { kind: "monthly", day: 1.5, time: "09:00", timeZone: "UTC" },
      "timing.day",
    ],
    [
      { kind: "daily", time: "09:00", timeZone: "UTC", startsOn: "tomorrow" },
      "timing.startsOn",
    ],
    [
      {
        kind: "daily",
        time: "09:00",
        timeZone: "UTC",
        startsOn: "2026-12-02",
        endsOn: "2026-12-01",
      },
      "timing.endsOn",
    ],
  ])("refuses %j", (timing, reason) => {
    expect(scheduleTimingError(timing)).toContain(reason);
  });
});

describe("canonicalScheduleTiming and scheduleTimingsEqual (T1.14)", () => {
  const weekly: ScheduleTiming = {
    kind: "weekly",
    days: ["mon", "fri"],
    time: "09:00",
    timeZone: BERLIN,
    endsOn: "2026-12-31",
  };

  test("the canonical form has the kind's keys in a fixed order and days in weekday order", () => {
    const shuffled = {
      endsOn: "2026-12-31",
      timeZone: BERLIN,
      days: ["fri", "mon"],
      time: "09:00",
      startsOn: undefined,
      kind: "weekly",
    } as unknown as ScheduleTiming;
    const canonical = canonicalScheduleTiming(shuffled);
    expect(JSON.stringify(canonical)).toBe(
      '{"kind":"weekly","days":["mon","fri"],"time":"09:00","timeZone":"Europe/Berlin","endsOn":"2026-12-31"}',
    );
    expect(Object.keys(canonical)).not.toContain("startsOn");
    // A once has no repeat window; a stray key of another kind is dropped.
    expect(
      canonicalScheduleTiming({
        timeZone: "UTC",
        time: "08:00",
        date: "2026-12-01",
        kind: "once",
        days: ["mon"],
      } as unknown as ScheduleTiming),
    ).toStrictEqual({
      kind: "once",
      date: "2026-12-01",
      time: "08:00",
      timeZone: "UTC",
    });
  });

  test("equal across key order, days order and absent vs undefined", () => {
    expect(
      scheduleTimingsEqual(weekly, {
        ...weekly,
        days: ["fri", "mon"],
        startsOn: undefined,
      } as unknown as ScheduleTiming),
    ).toBe(true);
    expect(
      scheduleTimingsEqual({ kind: "daily", time: "09:00", timeZone: BERLIN }, {
        timeZone: BERLIN,
        time: "09:00",
        kind: "daily",
        endsOn: undefined,
      } as unknown as ScheduleTiming),
    ).toBe(true);
  });

  test("unequal for a changed zone, time, day, endsOn or kind", () => {
    for (const changed of [
      { ...weekly, timeZone: "Europe/London" },
      { ...weekly, time: "09:01" },
      { ...weekly, days: ["mon", "thu"] },
      { ...weekly, days: ["mon"] },
      { ...weekly, endsOn: "2027-01-01" },
      { ...weekly, endsOn: undefined },
      { ...weekly, startsOn: "2026-12-01" },
    ] as ScheduleTiming[])
      expect(scheduleTimingsEqual(weekly, changed)).toBe(false);
    const monthly: ScheduleTiming = {
      kind: "monthly",
      day: 31,
      time: "09:00",
      timeZone: BERLIN,
    };
    expect(scheduleTimingsEqual(monthly, { ...monthly, day: 30 })).toBe(false);
    expect(
      scheduleTimingsEqual(
        { kind: "daily", time: "09:00", timeZone: BERLIN },
        { kind: "weekdays", time: "09:00", timeZone: BERLIN },
      ),
    ).toBe(false);
    expect(
      scheduleTimingsEqual(
        { kind: "once", date: "2026-12-01", time: "09:00", timeZone: BERLIN },
        { kind: "once", date: "2026-12-02", time: "09:00", timeZone: BERLIN },
      ),
    ).toBe(false);
  });
});

describe("normalizeScheduleSettings", () => {
  test("fills defaults, clamps ranges and rejects wrong kinds", () => {
    expect(normalizeScheduleSettings(undefined)).toEqual(
      DEFAULT_SCHEDULE_SETTINGS,
    );
    expect(DEFAULT_SCHEDULE_SETTINGS).toEqual({
      graceWindowMinutes: 60,
      cardlessLimit: 10,
      paused: false,
    });
    expect(
      normalizeScheduleSettings({
        graceWindowMinutes: 5000,
        cardlessLimit: -3,
        paused: true,
      }),
    ).toEqual({ graceWindowMinutes: 1440, cardlessLimit: 0, paused: true });
    expect(
      normalizeScheduleSettings({
        graceWindowMinutes: "x" as unknown as number,
        paused: "yes" as unknown as boolean,
      }),
    ).toEqual(DEFAULT_SCHEDULE_SETTINGS);
  });
});

test("claimed is the one open occurrence state", () => {
  expect(SCHEDULE_OCCURRENCE_STATES[0]).toBe("claimed");
});

describe("schedule time formatting", () => {
  // 2026-11-25 14:45Z is a Wednesday, CET (UTC+1) in Berlin.
  const winter = Date.UTC(2026, 10, 25, 14, 45);

  test("a due time reads in the frozen zone, without the year", () => {
    expect(formatScheduleDue(winter, "Europe/Berlin")).toBe("Wed 25 Nov 15:45");
    expect(formatScheduleDue(winter, "UTC")).toBe("Wed 25 Nov 14:45");
    // Single-digit days are not padded; Tokyo is already on the next day.
    expect(formatScheduleDue(Date.UTC(2026, 2, 3, 23, 5), "Asia/Tokyo")).toBe(
      "Wed 4 Mar 08:05",
    );
  });

  test("an absolute instant carries its year, zone and UTC offset", () => {
    expect(formatScheduleInstant(winter, "Europe/Berlin")).toBe(
      "Wed 25 Nov 2026 15:45 Europe/Berlin (UTC+01:00)",
    );
    // CEST in summer.
    expect(
      formatScheduleInstant(Date.UTC(2026, 6, 15, 7, 30), "Europe/Berlin"),
    ).toBe("Wed 15 Jul 2026 09:30 Europe/Berlin (UTC+02:00)");
    // West of UTC: EST in winter, EDT in summer.
    expect(formatScheduleInstant(winter, "America/New_York")).toBe(
      "Wed 25 Nov 2026 09:45 America/New_York (UTC-05:00)",
    );
    expect(
      formatScheduleInstant(Date.UTC(2026, 6, 15, 13, 0), "America/New_York"),
    ).toBe("Wed 15 Jul 2026 09:00 America/New_York (UTC-04:00)");
    expect(
      formatScheduleInstant(Date.UTC(2026, 0, 1, 0, 0), "Asia/Kolkata"),
    ).toBe("Thu 1 Jan 2026 05:30 Asia/Kolkata (UTC+05:30)");
  });

  test("the offset tells a fall-back night's repeated wall time apart", () => {
    // Berlin falls back on 25 Oct 2026 at 01:00Z: 02:30 local happens twice.
    expect(
      formatScheduleInstant(Date.UTC(2026, 9, 25, 0, 30), "Europe/Berlin"),
    ).toBe("Sun 25 Oct 2026 02:30 Europe/Berlin (UTC+02:00)");
    expect(
      formatScheduleInstant(Date.UTC(2026, 9, 25, 1, 30), "Europe/Berlin"),
    ).toBe("Sun 25 Oct 2026 02:30 Europe/Berlin (UTC+01:00)");
    // The due form has no offset: both read the same, which is why tool
    // output uses the absolute form.
    expect(
      formatScheduleDue(Date.UTC(2026, 9, 25, 0, 30), "Europe/Berlin"),
    ).toBe(formatScheduleDue(Date.UTC(2026, 9, 25, 1, 30), "Europe/Berlin"));
    // Spring forward on 29 Mar 2026 at 01:00Z: 01:59 CET, then 03:00 CEST.
    expect(
      formatScheduleInstant(Date.UTC(2026, 2, 29, 1, 0), "Europe/Berlin"),
    ).toBe("Sun 29 Mar 2026 03:00 Europe/Berlin (UTC+02:00)");
  });
});
