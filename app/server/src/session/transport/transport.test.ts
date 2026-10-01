/**
 * Unit test for the runtime → wire transport. Run through the server Vitest
 * suite:
 *   pnpm --filter @assistant/server test src/session/transport/transport.test.ts
 *
 * Covers: the entries→DisplayMessage projection (tool folding + streaming
 * overlay); the gateway's subscribe-then-snapshot + runtime event relay;
 * optimistic clientRequestId echo on the user message; and a reconnecting viewer
 * receiving durable history via a fresh snapshot.
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
import type { SessionEntry, StreamingEntry } from "@assistant/shared/session";
import { describeTimelineCache } from "@assistant/shared/runtime";
import type {
  ClaudeQueryParams,
  ClaudeSdkMessage,
  ClaudeSdkSeam,
} from "../../claudeSdk/sdkSeam.ts";

const tmp = mkdtempSync(join(tmpdir(), "transport-test-"));
process.env.ASSISTANT_CWD = tmp;

const { entriesToDisplayMessages } = await import("./displayMapping.ts");
const { RuntimeTransport } = await import("./gateway.ts");
const { SessionRuntime } = await import("../runtime/runtime.ts");
const { SessionLogStore } = await import("../log/store.ts");
const { ClaudeSdkSession } =
  await import("../../claudeSdk/ClaudeSdkSession.ts");

/* --------------------- 1. projection: folding + overlay ------------------ */
test("projection: folding + overlay", () => {
  const entries: SessionEntry[] = [
    {
      id: "u0",
      seq: 0,
      createdAt: "t",
      type: "message",
      role: "user",
      origin: { kind: "human" },
      content: [{ type: "text", text: "hi" }],
    },
    {
      id: "a1",
      seq: 1,
      createdAt: "t",
      type: "message",
      role: "assistant",
      content: [
        { type: "text", text: "ok" },
        {
          type: "toolCall",
          toolCallId: "tc1",
          name: "bash",
          input: { cmd: "ls" },
        },
      ],
    },
    {
      id: "tr1",
      seq: 2,
      createdAt: "t",
      type: "message",
      role: "toolResult",
      toolCallId: "tc1",
      content: [{ type: "text", text: "out" }],
      isError: false,
    },
  ];
  const msgs = entriesToDisplayMessages(entries);
  assert.equal(
    msgs.length,
    2,
    "toolResult folds into the assistant message (not a 3rd message)",
  );
  const tool = msgs[1]!.blocks.find((b) => b.kind === "tool") as {
    output: string;
    done: boolean;
  };
  assert.equal(
    tool.output,
    "out",
    "tool block output filled from the toolResult entry",
  );
  assert.equal(tool.done, true, "tool block marked done");

  // Streaming overlay → one trailing streaming assistant message.
  const streaming: StreamingEntry[] = [
    {
      streamId: "s1",
      kind: "message",
      role: "assistant",
      content: [{ type: "text", text: "partial" }],
    },
    {
      streamId: "tool-x",
      kind: "tool",
      toolCallId: "tx",
      name: "read",
      input: {},
    },
  ];
  const withLive = entriesToDisplayMessages(entries, streaming);
  const live = withLive[withLive.length - 1]!;
  assert.equal(
    live.streaming,
    true,
    "streaming overlay message is marked streaming",
  );
  assert.ok(
    live.blocks.some((b) => b.kind === "text") &&
      live.blocks.some((b) => b.kind === "tool"),
    "overlay has partial text + open tool block",
  );

  const activeDurableTool = entriesToDisplayMessages(entries.slice(0, 2), [
    {
      streamId: "tool-tc1",
      kind: "tool",
      toolCallId: "tc1",
      name: "bash",
      input: { cmd: "ls" },
      output: "still running",
      done: false,
    },
  ]);
  assert.equal(
    activeDurableTool.length,
    2,
    "live tool stream merges into its durable assistant block instead of duplicating a fallback row",
  );
  const activeToolBlock = activeDurableTool[1]!.blocks.find(
    (b) => b.kind === "tool",
  ) as { output: string; done: boolean };
  assert.equal(
    activeToolBlock.output,
    "still running",
    "durable tool block gets live output while awaiting the toolResult entry",
  );
  assert.equal(
    activeToolBlock.done,
    false,
    "durable tool block keeps the live running state",
  );
  assert.equal(
    activeDurableTool[1]!.streaming,
    true,
    "durable assistant message is marked streaming while its tool is live",
  );

  const completedDurableTool = entriesToDisplayMessages(entries.slice(0, 2), [
    {
      streamId: "tool-tc1",
      kind: "tool",
      toolCallId: "tc1",
      name: "bash",
      input: { cmd: "ls" },
      output: "done",
      done: true,
    },
  ]);
  const completedToolBlock = completedDurableTool[1]!.blocks.find(
    (b) => b.kind === "tool",
  ) as { output: string; done: boolean };
  assert.equal(
    completedToolBlock.done,
    true,
    "live toolEnd status stops the durable tool spinner before the durable result folds in",
  );

  // Regression: a tool call that opened BEFORE later text must render at its true
  // position (above the text), not appended after it. The message stream content
  // carries the toolCall block in order; the tool stream supplies live output,
  // merged by id (not duplicated as a trailing block).
  const ordered: StreamingEntry[] = [
    {
      streamId: "s2",
      kind: "message",
      role: "assistant",
      content: [
        { type: "toolCall", toolCallId: "tc9", name: "calendar", input: {} },
        { type: "text", text: "Today you have…" },
      ],
    },
    {
      streamId: "stream-tc9",
      kind: "tool",
      toolCallId: "tc9",
      name: "calendar",
      input: {},
      output: "519 lines",
      done: true,
    },
  ];
  const liveOrdered = entriesToDisplayMessages([], ordered).at(-1)!;
  const kinds = liveOrdered.blocks.map((b) => b.kind);
  assert.deepEqual(
    kinds,
    ["tool", "text"],
    "toolCall renders ABOVE the later streamed text (true arrival order)",
  );
  const toolB = liveOrdered.blocks[0] as { output: string; done: boolean };
  assert.equal(
    toolB.output,
    "519 lines",
    "live tool output merged into the in-content toolCall block",
  );
  assert.equal(
    toolB.done,
    true,
    "live toolEnd (done) merged — spinner stops without a duplicate trailing block",
  );

  // A durable host-command card (/commit) renders as a standalone commit message,
  // keyed by the synthetic turn id — this is the reconnect/migration re-render.
  const withCommit = entriesToDisplayMessages([
    entries[0]!,
    {
      id: "cmd0",
      seq: 5,
      createdAt: "t",
      type: "command.result",
      name: "commit",
      card: {
        kind: "commit",
        id: "syn9",
        commit: { renderKind: "commit", commitHash: "deadbee" } as never,
      },
    },
  ]);
  const commitMsg = withCommit.find((m) => m.id === "cmd0");
  assert.ok(
    commitMsg,
    "host-command entry projects to a message keyed by its timeline entry id",
  );
  assert.equal(commitMsg!.blocks[0]!.kind, "commit", "renders a commit block");
});

