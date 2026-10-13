import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type {
  ApprovalCard as ApprovalCardData,
  ManagedCommitOverrideApprovalBody,
} from "@assistant/shared";
import { ApprovalCard } from "./ApprovalCard.tsx";

/**
 * Overriding a blocked commit review is a one-off decision on exact findings:
 * the card has to say it overrides the review, list every blocker, and show the
 * agent's reason, branch, scope, message and files. It never offers "Approve
 * for session", because no grant may answer a later override.
 */

const body: ManagedCommitOverrideApprovalBody = {
  kind: "managedCommitOverride",
  worktreeId: "wt-1",
  branch: "t742-retry-backoff",
  reason: "The snapshot is regenerated as one atomic change.",
  stagedOnly: true,
  commit: {
    status: "blocked",
    dryRun: true,
    forced: false,
    stagedOnly: true,
    commitMessage: "Regenerate the provider API snapshot",
    blockers: [
      { kind: "too_broad", reason: "Diff is very large (210000 characters)." },
      {
        kind: "unclear",
        file: "api.snap",
        reason: "The change mixes generated and hand-written code.",
      },
    ],
    warnings: ["api.snap has no test touching it."],
    files: [
      { path: "api.snap", status: "modified", additions: 900, deletions: 12 },
      { path: "api.ts", status: "added", additions: 4 },
    ],
    totals: { files: 2, additions: 904, deletions: 12 },
  },
};

const card: ApprovalCardData = {
  renderKind: "approval",
  id: "appr_override",
  sessionId: "developer-session",
  kind: "managedCommitOverride",
  status: "pending",
  title: "Override the commit review",
  createdAt: Date.now(),
  body,
};

test("states the override, every blocker and what would be committed", () => {
  const html = renderToStaticMarkup(
    <ApprovalCard approval={card} onResolve={() => {}} />,
  );
  expect(html).toContain("Approving overrides the review");
  expect(html).toContain("Review blockers");
  expect(html).toContain("Diff is very large (210000 characters).");
  expect(html).toContain("The change mixes generated and hand-written code.");
  expect(html).toContain("The snapshot is regenerated as one atomic change.");
  expect(html).toContain("t742-retry-backoff");
  expect(html).toContain("staged changes only");
  expect(html).toContain("2 files");
  expect(html).toContain("Regenerate the provider API snapshot");
  expect(html).toContain("api.snap");
  expect(html).toContain("api.ts");
  expect(html).toContain("api.snap has no test touching it.");
});

test("offers Approve and Reject but never Approve for session", () => {
  const html = renderToStaticMarkup(
    <ApprovalCard approval={card} onResolve={() => {}} />,
  );
  expect(html).toContain(">Approve<");
  expect(html).toContain(">Reject<");
  expect(html).not.toContain("Approve for session");
});

test("an unstaged override reads as all changes", () => {
  const html = renderToStaticMarkup(
    <ApprovalCard
      approval={{ ...card, body: { ...body, stagedOnly: false } }}
    />,
  );
  expect(html).toContain("all changes");
});
