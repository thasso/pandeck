/**
 * The transport's live-body projection: what a viewer receives of an in-flight
 * thinking block or tool body, and how subscribing hydrates it losslessly.
 *
 *   pnpm --filter @assistant/server test src/session/transport/liveBodies.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type {
  ContextInfo,
  ServerMessage,
  SessionState,
} from "@assistant/shared";
import type { LiveBodyKey } from "@assistant/shared/session";
import type { ClientRuntimeEvent } from "@assistant/shared/runtime";
import { entriesToDisplayMessages } from "@assistant/shared/display";
import type { AdapterEvent } from "../adapters/contract.ts";

const tmp = mkdtempSync(join(tmpdir(), "live-bodies-test-"));
process.env.ASSISTANT_CWD = tmp;

const { RuntimeTransport } = await import("./gateway.ts");
const { SessionRuntime } = await import("../runtime/runtime.ts");
const { SessionLogStore } = await import("../log/store.ts");

const stubState = () => ({ sessionId: "s" }) as unknown as SessionState;
const stubContext = () => ({ sessionId: "s" }) as unknown as ContextInfo;

/** A scripted adapter: the test feeds it the events a harness would emit. */
function scriptedAdapter() {
  let listener: ((event: AdapterEvent) => void) | undefined;
  return {
    adapter: {
      provider: "fake",
      capabilities: { fork: "none", compact: false, attachments: false },
      subscribe(fn: (event: AdapterEvent) => void) {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
      getBinding() {
        return { provider: "fake" };
      },
      async prompt() {
        return { stopReason: "end" };
      },
      abort() {},
      setModel() {},
      async setReasoning() {},
      dispose() {},
    },
    emit(event: AdapterEvent) {
      listener?.(event);
    },
  };
}

function attach(sessionId: string) {
  const runtime = new SessionRuntime(new SessionLogStore(true));
  const { adapter, emit } = scriptedAdapter();
  const session = runtime.createSession(sessionId, adapter as never);
  const sent: ServerMessage[] = [];
  const transport = new RuntimeTransport(
    sessionId,
    session,
    { send: (m) => sent.push(m) },
    { buildState: stubState, buildContextInfo: stubContext },
  );
  transport.attach();
  const events = () =>
    sent
      .filter(
        (m): m is Extract<ServerMessage, { type: "event" }> =>
          m.type === "event",
      )
      .map((m) => m.event);
  const flushed = () => new Promise((resolve) => setTimeout(resolve, 80));
  return { runtime, session, emit, transport, sent, events, flushed };
}

const THINKING: LiveBodyKey = {
  streamId: "m1",
  blockIndex: 0,
  kind: "thinking",
};
const OUTPUT: LiveBodyKey = {
  streamId: "t1",
  blockIndex: 0,
  kind: "toolOutput",
};

function bodies(events: ClientRuntimeEvent[]) {
  return events.filter(
    (e): e is Extract<ClientRuntimeEvent, { type: "liveBody" }> =>
      e.type === "liveBody",
  );
}

/** Replay body frames the way the client reducer does, to check hydration. */
function replay(frames: Extract<ClientRuntimeEvent, { type: "liveBody" }>[]) {
  let text = "";
  for (const frame of frames) {
    if (frame.mode === "replace") text = String(frame.content);
    else {
      expect(frame.offset).toBe(text.length);
      text += String(frame.content);
    }
    expect(text.length).toBe(frame.length);
  }
  return text;
}

describe("live body projection", () => {
  const runtimes: Array<{ dispose(): Promise<void> }> = [];
  afterAll(async () => {
    for (const r of runtimes) await r.dispose();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("an unsubscribed thinking block reaches the viewer as progress, never text", async () => {
    const t = attach("hidden");
    runtimes.push(t.runtime);
    t.emit({ type: "messageStarted", streamId: "m1" });
    t.emit({
      type: "messageDelta",
      streamId: "m1",
      delta: { kind: "thinking", text: "let me think\n" },
    });
    t.emit({
      type: "messageDelta",
      streamId: "m1",
      delta: { kind: "thinking", text: "about this" },
    });
    await t.flushed();
    const events = t.events();
    expect(events.some((e) => e.type === "messageDelta")).toBe(false);
    expect(bodies(events)).toEqual([]);
    const progress = events.filter((e) => e.type === "liveBodyProgress");
    expect(progress).toHaveLength(1);
    expect(progress[0]).toEqual({
      type: "liveBodyProgress",
      ref: {
        ...THINKING,
        length: "let me think\nabout this".length,
        lineCount: 2,
      },
    });
    const wire = JSON.stringify(events);
    expect(wire).not.toContain("let me think");
  });

  test("batching preserves text, thinking, text order across blocks", async () => {
    const t = attach("ordered");
    runtimes.push(t.runtime);
    t.emit({ type: "messageStarted", streamId: "m1" });
    t.emit({
      type: "messageDelta",
      streamId: "m1",
      delta: { kind: "text", text: "before" },
    });
    t.emit({
      type: "messageDelta",
      streamId: "m1",
      delta: { kind: "thinking", text: "thought" },
    });
    t.emit({
      type: "messageDelta",
      streamId: "m1",
      delta: { kind: "text", text: "after" },
    });
    await t.flushed();

    expect(
      t
        .events()
        .filter(
          (e) =>
            e.type === "messageStarted" ||
            e.type === "messageDelta" ||
            e.type === "liveBodyProgress",
        )
        .map((e) =>
          e.type === "messageDelta"
            ? `text:${e.delta.text}`
            : e.type === "liveBodyProgress"
              ? `thinking:${e.ref.length}`
              : e.type,
        ),
    ).toEqual(["messageStarted", "text:before", "thinking:7", "text:after"]);
  });

  test("subscribing snapshots the current body, then relays ordered deltas; unsubscribing stops them", async () => {
    const t = attach("sub");
    runtimes.push(t.runtime);
    t.emit({ type: "messageStarted", streamId: "m1" });
    t.emit({
      type: "messageDelta",
      streamId: "m1",
      delta: { kind: "thinking", text: "alpha " },
    });
    // Subscribe while a delta is still queued: the queue flushes as progress
    // first, then the snapshot carries everything the runtime holds.
    t.transport.setLiveBodySubscriptions([THINKING]);
    t.emit({
      type: "messageDelta",
      streamId: "m1",
      delta: { kind: "thinking", text: "beta " },
    });
    t.emit({
      type: "messageDelta",
      streamId: "m1",
      delta: { kind: "thinking", text: "gamma" },
    });
    await t.flushed();
    let frames = bodies(t.events());
    expect(frames[0]).toMatchObject({
      mode: "replace",
      offset: 0,
      content: "alpha ",
      length: 6,
    });
    expect(frames).toHaveLength(2);
    expect(frames[1]).toMatchObject({
      mode: "append",
      offset: 6,
      content: "beta gamma",
      lineCount: 1,
    });
    expect(replay(frames)).toBe("alpha beta gamma");

    t.transport.setLiveBodySubscriptions([]);
    t.emit({
      type: "messageDelta",
      streamId: "m1",
      delta: { kind: "thinking", text: " delta" },
    });
    await t.flushed();
    frames = bodies(t.events());
    expect(frames).toHaveLength(2);
    expect(
      t
        .events()
        .filter((e) => e.type === "liveBodyProgress")
        .at(-1),
    ).toMatchObject({ ref: { length: "alpha beta gamma delta".length } });

    // Resubscribing replaces with what accumulated meanwhile.
    t.transport.setLiveBodySubscriptions([THINKING]);
    frames = bodies(t.events());
    expect(frames).toHaveLength(3);
    expect(frames[2]).toMatchObject({
      lineCount: 1,
      mode: "replace",
      content: "alpha beta gamma delta",
    });
    expect(replay(frames)).toBe("alpha beta gamma delta");
  });

  test("subscribed bodies coalesce per body without crossing an interleaved body", async () => {
    const t = attach("interleaved");
    runtimes.push(t.runtime);
    for (const streamId of ["t1", "t2"])
      t.emit({
        type: "toolStarted",
        streamId,
        toolCallId: streamId,
        name: "bash",
        input: { command: streamId },
      });
    t.transport.setLiveBodySubscriptions([
      { streamId: "t1", blockIndex: 0, kind: "toolOutput" },
      { streamId: "t2", blockIndex: 0, kind: "toolOutput" },
    ]);
    t.emit({ type: "toolUpdated", streamId: "t1", output: "a" });
    t.emit({ type: "toolUpdated", streamId: "t2", output: "b" });
    t.emit({ type: "toolUpdated", streamId: "t1", output: "ac" });
    await t.flushed();

    expect(
      bodies(t.events())
        .slice(-3)
        .map((frame) => [frame.key.streamId, frame.content]),
    ).toEqual([
      ["t1", "a"],
      ["t2", "b"],
      ["t1", "c"],
    ]);
  });

  test("a tool body streams replacements and extensions correctly, ends compact, and lands as the lazy durable row", async () => {
    const t = attach("tool");
    runtimes.push(t.runtime);
    const longOutput = Array.from({ length: 40 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    t.emit({ type: "messageStarted", streamId: "m1" });
    t.emit({
      type: "toolStarted",
      streamId: "t1",
      toolCallId: "t1",
      name: "bash",
      input: { command: "ls" },
    });
    t.emit({ type: "toolUpdated", streamId: "t1", output: "Starting…" });
    await t.flushed();
    const started = t.events().find((e) => e.type === "toolStarted") as Extract<
      ClientRuntimeEvent,
      { type: "toolStarted" }
    >;
    expect(started.input).toEqual({ command: "ls" });
    expect(started.inputLive).toBeUndefined();
    expect(t.events().some((e) => e.type === "liveBodyProgress")).toBe(true);
    expect(bodies(t.events())).toEqual([]);

    t.transport.setLiveBodySubscriptions([OUTPUT]);
    t.emit({ type: "toolUpdated", streamId: "t1", output: "line 0\nline 1" });
    t.emit({
      type: "toolUpdated",
      streamId: "t1",
      output: "line 0\nline 1\nline 2",
    });
    await t.flushed();
    let frames = bodies(t.events());
    expect(frames[0]).toMatchObject({ mode: "replace", content: "Starting…" });
    expect(frames[1]).toMatchObject({
      mode: "replace",
      content: "line 0\nline 1\nline 2",
    });
    expect(replay(frames)).toBe("line 0\nline 1\nline 2");

    // The live toolEnd: final body to the subscriber, then the compact end.
    t.emit({
      type: "passthrough",
      envelope: {
        type: "toolEnd",
        sessionId: "tool",
        id: "m1",
        toolId: "t1",
        output: longOutput,
        isError: false,
      },
    });
    frames = bodies(t.events());
    expect(replay(frames)).toBe(longOutput);
    const ended = t.events().at(-1);
    expect(ended).toEqual({
      type: "toolEnded",
      streamId: "t1",
      isError: false,
      output: { ...OUTPUT, length: longOutput.length, lineCount: 40 },
    });

    // Completion: the durable rows arrive projected by the lazy policy, exactly
    // as a reconnect would send them.
    t.emit({
      type: "messageCompleted",
      streamId: "m1",
      content: [
        { type: "thinking", text: "x".repeat(600) },
        {
          type: "toolCall",
          toolCallId: "t1",
          name: "bash",
          input: { command: "ls" },
        },
      ],
    });
    t.emit({
      type: "toolCompleted",
      streamId: "t1",
      toolCallId: "t1",
      content: [{ type: "text", text: longOutput }],
    });
    t.emit({ type: "runCompleted", stopReason: "end" });
    const deltas = t
      .events()
      .filter(
        (e): e is Extract<ClientRuntimeEvent, { type: "timelineDelta" }> =>
          e.type === "timelineDelta",
      );
    const live = deltas.flatMap((d) => d.entries);
    const reconnect = t.session.clientTimeline({ lazyBodies: true });
    expect(live).toEqual(reconnect);
    const assistant = live.find(
      (e) => e.type === "message" && e.role === "assistant",
    );
    expect(
      assistant && assistant.type === "message" && assistant.content[0],
    ).toMatchObject({ type: "thinking", lazy: { fullLength: 600 } });
    const result = live.find(
      (e) => e.type === "message" && e.role === "toolResult",
    );
    expect(
      result && result.type === "message" && result.content[0],
    ).toMatchObject({ lazy: { kind: "toolOutput", lineCount: 40 } });
    // The stream is gone: a stale subscription is ignored, not answered.
    t.transport.setLiveBodySubscriptions([OUTPUT, THINKING]);
    expect(bodies(t.events())).toHaveLength(frames.length);
  });

  test("rich cards complete inline before turn end and survive a mid-turn reconnect", () => {
    const t = attach("live-cards");
    runtimes.push(t.runtime);
    const taskInput = {
      operations: [
        {
          operation: "create",
          title: "Keep the card visible",
          description: "x".repeat(900),
        },
      ],
    };
    const taskOutput = JSON.stringify({
      renderKind: "taskManage",
      changed: [{ id: "697", title: "Keep the card visible", status: "todo" }],
    });
    const filesInput = { paths: ["/tmp/plot.png"], ignored: "z".repeat(900) };
    const filesOutput = JSON.stringify({
      renderKind: "showFiles",
      card: {
        files: [
          {
            url: "/api/files/tmp/plot.png",
            name: "plot.png",
            label: "plot.png",
          },
        ],
      },
    });
    t.emit({ type: "messageStarted", streamId: "m1" });
    t.emit({
      type: "toolStarted",
      streamId: "task",
      toolCallId: "task",
      name: "task_manage",
      input: taskInput,
    });
    t.emit({
      type: "toolStarted",
      streamId: "files",
      toolCallId: "files",
      name: "show_files",
      input: filesInput,
    });
    for (const [toolId, output] of [
      ["task", taskOutput],
      ["files", filesOutput],
    ] as const)
      t.emit({
        type: "passthrough",
        envelope: {
          type: "toolEnd",
          sessionId: "live-cards",
          id: "m1",
          toolId,
          output,
          isError: false,
        },
      });

    const ended = t
      .events()
      .filter(
        (e): e is Extract<ClientRuntimeEvent, { type: "toolEnded" }> =>
          e.type === "toolEnded",
      );
    expect(ended).toEqual([
      {
        type: "toolEnded",
        streamId: "task",
        isError: false,
        output: taskOutput,
        card: true,
        input: taskInput,
      },
      {
        type: "toolEnded",
        streamId: "files",
        isError: false,
        output: filesOutput,
        card: true,
      },
    ]);
    expect(t.events().some((e) => e.type === "messageCompleted")).toBe(false);

    const sent: ServerMessage[] = [];
    const late = new RuntimeTransport(
      "live-cards",
      t.session,
      { send: (m) => sent.push(m) },
      { buildState: stubState, buildContextInfo: stubContext },
    );
    late.attach();
    const snapshot = sent[0];
    if (snapshot?.type !== "snapshot") throw new Error("no snapshot");
    const task = snapshot.snapshot.streaming.find(
      (stream) => stream.kind === "tool" && stream.streamId === "task",
    );
    const files = snapshot.snapshot.streaming.find(
      (stream) => stream.kind === "tool" && stream.streamId === "files",
    );
    expect(task).toMatchObject({
      done: true,
      input: taskInput,
      output: taskOutput,
    });
    expect(task?.kind === "tool" && task.inputLive).toBeUndefined();
    expect(task?.kind === "tool" && task.outputLive).toBeUndefined();
    expect(files).toMatchObject({ done: true, output: filesOutput });
    expect(files?.kind === "tool" && files.input).not.toEqual(filesInput);
    expect(files?.kind === "tool" && files.inputLive).toBeUndefined();
    expect(files?.kind === "tool" && files.outputLive).toBeUndefined();
    // The declaring message stream was summarized when the call opened; what
    // the reconnecting viewer RENDERS folds the completed stream's exact
    // arguments back onto that block, so the Task card has its operation verbs
    // right away — before any durable correction — exactly as it did live.
    const rendered = entriesToDisplayMessages(
      snapshot.snapshot.timeline,
      snapshot.snapshot.streaming,
    ).at(-1)!;
    const taskBlock = rendered.blocks.find(
      (b) => b.kind === "tool" && b.toolId === "task",
    );
    expect(taskBlock).toMatchObject({
      kind: "tool",
      args: taskInput,
      output: taskOutput,
      done: true,
    });
    expect(taskBlock && "argsLive" in taskBlock).toBe(false);
    expect(taskBlock && "argsSummary" in taskBlock).toBe(false);
    late.detach();
  });

  test("a mid-turn attach sends compact streams whose bodies hydrate on subscribe", async () => {
    const t = attach("mid");
    runtimes.push(t.runtime);
    const bigInput = { content: "y".repeat(2000), file_path: "/tmp/x" };
    t.emit({ type: "messageStarted", streamId: "m1" });
    t.emit({
      type: "messageDelta",
      streamId: "m1",
      delta: { kind: "thinking", text: "thinking\nhard" },
    });
    t.emit({
      type: "toolStarted",
      streamId: "t1",
      toolCallId: "t1",
      name: "write",
      input: bigInput,
    });
    t.emit({ type: "toolUpdated", streamId: "t1", output: "partial out" });
    await t.flushed();

    const sent: ServerMessage[] = [];
    const late = new RuntimeTransport(
      "mid",
      t.session,
      { send: (m) => sent.push(m) },
      { buildState: stubState, buildContextInfo: stubContext },
    );
    late.attach();
    const snapshot = sent[0];
    if (snapshot?.type !== "snapshot") throw new Error("no snapshot");
    const streams = snapshot.snapshot.streaming;
    expect(JSON.stringify(streams)).not.toContain("thinking\nhard");
    expect(JSON.stringify(streams)).not.toContain("y".repeat(50));
    expect(JSON.stringify(streams)).not.toContain("partial out");
    const message = streams.find((s) => s.kind === "message");
    expect(message?.kind === "message" && message.content[0]).toEqual({
      type: "thinking",
      text: "",
      live: { ...THINKING, length: 13, lineCount: 2 },
    });
    expect(message?.kind === "message" && message.content[1]).toMatchObject({
      type: "toolCall",
      input: { file_path: "/tmp/x" },
      inputSummary: "/tmp/x",
      inputLive: { streamId: "t1", blockIndex: 0, kind: "toolInput" },
    });
    const tool = streams.find((s) => s.kind === "tool");
    expect(tool?.kind === "tool" && tool.output).toBe("");
    expect(tool?.kind === "tool" && tool.outputLive).toEqual({
      ...OUTPUT,
      length: "partial out".length,
    });

    late.setLiveBodySubscriptions([
      THINKING,
      OUTPUT,
      { streamId: "t1", blockIndex: 0, kind: "toolInput" },
    ]);
    const frames = sent
      .filter(
        (m): m is Extract<ServerMessage, { type: "event" }> =>
          m.type === "event",
      )
      .map((m) => m.event)
      .filter(
        (e): e is Extract<ClientRuntimeEvent, { type: "liveBody" }> =>
          e.type === "liveBody",
      );
    expect(frames.map((f) => [f.key.kind, f.mode, f.content])).toEqual([
      ["thinking", "replace", "thinking\nhard"],
      ["toolOutput", "replace", "partial out"],
      ["toolInput", "replace", bigInput],
    ]);
    late.detach();
  });

  test("a card that reads its input keeps it whole while running", async () => {
    const t = attach("card");
    runtimes.push(t.runtime);
    const questions = {
      questions: Array.from({ length: 6 }, (_, i) => ({
        id: `q${i}`,
        title: `Question ${i}`,
        prompt: "p".repeat(120),
      })),
    };
    t.emit({ type: "messageStarted", streamId: "m1" });
    t.emit({
      type: "toolStarted",
      streamId: "t1",
      toolCallId: "t1",
      name: "mcp__pa__ask_questions",
      input: questions,
    });
    const started = t.events().find((e) => e.type === "toolStarted") as Extract<
      ClientRuntimeEvent,
      { type: "toolStarted" }
    >;
    expect(started.input).toEqual(questions);
    expect(started.inputLive).toBeUndefined();
  });

  // Both cards are refused by the web registry when the payload carries
  // `renderRequested: false`, so neither the live durable delta nor a later
  // reconnect snapshot may inline such a payload: it is a generic result and
  // gets the bounded lazy projection like any other.
  test("a card payload that refuses rendering stays bounded in the delta and on reconnect", async () => {
    const t = attach("refused");
    runtimes.push(t.runtime);
    const peer = JSON.stringify({
      renderKind: "sessionPeerPrompt",
      renderRequested: false,
      version: 1,
      card: {
        direction: "sent",
        messageKey: "k1",
        senderTitle: "Reviewer",
        message: "x".repeat(4_200),
        responseRequested: true,
        state: "queued",
      },
    });
    const files = JSON.stringify({
      renderKind: "showFiles",
      renderRequested: false,
      version: 1,
      card: {
        files: Array.from({ length: 10 }, (_unused, index) => ({
          url: `/api/files/tmp/example/very/long/path/plot-${index}.png`,
          name: `plot-${index}.png`,
          label: `plot-${index}.png`,
          size: 2048,
          snippet: `![plot-${index}.png](/api/files/tmp/example/very/long/path/plot-${index}.png)`,
        })),
      },
    });
    t.emit({ type: "messageStarted", streamId: "m1" });
    t.emit({
      type: "toolStarted",
      streamId: "peer",
      toolCallId: "peer",
      name: "mcp__pa__session_send_prompt",
      input: { targetSessionId: "s2", prompt: "hi" },
    });
    t.emit({
      type: "toolStarted",
      streamId: "files",
      toolCallId: "files",
      name: "show_files",
      input: { paths: ["/tmp/example/very/long/path/plot-0.png"] },
    });
    t.emit({
      type: "messageCompleted",
      streamId: "m1",
      content: [
        {
          type: "toolCall",
          toolCallId: "peer",
          name: "mcp__pa__session_send_prompt",
          input: { targetSessionId: "s2", prompt: "hi" },
        },
        {
          type: "toolCall",
          toolCallId: "files",
          name: "show_files",
          input: { paths: ["/tmp/example/very/long/path/plot-0.png"] },
        },
      ],
    });
    t.emit({
      type: "toolCompleted",
      streamId: "peer",
      toolCallId: "peer",
      toolName: "mcp__pa__session_send_prompt",
      content: [{ type: "text", text: peer }],
    });
    t.emit({
      type: "toolCompleted",
      streamId: "files",
      toolCallId: "files",
      toolName: "show_files",
      content: [{ type: "text", text: files }],
    });
    t.emit({ type: "runCompleted", stopReason: "end" });

    const results = t
      .events()
      .filter(
        (e): e is Extract<ClientRuntimeEvent, { type: "timelineDelta" }> =>
          e.type === "timelineDelta",
      )
      .flatMap((d) => d.entries)
      .filter((e) => e.type === "message" && e.role === "toolResult");
    expect(results).toHaveLength(2);
    for (const result of results) {
      const block = result.type === "message" ? result.content[0] : undefined;
      expect(block).toMatchObject({
        type: "text",
        lazy: { kind: "toolOutput" },
      });
      if (block?.type !== "text") throw new Error("expected text block");
      expect(block.text.length).toBeLessThanOrEqual(1_200);
    }
    const wire = JSON.stringify(t.events());
    expect(wire).not.toContain("x".repeat(1_300));
    expect(wire).not.toContain("plot-9.png");

    const sent: ServerMessage[] = [];
    const late = new RuntimeTransport(
      "refused",
      t.session,
      { send: (m) => sent.push(m) },
      { buildState: stubState, buildContextInfo: stubContext },
    );
    late.attach();
    const snapshot = sent[0];
    if (snapshot?.type !== "snapshot") throw new Error("no snapshot");
    const reconnectResults = snapshot.snapshot.timeline.filter(
      (e) => e.type === "message" && e.role === "toolResult",
    );
    expect(reconnectResults).toEqual(results);
    const snapshotWire = JSON.stringify(snapshot.snapshot.timeline);
    expect(snapshotWire).not.toContain("x".repeat(1_300));
    expect(snapshotWire).not.toContain("plot-9.png");
    late.detach();
  });

  // Stream ids are opaque and a tool call's id is the provider's: nothing
  // says one cannot end in a message stream's id. A tool that started before
  // the message's current thinking block and completes while that block still
  // streams may drop only what the tool owns; the block's counter keeps
  // counting from where it was, whatever the tool was called.
  test("a tool call whose id is a suffix relative of the message stream's does not reset its thinking line count", async () => {
    const t = attach("collide");
    runtimes.push(t.runtime);
    const progressFor = (key: LiveBodyKey) =>
      t
        .events()
        .filter(
          (e): e is Extract<ClientRuntimeEvent, { type: "liveBodyProgress" }> =>
            e.type === "liveBodyProgress" &&
            e.ref.streamId === key.streamId &&
            e.ref.blockIndex === key.blockIndex &&
            e.ref.kind === key.kind,
        )
        .map((e) => e.ref.lineCount);
    t.emit({ type: "messageStarted", streamId: "m1" });
    // The tool call lands in the message at block 0; the thinking that follows
    // is block 1, whose serialized body key is `thinking:1:m1` — and the tool
    // is called `1:m1`.
    const toolId = "1:m1";
    t.emit({
      type: "toolStarted",
      streamId: toolId,
      toolCallId: toolId,
      name: "bash",
      input: { command: "ls" },
    });
    const thinking: LiveBodyKey = {
      streamId: "m1",
      blockIndex: 1,
      kind: "thinking",
    };
    t.emit({
      type: "messageDelta",
      streamId: "m1",
      delta: { kind: "thinking", text: "one\ntwo" },
    });
    await t.flushed();
    expect(progressFor(thinking)).toEqual([2]);
    t.transport.setLiveBodySubscriptions([thinking]);
    await t.flushed();
    expect(bodies(t.events()).at(-1)).toMatchObject({
      key: thinking,
      mode: "replace",
      lineCount: 2,
    });
    t.emit({
      type: "toolCompleted",
      streamId: toolId,
      toolCallId: toolId,
      content: [{ type: "text", text: "done" }],
    });
    t.emit({
      type: "messageDelta",
      streamId: "m1",
      delta: { kind: "thinking", text: "\nthree" },
    });
    await t.flushed();
    // The subscription outlived the tool, and the counter is monotonic: 2 → 3,
    // never back to the delta's own line count.
    expect(bodies(t.events()).at(-1)).toMatchObject({
      key: thinking,
      mode: "append",
      content: "\nthree",
      lineCount: 3,
    });
    expect(progressFor(thinking)).toEqual([2]);
  });
});
