/**
 * The pi store's half of a harness switch
 * (`docs/session-runtime-switching.md`): a first pi binding starts a
 * transcript under the APP id, a return reopens the one an earlier pi binding
 * wrote, a transcript that is there but cannot be opened holds the switch,
 * and releasing a session for another engine keeps its runtime session
 * detached for the next one.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import { seedLegacyDefaultAccounts } from "../test/legacyDefaultAccounts.ts";

const tmp = mkdtempSync(join(tmpdir(), "pi-switch-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { PiLiveSession } = await import("./PiLiveSession.ts");
const { localPiEngine } = await import("./piEngine.ts");
const { piStore, PiSwitchTranscriptError } = await import("./piStore.ts");
const { openPiEngine } = await import("./piEngineHost.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { closeDb } = await import("../db/index.ts");
const { sessionRuntime } = await import("../session/runtimeInstance.ts");
const { canonicalPiSessionPath } = await import("../sessionStorage.ts");

await seedLegacyDefaultAccounts();

type PiEngineOpened = import("./piEngineHost.ts").PiEngineOpened;
type PiEngineOpenSpec = import("./piEngineHost.ts").PiEngineOpenSpec;

interface StoreInternals {
  openEngine: (spec: PiEngineOpenSpec) => Promise<PiEngineOpened>;
  track: (kind: string, opened: PiEngineOpened) => unknown;
  live: Map<string, unknown>;
}
const internals = piStore as unknown as StoreInternals;
const originalOpenEngine = internals.openEngine;
const originalTrack = internals.track;

function host() {
  return {
    sessionRowsChanged: () => {},
    noteRunStarted: () => {},
    checkPendingReload: () => {},
    isReloadQueued: () => false,
    buildSessionState: () => ({}) as never,
  };
}

let specs: PiEngineOpenSpec[] = [];
beforeAll(() => piStore.setHost(host() as never));
afterEach(() => {
  internals.openEngine = originalOpenEngine;
  internals.track = originalTrack;
  internals.live.clear();
  specs = [];
});
afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

/** The real opener over a stand-in session, registered without a live wrapper. */
function openForReal(): void {
  internals.openEngine = (spec) => {
    specs.push(spec);
    // The model is resolved in an account registry this test has none of; the
    // spec above is what the switch asked for.
    const { model: _model, thinkingLevel: _thinking, ...transcriptOnly } = spec;
    return openPiEngine(
      transcriptOnly,
      {} as never,
      async (_spec, _ctx, { sm }) => {
        // A fresh transcript is written once it has an entry, as pi does after
        // its first message; the open only names it.
        return {
          session: {
            sessionId: sm.getSessionId(),
            sessionFile: sm.getSessionFile(),
            sessionManager: sm,
            subscribe: () => () => {},
            dispose: () => {},
          } as never,
          notices: [],
        };
      },
    );
  };
  internals.track = (kind, { engine }) => {
    const wrapper = {
      kind,
      key: engine.sessionId,
      appId: engine.sessionId,
      engine,
    };
    internals.live.set(engine.sessionId, wrapper);
    return wrapper;
  };
}

function row(id: string): void {
  assert.ok(
    sessionStore.upsert({
      id,
      harness: "claude-sdk",
      agentType: "developer",
      provider: "claude",
      providerSessionId: `native-${id}`,
      model: "claude-opus-5-5",
      credentialProfileId: "cp_claude",
    }),
  );
}

const binding = {
  kind: "developer" as const,
  model: { provider: "openai-codex", id: "gpt-5.6-sol" },
  thinkingLevel: "high" as const,
  credentialProfileId: "cp_pi",
  mode: "build" as const,
};

test("a first pi binding starts its transcript under the app id", async () => {
  openForReal();
  const id = "switch-to-pi-fresh";
  row(id);
  const { session: opened, resumed } = await piStore.openForBinding(id, {
    ...binding,
    cwd: tmp,
  });
  // openForBinding refuses any other id, and the live map finds it by ours.
  assert.equal(piStore.getLiveById(id), opened, "pi's native id is the app id");
  assert.equal(resumed, false, "a new transcript is no resume");
  const spec = specs[0]!;
  assert.deepEqual(spec.transcript, { type: "new", cwd: tmp, id });
  assert.equal(spec.canonicalize, true);
  assert.deepEqual(spec.model, binding.model);
  assert.equal(spec.thinkingLevel, "high");
  assert.equal(spec.credentialProfileId, "cp_pi");
  assert.equal(spec.mode, "build");
  // The row still projects Claude until the switch commits.
  assert.equal(sessionStore.get(id)?.harness, "claude-sdk");
});

