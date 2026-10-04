import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@assistant/shared";
import { toModelOption } from "./piSdk/models.ts";
import {
  getOpenAiCompatibleProviderConfigForRegistry,
  getOpenAiCompatibleSettings,
  testOpenAiCompatibleSettings,
  updateOpenAiCompatibleSettings,
} from "./openAiCompatibleSettings.ts";

const originalFetch = globalThis.fetch;
/** An obviously fake key: only its presence and redaction are under test. */
const FAKE_API_KEY = "fake-api-key";

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

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  updateOpenAiCompatibleSettings({
    enabled: false,
    name: "",
    baseUrl: "",
    thinkingFormat: "none",
    clearApiKey: true,
  });
});

test("starts generic: default name, no endpoint, no thinking control", () => {
  const settings = getOpenAiCompatibleSettings();
  assert.equal(settings.name, "OpenAI-compatible");
  assert.equal(settings.baseUrl, "");
  assert.equal(settings.thinkingFormat, "none");
  assert.equal(getOpenAiCompatibleProviderConfigForRegistry(), undefined);
});

test("persists name, trimmed base URL and a known thinking format; hides the key", () => {
  const settings = updateOpenAiCompatibleSettings({
    enabled: true,
    name: "  Team LLM ",
    baseUrl: "https://llm.example.net/v1/",
    thinkingFormat: "qwen-chat-template",
    apiKey: FAKE_API_KEY,
  });
  assert.equal(settings.name, "Team LLM");
  assert.equal(settings.baseUrl, "https://llm.example.net/v1");
  assert.equal(settings.thinkingFormat, "qwen-chat-template");
  assert.equal(settings.apiKeyConfigured, true);
  assert.doesNotMatch(JSON.stringify(settings), new RegExp(FAKE_API_KEY));

  const unknown = updateOpenAiCompatibleSettings({
    thinkingFormat: "not-a-format" as never,
  });
  assert.equal(unknown.thinkingFormat, "none");
});

