import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialProfileSummary } from "@assistant/shared";
import { runClaudeSdkOneShot } from "../claudeSdk/oneShot.ts";
import { sessionStore } from "../db/sessionStore.ts";
import {
  EnterpriseAccountRequiredError,
  resolveSlotAccount,
} from "../settingsModelSlots.ts";
import { credentialProfileById } from "../credentialProfiles.ts";
import { pickAccount } from "../accountRouter.ts";
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
vi.mock("../settingsModelSlots.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../settingsModelSlots.ts")>()),
  resolveSlotAccount: vi.fn(),
}));
vi.mock("../credentialProfiles.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../credentialProfiles.ts")>()),
  credentialProfileById: vi.fn(),
}));
vi.mock("../accountRouter.ts", () => ({ pickAccount: vi.fn() }));
vi.mock("../db/sessionStore.ts", () => ({
  sessionStore: {
    createInternalUsageSession: vi.fn(),
    getIncludingDeleted: vi.fn(),
  },
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
  vi.mocked(credentialProfileById).mockReturnValue({
    enterprise: true,
  } as never);
  vi.mocked(sessionStore.getIncludingDeleted).mockReturnValue({
    requiresEnterprise: false,
  } as never);
  vi.mocked(resolveSlotAccount).mockImplementation(async (slot) => ({
    profileId: slot.credentialProfileId?.trim() || "automatic-1",
  }));
  vi.mocked(pickAccount).mockResolvedValue({ profileId: "automatic-2" });
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
      enterprise: false,
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
        enterprise: false,
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

test.each(["quota", "rate_limit"] as const)(
  "an automatic %s failure retries once, records both attempts and sums usage",
  async (kind) => {
    vi.mocked(runPiOneShot)
      .mockResolvedValueOnce({
        text: "discarded partial",
        usage: {
          inputTokens: 3,
          outputTokens: 2,
          costUSD: 0.2,
          contextTokens: 9,
        },
        stopReason: "error",
        errorMessage: kind === "quota" ? "quota exceeded" : "rate limited",
      })
      .mockResolvedValueOnce({
        text: "complete",
        usage: {
          inputTokens: 5,
          outputTokens: 4,
          costUSD: 0.3,
          contextTokens: 11,
        },
      });
    const result = await runOneShot(
      request({
        credentialProfileId: undefined,
        record: { purpose: "p", title: "T" },
      }),
    );
    assert.deepEqual(result, {
      text: "complete",
      usage: {
        inputTokens: 8,
        outputTokens: 6,
        costUSD: 0.5,
        contextTokens: 11,
      },
    });
    assert.deepEqual(
      vi
        .mocked(runPiOneShot)
        .mock.calls.map(([input]) => input.credentialProfileId),
      ["automatic-1", "automatic-2"],
    );
    assert.deepEqual(vi.mocked(pickAccount).mock.calls[0]?.[0], {
      model: { provider: "openai-codex", modelId: "gpt-test" },
      thinkingLevel: "low",
      excludeProfileIds: ["automatic-1"],
      requiresEnterprise: false,
      allowDisabledDefault: true,
    });
    assert.deepEqual(
      vi
        .mocked(sessionStore.createInternalUsageSession)
        .mock.calls.map(([input]) => input.usage?.inputTokens),
      [3, 5],
    );
    assert.equal(
      vi.mocked(reportAccountRunFailure).mock.calls[0]?.[1]?.kind,
      kind,
    );
    assert.equal(
      vi.mocked(reportAccountRunWorking).mock.calls[0]?.[0],
      "automatic-2",
    );
  },
);

test.each(["returned", "thrown"] as const)(
  "automatic Claude %s 401 retries with raw status before wrapping",
  async (outcome) => {
    const engine = vi.mocked(runClaudeSdkOneShot);
    if (outcome === "returned")
      engine.mockResolvedValueOnce({
        text: "",
        usage: { inputTokens: 3 },
        failure: "Request failed without auth prose",
        failureStatus: 401,
      });
    else
      engine.mockRejectedValueOnce(
        Object.assign(new Error("Request failed without auth prose"), {
          status: 401,
        }),
      );
    engine.mockResolvedValueOnce({ text: "ok", usage: { inputTokens: 5 } });
    const result = await runOneShot(
      request({
        credentialProfileId: undefined,
        model: { provider: "claude-sdk", modelId: "sonnet" },
      }),
    );
    assert.equal(result.text, "ok");
    assert.equal(engine.mock.calls.length, 2);
    assert.deepEqual(vi.mocked(reportAccountRunFailure).mock.calls[0]?.[1], {
      kind: "auth",
      loginDeath: true,
    });
  },
);

test.each([
  "Unauthorized",
  "permission denied",
  "overloaded",
  "timed out",
  "content policy",
])(
  "automatic Codex failure %s does not cross-account retry",
  async (message) => {
    vi.mocked(runPiOneShot).mockResolvedValue({
      text: "",
      usage: {},
      stopReason: "error",
      errorMessage: message,
    });
    await assert.rejects(
      runOneShot(request({ credentialProfileId: undefined })),
      OneShotError,
    );
    assert.equal(vi.mocked(pickAccount).mock.calls.length, 0);
    assert.equal(vi.mocked(runPiOneShot).mock.calls.length, 1);
  },
);

test.each(["returned", "thrown"] as const)(
  "an explicit account's %s login death alerts that account and never retries",
  async (outcome) => {
    const engine = vi.mocked(runClaudeSdkOneShot);
    if (outcome === "returned")
      engine.mockResolvedValue({
        text: "",
        usage: { inputTokens: 2 },
        failure: "Request failed",
        failureStatus: 401,
      });
    else
      engine.mockRejectedValue(
        Object.assign(new Error("Request failed"), { status: 401 }),
      );
    await assert.rejects(
      runOneShot(
        request({
          credentialProfileId: "needs-login-pin",
          model: { provider: "claude-sdk", modelId: "sonnet" },
        }),
      ),
      /Request failed/,
    );
    assert.equal(
      engine.mock.calls[0]?.[0].credentialProfileId,
      "needs-login-pin",
    );
    assert.equal(engine.mock.calls.length, 1);
    assert.equal(vi.mocked(pickAccount).mock.calls.length, 0);
    assert.deepEqual(
      vi.mocked(reportAccountRunFailure).mock.calls[0]?.slice(0, 3),
      ["needs-login-pin", { kind: "auth", loginDeath: true }, "claude-sdk"],
    );
  },
);

test.each(["profile-1", "unusable-pin"])(
  "explicit %s never cross-account retries, including degraded pins",
  async (pin) => {
    vi.mocked(resolveSlotAccount).mockResolvedValue({
      profileId: "fallback-account",
      degraded: "disabled",
      pinnedProfileId: pin,
    });
    vi.mocked(runPiOneShot).mockResolvedValue({
      text: "",
      usage: { inputTokens: 3 },
      stopReason: "error",
      errorMessage: "quota exceeded",
    });
    await assert.rejects(
      runOneShot(request({ credentialProfileId: pin })),
      OneShotError,
    );
    assert.equal(vi.mocked(pickAccount).mock.calls.length, 0);
    assert.equal(
      vi.mocked(runPiOneShot).mock.calls[0]?.[0].credentialProfileId,
      "fallback-account",
    );
  },
);

test.each([null, "automatic-1"])(
  "no distinct replacement %s preserves partial output and original usage",
  async (replacement) => {
    vi.mocked(pickAccount).mockResolvedValue({ profileId: replacement });
    vi.mocked(runPiOneShot).mockResolvedValue({
      text: "partial",
      usage: { outputTokens: 4 },
      stopReason: "error",
      errorMessage: "quota exceeded",
    });
    assert.deepEqual(
      await runOneShot(request({ credentialProfileId: undefined })),
      {
        text: "partial",
        usage: { outputTokens: 4 },
        failure: "quota exceeded",
      },
    );
    assert.equal(vi.mocked(runPiOneShot).mock.calls.length, 1);
  },
);

test("no replacement preserves the original thrown error even if selection fails", async () => {
  const original = Object.assign(new Error("Request failed"), { status: 401 });
  vi.mocked(runClaudeSdkOneShot).mockRejectedValue(original);
  vi.mocked(pickAccount).mockRejectedValue(new Error("Registry failed"));
  await assert.rejects(
    runOneShot(
      request({
        credentialProfileId: undefined,
        model: { provider: "claude-sdk", modelId: "sonnet" },
      }),
    ),
    (error) => error === original,
  );
});

test("a second limit failure stops with summed consumption, never a third attempt", async () => {
  vi.mocked(runPiOneShot)
    .mockResolvedValueOnce({
      text: "",
      usage: { inputTokens: 3 },
      stopReason: "error",
      errorMessage: "quota exceeded",
    })
    .mockResolvedValueOnce({
      text: "",
      usage: { inputTokens: 5 },
      stopReason: "error",
      errorMessage: "rate limited",
    });
  await assert.rejects(
    runOneShot(request({ credentialProfileId: undefined })),
    (error) =>
      error instanceof OneShotError &&
      error.message === "rate limited" &&
      error.usage.inputTokens === 8,
  );
  assert.equal(vi.mocked(runPiOneShot).mock.calls.length, 2);
  assert.equal(vi.mocked(pickAccount).mock.calls.length, 1);
});

test("a replacement engine exception preserves already measured consumption", async () => {
  vi.mocked(runPiOneShot)
    .mockResolvedValueOnce({
      text: "partial",
      usage: { costUSD: 0.5 },
      stopReason: "error",
      errorMessage: "quota exceeded",
    })
    .mockRejectedValueOnce(new Error("Timed out."));
  await assert.rejects(
    runOneShot(request({ credentialProfileId: undefined })),
    (error) =>
      error instanceof OneShotError &&
      error.message === "Timed out." &&
      error.usage.costUSD === 0.5,
  );
});

test.each(["source", "parent"] as const)(
  "enterprise %s provenance survives caller false and deletion before retry",
  async (provenance) => {
    let sourceExists = true;
    vi.mocked(sessionStore.getIncludingDeleted).mockImplementation(() =>
      sourceExists ? ({ requiresEnterprise: true } as never) : undefined,
    );
    vi.mocked(resolveSlotAccount).mockImplementation(async (slot) => {
      assert.equal(slot.requiresEnterprise, true);
      sourceExists = false;
      return { profileId: "enterprise-1" };
    });
    vi.mocked(pickAccount).mockResolvedValue({ profileId: "enterprise-2" });
    vi.mocked(runPiOneShot)
      .mockResolvedValueOnce({
        text: "",
        usage: { inputTokens: 1 },
        stopReason: "error",
        errorMessage: "quota exceeded",
      })
      .mockResolvedValueOnce({ text: "ok", usage: { inputTokens: 2 } });
    const result = await runOneShot(
      request({
        credentialProfileId: undefined,
        requiresEnterprise: false,
        ...(provenance === "source"
          ? { sourceSessionIds: ["work-source"] }
          : {}),
        record: {
          purpose: "p",
          title: "T",
          ...(provenance === "parent"
            ? { parentSessionId: "work-source" }
            : {}),
        },
      }),
    );
    assert.equal(result.text, "ok");
    assert.equal(
      vi.mocked(pickAccount).mock.calls[0]?.[0].requiresEnterprise,
      true,
    );
    assert.equal(
      vi.mocked(pickAccount).mock.calls[0]?.[0].allowDisabledDefault,
      false,
    );
    assert.deepEqual(
      vi
        .mocked(sessionStore.createInternalUsageSession)
        .mock.calls.map(([input]) => input.requiresEnterprise),
      [true, true],
    );
  },
);

test("a degraded enterprise retry preserves the original failure and consumption", async () => {
  vi.mocked(pickAccount).mockResolvedValue({
    profileId: "enterprise-unhealthy",
    degraded: "no-eligible-account",
  });
  vi.mocked(runPiOneShot).mockResolvedValue({
    text: "partial",
    usage: { inputTokens: 3 },
    stopReason: "error",
    errorMessage: "quota exceeded",
  });
  assert.deepEqual(
    await runOneShot(
      request({ credentialProfileId: undefined, requiresEnterprise: true }),
    ),
    { text: "partial", usage: { inputTokens: 3 }, failure: "quota exceeded" },
  );
  assert.equal(vi.mocked(runPiOneShot).mock.calls.length, 1);
});

test.each(["claude-sdk", "pi"] as const)(
  "enterprise account demotion after pick prevents %s dispatch",
  async (engine) => {
    vi.mocked(resolveSlotAccount).mockImplementation(async () => {
      vi.mocked(credentialProfileById).mockReturnValue({
        enterprise: false,
      } as never);
      return { profileId: "enterprise" };
    });
    await assert.rejects(
      runOneShot(
        request({
          requiresEnterprise: true,
          model: {
            provider: engine === "claude-sdk" ? "claude" : "openai-codex",
            modelId: "test",
          },
        }),
      ),
      EnterpriseAccountRequiredError,
    );
    assert.equal(vi.mocked(runPiOneShot).mock.calls.length, 0);
    assert.equal(vi.mocked(runClaudeSdkOneShot).mock.calls.length, 0);
    assert.equal(vi.mocked(reportAccountRunFailure).mock.calls.length, 0);
  },
);

test("enterprise account demotion during model lookup prevents dispatch", async () => {
  vi.mocked(selectPiModelWithFallback).mockImplementation(async () => {
    vi.mocked(credentialProfileById).mockReturnValue({
      enterprise: false,
    } as never);
    return piModel as never;
  });
  await assert.rejects(
    runOneShot(request({ requiresEnterprise: true })),
    EnterpriseAccountRequiredError,
  );
  assert.equal(vi.mocked(runPiOneShot).mock.calls.length, 0);
});

test.each(["pick", "model"] as const)(
  "an enterprise replacement demoted during %s preserves the original measured failure",
  async (seam) => {
    let demoted = false;
    vi.mocked(credentialProfileById).mockImplementation(
      (id) => ({ enterprise: id !== "automatic-2" || !demoted }) as never,
    );
    vi.mocked(pickAccount).mockImplementation(async () => {
      if (seam === "pick") demoted = true;
      return { profileId: "automatic-2" };
    });
    vi.mocked(selectPiModelWithFallback).mockImplementation(
      async (_model, id) => {
        if (id === "automatic-2" && seam === "model") demoted = true;
        return piModel as never;
      },
    );
    vi.mocked(runPiOneShot).mockResolvedValue({
      text: "original partial",
      stopReason: "error",
      errorMessage: "429 rate limit exceeded",
      usage: { inputTokens: 7, costUSD: 0.2 },
    });
    const result = await runOneShot(
      request({
        credentialProfileId: undefined,
        requiresEnterprise: true,
        record: { purpose: "naming", title: "Test" },
      }),
    );
    assert.deepEqual(result, {
      text: "original partial",
      failure: "429 rate limit exceeded",
      usage: { inputTokens: 7, costUSD: 0.2 },
    });
    assert.equal(vi.mocked(runPiOneShot).mock.calls.length, 1);
    assert.equal(
      vi.mocked(sessionStore.createInternalUsageSession).mock.calls.length,
      1,
    );
    assert.equal(vi.mocked(reportAccountRunFailure).mock.calls.length, 1);
  },
);

test("an enterprise replacement removed after pick preserves the original exception", async () => {
  const original = new Error("429 rate limit exceeded");
  vi.mocked(runPiOneShot).mockRejectedValue(original);
  vi.mocked(pickAccount).mockImplementation(async () => {
    vi.mocked(credentialProfileById).mockReturnValue(undefined);
    return { profileId: "automatic-2" };
  });
  await assert.rejects(
    runOneShot(
      request({ credentialProfileId: undefined, requiresEnterprise: true }),
    ),
    (err) => err === original,
  );
  assert.equal(vi.mocked(runPiOneShot).mock.calls.length, 1);
});

test("unknown source provenance fails closed to enterprise scope", async () => {
  vi.mocked(sessionStore.getIncludingDeleted).mockReturnValue(undefined);
  vi.mocked(runPiOneShot).mockResolvedValue({ text: "ok", usage: {} });
  await runOneShot(
    request({
      sourceSessionIds: ["deleted-source"],
      requiresEnterprise: false,
    }),
  );
  assert.equal(
    vi.mocked(resolveSlotAccount).mock.calls[0]?.[0].requiresEnterprise,
    true,
  );
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
