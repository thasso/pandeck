/**
 * The cross-harness store move up to its commit
 * (`docs/session-runtime-switching.md` "Store move", "Switching fence"): a
 * session leaves Claude for pi (and returns) under the same app id, nothing
 * reaches it while it moves, the binding commits in one transaction, and every
 * way out before the commit leaves it on its old binding with its selection
 * pending. Lifting the fence, either way, offers the session its waiting work.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, test } from "vitest";
import type { SessionPendingRuntime } from "@assistant/shared";
import { claudeSdkStore } from "../claudeSdk/claudeSdkStore.ts";
import { claudeConfigDir } from "../credentialProfiles.ts";
import { sessionStore } from "../db/sessionStore.ts";
import { setDeliveryWake } from "../deliveryWake.ts";
import { openPiEngine } from "../piSdk/piEngineHost.ts";
import { piStore } from "../piSdk/piStore.ts";
import { sessionRuntime } from "../session/runtimeInstance.ts";
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
import { harnessRegistry } from "./registry.ts";

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
  piStore.setHost({
    sessionRowsChanged: () => {},
    noteRunStarted: () => {},
    checkPendingReload: () => {},
    isReloadQueued: () => false,
    buildSessionState: () => ({}) as never,
  } as never);
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
  assert.deepEqual(wakes, [id]);
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
