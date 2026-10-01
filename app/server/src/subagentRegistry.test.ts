import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { ServerMessage } from "@assistant/shared";

const dataDir = mkdtempSync(join(tmpdir(), "subagent-registry-test-"));
process.env.DATA_DIR = dataDir;
process.env.ASSISTANT_CWD = dataDir;

const { hub, seedTaskBaseline } = await import("./hub.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { subagentStore } = await import("./db/subagentStore.ts");
const {
  subagentRunRevisionDigest,
  subagentRunStateItems,
  subagentThreadRunDetail,
} = await import("./subagentRegistry.ts");

const profile = {
  roleName: "implementer",
  baseRole: "developer",
  provider: "pi",
  modelId: "model",
  credentialProfileId: "profile",
  accountSource: "test",
  defaultThinking: "off",
  hardMaxThinking: "high",
  executionProfileId: "execution",
  contractId: "implementation-result",
  contractVersion: 1,
};

test("cold registry baseline preserves pending tombstones and excludes old ones", () => {
  const index = new Map([
    ["live", { revision: 4, live: true }],
    ["pending-live", { revision: 5, live: true }],
    ["pending-delete", { revision: 6, live: false }],
    ["old-delete", { revision: 7, live: false }],
  ]);

  assert.deepEqual(
    seedTaskBaseline(index, new Set(["pending-live", "pending-delete"])),
    new Map([
      ["live", 4],
      ["pending-delete", 6],
    ]),
  );
});

test("run detail snapshots and item reads carry bounded summaries with sidecars", async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const parentSessionId = `parent-${suffix}`;
  const childSessionId = `child-${suffix}`;
  const threadId = `thread-${suffix}`;
  const runId = `run-${suffix}`;
  sessionStore.upsert({
    id: parentSessionId,
    scope: "user",
    harness: "pi",
    agentType: "developer",
  });
  sessionStore.upsert({
    id: childSessionId,
    scope: "subagent",
    harness: "pi",
    agentType: "developer",
    credentialProfileId: profile.credentialProfileId,
  });
  const messages: ServerMessage[] = [];
  const quietMessages: ServerMessage[] = [];
  const quiet = {
    send: (message: ServerMessage): void => {
      quietMessages.push(message);
    },
    wantsTopic: (topic: string) => topic === "subagents",
  };
  const viewer = {
    send: (message: ServerMessage): void => {
      messages.push(message);
    },
    wantsTopic: (topic: string) => topic === "subagents",
    wantsSubagentThread: (id: string) => id === threadId,
  };
  hub.register(viewer);
  hub.register(quiet);
  try {
    subagentStore.acceptInitial({
      thread: {
        id: threadId,
        parentSessionId,
        sessionId: childSessionId,
        profile,
      },
      run: { id: runId, initiatedBy: "human", actualThinking: "off" },
      parentLimit: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(
      messages.some(
        (message) =>
          message.type === "stateEvents" && message.topic === "subagents",
      ),
    );
    assert.ok(
      messages.some(
        (message) =>
          message.type === "subagentRunEvents" && message.threadId === threadId,
      ),
    );
    assert.equal(
      quietMessages.some((message) => message.type === "subagentRunEvents"),
      false,
    );

    subagentStore.transitionExecution({
      runId,
      status: "running",
      phase: "provider-admitted",
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(
      messages.filter(
        (message) =>
          message.type === "stateEvents" && message.topic === "subagents",
      ).length >= 2,
    );
    const detail = subagentThreadRunDetail(threadId, { limit: 1 });
    assert.ok(detail);
    assert.equal(detail.runs[0]?.id, runId);
    const [event] = subagentRunStateItems([runId]);
    assert.ok(event);
    assert.deepEqual(subagentRunRevisionDigest(threadId), [
      { id: runId, revision: event.revision },
    ]);
    assert.equal(event.kind, "upsert");
    assert.equal(event.id, runId);
    if (event.kind === "upsert") {
      assert.equal("acceptedResult" in event.item, false);
      assert.equal("revision" in event.item, false);
    }

    subagentStore.requestStop(runId, "test");
    subagentStore.recordQuiescence(runId, "test-completion");
    subagentStore.finalizeRun({ runId, status: "stopped" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    subagentStore.tombstoneParentTree(parentSessionId);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const threadBatches = messages.filter(
      (message) =>
        message.type === "stateEvents" && message.topic === "subagents",
    );
    const finalBatch = threadBatches.at(-1) as
      { events?: Array<{ id: string; kind: string }> } | undefined;
    assert.equal(
      finalBatch?.events?.find((event) => event.id === threadId)?.kind,
      "delete",
    );
  } finally {
    hub.unregister(viewer);
    hub.unregister(quiet);
  }
});
