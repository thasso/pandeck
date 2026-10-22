import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test, vi } from "vitest";
import type { Harness } from "@assistant/shared";
import type { PromptableAdapter } from "./session/adapters/contract.ts";

const tmp = mkdtempSync(join(tmpdir(), "account-router-sdk-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
const {
  createCredentialProfile,
  piAgentDir,
  patchCredentialProfile,
  setCredentialProfileEnabled,
} = await import("./credentialProfiles.ts");
const { pickAccount } = await import("./accountRouter.ts");
const { modelsForAccount, piModelForAccount } =
  await import("./harnesses/models.ts");
const { createSession } = await import("./harnesses/create.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { buildSessionState } = await import("./sessionState.ts");
const { piStore } = await import("./piSdk/piStore.ts");
const { claudeSdkStore } = await import("./claudeSdk/claudeSdkStore.ts");
const { sessionRuntime } = await import("./session/runtimeInstance.ts");
const { SessionRuntime } = await import("./session/runtime/runtime.ts");
const { SessionLogStore } = await import("./session/log/store.ts");
const { promptRuntimeSessionWithRuntime, beginRuntimeProviderTurn } =
  await import("./session/runtimePrompt.ts");
await import("./hub.ts");
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test.each([
  ["pi", false],
  ["pi", true],
  ["claude-sdk", false],
  ["claude-sdk", true],
] as const)(
  "%s refuses a demoted enterprise account before append, prior prompt=%s",
  async (harness, priorPrompt) => {
    const profile = createCredentialProfile({
      name: `Admission ${harness} ${priorPrompt}`,
      provider: harness === "pi" ? "openai-codex" : "claude",
    });
    patchCredentialProfile(profile.id, { enterprise: true });
    if (harness === "pi") provision(profile.id, "admission-model");
    const live = await createSession(
      harness === "pi"
        ? {
            harness,
            agentType: "assistant",
            credentialProfileId: profile.id,
            requiresEnterprise: true,
            thinkingLevel: "off",
            model: await piModelForAccount(
              profile.id,
              "router-test",
              "admission-model",
            ),
          }
        : {
            harness,
            agentType: "assistant",
            credentialProfileId: profile.id,
            requiresEnterprise: true,
            modelId: "sonnet",
          },
    );
    const runtime = new SessionRuntime(new SessionLogStore(true));
    const prompt = vi.fn(async () => ({ stopReason: "end" as const }));
    const adapter: PromptableAdapter = {
      provider: "scripted",
      capabilities: {
        fork: "none",
        compact: false,
        steer: false,
        attachments: true,
      },
      subscribe: () => () => {},
      getBinding: () => ({ provider: "scripted", nativeId: live.sessionId }),
      prompt,
      abort: () => {},
      setModel: () => {},
      setReasoning: () => {},
      dispose: () => {},
    };
    const bind = vi
      .spyOn(live, "createRuntimeAdapter")
      .mockReturnValue(adapter);
    try {
      // Demotion during an admitted turn does not interrupt it, but must
      // refuse the next one.
      if (priorPrompt) {
        prompt.mockImplementationOnce(async () => {
          patchCredentialProfile(profile.id, { enterprise: false });
          return { stopReason: "end" };
        });
        await promptRuntimeSessionWithRuntime(runtime, live, "admitted", {
          hidden: true,
        });
        assert.equal(prompt.mock.calls.length, 1);
      }
      const before = runtime.get(live.id)?.clientTimeline() ?? [];
      const calls = prompt.mock.calls.length;
      patchCredentialProfile(profile.id, { enterprise: false });
      // The check runs before `admit`: a peer admission reserves its delivery,
      // so a refused turn must never reach it.
      const admit = vi.fn();
      await assert.rejects(
        promptRuntimeSessionWithRuntime(runtime, live, "refused", {
          hidden: true,
          admit,
        }),
        /requires an enterprise account/,
      );
      assert.equal(admit.mock.calls.length, 0);
      assert.deepEqual(runtime.get(live.id)?.clientTimeline() ?? [], before);
      assert.equal(prompt.mock.calls.length, calls);
      if (!priorPrompt) assert.equal(bind.mock.calls.length, 0);
    } finally {
      bind.mockRestore();
      setCredentialProfileEnabled(profile.id, false);
      await runtime.disposeSession(live.id);
      releaseTestSession(harness, live.sessionId);
    }
  },
);

test.each(["pi", "claude-sdk"] as const)(
  "%s refuses missing enterprise bindings on prompt and provider turns",
  async (harness) => {
    const id = `missing-enterprise-${harness}`;
    sessionStore.upsert({
      id,
      harness,
      agentType: "assistant",
      requiresEnterprise: true,
      credentialProfileId: "gone-account",
    });
    const createRuntimeAdapter = vi.fn(() => {
      throw new Error("Must not bind a refused run");
    });
    const driver = {
      id,
      sessionId: id,
      key: id,
      harness,
      agentType: "assistant" as const,
      credentialProfileId: "gone-account",
      sessionFile: undefined,
      isRunning: false,
      canSteer: false,
      contextInfo: () => ({}) as never,
      broadcastState: () => {},
      createRuntimeAdapter,
    };
    const runtime = new SessionRuntime(new SessionLogStore(true));
    await assert.rejects(
      promptRuntimeSessionWithRuntime(runtime, driver, "refused"),
      /bound account is missing/,
    );
    await assert.rejects(
      beginRuntimeProviderTurn(driver, { kind: "human" }),
      /bound account is missing/,
    );
    assert.equal(runtime.get(id), undefined);
    assert.equal(sessionRuntime.get(id), undefined);
    assert.equal(createRuntimeAdapter.mock.calls.length, 0);
  },
);

function releaseTestSession(harness: Harness, id: string): void {
  if (harness === "pi") piStore.evict(id);
  else claudeSdkStore.remove(id);
}

function provision(id: string, modelId: string): void {
  const dir = piAgentDir(id);
  // SDK-owned file shapes, test credentials only. No login or provider request.
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "test-token",
        refresh: "test-refresh",
        expires: Date.now() + 86400_000,
      },
    }),
  );
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        "router-test": {
          baseUrl: "https://router-test.invalid/v1",
          api: "openai-completions",
          apiKey: "test-key",
          models: [
            {
              id: modelId,
              name: modelId,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 1024,
            },
          ],
        },
      },
    }),
  );
}

