/**
 * Unit test for normalized session stats. Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/session/runtime/stats.test.ts
 *
 * Covers: message/tool counts from the normalized timeline; durable token/cost
 * from finalized assistant entries (summed, with context size = last entry's
 * input-side tokens); and the live current-turn estimate from active streams.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type {
  SessionEntry,
  SessionSnapshot,
  StreamingEntry,
} from "@assistant/shared/session";
import { contextInfoFromSnapshot } from "./stats.ts";

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
      { type: "text", text: "x" },
      { type: "toolCall", toolCallId: "tc1", name: "bash", input: {} },
    ],
    usage: {
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 50,
      costUSD: 0.01,
      contextWindowTokens: 1_000_000,
    },
  },
  {
    id: "tr1",
    seq: 2,
    createdAt: "t",
    type: "message",
    role: "toolResult",
    toolCallId: "tc1",
    content: [{ type: "text", text: "out" }],
  },
  {
    id: "a2",
    seq: 3,
    createdAt: "t",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    usage: {
      inputTokens: 200,
      outputTokens: 20,
      cacheReadTokens: 60,
      costUSD: 0.02,
      contextWindowTokens: 1_000_000,
    },
  },
];

/* ----------------------------- durable (idle) ---------------------------- */
{
  const snap: SessionSnapshot = {
    sessionId: "s",
    runState: "idle",
    entries,
    streaming: [],
  };
  const info = contextInfoFromSnapshot(snap, { updatedAt: 123 });
  assert.deepEqual(
    info.messageCounts,
    { user: 1, assistant: 2, toolCalls: 1, toolResults: 1, total: 3 },
    "counts derived from the timeline",
  );
  assert.equal(
    info.tokenUsage.input,
    300,
    "input tokens summed across assistant entries",
  );
  assert.equal(info.tokenUsage.output, 30, "output tokens summed");
  assert.equal(info.tokenUsage.cacheRead, 110, "cache-read summed");
  assert.equal(
    Number(info.cost.toFixed(2)),
    0.03,
    "cost summed across assistant entries",
  );
  // Context size = LAST assistant entry's input-side tokens (200 + 60), not summed.
  assert.equal(
    info.context!.tokens,
    260,
    "context tokens = last assistant entry input-side (snapshot, not sum)",
  );
  assert.equal(
    info.context!.contextWindow,
    1_000_000,
    "context window from reported usage",
  );
  assert.equal(info.currentTurn, undefined, "no live estimate when idle");
}

/* -------------------- context snapshot from usage -------------------- */
{
  // When the harness reports the REAL context size (usage.contextTokens), it
  // wins over the prompt-token-sum fallback (which over-counts a tool loop).
  const withSnapshot: SessionEntry[] = [
    ...entries.slice(0, 3),
    {
      id: "a2",
      seq: 3,
      createdAt: "t",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      usage: {
        inputTokens: 200,
        outputTokens: 20,
        cacheReadTokens: 60,
        contextTokens: 5000,
        costUSD: 0.02,
        contextWindowTokens: 1_000_000,
      },
    },
  ];
  const snap: SessionSnapshot = {
    sessionId: "s",
    runState: "idle",
    entries: withSnapshot,
    streaming: [],
  };
  const info = contextInfoFromSnapshot(snap);
  assert.equal(
    info.context!.tokens,
    5000,
    "context tokens prefer the reported usage.contextTokens snapshot",
  );
}

/* --------------------------- live current turn --------------------------- */
{
  const streaming: StreamingEntry[] = [
    {
      streamId: "m",
      kind: "message",
      role: "assistant",
      content: [
        { type: "text", text: "abcd".repeat(10) },
        { type: "thinking", text: "xy" },
      ],
    },
    { streamId: "t", kind: "tool", toolCallId: "tx", name: "read", input: {} },
  ];
  const snap: SessionSnapshot = {
    sessionId: "s",
    runState: "running",
    entries,
    streaming,
  };
  const info = contextInfoFromSnapshot(snap);
  assert.ok(info.currentTurn, "live estimate present while streaming");
  assert.equal(
    info.currentTurn!.toolCalls,
    1,
    "live tool count from active tool streams",
  );
  assert.ok(
    info.currentTurn!.output > 0,
    "live output estimate from streamed text",
  );
  assert.ok(
    info.currentTurn!.thinking > 0,
    "live thinking estimate from streamed thinking",
  );
}

console.log("session stats unit test: PASS");

test("derives normalized session stats", () => {
  // Assertions run during module evaluation to preserve the former standalone script structure.
});
