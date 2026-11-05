/**
 * Each OpenAI-compatible account's provider as leased engines follow it
 * (`compatProviderFeed.ts`, `docs/workers.md`; T1373 AC9): per profile, read
 * from the account's endpoint, and never with its key.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, test } from "vitest";
import {
  createCredentialProfile,
  DEFAULT_OPENAI_PROFILE_ID,
  deleteCredentialProfile,
  patchOpenAiCompatibleEndpoint,
} from "../credentialProfiles.ts";
import {
  openAiCompatibleEndpointPath,
  readOpenAiCompatibleEndpoint,
  writeOpenAiCompatibleEndpoint,
} from "../openAiCompatibleAccounts.ts";
import { COMPAT_KEY_A, COMPAT_KEY_B } from "../test/gatewayFixtures.ts";
import { compatProviderFeed } from "./compatProviderFeed.ts";

const created: string[] = [];

afterEach(() => {
  for (const id of created.splice(0)) deleteCredentialProfile(id);
});

/** A ready account at `baseUrl` with one model, `model`, and `apiKey` if given. */
function readyAccount(
  name: string,
  baseUrl: string,
  model: string,
  apiKey?: string,
): string {
  const { id } = createCredentialProfile({
    name,
    provider: "openai-compatible",
  });
  created.push(id);
  patchOpenAiCompatibleEndpoint(id, { baseUrl, ...(apiKey ? { apiKey } : {}) });
  writeOpenAiCompatibleEndpoint(id, {
    ...readOpenAiCompatibleEndpoint(id),
    models: [
      {
        id: model,
        name: model,
        input: ["text"],
        contextWindow: 1000,
        maxTokens: 100,
        reasoning: false,
      },
    ],
  });
  return id;
}

test("AC9: current(id) is that account's provider, without its key; a login profile, an unknown id or an unreadable endpoint is undefined", () => {
  const a = readyAccount("A", "http://compat-a.test/v1", "ma", COMPAT_KEY_A);
  const b = readyAccount("B", "http://compat-b.test/v1", "mb", COMPAT_KEY_B);
  const configA = compatProviderFeed.current(a);
  assert.ok(configA);
  assert.equal(configA.name, "A");
  assert.equal(configA.baseUrl, "http://compat-a.test/v1");
  assert.equal(configA.api, "openai-completions");
  assert.deepEqual(
    configA.models?.map((model) => model.id),
    ["ma"],
  );
  assert.equal("apiKey" in configA, false);
  const configB = compatProviderFeed.current(b);
  assert.equal(configB?.baseUrl, "http://compat-b.test/v1");
  assert.notDeepEqual(configB, configA);
  for (const config of [configA, configB]) {
    const text = JSON.stringify(config);
    assert.ok(!text.includes("apiKey"));
    assert.ok(!text.includes(COMPAT_KEY_A) && !text.includes(COMPAT_KEY_B));
  }
  // Keyless: the placeholder stays with the push, never in the feed.
  const keyless = readyAccount("Keyless", "http://compat-c.test/v1", "mc");
  assert.ok(
    !JSON.stringify(compatProviderFeed.current(keyless)).includes("apiKey"),
  );

  assert.equal(
    compatProviderFeed.current(DEFAULT_OPENAI_PROFILE_ID),
    undefined,
  );
  assert.equal(
    compatProviderFeed.current("openai-compatible-zzzzzzzzzzzz"),
    undefined,
  );

  const file = openAiCompatibleEndpointPath(b);
  rmSync(file);
  mkdirSync(file);
  assert.throws(() => readOpenAiCompatibleEndpoint(b));
  assert.equal(compatProviderFeed.current(b), undefined);
  rmSync(file, { recursive: true });
});

test("AC9: subscribe(id) hears that account's changes and not another's", () => {
  const a = readyAccount("A", "http://compat-a.test/v1", "ma", COMPAT_KEY_A);
  const b = readyAccount("B", "http://compat-b.test/v1", "mb", COMPAT_KEY_B);
  const heard: string[] = [];
  const unsubscribe = compatProviderFeed.subscribe(a, () => heard.push("a"));
  patchOpenAiCompatibleEndpoint(b, { apiKey: COMPAT_KEY_A });
  assert.deepEqual(heard, []);
  patchOpenAiCompatibleEndpoint(a, { apiKey: COMPAT_KEY_B });
  assert.deepEqual(heard, ["a"]);
  unsubscribe();
  patchOpenAiCompatibleEndpoint(a, { apiKey: COMPAT_KEY_A });
  assert.deepEqual(heard, ["a"]);
});
