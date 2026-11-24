/**
 * The cross-harness store move up to its commit
 * (`docs/session-runtime-switching.md` "Store move", "Switching fence"): a
 * session leaves Claude for pi (and returns) under the same app id, nothing
 * reaches it while it moves, the binding commits in one transaction, and every
 * way out before the commit leaves it on its old binding with its selection
 * pending. A commit offers the session its waiting work; a rollback does when
 * the fence refused someone meanwhile.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, test, vi } from "vitest";

/** Naming runs, each answered by the test. */
const titles = vi.hoisted(() => [] as Array<(title: string) => void>);
vi.mock("../sessionNaming.ts", async (original) => ({
  ...(await original<object>()),
  generateSessionTitle: () =>
    new Promise<string>((resolve) => titles.push(resolve)),
}));
import type { SessionPendingRuntime } from "@assistant/shared";
import { claudeSdkStore } from "../claudeSdk/claudeSdkStore.ts";
import {
  claudeConfigDir,
  createCredentialProfile,
  setCredentialProfileEnabled,
} from "../credentialProfiles.ts";
import { sessionStore } from "../db/sessionStore.ts";
import { setDeliveryWake } from "../deliveryWake.ts";
import { openPiEngine } from "../piSdk/piEngineHost.ts";
import { piStore } from "../piSdk/piStore.ts";
import { SessionHeldElsewhereError } from "../harness.ts";
import { sessionRuntime } from "../session/runtimeInstance.ts";
import {
  CLAUDE_SDK_STORE_DIR,
  canonicalPiSessionPath,
} from "../sessionStorage.ts";
import { owedSwitchContext } from "../sessionSwitchHandoff.ts";
import { logPathFor } from "../session/log/persistence.ts";
import { ensureRuntimeSessionWithRuntime } from "../session/runtimePrompt.ts";
import { installClaudeStateBuilder } from "../test/claudeSdkSession.ts";
import { claudeTurnSeam } from "../test/claudeTurnSeam.ts";
import { seedLegacyDefaultAccounts } from "../test/legacyDefaultAccounts.ts";
import {
  prepareEngineSwitch,
  type EngineSwitchTarget,
} from "./engineSwitch.ts";
import {
  isSwitchingEngines,
  SessionSwitchingEnginesError,
} from "./engineSwitchFence.ts";
import { routingSpendLines } from "../workflow/runSpend.ts";
import { harnessRegistry } from "./registry.ts";
import { pickerModels, storedSessionModelOption } from "./models.ts";
import { runClearForHost } from "../hostSlashCommands.ts";
import { enableClaudeSdkForTests } from "../test/claudeSdkEnabled.ts";

beforeEach(enableClaudeSdkForTests);

installClaudeStateBuilder(claudeSdkStore);
await seedLegacyDefaultAccounts();

type PiEngineOpened = import("../piSdk/piEngineHost.ts").PiEngineOpened;
type PiEngineOpenSpec = import("../piSdk/piEngineHost.ts").PiEngineOpenSpec;
interface PiInternals {
  openEngine: (spec: PiEngineOpenSpec) => Promise<PiEngineOpened>;
  track: (kind: string, opened: PiEngineOpened) => unknown;
  live: Map<string, unknown>;
}
const pi = piStore as unknown as PiInternals;
const originalOpenEngine = pi.openEngine;
const originalTrack = pi.track;

const wakes: string[] = [];
let counter = 0;
const ids: string[] = [];
function freshId(): string {
  const id = `engine-switch-${Date.now()}-${counter++}`;
  ids.push(id);
  return id;
}

beforeAll(() => {
  claudeSdkStore.setSeam(() => Promise.resolve(claudeTurnSeam));
  // The registry's host wiring, so both stores ask it before registering an
  // id, as they do in the server; Claude keeps the test state builder.
  harnessRegistry.setHost({
    sessionRowsChanged: () => {},
    noteRunStarted: () => {},
    checkPendingReload: () => {},
    isReloadQueued: () => false,
    buildSessionState: () => ({}) as never,
  } as never);
  installClaudeStateBuilder(claudeSdkStore);
  setDeliveryWake((sessionId) => wakes.push(sessionId));
});
afterEach(async () => {
  pi.openEngine = originalOpenEngine;
  pi.track = originalTrack;
  pi.live.clear();
  wakes.length = 0;
  for (const id of ids.splice(0)) {
    claudeSdkStore.remove(id);
    await sessionRuntime.disposeSession(id);
  }
});

