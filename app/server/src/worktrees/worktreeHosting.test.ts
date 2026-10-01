import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { WorktreeRow } from "../db/worktreeStore.ts";
import {
  invalidateRepositoryCapabilities,
  type GitHostingProvider,
} from "../gitHosting.ts";

const hoisted = vi.hoisted(() => ({
  provider: vi.fn(),
  resolvePushTarget: vi.fn(),
}));

vi.mock("../gitExec.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gitExec.ts")>();
  return {
    ...actual,
    resolveRepoRoot: async () => "/repo",
    gitOptional: async () => ({ code: 0, stdout: "a".repeat(40), stderr: "" }),
  };
});

vi.mock("../pushWorkflow.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pushWorkflow.ts")>();
  return { ...actual, resolvePushTarget: hoisted.resolvePushTarget };
});

vi.mock("../gitHosting.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gitHosting.ts")>();
  return { ...actual, hostingProviderForRepo: hoisted.provider };
});

import {
  invalidateWorktreeHosting,
  worktreeHostingStatus,
  worktreeHostingStatusesWithFailures,
} from "./worktreeHosting.ts";

const row: WorktreeRow = {
  id: "wt-fork-hosting",
  projectId: "project",
  mainRepoRoot: "/repo/main",
  path: "/repo/worktree",
  branch: "feature",
  baseBranch: "main",
  baseCommit: "b".repeat(40),
  status: "active",
  mergeStateJson: null,
  createdAt: 1,
  updatedAt: 1,
  removedAt: null,
};

function provider(): GitHostingProvider {
  return {
    kind: "github",
    repoWebUrl: "https://github.com/acme/fork",
    findPullRequestForBranch: async () => ({
      number: 12,
      url: "https://github.com/acme/fork/pull/12",
      title: "Feature",
      state: "open",
    }),
    ciStatus: async () => ({ state: "pending", total: 1 }),
    pullRequestReview: async () => null,
    repositoryCapabilities: async () => ({
      defaultBranch: "main",
      mergeMethods: ["squash", "merge"],
      canClose: true,
      canDeleteBranchOnMerge: true,
    }),
  } as unknown as GitHostingProvider;
}

const sibling: WorktreeRow = {
  ...row,
  id: "wt-sibling-hosting",
  path: "/repo/sibling",
  branch: "other",
};

afterEach(() => {
  invalidateWorktreeHosting(row.id);
  invalidateWorktreeHosting(sibling.id);
  // Capabilities are cached per REPOSITORY, not per worktree: one test's read
  // would otherwise answer the next one's provider.
  invalidateRepositoryCapabilities();
  hoisted.provider.mockReset();
  hoisted.resolvePushTarget.mockReset();
});

test("spawned worktree hosting follows the branch's derived push remote", async () => {
  hoisted.resolvePushTarget.mockResolvedValue({
    repoRoot: "/repo",
    remote: "fork",
    upstream: { remote: "fork", branch: row.branch },
  });
  hoisted.provider.mockResolvedValue(provider());

  const status = await worktreeHostingStatus(row);

  assert.deepEqual(hoisted.resolvePushTarget.mock.calls, [
    ["/repo", row.branch],
  ]);
  assert.deepEqual(hoisted.provider.mock.calls, [[row.path, "fork"]]);
  assert.equal(status.pr?.number, 12);
  assert.equal(status.repoWebUrl, "https://github.com/acme/fork");
});

// The merge picker may offer only what the repository allows, so the status
// payload carries those capabilities beside the open pull request.
test("an open pull request carries the repository's merge capabilities", async () => {
  hoisted.resolvePushTarget.mockResolvedValue({
    repoRoot: "/repo",
    remote: "origin",
    upstream: { remote: "origin", branch: row.branch },
  });
  hoisted.provider.mockResolvedValue(provider());

  const status = await worktreeHostingStatus(row);

  assert.deepEqual(status.capabilities, {
    defaultBranch: "main",
    mergeMethods: ["squash", "merge"],
    canClose: true,
    canDeleteBranchOnMerge: true,
  });
});

// A capability read that fails is UNKNOWN, never "every method is supported":
// the picker then offers nothing rather than a method the backend refuses.
test("a failed capability read leaves the methods unknown", async () => {
  hoisted.resolvePushTarget.mockResolvedValue({
    repoRoot: "/repo",
    remote: "origin",
    upstream: { remote: "origin", branch: row.branch },
  });
  hoisted.provider.mockResolvedValue({
    ...provider(),
    repositoryCapabilities: async () => {
      throw new Error("repository settings unavailable");
    },
  } as unknown as GitHostingProvider);

  const status = await worktreeHostingStatus(row);

  assert.equal(status.capabilities?.mergeMethods, undefined);
  assert.equal(status.capabilities?.defaultBranch, undefined);
  assert.match(
    status.capabilities?.unknownReason ?? "",
    /repository settings unavailable/,
  );
});

// The pull-request lookup is the read this payload cannot be honest without —
// an empty answer would render as "no PR, no CI" — so it still propagates and
// the bulk path still omits the row.
test("a failed pull-request lookup propagates", async () => {
  hoisted.resolvePushTarget.mockResolvedValue({
    repoRoot: "/repo",
    remote: "origin",
    upstream: { remote: "origin", branch: row.branch },
  });
  hoisted.provider.mockResolvedValue({
    ...provider(),
    findPullRequestForBranch: async () => {
      throw new Error("forgejo unreachable");
    },
  } as unknown as GitHostingProvider);

  await assert.rejects(worktreeHostingStatus(row), /forgejo unreachable/);
});

