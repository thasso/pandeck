/**
 * The account model gate (`docs/agent-harnesses.md`): every per-account model
 * lookup answers only models that account serves, whatever its runtime holds.
 * Real pi runtimes, no network: pi's built-in providers sit in every runtime,
 * and an environment key makes one of them available everywhere.
 *
 * The first test is the boot: loading `models.ts` migrates the former single
 * endpoint and normalizes stored pins before any runtime exists.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_HELPER_MODEL } from "@assistant/shared";
import { afterAll, beforeAll, test } from "vitest";
import {
  APP_SETTINGS_PATH,
  readStoredAppSettings,
} from "../appSettingsFile.ts";
import {
  createCredentialProfile,
  credentialProfileById,
  deleteCredentialProfile,
  LEGACY_OPENAI_COMPATIBLE_SETTINGS_PATH,
  patchCredentialProfile,
  patchOpenAiCompatibleEndpoint,
  piAgentDir,
} from "../credentialProfiles.ts";
import {
  readOpenAiCompatibleEndpoint,
  writeOpenAiCompatibleEndpoint,
} from "../openAiCompatibleAccounts.ts";

/** Synthetic: never sent anywhere, only shows a built-in provider as available. */
const ENV_KEY = "fixture-env-openai-key";
const MIGRATED = "openai-compatible";
const savedEnvKey = process.env.OPENAI_API_KEY;

function endpointModels(...ids: string[]) {
  return ids.map((id) => ({
    id,
    name: id,
    input: ["text" as const],
    contextWindow: 32_768,
    maxTokens: 4096,
    reasoning: false,
  }));
}

let models: typeof import("./models.ts");
let second: string;