/** pi opens for real over a stand-in agent session, registered as a minimal live session. */
function piOpensForReal(): PiEngineOpenSpec[] {
  const specs: PiEngineOpenSpec[] = [];
  pi.openEngine = (spec) => {
    specs.push(spec);
    // No model registry here: the spec is what the switch asked for.
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
  pi.track = (kind, { engine }) => {
    const live = {
      kind,
      key: engine.sessionId,
      appId: engine.sessionId,
      engine,
      isRunning: false,
      released: false,
      modelSelection: () => ({
        model: { provider: "openai-codex", id: "gpt-5.6-sol" },
        thinkingLevel: "high" as const,
      }),
      dispose() {
        this.released = true;
      },
      commitWorkflowContext: () => ({ sessionManager: undefined }),
    };
    pi.live.set(engine.sessionId, live);
    return live;
  };
  return specs;
}

/** A Claude session with one committed turn, bound into the runtime. */
async function onClaude(id: string): Promise<void> {
  const session = claudeSdkStore.acquire(id, { modelId: "sonnet" });
  // Titled, so no naming agent runs after its first turn.
  session.setTitle("switch fixture");
  ensureRuntimeSessionWithRuntime(sessionRuntime, session);
  await sessionRuntime.prompt(id, "first");
}

const TO_PI: EngineSwitchTarget = {
  harness: "pi",
  model: { provider: "openai-codex", id: "gpt-5.6-sol" },
  thinkingLevel: "high",
  credentialProfileId: "cp_pi",
};
const PENDING_PI: SessionPendingRuntime = {
  model: TO_PI.model,
  thinkingLevel: "high",
  account: { kind: "automatic" },
  setBy: "user",
};

test("a switch moves the session to pi under its id, fenced until the binding commits", async () => {
  const id = freshId();
  await onClaude(id);
  sessionStore.setPendingRuntime(id, PENDING_PI);
  const specs = piOpensForReal();
  const cursor = sessionRuntime.logCursor(id);
  assert.ok(cursor > 0);

  const prepared = await prepareEngineSwitch(id, TO_PI, PENDING_PI, () => {});
  assert.equal(prepared.resumed, undefined, "no earlier pi binding");
  assert.deepEqual(specs[0]?.transcript.type, "new");
  // Fenced: neither engine shows it, opening it is busy, and the row still
  // names Claude with the selection pending.
  assert.equal(isSwitchingEngines(id), true);
  assert.equal(claudeSdkStore.get(id), undefined);
  assert.equal(harnessRegistry.residentById(id), undefined);
  await assert.rejects(
    harnessRegistry.acquireById(id),
    SessionSwitchingEnginesError,
  );
  assert.equal(sessionStore.get(id)?.harness, "claude-sdk");
  assert.deepEqual(sessionStore.get(id)?.pendingRuntime, PENDING_PI);
  assert.deepEqual(wakes, []);

  prepared.usable();
  prepared.commit();
  assert.equal(isSwitchingEngines(id), false);
  assert.deepEqual(wakes, [id], "lifting the fence offers waiting work");
  assert.equal(harnessRegistry.residentById(id), prepared.driver);
  const row = sessionStore.get(id);
  assert.equal(row?.harness, "pi");
  assert.equal(row?.model, "gpt-5.6-sol");
  assert.equal(row?.credentialProfileId, "cp_pi");
  assert.equal(row?.pendingRuntime, undefined);
  const [claude, next] = sessionStore.bindings(id);
  assert.ok(claude?.endedAt);
  assert.equal(claude?.harness, "claude-sdk");
  assert.equal(next?.seq, 2);
  assert.equal(next?.nativeSessionId, id, "pi's native id is the app id");
  assert.equal(next?.startedSeq, cursor);
  // The runtime session stays, detached for the turn's driver to bind.
  assert.equal(sessionRuntime.get(id)?.isDetached, true);
  assert.throws(() => prepared.commit(), /already ended/);
});

test("a failed open leaves the session on its old binding with its selection, and Claude reopens it", async () => {
  const id = freshId();
  await onClaude(id);
  sessionStore.setPendingRuntime(id, PENDING_PI);
  pi.openEngine = () =>
    Promise.reject(
      new Error("Model openai-codex/gpt-5.6-sol is not available."),
    );
  await assert.rejects(
    prepareEngineSwitch(id, TO_PI, PENDING_PI, () => {}),
    /is not available/,
  );
  assert.equal(isSwitchingEngines(id), false);
  assert.deepEqual(
    wakes,
    [],
    "nothing was refused meanwhile, so nothing retries the failed switch",
  );
  assert.equal(sessionStore.get(id)?.harness, "claude-sdk");
  assert.deepEqual(sessionStore.get(id)?.pendingRuntime, PENDING_PI);
  assert.equal(sessionStore.bindings(id).length, 1);
  const reopened = await harnessRegistry.acquireById(id);
  assert.equal(reopened, claudeSdkStore.get(id));
  assert.equal(
    claudeSdkStore.get(id)?.timelineEntries().length,
    2,
    "its history is intact",
  );
});

test("an admission that fails mid-switch, or an abandon, undoes the move", async () => {
  const id = freshId();
  await onClaude(id);
  piOpensForReal();
  let admissible = true;
  const admit = () => {
    if (!admissible) throw new Error("no longer admissible");
  };
  const prepared = await prepareEngineSwitch(id, TO_PI, PENDING_PI, admit);
  // A delivery refused while the fence is up is offered again once it lifts.
  await assert.rejects(
    harnessRegistry.acquireById(id),
    SessionSwitchingEnginesError,
  );
  await prepared.abandon();
  assert.equal(isSwitchingEngines(id), false);
  assert.deepEqual(wakes, [id]);
  assert.equal(piStore.getLiveById(id), undefined, "pi let it go");
  assert.equal(sessionStore.bindings(id).length, 1);
  assert.throws(() => prepared.usable(), /already ended/);
  await prepared.abandon();
  assert.deepEqual(wakes, [id], "the fence lifts once");

  // Refused at the release step: Claude keeps it.
  wakes.length = 0;
  const session = await harnessRegistry.acquireById(id);
  admissible = false;
  await assert.rejects(
    prepareEngineSwitch(id, TO_PI, PENDING_PI, admit),
    /no longer admissible/,
  );
  assert.equal(claudeSdkStore.get(id), session);
  assert.equal(isSwitchingEngines(id), false);
});

test("a commit refuses once the session's binding moved or it was deleted", async () => {
  const id = freshId();
  await onClaude(id);
  piOpensForReal();
  const prepared = await prepareEngineSwitch(id, TO_PI, PENDING_PI, () => {});
  sessionStore.markDeleted(id);
  assert.throws(() => prepared.usable(), /deleted while it switched/);
  assert.throws(() => prepared.commit(), /deleted while it switched/);
  assert.equal(sessionStore.bindings(id).length, 1);
  await prepared.abandon();
  assert.equal(isSwitchingEngines(id), false);
});

test("a return to Claude resumes the earlier native session its account still holds, else starts fresh", async () => {
  for (const kept of [true, false]) {
    const id = freshId();
    const native = `native-${id}`;
    assert.ok(
      sessionStore.upsert({
        id,
        harness: "claude-sdk",
        agentType: "developer",
        provider: "claude",
        providerSessionId: native,
        model: "sonnet",
        credentialProfileId: "claude-default",
      }),
    );
    sessionStore.switchEngineBinding(id, {
      nativeUsage: null,
      expectSeq: 1,
      fields: {
        harness: "pi",
        credentialProfileId: "cp_pi",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        thinkingLevel: "high",
        providerSessionId: null,
      },
      nativeSessionId: id,
      startedSeq: 0,
      pending: PENDING_PI,
    });
    if (kept) {
      const project = join(claudeConfigDir("claude-default"), "projects", "p");
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, `${native}.jsonl`), "{}\n");
    }
    const target: EngineSwitchTarget = {
      harness: "claude-sdk",
      model: { provider: "claude", id: "claude-opus-5-5" },
      thinkingLevel: "high",
      credentialProfileId: "claude-default",
    };
    const prepared = await prepareEngineSwitch(
      id,
      target,
      { ...PENDING_PI, model: target.model },
      () => {},
    );
    assert.equal(prepared.resumed?.seq, kept ? 1 : undefined);
    prepared.commit();
    const binding = sessionStore.activeBinding(id);
    assert.equal(binding?.seq, 3);
    assert.equal(binding?.harness, "claude-sdk");
    assert.equal(binding?.nativeSessionId, kept ? native : undefined);
    assert.equal(
      sessionStore.get(id)?.providerSessionId,
      kept ? native : undefined,
    );
    assert.equal(sessionStore.get(id)?.model, "opus");
    assert.equal(
      claudeSdkStore.get(id)?.toRecordMeta().providerSessionId,
      kept ? native : undefined,
    );
  }
});

