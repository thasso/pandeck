import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { updateSettings } from "../../settings.ts";
import { assistantTimeTools } from "./timeTools.ts";

const [currentTime] = assistantTimeTools;

async function at(iso: string, timeZone?: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
  const result = await currentTime!.execute(
    timeZone ? { timeZone } : {},
    {} as never,
  );
  return result.details as {
    requested: Record<string, string>;
    user?: Record<string, string>;
  };
}

afterEach(() => {
  vi.useRealTimers();
  updateSettings({
    profile: { displayName: "", timeZone: "", effectiveTimeZone: "" },
  });
});

test("the day bounds carry each bound's own offset on a DST day", async () => {
  const { requested } = await at("2026-03-29T12:00:00Z", "Europe/Berlin");
  assert.equal(requested.rfc3339, "2026-03-29T14:00:00+02:00");
  assert.equal(requested.startOfDayRfc3339, "2026-03-29T00:00:00+01:00");
  assert.equal(requested.endOfDayRfc3339, "2026-03-29T23:59:59+02:00");
});

test("a day whose midnight is skipped starts when the gap ends", async () => {
  const { requested } = await at("2026-03-08T15:00:00Z", "America/Havana");
  assert.equal(requested.startOfDayRfc3339, "2026-03-08T01:00:00-04:00");
  assert.equal(requested.endOfDayRfc3339, "2026-03-08T23:59:59-04:00");
});

test("the default zone is the profile's, and another zone also reports it", async () => {
  updateSettings({
    profile: {
      displayName: "",
      timeZone: "Pacific/Auckland",
      effectiveTimeZone: "",
    },
  });
  const plain = await at("2026-09-26T13:00:00Z");
  assert.equal(plain.requested.timeZone, "Pacific/Auckland");
  // Auckland's spring-forward day starts at +12 and ends at +13.
  assert.equal(plain.requested.startOfDayRfc3339, "2026-09-27T00:00:00+12:00");
  assert.equal(plain.requested.endOfDayRfc3339, "2026-09-27T23:59:59+13:00");
  assert.equal(plain.user, undefined);

  const other = await at("2026-09-26T13:00:00Z", "UTC");
  assert.equal(other.requested.timeZone, "UTC");
  assert.equal(other.user?.timeZone, "Pacific/Auckland");
});
