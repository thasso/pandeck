/** Proofs that deleting a managed branch will not discard its only copy. */
import type { WorktreeRow } from "../db/worktreeStore.ts";
import { listWorktrees } from "../db/worktreeStore.ts";
import { pullRequestCardStore } from "../db/pullRequestCardStore.ts";
import type { PullRequestCardContext } from "../pullRequestCards.ts";
import { checkoutGitOn } from "../gitExec.ts";
import { checkoutSideOf } from "./knowledgeCheckout.ts";
import { branchContainedInBase } from "./worktreeStatus.ts";

export async function worktreeBranchDelivered(
  row: WorktreeRow,
  tip: string,
  containmentBase = row.baseBranch,
  remoteHeads: readonly string[] = [],
): Promise<boolean> {
  const { gitOptionalExit } = checkoutGitOn(checkoutSideOf(row));
  // Keep semantic containment BASE-specific. Equal patches on an arbitrary
  // sibling or backup branch are not evidence of delivery into this base.
  if (
    await branchContainedInBase(
      checkoutSideOf(row),
      row.mainRepoRoot,
      tip,
      containmentBase,
    )
  )
    return true;

  // Only heads just advertised by another repository count. Tracking refs
  // can be stale after remote deletion and vanish on our next pruning fetch.
  for (const head of remoteHeads) {
    const ancestor = await gitOptionalExit(
      ["merge-base", "--is-ancestor", tip, head],
      row.mainRepoRoot,
    );
    if (ancestor.code === 0) return true;
  }

  // Review checkouts can outlive the implementation ref after a squash merge
  // or rebase. Its tombstone still identifies the merged PR receipt to check.
  const owners = [
    row,
    ...listWorktrees({ projectId: row.projectId, includeRemoved: true }).filter(
      (candidate) =>
        candidate.id !== row.id &&
        candidate.mainRepoRoot === row.mainRepoRoot &&
        candidate.branch === row.baseBranch,
    ),
  ];
  for (const owner of owners) {
    for (const { card, context } of pullRequestCardStore.forWorktree(
      owner.id,
    )) {
      if (card.status !== "merged") continue;
      // The creation head can predate a force-push. Only a provider-observed
      // head on the merged card proves the tip that actually landed.
      const head = (context as PullRequestCardContext).observedHeadSha;
      if (!head || !/^[a-f0-9]{40,64}$/i.test(head)) continue;
      const ancestor = await gitOptionalExit(
        ["merge-base", "--is-ancestor", tip, head],
        row.mainRepoRoot,
      );
      if (ancestor.code === 0) return true;
    }
  }
  return false;
}