/** A session bound to Claude on `profile` with native id `native`, then to pi. */
function claudeThenPi(id: string, native: string, profile: string): void {
  assert.ok(
    sessionStore.upsert({
      id,
      harness: "claude-sdk",
      agentType: "developer",
      provider: "claude",
      providerSessionId: native,
      model: "sonnet",
      credentialProfileId: profile,
    }),
  );
  sessionStore.switchEngineBinding(id, {
    nativeUsage: null,
    expectSeq: 1,
    fields: {
      harness: "pi",
      credentialProfileId: "cp_pi",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinkingLevel: "high",
      providerSessionId: null,
    },
    nativeSessionId: id,
    startedSeq: 0,
    pending: PENDING_PI,
  });
}

const TO_CLAUDE: EngineSwitchTarget = {
  harness: "claude-sdk",
  model: { provider: "claude", id: "claude-opus-5-5" },
  thinkingLevel: "high",
  credentialProfileId: "claude-default",
};
const PENDING_CLAUDE: SessionPendingRuntime = {
  ...PENDING_PI,
  model: TO_CLAUDE.model,
};

/** The session's Claude store state, dropped as a crash would drop it. */
function crashClaude(id: string): void {
  const internals = claudeSdkStore as unknown as {
    sessions: Map<string, unknown>;
    logs: Map<string, unknown>;
  };
  internals.sessions.delete(id);
  internals.logs.delete(id);
}

test("a move from pi onto Claude keeps the usage pi counted, and Claude's turns add to it (F027)", async () => {
  // The resolution review's reproducer, through the switch's own commit.
  const id = freshId();
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "developer",
    credentialProfileId: "default",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    messageCount: 2,
    title: "Usage fixture",
  });
  sessionStore.replaceUsage(id, {
    inputTokens: 7_777,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 7_778,
    costMicros: 1_000_000,
    currency: "USD",
    usageTurns: 1,
    assistantTurns: 1,
    usageSource: "provider_reported",
    updatedAt: 1_000,
  });
  const before = sessionStore.getUsageTotals(id);
  const toClaude = await prepareEngineSwitch(
    id,
    TO_CLAUDE,
    PENDING_CLAUDE,
    () => {},
  );
  assert.deepEqual(sessionStore.getUsageTotals(id), before);
  toClaude.commit();
  assert.deepEqual(
    sessionStore.getUsageTotals(id),
    before,
    "the commit adds nothing",
  );

  ensureRuntimeSessionWithRuntime(sessionRuntime, toClaude.driver as never);
  await sessionRuntime.prompt(id, "first Claude turn");
  // Claude's query reports 1 input, 1 output and $0.01, on top of pi's.
  const totals = sessionStore.getUsageTotals(id);
  assert.equal(totals?.inputTokens, 7_778);
  assert.equal(totals?.outputTokens, 2);
  assert.equal(totals?.totalTokens, 7_780);
  assert.equal(totals?.costMicros, 1_010_000);
  assert.equal(totals?.usageTurns, 2);
  assert.equal(totals?.assistantTurns, 2);
  // A run's spend evidence reads the same totals.
  const [spent] = routingSpendLines([
    { kind: "agent", executor: { kind: "session", id }, payload: {} } as never,
  ]);
  assert.equal(spent, "This run has spent $1.01 so far across 1 session.");
});

test("a concurrent return to Claude is refused before it touches the winner's staged transcript (F014)", async () => {
  const id = freshId();
  const native = `native-${id}`;
  // The earlier Claude binding ran on another account, so a return to the
  // default account stages a copy of its transcript there.
  claudeThenPi(id, native, "claude-source");
  const from = join(claudeConfigDir("claude-source"), "projects", "p");
  mkdirSync(from, { recursive: true });
  writeFileSync(join(from, `${native}.jsonl`), "{}\n");
  const staged = join(
    claudeConfigDir("claude-default"),
    "projects",
    "p",
    `${native}.jsonl`,
  );

  const first = await prepareEngineSwitch(
    id,
    TO_CLAUDE,
    PENDING_CLAUDE,
    () => {},
  );
  assert.equal(first.resumed?.seq, 1);
  assert.equal(existsSync(staged), true, "the first switch staged its copy");

  // The same pending return, resolved by a second turn that held the old
  // driver: busy, and the winner's copy is untouched.
  await assert.rejects(
    prepareEngineSwitch(id, TO_CLAUDE, PENDING_CLAUDE, () => {}),
    SessionSwitchingEnginesError,
  );
  assert.equal(existsSync(staged), true, "the refused switch removed nothing");
  assert.equal(
    isSwitchingEngines(id),
    true,
    "the winner still holds the fence",
  );

  first.commit();
  assert.deepEqual(wakes, [id], "the winner's lift offers the refused turn");
  assert.equal(existsSync(staged), true);
  assert.equal(sessionStore.activeBinding(id)?.nativeSessionId, native);
});

test("an acquisition that chose Claude before the switch cannot register it while pi opens, or after (F015)", async () => {
  const id = freshId();
  await onClaude(id);
  sessionStore.setPendingRuntime(id, PENDING_PI);
  piOpensForReal();
  const realOpen = pi.openEngine;
  let opened!: () => void;
  const gate = new Promise<void>((resolve) => {
    opened = resolve;
  });
  let entered!: () => void;
  const opening = new Promise<void>((resolve) => {
    entered = resolve;
  });
  pi.openEngine = async (spec) => {
    entered();
    await gate;
    return realOpen(spec);
  };

  const switching = prepareEngineSwitch(id, TO_PI, PENDING_PI, () => {});
  await opening;
  // Claude has let it go and pi is still opening: a cold acquisition that
  // passed the registry's fence check before its own await registers now.
  assert.equal(claudeSdkStore.get(id), undefined);
  assert.throws(
    () => claudeSdkStore.acquire(id),
    SessionSwitchingEnginesError,
    "busy while the switch moves it",
  );
  assert.equal(claudeSdkStore.get(id), undefined, "Claude did not take it");
  opened();
  const prepared = await switching;
  prepared.usable();
  prepared.commit();
  assert.ok(wakes.includes(id), "the refused acquisition is offered again");

  // After the commit the binding names pi: Claude refuses it even once pi has
  // let it go, so a late continuation cannot bring the old engine back.
  assert.throws(() => claudeSdkStore.acquire(id), SessionHeldElsewhereError);
  pi.live.clear();
  assert.throws(() => claudeSdkStore.acquire(id), SessionHeldElsewhereError);
  assert.equal(claudeSdkStore.get(id), undefined);
});

