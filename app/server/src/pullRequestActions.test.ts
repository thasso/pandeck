/**
 * The card actions are mostly ORDER and REFUSAL, and both are the whole point:
 * cleanup removes a checkout, so it must refresh the base first, verify
 * containment, and stop dead when the branch is not in the base; a conflicted
 * update hands the work to the agent instead of failing at the user; and a
 * provider refusal must leave an open pull request open.
 *
 * The git and provider seams are injected (`PullRequestActionOperations`), the
 * same way `prWorkflow.test.ts` drives the workflow: real worktrees would test
 * git, not these decisions.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
  applyPatch,
  type Patch,
  type PullRequestMergeMethod,
} from "@assistant/shared";
import { taskStore } from "./db/taskStore.ts";
import { insertWorktree, type WorktreeRow } from "./db/worktreeStore.ts";
import type { GitHostingProvider } from "./gitHosting.ts";
import {
  beginPullRequestCardObservation,
  createPullRequestCard,
  patchPullRequestCard,
  patchPullRequestCardObservation,
  pullRequestCardById,
  pullRequestCardRecord,
  resetPullRequestCardsStoreForTests,
  type CreatePullRequestCardInput,
} from "./pullRequestCards.ts";
import {
  reconcilePullRequestCardActionsOnBoot,
  recordRebaseHandoff,
  runPullRequestCardAction,
  runPullRequestCardActionWithActor,
  type PullRequestActionOperations,
} from "./pullRequestActions.ts";
import {
  beginPromptRun,
  reserveWorktreeForRemoval,
  resetSessionRunLeasesForTests,
  setSessionWorktreeResolverForTests,
} from "./session/sessionRunLease.ts";
import { createTask, deleteTask, readTask, taskSummaryOf } from "./tasks.ts";
import { validateClientMessage } from "./validateClientMessage.ts";
import { WorktreeSyncConflictError } from "./worktrees/worktreeSync.ts";

const context = {
  repoRoot: "/tmp/pr-actions-repo",
  sessionKind: "developer" as const,
  sessionId: "session-1",
  headBranch: "feature",
  baseBranch: "main",
  draft: false,
};

const worktreeRow: WorktreeRow = {
  id: "wt-1",
  projectId: "proj",
  mainRepoRoot: "/tmp/pr-actions-repo",
  path: "/tmp/pr-actions-repo-feature",
  branch: "feature",
  baseBranch: "main",
  baseCommit: "abc",
  status: "active",
  mergeStateJson: null,
  createdAt: 1,
  updatedAt: 1,
  removedAt: null,
};

const mainRow: WorktreeRow = {
  ...worktreeRow,
  id: "main:proj",
  path: "/tmp/pr-actions-repo",
};

function card(overrides: Patch<CreatePullRequestCardInput> = {}) {
  return createPullRequestCard(
    applyPatch(
      {
        sessionId: "session-1",
        status: "open",
        title: "Add /pr",
        headBranch: "feature",
        baseBranch: "main",
        provider: "github",
        number: 42,
        url: "https://github.com/acme/repo/pull/42",
        worktreeId: "wt-1",
      },
      overrides,
    ),
    context,
  );
}

interface Recorder {
  calls: string[];
  operations: PullRequestActionOperations;
  merges: Array<{
    number: number;
    method: PullRequestMergeMethod;
    deleteBranch?: boolean;
  }>;
}

function recorder(
  overrides: Partial<PullRequestActionOperations> = {},
  mergeImpl?: GitHostingProvider["mergePullRequest"],
): Recorder {
  const calls: string[] = [];
  const merges: Recorder["merges"] = [];
  const provider: GitHostingProvider = {
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
    mergePullRequest:
      mergeImpl ??
      (async (number, options) => {
        calls.push(`merge:${options.method}`);
        merges.push({ number, ...options });
        return { number, method: options.method, branchDeleted: true };
      }),
  };
  const operations: PullRequestActionOperations = {
    resolveProvider: async () => provider,
    worktreeRow: async () => worktreeRow,
    mainRow: async () => mainRow,
    async sync(row, operation) {
      calls.push(`${operation}:${row.id}`);
      return "updated";
    },
    async refreshBase(row) {
      calls.push(`refresh-base:${row.baseBranch}`);
      return "refreshed-base-oid";
    },
    async branchContained() {
      calls.push("contained");
      return true;
    },
    async removeWorktree(worktreeId) {
      calls.push(`remove:${worktreeId}`);
    },
    async pushBranch() {
      calls.push("push");
      return { status: "pushed" };
    },
    async headCommit() {
      calls.push("head-commit");
      return "local-head";
    },
    sessionSettleBlockedReason: async () => undefined,
    // The REAL lease: the race these tests are about is between this hold and
    // the prompt facade's check, so faking it would test nothing.
    reserveWorktreeForRemoval,
    liveSessionsForWorktree: () => ["session-1"],
    settleWorktreeSessions: () => {
      calls.push("settle");
    },
    ...overrides,
  };
  return { calls, operations, merges };
}

afterEach(() => {
  resetPullRequestCardsStoreForTests();
  resetSessionRunLeasesForTests();
});

/** Every session in these tests lives in the card's worktree. */
function sessionsRunIn(worktreeId: string | undefined): void {
  setSessionWorktreeResolverForTests(() => worktreeId);
}

