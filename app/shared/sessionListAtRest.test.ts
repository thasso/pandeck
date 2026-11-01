import { describe, expect, it } from "vitest";
import {
  SESSION_LIST_LIVE_FIELDS,
  sessionListItemAtRest,
  type SessionListItem,
} from "./protocol.ts";

/** A row as the server sends it for a session with nothing live. */
function resting(): SessionListItem {
  return {
    id: "s1",
    scope: "user",
    harness: "pi",
    agentType: "assistant",
    title: "Resting",
    createdAt: 1,
    updatedAt: 2,
    messageCount: 3,
    isStreaming: false,
    awaitingInput: false,
    lastError: { message: "boom", at: 2 },
    settledAt: 5,
    unread: false,
    archived: false,
    backgroundActivity: {
      activeCount: 1,
      shellCount: 1,
      monitorCommandCount: 0,
      monitorWebsocketCount: 0,
      startingCount: 0,
      stoppingCount: 0,
      oldestStartedAt: 1,
    },
    pullRequest: { status: "open", number: 7 },
    outcomeAttention: {
      revision: 2,
      settledRevision: 2,
      kind: "completed",
      at: 3,
    },
    taskProgress: { todo: 1, doing: 0, done: 1 },
    spawnedBySessionId: "parent",
    spawnOwnership: "coordinator",
    inboxPosition: 4,
  };
}

describe("sessionListItemAtRest", () => {
  it("maps a live row to the server's resting shape", () => {
    const live: SessionListItem = {
      ...resting(),
      isStreaming: true,
      runStartedAt: 10,
      providerRetry: { attempt: 2, maxAttempts: 5, since: 9 },
      awaitingInput: true,
      attention: "approval",
      queuedWork: true,
      waitingForSlot: { position: 1 },
      awaitingRepliesFrom: ["peer"],
      unansweredRequestsFrom: ["requester"],
    };
    expect(sessionListItemAtRest(live)).toEqual(resting());
    // The input is not mutated.
    expect(live.isStreaming).toBe(true);
    expect(live.attention).toBe("approval");
  });

  it("returns a resting row value-equal, durable fields untouched", () => {
    const row = resting();
    const atRest = sessionListItemAtRest(row);
    expect(atRest).not.toBe(row);
    expect(atRest).toEqual(row);
    expect(Object.keys(atRest).sort()).toEqual(Object.keys(row).sort());
  });

  it("emits both booleans false even when a row omitted them", () => {
    const { isStreaming: _s, awaitingInput: _a, ...bare } = resting();
    const atRest = sessionListItemAtRest(bare);
    expect(atRest.isStreaming).toBe(false);
    expect(atRest.awaitingInput).toBe(false);
  });

  it("names exactly the live-derived fields", () => {
    expect([...SESSION_LIST_LIVE_FIELDS].sort()).toEqual(
      [
        "attention",
        "awaitingInput",
        "awaitingRepliesFrom",
        "isStreaming",
        "providerRetry",
        "queuedWork",
        "runStartedAt",
        "unansweredRequestsFrom",
        "waitingForSlot",
      ].sort(),
    );
  });
});
