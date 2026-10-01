import assert from "node:assert/strict";
import { test } from "vitest";
import { localDateForInstant, localWallTimeMs } from "./dayWindow.ts";
import { nextScheduledRunMs } from "./schedule.ts";

const ZONE = "Europe/Berlin";

test("next run is today's local time when now is before it", () => {
  const now = localWallTimeMs("2026-07-23", "05:00", ZONE);
  assert.equal(
    nextScheduledRunMs(now, "07:00", ZONE),
    localWallTimeMs("2026-07-23", "07:00", ZONE),
  );
});

test("next run rolls to tomorrow once today's time has passed", () => {
  const now = localWallTimeMs("2026-07-23", "08:00", ZONE);
  assert.equal(
    nextScheduledRunMs(now, "07:00", ZONE),
    localWallTimeMs("2026-07-24", "07:00", ZONE),
  );
});

test("exactly at the fire time rolls to tomorrow (strictly-after semantics)", () => {
  const now = localWallTimeMs("2026-07-23", "07:00", ZONE);
  assert.equal(
    nextScheduledRunMs(now, "07:00", ZONE),
    localWallTimeMs("2026-07-24", "07:00", ZONE),
  );
});

test("fires at the local wall-clock time across a spring-forward DST boundary", () => {
  // 2026-03-29 is the spring-forward day in Europe/Berlin (02:00 → 03:00).
  const now = localWallTimeMs("2026-03-28", "23:00", ZONE);
  const next = nextScheduledRunMs(now, "07:00", ZONE);
  assert.equal(next, localWallTimeMs("2026-03-29", "07:00", ZONE));
  // 07:00 local on the 23h DST day is 05:00Z (CEST, +02:00), not 06:00Z.
  assert.equal(new Date(next).toISOString(), "2026-03-29T05:00:00.000Z");
});

test("a midnight run in a zone that skips midnight fires on the new day, not the old", () => {
  // America/Havana springs forward AT 00:00 on 2026-03-08: the day starts at
  // 01:00 local (05:00Z). A run for "00:00" must not fire at 04:00Z, which is
  // still 23:00 on 2026-03-07.
  const now = Date.parse("2026-03-08T03:00:00Z");
  const fire = nextScheduledRunMs(now, "00:00", "America/Havana");
  assert.equal(new Date(fire).toISOString(), "2026-03-08T05:00:00.000Z");
  assert.equal(localDateForInstant(fire, "America/Havana"), "2026-03-08");
});
