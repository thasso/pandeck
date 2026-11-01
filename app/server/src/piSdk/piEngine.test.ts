/**
 * The local pi engine handle: the loop policy it runs inside pi's event loop
 * (retry suppression, the `agent_end` guard, the compaction-window check), the
 * fan-out after it, the synchronous submit decision, the compaction-window
 * lower/restore split and disposal — and the live session over it awaiting
 * what it changed before announcing it.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { installCompactionWindow } from "./compactionWindow.ts";
import { PiLiveSession } from "./PiLiveSession.ts";
import {
  localPiEngine,
  nativePiSessionForTests,
  type PiEngineHandle,
} from "./piEngine.ts";
import {
  createPiToolActivation,
  UNUSED_TOOL_PRUNE_IDLE_MS,
} from "./toolActivation.ts";
import { agentToolsFor, eagerToolNamesFor } from "../tools/catalog.ts";

/** A content-policy refusal pi must not retry (see `providerErrors.test.ts`). */
const SUPPRESSIBLE_ERROR = `Codex error: This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.`;
const RECOVERABLE_ERROR = `503 Service Unavailable`;

type Listener = (event: unknown) => void;

function failedMessage(errorMessage: string) {
  return {
    role: "assistant",
    stopReason: "error",
    errorMessage,
    provider: "openai-codex",
    model: "gpt-6.1-sol",
  };
}

function fakeSession(overrides: Record<string, unknown> = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  let listener: Listener | undefined;
  const session = {
    sessionId: "S1",
    sessionFile: "/tmp/S1.jsonl",
    isStreaming: false,
    model: undefined,
    settingsManager: {
      getRetrySettings: () => {
        calls.push(["getRetrySettings"]);
        return { enabled: true, maxRetries: 3 };
      },
      applyOverrides: (value: unknown) => calls.push(["applyOverrides", value]),
    },
    abortRetry: () => calls.push(["abortRetry"]),
    subscribe: (next: Listener) => {
      assert.equal(listener, undefined, "the engine subscribes once");
      listener = next;
      calls.push(["subscribe"]);
      return () => {
        listener = undefined;
        calls.push(["unsubscribe"]);
      };
    },
    steer: (text: string, images: unknown) => {
      calls.push(["steer", text, images]);
      return Promise.resolve();
    },
    prompt: (text: string, options: unknown) => {
      calls.push(["prompt", text, options]);
      return Promise.resolve();
    },
    dispose: () => calls.push(["dispose"]),
    ...overrides,
  };
  return {
    session,
    calls,
    emit: (event: unknown) => listener?.(event),
    get subscribed() {
      return listener !== undefined;
    },
  };
}

test("a suppressible failure saves retry settings once, zeroes retries each time, and restores them on the next turn", () => {
  const fake = fakeSession();
  localPiEngine(fake.session as never);
  fake.calls.length = 0;

  fake.emit({
    type: "message_end",
    message: failedMessage(SUPPRESSIBLE_ERROR),
  });
  fake.emit({
    type: "message_end",
    message: failedMessage(SUPPRESSIBLE_ERROR),
  });
  assert.deepEqual(fake.calls, [
    ["getRetrySettings"],
    ["applyOverrides", { retry: { enabled: true, maxRetries: 0 } }],
    ["applyOverrides", { retry: { enabled: true, maxRetries: 0 } }],
  ]);

  fake.calls.length = 0;
  fake.emit({ type: "agent_start" });
  assert.deepEqual(fake.calls, [
    ["applyOverrides", { retry: { enabled: true, maxRetries: 3 } }],
  ]);
  fake.calls.length = 0;
  fake.emit({ type: "agent_start" });
  assert.deepEqual(fake.calls, [], "nothing left to restore");
});

