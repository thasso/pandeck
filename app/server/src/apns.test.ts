import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  createPublicKey,
  createVerify,
} from "node:crypto";
import { test } from "vitest";
import type { ApnsCredential, StoredApnsDevice } from "./apnsStore.ts";
import {
  apnsPayload,
  probeApnsCredential,
  providerToken,
  sendApnsNotification,
  type ApnsResponse,
} from "./apns.ts";

const { privateKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const credential: ApnsCredential = {
  keyId: "ABC1234567",
  teamId: "WCD4UBU845",
  bundleId: "test.acme.app.shell",
  privateKey,
  keyScope: "team",
};

function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(token.split(".")[1]!, "base64url").toString(),
  ) as Record<string, unknown>;
}

function device(overrides: Partial<StoredApnsDevice> = {}): StoredApnsDevice {
  return {
    token: "a".repeat(64),
    environment: "development",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const alert = {
  title: "Turn finished",
  body: "Implement APNs",
  navigatePath: "/session/session-1",
};

test("puts the navigation target OUTSIDE aps, where the device reads userInfo", () => {
  // The whole payload is `userInfo` on the device, and `aps` is Apple's half —
  // a target nested inside it would be dropped by the system rather than handed
  // to the app, so a tap would open the app and lose the session.
  assert.deepEqual(apnsPayload(alert), {
    aps: {
      alert: { title: "Turn finished", body: "Implement APNs" },
      sound: "default",
      "thread-id": "assistant",
    },
    paTarget: "/session/session-1",
  });
});

test("bounds the title and body rather than letting a long session name through", () => {
  const payload = apnsPayload({
    title: "T".repeat(400),
    body: "B".repeat(400),
    navigatePath: "/",
  });
  const aps = (payload.aps as { alert: { title: string; body: string } }).alert;
  assert.equal(aps.title.length, 120);
  assert.equal(aps.body.length, 240);
});

test("signs the provider token as a verifiable ES256 JWT with the key id", () => {
  const token = providerToken(credential, 1_700_000_000_000);
  const [header, claims, signature] = token.split(".");
  assert.ok(header && claims && signature);
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), {
    alg: "ES256",
    kid: "ABC1234567",
  });
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url").toString()), {
    iss: "WCD4UBU845",
    iat: 1_700_000_000,
  });
  // `ieee-p1363`, not OpenSSL's default DER: Apple rejects a DER signature as an
  // invalid provider token and says nothing more specific about why.
  const verified = createVerify("SHA256")
    .update(`${header}.${claims}`)
    .verify(
      { key: createPublicKey(privateKey), dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    );
  assert.equal(verified, true);
});

test("names the topic in sub only for a topic-specific key", () => {
  // Both mistakes are rejected as `InvalidProviderToken` and nothing more, so
  // which claim set goes with which portal scope is worth pinning down here.
  assert.equal(
    "sub" in claimsOf(providerToken(credential, 1_700_000_000_000)),
    false,
  );
  const scoped = providerToken(
    { ...credential, keyId: "TOPIC12345", keyScope: "topic" },
    1_700_000_000_000,
  );
  assert.equal(claimsOf(scoped).sub, "test.acme.app.shell");
});

test("reuses a provider token inside Apple's hour and re-signs after it", () => {
  const first = providerToken(credential, 1_700_000_000_000);
  assert.equal(providerToken(credential, 1_700_000_600_000), first);
  assert.notEqual(providerToken(credential, 1_700_003_600_000), first);
});

test("posts to the sandbox host for a development token and production for the other", async () => {
  const hosts: string[] = [];
  const post = async (
    _credential: ApnsCredential,
    target: StoredApnsDevice,
  ): Promise<ApnsResponse> => {
    hosts.push(target.environment);
    return { status: 200 };
  };
  const report = await sendApnsNotification(alert, {
    credential,
    devices: [
      device(),
      device({ token: "b".repeat(64), environment: "production" }),
    ],
    post,
  });
  assert.deepEqual(hosts, ["development", "production"]);
  assert.deepEqual(report, { delivered: 2, failures: [] });
});