/* --------------------- scripted seam for the gateway run ----------------- */
const TOOL_ID = "toolu_abc";
function scripted(): ClaudeSdkMessage[] {
  const stream = (event: unknown): ClaudeSdkMessage =>
    ({
      type: "stream_event",
      event,
      parent_tool_use_id: null,
      uuid: `e${Math.random()}`,
      session_id: "s1",
    }) as unknown as ClaudeSdkMessage;
  return [
    stream({ type: "message_start", message: { id: "m1" } }),
    stream({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Read" },
    }),
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "ing" },
    }),
    stream({ type: "content_block_stop", index: 0 }),
    {
      type: "assistant",
      uuid: "a1",
      session_id: "s1",
      message: {
        id: "m1",
        model: "claude-sonnet-4-6",
        content: [
          { type: "text", text: "Reading" },
          { type: "tool_use", id: TOOL_ID, name: "Read", input: { p: "/x" } },
        ],
        usage: { input_tokens: 1 },
      },
    } as unknown as ClaudeSdkMessage,
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
            tool_use_id: TOOL_ID,
            content: "file",
            is_error: false,
          },
        ],
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
function fakeSeam(messages: ClaudeSdkMessage[]): ClaudeSdkSeam {
  return {
    query: (_p: ClaudeQueryParams) => ({
      async *[Symbol.asyncIterator]() {
        for (const m of messages) yield m;
      },
    }),
  };
}
const stubState = () => ({ sessionId: "cs" }) as unknown as SessionState;
const stubContext = () => ({ sessionId: "cs" }) as unknown as ContextInfo;

