import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { stream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type {
  CredentialProfileSummary,
  ServerMessage,
} from "@assistant/shared";
import { PiLiveSession } from "./PiLiveSession.ts";
import { fetchOpenAiUsage } from "./openaiUsageQuery.ts";
import { runPiOneShot, selectPiModelWithFallback } from "./oneShot.ts";
import { runOneShot, OneShotError } from "../harnesses/oneShot.ts";
import {
  initializeAccountHealth,
  readAccountHealth,
  reportAccountLoginCompleted,
  reportAccountRunFailure,
  withAccountHealthProfiles,
} from "../accountHealth.ts";
import {
  TURN_END_DEBOUNCE_MS,
  forgetUsageProfile,
  markUsageProfileDirty,
  readUsageSnapshot,
  resetUsageCacheForTests,
  setUsageBroadcaster,
  setUsageCacheDepsForTests,
} from "../usageCache.ts";
import { SessionRuntime } from "../session/runtime/runtime.ts";
import { subscribeSessionRunCompleted } from "../session/runtime/liveSession.ts";
import { SessionLogStore } from "../session/log/store.ts";

vi.mock("./oneShot.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./oneShot.ts")>()),
  runPiOneShot: vi.fn(),
  selectPiModelWithFallback: vi.fn(),
}));
vi.mock("../accountHealth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../accountHealth.ts")>();
  return {
    ...actual,
    reportAccountRunFailure: vi.fn(actual.reportAccountRunFailure),
  };
});

const id = "codex-stream";
const model: Model<"openai-codex-responses"> = {
  id: "gpt-test",
  name: "Codex test",
  provider: "openai-codex",
  api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 1000,
};
const token = `header.${Buffer.from(
  JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
  }),
).toString("base64")}.signature`;
const rows: CredentialProfileSummary[] = [
  {
    id,
    name: "Codex",
    provider: "openai-codex",
    enabled: true,
    status: "ready",
    createdAt: 1,
    updatedAt: 1,
    health: { state: "unknown", since: null },
  },
];
const push = vi.fn(async () => {});
const messages: ServerMessage[] = [];
initializeAccountHealth({
  profiles: () =>
    withAccountHealthProfiles(() =>
      rows.map((row) => ({
        ...row,
        health: readAccountHealth(id, true),
      })),
    ),
  hasCredential: () => true,
  push,
  broadcast: (message) => messages.push(message),
  subscribeChanges: () => () => {},
  subscribeDeleted: () => () => {},
});

beforeEach(() => {
  resetUsageCacheForTests();
  forgetUsageProfile(id);
  reportAccountLoginCompleted(id);
  messages.length = 0;
  vi.clearAllMocks();
  vi.mocked(selectPiModelWithFallback).mockResolvedValue(model as never);
});
afterEach(() => {
  resetUsageCacheForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function rejectedStream(status: number): Promise<AssistantMessage> {
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          error: { type: "authentication_error", message: "Unauthorized" },
        }),
        { status },
      ),
  );
  const result = await stream(
    model,
    normalizeContext({
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    }),
    { apiKey: token, fetch, transport: "sse", maxRetries: 0 },
  ).result();
  assert.equal(fetch.mock.calls.length, 1);
  assert.equal(result.stopReason, "error");
  assert.equal(
    result.errorMessage,
    "Unauthorized",
    "installed SSE drops HTTP status",
  );
  return result;
}

/** Real PiLiveSession and adapter; only the AgentSession event carrier is scripted. */
function piSession(result: AssistantMessage | Error) {
  let listener!: (event: AgentSessionEvent) => void;
  const live = new PiLiveSession(
    "coding" as never,
    {
      sessionId: id,
      sessionName: "Already named",
      model,
      messages: [],
      isStreaming: false,
      sessionManager: { getBranch: () => [] },
      subscribe: (fn: typeof listener) => {
        listener = fn;
        return () => {};
      },
      getSessionStats: () => ({
        totalMessages: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
      }),
      settingsManager: {
        getRetrySettings: () => ({ enabled: false, maxRetries: 0 }),
        applyOverrides: () => {},
      },
      prompt: async () => {
        if (result instanceof Error) throw result;
        listener({ type: "agent_start" });
        listener({ type: "message_end", message: result });
        listener({ type: "agent_settled", aborted: false });
      },
      abort: async () => {},
      dispose: () => {},
    } as never,
    {
      broadcastSessions: async () => {},
      noteRunStarted: () => {},
      checkPendingReload: () => {},
      isReloadQueued: () => false,
      browserRuntimesFor: () => [],
    } as never,
    () => {},
  );
  return live.createRuntimeAdapter();
}
const request = {
  model: { provider: "openai-codex", modelId: model.id },
  credentialProfileId: id,
  thinkingLevel: "off" as const,
  systemPrompt: "system",
  prompt: "prompt",
  timeoutMs: 1000,
  timeoutMessage: "timeout",
};

