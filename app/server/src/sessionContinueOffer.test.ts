/**
 * "Continue on <model>" (`docs/session-runtime-switching.md` "Continue on
 * another model"): the offer a quota or rate-limit failure carries, and the
 * user's click, which moves the session to the chosen engine and continues the
 * failed turn there — no user row, the user's authority past a Stop, ahead of
 * queued work, which stays for after it.
 */
import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import type { ModelOption } from "@assistant/shared";
import { randomUUID } from "node:crypto";

/** A test may hold eligibility or routing open to act while they resolve. */
const gates = vi.hoisted(() => ({
  offers: undefined as undefined | (() => Promise<void>),
  pick: undefined as undefined | (() => Promise<void>),
}));

vi.mock("./harnesses/models.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./harnesses/models.ts")>();
  return {
    ...original,
    pickerModels: (): ModelOption[] => [
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
    accountOffersSelection: async () => {
      await gates.offers?.();
      return true;
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
afterEach(async () => {
  gates.offers = undefined;
  gates.pick = undefined;
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
  sessionStore.recordRunFailure(id, "You've hit your usage limit.");
  const failureAt = sessionStore.get(id)?.lastError?.at;
  assert.ok(failureAt !== undefined);
  return { id, claude, failureAt };
}

function userTexts(id: string): string[] {
  return readHandoffRecords(logPathFor(id), 0)
    .filter((record) => record.role === "user")
    .map((record) => record.text);
}

test("the offer sits beside its own failure only, and leaves with it", async () => {
  const { id, failureAt } = await failedOnClaude("offer");
  assert.equal(
    sessionStore.recordContinueOffer(id, failureAt - 1, [SOL]),
    false,
    "an older failure's offer is never attached to a newer one",
  );
  assert.equal(sessionStore.get(id)?.lastError?.continueOn, undefined);
  assert.equal(sessionStore.recordContinueOffer(id, failureAt, [SOL]), true);
  assert.deepEqual(sessionStore.get(id)?.lastError?.continueOn, [SOL]);

  sessionStore.recordRunFailure(id, "again", failureAt + 1);
  assert.equal(
    sessionStore.get(id)?.lastError?.continueOn,
    undefined,
    "a new failure starts without an offer",
  );
  sessionStore.recordContinueOffer(id, failureAt + 1, [SOL]);
  sessionStore.clearRunFailure(id);
  assert.equal(sessionStore.get(id)?.lastError, undefined);
});

test("only a terminal quota or rate-limit failure is offered a model to continue on", async () => {
  const uninstall = installContinueOffers();
  try {
    const { id } = await failedOnClaude("terminal");
    const report = (kind: "quota" | "rate_limit" | "auth", runId: string) =>
      terminal.listener!({
        sessionId: id,
        runId,
        origin: undefined,
        errorMessage: undefined,
        failure: { kind },
        at: Date.now(),
      });
    report("auth", "run-auth");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sessionStore.get(id)?.lastError?.continueOn, undefined);

    report("quota", "run-quota");
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
  const { id, claude, failureAt } = await failedOnClaude("continue");
  sessionStore.recordContinueOffer(id, failureAt, [SOL]);
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

test("a click on a failure that no longer offers the model changes nothing", async () => {
  const { id, claude, failureAt } = await failedOnClaude("stale");
  sessionStore.recordContinueOffer(id, failureAt, [SOL]);
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
    (id: string) => sessionStore.recordRunFailure(id, "again", Date.now() + 1),
  ],
] as const)(
  "%s while Continue resolves its target retires the offer, and nothing is left pending",
  async (_name, retire) => {
    const { id, claude, failureAt } = await failedOnClaude("retired");
    sessionStore.recordContinueOffer(id, failureAt, [SOL]);
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
    const { id } = await failedOnClaude("replaced");
    const held = gate();
    gates.pick = held.wait;
    terminal.listener!({
      sessionId: id,
      runId: "run-quota",
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
