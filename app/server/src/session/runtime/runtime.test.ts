/**
 * Unit test for the session runtime. Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/session/runtime/runtime.test.ts
 *
 * Driven by a scripted fake adapter so no provider/model/dev-server is involved.
 * Covers: prompt run-state gating, clientRequestId no-op (during a run AND a
 * second time), transient stream accumulation + drop on completion, durable
 * entryAppended, failed-run throw + stream cleanup + runStatus, subscriber
 * isolation, and race-safe reconnect snapshots.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "runtime-test-"));
process.env.ASSISTANT_CWD = tmp;

const { SessionRuntime } = await import("./runtime.ts");
const {
  subscribeSessionRunCompleted,
  subscribeSessionRunStarted,
  subscribeSessionToolCompleted,
} = await import("./liveSession.ts");
const { SessionBusyError, RunFailedError, InactiveSessionError } =
  await import("./errors.ts");
const { SessionLogStore } = await import("../log/store.ts");
await import("../adapters/contract.ts");
type AdapterEvent = import("../adapters/contract.ts").AdapterEvent;
type AgentRunResult = import("../adapters/contract.ts").AgentRunResult;
type PromptableAdapter = import("../adapters/contract.ts").PromptableAdapter;

/** A scripted adapter: tests emit events and resolve the in-flight run by hand. */
class ScriptedAdapter implements PromptableAdapter {
  readonly provider = "scripted";
  readonly capabilities: import("../adapters/contract.ts").ForkCapability = {
    fork: "none",
    compact: false,
    steer: false,
    attachments: true,
  };
  private listeners = new Set<(e: AdapterEvent) => void>();
  private resolveRun: ((r: AgentRunResult) => void) | undefined;
  promptCount = 0;
  aborted = 0;
  disposed = false;
  lastPromptOptions:
    import("../adapters/contract.ts").PromptOptions | undefined;
  lastPromptText: string | undefined;
  model: { provider: string; id: string } | undefined;
  reasoning: string | undefined;

