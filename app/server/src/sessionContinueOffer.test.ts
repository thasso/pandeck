/**
 * "Continue on <model>" (`docs/session-runtime-switching.md` "Continue on
 * another model"): the offer a quota or rate-limit failure carries, and the
 * user's click, which moves the session to the chosen engine and continues the
 * failed turn there — no user row, the user's authority past a Stop, ahead of
 * queued work, which stays for after it.
 */
import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import {
  disableClaudeSdkForTests,
  enableClaudeSdkForTests,
} from "./test/claudeSdkEnabled.ts";
import type { ModelOption } from "@assistant/shared";
import { randomUUID } from "node:crypto";

/** A test may hold eligibility or routing open to act while they resolve. */
const gates = vi.hoisted(() => ({
  offers: undefined as undefined | (() => Promise<void>),
  pick: undefined as undefined | (() => Promise<void>),
  /** Judge the pick's listing for real (the per-account Claude rules). */
  real: false,
  /** The picker's models, when a test needs others. */
  picker: undefined as undefined | ModelOption[],
}));

vi.mock("./harnesses/models.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./harnesses/models.ts")>();
  return {
    ...original,
    pickerModels: (): ModelOption[] =>
      gates.picker ?? [
        {
          provider: "claude-sdk",
          id: "sonnet",
          name: "Claude Sonnet",
          contextWindow: 200_000,
        } as ModelOption,
        {
          provider: "openai-codex",
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          contextWindow: 272_000,
          reasoning: true,
        } as ModelOption,
        {
          provider: "openai-codex",
          id: "gpt-5.4-mini",
          name: "GPT Mini",
          contextWindow: 272_000,
          reasoning: true,
        } as ModelOption,
      ],
  };
});
vi.mock("./sessionAccountMove.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./sessionAccountMove.ts")>();
  // Account listing is not under test: every account serves its kind's models.
  return {
    ...original,
    modelRefusal: async () => undefined,
    selectionListingRefusal: async (
      ...args: Parameters<typeof original.selectionListingRefusal>
    ) => {
      if (gates.real) return original.selectionListingRefusal(...args);
      await gates.offers?.();
      return undefined;
    },
    assertStillEligible: () => {},
  };
});
vi.mock("./accountRouter.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./accountRouter.ts")>();
  // Routing is not under test: each kind's default account is the pick.
  return {
    ...original,
    pickAccount: async (request: { model: { provider: string } }) => {
      await gates.pick?.();
      return {
        profileId:
          request.model.provider === "openai-codex"
            ? "default"
            : "claude-default",
        degraded: false,
      };
    },
  };
});

/** The terminal-failure listener `installContinueOffers` subscribed. */
const terminal: {
  listener?:
    | ((
        report: import("./session/runtime/liveSession.ts").RunFailureReport,
      ) => void)
    | undefined;
} = {};
vi.mock("./session/runtime/liveSession.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./session/runtime/liveSession.ts")>();
  return {
    ...original,
    subscribeSessionRunTerminallyFailed: (
      listener: Parameters<
        typeof original.subscribeSessionRunTerminallyFailed
      >[0],
    ) => {
      terminal.listener = listener;
      const off = original.subscribeSessionRunTerminallyFailed(listener);
      return () => {
        terminal.listener = undefined;
        return off();
      };
    },
  };
});

