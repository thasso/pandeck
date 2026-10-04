import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { runClaudeSdkOneShot } from "../claudeSdk/oneShot.ts";
import { sessionStore } from "../db/sessionStore.ts";
import { findModelForProfile } from "../piSdk/models.ts";
import { runPiOneShot, selectPiModelWithFallback } from "../piSdk/oneShot.ts";
import {
  NoHelperModelError,
  OneShotError,
  runOneShot,
  type OneShotRequest,
} from "./oneShot.ts";

vi.mock("../claudeSdk/oneShot.ts", () => ({ runClaudeSdkOneShot: vi.fn() }));
vi.mock("../piSdk/oneShot.ts", () => ({
  runPiOneShot: vi.fn(),
  selectPiModelWithFallback: vi.fn(),
}));
vi.mock("../piSdk/models.ts", () => ({ findModelForProfile: vi.fn() }));
vi.mock("../db/sessionStore.ts", () => ({
  sessionStore: { createInternalUsageSession: vi.fn() },
}));

const piModel = { id: "fallback-model", provider: "openai-codex" };

function request(overrides: Partial<OneShotRequest> = {}): OneShotRequest {
  return {
    model: { provider: "openai-codex", modelId: "gpt-test" },
    thinkingLevel: "low",
    credentialProfileId: "profile-1",
    noModelMessage: "No model for this helper.",
    systemPrompt: "system",
    prompt: "prompt",
    timeoutMs: 1_000,
    timeoutMessage: "Timed out.",
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(selectPiModelWithFallback).mockResolvedValue(piModel as never);
});

test("a Claude model runs on the Claude engine with its usage normalized", async () => {
  vi.mocked(runClaudeSdkOneShot).mockResolvedValue({
    text: "hello",
    usage: { inputTokens: 3, outputTokens: 2, cacheWriteTokens: 5 },
  });

  const result = await runOneShot(
    request({
      model: { provider: "claude-sdk", modelId: "sonnet" },
      tools: [],
      maxTurns: 4,
    }),
  );

  assert.deepEqual(result, {
    text: "hello",
    usage: { inputTokens: 3, outputTokens: 2, cacheCreationTokens: 5 },
  });
  const call = vi.mocked(runClaudeSdkOneShot).mock.calls[0]?.[0];
  assert.equal(call?.modelId, "sonnet");
  assert.equal(call?.credentialProfileId, "profile-1");
  assert.equal(call?.maxTurns, 4);
  assert.equal(vi.mocked(runPiOneShot).mock.calls.length, 0);
});

test("any other model runs on pi through the helper fallback", async () => {
  vi.mocked(runPiOneShot).mockResolvedValue({
    text: "hi",
    usage: { inputTokens: 1 },
  });

  const result = await runOneShot(request());

  assert.deepEqual(result, { text: "hi", usage: { inputTokens: 1 } });
  assert.deepEqual(vi.mocked(selectPiModelWithFallback).mock.calls[0], [
    { provider: "openai-codex", modelId: "gpt-test" },
    "profile-1",
  ]);
  assert.equal(vi.mocked(runPiOneShot).mock.calls[0]?.[0].model, piModel);
});

test("modelFallback none requires the exact model", async () => {
  vi.mocked(findModelForProfile).mockResolvedValue(undefined);

  await assert.rejects(
    () => runOneShot(request({ modelFallback: "none" })),
    (err: unknown) =>
      err instanceof NoHelperModelError &&
      err.message === "No model for this helper.",
  );
  assert.deepEqual(vi.mocked(findModelForProfile).mock.calls[0], [
    "profile-1",
    "openai-codex",
    "gpt-test",
  ]);
  assert.equal(vi.mocked(selectPiModelWithFallback).mock.calls.length, 0);
  assert.equal(vi.mocked(runPiOneShot).mock.calls.length, 0);
});

test("an account with no usable pi model refuses", async () => {
  vi.mocked(selectPiModelWithFallback).mockResolvedValue(undefined);

  await assert.rejects(() => runOneShot(request()), NoHelperModelError);
  assert.equal(vi.mocked(runPiOneShot).mock.calls.length, 0);
});

test("a failed run with no text throws with its usage, on either engine", async () => {
  vi.mocked(runPiOneShot).mockResolvedValue({
    text: "  ",
    usage: { inputTokens: 7 },
    stopReason: "error",
    errorMessage: "rate limited",
  });
  await assert.rejects(
    () => runOneShot(request()),
    (err: unknown) =>
      err instanceof OneShotError &&
      err.message === "rate limited" &&
      err.usage.inputTokens === 7,
  );

  vi.mocked(runClaudeSdkOneShot).mockResolvedValue({
    text: "",
    usage: {},
    failure: "Claude SDK run ended with: error_during_execution",
  });
  await assert.rejects(
    () =>
      runOneShot(
        request({ model: { provider: "claude-sdk", modelId: "sonnet" } }),
      ),
    (err: unknown) =>
      err instanceof OneShotError && /error_during_execution/.test(err.message),
  );
});

test("a failed run that wrote text returns it with the failure", async () => {
  vi.mocked(runPiOneShot).mockResolvedValue({
    text: "partial",
    usage: {},
    stopReason: "aborted",
    errorMessage: "",
  });

  const result = await runOneShot(request());

  assert.equal(result.text, "partial");
  assert.equal(result.failure, "The model stopped with aborted.");
});

test("documents need a Claude model", async () => {
  await assert.rejects(
    () =>
      runOneShot(
        request({
          documents: [{ mimeType: "application/pdf", dataBase64: "" }],
        }),
      ),
    /Claude model/,
  );
  assert.equal(vi.mocked(runPiOneShot).mock.calls.length, 0);
});

test("a recorded run is stored under the engine that ran it, failed or not", async () => {
  vi.mocked(runPiOneShot).mockResolvedValue({
    text: "",
    usage: { outputTokens: 4 },
    stopReason: "error",
    errorMessage: "boom",
  });
  await assert.rejects(
    () =>
      runOneShot(
        request({
          record: { purpose: "p", title: "T", parentSessionId: "parent" },
        }),
      ),
    OneShotError,
  );
  const piRecord = vi.mocked(sessionStore.createInternalUsageSession).mock
    .calls[0]?.[0];
  assert.equal(piRecord?.harness, "pi");
  assert.equal(piRecord?.provider, "pi");
  assert.equal(piRecord?.model, "fallback-model");
  assert.equal(piRecord?.parentSessionId, "parent");
  assert.deepEqual(piRecord?.usage, { outputTokens: 4 });

  vi.mocked(runClaudeSdkOneShot).mockResolvedValue({ text: "ok", usage: {} });
  await runOneShot(
    request({
      model: { provider: "claude-sdk", modelId: "haiku" },
      record: { purpose: "p", title: "T" },
    }),
  );
  const claudeRecord = vi.mocked(sessionStore.createInternalUsageSession).mock
    .calls[1]?.[0];
  assert.equal(claudeRecord?.harness, "claude-sdk");
  assert.equal(claudeRecord?.provider, "claude");
  assert.equal(claudeRecord?.model, "haiku");
  assert.equal("parentSessionId" in (claudeRecord ?? {}), false);
});

test("an unrecorded run stores nothing", async () => {
  vi.mocked(runPiOneShot).mockResolvedValue({ text: "x", usage: {} });
  await runOneShot(request());
  assert.equal(
    vi.mocked(sessionStore.createInternalUsageSession).mock.calls.length,
    0,
  );
});
