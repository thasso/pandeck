import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import {
  getApnsCredential,
  listApnsDevices,
  normalizeApnsEnvironment,
  normalizeApnsToken,
  removeApnsDevice,
  upsertApnsDevice,
} from "./apnsStore.ts";

const storeDir = join(DATA_DIR, "apns");
const token = "A".repeat(64);
const privateKey =
  "-----BEGIN PRIVATE KEY-----\nMIGHAgEA\n-----END PRIVATE KEY-----\n";

function writeCredential(value: unknown): void {
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(storeDir, "credential.json"), JSON.stringify(value));
}

beforeEach(() => rmSync(storeDir, { recursive: true, force: true }));
afterEach(() => rmSync(storeDir, { recursive: true, force: true }));

test("normalizes a device token to lowercase hex and rejects anything else", () => {
  assert.equal(normalizeApnsToken(token), "a".repeat(64));
  assert.throws(() => normalizeApnsToken("not-hex"));
  assert.throws(() => normalizeApnsToken("ab"));
  assert.throws(() => normalizeApnsToken(42));
});

test("accepts only Apple's two push environments", () => {
  assert.equal(normalizeApnsEnvironment("development"), "development");
  assert.equal(normalizeApnsEnvironment("production"), "production");
  assert.throws(() => normalizeApnsEnvironment("sandbox"));
});

test("upserts by token when no installation is reported", () => {
  const first = upsertApnsDevice(
    { token, environment: "development", label: "iPhone" },
    100,
  );
  const again = upsertApnsDevice(
    { token, environment: "production", label: "iPhone" },
    200,
  );
  assert.equal(listApnsDevices().length, 1);
  assert.equal(first.createdAt, 100);
  // A reissued token keeps its first-seen time but takes the newest environment:
  // a rebuild can move an installation between Apple's hosts.
  assert.equal(again.createdAt, 100);
  assert.equal(again.updatedAt, 200);
  assert.equal(again.environment, "production");

  upsertApnsDevice({ token: "b".repeat(64), environment: "development" }, 300);
  assert.equal(listApnsDevices().length, 2);
  assert.equal(removeApnsDevice(token), true);
  assert.equal(removeApnsDevice(token), false);
  assert.equal(listApnsDevices().length, 1);
});

test("a reissued token REPLACES its installation instead of adding a phone", () => {
  // Observed on a real reinstall: Apple minted a new token, kept delivering to
  // the old one, and one alert arrived twice. Keying on the install is the fix.
  upsertApnsDevice(
    { token, environment: "development", installId: "install-a" },
    100,
  );
  upsertApnsDevice(
    {
      token: "b".repeat(64),
      environment: "development",
      installId: "install-a",
    },
    200,
  );
  const devices = listApnsDevices();
  assert.equal(devices.length, 1);
  assert.equal(devices[0]?.token, "b".repeat(64));
  // First-seen time survives the token swap; it is the same phone.
  assert.equal(devices[0]?.createdAt, 100);

  // A genuinely different phone is not superseded.
  upsertApnsDevice(
    {
      token: "c".repeat(64),
      environment: "development",
      installId: "install-b",
    },
    300,
  );
  assert.equal(listApnsDevices().length, 2);
});

test("still keys on the token for a client that reports no installation", () => {
  upsertApnsDevice({ token, environment: "development" }, 100);
  upsertApnsDevice({ token, environment: "development" }, 200);
  assert.equal(listApnsDevices().length, 1);

  // A row with no installId must stay addressable once installs are identified,
  // rather than being shadowed by one that carries an id.
  upsertApnsDevice(
    { token, environment: "development", installId: "install-a" },
    300,
  );
  assert.equal(listApnsDevices().length, 1);
  assert.equal(listApnsDevices()[0]?.installId, "install-a");
});

test("keeps the store private on disk", () => {
  upsertApnsDevice({ token, environment: "development" }, 100);
  assert.equal(statSync(storeDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(storeDir, "devices.json")).mode & 0o777, 0o600);
});

test("reports push as unconfigured rather than throwing on a bad credential", () => {
  assert.equal(getApnsCredential(), null);

  // Every one of these is a plausible typo, and none of them may take the server
  // — or the settings page that asks this question — down with it.
  writeCredential({
    keyId: "ABC",
    teamId: "WCD4UBU845",
    bundleId: "a.b",
    privateKey,
  });
  assert.equal(getApnsCredential(), null);
  writeCredential({
    keyId: "ABC1234567",
    teamId: "WCD4UBU845",
    bundleId: "a.b",
    privateKey: "/path/to/AuthKey.p8",
  });
  assert.equal(getApnsCredential(), null);

  writeCredential({
    keyId: "ABC1234567",
    teamId: "WCD4UBU845",
    bundleId: "test.acme.app.shell",
    privateKey,
  });
  // A credential with no `keyScope` reads as the team-scoped provider token every
  // APNs example signs, so an existing file keeps working untouched.
  assert.deepEqual(getApnsCredential(), {
    keyId: "ABC1234567",
    teamId: "WCD4UBU845",
    bundleId: "test.acme.app.shell",
    privateKey: privateKey.trim(),
    keyScope: "team",
  });

  writeCredential({
    keyId: "ABC1234567",
    teamId: "WCD4UBU845",
    bundleId: "test.acme.app.shell",
    privateKey,
    keyScope: "topic",
  });
  assert.equal(getApnsCredential()?.keyScope, "topic");

  writeCredential({
    keyId: "ABC1234567",
    teamId: "WCD4UBU845",
    bundleId: "test.acme.app.shell",
    privateKey,
    keyScope: "bundle",
  });
  assert.equal(getApnsCredential(), null);
});

test("ignores a corrupt device list instead of failing every notification", () => {
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(storeDir, "devices.json"), "{ not json");
  assert.deepEqual(listApnsDevices(), []);
});
