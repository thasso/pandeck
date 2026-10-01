/**
 * The worktree page's Remove is a destructive act on a checkout OTHER sessions
 * may be working in, so what is tested here is the same thing
 * `pullRequestActions.test.ts` tests for the `/pr` card's cleanup: the ORDER
 * and the REFUSALS. Both surfaces must answer them identically — a review
 * session that stops one may not be steamrolled by the other.
 *
 * Run:
 *   pnpm --filter @assistant/server test src/worktreeRemoval.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
  removeWorktreeAndSettleSessions,
  retireWorktree,
  type WorktreeRemovalOperations,
  type WorktreeRetireOperations,
} from "./worktreeRemoval.ts";
import type { WorktreeRow } from "./db/worktreeStore.ts";
import {
  WorktreeBranchCleanupError,
  WorktreeDirectoryResidueError,
  WorktreeRemovalBlockedError,
  WorktreeUndeletableError,
} from "./worktrees/worktrees.ts";
import {
  beginPromptRun,
  reserveWorktreeForRemoval,
  resetSessionRunLeasesForTests,
  setSessionWorktreeResolverForTests,
} from "./session/sessionRunLease.ts";

function recorder(overrides: Partial<WorktreeRemovalOperations> = {}) {
  const calls: string[] = [];
  const operations: WorktreeRemovalOperations = {
    settleBlockedReason: async () => undefined,
    // The REAL lease: the race this guards is between this hold and the prompt
    // facade's check, so faking it would test nothing.
    reserveForRemoval: reserveWorktreeForRemoval,
    sessionsToSettle: () => ["session-1"],
    async removeWorktree(worktreeId, options) {
      calls.push(
        `remove:${worktreeId}:${options.deleteBranch ? "branch" : "-"}`,
      );
    },
    async settleSessions(worktreeId) {
      calls.push(`settle:${worktreeId}`);
    },
    ...overrides,
  };
  return { calls, operations };
}

afterEach(() => {
  resetSessionRunLeasesForTests();
});

const row: WorktreeRow = {
  id: "wt-1",
  projectId: "proj",
  mainRepoRoot: "/repo",
  path: "/repo/wt-1",
  branch: "feature",
  baseBranch: "main",
  baseCommit: "abc",
  status: "active",
  mergeStateJson: null,
  createdAt: 1,
  updatedAt: 1,
  removedAt: null,
};
function retireRecorder(overrides: Partial<WorktreeRetireOperations> = {}) {
  const calls: string[] = [];
  const operations: WorktreeRetireOperations = {
    resolveWorktree: async () => row,
    async refreshBase() {
      calls.push("refresh-base");
      return "refreshed-base-oid";
    },
    async branchContained(_row, baseTarget) {
      calls.push(`contained:${baseTarget}`);
      return true;
    },
    blockedReason: async () => undefined,
    reserveForRemoval: reserveWorktreeForRemoval,
    sessionsToSettle: () => ["session-1", "session-2"],
    async removeWorktree(worktreeId, options) {
      calls.push(
        `remove:${worktreeId}:${options.deleteBranch ? "branch" : "-"}`,
      );
    },
    async settleSessions(worktreeId) {
      calls.push(`settle:${worktreeId}`);
    },
    ...overrides,
  };
  return { calls, operations };
}

/* --------------------------------- retire --------------------------------- */

test("retire refreshes the base before containment, then removes and settles", async () => {
  const rec = retireRecorder();

  const result = await retireWorktree(
    "wt-1",
    { deleteBranch: true },
    rec.operations,
  );

  assert.deepEqual(rec.calls, [
    "refresh-base",
    "contained:refreshed-base-oid",
    "remove:wt-1:branch",
    "settle:wt-1",
  ]);
  assert.deepEqual(result, {
    worktreeId: "wt-1",
    status: "retired",
    branch: "feature",
    baseBranch: "main",
    branchDeleted: true,
    settledSessions: 2,
    // Containment ran and passed: the only outcome that may say so.
    deliveryVerified: true,
  });
});

