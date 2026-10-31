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
import { afterAll, test, vi } from "vitest";
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
const { ClaudeSdkSession } = await import("../test/claudeSdkSession.ts");
const { PiLiveSession } = await import("../piSdk/PiLiveSession.ts");
const { localPiEngine } = await import("../piSdk/piEngine.ts");
const { closeDb } = await import("../db/index.ts");
type AdapterEvent = import("./adapters/contract.ts").AdapterEvent;
type AgentRunResult = import("./adapters/contract.ts").AgentRunResult;
type PromptableAdapter = import("./adapters/contract.ts").PromptableAdapter;

/** A fixed title: no automatic naming, so no helper model is ever asked. */
const FIXED_TITLE = "Run progress test";

// Fail closed: nothing in this file may reach a network. The fixture config and
// temp data directory come from `src/test/setup.ts`; this checks they did.
vi.stubGlobal("fetch", () =>
  Promise.reject(new Error("network access is not allowed in this test")),
);
const { DATA_DIR } = await import("../config.ts");
assert.ok(
  DATA_DIR.startsWith(tmpdir()),
  "the data directory is a disposable temp directory",
);

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

/**
 * Yields its script — one per `query()` call, in order — stopping at each
 * {@link GATE} until `release()`.
 */
function gatedSeam(...scripts: Scripted[][]) {
  let queries = 0;
  const gates: (() => void)[] = [];
  let reached: (() => void) | undefined;
  let reachedPromise = new Promise<void>((resolve) => (reached = resolve));
  const seam: ClaudeSdkSeam = {
    query: (_params: ClaudeQueryParams) => {
      const script = scripts[queries++] ?? [];
      return {
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
      };
    },
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
  const session = new ClaudeSdkSession("cs", {
    seam: async () => gated.seam,
    title: FIXED_TITLE,
  });
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

const result = (): ClaudeSdkMessage =>
  ({
    type: "result",
    subtype: "success",
    session_id: "s1",
    usage: { input_tokens: 1 },
    total_cost_usd: 0,
  }) as unknown as ClaudeSdkMessage;

const assistantText = (id: string, text: string): ClaudeSdkMessage =>
  ({
    type: "assistant",
    uuid: `a-${id}`,
    session_id: "s1",
    message: {
      id,
      model: "claude-sonnet-4-6",
      content: text ? [{ type: "text", text }] : [],
      usage: { input_tokens: 1 },
    },
  }) as unknown as ClaudeSdkMessage;

const apiRetry = (attempt: number): ClaudeSdkMessage =>
  ({
    type: "system",
    subtype: "api_retry",
    attempt,
    max_retries: 10,
    retry_delay_ms: 500,
    error_status: 529,
    error: "overloaded",
    uuid: `r${attempt}`,
    session_id: "s1",
  }) as unknown as ClaudeSdkMessage;

/** A response that streams no content: only its lifecycle and usage. */
const emptyResponse = (id: string): ClaudeSdkMessage[] => [
  stream({ type: "message_start", message: { id, content: [] } }),
  stream({
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 0 },
  }),
  stream({ type: "message_stop" }),
];

test("Claude: an empty response's metadata is not output, and does not reset real output", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(5_000_000);
    const gated = gatedSeam([
      apiRetry(1),
      GATE, // 1: retrying
      ...emptyResponse("m1"),
      GATE, // 2: the provider answered with nothing
      stream({ type: "message_start", message: { id: "m2" } }),
      stream({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      stream({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hi" },
      }),
      GATE, // 3: real output
      stream({ type: "content_block_stop", index: 0 }),
      stream({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      }),
      stream({ type: "message_stop" }),
      GATE, // 4: only metadata since
      assistantText("m2", "Hi"),
      result(),
    ]);
    const runtime = new SessionRuntime(new SessionLogStore(true));
    const session = new ClaudeSdkSession("ce", {
      seam: async () => gated.seam,
      title: FIXED_TITLE,
    });
    runtime.createSession("ce", session.createRuntimeAdapter());
    const live = viewer(runtime, "ce");
    const run = runtime.prompt("ce", "go");

    await gated.atGate();
    assert.equal(runProgressPhase(runtime.runProgress("ce")!), "retrying");
    vi.setSystemTime(5_010_000);
    gated.release();

    await gated.atGate();
    let progress = runtime.runProgress("ce")!;
    assert.equal(progress.retry, undefined, "the response ended the retry");
    assert.equal(runProgressPhase(progress), "waiting", "but it said nothing");
    assert.equal(progress.awaitingModelSince, 5_000_000);
    assert.equal(progress.lastModelOutputAt, undefined);
    assert.equal(progress.lastActivityAt, 5_010_000, "the provider is alive");
    // What a viewer receives says the same.
    assert.equal(
      runProgressPhase(live.progress().at(-1)!),
      "waiting",
      "the published progress claims no output",
    );
    vi.setSystemTime(5_020_000);
    gated.release();

    await gated.atGate();
    progress = runtime.runProgress("ce")!;
    assert.equal(runProgressPhase(progress), "receiving");
    assert.equal(progress.lastModelOutputAt, 5_020_000);
    vi.setSystemTime(5_030_000);
    gated.release();

    await gated.atGate();
    progress = runtime.runProgress("ce")!;
    assert.equal(
      progress.lastModelOutputAt,
      5_020_000,
      "stop and usage metadata leave the last output where it was",
    );
    assert.equal(progress.lastActivityAt, 5_030_000);
    gated.release();
    await run;
  } finally {
    vi.useRealTimers();
  }
});

test("Claude: a closing epoch's late messages never reach the next turn", async () => {
  const LATE_TEXT = "LATE-OLD-TEXT";
  const LATE_MODEL = "claude-opus-4-6";
  const gated = gatedSeam(
    [
      stream({ type: "message_start", message: { id: "m1" } }),
      stream({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "one" },
      }),
      assistantText("m1", "one"),
      result(),
      GATE, // 1: turn one is over; its process has not exited yet
      { ...apiRetry(9), session_id: "s-old" } as ClaudeSdkMessage,
      {
        ...stream({ type: "message_start", message: { id: "m-late" } }),
        session_id: "s-old",
      } as ClaudeSdkMessage,
      stream({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      stream({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: LATE_TEXT },
      }),
      stream({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "old-tool", name: "Bash" },
      }),
      stream({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"command":' },
      }),
      ...emptyResponse("m-late"),
      {
        type: "assistant",
        uuid: "a-late",
        session_id: "s-old",
        message: {
          id: "m-late",
          model: LATE_MODEL,
          content: [
            { type: "text", text: LATE_TEXT },
            {
              type: "tool_use",
              id: "old-tool",
              name: "Bash",
              input: { command: "old-command" },
            },
          ],
          usage: { input_tokens: 1 },
        },
      } as unknown as ClaudeSdkMessage,
      {
        type: "user",
        uuid: "u-late",
        session_id: "s-old",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "old-tool",
              content: "old output",
              is_error: false,
            },
          ],
        },
      } as unknown as ClaudeSdkMessage,
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: "s-old",
        usage: { input_tokens: 1 },
        total_cost_usd: 0,
      } as unknown as ClaudeSdkMessage,
    ],
    [
      GATE, // 2: turn two's own query, before it says anything
      apiRetry(1),
      stream({ type: "message_start", message: { id: "m2" } }),
      stream({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "two" },
      }),
      GATE, // 3: turn two's own output
      assistantText("m2", "two"),
      result(),
    ],
  );
  const runtime = new SessionRuntime(new SessionLogStore(true));
  const session = new ClaudeSdkSession("cl", {
    seam: async () => gated.seam,
    title: FIXED_TITLE,
  });
  runtime.createSession("cl", session.createRuntimeAdapter());
  await runtime.prompt("cl", "one");
  await gated.atGate();

  const second = runtime.prompt("cl", "two");
  await tick();
  const fresh = stateOf(runtime, "cl")!;
  assert.equal(runProgressPhase(runtime.runProgress("cl")!), "waiting");
  gated.release(); // the old epoch delivers everything it still had

  await gated.atGate();
  const leaked = (value: unknown) => {
    const text = JSON.stringify(value);
    return (
      text.includes(LATE_TEXT) ||
      text.includes("old-tool") ||
      text.includes("old-command") ||
      text.includes(LATE_MODEL) ||
      text.includes("a-late")
    );
  };
  const mid = runtime.get("cl")!.getSnapshot();
  assert.equal(mid.runState, "running");
  assert.equal(leaked(mid.streaming), false, "no old text or tool goes live");
  assert.ok(
    !mid.streaming.some((stream) => stream.kind === "tool"),
    "no old tool runs in the new turn",
  );
  assert.deepEqual(
    stateOf(runtime, "cl"),
    fresh,
    "no retry, output, tool or activity from the old epoch",
  );
  // Nor did the old epoch move what turn two will be anchored to.
  const native = session as unknown as {
    pendingNativeMessageId?: string;
    providerSessionId?: string;
  };
  assert.notEqual(native.pendingNativeMessageId, "a-late");
  assert.notEqual(native.providerSessionId, "s-old");
  // A viewer joining now sees the same clean turn.
  const joiner = viewer(runtime, "cl");
  assert.equal(leaked(joiner.snapshot().streaming), false);
  joiner.transport.detach();
  gated.release();

  await gated.atGate();
  const own = runtime.runProgress("cl")!;
  assert.equal(runProgressPhase(own), "receiving", "turn two's output counts");
  assert.equal(own.retry, undefined);
  assert.deepEqual(own.runningTools, []);
  const live = runtime.get("cl")!.getSnapshot().streaming;
  assert.ok(JSON.stringify(live).includes("two"), "turn two streams its own");
  assert.equal(leaked(live), false);
  gated.release();

  // The old epoch's error result did not fail turn two.
  await second;
  const entries = runtime.get("cl")!.getSnapshot().entries;
  assert.equal(leaked(entries), false, "nothing old became durable");
  const assistants = entries.filter(
    (entry) => entry.type === "message" && entry.role === "assistant",
  );
  const turnTwo = assistants.at(-1)!;
  assert.ok(turnTwo.type === "message");
  assert.deepEqual(
    turnTwo.content,
    [{ type: "text", text: "two" }],
    "turn two's durable content is its own",
  );
  assert.equal(
    (turnTwo as { error?: string }).error,
    undefined,
    "and carries no old failure",
  );
  assert.ok(
    !entries.some(
      (entry) =>
        entry.type === "message" &&
        entry.role === "toolResult" &&
        entry.toolCallId === "old-tool",
    ),
  );
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
  adapter.emit({ type: "messageStarted", streamId: "m", run: 1 });
  adapter.emit({
    type: "messageDelta",
    streamId: "m",
    delta: { kind: "text", text: "hi" },
    run: 1,
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

/** Every progress-moving event a harness can emit, all claiming `run`. */
function everyEventOf(run: number | undefined, tag: string): AdapterEvent[] {
  const r = run === undefined ? {} : { run };
  return [
    {
      type: "messageDelta",
      streamId: `m-${tag}`,
      delta: { kind: "text", text: "late" },
      ...r,
    },
    {
      type: "messageDelta",
      streamId: `m-${tag}`,
      delta: { kind: "thinking", text: "late" },
      ...r,
    },
    ...(run === undefined
      ? []
      : ([
          { type: "providerActivity", kind: "output", run },
          { type: "providerActivity", kind: "response", run },
          { type: "providerActivity", kind: "lifecycle", run },
          {
            type: "providerRetry",
            attempt: 9,
            maxAttempts: 10,
            status: 529,
            run,
          },
        ] as AdapterEvent[])),
    {
      type: "toolStarted",
      streamId: `t-${tag}`,
      toolCallId: `t-${tag}`,
      name: "Bash",
      ...r,
    },
    { type: "toolUpdated", streamId: `t-${tag}`, output: "x", ...r },
    {
      type: "passthrough",
      envelope: {
        type: "toolEnd",
        sessionId: "s",
        id: `m-${tag}`,
        toolId: `t-${tag}`,
        output: "",
        isError: true,
      } as ServerMessage,
      ...r,
    },
    {
      type: "toolCompleted",
      streamId: `t-${tag}`,
      toolCallId: `t-${tag}`,
      content: [],
      isError: true,
      ...r,
    },
  ];
}

/** Progress as a reader sees it, without the publish stamp. */
function stateOf(runtime: InstanceType<typeof SessionRuntime>, id: string) {
  const progress = runtime.runProgress(id);
  if (!progress) return undefined;
  const { observedAt: _observedAt, ...rest } = progress;
  return rest;
}

test("runtime: an earlier run's late events cannot touch the current run, whose own events still count", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(1_000_000);
    const { runtime, adapter } = scriptedRuntime("r2");
    const published: RunProgress[] = [];
    runtime.subscribeEvents((_id, event) => {
      if (event.type === "runProgress") published.push(event.progress);
    });

    // Run 1: output, a tool still running, and a coalesced publish pending
    // when it ends.
    const first = runtime.prompt("r2", "one");
    adapter.emit({ type: "messageStarted", streamId: "m-1", run: 1 });
    adapter.emit({
      type: "toolStarted",
      streamId: "t-open",
      toolCallId: "t-open",
      name: "Bash",
      run: 1,
    });
    adapter.emit({ type: "providerActivity", kind: "output", run: 1 });
    vi.advanceTimersByTime(100);
    adapter.emit({ type: "providerActivity", kind: "output", run: 1 });
    adapter.emit({ type: "runCompleted", stopReason: "end" });
    adapter.finish({ stopReason: "end" });
    await first;

    // Run 2 starts; its provider has not announced itself yet.
    vi.setSystemTime(2_000_000);
    const second = runtime.prompt("r2", "two");
    const fresh = stateOf(runtime, "r2");
    assert.deepEqual(fresh, {
      startedAt: 2_000_000,
      lastActivityAt: 2_000_000,
      awaitingModelSince: 2_000_000,
      runningTools: [],
    });
    const freshPublishes = published.length;
    vi.advanceTimersByTime(10_000);
    assert.equal(
      published.length,
      freshPublishes,
      "run 1's pending publish died with it",
    );

    // Everything run 1 could still say — and anything carrying no run.
    vi.setSystemTime(2_005_000);
    for (const event of [
      ...everyEventOf(1, "1"),
      ...everyEventOf(undefined, "x"),
    ])
      adapter.emit(event);
    adapter.emit({
      type: "passthrough",
      envelope: {
        type: "toolEnd",
        sessionId: "s",
        id: "m-1",
        toolId: "t-open",
        output: "",
        isError: false,
      } as ServerMessage,
      run: 1,
    });
    assert.deepEqual(stateOf(runtime, "r2"), fresh, "before run 2 announced");

    // Run 2 announces itself; run 1 still cannot reach it, nor rebind it.
    adapter.emit({ type: "messageStarted", streamId: "m-2", run: 2 });
    adapter.emit({ type: "messageStarted", streamId: "m-1b", run: 1 });
    for (const event of everyEventOf(1, "1b")) adapter.emit(event);
    assert.deepEqual(stateOf(runtime, "r2"), fresh, "after run 2 announced");

    // Run 2's own events: retry, a response with no content, metadata, empty
    // deltas — none of them output.
    vi.setSystemTime(2_010_000);
    adapter.emit({
      type: "providerRetry",
      attempt: 1,
      maxAttempts: 10,
      run: 2,
    });
    assert.equal(stateOf(runtime, "r2")?.retry?.attempt, 1);
    vi.setSystemTime(2_011_000);
    adapter.emit({ type: "providerActivity", kind: "response", run: 2 });
    adapter.emit({ type: "providerActivity", kind: "lifecycle", run: 2 });
    adapter.emit({
      type: "messageDelta",
      streamId: "m-2",
      delta: { kind: "text", text: "" },
      run: 2,
    });
    let state = stateOf(runtime, "r2")!;
    assert.equal(state.retry, undefined, "the provider answered");
    assert.equal(state.awaitingModelSince, 2_000_000, "still no output");
    assert.equal(state.lastModelOutputAt, undefined);
    assert.equal(state.lastActivityAt, 2_011_000);

    // Real output, then parallel tools.
    vi.setSystemTime(2_012_000);
    adapter.emit({ type: "providerActivity", kind: "output", run: 2 });
    for (const id of ["a", "b"])
      adapter.emit({
        type: "toolStarted",
        streamId: id,
        toolCallId: id,
        name: id === "a" ? "Bash" : "Read",
        run: 2,
      });
    for (const event of everyEventOf(1, "1c")) adapter.emit(event);
    adapter.emit({
      type: "passthrough",
      envelope: {
        type: "toolEnd",
        sessionId: "s",
        id: "m-2",
        toolId: "a",
        output: "",
        isError: false,
      } as ServerMessage,
      run: 2,
    });
    state = stateOf(runtime, "r2")!;
    assert.deepEqual(
      state.runningTools.map((tool) => tool.toolCallId),
      ["b"],
      "b still runs; run 1's Bash never joined",
    );
    assert.equal(state.lastModelOutputAt, 2_012_000);
    adapter.emit({
      type: "toolCompleted",
      streamId: "b",
      toolCallId: "b",
      content: [],
      run: 2,
    });
    state = stateOf(runtime, "r2")!;
    assert.deepEqual(state.runningTools, []);
    assert.equal(state.awaitingModelSince, 2_012_000);
    assert.deepEqual(state.lastTool, {
      name: "Read",
      state: "completed",
      at: 2_012_000,
    });

    adapter.emit({ type: "runCompleted", stopReason: "aborted" });
    adapter.finish({ stopReason: "aborted" });
    await second;
    assert.equal(runtime.runProgress("r2"), undefined, "abort clears it");
    for (const event of everyEventOf(2, "late"))
      if (event.type !== "toolStarted") adapter.emit(event);
    assert.equal(runtime.runProgress("r2"), undefined, "nothing revives it");
    // A tool starting while idle is the runtime's out-of-band turn: it runs
    // again, with fresh progress that the ended run still cannot reach.
    vi.setSystemTime(3_000_000);
    for (const event of everyEventOf(2, "late2")) adapter.emit(event);
    assert.deepEqual(stateOf(runtime, "r2"), {
      startedAt: 3_000_000,
      lastActivityAt: 3_000_000,
      awaitingModelSince: 3_000_000,
      runningTools: [],
    });
  } finally {
    vi.useRealTimers();
  }
});