test("a restart right after a return to Claude commits reopens the committed binding, not the stale record (F016)", async () => {
  const id = freshId();
  await onClaude(id);
  const stale = claudeSdkStore.get(id)!.toRecordMeta();
  assert.equal(stale.modelId, "sonnet");
  sessionStore.setPendingRuntime(id, PENDING_PI);
  piOpensForReal();
  (await prepareEngineSwitch(id, TO_PI, PENDING_PI, () => {})).commit();
  pi.live.clear();

  // The return starts a fresh native session on Opus: the earlier one's
  // transcript is not under the account.
  const target: EngineSwitchTarget = { ...TO_CLAUDE, thinkingLevel: "low" };
  sessionStore.setPendingRuntime(id, {
    ...PENDING_CLAUDE,
    thinkingLevel: "low",
  });
  const back = await prepareEngineSwitch(
    id,
    target,
    { ...PENDING_CLAUDE, thinkingLevel: "low" },
    () => {},
  );
  assert.equal(back.resumed, undefined);
  back.commit();
  const committed = sessionStore.activeBinding(id);
  assert.equal(committed?.seq, 3);
  assert.equal(committed?.nativeSessionId, undefined);

  // The process dies before the new binding's first turn persists a record.
  crashClaude(id);
  const reopened = await harnessRegistry.acquireById(id);
  assert.ok(reopened);
  const meta = claudeSdkStore.get(id)!.toRecordMeta();
  assert.equal(meta.modelId, committed?.model, "the committed model");
  assert.equal(meta.thinkingLevel, "low", "the committed effort");
  assert.equal(
    meta.providerSessionId,
    undefined,
    "a fresh native session, not the earlier binding's",
  );
  assert.equal(sessionStore.get(id)?.model, committed?.model);
  assert.equal(sessionStore.activeBinding(id)?.seq, 3);
});