test("retire carries the refreshed target into the removal guards", async () => {
  const stacked = { ...row, baseBranch: "epic" };
  let removalBase: string | undefined;
  const rec = retireRecorder({
    resolveWorktree: async () => stacked,
    refreshBase: async () => "merged-epic-oid",
    branchContained: async (_row, baseTarget) =>
      baseTarget === "merged-epic-oid",
    async removeWorktree(_worktreeId, options) {
      removalBase = options.branchContainmentBase;
    },
  });

  const result = await retireWorktree(
    stacked.id,
    { deleteBranch: true },
    rec.operations,
  );

  assert.equal(result.status, "retired");
  assert.equal(removalBase, "merged-epic-oid");
});

test("retire can safely reach identity-bound cleanup on a removed row", async () => {
  const pending: WorktreeRow = {
    ...row,
    status: "removed",
    branchCleanupOid: "expected-oid",
    removedAt: 2,
  };
  const rec = retireRecorder({ resolveWorktree: async () => pending });

  const result = await retireWorktree(
    pending.id,
    { deleteBranch: true, force: true },
    rec.operations,
  );

  assert.equal(result.status, "retired");
  assert.deepEqual(rec.calls, ["remove:wt-1:branch", "settle:wt-1"]);

  // Unforced, the oid-bound cleanup DOES check containment — but it also
  // succeeds on a branch already deleted out of band, which proves nothing. A
  // retry therefore never claims verification: `deliveryVerified` promises
  // containment passed, and this path cannot tell the two successes apart.
  const unforced = retireRecorder({ resolveWorktree: async () => pending });
  const retried = await retireWorktree(
    pending.id,
    { deleteBranch: true },
    unforced.operations,
  );
  assert.equal(retried.status, "retired");
  if (retried.status === "retired") {
    assert.equal(retried.branchDeleted, true);
    assert.equal(retried.deliveryVerified, false);
  }
});

test("retire rejects an ordinary completed tombstone", async () => {
  const completed: WorktreeRow = {
    ...row,
    status: "removed",
    branchCleanupOid: null,
    removedAt: 2,
  };
  const rec = retireRecorder({ resolveWorktree: async () => completed });

  await assert.rejects(
    () => retireWorktree(completed.id, { deleteBranch: true }, rec.operations),
    /no longer available/i,
  );
  assert.deepEqual(rec.calls, []);
});

test("retire returns the containment refusal unless lost git work was confirmed", async () => {
  const blocked = retireRecorder({ branchContained: async () => false });
  const refusal = await retireWorktree(
    "wt-1",
    { deleteBranch: true },
    blocked.operations,
  );
  assert.equal(refusal.status, "refused");
  if (refusal.status === "refused") {
    assert.match(refusal.refusal, /not contained/);
    // The verification that produced this is the one a surface may escalate
    // from, so the refusal has to say that force is even an answer to it.
    assert.equal(refusal.refusalKind, "delivery");
  }
  assert.ok(!blocked.calls.some((call) => call.startsWith("remove:")));

  // Keeping the branch discards nothing, so an undelivered branch is not a
  // reason to refuse — and asking for force there would be asking consent to
  // lose commits that stay on the ref.
  const kept = retireRecorder({ branchContained: async () => false });
  const keptResult = await retireWorktree("wt-1", {}, kept.operations);
  assert.equal(keptResult.status, "retired");
  if (keptResult.status === "retired") {
    assert.equal(keptResult.branchDeleted, false);
    // Containment never ran, so the outcome must not read as verified.
    assert.equal(keptResult.deliveryVerified, false);
  }
  assert.ok(kept.calls.includes("remove:wt-1:-"));

  const forced = retireRecorder({ branchContained: async () => false });
  const result = await retireWorktree(
    "wt-1",
    { deleteBranch: true, force: true },
    forced.operations,
  );
  assert.equal(result.status, "retired");
  if (result.status === "retired") assert.equal(result.deliveryVerified, false);
  assert.ok(forced.calls.includes("remove:wt-1:branch"));
});

