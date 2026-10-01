import assert from "node:assert/strict";
import { test } from "vitest";
import { updateSettings } from "../settings.ts";
import { inWindow, localDayWindow } from "./dayWindow.ts";

const HOUR = 3600 * 1000;

test("an ordinary Berlin day is 24 hours starting at local midnight", () => {
  const window = localDayWindow("2026-07-13", "Europe/Berlin");
  assert.equal(window.endMs - window.startMs, 24 * HOUR);
  // 2026-07-13 is CEST (UTC+2): local midnight is 22:00 UTC the day before.
  assert.equal(window.startIso, "2026-07-12T22:00:00.000Z");
  assert.equal(window.endIso, "2026-07-13T22:00:00.000Z");
});

test("the spring-forward DST day is 23 hours", () => {
  // Europe/Berlin springs forward on 2026-03-29 (02:00 → 03:00).
  const window = localDayWindow("2026-03-29", "Europe/Berlin");
  assert.equal(window.endMs - window.startMs, 23 * HOUR);
  assert.equal(window.startIso, "2026-03-28T23:00:00.000Z");
  assert.equal(window.endIso, "2026-03-29T22:00:00.000Z");
});

test("the fall-back DST day is 25 hours", () => {
  // Europe/Berlin falls back on 2026-10-25 (03:00 → 02:00).
  const window = localDayWindow("2026-10-25", "Europe/Berlin");
  assert.equal(window.endMs - window.startMs, 25 * HOUR);
  assert.equal(window.startIso, "2026-10-24T22:00:00.000Z");
  assert.equal(window.endIso, "2026-10-25T23:00:00.000Z");
});

test("a day whose midnight is skipped starts when the gap ends", () => {
  // America/Havana springs forward AT 00:00 on 2026-03-08 (00:00 → 01:00).
  const window = localDayWindow("2026-03-08", "America/Havana");
  assert.equal(window.startIso, "2026-03-08T05:00:00.000Z");
  assert.equal(window.endIso, "2026-03-09T04:00:00.000Z");
  // Pacific/Auckland's midnight on its spring-forward day keeps the old offset.
  assert.equal(
    localDayWindow("2026-09-27", "Pacific/Auckland").startIso,
    "2026-09-26T12:00:00.000Z",
  );
});

test("inWindow bounds are inclusive-start exclusive-end and reject garbage", () => {
  const window = localDayWindow("2026-07-13", "Europe/Berlin");
  assert.equal(inWindow(window, window.startIso), true);
  assert.equal(inWindow(window, window.endIso), false);
  assert.equal(inWindow(window, window.startMs + HOUR), true);
  assert.equal(inWindow(window, "not-a-date"), false);
  assert.equal(inWindow(window, null), false);
});

test("the default zone is the profile timezone, read at use time", () => {
  const profile = (timeZone: string) =>
    updateSettings({
      profile: { displayName: "", timeZone, effectiveTimeZone: "" },
    });
  try {
    profile("Asia/Tokyo");
    assert.equal(
      localDayWindow("2026-07-13").startIso,
      "2026-07-12T15:00:00.000Z",
    );
    profile("America/New_York");
    const window = localDayWindow("2026-07-13");
    assert.equal(window.timeZone, "America/New_York");
    assert.equal(window.startIso, "2026-07-13T04:00:00.000Z");
  } finally {
    profile("");
  }
});

test("invalid dates are rejected", () => {
  assert.throws(() => localDayWindow("2026-7-13"));
  assert.throws(() => localDayWindow("garbage"));
});