const { claudeSdkStore } = await import("./claudeSdk/claudeSdkStore.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { setDeliveryWake } = await import("./deliveryWake.ts");
const { piStore } = await import("./piSdk/piStore.ts");
const { openPiEngine } = await import("./piSdk/piEngineHost.ts");
const { sessionRuntime } = await import("./session/runtimeInstance.ts");
const { logPathFor } = await import("./session/log/persistence.ts");
const { ensureRuntimeSessionWithRuntime, promptRuntimeSessionWithRuntime } =
  await import("./session/runtimePrompt.ts");
const { readHandoffRecords } = await import("./sessionHandoff.ts");
const { setPendingRuntimeHostForTests } =
  await import("./sessionPendingRuntime.ts");
const { automaticTurnsHeld, captureHumanResume, holdAutomaticTurns } =
  await import("./automaticTurnHold.ts");
const { clearPromptQueue, promptQueueField, queuePrompt } =
  await import("./promptQueue.ts");
const {
  ContinueOfferGoneError,
  continueChoices,
  continueOnModel,
  installContinueOffers,
} = await import("./sessionContinueOffer.ts");
const { installClaudeStateBuilder } =
  await import("./test/claudeSdkSession.ts");
const { claudeTurnSeam } = await import("./test/claudeTurnSeam.ts");
const { FakeRuntimeDriver } = await import("./test/fakeRuntimeDriver.ts");
const { seedLegacyDefaultAccounts } =
  await import("./test/legacyDefaultAccounts.ts");
const { resetClaudeAccountModelsForTests } =
  await import("./harnesses/claudeAccountModels.ts");

installClaudeStateBuilder(claudeSdkStore);
await seedLegacyDefaultAccounts();

type PiEngineOpened = import("./piSdk/piEngineHost.ts").PiEngineOpened;
type PiEngineOpenSpec = import("./piSdk/piEngineHost.ts").PiEngineOpenSpec;
interface PiInternals {
  openEngine: (spec: PiEngineOpenSpec) => Promise<PiEngineOpened>;
  track: (kind: string, opened: PiEngineOpened) => unknown;
  live: Map<string, unknown>;
}
const pi = piStore as unknown as PiInternals;
const originalOpenEngine = pi.openEngine;
const originalTrack = pi.track;

/** pi's side of the move: a fake driver the continuation runs on. */
class PiStandIn extends FakeRuntimeDriver {
  readonly live = true as const;
  readonly kind = "developer";
  readonly appId: string;
  readonly engine: unknown;
  constructor(id: string, engine: unknown) {
    super(id);
    this.appId = id;
    this.engine = engine;
  }
  modelSelection() {
    return {
      model: { provider: "openai-codex", id: "gpt-5.6-sol" },
      thinkingLevel: "high" as const,
    };
  }
  addViewer(): void {}
  removeViewer(): void {}
  commitWorkflowContext() {
    return { sessionManager: undefined };
  }
  dispose(): void {}
}

const opened: PiStandIn[] = [];
const ids: string[] = [];

beforeAll(() => {
  claudeSdkStore.setSeam(() =>
    Promise.resolve({
      query(params) {
        const turn = claudeTurnSeam.query(params) as AsyncIterable<
          Record<string, unknown>
        >;
        const native = params.options?.resume ?? `native-${randomUUID()}`;
        return {
          async *[Symbol.asyncIterator]() {
            for await (const message of turn)
              yield "session_id" in message
                ? { ...message, session_id: native }
                : message;
          },
        } as never;
      },
      deleteSession: async () => {},
    }),
  );
  piStore.setHost({
    sessionRowsChanged: () => {},
    noteRunStarted: () => {},
    checkPendingReload: () => {},
    isReloadQueued: () => false,
    buildSessionState: () => ({}) as never,
  } as never);
  setDeliveryWake(() => {});
  setPendingRuntimeHostForTests({
    stateChanged: async () => {},
    publishRows: async () => {},
    wake: () => assert.fail("a Continue offers held work no turn of its own"),
  });
  pi.openEngine = (spec) => {
    const { model: _model, thinkingLevel: _thinking, ...transcript } = spec;
    return openPiEngine(
      transcript,
      {} as never,
      async (_spec, _ctx, { sm }) => ({
        session: {
          sessionId: sm.getSessionId(),
          sessionFile: sm.getSessionFile(),
          sessionManager: sm,
          subscribe: () => () => {},
          dispose: () => {},
        } as never,
        notices: [],
      }),
    );
  };
  pi.track = (_kind, { engine }) => {
    const live = new PiStandIn(engine.sessionId, engine);
    opened.push(live);
    pi.live.set(engine.sessionId, live);
    return live;
  };
});
// These tests drive Claude runs; the integration is off by default.
beforeEach(enableClaudeSdkForTests);
afterEach(async () => {
  gates.offers = undefined;
  gates.pick = undefined;
  gates.real = false;
  gates.picker = undefined;
  resetClaudeAccountModelsForTests();
  pi.live.clear();
  opened.length = 0;
  for (const id of ids.splice(0)) {
    clearPromptQueue(id);
    claudeSdkStore.remove(id);
    await sessionRuntime.disposeSession(id);
  }
});
afterAll(() => {
  pi.openEngine = originalOpenEngine;
  pi.track = originalTrack;
  setPendingRuntimeHostForTests(undefined);
});

const SOL = {
  provider: "openai-codex",
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  thinkingLevel: "high",
} as const;

/** A Claude session with one answered turn whose next one hit a usage limit. */
async function failedOnClaude(name: string) {
  const id = `continue-on-${Date.now()}-${name}`;
  ids.push(id);
  const claude = claudeSdkStore.acquire(id, { modelId: "sonnet" });
  claude.setTitle("continue on");
  ensureRuntimeSessionWithRuntime(sessionRuntime, claude);
  await promptRuntimeSessionWithRuntime(sessionRuntime, claude, "first ask");
  const runId = `run-${name}`;
  sessionStore.recordRunFailure(
    id,
    "You've hit your usage limit.",
    Date.now(),
    runId,
  );
  const failureAt = sessionStore.get(id)?.lastError?.at;
  assert.ok(failureAt !== undefined);
  return { id, claude, failureAt, runId };
}

function userTexts(id: string): string[] {
  return readHandoffRecords(logPathFor(id), 0)
    .filter((record) => record.role === "user")
    .map((record) => record.text);
}

test("the offer sits beside its own run's failure only, and leaves with it", async () => {
  const { id, failureAt, runId } = await failedOnClaude("offer");
  assert.equal(
    sessionStore.recordContinueOffer(id, "run-older", [SOL]),
    false,
    "an older run's offer is never attached to a newer run's failure",
  );
  assert.equal(sessionStore.get(id)?.lastError?.continueOn, undefined);
  assert.equal(sessionStore.recordContinueOffer(id, runId, [SOL]), true);
  assert.deepEqual(sessionStore.get(id)?.lastError?.continueOn, [SOL]);

  sessionStore.recordRunFailure(id, "again", failureAt + 1, "run-again");
  assert.equal(
    sessionStore.get(id)?.lastError?.continueOn,
    undefined,
    "a new failure starts without an offer",
  );
  assert.equal(sessionStore.recordContinueOffer(id, runId, [SOL]), false);
  // A failure no run owns (a pending selection's hold) takes no run's offer.
  sessionStore.recordRunFailure(id, "held", failureAt + 2);
  assert.equal(sessionStore.recordContinueOffer(id, "run-again", [SOL]), false);
  sessionStore.recordRunFailure(id, "again", failureAt + 3, "run-again");
  assert.equal(sessionStore.recordContinueOffer(id, "run-again", [SOL]), true);
  sessionStore.clearRunFailure(id);
  assert.equal(sessionStore.get(id)?.lastError, undefined);
  assert.equal(
    sessionStore.recordContinueOffer(id, "run-again", [SOL]),
    false,
    "a cleared failure takes no offer",
  );
});

test("only a terminal quota or rate-limit failure is offered a model to continue on", async () => {
  const uninstall = installContinueOffers();
  try {
    const { id, runId } = await failedOnClaude("terminal");
    const report = (kind: "quota" | "rate_limit" | "auth") =>
      terminal.listener!({
        sessionId: id,
        runId,
        origin: undefined,
        errorMessage: undefined,
        failure: { kind },
        at: Date.now(),
      });
    report("auth");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sessionStore.get(id)?.lastError?.continueOn, undefined);

    report("quota");
    await vi.waitFor(() =>
      assert.deepEqual(
        sessionStore.get(id)?.lastError?.continueOn?.map((c) => c.id),
        ["gpt-5.6-sol", "gpt-5.4-mini"],
      ),
    );
  } finally {
    uninstall();
  }
});

