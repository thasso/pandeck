import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";

const naming = vi.hoisted(() => ({
  pending: [] as Array<(title: string) => void>,
}));
vi.mock("../sessionNaming.ts", async (original) => ({
  ...(await original<object>()),
  generateSessionTitle: () =>
    new Promise<string>((resolve) => naming.pending.push(resolve)),
}));
const tmp = mkdtempSync(join(tmpdir(), "session-list-live-writers-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
const { hub } = await import("../hub.ts");
const { assertSessionRowsReported: oracle, publicSessionRows } =
  await import("../test/sessionListPublicOracle.ts");
const { piStore } = await import("./piStore.ts");
const { sessionRuntime } = await import("../session/runtimeInstance.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { ensureRuntimeSessionWithRuntime } =
  await import("../session/runtimePrompt.ts");
const { updateSettings, getSettings } = await import("../settings.ts");
const profiles = await import("../credentialProfiles.ts");
const { piModelForAccount } = await import("../harnesses/models.ts");
const { createSession } = await import("../harnesses/create.ts");
const { HARNESS_IDLE_EVICT_MS } = await import("../harness.ts");
const { installSessionActivityTracking } =
  await import("../sessionActivity.ts");
const stopTracking = installSessionActivityTracking();
updateSettings({
  sessionNaming: { ...getSettings().sessionNaming, enabled: false },
  claudeSdk: { enabled: true },
});
profiles.listCredentialProfiles();
profiles.setCredentialProfileEnabled(profiles.DEFAULT_CLAUDE_PROFILE_ID, false);
profiles.setCredentialProfileEnabled(profiles.DEFAULT_OPENAI_PROFILE_ID, false);
function account(provider: "openai-codex" | "claude") {
  const p = profiles.createCredentialProfile({
    provider,
    name: "Oracle account",
  });
  if (provider === "openai-codex")
    writeFileSync(
      join(profiles.piAgentDir(p.id), "auth.json"),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "test-token",
          refresh: "test-refresh",
          expires: Date.now() + 86400000,
        },
      }),
    );
  else
    writeFileSync(
      join(profiles.claudeConfigDir(p.id), ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "test-token",
          refreshToken: "test-refresh",
          expiresAt: Date.now() + 86400000,
        },
      }),
    );
  profiles.listCredentialProfiles();
  return p.id;
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const opens: AgentSession[] = [];
const response = { failure: false, throwSubmit: false, encrypted: false };
function interceptPi() {
  const internals = piStore as unknown as {
    create: (...args: unknown[]) => Promise<{
      session: AgentSession;
      notices: unknown[];
      commit(): void;
      dispose(): void;
    }>;
  };
  const original = internals.create.bind(piStore);
  return vi.spyOn(internals, "create").mockImplementation(async (...args) => {
    const created = await original(...args);
    const native = created.session;
    opens.push(native);
    native.setAutoRetryEnabled(false);
    native.agent.streamFunction = (model) => {
      if (response.throwSubmit)
        throw new Error("provider construction refused");
      const failure = response.failure;
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [
          ...(response.encrypted
            ? [
                {
                  type: "thinking" as const,
                  thinking: "opaque",
                  thinkingSignature: "test-encrypted",
                },
              ]
            : []),
          { type: "text", text: failure ? "" : "Oracle answer" },
        ],
        stopReason: failure ? "error" : "stop",
        ...(failure ? { errorMessage: "provider refused this turn" } : {}),
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push(
          failure
            ? { type: "error", reason: "error", error: message }
            : { type: "done", reason: "stop", message },
        );
        stream.end();
      });
      return stream;
    };
    return created;
  });
}
async function freshPi(profile = account("openai-codex")) {
  return (await createSession({
    harness: "pi",
    agentType: "assistant",
    model: await piModelForAccount(profile, "openai-codex", "gpt-5.5"),
    thinkingLevel: "off",
    cwd: tmp,
    credentialProfileId: profile,
  })) as import("./PiLiveSession.ts").PiLiveSession;
}
afterEach(async () => {
  vi.useRealTimers();
  for (const live of piStore.list()) piStore.evict(live.id);
  await sessionRuntime.dispose();
  vi.restoreAllMocks();
  response.failure = false;
  response.throwSubmit = false;
  response.encrypted = false;
  updateSettings({
    sessionNaming: { ...getSettings().sessionNaming, enabled: false },
  });
  naming.pending.length = 0;
  await hub.flushPendingBroadcastsForTests();
});
afterAll(() => {
  stopTracking();
  rmSync(tmp, { recursive: true, force: true });
});

