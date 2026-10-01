import assert from "node:assert/strict";
import { test } from "vitest";
import { localDayBoundsMs } from "@assistant/shared/zonedTime";
import {
  formatLocalDateTime,
  localDateOf,
  localDayRange,
  normalizeRfc3339,
} from "./googleTime.ts";

test("local day ranges are the shared day bounds, across every DST shape", () => {
  const cases: Array<[string, string, string, string]> = [
    [
      "Europe/Berlin",
      "2026-03-29",
      "2026-03-28T23:00:00.000Z",
      "2026-03-29T22:00:00.000Z",
    ],
    [
      "Europe/Berlin",
      "2026-10-25",
      "2026-10-24T22:00:00.000Z",
      "2026-10-25T23:00:00.000Z",
    ],
    [
      "Pacific/Auckland",
      "2026-09-27",
      "2026-09-26T12:00:00.000Z",
      "2026-09-27T11:00:00.000Z",
    ],
    [
      "Pacific/Auckland",
      "2026-04-05",
      "2026-04-04T11:00:00.000Z",
      "2026-04-05T12:00:00.000Z",
    ],
    [
      "America/Havana",
      "2026-03-08",
      "2026-03-08T05:00:00.000Z",
      "2026-03-09T04:00:00.000Z",
    ],
  ];
  for (const [zone, date, from, to] of cases) {
    assert.deepEqual(
      localDayRange(date, zone),
      { from, to },
      `${zone} ${date}`,
    );
    const shared = localDayBoundsMs(date, zone);
    assert.equal(Date.parse(from), shared.startMs);
    assert.equal(Date.parse(to), shared.endMs);
  }
});

test("formats instants and dates in the zone it is given", () => {
  const instant = "2026-08-10T22:30:00Z";
  assert.equal(
    formatLocalDateTime(instant, "Europe/Berlin"),
    "11.08.2026, 00:30",
  );
  assert.equal(formatLocalDateTime(instant, "UTC"), "10.08.2026, 22:30");
  assert.equal(formatLocalDateTime("not-a-date", "UTC"), "not-a-date");
  assert.equal(formatLocalDateTime(null, "UTC"), null);
  assert.equal(localDateOf(instant, "Europe/Berlin"), "2026-08-11");
  assert.equal(localDateOf(instant, "America/New_York"), "2026-08-10");
});

test("keeps RFC3339 normalization behavior", () => {
  assert.equal(
    normalizeRfc3339("2026-08-10T14:30:00+02:00", "from"),
    "2026-08-10T12:30:00.000Z",
  );
  assert.throws(() => normalizeRfc3339("not-a-date", "from"), {
    message: "from must be an RFC3339 date/time.",
  });
});
