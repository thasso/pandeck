import { expect, it } from "vitest";
import type { WorktreeComment } from "@assistant/shared";
import { pendingWorktreeReviewIds } from "./worktreeReview.tsx";

it("projects only unsent open roots into the pending review", () => {
  expect(
    pendingWorktreeReviewIds([
      comment("pending"),
      comment("sent", { attachedSessionId: "session-1" }),
      comment("resolved", { resolvedAt: 2 }),
      { ...comment("reply"), parentId: "pending" },
    ]),
  ).toEqual(["pending"]);
});

function comment(
  id: string,
  fields: Partial<WorktreeComment> = {},
): WorktreeComment {
  return {
    id,
    worktreeId: "wt-1",
    author: { kind: "user" },
    body: `Comment ${id}`,
    anchor: {
      path: "src/app.ts",
      side: "new",
      line: 3,
      commit: "abc123",
      dirty: false,
      selectors: {
        quote: { exact: "line", prefix: "", suffix: "" },
        position: { start: 0, end: 4 },
        block: { id: "3", occurrence: 1 },
      },
    },
    current: { path: "src/app.ts", line: 3 },
    anchorState: "anchored",
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  };
}