test("a clear on a switched Claude binding stays cleared across a restart (F022)", async () => {
  const id = freshId();
  const native = `native-${id}`;
  claudeThenPi(id, native, "claude-default");
  const project = join(claudeConfigDir("claude-default"), "projects", "p");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${native}.jsonl`), "{}\n");
  sessionStore.setPendingRuntime(id, PENDING_CLAUDE);
  const back = await prepareEngineSwitch(
    id,
    TO_CLAUDE,
    PENDING_CLAUDE,
    () => {},
  );
  assert.equal(back.resumed?.seq, 1, "the return resumes the native session");
  back.commit();
  assert.equal(sessionStore.activeBinding(id)?.nativeSessionId, native);

  const session = claudeSdkStore.get(id)!;
  assert.equal(session.toRecordMeta().providerSessionId, native);
  assert.equal((await session.clearContext()).kind, "cleared");
  // The clear reaches the binding and its projection, not only the record.
  assert.equal(sessionStore.activeBinding(id)?.nativeSessionId, undefined);
  assert.equal(sessionStore.get(id)?.providerSessionId, undefined);

  crashClaude(id);
  assert.ok(await harnessRegistry.acquireById(id));
  assert.equal(
    claudeSdkStore.get(id)!.toRecordMeta().providerSessionId,
    undefined,
    "the cleared conversation does not come back",
  );
  assert.equal(sessionStore.activeBinding(id)?.seq, 3);
});

test("a native session a switched Claude binding learns later reaches the binding", async () => {
  const id = freshId();
  claudeThenPi(id, `native-${id}`, "claude-source");
  sessionStore.setPendingRuntime(id, PENDING_CLAUDE);
  // No transcript under the target account: the return starts fresh.
  const back = await prepareEngineSwitch(
    id,
    TO_CLAUDE,
    PENDING_CLAUDE,
    () => {},
  );
  assert.equal(back.resumed, undefined);
  back.commit();
  assert.equal(sessionStore.activeBinding(id)?.nativeSessionId, undefined);

  // Its first query learns a new native session; the turn-end persist moves
  // the binding to it, so a restart resumes that one.
  const session = claudeSdkStore.get(id)!;
  (session as unknown as { providerSessionId: string }).providerSessionId =
    "learned-native";
  session.onPersist();
  assert.equal(
    sessionStore.activeBinding(id)?.nativeSessionId,
    "learned-native",
  );
  crashClaude(id);
  assert.ok(await harnessRegistry.acquireById(id));
  assert.equal(
    claudeSdkStore.get(id)!.toRecordMeta().providerSessionId,
    "learned-native",
  );
});

test("deleting a session while its first move to Claude is prepared leaves nothing to reopen (F017)", async () => {
  const id = freshId();
  assert.ok(
    sessionStore.upsert({
      id,
      harness: "pi",
      agentType: "developer",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      credentialProfileId: "cp_pi",
    }),
  );
  const prepared = await prepareEngineSwitch(
    id,
    TO_CLAUDE,
    PENDING_CLAUDE,
    () => {},
  );
  assert.equal(claudeSdkStore.get(id), prepared.driver);

  // The user deletes it: the hub tombstones the row and removes it from the
  // engine its binding names, pi.
  sessionStore.remove(id);
  await harnessRegistry.remove({
    harness: "pi",
    id,
    agentType: "developer",
    file: canonicalPiSessionPath(id),
  });
  assert.equal(
    claudeSdkStore.get(id),
    undefined,
    "the uncommitted target went",
  );

  // The turn's final admission refuses, and the switch is abandoned.
  assert.throws(() => prepared.usable(), /deleted while it switched/);
  await prepared.abandon();
  assert.equal(
    existsSync(join(CLAUDE_SDK_STORE_DIR, `${id}.json`)),
    false,
    "no record is written back for the deleted id",
  );
  assert.equal(await harnessRegistry.acquireById(id), undefined);
  assert.equal(claudeSdkStore.get(id), undefined);
  assert.throws(() => claudeSdkStore.acquire(id), /was deleted/);
});

test("a return to pi whose transcript is gone starts over and is not recorded as a resume (F018)", async () => {
  for (const kept of [true, false]) {
    const id = freshId();
    claudeThenPi(id, `native-${id}`, "claude-default");
    sessionStore.switchEngineBinding(id, {
      nativeUsage: null,
      expectSeq: 2,
      fields: {
        harness: "claude-sdk",
        credentialProfileId: "claude-default",
        provider: "claude",
        model: "opus",
        thinkingLevel: "high",
        providerSessionId: null,
      },
      nativeSessionId: null,
      startedSeq: 0,
      pending: PENDING_CLAUDE,
    });
    const file = canonicalPiSessionPath(id);
    rmSync(file, { force: true });
    if (kept) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(
        file,
        `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`,
      );
    }
    const specs = piOpensForReal();
    const prepared = await prepareEngineSwitch(id, TO_PI, PENDING_PI, () => {});
    assert.equal(specs[0]?.transcript.type, kept ? "open" : "new");
    assert.equal(prepared.resumed?.seq, kept ? 2 : undefined);
    prepared.commit();
    const active = sessionStore.activeBinding(id);
    assert.equal(active?.seq, 4);
    assert.equal(
      active?.nativeSessionId,
      id,
      "pi's native id stays the app id",
    );
    assert.equal(active?.resumedSeq, kept ? 2 : undefined);
    pi.live.clear();
    rmSync(file, { force: true });
  }
});

test("a fresh pi return owes the whole log, the pi-era history included (F018)", async () => {
  const id = freshId();
  claudeThenPi(id, `native-${id}`, "claude-default");
  const path = logPathFor(id);
  mkdirSync(join(path, ".."), { recursive: true });
  const row = (seq: number, role: string, text: string) =>
    `${JSON.stringify({ type: "message", role, seq, id: `m${seq}`, content: [{ type: "text", text }] })}\n`;
  writeFileSync(
    path,
    row(0, "user", "PI_ONLY_HISTORY ask") + row(1, "assistant", "pi said so"),
  );
  sessionStore.switchEngineBinding(id, {
    nativeUsage: null,
    expectSeq: 2,
    fields: {
      harness: "claude-sdk",
      credentialProfileId: "claude-default",
      provider: "claude",
      model: "opus",
      thinkingLevel: "high",
      providerSessionId: null,
    },
    nativeSessionId: null,
    startedSeq: 2,
    pending: PENDING_CLAUDE,
  });
  writeFileSync(
    path,
    row(2, "user", "on claude") + row(3, "assistant", "claude said"),
    {
      flag: "a",
    },
  );
  rmSync(canonicalPiSessionPath(id), { force: true });
  piOpensForReal();
  const prepared = await prepareEngineSwitch(id, TO_PI, PENDING_PI, () => {});
  prepared.commit();
  const owed = owedSwitchContext(id) ?? "";
  assert.match(owed, /PI_ONLY_HISTORY ask/, "the fresh transcript gets it all");
  assert.match(owed, /on claude/);
  assert.doesNotMatch(owed, /You ran this session before/);
});

test("a switch held only by the naming agent is offered again when naming ends (F021)", async () => {
  const id = freshId();
  await onClaude(id);
  const session = claudeSdkStore.get(id)!;
  const naming = session as unknown as { titleGenerationPending: boolean };
  // The naming agent the first answer started is still working.
  naming.titleGenerationPending = true;
  piOpensForReal();
  await assert.rejects(
    prepareEngineSwitch(id, TO_PI, PENDING_PI, () => {}),
    // By name, so this file also loads against a build without the class.
    (error: Error) => error.name === "SessionSettlingError",
  );
  assert.equal(isSwitchingEngines(id), false);
  assert.equal(claudeSdkStore.get(id), session, "Claude keeps it meanwhile");
  assert.deepEqual(wakes, [], "nothing was refused by the fence");

  // Naming ends, as `autoName` does: pending off, then a change.
  naming.titleGenerationPending = false;
  session.onChange();
  assert.deepEqual(wakes, [id], "the held turn is offered again");
  session.onChange();
  assert.deepEqual(wakes, [id], "once");
});

test("a kind change within pi reopens its own transcript on the new account and owes no handoff", async () => {
  const endpoint = createCredentialProfile({
    name: "Team LLM",
    provider: "openai-compatible",
  });
  try {
    const id = freshId();
    await onClaude(id);
    sessionStore.setPendingRuntime(id, PENDING_PI);
    const specs = piOpensForReal();
    const toCodex = await prepareEngineSwitch(
      id,
      { ...TO_PI, credentialProfileId: "default" },
      PENDING_PI,
      () => {},
    );
    toCodex.usable();
    toCodex.commit();
    // pi's transcript of the session, as pi keeps it once it has run.
    const file = canonicalPiSessionPath(id);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`,
    );
    const onCodex = pi.live.get(id) as { released: boolean } | undefined;
    assert.ok(onCodex);

    const toEndpoint: EngineSwitchTarget = {
      harness: "pi",
      model: { provider: endpoint.id, id: "llama3" },
      thinkingLevel: "off",
      credentialProfileId: endpoint.id,
    };
    const pending: SessionPendingRuntime = {
      ...PENDING_PI,
      model: toEndpoint.model,
      thinkingLevel: "off",
      account: { kind: "account", id: endpoint.id },
    };
    sessionStore.setPendingRuntime(id, pending);
    const prepared = await prepareEngineSwitch(
      id,
      toEndpoint,
      pending,
      () => {},
    );
    assert.equal(onCodex.released, true, "the Codex-bound engine let it go");
    assert.equal(specs[1]?.transcript.type, "open");
    assert.equal(prepared.resumed?.seq, 2, "it resumed the binding it left");
    prepared.usable();
    prepared.commit();
    const row = sessionStore.get(id);
    assert.equal(row?.harness, "pi");
    assert.equal(row?.provider, endpoint.id);
    assert.equal(row?.credentialProfileId, endpoint.id);
    assert.deepEqual(
      sessionStore.bindings(id).map((binding) => binding.harness),
      ["claude-sdk", "pi", "pi"],
    );
    assert.equal(sessionStore.activeBinding(id)?.resumedSeq, 2);
    assert.equal(owedSwitchContext(id), undefined);
    pi.live.clear();
    rmSync(file, { force: true });
  } finally {
    // Still bound to the test's session, so it cannot be deleted.
    setCredentialProfileEnabled(endpoint.id, false);
  }
});

/**
 * pi opens for real and is tracked for real: the production `track` builds a
 * `PiLiveSession`, whose constructor syncs the session's row. Only the agent
 * session under the engine is a stand-in, one that has run and runs `model`.
 */
