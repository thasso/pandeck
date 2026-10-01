import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type {
  ApprovalCard as ApprovalCardData,
  ManagedPullRequestMergeApprovalBody,
} from "@assistant/shared";
import { ApprovalCard } from "./ApprovalCard.tsx";

/**
 * The default-branch merge card is the ONE human boundary in agent delivery, so
 * it has to state what is being merged where, at which head, with which method
 * out of which supported set, and on what check/review evidence. It is
 * deliberately not editable: approving re-derives every one of those facts
 * server-side.
 */

const body: ManagedPullRequestMergeApprovalBody = {
  kind: "managedPullRequestMerge",
  provider: "forgejo",
  repo: "acme/personal-assistant",
  worktreeId: "wt-1",
  number: 201,
  url: "https://git.example.com/acme/personal-assistant/pulls/201",
  title: "Task-588: finish the delivery loop",
  headBranch: "t588-branch-merge-close",
  baseBranch: "main",
  defaultBranch: "main",
  headSha: "abcdef1234567890",
  method: "squash",
  supportedMethods: ["squash", "merge"],
  deleteRemoteBranch: true,
  checks: { state: "success", total: 3, finished: true },
  review: { changesRequested: false },
  mergeable: true,
  draft: false,
  linkedTask: { id: "588", title: "Finish the delivery loop" },
};

const card: ApprovalCardData = {
  renderKind: "approval",
  id: "appr_merge",
  sessionId: "developer-session",
  kind: "managedPullRequestMerge",
  status: "pending",
  title: "Merge #201 into main",
  createdAt: Date.now(),
  body,
};

test("states the default-branch merge, its head and its evidence", () => {
  const html = renderToStaticMarkup(<ApprovalCard approval={card} />);
  expect(html).toContain("t588-branch-merge-close");
  expect(html).toContain("default branch");
  expect(html).toContain("acme/personal-assistant#201");
  expect(html).toContain("squash");
  expect(html).toContain("delete the remote branch");
  // The exact head is what was approved, so it is on the card.
  expect(html).toContain("abcdef12");
  expect(html).toContain("checks success (3)");
  expect(html).toContain("review clear");
  expect(html).toContain("Repository allows: squash, merge");
  expect(html).toContain("Task-588");
});

// Absence is unknown, never "nobody objected": a review the provider could not
// be asked about must not read as a clean one.
test("an unavailable review reads as unknown", () => {
  const { review: _dropped, ...withoutReview } = body;
  const html = renderToStaticMarkup(
    <ApprovalCard approval={{ ...card, body: withoutReview }} />,
  );
  expect(html).toContain("review unknown");
});
