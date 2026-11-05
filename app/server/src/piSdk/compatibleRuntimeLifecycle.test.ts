/**
 * An OpenAI-compatible account's endpoint edits reach the runtime a running
 * session or one-shot already holds, at the edit (`docs/workers.md`, "The
 * server's runtimes pair the compatible key with its origin"): a rotated key
 * is the next request's key, a cleared one is never sent again, a held model
 * of a replaced origin is refused unsent, and a deleted account's runtime
 * serves nothing. No model lookup runs between an edit and the request that
 * checks it.
 *
 * Real pi runtimes and requests (`runtime.complete`, as a one-shot runs) on
 * two fake endpoints on their own loopback origins; nothing else is reached.
 */
import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import {
  createCredentialProfile,
  credentialProfileById,
  deleteCredentialProfile,
  patchCredentialProfile,
  patchOpenAiCompatibleEndpoint,
  testOpenAiCompatibleProfile,
} from "../credentialProfiles.ts";
import {
  COMPAT_KEY_A,
  COMPAT_KEY_B,
  COMPAT_KEY_C,
  startFakeCompatEndpoint,
  type FakeCompatEndpoint,
} from "../test/gatewayFixtures.ts";
import { findModelForProfile, modelRuntimeForProfile } from "./models.ts";

let a: FakeCompatEndpoint;
let b: FakeCompatEndpoint;
const created: string[] = [];

beforeAll(async () => {
  a = await startFakeCompatEndpoint(["m"], "from A");
  b = await startFakeCompatEndpoint(["m"], "from B");
});

afterAll(async () => {
  await a.close();
  await b.close();
});

afterEach(() => {
  for (const id of created.splice(0))
    if (credentialProfileById(id)) deleteCredentialProfile(id);
});

/** A ready account on `endpoint`, its models discovered as Test does. */
async function account(
  endpoint: FakeCompatEndpoint,
  apiKey: string,
): Promise<string> {
  const { id } = createCredentialProfile({
    name: "Lifecycle",
    provider: "openai-compatible",
  });
  created.push(id);
  patchOpenAiCompatibleEndpoint(id, { baseUrl: endpoint.baseUrl, apiKey });
  const { status } = await testOpenAiCompatibleProfile(id);
  assert.equal(status.ok, true, status.message);
  return id;
}

/** What a running session or one-shot holds: its runtime and its model. */
async function held(id: string) {
  const model = await findModelForProfile(id, id, "m");
  assert.ok(model);
  const runtime = await modelRuntimeForProfile(id);
  return {
    model,
    request: () =>
      runtime.complete(model, {
        messages: [{ role: "user", content: "Say hello.", timestamp: 0 }],
      }),
  };
}

/** The chat requests `endpoint` has seen since `from`, by their key. */
function chats(endpoint: FakeCompatEndpoint, from: number): string[] {
  return endpoint.seen
    .slice(from)
    .filter((request) => request.method === "POST")
    .map((request) => request.authorization ?? "");
}

async function assertReaches(
  run: { request(): Promise<{ stopReason: string; errorMessage?: string }> },
  endpoint: FakeCompatEndpoint,
  authorization: string,
): Promise<void> {
  const from = endpoint.seen.length;
  const reply = await run.request();
  assert.equal(reply.stopReason, "stop", reply.errorMessage);
  assert.deepEqual(chats(endpoint, from), [authorization]);
}

async function assertRefusedUnsent(run: {
  request(): Promise<{ stopReason: string }>;
}): Promise<void> {
  const fromA = a.seen.length;
  const fromB = b.seen.length;
  const reply = await run.request();
  assert.equal(reply.stopReason, "error");
  assert.deepEqual(chats(a, fromA), [], "nothing reaches A");
  assert.deepEqual(chats(b, fromB), [], "nothing reaches B");
}

test("a held model sends a rotated key, never a cleared one, and keeps working through a rename and a disable", async () => {
  const id = await account(a, COMPAT_KEY_A);
  const other = await account(b, COMPAT_KEY_C);
  const run = await held(id);
  const beside = await held(other);
  await assertReaches(run, a, `Bearer ${COMPAT_KEY_A}`);

  patchOpenAiCompatibleEndpoint(id, { apiKey: COMPAT_KEY_B });
  await assertReaches(run, a, `Bearer ${COMPAT_KEY_B}`);

  patchOpenAiCompatibleEndpoint(id, { clearApiKey: true });
  // The key-less placeholder, as a new run would send.
  await assertReaches(run, a, "Bearer none");

  // Metadata changes keep the endpoint it runs on.
  patchOpenAiCompatibleEndpoint(id, { apiKey: COMPAT_KEY_A });
  patchCredentialProfile(id, { name: "Lifecycle renamed" });
  await assertReaches(run, a, `Bearer ${COMPAT_KEY_A}`);
  patchCredentialProfile(id, { enabled: false });
  await assertReaches(run, a, `Bearer ${COMPAT_KEY_A}`);

  // Another account's runtime never took any of it.
  await assertReaches(beside, b, `Bearer ${COMPAT_KEY_C}`);
});

test("a held model of a replaced origin is refused unsent, with or without a new key, and a fresh one reaches the new endpoint", async () => {
  const id = await account(a, COMPAT_KEY_A);
  const run = await held(id);
  await assertReaches(run, a, `Bearer ${COMPAT_KEY_A}`);

  // A new origin without a key drops the stored one, and its models.
  patchOpenAiCompatibleEndpoint(id, { baseUrl: b.baseUrl });
  await assertRefusedUnsent(run);

  patchOpenAiCompatibleEndpoint(id, { apiKey: COMPAT_KEY_B });
  await assertRefusedUnsent(run);
  // Discovery at the new origin registers its models; the held one stays A's.
  const { status } = await testOpenAiCompatibleProfile(id);
  assert.equal(status.ok, true, status.message);
  await assertRefusedUnsent(run);

  await assertReaches(await held(id), b, `Bearer ${COMPAT_KEY_B}`);
});

test("a new origin with its key in the same edit refuses the held model too", async () => {
  const id = await account(a, COMPAT_KEY_A);
  const run = await held(id);
  patchOpenAiCompatibleEndpoint(id, {
    baseUrl: b.baseUrl,
    apiKey: COMPAT_KEY_B,
  });
  await assertRefusedUnsent(run);
});

test("a deleted account's held runtime serves nothing", async () => {
  const id = await account(a, COMPAT_KEY_A);
  const run = await held(id);
  await assertReaches(run, a, `Bearer ${COMPAT_KEY_A}`);
  deleteCredentialProfile(id);
  await assertRefusedUnsent(run);
});

test("an edit landing while the account's runtime is created reaches it", async () => {
  const id = await account(a, COMPAT_KEY_A);
  const creating = modelRuntimeForProfile(id);
  patchOpenAiCompatibleEndpoint(id, { apiKey: COMPAT_KEY_B });
  const runtime = await creating;
  const model = await findModelForProfile(id, id, "m");
  assert.ok(model);
  assert.equal((await runtime.getAuth(model))?.auth.apiKey, COMPAT_KEY_B);

  // And an account deleted meanwhile registers nothing on it.
  const gone = await account(a, COMPAT_KEY_C);
  const pending = modelRuntimeForProfile(gone);
  deleteCredentialProfile(gone);
  const orphan = await pending;
  assert.equal(orphan.getRegisteredProviderConfig(gone), undefined);
});
