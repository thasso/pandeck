import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import {
  getOrCreateVapidKeys,
  listWebPushSubscriptions,
  normalizeWebPushOrigin,
  normalizeWebPushSubscription,
  removeWebPushSubscription,
  upsertWebPushSubscription,
} from "./webPushStore.ts";

const storeDir = join(DATA_DIR, "web-push");
const subscription = {
  endpoint: "https://push.example.test/subscription/one",
  keys: { p256dh: "abc_DEF-123", auth: "auth_123" },
};

beforeEach(() => rmSync(storeDir, { recursive: true, force: true }));
afterEach(() => rmSync(storeDir, { recursive: true, force: true }));

test("persists one private VAPID key pair", () => {
  let generated = 0;
  const first = getOrCreateVapidKeys(() => {
    generated += 1;
    return { publicKey: "public_123", privateKey: "private_456" };
  });
  const second = getOrCreateVapidKeys(() => {
    generated += 1;
    return { publicKey: "other", privateKey: "other" };
  });

  assert.deepEqual(first, second);
  assert.equal(generated, 1);
  assert.equal(statSync(storeDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(storeDir, "vapid.json")).mode & 0o777, 0o600);
});

test("upserts and removes subscriptions idempotently", () => {
  const first = upsertWebPushSubscription(
    subscription,
    "https://pa.example.test",
    100,
  );
  const updated = upsertWebPushSubscription(
    { ...subscription, keys: { ...subscription.keys, auth: "changed" } },
    "https://pa.example.test",
    200,
  );

  assert.equal(first.createdAt, 100);
  assert.equal(updated.createdAt, 100);
  assert.equal(updated.updatedAt, 200);
  assert.equal(updated.keys.auth, "changed");
  assert.equal(listWebPushSubscriptions().length, 1);
  assert.equal(
    statSync(join(storeDir, "subscriptions.json")).mode & 0o777,
    0o600,
  );
  assert.equal(removeWebPushSubscription(subscription.endpoint), true);
  assert.equal(removeWebPushSubscription(subscription.endpoint), false);
  assert.deepEqual(listWebPushSubscriptions(), []);
});

test("strictly validates subscription capability data and installation origins", () => {
  assert.deepEqual(normalizeWebPushSubscription(subscription), subscription);
  assert.equal(
    normalizeWebPushOrigin("https://pa.example.test/path"),
    "https://pa.example.test",
  );
  assert.equal(
    normalizeWebPushOrigin("http://localhost:8787"),
    "http://localhost:8787",
  );
  assert.throws(
    () =>
      normalizeWebPushSubscription({
        ...subscription,
        endpoint: "http://push.example.test/one",
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      normalizeWebPushSubscription({
        ...subscription,
        keys: { ...subscription.keys, auth: "not base64!" },
      }),
    /base64url/,
  );
  assert.throws(
    () => normalizeWebPushOrigin("http://pa.example.test"),
    /HTTPS/,
  );
});