/* --------------------- 2. gateway: native snapshot + event relay --------- */
test("gateway: native snapshot + event relay, then a reconnect snapshot carries the timeline", async () => {
  const runtime = new SessionRuntime(new SessionLogStore(true));
  const session = new ClaudeSdkSession("cs", {
    seam: async () => fakeSeam(scripted()),
  });
  runtime.createSession("cs", session.createRuntimeAdapter());
  const sent: ServerMessage[] = [];
  const transport = new RuntimeTransport(
    "cs",
    runtime.get("cs")!,
    { send: (m) => sent.push(m) },
    { buildState: stubState, buildContextInfo: stubContext },
  );
  transport.attach();

  const first = sent[0];
  assert.ok(
    first?.type === "snapshot" && first.snapshot,
    "first envelope is the atomic native snapshot",
  );
  assert.equal(
    "isStreaming" in first.state,
    false,
    "snapshot SessionState omits run-state; snapshot.runState is authoritative",
  );

  await runtime.prompt("cs", "read x", { clientRequestId: "req-9" });

  const events = sent
    .filter(
      (m): m is Extract<ServerMessage, { type: "event" }> => m.type === "event",
    )
    .map((m) => m.event);
  const types = events.map((e) => e.type);
  const deltaEntries = (role: string) =>
    events.filter(
      (e): e is Extract<typeof e, { type: "timelineDelta" }> =>
        e.type === "timelineDelta" &&
        e.entries.some(
          (entry) => entry.type === "message" && entry.role === role,
        ),
    );
  // The user entry echoes the clientRequestId (optimistic reconciliation).
  const userDelta = deltaEntries("user")[0];
  assert.ok(
    userDelta && userDelta.clientRequestId === "req-9",
    "user timelineDelta echoes the clientRequestId",
  );
  assert.ok(types.includes("messageStarted"), "messageStarted emitted");
  const deltas = events.filter(
    (e): e is Extract<typeof e, { type: "messageDelta" }> =>
      e.type === "messageDelta",
  );
  assert.equal(
    deltas.length,
    1,
    "adjacent messageDelta events for the same stream/kind are coalesced",
  );
  assert.equal(
    deltas[0]!.delta.text,
    "Reading",
    "coalesced messageDelta preserves concatenated text",
  );
  assert.ok(
    types.indexOf("messageDelta") < types.indexOf("toolStarted"),
    "pending delta flushes before the following terminal/non-delta event",
  );
  assert.ok(types.includes("toolStarted"), "toolStarted emitted");
  assert.ok(types.includes("messageCompleted"), "messageCompleted emitted");
  assert.ok(types.includes("runStateChanged"), "runStateChanged emitted");
  assert.ok(
    !sent.some((m) => m.type === "state"),
    "run-state changes do not emit competing full state envelopes",
  );
  assert.ok(
    deltaEntries("assistant").length > 0,
    "durable assistant entry appended",
  );
  assert.ok(
    deltaEntries("toolResult").length > 0,
    "durable toolResult entry appended",
  );
  // The live toolEnd reaches the viewer as the COMPACT `toolEnded` BEFORE the
  // durable assistant entry, so the tool's spinner stops the moment it finishes
  // (not at turn end) — without its output, which the durable row carries.
  const endedIdx = events.findIndex((e) => e.type === "toolEnded");
  const asstIdx = events.findIndex(
    (e) =>
      e.type === "timelineDelta" &&
      e.entries.some(
        (entry) => entry.type === "message" && entry.role === "assistant",
      ),
  );
  assert.ok(endedIdx >= 0, "live toolEnd forwarded as toolEnded");
  assert.ok(
    endedIdx < asstIdx,
    "toolEnded precedes the durable assistant entry",
  );
  assert.ok(
    !events.some(
      (e) => e.type === "passthrough" && e.envelope.type === "toolEnd",
    ),
    "the toolEnd envelope itself never passes through",
  );
  const ended = events[endedIdx] as Extract<
    (typeof events)[number],
    { type: "toolEnded" }
  >;
  assert.deepEqual(
    ended.output,
    {
      streamId: TOOL_ID,
      blockIndex: 0,
      kind: "toolOutput",
      length: "file".length,
      lineCount: 1,
    },
    "toolEnded carries the output's size, not the output",
  );

  /* ----------------- 3. reconnect: fresh native snapshot has the timeline -- */
  const sent2: ServerMessage[] = [];
  const reconnect = new RuntimeTransport(
    "cs",
    runtime.get("cs")!,
    { send: (m) => sent2.push(m) },
    { buildState: stubState, buildContextInfo: stubContext },
  );
  reconnect.attach();
  const snap = sent2[0];
  assert.ok(
    snap?.type === "snapshot" && snap.snapshot,
    "reconnect gets a native snapshot",
  );
  const timeline = (snap as Extract<ServerMessage, { type: "snapshot" }>)
    .snapshot!.timeline;
  assert.deepEqual(
    timeline.map((e) => (e.type === "command.result" ? "command" : e.role)),
    ["user", "assistant", "toolResult"],
    "reconnect timeline has durable user + assistant + toolResult entries",
  );
  // Projecting that timeline folds the tool result into the assistant message.
  const projected = entriesToDisplayMessages(timeline);
  const toolBlock = projected[1]!.blocks.find((b) => b.kind === "tool") as {
    output: string;
    done: boolean;
  };
  assert.equal(
    toolBlock.done,
    true,
    "projection shows the completed tool with output",
  );
  assert.equal(toolBlock.output, "file");

  const prefix = timeline.slice(0, 2);
  const sent3: ServerMessage[] = [];
  const deltaReconnect = new RuntimeTransport(
    "cs",
    runtime.get("cs")!,
    { send: (m) => sent3.push(m) },
    {
      buildState: stubState,
      buildContextInfo: stubContext,
      timelineCache: describeTimelineCache(prefix),
    },
  );
  deltaReconnect.attach();
  const deltaSnapshot = sent3[0];
  assert.ok(
    deltaSnapshot?.type === "snapshot",
    "cache-aware reconnect gets a snapshot envelope",
  );
  assert.equal(
    deltaSnapshot.snapshot.timelineStart,
    2,
    "matching cached range is omitted",
  );
  assert.deepEqual(
    deltaSnapshot.snapshot.timeline.map((entry) => entry.id),
    timeline.slice(2).map((entry) => entry.id),
    "only the append-only tail crosses the wire",
  );
  assert.equal(
    deltaSnapshot.snapshot.totalEntryCount,
    timeline.length,
    "the snapshot states what the whole timeline holds",
  );
  assert.deepEqual(
    deltaSnapshot.snapshot.timelineCache,
    describeTimelineCache(timeline),
    "response anchors the reconstructed complete timeline",
  );

  const sent4: ServerMessage[] = [];
  new RuntimeTransport(
    "cs",
    runtime.get("cs")!,
    { send: (m) => sent4.push(m) },
    {
      buildState: stubState,
      buildContextInfo: stubContext,
      timelineCache: describeTimelineCache(timeline),
    },
  ).attach();
  const unchangedSnapshot = sent4[0];
  assert.ok(unchangedSnapshot?.type === "snapshot");
  assert.equal(
    unchangedSnapshot.snapshot.timelineStart,
    timeline.length,
    "an unchanged repeat load accepts the complete cached range",
  );
  assert.equal(
    unchangedSnapshot.snapshot.timeline.length,
    0,
    "an unchanged repeat load transfers no durable timeline entries",
  );

  await runtime.dispose();
});

