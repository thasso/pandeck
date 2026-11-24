import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, test, vi } from "vitest";
import type { Harness, ThinkingLevel } from "@assistant/shared";
import type { RuntimePromptDriver } from "./session/runtimePrompt.ts";
import type {
  RunOutcome,
  RunFailureReport,
} from "./session/runtime/liveSession.ts";
import { SessionBusyError } from "./session/runtime/errors.ts";
import type { RunFailureFacts } from "./session/adapters/contract.ts";
import type { AccountSwitchOptions } from "./sessionAccount.ts";

const offers = vi.hoisted(
  () => new Map<string, { provider: string; id: string }>(),
);
/**
 * Every account that offers its first model also offers a second, reasoning
 * one, for pending model and effort changes: "Big model".
 */
const second = vi.hoisted(
  () => (provider: string) =>
    provider === "claude-sdk" ? "claude-opus-4-7" : "gpt-5.4",
);
const offered = vi.hoisted(
  () => (id: string) =>
    offers.has(id)
      ? [
          { ...offers.get(id)!, name: "Test model", reasoning: false },
          {
            provider: offers.get(id)!.provider,
            id: second(offers.get(id)!.provider),
            name: "Big model",
            reasoning: true,
          },
        ]
      : [],
);
vi.mock("./harnesses/models.ts", () => ({
  accountLacksModel: async () => false,
  modelsForAccount: async ({ id }: { id: string }) => offered(id),
  accountOffersModel: async (id: string, provider: string, model: string) =>
    offered(id).some(
      (option) => option.provider === provider && option.id === model,
    ),
  pickerModels: () => [...offers.keys()].flatMap(offered),
  // A stored session's model, as the session list reads it without a harness.
  storedSessionModelOption: (
    _harness: string,
    provider: string | undefined,
    id: string | undefined,
  ) =>
    provider && id
      ? { provider, id, name: "Test model", reasoning: false }
      : undefined,
}));
// The move host is injected per test; the app's runtime is never built here.
vi.mock("./session/runtimeInstance.ts", () => ({ sessionRuntime: {} }));
const tmp = mkdtempSync(join(tmpdir(), "session-account-switch-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
const profiles = await import("./credentialProfiles.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { SessionRuntime } = await import("./session/runtime/runtime.ts");
const { SessionLogStore } = await import("./session/log/store.ts");
const { promptRuntimeSessionWithRuntime } =
  await import("./session/runtimePrompt.ts");
const { NativeAdapterEventSource } =
  await import("./session/adapters/nativeEvents.ts");
const { createPiAdapter } = await import("./session/adapters/pi.ts");
const { createClaudeSdkAdapter } =
  await import("./session/adapters/claudeSdk.ts");
const lifecycle = await import("./session/runtime/liveSession.ts");
const userProfile = await import("./userProfile.ts");
const { formatLocalDateTime } = await import("./googleTime.ts");
const usageCache = await import("./usageCache.ts");
const { usageProfileForSession } = await import("./harnesses/usage.ts");
const health = await import("./accountHealth.ts");
const { installGatewayLink } = await import("./gatewayLink.ts");
type GatewayLink = import("./gatewayLink.ts").GatewayLink;
health.initializeAccountHealth({
  broadcast: () => {},
  push: async () => {},
  profiles: profiles.listCredentialProfiles,
  hasCredential: profiles.credentialProfileHasCredential,
  subscribeChanges: profiles.subscribeCredentialProfileChanges,
  subscribeDeleted: profiles.subscribeCredentialProfileDeleted,
});
const untrack = health.trackSessionRunHealth({
  session: sessionStore.get,
  subscribeStarted: lifecycle.subscribeSessionRunStarted,
  subscribeFailed: lifecycle.subscribeSessionRunFailed,
  subscribeClosed: lifecycle.subscribeSessionTurnClosed,
});
const created: string[] = [];
const runtimes: { runtime: InstanceType<typeof SessionRuntime>; id: string }[] =
  [];
afterEach(async () => {
  vi.restoreAllMocks();
  // The pending-selection section's seams (declared with it, below).
  setAccountMoveHostForTests(undefined);
  setPendingRuntimeHostForTests(undefined);
  leases.resetSessionRunLeasesForTests();
  for (const { runtime, id } of runtimes.splice(0))
    await runtime.disposeSession(id);
  for (const id of created.splice(0))
    profiles.setCredentialProfileEnabled(id, false);
});
afterAll(() => {
  untrack.dispose();
  rmSync(tmp, { recursive: true, force: true });
});

function account(harness: Harness, name: string, enterprise = false) {
  const p = profiles.createCredentialProfile({
    name,
    provider: harness === "pi" ? "openai-codex" : "claude",
  });
  if (harness === "pi")
    writeFileSync(
      join(profiles.piAgentDir(p.id), "auth.json"),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "test-token",
          refresh: "test-refresh",
          expires: Date.now() + 86400_000,
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
          expiresAt: Date.now() + 86400_000,
        },
      }),
    );
  profiles.patchCredentialProfile(p.id, { enterprise });
  created.push(p.id);
  offers.set(p.id, {
    provider: harness === "pi" ? "openai-codex" : "claude-sdk",
    id: harness === "pi" ? "gpt-5.5" : "claude-sonnet-4-6",
  });
  return p.id;
}

/** Scripted provider, driven through the production normalized engine adapter. */
function setup(
  harness: Harness,
  first: string,
  failures: (RunFailureFacts | undefined)[],
  enterprise = false,
  bound = true,
) {
  const id = randomUUID();
  sessionStore.upsert({
    id,
    harness,
    agentType: "assistant",
    ...(bound ? { credentialProfileId: first } : {}),
    requiresEnterprise: enterprise,
  });
  const runtime = new SessionRuntime(new SessionLogStore(true));
  runtimes.push({ runtime, id });
  const events = new NativeAdapterEventSource();
  // The account's model as the fixture offers it, until a turn applies another.
  const offered = offers.get(first)!;
  let chosen: string | undefined;
  let thinkingLevel: ThinkingLevel = "off";
  /** Native model and effort changes, in order: none until a turn applies one. */
  const native: string[] = [];
  let profileId = first;
  let running = false;
  const calls: { text: string; continuation: boolean; profileId: string }[] =
    [];
  const moves: string[] = [];
  const switchOptions: AccountSwitchOptions[] = [];
  let moveGate: (() => Promise<void>) | undefined;
  let afterMove: (() => Promise<void>) | undefined;
  let failureGate: (() => Promise<void>) | undefined;
  let completionGate: (() => Promise<void>) | undefined;
  async function drive(text: string, continuation: boolean) {
    calls.push({ text, continuation, profileId });
    running = true;
    const stream = randomUUID();
    events.messageStarted(stream);
    await Promise.resolve();
    const failure = failures.shift();
    if (failure && failureGate) {
      events.runFailing("provider rejected request", failure);
      await failureGate();
    }
    running = false;
    events.messageDelta(
      stream,
      "text",
      failure ? "failed attempt" : "continued answer",
    );
    events.messageCompleted(stream, {
      model: chosen ?? offered.id,
      ...(failure
        ? { errorMessage: "provider rejected request", failure }
        : {}),
    });
  }
  const common = {
    modelProvider: () => offered.provider,
    modelId: () => chosen ?? offered.id,
    subscribeAdapterEvents: events.subscribe.bind(events),
    abort: () => {},
    setModel: (next: unknown) => {
      chosen = typeof next === "string" ? next : (next as { id: string }).id;
      native.push(`model:${chosen}`);
    },
    setThinkingLevel: (level: string) => {
      thinkingLevel = level as ThinkingLevel;
      native.push(`effort:${level}`);
    },
  };
  const driver: RuntimePromptDriver = {
    id,
    key: id,
    sessionId: id,
    harness,
    agentType: "assistant",
    sessionFile: undefined,
    get credentialProfileId() {
      return bound ? profileId : undefined;
    },
    get isRunning() {
      return running;
    },
    canSteer: true,
    modelSelection: () => ({
      model: { ...offered, id: chosen ?? offered.id },
      thinkingLevel,
    }),
    contextInfo: () => ({}) as ReturnType<RuntimePromptDriver["contextInfo"]>,
    broadcastState: () => {},
    createRuntimeAdapter: () => {
      const adapter =
        harness === "pi"
          ? createPiAdapter(
              id,
              {
                ...common,
                sessionFile: undefined,
                prompt: (text, _attachments, options) => ({
                  outcome: "started",
                  completed: drive(text, options?.continuation === true),
                }),
              },
              { resolveModel: (next) => next },
            )
          : createClaudeSdkAdapter(id, {
              ...common,
              prompt: (text, options) =>
                drive(text, options?.continuation === true),
              steer: async () => "refused",
            });
      const prompt = adapter.prompt.bind(adapter);
      adapter.prompt = async (text, options) => {
        const result = await prompt(text, options);
        if (options?.continuation && result.stopReason === "end")
          await completionGate?.();
        return result;
      };
      return adapter;
    },
    switchAccount: async (next, admit, options) => {
      switchOptions.push({ ...options });
      admit();
      await moveGate?.();
      admit();
      sessionStore.switchCredentialProfile(
        id,
        profileId,
        next,
        options?.requireEnterprise ? { requireEnterprise: true } : {},
      );
      profileId = next;
      moves.push(next);
      await afterMove?.();
    },
  };
  return {
    id,
    runtime,
    driver,
    calls,
    moves,
    native,
    switchOptions,
    gate: (fn: () => Promise<void>) => {
      moveGate = fn;
    },
    afterMove: (fn: () => Promise<void>) => {
      afterMove = fn;
    },
    failureGate: (fn: () => Promise<void>) => {
      failureGate = fn;
    },
    completionGate: (fn: () => Promise<void>) => {
      completionGate = fn;
    },
    send: (
      options: Parameters<typeof promptRuntimeSessionWithRuntime>[3] = {},
    ) =>
      promptRuntimeSessionWithRuntime(
        runtime,
        driver,
        "original user request",
        options,
      ),
  };
}
function messages(s: ReturnType<typeof setup>) {
  return s.runtime.get(s.id)!.clientTimeline();
}
test("a pi run using an unrelated provider neither benches nor switches its bound OpenAI account", async () => {
  const a = account("pi", "A");
  account("pi", "B");
  const s = setup("pi", a, [{ kind: "quota" }]);
  offers.get(a)!.provider = "github-copilot";
  await s.send().catch(() => {});
  assert.deepEqual(s.moves, []);
  assert.equal(s.calls.length, 1);
  assert.equal(health.readAccountBench(a, "gpt-5.5"), undefined);
});

