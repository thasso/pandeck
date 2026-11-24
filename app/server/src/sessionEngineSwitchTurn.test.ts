/**
 * A turn whose pending selection names another engine
 * (`docs/session-runtime-switching.md`): its admission moves the session
 * there, the turn runs on the new driver with the switch's handoff as
 * model-only context, and a viewer attached to the old driver follows. A
 * refusal after the move puts the session back on its old binding with the
 * selection pending.
 */
import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import {
  disableClaudeSdkForTests,
  enableClaudeSdkForTests,
} from "./test/claudeSdkEnabled.ts";
import type {
  ClientMessage,
  ModelOption,
  ServerMessage,
  SessionPendingRuntime,
} from "@assistant/shared";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ClaudeQueryParams,
  ClaudeSdkSeam,
  ClaudeSdkUserMessage,
} from "./claudeSdk/sdkSeam.ts";

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
      {
        provider: "claude-sdk",
        id: "sonnet",
        name: "Claude Sonnet",
        contextWindow: 200_000,
      } as ModelOption,
      {
        provider: "claude-sdk",
        id: "fable",
        name: "Claude Fable",
        contextWindow: 200_000,
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
    selectionListingRefusal: async () => undefined,
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
const { estimateTokens } = await import("./session/runtime/liveBlocks.ts");
const { claudeConfigDir, setCredentialProfileEnabled } =
  await import("./credentialProfiles.ts");
const {
  clearSessionPendingRuntime,
  pendingSwitchHandoffTokens,
  setPendingRuntimeHostForTests,
  setSessionPendingRuntime,
} = await import("./sessionPendingRuntime.ts");
const { installClaudeStateBuilder } =
  await import("./test/claudeSdkSession.ts");
const { claudeTurnSeam } = await import("./test/claudeTurnSeam.ts");
const { resetClaudeAccountModelsForTests } =
  await import("./harnesses/claudeAccountModels.ts");
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
  /** Where the session works: the default directory. */
  commitWorkflowContext() {
    return { sessionManager: undefined };
  }
  dispose(): void {
    this.released = true;
  }
}

const opened: PiStandIn[] = [];
const ids: string[] = [];

/** What each Claude query was asked: the model text and the native resume. */
const claudeQueries: Array<{
  text: string;
  resume: string | undefined;
  model: string | undefined;
}> = [];

async function firstPromptText(
  prompt: ClaudeQueryParams["prompt"],
): Promise<string> {
  if (typeof prompt === "string") return prompt;
  const messages = prompt as AsyncIterable<ClaudeSdkUserMessage>;
  const first = await messages[Symbol.asyncIterator]().next();
  const content = (first.value as ClaudeSdkUserMessage | undefined)?.message
    .content;
  if (typeof content === "string") return content;
  return (content ?? [])
    .map((block) => ("text" in block ? block.text : ""))
    .join("");
}

/** Report the id each query ran as its answering model, as the CLI does. */
const seamOptions = { reportQueryModel: false };
const recordingClaudeSeam: ClaudeSdkSeam = {
  query(params) {
    const turn = claudeTurnSeam.query(params) as AsyncIterable<
      Record<string, unknown>
    >;
    // Native ids are unique across sessions: each session gets its own.
    const native = params.options?.resume ?? `native-${randomUUID()}`;
    return {
      async *[Symbol.asyncIterator]() {
        claudeQueries.push({
          text: await firstPromptText(params.prompt),
          resume: params.options?.resume,
          model: params.options?.model,
        });
        for await (const message of turn) {
          const reported =
            seamOptions.reportQueryModel &&
            message.type === "assistant" &&
            typeof message.message === "object"
              ? {
                  ...message,
                  message: { ...message.message, model: params.options?.model },
                }
              : message;
          yield "session_id" in reported
            ? { ...reported, session_id: native }
            : reported;
        }
      },
    } as never;
  },
  deleteSession: async () => {},
};