test("Pi acquireNew, prompt, fork lineage and idle callback use real native/store paths", async () => {
  interceptPi();
  const parent = await oracle("PiStore.acquireNew", () => freshPi(), {
    equal: "an empty new native conversation has no public membership yet",
  });
  assert.equal(piStore.get(parent.id), parent);
  assert.equal(sessionStore.liveDefaultScopeGate([parent.id])(parent.id), true);
  ensureRuntimeSessionWithRuntime(sessionRuntime, parent);
  await oracle(
    "Pi prompt acceptance/settlement",
    () => sessionRuntime.prompt(parent.id, "first oracle prompt"),
    { changed: [parent.id] },
  );
  assert.ok(parent.listInfo().messageCount >= 2);
  assert.equal(parent.isRunning, false);
  const native = opens[0]!;
  const anchor = native.sessionManager
    .getEntries()
    .findLast((e) => e.type === "message" && e.message.role === "assistant")!;
  const child = await oracle(
    "PiStore.forkSession",
    () =>
      piStore.forkSession(
        "assistant",
        parent.sessionFile!,
        anchor.id,
        "at",
        "app-parent-entry",
      ),
    { changed: (value) => [value.id] },
  );
  assert.notEqual(child.id, parent.id);
  assert.equal(child.listInfo().forkOrigin?.parentSessionId, parent.id);
  assert.equal(child.listInfo().forkAutoRenamePending, true);
  assert.ok(existsSync(child.sessionFile!));
  ensureRuntimeSessionWithRuntime(sessionRuntime, child);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  child.armIdleIfUnviewed();
  await oracle(
    "PiStore.onLiveSessionEvicted/idle residency",
    () => vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS),
    { changed: [child.id] },
  );
  assert.equal(child.released, true);
  assert.equal(piStore.get(child.id), undefined);
  assert.equal(sessionRuntime.get(child.id), undefined);
});

test("Pi new acquisition failure disposes unregistered native output without public leakage", async () => {
  interceptPi();
  const profile = account("openai-codex");
  const before = piStore.list().length;
  await oracle(
    "PiStore.acquireNew failure cleanup",
    async () => {
      await assert.rejects(
        () =>
          piStore.acquireNew("assistant", undefined, "off", {
            cwd: tmp,
            credentialProfileId: profile,
            requiresEnterprise: true,
          }),
        /enterprise/,
      );
    },
    {
      equal:
        "enterprise refusal happens before registration; cleanup leaves no public child",
    },
  );
  assert.equal(piStore.list().length, before);
  assert.ok(opens.length > 0);
  assert.equal(sessionStore.get(opens.at(-1)!.sessionId), undefined);
  assert.ok(
    !opens.at(-1)!.sessionFile || !existsSync(opens.at(-1)!.sessionFile!),
  );
});

