/**
 * Scripted-seam tests for the Claude SDK adapter + runtime integration. Run
 * through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/session/adapters/claudeSdkAdapter.test.ts
 *
 * Drives multi-block turns through a fake SDK seam and asserts the runtime's
 * normalized projection and abort behavior.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ClaudeQueryParams,
  ClaudeSdkMessage,
  ClaudeSdkSeam,
} from "../../claudeSdk/sdkSeam.ts";

const tmp = mkdtempSync(join(tmpdir(), "claude-sdk-adapter-test-"));
process.env.ASSISTANT_CWD = tmp;

const { SessionRuntime } = await import("../runtime/runtime.ts");
const { SessionLogStore } = await import("../log/store.ts");
const { ClaudeSdkSession } =
  await import("../../claudeSdk/ClaudeSdkSession.ts");

const TOOL_ID = "toolu_abc";
const MSG_ID = "msg_123";

function scriptedMessages(): ClaudeSdkMessage[] {
  const stream = (event: unknown): ClaudeSdkMessage =>
    ({
      type: "stream_event",
      event,
      parent_tool_use_id: null,
      uuid: `evt-${Math.random()}`,
      session_id: "sess-1",
    }) as unknown as ClaudeSdkMessage;
  return [
    stream({
      type: "message_start",
      message: {
        id: MSG_ID,
        usage: { input_tokens: 100, cache_read_input_tokens: 900 },
      },
    }),
    stream({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    }),
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "Let me " },
    }),
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "think." },
    }),
    stream({ type: "content_block_stop", index: 0 }),
    stream({
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "" },
    }),
    stream({
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "Hello " },
    }),
    stream({
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "world" },
    }),
    stream({ type: "content_block_stop", index: 1 }),
    {
      type: "assistant",
      uuid: "asst-1",
      session_id: "sess-1",
      message: {
        id: MSG_ID,
        model: "claude-sonnet-4-6",
        content: [
          { type: "thinking", thinking: "Let me think." },
          { type: "text", text: "Hello world" },
          {
            type: "tool_use",
            id: TOOL_ID,
            name: "Read",
            input: { file_path: "/x.txt" },
          },
        ],
        usage: {
          input_tokens: 100,
          output_tokens: 5,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 200,
        },
      },
    } as unknown as ClaudeSdkMessage,
    {
      type: "user",
      uuid: "user-1",
      session_id: "sess-1",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: TOOL_ID,
            content: "file contents",
            is_error: false,
          },
        ],
      },
    } as unknown as ClaudeSdkMessage,
    {
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      usage: {
        input_tokens: 100,
        output_tokens: 5,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 200,
      },
      total_cost_usd: 0.0123,
      modelUsage: {
        "claude-sonnet-4-6": {
          inputTokens: 100,
          outputTokens: 5,
          contextWindow: 1_000_000,
        },
      },
    } as unknown as ClaudeSdkMessage,
  ];
}

function fakeSeam(messages: ClaudeSdkMessage[]): ClaudeSdkSeam {
  return {
    query(_params: ClaudeQueryParams) {
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of messages) yield m;
        },
      };
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 25; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function abortableSeam(): ClaudeSdkSeam {
  const stream = (event: unknown): ClaudeSdkMessage =>
    ({
      type: "stream_event",
      event,
      parent_tool_use_id: null,
      uuid: `evt-${Math.random()}`,
      session_id: "sess-abort",
    }) as unknown as ClaudeSdkMessage;
  return {
    query(_params: ClaudeQueryParams) {
      let release: (() => void) | undefined;
      const closed = new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        close() {
          release?.();
        },
        async *[Symbol.asyncIterator]() {
          yield stream({ type: "message_start", message: { id: "msg-abort" } });
          yield stream({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          });
          yield stream({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "partial" },
          });
          yield {
            type: "assistant",
            uuid: "asst-abort",
            session_id: "sess-abort",
            message: {
              id: "msg-abort",
              model: "claude-sonnet-4-6",
              content: [
                {
                  type: "tool_use",
                  id: TOOL_ID,
                  name: "Edit",
                  input: { file_path: "/x.txt" },
                },
              ],
            },
          } as unknown as ClaudeSdkMessage;
          yield {
            type: "user",
            uuid: "user-abort",
            session_id: "sess-abort",
            parent_tool_use_id: null,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: TOOL_ID,
                  content: "edited file",
                  is_error: false,
                },
              ],
            },
          } as unknown as ClaudeSdkMessage;
          await closed;
        },
      };
    },
  };
}

/* -------------------- adapter → runtime: normalized projection ----------- */
{
  const runtime = new SessionRuntime(new SessionLogStore(true));
  const session = new ClaudeSdkSession("cs-1", {
    seam: async () => fakeSeam(scriptedMessages()),
  });
  runtime.createSession("cs-1", session.createRuntimeAdapter());

  const events: string[] = [];
  runtime.openSessionStream("cs-1", (e) => events.push(e.type));
  await runtime.prompt("cs-1", "read x", { clientRequestId: "r1" });

  const snap = runtime.get("cs-1")!.getSnapshot();
  assert.equal(snap.runState, "idle", "idle after the turn");
  assert.equal(
    snap.streaming.length,
    0,
    "no transient streams left after the turn",
  );

  const roles = snap.entries.map((e) => e.role);
  assert.deepEqual(
    roles,
    ["user", "assistant", "toolResult"],
    "normalized entries: user, assistant, then tool result",
  );

  const assistant = snap.entries.find((e) => e.role === "assistant")!;
  assert.deepEqual(
    (assistant as { content: Array<{ type: string }> }).content.map(
      (c) => c.type,
    ),
    ["thinking", "text", "toolCall"],
    "assistant entry has thinking + text + toolCall blocks",
  );
  const toolResult = snap.entries.find((e) => e.role === "toolResult") as {
    toolCallId: string;
    content: Array<{ text: string }>;
  };
  assert.equal(toolResult.toolCallId, TOOL_ID, "tool result links by tool id");
  assert.equal(
    toolResult.content[0]?.text,
    "file contents",
    "tool result carries the output",
  );

  // The assistant entry (durable) precedes its tool result (ordering matches the converter).
  assert.ok(
    events.includes("messageStarted") && events.includes("messageCompleted"),
    "assistant stream lifecycle emitted",
  );
  assert.ok(
    events.includes("toolStarted") && events.includes("toolCompleted"),
    "tool stream lifecycle emitted",
  );

  await runtime.dispose();
}