test("discovers models and registers them with the chosen thinking format", async () => {
  const calls = serveModels();
  updateOpenAiCompatibleSettings({
    enabled: true,
    name: "Team LLM",
    baseUrl: "https://llm.example.net/v1",
    thinkingFormat: "qwen-chat-template",
    apiKey: FAKE_API_KEY,
  });

  const status = await testOpenAiCompatibleSettings();
  assert.equal(status.ok, true);
  assert.equal(status.message, "Discovered 2 Team LLM models.");
  assert.equal(calls[0]?.url, "https://llm.example.net/v1/models");
  assert.deepEqual(calls[0]?.init?.headers, {
    Authorization: `Bearer ${FAKE_API_KEY}`,
  });

  const config = getOpenAiCompatibleProviderConfigForRegistry();
  assert.ok(config);
  assert.equal(config.name, "Team LLM");
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

test("without thinking control no model reasons and no format is sent", async () => {
  serveModels();
  updateOpenAiCompatibleSettings({
    enabled: true,
    baseUrl: "https://llm.example.net/v1",
    thinkingFormat: "qwen-chat-template",
  });
  await testOpenAiCompatibleSettings();

  // Switching the format re-derives reasoning without rediscovery.
  updateOpenAiCompatibleSettings({ thinkingFormat: "none" });
  const config = getOpenAiCompatibleProviderConfigForRegistry();
  assert.ok(config);
  assert.equal(config.compat.thinkingFormat, undefined);
  assert.equal(config.compat.supportsReasoningEffort, false);
  assert.ok(config.models.every((model) => !model.reasoning));
  assert.ok(getOpenAiCompatibleSettings().models.every((m) => !m.reasoning));
});

test("reasoning_effort is claimed only by the openai format", async () => {
  serveModels();
  updateOpenAiCompatibleSettings({
    enabled: true,
    baseUrl: "https://llm.example.net/v1",
    thinkingFormat: "openai",
  });
  await testOpenAiCompatibleSettings();
  assert.equal(
    getOpenAiCompatibleProviderConfigForRegistry()?.compat
      .supportsReasoningEffort,
    true,
  );
});

test("a keyless endpoint is discovered without Authorization and registered", async () => {
  const calls = serveModels();
  updateOpenAiCompatibleSettings({
    enabled: true,
    baseUrl: "http://127.0.0.1:8080/v1",
  });
  const status = await testOpenAiCompatibleSettings();
  assert.equal(status.ok, true);
  assert.equal(calls[0]?.init?.headers, undefined);
  assert.equal(getOpenAiCompatibleProviderConfigForRegistry()?.apiKey, "none");
});

test("reports a missing base URL instead of calling out", async () => {
  const calls = serveModels();
  updateOpenAiCompatibleSettings({ enabled: true });
  const status = await testOpenAiCompatibleSettings();
  assert.equal(status.ok, false);
  assert.equal(status.message, "A base URL is required.");
  assert.equal(calls.length, 0);
});

test("a new endpoint drops the old endpoint's models, even when discovery fails", async () => {
  serveModels();
  updateOpenAiCompatibleSettings({
    enabled: true,
    baseUrl: "https://llm.example.net/v1",
  });
  await testOpenAiCompatibleSettings();
  // Saving the same endpoint (trailing slash normalizes away) keeps them.
  updateOpenAiCompatibleSettings({ baseUrl: "https://llm.example.net/v1/" });
  assert.equal(getOpenAiCompatibleSettings().models.length, 2);

  globalThis.fetch = vi.fn(async () => {
    throw new Error("connect ECONNREFUSED");
  }) as typeof fetch;
  updateOpenAiCompatibleSettings({ baseUrl: "https://other.example.net/v1" });
  const status = await testOpenAiCompatibleSettings();
  assert.equal(status.ok, false);
  assert.match(status.message, /Model discovery failed: .*ECONNREFUSED/);
  assert.deepEqual(status.models, []);
  assert.equal(getOpenAiCompatibleProviderConfigForRegistry(), undefined);
});

test("the picker model carries the endpoint's display name", () => {
  updateOpenAiCompatibleSettings({ name: "Team LLM" });
  const option = toModelOption({
    id: "qwen3-32b",
    name: "qwen3-32b",
    provider: OPENAI_COMPATIBLE_PROVIDER_ID,
    reasoning: true,
    contextWindow: 32_768,
  } as Parameters<typeof toModelOption>[0]);
  assert.equal(option.providerName, "Team LLM");
  const other = toModelOption({
    id: "gpt-x",
    name: "gpt-x",
    provider: "openai",
    reasoning: false,
    contextWindow: 1000,
  } as Parameters<typeof toModelOption>[0]);
  assert.equal("providerName" in other, false);
});

test("a discovery failure never echoes the key or URL credentials", async () => {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(`{"error":"bad token Bearer ${FAKE_API_KEY}"}`, {
        status: 401,
      }),
  ) as typeof fetch;
  updateOpenAiCompatibleSettings({
    enabled: true,
    baseUrl: "https://fixture-user:fixture-password@llm.example.net/v1",
    apiKey: FAKE_API_KEY,
  });
  const status = await testOpenAiCompatibleSettings();
  assert.equal(status.ok, false);
  assert.match(status.message, /HTTP 401/);
  assert.match(status.message, /\[redacted\]/);
  for (const secret of [FAKE_API_KEY, "fixture-user", "fixture-password"])
    assert.equal(status.message.includes(secret), false, secret);
});

test("a model list passes the display name in instead of re-reading it", () => {
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
});

test("the API key stays with the origin it was entered for", () => {
  updateOpenAiCompatibleSettings({
    enabled: true,
    baseUrl: "https://llm.example.net/v1",
    apiKey: FAKE_API_KEY,
  });
  let settings = updateOpenAiCompatibleSettings({
    baseUrl: "https://llm.example.net/v2",
  });
  assert.equal(settings.apiKeyConfigured, true);
  settings = updateOpenAiCompatibleSettings({
    baseUrl: "https://evil.test/v1",
  });
  assert.equal(settings.apiKeyConfigured, false);
  settings = updateOpenAiCompatibleSettings({
    baseUrl: "https://llm.example.net/v1",
    apiKey: FAKE_API_KEY,
  });
  assert.equal(settings.apiKeyConfigured, true);
});