/* --------------------------------- merge ---------------------------------- */

test("merging uses the chosen method, deletes the remote branch, and lands the card in merged", async () => {
  const subject = card();
  const rec = recorder();

  const { card: updated } = await runPullRequestCardAction(
    subject.id,
    "merge",
    { mergeMethod: "squash" },
    rec.operations,
  );

  // The seam tells the provider which base this click decided on. It cannot
  // name the head branch here: this provider answers no detail, so nothing
  // proved it, and the provider looks the ref up itself (see gitHosting).
  assert.deepEqual(rec.merges, [
    {
      number: 42,
      method: "squash",
      deleteBranch: true,
      expectedBaseBranch: "main",
    },
  ]);
  assert.equal(updated.status, "merged");
  assert.equal(updated.busyAction, undefined);
  assert.match(updated.actionMessage ?? "", /Merged #42 into main \(squash\)/);
});

// The opt-out reaches the PROVIDER call, and the card says the branch survived:
// a message claiming a deletion that was never asked for is the one thing worse
// than not offering the choice at all.
test("a merge that keeps the remote branch asks the provider to keep it", async () => {
  const subject = card();
  const seen: Array<{ deleteBranch?: boolean }> = [];
  const rec = recorder({}, async (number, options) => {
    seen.push({
      ...(options.deleteBranch !== undefined
        ? { deleteBranch: options.deleteBranch }
        : {}),
    });
    return { number, method: options.method, branchDeleted: false };
  });

  const { card: updated } = await runPullRequestCardAction(
    subject.id,
    "merge",
    { mergeMethod: "merge", deleteBranch: false },
    rec.operations,
  );

  assert.deepEqual(seen, [{ deleteBranch: false }]);
  assert.equal(updated.status, "merged");
  assert.match(
    updated.actionMessage ?? "",
    /Merged #42 into main \(merge\)\. The remote branch feature was kept\./,
  );
});

// A pull request outlives the checkout it was published from, and retiring the
// worktree is the ordinary end of a delivery. Resolving hosting only from that
// deleted directory made a merge the run is still waiting for impossible to
// perform from the only surface that offers it.
test("a card whose worktree was removed still merges, through the main checkout", async () => {
  insertWorktree({
    id: "wt-retired",
    projectId: "proj",
    mainRepoRoot: "/tmp/pr-actions-main",
    path: context.repoRoot,
    branch: "feature",
    baseBranch: "main",
    baseCommit: "abc",
    status: "removed",
    mergeStateJson: null,
    createdAt: 1,
    updatedAt: 1,
    removedAt: 2,
  });
  const subject = card({ worktreeId: "wt-retired" });
  const rec = recorder();
  const configured = rec.operations.resolveProvider;
  const asked: string[] = [];
  rec.operations.resolveProvider = async (repoRoot, remote) => {
    asked.push(repoRoot);
    // The deleted checkout answers nothing, exactly as `git remote get-url` does.
    return repoRoot === "/tmp/pr-actions-main"
      ? configured(repoRoot, remote)
      : null;
  };

  const { card: updated } = await runPullRequestCardAction(
    subject.id,
    "merge",
    { mergeMethod: "squash" },
    rec.operations,
  );

  assert.deepEqual(asked, ["/tmp/pr-actions-main"]);
  // The card is also MATCHED to the pull request through that same checkout: a
  // deleted path is only ever its own lock key, so the merge would otherwise
  // project onto no card at all and leave this one open.
  assert.equal(updated.status, "merged");
});

// The click ANSWERS the suggestion a merge leaves behind, so it may not close
// the Task while the pull request is still open — the client hides the button
// then, but a stale or hand-made message must be refused too.
test("marking the Task done is refused before the pull request is merged", async () => {
  const task = createTask({
    title: "Not shipped yet",
    source: { createdBy: "user" },
  });
  try {
    const subject = card({ linkedTask: taskSummaryOf(task) });
    await assert.rejects(
      runPullRequestCardAction(
        subject.id,
        "mark-task-done",
        {},
        recorder().operations,
      ),
      /not answered by merging yet/,
    );
    assert.notEqual(readTask(task.id)?.status, "done");
  } finally {
    deleteTask(task.id);
  }
});

// The provider is the authority on whether a merge is allowed. Its refusal is
// news about an OPEN pull request, not a state change.
test("a refused merge leaves the card open and says why", async () => {
  const subject = card();
  const rec = recorder({}, async () => {
    throw new Error("At least 1 approving review is required.");
  });

  await assert.rejects(
    runPullRequestCardAction(
      subject.id,
      "merge",
      { mergeMethod: "merge" },
      rec.operations,
    ),
    /approving review/,
  );
  const after = pullRequestCardById(subject.id)!;
  assert.equal(after.status, "open");
  assert.equal(after.busyAction, undefined);
  assert.match(after.actionError ?? "", /approving review/);
});

test("a merged pull request suggests its linked Task done rather than writing it", async () => {
  const task = createTask({
    title: "Ship /pr stage 3",
    source: { createdBy: "user" },
  });
  try {
    const subject = card({ linkedTask: taskSummaryOf(task) });
    const rec = recorder();

    await runPullRequestCardAction(
      subject.id,
      "merge",
      { mergeMethod: "squash" },
      rec.operations,
    );

    const stored = readTask(task.id)!;
    assert.notEqual(
      stored.status,
      "done",
      "an agent may not write done itself",
    );
    assert.equal(stored.statusSuggestion?.to, "done");
    assert.equal(stored.statusSuggestion?.reason, "PR #42 merged");
  } finally {
    deleteTask(task.id);
  }
});

test("marking the linked Task done retains coordinator user attribution", async () => {
  const task = createTask({
    title: "Ship /pr stage 3",
    source: { createdBy: "user" },
  });
  try {
    const subject = card({
      status: "merged",
      linkedTask: taskSummaryOf(task),
    });

    const { card: updated } = await runPullRequestCardActionWithActor(
      subject.id,
      "mark-task-done",
      {},
      { kind: "user", id: "via coordinator session coordinator-7" },
    );

    assert.equal(readTask(task.id)?.status, "done");
    assert.equal(updated.linkedTask?.status, "done");
    const statusEvent = taskStore.statusEventsForTask(Number(task.id)).at(-1);
    assert.equal(statusEvent?.actorKind, "user");
    assert.equal(statusEvent?.actorId, "via coordinator session coordinator-7");
  } finally {
    deleteTask(task.id);
  }
});

/* -------------------------------- cleanup ---------------------------------- */

test("cleanup refreshes the base, verifies containment, removes the worktree, then settles", async () => {
  const subject = card({ status: "merged" });
  let removalBase: string | undefined;
  const rec = recorder({
    async removeWorktree(worktreeId, options) {
      rec.calls.push(`remove:${worktreeId}`);
      removalBase = options.branchContainmentBase;
    },
  });

  const { card: updated } = await runPullRequestCardAction(
    subject.id,
    "cleanup",
    {},
    rec.operations,
  );

  assert.deepEqual(rec.calls, [
    "refresh-base:main",
    "contained",
    "remove:wt-1",
    "settle",
  ]);
  assert.equal(removalBase, "refreshed-base-oid");
  assert.equal(updated.cleanedUp, true);
});

// Merged upstream but not contained in the refreshed base means something else
// happened. The only safe move is to stop — never a forced removal.
test("cleanup refuses when the base does not contain the branch, and removes nothing", async () => {
  const subject = card({ status: "merged" });
  const rec = recorder({
    branchContained: async () => false,
  });

  await assert.rejects(
    runPullRequestCardAction(subject.id, "cleanup", {}, rec.operations),
    /not contained in the refreshed main/,
  );
  assert.ok(
    !rec.calls.some((call) => call.startsWith("remove:")),
    "nothing may be removed once containment fails",
  );
  assert.equal(pullRequestCardById(subject.id)?.cleanedUp, undefined);
});

test("cleanup is refused before the pull request is merged", async () => {
  const subject = card();
  const rec = recorder();

  await assert.rejects(
    runPullRequestCardAction(subject.id, "cleanup", {}, rec.operations),
    /only offered once the pull request is merged/,
  );
  assert.deepEqual(rec.calls, []);
});

// The gate is the SHARED settle predicate, not merely "is it running": a queued
// prompt or a pending approval is not done enough to leave the inbox either,
// and this action also takes the worktree away.
test("cleanup is refused whenever the session may not be settled", async () => {
  const subject = card({ status: "merged" });
  const rec = recorder({
    sessionSettleBlockedReason: async () => "work is queued behind it.",
  });

  await assert.rejects(
    runPullRequestCardAction(subject.id, "cleanup", {}, rec.operations),
    /work is queued behind it/,
  );
  assert.deepEqual(rec.calls, []);
});

test("coordinator cleanup excludes its own active turn from settlement blocking", async () => {
  const subject = card({ status: "merged" });
  const rec = recorder({
    sessionSettleBlockedReason: async () => "it is still running.",
  });

  const { card: updated } = await runPullRequestCardActionWithActor(
    subject.id,
    "cleanup",
    {},
    { kind: "user", id: "via coordinator session session-1" },
    "session-1",
    rec.operations,
  );

  assert.equal(updated.cleanedUp, true);
  assert.ok(rec.calls.includes("remove:wt-1"));
  assert.ok(rec.calls.includes("settle"));
});

// `/pr --base <branch>` can point the card at a base the worktree does not
// track. Acting on `row.baseBranch` while reporting `card.baseBranch` would be
// a claim about a branch nobody touched.
test("a card whose base differs from its worktree's is refused, not silently rebased elsewhere", async () => {
  const subject = card({ baseBranch: "release-2" });
  const rec = recorder();

  await assert.rejects(
    runPullRequestCardAction(
      subject.id,
      "update-with-main",
      {},
      rec.operations,
    ),
    /targets release-2, but its worktree tracks main/,
  );
  assert.deepEqual(rec.calls, []);

  const merged = card({ status: "merged", baseBranch: "release-2" });
  await assert.rejects(
    runPullRequestCardAction(merged.id, "cleanup", {}, rec.operations),
    /targets release-2, but its worktree tracks main/,
  );
  assert.deepEqual(rec.calls, []);
});

// The first check is seconds old by the time the worktree is removed — a
// session that started a run in between must still stop it, as late as
// possible, before its checkout is pulled away.
test("cleanup re-checks the session immediately before removing the worktree", async () => {
  const subject = card({ status: "merged" });
  let checks = 0;
  const rec = recorder({
    sessionSettleBlockedReason: async () => {
      checks += 1;
      // Idle when the action starts; running by the time the fetch is done.
      return checks === 1 ? undefined : "it is still running.";
    },
  });

  await assert.rejects(
    runPullRequestCardAction(subject.id, "cleanup", {}, rec.operations),
    /it is still running/,
  );
  assert.equal(checks, 2, "the gate is asked again just before the removal");
  assert.ok(
    !rec.calls.some((call) => call.startsWith("remove:")),
    "a session that woke up mid-cleanup keeps its worktree",
  );
  assert.ok(!rec.calls.includes("settle"));
});

test("cleanup is refused for a session with no worktree", async () => {
  const subject = card({ status: "merged", worktreeId: undefined });
  const rec = recorder({ worktreeRow: async () => undefined });

  await assert.rejects(
    runPullRequestCardAction(subject.id, "cleanup", {}, rec.operations),
    /no active worktree/,
  );
});

/* ---------------------------- update with main ----------------------------- */

test("update with main rebases onto a refreshed base and republishes the branch", async () => {
  const subject = card();
  const rec = recorder();
  const stalePoll = beginPullRequestCardObservation(subject.id);

  const result = await runPullRequestCardAction(
    subject.id,
    "update-with-main",
    {},
    rec.operations,
  );

  assert.deepEqual(rec.calls, [
    "pull-rebase:main:proj",
    "rebase-main:wt-1",
    "push",
  ]);
  assert.equal(result.agentPrompt, undefined);
  assert.match(result.card.actionMessage ?? "", /force-pushed it with lease/);
  assert.equal(
    patchPullRequestCardObservation(
      subject.id,
      stalePoll,
      { mergeable: false, conflicts: true },
      { observedHeadSha: "pre-push-head" },
    ),
    undefined,
    "a poll started before update-with-main cannot land after the push",
  );
});

// The deterministic rebase gets the first attempt; only a genuine conflict —
// aborted and restored by `worktreeSync` — becomes the agent's problem.
test("a conflicted rebase hands the work to the session's agent and pushes nothing", async () => {
  const subject = card();
  const rec = recorder({
    async sync(row, operation) {
      rec.calls.push(`${operation}:${row.id}`);
      if (operation === "rebase-main")
        throw new WorktreeSyncConflictError(
          "Rebase onto main hit a conflict.",
          "rebase-main",
          ["docs/reference/web-diff.md"],
          true,
        );
      return "updated";
    },
  });

  const result = await runPullRequestCardAction(
    subject.id,
    "update-with-main",
    {},
    rec.operations,
  );

  assert.ok(
    !rec.calls.includes("push"),
    "a conflicted branch is not published",
  );
  assert.match(result.agentPrompt ?? "", /resolve the conflicts/);
  assert.match(result.agentPrompt ?? "", /docs\/reference\/web-diff\.md/);
  assert.match(result.agentPrompt ?? "", /truncated.*complete set/i);
  assert.match(result.agentPrompt ?? "", /force-with-lease/);
  // Only the FACT: whether the agent took the work is not known yet, and a
  // restart before it is must still leave a true sentence on the card.
  assert.equal(
    result.card.actionMessage,
    "Rebasing feature onto main hit a conflict.",
  );
});

// A durable card must never claim a handoff that a missing session or a
// rejected prompt then undoes — the socket error is gone the moment the tab is.
test("the conflict handoff is only recorded as done once the session took it", async () => {
  const subject = card();
  const rec = recorder({
    async sync(row, operation) {
      rec.calls.push(`${operation}:${row.id}`);
      if (operation === "rebase-main")
        throw new WorktreeSyncConflictError("conflict", "rebase-main");
      return "updated";
    },
  });
  const conflicted = await runPullRequestCardAction(
    subject.id,
    "update-with-main",
    {},
    rec.operations,
  );

  // The action itself is over (`busyAction` cleared), so this flag is the only
  // thing that stops the card offering the same rebase again while the agent
  // holds the branch.
  assert.equal(conflicted.card.rebaseHandedOff, undefined);

  recordRebaseHandoff(subject.id, { ok: true }, conflicted.actionToken);
  const handed = pullRequestCardById(subject.id)!;
  assert.match(handed.actionMessage ?? "", /handed it to this session's agent/);
  assert.equal(handed.actionError, undefined);
  assert.equal(handed.rebaseHandedOff, true);

  // And the NEXT action owns the card's story: the previous handoff, whatever
  // became of it, stops speaking for the button.
  const next = await runPullRequestCardAction(
    subject.id,
    "update-with-main",
    {},
    recorder().operations,
  );
  assert.equal(next.card.rebaseHandedOff, undefined);
});

// The handoff ends when the branch is republished, which the watcher can only
// recognise against the head the agent INHERITED. A card polled at least once
// has that from the provider; one that has not been polled yet has nothing —
// and its first poll after the agent's force-push would otherwise adopt the
// rebased head as the baseline, leaving the button disabled for a rebase that
// is already done.
test("the conflict handoff records the head the agent inherits", async () => {
  const unobserved = card();
  const rec = recorder({
    async sync(row, operation) {
      rec.calls.push(`${operation}:${row.id}`);
      if (operation === "rebase-main")
        throw new WorktreeSyncConflictError("conflict", "rebase-main");
      return "updated";
    },
  });
  await runPullRequestCardAction(
    unobserved.id,
    "update-with-main",
    {},
    rec.operations,
  );
  // The aborted rebase restored the branch, so its local head IS what the agent
  // starts from.
  assert.equal(
    pullRequestCardRecord(unobserved.id)?.context.rebaseHandoffHeadSha,
    "local-head",
  );

  // With an observation, the provider's own SHA is the baseline: the watcher
  // compares provider heads, and a local read could differ from it for reasons
  // that have nothing to do with this rebase (an unpushed commit).
  const observed = card();
  patchPullRequestCard(observed.id, {}, { observedHeadSha: "provider-head" });
  const observedRec = recorder({
    async sync(row, operation) {
      observedRec.calls.push(`${operation}:${row.id}`);
      if (operation === "rebase-main")
        throw new WorktreeSyncConflictError("conflict", "rebase-main");
      return "updated";
    },
  });
  await runPullRequestCardAction(
    observed.id,
    "update-with-main",
    {},
    observedRec.operations,
  );
  assert.equal(
    pullRequestCardRecord(observed.id)?.context.rebaseHandoffHeadSha,
    "provider-head",
  );
  assert.ok(!observedRec.calls.includes("head-commit"));
});

// The baseline describes ONE handoff. A later attempt that establishes none of
// its own must not inherit the previous one: the branch can have moved out of
// band in between, and the watcher would read that stale SHA as this rebase
// having been published — re-enabling the button while the agent works.
test("an action does not inherit the previous handoff's baseline", async () => {
  const subject = card();
  patchPullRequestCard(subject.id, {}, { rebaseHandoffHeadSha: "stale-head" });
  const conflictWithoutHead = recorder({
    async sync(_row, operation) {
      if (operation === "rebase-main")
        throw new WorktreeSyncConflictError("conflict", "rebase-main");
      return "updated";
    },
    // Nothing observed, and the local read cannot answer either.
    headCommit: async () => undefined,
  });

  const conflicted = await runPullRequestCardAction(
    subject.id,
    "update-with-main",
    {},
    conflictWithoutHead.operations,
  );
  recordRebaseHandoff(subject.id, { ok: true }, conflicted.actionToken);

  assert.equal(pullRequestCardById(subject.id)?.rebaseHandedOff, true);
  assert.equal(
    pullRequestCardRecord(subject.id)?.context.rebaseHandoffHeadSha,
    undefined,
    "no baseline is a state of its own, not a reason to keep the last one",
  );

  // The same for an action that is not a handoff at all: the baseline is spent.
  patchPullRequestCard(subject.id, {}, { rebaseHandoffHeadSha: "stale-head" });
  await runPullRequestCardAction(
    subject.id,
    "update-with-main",
    {},
    recorder().operations,
  );
  assert.equal(
    pullRequestCardRecord(subject.id)?.context.rebaseHandoffHeadSha,
    undefined,
  );
});

test("a handoff that could not be delivered is recorded on the card, not just sent", async () => {
  const subject = card();
  const rec = recorder({
    async sync(row, operation) {
      rec.calls.push(`${operation}:${row.id}`);
      if (operation === "rebase-main")
        throw new WorktreeSyncConflictError("conflict", "rebase-main");
      return "updated";
    },
  });
  const conflicted = await runPullRequestCardAction(
    subject.id,
    "update-with-main",
    {},
    rec.operations,
  );

  recordRebaseHandoff(
    subject.id,
    { ok: false, reason: "that session is not available." },
    conflicted.actionToken,
  );
  const failed = pullRequestCardById(subject.id)!;
  assert.match(failed.actionError ?? "", /could not be handed/);
  assert.match(failed.actionError ?? "", /not available/);
  assert.equal(failed.actionMessage, undefined);
  // Nobody took the rebase, so the button stays the way to run it again.
  assert.equal(failed.rebaseHandedOff, undefined);
});

// A dirty or diverged main checkout is a user decision, not a merge conflict:
// it must not be dressed up as one and handed to the agent.
test("a failure updating the base is reported, not handed to the agent", async () => {
  const subject = card();
  const rec = recorder({
    async sync(row, operation) {
      rec.calls.push(`${operation}:${row.id}`);
      if (operation === "pull-rebase")
        throw new Error("The main checkout has uncommitted changes.");
      return "updated";
    },
  });

  await assert.rejects(
    runPullRequestCardAction(
      subject.id,
      "update-with-main",
      {},
      rec.operations,
    ),
    /Could not update main before rebasing/,
  );
  assert.deepEqual(rec.calls, ["pull-rebase:main:proj"]);
});

/* ------------------------------ serialization ------------------------------ */

// The running action is durable card state, so the second click is refused
// whichever tab it comes from — a merge and a cleanup must never interleave.
test("a second action is refused while one is already running", async () => {
  const subject = card({ status: "merged" });
  let release: (() => void) | undefined;
  const rec = recorder({
    refreshBase: () =>
      new Promise<string>((resolve) => {
        release = () => resolve("refreshed-base-oid");
      }),
  });

  const first = runPullRequestCardAction(
    subject.id,
    "cleanup",
    {},
    rec.operations,
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(pullRequestCardById(subject.id)?.busyAction, "cleanup");

  await assert.rejects(
    runPullRequestCardAction(subject.id, "cleanup", {}, rec.operations),
    /already running/,
  );
  release?.();
  await first;
  assert.equal(pullRequestCardById(subject.id)?.busyAction, undefined);
});

// `busyAction` is durable so a merge survives a browser reload — which means a
// process that DIES mid-action would otherwise leave the card refusing every
// later click forever, fixable only by editing a file under DATA_DIR.
test("an action interrupted by a restart is released on boot, with a warning", async () => {
  const subject = card({ status: "merged" });
  let release: (() => void) | undefined;
  const rec = recorder({
    refreshBase: () =>
      new Promise<string>((resolve) => {
        release = () => resolve("refreshed-base-oid");
      }),
  });
  const inFlight = runPullRequestCardAction(
    subject.id,
    "cleanup",
    {},
    rec.operations,
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(pullRequestCardById(subject.id)?.busyAction, "cleanup");

  // The next process comes up against the same store.
  reconcilePullRequestCardActionsOnBoot();

  const after = pullRequestCardById(subject.id)!;
  assert.equal(after.busyAction, undefined);
  assert.match(after.actionError ?? "", /interrupted by a server restart/);
  release?.();
  await inFlight;
});

// THE unsafe schedule, exactly: another connection starts a run while cleanup
// is fetching the base. Sampling "is it running" cannot see it in time — the run
// passes its own worktree guard while the checkout still exists — so cleanup
// must be REFUSED by the lease instead of deleting a running agent's tree.
test("a run that starts while cleanup fetches the base stops the removal", async () => {
  const subject = card({ status: "merged" });
  sessionsRunIn("wt-1");
  let releaseRun: (() => void) | undefined;
  const rec = recorder({
    async refreshBase(row) {
      rec.calls.push(`refresh-base:${row.baseBranch}`);
      // Another connection's prompt, in the gap the second sample cannot see.
      releaseRun = beginPromptRun("session-1");
      return "refreshed-base-oid";
    },
  });

  await assert.rejects(
    runPullRequestCardAction(subject.id, "cleanup", {}, rec.operations),
    /A run is starting in this worktree right now/,
  );
  assert.ok(
    !rec.calls.some((call) => call.startsWith("remove:")),
    "a session that started running keeps its worktree",
  );
  assert.ok(!rec.calls.includes("settle"));
  releaseRun?.();
});

// The other direction of the same exclusion: while cleanup holds the session,
// the prompt facade's synchronous check refuses a run from starting at all.
test("no run may start while cleanup holds the worktree", async () => {
  const subject = card({ status: "merged" });
  sessionsRunIn("wt-1");
  let startedDuringRemoval: Error | undefined;
  const rec = recorder({
    async removeWorktree(worktreeId) {
      rec.calls.push(`remove:${worktreeId}`);
      try {
        beginPromptRun("session-1");
      } catch (err) {
        startedDuringRemoval = err as Error;
      }
    },
  });

  await runPullRequestCardAction(subject.id, "cleanup", {}, rec.operations);

  assert.match(startedDuringRemoval?.message ?? "", /being cleaned up/);
  // And the hold is released again once the action is done.
  const after = reserveWorktreeForRemoval("wt-1", "later");
  assert.ok(after, "the hold must not outlive the action");
  after?.();
});

// The resource is the WORKTREE, not a list of sessions: a session LINKED to it
// after cleanup started is covered by the same hold, even though no snapshot
// could have contained it.
test("a session linked to the worktree mid-cleanup still cannot start a run", async () => {
  const subject = card({ status: "merged" });
  sessionsRunIn("wt-1");
  let lateSession: Error | undefined;
  const rec = recorder({
    async removeWorktree(worktreeId) {
      rec.calls.push(`remove:${worktreeId}`);
      // A fork/review handoff links a brand-new session to this worktree now.
      try {
        beginPromptRun("session-forked-just-now");
      } catch (err) {
        lateSession = err as Error;
      }
    },
  });

  await runPullRequestCardAction(subject.id, "cleanup", {}, rec.operations);

  assert.match(
    lateSession?.message ?? "",
    /being cleaned up/,
    "a session linked after the hold is still refused",
  );
});

// The handoff outcome can land long after it was issued. By then the user may
// have run another action — or merged — and this write must not clobber it.
test("a late handoff outcome cannot overwrite a newer action on the card", async () => {
  const subject = card();
  const rec = recorder({
    async sync(row, operation) {
      rec.calls.push(`${operation}:${row.id}`);
      if (operation === "rebase-main")
        throw new WorktreeSyncConflictError("conflict", "rebase-main");
      return "updated";
    },
  });
  const conflicted = await runPullRequestCardAction(
    subject.id,
    "update-with-main",
    {},
    rec.operations,
  );

  // The user merges in the meantime.
  await runPullRequestCardAction(
    subject.id,
    "merge",
    { mergeMethod: "squash" },
    recorder().operations,
  );
  const merged = pullRequestCardById(subject.id)!;

  // ...and only THEN does the old prompt fail.
  recordRebaseHandoff(
    subject.id,
    { ok: false, reason: "that session is not available." },
    conflicted.actionToken,
  );

  const after = pullRequestCardById(subject.id)!;
  assert.equal(after.status, "merged");
  assert.equal(after.actionError, undefined, "the merge's outcome stands");
  assert.equal(after.actionMessage, merged.actionMessage);
});

// A dev session with a review session beside it is the ORDINARY shape of a
// worktree here, so live siblings are a consequence to state, not a reason to
// refuse: they settle with the card's own session, and the outcome says so.
test("cleanup settles the live siblings on the worktree and names them", async () => {
  const subject = card({ status: "merged" });
  const settled: string[][] = [];
  const rec = recorder({
    liveSessionsForWorktree: () => ["session-1", "session-review"],
    settleWorktreeSessions: (worktreeId) => {
      rec.calls.push("settle");
      settled.push([worktreeId]);
    },
  });

  const { card: updated } = await runPullRequestCardAction(
    subject.id,
    "cleanup",
    {},
    rec.operations,
  );

  assert.deepEqual(settled, [["wt-1"]], "the whole checkout settles at once");
  assert.match(
    updated.actionMessage ?? "",
    /this session and 1 other on this worktree are settled/,
  );
});

// The sessions the button must NOT wait for: a review session that is finished
// — settled or archived — is done with the checkout, and the store's live
// filter is what keeps it from blocking the common case.
test("finished siblings are not counted: cleanup runs and speaks only for this session", async () => {
  const subject = card({ status: "merged" });
  // What `liveSessionIdsForWorktree` returns once the review sessions settled.
  const rec = recorder({ liveSessionsForWorktree: () => ["session-1"] });

  const { card: updated } = await runPullRequestCardAction(
    subject.id,
    "cleanup",
    {},
    rec.operations,
  );

  assert.deepEqual(rec.calls, [
    "refresh-base:main",
    "contained",
    "remove:wt-1",
    "settle",
  ]);
  assert.match(updated.actionMessage ?? "", /this session is settled/);
});

// Settling a sibling that is not done is the one thing cleanup may not do, so a
// RUNNING sibling refuses — before anything is touched.
test("cleanup refuses while another session on the worktree is running", async () => {
  const subject = card({ status: "merged" });
  const rec = recorder({
    liveSessionsForWorktree: () => ["session-1", "session-review"],
    sessionSettleBlockedReason: async (sessionId) =>
      sessionId === "session-review" ? "it is still running." : undefined,
  });

  await assert.rejects(
    runPullRequestCardAction(subject.id, "cleanup", {}, rec.operations),
    /another session on this worktree, but it is still running/,
  );
  assert.deepEqual(rec.calls, [], "nothing is touched, not even the base pull");
});

// A session linked DURING the action is picked up by the re-check under the
// hold: it settles with the rest when it is idle, and stops the removal when it
// is not — it must never be settled unasked or left running in a deleted tree.
test("a session linked while the base was fetched is re-checked under the hold", async () => {
  const subject = card({ status: "merged" });
  sessionsRunIn("wt-1");
  let linked = ["session-1"];
  const rec = recorder({
    liveSessionsForWorktree: () => linked,
    sessionSettleBlockedReason: async (sessionId) =>
      sessionId === "session-handoff" ? "it is still running." : undefined,
    async refreshBase(row) {
      rec.calls.push(`refresh-base:${row.baseBranch}`);
      linked = ["session-1", "session-handoff"];
      return "refreshed-base-oid";
    },
  });

  await assert.rejects(
    runPullRequestCardAction(subject.id, "cleanup", {}, rec.operations),
    /another session on this worktree, but it is still running/,
  );
  assert.ok(!rec.calls.some((call) => call.startsWith("remove:")));
  assert.ok(!rec.calls.includes("settle"));
});

// A routine watcher poll bumps `updatedAt` on every card it touches. It must not
// suppress a handoff outcome — only a newer ACTION may.
test("a watcher patch between the conflict and the outcome does not drop it", async () => {
  const subject = card();
  const rec = recorder({
    async sync(row, operation) {
      rec.calls.push(`${operation}:${row.id}`);
      if (operation === "rebase-main")
        throw new WorktreeSyncConflictError("conflict", "rebase-main");
      return "updated";
    },
  });
  const conflicted = await runPullRequestCardAction(
    subject.id,
    "update-with-main",
    {},
    rec.operations,
  );

  // Exactly what the watcher writes on a poll — no action, no new token.
  patchPullRequestCard(subject.id, {
    ci: { state: "success", total: 3 },
    mergeable: true,
    conflicts: false,
  });

  recordRebaseHandoff(subject.id, { ok: true }, conflicted.actionToken);
  assert.match(
    pullRequestCardById(subject.id)?.actionMessage ?? "",
    /handed it to this session's agent/,
  );
});

/* ------------------------------- the message ------------------------------- */

// The action selects server behavior and the method decides how history is
// rewritten, so neither may arrive as an arbitrary string — and a merge without
// a method must be rejected rather than defaulted to someone's favorite.
test("the card-action message is validated down to its action and method", () => {
  const ok = (msg: Record<string, unknown>) =>
    validateClientMessage({ type: "pullRequestCardAction", ...msg }).ok;

  assert.equal(ok({ cardId: "pr_1", action: "cleanup" }), true);
  assert.equal(
    ok({ cardId: "pr_1", action: "cleanup", requestId: "request-1" }),
    true,
  );
  assert.equal(ok({ cardId: "pr_1", action: "cleanup", requestId: 1 }), false);
  assert.equal(
    ok({ cardId: "pr_1", action: "merge", mergeMethod: "squash" }),
    true,
  );
  assert.equal(ok({ cardId: "pr_1", action: "merge" }), false);
  assert.equal(
    ok({ cardId: "pr_1", action: "merge", mergeMethod: "octopus" }),
    false,
  );
  assert.equal(ok({ cardId: "pr_1", action: "delete-everything" }), false);
  assert.equal(ok({ action: "cleanup" }), false);

  // Keeping the remote branch is an explicit opt-out, so a non-boolean is
  // refused rather than being read as truthy — "false" must never delete it.
  assert.equal(
    ok({
      cardId: "pr_1",
      action: "merge",
      mergeMethod: "squash",
      deleteBranch: false,
    }),
    true,
  );
  assert.equal(
    ok({
      cardId: "pr_1",
      action: "merge",
      mergeMethod: "squash",
      deleteBranch: "false",
    }),
    false,
  );
});
