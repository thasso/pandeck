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

const offers = vi.hoisted(
  () => new Map<string, { provider: string; id: string }>(),
);
vi.mock("./harnesses/models.ts", () => ({
  modelsForAccount: async ({ id }: { id: string }) =>
    offers.has(id)
      ? [{ ...offers.get(id), name: "Test model", reasoning: false }]
      : [],
}));
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
  const model = offers.get(first)!;
  let profileId = first;
  let running = false;
  const calls: { text: string; continuation: boolean; profileId: string }[] =
    [];
  const moves: string[] = [];
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
    switchAccount: async (next, admit) => {
      admit();
      await moveGate?.();
      admit();
      sessionStore.switchCredentialProfile(id, profileId, next);
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
        queued = promptRuntimeSessionWithRuntime(
          s.runtime,
          s.driver,
          "queued unrelated turn",
          {
            onRunEnded: (outcome) => {
              queuedOutcomes.push(outcome);
            },
          },
        ).catch((error: unknown) => {
          if (error instanceof SessionBusyError) {
            pending = true;
            busy++;
          }
        });
      });
      const original = s.send({
        onRunEnded: (outcome) => {
          outcomes.push(outcome);
        },
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
      const sent = s
        .send({
          onRunEnded: (outcome) => {
            outcomes.push(outcome);
          },
        })
        .catch((error: unknown) => error);
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
            hooks: {
              onUserEntry: () => {
                pending = false;
                committed++;
              },
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
