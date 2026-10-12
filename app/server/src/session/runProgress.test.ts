/**
 * Live run progress end to end on the server: harness → adapter → runtime →
 * wire, BEFORE the assistant turn commits, and what reconnects see.
 *   pnpm --filter @assistant/server test src/session/runProgress.test.ts
 *
 * The Claude cases drive the REAL `ClaudeSdkSession` through a gated scripted
 * seam, so a test can stop the provider mid-turn and look. The runtime cases
 * use a scripted adapter for stale-event and lifecycle ordering, and the pi
 * case feeds `PiLiveSession` the agent events pi emits.
 */
import assert from "node:assert/strict";
import { afterAll, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ContextInfo,
  ServerMessage,
  SessionState,
} from "@assistant/shared";
import type {
  ClientRuntimeEvent,
  ClientSessionSnapshot,
} from "@assistant/shared/runtime";
import { runProgressPhase, type RunProgress } from "@assistant/shared/session";
import type {
  ClaudeQueryParams,
  ClaudeSdkMessage,
  ClaudeSdkSeam,
} from "../claudeSdk/sdkSeam.ts";

const tmp = mkdtempSync(join(tmpdir(), "run-progress-test-"));
process.env.ASSISTANT_CWD = tmp;

const { RuntimeTransport } = await import("./transport/gateway.ts");
const { SessionRuntime } = await import("./runtime/runtime.ts");
const { SessionLogStore } = await import("./log/store.ts");
const { setSessionIdleHook } = await import("./runtime/liveSession.ts");
const { ClaudeSdkSession } = await import("../claudeSdk/ClaudeSdkSession.ts");
const { PiLiveSession } = await import("../piSdk/PiLiveSession.ts");
const { closeDb } = await import("../db/index.ts");
type AdapterEvent = import("./adapters/contract.ts").AdapterEvent;
type AgentRunResult = import("./adapters/contract.ts").AgentRunResult;
type PromptableAdapter = import("./adapters/contract.ts").PromptableAdapter;

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

const stubState = () => ({ sessionId: "cs" }) as unknown as SessionState;
const stubContext = () => ({ sessionId: "cs" }) as unknown as ContextInfo;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function viewer(runtime: InstanceType<typeof SessionRuntime>, id: string) {
  const sent: ServerMessage[] = [];
  const transport = new RuntimeTransport(
    id,
    runtime.get(id)!,
    { send: (message) => sent.push(message) },
    { buildState: stubState, buildContextInfo: stubContext },
  );
  transport.attach();
  const snapshot = (): ClientSessionSnapshot => {
    const first = sent[0];
    assert.ok(first?.type === "snapshot");
    return first.snapshot;
  };
  const events = (): ClientRuntimeEvent[] =>
    sent.flatMap((message) =>
      message.type === "event" ? [message.event] : [],
    );
  const progress = (): RunProgress[] =>
    events().flatMap((event) =>
      event.type === "runProgress" ? [event.progress] : [],
    );
  return { transport, sent, snapshot, events, progress };
}

/* --------------------------- Claude, gated seam --------------------------- */

const GATE = Symbol("gate");
type Scripted = ClaudeSdkMessage | typeof GATE;

const stream = (event: unknown): ClaudeSdkMessage =>
  ({
    type: "stream_event",
    event,
    parent_tool_use_id: null,
    uuid: `e${Math.random()}`,
    session_id: "s1",
  }) as unknown as ClaudeSdkMessage;

/** Yields its script, stopping at each {@link GATE} until `release()`. */
function gatedSeam(script: Scripted[]) {
  const gates: (() => void)[] = [];
  let reached: (() => void) | undefined;
  let reachedPromise = new Promise<void>((resolve) => (reached = resolve));
  const seam: ClaudeSdkSeam = {
    query: (_params: ClaudeQueryParams) => ({
      async *[Symbol.asyncIterator]() {
        for (const item of script) {
          if (item === GATE) {
            await new Promise<void>((resolve) => {
              gates.push(resolve);
              reached?.();
            });
            continue;
          }
          yield item;
        }
      },
    }),
  };
  return {
    seam,
    /** Resolves when the provider is parked at the next gate. */
    async atGate(): Promise<void> {
      await reachedPromise;
      reachedPromise = new Promise<void>((resolve) => (reached = resolve));
      await tick();
    },
    release(): void {
      gates.shift()?.();
    },
  };
}

const TOOL_A = "toolu_a";
const TOOL_B = "toolu_b";

