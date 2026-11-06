import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { afterAll, test } from "vitest";
import { PresenceCredentialStore } from "./presenceCredentialStore.ts";

const dir = mkdtempSync(join(tmpdir(), "presence-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Sentinels a copied field would carry into a read. */
const FIXTURE_ACCESS = "fixture-access-sentinel";
const FIXTURE_REFRESH = "fixture-refresh-sentinel";
const FIXTURE_ACCOUNT = "fixture-account-sentinel";
const FIXTURE_KEY = "fixture-key-sentinel";

let files = 0;
function authFile(content: unknown): string {
  const path = join(dir, `auth-${++files}.json`);
  writeFileSync(path, JSON.stringify(content));
  return path;
}

const EXPIRED = {
  "openai-codex": {
    type: "oauth",
    access: FIXTURE_ACCESS,
    refresh: FIXTURE_REFRESH,
    expires: 1,
    accountId: FIXTURE_ACCOUNT,
  },
  openrouter: { type: "api_key", key: FIXTURE_KEY },
};

test("AC1: an expired login reads as a placeholder that never expires, with no field copied", async () => {
  const store = new PresenceCredentialStore(authFile(EXPIRED));
  const oauth = await store.read("openai-codex");
  assert.deepEqual(oauth, {
    type: "oauth",
    access: "gateway-served",
    refresh: "gateway-served",
    expires: Number.MAX_SAFE_INTEGER,
  });
  const key = await store.read("openrouter");
  assert.deepEqual(key, { type: "api_key", key: "gateway-served" });
  assert.equal(await store.read("anthropic"), undefined);
  const serialized = JSON.stringify([oauth, key, await store.list()]);
  for (const sentinel of [
    FIXTURE_ACCESS,
    FIXTURE_REFRESH,
    FIXTURE_ACCOUNT,
    FIXTURE_KEY,
  ])
    assert.ok(!serialized.includes(sentinel), `no ${sentinel} in a read`);
  assert.deepEqual(await store.list(), [
    { providerId: "openai-codex", type: "oauth" },
    { providerId: "openrouter", type: "api_key" },
  ]);
});

test("AC1: a missing or unreadable file reads as empty and is never created", async () => {
  const missing = join(dir, "missing", "auth.json");
  const store = new PresenceCredentialStore(missing);
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.read("openai-codex"), undefined);
  assert.equal(existsSync(missing), false);
  const garbled = join(dir, "garbled.json");
  writeFileSync(garbled, "{not json");
  assert.deepEqual(await new PresenceCredentialStore(garbled).list(), []);
});

test("AC1: every write rejects and leaves the file's bytes alone", async () => {
  const path = authFile(EXPIRED);
  const before = readFileSync(path);
  const store: CredentialStore = new PresenceCredentialStore(path);
  await assert.rejects(
    store.modify("openai-codex", () =>
      Promise.resolve({ type: "api_key", key: "new" }),
    ),
  );
  await assert.rejects(store.delete("openai-codex"));
  assert.deepEqual(readFileSync(path), before);
});

test("AC1: a rewritten file is seen at the next read", async () => {
  const path = authFile({});
  const store = new PresenceCredentialStore(path);
  assert.equal(await store.read("openai-codex"), undefined);
  writeFileSync(path, JSON.stringify(EXPIRED));
  assert.equal((await store.read("openai-codex"))?.type, "oauth");
  writeFileSync(path, JSON.stringify({}));
  assert.equal(await store.read("openai-codex"), undefined);
});