test("Pi failed prompt, account replacement, continuation and teardown report actual rows", async () => {
  interceptPi();
  const a = account("openai-codex"),
    b = account("openai-codex");
  const live = await freshPi(a);
  ensureRuntimeSessionWithRuntime(sessionRuntime, live);
  response.failure = true;
  await oracle(
    "Pi prompt error/finishPromptError",
    async () => {
      await assert.rejects(async () => {
        await sessionRuntime.prompt(live.id, "fail once");
      }, /provider refused/);
    },
    { changed: [live.id] },
  );
  assert.equal(live.isRunning, false);
  assert.ok(
    opens
      .at(-1)!
      .sessionManager.getEntries()
      .some(
        (e) =>
          e.type === "message" &&
          e.message.role === "assistant" &&
          e.message.stopReason === "error",
      ),
  );
  await oracle(
    "PiLiveSession.switchAccount",
    () => live.switchAccount(b, () => {}),
    { changed: [live.id] },
  );
  assert.equal(live.credentialProfileId, b);
  assert.equal(sessionStore.get(live.id)?.credentialProfileId, b);
  response.failure = false;
  await oracle(
    "Pi continueFailedTurn",
    () =>
      sessionRuntime.prompt(live.id, "continue the same turn", {
        continuation: true,
      }),
    { changed: [live.id] },
  );
  assert.ok(
    opens
      .at(-1)!
      .sessionManager.getEntries()
      .some(
        (e) =>
          e.type === "custom_message" &&
          e.customType === "account-continuation",
      ),
  );
  live.beginSyntheticTool("teardown", {});
  await oracle(
    "runtime.closeForTeardown",
    () => sessionRuntime.closeForTeardown(live.id),
    { changed: [live.id] },
  );
  await oracle(
    "runtime.disposeSession",
    () => sessionRuntime.disposeSession(live.id),
    {
      equal:
        "already closed runtime removal changes ownership, not the durable idle row",
    },
  );
  assert.equal(sessionRuntime.get(live.id), undefined);
  assert.equal(sessionRuntime.get(live.id), undefined);
});

test("Pi automatic and fork title completions report pending/title transitions", async () => {
  interceptPi();
  updateSettings({
    sessionNaming: { ...getSettings().sessionNaming, enabled: true },
  });
  const live = await freshPi();
  ensureRuntimeSessionWithRuntime(sessionRuntime, live);
  await oracle(
    "Pi autoName start",
    () => sessionRuntime.prompt(live.id, "name this conversation"),
    { changed: [live.id] },
  );
  assert.equal(live.listInfo().titleGenerationPending, true);
  assert.equal(naming.pending.length, 1);
  await oracle(
    "Pi autoName completion",
    async () => {
      naming.pending.shift()!("Generated oracle title");
      await turn();
    },
    { changed: [live.id] },
  );
  assert.equal(live.sessionTitle, "Generated oracle title");
  assert.ok(!live.listInfo().titleGenerationPending);
  const native = opens.at(-1)!;
  const anchor = native.sessionManager
    .getEntries()
    .findLast((e) => e.type === "message" && e.message.role === "assistant")!;
  const child = await piStore.forkSession(
    "assistant",
    live.sessionFile!,
    anchor.id,
    "at",
    "origin",
  );
  ensureRuntimeSessionWithRuntime(sessionRuntime, child);
  await oracle(
    "Pi fork title start",
    () => sessionRuntime.prompt(child.id, "fork direction"),
    { changed: [child.id] },
  );
  assert.equal(naming.pending.length, 1);
  await oracle(
    "Pi autoNameFork completion",
    async () => {
      naming.pending.shift()!("Fork oracle title");
      await turn();
    },
    { changed: [child.id] },
  );
  assert.equal(child.sessionTitle, "Fork oracle title");
  assert.equal(child.listInfo().forkAutoRenamePending, false);
});

test("Pi context-only clearing uses real transcript-total stats, not fabricated message counts", async () => {
  interceptPi();
  const live = await freshPi();
  ensureRuntimeSessionWithRuntime(sessionRuntime, live);
  await sessionRuntime.prompt(live.id, "native stats fixture");
  const native = opens.at(-1)!;
  const total = native.getSessionStats().totalMessages;
  assert.ok(native.messages.length > 0);
  const entries = native.sessionManager.getEntries().length;
  await oracle("PiLiveSession.clearContext", () => live.clearContext(), {
    equal:
      "clear resets active leaf/context; native stats still aggregate all physical transcript messages",
  });
  assert.equal(native.messages.length, 0);
  assert.equal(native.sessionManager.getLeafId(), null);
  assert.equal(native.getSessionStats().totalMessages, total);
  assert.equal(native.sessionManager.getEntries().length, entries);
  const before = await publicSessionRows();
  assert.ok(before.size > 0);
});