test("a return reopens the transcript an earlier pi binding wrote", async () => {
  openForReal();
  const id = "switch-back-to-pi";
  row(id);
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const file = canonicalPiSessionPath(id);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: tmp })}\n`,
  );
  const { session: opened, resumed } = await piStore.openForBinding(
    id,
    binding,
  );
  assert.equal(piStore.getLiveById(id), opened);
  assert.equal(resumed, true, "the open reports what it reopened");
  assert.deepEqual(specs[0]!.transcript, {
    type: "open",
    file,
    expectedId: id,
  });
  assert.equal(specs[0]!.canonicalize, undefined);
});

test("a transcript that is there but cannot be read holds the switch with a way out", async () => {
  const id = "switch-unreadable";
  row(id);
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const file = canonicalPiSessionPath(id);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "not json\n");
  let opens = 0;
  internals.openEngine = () => {
    opens += 1;
    return Promise.reject(new Error("never reached"));
  };
  const refused = await piStore.openForBinding(id, binding).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(refused instanceof PiSwitchTranscriptError);
  assert.match(refused.message, /header is missing or names another session/);
  assert.match(refused.message, /Choose another model, or reset the change\./);
  assert.equal(opens, 0, "nothing is opened over it");
  assert.equal(existsSync(file), true, "the transcript is left alone");
});

test("a model or account refusal on a return is not taken for an unreadable transcript", async () => {
  const id = "switch-model-refused";
  row(id);
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const file = canonicalPiSessionPath(id);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: tmp })}\n`,
  );
  internals.openEngine = () =>
    Promise.reject(
      new Error("Model openai-codex/gpt-5.6-sol is not available."),
    );
  const refused = await piStore.openForBinding(id, binding).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(refused instanceof Error);
  assert.ok(!(refused instanceof PiSwitchTranscriptError));
  assert.match(refused.message, /is not available/);
});

test("releasing for a switch drops the session and keeps its runtime session detached", async () => {
  const id = "switch-release-pi";
  const agent = {
    sessionId: id,
    sessionName: "Named",
    isStreaming: false,
    sessionManager: { getBranch: () => [] },
    subscribe: () => () => {},
    getSessionStats: () => ({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      contextSize: 0,
    }),
    steer: () => Promise.resolve(),
    prompt: () => Promise.resolve(),
    dispose: () => {},
  };
  const live = new PiLiveSession(
    "developer" as never,
    localPiEngine(agent as never),
    host() as never,
    () => {},
  );
  internals.live.set(id, live);
  const runtimeSession = sessionRuntime.createSession(
    id,
    live.createRuntimeAdapter(),
  );

  // A turn still streaming belongs to pi.
  agent.isStreaming = true;
  await assert.rejects(
    piStore.releaseForSwitch(id, () => {}),
    /still running a turn/,
  );
  assert.equal(piStore.getLiveById(id), live);
  agent.isStreaming = false;

  // The switching turn's own admission does not keep it from going.
  const releaseAdmission = sessionRuntime.admitPrompt(id);
  try {
    await piStore.releaseForSwitch(id, () => {});
  } finally {
    releaseAdmission();
  }
  assert.equal(piStore.getLiveById(id), undefined);
  assert.equal(live.released, true);
  assert.equal(sessionRuntime.get(id), runtimeSession);
  assert.equal(runtimeSession.isDetached, true);
  await sessionRuntime.disposeSession(id);
  // Nothing resident: nothing to release.
  await piStore.releaseForSwitch(id, () => {});
});

test("a reopen of a switched-to pi binding runs its committed model, a first binding its transcript's", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  for (const switched of [true, false]) {
    openForReal();
    const id = `reopen-bound-${switched}`;
    if (switched) {
      row(id);
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
        pending: {
          model: { provider: "openai-codex", id: "gpt-5.6-sol" },
          thinkingLevel: "high",
          account: { kind: "automatic" },
          setBy: "user",
        },
      });
    } else
      assert.ok(
        sessionStore.upsert({
          id,
          harness: "pi",
          agentType: "developer",
          provider: "openai-codex",
          model: "gpt-5.6-sol",
          thinkingLevel: "high",
          credentialProfileId: "cp_pi",
        }),
      );
    // The transcript an earlier pi binding wrote; its own last selection is
    // what pi would restore (a crash before the new binding's first reply).
    const file = canonicalPiSessionPath(id);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: tmp })}\n`,
    );
    await piStore.acquireByRecordId(id, "developer");
    const spec = specs.at(-1)!;
    assert.deepEqual(
      spec.model,
      switched ? { provider: "openai-codex", id: "gpt-5.6-sol" } : undefined,
    );
    assert.equal(spec.thinkingLevel, switched ? "high" : undefined);
    internals.live.clear();
  }
});
