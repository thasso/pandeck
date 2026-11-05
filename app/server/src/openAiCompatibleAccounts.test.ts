/**
 * OpenAI-compatible accounts (`docs/settings.md`): each holds its own endpoint
 * in `credential-profiles/<id>/endpoint.json`, 0600, and no summary ever
 * carries the key.
 */
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { afterEach, test, vi } from "vitest";
import {
  ACCOUNT_KINDS,
  isOpenAiCompatibleModelProvider,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "@assistant/shared";
import {
  createCredentialProfile,
  credentialProfileHasCredential,
  deleteCredentialProfile,
  listCredentialProfiles,
  patchOpenAiCompatibleEndpoint,
  testOpenAiCompatibleProfile,
} from "./credentialProfiles.ts";
import {
  OPENAI_COMPATIBLE_KEYLESS,
  openAiCompatibleEndpointPath,
  openAiCompatibleProviderConfig,
  readOpenAiCompatibleEndpoint,
} from "./openAiCompatibleAccounts.ts";
import { toModelOption } from "./piSdk/models.ts";

const originalFetch = globalThis.fetch;
/** An obviously fake key: only its presence and redaction are under test. */
const FAKE_API_KEY = "fake-api-key";
const created: string[] = [];

/** Answer `/models` with two llama.cpp-style entries and record each request. */
function serveModels(): Array<{ url: string; init?: RequestInit }> {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    return new Response(
      JSON.stringify({
        data: [
          { id: "qwen3-32b", owned_by: "llamacpp", meta: { n_ctx: 32_768 } },
          {
            id: "vision-7b",
            architecture: { input_modalities: ["text", "image"] },
          },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return calls;
}

function newAccount(name = "Team LLM"): string {
  const { id } = createCredentialProfile({
    name,
    provider: "openai-compatible",
  });
  created.push(id);
  return id;
}

function summaryOf(id: string) {
  const summary = listCredentialProfiles().find((p) => p.id === id);
  assert.ok(summary);
  return summary;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  for (const id of created.splice(0)) deleteCredentialProfile(id);
});

test("every new compatible account gets its own id in the provider grammar", () => {
  const first = newAccount("First");
  const second = newAccount("Second");
  assert.notEqual(first, second);
  for (const id of [first, second]) {
    assert.match(id, /^openai-compatible-[0-9a-f]{12}$/);
    assert.equal(isOpenAiCompatibleModelProvider(id), true);
    assert.notEqual(id, OPENAI_COMPATIBLE_PROVIDER_ID);
  }
  // A login account never gets an id in that grammar.
  const login = createCredentialProfile({
    name: "Login",
    provider: "openai-codex",
  });
  created.push(login.id);
  assert.equal(isOpenAiCompatibleModelProvider(login.id), false);
});

test("a new account is disconnected, with a constant health and an empty endpoint", () => {
  const id = newAccount();
  const summary = summaryOf(id);
  assert.equal(summary.provider, "openai-compatible");
  assert.equal(summary.status, "disconnected");
  assert.deepEqual(summary.health, { state: "unknown", since: null });
  assert.deepEqual(summary.endpoint, {
    baseUrl: "",
    apiKeyConfigured: false,
    thinkingFormat: "none",
    models: [],
  });
  assert.equal(credentialProfileHasCredential(id), false);
  assert.equal(ACCOUNT_KINDS[summary.provider].subscription, false);
});

test("the endpoint is stored 0600 in the account's directory; no summary carries the key", () => {
  const id = newAccount();
  const summary = patchOpenAiCompatibleEndpoint(id, {
    baseUrl: "https://llm.example.net/v1/",
    thinkingFormat: "qwen-chat-template",
    apiKey: FAKE_API_KEY,
  });
  const path = openAiCompatibleEndpointPath(id);
  assert.match(path, new RegExp(`credential-profiles/${id}/endpoint\\.json$`));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.match(readFileSync(path, "utf8"), new RegExp(FAKE_API_KEY));
  assert.equal(summary.endpoint?.baseUrl, "https://llm.example.net/v1");
  assert.equal(summary.endpoint?.apiKeyConfigured, true);
  for (const projection of [summary, summaryOf(id), listCredentialProfiles()])
    assert.doesNotMatch(JSON.stringify(projection), new RegExp(FAKE_API_KEY));
});

test("an endpoint edit is validated as a whole before it is written", () => {
  const id = newAccount();
  assert.throws(
    () =>
      patchOpenAiCompatibleEndpoint(id, {
        baseUrl: "https://llm.example.net/v1",
        thinkingFormat: "not-a-format",
      }),
    /Unknown thinking format/,
  );
  assert.equal(readOpenAiCompatibleEndpoint(id).baseUrl, "");
  assert.throws(() => patchOpenAiCompatibleEndpoint(id, {}), /is required/);
  const login = createCredentialProfile({ name: "L", provider: "claude" });
  created.push(login.id);
  assert.throws(
    () => patchOpenAiCompatibleEndpoint(login.id, { baseUrl: "https://x" }),
    /has no endpoint/,
  );
});

test("Test discovers the account's models and makes it ready", async () => {
  const calls = serveModels();
  const id = newAccount();
  patchOpenAiCompatibleEndpoint(id, {
    baseUrl: "https://llm.example.net/v1",
    thinkingFormat: "qwen-chat-template",
    apiKey: FAKE_API_KEY,
  });
  const { status, profile } = await testOpenAiCompatibleProfile(id);
  assert.equal(status.ok, true);
  assert.equal(status.message, "Discovered 2 models.");
  assert.equal(calls[0]?.url, "https://llm.example.net/v1/models");
  assert.deepEqual(calls[0]?.init?.headers, {
    Authorization: `Bearer ${FAKE_API_KEY}`,
  });
  assert.equal(profile.status, "ready");
  assert.equal(credentialProfileHasCredential(id), true);
  assert.doesNotMatch(JSON.stringify(profile), new RegExp(FAKE_API_KEY));

  const config = openAiCompatibleProviderConfig(
    readOpenAiCompatibleEndpoint(id),
    "Team LLM",
  );
  assert.ok(config);
  assert.equal(config.apiKey, FAKE_API_KEY);
  assert.deepEqual(config.compat, {
    thinkingFormat: "qwen-chat-template",
    supportsReasoningEffort: false,
    maxTokensField: "max_tokens",
  });
  assert.deepEqual(
    config.models.map((model) => [model.id, model.reasoning, model.input]),
    [
      ["qwen3-32b", true, ["text"]],
      ["vision-7b", true, ["text", "image"]],
    ],
  );
  assert.equal(config.models[0]?.contextWindow, 32_768);
  // registerProvider applies compat per model only.
  assert.deepEqual(config.models[0]?.compat, config.compat);
});

test("two accounts keep separate endpoints and models", async () => {
  serveModels();
  const a = newAccount("A");
  const b = newAccount("B");
  patchOpenAiCompatibleEndpoint(a, { baseUrl: "https://a.example.net/v1" });
  patchOpenAiCompatibleEndpoint(b, { baseUrl: "https://b.example.net/v1" });
  await testOpenAiCompatibleProfile(a);
  assert.equal(readOpenAiCompatibleEndpoint(a).models.length, 2);
  assert.equal(readOpenAiCompatibleEndpoint(b).models.length, 0);
  assert.equal(summaryOf(b).status, "disconnected");
});

test("without thinking control no model reasons and no format is sent", async () => {
  serveModels();
  const id = newAccount();
  patchOpenAiCompatibleEndpoint(id, {
    baseUrl: "https://llm.example.net/v1",
    thinkingFormat: "qwen-chat-template",
  });
  await testOpenAiCompatibleProfile(id);
  // Switching the format re-derives reasoning without rediscovery.
  patchOpenAiCompatibleEndpoint(id, { thinkingFormat: "none" });
  const endpoint = readOpenAiCompatibleEndpoint(id);
  const config = openAiCompatibleProviderConfig(endpoint, "x");
  assert.ok(config);
  assert.equal(config.compat.thinkingFormat, undefined);
  assert.equal(config.compat.supportsReasoningEffort, false);
  assert.ok(config.models.every((model) => !model.reasoning));
  assert.ok(endpoint.models.every((model) => !model.reasoning));
});

test("reasoning_effort is claimed only by the openai format", async () => {
  serveModels();
  const id = newAccount();
  patchOpenAiCompatibleEndpoint(id, {
    baseUrl: "https://llm.example.net/v1",
    thinkingFormat: "openai",
  });
  await testOpenAiCompatibleProfile(id);
  assert.equal(
    openAiCompatibleProviderConfig(readOpenAiCompatibleEndpoint(id), "x")
      ?.compat.supportsReasoningEffort,
    true,
  );
});

test("a keyless endpoint is discovered without Authorization and registered", async () => {
  const calls = serveModels();
  const id = newAccount();
  patchOpenAiCompatibleEndpoint(id, { baseUrl: "http://127.0.0.1:8080/v1" });
  const { status } = await testOpenAiCompatibleProfile(id);
  assert.equal(status.ok, true);
  assert.equal(calls[0]?.init?.headers, undefined);
  assert.equal(
    openAiCompatibleProviderConfig(readOpenAiCompatibleEndpoint(id), "x")
      ?.apiKey,
    OPENAI_COMPATIBLE_KEYLESS,
  );
  // The value the server runtimes' guard reads as "no credential paired".
  assert.equal(OPENAI_COMPATIBLE_KEYLESS, "none");
});

test("reports a missing base URL instead of calling out", async () => {
  const calls = serveModels();
  const id = newAccount();
  const { status } = await testOpenAiCompatibleProfile(id);
  assert.equal(status.ok, false);
  assert.equal(status.message, "A base URL is required.");
  assert.equal(calls.length, 0);
});

test("a new endpoint drops the old endpoint's models; a new origin drops the key", async () => {
  serveModels();
  const id = newAccount();
  patchOpenAiCompatibleEndpoint(id, {
    baseUrl: "https://llm.example.net/v1",
    apiKey: FAKE_API_KEY,
  });
  await testOpenAiCompatibleProfile(id);
  // Saving the same endpoint (trailing slash normalizes away) keeps them.
  patchOpenAiCompatibleEndpoint(id, { baseUrl: "https://llm.example.net/v1/" });
  assert.equal(readOpenAiCompatibleEndpoint(id).models.length, 2);
  // Another path on the same origin keeps the key, not the models.
  patchOpenAiCompatibleEndpoint(id, { baseUrl: "https://llm.example.net/v2" });
  assert.equal(readOpenAiCompatibleEndpoint(id).models.length, 0);
  assert.equal(readOpenAiCompatibleEndpoint(id).apiKey, FAKE_API_KEY);

  globalThis.fetch = vi.fn(async () => {
    throw new Error("connect ECONNREFUSED");
  }) as typeof fetch;
  const summary = patchOpenAiCompatibleEndpoint(id, {
    baseUrl: "https://other.example.net/v1",
  });
  assert.equal(summary.endpoint?.apiKeyConfigured, false);
  const { status, profile } = await testOpenAiCompatibleProfile(id);
  assert.equal(status.ok, false);
  assert.match(status.message, /Model discovery failed: .*ECONNREFUSED/);
  assert.deepEqual(status.models, []);
  assert.equal(profile.status, "disconnected");
});

test("discovery that outlives an edit stores nothing", async () => {
  const id = newAccount();
  patchOpenAiCompatibleEndpoint(id, { baseUrl: "https://llm.example.net/v1" });
  let answer!: () => void;
  globalThis.fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        answer = () =>
          resolve(
            new Response(JSON.stringify({ data: [{ id: "m" }] }), {
              status: 200,
            }),
          );
      }),
  ) as typeof fetch;
  const pending = testOpenAiCompatibleProfile(id);
  await vi.waitFor(() => assert.ok(answer));
  patchOpenAiCompatibleEndpoint(id, { apiKey: FAKE_API_KEY });
  answer();
  const { status } = await pending;
  assert.equal(status.ok, false);
  assert.match(status.message, /changed during discovery/);
  assert.equal(readOpenAiCompatibleEndpoint(id).models.length, 0);
  assert.equal(readOpenAiCompatibleEndpoint(id).apiKey, FAKE_API_KEY);
});

test("a cancelled Test stores nothing", async () => {
  serveModels();
  const id = newAccount();
  patchOpenAiCompatibleEndpoint(id, { baseUrl: "https://llm.example.net/v1" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(testOpenAiCompatibleProfile(id, controller.signal));
  assert.equal(readOpenAiCompatibleEndpoint(id).models.length, 0);
});

test("a discovery failure never echoes the key or URL credentials", async () => {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(`{"error":"bad token Bearer ${FAKE_API_KEY}"}`, {
        status: 401,
      }),
  ) as typeof fetch;
  const id = newAccount();
  patchOpenAiCompatibleEndpoint(id, {
    baseUrl: "https://fixture-user:fixture-password@llm.example.net/v1",
    apiKey: FAKE_API_KEY,
  });
  const { status } = await testOpenAiCompatibleProfile(id);
  assert.equal(status.ok, false);
  assert.match(status.message, /HTTP 401/);
  assert.match(status.message, /\[redacted\]/);
  for (const secret of [FAKE_API_KEY, "fixture-user", "fixture-password"])
    assert.equal(status.message.includes(secret), false, secret);
});

test("deleting an account removes its endpoint file", () => {
  const id = newAccount();
  patchOpenAiCompatibleEndpoint(id, { baseUrl: "https://llm.example.net/v1" });
  const path = openAiCompatibleEndpointPath(id);
  deleteCredentialProfile(created.splice(created.indexOf(id), 1)[0]!);
  assert.throws(() => statSync(path), { code: "ENOENT" });
});

test("a model option carries the name it is given", () => {
  const option = toModelOption(
    {
      id: "qwen3-32b",
      name: "qwen3-32b",
      provider: OPENAI_COMPATIBLE_PROVIDER_ID,
      reasoning: true,
      contextWindow: 32_768,
    } as Parameters<typeof toModelOption>[0],
    "Passed Name",
  );
  assert.equal(option.providerName, "Passed Name");
  const other = toModelOption({
    id: "gpt-x",
    name: "gpt-x",
    provider: "openai",
    reasoning: false,
    contextWindow: 1000,
  } as Parameters<typeof toModelOption>[0]);
  assert.equal("providerName" in other, false);
});