test("a recoverable or aborted failure leaves retry settings alone", () => {
  const fake = fakeSession();
  localPiEngine(fake.session as never);
  fake.calls.length = 0;
  fake.emit({
    type: "message_end",
    message: failedMessage(RECOVERABLE_ERROR),
  });
  fake.emit({
    type: "message_end",
    message: {
      ...failedMessage(SUPPRESSIBLE_ERROR),
      stopReason: "aborted",
    },
  });
  fake.emit({ type: "agent_start" });
  assert.deepEqual(fake.calls, []);
});

test("agent_end reports no retry while suppression is active, and passes through otherwise", () => {
  const fake = fakeSession();
  const engine = localPiEngine(fake.session as never);
  const seen: unknown[] = [];
  engine.subscribe((event) => seen.push(event));

  fake.emit({ type: "agent_end", messages: [], willRetry: true });
  fake.emit({
    type: "message_end",
    message: failedMessage(SUPPRESSIBLE_ERROR),
  });
  fake.emit({ type: "agent_end", messages: [], willRetry: true });
  fake.emit({ type: "agent_end", messages: [], willRetry: false });

  assert.deepEqual(
    seen
      .filter((event) => (event as { type: string }).type === "agent_end")
      .map((event) => (event as { willRetry: boolean }).willRetry),
    [true, false, false],
  );
});

test("auto_retry_start aborts the retry only for a suppressible error", () => {
  const fake = fakeSession();
  localPiEngine(fake.session as never);
  fake.calls.length = 0;
  fake.emit({
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 1000,
    errorMessage: RECOVERABLE_ERROR,
  });
  assert.deepEqual(fake.calls, []);
  fake.emit({
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 1000,
    errorMessage: SUPPRESSIBLE_ERROR,
  });
  assert.deepEqual(fake.calls, [["abortRetry"]]);
});

test("listeners each see every event once, in order, after the policy ran for it", () => {
  const fake = fakeSession();
  const engine = localPiEngine(fake.session as never);
  const seen: string[] = [];
  const watch = (name: string) => (event: { type: string }) =>
    seen.push(`${name}:${event.type}:${fake.calls.length}`);
  engine.subscribe(watch("first"));
  const stopSecond = engine.subscribe(watch("second"));
  fake.calls.length = 0;

  fake.emit({
    type: "message_end",
    message: failedMessage(SUPPRESSIBLE_ERROR),
  });
  fake.emit({ type: "agent_start" });
  stopSecond();
  fake.emit({ type: "turn_start" });

  assert.deepEqual(seen, [
    // getRetrySettings + applyOverrides already happened.
    "first:message_end:2",
    "second:message_end:2",
    // The restoring applyOverrides already happened.
    "first:agent_start:3",
    "second:agent_start:3",
    "first:turn_start:3",
  ]);
});

test("submit makes the caller's steer-or-prompt call before it returns, and settles as pi's call does", async () => {
  const calls: unknown[] = [];
  const fake = fakeSession({
    steer: (text: string, images: unknown) => {
      calls.push(["steer", text, images]);
      return Promise.resolve("queued");
    },
    prompt: (text: string, options: unknown) => {
      calls.push(["prompt", text, options]);
      return Promise.reject(new Error("prompt refused"));
    },
  });
  const engine = localPiEngine(fake.session as never);
  const images = [{ type: "image", data: "AAAA", mimeType: "image/png" }];

  const steered = engine.submit("more", images as never, {
    steer: true,
    steerOnly: true,
    userTurnIdleMs: 0,
  });
  assert.deepEqual(calls, [["steer", "more", images]]);
  assert.equal(await steered, undefined, "a steer's disposition stays in pi");

  calls.length = 0;
  const started = engine.submit("hello", images as never, {
    steer: false,
    steerOnly: false,
    userTurnIdleMs: 0,
  });
  assert.deepEqual(calls, [["prompt", "hello", { images }]]);
  await assert.rejects(started, /prompt refused/);
});

