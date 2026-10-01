/**
 * A merged pull request is shown in TWO places — the live card and the worktree
 * page — and merging is offered in both. Sharing only the provider call left
 * each surface updating its own store, so a merge in one left the other
 * offering Merge for a pull request that was already in. These tests drive the
 * shared projection from BOTH directions against a real repository (the card
 * match is by repo identity, which is a git question).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import type {
  PullRequestDetail,
  PullRequestRepositoryCapabilities,
} from "@assistant/shared";
import type { GitHostingProvider } from "./gitHosting.ts";
import {
  beginPullRequestCardObservation,
  createPullRequestCard,
  patchPullRequestCard,
  patchPullRequestCardObservation,
  pullRequestCardById,
  resetPullRequestCardsStoreForTests,
} from "./pullRequestCards.ts";
import {
  mergePullRequestAndProject,
  resetPullRequestMutationsForTests,
  suggestLinkedTaskDone,
  withPullRequestMutation,
} from "./pullRequestMerge.ts";
import { createTask, deleteTask, readTask, taskSummaryOf } from "./tasks.ts";
import {
  appendStep,
  createRun,
  resetWorkflowStoreForTests,
} from "./db/workflowStore.ts";

function repo(): string {
  const path = mkdtempSync(join(tmpdir(), "pr-merge-projection-"));
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: path });
  return path;
}

function fakeProvider(
  onMerge: () => void = () => undefined,
): GitHostingProvider {
  return {
    kind: "github",
    repoWebUrl: "https://github.com/acme/repo",
    findPullRequestForBranch: async () => null,
    findPullRequestsForBranch: async () => ({ open: [] }),
    createPullRequest: async () => {
      throw new Error("not used");
    },
    markPullRequestReady: async () => ({}),
    listOpenPullRequests: async () => [],
    ciStatus: async () => null,
    refChecks: async () => ({ state: "none", checks: [] }),
    pullRequestReview: async () => null,
    pullRequestDetail: async () => null,
    closePullRequest: async () => {
      throw new Error("not used");
    },
    repositoryCapabilities: async () => ({
      defaultBranch: "main",
      mergeMethods: ["squash", "merge", "rebase"],
      canClose: true,
    }),
    mergePullRequest: async (number, options) => {
      onMerge();
      return { number, method: options.method, branchDeleted: true };
    },
  };
}

afterEach(() => {
  resetPullRequestCardsStoreForTests();
  resetPullRequestMutationsForTests();
  resetWorkflowStoreForTests();
});

// The worktree page's merge must reach the card, or the card stays `open` until
// the watcher's slow poll — or forever, past its lifetime cap.
test("a merge issued from another checkout of the repo still closes the card", async () => {
  const path = repo();
  const card = createPullRequestCard(
    {
      sessionId: "session-1",
      status: "open",
      title: "Add /pr",
      headBranch: "feature",
      baseBranch: "main",
      provider: "github",
      number: 42,
    },
    {
      repoRoot: path,
      sessionKind: "developer",
      sessionId: "session-1",
      headBranch: "feature",
      baseBranch: "main",
      draft: false,
    },
  );

  // The watcher had already found it conflicting, and another stale poll is
  // still in flight when the merge lands.
  patchPullRequestCard(card.id, { mergeable: false, conflicts: true });
  const staleObservation = beginPullRequestCardObservation(card.id);

  const projection = await mergePullRequestAndProject({
    provider: fakeProvider(),
    // A DIFFERENT path string for the same repository, as the worktree page's
    // row would supply.
    repoPath: join(path, "."),
    number: 42,
    headBranch: "feature",
    baseBranch: "main",
    method: "squash",
  });

  assert.deepEqual(projection.cardIds, [card.id]);
  const after = pullRequestCardById(card.id)!;
  assert.equal(after.status, "merged");
  assert.match(after.actionMessage ?? "", /Merged #42 into main \(squash\)/);
  // A conflict badge on a pull request that is already in would be nonsense.
  assert.equal(after.conflicts, undefined);
  assert.equal(after.mergeable, undefined);
  assert.equal(
    patchPullRequestCardObservation(
      card.id,
      staleObservation,
      { status: "open", mergeable: false, conflicts: true },
      { observedHeadSha: "stale-head" },
    ),
    undefined,
    "a poll started before merge cannot reopen the merged card",
  );
  assert.equal(pullRequestCardById(card.id)?.status, "merged");
});

// Same number, same provider, different repository: never the same card.
test("a same-numbered pull request in another repository is left alone", async () => {
  const mine = repo();
  const theirs = repo();
  const card = createPullRequestCard(
    {
      sessionId: "session-1",
      status: "open",
      title: "Add /pr",
      headBranch: "feature",
      baseBranch: "main",
      provider: "github",
      number: 42,
    },
    {
      repoRoot: mine,
      sessionKind: "developer",
      sessionId: "session-1",
      headBranch: "feature",
      baseBranch: "main",
      draft: false,
    },
  );

  const projection = await mergePullRequestAndProject({
    provider: fakeProvider(),
    repoPath: theirs,
    number: 42,
    headBranch: "feature",
    baseBranch: "main",
    method: "merge",
  });

  assert.deepEqual(projection.cardIds, []);
  assert.equal(pullRequestCardById(card.id)?.status, "open");
});

test("the projection suggests the linked Task done, whichever surface merged", async () => {
  const path = repo();
  const task = createTask({
    title: "Ship the projection",
    source: { createdBy: "user" },
  });
  try {
    createPullRequestCard(
      {
        sessionId: "session-1",
        status: "open",
        title: "Add /pr",
        headBranch: "feature",
        baseBranch: "main",
        provider: "github",
        number: 42,
        linkedTask: taskSummaryOf(task),
      },
      {
        repoRoot: path,
        sessionKind: "developer",
        sessionId: "session-1",
        headBranch: "feature",
        baseBranch: "main",
        draft: false,
      },
    );

    await mergePullRequestAndProject({
      provider: fakeProvider(),
      repoPath: path,
      number: 42,
      headBranch: "feature",
      baseBranch: "main",
      method: "squash",
    });

    const stored = readTask(task.id)!;
    assert.notEqual(stored.status, "done", "still the user's call");
    assert.equal(stored.statusSuggestion?.to, "done");
    assert.equal(stored.statusSuggestion?.reason, "PR #42 merged");
  } finally {
    deleteTask(task.id);
  }
});

// Merging from the card must also drop the worktree page's cached hosting
// state, or that page keeps offering Merge for a merged pull request.
test("a refused merge is re-fetched and classified as a moved-base conflict", async () => {
  const path = repo();
  const card = createPullRequestCard(
    {
      sessionId: "session-1",
      status: "open",
      title: "Add /pr",
      headBranch: "feature",
      baseBranch: "main",
      provider: "github",
      number: 42,
    },
    {
      repoRoot: path,
      sessionKind: "developer",
      sessionId: "session-1",
      headBranch: "feature",
      baseBranch: "main",
      draft: false,
    },
  );
  let detailCalls = 0;
  let preRefetchToken = "";
  let staleDuringRefetch: unknown;
  const provider: GitHostingProvider = {
    ...fakeProvider(),
    mergePullRequest: async () => {
      preRefetchToken = beginPullRequestCardObservation(card.id);
      throw new Error("provider raw 405");
    },
    pullRequestDetail: async () => {
      detailCalls += 1;
      staleDuringRefetch = patchPullRequestCardObservation(
        card.id,
        preRefetchToken,
        { mergeable: true, conflicts: false },
        { observedHeadSha: "stale-head" },
      );
      return {
        number: 42,
        state: "open",
        merged: false,
        mergeable: false,
        draft: false,
        headSha: "a".repeat(40),
        headBranch: "feature",
        baseBranch: "main",
      };
    },
  };

  await assert.rejects(
    mergePullRequestAndProject({
      provider,
      repoPath: path,
      number: 42,
      headBranch: "feature",
      baseBranch: "main",
      method: "squash",
    }),
    /base moved; use Rebase and re-review/,
  );
  // Two reads: the binding re-read taken under the mutation lock, then the
  // refusal classification's own fresh one.
  assert.equal(detailCalls, 2);
  assert.equal(
    staleDuringRefetch,
    undefined,
    "classification reserves before fetching fresh provider detail",
  );
  assert.equal(pullRequestCardById(card.id)?.mergeable, false);
  assert.equal(pullRequestCardById(card.id)?.conflicts, true);
  assert.match(
    pullRequestCardById(card.id)?.actionError ?? "",
    /base moved; use Rebase and re-review/,
  );
});

/* --------------------- the workflow merge's preflight ---------------------- */

