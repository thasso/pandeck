/**
 * The reducer's side of live-body delivery: compact refs render collapsed
 * rows, subscribed text hydrates the block it names, and a durable row carries
 * a hydrated body over instead of flashing back to its preview.
 */
import type {
  ContextInfo,
  ServerMessage,
  SessionState,
} from "@assistant/shared";
import type { ClientRuntimeEvent } from "@assistant/shared/runtime";
import { bodyContentHash } from "@assistant/shared/session";
import { describe, expect, it } from "vitest";
import { changedOperationKinds } from "../components/TaskManageToolCard.tsx";
import { toolBlockIsVisible } from "../components/tools/registry.tsx";
import { createInitialState, reduceAssistantState } from "./useAssistant.ts";

const session = (): SessionState => ({
  sessionId: "s1",
  harness: "pi",
  agentType: "assistant",
  thinkingLevel: "off",
});

const contextInfo = (): ContextInfo => ({
  sessionId: "s1",
  updatedAt: 1,
  messageCounts: {
    user: 0,
    assistant: 0,
    toolCalls: 0,
    toolResults: 0,
    total: 0,
  },
  tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: 0,
});

function apply(msg: ServerMessage, state = createInitialState()) {
  return reduceAssistantState(state, { kind: "server", msg });
}

function event(event: ClientRuntimeEvent): ServerMessage {
  return { type: "event", sessionId: "s1", event };
}

function viewing() {
  return apply({
    type: "snapshot",
    state: session(),
    contextInfo: contextInfo(),
    snapshot: {
      sessionId: "s1",
      runState: "running",
      timeline: [],
      timelineStart: 0,
      totalEntryCount: 0,
      streaming: [],
    },
  });
}

function liveBlocks(state: ReturnType<typeof apply>) {
  return state.messages.find((m) => m.id === "live")?.blocks ?? [];
}

