/**
 * The `once` timing input of `schedule_manage` (T6.8), pure: no store, no
 * clock, no profile.
 *   pnpm --filter @assistant/server test src/tools/schedules/timingInput.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  formatScheduleInstant,
  nextOccurrencesAfter,
} from "@assistant/shared/schedules";
import { parseOnceAt } from "./timingInput.ts";

const BERLIN = "Europe/Berlin";
const NEW_YORK = "America/New_York";
const at = (iso: string) => Date.parse(iso);
/** 2026-11-25 15:00:30 in Berlin (UTC+01:00). */
const NOW = at("2026-11-25T14:00:30Z");

const AT_ERROR =
  'timing.at must be a local date-time ("2026-11-25 15:45"), an ISO time with offset, or a relative time ("in 45m", "in 2h", "in 1d").';

/** Where the stored reading actually occurs, as the echo shows it. */
function echo(reading: { date: string; time: string }, zone: string): string {
  const [first] = nextOccurrencesAfter(
    { kind: "once", ...reading, timeZone: zone },
    at("2026-01-01T00:00:00Z"),
    1,
  );
  return formatScheduleInstant(first!, zone);
}

describe("parseOnceAt: local date-times", () => {
  it("takes a local date-time as given, in the zone's wall clock", () => {
    assert.deepEqual(parseOnceAt("2026-11-25 15:45", BERLIN, NOW), {
      date: "2026-11-25",
      time: "15:45",
    });
    assert.deepEqual(parseOnceAt("2026-11-25T15:45", NEW_YORK, NOW), {
      date: "2026-11-25",
      time: "15:45",
    });
    assert.equal(
      echo(parseOnceAt("2026-11-25 15:45", NEW_YORK, NOW), NEW_YORK),
      "Wed 25 Nov 2026 15:45 America/New_York (UTC-05:00)",
    );
  });

  it("rounds seconds up to the next minute, across midnight too", () => {
    assert.deepEqual(parseOnceAt("2026-11-25 15:45:00", BERLIN, NOW), {
      date: "2026-11-25",
      time: "15:45",
    });
    assert.deepEqual(parseOnceAt("2026-11-25 15:45:01", BERLIN, NOW), {
      date: "2026-11-25",
      time: "15:46",
    });
    assert.deepEqual(parseOnceAt("2026-12-31 23:59:30", BERLIN, NOW), {
      date: "2027-01-01",
      time: "00:00",
    });
  });

  it("keeps a skipped time as given; the recurrence engine moves it to the gap's end", () => {
    const reading = parseOnceAt("2026-03-29 02:30", BERLIN, NOW);
    assert.deepEqual(reading, { date: "2026-03-29", time: "02:30" });
    assert.equal(
      echo(reading, BERLIN),
      "Sun 29 Mar 2026 03:00 Europe/Berlin (UTC+02:00)",
    );
    const ny = parseOnceAt("2026-03-08 02:30", NEW_YORK, NOW);
    assert.equal(
      echo(ny, NEW_YORK),
      "Sun 8 Mar 2026 03:00 America/New_York (UTC-04:00)",
    );
  });

  it("takes a repeated local time as its first pass", () => {
    const reading = parseOnceAt("2026-10-25 02:30", BERLIN, NOW);
    assert.deepEqual(reading, { date: "2026-10-25", time: "02:30" });
    assert.equal(
      echo(reading, BERLIN),
      "Sun 25 Oct 2026 02:30 Europe/Berlin (UTC+02:00)",
    );
  });
});

