import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialProfileSummary } from "@assistant/shared";
import { runClaudeSdkOneShot } from "../claudeSdk/oneShot.ts";
import { sessionStore } from "../db/sessionStore.ts";
import {
  AccountHealthStore,
  observeAccountHealth,
  reportAccountRunWorking,
  reportAccountRunFailure,
} from "../accountHealth.ts";
import {
  findPiModelExact,
  runPiOneShot,
  selectPiModelWithFallback,
} from "../piSdk/oneShot.ts";
import {
  NoHelperModelError,
  OneShotError,
  runOneShot,
  type OneShotRequest,
} from "./oneShot.ts";

vi.mock("../claudeSdk/oneShot.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claudeSdk/oneShot.ts")>()),
  runClaudeSdkOneShot: vi.fn(),
}));
vi.mock("../piSdk/oneShot.ts", () => ({
  findPiModelExact: vi.fn(),
  runPiOneShot: vi.fn(),
  selectPiModelWithFallback: vi.fn(),
}));
vi.mock("../accountHealth.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../accountHealth.ts")>()),
  observeAccountHealth: vi.fn(),
  reportAccountRunWorking: vi.fn(),
  reportAccountRunFailure: vi.fn(),
}));
vi.mock("../db/sessionStore.ts", () => ({
  sessionStore: { createInternalUsageSession: vi.fn() },
}));

const piModel = { id: "fallback-model", provider: "openai-codex" };
const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

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

test.each(["success", "returned-failure", "thrown-failure"] as const)(
  "health registry errors cannot replace a one-shot %s",
  async (outcome) => {
    const dir = mkdtempSync(join(tmpdir(), "one-shot-health-best-effort-"));
    directories.push(dir);
    const row: CredentialProfileSummary = {
      id: "profile-1",
      name: "Own",
      provider: "openai-codex",
      enabled: true,
      status: "ready",
      health: { state: "unknown", since: null },
      createdAt: 1,
      updatedAt: 1,
    };
    let broken = false;
    const deps = {
      profiles: () => {
        if (broken) throw new Error("SECRET registry error");
        return health.summaries(() => [
          { ...row, health: health.read(row.id, true) },
        ]);
      },
      hasCredential: () => true,
      now: Date.now,
      persistPath: join(dir, "health.json"),
      push: async () => {},
    };
    const health: AccountHealthStore = new AccountHealthStore(deps);
    deps.profiles();
    vi.mocked(observeAccountHealth).mockImplementation(
      health.observe.bind(health),
    );
    vi.mocked(reportAccountRunWorking).mockImplementation(
      health.runWorking.bind(health),
    );
    vi.mocked(reportAccountRunFailure).mockImplementation(
      health.runFailure.bind(health),
    );
    const error = new Error("Unauthorized");
    if (outcome === "thrown-failure")
      vi.mocked(runPiOneShot).mockRejectedValue(error);
    else
      vi.mocked(runPiOneShot).mockResolvedValue({
        text: "partial",
        usage: {},
        ...(outcome === "returned-failure"
          ? { stopReason: "error", errorMessage: error.message }
          : {}),
      });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    broken = true;
    try {
      if (outcome === "thrown-failure")
        await assert.rejects(
          runOneShot(request()),
          (err: unknown) => err === error,
        );
      else {
        const result = await runOneShot(request());
        assert.equal(result.text, "partial");
        assert.equal(
          result.failure,
          outcome === "returned-failure" ? error.message : undefined,
        );
      }
      assert.equal(warn.mock.calls.length, 1);
    } finally {
      warn.mockRestore();
    }
  },
);