  subscribe(listener: (e: AdapterEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: AdapterEvent): void {
    for (const l of this.listeners) l(event);
  }
  getBinding() {
    return { provider: this.provider, nativeId: "native-1" };
  }
  prompt(
    text: string,
    options?: import("../adapters/contract.ts").PromptOptions,
  ): Promise<AgentRunResult> {
    this.promptCount++;
    this.lastPromptText = text;
    this.lastPromptOptions = options;
    if (options?.steer) return Promise.resolve({ stopReason: "end" });
    return new Promise<AgentRunResult>((resolve) => {
      this.resolveRun = resolve;
    });
  }
  /** Resolve the pending run() promise. */
  finishRun(result: AgentRunResult): void {
    this.resolveRun?.(result);
    this.resolveRun = undefined;
  }
  abort(): void {
    this.aborted++;
  }
  setModel(model: { provider: string; id: string }): void {
    this.model = model;
  }
  setReasoning(level: string): void {
    this.reasoning = level;
  }
  async listModels() {
    return [{ provider: "scripted", id: "m1" }];
  }
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

function makeRuntime() {
  const runtime = new SessionRuntime(new SessionLogStore(true));
  const adapter = new ScriptedAdapter();
  runtime.createSession("s1", adapter);
  return { runtime, adapter };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/* ---------------------- run gate + idempotency --------------------------- */
{
  const { runtime, adapter } = makeRuntime();
  const events: string[] = [];
  const runtimeEvents: string[] = [];
  const unsubscribeRuntimeEvents = runtime.subscribeEvents((sessionId, event) =>
    runtimeEvents.push(`${sessionId}:${event.type}`),
  );
  const { snapshot, unsubscribe } = runtime.openSessionStream("s1", (e) =>
    events.push(e.type),
  );
  assert.equal(snapshot.runState, "idle", "fresh session is idle");

  const run = runtime.prompt("s1", "hi", { clientRequestId: "r1" });
  await tick();
  assert.equal(
    runtime.isRunning("s1"),
    true,
    "session is running after prompt",
  );
  assert.equal(adapter.promptCount, 1, "adapter.prompt called once");

  // Duplicate clientRequestId DURING the run → no-op (not busy, not a 2nd prompt).
  await runtime.prompt("s1", "hi again", { clientRequestId: "r1" });
  assert.equal(
    adapter.promptCount,
    1,
    "duplicate clientRequestId during run is a no-op",
  );

  // A DIFFERENT prompt during the run → busy.
  await assert.rejects(
    () => runtime.prompt("s1", "other"),
    SessionBusyError,
    "concurrent prompt rejects busy",
  );

  adapter.finishRun({ stopReason: "end" });
  await run;
  assert.equal(runtime.isRunning("s1"), false, "session idle after run ends");

  // Same clientRequestId AGAIN after the run → still a no-op.
  await runtime.prompt("s1", "hi once more", { clientRequestId: "r1" });
  assert.equal(
    adapter.promptCount,
    1,
    "repeat clientRequestId after run is still a no-op",
  );

  assert.ok(events.includes("runStateChanged"), "runStateChanged emitted");
  assert.ok(events.includes("entryAppended"), "user entryAppended emitted");
  assert.ok(
    runtimeEvents.includes("s1:runStateChanged"),
    "runtime-level event feed tags run-state changes by session",
  );
  unsubscribe();
  unsubscribeRuntimeEvents();
}

/* -------------- observed out-of-band adapter work drives state ----------- */
{
  const { runtime, adapter } = makeRuntime();
  const events: string[] = [];
  runtime.openSessionStream("s1", (e) => events.push(e.type));

  adapter.emit({ type: "messageStarted", streamId: "external-a" });
  assert.equal(
    runtime.isRunning("s1"),
    true,
    "observed external message start marks the runtime running",
  );
  adapter.emit({
    type: "messageDelta",
    streamId: "external-a",
    delta: { kind: "text", text: "outside" },
  });
  adapter.emit({
    type: "messageCompleted",
    streamId: "external-a",
    content: [{ type: "text", text: "outside" }],
  });
  adapter.emit({ type: "runCompleted", stopReason: "end" });

  assert.equal(
    runtime.isRunning("s1"),
    false,
    "observed external run completion marks the runtime idle",
  );
  assert.equal(
    runtime
      .get("s1")!
      .getSnapshot()
      .entries.filter((e) => e.role === "assistant").length,
    1,
    "observed assistant output is durable",
  );
  assert.equal(
    events.filter((e) => e === "runStateChanged").length,
    2,
    "external observed run emitted running and idle transitions",
  );
}

/* -------- observed host-command turns settle without runCompleted -------- */
{
  const { runtime, adapter } = makeRuntime();
  const events: string[] = [];
  runtime.openSessionStream("s1", (e) => events.push(e.type));

  adapter.emit({ type: "messageStarted", streamId: "synthetic-a" });
  adapter.emit({
    type: "toolStarted",
    streamId: "synthetic-tool",
    toolCallId: "synthetic-tool",
    name: "/commit",
    input: { command: "/commit" },
  });
  assert.equal(
    runtime.isRunning("s1"),
    true,
    "observed synthetic host command marks the runtime running",
  );
  adapter.emit({
    type: "hostCommandResult",
    name: "commit",
    card: {
      kind: "commit",
      id: "synthetic-a",
      commit: { renderKind: "commit" } as never,
    },
  });

  assert.equal(
    runtime.isRunning("s1"),
    false,
    "host-command result marks the runtime idle without runCompleted",
  );
  assert.equal(
    runtime.get("s1")!.getSnapshot().streaming.length,
    0,
    "host-command result clears synthetic streams",
  );
  assert.ok(
    runtime
      .get("s1")!
      .clientTimeline()
      .some((e) => e.type === "command.result"),
    "host-command card is durable",
  );
  assert.equal(
    events.filter((e) => e === "runStateChanged").length,
    2,
    "host-command emitted running and idle transitions",
  );

  let nextRunStarts = 0;
  const unsubscribeStarted = subscribeSessionRunStarted((sessionId) => {
    if (sessionId === "s1") nextRunStarts++;
  });
  const next = runtime.prompt("s1", "after host command");
  assert.equal(
    nextRunStarts,
    1,
    "the provider turn after a host command opens a fresh boundary",
  );
  adapter.emit({ type: "runCompleted", stopReason: "end" });
  adapter.finishRun({ stopReason: "end" });
  await next;
  unsubscribeStarted();
}

/* ---------------- skipped host-command turns leave no durable row -------- */
{
  const { runtime, adapter } = makeRuntime();
  adapter.emit({ type: "messageStarted", streamId: "synthetic-skip" });
  adapter.emit({
    type: "toolStarted",
    streamId: "synthetic-skip-tool",
    toolCallId: "synthetic-skip-tool",
    name: "/push",
    input: {},
  });
  adapter.emit({ type: "hostCommandDiscarded" });
  assert.equal(runtime.isRunning("s1"), false);
  assert.equal(runtime.get("s1")!.getSnapshot().streaming.length, 0);
  assert.equal(runtime.get("s1")!.clientTimeline().length, 0);

  let nextRunStarts = 0;
  const unsubscribeStarted = subscribeSessionRunStarted((sessionId) => {
    if (sessionId === "s1") nextRunStarts++;
  });
  const next = runtime.prompt("s1", "after skipped host command");
  assert.equal(
    nextRunStarts,
    1,
    "the provider turn after a skipped host command opens a fresh boundary",
  );
  adapter.emit({ type: "runCompleted", stopReason: "end" });
  adapter.finishRun({ stopReason: "end" });
  await next;
  unsubscribeStarted();
}

/* ------------------------ steering during a run -------------------------- */
{
  const { runtime, adapter } = makeRuntime();
  adapter.capabilities.steer = true;
  const run = runtime.prompt("s1", "main");
  await tick();
  assert.equal(
    runtime.isRunning("s1"),
    true,
    "main prompt is running before steer",
  );

  await runtime.prompt("s1", "follow-up", {
    steer: true,
    origin: { kind: "system", source: "test-steer" },
  });
  assert.equal(
    runtime.isRunning("s1"),
    true,
    "steering does not settle the active run",
  );
  assert.equal(
    adapter.promptCount,
    2,
    "steering reached the adapter as a second prompt",
  );
  assert.equal(
    adapter.lastPromptOptions?.steer,
    true,
    "steer flag forwarded to the adapter",
  );
  assert.equal(
    runtime
      .get("s1")!
      .getSnapshot()
      .entries.filter((e) => e.role === "user").length,
    2,
    "steering prompt is durable",
  );

  adapter.finishRun({ stopReason: "end" });
  await run;
  assert.equal(
    runtime.isRunning("s1"),
    false,
    "main run completion still controls run-state",
  );
}

/* --------------- stream accumulation + durable handover ------------------ */
{
  const { runtime, adapter } = makeRuntime();
  const seen: string[] = [];
  runtime.openSessionStream("s1", (e) => seen.push(e.type));
  const run = runtime.prompt("s1", "go", { clientRequestId: "rr" });
  await tick();

  adapter.emit({ type: "messageStarted", streamId: "m1" });
  adapter.emit({
    type: "messageDelta",
    streamId: "m1",
    delta: { kind: "text", text: "Hel" },
  });
  adapter.emit({
    type: "messageDelta",
    streamId: "m1",
    delta: { kind: "text", text: "lo" },
  });

  let snap = runtime.get("s1")!.getSnapshot();
  assert.equal(
    snap.streaming.length,
    1,
    "one in-flight stream while generating",
  );
  const live = snap.streaming[0];
  assert.ok(
    live &&
      live.kind === "message" &&
      live.content[0]?.type === "text" &&
      live.content[0].text === "Hello",
    "deltas accumulate into the stream",
  );

  adapter.emit({
    type: "messageCompleted",
    streamId: "m1",
    content: [{ type: "text", text: "Hello" }],
    model: "opus",
  });
  snap = runtime.get("s1")!.getSnapshot();
  assert.equal(snap.streaming.length, 0, "stream dropped once finalized");
  assert.equal(
    snap.entries.filter((e) => e.role === "assistant").length,
    1,
    "assistant entry is now durable",
  );
  // messageCompleted is emitted BEFORE the durable entryAppended replacement.
  assert.ok(
    seen.indexOf("messageCompleted") < seen.lastIndexOf("entryAppended"),
    "stream removed before durable replacement",
  );

  // A tool round-trip produces a separate durable toolResult entry.
  adapter.emit({
    type: "toolStarted",
    streamId: "t1",
    toolCallId: "tc1",
    name: "bash",
    input: { cmd: "ls" },
  });
  adapter.emit({ type: "toolUpdated", streamId: "t1", output: "fi" });
  adapter.emit({
    type: "toolCompleted",
    streamId: "t1",
    toolCallId: "tc1",
    toolName: "bash",
    content: [{ type: "text", text: "file.txt" }],
  });
  snap = runtime.get("s1")!.getSnapshot();
  assert.equal(snap.streaming.length, 0, "tool stream dropped on completion");
  assert.equal(
    snap.entries.filter((e) => e.role === "toolResult").length,
    1,
    "durable toolResult entry appended",
  );

  adapter.finishRun({ stopReason: "end" });
  await run;
}

/* ------ live toolEnd survives snapshots before durable toolResult flush --- */
{
  const { runtime, adapter } = makeRuntime();
  const toolCompletions: string[] = [];
  const unsubscribeToolCompleted = subscribeSessionToolCompleted((sessionId) =>
    toolCompletions.push(sessionId),
  );
  const run = runtime.prompt("s1", "tool then more text");
  await tick();

  adapter.emit({ type: "messageStarted", streamId: "m1" });
  adapter.emit({
    type: "toolStarted",
    streamId: "tc1",
    toolCallId: "tc1",
    name: "read",
    input: { path: "x" },
  });
  adapter.emit({
    type: "passthrough",
    envelope: {
      type: "toolEnd",
      sessionId: "s1",
      id: "m1",
      toolId: "tc1",
      output: "done output",
      isError: false,
    },
  });

  const midTurnSnapshot = runtime.openSessionStream(
    "s1",
    () => undefined,
  ).snapshot;
  const toolStream = midTurnSnapshot.streaming.find(
    (s) => s.kind === "tool" && s.toolCallId === "tc1",
  );
  assert.ok(
    toolStream && toolStream.kind === "tool",
    "snapshot still carries the not-yet-durable tool stream",
  );
  assert.equal(
    toolStream.done,
    true,
    "snapshot preserves live toolEnd completion before durable toolResult flush",
  );
  assert.equal(
    toolStream.output,
    "done output",
    "snapshot preserves live tool output before durable toolResult flush",
  );
  assert.deepEqual(
    toolCompletions,
    ["s1"],
    "a live toolEnd signals the session's finished tool call once",
  );
  unsubscribeToolCompleted();

  adapter.emit({
    type: "messageDelta",
    streamId: "m1",
    delta: { kind: "text", text: "continuing" },
  });
  adapter.emit({
    type: "messageCompleted",
    streamId: "m1",
    content: [
      {
        type: "toolCall",
        toolCallId: "tc1",
        name: "read",
        input: { path: "x" },
      },
      { type: "text", text: "continuing" },
    ],
  });
  adapter.emit({
    type: "toolCompleted",
    streamId: "tc1",
    toolCallId: "tc1",
    toolName: "read",
    content: [{ type: "text", text: "done output" }],
  });
  adapter.finishRun({ stopReason: "end" });
  await run;
}

/* ---------------------- failed run: throw + cleanup ---------------------- */
{
  const { runtime, adapter } = makeRuntime();
  const statuses: string[] = [];
  runtime.openSessionStream("s1", (e) => {
    if (e.type === "runStatus") statuses.push(e.status);
  });
  const run = runtime.prompt("s1", "boom");
  await tick();
  adapter.emit({ type: "messageStarted", streamId: "m1" }); // a dangling stream
  adapter.emit({
    type: "runCompleted",
    stopReason: "error",
    errorMessage: "kaboom",
  });
  adapter.finishRun({ stopReason: "error", errorMessage: "kaboom" });

  await assert.rejects(
    () => run,
    RunFailedError,
    "failed run surfaces as a RunFailedError",
  );
  assert.equal(
    runtime.isRunning("s1"),
    false,
    "run-state returns to idle after a failure",
  );
  assert.equal(
    runtime.get("s1")!.getSnapshot().streaming.length,
    0,
    "dangling streams cleared on failed run",
  );
  assert.deepEqual(statuses, ["error"], "runStatus error emitted");
}

/* --------------------------- abort settles to idle ----------------------- */
{
  const { runtime, adapter } = makeRuntime();
  const run = runtime.prompt("s1", "long task");
  await tick();
  assert.equal(runtime.isRunning("s1"), true, "running before abort");

  await runtime.abort("s1");
  assert.equal(adapter.aborted, 1, "abort reached the adapter");
  assert.equal(
    runtime.isRunning("s1"),
    true,
    "still running until the adapter settles the run",
  );

  // The adapter settles the in-flight run as aborted (NOT an error, so no
  // RunFailedError); run-state must return to idle.
  adapter.finishRun({ stopReason: "aborted" });
  await run;
  assert.equal(
    runtime.isRunning("s1"),
    false,
    "session settles to idle after abort",
  );
}

/* -------------------------- durable provider notices --------------------- */
{
  const { runtime, adapter } = makeRuntime();
  adapter.emit({
    type: "providerNotice",
    severity: "warning",
    message: "Provider connection failed; retrying 1/3.",
    providerError: {
      kind: "network",
      title: "Provider connection failed",
      summary: "The connection failed.",
      rawMessage: "WebSocket error",
    },
    attempt: 1,
    maxAttempts: 3,
    phase: "after_message_stream_start",
    requestBytes: 618_782,
  });
  const timeline = runtime.get("s1")!.clientTimeline();
  assert.deepEqual(timeline, [
    {
      id: timeline[0]!.id,
      seq: 0,
      createdAt: timeline[0]!.createdAt,
      type: "message",
      role: "assistant",
      content: [
        {
          type: "text",
          text:
            "Provider connection failed; retrying 1/3.\n\n" +
            "Provider diagnostic: network — WebSocket error\n" +
            "Attempt: 1/3\nPhase: after_message_stream_start\n" +
            "Request bytes: 618782",
        },
      ],
    },
  ]);
}

/* --------------------------- subscriber isolation ------------------------ */
{
  const { runtime, adapter } = makeRuntime();
  const good: string[] = [];
  runtime.openSessionStream("s1", () => {
    throw new Error("bad subscriber");
  });
  runtime.openSessionStream("s1", (e) => good.push(e.type));
  const run = runtime.prompt("s1", "hi");
  await tick();
  adapter.emit({ type: "messageStarted", streamId: "m1" });
  assert.ok(
    good.includes("messageStarted"),
    "a throwing subscriber does not block others",
  );
  assert.equal(
    runtime.isRunning("s1"),
    true,
    "run-state intact despite a faulty subscriber",
  );
  adapter.finishRun({ stopReason: "end" });
  await run;
}

/* --------------------- reconnect snapshot is race-safe ------------------- */
{
  const { runtime, adapter } = makeRuntime();
  const run = runtime.prompt("s1", "first", { clientRequestId: "c1" });
  await tick();
  adapter.emit({ type: "messageStarted", streamId: "m1" });
  adapter.emit({
    type: "messageDelta",
    streamId: "m1",
    delta: { kind: "text", text: "partial" },
  });

  // A new viewer subscribes mid-run: snapshot must carry the durable user entry
  // AND the in-flight stream, and then receive subsequent deltas.
  const later: string[] = [];
  const { snapshot } = runtime.openSessionStream("s1", (e) =>
    later.push(e.type),
  );
  assert.equal(snapshot.runState, "running", "reconnect sees running state");
  assert.equal(
    snapshot.entries.filter((e) => e.role === "user").length,
    1,
    "reconnect snapshot has the durable user entry",
  );
  assert.equal(
    snapshot.streaming.length,
    1,
    "reconnect snapshot has the in-flight stream",
  );

  adapter.emit({
    type: "messageDelta",
    streamId: "m1",
    delta: { kind: "text", text: "!" },
  });
  assert.ok(
    later.includes("messageDelta"),
    "post-subscribe deltas reach the reconnected viewer",
  );
  adapter.emit({
    type: "messageCompleted",
    streamId: "m1",
    content: [{ type: "text", text: "partial!" }],
  });
  adapter.finishRun({ stopReason: "end" });
  await run;
}

/* ----------------------- attachments → durable user entry --------------- */
{
  const { runtime, adapter } = makeRuntime();
  const run = runtime.prompt("s1", "see this", {
    attachments: [
      {
        id: "att1",
        name: "shot.png",
        mimeType: "image/png",
        size: 1234,
        data: "AAAA",
      },
      {
        id: "att2",
        name: "notes.txt",
        mimeType: "text/plain",
        size: 50,
        data: "Yg==",
        role: "task-context",
      },
    ],
  });
  await tick();
  // The adapter receives the attachments to forward to the model.
  assert.equal(
    adapter.lastPromptOptions?.attachments?.length,
    2,
    "attachments forwarded to the adapter",
  );
  // The durable user entry carries an attachment content block per file.
  const userEntry = runtime
    .get("s1")!
    .getSnapshot()
    .entries.find((e) => e.role === "user")!;
  const atts = userEntry.content.filter((c) => c.type === "image");
  assert.equal(
    atts.length,
    2,
    "two attachment content blocks on the durable user entry",
  );
  assert.equal(
    (atts[1] as { ref?: string; role?: string }).ref,
    "att2",
    "attachment ref is the saved id",
  );
  assert.equal(
    (atts[1] as { role?: string }).role,
    "task-context",
    "attachment role preserved",
  );
  adapter.finishRun({ stopReason: "end" });
  await run;
}

/* -------- model-only structured context stays out of the durable log ----- */
{
  const { runtime, adapter } = makeRuntime();
  const run = runtime.prompt("s1", "Visible user instruction", {
    contextBlock: "Hidden structured review context",
  });
  await tick();
  assert.equal(
    adapter.lastPromptText,
    "Hidden structured review context\n\nVisible user instruction",
    "context reaches model input",
  );
  const userEntry = runtime
    .get("s1")!
    .getSnapshot()
    .entries.find((e) => e.role === "user")!;
  assert.deepEqual(
    userEntry.content,
    [{ type: "text", text: "Visible user instruction" }],
    "durable user entry excludes structured context",
  );
  adapter.finishRun({ stopReason: "end" });
  await run;
}

/* -------- disposeSession: frees the session + allows a fresh re-create ---- */
// This is the property hub eviction relies on (gap 4): once the hub evicts a
// session and the runtime disposes it, a later re-acquire must build a FRESH
// adapter rather than reuse a stale one wrapping a disposed hub session.
{
  const { runtime, adapter } = makeRuntime();
  assert.equal(
    runtime.get("s1"),
    runtime.get("s1"),
    "same live instance before dispose",
  );
  await runtime.disposeSession("s1");
  assert.equal(adapter.disposed, true, "the adapter is disposed");
  assert.equal(
    runtime.get("s1"),
    undefined,
    "the session is gone from the runtime",
  );
  // disposing again / disposing an unknown id is a safe no-op (matches hub
  // eviction when no runtime session is registered for the id).
  await runtime.disposeSession("s1");
  await runtime.disposeSession("never-existed");
  const fresh = new ScriptedAdapter();
  const recreated = runtime.createSession("s1", fresh);
  assert.notEqual(
    recreated,
    undefined,
    "a fresh session can be created after disposal",
  );
  await runtime.disposeSession("s1");
}

/* -------------- semantic completion hook excludes generic idle ---------- */
{
  const { runtime, adapter } = makeRuntime();
  const completed: Array<{
    sessionId: string;
    stopReason: string;
    originKind?: string;
  }> = [];
  const unsubscribeCompleted = subscribeSessionRunCompleted(
    (sessionId, stopReason, origin) =>
      completed.push({
        sessionId,
        stopReason,
        ...(origin ? { originKind: origin.kind } : {}),
      }),
  );

  adapter.emit({ type: "messageStarted", streamId: "synthetic-a" });
  adapter.emit({
    type: "hostCommandResult",
    name: "commit",
    card: {
      kind: "commit",
      id: "synthetic-a",
      commit: { renderKind: "commit" } as never,
    },
  });
  assert.deepEqual(
    completed,
    [],
    "synthetic host-command idle does not report a completed provider run",
  );

  adapter.emit({ type: "messageStarted", streamId: "provider-a" });
  adapter.emit({
    type: "runCompleted",
    stopReason: "error",
    errorMessage: "failed",
  });
  assert.deepEqual(
    completed,
    [{ sessionId: "s1", stopReason: "error" }],
    "normalized run completion fires exactly once with its outcome",
  );

  const peerRun = runtime.prompt("s1", "peer report", {
    origin: { kind: "agent", agentId: "peer" },
  });
  await tick();
  adapter.emit({ type: "runCompleted", stopReason: "end" });
  adapter.finishRun({ stopReason: "end" });
  await peerRun;
  assert.deepEqual(completed[1], {
    sessionId: "s1",
    stopReason: "end",
    originKind: "agent",
  });

  unsubscribeCompleted();
  await runtime.dispose();
}

/* ----------------------- inactive session + config ---------------------- */
{
  const { runtime } = makeRuntime();
  await assert.rejects(
    () => runtime.prompt("nope", "hi"),
    InactiveSessionError,
    "prompting an unknown session throws",
  );
  const config = await runtime.getConfig("s1");
  assert.deepEqual(
    config.availableModels,
    [{ provider: "scripted", id: "m1" }],
    "config lists models via the adapter",
  );
  await runtime.dispose();
}

/* ------------------------- fork anchor resolution ------------------------ */
{
  const { runtime, adapter } = makeRuntime();
  const turn = async (prompt: string, native: string) => {
    const run = runtime.prompt("s1", prompt);
    await tick();
    adapter.emit({
      type: "messageCompleted",
      streamId: native,
      content: [{ type: "text", text: `answer to ${prompt}` }],
      providerMessageId: native,
    });
    adapter.finishRun({ stopReason: "end" });
    await run;
  };
  await turn("first", "native-a1");
  await turn("second", "native-a2");

  const timeline = runtime.get("s1")!.clientTimeline();
  const ids = timeline.map((entry) => entry.id);
  const [u1, a1, u2, a2] = ids as [string, string, string, string];

  assert.deepEqual(
    runtime.forkAnchors("s1", a2),
    {
      entryFound: true,
      own: "native-a2",
      // No `ownTurnEnd`: this entry was anchored inline by the harness, which
      // says nothing about where the turn ended. Only a reconciled binding
      // resolves that, and a caller must not read one into its absence.
      previous: "native-a1",
      previousEntryId: a1,
      precedingEntryId: u2,
    },
    "an assistant turn answers its own anchor, plus the one before it",
  );
  assert.equal(
    runtime.forkAnchors("s1", u2).previous,
    "native-a1",
    "forking before a prompt cuts at the turn that precedes it",
  );
  assert.equal(
    runtime.forkAnchors("s1", u2).previousEntryId,
    a1,
    "and reports which of OUR entries that anchor belongs to, for slicing",
  );
  assert.equal(
    runtime.forkAnchors("s1", u2).precedingEntryId,
    a1,
    "while the entry simply BEFORE it needs no anchor — copying our log never does",
  );
  assert.equal(
    runtime.forkAnchors("s1", u1).precedingEntryId,
    undefined,
    "and the first prompt has nothing before it at all",
  );
  assert.equal(
    runtime.forkAnchors("s1", u1).previous,
    undefined,
    "the first prompt has nothing before it to cut at",
  );
  assert.deepEqual(
    runtime.forkAnchors("s1", "no-such-entry"),
    { entryFound: false },
    "an entry that is gone is reported as such, not as an unanchored one",
  );
  assert.equal(
    runtime.entryText("s1", u2),
    "second",
    "entry text is recoverable for an edit-and-retry composer",
  );
  await runtime.dispose();
}

/* ------------- anchors bound the pi way (post-turn scan) ----------------- */
{
  // pi never carries a native id on `messageCompleted`; it recovers EVERY id
  // from its session file after the turn and emits `entriesBound`, which the log
  // records as immutable `message.providerBound` rows. Anything that folds only
  // the inline field therefore sees a whole harness as unanchored — pi's fork
  // action disappears and `forkAnchors` resolves nothing. This drives the real
  // adapter event rather than injecting ids inline.
  const { runtime, adapter } = makeRuntime();
  const run = runtime.prompt("s1", "a pi prompt");
  await tick();
  adapter.emit({
    type: "messageCompleted",
    streamId: "m1",
    content: [
      { type: "text", text: "using a tool" },
      { type: "toolCall", toolCallId: "call-1", name: "read", input: {} },
    ],
  });
  adapter.emit({
    type: "toolCompleted",
    streamId: "call-1",
    toolCallId: "call-1",
    content: [{ type: "text", text: "file body" }],
  });
  // The scan reports PI's transcript, where the turn is several messages: the
  // one that made the call, its result, and the answer written after it.
  adapter.emit({
    type: "entriesBound",
    entries: [
      { role: "user", providerMessageId: "pi-u1" },
      {
        role: "assistant",
        providerMessageId: "pi-a1",
        toolCallIds: ["call-1"],
      },
      { role: "toolResult", providerMessageId: "pi-t1", toolCallId: "call-1" },
      { role: "assistant", providerMessageId: "pi-a2" },
    ],
  });
  adapter.finishRun({ stopReason: "end" });
  await run;

  const timeline = runtime.get("s1")!.clientTimeline();
  const [u1, a1, t1] = timeline.map((entry) => entry.id) as [
    string,
    string,
    string,
  ];
  assert.deepEqual(
    timeline.map((entry) => entry.forkable === true),
    [true, true, true],
    "entries bound by the post-turn scan project as forkable",
  );
  assert.equal(
    runtime.forkAnchors("s1", a1).own,
    "pi-a2",
    "our one entry mirrors the message the turn's answer was written as",
  );
  assert.equal(
    runtime.forkAnchors("s1", u1).own,
    "pi-u1",
    "including the user entry pi branches from for an edit-and-retry fork",
  );
  assert.equal(
    runtime.forkAnchors("s1", t1).own,
    "pi-t1",
    "and tool results, which the scan binds by the call they answer",
  );
  await runtime.dispose();
}

/* --------- a post-turn scan binds THIS turn, never the history ----------- */
{
  // A scan reports the provider's whole file, so the runtime hands the log the
  // boundary the turn opened at. Without it, the first scan of an existing
  // session would anchor every turn it ever had — a backfill this feature must
  // not perform, and one nothing asked for.
  const { runtime, adapter } = makeRuntime();
  const older = runtime.prompt("s1", "an older prompt");
  await tick();
  adapter.emit({
    type: "messageCompleted",
    streamId: "m-old",
    content: [{ type: "text", text: "an older answer" }],
  });
  // No `entriesBound`: this turn predates the reconciliation, exactly like the
  // turns already sitting in a user's session file.
  adapter.finishRun({ stopReason: "end" });
  await older;

  const newer = runtime.prompt("s1", "the new prompt");
  await tick();
  adapter.emit({
    type: "messageCompleted",
    streamId: "m-new",
    content: [{ type: "text", text: "the new answer" }],
  });
  adapter.emit({
    type: "entriesBound",
    entries: [
      { role: "user", providerMessageId: "pi-old-u" },
      { role: "assistant", providerMessageId: "pi-old-a" },
      { role: "user", providerMessageId: "pi-new-u" },
      { role: "assistant", providerMessageId: "pi-new-a" },
    ],
  });
  adapter.finishRun({ stopReason: "end" });
  await newer;

  const timeline = runtime.get("s1")!.clientTimeline();
  assert.deepEqual(
    timeline.map((entry) => entry.forkable === true),
    [false, false, true, true],
    "the turn that just ran is anchored; the history stays exactly as it was",
  );
  assert.equal(
    runtime.forkAnchors("s1", timeline[2]!.id).own,
    "pi-new-u",
    "and the new prompt anchors on the provider's newest, not on an older one",
  );
  await runtime.dispose();
}

/* --------- a REFUSED steering prompt never joins the turn's prompts ------ */
{
  // A steering message is appended to the log BEFORE the provider answers. When
  // it refuses, our log holds a prompt its transcript never got — and counting
  // that as one of the turn's prompts would pair the turn's OWN prompt with the
  // previous turn's native row, which is a wrong fork point, not a missing one.
  class SteerRefusingAdapter extends ScriptedAdapter {
    override readonly capabilities = {
      fork: "arbitrary" as const,
      compact: false,
      steer: true,
      attachments: true,
    };
    override prompt(
      text: string,
      options?: import("../adapters/contract.ts").PromptOptions,
    ): Promise<AgentRunResult> {
      if (options?.steer)
        return Promise.reject(
          new Error("Prompt was not accepted by the pi session."),
        );
      return super.prompt(text, options);
    }
  }
  const runtime = new SessionRuntime(new SessionLogStore(true));
  const adapter = new SteerRefusingAdapter();
  runtime.createSession("s1", adapter);

  const first = runtime.prompt("s1", "an earlier prompt");
  await tick();
  adapter.emit({
    type: "messageCompleted",
    streamId: "m1",
    content: [{ type: "text", text: "an earlier answer" }],
  });
  adapter.emit({
    type: "entriesBound",
    entries: [
      { role: "user", providerMessageId: "pi-u1" },
      { role: "assistant", providerMessageId: "pi-a1" },
    ],
  });
  adapter.finishRun({ stopReason: "end" });
  await first;

  const second = runtime.prompt("s1", "the running prompt");
  await tick();
  await assert.rejects(
    () => runtime.prompt("s1", "a steer it ignores", { steer: true }),
    /not accepted/,
    "the refused steering prompt surfaces as a rejection",
  );
  adapter.emit({
    type: "messageCompleted",
    streamId: "m2",
    content: [{ type: "text", text: "the answer" }],
  });
  adapter.emit({
    type: "entriesBound",
    entries: [
      { role: "user", providerMessageId: "pi-u1" },
      { role: "assistant", providerMessageId: "pi-a1" },
      { role: "user", providerMessageId: "pi-u2" },
      { role: "assistant", providerMessageId: "pi-a2" },
    ],
  });
  adapter.finishRun({ stopReason: "end" });
  await second;

  const timeline = runtime.get("s1")!.clientTimeline();
  const [, , prompt, refusedSteer, answer] = timeline;
  assert.equal(
    runtime.forkAnchors("s1", prompt!.id).own,
    "pi-u2",
    "the turn's own prompt anchors on the provider's newest prompt",
  );
  assert.equal(
    runtime.forkAnchors("s1", refusedSteer!.id).own,
    undefined,
    "the refused steer is anchored to nothing, having reached no transcript",
  );
  assert.equal(
    runtime.forkAnchors("s1", answer!.id).own,
    "pi-a2",
    "and the turn's answer still binds",
  );
  assert.equal(
    runtime.forkAnchors("s1", timeline[0]!.id).own,
    "pi-u1",
    "while the earlier turn keeps the anchor it earned",
  );
  await runtime.dispose();
}

/* --------- an out-of-band turn with no prompt of ours binds nothing ------ */
{
  // Without a prompt there is nothing to anchor the scan's tail to: the rows
  // after the provider's last prompt would be read against whatever that prompt
  // left behind, and a fork at the result would include a prompt our copy does
  // not have. Under-bind instead.
  const { runtime, adapter } = makeRuntime();
  adapter.emit({ type: "messageStarted", streamId: "m-observed" });
  adapter.emit({
    type: "messageCompleted",
    streamId: "m-observed",
    content: [{ type: "text", text: "an answer nobody prompted" }],
  });
  // A perfectly ordinary tail — one prompt, one answer — that would otherwise
  // satisfy every rule. It answers a PROMPT WE DO NOT HAVE, so binding our entry
  // to it would let a fork cut a turn whose prompt our copy cannot show.
  adapter.emit({
    type: "entriesBound",
    entries: [
      { role: "user", providerMessageId: "pi-u1" },
      { role: "assistant", providerMessageId: "pi-a1" },
    ],
  });
  adapter.emit({ type: "runCompleted", stopReason: "end" });

  const timeline = runtime.get("s1")!.clientTimeline();
  assert.deepEqual(
    timeline.map((entry) => entry.forkable === true),
    [false],
    "an observed turn with no prompt of ours is left unanchored",
  );
  await runtime.dispose();
}

/* --------------- a forked log inherits no foreign ids -------------------- */
{
  // Two kinds of id in a copied prefix name something outside the child: the
  // native anchor (the provider remapped it) and the submitting client's
  // idempotency token. An inherited token is the nastier one — the child would
  // treat a resubmit of it as already handled and silently append nothing, which
  // is exactly what an edit-and-retry of the same optimistic submit sends.
  const { runtime, adapter } = makeRuntime();
  const run = runtime.prompt("s1", "the prompt", { clientRequestId: "req-1" });
  await tick();
  adapter.emit({
    type: "messageCompleted",
    streamId: "m1",
    content: [{ type: "text", text: "an answer" }],
    providerMessageId: "native-a1",
  });
  adapter.finishRun({ stopReason: "end" });
  await run;

  const [, assistantId] = runtime
    .get("s1")!
    .clientTimeline()
    .map((entry) => entry.id) as [string, string];
  const entries = runtime.forkLog("s1", "child-1", assistantId);
  assert.ok(entries, "the fork copied the prefix");
  assert.equal(
    runtime.forkAnchors("child-1", assistantId).own,
    undefined,
    "the copy is unanchored: the parent's native id names nothing here",
  );

  // The child accepts a prompt carrying the SAME request id the parent used.
  const childAdapter = new ScriptedAdapter();
  runtime.createSession("child-1", childAdapter);
  const childRun = runtime.prompt("child-1", "retried", {
    clientRequestId: "req-1",
  });
  await tick();
  childAdapter.finishRun({ stopReason: "end" });
  await childRun;
  assert.equal(
    runtime
      .get("child-1")!
      .clientTimeline()
      .filter((entry) => entry.type === "message" && entry.role === "user")
      .length,
    2,
    "a resubmitted parent token is a NEW prompt in the child, not a duplicate",
  );
  assert.deepEqual(
    runtime
      .get("child-1")!
      .clientTimeline()
      .map((entry) => entry.inheritedFrom?.sessionId),
    ["s1", "s1", undefined],
    "the copied prefix is stamped with the session that wrote it; the child's own prompt is not",
  );

  // A fork OF the fork keeps pointing at where each message was written: the
  // grandchild's inherited rows still name s1, not the intermediate child.
  const childPromptId = runtime.get("child-1")!.clientTimeline().at(-1)!.id;
  const grandchild = runtime.forkLog("child-1", "child-2", childPromptId);
  assert.ok(grandchild, "the second fork copied the prefix");
  assert.deepEqual(
    grandchild.map((entry) => entry.inheritedFrom?.sessionId),
    ["s1", "s1", "child-1"],
    "each inherited row names the session that produced it, not the hop it came through",
  );
  await runtime.dispose();
}

rmSync(tmp, { recursive: true, force: true });
console.log("session runtime unit test: PASS");

test("coordinates normalized session runtime state", () => {
  // Assertions run during module evaluation to preserve the former standalone script structure.
});

/* ------- the run bracket: what a killed turn leaves behind ---------------- */
/**
 * A turn's assistant entry and tool results reach the durable log in ONE flush
 * when it completes, so a turn the process dies inside leaves no conversation
 * record at all. The bracket is what makes it visible afterwards, and it must be
 * open for exactly as long as the turn is.
 */
{
  const { runtime, adapter } = makeRuntime();
  assert.equal(
    runtime.interruptedRunAt("s1"),
    undefined,
    "a session that has never run holds no open bracket",
  );

  const run = runtime.prompt("s1", "hi", { clientRequestId: "bracket-1" });
  await tick();
  assert.ok(
    runtime.interruptedRunAt("s1") !== undefined,
    "the bracket is open for the whole turn — this is the state a crash freezes",
  );

  adapter.finishRun({ stopReason: "end" });
  await run;
  await tick();
  assert.equal(
    runtime.interruptedRunAt("s1"),
    undefined,
    "a completed turn closes it",
  );

  const second = runtime.prompt("s1", "again", {
    clientRequestId: "bracket-2",
  });
  await tick();
  assert.ok(runtime.interruptedRunAt("s1") !== undefined);
  adapter.finishRun({ stopReason: "end" });
  await second;
  await tick();
  assert.equal(
    runtime.interruptedRunAt("s1"),
    undefined,
    "and each later turn brackets independently",
  );
}
