import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, test, vi } from "vitest";
import type { Harness } from "@assistant/shared";
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
/** Per account, the pinned ids its listing lacks. */
const lacksPin = vi.hoisted(() => new Map<string, string[]>());
/**
 * Accounts whose listing runs only an exact (legacy) pin: the unpinned alias
 * catalog offers nothing there, the pin's own option does.
 */
const pinOnly = vi.hoisted(() => new Map<string, string>());
vi.mock("./harnesses/models.ts", () => ({
  accountLacksModel: async (
    id: string,
    _provider: string,
    _model: string,
    pin?: { pinnedModelId?: string },
  ) =>
    pin?.pinnedModelId !== undefined &&
    (lacksPin.get(id)?.includes(pin.pinnedModelId) ?? false),
  modelsForAccount: async ({ id }: { id: string }) =>
    offers.has(id) && !pinOnly.has(id)
      ? [{ ...offers.get(id), name: "Test model", reasoning: false }]
      : [],
  accountOffersModel: async (id: string, provider: string, model: string) =>
    !pinOnly.has(id) &&
    offers.get(id)?.provider === provider &&
    offers.get(id)?.id === model,
  // A pinned pick is offered by its pin: what the account offers, unless its
  // listing lacks that pin.
  pinnedModelOption: async (
    id: string,
    provider: string,
    model: string,
    pin: { pinnedModelId?: string },
  ) =>
    pin.pinnedModelId !== undefined &&
    !(lacksPin.get(id)?.includes(pin.pinnedModelId) ?? false) &&
    (!pinOnly.has(id) || pinOnly.get(id) === pin.pinnedModelId) &&
    offers.get(id)?.provider === provider &&
    offers.get(id)?.id === model
      ? { ...offers.get(id), name: "Test model", reasoning: false }
      : undefined,
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
const { setDeliveryWake } = await import("./deliveryWake.ts");
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
  // The explicit-move section's seams (declared with it, below).
  setAccountMoveHostForTests(undefined);
  leases.resetSessionRunLeasesForTests();
  for (const { runtime, id } of runtimes.splice(0))
    await runtime.disposeSession(id);
  for (const id of created.splice(0))
    profiles.setCredentialProfileEnabled(id, false);
  lacksPin.clear();
  pinOnly.clear();
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
  const model = offers.get(first)!;
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
      model: model.id,
      ...(failure
        ? { errorMessage: "provider rejected request", failure }
        : {}),
    });
  }
  const common = {
    modelProvider: () => model.provider,
    modelId: () => model.id,
    subscribeAdapterEvents: events.subscribe.bind(events),
    abort: () => {},
    setModel: () => {},
    setThinkingLevel: () => {},
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
    modelSelection: () => ({ model, thinkingLevel: "off" }),
    contextInfo: () => ({}) as ReturnType<RuntimePromptDriver["contextInfo"]>,
    broadcastState: () => {},
    createRuntimeAdapter: () => {
      const adapter =
        harness === "pi"
          ? createPiAdapter(id, {
              ...common,
              sessionFile: undefined,
              prompt: (text, _attachments, options) => ({
                outcome: "started",
                completed: drive(text, options?.continuation === true),
              }),
            })
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
 * An explicit move (Task-1415): the user's pick in the inspector, or an
 * owning coordinator's `move_account`, through `moveSessionAccount`.
 * ------------------------------------------------------------------------ */

const { moveSessionAccount, accountMoveTargets, setAccountMoveHostForTests } =
  await import("./sessionAccountMove.ts");
const { assertAccountRecoveryAdmission, reserveAccountRecovery: reserve } =
  await import("./session/runtime/accountRecoveryAdmission.ts");
const leases = await import("./session/sessionRunLease.ts");
const { beginRuntimeProviderTurn } = await import("./session/runtimePrompt.ts");

/** Route the move through this fixture's runtime; `acquire` opens it. */
function host(
  s: ReturnType<typeof setup>,
  acquire: () => Promise<RuntimePromptDriver | undefined> = async () =>
    s.driver,
) {
  setAccountMoveHostForTests({
    runtime: s.runtime,
    resident: async () => (s.runtime.get(s.id) ? s.driver : undefined),
    acquire,
    publishRows: async () => {},
  });
}

function pick(
  s: ReturnType<typeof setup>,
  target: string,
  over: Partial<Parameters<typeof moveSessionAccount>[0]> = {},
) {
  return moveSessionAccount({
    sessionId: s.id,
    targetProfileId: target,
    by: "user",
    authorize: () => {},
    ...over,
  });
}

const RUNNING = "This session is running; move it once its turn ends.";
const BUSY =
  "This session is starting a turn or already moving; try again once it is idle.";

/** Nothing the move held is still held: a new turn and a new move may start. */
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

for (const harness of engines) {
  test(`${harness} an explicit move rebinds an idle loaded session at once`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const s = setup(harness, a, [undefined, undefined]);
    host(s);
    await s.send();
    assert.deepEqual(await pick(s, b), { from: "A", to: "B" });
    assert.equal(sessionStore.get(s.id)?.credentialProfileId, b);
    assert.deepEqual(s.moves, [b]);
    assert.deepEqual(s.switchOptions, [{ allowWithoutHistory: true }]);
    assert.deepEqual(markers(s), ["Switched from A to B — chosen by you."]);
    released(s);
    await s.send();
    assert.deepEqual(
      s.calls.map((call) => call.profileId),
      [a, b],
    );
  });

  test(`${harness} a coordinator's move says so in its marker`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const s = setup(harness, a, []);
    host(s);
    await pick(s, b, { by: "coordinator" });
    assert.deepEqual(markers(s), [
      "Switched from A to B — chosen by its coordinating session.",
    ]);
  });

  test(`${harness} a session that is not loaded is opened for the move`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const s = setup(harness, a, [undefined]);
    let opened = 0;
    host(s, async () => {
      opened += 1;
      return s.driver;
    });
    assert.equal(s.runtime.get(s.id), undefined);
    await pick(s, b);
    assert.equal(opened, 1);
    assert.equal(sessionStore.get(s.id)?.credentialProfileId, b);
    released(s);
    await s.send();
    assert.deepEqual(
      s.calls.map((call) => call.profileId),
      [b],
    );
  });

  test.each(["missing", "throws", "released"] as const)(
    `${harness} a session that cannot be opened is refused and holds nothing; acquisition %s`,
    async (failure) => {
      const a = account(harness, "A");
      const b = account(harness, "B");
      const s = setup(harness, a, [undefined]);
      host(s, async () => {
        if (failure === "throws") throw new Error("disk is gone");
        return failure === "missing"
          ? undefined
          : ({ ...s.driver, released: true } as RuntimePromptDriver);
      });
      await assert.rejects(pick(s, b), {
        message: "This session could not be loaded for the move.",
      });
      assert.equal(sessionStore.get(s.id)?.credentialProfileId, a);
      released(s);
      host(s);
      await pick(s, b);
      assert.equal(sessionStore.get(s.id)?.credentialProfileId, b);
    },
  );

  test(`${harness} the move marker is display only: its failure changes nothing`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const s = setup(harness, a, [undefined, undefined]);
    host(s);
    await s.send();
    const live = s.runtime.get(s.id)!;
    vi.spyOn(live, "appendNotice").mockImplementation(() => {
      throw new Error("log is full");
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    assert.deepEqual(await pick(s, b), { from: "A", to: "B" });
    assert.equal(sessionStore.get(s.id)?.credentialProfileId, b);
    assert.deepEqual(warning.mock.calls, [
      ["[account-move] Could not append the move marker."],
    ]);
    released(s);
  });

  test(`${harness} moves between personal and enterprise accounts without touching the requirement`, async () => {
    const a = account(harness, "A");
    const e = account(harness, "Work", true);
    const s = setup(harness, a, []);
    host(s);
    await pick(s, e);
    assert.equal(sessionStore.get(s.id)?.credentialProfileId, e);
    assert.equal(sessionStore.get(s.id)?.requiresEnterprise, undefined);
    await pick(s, a);
    assert.equal(sessionStore.get(s.id)?.credentialProfileId, a);
    assert.deepEqual(s.switchOptions, [
      { allowWithoutHistory: true },
      { allowWithoutHistory: true },
    ]);
  });

  test(`${harness} an enterprise-only session moves only to enterprise accounts`, async () => {
    const e1 = account(harness, "Work", true);
    const e2 = account(harness, "Work 2", true);
    const personal = account(harness, "Personal");
    const s = setup(harness, e1, [], true);
    stored(s, e1);
    host(s);
    const listed = (await accountMoveTargets(s.id)).map(({ id }) => id);
    assert.ok(listed.includes(e2));
    assert.ok(!listed.includes(personal));
    await assert.rejects(pick(s, personal), {
      message:
        "This session requires an enterprise account, and Personal is not one.",
    });
    await pick(s, e2);
    assert.equal(sessionStore.get(s.id)?.credentialProfileId, e2);
    assert.equal(sessionStore.get(s.id)?.requiresEnterprise, true);
    assert.deepEqual(s.switchOptions, [
      { allowWithoutHistory: true, requireEnterprise: true },
    ]);
  });

  test(`${harness} each ineligible target is refused with its own reason, binding unchanged`, async () => {
    const a = account(harness, "A");
    const disabled = account(harness, "Off");
    profiles.setCredentialProfileEnabled(disabled, false);
    const other = account(otherKind(harness), "Other kind");
    const unoffered = account(harness, "No model");
    offers.delete(unoffered);
    const login = account(harness, "Logged out");
    health.reportAccountRunFailure(
      login,
      { kind: "auth", loginDeath: true },
      offers.get(login)!.provider,
      health.observeAccountHealth(login),
    );
    const benched = account(harness, "Benched");
    health.reportAccountRunFailure(
      benched,
      { kind: "quota" },
      offers.get(benched)!.provider,
      health.observeAccountHealth(benched),
    );
    const s = setup(harness, a, []);
    host(s);
    const model = offers.get(a)!.id;
    for (const [target, reason] of [
      [a, /^This session already runs on A\.$/],
      ["cp_missing", /^The chosen account no longer exists\.$/],
      [disabled, /^Off is disabled\.$/],
      [other, /^Other kind is not the same kind of account as A\.$/],
      [unoffered, new RegExp(`^No model does not offer ${model} at`)],
      [login, /^Logged out needs login\.$/],
      [benched, new RegExp(`^Benched has reached its ${model} limit until `)],
    ] as const) {
      await assert.rejects(pick(s, target), { message: reason }, target);
      assert.equal(sessionStore.get(s.id)?.credentialProfileId, a);
      released(s);
    }
    assert.deepEqual(s.moves, []);
    const listed = (await accountMoveTargets(s.id)).map(({ id }) => id);
    for (const excluded of [a, disabled, other, unoffered, login, benched])
      assert.ok(!listed.includes(excluded), excluded);
  });

  test(`${harness} a disabled source may still move off`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const s = setup(harness, a, []);
    host(s);
    profiles.setCredentialProfileEnabled(a, false);
    await pick(s, b);
    assert.equal(sessionStore.get(s.id)?.credentialProfileId, b);
  });

  test(`${harness} benches judge the session's own model, as Automatic does`, async () => {
    const a = account(harness, "A");
    const [own, unrelated] =
      harness === "pi" ? ["gpt-5.5", "gpt-5.4-mini"] : ["sonnet", "opus"];
    const bench = (
      id: string,
      limitModel: string | undefined,
      resetAtMs: number,
    ) =>
      health.reportAccountRunFailure(
        id,
        { kind: "quota", resetAtMs, ...(limitModel ? { limitModel } : {}) },
        offers.get(id)!.provider,
        health.observeAccountHealth(id),
      );
    const now = Date.now();
    // The session model's bench ends sooner than another model's: the
    // account's single displayed bench names the other, yet it is excluded.
    const hidden = account(harness, "Hidden");
    bench(hidden, own, now + 3_600_000);
    bench(hidden, unrelated, now + 7_200_000);
    const elsewhere = account(harness, "Elsewhere");
    bench(elsewhere, unrelated, now + 3_600_000);
    const whole = account(harness, "Whole");
    bench(whole, undefined, now + 3_600_000);
    const expired = account(harness, "Expired");
    bench(expired, own, now + 40);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const s = setup(harness, a, []);
    stored(s, a);
    host(s);
    const listed = (await accountMoveTargets(s.id)).map(({ id }) => id);
    assert.ok(!listed.includes(hidden), "hidden matching bench");
    assert.ok(listed.includes(elsewhere), "unrelated bench only");
    assert.ok(!listed.includes(whole), "account-wide bench");
    assert.ok(listed.includes(expired), "expired bench");
    await assert.rejects(pick(s, hidden), /limit until/);
    await pick(s, elsewhere);
    assert.equal(sessionStore.get(s.id)?.credentialProfileId, elsewhere);
  });

  test(`${harness} a busy session is refused: running, or a prompt admitted but not yet running`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const s = setup(harness, a, []);
    host(s);
    const admitted = s.runtime.admitPrompt(s.id);
    await assert.rejects(pick(s, b), { message: BUSY });
    admitted();
    assert.equal(sessionStore.get(s.id)?.credentialProfileId, a);
    released(s);
    host(s, async () => ({ ...s.driver, isRunning: true }));
    await assert.rejects(pick(s, b), { message: RUNNING });
    assert.equal(sessionStore.get(s.id)?.credentialProfileId, a);
    released(s);
    host(s);
    await pick(s, b);
    assert.equal(sessionStore.get(s.id)?.credentialProfileId, b);
  });

  test(`${harness} while a move holds the session, no turn starts; queued work waits for its idle edge`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const s = setup(harness, a, [undefined, undefined]);
    host(s);
    await s.send();
    let release!: () => void;
    let entered = false;
    s.gate(() => {
      entered = true;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const moving = pick(s, b);
    await vi.waitFor(() => assert.ok(entered));
    const before = s.runtime.get(s.id)!.clientTimeline().length;
    await assert.rejects(s.send(), (error: unknown) => {
      assert.ok(error instanceof SessionBusyError);
      assert.equal((error as Error).name, "AccountSwitchInProgressError");
      return true;
    });
    await assert.rejects(
      beginRuntimeProviderTurn(s.driver, {
        kind: "system",
        source: "account-switch",
      }),
      { name: "AccountSwitchInProgressError" },
    );
    // Slash commands open their synthetic turn behind this same typed-busy
    // check, and a queued row stays queued on SessionBusyError.
    assert.throws(() => assertAccountRecoveryAdmission(s.id), SessionBusyError);
    // A second move finds the first one's admission, which is no run.
    await assert.rejects(pick(s, b), { message: BUSY });
    assert.equal(s.runtime.get(s.id)!.clientTimeline().length, before);
    assert.equal(s.calls.length, 1);
    const idle = vi.spyOn(s.runtime.get(s.id)!, "notifyIdle");
    release();
    await moving;
    assert.equal(idle.mock.calls.length, 1, "idle re-offered after release");
    released(s);
    await s.send();
    assert.deepEqual(
      s.calls.map((call) => call.profileId),
      [a, b],
    );
  });

  test(`${harness} a failover reservation refuses the move and stays its owner's`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const s = setup(harness, a, []);
    host(s);
    const ticket = reserve(s.id);
    try {
      await assert.rejects(pick(s, b), {
        name: "AccountSwitchInProgressError",
      });
      assertAccountRecoveryAdmission(s.id, ticket);
      assert.equal(s.runtime.isBusy(s.id), false);
    } finally {
      const { releaseAccountRecovery } =
        await import("./session/runtime/accountRecoveryAdmission.ts");
      releaseAccountRecovery(s.id, ticket);
    }
    assert.equal(sessionStore.get(s.id)?.credentialProfileId, a);
  });

  test(`${harness} a model or effort change during the move refuses it`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const s = setup(harness, a, []);
    host(s);
    const original = s.driver.modelSelection!;
    s.gate(async () => {
      s.driver.modelSelection = () => ({
        ...original(),
        thinkingLevel: "high",
      });
    });
    await assert.rejects(pick(s, b), {
      message: "This session's model or effort changed during the move.",
    });
    assert.equal(sessionStore.get(s.id)?.credentialProfileId, a);
    released(s);
  });

  test(`${harness} a target that loses its login mid-move keeps the binding`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const s = setup(harness, a, []);
    host(s);
    s.gate(async () =>
      health.reportAccountRunFailure(
        b,
        { kind: "auth", loginDeath: true },
        offers.get(b)!.provider,
        health.observeAccountHealth(b),
      ),
    );
    await assert.rejects(pick(s, b), { message: "B needs login." });
    assert.equal(sessionStore.get(s.id)?.credentialProfileId, a);
    released(s);
  });

  test(`${harness} losing authority before the commit refuses the move`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const s = setup(harness, a, []);
    host(s);
    let owned = true;
    s.gate(async () => {
      owned = false;
    });
    await assert.rejects(
      pick(s, b, {
        by: "coordinator",
        authorize: () => {
          if (!owned) throw new Error("taken over");
        },
      }),
      { message: "taken over" },
    );
    assert.equal(sessionStore.get(s.id)?.credentialProfileId, a);
    assert.deepEqual(s.moves, []);
    released(s);
  });

  test(`${harness} a worktree hold refuses the move, and nothing leaks once it lifts`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const s = setup(harness, a, [undefined]);
    host(s);
    leases.setSessionWorktreeResolverForTests((id) =>
      id === s.id ? "wt-move" : undefined,
    );
    const lift = leases.reserveWorktreeForRemoval(
      "wt-move",
      "This worktree is being removed.",
    )!;
    await assert.rejects(pick(s, b), {
      message: "This worktree is being removed.",
    });
    assert.equal(s.runtime.isBusy(s.id), false);
    assertAccountRecoveryAdmission(s.id);
    lift();
    await s.send();
    await pick(s, b);
    assert.equal(sessionStore.get(s.id)?.credentialProfileId, b);
    released(s);
    // The lease the move held is gone: a removal may take the worktree again.
    const again = leases.reserveWorktreeForRemoval("wt-move", "again");
    assert.ok(again);
    again();
  });

  test(`${harness} a throwing engine switch is refused and releases everything`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const s = setup(harness, a, [undefined]);
    host(s);
    s.gate(async () => {
      throw new Error("Background work still holds this session's host.");
    });
    await assert.rejects(pick(s, b), {
      message: "Background work still holds this session's host.",
    });
    assert.equal(sessionStore.get(s.id)?.credentialProfileId, a);
    released(s);
    s.gate(async () => {});
    await pick(s, b);
    assert.equal(sessionStore.get(s.id)?.credentialProfileId, b);
  });

  test(`${harness} a session of another scope, deleted, unbound or on an endpoint cannot move`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const unbound = setup(harness, a, [], false, false);
    host(unbound);
    await assert.rejects(pick(unbound, b), {
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
    host(onEndpoint);
    await assert.rejects(pick(onEndpoint, b), {
      message:
        "Team LLM is the only account that serves this session's model, so the session cannot move.",
    });
    const deleted = setup(harness, a, []);
    host(deleted);
    sessionStore.markDeleted(deleted.id);
    await assert.rejects(pick(deleted, b), {
      message: "Session does not exist or was deleted.",
    });
  });

  // Work refused as busy while the move held the session (a queued row, a peer
  // delivery) waits for one re-offer at release, however the move ended: the
  // bound runtime's idle edge, or a wake by id when no live runtime remains.
  test.each([
    "success",
    "acquisition missing",
    "acquisition throws",
    "released driver",
    "no switchAccount",
    "engine switch throws",
    "model change",
    "authority loss",
    "target needs login",
    "harness torn down mid-move",
  ] as const)(
    `${harness} every exit after the holds re-offers delivery exactly once: %s`,
    async (exit) => {
      const a = account(harness, "A");
      const b = account(harness, "B");
      const s = setup(harness, a, []);
      let owned = true;
      host(s, async () => {
        if (exit === "acquisition throws") throw new Error("disk is gone");
        if (exit === "acquisition missing") return undefined;
        if (exit === "released driver")
          return { ...s.driver, released: true } as RuntimePromptDriver;
        if (exit === "no switchAccount") {
          const { switchAccount: _unused, ...rest } = s.driver;
          return rest;
        }
        return s.driver;
      });
      s.gate(async () => {
        if (exit === "engine switch throws") throw new Error("engine refused");
        if (exit === "model change")
          s.driver.modelSelection = () => ({
            model: offers.get(a),
            thinkingLevel: "high",
          });
        if (exit === "authority loss") owned = false;
        if (exit === "target needs login")
          health.reportAccountRunFailure(
            b,
            { kind: "auth", loginDeath: true },
            offers.get(b)!.provider,
            health.observeAccountHealth(b),
          );
        if (exit === "harness torn down mid-move") {
          // What a harness store does when its engine is lost: the session
          // stays, its runtime goes.
          s.runtime.closeForTeardown(s.id);
          await s.runtime.releaseHarness(s.id);
          throw new Error("engine lost");
        }
      });
      const wakes: string[] = [];
      lifecycle.setSessionIdleHook((id) => {
        if (id === s.id) wakes.push("idle");
      });
      setDeliveryWake((id, reminders) => {
        if (id === s.id) wakes.push(`wake reminders=${reminders}`);
      });
      try {
        const moving = pick(s, b, {
          authorize: () => {
            if (!owned) throw new Error("taken over");
          },
        });
        if (exit === "success") await moving;
        else await assert.rejects(moving);
        released(s);
        assert.equal(
          sessionStore.get(s.id)?.credentialProfileId,
          exit === "success" ? b : a,
        );
        assert.deepEqual(
          wakes,
          exit.startsWith("acquisition") ||
            exit === "released driver" ||
            exit === "no switchAccount" ||
            exit === "harness torn down mid-move"
            ? ["wake reminders=true"]
            : ["idle"],
        );
      } finally {
        lifecycle.setSessionIdleHook(undefined);
        setDeliveryWake(undefined);
      }
    },
  );

  test(`${harness} a move refused before its holds wakes nothing, and a deleted session is not woken`, async () => {
    const a = account(harness, "A");
    const b = account(harness, "B");
    const s = setup(harness, a, []);
    const wakes: string[] = [];
    setDeliveryWake((id) => {
      if (id === s.id) wakes.push("wake");
    });
    try {
      const admitted = s.runtime.admitPrompt(s.id);
      host(s);
      await assert.rejects(pick(s, b), { message: BUSY });
      admitted();
      host(s, async () => {
        sessionStore.markDeleted(s.id);
        return undefined;
      });
      await assert.rejects(pick(s, b));
      assert.deepEqual(wakes, []);
    } finally {
      setDeliveryWake(undefined);
    }
  });
}