/* --------- 4. config changes still refresh full SessionState metadata ----- */
test("config changes still refresh full SessionState metadata", async () => {
  const runtime = new SessionRuntime(new SessionLogStore(true));
  let listener: ((event: unknown) => void) | undefined;
  const adapter = {
    provider: "fake",
    capabilities: { fork: "none", compact: false, attachments: false },
    subscribe(fn: (event: unknown) => void) {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    getBinding() {
      return { provider: "fake" };
    },
    async prompt() {
      listener?.({ type: "runCompleted", stopReason: "end" });
      return { stopReason: "end" };
    },
    abort() {},
    setModel() {},
    async setReasoning() {},
    dispose() {},
  };
  const session = runtime.createSession("cfg", adapter as never);
  const sent: ServerMessage[] = [];
  const transport = new RuntimeTransport(
    "cfg",
    session,
    { send: (m) => sent.push(m) },
    {
      buildState: () => ({ sessionId: "cfg" }) as unknown as SessionState,
      buildContextInfo: stubContext,
    },
  );
  transport.attach();

  await session.setReasoning("high");
  const events = sent
    .filter(
      (m): m is Extract<ServerMessage, { type: "event" }> => m.type === "event",
    )
    .map((m) => m.event.type);
  assert.ok(events.includes("sessionConfigChanged"), "config event emitted");
  const stateEnvelope = sent.find(
    (m): m is Extract<ServerMessage, { type: "state" }> => m.type === "state",
  );
  assert.ok(
    stateEnvelope,
    "config changes still emit full SessionState metadata",
  );
  assert.equal(
    "isStreaming" in stateEnvelope.state,
    false,
    "state metadata omits run-state",
  );

  await runtime.dispose();
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
