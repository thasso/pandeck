import { expect, test } from "vitest";
import { approvalGrantKeys, approvalGrantLabel } from "./approvalGrants.ts";

test("a grant key is the operation, never the target", () => {
  expect(
    approvalGrantKeys({
      kind: "githubPullRequest",
      operation: "comment",
      repo: "org/repo",
      pullNumber: 1,
    }),
  ).toEqual(["github:comment"]);
  expect(approvalGrantKeys({ kind: "gmailArchive", items: [] })).toEqual([
    "gmailArchive",
  ]);
});

test("a batch card needs every operation it mixes, once each", () => {
  expect(
    approvalGrantKeys({
      kind: "jiraIssue",
      items: [
        {
          clientId: "a",
          issueKey: "PA-1",
          operation: "comment",
          fieldChanges: [],
        },
        { clientId: "b", issueKey: "PA-2", fieldChanges: [] },
        {
          clientId: "c",
          issueKey: "PA-3",
          operation: "comment",
          fieldChanges: [],
        },
      ],
    }),
  ).toEqual(["jira:comment", "jira:edit"]);
});

test("tag grants bind the exact checkout, destination, tag and commit", () => {
  const body = {
    kind: "gitTag" as const,
    repoPath: "/repo",
    remote: "origin",
    branch: "main",
    pushUrlFingerprint: "a".repeat(64),
    pushUrlDisplay: "ssh://example.test/repo",
    tag: "v0.1.0",
    targetSha: "b".repeat(40),
  };
  const [key] = approvalGrantKeys(body);
  expect(approvalGrantLabel(key!)).toBe("Publish tag v0.1.0");
  for (const changed of [
    { tag: "v0.2.0" },
    { targetSha: "c".repeat(40) },
    { repoPath: "/other" },
    { pushUrlFingerprint: "d".repeat(64) },
    { branch: "release" },
    { remote: "fork" },
  ])
    expect(approvalGrantKeys({ ...body, ...changed })).not.toEqual([key]);
});

test("grant labels read as provider: operation", () => {
  expect(approvalGrantLabel("jira:comment")).toBe("Jira: comment on issues");
  expect(approvalGrantLabel("github:create")).toBe(
    "GitHub: open pull requests",
  );
  expect(approvalGrantLabel("managedPullRequestMerge")).toBe(
    "Merge into the default branch",
  );
});

test("a commit review override is never grantable", () => {
  expect(
    approvalGrantKeys({
      kind: "managedCommitOverride",
      worktreeId: "wt-1",
      branch: "t742-retry-backoff",
      reason: "The generated snapshot is one atomic change.",
      stagedOnly: false,
      commit: {
        status: "blocked",
        dryRun: true,
        forced: false,
        commitMessage: "Regenerate the API snapshot",
        blockers: [{ kind: "too_broad", reason: "Diff is very large." }],
        warnings: [],
        files: [{ path: "api.snap", status: "modified", additions: 900 }],
        totals: { files: 1, additions: 900, deletions: 0 },
      },
    }),
  ).toEqual([]);
});
