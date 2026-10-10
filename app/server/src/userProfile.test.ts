import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test, vi } from "vitest";
import { APP_SETTINGS_PATH } from "./appSettingsFile.ts";
import { getSettings, updateSettings } from "./settings.ts";
import { validateClientMessage } from "./validateClientMessage.ts";
import {
  hostTimeZone,
  userAuthorName,
  userDisplayName,
  userTimeZone,
} from "./userProfile.ts";

/** Pin what the "host" reports, so no assertion depends on the CI container's zone. */
function stubHostZone(timeZone: string | undefined): void {
  const real = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(
    function (this: Intl.DateTimeFormat) {
      return { ...real.call(this), timeZone } as ReturnType<typeof real>;
    },
  );
}

function setProfile(displayName: string, timeZone: string): void {
  updateSettings({
    profile: { displayName, timeZone, effectiveTimeZone: "" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  setProfile("", "");
});

test("userTimeZone: a valid stored zone wins over the host", () => {
  stubHostZone("Asia/Kolkata");
  setProfile("", "America/New_York");
  assert.equal(userTimeZone(), "America/New_York");
});

test("userTimeZone: an empty or invalid stored zone follows the host", () => {
  stubHostZone("Asia/Kolkata");
  setProfile("", "");
  assert.equal(userTimeZone(), "Asia/Kolkata");
  setProfile("", "Not/AZone");
  assert.equal(userTimeZone(), "Asia/Kolkata");
  assert.equal(
    getSettings().profile.timeZone,
    "",
    "an invalid zone is normalized to follow-the-host",
  );
});

test("userTimeZone: a host without a usable zone falls back to UTC", () => {
  stubHostZone(undefined);
  setProfile("", "");
  assert.equal(hostTimeZone(), "UTC");
  assert.equal(userTimeZone(), "UTC");
});

test("userTimeZone reads the settings at use time, without a restart", () => {
  setProfile("", "Asia/Tokyo");
  assert.equal(userTimeZone(), "Asia/Tokyo");
  setProfile("", "Europe/Lisbon");
  assert.equal(userTimeZone(), "Europe/Lisbon");
});

test("the settings projection carries the effective zone, which never persists", () => {
  stubHostZone("Asia/Kolkata");
  const saved = updateSettings({
    profile: {
      displayName: "  Ada Lovelace  ",
      timeZone: " ",
      effectiveTimeZone: "Pacific/Auckland",
    },
  }).profile;
  assert.deepEqual(saved, {
    displayName: "Ada Lovelace",
    timeZone: "",
    effectiveTimeZone: "Asia/Kolkata",
  });
  const stored = JSON.parse(readFileSync(APP_SETTINGS_PATH, "utf8")) as {
    profile: unknown;
  };
  assert.deepEqual(stored.profile, {
    displayName: "Ada Lovelace",
    timeZone: "",
  });

  setProfile("Ada Lovelace", "Europe/Berlin");
  assert.equal(getSettings().profile.effectiveTimeZone, "Europe/Berlin");
});

test("a new user comment is authored by the display name, else You", () => {
  setProfile("  Ada  ", "");
  assert.equal(userDisplayName(), "Ada");
  assert.equal(userAuthorName(), "Ada");
  setProfile("", "");
  assert.equal(userAuthorName(), "You");
});

test("a malformed profile patch is rejected before it can wipe the profile", () => {
  for (const profile of [
    [],
    "Europe/Berlin",
    { timeZone: 42 },
    { displayName: null },
    { displayName: "Ada", effectiveTimeZone: 7 },
  ])
    assert.equal(
      validateClientMessage({ type: "updateSettings", patch: { profile } }).ok,
      false,
      `expected ${JSON.stringify(profile)} to be rejected`,
    );
  for (const profile of [
    {},
    { displayName: "Ada" },
    { displayName: "Ada", timeZone: "", effectiveTimeZone: "UTC" },
  ])
    assert.equal(
      validateClientMessage({ type: "updateSettings", patch: { profile } }).ok,
      true,
      `expected ${JSON.stringify(profile)} to be accepted`,
    );
});

test("a profile patch naming one field keeps the other", () => {
  setProfile("Ada", "Asia/Tokyo");
  updateSettings({ profile: { timeZone: "Europe/Lisbon" } as never });
  assert.deepEqual(
    { ...getSettings().profile, effectiveTimeZone: undefined },
    {
      displayName: "Ada",
      timeZone: "Europe/Lisbon",
      effectiveTimeZone: undefined,
    },
  );
  updateSettings({ profile: { displayName: "Grace" } as never });
  assert.equal(getSettings().profile.displayName, "Grace");
  assert.equal(getSettings().profile.timeZone, "Europe/Lisbon");
});