test("Pi fork failure after account revocation cleans native child without leaking membership", async () => {
  const factory = interceptPi();
  const profile = account("openai-codex");
  profiles.patchCredentialProfile(profile, { enterprise: true });
  const parent = (await createSession({
    harness: "pi",
    agentType: "assistant",
    model: await piModelForAccount(profile, "openai-codex", "gpt-5.5"),
    credentialProfileId: profile,
    requiresEnterprise: true,
  })) as import("./PiLiveSession.ts").PiLiveSession;
  ensureRuntimeSessionWithRuntime(sessionRuntime, parent);
  await sessionRuntime.prompt(parent.id, "enterprise parent");
  const anchor = opens
    .at(-1)!
    .sessionManager.getEntries()
    .findLast((e) => e.type === "message" && e.message.role === "assistant")!;
  const baseFactory = factory.getMockImplementation()!;
  factory.mockImplementation(async (...args) => {
    const created = await baseFactory(...args);
    profiles.patchCredentialProfile(profile, { enterprise: false });
    return created;
  });
  await oracle(
    "PiStore.forkSession revoked-account cleanup",
    async () => {
      await assert.rejects(
        () =>
          piStore.forkSession(
            "assistant",
            parent.sessionFile!,
            anchor.id,
            "at",
            "origin",
          ),
        /enterprise/,
      );
    },
    {
      equal:
        "revocation refuses registration and deletes only the unregistered child",
    },
  );
  const refused = opens.at(-1)!;
  assert.notEqual(refused.sessionId, parent.id);
  assert.equal(piStore.get(refused.sessionId), undefined);
  assert.ok(!refused.sessionFile || !existsSync(refused.sessionFile));
  assert.ok(existsSync(parent.sessionFile!));
});

test("Pi prompt-command rejection reaches finishPromptError and reports its final state", async () => {
  interceptPi();
  const live = await freshPi();
  ensureRuntimeSessionWithRuntime(sessionRuntime, live);
  await sessionRuntime.prompt(live.id, "existing conversation");
  const errorPath = vi.spyOn(
    live as unknown as {
      finishPromptError(error: unknown, steer: boolean): void;
    },
    "finishPromptError",
  );
  vi.spyOn(opens.at(-1)!, "prompt").mockRejectedValueOnce(
    new Error("provider construction refused"),
  );
  await oracle(
    "Pi finishPromptError",
    async () => {
      await assert.rejects(async () => {
        await sessionRuntime.prompt(live.id, "refused provider command");
      }, /provider construction refused/);
    },
    { changed: [live.id] },
  );
  assert.equal(live.isRunning, false);
  assert.ok(errorPath.mock.calls.length > 0);
});

test("Pi context edits, compaction and window controls preserve transcript-total public stats", async () => {
  interceptPi();
  response.encrypted = true;
  const live = await freshPi();
  ensureRuntimeSessionWithRuntime(sessionRuntime, live);
  await sessionRuntime.prompt(live.id, "encrypted native transcript");
  const native = opens.at(-1)!;
  const count = native.getSessionStats().totalMessages;
  await oracle(
    "Pi dropEncryptedReasoning",
    () => live.dropEncryptedReasoning(() => {}),
    {
      equal:
        "context edits remove opaque reasoning without removing physical messages",
    },
  );
  assert.ok(
    native.sessionManager.getEntries().some((e) => e.type === "context_edit"),
  );
  assert.equal(native.getSessionStats().totalMessages, count);
  const leaf = native.sessionManager.getLeafId()!;
  vi.spyOn(native, "compact").mockImplementation(async () => {
    // Provider summary production is fake; the native transcript/context edit is real.
    native.sessionManager.appendCompaction("Oracle summary", leaf, 100);
    native.state.messages =
      native.sessionManager.buildSessionContext().messages;
    return {
      summary: "Oracle summary",
      firstKeptEntryId: leaf,
      tokensBefore: 100,
    };
  });
  const compacted = await oracle(
    "Pi compactContext",
    () => live.compactContext(),
    {
      equal:
        "compaction changes the active context, while stats count all transcript entries",
    },
  );
  assert.equal(compacted.kind, "compacted");
  assert.ok(
    native.sessionManager.getEntries().some((e) => e.type === "compaction"),
  );
  assert.equal(native.getSessionStats().totalMessages, count);
  await oracle(
    "Pi applyCompactionWindow",
    () => live.applyCompactionWindow(150000),
    { equal: "the configured context cap is not a session-list field" },
  );
  assert.equal(live.compactionWindowStatus().live.appliedTokens, 150000);
  const lowered = await oracle(
    "Pi lowerCompactionWindow",
    () =>
      live.lowerCompactionWindow(120000, (value) =>
        sessionStore.setCompactionWindow(live.id, value),
      ),
    { equal: "window configuration persists separately from list fields" },
  );
  assert.equal(lowered.ok, true);
  assert.equal(sessionStore.get(live.id)?.compactionWindow, 120000);
});