const REVIEWED = "d".repeat(40);

test("a caller's accepted head is always forwarded to the provider", async () => {
  const path = repo();
  let providerExpectedHead: string | undefined;
  const provider: GitHostingProvider = {
    ...fakeProvider(),
    pullRequestDetail: async () => ({
      number: 42,
      state: "open",
      merged: false,
      mergeable: true,
      draft: false,
      headSha: REVIEWED,
      headBranch: "feature",
      baseBranch: "main",
    }),
    mergePullRequest: async (number, options) => {
      providerExpectedHead = options.expectedHeadSha;
      return { number, method: options.method, branchDeleted: false };
    },
  };

  await mergePullRequestAndProject({
    provider,
    repoPath: path,
    number: 42,
    headBranch: "feature",
    baseBranch: "main",
    method: "squash",
    expectedHeadSha: REVIEWED,
  });

  assert.equal(providerExpectedHead, REVIEWED);
});

/** A live card plus the Workflow merge decision that names its reviewed head. */
function cardWithMergeDecision(path: string) {
  const card = createPullRequestCard(
    {
      sessionId: "session-1",
      status: "open",
      title: "Add /pr",
      headBranch: "feature",
      baseBranch: "main",
      provider: "github",
      number: 42,
    },
    {
      repoRoot: path,
      sessionKind: "developer",
      sessionId: "session-1",
      headBranch: "feature",
      baseBranch: "main",
      draft: false,
      observedHeadSha: REVIEWED,
    },
  );
  const run = createRun({
    taskId: 535,
    recipeId: "code-delivery",
    recipeVersion: 4,
    maxIterations: 3,
    maxReviewPasses: 1,
    actor: { kind: "system" },
  });
  appendStep({
    runId: run.id,
    kind: "user-decision",
    payload: {
      decision: "merge-pull-request",
      cardId: card.id,
      reviewedHeadCommit: REVIEWED,
      allowedChoices: ["merge", "cancel"],
    },
    actor: { kind: "system" },
  });
  return card;
}

/** One scripted answer to `pullRequestDetail`, in call order. */
type DetailAnswer =
  { mergeable: boolean | null; headSha?: string } | "unavailable" | "gone";

function detailingProvider(
  answers: DetailAnswer[],
  onMerge: () => void = () => undefined,
): { provider: GitHostingProvider; calls: () => number } {
  let calls = 0;
  return {
    provider: {
      ...fakeProvider(onMerge),
      pullRequestDetail: async () => {
        const answer = answers[Math.min(calls, answers.length - 1)]!;
        calls += 1;
        if (answer === "unavailable") throw new Error("provider unavailable");
        if (answer === "gone") return null;
        return {
          number: 42,
          state: "open" as const,
          merged: false,
          mergeable: answer.mergeable,
          draft: false,
          headSha: answer.headSha ?? REVIEWED,
          headBranch: "feature",
          baseBranch: "main",
        };
      },
    },
    calls: () => calls,
  };
}

