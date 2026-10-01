import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { beforeEach, test, vi } from "vitest";

// Count every read of the settings file, so the cache is observable.
const reads = vi.hoisted(() => ({ count: 0 }));
vi.mock("./appSettingsFile.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./appSettingsFile.ts")>();
  return {
    ...actual,
    readStoredAppSettings: () => {
      reads.count += 1;
      return actual.readStoredAppSettings();
    },
  };
});

const { APP_SETTINGS_PATH } = await import("./appSettingsFile.ts");
const { updateSettings } = await import("./settings.ts");
const { userDisplayName, userTimeZone } = await import("./userProfile.ts");

function setProfile(displayName: string, timeZone: string): void {
  updateSettings({ profile: { displayName, timeZone, effectiveTimeZone: "" } });
}

beforeEach(() => setProfile("", "Asia/Tokyo"));

test("repeated reads of an unchanged settings file parse it once", () => {
  assert.equal(userTimeZone(), "Asia/Tokyo");
  const before = reads.count;
  for (let i = 0; i < 200; i += 1) {
    assert.equal(userTimeZone(), "Asia/Tokyo");
    assert.equal(userDisplayName(), "");
  }
  assert.equal(reads.count, before, "no re-read while the file is unchanged");
});

test("an in-process settings write is observed immediately", () => {
  assert.equal(userTimeZone(), "Asia/Tokyo");
  setProfile("Ada", "America/New_York");
  assert.equal(userTimeZone(), "America/New_York");
  assert.equal(userDisplayName(), "Ada");
});

test("an out-of-process edit of the settings file is observed", () => {
  assert.equal(userTimeZone(), "Asia/Tokyo");
  // Rewritten in place (same inode), as an editor or another process might.
  const stored = JSON.parse(readFileSync(APP_SETTINGS_PATH, "utf8")) as Record<
    string,
    unknown
  >;
  writeFileSync(
    APP_SETTINGS_PATH,
    JSON.stringify({
      ...stored,
      profile: { displayName: "Grace", timeZone: "Europe/Lisbon" },
    }),
  );
  assert.equal(userTimeZone(), "Europe/Lisbon");
  assert.equal(userDisplayName(), "Grace");
});
