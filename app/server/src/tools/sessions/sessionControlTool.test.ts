import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { peerPromptStore } from "../../db/peerPromptStore.ts";
import { sessionStore } from "../../db/sessionStore.ts";
import {
  sessionControlTools,
  setSessionControlRuntimeForTests,
} from "./sessionControlTool.ts";

let sequence = 0;
const sessions: string[] = [];

function seed(title: string, scope: "user" | "internal" = "user"): string {
  const id = `session-control-${sequence++}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    title,
    scope,
  });
  sessions.push(id);
  return id;
}

function enqueue(senderSessionId: string, recipientSessionId: string) {
  const chainId = peerPromptStore.createChain(
    `session-control-chain-${sequence++}`,
  );
  return peerPromptStore.enqueue({
    conversationId: `session-control-conversation-${sequence++}`,
    chainId,
    hop: peerPromptStore.reserveHop(chainId),
    senderSessionId,
    recipientSessionId,
    prompt: "queued work",
    responseRequested: false,
  });
}

const tool = () => sessionControlTools()[0]!;
const context = (sessionId: string) => ({
  toolCallId: "tool-call",
  session: {
    sessionId,
    harness: "pi" as const,
    agentType: "assistant" as const,
    title: "Coordinator",
  },
});

function resultText(
  result: Awaited<ReturnType<ReturnType<typeof tool>["execute"]>>,
) {
  return (result.content[0] as { type: "text"; text: string }).text;
}

afterEach(() => {
  setSessionControlRuntimeForTests(undefined);
  for (const id of sessions.splice(0)) sessionStore.remove(id);
});

describe("session_control tool", () => {
  it("exposes the two operations and validates operation-specific fields", async () => {
    const schema = tool().parameters as {
      required: string[];
      properties: Record<string, unknown>;
    };
    assert.deepEqual(schema.required.sort(), ["operation", "targetSessionId"]);
    assert.deepEqual(Object.keys(schema.properties).sort(), [
      "clearQueue",
      "operation",
      "targetSessionId",
    ]);

    const caller = seed("Caller");
    const target = seed("Target");
    await assert.rejects(
      () =>
        tool().execute(
          {
            operation: "cancel_queued_prompts",
            targetSessionId: target,
            clearQueue: false,
          },
          context(caller),
        ),
      /only valid with operation "stop"/,
    );
    await assert.rejects(
      () =>
        tool().execute(
          { operation: "stop", targetSessionId: target, clearQueue: "yes" },
          context(caller),
        ),
      /clearQueue must be a boolean/,
    );
  });

  it("cancels only the caller's own waiting prompts", async () => {
    const caller = seed("Caller");
    const other = seed("Other sender");
    const target = seed("Target");
    const own = enqueue(caller, target);
    const unrelated = enqueue(other, target);

    const result = await tool().execute(
      { operation: "cancel_queued_prompts", targetSessionId: target },
      context(caller),
    );

    assert.match(resultText(result), /Cancelled 1 queued prompt/);
    assert.equal(peerPromptStore.getById(own.id)?.status, "cancelled");
    assert.equal(peerPromptStore.getById(unrelated.id)?.status, "queued");
  });

  it("stops a coordinator-owned child after clearing its whole queue", async () => {
    const caller = seed("Caller");
    const other = seed("Other sender");
    const child = seed("Child");
    sessionStore.linkSpawned(caller, child);
    const own = enqueue(caller, child);
    const unrelated = enqueue(other, child);
    let aborted = false;
    setSessionControlRuntimeForTests({
      isRunning: (sessionId) => sessionId === child,
      abort: (sessionId) => {
        assert.equal(sessionId, child);
        assert.equal(
          peerPromptStore.listPendingForRecipient(child).length,
          0,
          "the queue is cleared before abort can trigger the idle hook",
        );
        aborted = true;
      },
    });

    const result = await tool().execute(
      { operation: "stop", targetSessionId: child, clearQueue: true },
      context(caller),
    );

    assert.equal(aborted, true);
    assert.equal(peerPromptStore.getById(own.id)?.status, "cancelled");
    assert.equal(peerPromptStore.getById(unrelated.id)?.status, "cancelled");
    assert.match(resultText(result), /Stopped the current turn/);
    assert.match(resultText(result), /Cancelled 2 queued prompts first/);
  });

  it("refuses an unrelated or user-taken-over child", async () => {
    const caller = seed("Caller");
    const unrelated = seed("Unrelated");
    await assert.rejects(
      () =>
        tool().execute(
          { operation: "stop", targetSessionId: unrelated },
          context(caller),
        ),
      /was not spawned by the current session/,
    );

    const child = seed("Taken over child");
    sessionStore.linkSpawned(caller, child);
    sessionStore.setSpawnedOwnership(child, "taken-over");
    await assert.rejects(
      () =>
        tool().execute(
          { operation: "stop", targetSessionId: child },
          context(caller),
        ),
      /no longer owned by the current session/,
    );
  });
});
