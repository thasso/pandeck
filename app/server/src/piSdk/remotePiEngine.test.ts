import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import type { PiEngineHandle } from "./piEngine.ts";

/**
 * Real pi through the in-process Worker: piStore's production opener, the
 * Worker's engine table and the remote handle's mirror. Turns run on a
 * scripted stream installed on the native session behind the Worker
 * (the turn-capable fixture of `sessionAccountSwitchEngines.test.ts`).
 */

const tmp = mkdtempSync(join(tmpdir(), "remote-pi-engine-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
const profiles = await import("../credentialProfiles.ts");
// Protected defaults may point at real host credentials. Never select them in a fake-provider test.
profiles.listCredentialProfiles();
profiles.setCredentialProfileEnabled(profiles.DEFAULT_CLAUDE_PROFILE_ID, false);
profiles.setCredentialProfileEnabled(profiles.DEFAULT_OPENAI_PROFILE_ID, false);
const { piStore } = await import("./piStore.ts");
const { nativePiSessionForTests, piToolActivationForTests } =
  await import("./piEngine.ts");
const { hostedPiEngine, piHostedEngineFactory } =
  await import("./piEngineHosted.ts");
const { UNUSED_TOOL_PRUNE_IDLE_MS } = await import("./toolActivation.ts");
const { piModelForAccount } = await import("../harnesses/models.ts");
const { createSession } = await import("../harnesses/create.ts");
const { sessionRuntime } = await import("../session/runtimeInstance.ts");
const { ensureRuntimeSessionWithRuntime } =
  await import("../session/runtimePrompt.ts");
const inProcess = await import("../workers/inProcessWorker.ts");
await import("../hub.ts");

/** The Worker-side local handle of every engine piStore opened. */
const locals: PiEngineHandle[] = [];
inProcess.registerInProcessEngineFactory("pi", async (spec, host) => {
  const engine = await piHostedEngineFactory(spec, host);
  locals.push(hostedPiEngine(host.engineId)!);
  return engine;
});

afterAll(() => {
  inProcess.registerInProcessEngineFactory("pi", piHostedEngineFactory);
  rmSync(tmp, { recursive: true, force: true });
});

const created: string[] = [];
afterEach(async () => {
  for (const id of created.splice(0)) {
    await sessionRuntime.disposeSession(id);
    piStore.evict(id);
  }
});

function account(name: string): string {
  const p = profiles.createCredentialProfile({
    provider: "openai-codex",
    name,
  });
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
  profiles.listCredentialProfiles();
  return p.id;
}

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Answer every turn with `text`; with `hold`, a turn streams its start and
 * waits there until the native session is disposed or aborted.
 */
function scriptTurns(session: AgentSession, options: { hold?: boolean } = {}) {
  session.setAutoRetryEnabled(false);
  session.agent.streamFunction = (model, _context, streamOptions) => {
    const message: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [{ type: "text", text: "Scripted answer" }],
      stopReason: "stop",
      timestamp: Date.now(),
      usage: ZERO_USAGE,
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      if (options.hold) {
        streamOptions?.signal?.addEventListener("abort", () => {
          stream.push({
            type: "error",
            reason: "aborted",
            error: { ...message, stopReason: "aborted" },
          });
          stream.end();
        });
        return;
      }
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: "Scripted answer",
        partial: message,
      });
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
    });
    return stream;
  };
}

async function freshSession(name: string) {
  const profile = account(name);
  const opensBefore =
    inProcess.inProcessWorkerServedMethodForTests("engine.open");
  const live = await createSession({
    harness: "pi",
    agentType: "assistant",
    credentialProfileId: profile,
    model: await piModelForAccount(profile, "openai-codex", "gpt-5.5"),
    thinkingLevel: "off",
    title: name,
  });
  created.push(live.id);
  const pi = live as import("./PiLiveSession.ts").PiLiveSession;
  assert.equal(
    inProcess.inProcessWorkerServedMethodForTests("engine.open"),
    opensBefore + 1,
    "piStore opened the engine through the Worker",
  );
  return { pi, profile, native: nativePiSessionForTests(pi.engine) };
}

/** Every synchronous read, as JSON (the mirror's form). */
function reads(engine: PiEngineHandle) {
  const leafId = engine.transcript.getLeafId();
  return JSON.parse(
    JSON.stringify({
      sessionId: engine.sessionId,
      sessionFile: engine.sessionFile,
      isStreaming: engine.isStreaming,
      sessionName: engine.sessionName,
      model: engine.model,
      thinkingLevel: engine.thinkingLevel,
      stats: engine.stats(),
      contextMessageCount: engine.contextMessageCount(),
      skills: engine.skills(),
      compactionWindowStatus: engine.compactionWindowStatus(),
      transcriptId: engine.transcript.getSessionId(),
      header: engine.transcript.getHeader(),
      entries: engine.transcript.getEntries(),
      branch: engine.transcript.getBranch(),
      leafId,
      leaf: leafId ? engine.transcript.getEntry(leafId) : null,
      toolBranch: engine.toolSessionManager().getBranch(),
    }),
  ) as Record<string, unknown>;
}

const run = (engine: PiEngineHandle, text: string, userTurnIdleMs = 0) =>
  engine.submit(text, [], { steer: false, steerOnly: false, userTurnIdleMs });