test("retire survives a base branch that cannot be refreshed at all", async () => {
  const gone = (): Partial<WorktreeRetireOperations> => ({
    async refreshBase() {
      throw new Error(
        'Cannot rebase: "main" exists neither on a remote nor locally.',
      );
    },
  });

  // Unverifiable is not delivered: deleting the branch still needs consent, and
  // the refusal names why rather than throwing a rebase error at a removal.
  const blocked = retireRecorder(gone());
  const refusal = await retireWorktree(
    "wt-1",
    { deleteBranch: true },
    blocked.operations,
  );
  assert.equal(refusal.status, "refused");
  if (refusal.status === "refused") {
    assert.match(refusal.refusal, /could not be refreshed/);
    assert.match(refusal.refusal, /keep the branch/);
    assert.equal(refusal.refusalKind, "delivery");
  }
  assert.ok(!blocked.calls.some((call) => call.startsWith("remove:")));

  // Keeping the branch needs no target at all, and force is the consent the
  // verification would have asked for. Neither may inherit a base oid.
  const kept = retireRecorder(gone());
  assert.equal(
    (await retireWorktree("wt-1", {}, kept.operations)).status,
    "retired",
  );
  assert.deepEqual(kept.calls, ["remove:wt-1:-", "settle:wt-1"]);

  const forced = retireRecorder(gone());
  assert.equal(
    (
      await retireWorktree(
        "wt-1",
        { deleteBranch: true, force: true },
        forced.operations,
      )
    ).status,
    "retired",
  );
  assert.deepEqual(forced.calls, ["remove:wt-1:branch", "settle:wt-1"]);
});

test("retire returns git guard words as a structured refusal", async () => {
  const rec = retireRecorder({
    removeWorktree: async () => {
      throw new WorktreeRemovalBlockedError(
        "Worktree has uncommitted changes. Commit them first.",
      );
    },
  });

  const result = await retireWorktree("wt-1", {}, rec.operations);

  assert.equal(result.status, "refused");
  if (result.status === "refused") {
    assert.match(result.refusal, /uncommitted changes/);
    assert.equal(result.refusalKind, "git-guard");
  }
  assert.ok(!rec.calls.some((call) => call.startsWith("settle:")));
});

test("retire stays successful when post-removal session refresh fails", async () => {
  const rec = retireRecorder({
    async settleSessions(worktreeId) {
      rec.calls.push(`settle:${worktreeId}`);
      throw new Error("broadcast failed");
    },
  });

  const result = await retireWorktree(
    "wt-1",
    { deleteBranch: true },
    rec.operations,
  );

  assert.equal(result.status, "retired");
  assert.deepEqual(rec.calls, [
    "refresh-base",
    "contained:refreshed-base-oid",
    "remove:wt-1:branch",
    "settle:wt-1",
  ]);
});

test("retire re-checks session blockers under the hold after refreshing the base", async () => {
  let checks = 0;
  const rec = retireRecorder({
    blockedReason: async () => {
      checks += 1;
      return checks === 1
        ? undefined
        : "A session is still running. Nothing was removed.";
    },
  });

  const result = await retireWorktree(
    "wt-1",
    { deleteBranch: true },
    rec.operations,
  );

  assert.equal(result.status, "refused");
  // A session gate is nobody's to escalate: force never overrides one, so the
  // kind must not invite a surface to offer it.
  if (result.status === "refused") assert.equal(result.refusalKind, "sessions");
  assert.equal(checks, 2);
  assert.deepEqual(rec.calls, ["refresh-base", "contained:refreshed-base-oid"]);
});

/* ------------------------------- plain remove ------------------------------ */

test("removal deletes the checkout and then settles the sessions that ran in it", async () => {
  const rec = recorder();

  const refused = await removeWorktreeAndSettleSessions(
    "wt-1",
    { deleteBranch: true },
    rec.operations,
  );

  assert.equal(refused, undefined);
  assert.deepEqual(rec.calls, ["remove:wt-1:branch", "settle:wt-1"]);
  // The hold does not outlive the removal.
  const after = reserveWorktreeForRemoval("wt-1", "later");
  assert.ok(after, "the hold must be released");
  after?.();
});

