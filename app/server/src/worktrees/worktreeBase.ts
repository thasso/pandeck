/** Change the recorded merge-back target of an active spawned worktree. */
import { gitOptional, repoLockKey, withRepoLock } from "../gitExec.ts";
import { getWorktree, updateWorktreeBase } from "../db/worktreeStore.ts";
import { invalidateWorktreeHosting } from "./worktreeHosting.ts";
import { mergePhase } from "./worktreeMerge.ts";
import { invalidateWorktreeStatus } from "./worktreeStatus.ts";
import { broadcastWorktreeList } from "./worktrees.ts";

export interface WorktreeBaseChange {
  worktreeId: string;
  branch: string;
  previousBaseBranch: string;
  previousBaseCommit: string;
  baseBranch: string;
  baseCommit: string;
  changed: boolean;
}

/**
 * Record a new local merge-back branch and its common ancestor with the managed
 * branch for whole-branch diffs. This changes app metadata only. It does not
 * rebase the branch or retarget a provider pull request.
 */
export async function changeWorktreeBase(
  worktreeId: string,
  requestedBaseBranch: string,
  signal?: AbortSignal,
): Promise<WorktreeBaseChange> {
  const baseBranch = requestedBaseBranch.trim();
  if (!baseBranch) throw new Error("baseBranch is required.");

  const initial = getWorktree(worktreeId);
  if (!initial || initial.status !== "active")
    throw new Error("That active managed worktree is not available.");
  if (baseBranch === initial.branch)
    throw new Error("A worktree branch cannot be its own merge-back target.");

  const repoKey = await repoLockKey(initial.mainRepoRoot);
  const result = await withRepoLock(repoKey, async () => {
    const row = getWorktree(worktreeId);
    if (
      !row ||
      row.status !== "active" ||
      row.path !== initial.path ||
      row.branch !== initial.branch ||
      row.mainRepoRoot !== initial.mainRepoRoot
    )
      throw new Error("The managed worktree changed or was removed.");
    const phase = mergePhase(row.id);
    if (
      phase === "merging" ||
      phase === "conflicts" ||
      phase === "agent_resolving"
    )
      throw new Error(
        "The managed worktree has a merge in progress. Finish or abort it before changing the base.",
      );
    const ref = `refs/heads/${baseBranch}`;
    const resolved = await gitOptional(
      ["show-ref", "--verify", "--hash", ref],
      row.mainRepoRoot,
      signal,
    );
    if (resolved.code !== 0 || !resolved.stdout.trim())
      throw new Error(
        `Base branch ${JSON.stringify(baseBranch)} must be an existing local branch. Remote refs, tags and commit SHAs are not merge-back targets.`,
      );
    const fork = await gitOptional(
      ["merge-base", ref, `refs/heads/${row.branch}`],
      row.mainRepoRoot,
      signal,
    );
    const baseCommit = fork.stdout.trim();
    if (fork.code !== 0 || !baseCommit)
      throw new Error(
        `Base branch ${JSON.stringify(baseBranch)} does not share commit history with ${JSON.stringify(row.branch)}.`,
      );
    if (baseBranch === row.baseBranch && baseCommit === row.baseCommit)
      return {
        worktreeId: row.id,
        branch: row.branch,
        previousBaseBranch: row.baseBranch,
        previousBaseCommit: row.baseCommit,
        baseBranch: row.baseBranch,
        baseCommit: row.baseCommit,
        changed: false,
      } satisfies WorktreeBaseChange;

    const updated = updateWorktreeBase(row.id, baseBranch, baseCommit);
    if (!updated)
      throw new Error("The managed worktree changed or was removed.");
    return {
      worktreeId: updated.id,
      branch: updated.branch,
      previousBaseBranch: row.baseBranch,
      previousBaseCommit: row.baseCommit,
      baseBranch: updated.baseBranch,
      baseCommit: updated.baseCommit,
      changed: true,
    } satisfies WorktreeBaseChange;
  });

  if (result.changed) {
    invalidateWorktreeStatus(worktreeId);
    invalidateWorktreeHosting(worktreeId);
    void broadcastWorktreeList().catch(() => undefined);
  }
  return result;
}