// The preflight's `mergeable: false` is one read of a field Forgejo also
// answers `false` while its conflict check is queued, and this projection
// reaches an armed Workflow Run as a terminal base conflict. One `false` may
// therefore refuse THIS merge, but only a reproduced one may say the base moved
// and cost a rebase plus a whole re-review (Task 535).
test("a preflight conflict is not claimed until a second read reproduces it", async () => {
  const path = repo();
  const card = cardWithMergeDecision(path);
  let merged = 0;
  const { provider, calls } = detailingProvider(
    [{ mergeable: false }, { mergeable: true }],
    () => {
      merged += 1;
    },
  );

  await mergePullRequestAndProject({
    provider,
    repoPath: path,
    number: 42,
    headBranch: "feature",
    baseBranch: "main",
    method: "squash",
  });

  assert.equal(calls(), 2, "the conflicting read is asked again");
  assert.equal(merged, 1, "a check that settled clean still merges");
  assert.equal(pullRequestCardById(card.id)?.status, "merged");
});

// An answer that is still unknown is not a conflict either: the provider is the
// authority on whether a merge is allowed, and its own refusal — re-fetched and
// classified afterwards — is the evidence a single unanswered read is not.
test("a preflight answer that is still unknown goes to the provider", async () => {
  const path = repo();
  const card = cardWithMergeDecision(path);
  let merged = 0;
  const { provider } = detailingProvider(
    [{ mergeable: false }, { mergeable: null }],
    () => {
      merged += 1;
    },
  );

  await mergePullRequestAndProject({
    provider,
    repoPath: path,
    number: 42,
    headBranch: "feature",
    baseBranch: "main",
    method: "squash",
  });

  assert.equal(merged, 1);
  assert.equal(pullRequestCardById(card.id)?.conflicts, undefined);
});

test("a preflight conflict that reproduces refuses the merge and says so", async () => {
  const path = repo();
  const card = cardWithMergeDecision(path);
  let merged = 0;
  const { provider, calls } = detailingProvider(
    [{ mergeable: false }, { mergeable: false }],
    () => {
      merged += 1;
    },
  );

  await assert.rejects(
    mergePullRequestAndProject({
      provider,
      repoPath: path,
      number: 42,
      headBranch: "feature",
      baseBranch: "main",
      method: "squash",
    }),
    /base moved; use Rebase and re-review/,
  );

  assert.equal(calls(), 2);
  assert.equal(merged, 0);
  assert.equal(pullRequestCardById(card.id)?.conflicts, true);
  assert.equal(pullRequestCardById(card.id)?.mergeable, false);
});

// A second read that never happened confirms nothing. Restoring the first
// answer when the retry fails would make an unreachable provider the evidence
// for a rebase — the one thing the confirmation exists to prevent.
test("a preflight retry that fails or finds nothing confirms no conflict", async () => {
  for (const retry of ["unavailable", "gone"] as const) {
    const path = repo();
    const card = cardWithMergeDecision(path);
    let merged = 0;
    const { provider, calls } = detailingProvider(
      [{ mergeable: false }, retry],
      () => {
        merged += 1;
      },
    );

    await mergePullRequestAndProject({
      provider,
      repoPath: path,
      number: 42,
      headBranch: "feature",
      baseBranch: "main",
      method: "squash",
    });

    assert.equal(calls(), 2, retry);
    assert.equal(merged, 1, `${retry}: the provider decides instead`);
    const stored = pullRequestCardById(card.id);
    assert.equal(stored?.status, "merged", retry);
    assert.equal(stored?.conflicts, undefined, retry);
    assert.equal(
      stored?.actionError,
      undefined,
      `${retry}: no conflict is claimed`,
    );
    resetPullRequestCardsStoreForTests();
    resetWorkflowStoreForTests();
  }
});

// Two `false` answers about DIFFERENT heads are one read of each, not two of
// one: the first can be a stale snapshot from before the branch was republished.
test("a preflight retry about another head does not confirm the first", async () => {
  const path = repo();
  const card = cardWithMergeDecision(path);
  let merged = 0;
  const { provider, calls } = detailingProvider(
    [{ mergeable: false, headSha: "e".repeat(40) }, { mergeable: false }],
    () => {
      merged += 1;
    },
  );

  await mergePullRequestAndProject({
    provider,
    repoPath: path,
    number: 42,
    headBranch: "feature",
    baseBranch: "main",
    method: "squash",
  });

  assert.equal(calls(), 2);
  assert.equal(merged, 1, "only the provider may refuse on this evidence");
  assert.equal(pullRequestCardById(card.id)?.conflicts, undefined);
});

test("classifier bookkeeping failures cannot mask the provider refusal", async () => {
  const path = repo();
  createPullRequestCard(
    {
      sessionId: "session-1",
      status: "open",
      title: "Add /pr",
      headBranch: "feature",
      baseBranch: "main",
      provider: "github",
      number: 42,
    },
    {
      repoRoot: path,
      sessionKind: "developer",
      sessionId: "session-1",
      headBranch: "feature",
      baseBranch: "main",
      draft: false,
    },
  );
  const provider: GitHostingProvider = {
    ...fakeProvider(),
    mergePullRequest: async () => {
      throw new Error("required checks have not passed");
    },
    pullRequestDetail: async () => {
      // Simulate local bookkeeping disappearing after the provider refusal but
      // before best-effort classification projects its fresh detail.
      resetPullRequestCardsStoreForTests();
      return {
        number: 42,
        state: "open",
        merged: false,
        mergeable: false,
        draft: false,
        headSha: "a".repeat(40),
        headBranch: "feature",
        baseBranch: "main",
      };
    },
  };

  await assert.rejects(
    mergePullRequestAndProject({
      provider,
      repoPath: path,
      number: 42,
      headBranch: "feature",
      baseBranch: "main",
      method: "squash",
    }),
    /required checks have not passed/,
  );
});

