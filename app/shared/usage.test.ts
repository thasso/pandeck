import { describe, expect, it } from "vitest";
import {
  OPENAI_RESET_AUTO_REDEEM_LEAD_MS,
  formatUsageReset,
  resetCreditExpiryLevel,
} from "./usage.ts";

const NOW = Date.parse("2026-08-06T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The label for a reset `ms` from now. */
const inMs = (ms: number) =>
  formatUsageReset(new Date(NOW + ms).toISOString(), NOW);

describe("formatUsageReset", () => {
  it("keeps minutes only while the wait is short", () => {
    expect(inMs(45 * MINUTE)).toBe("45m");
    expect(inMs(2 * HOUR + 20 * MINUTE)).toBe("2h 20m");
    expect(inMs(3 * HOUR)).toBe("3h");
  });

  it("drops minute-level detail once the wait is long", () => {
    // Ten hours out, "13h 42m" is false precision on a cached number.
    expect(inMs(13 * HOUR + 42 * MINUTE)).toBe("14h");
    expect(inMs(2 * DAY + 3 * HOUR + 42 * MINUTE)).toBe("2d 4h");
    expect(inMs(3 * DAY)).toBe("3d");
    // Past ten days the hour is noise too, and dropping it is what keeps the
    // six-character bound true for every input, not just weekly windows.
    expect(inMs(12 * DAY + 9 * HOUR)).toBe("12d");
    expect(inMs(400 * DAY)).toBe("400d");
  });

  it("carries rounding upward instead of printing an overflowing unit", () => {
    expect(inMs(59 * MINUTE + 40_000)).toBe("1h");
    expect(inMs(9 * HOUR + 59 * MINUTE + 40_000)).toBe("10h");
    expect(inMs(23 * HOUR + 50 * MINUTE)).toBe("1d");
    expect(inMs(6 * DAY + 23 * HOUR + 50 * MINUTE)).toBe("7d");
    expect(inMs(9 * DAY + 23 * HOUR + 50 * MINUTE)).toBe("10d");
  });

  it("stays inside the width the card reserves for it", () => {
    for (const ms of [
      30_000,
      MINUTE,
      59 * MINUTE,
      HOUR + MINUTE,
      9 * HOUR + 59 * MINUTE,
      13 * HOUR,
      DAY + HOUR,
      6 * DAY + 23 * HOUR,
      9 * DAY + 23 * HOUR,
      365 * DAY,
      9999 * DAY,
    ])
      expect(inMs(ms).length).toBeLessThanOrEqual(6);
  });

  it("says `now` at and past the reset, and nothing at all when unknown", () => {
    expect(inMs(20_000)).toBe("now");
    expect(inMs(0)).toBe("now");
    expect(inMs(-HOUR)).toBe("now");
    expect(formatUsageReset(null, NOW)).toBe("");
    expect(formatUsageReset(undefined, NOW)).toBe("");
    expect(formatUsageReset("not a date", NOW)).toBe("");
  });
});

describe("resetCreditExpiryLevel", () => {
  const level = (ms: number) =>
    resetCreditExpiryLevel(new Date(NOW + ms).toISOString(), NOW);

  it("bands a credit's expiry by how much of it is left", () => {
    expect(level(20 * DAY)).toBe("ok");
    expect(level(5 * DAY)).toBe("soon");
    expect(level(2 * DAY)).toBe("soon");
    expect(level(DAY)).toBe("imminent");
    expect(level(8 * HOUR)).toBe("imminent");
  });

  it("is `pending` inside the auto-redeem lead — the server is about to spend it", () => {
    expect(level(OPENAI_RESET_AUTO_REDEEM_LEAD_MS)).toBe("pending");
    expect(level(OPENAI_RESET_AUTO_REDEEM_LEAD_MS + MINUTE)).toBe("imminent");
    expect(level(10 * MINUTE)).toBe("pending");
  });

  it("says expired at and past the moment, and unknown without one", () => {
    expect(level(0)).toBe("expired");
    expect(level(-HOUR)).toBe("expired");
    expect(resetCreditExpiryLevel(null, NOW)).toBe("unknown");
    expect(resetCreditExpiryLevel("not a date", NOW)).toBe("unknown");
  });
});