function claudeScript(): Scripted[] {
  return [
    // The provider fails the first request and says so before any output.
    {
      type: "system",
      subtype: "api_retry",
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 500,
      error_status: 529,
      error: "overloaded",
      uuid: "r1",
      session_id: "s1",
    } as unknown as ClaudeSdkMessage,
    GATE, // 1: retrying, nothing streamed yet
    stream({ type: "message_start", message: { id: "m1" } }),
    stream({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: TOOL_A, name: "Bash", input: {} },
    }),
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"command":' },
    }),
    GATE, // 2: a tool call is being written — output, though not text
    {
      type: "assistant",
      uuid: "a1",
      session_id: "s1",
      message: {
        id: "m1",
        model: "claude-sonnet-4-6",
        content: [
          { type: "tool_use", id: TOOL_A, name: "Bash", input: { c: "ls" } },
          { type: "tool_use", id: TOOL_B, name: "Read", input: { p: "/x" } },
        ],
        usage: { input_tokens: 1 },
      },
    } as unknown as ClaudeSdkMessage,
    GATE, // 3: two tools running in parallel
    {
      type: "user",
      uuid: "u1",
      session_id: "s1",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: TOOL_A,
            content: "out",
            is_error: false,
          },
        ],
      },
    } as unknown as ClaudeSdkMessage,
    GATE, // 4: one finished, one still running, turn still open
    {
      type: "user",
      uuid: "u2",
      session_id: "s1",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: TOOL_B,
            content: "file",
            is_error: true,
          },
        ],
      },
    } as unknown as ClaudeSdkMessage,
    GATE, // 5: both finished, waiting on the model with results
    stream({ type: "message_start", message: { id: "m2" } }),
    stream({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Done" },
    }),
    stream({ type: "content_block_stop", index: 0 }),
    {
      type: "assistant",
      uuid: "a2",
      session_id: "s1",
      message: {
        id: "m2",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Done" }],
        usage: { input_tokens: 1 },
      },
    } as unknown as ClaudeSdkMessage,
    {
      type: "result",
      subtype: "success",
      session_id: "s1",
      usage: { input_tokens: 1 },
      total_cost_usd: 0,
    } as unknown as ClaudeSdkMessage,
  ];
}

test("Claude: progress reaches the wire at every transition, before the turn commits", async () => {
  const gated = gatedSeam(claudeScript());
  const runtime = new SessionRuntime(new SessionLogStore(true));
  const session = new ClaudeSdkSession("cs", { seam: async () => gated.seam });
  runtime.createSession("cs", session.createRuntimeAdapter());
  const live = viewer(runtime, "cs");
  assert.equal(live.snapshot().progress, undefined, "idle: no progress");

  const run = runtime.prompt("cs", "do it");
  const committedAssistant = () =>
    live
      .events()
      .some(
        (event) =>
          event.type === "timelineDelta" &&
          event.entries.some(
            (entry) => entry.type === "message" && entry.role === "assistant",
          ),
      );

  // 1. The retry the provider reported, before any model output.
  await gated.atGate();
  let latest = live.progress().at(-1)!;
  assert.equal(runProgressPhase(latest), "retrying");
  assert.deepEqual(
    { attempt: latest.retry?.attempt, max: latest.retry?.maxAttempts },
    { attempt: 1, max: 10 },
  );
  assert.equal(latest.retry?.status, 529);
  assert.equal(committedAssistant(), false);
  // A reconnect mid-turn restores the same state from its snapshot.
  const mid = viewer(runtime, "cs");
  assert.equal(mid.snapshot().runState, "running");
  assert.equal(runProgressPhase(mid.snapshot().progress!), "retrying");
  mid.transport.detach();
  gated.release();

  // 2. A tool call's arguments streaming is model output: the wait ends.
  await gated.atGate();
  latest = live.progress().at(-1)!;
  assert.equal(runProgressPhase(latest), "receiving");
  assert.equal(latest.retry, undefined, "output clears the retry");
  assert.ok(latest.lastModelOutputAt !== undefined);
  gated.release();

  // 3. Two tools started; both are running.
  await gated.atGate();
  latest = live.progress().at(-1)!;
  assert.equal(runProgressPhase(latest), "tool");
  assert.deepEqual(
    latest.runningTools.map((tool) => tool.name),
    ["Bash", "Read"],
  );
  assert.equal(committedAssistant(), false, "the turn has not committed");
  gated.release();

  // 4. One finished: the other still shows as running.
  await gated.atGate();
  latest = live.progress().at(-1)!;
  assert.equal(runProgressPhase(latest), "tool");
  assert.deepEqual(
    latest.runningTools.map((tool) => tool.toolCallId),
    [TOOL_B],
  );
  assert.deepEqual(
    { name: latest.lastTool?.name, state: latest.lastTool?.state },
    { name: "Bash", state: "completed" },
  );
  assert.equal(committedAssistant(), false);
  const switched = viewer(runtime, "cs");
  assert.deepEqual(
    switched.snapshot().progress?.runningTools.map((tool) => tool.toolCallId),
    [TOOL_B],
    "a session switch back mid-turn sees the tool still running",
  );
  switched.transport.detach();
  gated.release();

  // 5. Both finished: the results are with the model.
  await gated.atGate();
  latest = live.progress().at(-1)!;
  assert.equal(runProgressPhase(latest), "waiting");
  assert.deepEqual(
    { name: latest.lastTool?.name, state: latest.lastTool?.state },
    { name: "Read", state: "failed" },
  );
  gated.release();

  await run;
  await tick();
  const types = live.events().map((event) => event.type);
  const lastProgress = types.lastIndexOf("runProgress");
  const idle = live
    .events()
    .findIndex(
      (event) => event.type === "runStateChanged" && event.runState === "idle",
    );
  assert.ok(idle > lastProgress, "nothing is published after the run ends");
  const after = viewer(runtime, "cs");
  assert.equal(after.snapshot().runState, "idle");
  assert.equal(after.snapshot().progress, undefined, "settled: no progress");
});