// CI belongs to the LOCAL head and the review to the pull request, so neither
// may take an ANSWERED pull request down with it: the Pull Requests inventory
// reads this projection to find the merged pull request a checkout is still
// waiting on, and losing the row over an unrelated outage would hide it. Such a
// payload is answered but NOT cached, so the failed read is retried.
test("a failed CI read keeps the answered pull request and is not cached", async () => {
  hoisted.resolvePushTarget.mockResolvedValue({
    repoRoot: "/repo",
    remote: "origin",
    upstream: { remote: "origin", branch: row.branch },
  });
  let ciCalls = 0;
  hoisted.provider.mockResolvedValue({
    ...provider(),
    findPullRequestForBranch: async () => ({
      number: 13,
      url: "https://github.com/acme/fork/pull/13",
      title: "Merged work",
      state: "merged",
    }),
    ciStatus: async () => {
      ciCalls += 1;
      throw new Error("status API down");
    },
  } as unknown as GitHostingProvider);

  const first = await worktreeHostingStatus(row);
  assert.equal(first.pr?.number, 13);
  assert.equal(first.pr?.state, "merged");
  assert.equal(first.ci, undefined);

  const second = await worktreeHostingStatus(row);
  assert.equal(second.pr?.number, 13);
  assert.equal(ciCalls, 2);
});

// The same isolation for the review of an OPEN pull request.
test("a failed review read keeps the answered pull request", async () => {
  hoisted.resolvePushTarget.mockResolvedValue({
    repoRoot: "/repo",
    remote: "origin",
    upstream: { remote: "origin", branch: row.branch },
  });
  hoisted.provider.mockResolvedValue({
    ...provider(),
    pullRequestReview: async () => {
      throw new Error("reviews API down");
    },
  } as unknown as GitHostingProvider);

  const status = await worktreeHostingStatus(row);

  assert.equal(status.pr?.number, 12);
  assert.deepEqual(status.ci, { state: "pending", total: 1 });
  assert.equal(status.review, undefined);
});

// A provider with a batched read answers every row of a repository in ONE
// request instead of a lookup, CI and review per row.
test("rows of one repository share one batched provider read", async () => {
  hoisted.resolvePushTarget.mockResolvedValue({
    repoRoot: "/repo",
    remote: "origin",
    upstream: { remote: "origin", branch: row.branch },
  });
  const branchStatuses = vi.fn(async (requests: unknown[]) =>
    requests.map((_, index) =>
      index === 0
        ? {
            pr: {
              number: 12,
              url: "https://github.com/acme/fork/pull/12",
              title: "Feature",
              state: "open" as const,
            },
            ci: { state: "success" as const, total: 1 },
            review: { changesRequested: false },
          }
        : { pr: null, ci: null, review: null },
    ),
  );
  const perRow = vi.fn(async () => {
    throw new Error("per-row read must not run");
  });
  hoisted.provider.mockResolvedValue({
    ...provider(),
    findPullRequestForBranch: perRow,
    ciStatus: perRow,
    branchStatuses,
  } as unknown as GitHostingProvider);

  const read = await worktreeHostingStatusesWithFailures([row, sibling]);

  assert.equal(branchStatuses.mock.calls.length, 1);
  assert.deepEqual(branchStatuses.mock.calls[0]![0], [
    { branch: "feature", headSha: "a".repeat(40) },
    { branch: "other", headSha: "a".repeat(40) },
  ]);
  assert.equal(perRow.mock.calls.length, 0);
  assert.deepEqual(read.failedWorktreeIds, []);
  const byId = new Map(
    read.statuses.map((status) => [status.worktreeId, status]),
  );
  assert.equal(byId.get(row.id)?.pr?.number, 12);
  assert.deepEqual(byId.get(row.id)?.review, { changesRequested: false });
  assert.equal(byId.get(row.id)?.capabilities?.defaultBranch, "main");
  assert.deepEqual(byId.get(sibling.id), {
    worktreeId: sibling.id,
    provider: "github",
    repoWebUrl: "https://github.com/acme/fork",
  });

  // Answered whole, so cached: the single-row path does not ask again.
  await worktreeHostingStatus(row);
  assert.equal(branchStatuses.mock.calls.length, 1);
});

test("a failed batched read omits every row it covered", async () => {
  hoisted.resolvePushTarget.mockResolvedValue({
    repoRoot: "/repo",
    remote: "origin",
    upstream: { remote: "origin", branch: row.branch },
  });
  hoisted.provider.mockResolvedValue({
    ...provider(),
    branchStatuses: async () => {
      throw new Error("GitHub GraphQL query failed");
    },
  } as unknown as GitHostingProvider);

  const read = await worktreeHostingStatusesWithFailures([row, sibling]);

  assert.deepEqual(read.statuses, []);
  assert.deepEqual(read.failedWorktreeIds.sort(), [row.id, sibling.id].sort());
  await assert.rejects(worktreeHostingStatus(row), /GraphQL query failed/);
});