test("every mirror read equals the Worker's local handle after each command and turn", async () => {
  const { pi, native } = await freshSession("Mirror parity");
  const remote = pi.engine;
  const local = locals.at(-1)!;
  assert.notEqual(remote, local, "production holds the remote handle");
  assert.equal(nativePiSessionForTests(local), native);
  scriptTurns(native);
  assert.deepEqual(reads(remote), reads(local), "at open");

  let insideSettled: { streaming: boolean; entries: number } | undefined;
  const unsubscribe = remote.subscribe((event) => {
    if (event.type === "agent_settled")
      insideSettled = {
        streaming: remote.isStreaming,
        entries: remote.transcript.getEntries().length,
      };
  });
  const turn = run(remote, "First question");
  assert.equal(await turn.disposition, "started");
  await turn.settled;
  unsubscribe();
  assert.deepEqual(insideSettled, {
    streaming: false,
    entries: native.sessionManager.getEntries().length,
  });
  assert.ok(
    remote.transcript
      .getEntries()
      .some(
        (entry) =>
          entry.type === "message" && entry.message.role === "assistant",
      ),
  );
  assert.deepEqual(reads(remote), reads(local), "after a turn");

  await remote.setSessionName("Renamed through the Worker");
  assert.equal(native.sessionName, "Renamed through the Worker");
  assert.deepEqual(reads(remote), reads(local), "after setSessionName");

  await remote.setThinkingLevel("low");
  assert.equal(remote.thinkingLevel, native.thinkingLevel);
  assert.deepEqual(reads(remote), reads(local), "after setThinkingLevel");

  const entryId = await remote
    .toolSessionManager()
    .appendCustomEntry("remote-test", { value: 1 });
  assert.ok(entryId, "the append answers the entry's id");
  assert.equal(remote.transcript.getEntry(entryId)?.id, entryId);
  assert.deepEqual(
    remote.toolSessionManager().getEntry(entryId),
    native.sessionManager.getEntry(entryId),
  );
  assert.deepEqual(reads(remote), reads(local), "after appendCustomEntry");

  assert.equal(await remote.dropEncryptedReasoning(), false);
  assert.deepEqual(reads(remote), reads(local), "after dropEncryptedReasoning");

  const cleared = await remote.clearContext();
  assert.equal(cleared.kind, "cleared");
  assert.equal(remote.transcript.getLeafId(), null, "the leaf was reset");
  assert.equal(remote.contextMessageCount(), 0);
  assert.deepEqual(reads(remote), reads(local), "after clearContext");

  // The model crosses as provider and id and resolves in the Worker.
  const model = remote.model!;
  await remote.setModel(model);
  assert.deepEqual(reads(remote), reads(local), "after setModel");
});

test("a marked app tool survives the cold prune of the submit that follows it", async () => {
  const { pi, native } = await freshSession("Cold prune");
  scriptTurns(native);
  const activation = piToolActivationForTests(pi.engine);
  activation.initialize(["kb_read", "kb_search"]);
  const active = () => native.getActiveToolNames();
  assert.ok(active().includes("kb_read") && active().includes("kb_search"));
  // Sent without waiting; the Worker runs it before the submit.
  pi.engine.markToolUsed("kb_read");
  await run(pi.engine, "Cold question", UNUSED_TOOL_PRUNE_IDLE_MS).settled;
  assert.equal(active().includes("kb_read"), true, "the marked tool stays");
  assert.equal(active().includes("kb_search"), false, "the unmarked one goes");
});

test("PiStore.onEngineLost connection end", async () => {
  const { pi, native } = await freshSession("Connection end");
  scriptTurns(native);
  ensureRuntimeSessionWithRuntime(sessionRuntime, pi);
  // A first turn writes the transcript, so the session can reopen.
  await sessionRuntime.prompt(pi.id, "Before the end");
  await vi.waitFor(() => assert.equal(sessionRuntime.isRunning(pi.id), false));
  scriptTurns(native, { hold: true });
  void sessionRuntime.prompt(pi.id, "Running when the connection ends");
  await vi.waitFor(() => assert.equal(sessionRuntime.isRunning(pi.id), true));
  const disposed = vi.spyOn(native, "dispose");
  const epoch = inProcess.inProcessWorkerEpochForTests();
  const quiescent = inProcess.inProcessWorkerQuiescentForTests();
  assert.equal(inProcess.inProcessWorkerEnginesForTests(), 1);

  inProcess.writeAsInProcessWorkerForTests(new Uint8Array(8));
  await quiescent;
  await vi.waitFor(() => assert.equal(piStore.get(pi.id), undefined));
  assert.equal(disposed.mock.calls.length, 1, "the Worker disposed pi");
  assert.equal(sessionRuntime.isRunning(pi.id), false, "the run was closed");
  await assert.rejects(pi.engine.setSessionName("too late"), {
    code: "engine_gone",
  });

  // The next acquisition dials a fresh connection and reopens the session.
  const reopened = await piStore.acquireByRecordId(pi.id, "assistant");
  assert.ok(reopened);
  assert.notEqual(reopened, pi);
  assert.notEqual(inProcess.inProcessWorkerEpochForTests(), epoch);
  assert.equal(inProcess.inProcessWorkerEnginesForTests(), 1);
  assert.ok(
    reopened.engine.transcript
      .getEntries()
      .some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "user" &&
          JSON.stringify(entry.message.content).includes("Before the end"),
      ),
  );
});
