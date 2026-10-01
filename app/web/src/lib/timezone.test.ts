/**
 * pnpm --filter @assistant/web test src/lib/timezone.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  isValidTimezone,
  resolveTimezone,
  temporalModeUsesTimezone,
  utcMsToZonedWallTimeValue,
  zonedWallTimeToUtcMs,
} from "./timezone.ts";

describe("zonedWallTimeToUtcMs / utcMsToZonedWallTimeValue", () => {
  it("converts a wall-clock time in a fixed-offset zone", () => {
    // UTC has zero offset, so the round trip is exact and simple to verify.
    const ms = zonedWallTimeToUtcMs("2026-06-15T14:30", "UTC");
    expect(new Date(ms).toISOString()).toBe("2026-06-15T14:30:00.000Z");
    expect(utcMsToZonedWallTimeValue(ms, "UTC")).toBe("2026-06-15T14:30");
  });

  it("interprets the same naive string differently depending on the target timezone", () => {
    const berlin = zonedWallTimeToUtcMs("2026-06-15T14:30", "Europe/Berlin"); // CEST = UTC+2
    const tokyo = zonedWallTimeToUtcMs("2026-06-15T14:30", "Asia/Tokyo"); // JST = UTC+9
    expect(berlin).not.toBe(tokyo);
    expect(new Date(berlin).toISOString()).toBe("2026-06-15T12:30:00.000Z");
    expect(new Date(tokyo).toISOString()).toBe("2026-06-15T05:30:00.000Z");
  });

  it("round-trips across a DST transition (spring-forward in Europe/Berlin)", () => {
    // 2026-03-29 is Berlin's spring-forward date; 03:30 local is a valid post-transition time.
    const ms = zonedWallTimeToUtcMs("2026-03-29T03:30", "Europe/Berlin");
    expect(utcMsToZonedWallTimeValue(ms, "Europe/Berlin")).toBe(
      "2026-03-29T03:30",
    );
  });
});

describe("isValidTimezone / resolveTimezone", () => {
  it("accepts valid IANA zones and rejects garbage without throwing", () => {
    expect(isValidTimezone("Europe/Berlin")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("not a timezone")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });

  it("resolveTimezone falls back to the given default for an invalid/empty candidate, never throwing", () => {
    expect(resolveTimezone("Asia/Tokyo", "Europe/Berlin")).toBe("Asia/Tokyo");
    expect(resolveTimezone("not a timezone", "Europe/Berlin")).toBe(
      "Europe/Berlin",
    );
    expect(resolveTimezone(undefined, "Europe/Berlin")).toBe("Europe/Berlin");
    expect(resolveTimezone("   ", "Europe/Berlin")).toBe("Europe/Berlin");
    // Critically: this must not throw even for a string that would crash a raw
    // `new Intl.DateTimeFormat(..., { timeZone: candidate })` call.
    expect(() =>
      resolveTimezone("Europe/Not_A_Real_City", "UTC"),
    ).not.toThrow();
  });
});

describe("temporalModeUsesTimezone", () => {
  it("is true only for window/recurring, so an irrelevant invalid timezone never blocks other modes (exchange 23)", () => {
    expect(temporalModeUsesTimezone("persistent")).toBe(false);
    expect(temporalModeUsesTimezone("until-changed")).toBe(false);
    expect(temporalModeUsesTimezone("window")).toBe(true);
    expect(temporalModeUsesTimezone("recurring")).toBe(true);
  });
});