test("Pi native message, tool and retry callbacks report individual native projection writes", async () => {
  interceptPi();
  const live = await freshPi();
  ensureRuntimeSessionWithRuntime(sessionRuntime, live);
  await sessionRuntime.prompt(live.id, "callback baseline");
  const native = opens.at(-1)!;
  const dispatch = (
    event: import("@earendil-works/pi-coding-agent").AgentSessionEvent,
  ) =>
    (
      live as unknown as {
        onAgentEvent(
          event: import("@earendil-works/pi-coding-agent").AgentSessionEvent,
        ): void;
      }
    ).onAgentEvent(event);
  await oracle(
    "Pi native agent_start callback",
    () => dispatch({ type: "agent_start" }),
    { changed: [live.id] },
  );
  const message = {
    role: "toolResult" as const,
    toolCallId: "native-oracle-tool",
    toolName: "oracle",
    content: [{ type: "text" as const, text: "native terminal result" }],
    isError: false,
    timestamp: Date.now(),
  };
  const count = native.getSessionStats().totalMessages;
  await oracle(
    "Pi native message_end callback",
    () => {
      // The installed SDK notifies listeners, then persists in the same span.
      dispatch({ type: "message_end", message });
      native.sessionManager.appendMessage(message);
    },
    { changed: [live.id] },
  );
  assert.equal(native.getSessionStats().totalMessages, count + 1);
  await oracle(
    "Pi native tool_execution_start callback",
    () =>
      dispatch({
        type: "tool_execution_start",
        toolCallId: message.toolCallId,
        toolName: "oracle",
        args: {},
      }),
    { equal: "tool blocks are live content, not session-list fields" },
  );
  assert.match(JSON.stringify(live.snapshot()), /native-oracle-tool/);
  await oracle(
    "Pi native tool_execution_update callback",
    () =>
      dispatch({
        type: "tool_execution_update",
        toolCallId: message.toolCallId,
        toolName: "oracle",
        args: {},
        partialResult: {
          content: [{ type: "text", text: "native progress" }],
          details: {},
        },
      }),
    { equal: "progress changes the tool body, not the row" },
  );
  assert.match(JSON.stringify(live.snapshot()), /native progress/);
  await oracle(
    "Pi native tool_execution_end callback",
    () =>
      dispatch({
        type: "tool_execution_end",
        toolCallId: message.toolCallId,
        toolName: "oracle",
        result: { content: message.content, details: {} },
        isError: false,
      }),
    {
      equal:
        "the terminal tool body is not a list field; native transcript append was checked separately",
    },
  );
  assert.match(JSON.stringify(live.snapshot()), /native terminal result/);
  await oracle(
    "Pi native auto_retry_start callback",
    () =>
      new Promise<void>((resolve) => {
        const unsubscribe = sessionRuntime.subscribeEvents((id, event) => {
          if (id === live.id && event.type === "runProgress") {
            unsubscribe();
            resolve();
          }
        });
        dispatch({
          type: "auto_retry_start",
          attempt: 1,
          maxAttempts: 3,
          delayMs: 1000,
          errorMessage: "HTTP 503 Service unavailable",
        });
      }),
    { changed: [live.id] },
  );
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 100);
  await oracle(
    "Pi native retry agent_end callback",
    () => dispatch({ type: "agent_end", messages: [], willRetry: true }),
    { changed: [live.id] },
  );
  assert.equal(live.isRunning, true);
  await oracle(
    "Pi native auto_retry_end callback",
    () =>
      dispatch({
        type: "auto_retry_end",
        success: false,
        attempt: 3,
        finalError: "HTTP 503 Service unavailable",
      }),
    {
      equal:
        "the retry failure is recorded in the runtime and transcript before terminal idle",
    },
  );
  assert.match(
    JSON.stringify(sessionRuntime.get(live.id)!.clientTimeline()),
    /Provider retry failed/,
  );
  await oracle(
    "Pi native retry agent_settled callback",
    () => dispatch({ type: "agent_settled", aborted: false }),
    { changed: [live.id] },
  );
  assert.equal(live.isRunning, false);
  assert.equal(sessionRuntime.isRunning(live.id), false);
  dispatch({ type: "agent_start" });
  const aborted = vi.spyOn(native, "abort").mockImplementation(async () => {
    dispatch({ type: "agent_settled", aborted: true });
  });
  await oracle("runtime.abort/Pi.abort", () => sessionRuntime.abort(live.id), {
    changed: [live.id],
  });
  assert.equal(aborted.mock.calls.length, 1);
  assert.equal(live.isRunning, false);
  assert.equal(sessionRuntime.isRunning(live.id), false);
});