test("a non-conflict merge refusal keeps the provider's raw message", async () => {
  const path = repo();
  const provider: GitHostingProvider = {
    ...fakeProvider(),
    mergePullRequest: async () => {
      throw new Error("required checks have not passed");
    },
    pullRequestDetail: async () => ({
      number: 42,
      state: "open",
      merged: false,
      mergeable: true,
      draft: false,
      headSha: "a".repeat(40),
      headBranch: "feature",
      baseBranch: "main",
    }),
  };

  await assert.rejects(
    mergePullRequestAndProject({
      provider,
      repoPath: path,
      number: 42,
      headBranch: "feature",
      baseBranch: "main",
      method: "squash",
    }),
    /required checks have not passed/,
  );
});

test("a provider merge failure never attempts the local base refresh", async () => {
  const path = repo();
  let refreshCalls = 0;
  const provider: GitHostingProvider = {
    ...fakeProvider(),
    mergePullRequest: async () => {
      throw new Error("provider refused");
    },
  };

  await assert.rejects(
    mergePullRequestAndProject(
      {
        provider,
        repoPath: path,
        number: 42,
        headBranch: "feature",
        baseBranch: "main",
        method: "squash",
        worktreeId: "worktree-1",
      },
      {
        refreshBaseCheckout: async () => {
          refreshCalls += 1;
          return "Updated main.";
        },
      },
    ),
    /provider refused/,
  );
  assert.equal(refreshCalls, 0);
});

test("the local base refresh outcome is appended to the merge sentence", async () => {
  const path = repo();
  const projection = await mergePullRequestAndProject(
    {
      provider: fakeProvider(),
      repoPath: path,
      number: 42,
      headBranch: "feature",
      baseBranch: "main",
      method: "squash",
      worktreeId: "worktree-1",
    },
    {
      refreshBaseCheckout: async () => "Updated main to a1b2c3d.",
    },
  );

  assert.match(
    projection.message,
    /Deleted the remote branch feature\. Updated main to a1b2c3d\.$/,
  );
});

