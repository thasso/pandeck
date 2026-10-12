/**
 * Stop stays stopped at the run door: a held session refuses every turn the
 * user did not ask for, keeps the hold across a reload, and only the user's
 * own words or an explicit Resume lift it.
 *   pnpm --filter @assistant/server test src/automaticTurnHold.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { PromptQueueState } from "@assistant/shared";
import type {
  AgentRunResult,
  PromptableAdapter,
} from "./session/adapters/contract.ts";

const dataDir = mkdtempSync(join(tmpdir(), "automatic-turn-hold-test-"));
process.env.DATA_DIR = dataDir;
process.env.ASSISTANT_CWD = dataDir;

const hold = await import("./automaticTurnHold.ts");
const queue = await import("./promptQueue.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { sessionRuntime } = await import("./session/runtimeInstance.ts");
const { SessionBusyError } = await import("./session/runtime/errors.ts");
const { promptRuntimeSession, beginRuntimeProviderTurn } =
  await import("./session/runtimePrompt.ts");
const { updateSettings, getSettings } = await import("./settings.ts");

updateSettings({ memory: { ...getSettings().memory, learningMode: "off" } });

/** A steering driver whose ordinary turns stay open until released. */
function fakeDriver(sessionId: string) {
  let running = false;
  let release: (() => void) | undefined;
  const sent: string[] = [];
  const adapter: PromptableAdapter = {
    provider: "fake",
    capabilities: {
      fork: "none",
      compact: false,
      steer: true,
      attachments: false,
    },
    subscribe: () => () => {},
    getBinding: () => ({ provider: "fake" }),
    prompt: (text, options = {}) => {
      sent.push(text);
      if (options.steer)
        return Promise.resolve<AgentRunResult>({ stopReason: "end" });
      running = true;
      return new Promise<AgentRunResult>((resolve) => {
        release = () => {
          release = undefined;
          running = false;
          resolve({ stopReason: "end" });
        };
      });
    },
    abort: () => release?.(),
    setModel: () => {},
    setReasoning: () => {},
    dispose: () => {},
  };
  const driver = {
    id: sessionId,
    key: sessionId,
    sessionId,
    harness: "pi" as const,
    agentType: "assistant" as const,
    sessionFile: undefined,
    get isRunning() {
      return running;
    },
    canSteer: true,
    contextInfo: () => ({}) as never,
    broadcastState: () => {},
    createRuntimeAdapter: () => adapter,
  };
  return {
    driver,
    sent,
    finish: async () => {
      await until(
        () => release !== undefined,
        "the turn to reach the provider",
      );
      release?.();
      await until(
        () => !sessionRuntime.get(sessionId)?.isRunning,
        "the turn to end",
      );
    },
  };
}

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${label} was not reached`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

let serial = 0;
function session() {
  serial += 1;
  const id = `hold-session-${serial}`;
  sessionStore.upsert({
    id,
    scope: "user",
    harness: "pi",
    agentType: "assistant",
  });
  return { id, ...fakeDriver(id) };
}

const userEntries = (id: string) =>
  (sessionRuntime.get(id)?.getSnapshot().entries ?? []).filter(
    (entry) => entry.type === "message" && entry.role === "user",
  );

const peerOrigin = { kind: "agent" as const, agentId: "peer-prompt" };
const backgroundOrigin = {
  kind: "system" as const,
  source: "background-completion",
};

let changed: string[] = [];
let resumed: string[] = [];
let published: Record<string, PromptQueueState> = {};

beforeEach(() => {
  changed = [];
  resumed = [];
  published = {};
  hold.setAutomaticTurnHoldHost({
    changed: (id) => {
      changed.push(id);
      queue.publishPromptQueue(id);
    },
    resumed: (id) => resumed.push(id),
  });
  queue.setPromptQueueHost({
    resolve: async () => undefined,
    live: () => undefined,
    publish: (id, state) => (published[id] = state),
    reportError: () => {},
    yieldToOthers: () => {},
  });
});

afterEach(() => {
  hold.setAutomaticTurnHoldHost(undefined);
  queue.setPromptQueueHost(undefined);
});

test("a fresh session is unheld and takes automatic turns", async () => {
  const s = session();
  assert.equal(hold.automaticTurnsHeld(s.id), false);
  void promptRuntimeSession(s.driver, "peer message", { origin: peerOrigin });
  await until(() => s.sent.length === 1, "the peer turn");
  await s.finish();
});

test("a held session refuses peer and background turns without appending or consuming the hold", async () => {
  const s = session();
  hold.holdAutomaticTurns(s.id);
  for (const origin of [peerOrigin, backgroundOrigin]) {
    const refused = await promptRuntimeSession(s.driver, "automatic", {
      origin,
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    assert.ok(refused instanceof hold.AutomaticTurnsHeldError);
    // Every automatic caller keeps its work on busy, so the refusal is one.
    assert.ok(refused instanceof SessionBusyError);
  }
  assert.equal(s.sent.length, 0, "nothing reached the provider");
  assert.equal(userEntries(s.id).length, 0, "nothing was appended");
  assert.equal(hold.automaticTurnsHeld(s.id), true, "system input lifts none");
});

test("a Stop that lands while an automatic prompt is past the entry check still refuses it", async () => {
  const s = session();
  // The first check passes synchronously; the Stop lands during the awaited
  // session-skills step, before anything is appended.
  const run = promptRuntimeSession(s.driver, "background update", {
    origin: backgroundOrigin,
  });
  hold.holdAutomaticTurns(s.id);
  await assert.rejects(run, hold.AutomaticTurnsHeldError);
  assert.equal(s.sent.length, 0);
  assert.equal(userEntries(s.id).length, 0);
});

test("the Claude provider-initiated background turn is refused while held, also mid-admission", async () => {
  const s = session();
  hold.holdAutomaticTurns(s.id);
  await assert.rejects(
    beginRuntimeProviderTurn(s.driver, {
      kind: "system",
      source: "claude-background:item",
    }),
    hold.AutomaticTurnsHeldError,
  );
  const other = session();
  const admission = beginRuntimeProviderTurn(other.driver, {
    kind: "system",
    source: "claude-background:item",
  });
  hold.holdAutomaticTurns(other.id);
  await assert.rejects(admission, hold.AutomaticTurnsHeldError);
});

test("a message the user sends now lifts the hold once appended, without offering the idle edge", async () => {
  const s = session();
  hold.holdAutomaticTurns(s.id);
  changed = [];
  const resumeHold = hold.captureHumanResume(s.id);
  void promptRuntimeSession(s.driver, "carry on", { resumeHold });
  await until(() => s.sent.length === 1, "the human turn");
  assert.equal(hold.automaticTurnsHeld(s.id), false);
  assert.deepEqual(changed, [s.id], "viewers are told");
  // The human turn's own idle edge brings what waited; an offer now would
  // race it for the session.
  assert.deepEqual(resumed, []);
  await s.finish();
});

test("older human work scheduled for later neither runs nor resumes while held", async () => {
  const s = session();
  hold.holdAutomaticTurns(s.id);
  // A queued draft or intake row: human provenance, but no authority now.
  await assert.rejects(
    promptRuntimeSession(s.driver, "queued before the Stop", {
      origin: { kind: "human" },
    }),
    hold.AutomaticTurnsHeldError,
  );
  assert.equal(s.sent.length, 0);
  assert.equal(userEntries(s.id).length, 0);
  assert.equal(hold.automaticTurnsHeld(s.id), true);
});

test("a newer Stop defeats a resume the user authorized before it", async () => {
  const s = session();
  hold.holdAutomaticTurns(s.id);
  const stale = hold.captureHumanResume(s.id);
  // Stop again before the send is admitted: a new generation.
  hold.holdAutomaticTurns(s.id);
  await assert.rejects(
    promptRuntimeSession(s.driver, "sent before the second Stop", {
      resumeHold: stale,
    }),
    hold.AutomaticTurnsHeldError,
  );
  assert.equal(hold.spendHumanResume(stale), false, "nor can it be spent");
  assert.equal(hold.automaticTurnsHeld(s.id), true);

  // Resume, then Stop again while a send authorized under the first is on its
  // way: the generation never repeats, so the old authority is still dead.
  hold.resumeAutomaticTurns(s.id);
  hold.holdAutomaticTurns(s.id);
  assert.equal(hold.spendHumanResume(stale), false);
  assert.equal(hold.automaticTurnsHeld(s.id), true);

  // A send captured while unheld, overtaken by a Stop during its admission.
  const other = session();
  const unheld = hold.captureHumanResume(other.id);
  const run = promptRuntimeSession(other.driver, "typed before the Stop", {
    resumeHold: unheld,
  });
  hold.holdAutomaticTurns(other.id);
  await assert.rejects(run, hold.AutomaticTurnsHeldError);
  assert.equal(other.sent.length, 0);
  assert.equal(hold.automaticTurnsHeld(other.id), true);
});

test("a refused human send and a human steer into the stopping turn lift nothing", async () => {
  const s = session();
  void promptRuntimeSession(s.driver, "the running turn");
  await until(() => s.driver.isRunning, "the running turn");
  hold.holdAutomaticTurns(s.id);
  const resumeHold = hold.captureHumanResume(s.id);
  // Busy: an ordinary prompt cannot join the turn being stopped.
  await assert.rejects(
    promptRuntimeSession(s.driver, "second", { resumeHold }),
    SessionBusyError,
  );
  assert.equal(hold.automaticTurnsHeld(s.id), true);
  // A steer is aimed at the turn being stopped, not a resume.
  await promptRuntimeSession(s.driver, "also this", {
    steer: true,
    resumeHold,
  });
  assert.equal(hold.automaticTurnsHeld(s.id), true);
  await s.finish();
  assert.equal(hold.automaticTurnsHeld(s.id), true, "the idle edge lifts none");
});

test("a queued draft past its queue check is refused when a Stop lands during its admission", async () => {
  const s = session();
  let stopped = false;
  queue.setPromptQueueHost({
    resolve: async () => s.driver as never,
    live: () => s.driver as never,
    reportError: () => {},
    yieldToOthers: () => {},
    publish: (id, state) => {
      published[id] = state;
      // The send has begun (the row is locked): the Stop lands while the run
      // door awaits the session's skills.
      if (!stopped && state.items.some((item) => item.sending)) {
        stopped = true;
        queueMicrotask(() => {
          hold.holdAutomaticTurns(id);
          queue.pausePromptQueueForStop(id);
        });
      }
    },
  });
  queue.queuePrompt(s.id, { text: "old queued draft" });
  await queue.drainPromptQueue(s.id);
  await until(
    () => stopped && !published[s.id]?.items.some((item) => item.sending),
    "the refused send to settle",
  );
  assert.equal(s.sent.length, 0, "the draft never reached the provider");
  assert.equal(hold.automaticTurnsHeld(s.id), true);
  assert.deepEqual(
    queue.promptQueueField(s.id).promptQueue?.items.map((item) => item.text),
    ["old queued draft"],
    "it waits in its place",
  );
  assert.equal(
    queue.promptQueueField(s.id).promptQueue?.items[0]?.error,
    undefined,
  );
});

test("the hold survives a reload of every module (a server restart)", async () => {
  const s = session();
  hold.holdAutomaticTurns(s.id);
  vi.resetModules();
  const reloaded = await import("./automaticTurnHold.ts");
  assert.equal(reloaded.automaticTurnsHeld(s.id), true);
  assert.equal(reloaded.automaticTurnsHeld(`${s.id}-other`), false);
});

test("a held session with nothing queued still carries its Resume, and Resume offers the idle edge", () => {
  const s = session();
  assert.deepEqual(queue.promptQueueField(s.id), {});
  hold.holdAutomaticTurns(s.id);
  assert.deepEqual(queue.promptQueueField(s.id), {
    promptQueue: { items: [], paused: true, automaticTurnsHeld: true },
  });
  assert.equal(published[s.id]?.automaticTurnsHeld, true, "viewers are told");
  // Reading the state again (a reconnect, a mount) changes nothing.
  queue.promptQueueField(s.id);
  assert.equal(hold.automaticTurnsHeld(s.id), true);

  queue.resumePromptQueue(s.id);
  assert.equal(hold.automaticTurnsHeld(s.id), false);
  assert.deepEqual(resumed, [s.id]);
  assert.deepEqual(queue.promptQueueField(s.id), {});
  assert.equal(published[s.id]?.automaticTurnsHeld, undefined);
});

test("a second Stop and a release with nothing held are no-ops", () => {
  const s = session();
  hold.holdAutomaticTurns(s.id);
  hold.holdAutomaticTurns(s.id);
  assert.deepEqual(changed, [s.id]);
  assert.equal(hold.resumeAutomaticTurns(s.id), true);
  assert.equal(hold.resumeAutomaticTurns(s.id), false);
  assert.deepEqual(resumed, [s.id]);
});

/**
 * `connection.ts` binds a server at import, so its Stop is asserted on the
 * source, like the idle-chain wiring: the hold is persisted from the viewed id
 * BEFORE the awaited harness upgrade and the abort, so a delivery waiting on
 * the stopped turn's idle edge can never read the session as unheld.
 */
test("Stop persists the hold before anything is awaited or aborted", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "connection.ts"),
    "utf8",
  );
  assert.match(
    source,
    /case "abort": \{(?:\s*\/\/[^\n]*)*\s*const stopped = this\.viewing\?\.sessionId;\s*if \(stopped\) holdAutomaticTurns\(stopped\);(?:\s*\/\/[^\n]*)*\s*return this\.withViewedSession\(\(driver, view\) => \{\s*if \(driver\.isRunning\) pausePromptQueueForStop\(driver\.sessionId\);\s*return view\?\.abort\(\);/,
  );
});

test("the Assistant takes Resume, and a post-reload continuation goes through the durable handoff", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "connection.ts"),
    "utf8",
  );
  // Its draft queue stays refused; Resume lifts only the hold.
  assert.match(
    source,
    /if \(isPermanentAssistantSession\(sessionId\)\) \{(?:\s*\/\/[^\n]*)*\s*if \(msg\.type === "resumePromptQueue"\) \{\s*resumeAutomaticTurns\(sessionId\);\s*return;\s*\}/,
  );
  const start = source.indexOf(
    "private async maybeStartPostReloadContinuation",
  );
  const body = source.slice(start, source.indexOf("\n  }\n", start));
  assert.match(body, /deliverPostReloadContinuation\(continuation,/);
  assert.doesNotMatch(body, /promptRuntimeSession/);
});

test("a typed message captures its resume authority before anything is awaited", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "connection.ts"),
    "utf8",
  );
  assert.match(
    source,
    /const resumeHold = this\.viewing\s*\?\s*captureHumanResume\(this\.viewing\.sessionId\)\s*:\s*undefined;\s*const driver = await this\.ensureViewingDriver\(\);/,
  );
});