function piTracksForReal(model: {
  provider: string;
  id: string;
  thinkingLevel: string;
}): void {
  pi.openEngine = (spec) => {
    const { model: _model, thinkingLevel: _thinking, ...transcript } = spec;
    return openPiEngine(
      transcript,
      {} as never,
      async (_spec, _ctx, { sm }) => {
        const session = {
          sessionId: sm.getSessionId(),
          sessionFile: sm.getSessionFile(),
          sessionManager: sm,
          sessionName: undefined as string | undefined,
          setSessionName: (name: string) => {
            session.sessionName = name;
          },
          model: { provider: model.provider, id: model.id },
          thinkingLevel: model.thinkingLevel,
          isStreaming: false,
          messages: [],
          getSessionStats: () => ({ totalMessages: 2 }),
          subscribe: () => () => {},
          dispose: async () => {},
        };
        return { session: session as never, notices: [] };
      },
    );
  };
}

test("a kind change within pi writes nothing to the binding it leaves before it commits, and abandon leaves it as it was (F023)", async () => {
  const endpoint = createCredentialProfile({
    name: "Kind change LLM",
    provider: "openai-compatible",
  });
  const id = freshId();
  try {
    assert.ok(
      sessionStore.upsert({
        id,
        harness: "pi",
        agentType: "developer",
        provider: "openai-codex",
        providerSessionId: id,
        model: "gpt-5.6-sol",
        thinkingLevel: "high",
        credentialProfileId: "default",
        title: "kind fixture",
        messageCount: 2,
      }),
    );
    const file = canonicalPiSessionPath(id);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`,
    );
    const toEndpoint: EngineSwitchTarget = {
      harness: "pi",
      model: { provider: endpoint.id, id: "llama3" },
      thinkingLevel: "off",
      credentialProfileId: endpoint.id,
    };
    const pending: SessionPendingRuntime = {
      ...PENDING_PI,
      model: toEndpoint.model,
      thinkingLevel: "off",
      account: { kind: "account", id: endpoint.id },
    };
    sessionStore.setPendingRuntime(id, pending);
    const before = sessionStore.get(id);
    const bindingBefore = sessionStore.activeBinding(id);
    piTracksForReal({ ...toEndpoint.model, thinkingLevel: "off" });

    const prepared = await prepareEngineSwitch(
      id,
      toEndpoint,
      pending,
      () => {},
    );
    assert.equal(
      piStore.getLiveById(id),
      prepared.driver,
      "the production track registered the target",
    );
    assert.deepEqual(
      sessionStore.get(id),
      before,
      "the uncommitted target rewrote nothing on the row",
    );
    assert.deepEqual(sessionStore.activeBinding(id), bindingBefore);

    await prepared.abandon();
    assert.equal(piStore.getLiveById(id), undefined);
    assert.deepEqual(
      sessionStore.get(id),
      before,
      "after abandon the row is as it was",
    );
    assert.deepEqual(sessionStore.activeBinding(id), bindingBefore);
    assert.deepEqual(sessionStore.get(id)?.pendingRuntime, pending);

    // The same move committed: the target's own figures land with the binding.
    piTracksForReal({ ...toEndpoint.model, thinkingLevel: "off" });
    const again = await prepareEngineSwitch(id, toEndpoint, pending, () => {});
    again.commit();
    const row = sessionStore.get(id);
    assert.equal(row?.provider, endpoint.id);
    assert.equal(row?.model, "llama3");
    assert.equal(row?.thinkingLevel, "off");
    assert.equal(row?.credentialProfileId, endpoint.id);
    const [left, active] = sessionStore.bindings(id);
    assert.equal(
      left?.provider,
      "openai-codex",
      "the left binding kept its own",
    );
    assert.equal(left?.model, "gpt-5.6-sol");
    assert.equal(left?.credentialProfileId, "default");
    assert.equal(active?.provider, endpoint.id);
    // Once committed, the target is the active engine and writes as one.
    await (
      again.driver as unknown as { rename(t: string): Promise<void> }
    ).rename("renamed on the endpoint");
    assert.equal(sessionStore.get(id)?.title, "renamed on the endpoint");
    await piStore.releaseForSwitch(id, () => {});
    rmSync(file, { force: true });
  } finally {
    // Still bound to the test's session, so it cannot be deleted.
    setCredentialProfileEnabled(endpoint.id, false);
  }
});

test("a pi kind change waits for a naming run, and one that outlives its released instance writes nothing after the commit (F025)", async () => {
  const endpoint = createCredentialProfile({
    name: "Naming kind change LLM",
    provider: "openai-compatible",
  });
  const id = freshId();
  try {
    assert.ok(
      sessionStore.upsert({
        id,
        harness: "pi",
        agentType: "developer",
        provider: "openai-codex",
        providerSessionId: id,
        model: "gpt-5.6-sol",
        thinkingLevel: "high",
        credentialProfileId: "default",
        messageCount: 2,
      }),
    );
    const file = canonicalPiSessionPath(id);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`,
    );
    // The source: Codex, opened and tracked as the store opens any session.
    piTracksForReal({
      provider: "openai-codex",
      id: "gpt-5.6-sol",
      thinkingLevel: "high",
    });
    const source = await piStore.acquireByRecordId(id, "developer");
    assert.ok(source);
    assert.equal(source.bindingSeq, 1);
    // Its first answer started the naming agent (the production routine).
    const naming = (
      source as unknown as {
        autoNameFromFirstPrompt(
          prompt: string,
          attachments: never[],
          settings: { enabled: boolean },
        ): Promise<void>;
      }
    ).autoNameFromFirstPrompt("name this", [], { enabled: true });
    assert.equal(titles.length, 1);

    const toEndpoint: EngineSwitchTarget = {
      harness: "pi",
      model: { provider: endpoint.id, id: "llama3" },
      thinkingLevel: "off",
      credentialProfileId: endpoint.id,
    };
    const pending: SessionPendingRuntime = {
      ...PENDING_PI,
      model: toEndpoint.model,
      thinkingLevel: "off",
      account: { kind: "account", id: endpoint.id },
    };
    sessionStore.setPendingRuntime(id, pending);
    piTracksForReal({ ...toEndpoint.model, thinkingLevel: "off" });
    await assert.rejects(
      prepareEngineSwitch(id, toEndpoint, pending, () => {}),
      (error: Error) => error.name === "SessionSettlingError",
    );
    assert.equal(piStore.getLiveById(id), source, "pi keeps it meanwhile");
    assert.equal(isSwitchingEngines(id), false);
    assert.equal(sessionStore.get(id)?.provider, "openai-codex");

    // Released anyway (nothing does so now): the switch commits meanwhile.
    piStore.evict(id);
    const prepared = await prepareEngineSwitch(
      id,
      toEndpoint,
      pending,
      () => {},
    );
    prepared.commit();
    const committed = sessionStore.get(id);
    assert.equal(committed?.provider, endpoint.id);
    assert.equal(committed?.model, "llama3");

    titles.shift()!("Too late");
    await naming;
    assert.deepEqual(sessionStore.get(id), committed);
    assert.equal(
      source.engine.sessionName,
      undefined,
      "nothing is appended to the transcript the endpoint binding reopened",
    );
    await piStore.releaseForSwitch(id, () => {});
    rmSync(file, { force: true });
  } finally {
    titles.length = 0;
    setCredentialProfileEnabled(endpoint.id, false);
  }
});