test("a throwing local base refresh cannot fail an accepted merge", async () => {
  const path = repo();
  const projection = await mergePullRequestAndProject(
    {
      provider: fakeProvider(),
      repoPath: path,
      number: 42,
      headBranch: "feature",
      baseBranch: "main",
      method: "squash",
      worktreeId: "worktree-1",
    },
    {
      refreshBaseCheckout: async () => {
        throw new Error("local refresh failed");
      },
    },
  );

  assert.match(projection.message, /Merged #42 into main \(squash\)/);
  assert.doesNotMatch(projection.message, /local refresh|Updated main/);
});

test("the projection invalidates the hosting cache for every worktree it knows", async () => {
  const path = repo();
  const { worktreeHostingStatus, invalidateWorktreeHosting } =
    await import("./worktrees/worktreeHosting.ts");
  const row = {
    id: "wt-cache",
    projectId: "proj",
    mainRepoRoot: path,
    path,
    branch: "feature",
    baseBranch: "main",
    baseCommit: "",
    status: "active" as const,
    mergeStateJson: null,
    createdAt: 0,
    updatedAt: 0,
    removedAt: null,
  };
  // Prime the cache: no provider for this bare temp repo, so the payload is
  // empty — what matters is that an entry EXISTS and is dropped again.
  invalidateWorktreeHosting(row.id);
  const first = await worktreeHostingStatus(row);
  const cached = await worktreeHostingStatus(row);
  assert.equal(cached, first, "the second read came from the cache");

  await mergePullRequestAndProject({
    provider: fakeProvider(),
    repoPath: path,
    number: 42,
    headBranch: "feature",
    baseBranch: "main",
    method: "squash",
    worktreeId: row.id,
  });

  const afterMerge = await worktreeHostingStatus(row);
  assert.notEqual(
    afterMerge,
    first,
    "the merge must force the page to read hosting again",
  );
});

/* ------------------------- one pull request at a time ---------------------- */

// The schedule this lock exists for: a card is mid `update-with-main` (rebasing,
// about to force-push) when the worktree page merges the same pull request. The
// merge must be REFUSED before it touches the provider — otherwise the branch is
// merged and deleted under a rebase that then tries to publish rewritten
// history, and the merge's projection clears the running action's `busyAction`
// on the way past.
test("a merge is refused while the same pull request is being updated", async () => {
  const path = repo();
  let mergeCalls = 0;
  const provider = fakeProvider(() => {
    mergeCalls += 1;
  });

  let refused: unknown;
  await withPullRequestMutation(
    { repoPath: path, providerKind: "github", number: 42 },
    "an update with main",
    async () => {
      refused = await mergePullRequestAndProject({
        provider,
        repoPath: path,
        number: 42,
        headBranch: "feature",
        baseBranch: "main",
        method: "squash",
      }).catch((err: unknown) => err);
    },
  );

  assert.ok(refused instanceof Error);
  assert.match((refused as Error).message, /is busy: an update with main/);
  assert.equal(mergeCalls, 0, "refused BEFORE any provider side effect");
});

// The identity is the pull request, not the checkout path or the card: another
// repository's #42 is a different pull request and must not be blocked.
test("the hold is per pull request, and released again afterwards", async () => {
  const mine = repo();
  const theirs = repo();
  await withPullRequestMutation(
    { repoPath: mine, providerKind: "github", number: 42 },
    "a merge",
    async () => {
      // Same number, other repository: untouched.
      await withPullRequestMutation(
        { repoPath: theirs, providerKind: "github", number: 42 },
        "a merge",
        async () => undefined,
      );
      await assert.rejects(
        withPullRequestMutation(
          { repoPath: mine, providerKind: "github", number: 42 },
          "a merge",
          async () => undefined,
        ),
        /is busy/,
      );
    },
  );

  // Released: the same identity can be taken again.
  await withPullRequestMutation(
    { repoPath: mine, providerKind: "github", number: 42 },
    "a merge",
    async () => undefined,
  );
});

/* ------------------- what the lock binds besides the head ------------------- */

/** A provider whose current answer differs from what the caller decided on. */
function retargetingProvider(
  detail: Partial<PullRequestDetail>,
  onMerge: () => void = () => undefined,
): GitHostingProvider {
  return {
    ...fakeProvider(onMerge),
    pullRequestDetail: async () => ({
      number: 42,
      state: "open" as const,
      merged: false,
      mergeable: true,
      draft: false,
      headSha: REVIEWED,
      headBranch: "feature",
      baseBranch: "main",
      ...detail,
    }),
  };
}

// The head SHA does not identify what is being merged. An external RETARGET
// moves a pull request onto another base while keeping that exact head, so the
// provider's expected-head precondition still passes — and a managed merge
// classified as "non-default base, no approval needed" would land on the
// default branch anyway. The branches are therefore bound under the lock.
test("a pull request retargeted onto another base is not merged", async () => {
  const path = repo();
  let merged = 0;
  await assert.rejects(
    mergePullRequestAndProject({
      provider: retargetingProvider({ baseBranch: "main" }, () => {
        merged += 1;
      }),
      repoPath: path,
      number: 42,
      headBranch: "feature",
      baseBranch: "release-2",
      method: "squash",
      expectedHeadSha: REVIEWED,
    }),
    /now feature → main, not the feature → release-2 this merge was decided for/,
  );
  assert.equal(merged, 0, "nothing may reach the provider after a retarget");
});

test("a head branch that no longer matches the decision is not merged", async () => {
  const path = repo();
  let merged = 0;
  await assert.rejects(
    mergePullRequestAndProject({
      provider: retargetingProvider({ headBranch: "someone-elses" }, () => {
        merged += 1;
      }),
      repoPath: path,
      number: 42,
      headBranch: "feature",
      baseBranch: "main",
      method: "squash",
      expectedHeadSha: REVIEWED,
    }),
    /now someone-elses → main/,
  );
  assert.equal(merged, 0);
});

test("a pull request turned back into a draft is not merged", async () => {
  const path = repo();
  let merged = 0;
  await assert.rejects(
    mergePullRequestAndProject({
      provider: retargetingProvider({ draft: true }, () => {
        merged += 1;
      }),
      repoPath: path,
      number: 42,
      headBranch: "feature",
      baseBranch: "main",
      method: "squash",
      expectedHeadSha: REVIEWED,
    }),
    /is a draft again/,
  );
  assert.equal(merged, 0);
});

// The same binding protects the ordinary card click, which carries no accepted
// head: it merges when the provider cannot be asked, but never against an
// answer that contradicts the card it was clicked on.
test("a card click is refused by a contradicting answer and tolerates none", async () => {
  const path = repo();
  let merged = 0;
  await assert.rejects(
    mergePullRequestAndProject({
      provider: retargetingProvider({ baseBranch: "main" }, () => {
        merged += 1;
      }),
      repoPath: path,
      number: 42,
      headBranch: "feature",
      baseBranch: "release-2",
      method: "squash",
    }),
    /not the feature → release-2 this merge was decided for/,
  );
  assert.equal(merged, 0);

  const projection = await mergePullRequestAndProject({
    // `fakeProvider` answers no detail at all — an older surface, or a provider
    // that could not be asked. The click still merges.
    provider: fakeProvider(() => {
      merged += 1;
    }),
    repoPath: path,
    number: 42,
    headBranch: "feature",
    baseBranch: "main",
    method: "squash",
  });
  assert.equal(merged, 1);
  assert.equal(projection.result.number, 42);
});

// A caller that accepted an exact head demands the current answer; merging
// without it would be merging blind under the lock.
test("an unreadable pull request refuses a merge that accepted a head", async () => {
  const path = repo();
  let merged = 0;
  const provider: GitHostingProvider = {
    ...fakeProvider(() => {
      merged += 1;
    }),
    pullRequestDetail: async () => null,
  };
  await assert.rejects(
    mergePullRequestAndProject({
      provider,
      repoPath: path,
      number: 42,
      headBranch: "feature",
      baseBranch: "main",
      method: "squash",
      expectedHeadSha: REVIEWED,
    }),
    /could not be re-read before merging/,
  );
  assert.equal(merged, 0);
});

/* ------------- the capability guard every merge surface passes -------------- */

/** A provider whose repository settings can be changed between merges. */
function capabilityProvider(
  capabilities: () => Promise<PullRequestRepositoryCapabilities>,
  onMerge: () => void = () => undefined,
): GitHostingProvider {
  return { ...fakeProvider(onMerge), repositoryCapabilities: capabilities };
}

// The managed tool checks capabilities before it decides, but the live card and
// the worktree page's HTTP route reach the provider through this seam alone: a
// picker rendered before the repository turned a method off would otherwise
// merge with it.
test("a method the repository does not allow is refused for every surface", async () => {
  const path = repo();
  let merged = 0;
  await assert.rejects(
    mergePullRequestAndProject({
      provider: capabilityProvider(
        async () => ({ defaultBranch: "main", mergeMethods: ["merge"] }),
        () => {
          merged += 1;
        },
      ),
      repoPath: path,
      number: 42,
      headBranch: "feature",
      baseBranch: "main",
      method: "squash",
    }),
    /does not allow the squash merge method.*Supported: merge/s,
  );
  assert.equal(merged, 0, "nothing may reach the provider");
});

test("unknown merge capabilities refuse the merge rather than guessing", async () => {
  const path = repo();
  let merged = 0;
  await assert.rejects(
    mergePullRequestAndProject({
      provider: capabilityProvider(
        async () => {
          throw new Error("repository settings unavailable");
        },
        () => {
          merged += 1;
        },
      ),
      repoPath: path,
      number: 42,
      headBranch: "feature",
      baseBranch: "main",
      method: "squash",
    }),
    /supported merge methods could not be read.*settings unavailable/s,
  );
  assert.equal(merged, 0);
});

// "Runtime revalidation is authoritative" means the merge asks what the
// repository allows NOW: an answer cached from a minute ago is exactly the
// stale permission this guard exists to catch.
test("the guard re-reads capabilities instead of trusting the cache", async () => {
  const path = repo();
  let allowSquash = true;
  let reads = 0;
  const provider = capabilityProvider(async () => {
    reads += 1;
    return {
      defaultBranch: "main",
      mergeMethods: allowSquash ? ["squash", "merge"] : ["merge"],
    };
  });

  const first = await mergePullRequestAndProject({
    provider,
    repoPath: path,
    number: 42,
    headBranch: "feature",
    baseBranch: "main",
    method: "squash",
  });
  assert.equal(first.result.method, "squash");

  allowSquash = false;
  await assert.rejects(
    mergePullRequestAndProject({
      provider,
      repoPath: path,
      number: 42,
      headBranch: "feature",
      baseBranch: "main",
      method: "squash",
    }),
    /does not allow the squash merge method/,
  );
  assert.equal(reads, 2, "each merge reads the repository's own answer");
});

/* --------------------- what a Task suggestion may claim --------------------- */

/** One open card for pull request #42 in `path`, linked to `task`. */
function linkedCard(
  path: string,
  task: ReturnType<typeof createTask>,
  sessionId: string,
) {
  return createPullRequestCard(
    {
      sessionId,
      status: "open",
      title: "Add /pr",
      headBranch: "feature",
      baseBranch: "main",
      provider: "github",
      number: 42,
      linkedTask: taskSummaryOf(task),
    },
    {
      repoRoot: path,
      sessionKind: "developer",
      sessionId,
      headBranch: "feature",
      baseBranch: "main",
      draft: false,
    },
  );
}

// Two sessions can hold their own card for the SAME pull request and the same
// Task. Repeating the suggestion writes nothing (the first timestamp is what
// says how long it has sat unanswered), so reporting it twice would describe
// one write as two.
test("duplicate cards for one Task report a single suggestion", async () => {
  const path = repo();
  const task = createTask({
    title: "Ship the projection",
    source: { createdBy: "user" },
  });
  try {
    const first = linkedCard(path, task, "session-1");
    const second = linkedCard(path, task, "session-2");

    const projection = await mergePullRequestAndProject({
      provider: fakeProvider(),
      repoPath: path,
      number: 42,
      headBranch: "feature",
      baseBranch: "main",
      method: "squash",
    });

    assert.equal(projection.cardIds.length, 2);
    assert.deepEqual(
      projection.taskSuggestions.map((suggestion) => suggestion.id),
      [task.id],
    );
    // Both cards still show the Task with its standing suggestion.
    for (const id of [first.id, second.id])
      assert.equal(
        pullRequestCardById(id)?.linkedTask?.statusSuggestion?.to,
        "done",
      );
    assert.equal(readTask(task.id)?.statusSuggestion?.to, "done");
  } finally {
    deleteTask(task.id);
  }
});

// A suggestion the watcher (or an earlier merge attempt) already left standing
// is not this projection's write, and claiming it would tell an agent a fresh
// decision is waiting when the same one has been waiting all along.
test("a suggestion that already stood is not claimed as newly written", async () => {
  const path = repo();
  const task = createTask({
    title: "Ship the projection",
    source: { createdBy: "user" },
  });
  try {
    const card = linkedCard(path, task, "session-1");
    // Whatever wrote it first — the watcher observing the provider's own merge.
    suggestLinkedTaskDone(pullRequestCardById(card.id)!);
    const suggestedAt = readTask(task.id)?.statusSuggestion?.at;
    assert.equal(readTask(task.id)?.statusSuggestion?.to, "done");

    const projection = await mergePullRequestAndProject({
      provider: fakeProvider(),
      repoPath: path,
      number: 42,
      headBranch: "feature",
      baseBranch: "main",
      method: "squash",
    });

    assert.deepEqual(projection.taskSuggestions, []);
    assert.equal(
      readTask(task.id)?.statusSuggestion?.at,
      suggestedAt,
      "the standing suggestion is left exactly as it was",
    );
  } finally {
    deleteTask(task.id);
  }
});

/* ------------ what a managed decision still has to be true about ----------- */

/**
 * A provider whose capability read runs a callback — so a test can move the
 * world (a retarget, a settings change) DURING that network round trip.
 */
function providerWithCapabilityHook(
  capabilities: () => Promise<PullRequestRepositoryCapabilities>,
  detail: () => PullRequestDetail,
  onMerge: () => void = () => undefined,
): GitHostingProvider {
  return {
    ...fakeProvider(onMerge),
    repositoryCapabilities: capabilities,
    pullRequestDetail: async () => detail(),
  };
}

// The capability read is a network round trip. Whatever it learns must not sit
// between the identity check and the provider merge: a retarget landing in that
// gap keeps the accepted head, satisfies the provider's precondition, and lands
// on a base nobody classified. So the pull request's own identity is the LAST
// thing read before merging.
test("a retarget during the capability read still refuses the merge", async () => {
  const path = repo();
  let base = "release-2";
  let merged = 0;
  const provider = providerWithCapabilityHook(
    async () => {
      // The world moves while the capability GET is in flight.
      base = "main";
      return { defaultBranch: "main", mergeMethods: ["squash"] };
    },
    () => ({
      number: 42,
      state: "open",
      merged: false,
      mergeable: true,
      draft: false,
      headSha: REVIEWED,
      headBranch: "feature",
      baseBranch: base,
    }),
    () => {
      merged += 1;
    },
  );

  await assert.rejects(
    mergePullRequestAndProject({
      provider,
      repoPath: path,
      number: 42,
      headBranch: "feature",
      baseBranch: "release-2",
      method: "squash",
      expectedHeadSha: REVIEWED,
      managedDecision: { baseIsDefaultBranch: false, defaultBranch: "main" },
    }),
    /is now feature → main, not the feature → release-2 this merge was decided for/,
  );
  assert.equal(merged, 0);
});

// The classification, not just the method, is what made a managed merge
// pre-authorized: "this base is not the default branch". If the repository's
// default moves onto this base, that judgement is void even though the pull
// request never changed.
test("a default branch that moved onto this base refuses a direct merge", async () => {
  const path = repo();
  let merged = 0;
  await assert.rejects(
    mergePullRequestAndProject({
      provider: capabilityProvider(
        async () => ({ defaultBranch: "release-2", mergeMethods: ["squash"] }),
        () => {
          merged += 1;
        },
      ),
      repoPath: path,
      number: 42,
      headBranch: "feature",
      baseBranch: "release-2",
      method: "squash",
      managedDecision: { baseIsDefaultBranch: false, defaultBranch: "main" },
    }),
    /default branch changed from main to release-2/,
  );
  assert.equal(merged, 0);
});

// The mirror case: a human approved merging into the DEFAULT branch. Once the
// base is no longer the default, the approval answered a different question.
test("an approved merge whose base stopped being the default refuses", async () => {
  const path = repo();
  let merged = 0;
  const provider = providerWithCapabilityHook(
    async () => ({ defaultBranch: "main", mergeMethods: ["squash", "merge"] }),
    () => ({
      number: 42,
      state: "open",
      merged: false,
      mergeable: true,
      draft: false,
      headSha: REVIEWED,
      headBranch: "feature",
      // The pull request still targets what was approved; the repository's
      // default moved off it.
      baseBranch: "release-2",
    }),
    () => {
      merged += 1;
    },
  );
  await assert.rejects(
    mergePullRequestAndProject({
      provider,
      repoPath: path,
      number: 42,
      headBranch: "feature",
      baseBranch: "release-2",
      method: "squash",
      expectedHeadSha: REVIEWED,
      managedDecision: {
        baseIsDefaultBranch: true,
        defaultBranch: "main",
        approvedMethods: ["squash", "merge"],
      },
    }),
    /no longer the repository default branch main/,
  );
  assert.equal(merged, 0);
});

// The frozen set is part of the answer, enforced centrally rather than only in
// the approval's own revalidation.
test("an approved merge refuses when the offered method set changed", async () => {
  const path = repo();
  let merged = 0;
  await assert.rejects(
    mergePullRequestAndProject({
      provider: capabilityProvider(
        async () => ({
          defaultBranch: "main",
          mergeMethods: ["squash", "merge", "rebase"],
        }),
        () => {
          merged += 1;
        },
      ),
      repoPath: path,
      number: 42,
      headBranch: "feature",
      baseBranch: "main",
      method: "squash",
      managedDecision: {
        baseIsDefaultBranch: true,
        defaultBranch: "main",
        approvedMethods: ["squash", "merge"],
      },
    }),
    /changed from the approved squash, merge to squash, merge, rebase/,
  );
  assert.equal(merged, 0);
});

// An ordinary card click states no decision, so none of the above applies to
// it: the repository's default branch is simply not its business.
test("a human merge is unaffected by where the default branch sits", async () => {
  const path = repo();
  const projection = await mergePullRequestAndProject({
    provider: capabilityProvider(async () => ({
      defaultBranch: "main",
      mergeMethods: ["squash"],
    })),
    repoPath: path,
    number: 42,
    headBranch: "feature",
    baseBranch: "main",
    method: "squash",
  });
  assert.equal(projection.result.method, "squash");
});

/* ------------ what the seam hands the provider to merge with --------------- */

/** Capture the options the seam passes to `mergePullRequest`. */
function optionCapturingProvider(detail: PullRequestDetail | null): {
  provider: GitHostingProvider;
  options: () => Record<string, unknown> | undefined;
} {
  let captured: Record<string, unknown> | undefined;
  return {
    provider: {
      ...fakeProvider(),
      pullRequestDetail: async () => detail,
      mergePullRequest: async (number, options) => {
        captured = { ...options };
        return { number, method: options.method, branchDeleted: true };
      },
    },
    options: () => captured,
  };
}

// The seam proved the head branch a moment earlier, so the provider must not
// have to look it up again: that lookup is a round trip the identity check no
// longer covers, and a retarget inside it keeps the expected head.
test("a verified merge hands the provider the branch it proved", async () => {
  const path = repo();
  const { provider, options } = optionCapturingProvider({
    number: 42,
    state: "open",
    merged: false,
    mergeable: true,
    draft: false,
    headSha: REVIEWED,
    headBranch: "feature",
    baseBranch: "main",
  });

  await mergePullRequestAndProject({
    provider,
    repoPath: path,
    number: 42,
    headBranch: "feature",
    baseBranch: "main",
    method: "squash",
    expectedHeadSha: REVIEWED,
  });

  assert.equal(options()?.headBranch, "feature");
  assert.equal(options()?.expectedBaseBranch, "main");
});

// An ordinary click carries no REVIEWED head — nobody decided one — but it did
// just read one, and a push landing between that read and the merge must not be
// merged silently. So the head it validated becomes the merge's precondition.
test("a human merge is conditioned on the head it just validated", async () => {
  const path = repo();
  const { provider, options } = optionCapturingProvider({
    number: 42,
    state: "open",
    merged: false,
    mergeable: true,
    draft: false,
    headSha: "b".repeat(40),
    headBranch: "feature",
    baseBranch: "main",
  });

  const projection = await mergePullRequestAndProject({
    provider,
    repoPath: path,
    number: 42,
    headBranch: "feature",
    baseBranch: "main",
    method: "squash",
    // No expectedHeadSha: this is a card click, not a reviewed decision.
  });

  assert.equal(options()?.expectedHeadSha, "b".repeat(40));
  assert.equal(projection.result.number, 42);
});

// A click whose provider could not be asked proved nothing about the branch, so
// it says nothing about it either — the provider reads the ref itself and
// refuses what it then sees moved.
test("a merge that could not verify the branch names none", async () => {
  const path = repo();
  const { provider, options } = optionCapturingProvider(null);

  await mergePullRequestAndProject({
    provider,
    repoPath: path,
    number: 42,
    headBranch: "feature",
    baseBranch: "main",
    method: "squash",
  });

  assert.equal(options()?.headBranch, undefined);
  assert.equal(options()?.expectedBaseBranch, "main");
});

/* --------- what a refusal may be blamed on when the head moved ------------- */

/** One open card for #42 in `path`, with no linked Task. */
function plainCard(path: string) {
  return createPullRequestCard(
    {
      sessionId: "session-1",
      status: "open",
      title: "Add /pr",
      headBranch: "feature",
      baseBranch: "main",
      provider: "github",
      number: 42,
    },
    {
      repoRoot: path,
      sessionKind: "developer",
      sessionId: "session-1",
      headBranch: "feature",
      baseBranch: "main",
      draft: false,
    },
  );
}

/**
 * A provider that validates one head, refuses the merge the way an atomic head
 * precondition does, and then answers about a DIFFERENT head — the exact race
 * the precondition exists to catch, with a push landing in between.
 */
function headMovedUnderMergeProvider(heads: {
  validated: string;
  published: string;
}): GitHostingProvider {
  let reads = 0;
  return {
    ...fakeProvider(),
    pullRequestDetail: async () => {
      reads += 1;
      return {
        number: 42,
        state: "open",
        merged: false,
        // Forgejo reports a just-published head as not mergeable while it
        // recomputes; that answer is about the NEW head, not the base.
        mergeable: reads === 1 ? true : false,
        draft: false,
        headSha: reads === 1 ? heads.validated : heads.published,
        headBranch: "feature",
        baseBranch: "main",
      };
    },
    mergePullRequest: async () => {
      throw new Error(
        "Head branch was modified. Review and try the merge again.",
      );
    },
  };
}

// The refusal came from the head precondition, so it says nothing about the
// base. Claiming a conflict here would tell the user to rebase and hand an
// armed Workflow Run a terminal conflict, when the branch simply moved.
test("a head that moved under the merge is not called a base conflict", async () => {
  const path = repo();
  const card = plainCard(path);
  const validated = "a".repeat(40);
  const published = "b".repeat(40);

  await assert.rejects(
    mergePullRequestAndProject({
      provider: headMovedUnderMergeProvider({ validated, published }),
      repoPath: path,
      number: 42,
      headBranch: "feature",
      baseBranch: "main",
      method: "squash",
    }),
    // The provider's own refusal stands, NOT a rewritten base-moved verdict.
    /Head branch was modified/,
  );

  const after = pullRequestCardById(card.id)!;
  assert.notEqual(
    after.conflicts,
    true,
    "a moved head is no evidence about the base",
  );
  assert.equal(after.status, "open");
  assert.equal(
    /base moved/.test(after.actionError ?? ""),
    false,
    "the card must not carry a rebase instruction for a moved head",
  );
});

// The same read, about the SAME head the merge was refused for, is still
// confirmed evidence: that is what the classification exists for.
test("a conflict about the refused head is still confirmed", async () => {
  const path = repo();
  const card = plainCard(path);
  const head = "c".repeat(40);
  const provider: GitHostingProvider = {
    ...fakeProvider(),
    pullRequestDetail: async () => ({
      number: 42,
      state: "open",
      merged: false,
      mergeable: false,
      draft: false,
      headSha: head,
      headBranch: "feature",
      baseBranch: "main",
    }),
    mergePullRequest: async () => {
      throw new Error("provider raw 405");
    },
  };

  await assert.rejects(
    mergePullRequestAndProject({
      provider,
      repoPath: path,
      number: 42,
      headBranch: "feature",
      baseBranch: "main",
      method: "squash",
    }),
    /base moved; use Rebase and re-review/,
  );
  assert.equal(pullRequestCardById(card.id)?.conflicts, true);
});

// With no head to tie the refusal to — the seam could not read the pull request
// at all, so the provider conditioned on a head only it saw — nothing may be
// attributed to the base either.
test("a refusal with no known conditioned head claims no conflict", async () => {
  const path = repo();
  const card = plainCard(path);
  let reads = 0;
  const provider: GitHostingProvider = {
    ...fakeProvider(),
    pullRequestDetail: async () => {
      reads += 1;
      // The seam's own binding read fails; only the classification answers.
      if (reads === 1) return null;
      return {
        number: 42,
        state: "open",
        merged: false,
        mergeable: false,
        draft: false,
        headSha: "d".repeat(40),
        headBranch: "feature",
        baseBranch: "main",
      };
    },
    mergePullRequest: async () => {
      throw new Error("provider raw 409");
    },
  };

  await assert.rejects(
    mergePullRequestAndProject({
      provider,
      repoPath: path,
      number: 42,
      headBranch: "feature",
      baseBranch: "main",
      method: "squash",
    }),
    /provider raw 409/,
  );
  assert.notEqual(pullRequestCardById(card.id)?.conflicts, true);
});