describe("parseOnceAt: instants with an offset", () => {
  it("rounds an instant up to its minute and reads it in the zone", () => {
    assert.deepEqual(parseOnceAt("2026-11-25T15:45:30+01:00", BERLIN, NOW), {
      date: "2026-11-25",
      time: "15:46",
    });
    assert.deepEqual(parseOnceAt("2026-11-25T14:45Z", BERLIN, NOW), {
      date: "2026-11-25",
      time: "15:45",
    });
    assert.deepEqual(parseOnceAt("2026-11-25T14:45:00.001Z", BERLIN, NOW), {
      date: "2026-11-25",
      time: "15:46",
    });
    // Another offset than the zone's is converted, not copied.
    assert.deepEqual(parseOnceAt("2026-11-25T15:45-05:00", BERLIN, NOW), {
      date: "2026-11-25",
      time: "21:45",
    });
    assert.deepEqual(parseOnceAt("2026-11-25T15:45+01:00", NEW_YORK, NOW), {
      date: "2026-11-25",
      time: "09:45",
    });
  });

  it("refuses the second pass of a repeated time and accepts the first", () => {
    assert.throws(() => parseOnceAt("2026-10-25T02:30+01:00", BERLIN, NOW), {
      message:
        '"2026-10-25T02:30+01:00" is the repeated 02:30 of a daylight-saving change in Europe/Berlin; a Schedule occurs at the first one. Pick the earlier offset or another minute.',
    });
    assert.deepEqual(parseOnceAt("2026-10-25T02:30+02:00", BERLIN, NOW), {
      date: "2026-10-25",
      time: "02:30",
    });
    assert.throws(
      () => parseOnceAt("2026-11-01T01:30-05:00", NEW_YORK, NOW),
      /is the repeated 01:30 of a daylight-saving change in America\/New_York/,
    );
    assert.deepEqual(parseOnceAt("2026-11-01T01:30-04:00", NEW_YORK, NOW), {
      date: "2026-11-01",
      time: "01:30",
    });
  });
});

describe("parseOnceAt: relative times", () => {
  it("adds elapsed time to now and rounds up", () => {
    assert.deepEqual(parseOnceAt("in 45m", BERLIN, NOW), {
      date: "2026-11-25",
      time: "15:46",
    });
    assert.deepEqual(parseOnceAt("in 2h", BERLIN, NOW), {
      date: "2026-11-25",
      time: "17:01",
    });
    assert.deepEqual(parseOnceAt("in 1h30m", BERLIN, NOW), {
      date: "2026-11-25",
      time: "16:31",
    });
    assert.deepEqual(parseOnceAt("in 1h 30m", BERLIN, NOW), {
      date: "2026-11-25",
      time: "16:31",
    });
  });

  it("counts 1d as 24 elapsed hours across a fall-back change", () => {
    // 2026-10-24 12:00 Berlin is UTC+02:00; 24 hours later the zone is +01:00.
    const before = at("2026-10-24T10:00:00Z");
    assert.deepEqual(parseOnceAt("in 1d", BERLIN, before), {
      date: "2026-10-25",
      time: "11:00",
    });
    // And across New York's fall-back.
    assert.deepEqual(
      parseOnceAt("in 1d", NEW_YORK, at("2026-10-31T16:00:00Z")),
      { date: "2026-11-01", time: "11:00" },
    );
  });

  it("refuses a relative time landing on a second pass", () => {
    // 00:30 UTC on 2026-10-25 is 02:30 Berlin's first pass; one hour later
    // the clock reads 02:30 again.
    assert.throws(
      () => parseOnceAt("in 1h", BERLIN, at("2026-10-25T00:30:00Z")),
      /"in 1h" is the repeated 02:30 of a daylight-saving change in Europe\/Berlin/,
    );
    assert.deepEqual(
      parseOnceAt("in 30m", BERLIN, at("2026-10-25T00:00:00Z")),
      { date: "2026-10-25", time: "02:30" },
    );
  });
});

describe("parseOnceAt: unreadable input", () => {
  it("refuses anything else with the approved at error", () => {
    for (const bad of [
      "tomorrow at 9",
      "2026-11-25",
      "15:45",
      "2026-02-30 10:00",
      "2026-11-25 24:00",
      "2026-11-25 15:60",
      "2026-11-25T15:45+25:00",
      "in 5s",
      "in",
      "in -5m",
      "",
      42,
      undefined,
      null,
    ])
      assert.throws(() => parseOnceAt(bad, BERLIN, NOW), { message: AT_ERROR });
  });
});