// The gate is the SHARED settle predicate, not merely "is it running": this
// button settles every live session on the checkout, so a queued prompt or a
// pending approval stops it in the same words the `/pr` cleanup uses.
test("branch cleanup failure still settles sessions before reaching the caller", async () => {
  const cleanupError = new WorktreeBranchCleanupError(
    "branch cleanup failed",
    "wt-1",
    "feature",
    "expected-oid",
    true,
  );
  const rec = recorder({
    async removeWorktree(worktreeId, options) {
      rec.calls.push(
        `remove:${worktreeId}:${options.deleteBranch ? "branch" : "-"}`,
      );
      throw cleanupError;
    },
  });

  await assert.rejects(
    () =>
      removeWorktreeAndSettleSessions(
        "wt-1",
        { deleteBranch: true },
        rec.operations,
      ),
    (error) => error === cleanupError,
  );
  assert.deepEqual(rec.calls, ["remove:wt-1:branch", "settle:wt-1"]);
});

test("plain removal stays successful when post-removal session refresh fails", async () => {
  const rec = recorder({
    async settleSessions(worktreeId) {
      rec.calls.push(`settle:${worktreeId}`);
      throw new Error("broadcast failed");
    },
  });

  const refused = await removeWorktreeAndSettleSessions(
    "wt-1",
    {},
    rec.operations,
  );

  assert.equal(refused, undefined);
  assert.deepEqual(rec.calls, ["remove:wt-1:-", "settle:wt-1"]);
});

test("a session that may not be settled refuses the removal before any git side effect", async () => {
  const rec = recorder({
    settleBlockedReason: async () => "work is queued behind it.",
  });

  const refused = await removeWorktreeAndSettleSessions(
    "wt-1",
    {},
    rec.operations,
  );

  assert.match(refused ?? "", /work is queued behind it/);
  assert.deepEqual(rec.calls, [], "nothing is removed and nothing is settled");
});

// A `force` removal overrides losing GIT work — a dirty tree, unmerged commits.
// It is not a licence to delete the directory under a running agent.
test("force does not skip the session gates", async () => {
  const rec = recorder({
    settleBlockedReason: async () => "it is still running.",
  });

  const refused = await removeWorktreeAndSettleSessions(
    "wt-1",
    { deleteBranch: true, force: true },
    rec.operations,
  );

  assert.match(refused ?? "", /it is still running/);
  assert.deepEqual(rec.calls, []);
});

// THE unsafe schedule: another connection starts a run between the check and
// the removal. Sampling cannot see it in time — the run passes its own worktree
// guard while the checkout still exists — so the lease must refuse instead.
test("a run in flight in the worktree refuses the removal", async () => {
  setSessionWorktreeResolverForTests(() => "wt-1");
  const release = beginPromptRun("session-1");
  const rec = recorder();

  const refused = await removeWorktreeAndSettleSessions(
    "wt-1",
    {},
    rec.operations,
  );

  assert.match(refused ?? "", /A run is starting in this worktree right now/);
  assert.deepEqual(rec.calls, []);
  release();
});

// The first check is already stale by the time the directory goes: it is asked
// again under the hold, as late as possible.
test("the gate is asked again under the hold, before the removal", async () => {
  let checks = 0;
  const rec = recorder({
    settleBlockedReason: async () => {
      checks += 1;
      // Idle when the removal starts; awaiting an answer a moment later.
      return checks === 1 ? undefined : "it is waiting for your answer.";
    },
  });

  const refused = await removeWorktreeAndSettleSessions(
    "wt-1",
    {},
    rec.operations,
  );

  assert.match(refused ?? "", /it is waiting for your answer/);
  assert.equal(checks, 2, "asked once up front and once under the hold");
  assert.deepEqual(rec.calls, []);
});

