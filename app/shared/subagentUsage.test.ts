import { describe, expect, it } from "vitest";
import type { SessionEntry } from "./session/index.ts";
import {
  delegationObligationReason,
  settleBlockedReason,
  subagentUsageSnapshotFromEntries,
  type SessionListItem,
} from "./protocol.ts";

function assistant(
  id: string,
  usage?: Extract<SessionEntry, { role: "assistant" }>["usage"],
): SessionEntry {
  return {
    id,
    seq: Number(id),
    createdAt: "2026-01-01T00:00:00.000Z",
    type: "message",
    role: "assistant",
    content: [],
    ...(usage ? { usage } : {}),
  };
}

describe("subagent usage and delegation projections", () => {
  it("sums finalized assistant entries only and reports missing usage", () => {
    expect(subagentUsageSnapshotFromEntries([])).toEqual({
      totals: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      completeness: "complete",
    });

    const entries: SessionEntry[] = [
      {
        id: "0",
        seq: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "message",
        role: "user",
        origin: { kind: "human" },
        content: [],
      },
      assistant("1", {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 3,
        cacheCreationTokens: 2,
        costUSD: 0.0000014,
        contextTokens: 999,
      }),
      assistant("2", {
        inputTokens: 5,
        outputTokens: 1,
        costUSD: 0.0000014,
      }),
    ];
    expect(subagentUsageSnapshotFromEntries(entries)).toEqual({
      totals: {
        inputTokens: 15,
        outputTokens: 5,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        costMicros: 2,
      },
      completeness: "complete",
    });
    expect(
      subagentUsageSnapshotFromEntries([...entries, assistant("3")])
        .completeness,
    ).toBe("partial");
  });

  it("uses one truthful obligation reason and blocks settlement on active children", () => {
    expect(
      delegationObligationReason({
        activeRunCount: 2,
        unadmittedResultCount: 1,
        ownedManagedWorktreeCount: 1,
      }),
    ).toBe("it still has active delegated work.");
    expect(
      delegationObligationReason({
        activeRunCount: 0,
        unadmittedResultCount: 1,
        ownedManagedWorktreeCount: 1,
      }),
    ).toBe("a delegated result has not been admitted to its transcript.");
    expect(
      settleBlockedReason({
        id: "parent",
        harness: "pi",
        agentType: "developer",
        title: "Parent",
        createdAt: 1,
        updatedAt: 1,
        messageCount: 1,
        delegation: {
          activeCount: 1,
          startingCount: 0,
          workingCount: 1,
          awaitingParentCount: 0,
        },
      } satisfies SessionListItem),
    ).toBe("it still has active delegated work.");
  });
});