/* ------------------------- runtime, scripted adapter ---------------------- */

class ScriptedAdapter implements PromptableAdapter {
  readonly provider = "scripted";
  readonly capabilities = {
    fork: "none" as const,
    compact: false,
    steer: false,
    attachments: false,
  };
  private listeners = new Set<(event: AdapterEvent) => void>();
  private resolveRun: ((result: AgentRunResult) => void) | undefined;
  prompts = 0;
  subscribe(listener: (event: AdapterEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: AdapterEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  getBinding() {
    return { provider: this.provider, nativeId: "native-1" };
  }
  prompt(): Promise<AgentRunResult> {
    this.prompts += 1;
    return new Promise((resolve) => (this.resolveRun = resolve));
  }
  finish(result: AgentRunResult): void {
    this.resolveRun?.(result);
    this.resolveRun = undefined;
  }
  abort(): void {}
  setModel(): void {}
  setReasoning(): void {}
  dispose(): void {}
}

function scriptedRuntime(id: string) {
  const runtime = new SessionRuntime(new SessionLogStore(true));
  const adapter = new ScriptedAdapter();
  runtime.createSession(id, adapter);
  return { runtime, adapter };
}

test("runtime: progress is ordered after running and before the durable turn", async () => {
  const { runtime, adapter } = scriptedRuntime("r1");
  const order: string[] = [];
  runtime.subscribeEvents((_id, event) => order.push(event.type));
  const run = runtime.prompt("r1", "go");
  adapter.emit({ type: "messageStarted", streamId: "m" });
  adapter.emit({
    type: "messageDelta",
    streamId: "m",
    delta: { kind: "text", text: "hi" },
  });
  adapter.emit({
    type: "messageCompleted",
    streamId: "m",
    content: [{ type: "text", text: "hi" }],
  });
  adapter.emit({ type: "runCompleted", stopReason: "end" });
  adapter.finish({ stopReason: "end" });
  await run;
  const running = order.indexOf("runStateChanged");
  const firstProgress = order.indexOf("runProgress");
  const assistant = order.lastIndexOf("entryAppended");
  assert.ok(running < firstProgress, "running is announced first");
  assert.ok(
    order.indexOf("runProgress", firstProgress + 1) < assistant,
    "the first output publishes before the assistant entry commits",
  );
  assert.equal(runtime.runProgress("r1"), undefined);
});

test("runtime: events from an ended run never revive or corrupt progress", async () => {
  const { runtime, adapter } = scriptedRuntime("r2");
  const published: RunProgress[] = [];
  runtime.subscribeEvents((_id, event) => {
    if (event.type === "runProgress") published.push(event.progress);
  });
  const first = runtime.prompt("r2", "one");
  adapter.emit({
    type: "toolStarted",
    streamId: "old",
    toolCallId: "old",
    name: "bash",
  });
  adapter.emit({
    type: "runCompleted",
    stopReason: "error",
    errorMessage: "boom",
  });
  adapter.finish({ stopReason: "error", errorMessage: "boom" });
  await assert.rejects(first);
  assert.equal(runtime.runProgress("r2"), undefined, "error clears it");

  // Late callbacks of that run, while idle: nothing is tracked or published.
  const before = published.length;
  adapter.emit({ type: "modelActivity" });
  adapter.emit({ type: "providerRetry", attempt: 3 });
  adapter.emit({
    type: "toolCompleted",
    streamId: "old",
    toolCallId: "old",
    content: [],
  });
  assert.equal(published.length, before);
  assert.equal(runtime.runProgress("r2"), undefined);

  // A new run starts clean, and the old tool's completion cannot touch it.
  const second = runtime.prompt("r2", "two");
  const fresh = runtime.runProgress("r2")!;
  assert.deepEqual(fresh.runningTools, []);
  assert.equal(fresh.lastTool, undefined);
  adapter.emit({
    type: "passthrough",
    envelope: {
      type: "toolEnd",
      sessionId: "r2",
      id: "a",
      toolId: "old",
      output: "",
      isError: false,
    } as ServerMessage,
  });
  assert.equal(runtime.runProgress("r2")!.lastTool, undefined);
  adapter.emit({ type: "runCompleted", stopReason: "aborted" });
  adapter.finish({ stopReason: "aborted" });
  await second;
  assert.equal(runtime.runProgress("r2"), undefined, "abort clears it");
});

test("runtime: progress observes only — no prompt, no idle wake", async () => {
  const { runtime, adapter } = scriptedRuntime("r3");
  const idles: string[] = [];
  setSessionIdleHook((id) => idles.push(id));
  try {
    const run = runtime.prompt("r3", "go");
    assert.equal(adapter.prompts, 1);
    for (let i = 0; i < 20; i++) {
      adapter.emit({ type: "modelActivity" });
      adapter.emit({ type: "providerRetry", attempt: i + 1 });
    }
    adapter.emit({
      type: "toolStarted",
      streamId: "t",
      toolCallId: "t",
      name: "bash",
    });
    adapter.emit({ type: "toolUpdated", streamId: "t", output: "x" });
    assert.equal(adapter.prompts, 1, "progress never drives the adapter");
    assert.deepEqual(idles, [], "and never reports the session idle");
    adapter.emit({ type: "runCompleted", stopReason: "end" });
    adapter.finish({ stopReason: "end" });
    await run;
    assert.deepEqual(idles, ["r3"], "only the real end does");
    assert.equal(adapter.prompts, 1);
  } finally {
    setSessionIdleHook(undefined);
  }
});

/* ------------------------------------ pi --------------------------------- */

test("pi: retries and non-text output reach the adapter as progress events", () => {
  let agentListener: ((event: unknown) => void) | undefined;
  const session = {
    sessionId: "pi-progress",
    sessionName: "Named",
    isStreaming: false,
    sessionManager: { getBranch: () => [] },
    settingsManager: {
      getRetrySettings: () => ({}),
      applyOverrides: () => {},
    },
    subscribe: (listener: (event: unknown) => void) => {
      agentListener = listener;
      return () => {};
    },
    getSessionStats: () => ({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      contextSize: 0,
    }),
    abortRetry: () => {},
    prompt: () => Promise.resolve(),
  };
  const host = {
    broadcastSessions: () => Promise.resolve(),
    noteRunStarted: () => {},
    checkPendingReload: () => {},
    isReloadQueued: () => false,
    browserRuntimesFor: () => [],
  };
  const live = new PiLiveSession(
    "coding" as never,
    session as never,
    host as never,
    () => {},
  );
  const events: AdapterEvent[] = [];
  live.subscribeAdapterEvents((event) => events.push(event));
  assert.ok(agentListener, "the live session listens to pi");
  agentListener!({ type: "agent_start" });
  agentListener!({
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_delta", delta: "{" },
  });
  agentListener!({
    type: "message_update",
    assistantMessageEvent: { type: "error", reason: "error" },
  });
  agentListener!({
    type: "auto_retry_start",
    attempt: 2,
    maxAttempts: 5,
    delayMs: 4000,
    errorMessage: "529 Overloaded",
  });
  const kinds = events.map((event) => event.type);
  assert.equal(
    kinds.filter((kind) => kind === "modelActivity").length,
    1,
    "a tool call being written counts; an error event does not",
  );
  const retry = events.find(
    (event): event is Extract<AdapterEvent, { type: "providerRetry" }> =>
      event.type === "providerRetry",
  );
  assert.deepEqual(
    { attempt: retry?.attempt, max: retry?.maxAttempts, delay: retry?.delayMs },
    { attempt: 2, max: 5, delay: 4000 },
  );
  assert.ok(
    kinds.indexOf("providerRetry") < kinds.indexOf("providerNotice"),
    "the transient retry accompanies the existing durable notice",
  );
});