test("the same engine and account kind is not an engine switch", async () => {
  const id = freshId();
  await onClaude(id);
  await assert.rejects(
    prepareEngineSwitch(
      id,
      {
        harness: "claude-sdk",
        model: { provider: "claude-sdk", id: "opus" },
        thinkingLevel: "high",
        credentialProfileId: "claude-default",
      },
      PENDING_PI,
      () => {},
    ),
  );
  assert.equal(isSwitchingEngines(id), false);
  assert.equal(sessionStore.bindings(id).length, 1);
});

/**
 * The turn seam, answering as the native session `native()` names. The shared
 * one answers as "provider-store" for every session, an id only the first
 * session to claim it keeps.
 */
function answeringAs(native: () => string) {
  return () =>
    Promise.resolve({
      ...claudeTurnSeam,
      query(...args: Parameters<typeof claudeTurnSeam.query>) {
        const turn = claudeTurnSeam.query(...args);
        return {
          async *[Symbol.asyncIterator]() {
            for await (const message of turn)
              yield { ...message, session_id: native() } as typeof message;
          },
        };
      },
    });
}

/**
 * A seam whose fork loads the native transcript from the store it was handed,
 * as the SDK does, and records that store's root.
 */
function forkLoadingSeam(roots: Array<string | undefined>) {
  return () =>
    Promise.resolve({
      ...claudeTurnSeam,
      forkSession: async (
        nativeId: string,
        opts: {
          sessionStore?: {
            root?: string;
            load: (key: {
              projectKey: string;
              sessionId: string;
            }) => Promise<unknown>;
          };
        },
      ) => {
        roots.push(opts.sessionStore?.root);
        const entries = await opts.sessionStore!.load({
          projectKey: "p",
          sessionId: nativeId,
        });
        if (!entries) throw new Error("the native transcript is missing");
        return { sessionId: `fork-${freshId()}` };
      },
    } as never);
}