test.each(["returned", "thrown"] as const)(
  "a slow one-shot's %s login death beats intervening usage but not a completed login",
  async (outcome) => {
    const dir = mkdtempSync(join(tmpdir(), "one-shot-health-"));
    directories.push(dir);
    const rows: CredentialProfileSummary[] = [
      {
        id: "profile-1",
        name: "Own",
        provider: "claude",
        enabled: true,
        status: "ready",
        health: { state: "unknown", since: null },
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const push = vi.fn(async () => {});
    const deps = {
      profiles: () =>
        health.summaries(() =>
          rows.map((row) => ({ ...row, health: health.read(row.id, true) })),
        ),
      hasCredential: () => true,
      now: Date.now,
      persistPath: join(dir, "health.json"),
      push,
    };
    const health: AccountHealthStore = new AccountHealthStore(deps);
    deps.profiles();
    vi.mocked(observeAccountHealth).mockImplementation(
      health.observe.bind(health),
    );
    vi.mocked(reportAccountRunFailure).mockImplementation(
      health.runFailure.bind(health),
    );
    vi.mocked(reportAccountRunWorking).mockImplementation(
      health.runWorking.bind(health),
    );
    for (const loginCompleted of [false, true]) {
      let release!: () => void;
      let began!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        began = resolve;
      });
      vi.mocked(runClaudeSdkOneShot).mockImplementation(async () => {
        began();
        await pending;
        if (outcome === "thrown") throw new Error("refresh token revoked");
        return { text: "partial", usage: {}, failure: "refresh token revoked" };
      });
      const run = runOneShot(
        request({ model: { provider: "claude-sdk", modelId: "sonnet" } }),
      );
      const finished = run.then(
        (result) => result,
        (error: unknown) => error,
      );
      await started;
      health.usageSnapshot("profile-1", {
        fetchedAt: 0,
        rateLimitsAvailable: true,
      });
      if (loginCompleted) health.loginCompleted("profile-1");
      release();
      await finished;
      assert.equal(
        health.read("profile-1", true).state,
        loginCompleted ? "ok" : "needs-login",
      );
    }
    assert.equal(push.mock.calls.length, 1);
  },
);

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
  vi.mocked(findPiModelExact).mockResolvedValue(undefined);

  await assert.rejects(
    () => runOneShot(request({ modelFallback: "none" })),
    (err: unknown) =>
      err instanceof NoHelperModelError &&
      err.message === "No model for this helper.",
  );
  assert.deepEqual(vi.mocked(findPiModelExact).mock.calls[0], [
    { provider: "openai-codex", modelId: "gpt-test" },
    "profile-1",
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

test("a pi run cut off at its output limit fails with the text it wrote", async () => {
  vi.mocked(runPiOneShot).mockResolvedValue({
    text: "**Half a card",
    usage: { outputTokens: 4096 },
    stopReason: "length",
    errorMessage: "",
  });

  const result = await runOneShot(request());

  assert.equal(result.text, "**Half a card");
  assert.equal(
    result.failure,
    "The model reached its output limit before finishing.",
  );
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

test("one-shots report health for their actual account on success, partial failure and thrown login failure", async () => {
  vi.mocked(runPiOneShot).mockResolvedValue({ text: "ok", usage: {} });
  await runOneShot(request());
  assert.deepEqual(vi.mocked(reportAccountRunWorking).mock.calls, [
    ["profile-1", "openai-codex", undefined],
  ]);
  vi.mocked(runClaudeSdkOneShot).mockResolvedValue({
    text: "partial",
    usage: {},
    failure: "Invalid API key · Please run /login",
  });
  await runOneShot(
    request({
      credentialProfileId: "claude-account",
      model: { provider: "claude-sdk", modelId: "sonnet" },
    }),
  );
  assert.deepEqual(vi.mocked(reportAccountRunFailure).mock.calls[0], [
    "claude-account",
    { kind: "auth", loginDeath: true },
    "claude-sdk",
    undefined,
  ]);
  vi.mocked(runPiOneShot).mockRejectedValue(
    new Error("OpenAI Codex token refresh failed (401): details"),
  );
  await assert.rejects(() => runOneShot(request()), /token refresh failed/);
  assert.deepEqual(vi.mocked(reportAccountRunFailure).mock.calls[1], [
    "profile-1",
    { kind: "auth", loginDeath: true },
    "openai-codex",
    undefined,
  ]);
  assert.equal(vi.mocked(reportAccountRunWorking).mock.calls.length, 1);
});

test.each(["github-copilot", "openai-compatible"])(
  "reports the actual %s model rather than its bound Codex profile on either outcome",
  async (provider) => {
    vi.mocked(selectPiModelWithFallback).mockResolvedValue({
      ...piModel,
      provider,
    } as never);
    const observation = { startedAt: 1, order: 2, generation: 0 };
    vi.mocked(observeAccountHealth).mockReturnValue(observation);
    vi.mocked(runPiOneShot).mockResolvedValue({ text: "ok", usage: {} });
    await runOneShot(request());
    assert.deepEqual(vi.mocked(reportAccountRunWorking).mock.calls[0], [
      "profile-1",
      provider,
      observation,
    ]);
    vi.mocked(runPiOneShot).mockRejectedValue(new Error("401 unauthorized"));
    await assert.rejects(() => runOneShot(request()), /401/);
    assert.deepEqual(vi.mocked(reportAccountRunFailure).mock.calls[0], [
      "profile-1",
      { kind: "auth", loginDeath: true },
      provider,
      observation,
    ]);
  },
);

test("a thrown engine error passes through unchanged and is not recorded", async () => {
  vi.mocked(runPiOneShot).mockRejectedValue(new Error("Timed out."));

  await assert.rejects(
    () => runOneShot(request({ record: { purpose: "p", title: "T" } })),
    (err: unknown) =>
      err instanceof Error &&
      !(err instanceof OneShotError) &&
      err.message === "Timed out.",
  );
  assert.equal(
    vi.mocked(sessionStore.createInternalUsageSession).mock.calls.length,
    0,
  );
});

test("documents reach the Claude engine and tools reach either engine", async () => {
  const documents = [{ mimeType: "application/pdf", dataBase64: "QQ==" }];
  const tools = [{ name: "kb_read" }] as unknown as NonNullable<
    OneShotRequest["tools"]
  >;
  vi.mocked(runClaudeSdkOneShot).mockResolvedValue({ text: "ok", usage: {} });
  await runOneShot(
    request({
      model: { provider: "claude-sdk", modelId: "sonnet" },
      documents,
      tools,
    }),
  );
  const claudeCall = vi.mocked(runClaudeSdkOneShot).mock.calls[0]?.[0];
  assert.equal(claudeCall?.documents, documents);
  assert.equal(claudeCall?.tools, tools);

  vi.mocked(runPiOneShot).mockResolvedValue({ text: "ok", usage: {} });
  await runOneShot(request({ tools }));
  assert.equal(vi.mocked(runPiOneShot).mock.calls[0]?.[0].tools, tools);
});

test("the missing-model message defaults when the caller gives none", async () => {
  vi.mocked(selectPiModelWithFallback).mockResolvedValue(undefined);
  const { noModelMessage: _omitted, ...withoutMessage } = request();

  await assert.rejects(
    () => runOneShot(withoutMessage),
    (err: unknown) =>
      err instanceof NoHelperModelError &&
      err.message === "No model is available for this helper run.",
  );
});