test("pi counts the run after an explicit move as moved for its encrypted-reasoning retry", async () => {
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
  await pick(s, b);
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

/** A Claude account running `model`; `lacks52` marks it Y (no fable 5-2). */
function claudeOn(name: string, model: string, lacks52 = false): string {
  const id = account("claude-sdk", name);
  offers.set(id, { provider: "claude-sdk", id: model });
  if (lacks52) lacksPin.set(id, ["claude-fable-5-2"]);
  return id;
}

/** The session was spawned from a definition pinned to fable 5-2. */
function pinFable52(sessionId: string): void {
  sessionStore.freezeAgent(
    sessionId,
    JSON.stringify({
      name: "pinned-fable",
      blob: "0".repeat(40),
      persona: "assistant",
      provider: "claude-sdk",
      model: "fable",
      pinnedModel: "claude-fable-5-2",
      effort: "high",
      runtimeSource: "definition",
      denyTools: [],
      skills: [],
      body: "",
    }),
  );
}

test("a 5-2-pinned session moves off a disabled account only to one that runs 5-2", async () => {
  const x = claudeOn("X", "fable");
  claudeOn("Y", "fable", true);
  const z = claudeOn("Z", "fable");
  const s = setup("claude-sdk", x, [undefined]);
  pinFable52(s.id);
  profiles.setCredentialProfileEnabled(x, false);
  await s.send();
  assert.deepEqual(s.moves, [z]);
});

test("a 5-2-pinned session on a disabled account with only Y left is refused, binding kept", async () => {
  const x = claudeOn("X", "fable");
  claudeOn("Y", "fable", true);
  const s = setup("claude-sdk", x, [undefined]);
  pinFable52(s.id);
  profiles.setCredentialProfileEnabled(x, false);
  await assert.rejects(
    s.send(),
    /X is disabled and no other eligible account is available/,
  );
  assert.deepEqual(s.moves, []);
  assert.equal(sessionStore.get(s.id)?.credentialProfileId, x);
});

test("failure recovery of a 5-2-pinned session skips the account without 5-2", async () => {
  const x = claudeOn("X", "fable");
  claudeOn("Y", "fable", true);
  const z = claudeOn("Z", "fable");
  const s = setup("claude-sdk", x, [{ kind: "quota" }, undefined]);
  pinFable52(s.id);
  await s.send().catch(() => {});
  await vi.waitFor(() => assert.equal(s.driver.credentialProfileId, z));
  assert.deepEqual(s.moves, [z]);
});

test("failure recovery of a 5-2-pinned session with only Y left stays and says so", async () => {
  const x = claudeOn("X", "fable");
  claudeOn("Y", "fable", true);
  const s = setup("claude-sdk", x, [{ kind: "quota" }]);
  pinFable52(s.id);
  await s.send().catch(() => {});
  await vi.waitFor(() =>
    assert.ok(
      JSON.stringify(messages(s)).includes("No other eligible account"),
    ),
  );
  assert.deepEqual(s.moves, []);
  assert.equal(sessionStore.get(s.id)?.credentialProfileId, x);
});

test("the pin no longer applies once the user switched the session to another alias", async () => {
  const x = claudeOn("X", "opus");
  const y = claudeOn("Y", "opus", true);
  const s = setup("claude-sdk", x, [undefined]);
  pinFable52(s.id);
  profiles.setCredentialProfileEnabled(x, false);
  await s.send();
  assert.deepEqual(s.moves, [y]);
});

test("a local-policy failure is never switch evidence, whatever its kind", async () => {
  const x = claudeOn("X", "opus");
  claudeOn("Z", "opus");
  const s = setup("claude-sdk", x, [{ kind: "quota", localPolicy: true }]);
  await s.send().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(s.moves, []);
  assert.equal(s.calls.length, 1);
  assert.equal(sessionStore.get(s.id)?.credentialProfileId, x);
  assert.equal(
    JSON.stringify(messages(s)).includes("No other eligible account"),
    false,
  );
});

/** The session was spawned from a definition pinned to legacy opus 5. */
function pinOpus5(sessionId: string): void {
  sessionStore.freezeAgent(
    sessionId,
    JSON.stringify({
      name: "pinned-opus",
      blob: "0".repeat(40),
      persona: "assistant",
      provider: "claude-sdk",
      model: "opus",
      pinnedModel: "claude-opus-5",
      effort: "high",
      runtimeSource: "definition",
      denyTools: [],
      skills: [],
      body: "",
    }),
  );
}

/** An account listing legacy opus 5 but not opus's current candidate. */
function legacyOpusOnly(name: string): string {
  const id = claudeOn(name, "opus");
  pinOnly.set(id, "claude-opus-5");
  return id;
}

test("an opus-5-pinned session moves off a disabled account to one listing only that exact version", async () => {
  const x = claudeOn("X", "opus");
  const legacy = legacyOpusOnly("Legacy");
  const s = setup("claude-sdk", x, [undefined]);
  pinOpus5(s.id);
  profiles.setCredentialProfileEnabled(x, false);
  await s.send();
  assert.deepEqual(s.moves, [legacy]);
});

test("failure recovery of an opus-5-pinned session moves to an account listing only that exact version", async () => {
  const x = claudeOn("X", "opus");
  const legacy = legacyOpusOnly("Legacy");
  const s = setup("claude-sdk", x, [{ kind: "quota" }, undefined]);
  pinOpus5(s.id);
  await s.send().catch(() => {});
  await vi.waitFor(() => assert.equal(s.driver.credentialProfileId, legacy));
  assert.deepEqual(s.moves, [legacy]);
});

test("an unpinned opus session is not offered an account listing only legacy opus 5", async () => {
  const x = claudeOn("X", "opus");
  legacyOpusOnly("Legacy");
  const s = setup("claude-sdk", x, [undefined]);
  profiles.setCredentialProfileEnabled(x, false);
  await assert.rejects(
    s.send(),
    /X is disabled and no other eligible account is available/,
  );
  assert.deepEqual(s.moves, []);
});
