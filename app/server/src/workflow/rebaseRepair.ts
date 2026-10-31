import { join } from "node:path";
import type { WorkflowResultStatus } from "@assistant/shared";
import { checkoutFilesOn } from "../checkoutFileAccess.ts";
import { getWorktree } from "../db/worktreeStore.ts";
import type { WorkflowRunRow, WorkflowStepRow } from "../db/workflowStore.ts";
import { checkoutGitOn, withRepoLock } from "../gitExec.ts";
import type { CheckoutSide } from "../workers/placement.ts";
import { checkoutSideOf } from "../worktrees/knowledgeCheckout.ts";
import {
  repairRebasePayloadOf,
  type RebaseRepairSafetyEvidence,
} from "./codeDeliveryRecipe.ts";

async function rebaseInProgress(
  side: CheckoutSide,
  cwd: string,
): Promise<boolean> {
  const { pathExists } = checkoutFilesOn(side);
  const result = await checkoutGitOn(side).gitOptional(
    ["rev-parse", "--absolute-git-dir"],
    cwd,
  );
  if (result.code !== 0) return false;
  const dir = result.stdout.trim();
  return (
    (await pathExists(cwd, join(dir, "rebase-merge"))) ||
    (await pathExists(cwd, join(dir, "rebase-apply")))
  );
}

async function head(side: CheckoutSide, cwd: string): Promise<string> {
  return (
    await checkoutGitOn(side).git(
      ["rev-parse", "--verify", "HEAD^{commit}"],
      cwd,
    )
  ).stdout.trim();
}

async function branch(side: CheckoutSide, cwd: string): Promise<string> {
  const result = await checkoutGitOn(side).gitOptional(
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    cwd,
  );
  return result.code === 0 ? result.stdout.trim() : "";
}

async function status(side: CheckoutSide, cwd: string): Promise<string> {
  return (
    await checkoutGitOn(side).git(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      cwd,
    )
  ).stdout.trim();
}

/**
 * Enforce the repair assignment's Git postcondition under the repository lock.
 * A completed repair must be a clean finished rebase onto the recorded base;
 * every other outcome is aborted/reset to the exact pre-repair head before the
 * workflow is allowed to record it as terminal.
 */
export async function finalizeRebaseRepair(
  run: WorkflowRunRow,
  step: WorkflowStepRow,
  resultStatus: WorkflowResultStatus,
): Promise<RebaseRepairSafetyEvidence | undefined> {
  const repair = repairRebasePayloadOf(step);
  if (!repair) return undefined;
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(repair.originalHead))
    throw new Error(`repair step ${step.id} has an invalid original head`);
  if (!run.worktreeId || !run.branch)
    throw new Error(`workflow run ${run.id} has no repair worktree or branch`);
  const runBranch = run.branch;
  const row = getWorktree(run.worktreeId);
  if (!row || row.status !== "active")
    throw new Error(
      `workflow repair worktree ${run.worktreeId} is unavailable`,
    );
  if (row.branch !== runBranch || row.baseBranch !== repair.baseBranch)
    throw new Error(
      `workflow repair step ${step.id} no longer matches its worktree`,
    );

  const side = checkoutSideOf(row);
  const { git, gitOptional, repoLockKey } = checkoutGitOn(side);
  return withRepoLock(await repoLockKey(row.mainRepoRoot), async () => {
    if (resultStatus === "completed") {
      if (await rebaseInProgress(side, row.path))
        throw new Error(
          "rebase repair cannot complete while a rebase is still in progress",
        );
      if ((await branch(side, row.path)) !== runBranch)
        throw new Error(
          `rebase repair cannot complete off the run branch "${runBranch}"`,
        );
      if (await status(side, row.path))
        throw new Error(
          "rebase repair cannot complete with uncommitted or untracked changes",
        );
      await head(side, row.path);
      const based = await gitOptional(
        ["merge-base", "--is-ancestor", repair.baseBranch, "HEAD"],
        row.path,
      );
      if (based.code !== 0)
        throw new Error(
          `rebase repair did not place the run branch onto ${repair.baseBranch}`,
        );
      return undefined;
    }

    if (await rebaseInProgress(side, row.path))
      await gitOptional(["rebase", "--abort"], row.path);
    if ((await branch(side, row.path)) !== runBranch)
      await git(["checkout", "-f", runBranch], row.path);
    await git(["reset", "--hard", repair.originalHead], row.path);
    // The repair started from a verified clean tree, so any untracked path now
    // present was created during this bounded assignment and must not survive a
    // failed/blocked recovery as an unreviewed workspace change.
    await git(["clean", "-fd"], row.path);
    const problems = [
      (await rebaseInProgress(side, row.path))
        ? "a rebase is still in progress"
        : "",
      (await branch(side, row.path)) !== runBranch
        ? `the checkout is not on ${runBranch}`
        : "",
      (await head(side, row.path).catch(() => "")) !== repair.originalHead
        ? `HEAD was not restored to ${repair.originalHead}`
        : "",
      (await status(side, row.path)) ? "the worktree is not clean" : "",
    ].filter(Boolean);
    if (problems.length > 0)
      throw new Error(
        `rebase repair safety recovery failed: ${problems.join("; ")}`,
      );
    return {
      verified: true,
      restored: true,
      originalHead: repair.originalHead,
    };
  });
}
