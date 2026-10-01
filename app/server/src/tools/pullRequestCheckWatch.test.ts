/**
 * The readiness vocabulary is SHARED: the GitHub/Forgejo check-watch tools
 * report it, and `worktree_finish_pull_request` re-derives it before merging.
 * These tests pin the one definition both use — a second one would let an agent
 * merge on a verdict the watcher would have refused.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { PullRequestDetail } from "@assistant/shared";
import type { GitHostingProvider, GitHostingRefChecks } from "../gitHosting.ts";
import {
  checksAreFinished,
  evaluatePullRequestReadiness,
  readPullRequestReadiness,
} from "./pullRequestCheckWatch.ts";

function detail(patch: Partial<PullRequestDetail> = {}): PullRequestDetail {
  return {
    number: 42,
    state: "open",
    merged: false,
    mergeable: true,
    draft: false,
    headSha: "abc123",
    headBranch: "feature",
    baseBranch: "main",
    ...patch,
  };
}

const green: GitHostingRefChecks = {
  state: "success",
  total: 1,
  checks: [{ name: "test", status: "success" }],
};

test("a green, mergeable, reviewed pull request can merge now", () => {
  const readiness = evaluatePullRequestReadiness(detail(), green, {
    changesRequested: false,
  });
  assert.equal(readiness.canMergeNow, true);
  assert.deepEqual(readiness.mergeBlockers, []);
  assert.equal(readiness.checksFinished, true);
});

test("each unready fact is named as its own blocker", () => {
  const cases: Array<{
    readiness: ReturnType<typeof evaluatePullRequestReadiness>;
    blocker: string;
  }> = [
    {
      readiness: evaluatePullRequestReadiness(
        detail(),
        { state: "none", checks: [] },
        { changesRequested: false },
      ),
      blocker: "checks_not_found",
    },
    {
      readiness: evaluatePullRequestReadiness(
        detail(),
        {
          state: "pending",
          checks: [{ name: "test", status: "in_progress" }],
        },
        { changesRequested: false },
      ),
      blocker: "checks_pending",
    },
    {
      readiness: evaluatePullRequestReadiness(
        detail(),
        { ...green, truncated: true },
        { changesRequested: false },
      ),
      blocker: "checks_truncated",
    },
    {
      readiness: evaluatePullRequestReadiness(
        detail(),
        {
          state: "failure",
          total: 1,
          checks: [{ name: "test", status: "failure" }],
        },
        { changesRequested: false },
      ),
      blocker: "checks_failed",
    },
    {
      readiness: evaluatePullRequestReadiness(
        detail({ mergeable: null }),
        green,
        { changesRequested: false },
      ),
      blocker: "mergeability_unknown",
    },
    {
      readiness: evaluatePullRequestReadiness(
        detail({ mergeable: false }),
        green,
        { changesRequested: false },
      ),
      blocker: "provider_not_mergeable",
    },
    {
      readiness: evaluatePullRequestReadiness(detail(), green, null),
      blocker: "review_unknown",
    },
    {
      readiness: evaluatePullRequestReadiness(detail(), green, {
        changesRequested: true,
      }),
      blocker: "changes_requested",
    },
    {
      readiness: evaluatePullRequestReadiness(detail({ draft: true }), green, {
        changesRequested: false,
      }),
      blocker: "draft",
    },
    {
      readiness: evaluatePullRequestReadiness(
        detail({ state: "closed" }),
        green,
        null,
      ),
      blocker: "pull_request_closed",
    },
  ];
  for (const { readiness, blocker } of cases) {
    assert.equal(readiness.canMergeNow, false, blocker);
    assert.ok(
      readiness.mergeBlockers.includes(blocker),
      `${blocker} not in ${readiness.mergeBlockers.join(", ")}`,
    );
  }
});

test("checks are finished only when every observed one is terminal and complete", () => {
  assert.equal(checksAreFinished(green), true);
  assert.equal(checksAreFinished({ state: "none", checks: [] }), false);
  assert.equal(checksAreFinished({ ...green, truncated: true }), false);
  assert.equal(
    checksAreFinished({
      state: "pending",
      checks: [
        { name: "a", status: "success" },
        { name: "b", status: "queued" },
      ],
    }),
    false,
  );
});

// The fetching read is the SAME verdict over facts it gathers itself: this is
// what the finish tool calls, and it must not drift from the evaluation above.
test("the fetching read agrees with the evaluation over the same facts", async () => {
  const provider = {
    kind: "github",
    repoWebUrl: "https://github.com/acme/repo",
    pullRequestDetail: async () => detail({ mergeable: null }),
    refChecks: async () => green,
    pullRequestReview: async () => ({ changesRequested: false }),
  } as unknown as GitHostingProvider;
  const fetched = await readPullRequestReadiness(provider, 42);
  const evaluated = evaluatePullRequestReadiness(
    detail({ mergeable: null }),
    green,
    { changesRequested: false },
  );
  assert.deepEqual(fetched.mergeBlockers, evaluated.mergeBlockers);
  assert.equal(fetched.canMergeNow, evaluated.canMergeNow);
});

test("a pull request with no head commit refuses to be judged", async () => {
  const provider = {
    kind: "github",
    repoWebUrl: "https://github.com/acme/repo",
    pullRequestDetail: async () => detail({ headSha: "" }),
    refChecks: async () => green,
    pullRequestReview: async () => null,
  } as unknown as GitHostingProvider;
  await assert.rejects(
    readPullRequestReadiness(provider, 42),
    /no head commit SHA/,
  );
});