/* -------------------- abort preserves partial assistant output ----------- */
{
  const runtime = new SessionRuntime(new SessionLogStore(true));
  const session = new ClaudeSdkSession("cs-abort", {
    seam: async () => abortableSeam(),
  });
  runtime.createSession("cs-abort", session.createRuntimeAdapter());

  const events: string[] = [];
  const statuses: string[] = [];
  runtime.openSessionStream("cs-abort", (e) => {
    events.push(e.type);
    if (e.type === "runStatus") statuses.push(e.status);
  });

  const run = runtime.prompt("cs-abort", "start", {
    clientRequestId: "abort-1",
  });
  await waitFor(
    () => events.includes("passthrough"),
    "completed tool before abort",
  );
  await runtime.abort("cs-abort");
  await run;

  const snap = runtime.get("cs-abort")!.getSnapshot();
  assert.equal(snap.runState, "idle", "aborted run settles idle");
  assert.equal(
    snap.streaming.length,
    0,
    "aborted run clears transient streams",
  );
  assert.deepEqual(
    snap.entries.map((e) => e.role),
    ["user", "assistant", "toolResult"],
    "partial assistant turn and completed tool result are durable on abort",
  );
  const assistant = snap.entries.find((e) => e.role === "assistant")!;
  assert.equal(
    assistant.stopReason,
    "aborted",
    "partial assistant entry is marked aborted",
  );
  assert.deepEqual(
    assistant.content.map((c) => c.type),
    ["text", "toolCall"],
    "partial assistant content and tool call are preserved",
  );
  const toolResult = snap.entries.find((e) => e.role === "toolResult") as {
    toolCallId: string;
    content: Array<{ text: string }>;
  };
  assert.equal(
    toolResult.toolCallId,
    TOOL_ID,
    "completed tool result is preserved",
  );
  assert.equal(
    toolResult.content[0]?.text,
    "edited file",
    "tool output is durable",
  );
  assert.deepEqual(
    statuses,
    ["aborted"],
    "runtime observes an aborted run, not a successful end",
  );

  await runtime.dispose();
}

rmSync(tmp, { recursive: true, force: true });
console.log("claude-sdk adapter test: PASS");

test("adapts Claude SDK turns into the normalized runtime", () => {
  // Assertions run during module evaluation to preserve the former standalone script structure.
});