test("Pi synthetic progress and card completion execute their own report boundaries", async () => {
  interceptPi();
  const live = await freshPi();
  ensureRuntimeSessionWithRuntime(sessionRuntime, live);
  await sessionRuntime.prompt(live.id, "card baseline");
  live.beginSyntheticTool("clear-context", {});
  await oracle(
    "Pi.updateSyntheticTool",
    () => live.updateSyntheticTool("card progress"),
    { equal: "progress changes the native live tool body, not list fields" },
  );
  assert.match(JSON.stringify(live.snapshot()), /card progress/);
  await oracle(
    "Pi.finishSyntheticCard",
    () =>
      live.finishSyntheticCard({
        kind: "contextClear",
        contextClear: { tokensBefore: 100 },
      }),
    { changed: [live.id] },
  );
  assert.equal(live.isRunning, false);
  assert.ok(
    sessionRuntime
      .get(live.id)!
      .clientTimeline()
      .some((e) => e.type === "command.result"),
  );
});

test("runtime detached view retention, release timer and adapter attachment have equal public rows", async () => {
  interceptPi();
  const live = await freshPi();
  ensureRuntimeSessionWithRuntime(sessionRuntime, live);
  await sessionRuntime.prompt(live.id, "view baseline");
  await oracle(
    "runtime.releaseHarness idle",
    () => sessionRuntime.releaseHarness(live.id),
    {
      equal:
        "dropping an idle runtime leaves the harness and durable list row unchanged",
    },
  );
  assert.equal(sessionRuntime.get(live.id), undefined);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const detached = await oracle(
    "runtime.openForView",
    () => sessionRuntime.openForView(live.id),
    { equal: "a detached read view owns no streaming projection" },
  );
  assert.equal(detached.isDetached, true);
  const release = sessionRuntime.retainView(detached);
  release();
  await oracle(
    "runtime.scheduleViewRelease timer",
    () => vi.advanceTimersByTime(60000),
    { equal: "a detached view's idle eviction changes only runtime residency" },
  );
  assert.equal(sessionRuntime.get(live.id), undefined);
  const reopened = sessionRuntime.openForView(live.id);
  await oracle(
    "runtime.attachAdapter",
    () =>
      sessionRuntime.attachAdapter(live.id, () => live.createRuntimeAdapter()),
    {
      equal:
        "binding an idle adapter changes residency, not public streaming state",
    },
  );
  assert.equal(reopened.isDetached, false);
});

test.each([
  "closeForTeardown",
  "disposeSession",
  "releaseHarness",
  "dispose",
] as const)(
  "runtime %s closes active projected state before removing ownership",
  async (method) => {
    interceptPi();
    const live = await freshPi();
    ensureRuntimeSessionWithRuntime(sessionRuntime, live);
    await sessionRuntime.prompt(live.id, "runtime owner");
    live.beginSyntheticTool("teardown-fixture", {});
    await oracle(
      `runtime.${method}`,
      () =>
        method === "dispose"
          ? sessionRuntime.dispose()
          : sessionRuntime[method](live.id),
      { changed: [live.id] },
    );
    assert.equal(sessionRuntime.isRunning(live.id), false);
    if (method !== "closeForTeardown")
      assert.equal(sessionRuntime.get(live.id), undefined);
  },
);
