/**
 * The user's prompt queue: one message per idle edge, in the user's order,
 * held by a Stop or a failed send.
 *   pnpm --filter @assistant/server test src/promptQueue.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "vitest";
import type { PromptQueueState } from "@assistant/shared";
import type {
  AdapterEvent,
  AgentRunResult,
  PromptableAdapter,
  PromptOptions,
} from "./session/adapters/contract.ts";

const dataDir = mkdtempSync(join(tmpdir(), "prompt-queue-test-"));
process.env.DATA_DIR = dataDir;
process.env.ASSISTANT_CWD = dataDir;

const queue = await import("./promptQueue.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { promptQueueStore } = await import("./db/promptQueueStore.ts");
const { sessionRuntime } = await import("./session/runtimeInstance.ts");
const { SessionBusyError } = await import("./session/runtime/errors.ts");
const { updateSettings, getSettings } = await import("./settings.ts");

updateSettings({ memory: { ...getSettings().memory, learningMode: "off" } });

/**
 * A driver whose turns stay open until released, so "running" is real and the
 * queue has something to wait behind.
 */
function fakeDriver(
  sessionId: string,
  options: { deferSteer?: boolean; commandBusy?: boolean } = {},
) {
  const sent: { text: string; options: PromptOptions }[] = [];
  let running = false;
  let release: (() => void) | undefined;
  let answerSteer: (() => void) | undefined;
  const commands: string[] = [];
  const listeners = new Set<(event: AdapterEvent) => void>();
  const adapter: PromptableAdapter = {
    provider: "fake",
    capabilities: {
      fork: "none",
      compact: false,
      steer: true,
      ...(options.deferSteer ? { steerAcceptance: "deferred" as const } : {}),
      attachments: true,
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getBinding: () => ({ provider: "fake" }),
    prompt: (text: string, promptOptions: PromptOptions = {}) => {
      sent.push({ text, options: promptOptions });
      if (promptOptions.steer && options.deferSteer)
        return new Promise<AgentRunResult>((resolve) => {
          answerSteer = () =>
            resolve({ stopReason: "end", steerDelivery: "steer" });
        });
      if (promptOptions.steer)
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
    kind: "assistant" as const,
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
    // The host-command surface `/clear` drives.
    beginSyntheticTool: (name: string) => {
      if (options.commandBusy) throw new SessionBusyError(sessionId);
      commands.push(name);
      return { assistantId: "a", toolId: "t" };
    },
    updateSyntheticTool: () => {},
    clearContext: async () => ({ kind: "skipped" as const, reason: "empty" }),
    finishSyntheticTool: () => {},
  };
  return {
    driver,
    sent,
    commands,
    answerSteer: () => answerSteer?.(),
    /** End the running turn, as the harness would, and wait for the runtime to see it. */
    finishTurn: async () => {
      // A drain returns once the entry is appended, which is before the
      // provider is asked: wait for the turn it started to exist first.
      await until(
        () =>
          release !== undefined || !sessionRuntime.get(sessionId)?.isRunning,
        "the running turn to reach the provider",
      );
      const ended = release;
      ended?.();
      // Ended — or the queue has rightly started the next turn at once.
      await until(
        () =>
          !sessionRuntime.get(sessionId)?.isRunning ||
          (release !== undefined && release !== ended),
        "the turn to end",
      );
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

/**
 * Wait for what a send does asynchronously (session skills, the runtime's
 * append) instead of a fixed pause, which a loaded CI runner can outlast.
 */
async function until(check: () => boolean, label = "condition"): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${label} was not reached`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

let serial = 0;
let published: Record<string, PromptQueueState> = {};
let errors: string[] = [];
let yielded: string[] = [];
let drivers: Map<string, ReturnType<typeof fakeDriver>>;

beforeEach(() => {
  published = {};
  errors = [];
  yielded = [];
  drivers = new Map();
  queue.setPromptQueueHost({
    resolve: async (id) => drivers.get(id)?.driver as never,
    live: (id) => drivers.get(id)?.driver as never,
    publish: (id, state) => (published[id] = state),
    reportError: (_id, message) => errors.push(message),
    yieldToOthers: (id) => yielded.push(id),
  });
});

function session(options: Parameters<typeof fakeDriver>[1] = {}) {
  serial += 1;
  const id = `queue-session-${serial}`;
  sessionStore.upsert({
    id,
    scope: "user",
    harness: "pi",
    agentType: "assistant",
  });
  const fake = fakeDriver(id, options);
  drivers.set(id, fake);
  return { id, ...fake };
}

/** Start a turn of the user's own so the queue has something to wait behind. */
async function startTurn(fake: ReturnType<typeof session>) {
  const { promptRuntimeSession } = await import("./session/runtimePrompt.ts");
  void promptRuntimeSession(fake.driver, "the running turn");
  await until(
    () =>
      fake.driver.isRunning && Boolean(sessionRuntime.get(fake.id)?.isRunning),
    "the running turn",
  );
}

const texts = (id: string) => published[id]?.items.map((i) => i.text) ?? [];

test("rechecks a coordinated handoff after cold driver acquisition", async () => {
  const s = session();
  let acquisitionStarted!: () => void;
  let finishAcquire!: () => void;
  const started = new Promise<void>((resolve) => {
    acquisitionStarted = resolve;
  });
  const acquisition = new Promise<void>((resolve) => {
    finishAcquire = resolve;
  });
  let authorityAvailable = true;
  promptQueueStore.append({
    id: `queued-${s.id}`,
    sessionId: s.id,
    text: "user queued prompt",
  });
  queue.setPromptQueueHost({
    resolve: async () => {
      acquisitionStarted();
      await acquisition;
      return s.driver as never;
    },
    live: () => undefined,
    publish: (id, state) => (published[id] = state),
    reportError: (_id, message) => errors.push(message),
    yieldToOthers: (id) => yielded.push(id),
  });

  const drain = queue.drainPromptQueue(s.id);
  await started;
  // The peer drain joins an already-acquiring queue drain and contributes its
  // authority check to that in-flight delivery.
  const coordinatedDrain = queue.drainPromptQueue(
    s.id,
    () => authorityAvailable,
  );
  // An explicit send-now takes authority while cold acquisition is pending.
  authorityAvailable = false;
  finishAcquire();
  await Promise.all([drain, coordinatedDrain]);
  assert.equal(
    s.sent.length,
    0,
    "the user row yields to the selected peer row",
  );
  assert.equal(promptQueueStore.list(s.id).length, 1);

  // Once authority is released, ordinary queue processing resumes.
  authorityAvailable = true;
  await queue.drainPromptQueue(s.id);
  await until(() => s.sent.at(-1)?.text === "user queued prompt");
  assert.equal(promptQueueStore.list(s.id).length, 0);
});

test("queued messages wait for the turn, then go one per idle edge in order", async () => {
  const s = session();
  await startTurn(s);
  queue.queuePrompt(s.id, { text: "first" });
  queue.queuePrompt(s.id, { text: "second" });
  await tick();
  assert.deepEqual(texts(s.id), ["first", "second"]);
  assert.equal(s.sent.length, 1, "nothing is sent while the turn runs");

  await s.finishTurn();
  await queue.drainPromptQueue(s.id);
  assert.equal(s.sent.at(-1)?.text, "first");
  assert.deepEqual(texts(s.id), ["second"], "a sent row leaves the queue");

  await s.finishTurn();
  await queue.drainPromptQueue(s.id);
  assert.equal(s.sent.at(-1)?.text, "second");
  assert.deepEqual(texts(s.id), []);
  await s.finishTurn();
});

test("edit, reorder and remove act on the user's queue", async () => {
  const s = session();
  await startTurn(s);
  queue.queuePrompt(s.id, { text: "a" });
  queue.queuePrompt(s.id, { text: "b" });
  queue.queuePrompt(s.id, { text: "c" });
  const [a, , c] = published[s.id]!.items;
  queue.moveQueuedPrompt(s.id, c!.id, 0);
  assert.deepEqual(texts(s.id), ["c", "a", "b"]);
  queue.updateQueuedPrompt(s.id, a!.id, "a, edited");
  assert.deepEqual(texts(s.id), ["c", "a, edited", "b"]);
  queue.removeQueuedPrompt(s.id, c!.id);
  assert.deepEqual(texts(s.id), ["a, edited", "b"]);
  queue.clearPromptQueue(s.id);
  assert.deepEqual(published[s.id], { items: [], paused: false });
  await s.finishTurn();
});

test("Stop holds the queue; resuming or a message of the user's own lifts it", async () => {
  const s = session();
  await startTurn(s);
  queue.queuePrompt(s.id, { text: "after the stop" });
  queue.pausePromptQueueForStop(s.id);
  await s.finishTurn();
  await queue.drainPromptQueue(s.id);
  assert.equal(published[s.id]?.paused, true);
  assert.equal(s.sent.length, 1, "a stopped turn is not followed by the queue");
  assert.equal(queue.promptQueueHasPriority(s.id), false);

  queue.resumePromptQueueForHumanPrompt(s.id);
  assert.equal(published[s.id]?.paused, false);
  queue.pausePromptQueueForStop(s.id);
  queue.resumePromptQueue(s.id);
  await until(() => s.sent.at(-1)?.text === "after the stop");
  await s.finishTurn();
});

test("a queued message goes before an agent's while one is owed", async () => {
  const s = session();
  await startTurn(s);
  queue.queuePrompt(s.id, { text: "mine" });
  assert.equal(queue.promptQueueHasPriority(s.id), true);
  await s.finishTurn();
  await queue.drainPromptQueue(s.id);
  assert.equal(queue.promptQueueHasPriority(s.id), false);
  await s.finishTurn();
});

test("send now steers a queued message into the running turn", async () => {
  const s = session();
  await startTurn(s);
  queue.queuePrompt(s.id, { text: "now please" });
  const [item] = published[s.id]!.items;
  await queue.sendQueuedPromptNow(s.id, item!.id);
  const steer = s.sent.at(-1);
  assert.equal(steer?.text, "now please");
  assert.equal(steer?.options.steer, true);
  assert.deepEqual(texts(s.id), []);
  await s.finishTurn();
});

test("a queued command that cannot run holds the queue on its row", async () => {
  const s = session();
  await startTurn(s);
  queue.queuePrompt(s.id, {
    text: "/nope",
    command: { name: "nope", rawArgs: "" },
  });
  await s.finishTurn();
  await queue.drainPromptQueue(s.id);
  const state = published[s.id]!;
  assert.equal(state.paused, true);
  assert.match(state.items[0]?.error ?? "", /not available/);
  assert.ok(yielded.includes(s.id), "the held queue gives up the edge");
  queue.resumePromptQueue(s.id);
  assert.equal(published[s.id]?.items[0]?.error, undefined);
  queue.clearPromptQueue(s.id);
});

test("queueing on an idle session sends at once", async () => {
  const s = session();
  queue.queuePrompt(s.id, { text: "hello" });
  await until(() => s.sent.at(-1)?.text === "hello");
  await until(() => texts(s.id).length === 0);
  await s.finishTurn();
});

test("a row being sent is locked: no edit, no removal, and clear keeps it", async () => {
  const s = session({ deferSteer: true });
  await startTurn(s);
  queue.queuePrompt(s.id, { text: "locked" });
  queue.queuePrompt(s.id, { text: "free" });
  const [locked] = published[s.id]!.items;
  const send = queue.sendQueuedPromptNow(s.id, locked!.id);
  // Held open until the fake provider answers, which it can only do once
  // the steer has reached it.
  await until(() => s.sent.some((sent) => sent.options.steer === true));
  assert.equal(published[s.id]?.items[0]?.sending, true);
  assert.throws(() => queue.updateQueuedPrompt(s.id, locked!.id, "changed"));
  assert.throws(() => queue.removeQueuedPrompt(s.id, locked!.id));
  assert.throws(() => queue.moveQueuedPrompt(s.id, locked!.id, 1));
  queue.clearPromptQueue(s.id);
  assert.deepEqual(texts(s.id), ["locked"], "clear keeps what is under way");

  s.answerSteer();
  await send;
  assert.deepEqual(texts(s.id), [], "taken, it leaves the queue");
  assert.equal(s.sent.at(-1)?.text, "locked", "with the text read at send");
  await s.finishTurn();
});

test("a queued command that meets a busy session waits for the next edge", async () => {
  const s = session({ commandBusy: true });
  queue.queuePrompt(s.id, {
    text: "/clear",
    command: { name: "clear", rawArgs: "" },
  });
  await tick();
  await queue.drainPromptQueue(s.id);
  const state = published[s.id]!;
  assert.deepEqual(
    state.items.map((i) => i.text),
    ["/clear"],
  );
  assert.equal(state.paused, false, "busy is not a failure");
  assert.equal(state.items[0]?.error, undefined);
  queue.clearPromptQueue(s.id);
});

test("a queued command leaves the queue only once it ran", async () => {
  const s = session();
  queue.queuePrompt(s.id, {
    text: "/clear",
    command: { name: "clear", rawArgs: "" },
  });
  await tick();
  await queue.drainPromptQueue(s.id);
  assert.deepEqual(s.commands, ["/clear"]);
  assert.deepEqual(texts(s.id), []);
});

test("a message queued held stays put until the user resumes", async () => {
  const s = session();
  queue.queuePrompt(s.id, { text: "back from a Stop" }, { paused: true });
  await tick();
  assert.equal(published[s.id]?.paused, true);
  assert.equal(s.sent.length, 0, "an idle session is not sent a held message");
  queue.resumePromptQueue(s.id);
  await until(() => s.sent.at(-1)?.text === "back from a Stop");
  await s.finishTurn();
});

test("a note rides a held message until the user resumes", async () => {
  const s = session();
  queue.queuePrompt(
    s.id,
    { text: "maybe read" },
    { paused: true, note: "Claude may have read this." },
  );
  await tick();
  assert.equal(published[s.id]?.items[0]?.error, "Claude may have read this.");
  assert.equal(s.sent.length, 0);
  queue.clearPromptQueue(s.id);
});

test("a message the model may have read is never resent by the user's next message", async () => {
  const s = session();
  queue.queuePrompt(
    s.id,
    { text: "maybe read" },
    { paused: true, note: "Claude may have read this." },
  );
  await tick();
  // The user writes something else instead of resending it.
  queue.resumePromptQueueForHumanPrompt(s.id);
  await startTurn(s);
  await s.finishTurn();
  await queue.drainPromptQueue(s.id);
  assert.equal(
    s.sent.some((sent) => sent.text === "maybe read"),
    false,
    "their own message lifts the Stop, not the row's note",
  );
  assert.equal(published[s.id]?.paused, true, "the tray still says it is held");
  assert.equal(queue.promptQueueHasPriority(s.id), false);

  // Only an explicit Send next sends it, and only it.
  queue.queuePrompt(s.id, { text: "after it" });
  queue.queuePrompt(
    s.id,
    { text: "also maybe read" },
    { note: "Claude may have read this." },
  );
  queue.resumePromptQueue(s.id);
  await until(() => s.sent.at(-1)?.text === "maybe read");
  await s.finishTurn();
  await queue.drainPromptQueue(s.id);
  assert.equal(s.sent.at(-1)?.text, "after it");
  await s.finishTurn();
  await queue.drainPromptQueue(s.id);
  assert.equal(
    s.sent.at(-1)?.text,
    "after it",
    "a later noted row holds again",
  );
  assert.equal(published[s.id]?.paused, true);
  queue.clearPromptQueue(s.id);
});

test("editing a held row keeps its hold: only an explicit send lifts it", async () => {
  const s = session();
  queue.queuePrompt(
    s.id,
    { text: "maybe read" },
    { paused: true, note: "Claude may have read this." },
  );
  await tick();
  queue.resumePromptQueueForHumanPrompt(s.id);
  await startTurn(s);
  const [held] = published[s.id]!.items;
  queue.updateQueuedPrompt(s.id, held!.id, "maybe read, reworded");
  assert.equal(published[s.id]?.items[0]?.error, "Claude may have read this.");
  await s.finishTurn();
  await queue.drainPromptQueue(s.id);
  assert.equal(
    s.sent.some((sent) => sent.text.startsWith("maybe read")),
    false,
    "an edit is not consent to resend it",
  );
  queue.clearPromptQueue(s.id);
});