test("retires a token Apple reports as dead and keeps every other one", async () => {
  const removed: string[] = [];
  const report = await sendApnsNotification(alert, {
    credential,
    devices: [
      device(),
      device({ token: "b".repeat(64) }),
      device({ token: "c".repeat(64) }),
    ],
    post: async (_credential, target) =>
      target.token.startsWith("b")
        ? { status: 410, reason: "Unregistered" }
        : { status: 200 },
    removeDevice: (token) => {
      removed.push(token);
      return true;
    },
  });
  assert.deepEqual(removed, ["b".repeat(64)]);
  assert.equal(report.delivered, 2);
  assert.equal(report.failures.length, 1);
});

test("keeps a token Apple merely refused this once", async () => {
  const removed: string[] = [];
  const report = await sendApnsNotification(alert, {
    credential,
    devices: [device()],
    // 429/500-class answers say try later, not that the device is gone. Retiring
    // on those would silently unsubscribe a working phone.
    post: async () => ({ status: 429, reason: "TooManyRequests" }),
    removeDevice: (token) => {
      removed.push(token);
      return true;
    },
  });
  assert.deepEqual(removed, []);
  assert.equal(report.delivered, 0);
  assert.equal(report.failures.length, 1);
});

test("survives one device throwing without dropping the others", async () => {
  const report = await sendApnsNotification(alert, {
    credential,
    devices: [device(), device({ token: "b".repeat(64) })],
    post: async (_credential, target) => {
      if (target.token.startsWith("a")) throw new Error("connect ETIMEDOUT");
      return { status: 200 };
    },
  });
  assert.equal(report.delivered, 1);
  assert.deepEqual(report.failures, ["connect ETIMEDOUT"]);
});

test("reads Apple's BadDeviceToken as a WORKING credential when probing", async () => {
  // The probe pushes to a device that cannot exist, so Apple complaining about the
  // device is proof it accepted the provider token first. Reading this as a
  // failure would make `check:apns` reject every correct credential.
  const good = await probeApnsCredential(
    credential,
    "development",
    async () => ({
      status: 400,
      reason: "BadDeviceToken",
    }),
  );
  assert.equal(good.authenticated, true);

  const refused = await probeApnsCredential(
    credential,
    "development",
    async () => ({
      status: 403,
      reason: "InvalidProviderToken",
    }),
  );
  assert.equal(refused.authenticated, false);
  assert.match(refused.verdict, /keyScope/);
  // Names the OTHER scope, since that is the fix.
  assert.match(refused.verdict, /"topic"/);

  const wrongTopic = await probeApnsCredential(
    credential,
    "development",
    async () => ({
      status: 400,
      reason: "DeviceTokenNotForTopic",
    }),
  );
  assert.equal(wrongTopic.authenticated, false);
  assert.match(wrongTopic.verdict, /test\.acme\.app\.shell/);
});

test("explains an environment-restricted key rather than calling it unrecognised", async () => {
  // The portal restricts a key to one of Apple's two environments, so the host it
  // is not for answers this. Reading it as a mystery sent the operator hunting a
  // fault in a key that was working.
  const probe = await probeApnsCredential(
    credential,
    "production",
    async () => ({
      status: 403,
      reason: "BadEnvironmentKeyInToken",
    }),
  );
  assert.equal(probe.authenticated, false);
  assert.match(probe.verdict, /restricted to the other environment/);
});

test("probes the host the caller asked for", async () => {
  const seen: string[] = [];
  await probeApnsCredential(
    credential,
    "production",
    async (_credential, device) => {
      seen.push(device.environment);
      return { status: 400, reason: "BadDeviceToken" };
    },
  );
  assert.deepEqual(seen, ["production"]);
});

test("says why nothing was sent when there is no key or no device", async () => {
  const noKey = await sendApnsNotification(alert, { credential: null });
  assert.equal(noKey.delivered, 0);
  assert.equal(noKey.failures.length, 1);
  const noDevice = await sendApnsNotification(alert, {
    credential,
    devices: [],
  });
  assert.equal(noDevice.delivered, 0);
  assert.equal(noDevice.failures.length, 1);
});