test("an endpoint session never moves: no failover, and disabled refuses", async () => {
  const endpoint = profiles.createCredentialProfile({
    name: "Team LLM",
    provider: "openai-compatible",
  });
  created.push(endpoint.id);
  offers.set(endpoint.id, { provider: endpoint.id, id: "llama3" });
  account("pi", "B");
  const failing = setup("pi", endpoint.id, [{ kind: "quota" }]);
  await failing.send().catch(() => {});
  assert.deepEqual(failing.moves, []);
  assert.equal(health.readAccountBench(endpoint.id, "llama3"), undefined);
  const s = setup("pi", endpoint.id, [undefined]);
  profiles.setCredentialProfileEnabled(endpoint.id, false);
  await assert.rejects(
    s.send(),
    /Team LLM is disabled and no other eligible account is available\. Enable it to continue this session\./,
  );
  assert.deepEqual(s.moves, []);
  assert.equal(s.calls.length, 0);
  assert.equal(sessionStore.get(s.id)?.credentialProfileId, endpoint.id);
});

const engines = ["pi", "claude-sdk"] as const;
for (const harness of engines) {
  test.each([false, true])(
    `${harness} waits for failed-run termination, even when Stop arrives after failure; stopped=%s`,
    async (stopped) => {
      const a = account(harness, "A");
      const b = account(harness, "B");
      const s = setup(harness, a, [{ kind: "quota" }, undefined]);
      let release!: () => void;
      s.failureGate(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const sent = s.send().catch(() => {});
      await vi.waitFor(() =>
        assert.ok(health.readAccountBench(a, offers.get(a)!.id)),
      );
      assert.equal(s.driver.isRunning, true);
      assert.deepEqual(s.moves, []);
      if (stopped) await s.runtime.get(s.id)!.abort();
      release();
      await sent;
      if (!stopped)
        await vi.waitFor(() => assert.equal(s.driver.credentialProfileId, b));
      else {
        await Promise.resolve();
        assert.deepEqual(s.moves, []);
        assert.equal(s.calls.length, 1);
      }
    },
  );
  test(`${harness} unbound legacy sessions never attribute a default account or switch`, async () => {
    const a = account(harness, "A");
    account(harness, "B");
    const s = setup(harness, a, [{ kind: "quota" }], false, false);
    await s.send().catch(() => {});
    assert.deepEqual(s.moves, []);
    assert.equal(s.calls.length, 1);
    assert.equal(health.readAccountBench(a, offers.get(a)!.id), undefined);
  });
  test.each([{ kind: "server" }, { kind: "quota" }] as RunFailureFacts[])(
    `${harness} isolates a completed continuation from an idle queued failure: %j`,
    async (queuedFailure) => {
      const a = account(harness, "A");
      account(harness, "B");
      const s = setup(harness, a, [
        { kind: "quota" },
        undefined,
        queuedFailure,
      ]);
      let release!: () => void;
      let completed = false;
      let pending = true;
      const outcomes: RunOutcome[] = [];
      const queuedOutcomes: RunOutcome[] = [];
      const completions: string[] = [];
      const unsubscribe = lifecycle.subscribeSessionRunCompleted(
        (id, reason) => {
          if (id === s.id) completions.push(reason);
        },
      );
      s.completionGate(() => {
        completed = true;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      let queued: Promise<void> | undefined;
      let busy = 0;
      lifecycle.setSessionIdleHook((id) => {
        if (id !== s.id || !pending) return;
        pending = false;
        const receipt = promptRuntimeSessionWithRuntime(
          s.runtime,
          s.driver,
          "queued unrelated turn",
        );
        receipt.observe((event) => {
          if (event.type === "run-ended") queuedOutcomes.push(event.outcome);
        });
        queued = receipt.catch((error: unknown) => {
          if (error instanceof SessionBusyError) {
            pending = true;
            busy++;
          }
        });
      });
      const original = s.send();
      original.observe((event) => {
        if (event.type === "run-ended") outcomes.push(event.outcome);
      });
      try {
        await vi.waitFor(() => assert.ok(completed));
        await queued;
        assert.ok(busy > 0);
        assert.equal(s.calls.length, 2);
        assert.equal(outcomes.length, 0);
        release();
        await original;
        await vi.waitFor(() => assert.equal(queuedOutcomes.length, 1));
        await queued;
        assert.equal(outcomes[0]?.stopReason, "end");
        assert.equal(queuedOutcomes[0]?.stopReason, "error");
        assert.notEqual(outcomes[0]?.runId, queuedOutcomes[0]?.runId);
        assert.equal(s.calls.length, 3);
        assert.deepEqual(completions, ["end", "error"]);
      } finally {
        release?.();
        unsubscribe();
        lifecycle.setSessionIdleHook(undefined);
      }
    },
  );
  test.each([undefined, { kind: "server" } as RunFailureFacts])(
    `${harness} defers caller settlement and failure notices until continuation decides: %j`,
    async (terminal) => {
      const a = account(harness, "A");
      account(harness, "B");
      const s = setup(harness, a, [{ kind: "quota" }, terminal]);
      const outcomes: RunOutcome[] = [];
      const completions: string[] = [];
      const unsubscribe = lifecycle.subscribeSessionRunCompleted(
        (id, reason) => {
          if (id === s.id) completions.push(reason);
        },
      );
      const failures: RunFailureReport[] = [];
      lifecycle.setRunFailureHook((report) => {
        failures.push(report);
      });
      let release!: () => void;
      let copying = false;
      s.gate(() => {
        copying = true;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      const receipt = s.send();
      receipt.observe((event) => {
        if (event.type === "run-ended") outcomes.push(event.outcome);
      });
      const sent = receipt.catch((error: unknown) => error);
      try {
        await vi.waitFor(() => assert.ok(copying));
        assert.equal(outcomes.length, 0);
        assert.equal(failures.length, 0);
        assert.equal(completions.length, 0);
        release();
        const error = await sent;
        assert.equal(outcomes.length, 1);
        assert.equal(outcomes[0]?.stopReason, terminal ? "error" : "end");
        assert.equal(error instanceof Error, !!terminal);
        assert.deepEqual(completions, [terminal ? "error" : "end"]);
        if (terminal) assert.equal(failures[0]?.runId, outcomes[0]?.runId);
        assert.deepEqual(
          failures.map((report) => report.failure?.kind),
          terminal ? ["server"] : [],
        );
      } finally {
        release?.();
        unsubscribe();
        lifecycle.setRunFailureHook(undefined);
      }
    },
  );
  test(`${harness} a detached-view Stop hold suppresses a misleading move-failure notice`, async () => {
    const a = account(harness, "A");
    account(harness, "B");
    const s = setup(harness, a, [{ kind: "quota" }]);
    const { holdAutomaticTurns } = await import("./automaticTurnHold.ts");
    let release!: () => void;
    let copying = false;
    s.gate(() => {
      copying = true;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const sent = s.send().catch(() => {});
    await vi.waitFor(() => assert.ok(copying));
    const generation = s.runtime.get(s.id)!.stopGeneration;
    holdAutomaticTurns(s.id);
    release();
    await sent;
    assert.equal(s.runtime.get(s.id)!.stopGeneration, generation);
    assert.deepEqual(s.moves, []);
    assert.ok(!JSON.stringify(messages(s)).includes("could not safely resume"));
  });
  test(`${harness} continuations do not consume new deferred facts or the pending Plan clearing line`, async () => {
    const a = account(harness, "A");
    account(harness, "B");
    const s = setup(harness, a, [{ kind: "quota" }, undefined]);
    const { setDeferredBackgroundContextProvider } =
      await import("./session/runtimePrompt.ts");
    let pending = false;
    let committed = 0;
    let sampled = 0;
    Object.defineProperty(s.driver, "sessionMode", {
      value: "plan",
      writable: true,
    });
    setDeferredBackgroundContextProvider(() => {
      sampled++;
      return pending
        ? {
            block: "NEW DEFERRED FACT",
            observe: (receipt) => {
              receipt.observe((event) => {
                if (event.type !== "appended") return;
                pending = false;
                committed++;
              });
            },
            finished: () => {},
          }
        : undefined;
    });
    s.gate(async () => {
      pending = true;
      Object.defineProperty(s.driver, "sessionMode", { value: "build" });
    });
    try {
      await s.send();
      assert.equal(sampled, 1);
      assert.equal(committed, 0);
      assert.ok(!s.calls[1]!.text.includes("NEW DEFERRED FACT"));
      assert.ok(!s.calls[1]!.text.includes("<session-mode>"));
      await s.send();
      assert.ok(s.calls[2]!.text.includes("NEW DEFERRED FACT"));
      assert.ok(s.calls[2]!.text.includes("Plan-mode restrictions"));
      assert.equal(committed, 1);
      await s.send();
      assert.ok(!s.calls[3]!.text.includes("NEW DEFERRED FACT"));
      assert.ok(!s.calls[3]!.text.includes("<session-mode>"));
    } finally {
      setDeferredBackgroundContextProvider(undefined);
    }
  });
  test.each([
    { kind: "quota" },
    { kind: "rate_limit" },
    { kind: "auth", loginDeath: true },
  ] as RunFailureFacts[])(
    `${harness} resumes after %j without another user entry`,
    async (failure) => {
      const timeZone =
        userProfile.hostTimeZone() === "Pacific/Honolulu"
          ? "Asia/Tokyo"
          : "Pacific/Honolulu";
      vi.spyOn(userProfile, "userTimeZone").mockReturnValue(timeZone);
      const a = account(harness, "Account A");
      const b = account(harness, "Account B");
      const s = setup(harness, a, [failure, undefined]);
      await s.send().catch(() => {});
      await vi.waitFor(() => assert.equal(s.calls.length, 2));
      await vi.waitFor(() =>
        assert.equal(s.runtime.get(s.id)!.isRunning, false),
      );
      assert.deepEqual(s.moves, [b]);
      assert.equal(s.driver.credentialProfileId, b);
      assert.equal(sessionStore.get(s.id)?.credentialProfileId, b);
      assert.equal(s.calls[1]?.continuation, true);
      assert.ok(!s.calls[1]?.text.includes("original user request"));
      assert.ok(
        !s.calls[1]?.text.includes("Account A"),
        "marker is not model context",
      );
      assert.equal(
        messages(s).filter((e) => e.type === "message" && e.role === "user")
          .length,
        1,
      );
      assert.ok(
        JSON.stringify(messages(s)).includes(
          "Switched from Account A to Account B",
        ),
      );
      assert.ok(
        failure.loginDeath
          ? health.readAccountHealth(a, true).state === "needs-login"
          : health.readAccountBench(a, offers.get(a)!.id),
      );
      const bench = health.readAccountBench(a, offers.get(a)!.id);
      if (bench) {
        const text = JSON.stringify(messages(s));
        assert.ok(
          text.includes(
            formatLocalDateTime(new Date(bench.until).toISOString(), timeZone)!,
          ),
        );
        assert.ok(!text.includes(new Date(bench.until).toISOString()));
      }
    },
  );
  test.each([
    [{ kind: "auth", gatewayNeedsLogin: true }, true, true],
    [{ kind: "auth", loginDeath: true }, true, false],
    [{ kind: "auth", gatewayNeedsLogin: true }, false, false],
  ] as [RunFailureFacts, boolean, boolean][])(
    `${harness} 1368 AC10: after %j, gateway-served %s, the session moves: %s`,
    async (failure, served, moves) => {
      // Only `gatewayServesProfile` reads the link here.
      const uninstall = served
        ? installGatewayLink({
            reportsCredentialStatus: true,
          } as unknown as GatewayLink)
        : () => {};
      try {
        const a = account(harness, "Account A");
        const b = account(harness, "Account B");
        const s = setup(harness, a, [failure, undefined]);
        await s.send().catch(() => {});
        if (moves) await vi.waitFor(() => assert.equal(s.calls.length, 2));
        await vi.waitFor(() =>
          assert.equal(s.runtime.get(s.id)!.isRunning, false),
        );
        assert.deepEqual(s.moves, moves ? [b] : []);
        assert.equal(s.calls.length, moves ? 2 : 1);
        assert.equal(
          JSON.stringify(messages(s)).includes(
            "Switched from Account A to Account B — login expired",
          ),
          moves,
        );
      } finally {
        uninstall();
      }
    },
  );
  test.each([1, 2])(
    `${harness} marks usage for every account across %i moves`,
    async (moves) => {
      const a = account(harness, "A");
      const b = account(harness, "B");
      const accounts = [a, b];
      if (moves === 2) accounts.push(account(harness, "C"));
      const s = setup(harness, a, [
        ...Array.from({ length: moves }, () => ({ kind: "quota" as const })),
        undefined,
      ]);
      const dirty = vi
        .spyOn(usageCache, "markUsageProfileDirty")
        .mockImplementation(() => {});
      // The boot completion subscriber marks the current account, while recovery
      // must also dirty all moved-from accounts before this deferred completion.
      const unsubscribe = lifecycle.subscribeSessionRunCompleted(
        (sessionId) => {
          if (sessionId !== s.id) return;
          const profile = usageProfileForSession(sessionStore.get(sessionId));
          if (profile) usageCache.markUsageProfileDirty(profile);
        },
      );
      try {
        await s.send();
        assert.equal(s.moves.length, moves);
        assert.deepEqual(
          dirty.mock.calls.map(([profile]) => profile),
          s.calls.map((call) => call.profileId),
        );
        assert.deepEqual(
          dirty.mock.calls.map(([profile]) => profile).sort(),
          accounts.sort(),
        );
      } finally {
        unsubscribe();
      }
    },
  );
  test(`${harness} a throwing notice append cannot reject the recovery pump`, async () => {
    const a = account(harness, "A");
    const s = setup(harness, a, [{ kind: "quota" }]);
    let release: (() => void) | undefined;
    s.failureGate(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const sent = s.send().catch((error: unknown) => error);
    await vi.waitFor(() => assert.ok(release));
    const live = s.runtime.get(s.id)!;
    const append = vi.spyOn(live, "appendNotice").mockImplementation(() => {
      throw new Error("secret filesystem path /private/transcript");
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    release!();
    await sent;
    assert.equal(
      append.mock.calls.length,
      2,
      "both recovery and its catch-path tried the notice",
    );
    assert.deepEqual(warning.mock.calls, [
      ["[account-switch] Could not append the recovery notice."],
    ]);
    assert.equal(live.isRunning, false);
    append.mockRestore();
    await s.send();
    assert.equal(
      s.calls.length,
      2,
      "recovery admission released despite the failed append",
    );
    await s.runtime.disposeSession(s.id);
    const before = live.getSnapshot().entries.length;
    live.appendNotice("late recovery notice");
    assert.equal(
      live.getSnapshot().entries.length,
      before,
      "teardown ignores late notices",
    );
  });
  test(`${harness} exhausts each account once, never selecting a degraded bench`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const c = account(harness, "C");
    const s = setup(
      harness,
      a,
      Array.from({ length: 4 }, () => ({ kind: "quota" as const })),
    );
    await s.send().catch(() => {});
    await vi.waitFor(() =>
      assert.ok(
        JSON.stringify(messages(s)).includes("No other eligible account"),
      ),
    );
    assert.deepEqual([...s.moves].sort(), [b, c].sort());
    assert.equal(new Set(s.moves).size, 2);
    assert.equal(s.calls.length, 3);
    assert.equal(sessionStore.get(s.id)?.credentialProfileId, s.moves.at(-1));
  });
  test(`${harness} enterprise scope refuses personal-only replacements`, async () => {
    const a = account(harness, "Enterprise", true);
    account(harness, "Personal");
    const s = setup(harness, a, [{ kind: "quota" }], true);
    await s.send().catch(() => {});
    await vi.waitFor(() =>
      assert.ok(
        JSON.stringify(messages(s)).includes("No other eligible account"),
      ),
    );
    assert.deepEqual(s.moves, []);
  });
  test.each([
    { kind: "auth" },
    { kind: "server" },
    { kind: "unknown" },
    { kind: "content_policy" },
  ] as RunFailureFacts[])(
    `${harness} never switches for unrelated %j`,
    async (failure) => {
      const a = account(harness, "A");
      account(harness, "B");
      const s = setup(harness, a, [failure]);
      await s.send().catch(() => {});
      await Promise.resolve();
      assert.deepEqual(s.moves, []);
      assert.equal(s.calls.length, 1);
    },
  );
  test(`${harness} holds admission during a move and Stop cancels before commit`, async () => {
    const a = account(harness, "A");
    account(harness, "B");
    const s = setup(harness, a, [{ kind: "quota" }]);
    let release!: () => void;
    let copying = false;
    s.gate(() => {
      copying = true;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const sent = s.send().catch(() => {});
    await vi.waitFor(() => assert.ok(copying));
    await assert.rejects(
      promptRuntimeSessionWithRuntime(s.runtime, s.driver, "another input"),
      { name: "AccountSwitchInProgressError", message: /switching accounts/ },
    );
    await s.runtime.get(s.id)!.abort();
    release();
    await sent;
    assert.deepEqual(s.moves, []);
    assert.equal(s.calls.length, 1);
    assert.equal(sessionStore.get(s.id)?.credentialProfileId, a);
  });
}

const CYBER: RunFailureFacts = { kind: "content_policy", cyberRefusal: true };

/** The send's final outcome, once its deferred settlement decided it. */
async function finalOutcome(
  sent: ReturnType<ReturnType<typeof setup>["send"]>,
): Promise<RunOutcome | undefined> {
  let outcome: RunOutcome | undefined;
  sent.observe((event) => {
    if (event.type === "run-ended") outcome = event.outcome;
  });
  await sent.catch(() => {});
  return outcome;
}

for (const harness of engines) {
  test(`${harness} a cybersecurity refusal on a personal account moves once to an enterprise account and continues`, async () => {
    const a = account(harness, "A");
    account(harness, "Other personal");
    const e = account(harness, "Work", true);
    const s = setup(harness, a, [CYBER, undefined]);
    const outcome = await finalOutcome(s.send());
    await vi.waitFor(() => assert.equal(s.calls.length, 2));
    assert.deepEqual(s.moves, [e]);
    assert.deepEqual(s.switchOptions, [{ requireEnterprise: true }]);
    assert.equal(sessionStore.get(s.id)?.credentialProfileId, e);
    assert.equal(sessionStore.get(s.id)?.requiresEnterprise, true);
    assert.deepEqual(
      s.calls.map((call) => [call.profileId, call.continuation]),
      [
        [a, false],
        [e, true],
      ],
    );
    assert.equal(outcome?.stopReason, "end");
    assert.ok(
      JSON.stringify(messages(s)).includes(
        "Switched from A to Work — cybersecurity refusal. This session now requires an enterprise account.",
      ),
    );
  });
  test(`${harness} a cybersecurity refusal with no eligible enterprise account stays and keeps the failure`, async () => {
    const a = account(harness, "A");
    account(harness, "Other personal");
    const disabled = account(harness, "Disabled work", true);
    profiles.setCredentialProfileEnabled(disabled, false);
    const s = setup(harness, a, [CYBER]);
    const outcome = await finalOutcome(s.send());
    await vi.waitFor(() =>
      assert.ok(
        JSON.stringify(messages(s)).includes(
          "No enterprise account is available for this cybersecurity refusal. This session remains on A.",
        ),
      ),
    );
    assert.deepEqual(s.moves, []);
    assert.equal(s.calls.length, 1);
    assert.equal(outcome?.stopReason, "error");
    assert.equal(sessionStore.get(s.id)?.credentialProfileId, a);
    assert.equal(sessionStore.get(s.id)?.requiresEnterprise, undefined);
  });
  test(`${harness} refused again on the enterprise account it moved to, the failure stands`, async () => {
    const a = account(harness, "A");
    const e1 = account(harness, "Work 1", true);
    const e2 = account(harness, "Work 2", true);
    const s = setup(harness, a, [CYBER, CYBER, undefined]);
    const outcome = await finalOutcome(s.send());
    await vi.waitFor(() => assert.equal(s.calls.length, 2));
    await Promise.resolve();
    assert.equal(s.moves.length, 1, "one move in total");
    assert.ok([e1, e2].includes(s.moves[0]!));
    assert.equal(s.calls.length, 2);
    assert.equal(outcome?.stopReason, "error");
    assert.equal(sessionStore.get(s.id)?.requiresEnterprise, true);
  });
  test(`${harness} a cybersecurity refusal on an enterprise account never moves`, async () => {
    const e1 = account(harness, "Work 1", true);
    account(harness, "Work 2", true);
    const s = setup(harness, e1, [CYBER]);
    const outcome = await finalOutcome(s.send());
    await Promise.resolve();
    assert.deepEqual(s.moves, []);
    assert.equal(s.calls.length, 1);
    assert.equal(outcome?.stopReason, "error");
  });
  test(`${harness} a session required to be enterprise moves before its next turn`, async () => {
    const a = account(harness, "A");
    account(harness, "Other personal");
    const e = account(harness, "Work", true);
    const s = setup(harness, a, [undefined]);
    sessionStore.requireEnterprise(s.id);
    await s.send();
    assert.deepEqual(s.moves, [e]);
    assert.deepEqual(s.switchOptions, [
      { allowWithoutHistory: true, requireEnterprise: true },
    ]);
    assert.deepEqual(
      s.calls.map((call) => call.profileId),
      [e],
    );
    assert.ok(
      JSON.stringify(messages(s)).includes(
        "Switched from A to Work — this session requires an enterprise account.",
      ),
    );
  });
  test(`${harness} a session required to be enterprise with none eligible refuses the turn`, async () => {
    const a = account(harness, "A");
    account(harness, "Other personal");
    const s = setup(harness, a, [undefined]);
    sessionStore.requireEnterprise(s.id);
    await assert.rejects(
      s.send(),
      /This session requires an enterprise account, and no eligible enterprise account is available\. It remains on A\./,
    );
    assert.deepEqual(s.moves, []);
    assert.equal(s.calls.length, 0);
    assert.equal(s.runtime.get(s.id)?.clientTimeline().length ?? 0, 0);
  });
  test(`${harness} a session already on an enterprise account does not move for the requirement`, async () => {
    const e = account(harness, "Work", true);
    account(harness, "Work 2", true);
    const s = setup(harness, e, [undefined], true);
    await s.send();
    assert.deepEqual(s.moves, []);
    assert.deepEqual(
      s.calls.map((call) => call.profileId),
      [e],
    );
  });
}

for (const harness of engines) {
  test(`${harness} moves off a disabled account before its next turn starts`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const s = setup(harness, a, [undefined]);
    profiles.setCredentialProfileEnabled(a, false);
    await s.send();
    assert.deepEqual(s.moves, [b]);
    assert.deepEqual(
      s.calls.map((call) => call.profileId),
      [b],
    );
    assert.ok(
      JSON.stringify(messages(s)).includes(
        "Switched from A to B — A is disabled.",
      ),
    );
  });
  test.each([false, true])(
    `${harness} refuses the turn when disabling left no eligible account; enterprise=%s`,
    async (enterprise) => {
      const a = account(harness, "A", enterprise);
      if (enterprise) account(harness, "Personal");
      const s = setup(harness, a, [undefined], enterprise);
      profiles.setCredentialProfileEnabled(a, false);
      await assert.rejects(
        s.send(),
        /A is disabled and no other eligible account is available/,
      );
      assert.deepEqual(s.moves, []);
      assert.equal(s.calls.length, 0);
    },
  );
}

for (const harness of engines) {
  test(`${harness} a pre-turn move refused at final admission appends no marker`, async () => {
    const a = account(harness, "A");
    account(harness, "B");
    const s = setup(harness, a, [undefined]);
    profiles.setCredentialProfileEnabled(a, false);
    await assert.rejects(
      s.send({
        admit: () => {
          throw new Error("caller refused admission");
        },
      }),
      /caller refused admission/,
    );
    assert.equal(s.calls.length, 0);
    assert.ok(
      !JSON.stringify(s.runtime.get(s.id)?.clientTimeline() ?? []).includes(
        "Switched from",
      ),
    );
  });
  test(`${harness} a Stop during the pre-turn move keeps the binding`, async () => {
    const a = account(harness, "A");
    account(harness, "B");
    const s = setup(harness, a, [undefined]);
    profiles.setCredentialProfileEnabled(a, false);
    const { holdAutomaticTurns } = await import("./automaticTurnHold.ts");
    s.gate(async () => holdAutomaticTurns(s.id));
    await assert.rejects(s.send());
    assert.deepEqual(s.moves, []);
    assert.equal(s.driver.credentialProfileId, a);
    assert.equal(s.calls.length, 0);
  });
  test(`${harness} a target that needs login mid-move keeps the binding`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const s = setup(harness, a, [undefined]);
    profiles.setCredentialProfileEnabled(a, false);
    s.gate(async () =>
      health.reportAccountRunFailure(
        b,
        { kind: "auth", loginDeath: true },
        offers.get(b)!.provider,
        health.observeAccountHealth(b),
      ),
    );
    await assert.rejects(s.send(), /B became unavailable/);
    assert.deepEqual(s.moves, []);
    assert.equal(s.driver.credentialProfileId, a);
  });
}

test("pi retries without encrypted reasoning when the account it was moved to rejects it", async () => {
  const a = account("pi", "A");
  const b = account("pi", "B");
  const s = setup("pi", a, [
    { kind: "server", encryptedReasoningRejected: true },
    undefined,
  ]);
  let drops = 0;
  s.driver.dropEncryptedReasoning = async (admit) => {
    admit();
    drops += 1;
    return true;
  };
  profiles.setCredentialProfileEnabled(a, false);
  await s.send();
  assert.deepEqual(s.moves, [b]);
  assert.equal(drops, 1);
  assert.deepEqual(
    s.calls.map((call) => [call.profileId, call.continuation]),
    [
      [b, false],
      [b, true],
    ],
  );
});

for (const harness of engines) {
  test(`${harness} a target that needs login after the move commits refuses the turn`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const s = setup(harness, a, [undefined]);
    profiles.setCredentialProfileEnabled(a, false);
    s.afterMove(async () =>
      health.reportAccountRunFailure(
        b,
        { kind: "auth", loginDeath: true },
        offers.get(b)!.provider,
        health.observeAccountHealth(b),
      ),
    );
    await assert.rejects(s.send(), /B became unavailable/);
    assert.equal(s.calls.length, 0);
    assert.ok(
      !JSON.stringify(s.runtime.get(s.id)?.clientTimeline() ?? []).includes(
        "Switched from",
      ),
    );
  });
  test(`${harness} a steer-only message to an idle session on a disabled account moves nothing`, async () => {
    const a = account(harness, "A");
    account(harness, "B");
    const s = setup(harness, a, [undefined]);
    profiles.setCredentialProfileEnabled(a, false);
    await assert.rejects(s.send({ steer: true, steerOnly: true }));
    assert.deepEqual(s.moves, []);
    assert.equal(s.calls.length, 0);
    assert.ok(
      !JSON.stringify(s.runtime.get(s.id)?.clientTimeline() ?? []).includes(
        "Switched from",
      ),
    );
  });
}

test("pi keeps a refused turn's move for the encrypted-reasoning retry of the next run", async () => {
  const a = account("pi", "A");
  const b = account("pi", "B");
  const s = setup("pi", a, [
    { kind: "server", encryptedReasoningRejected: true },
    undefined,
  ]);
  let drops = 0;
  s.driver.dropEncryptedReasoning = async (admit) => {
    admit();
    drops += 1;
    return true;
  };
  profiles.setCredentialProfileEnabled(a, false);
  await assert.rejects(
    s.send({
      admit: () => {
        throw new Error("caller refused admission");
      },
    }),
    /caller refused admission/,
  );
  assert.deepEqual(s.moves, [b]);
  await s.send();
  assert.equal(drops, 1);
  assert.deepEqual(
    s.calls.map((call) => [call.profileId, call.continuation]),
    [
      [b, false],
      [b, true],
    ],
  );
});

/* ------------------------------------------------------------------------ *
 * The pending runtime selection (Task-1485): a model, effort or account the
 * user or an owning coordinator picks is applied when the next turn of any
 * origin is admitted, and held, never dropped, while it cannot apply.
 * ------------------------------------------------------------------------ */

const { accountMoveTargets, setAccountMoveHostForTests } =
  await import("./sessionAccountMove.ts");
const {
  setSessionPendingRuntime,
  clearSessionPendingRuntime,
  setPendingRuntimeHostForTests,
  PendingRuntimeHeldError,
} = await import("./sessionPendingRuntime.ts");
const { AutomaticTurnsHeldError } = await import("./automaticTurnHold.ts");
const { AccountSwitchBlockedError, reserveAccountRecovery: reserve } =
  await import("./session/runtime/accountRecoveryAdmission.ts");
const leases = await import("./session/sessionRunLease.ts");

/** Route list reads through this fixture's runtime; record re-offers. */
function host(s: ReturnType<typeof setup>): string[] {
  const wakes: string[] = [];
  setAccountMoveHostForTests({
    resident: async () => (s.runtime.get(s.id) ? s.driver : undefined),
  });
  setPendingRuntimeHostForTests({
    stateChanged: async () => {},
    publishRows: async () => {},
    wake: (id) => wakes.push(id),
  });
  return wakes;
}

function choose(
  s: ReturnType<typeof setup>,
  target: string,
  setBy: "user" | "coordinator" = "user",
) {
  return setSessionPendingRuntime(
    s.id,
    { account: { kind: "account", id: target } },
    setBy,
  );
}

function bigModel(harness: Harness) {
  const provider = harness === "pi" ? "openai-codex" : "claude-sdk";
  return { provider, id: second(provider) };
}

/** Nothing the turn held is still held: a new turn may start. */
function released(s: ReturnType<typeof setup>) {
  assert.equal(s.runtime.isBusy(s.id), false, "harness admission released");
  assertAccountRecoveryAdmission(s.id);
  leases.assertSessionRunnable(s.id);
}

function markers(s: ReturnType<typeof setup>): string[] {
  return (JSON.stringify(s.runtime.get(s.id)?.clientTimeline() ?? []).match(
    /Switched from [^"]*/g,
  ) ?? []) as string[];
}

/** The model a session that is not loaded names, as its stored row holds it. */
function stored(s: ReturnType<typeof setup>, account: string) {
  const model = offers.get(account)!;
  sessionStore.upsert({
    id: s.id,
    harness: sessionStore.get(s.id)!.harness,
    agentType: "assistant",
    provider: model.provider,
    model: model.id,
    thinkingLevel: "off",
  });
}

const otherKind = (harness: Harness): Harness =>
  harness === "pi" ? "claude-sdk" : "pi";

const { assertAccountRecoveryAdmission } =
  await import("./session/runtime/accountRecoveryAdmission.ts");

for (const harness of engines) {
  test(`${harness} a pending account applies when the next turn starts, not before`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const s = setup(harness, a, [undefined, undefined]);
    host(s);
    await s.send();
    const pending = await choose(s, b);
    assert.deepEqual(pending?.account, { kind: "account", id: b });
    // Setting it changes nothing about the engine.
    assert.equal(sessionStore.get(s.id)?.credentialProfileId, a);
    assert.deepEqual(s.moves, []);
    assert.deepEqual(markers(s), []);
    assert.deepEqual(sessionStore.get(s.id)?.pendingRuntime, pending);
    await s.send();
    assert.equal(sessionStore.get(s.id)?.credentialProfileId, b);
    assert.deepEqual(s.moves, [b]);
    assert.deepEqual(s.switchOptions, [{ allowWithoutHistory: true }]);
    assert.deepEqual(markers(s), ["Switched from A to B — chosen by you."]);
    assert.deepEqual(
      s.calls.map((call) => call.profileId),
      [a, b],
    );
    assert.equal(sessionStore.get(s.id)?.pendingRuntime, undefined);
    assert.deepEqual(s.native, []);
    released(s);
  });

  test(`${harness} a coordinator's pending move says so in its marker`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const s = setup(harness, a, [undefined]);
    host(s);
    stored(s, a);
    await choose(s, b, "coordinator");
    await s.send();
    assert.deepEqual(markers(s), [
      "Switched from A to B — chosen by its coordinating session.",
    ]);
  });

  test(`${harness} model and effort apply at admission through the adapter; Automatic keeps the bound account`, async () => {
    const a = account(harness, "A");
    account(harness, "B");
    const s = setup(harness, a, [undefined, undefined]);
    host(s);
    await s.send();
    const pending = await setSessionPendingRuntime(
      s.id,
      { model: bigModel(harness), thinkingLevel: "high" },
      "user",
    );
    assert.deepEqual(pending, {
      model: bigModel(harness),
      thinkingLevel: "high",
      account: { kind: "automatic" },
      setBy: "user",
    });
    assert.deepEqual(s.native, [], "no native trace before the turn");
    await s.send();
    assert.deepEqual(s.native, [
      `model:${bigModel(harness).id}`,
      "effort:high",
    ]);
    assert.deepEqual(s.driver.modelSelection?.(), {
      model: bigModel(harness),
      thinkingLevel: "high",
    });
    assert.deepEqual(
      s.moves,
      [],
      "Automatic stays on an account that can run it",
    );
    assert.equal(sessionStore.get(s.id)?.pendingRuntime, undefined);
  });

  test(`${harness} Automatic routes only when the bound account cannot run the target`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const s = setup(harness, a, [undefined, undefined]);
    host(s);
    await s.send();
    await setSessionPendingRuntime(s.id, { model: bigModel(harness) }, "user");
    health.reportAccountRunFailure(
      a,
      {
        kind: "quota",
        limitModel: bigModel(harness).id,
        resetAtMs: Date.now() + 3_600_000,
      },
      offers.get(a)!.provider,
      health.observeAccountHealth(a),
    );
    await s.send();
    assert.deepEqual(s.moves, [b]);
    assert.equal(s.driver.modelSelection?.().model?.id, bigModel(harness).id);
  });

  test(`${harness} effort is clamped to the target model; a target equal to now clears`, async () => {
    const a = account(harness, "A");
    const s = setup(harness, a, [undefined]);
    host(s);
    await s.send();
    // The session's model has no thinking budget: "high" clamps to "off",
    // which is what it runs now, so nothing is pending.
    assert.equal(
      await setSessionPendingRuntime(s.id, { thinkingLevel: "high" }, "user"),
      undefined,
    );
    assert.equal(sessionStore.get(s.id)?.pendingRuntime, undefined);
    await setSessionPendingRuntime(s.id, { model: bigModel(harness) }, "user");
    assert.ok(sessionStore.get(s.id)?.pendingRuntime);
    await setSessionPendingRuntime(s.id, { model: offers.get(a)! }, "user");
    assert.equal(sessionStore.get(s.id)?.pendingRuntime, undefined);
  });

  test(`${harness} a reset leaves no trace: no native change, no move`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const s = setup(harness, a, [undefined, undefined]);
    const wakes = host(s);
    await s.send();
    await setSessionPendingRuntime(
      s.id,
      {
        model: bigModel(harness),
        thinkingLevel: "high",
        account: { kind: "account", id: b },
      },
      "user",
    );
    await clearSessionPendingRuntime(s.id);
    assert.equal(sessionStore.get(s.id)?.pendingRuntime, undefined);
    await s.send();
    assert.deepEqual(s.native, []);
    assert.deepEqual(s.moves, []);
    assert.deepEqual(markers(s), []);
    assert.deepEqual(wakes, [s.id, s.id], "each change re-offers held work");
  });

  test(`${harness} a steer into a running turn never applies it`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const s = setup(harness, a, [undefined, undefined]);
    host(s);
    await s.send();
    await choose(s, b);
    const running = Object.create(s.driver, {
      isRunning: { get: () => true },
    }) as RuntimePromptDriver;
    await promptRuntimeSessionWithRuntime(s.runtime, running, "steer", {
      steer: true,
    }).catch(() => {});
    assert.deepEqual(s.moves, []);
    assert.ok(sessionStore.get(s.id)?.pendingRuntime, "still pending");
  });

  test(`${harness} every new turn applies it, whatever its origin`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const origins: Parameters<ReturnType<typeof setup>["send"]>[0][] = [
      { clientRequestId: "queued:row" },
      { origin: { kind: "agent", agentId: "peer-session" } },
      {
        hidden: true,
        origin: { kind: "system", source: "background-work" },
      },
      {
        hidden: true,
        continuation: true,
        origin: { kind: "system", source: "post-reload" },
      },
    ];
    for (const options of origins) {
      const s = setup(harness, a, [undefined]);
      host(s);
      stored(s, a);
      await choose(s, b);
      await s.send(options);
      assert.deepEqual(s.moves, [b], JSON.stringify(options));
      assert.equal(sessionStore.get(s.id)?.pendingRuntime, undefined);
    }
  });

  test(`${harness} an account-recovery continuation leaves it pending`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const s = setup(harness, a, [undefined, undefined]);
    host(s);
    stored(s, a);
    await choose(s, b);
    const ticket = reserve(s.id);
    await s
      .send({ continuation: true, hidden: true, accountRecovery: ticket })
      .catch(() => {});
    assert.deepEqual(s.moves, []);
    assert.ok(sessionStore.get(s.id)?.pendingRuntime);
  });

  test(`${harness} a target that cannot run holds the turn: pending kept, reason shown, nothing runs`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const s = setup(harness, a, [undefined, undefined]);
    const wakes = host(s);
    await s.send();
    await choose(s, b);
    health.reportAccountRunFailure(
      b,
      { kind: "auth", loginDeath: true },
      offers.get(b)!.provider,
      health.observeAccountHealth(b),
    );
    const held = await s.send().catch((error: unknown) => error);
    assert.ok(held instanceof PendingRuntimeHeldError);
    // A Stop's hold class: every lane keeps its work and spends no attempt.
    assert.ok(held instanceof AutomaticTurnsHeldError);
    assert.equal(
      held.message,
      "Couldn't switch to Test model · B: B needs login. The change is still pending; change or reset it to continue.",
    );
    assert.equal(sessionStore.get(s.id)?.lastError?.message, held.message);
    assert.ok(sessionStore.get(s.id)?.pendingRuntime, "still pending");
    assert.equal(sessionStore.get(s.id)?.credentialProfileId, a);
    assert.equal(s.calls.length, 1, "nothing ran, on neither account");
    assert.deepEqual(s.moves, []);
    released(s);
    // A reset offers the held work again; it runs where the session is.
    wakes.length = 0;
    await clearSessionPendingRuntime(s.id);
    assert.deepEqual(wakes, [s.id]);
    await s.send();
    assert.deepEqual(
      s.calls.map((call) => call.profileId),
      [a, a],
    );
  });

  test(`${harness} background work holding the engine holds the switch with its reason`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const s = setup(harness, a, [undefined]);
    host(s);
    stored(s, a);
    await choose(s, b);
    s.driver.switchAccount = async () => {
      throw new AccountSwitchBlockedError(
        "Background work still holds this session's Claude host. Stop it before switching accounts.",
      );
    };
    const held = await s.send().catch((error: unknown) => error);
    assert.ok(held instanceof PendingRuntimeHeldError);
    assert.equal(
      held.message,
      `Waiting for background work on ${harness === "pi" ? "OpenAI" : "Claude"}; stop it to switch now.`,
    );
    assert.equal(s.calls.length, 0);
    assert.ok(sessionStore.get(s.id)?.pendingRuntime);
  });

  test(`${harness} a target outside the session's engine or one that could never run is refused when set`, async () => {
    const a = account(harness, "A");
    const disabled = account(harness, "Off");
    profiles.setCredentialProfileEnabled(disabled, false);
    const other = account(otherKind(harness), "Other kind");
    const unoffered = account(harness, "No model");
    offers.delete(unoffered);
    const s = setup(harness, a, []);
    host(s);
    stored(s, a);
    for (const [target, reason] of [
      ["cp_missing", /^The chosen account no longer exists\.$/],
      [disabled, /^Off is disabled\.$/],
      [other, /^Other kind is not the same kind of account as A\.$/],
      [unoffered, /^No model does not offer Test model\.$/],
    ] as const) {
      await assert.rejects(choose(s, target), { message: reason }, target);
      assert.equal(sessionStore.get(s.id)?.pendingRuntime, undefined);
    }
    await assert.rejects(
      setSessionPendingRuntime(
        s.id,
        { model: bigModel(otherKind(harness)) },
        "user",
      ),
      /runs on another harness; moving a session between harnesses is not available yet\.$/,
    );
    await assert.rejects(
      setSessionPendingRuntime(
        s.id,
        { model: { provider: offers.get(a)!.provider, id: "no-such-model" } },
        "user",
      ),
      { message: "no-such-model is not an available model." },
    );
    assert.deepEqual(s.moves, []);
  });

  test(`${harness} an enterprise-only session takes only enterprise accounts`, async () => {
    const e1 = account(harness, "Work", true);
    const e2 = account(harness, "Work 2", true);
    const personal = account(harness, "Personal");
    const s = setup(harness, e1, [undefined], true);
    stored(s, e1);
    host(s);
    const listed = (await accountMoveTargets(s.id)).map(({ id }) => id);
    assert.ok(listed.includes(e2));
    assert.ok(!listed.includes(personal));
    await assert.rejects(choose(s, personal), {
      message:
        "This session requires an enterprise account, and Personal is not one.",
    });
    await choose(s, e2);
    await s.send();
    assert.equal(sessionStore.get(s.id)?.credentialProfileId, e2);
    assert.equal(sessionStore.get(s.id)?.requiresEnterprise, true);
    assert.deepEqual(s.switchOptions, [
      { allowWithoutHistory: true, requireEnterprise: true },
    ]);
  });

  test(`${harness} the move list is judged against the pending model`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const s = setup(harness, a, []);
    stored(s, a);
    host(s);
    assert.ok((await accountMoveTargets(s.id)).some(({ id }) => id === b));
    await setSessionPendingRuntime(s.id, { model: bigModel(harness) }, "user");
    health.reportAccountRunFailure(
      b,
      {
        kind: "quota",
        limitModel: bigModel(harness).id,
        resetAtMs: Date.now() + 3_600_000,
      },
      offers.get(b)!.provider,
      health.observeAccountHealth(b),
    );
    assert.ok(!(await accountMoveTargets(s.id)).some(({ id }) => id === b));
  });

  test(`${harness} a session of another scope, deleted, unbound or on an endpoint cannot take an account`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const unbound = setup(harness, a, [], false, false);
    stored(unbound, a);
    host(unbound);
    await assert.rejects(choose(unbound, b), {
      message: "This session has no account to move from.",
    });
    await assert.rejects(accountMoveTargets(unbound.id), {
      message: "This session has no account to move from.",
    });
    const endpoint = profiles.createCredentialProfile({
      name: "Team LLM",
      provider: "openai-compatible",
    });
    created.push(endpoint.id);
    offers.set(endpoint.id, { provider: endpoint.id, id: "llama3" });
    const onEndpoint = setup("pi", endpoint.id, []);
    stored(onEndpoint, endpoint.id);
    host(onEndpoint);
    await assert.rejects(choose(onEndpoint, b), {
      message:
        "Team LLM is the only account that serves this session's model, so the session cannot move.",
    });
    const deleted = setup(harness, a, []);
    host(deleted);
    sessionStore.markDeleted(deleted.id);
    await assert.rejects(choose(deleted, b), {
      message: "Session does not exist or was deleted.",
    });
  });
}

