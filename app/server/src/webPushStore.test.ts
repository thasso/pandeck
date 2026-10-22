import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

test("persists one VAPID key pair", () => {
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
  assert.equal(removeWebPushSubscription(subscription.endpoint), true);
  assert.equal(removeWebPushSubscription(subscription.endpoint), false);
  assert.deepEqual(listWebPushSubscriptions(), []);
});

test("rejects malformed stored VAPID keys without replacing them", () => {
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, "vapid.json"), "{}");
  let generated = false;
  assert.throws(
    () =>
      getOrCreateVapidKeys(() => {
        generated = true;
        return { publicKey: "public_123", privateKey: "private_456" };
      }),
    { message: "publicKey must be a string." },
  );
  assert.equal(generated, false);
});

test("keeps raw parse and store validation errors on subscription reads", () => {
  mkdirSync(storeDir, { recursive: true });
  const path = join(storeDir, "subscriptions.json");
  writeFileSync(path, "{ not json");
  assert.throws(() => listWebPushSubscriptions(), SyntaxError);
  writeFileSync(path, '{"version":2,"subscriptions":[]}');
  assert.throws(() => listWebPushSubscriptions(), {
    message: "Stored Web Push subscriptions are malformed.",
  });
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