beforeAll(() => {
  claudeSdkStore.setSeam(() => Promise.resolve(recordingClaudeSeam));
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
// These tests drive Claude runs; the integration is off by default.
beforeEach(enableClaudeSdkForTests);
afterEach(async () => {
  pi.live.clear();
  opened.length = 0;
  claudeQueries.length = 0;
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
    assert.match(
      model ?? "",
      /moved from Claude Sonnet · Claude to GPT-5\.6 Sol · /,
    );
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

type TestConnection = {
  handle(msg: ClientMessage): Promise<void>;
  dispose(): void;
};

/** A connection whose answers are read back by request id. */
function connect() {
  const sent: ServerMessage[] = [];
  const conn = new Connection({
    OPEN: 1,
    readyState: 1,
    send: (frame: string | Buffer) => sent.push(parseServerFrame(frame)),
  } as never) as unknown as TestConnection;
  hub.register(conn as never);
  const ask = async (msg: ClientMessage & { requestId: string }) => {
    await conn.handle(msg);
    const answer = sent.find(
      (frame) => "requestId" in frame && frame.requestId === msg.requestId,
    );
    assert.ok(answer, `${msg.type} was answered`);
    return answer as ServerMessage & Record<string, unknown>;
  };
  const close = () => {
    hub.unregister(conn as never);
    conn.dispose();
  };
  return { ask, close };
}

/** The host's display-only markers in the session's log, oldest first. */
function notices(id: string): string[] {
  return readFileSync(logPathFor(id), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; message?: string })
    .filter((entry) => entry.type === "provider.notice")
    .map((entry) => entry.message ?? "");
}

/** The model-only context a turn carried ahead of the user's `text`. */
function contextOf(model: string | undefined, text: string): string {
  const tail = `\n\n${text}`;
  assert.ok(model?.endsWith(tail), "the turn ends with its text");
  return (model ?? "").slice(0, -tail.length);
}

/** Claude's account holds the native transcript its binding names, so a return resumes it. */
async function seedClaudeTranscript(id: string): Promise<void> {
  // The binding learns its native id from the turn's result.
  const binding = await vi.waitFor(() => {
    const [first] = sessionStore.bindings(id);
    assert.ok(first?.nativeSessionId && first.credentialProfileId);
    return first as typeof first & {
      nativeSessionId: string;
      credentialProfileId: string;
    };
  });
  const dir = join(
    claudeConfigDir(binding.credentialProfileId),
    "projects",
    "engine-switch-turn",
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${binding.nativeSessionId}.jsonl`), "");
}

test("Claude → pi → Claude through the set path: marker, estimate, handoff, and the return's delta", async () => {
  const id = `engine-switch-turn-${Date.now()}-set-path`;
  ids.push(id);
  const claude = claudeSdkStore.acquire(id, { modelId: "sonnet" });
  claude.setTitle("switch turn");
  ensureRuntimeSessionWithRuntime(sessionRuntime, claude);
  await promptRuntimeSessionWithRuntime(sessionRuntime, claude, "first ask");
  await seedClaudeTranscript(id);
  const { ask, close } = connect();
  try {
    // The inspector's set: a model of another engine with its account.
    const set = await ask({
      type: "setPendingRuntime",
      sessionId: id,
      requestId: "set-pi",
      model: { provider: "openai-codex", id: "gpt-5.6-sol" },
      account: { kind: "account", id: "default" },
    });
    assert.equal(set.type, "pendingRuntimeAnswer");
    assert.equal(set.error, undefined);
    assert.equal(sessionStore.get(id)?.pendingRuntime?.setBy, "user");

    // The estimate the inspector shows is the handoff the turn delivers.
    const estimate = await ask({
      type: "estimateSessionHandoff",
      sessionId: id,
      requestId: "estimate-pi",
    });
    assert.equal(estimate.type, "sessionHandoffEstimate");
    assert.equal(typeof estimate.tokens, "number");

    await promptRuntimeSessionWithRuntime(sessionRuntime, claude, "second ask");
    const [onPi] = opened;
    assert.ok(onPi, "the session opened on pi");
    const toPi = contextOf(onPi.promptTexts[0], "second ask");
    assert.equal(estimate.tokens, estimateTokens(toPi));
    assert.match(toPi, /moved from Claude Sonnet · Claude to GPT-5\.6 Sol · /);
    assert.match(toPi, /<session-history>[\s\S]*first ask[\s\S]*a reply/);
    assert.match(
      notices(id).at(-1) ?? "",
      /^Switched from Claude Sonnet · Claude to GPT-5\.6 Sol · Default OpenAI — chosen by you\.$/,
    );

    // Back to Claude on the account that holds its transcript, which the
    // return resumes. (This test host has no logged-in account for Automatic
    // to route to.)
    await setSessionPendingRuntime(
      id,
      {
        model: { provider: "claude-sdk", id: "sonnet" },
        account: { kind: "account", id: "claude-default" },
      },
      "user",
    );
    const back = await pendingSwitchHandoffTokens(id);
    await promptRuntimeSessionWithRuntime(sessionRuntime, onPi, "third ask");
    assert.equal(onPi.released, true, "pi let the session go");
    assert.equal(sessionStore.get(id)?.harness, "claude-sdk");
    const resumedNative = sessionStore.bindings(id)[0]?.nativeSessionId;
    const last = claudeQueries.at(-1);
    assert.equal(last?.resume, resumedNative, "Claude resumed its transcript");
    const toClaude = contextOf(last?.text, "third ask");
    assert.equal(back, estimateTokens(toClaude));
    // Only what Claude missed: the turn on pi, not the turn it already holds.
    assert.match(toClaude, /<session-history>[\s\S]*second ask/);
    assert.doesNotMatch(toClaude, /first ask/);
    assert.match(
      notices(id).at(-1) ?? "",
      /^Switched from GPT-5\.6 Sol · .+ to Claude Sonnet · .+ — chosen by you\.$/,
    );
    assert.deepEqual(
      sessionStore.bindings(id).map((binding) => binding.harness),
      ["claude-sdk", "pi", "claude-sdk"],
    );
    assert.deepEqual(userTexts(id), ["first ask", "second ask", "third ask"]);
  } finally {
    close();
  }
});

test("a session's usage is the sum over its engines, Claude → pi → Claude, and a return counts Claude's earlier usage once (F027)", async () => {
  const { id, claude } = await claudeWithPendingPi("usage");
  await seedClaudeTranscript(id);
  const usage = () => {
    const totals = sessionStore.getUsageTotals(id);
    return {
      input: totals?.inputTokens,
      output: totals?.outputTokens,
      cost: totals?.costMicros,
    };
  };
  // Each Claude query reports 1 input, 1 output and $0.01 for its epoch.
  assert.deepEqual(usage(), { input: 1, output: 1, cost: 10_000 });

  await promptRuntimeSessionWithRuntime(sessionRuntime, claude, "second ask");
  const [onPi] = opened;
  assert.ok(onPi, "the session opened on pi");
  // pi counts run by run: its turn's assistant entry adds its own usage (the
  // stand-in writes no reply, so the entry's figure is added as the log does).
  sessionStore.recordUsageTurn(id, {
    inputTokens: 7_776,
    outputTokens: 0,
    costUSD: 1,
  });
  assert.deepEqual(usage(), { input: 7_777, output: 1, cost: 1_010_000 });

  await setSessionPendingRuntime(
    id,
    {
      model: { provider: "claude-sdk", id: "sonnet" },
      account: { kind: "account", id: "claude-default" },
    },
    "user",
  );
  await promptRuntimeSessionWithRuntime(sessionRuntime, onPi, "third ask");
  assert.equal(sessionStore.get(id)?.harness, "claude-sdk");
  const back = claudeSdkStore.get(id);
  assert.ok(back && back !== claude, "the return opened Claude afresh");
  // The record Claude resumed already counts its first turn: the session adds
  // only the return's own turn to pi's, never that first turn again.
  assert.deepEqual(usage(), { input: 7_778, output: 2, cost: 1_020_000 });

  // The base is durable: a reopen writes the record's totals over it again.
  await claudeSdkStore.releaseForSwitch(id, () => {});
  claudeSdkStore.acquire(id, {});
  assert.deepEqual(usage(), { input: 7_778, output: 2, cost: 1_020_000 });
});

test("a target that cannot run is held as the session's failure, the selection still pending", async () => {
  const { id, claude } = await claudeWithPendingPi("held");
  setCredentialProfileEnabled("default", false);
  try {
    await assert.rejects(
      promptRuntimeSessionWithRuntime(sessionRuntime, claude, "second ask"),
      /Couldn't switch to GPT-5\.6 Sol/,
    );
    assert.match(
      sessionStore.get(id)?.lastError?.message ?? "",
      /^Couldn't switch to GPT-5\.6 Sol.*The change is still pending/,
    );
    assert.deepEqual(sessionStore.get(id)?.pendingRuntime, PENDING);
    assert.equal(sessionStore.get(id)?.harness, "claude-sdk");
    assert.deepEqual(opened, [], "pi never opened");
  } finally {
    setCredentialProfileEnabled("default", true);
  }
});

test("with the Claude SDK disabled a switch to Claude is refused when set and held when applied, and nothing reaches Claude", async () => {
  const { id, claude } = await claudeWithPendingPi("sdk-disabled");
  await promptRuntimeSessionWithRuntime(sessionRuntime, claude, "second ask");
  const [onPi] = opened;
  assert.ok(onPi, "the session opened on pi");
  const back = {
    model: { provider: "claude-sdk", id: "sonnet" },
    account: { kind: "account", id: "claude-default" },
  } as const;
  await setSessionPendingRuntime(id, back, "user");
  const pending = sessionStore.get(id)?.pendingRuntime;
  assert.ok(pending);
  const queriesBefore = claudeQueries.length;

  await disableClaudeSdkForTests();
  // Applied: held with the setting's own refusal; the session stays on pi.
  await assert.rejects(
    promptRuntimeSessionWithRuntime(sessionRuntime, onPi, "third ask"),
    /Couldn't switch to Claude Sonnet: Claude SDK is disabled in settings\./,
  );
  assert.match(
    sessionStore.get(id)?.lastError?.message ?? "",
    /Claude SDK is disabled in settings.*The change is still pending/,
  );
  assert.equal(sessionStore.get(id)?.harness, "pi");
  assert.deepEqual(sessionStore.get(id)?.pendingRuntime, pending);
  assert.equal(claudeQueries.length, queriesBefore, "no Claude query opened");
  assert.equal(onPi.released, false, "pi kept the session");

  // Set: refused before any account is judged.
  await clearSessionPendingRuntime(id);
  await assert.rejects(setSessionPendingRuntime(id, back, "user"), {
    message:
      'Claude SDK is disabled in settings. Turn on "Enable Claude SDK sessions" in Settings > Claude SDK to run Claude models.',
  });
  assert.equal(sessionStore.get(id)?.pendingRuntime, undefined);
});

test("a switch to Claude opens on the id the target account lists for the alias, and the binding keeps the alias", async () => {
  const { id, claude } = await claudeWithPendingPi("alias-resolution");
  await promptRuntimeSessionWithRuntime(sessionRuntime, claude, "second ask");
  const [onPi] = opened;
  assert.ok(onPi, "the session opened on pi");
  // The target account lists fable 5-1 only: that is what the switch runs.
  seamOptions.reportQueryModel = true;
  resetClaudeAccountModelsForTests({
    read: async (accountId) =>
      accountId === "claude-default"
        ? ["claude-fable-5-1", "claude-sonnet-5-5"]
        : undefined,
  });
  try {
    await setSessionPendingRuntime(
      id,
      {
        model: { provider: "claude-sdk", id: "fable" },
        account: { kind: "account", id: "claude-default" },
      },
      "user",
    );
    await promptRuntimeSessionWithRuntime(sessionRuntime, onPi, "third ask");
    assert.equal(sessionStore.get(id)?.harness, "claude-sdk");
    assert.equal(claudeQueries.at(-1)?.model, "claude-fable-5-1");
    // The record and the binding keep the alias, never the concrete id the
    // provider reports.
    assert.equal(sessionStore.get(id)?.model, "fable");
    const binding = sessionStore.bindings(id).at(-1);
    assert.equal(binding?.harness, "claude-sdk");
    assert.equal(binding?.credentialProfileId, "claude-default");
    assert.equal(binding?.model, "fable");
  } finally {
    seamOptions.reportQueryModel = false;
    resetClaudeAccountModelsForTests();
  }
});
