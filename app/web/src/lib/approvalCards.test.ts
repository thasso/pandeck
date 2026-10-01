import { describe, expect, it } from "vitest";
import type { ApprovalCard, DisplayMessage } from "@assistant/shared";
import { pendingApprovalCards } from "./approvalCards.ts";

function message(id: string, patch: Partial<ApprovalCard>): DisplayMessage {
  return {
    id: `approval-${id}`,
    role: "assistant",
    blocks: [
      {
        kind: "approval",
        approval: {
          renderKind: "approval",
          id,
          sessionId: "s1",
          kind: "commit",
          status: "pending",
          title: id,
          createdAt: 0,
          body: { kind: "commit", message: "wip", files: ["a.ts"] },
          ...patch,
        } as ApprovalCard,
      },
    ],
  };
}

describe("pendingApprovalCards", () => {
  it("names only cards that wait on the user, oldest first", () => {
    const cards = pendingApprovalCards([
      message("later", { createdAt: 2 }),
      message("done", { status: "executed" }),
      // A session grant covers it: it runs on the next idle edge unclicked.
      message("granted", { autoApproved: true }),
      message("earlier", { createdAt: 1 }),
    ]);

    expect(cards.map((card) => card.id)).toEqual(["earlier", "later"]);
  });
});
