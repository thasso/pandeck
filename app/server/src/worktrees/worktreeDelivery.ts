/** Proofs that deleting a managed branch will not discard its only copy. */
import type { WorktreeRow } from "../db/worktreeStore.ts";
import { listWorktrees } from "../db/worktreeStore.ts";
import { pullRequestCardStore } from "../db/pullRequestCardStore.ts";
import type { PullRequestCardContext } from "../pullRequestCards.ts";
import { gitOptionalExit } from "../gitExec.ts";
import { branchContainedInBase } from "./worktreeStatus.ts";

export async function worktreeBranchDelivered(
  row: WorktreeRow,
  tip: string,
  containmentBase = row.baseBranch,
): Promise<boolean> {
  // Keep semantic containment BASE-specific. Equal patches on an arbitrary
  // sibling or backup branch are not evidence of delivery into this base.
  if (await branchContainedInBase(row.mainRepoRoot, tip, containmentBase))
    return true;

  const remoteRefs = await gitOptionalExit(
    [
      "for-each-ref",
      `--contains=${tip}`,
      "--format=%(refname)%09%(symref)",
      "refs/remotes/",
    ],
    row.mainRepoRoot,
  );
  if (
    remoteRefs.code === 0 &&
    remoteRefs.stdout.split("\n").some((line) => {
      const [ref, symref] = line.split("\t");
      return Boolean(ref) && !symref;
    })
  )
    return true;

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
