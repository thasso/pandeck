/**
 * The local pi engine handle: the loop policy it runs inside pi's event loop
 * (retry suppression, the `agent_end` guard, the compaction-window check), the
 * fan-out after it, the synchronous submit decision, the compaction-window
 * lower/restore split and disposal.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { installCompactionWindow } from "./compactionWindow.ts";
import { localPiEngine, nativePiSessionForTests } from "./piEngine.ts";

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
  });
  assert.deepEqual(calls, [["steer", "more", images]]);
  assert.equal(await steered, undefined, "a steer's disposition stays in pi");

  calls.length = 0;
  const started = engine.submit("hello", images as never, {
    steer: false,
    steerOnly: false,
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