for (const status of [401, 403, 503]) {
  test(`installed Codex SSE ${status} bare Unauthorized is not login death in either path`, async () => {
    const message = await rejectedStream(status);
    const adapter = piSession(message);
    try {
      const result = await adapter.prompt("hi");
      assert.equal(result.stopReason, "error");
      assert.deepEqual(result.failure, { kind: "auth" });
    } finally {
      await adapter.dispose();
    }
    vi.mocked(runPiOneShot).mockResolvedValue({
      text: "",
      usage: {},
      stopReason: "error",
      errorMessage: message.errorMessage!,
    });
    await assert.rejects(runOneShot(request), OneShotError);
    assert.deepEqual(vi.mocked(reportAccountRunFailure).mock.calls[0]?.[1], {
      kind: "auth",
    });
    assert.equal(readAccountHealth(id, true).state, "ok");
    assert.equal(push.mock.calls.length, 0);
  });
}

for (const [status, body, mortal] of [
  [401, "Unauthorized", true],
  [400, '{"error":"invalid_grant"}', true],
  [400, "refresh token revoked", true],
  [503, "Unauthorized", false],
] as const) {
  test(`installed Codex OAuth refresh ${status}: ${body}`, async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status })),
    );
    let error!: Error;
    await assert.rejects(
      openaiCodexProvider().auth.oauth!.refresh(
        {
          type: "oauth",
          access: token,
          refresh: "test-refresh",
          expires: 0,
        },
        new AbortController().signal,
      ),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        error = err;
        assert.match(error.message, /OpenAI Codex token refresh failed/);
        return true;
      },
    );
    const adapter = piSession(error);
    try {
      const result = await adapter.prompt("hi");
      assert.equal(result.failure?.loginDeath === true, mortal);
    } finally {
      await adapter.dispose();
    }
    vi.mocked(runPiOneShot).mockRejectedValue(error);
    await assert.rejects(runOneShot(request), (err: unknown) => err === error);
    assert.equal(
      vi.mocked(reportAccountRunFailure).mock.calls[0]?.[1]?.loginDeath ===
        true,
      mortal,
    );
  });
}

test("a connected client's failed Codex run revalidates usage and publishes its 401 rejection", async () => {
  vi.useFakeTimers();
  setUsageCacheDepsForTests({
    listProfiles: () => rows,
    now: Date.now,
    fetchOpenAi: () =>
      fetchOpenAiUsage({
        now: Date.now,
        readAuth: async () => ({
          access: token,
          accountId: "test-account",
          expires: null,
        }),
        fetchUsage: async () => ({ status: 401, body: {} }),
      }),
    fetchClaude: async () => {
      throw new Error("unused");
    },
  });
  setUsageBroadcaster({ broadcast: () => {}, hasClients: () => true });
  const adapter = piSession(await rejectedStream(401));
  const runtime = new SessionRuntime(new SessionLogStore(true));
  runtime.createSession(id, adapter);
  const off = subscribeSessionRunCompleted((sessionId, reason) => {
    assert.equal(sessionId, id);
    assert.equal(reason, "error");
    markUsageProfileDirty(id);
  });
  try {
    await assert.rejects(runtime.prompt(id, "hi"));
    assert.equal(readAccountHealth(id, true).state, "ok");
    assert.equal(push.mock.calls.length, 0);
    await vi.advanceTimersByTimeAsync(TURN_END_DEBOUNCE_MS);
    const snapshot = await readUsageSnapshot(id, "openai-codex");
    assert.ok("unavailableCode" in snapshot);
    assert.equal(snapshot.unavailableCode, "rejected");
    assert.equal(readAccountHealth(id, true).state, "needs-login");
    assert.equal(push.mock.calls.length, 1);
    assert.ok(
      messages.some(
        (message) =>
          message.type === "accountLoginAlerts" &&
          message.accounts[0]?.profileId === id,
      ),
    );
  } finally {
    off();
    await runtime.disposeSession(id);
  }
});