test("dispose drops the engine's subscription and disposes the session within the call", () => {
  const fake = fakeSession();
  const engine = localPiEngine(fake.session as never);
  const seen: unknown[] = [];
  engine.subscribe((event) => seen.push(event));
  fake.calls.length = 0;

  void engine.dispose();
  assert.deepEqual(fake.calls, [["unsubscribe"], ["dispose"]]);
  assert.equal(fake.subscribed, false);
  fake.emit({ type: "agent_start" });
  assert.deepEqual(seen, []);
});

test("the test seam answers only a local engine's own session", () => {
  const fake = fakeSession();
  const engine = localPiEngine(fake.session as never);
  assert.equal(nativePiSessionForTests(engine), fake.session);
  assert.throws(
    () => nativePiSessionForTests({ ...engine }),
    /Not a local pi engine/,
  );
});

test("the tool session manager reads entries across the whole transcript and appends as a command", async () => {
  const appended: unknown[] = [];
  const entries = [
    { id: "off-branch", type: "custom" },
    { id: "on-branch", type: "custom" },
  ];
  const fake = fakeSession({
    sessionManager: {
      getSessionId: () => "S1",
      getBranch: () => entries.slice(1),
      getEntry: (id: string) => entries.find((entry) => entry.id === id),
      appendCustomEntry: (type: string, data: unknown) => {
        appended.push([type, data]);
        return "new-entry";
      },
    },
  });
  const manager = localPiEngine(fake.session as never).toolSessionManager();
  assert.equal(manager.getSessionId(), "S1");
  assert.deepEqual(manager.getBranch(), [entries[1]]);
  assert.equal(manager.getEntry("off-branch"), entries[0]);
  const id = manager.appendCustomEntry("workshop.commit", { version: 1 });
  assert.ok(id instanceof Promise);
  assert.equal(await id, "new-entry");
  assert.deepEqual(appended, [["workshop.commit", { version: 1 }]]);
});

/* --------------------------- compaction window --------------------------- */

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const MODEL = { provider: "p", id: "m", contextWindow: 272_000 };

