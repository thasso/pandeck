/**
 * A turn whose pending selection names another engine
 * (`docs/session-runtime-switching.md`): its admission moves the session
 * there, the turn runs on the new driver with the switch's handoff as
 * model-only context, and a viewer attached to the old driver follows. A
 * refusal after the move puts the session back on its old binding with the
 * selection pending.
 */
import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import type {
  ClientMessage,
  ModelOption,
  ServerMessage,
  SessionPendingRuntime,
} from "@assistant/shared";

vi.mock("./harnesses/models.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./harnesses/models.ts")>();
  return {
    ...original,
    pickerModels: (): ModelOption[] => [
      {
        provider: "openai-codex",
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        contextWindow: 272_000,
      } as ModelOption,
    ],
  };
});
// The library is not under test: a skill the session froze is user-invocable.
vi.mock("./sessionSkills.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sessionSkills.ts")>()),
  skillUserInvocable: async () => true,
}));
vi.mock("./sessionAccountMove.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./sessionAccountMove.ts")>();
  // Account listing and health are not under test: the account serves the model.
  return {
    ...original,
    modelRefusal: async () => undefined,
    assertStillEligible: () => {},
  };
});

const { claudeSdkStore } = await import("./claudeSdk/claudeSdkStore.ts");
const { Connection } = await import("./connection.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { getDb } = await import("./db/index.ts");
const { setDeliveryWake } = await import("./deliveryWake.ts");
const { isSwitchingEngines } = await import("./harnesses/engineSwitchFence.ts");
const { hub } = await import("./hub.ts");
const { openPiEngine } = await import("./piSdk/piEngineHost.ts");
const { piStore } = await import("./piSdk/piStore.ts");
const { sessionRuntime } = await import("./session/runtimeInstance.ts");
const { logPathFor } = await import("./session/log/persistence.ts");
const { ensureRuntimeSessionWithRuntime, promptRuntimeSessionWithRuntime } =
  await import("./session/runtimePrompt.ts");
const { readHandoffRecords } = await import("./sessionHandoff.ts");
const { setPendingRuntimeHostForTests } =
  await import("./sessionPendingRuntime.ts");
const { installClaudeStateBuilder } =
  await import("./test/claudeSdkSession.ts");
const { claudeTurnSeam } = await import("./test/claudeTurnSeam.ts");
const { FakeRuntimeDriver } = await import("./test/fakeRuntimeDriver.ts");
const { parseServerFrame } = await import("./test/serverFrames.ts");
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

/** pi's side of the switch: a fake driver the turn runs on. */
class PiStandIn extends FakeRuntimeDriver {
  readonly live = true as const;
  released = false;
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
  dispose(): void {
    this.released = true;
  }
}

const opened: PiStandIn[] = [];
const ids: string[] = [];

beforeAll(() => {
  claudeSdkStore.setSeam(() => Promise.resolve(claudeTurnSeam));
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
    wake: () => {},
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
  pi.live.clear();
  opened.length = 0;
  for (const id of ids.splice(0)) {
    claudeSdkStore.remove(id);
    await sessionRuntime.disposeSession(id);
  }
});
afterAll(() => {
  pi.openEngine = originalOpenEngine;
  pi.track = originalTrack;
  setPendingRuntimeHostForTests(undefined);
});

const PENDING: SessionPendingRuntime = {
  model: { provider: "openai-codex", id: "gpt-5.6-sol" },
  thinkingLevel: "high",
  account: { kind: "account", id: "default" },
  setBy: "user",
};

/** A titled Claude session with one answered turn, its selection pending on pi. */
async function claudeWithPendingPi(name: string) {
  const id = `engine-switch-turn-${Date.now()}-${name}`;
  ids.push(id);
  const claude = claudeSdkStore.acquire(id, { modelId: "sonnet" });
  claude.setTitle("switch turn");
  ensureRuntimeSessionWithRuntime(sessionRuntime, claude);
  await promptRuntimeSessionWithRuntime(sessionRuntime, claude, "first ask");
  sessionStore.setPendingRuntime(id, PENDING);
  return { id, claude };
}

function userTexts(id: string): string[] {
  return readHandoffRecords(logPathFor(id), 0)
    .filter((record) => record.role === "user")
    .map((record) => record.text);
}

test("the turn runs on the new engine with the handoff, and an attached viewer follows", async () => {
  const { id, claude } = await claudeWithPendingPi("viewer");
  const sent: ServerMessage[] = [];
  const conn = new Connection({
    OPEN: 1,
    readyState: 1,
    send: (frame: string | Buffer) => sent.push(parseServerFrame(frame)),
  } as never) as unknown as {
    view(live: unknown): void;
    viewing: unknown;
    ensureViewingDriver(): Promise<unknown>;
    handle(msg: ClientMessage): Promise<void>;
    dispose(): void;
  };
  hub.register(conn as never);
  try {
    conn.view(claude);
    assert.equal(conn.viewing, claude);

    await promptRuntimeSessionWithRuntime(sessionRuntime, claude, "second ask");

    const [onPi] = opened;
    assert.ok(onPi, "the session opened on pi");
    assert.equal(claude.released, true, "Claude let the session go");
    assert.equal(isSwitchingEngines(id), false);
    const row = sessionStore.get(id);
    assert.equal(row?.harness, "pi");
    assert.equal(row?.credentialProfileId, "default");
    assert.equal(row?.pendingRuntime, undefined, "the selection is spent");
    assert.deepEqual(
      sessionStore.bindings(id).map((binding) => binding.harness),
      ["claude-sdk", "pi"],
    );

    // The turn ran on pi with the handoff as model-only context; the log keeps
    // the clean text.
    assert.equal(onPi.promptTexts.length, 1);
    const [model] = onPi.promptTexts;
    assert.match(
      model ?? "",
      /^<session-switch>\nSession switch: this session/,
    );
    assert.match(model ?? "", /moved from sonnet · Claude to GPT-5\.6 Sol · /);
    assert.match(
      model ?? "",
      /<session-history>[\s\S]*first ask[\s\S]*a reply/,
    );
    assert.match(model ?? "", /<\/session-history>\n\nsecond ask$/);
    assert.deepEqual(userTexts(id), ["first ask", "second ask"]);

    // The viewer moved to the new driver, and its commands reach it.
    assert.equal(conn.viewing, onPi);
    assert.equal(await conn.ensureViewingDriver(), onPi);
    await conn.handle({ type: "prompt", text: "third ask" } as ClientMessage);
    // The connection starts the turn without awaiting it.
    await vi.waitFor(() => assert.equal(onPi.promptTexts.length, 2));
    // pi has not answered (the stand-in writes no reply), so the handoff is
    // still owed.
    assert.match(
      onPi.promptTexts[1] ?? "",
      /^<session-switch>[\s\S]*third ask$/,
    );
    assert.deepEqual(userTexts(id), ["first ask", "second ask", "third ask"]);
  } finally {
    hub.unregister(conn as never);
    conn.dispose();
  }
});

test("a refusal after the move puts the session back on its old binding", async () => {
  const { id, claude } = await claudeWithPendingPi("refused");
  await assert.rejects(
    promptRuntimeSessionWithRuntime(sessionRuntime, claude, "second ask", {
      admit: () => {
        throw new Error("refused at the last admission");
      },
    }),
    /refused at the last admission/,
  );
  const [onPi] = opened;
  assert.equal(onPi?.released, true, "pi let the session go");
  assert.equal(piStore.getLiveById(id), undefined);
  assert.equal(isSwitchingEngines(id), false);
  assert.equal(sessionStore.get(id)?.harness, "claude-sdk");
  assert.deepEqual(sessionStore.get(id)?.pendingRuntime, PENDING);
  assert.equal(sessionStore.bindings(id).length, 1);
  assert.deepEqual(userTexts(id), ["first ask"], "nothing was appended");
  assert.deepEqual(onPi?.promptTexts, []);
});

test("a skill whose switch is held is kept as a held input, and the session stays where it was", async () => {
  const { id, claude } = await claudeWithPendingPi("held-skill");
  const { promptQueueStore } = await import("./db/promptQueueStore.ts");
  // The session's frozen skills name it, so only the switch can refuse it
  // (the hold comes before the skill is materialized on any engine).
  getDb()
    .prepare("UPDATE session_skills SET names_json = ? WHERE session_id = ?")
    .run(JSON.stringify(["review-pr"]), id);
  const failing = pi.openEngine;
  pi.openEngine = async () => {
    throw new Error("pi could not start");
  };
  const sent: ServerMessage[] = [];
  const conn = new Connection({
    OPEN: 1,
    readyState: 1,
    send: (frame: string | Buffer) => sent.push(parseServerFrame(frame)),
  } as never) as unknown as {
    view(live: unknown): void;
    handle(msg: ClientMessage): Promise<void>;
    dispose(): void;
  };
  hub.register(conn as never);
  try {
    conn.view(claude);
    const typed = "/review-pr 7";
    await conn.handle({
      type: "prompt",
      text: typed,
      skill: "review-pr",
      clientRequestId: "skill-1",
    } as ClientMessage);
    await vi.waitFor(() =>
      assert.ok(sent.some((message) => message.type === "error")),
    );
    const error = sent.find((message) => message.type === "error") as Extract<
      ServerMessage,
      { type: "error" }
    >;
    // The switch's own hold, with sub-PR 2's held-input wording.
    assert.match(error.message, /^Couldn't switch to GPT-5\.6 Sol/);
    assert.match(
      error.message,
      /\/review-pr did not run; it is waiting above your message box/,
    );
    assert.deepEqual(
      promptQueueStore.listHeld(id).map((input) => input.text),
      [typed],
      "kept exactly as typed",
    );
    assert.equal(promptQueueStore.list(id).length, 0, "skills never queue");
    assert.equal(sessionStore.get(id)?.harness, "claude-sdk");
    assert.deepEqual(sessionStore.get(id)?.pendingRuntime, PENDING);
    assert.equal(isSwitchingEngines(id), false);
    assert.deepEqual(userTexts(id), ["first ask"], "nothing was appended");
  } finally {
    pi.openEngine = failing;
    hub.unregister(conn as never);
    conn.dispose();
    promptQueueStore.deleteSession(id);
  }
});