test("pi counts the run after a pending move as moved for its encrypted-reasoning retry", async () => {
  const a = account("pi", "A");
  const b = account("pi", "B");
  const s = setup("pi", a, [
    { kind: "server", encryptedReasoningRejected: true },
    undefined,
  ]);
  let drops = 0;
  s.driver.dropEncryptedReasoning = async (admit) => {
    admit();
    drops += 1;
    return true;
  };
  host(s);
  stored(s, a);
  await choose(s, b);
  await s.send();
  assert.equal(drops, 1);
  assert.deepEqual(
    s.calls.map((call) => [call.profileId, call.continuation]),
    [
      [b, false],
      [b, true],
    ],
  );
});

/* ---------------------------------------------------------------------------
 * The selection stays pending until its turn is admitted on it (R2-A2 F006),
 * and its sets and resets are linearizable per session (F007).
 * ------------------------------------------------------------------------ */

for (const harness of engines) {
  test(`${harness} a chosen account that loses its login after the move commits holds the turn and stays pending`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const s = setup(harness, a, [undefined]);
    host(s);
    stored(s, a);
    await choose(s, b);
    s.afterMove(async () => {
      health.reportAccountRunFailure(
        b,
        { kind: "auth", loginDeath: true },
        offers.get(b)!.provider,
        health.observeAccountHealth(b),
      );
    });
    const held = await s.send().catch((error: unknown) => error);
    assert.ok(held instanceof PendingRuntimeHeldError);
    assert.match(held.message, /B needs login/);
    assert.equal(sessionStore.get(s.id)?.lastError?.message, held.message);
    assert.equal(s.calls.length, 0, "nothing ran on the ineligible target");
    assert.deepEqual(sessionStore.get(s.id)?.pendingRuntime?.account, {
      kind: "account",
      id: b,
    });
    released(s);
  });

  test(`${harness} a chosen account disabled after the move commits holds the turn; nothing moves off it`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    account(harness, "C");
    const s = setup(harness, a, [undefined]);
    host(s);
    stored(s, a);
    await choose(s, b);
    s.afterMove(async () => {
      profiles.setCredentialProfileEnabled(b, false);
    });
    const held = await s.send().catch((error: unknown) => error);
    assert.ok(held instanceof PendingRuntimeHeldError);
    assert.match(held.message, /B is disabled/);
    assert.equal(s.calls.length, 0);
    assert.deepEqual(s.moves, [b], "no fallback move to another account");
    assert.ok(sessionStore.get(s.id)?.pendingRuntime, "a refusal keeps it");
    released(s);
  });

  test(`${harness} a chosen account that stops offering the model while it applies holds the turn`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const s = setup(harness, a, [undefined]);
    host(s);
    stored(s, a);
    await choose(s, b);
    s.afterMove(async () => {
      offers.delete(b);
    });
    const held = await s.send().catch((error: unknown) => error);
    assert.ok(held instanceof PendingRuntimeHeldError);
    assert.match(held.message, /B does not offer/);
    assert.equal(s.calls.length, 0);
    assert.ok(sessionStore.get(s.id)?.pendingRuntime);
  });

  test(`${harness} a turn refused at its final admission keeps the selection; the admitted one spends it`, async () => {
    const a = account(harness, "A");
    const s = setup(harness, a, [undefined]);
    host(s);
    stored(s, a);
    await setSessionPendingRuntime(s.id, { model: bigModel(harness) }, "user");
    await assert.rejects(
      s.send({
        admit: () => {
          throw new Error("the delivery's reservation is gone");
        },
      }),
      /reservation is gone/,
    );
    assert.equal(s.calls.length, 0);
    assert.deepEqual(
      sessionStore.get(s.id)?.pendingRuntime?.model,
      bigModel(harness),
      "not spent by a turn that was never admitted",
    );
    await s.send();
    assert.equal(s.calls.length, 1);
    assert.equal(sessionStore.get(s.id)?.pendingRuntime, undefined);
  });

  test(`${harness} concurrent partial changes both land, in request order`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const s = setup(harness, a, []);
    host(s);
    stored(s, a);
    await Promise.all([
      setSessionPendingRuntime(s.id, { model: bigModel(harness) }, "user"),
      choose(s, b),
      setSessionPendingRuntime(s.id, { thinkingLevel: "high" }, "user"),
    ]);
    const pending = sessionStore.get(s.id)?.pendingRuntime;
    assert.deepEqual(pending?.model, bigModel(harness));
    assert.deepEqual(pending?.account, { kind: "account", id: b });
    assert.equal(pending?.thinkingLevel, "high");
  });

  test(`${harness} a reset is never undone by a set asked for before it`, async () => {
    const a = account(harness, "A");
    const s = setup(harness, a, []);
    host(s);
    stored(s, a);
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    setAccountMoveHostForTests({
      resident: async () => {
        entered();
        await gate;
        return undefined;
      },
    });
    const setting = setSessionPendingRuntime(
      s.id,
      { model: bigModel(harness) },
      "user",
    );
    await reading;
    const reset = clearSessionPendingRuntime(s.id);
    release();
    await Promise.all([setting, reset]);
    assert.equal(sessionStore.get(s.id)?.pendingRuntime, undefined);
  });

  test(`${harness} a set racing the admission that spent the selection computes from what the session now runs`, async () => {
    const a = account(harness, "A");
    const s = setup(harness, a, []);
    host(s);
    stored(s, a);
    await setSessionPendingRuntime(s.id, { model: bigModel(harness) }, "user");
    let reads = 0;
    setAccountMoveHostForTests({
      resident: async () => {
        // The first read races a turn's admission: it applies the pending
        // big model and spends the selection.
        if (reads++ === 0) {
          sessionStore.upsert({
            id: s.id,
            harness,
            agentType: "assistant",
            provider: bigModel(harness).provider,
            model: bigModel(harness).id,
          });
          sessionStore.setPendingRuntime(s.id, null);
        }
        return undefined;
      },
    });
    // Back to the model it ran before: from the big model, that is a change.
    await setSessionPendingRuntime(s.id, { model: offers.get(a)! }, "user");
    assert.deepEqual(
      sessionStore.get(s.id)?.pendingRuntime?.model,
      offers.get(a),
    );
  });
}