test("installed pi runtime isolates model availability before account ranking", async () => {
  const otherModel = createCredentialProfile({
    name: "Other catalog",
    provider: "openai-codex",
  });
  const exact = createCredentialProfile({
    name: "Exact catalog",
    provider: "openai-codex",
  });
  provision(otherModel.id, "other-model");
  provision(exact.id, "wanted-model");
  const models = await modelsForAccount(exact);
  assert.ok(
    models.some(
      (model) =>
        model.provider === "router-test" && model.id === "wanted-model",
    ),
  );
  assert.ok(
    !(await modelsForAccount(otherModel)).some(
      (model) => model.id === "wanted-model",
    ),
  );
  assert.deepEqual(
    await pickAccount({
      model: { provider: "router-test", modelId: "wanted-model" },
      thinkingLevel: "off",
    }),
    { profileId: exact.id },
  );
  assert.deepEqual(
    await pickAccount({
      model: { provider: "router-test", modelId: "wanted-model" },
      thinkingLevel: "high",
    }),
    {
      profileId: [otherModel.id, exact.id, "default"].sort()[0],
      degraded: "no-eligible-account",
    },
  );
  patchCredentialProfile(exact.id, { enterprise: true });
  assert.deepEqual(
    await pickAccount({
      model: { provider: "router-test", modelId: "wanted-model" },
      thinkingLevel: "off",
      requiresEnterprise: true,
    }),
    { profileId: exact.id },
  );
});