test("runtime: an error ends progress, and the next run starts clean", async () => {
  const { runtime, adapter } = scriptedRuntime("r4");
  const first = runtime.prompt("r4", "one");
  adapter.emit({ type: "messageStarted", streamId: "m", run: 1 });
  adapter.emit({
    type: "toolStarted",
    streamId: "t",
    toolCallId: "t",
    name: "bash",
    run: 1,
  });
  adapter.emit({
    type: "runCompleted",
    stopReason: "error",
    errorMessage: "boom",
  });
  adapter.finish({ stopReason: "error", errorMessage: "boom" });
  await assert.rejects(first);
  assert.equal(runtime.runProgress("r4"), undefined, "error clears it");
  const second = runtime.prompt("r4", "two");
  assert.deepEqual(runtime.runProgress("r4")!.runningTools, []);
  adapter.emit({ type: "runCompleted", stopReason: "end" });
  adapter.finish({ stopReason: "end" });
  await second;
});

test("runtime: progress observes only — no prompt, no idle wake", async () => {
  const { runtime, adapter } = scriptedRuntime("r3");
  const idles: string[] = [];
  setSessionIdleHook((id) => idles.push(id));
  try {
    const run = runtime.prompt("r3", "go");
    assert.equal(adapter.prompts, 1);
    adapter.emit({ type: "messageStarted", streamId: "m", run: 1 });
    for (let i = 0; i < 20; i++) {
      adapter.emit({ type: "providerActivity", kind: "output", run: 1 });
      adapter.emit({ type: "providerRetry", attempt: i + 1, run: 1 });
    }
    adapter.emit({
      type: "toolStarted",
      streamId: "t",
      toolCallId: "t",
      name: "bash",
      run: 1,
    });
    adapter.emit({ type: "toolUpdated", streamId: "t", output: "x", run: 1 });
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

function piHarness(sessionId: string) {
  let agentListener: ((event: unknown) => void) | undefined;
  const session = {
    sessionId,
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
    buildSessionState: () => ({}) as never,
  };
  const live = new PiLiveSession(
    "coding" as never,
    localPiEngine(session as never),
    host as never,
    () => {},
  );
  const events: AdapterEvent[] = [];
  live.subscribeAdapterEvents((event) => events.push(event));
  assert.ok(agentListener, "the live session listens to pi");
  return { live, events, pi: (event: unknown) => agentListener!(event) };
}

const piUpdate = (type: string, extra: Record<string, unknown> = {}) => ({
  type: "message_update",
  assistantMessageEvent: { type, ...extra },
});

test("pi: activity is classified, and only output counts as output", () => {
  const { events, pi } = piHarness("pi-progress");
  pi({ type: "agent_start" });
  const started = events.find((event) => event.type === "messageStarted");
  assert.ok(started?.type === "messageStarted" && started.run === 1);
  pi(piUpdate("start"));
  pi(piUpdate("text_start"));
  pi(piUpdate("toolcall_start"));
  pi(piUpdate("toolcall_delta", { delta: "{" }));
  pi(piUpdate("toolcall_end"));
  pi(piUpdate("done"));
  pi(piUpdate("error", { reason: "error" }));
  pi({
    type: "auto_retry_start",
    attempt: 2,
    maxAttempts: 5,
    delayMs: 4000,
    errorMessage: "529 Overloaded",
  });
  const kinds = events.flatMap((event) =>
    event.type === "providerActivity" ? [event.kind] : [],
  );
  assert.deepEqual(kinds, [
    "response",
    "lifecycle",
    "output",
    "output",
    "lifecycle",
    "lifecycle",
  ]);
  const retry = events.find(
    (event): event is Extract<AdapterEvent, { type: "providerRetry" }> =>
      event.type === "providerRetry",
  );
  assert.deepEqual(
    {
      attempt: retry?.attempt,
      max: retry?.maxAttempts,
      delay: retry?.delayMs,
      run: retry?.run,
    },
    { attempt: 2, max: 5, delay: 4000, run: 1 },
  );
  const types = events.map((event) => event.type);
  assert.ok(
    types.indexOf("providerRetry") < types.indexOf("providerNotice"),
    "the transient retry accompanies the existing durable notice",
  );
});

test("pi: a retry continues its run; what pi says after a run settles belongs to none", () => {
  const { events, pi } = piHarness("pi-runs");
  pi({ type: "agent_start" });
  pi({ type: "agent_end", willRetry: true });
  pi({
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 10,
    errorMessage: "529 Overloaded",
  });
  pi({ type: "agent_start" });
  pi({ type: "agent_settled" });
  const runsSoFar = events.flatMap((event) =>
    "run" in event && event.run !== undefined ? [event.run] : [],
  );
  assert.ok(runsSoFar.length > 0);
  assert.ok(
    runsSoFar.every((run) => run === 1),
    "the retry and its second attempt are run 1",
  );

  // Settled: a late retry report or output belongs to no run at all.
  const before = events.length;
  pi({
    type: "auto_retry_start",
    attempt: 2,
    maxAttempts: 3,
    delayMs: 10,
    errorMessage: "529 Overloaded",
  });
  pi(piUpdate("toolcall_delta", { delta: "{" }));
  assert.ok(
    events
      .slice(before)
      .every(
        (event) =>
          event.type !== "providerRetry" && event.type !== "providerActivity",
      ),
  );

  pi({ type: "agent_start" });
  const next = events
    .slice(before)
    .find((event) => event.type === "messageStarted");
  assert.ok(next?.type === "messageStarted" && next.run === 2);
});