test("a fork of an earlier Claude binding reads its transcript where a return on another account moved it (F036)", async () => {
  const id = freshId();
  const native = `native-${id}`;
  claudeSdkStore.setSeam(answeringAs(() => native));
  try {
    await onClaude(id);
  } finally {
    claudeSdkStore.setSeam(() => Promise.resolve(claudeTurnSeam));
  }
  const first = sessionStore.activeBinding(id)!;
  assert.equal(first.nativeSessionId, native);
  const answer = readFileSync(logPathFor(id), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((row) => row.type === "message" && row.role === "assistant");
  assert.ok(answer);
  const projects = (account: string) =>
    join(claudeConfigDir(account), "projects", "p");
  mkdirSync(projects(first.credentialProfileId!), { recursive: true });
  const oldFile = join(projects(first.credentialProfileId!), `${native}.jsonl`);
  writeFileSync(oldFile, "{}\n");
  piOpensForReal();
  (await prepareEngineSwitch(id, TO_PI, PENDING_PI, () => {})).commit();
  const b = createCredentialProfile({
    name: "Fork return B",
    provider: "claude",
  });
  try {
    // The return resumes the same native session on B: the transcript moves.
    (
      await prepareEngineSwitch(
        id,
        { ...TO_CLAUDE, credentialProfileId: b.id },
        PENDING_CLAUDE,
        () => {},
      )
    ).commit();
    await vi.waitFor(() => assert.equal(existsSync(oldFile), false));
    assert.equal(existsSync(join(projects(b.id), `${native}.jsonl`)), true);

    const roots: Array<string | undefined> = [];
    claudeSdkStore.setSeam(forkLoadingSeam(roots));
    const anchors = {
      entryFound: true,
      seq: answer.seq as number,
      own: "native-anchor",
    };
    vi.spyOn(sessionRuntime, "forkAnchors").mockReturnValue(anchors);
    const { prepareFork } = await import("./fork.ts");
    const prepared = prepareFork("claude-sdk", {
      id,
      kind: "developer",
      file: id,
      entryId: answer.id as string,
      position: "at",
      anchors,
    });
    assert.ok("fork" in prepared);
    const child = await prepared.fork();
    ids.push(child.sessionId);
    assert.deepEqual(
      roots,
      [claudeConfigDir(b.id)],
      "read from B, where it lives",
    );
    assert.equal(
      sessionStore.get(child.sessionId)?.credentialProfileId,
      b.id,
      "and the fork runs where its transcript was cut",
    );
  } finally {
    vi.restoreAllMocks();
    claudeSdkStore.setSeam(() => Promise.resolve(claudeTurnSeam));
    setCredentialProfileEnabled(b.id, false);
  }
});

test("a clear between returns keeps the earlier native session where it stayed: forks of both read theirs, and a delete sweeps both (F036)", async () => {
  const id = freshId();
  const n = `native-n-${id}`;
  const m = `native-m-${id}`;
  let native = n;
  claudeSdkStore.setSeam(answeringAs(() => native));
  const b = createCredentialProfile({
    name: "Clear between B",
    provider: "claude",
  });
  const projects = (account: string) =>
    join(claudeConfigDir(account), "projects", "p");
  const file = (account: string, which: string) =>
    join(projects(account), `${which}.jsonl`);
  try {
    await onClaude(id);
    const a = sessionStore.activeBinding(id)!.credentialProfileId!;
    assert.equal(sessionStore.activeBinding(id)?.nativeSessionId, n);
    const answers = () =>
      readFileSync(logPathFor(id), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((row) => row.type === "message" && row.role === "assistant");
    const [firstAnswer] = answers();
    assert.ok(firstAnswer);
    mkdirSync(projects(a), { recursive: true });
    writeFileSync(file(a, n), "{}\n");
    piOpensForReal();
    (await prepareEngineSwitch(id, TO_PI, PENDING_PI, () => {})).commit();
    // A return on B moves N there.
    (
      await prepareEngineSwitch(
        id,
        { ...TO_CLAUDE, credentialProfileId: b.id },
        PENDING_CLAUDE,
        () => {},
      )
    ).commit();
    await vi.waitFor(() => assert.equal(existsSync(file(a, n)), false));
    assert.equal(existsSync(file(b.id, n)), true);
    // A clear on B, and a run that starts M there.
    const live = claudeSdkStore.get(id)!;
    assert.equal((await live.clearContext()).kind, "cleared");
    native = m;
    ensureRuntimeSessionWithRuntime(sessionRuntime, live);
    await sessionRuntime.prompt(id, "after the clear");
    assert.equal(sessionStore.activeBinding(id)?.nativeSessionId, m);
    writeFileSync(file(b.id, m), "{}\n");
    const secondAnswer = answers().at(-1)!;
    // Back to A through pi: the return moves M alone, and N stays on B.
    (await prepareEngineSwitch(id, TO_PI, PENDING_PI, () => {})).commit();
    (
      await prepareEngineSwitch(
        id,
        { ...TO_CLAUDE, credentialProfileId: a },
        PENDING_CLAUDE,
        () => {},
      )
    ).commit();
    await vi.waitFor(() => assert.equal(existsSync(file(b.id, m)), false));
    assert.equal(existsSync(file(a, m)), true);
    assert.equal(existsSync(file(b.id, n)), true);
    assert.deepEqual(
      sessionStore
        .bindings(id)
        .filter((binding) => binding.harness === "claude-sdk")
        .map((binding) => [binding.nativeSessionId, binding.resumedSeq]),
      [
        [n, undefined],
        [m, 1],
        [m, 3],
      ],
    );

    const roots: Array<string | undefined> = [];
    claudeSdkStore.setSeam(forkLoadingSeam(roots));
    const { prepareFork } = await import("./fork.ts");
    const forkAt = async (entry: Record<string, unknown>) => {
      const anchors = {
        entryFound: true,
        seq: entry.seq as number,
        own: "native-anchor",
      };
      const spy = vi
        .spyOn(sessionRuntime, "forkAnchors")
        .mockReturnValue(anchors);
      try {
        const prepared = prepareFork("claude-sdk", {
          id,
          kind: "developer",
          file: id,
          entryId: entry.id as string,
          position: "at",
          anchors,
        });
        assert.ok("fork" in prepared);
        const child = await prepared.fork();
        ids.push(child.sessionId);
        return sessionStore.get(child.sessionId)?.credentialProfileId;
      } finally {
        spy.mockRestore();
      }
    };
    assert.equal(await forkAt(firstAnswer), b.id, "N is read on B");
    assert.equal(await forkAt(secondAnswer), a, "M is read on A");
    assert.deepEqual(roots, [claudeConfigDir(b.id), claudeConfigDir(a)]);

    // Deleting the session sweeps every copy of both.
    await harnessRegistry.remove({
      harness: "claude-sdk",
      id,
      agentType: "developer",
      file: id,
    });
    for (const account of [a, b.id])
      for (const which of [n, m])
        assert.equal(existsSync(file(account, which)), false);
  } finally {
    vi.restoreAllMocks();
    claudeSdkStore.setSeam(() => Promise.resolve(claudeTurnSeam));
    setCredentialProfileEnabled(b.id, false);
  }
});

test("a return after a real /clear whose next run reported no usage sizes the new native session from the log, never the cleared one's report (F041)", async () => {
  const id = freshId();
  const n = `native-n-${id}`;
  const m = `native-m-${id}`;
  let native = n;
  let reports = true;
  // As `answeringAs`, and once `reports` is off a result with no usage, as a
  // run that fails before any report ends.
  claudeSdkStore.setSeam(() =>
    Promise.resolve({
      ...claudeTurnSeam,
      query(...args: Parameters<typeof claudeTurnSeam.query>) {
        const turn = claudeTurnSeam.query(...args);
        return {
          async *[Symbol.asyncIterator]() {
            for await (const message of turn) {
              const own = { ...message, session_id: native };
              yield (
                !reports && own.type === "result"
                  ? { ...own, total_cost_usd: 0, modelUsage: {} }
                  : own
              ) as typeof message;
            }
          },
        };
      },
    }),
  );
  const window =
    pickerModels().find(
      (option) =>
        option.provider === TO_CLAUDE.model.provider &&
        option.id === TO_CLAUDE.model.id,
    )?.contextWindow ??
    storedSessionModelOption(
      "claude-sdk",
      TO_CLAUDE.model.provider,
      TO_CLAUDE.model.id,
    )?.contextWindow;
  assert.ok(window, "the return target has a known window");
  const assistants = () =>
    readFileSync(logPathFor(id), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((row) => row.type === "message" && row.role === "assistant");
  let transcript: string | undefined;
  try {
    await onClaude(id);
    assert.ok(assistants()[0]?.usage, "N's run reported its (light) context");
    const live = claudeSdkStore.get(id)!;
    await runClearForHost(live);
    native = m;
    reports = false;
    await sessionRuntime.prompt(id, "x ".repeat(window * 2));
    assert.equal(sessionStore.activeBinding(id)?.nativeSessionId, m);
    assert.equal(assistants().length, 2);
    assert.equal(assistants()[1]?.usage, undefined, "M's run reported none");
    // M's transcript, where the return looks for it.
    const account = sessionStore.activeBinding(id)!.credentialProfileId!;
    transcript = join(claudeConfigDir(account), "projects", "p", `${m}.jsonl`);
    mkdirSync(join(transcript, ".."), { recursive: true });
    writeFileSync(transcript, "{}\n");

    piOpensForReal();
    (await prepareEngineSwitch(id, TO_PI, PENDING_PI, () => {})).commit();
    const piStart = sessionStore.activeBinding(id)!.startedSeq;
    // pi's turn, written to the log once the detached runtime let go of it (as
    // its view grace ends).
    await sessionRuntime.disposeSession(id);
    const row = (seq: number, role: string, text: string) =>
      `${JSON.stringify({ type: "message", role, seq, id: `m${seq}`, content: [{ type: "text", text }] })}\n`;
    writeFileSync(
      logPathFor(id),
      row(piStart, "user", "asked on pi") +
        row(piStart + 1, "assistant", "pi answered"),
      { flag: "a" },
    );
    assert.equal(sessionRuntime.logCursor(id), piStart + 2);
    (
      await prepareEngineSwitch(id, TO_CLAUDE, PENDING_CLAUDE, () => {})
    ).commit();
    assert.equal(sessionStore.activeBinding(id)?.resumedSeq, 1);
    const owed = owedSwitchContext(id) ?? "";
    assert.match(owed, /You ran this session before/);
    assert.doesNotMatch(owed, /pi answered/, "M may already fill its window");
  } finally {
    claudeSdkStore.setSeam(() => Promise.resolve(claudeTurnSeam));
    if (transcript) rmSync(transcript, { force: true });
  }
});