test("real pi-store creation persists enterprise before its first immutable claim", async () => {
  const pi = createCredentialProfile({
    name: "Enterprise pi",
    provider: "openai-codex",
  });
  provision(pi.id, "enterprise-model");
  patchCredentialProfile(pi.id, { enterprise: true });
  const model = await piModelForAccount(
    pi.id,
    "router-test",
    "enterprise-model",
  );
  assert.ok(model);
  const piSession = await createSession({
    harness: "pi",
    agentType: "assistant",
    credentialProfileId: pi.id,
    model,
    thinkingLevel: "off",
    requiresEnterprise: true,
  });
  try {
    assert.equal(
      sessionStore.get(piSession.sessionId)?.requiresEnterprise,
      true,
    );
    assert.equal(
      buildSessionState(piSession.id, piSession.nativeFacts())
        .requiresEnterprise,
      true,
    );
    const native = piStore.get(piSession.sessionId);
    assert.ok(native);
    const anchor = native.session.sessionManager.appendMessage({
      role: "user",
      content: "Enterprise fork fixture",
      timestamp: Date.now(),
    });
    const file = native.session.sessionFile;
    assert.ok(file);
    patchCredentialProfile(pi.id, { enterprise: false });
    await assert.rejects(
      piStore.forkSession("assistant", file, anchor, "at", "app-origin"),
      /requires an enterprise account/,
    );
    assert.equal(piStore.get(piSession.sessionId), native);
    assert.equal(existsSync(file), true);
    patchCredentialProfile(pi.id, { enterprise: true });
    const child = await piStore.forkSession(
      "assistant",
      file,
      anchor,
      "at",
      "app-origin",
    );
    try {
      assert.equal(sessionStore.get(child.sessionId)?.requiresEnterprise, true);
      assert.equal(
        buildSessionState(child.id, child.nativeFacts()).requiresEnterprise,
        true,
      );
      assert.equal(child.credentialProfileId, pi.id);
    } finally {
      piStore.evict(child.sessionId);
      await sessionRuntime.disposeSession(child.sessionId);
    }
    assert.equal(existsSync(file), true);
  } finally {
    piStore.evict(piSession.sessionId);
    await sessionRuntime.disposeSession(piSession.sessionId);
  }
});

test.each(["build", "plan"] as const)(
  "real Claude creation preserves the first claim and applies requested %s mode",
  async (mode) => {
    const claude = createCredentialProfile({
      name: "Enterprise Claude",
      provider: "claude",
    });
    patchCredentialProfile(claude.id, { enterprise: true });
    const acquire = claudeSdkStore.acquire.bind(claudeSdkStore);
    let claimed: ReturnType<typeof sessionStore.get>;
    const spy = vi
      .spyOn(claudeSdkStore, "acquire")
      .mockImplementation((...args) => {
        const live = acquire(...args);
        claimed = sessionStore.get(live.sessionId);
        return live;
      });
    let claudeSession: Awaited<ReturnType<typeof createSession>> | undefined;
    try {
      claudeSession = await createSession({
        harness: "claude-sdk",
        agentType: "assistant",
        credentialProfileId: claude.id,
        modelId: "sonnet",
        thinkingLevel: "high",
        mode,
        requiresEnterprise: true,
      });
      // acquire's initial row is Build; the wrapper's upsert is required for Plan.
      assert.equal(claimed?.mode, "build");
      assert.deepEqual(sessionStore.get(claudeSession.sessionId), {
        ...claimed,
        mode,
      });
      assert.equal(claimed?.credentialProfileId, claude.id);
      assert.equal(claimed?.thinkingLevel, "high");
      assert.equal(
        sessionStore.get(claudeSession.sessionId)?.requiresEnterprise,
        true,
      );
      assert.equal(
        buildSessionState(claudeSession.id, claudeSession.nativeFacts())
          .requiresEnterprise,
        true,
      );
    } finally {
      spy.mockRestore();
      if (claudeSession) {
        claudeSdkStore.remove(claudeSession.sessionId);
        await sessionRuntime.disposeSession(claudeSession.sessionId);
      }
    }
  },
);