test("stopping the background work a pending switch waits for offers the held turn again", async () => {
  const { BackgroundCompletionDelivery } =
    await import("./backgroundWork/completionDelivery.ts");
  const { completionDisposition } =
    await import("./backgroundCompletionNotices.ts");
  const { setDeliveryWake } = await import("./deliveryWake.ts");
  const a = account("claude-sdk", "A");
  const b = account("claude-sdk", "B");
  const s = setup("claude-sdk", a, [undefined]);
  host(s);
  stored(s, a);
  await choose(s, b);
  let backgroundActive = true;
  const switchAccount = s.driver.switchAccount!;
  s.driver.switchAccount = async (...args) => {
    if (backgroundActive)
      throw new AccountSwitchBlockedError(
        "Background work still holds this session's Claude host. Stop it before switching accounts.",
      );
    await switchAccount(...args);
  };
  const held = await s.send().catch((error: unknown) => error);
  assert.ok(held instanceof PendingRuntimeHeldError);
  assert.match(held.message, /stop it to switch now/);

  const wakes: string[] = [];
  setDeliveryWake((id) => {
    wakes.push(id);
  });
  const delivery = new BackgroundCompletionDelivery({
    disposition: completionDisposition,
    offer: async () => "busy",
  });
  try {
    // The user stops it from the background UI: a requester Stop, which the
    // policy defers (no turn of its own).
    const stopped = {
      itemId: "held-host-job",
      revision: 1,
      label: "background job",
      state: "stopped" as const,
      backend: "claude-query" as const,
      stopRequested: true,
      stopOrigin: "requester" as const,
      ownerTurnRunning: false,
      humanLink: "/background-tasks/held-host-job",
    };
    assert.equal(completionDisposition(stopped), "defer");
    backgroundActive = false;
    delivery.enqueue(s.id, stopped);
    assert.deepEqual(wakes, [s.id], "the held turn is offered again");
    // Offered again, it switches and runs.
    await s.send();
    assert.deepEqual(
      s.calls.map((call) => call.profileId),
      [b],
    );
    assert.equal(sessionStore.get(s.id)?.pendingRuntime, undefined);
  } finally {
    delivery.stop();
    setDeliveryWake(undefined);
  }
});

test("an account change offers every session with a pending selection its turn again", async () => {
  const { wakePendingRuntimeSessions } =
    await import("./sessionPendingRuntime.ts");
  const a = account("claude-sdk", "A");
  const b = account("claude-sdk", "B");
  const waiting = setup("claude-sdk", a, []);
  const idle = setup("claude-sdk", a, []);
  const wakes = host(waiting);
  stored(waiting, a);
  stored(idle, a);
  await choose(waiting, b);
  wakes.length = 0;
  wakePendingRuntimeSessions();
  // Other tests' sessions may still hold one; this pair decides.
  assert.ok(wakes.includes(waiting.id), "a session with a selection");
  assert.ok(!wakes.includes(idle.id), "never a session without one");

  // A login restored (or lost) is a health change: its listeners hear it.
  let heard = 0;
  const unsubscribe = health.subscribeAccountHealthChanges(() => {
    heard += 1;
  });
  try {
    health.reportAccountRunFailure(
      b,
      { kind: "auth", loginDeath: true },
      offers.get(b)!.provider,
      health.observeAccountHealth(b),
    );
    profiles.listCredentialProfiles();
    assert.ok(heard > 0, "a health change reaches the listener");
  } finally {
    unsubscribe();
  }
});
