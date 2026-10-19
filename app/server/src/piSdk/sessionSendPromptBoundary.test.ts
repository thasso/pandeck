/**
 * `session_send_prompt` rows at both harness entries (Task-942). pi validates
 * and coerces a call against the tool's schema BEFORE `execute`, and a schema
 * failure there refuses the whole call — so one malformed row would fail its
 * siblings. The row schema is typeless so that pi passes every row through
 * untouched; this holds that against pi-ai's real validator, and holds the
 * MCP entry (raw arguments straight into `execute`) to the same outcome.
 */
import assert from "node:assert/strict";
import { afterEach, beforeAll, describe, it, vi } from "vitest";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { sessionStore } from "../db/sessionStore.ts";
import { peerPromptStore } from "../db/peerPromptStore.ts";

const standIn = (id: string) => ({ id, sessionId: id, isRunning: false });
const hub = vi.hoisted(() => ({
  getLiveById: (id: string) => standIn(id),
  acquireById: async (id: string) => standIn(id),
  broadcastPeerPromptCardUpdate: () => {},
}));
vi.mock("../hub.ts", () => ({ hub }));

const { setHubForTests, setPeerPromptAutoDeliverForTests } =
  await import("../peerPrompt.ts");
const { sessionSendPromptTools } =
  await import("../tools/sessions/sessionSendPromptTool.ts");
const { toPiToolDefinitions } = await import("./agentToolAdapter.ts");

beforeAll(() => {
  setHubForTests(hub as never);
  setPeerPromptAutoDeliverForTests(false);
});

let n = 0;
const created: string[] = [];
function seed(title: string): string {
  const id = `boundary-${n++}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    title,
    scope: "user",
  });
  created.push(id);
  return id;
}
afterEach(() => {
  for (const id of created.splice(0)) sessionStore.remove(id);
});

const session = (sessionId: string) => ({
  sessionId,
  harness: "pi" as const,
  agentType: "assistant" as const,
  title: "Sender",
});

/** Two valid rows around every kind of bad one. */
function mixedRows() {
  const [a, b, c, d] = ["A", "B", "C", "D"].map(seed);
  return {
    targets: { a: a!, d: d! },
    rows: [
      { targetSessionId: a, prompt: "to A" },
      { targetSessionId: b, prompt: "x", inReplyTo: 7 },
      { targetSessionId: 5, prompt: "x", responseRequested: "true" },
      "not a row",
      null,
      { targetSessionId: c, prompt: "x", inReplyTo: null },
      { targetSessionId: d, prompt: "to D" },
    ] as unknown[],
  };
}

function outcome(
  sender: string,
  details: unknown,
  targets: { a: string; d: string },
) {
  const rows = (details as { rows: Array<{ kind: string; index?: number }> })
    .rows;
  const sent = peerPromptStore
    .listByParticipant(sender)
    .map((m) => m.recipientSessionId)
    .sort();
  assert.deepEqual(sent, [targets.a, targets.d].sort(), "A and D, once each");
  return rows.map((r) => (r.kind === "error" ? r.index : r.kind));
}

const EXPECTED = ["message", 1, 2, 3, 4, 5, "message"];

describe("session_send_prompt rows at the harness boundary", () => {
  it("pi's validator passes every row through unchanged, and execute isolates the bad ones", async () => {
    const sender = seed("Sender");
    const { rows, targets } = mixedRows();
    const tool = sessionSendPromptTools()[0]!;
    const [definition] = toPiToolDefinitions([tool], {
      session: () => session(sender),
    });
    const args = { rows: structuredClone(rows) };
    const validated = validateToolArguments(
      {
        name: definition!.name,
        description: definition!.description,
        parameters: definition!.parameters,
      } as never,
      {
        type: "toolCall",
        id: "call-1",
        name: definition!.name,
        arguments: args,
      } as never,
    );
    // Nothing coerced ("true" stays a string, 5 a number), no null dropped.
    assert.deepEqual(validated, { rows });
    const result = await definition!.execute(
      "call-1",
      validated as never,
      undefined,
      undefined,
      undefined as never,
    );
    assert.deepEqual(outcome(sender, result.details, targets), EXPECTED);
  });

  it("the MCP entry's raw arguments give the same per-row outcome", async () => {
    const sender = seed("Sender");
    const { rows, targets } = mixedRows();
    const tool = sessionSendPromptTools()[0]!;
    const result = await tool.execute(
      { rows },
      { toolCallId: "call-2", session: session(sender) },
    );
    assert.deepEqual(outcome(sender, result.details, targets), EXPECTED);
  });
});