// The held resource is the WORKTREE, so a session linked to it while the
// removal runs — a fork, a review handoff — cannot start a run either.
test("no run may start in the worktree while the removal holds it", async () => {
  setSessionWorktreeResolverForTests(() => "wt-1");
  let startedDuringRemoval: Error | undefined;
  const rec = recorder({
    async removeWorktree(worktreeId) {
      rec.calls.push(`remove:${worktreeId}`);
      try {
        beginPromptRun("session-linked-just-now");
      } catch (err) {
        startedDuringRemoval = err as Error;
      }
    },
  });

  await removeWorktreeAndSettleSessions("wt-1", {}, rec.operations);

  assert.match(startedDuringRemoval?.message ?? "", /being removed/);
});

// Git's own guards are not session refusals: a dirty tree still THROWS, so the
// caller reports it as the failure it is rather than as a settle problem.
test("a git guard propagates as a throw and still releases the hold", async () => {
  const rec = recorder({
    async removeWorktree() {
      throw new Error("Worktree has uncommitted changes.");
    },
  });

  await assert.rejects(
    removeWorktreeAndSettleSessions("wt-1", {}, rec.operations),
    /uncommitted changes/,
  );
  assert.ok(!rec.calls.includes("settle:wt-1"));
  const after = reserveWorktreeForRemoval("wt-1", "later");
  assert.ok(after, "a failed removal must not leave the worktree held");
  after?.();
});

/* ------------------------- undeletable checkouts -------------------------- */

test("a directory left on disk still settles sessions: the record is already gone", async () => {
  // `git worktree remove` deleted its administrative directory and failed on the
  // working tree, so the row is a tombstone and Git agrees. The sessions that
  // ran in the checkout must not be left pointing at it just because one folder
  // survived.
  const residueError = new WorktreeDirectoryResidueError(
    "Removed the feature worktree, but its directory is still on disk.",
    "wt-1",
    "/repo/wt-1",
  );
  const rec = recorder({
    async removeWorktree(worktreeId, options) {
      rec.calls.push(
        `remove:${worktreeId}:${options.deleteBranch ? "branch" : "-"}`,
      );
      throw residueError;
    },
  });

  await assert.rejects(
    () =>
      removeWorktreeAndSettleSessions(
        "wt-1",
        { deleteBranch: true },
        rec.operations,
      ),
    (error) => error === residueError,
  );
  assert.deepEqual(rec.calls, ["remove:wt-1:branch", "settle:wt-1"]);
});

test("a checkout owned by another user refuses as permissions, not a git guard", async () => {
  const rec = retireRecorder({
    async removeWorktree() {
      throw new WorktreeUndeletableError(
        "/repo/wt-1/.pnpm-store belongs to uid 0, so this server cannot delete it. Nothing was removed — hand it back with sudo chown.",
        "/repo/wt-1/.pnpm-store",
        0,
      );
    },
  });

  const result = await retireWorktree(
    "wt-1",
    { deleteBranch: true },
    rec.operations,
  );

  assert.equal(result.status, "refused");
  // `force` is consent to lose work; it cannot make another user's files
  // deletable, so the surface must not offer it here.
  assert.equal(
    result.status === "refused" ? result.refusalKind : undefined,
    "permissions",
  );
  assert.match(
    result.status === "refused" ? result.refusal : "",
    /belongs to uid 0/,
  );
  // The message owns its own ending: appending "Nothing was removed." to a
  // refusal that already explains the sudo fix would read as two verdicts.
  assert.doesNotMatch(
    result.status === "refused" ? result.refusal : "",
    /Nothing was removed\..*Nothing was removed\./,
  );
});

test("an ordinary git guard still refuses as git-guard", async () => {
  const rec = retireRecorder({
    async removeWorktree() {
      throw new WorktreeRemovalBlockedError(
        "Worktree has uncommitted changes.",
      );
    },
  });

  const result = await retireWorktree(
    "wt-1",
    { deleteBranch: true },
    rec.operations,
  );
  assert.equal(
    result.status === "refused" ? result.refusalKind : undefined,
    "git-guard",
  );
});