describe("live body delivery in the reducer", () => {
  it("renders a thinking block from its ref alone, then hydrates it in order", () => {
    let state = viewing();
    state = apply(event({ type: "messageStarted", streamId: "m1" }), state);
    state = apply(
      event({
        type: "liveBodyProgress",
        ref: { streamId: "m1", blockIndex: 0, kind: "thinking", length: 5 },
      }),
      state,
    );
    expect(liveBlocks(state)).toEqual([
      {
        kind: "thinking",
        text: "",
        live: { streamId: "m1", blockIndex: 0, kind: "thinking", length: 5 },
      },
    ]);

    const key = { streamId: "m1", blockIndex: 0, kind: "thinking" as const };
    state = apply(
      event({
        type: "liveBody",
        key,
        mode: "replace",
        offset: 0,
        content: "hello",
        length: 5,
      }),
      state,
    );
    state = apply(
      event({
        type: "liveBody",
        key,
        mode: "append",
        offset: 5,
        content: " world",
        length: 11,
        lineCount: 2,
      }),
      state,
    );
    // A frame that does not continue what is held is dropped, not spliced.
    state = apply(
      event({
        type: "liveBody",
        key,
        mode: "append",
        offset: 3,
        content: "zzz",
        length: 6,
      }),
      state,
    );
    expect(liveBlocks(state)[0]).toMatchObject({
      text: "hello world",
      live: { length: 11, lineCount: 2 },
    });

    // Text deltas after the thinking block open a text block behind it.
    state = apply(
      event({
        type: "messageDelta",
        streamId: "m1",
        delta: { kind: "text", text: "Answer" },
      }),
      state,
    );
    expect(liveBlocks(state).map((b) => b.kind)).toEqual(["thinking", "text"]);
  });

  it("carries a fully hydrated live body onto the durable row and leaves the rest lazy", () => {
    let state = viewing();
    const thinking = "t".repeat(600);
    state = apply(event({ type: "messageStarted", streamId: "m1" }), state);
    state = apply(
      event({
        type: "liveBody",
        key: { streamId: "m1", blockIndex: 0, kind: "thinking" },
        mode: "replace",
        offset: 0,
        content: thinking,
        length: 600,
      }),
      state,
    );
    // A frame names a block that progress created; before that it is dropped.
    expect(liveBlocks(state)).toEqual([]);
    state = apply(
      event({
        type: "liveBodyProgress",
        ref: { streamId: "m1", blockIndex: 0, kind: "thinking", length: 600 },
      }),
      state,
    );
    state = apply(
      event({
        type: "liveBody",
        key: { streamId: "m1", blockIndex: 0, kind: "thinking" },
        mode: "replace",
        offset: 0,
        content: thinking,
        length: 600,
      }),
      state,
    );
    state = apply(
      event({
        type: "liveBodyProgress",
        ref: { streamId: "m1", blockIndex: 1, kind: "thinking", length: 3 },
      }),
      state,
    );
    state = apply(event({ type: "messageCompleted", streamId: "m1" }), state);
    state = apply(
      event({
        type: "timelineDelta",
        entries: [
          {
            id: "a1",
            seq: 1,
            createdAt: "t",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "thinking",
                text: thinking.slice(0, 240),
                lazy: {
                  entryId: "a1",
                  blockIndex: 0,
                  kind: "thinking",
                  fullLength: 600,
                  previewLength: 240,
                  contentHash: bodyContentHash(thinking),
                },
              },
              {
                type: "thinking",
                text: "abc",
                lazy: {
                  entryId: "a1",
                  blockIndex: 1,
                  kind: "thinking",
                  fullLength: 3,
                  previewLength: 1,
                },
              },
            ],
          },
        ],
      }),
      state,
    );
    expect(state.liveStreams).toEqual([]);
    const entry = state.timeline[0];
    if (entry?.type !== "message" || entry.role !== "assistant")
      throw new Error("no assistant entry");
    // Hydrated live text replaces the preview; the never-hydrated block stays lazy.
    expect(entry.content[0]).toEqual({ type: "thinking", text: thinking });
    expect(entry.content[1]).toMatchObject({ lazy: { fullLength: 3 } });
  });

  it("keeps hydrated timeline bodies when a later durable correction is compact", () => {
    let state = viewing();
    const thinking = "t".repeat(600);
    const input = { file_path: "/x", content: "c".repeat(900) };
    state = apply(
      event({
        type: "timelineDelta",
        entries: [
          {
            id: "a1",
            seq: 1,
            createdAt: "t",
            type: "message",
            role: "assistant",
            content: [
              { type: "thinking", text: thinking },
              { type: "toolCall", toolCallId: "t1", name: "write", input },
            ],
          },
        ],
      }),
      state,
    );

    state = apply(
      event({
        type: "timelineDelta",
        entries: [
          {
            id: "a1",
            seq: 1,
            createdAt: "t",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "thinking",
                text: thinking.slice(0, 240),
                lazy: {
                  entryId: "a1",
                  blockIndex: 0,
                  kind: "thinking",
                  fullLength: thinking.length,
                  previewLength: 240,
                  contentHash: bodyContentHash(thinking),
                },
              },
              {
                type: "toolCall",
                toolCallId: "t1",
                name: "write",
                input: { file_path: "/x" },
                inputSummary: "/x",
                inputLazy: {
                  entryId: "a1",
                  blockIndex: 1,
                  kind: "toolInput",
                  fullLength: JSON.stringify(input).length,
                  previewLength: JSON.stringify({ file_path: "/x" }).length,
                  contentHash: bodyContentHash(JSON.stringify(input)),
                },
              },
            ],
          },
        ],
      }),
      state,
    );

    const entry = state.timeline[0];
    if (entry?.type !== "message" || entry.role !== "assistant")
      throw new Error("no assistant entry");
    expect(entry.content).toEqual([
      { type: "thinking", text: thinking },
      { type: "toolCall", toolCallId: "t1", name: "write", input },
    ]);
  });

  it("replaces subscribed bodies with authoritative rich-card completion data", () => {
    let state = viewing();
    state = apply(event({ type: "messageStarted", streamId: "m1" }), state);
    const compactTaskInput = { summary: "Object(operations)" };
    state = apply(
      event({
        type: "toolStarted",
        streamId: "task",
        toolCallId: "task",
        name: "task_manage",
        input: compactTaskInput,
        inputLive: {
          streamId: "task",
          blockIndex: 0,
          kind: "toolInput",
          length: 900,
        },
      }),
      state,
    );
    state = apply(
      event({
        type: "liveBody",
        key: { streamId: "task", blockIndex: 0, kind: "toolOutput" },
        mode: "replace",
        offset: 0,
        content: "stale partial output",
        length: 20,
      }),
      state,
    );
    const taskInput = { operations: [{ operation: "create", title: "Card" }] };
    const taskOutput = JSON.stringify({
      renderKind: "taskManage",
      changed: [{ id: "1", title: "Card", status: "todo" }],
    });
    state = apply(
      event({
        type: "toolEnded",
        streamId: "task",
        isError: false,
        output: taskOutput,
        card: true,
        input: taskInput,
      }),
      state,
    );
    expect(
      state.liveStreams.find(
        (stream) => stream.kind === "tool" && stream.streamId === "task",
      ),
    ).toMatchObject({
      input: taskInput,
      output: taskOutput,
      done: true,
      isError: false,
    });
    const task = state.liveStreams.find(
      (stream) => stream.kind === "tool" && stream.streamId === "task",
    );
    expect(task?.kind === "tool" && task.inputLive).toBeUndefined();
    expect(task?.kind === "tool" && task.outputLive).toBeUndefined();
    const message = state.liveStreams.find(
      (stream) => stream.kind === "message" && stream.streamId === "m1",
    );
    expect(message?.kind === "message" && message.content[0]).toEqual({
      type: "toolCall",
      toolCallId: "task",
      name: "task_manage",
      input: taskInput,
    });

    state = apply(
      event({
        type: "toolStarted",
        streamId: "files",
        toolCallId: "files",
        name: "show_files",
        input: { summary: "Object(paths)" },
        inputLive: {
          streamId: "files",
          blockIndex: 0,
          kind: "toolInput",
          length: 800,
        },
      }),
      state,
    );
    const filesOutput = JSON.stringify({
      renderKind: "showFiles",
      card: { files: [{ url: "/api/files/tmp/a", name: "a", label: "a" }] },
    });
    state = apply(
      event({
        type: "toolEnded",
        streamId: "files",
        isError: false,
        output: filesOutput,
        card: true,
      }),
      state,
    );
    const files = state.liveStreams.find(
      (stream) => stream.kind === "tool" && stream.streamId === "files",
    );
    expect(files).toMatchObject({ output: filesOutput, done: true });
    expect(files?.kind === "tool" && files.inputLive).toBeUndefined();
    expect(files?.kind === "tool" && files.outputLive).toBeUndefined();
  });

  it("tracks a tool through compact start, ended, and durable result", () => {
    let state = viewing();
    state = apply(event({ type: "messageStarted", streamId: "m1" }), state);
    state = apply(
      event({
        type: "toolStarted",
        streamId: "t1",
        toolCallId: "t1",
        name: "bash",
        input: { command: "ls" },
      }),
      state,
    );
    let tool = liveBlocks(state).find((b) => b.kind === "tool");
    expect(tool).toMatchObject({
      kind: "tool",
      done: false,
      output: "",
      outputLive: { streamId: "t1", kind: "toolOutput", length: 0 },
    });
    state = apply(
      event({
        type: "liveBodyProgress",
        ref: { streamId: "t1", blockIndex: 0, kind: "toolOutput", length: 9 },
      }),
      state,
    );
    state = apply(
      event({
        type: "toolEnded",
        streamId: "t1",
        isError: true,
        output: {
          streamId: "t1",
          blockIndex: 0,
          kind: "toolOutput",
          length: 40,
          lineCount: 3,
        },
      }),
      state,
    );
    tool = liveBlocks(state).find((b) => b.kind === "tool");
    expect(tool).toMatchObject({
      done: true,
      isError: true,
      output: "",
      outputLive: { length: 40, lineCount: 3 },
    });
    // Hydrate the output, then let the durable rows land.
    const output = "a".repeat(40);
    state = apply(
      event({
        type: "liveBody",
        key: { streamId: "t1", blockIndex: 0, kind: "toolOutput" },
        mode: "replace",
        offset: 0,
        content: output,
        length: 40,
      }),
      state,
    );
    state = apply(event({ type: "messageCompleted", streamId: "m1" }), state);
    state = apply(
      event({
        type: "timelineDelta",
        entries: [
          {
            id: "a1",
            seq: 1,
            createdAt: "t",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "toolCall",
                toolCallId: "t1",
                name: "bash",
                input: { command: "ls" },
              },
            ],
          },
        ],
      }),
      state,
    );
    state = apply(event({ type: "toolCompleted", streamId: "t1" }), state);
    state = apply(
      event({
        type: "timelineDelta",
        entries: [
          {
            id: "r1",
            seq: 2,
            createdAt: "t",
            type: "message",
            role: "toolResult",
            toolCallId: "t1",
            isError: true,
            content: [
              {
                type: "text",
                text: output.slice(0, 10),
                lazy: {
                  entryId: "r1",
                  blockIndex: 0,
                  kind: "toolOutput",
                  fullLength: 40,
                  previewLength: 10,
                  contentHash: bodyContentHash(output),
                  lineCount: 3,
                },
              },
            ],
          },
        ],
      }),
      state,
    );
    expect(state.liveStreams).toEqual([]);
    const result = state.timeline[1];
    if (result?.type !== "message" || result.role !== "toolResult")
      throw new Error("no result");
    expect(result.content[0]).toEqual({ type: "text", text: output });
    const block = state.messages[0]?.blocks[0];
    expect(block).toMatchObject({
      kind: "tool",
      done: true,
      isError: true,
      output,
    });
  });

  it("does not carry same-length stale live bodies over a durable correction", () => {
    let state = viewing();
    const liveOutput = "a".repeat(40);
    const persistedOutput = "b".repeat(40);
    state = apply(event({ type: "messageStarted", streamId: "m1" }), state);
    state = apply(
      event({
        type: "toolStarted",
        streamId: "t1",
        toolCallId: "t1",
        name: "bash",
        input: { command: "ls" },
      }),
      state,
    );
    state = apply(
      event({
        type: "liveBodyProgress",
        ref: { streamId: "t1", blockIndex: 0, kind: "toolOutput", length: 40 },
      }),
      state,
    );
    state = apply(
      event({
        type: "liveBody",
        key: { streamId: "t1", blockIndex: 0, kind: "toolOutput" },
        mode: "replace",
        offset: 0,
        content: liveOutput,
        length: 40,
      }),
      state,
    );
    state = apply(event({ type: "toolCompleted", streamId: "t1" }), state);
    state = apply(
      event({
        type: "timelineDelta",
        entries: [
          {
            id: "r1",
            seq: 1,
            createdAt: "t",
            type: "message",
            role: "toolResult",
            toolCallId: "t1",
            content: [
              {
                type: "text",
                text: persistedOutput.slice(0, 10),
                lazy: {
                  entryId: "r1",
                  blockIndex: 0,
                  kind: "toolOutput",
                  fullLength: 40,
                  previewLength: 10,
                  contentHash: bodyContentHash(persistedOutput),
                },
              },
            ],
          },
        ],
      }),
      state,
    );
    const result = state.timeline[0];
    if (result?.type !== "message" || result.role !== "toolResult")
      throw new Error("no result");
    expect(result.content[0]).toMatchObject({
      text: persistedOutput.slice(0, 10),
    });
    expect(result.content[0]).not.toMatchObject({ text: liveOutput });
  });

  it("hydrates a summarized tool input wherever the call is declared", () => {
    let state = viewing();
    const input = { file_path: "/x", content: "c".repeat(900) };
    state = apply(event({ type: "messageStarted", streamId: "m1" }), state);
    state = apply(
      event({
        type: "toolStarted",
        streamId: "t1",
        toolCallId: "t1",
        name: "write",
        input: { file_path: "/x" },
        inputSummary: "/x",
        inputLive: {
          streamId: "t1",
          blockIndex: 0,
          kind: "toolInput",
          length: 930,
        },
      }),
      state,
    );
    expect(liveBlocks(state)[0]).toMatchObject({
      kind: "tool",
      args: { file_path: "/x" },
      argsSummary: "/x",
      argsLive: { kind: "toolInput" },
    });
    state = apply(
      event({
        type: "liveBody",
        key: { streamId: "t1", blockIndex: 0, kind: "toolInput" },
        mode: "replace",
        offset: 0,
        content: input,
        length: 930,
      }),
      state,
    );
    const block = liveBlocks(state)[0];
    expect(block).toMatchObject({ kind: "tool", args: input });
    expect(
      block && "argsLive" in block ? block.argsLive : undefined,
    ).toBeUndefined();
    for (const s of state.liveStreams) {
      if (s.kind === "tool") expect(s.input).toEqual(input);
      else expect(s.content[0]).toMatchObject({ type: "toolCall", input });
    }
    // Its durable row arrives summarized (same lazy policy as a reload); the
    // hydrated input carries over because a whole input never changes.
    state = apply(event({ type: "messageCompleted", streamId: "m1" }), state);
    state = apply(
      event({
        type: "timelineDelta",
        entries: [
          {
            id: "a1",
            seq: 1,
            createdAt: "t",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "toolCall",
                toolCallId: "t1",
                name: "write",
                input: { file_path: "/x" },
                inputSummary: "/x",
                inputLazy: {
                  entryId: "a1",
                  blockIndex: 0,
                  kind: "toolInput",
                  fullLength: 930,
                  previewLength: 20,
                  contentHash: bodyContentHash(JSON.stringify(input)),
                },
              },
            ],
          },
        ],
      }),
      state,
    );
    const entry = state.timeline[0];
    if (entry?.type !== "message" || entry.role !== "assistant")
      throw new Error("no assistant entry");
    expect(entry.content[0]).toEqual({
      type: "toolCall",
      toolCallId: "t1",
      name: "write",
      input,
    });
  });

  // The pair the review found: same length, identical under the 32-bit
  // checksum the identity used before. Under SHA-256 they differ, so a stale
  // body is never mistaken for the persisted one — at the live handoff or on a
  // later correction — and the lazy ref stays as the way to the real body.
  const COLLIDING_LIVE = "Vv-Q(F%10SDJ";
  const COLLIDING_PERSISTED = "3p/b1IB-*Ejm";

  it("does not carry a live body whose old-checksum twin is what got persisted", () => {
    let state = viewing();
    state = apply(event({ type: "messageStarted", streamId: "m1" }), state);
    state = apply(
      event({
        type: "liveBodyProgress",
        ref: { streamId: "m1", blockIndex: 0, kind: "thinking", length: 12 },
      }),
      state,
    );
    state = apply(
      event({
        type: "liveBody",
        key: { streamId: "m1", blockIndex: 0, kind: "thinking" },
        mode: "replace",
        offset: 0,
        content: COLLIDING_LIVE,
        length: 12,
      }),
      state,
    );
    state = apply(event({ type: "messageCompleted", streamId: "m1" }), state);
    const lazy = {
      entryId: "a1",
      blockIndex: 0,
      kind: "thinking" as const,
      fullLength: 12,
      previewLength: 4,
      contentHash: bodyContentHash(COLLIDING_PERSISTED),
    };
    state = apply(
      event({
        type: "timelineDelta",
        entries: [
          {
            id: "a1",
            seq: 1,
            createdAt: "t",
            type: "message",
            role: "assistant",
            content: [
              { type: "thinking", text: COLLIDING_PERSISTED.slice(0, 4), lazy },
            ],
          },
        ],
      }),
      state,
    );
    const entry = state.timeline[0];
    if (entry?.type !== "message" || entry.role !== "assistant")
      throw new Error("no assistant entry");
    expect(entry.content[0]).toEqual({
      type: "thinking",
      text: COLLIDING_PERSISTED.slice(0, 4),
      lazy,
    });
  });

  it("does not preserve a hydrated body over a correction that persisted its old-checksum twin", () => {
    let state = viewing();
    const durable = (content: unknown[]) =>
      event({
        type: "timelineDelta",
        entries: [
          {
            id: "a1",
            seq: 1,
            createdAt: "t",
            type: "message",
            role: "assistant",
            content: content as never,
          },
        ],
      });
    state = apply(durable([{ type: "thinking", text: COLLIDING_LIVE }]), state);
    const lazy = {
      entryId: "a1",
      blockIndex: 0,
      kind: "thinking" as const,
      fullLength: 12,
      previewLength: 4,
      contentHash: bodyContentHash(COLLIDING_PERSISTED),
    };
    state = apply(
      durable([
        { type: "thinking", text: COLLIDING_PERSISTED.slice(0, 4), lazy },
      ]),
      state,
    );
    const entry = state.timeline[0];
    if (entry?.type !== "message" || entry.role !== "assistant")
      throw new Error("no assistant entry");
    expect(entry.content[0]).toEqual({
      type: "thinking",
      text: COLLIDING_PERSISTED.slice(0, 4),
      lazy,
    });
    // The same correction WITH the body this viewer holds is preserved.
    state = apply(durable([{ type: "thinking", text: COLLIDING_LIVE }]), state);
    state = apply(
      durable([
        {
          type: "thinking",
          text: COLLIDING_LIVE.slice(0, 4),
          lazy: { ...lazy, contentHash: bodyContentHash(COLLIDING_LIVE) },
        },
      ]),
      state,
    );
    const kept = state.timeline[0];
    if (kept?.type !== "message" || kept.role !== "assistant")
      throw new Error("no assistant entry");
    expect(kept.content[0]).toEqual({ type: "thinking", text: COLLIDING_LIVE });
  });

  it("renders a completed Task card with its operation verbs straight from a mid-turn reconnect snapshot", () => {
    const operations = [
      {
        operation: "create",
        title: "Keep the card visible",
        description: "x".repeat(900),
      },
    ];
    const output = JSON.stringify({
      renderKind: "taskManage",
      changed: [{ id: "697", title: "Keep the card visible", status: "todo" }],
    });
    for (const name of ["task_manage", "mcp__pa__task_manage"]) {
      // What the transport sends on a mid-turn attach: the declaring message
      // stream summarized as it was when the call opened, the completed tool
      // stream carrying the card's exact arguments (`projectToolStream`).
      const state = apply({
        type: "snapshot",
        state: session(),
        contextInfo: contextInfo(),
        snapshot: {
          sessionId: "s1",
          runState: "running",
          timeline: [],
          timelineStart: 0,
          totalEntryCount: 0,
          streaming: [
            {
              streamId: "m1",
              kind: "message",
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  toolCallId: "task",
                  name,
                  input: { summary: "Object(operations)" },
                  inputSummary: "Object(operations)",
                  inputLive: {
                    streamId: "task",
                    blockIndex: 0,
                    kind: "toolInput",
                    length: 1_000,
                  },
                },
              ],
            },
            {
              streamId: "task",
              kind: "tool",
              toolCallId: "task",
              name,
              input: { operations },
              output,
              done: true,
            },
          ],
        },
      });
      const block = liveBlocks(state)[0];
      if (block?.kind !== "tool") throw new Error("no tool block");
      expect(block).toMatchObject({ args: { operations }, output, done: true });
      expect("argsLive" in block).toBe(false);
      // The card shows with tools hidden and can name what each operation did.
      expect(toolBlockIsVisible(block, false)).toBe(true);
      expect(changedOperationKinds(block.args, 1)).toEqual(["create"]);
    }
  });

  it("counts every applied snapshot, which is what re-declares demand after a switch or reconnect", () => {
    let state = viewing();
    expect(state.snapshotGeneration).toBe(1);
    state = apply(
      {
        type: "snapshot",
        state: session(),
        contextInfo: contextInfo(),
        snapshot: {
          sessionId: "s1",
          runState: "idle",
          timeline: [],
          timelineStart: 0,
          totalEntryCount: 0,
          streaming: [],
        },
      },
      state,
    );
    expect(state.snapshotGeneration).toBe(2);
    state = apply(
      event({ type: "runStateChanged", runState: "running" }),
      state,
    );
    expect(state.snapshotGeneration).toBe(2);
  });

  it("ignores body frames for a session that is not viewed", () => {
    let state = viewing();
    state = apply(event({ type: "messageStarted", streamId: "m1" }), state);
    state = apply(
      {
        type: "event",
        sessionId: "other",
        event: {
          type: "liveBodyProgress",
          ref: { streamId: "m1", blockIndex: 0, kind: "thinking", length: 5 },
        },
      },
      state,
    );
    expect(liveBlocks(state)).toEqual([]);
  });
});