test("a local-policy refusal is never offered a model to continue on", async () => {
  const offActivity = installSessionActivityTracking();
  const uninstall = installContinueOffers();
  try {
    const { id, runId } = await failedOnClaude("local-policy");
    // The marker alone: PA refused before any provider call.
    terminal.listener!({
      sessionId: id,
      runId,
      origin: undefined,
      errorMessage: undefined,
      failure: { kind: "unknown", localPolicy: true },
      at: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sessionStore.get(id)?.lastError?.continueOn, undefined);

    // A real one: the Claude SDK turned off refuses the next turn at its
    // query open, as local policy, and nothing is offered.
    await disableClaudeSdkForTests();
    const claude = claudeSdkStore.get(id)!;
    await assert.rejects(
      promptRuntimeSessionWithRuntime(sessionRuntime, claude, "refused ask"),
      /Claude SDK is disabled in settings/,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(
      sessionStore.get(id)?.lastError?.message ?? "",
      /Claude SDK is disabled in settings/,
    );
    assert.equal(sessionStore.get(id)?.lastError?.continueOn, undefined);
  } finally {
    uninstall();
    offActivity();
  }
});

test("choices are the other engine's runnable models, the failed one's counterpart first", async () => {
  const { id } = await failedOnClaude("choices");
  // Sonnet is first among Claude's models, so GPT-5.6 Sol (first among
  // OpenAI's) is the default; the same engine is never offered.
  assert.deepEqual(
    (await continueChoices(id)).map((choice) => choice.id),
    ["gpt-5.6-sol", "gpt-5.4-mini"],
  );
});

test("Continue moves the session, continues the failed turn past a Stop, and leaves the queue for after", async () => {
  const { id, claude, failureAt, runId } = await failedOnClaude("continue");
  sessionStore.recordContinueOffer(id, runId, [SOL]);
  holdAutomaticTurns(id);
  queuePrompt(id, { text: "queued ask" }, { paused: true });
  const resumeHold = captureHumanResume(id);

  await continueOnModel(claude, {
    failureAt,
    model: { provider: SOL.provider, id: SOL.id },
    resumeHold,
  });

  const [onPi] = opened;
  assert.ok(onPi, "the session opened on pi");
  const row = sessionStore.get(id);
  assert.equal(row?.harness, "pi");
  assert.equal(row?.pendingRuntime, undefined, "the selection was applied");
  assert.equal(onPi.promptTexts.length, 1, "one continuation, nothing more");
  assert.match(onPi.promptTexts[0] ?? "", /Continue the interrupted turn/);
  assert.deepEqual(userTexts(id), ["first ask"], "no user row was added");
  assert.equal(automaticTurnsHeld(id), false, "the click lifted the Stop");
  const queue = promptQueueField(id).promptQueue;
  assert.deepEqual(
    queue?.items.map((item) => item.text),
    ["queued ask"],
    "the queued message waits for the continuation",
  );
  assert.equal(queue?.paused, false, "and follows it on the new engine");
});

test("a Claude model is offered only where the picked account lists it: Mythos never on an account without it", async () => {
  const { id, claude, failureAt, runId } = await failedOnClaude("mythos");
  sessionStore.recordContinueOffer(id, runId, [SOL]);
  await continueOnModel(claude, {
    failureAt,
    model: { provider: SOL.provider, id: SOL.id },
    resumeHold: undefined,
  });
  assert.equal(sessionStore.get(id)?.harness, "pi");
  // Now on pi, so the Claude models are the other engine's. Routing stays
  // mocked (the router's own entitlement filter is its suite's); the listing
  // of the account it picks is judged for real.
  gates.real = true;
  const { curatedModelOption } = await import("./harnesses/curatedModels.ts");
  gates.picker = ["sonnet", "mythos"].map((alias) => {
    const option = curatedModelOption("claude-sdk", alias);
    assert.ok(option, alias);
    return option;
  });
  const listing = (ids: string[] | undefined) =>
    resetClaudeAccountModelsForTests({
      read: async (account) => (account === "claude-default" ? ids : undefined),
    });
  const offered = async () =>
    (await continueChoices(id)).map((choice) => choice.id).sort();

  listing(["claude-sonnet-5-5"]);
  assert.deepEqual(await offered(), ["sonnet"], "not listed: no Mythos");
  listing(undefined);
  assert.deepEqual(await offered(), ["sonnet"], "unknown: no Mythos either");
  listing(["claude-sonnet-5-5", "claude-mythos-5-2"]);
  assert.deepEqual(await offered(), ["mythos", "sonnet"], "listed: offered");
});

test("a click on a failure that no longer offers the model changes nothing", async () => {
  const { id, claude, failureAt, runId } = await failedOnClaude("stale");
  sessionStore.recordContinueOffer(id, runId, [SOL]);
  await assert.rejects(
    continueOnModel(claude, {
      failureAt: failureAt - 1,
      model: { provider: SOL.provider, id: SOL.id },
      resumeHold: undefined,
    }),
    ContinueOfferGoneError,
  );
  await assert.rejects(
    continueOnModel(claude, {
      failureAt,
      model: { provider: "openai-codex", id: "gpt-5.4-mini" },
      resumeHold: undefined,
    }),
    ContinueOfferGoneError,
  );
  assert.equal(sessionStore.get(id)?.pendingRuntime, undefined);
  assert.equal(sessionStore.get(id)?.harness, "claude-sdk");
  assert.deepEqual(opened, []);
});

/** A gate: `entered` once something waits on it, open after `release()`. */
function gate() {
  let release!: () => void;
  let enter!: () => void;
  const open = new Promise<void>((resolve) => (release = resolve));
  const entered = new Promise<void>((resolve) => (enter = resolve));
  return {
    release,
    entered,
    wait: async () => {
      enter();
      await open;
    },
  };
}

test.each([
  ["a run start", (id: string) => sessionStore.clearRunFailure(id)],
  [
    "a newer failure",
    (id: string) =>
      sessionStore.recordRunFailure(id, "again", Date.now() + 1, "run-newer"),
  ],
] as const)(
  "%s while Continue resolves its target retires the offer, and nothing is left pending",
  async (_name, retire) => {
    const { id, claude, failureAt, runId } = await failedOnClaude("retired");
    sessionStore.recordContinueOffer(id, runId, [SOL]);
    const held = gate();
    gates.offers = held.wait;
    const click = continueOnModel(claude, {
      failureAt,
      model: { provider: SOL.provider, id: SOL.id },
      resumeHold: undefined,
    });
    await held.entered;
    retire(id);
    held.release();
    await assert.rejects(click, ContinueOfferGoneError);
    assert.equal(
      sessionStore.get(id)?.pendingRuntime,
      undefined,
      "a retired offer writes nothing",
    );
    assert.equal(sessionStore.get(id)?.harness, "claude-sdk");
    assert.deepEqual(opened, []);
  },
);

test("an offer computed for one failure never attaches to a newer one that started no run", async () => {
  const uninstall = installContinueOffers();
  try {
    const { id, runId } = await failedOnClaude("replaced");
    const held = gate();
    gates.pick = held.wait;
    terminal.listener!({
      sessionId: id,
      runId,
      origin: undefined,
      errorMessage: undefined,
      failure: { kind: "quota" },
      at: Date.now(),
    });
    await held.entered;
    // A pending selection's hold records its reason without starting a run.
    sessionStore.recordRunFailure(
      id,
      "Waiting for background work on Claude; stop it to switch now.",
      Date.now() + 1,
    );
    held.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const failure = sessionStore.get(id)?.lastError;
    assert.match(failure?.message ?? "", /Waiting for background work/);
    assert.equal(failure?.continueOn, undefined);
  } finally {
    uninstall();
  }
});

/**
 * A session on a driver whose turns end in the provider's normalized failure
 * (`runCompleted` with its facts), as a real harness reports one.
 */
function failingSession(name: string) {
  const id = `continue-real-${Date.now()}-${name}`;
  ids.push(id);
  sessionStore.upsert({
    id,
    harness: "claude-sdk",
    agentType: "assistant",
    provider: "claude",
    model: "sonnet",
    credentialProfileId: "claude-default",
  });
  const driver = new FakeRuntimeDriver(id);
  const next = {
    kind: "quota" as "quota" | "auth" | undefined,
    message: "You've hit your usage limit.",
  };
  const createAdapter = driver.createRuntimeAdapter.bind(driver);
  driver.createRuntimeAdapter = () => {
    const adapter = createAdapter();
    const listeners = new Set<(event: unknown) => void>();
    adapter.subscribe = (listener) => {
      listeners.add(listener as never);
      return () => listeners.delete(listener as never);
    };
    const prompt = adapter.prompt.bind(adapter);
    adapter.prompt = async (...args) => {
      const kind = next.kind;
      driver.behavior = kind
        ? { mode: "error", message: next.message }
        : { mode: "success" };
      const result = await prompt(...args);
      if (kind)
        for (const listener of listeners)
          listener({
            type: "runCompleted",
            stopReason: "error",
            errorMessage: next.message,
            failure: { kind },
          });
      return result;
    };
    return adapter;
  };
  const live = ensureRuntimeSessionWithRuntime(sessionRuntime, driver);
  const failWith = (kind: "quota" | "auth" | undefined, message = "") => {
    next.kind = kind;
    next.message = message;
  };
  return { id, driver, live, failWith };
}

const { installSessionActivityTracking } = await import("./sessionActivity.ts");
const { setRunFailureHook } = await import("./session/runtime/liveSession.ts");

test("a real quota failure's offer lands on that failure", async () => {
  const offActivity = installSessionActivityTracking();
  const offOffers = installContinueOffers();
  try {
    const { id, driver } = failingSession("ordinary");
    await assert.rejects(
      promptRuntimeSessionWithRuntime(sessionRuntime, driver, "quota ask"),
    );
    await vi.waitFor(() =>
      assert.deepEqual(
        sessionStore.get(id)?.lastError?.continueOn?.map((c) => c.id),
        [SOL.id, "gpt-5.4-mini"],
      ),
    );
  } finally {
    offOffers();
    offActivity();
  }
});

test("a recovered turn's offer lands on its last attempt's failure, not the first's", async () => {
  const offActivity = installSessionActivityTracking();
  const offOffers = installContinueOffers();
  const { id, driver, live } = failingSession("deferred");
  // Recovery's shape (`sessionAccountSwitch.ts`): each failed attempt's
  // settlement is deferred, the continuation runs as its own run, and once it
  // fails too every attempt settles with its failure, the first publishing.
  const finishes: Array<ReturnType<typeof live.deferRunSettlement>> = [];
  const runs: string[] = [];
  let continuation: Promise<unknown> | undefined;
  let failed: import("./session/runtime/liveSession.ts").RunFailureReport;
  const off = live.subscribeRuns((event) => {
    if (event.type === "failed") {
      failed = event.report;
      runs.push(event.report.runId);
      finishes.push(live.deferRunSettlement(event.report.runId));
    } else if (event.type === "ended" && runs.length === 1)
      setImmediate(() => {
        continuation = promptRuntimeSessionWithRuntime(
          sessionRuntime,
          driver,
          "",
          { hidden: true, continuation: true },
        ).catch(() => undefined);
      });
    else if (event.type === "ended")
      setImmediate(() =>
        finishes.forEach((finish, index) =>
          finish(event.outcome, failed, index === 0),
        ),
      );
  });
  try {
    await assert.rejects(
      promptRuntimeSessionWithRuntime(sessionRuntime, driver, "quota ask"),
    );
    await continuation;
    assert.equal(runs.length, 2, "the continuation ran as its own run");
    await vi.waitFor(() =>
      assert.deepEqual(
        sessionStore.get(id)?.lastError?.continueOn?.map((c) => c.id),
        [SOL.id, "gpt-5.4-mini"],
      ),
    );
  } finally {
    off();
    offOffers();
    offActivity();
  }
});

test("a retried report of an older quota failure never offers on a newer run's failure", async () => {
  const offActivity = installSessionActivityTracking();
  const offOffers = installContinueOffers();
  // The durable hook cannot store the quota failure until the auth turn: the
  // runtime keeps the quota report and retries it at that turn's end, after
  // the auth failure is the row's.
  let stored = false;
  const retried: string[] = [];
  setRunFailureHook((report) => {
    if (report.failure?.kind === "auth") stored = true;
    else if (!stored) throw new Error("recorder outage");
    else retried.push(report.runId);
  });
  try {
    const { id, driver, failWith } = failingSession("retried");
    await assert.rejects(
      promptRuntimeSessionWithRuntime(sessionRuntime, driver, "quota ask"),
    );
    failWith("auth", "OAuth token has expired");
    await assert.rejects(
      promptRuntimeSessionWithRuntime(sessionRuntime, driver, "auth ask"),
    );
    assert.equal(retried.length, 1, "the quota report was published late");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const failure = sessionStore.get(id)?.lastError;
    assert.equal(failure?.message, "OAuth token has expired");
    assert.equal(failure?.continueOn, undefined);
  } finally {
    setRunFailureHook(undefined);
    offOffers();
    offActivity();
  }
});

test("a retried report of a quota failure a later turn moved past offers nothing", async () => {
  const offActivity = installSessionActivityTracking();
  const offOffers = installContinueOffers();
  let outage = true;
  let retried = 0;
  setRunFailureHook(() => {
    if (outage) throw new Error("recorder outage");
    retried++;
  });
  try {
    const { id, driver, failWith } = failingSession("moved-past");
    await assert.rejects(
      promptRuntimeSessionWithRuntime(sessionRuntime, driver, "quota ask"),
    );
    outage = false;
    // A later turn that answers: the retry at its boundary publishes the old
    // report, but the row's failure went with that turn's start.
    failWith(undefined);
    await promptRuntimeSessionWithRuntime(sessionRuntime, driver, "next ask");
    assert.ok(retried >= 1, "the quota report was published late");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(sessionStore.get(id)?.lastError, undefined);
  } finally {
    setRunFailureHook(undefined);
    offOffers();
    offActivity();
  }
});