function windowedSession() {
  root = mkdtempSync(join(tmpdir(), "pi-engine-window-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ compaction: { reserveTokens: 30_000 } }),
  );
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const fake = fakeSession({ settingsManager, model: MODEL });
  return { fake, settingsManager };
}

test("agent_start verifies the compaction window before any listener sees it", () => {
  const { fake } = windowedSession();
  const controller = installCompactionWindow(fake.session as never, 150_000);
  const order: string[] = [];
  const verify = controller.verify.bind(controller);
  controller.verify = () => {
    order.push("verify");
    verify();
  };
  const engine = localPiEngine(fake.session as never);
  engine.subscribe((event) => order.push(`listener:${event.type}`));

  fake.emit({ type: "agent_start" });
  fake.emit({ type: "turn_start" });
  assert.deepEqual(order, [
    "verify",
    "listener:agent_start",
    "listener:turn_start",
  ]);
});

test("lowering applies without persisting, and a restore puts the previous window back", async () => {
  const { fake, settingsManager } = windowedSession();
  const controller = installCompactionWindow(fake.session as never, 150_000);
  const engine = localPiEngine(fake.session as never);

  const lowered = await engine.lowerCompactionWindow(120_000);
  assert.deepEqual(lowered, { ok: true, previous: 150_000, applied: 120_000 });
  assert.equal(controller.status().live.appliedTokens, 120_000);

  const restored = await engine.restoreCompactionWindow(
    150_000,
    "Saving the compaction window failed: disk full",
  );
  assert.deepEqual(restored, {
    ok: false,
    message: "Saving the compaction window failed: disk full",
  });
  assert.equal(controller.status().live.appliedTokens, 150_000);
  assert.equal(settingsManager.getCompactionReserveTokens(MODEL), 122_000);
  assert.equal(engine.compactionWindowStatus().live.appliedTokens, 150_000);
});

test("without a controller the compaction window answers today's fallbacks", async () => {
  const engine = localPiEngine(fakeSession().session as never);
  assert.deepEqual(engine.compactionWindowStatus(), {
    live: { applied: "pending", pendingReason: "next-turn" },
  });
  assert.deepEqual(await engine.applyCompactionWindow(100_000), {
    pendingReason: "next-turn",
  });
  assert.deepEqual(await engine.lowerCompactionWindow(100_000), {
    ok: false,
    message: "This pi session cannot change its window.",
  });
});

/* ------------------------- the live session awaits ------------------------ */

/** What a live session reads of a session beyond the engine's own needs. */
const LIVE_READS = {
  sessionName: "Already named",
  sessionManager: {
    getBranch: () => [],
    getEntries: () => [],
    getHeader: () => undefined,
  },
  getSessionStats: () => ({
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    contextSize: 0,
  }),
};

function liveOver(engine: PiEngineHandle) {
  const rowChanges: string[][] = [];
  const host = {
    sessionRowsChanged: (ids: readonly string[]) => rowChanges.push([...ids]),
    noteRunStarted: () => {},
    checkPendingReload: () => {},
    isReloadQueued: () => false,
    buildSessionState: () => ({}) as never,
  };
  const live = new PiLiveSession(
    "coding" as never,
    engine,
    host as never,
    () => {},
  );
  const sent: string[] = [];
  live.addViewer({
    send: (message: { type: string }) => sent.push(message.type),
  });
  return { live, sent, rowChanges };
}

test.each(["model", "thinking"] as const)(
  "a %s change is announced only once the engine applied it, and a refusal reaches the caller",
  async (kind) => {
    const base = localPiEngine(fakeSession(LIVE_READS).session as never);
    const applied: unknown[] = [];
    let settle!: { resolve: () => void; reject: (error: Error) => void };
    const engine: PiEngineHandle = Object.create(base, {
      [kind === "model" ? "setModel" : "setThinkingLevel"]: {
        value: (value: unknown) => {
          applied.push(value);
          return new Promise<void>((resolve, reject) => {
            settle = { resolve, reject };
          });
        },
      },
    });
    const { live, sent, rowChanges } = liveOver(engine);
    const settled = () => new Promise((resolve) => setImmediate(resolve));
    const invoke = (refuse: boolean) =>
      kind === "model"
        ? live.setModel({ ...MODEL, id: refuse ? "refused" : "new" } as never)
        : live.setThinkingLevel(refuse ? "low" : "high");
    const raised = invoke(false);
    await settled();
    assert.equal(applied.length, 1);
    assert.deepEqual(
      rowChanges,
      [],
      "no row touch before the engine applies it",
    );
    assert.deepEqual(
      sent,
      [],
      "nothing is announced while the engine holds it",
    );
    settle.resolve();
    await raised;
    assert.deepEqual(sent, ["state", "contextInfo"]);
    assert.deepEqual(rowChanges, [[live.key]]);

    sent.length = 0;
    rowChanges.length = 0;
    const refused = invoke(true);
    await settled();
    settle.reject(new Error("engine refused"));
    await assert.rejects(refused, /engine refused/);
    assert.deepEqual(sent, [], "a refused change is never announced");
    assert.deepEqual(
      rowChanges,
      [],
      "a refused command cannot report a changed row",
    );
    live.dispose();
  },
);

test("a lowered compaction window whose save fails is put back to the previous one", async () => {
  const { fake } = windowedSession();
  Object.assign(fake.session, LIVE_READS);
  const controller = installCompactionWindow(fake.session as never, 150_000);
  const { live } = liveOver(localPiEngine(fake.session as never));

  const result = await live.lowerCompactionWindow(120_000, () => {
    throw new Error("disk full");
  });
  assert.deepEqual(result, {
    ok: false,
    message: "Saving the compaction window failed: disk full",
  });
  assert.equal(controller.status().live.appliedTokens, 150_000);
  assert.equal(live.compactionWindowStatus().live.appliedTokens, 150_000);

  const saved: number[] = [];
  assert.deepEqual(
    await live.lowerCompactionWindow(120_000, (tokens) => saved.push(tokens)),
    { ok: true, previous: 150_000, applied: 120_000 },
  );
  assert.deepEqual(saved, [120_000], "a successful lower persists once");
  assert.equal(controller.status().live.appliedTokens, 120_000);
  live.dispose();
});

/* ------------------------ the cold-boundary prune ------------------------- */

/**
 * The production engine over a fake session whose `prompt` and `steer` record
 * the active set they were invoked under, with a real registered activation
 * holding one deferred tool loaded and never used.
 */
function prunableEngine(sessionId: string) {
  let active: ReadonlySet<string> = new Set();
  const seenAtCall: Array<ReadonlySet<string>> = [];
  const fake = fakeSession({
    sessionId,
    steer: () => {
      seenAtCall.push(active);
      return Promise.resolve();
    },
    prompt: () => {
      seenAtCall.push(active);
      return Promise.resolve();
    },
  });
  const activation = createPiToolActivation({
    sessionId,
    agentType: "assistant",
    agentTools: agentToolsFor("assistant"),
    eagerToolNames: eagerToolNamesFor("assistant"),
    deferToolLoading: true,
    applyActiveToolNames: (names) => {
      active = new Set(names);
    },
  });
  activation.initialize(["kb_read"]);
  assert.ok(active.has("kb_read"), "the deferred tool starts loaded");
  const engine = localPiEngine(fake.session as never, {
    activation,
    mode: { current: "build" },
  });
  return { engine, seenAtCall };
}

for (const steer of [false, true])
  test(`submit (steer=${steer}) prunes a never-used load before pi is called, only past the cold boundary`, async () => {
    const cold = prunableEngine(`prune-cold-${steer}`);
    await cold.engine.submit("hello", [], {
      steer,
      steerOnly: false,
      userTurnIdleMs: UNUSED_TOOL_PRUNE_IDLE_MS,
    });
    assert.equal(cold.seenAtCall.length, 1);
    assert.equal(cold.seenAtCall[0]!.has("kb_read"), false);
    await cold.engine.dispose();

    const warm = prunableEngine(`prune-warm-${steer}`);
    await warm.engine.submit("hello", [], {
      steer,
      steerOnly: false,
      userTurnIdleMs: UNUSED_TOOL_PRUNE_IDLE_MS - 1,
    });
    assert.equal(warm.seenAtCall.length, 1);
    assert.equal(warm.seenAtCall[0]!.has("kb_read"), true);
    await warm.engine.dispose();
  });

test("the live session tells the engine how long it sat idle before each user turn", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000 });
  const fake = fakeSession(LIVE_READS);
  const base = localPiEngine(fake.session as never);
  const idle: number[] = [];
  const engine: PiEngineHandle = Object.create(base, {
    submit: {
      value: (
        _text: string,
        _images: unknown,
        intent: { userTurnIdleMs: number },
      ) => {
        idle.push(intent.userTurnIdleMs);
        return Promise.resolve();
      },
    },
  });
  const { live } = liveOver(engine);
  const adapter = live.createRuntimeAdapter();
  const settled = () => new Promise((resolve) => setImmediate(resolve));
  try {
    const turn = async (text: string) => {
      const run = adapter.prompt(text);
      await settled();
      fake.emit({ type: "agent_start" });
      fake.emit({ type: "agent_end", messages: [], willRetry: false });
      await run;
    };
    await turn("first");
    vi.setSystemTime(1_000_000 + 7_000);
    await turn("second");
    assert.deepEqual(idle, [0, 7_000]);
  } finally {
    vi.useRealTimers();
    live.dispose();
  }
});