beforeAll(async () => {
  process.env.OPENAI_API_KEY = ENV_KEY;
  mkdirSync(dirname(LEGACY_OPENAI_COMPATIBLE_SETTINGS_PATH), {
    recursive: true,
  });
  writeFileSync(
    LEGACY_OPENAI_COMPATIBLE_SETTINGS_PATH,
    JSON.stringify({
      enabled: true,
      name: "Migrated LLM",
      baseUrl: "https://migrated.example.invalid/v1",
      models: endpointModels("qwen3-32b"),
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    APP_SETTINGS_PATH,
    JSON.stringify({
      naming: {
        provider: MIGRATED,
        modelId: "qwen3-32b",
        credentialProfileId: "default",
      },
    }),
  );
  models = await import("./models.ts");
  second = createCredentialProfile({
    name: "Second LLM",
    provider: "openai-compatible",
  }).id;
  patchOpenAiCompatibleEndpoint(second, {
    baseUrl: "https://second.example.invalid/v1",
  });
  writeOpenAiCompatibleEndpoint(second, {
    ...readOpenAiCompatibleEndpoint(second),
    models: endpointModels("llama-8b"),
  });
});

afterAll(() => {
  if (savedEnvKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedEnvKey;
});

test("loading the models migrates the endpoint and normalizes pins first", () => {
  assert.equal(credentialProfileById(MIGRATED)?.name, "Migrated LLM");
  assert.equal(existsSync(LEGACY_OPENAI_COMPATIBLE_SETTINGS_PATH), false);
  assert.ok(
    models
      .listModels()
      .some((model) => model.provider === MIGRATED && model.id === "qwen3-32b"),
  );
  const stored = readStoredAppSettings() as Record<string, unknown>;
  assert.deepEqual(stored.naming, {
    provider: MIGRATED,
    modelId: "qwen3-32b",
    credentialProfileId: MIGRATED,
  });
});

test("a compatible account lists only its own models, even with a built-in available", async () => {
  // The env key makes pi's `openai` provider available in every runtime.
  const builtIn = await models.availableModelsForProfile("default");
  assert.ok(builtIn.some((model) => model.provider === "openai"));
  assert.ok(builtIn.every((model) => !model.provider.startsWith(MIGRATED)));

  for (const [account, ids] of [
    [MIGRATED, ["qwen3-32b"]],
    [second, ["llama-8b"]],
  ] as const) {
    const listed = await models.listModelsForProfile(account);
    assert.deepEqual(
      listed.map((model) => `${model.provider}/${model.id}`),
      ids.map((id) => `${account}/${id}`),
    );
    const available = await models.availableModelsForProfile(account);
    assert.deepEqual(
      available.map((model) => model.id),
      [...ids],
    );
  }
});

test("a lookup answers only a model the account serves", async () => {
  const own = await models.findModelForProfile(MIGRATED, MIGRATED, "qwen3-32b");
  assert.equal(own?.baseUrl, "https://migrated.example.invalid/v1");
  assert.equal(
    await models.findModelForProfile(
      MIGRATED,
      DEFAULT_HELPER_MODEL.provider,
      DEFAULT_HELPER_MODEL.modelId,
    ),
    undefined,
  );
  assert.equal("modelRegistryForProfile" in models, false);
  assert.equal(existsSync(join(piAgentDir(MIGRATED), "auth.json")), false);
  // Never a built-in, another compatible account's model, or the reverse.
  assert.equal(
    await models.findModelForProfile(MIGRATED, "openai", "gpt-4o-mini"),
    undefined,
  );
  assert.equal(
    await models.findModelForProfile(MIGRATED, second, "llama-8b"),
    undefined,
  );
  assert.equal(
    await models.findModelForProfile("default", MIGRATED, "qwen3-32b"),
    undefined,
  );
  assert.equal(
    await models.findModelForProfile(
      "claude-default",
      "openai-codex",
      "gpt-5.4",
    ),
    undefined,
  );
});

test("an endpoint edit reaches the account's runtime on the next lookup", async () => {
  patchOpenAiCompatibleEndpoint(second, {
    baseUrl: "https://moved.example.invalid/v1",
  });
  assert.equal(
    await models.findModelForProfile(second, second, "llama-8b"),
    undefined,
  );
  writeOpenAiCompatibleEndpoint(second, {
    ...readOpenAiCompatibleEndpoint(second),
    models: endpointModels("llama-8b"),
  });
  const found = await models.findModelForProfile(second, second, "llama-8b");
  assert.equal(found?.baseUrl, "https://moved.example.invalid/v1");
});

test("the pickers list every enabled compatible account under its name", () => {
  const listed = models
    .listModels()
    .filter((model) => model.provider.startsWith(MIGRATED));
  assert.deepEqual(
    listed.map((model) => [model.provider, model.id, model.providerName]),
    [
      [MIGRATED, "qwen3-32b", "Migrated LLM"],
      [second, "llama-8b", "Second LLM"],
    ],
  );
  patchCredentialProfile(second, { enabled: false });
  assert.deepEqual(
    models
      .listModels()
      .filter((model) => model.provider.startsWith(MIGRATED))
      .map((model) => model.provider),
    [MIGRATED],
  );
  patchCredentialProfile(second, { enabled: true });
  // A display lookup finds a compatible model without any key.
  assert.equal(models.findModel(second, "llama-8b")?.id, "llama-8b");
});

test("a one-shot's fallback stays on the account it runs on", async () => {
  const { selectPiModelWithFallback } = await import("./oneShot.ts");
  // A configured model of another account, or none the account offers, falls
  // back to the account's own model: never the built-in the env key opens.
  for (const configured of [
    { provider: "openai", modelId: "gpt-4o-mini" },
    { provider: MIGRATED, modelId: "qwen3-32b" },
    { provider: second, modelId: "gone" },
  ]) {
    const picked = await selectPiModelWithFallback(configured, second);
    assert.equal(`${picked?.provider}/${picked?.id}`, `${second}/llama-8b`);
  }
  const empty = createCredentialProfile({
    name: "Empty helper endpoint",
    provider: "openai-compatible",
  });
  assert.equal(
    await selectPiModelWithFallback(
      { provider: empty.id, modelId: "retired" },
      empty.id,
    ),
    undefined,
  );
  assert.equal(existsSync(join(piAgentDir(empty.id), "auth.json")), false);
  deleteCredentialProfile(empty.id);
  // And an OpenAI account's fallback never reaches a compatible model.
  const fallback = await selectPiModelWithFallback(
    { provider: MIGRATED, modelId: "qwen3-32b" },
    "default",
  );
  assert.ok(fallback);
  assert.ok(!fallback.provider.startsWith(MIGRATED));
});

test("a deleted account serves nothing", async () => {
  deleteCredentialProfile(second);
  assert.equal(models.findModel(second, "llama-8b"), undefined);
  assert.ok(models.listModels().every((model) => model.provider !== second));
});
