import { existsSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowResultStatus } from "@assistant/shared";
import { getWorktree } from "../db/worktreeStore.ts";
import type { WorkflowRunRow, WorkflowStepRow } from "../db/workflowStore.ts";
import { git, gitOptional, repoLockKey, withRepoLock } from "../gitExec.ts";
import {
  repairRebasePayloadOf,
  type RebaseRepairSafetyEvidence,
} from "./codeDeliveryRecipe.ts";

async function rebaseInProgress(cwd: string): Promise<boolean> {
  const result = await gitOptional(["rev-parse", "--absolute-git-dir"], cwd);
  if (result.code !== 0) return false;
  const dir = result.stdout.trim();
  return (
    existsSync(join(dir, "rebase-merge")) ||
    existsSync(join(dir, "rebase-apply"))
  );
}

async function head(cwd: string): Promise<string> {
  return (
    await git(["rev-parse", "--verify", "HEAD^{commit}"], cwd)
  ).stdout.trim();
}

async function branch(cwd: string): Promise<string> {
  const result = await gitOptional(
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    cwd,
  );
  return result.code === 0 ? result.stdout.trim() : "";
}

async function status(cwd: string): Promise<string> {
  return (
    await git(["status", "--porcelain=v1", "--untracked-files=all"], cwd)
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

  return withRepoLock(await repoLockKey(row.mainRepoRoot), async () => {
    if (resultStatus === "completed") {
      if (await rebaseInProgress(row.path))
        throw new Error(
          "rebase repair cannot complete while a rebase is still in progress",
        );
      if ((await branch(row.path)) !== runBranch)
        throw new Error(
          `rebase repair cannot complete off the run branch "${runBranch}"`,
        );
      if (await status(row.path))
        throw new Error(
          "rebase repair cannot complete with uncommitted or untracked changes",
        );
      await head(row.path);
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

    if (await rebaseInProgress(row.path))
      await gitOptional(["rebase", "--abort"], row.path);
    if ((await branch(row.path)) !== runBranch)
      await git(["checkout", "-f", runBranch], row.path);
    await git(["reset", "--hard", repair.originalHead], row.path);
    // The repair started from a verified clean tree, so any untracked path now
    // present was created during this bounded assignment and must not survive a
    // failed/blocked recovery as an unreviewed workspace change.
    await git(["clean", "-fd"], row.path);
    const problems = [
      (await rebaseInProgress(row.path)) ? "a rebase is still in progress" : "",
      (await branch(row.path)) !== runBranch
        ? `the checkout is not on ${runBranch}`
        : "",
      (await head(row.path).catch(() => "")) !== repair.originalHead
        ? `HEAD was not restored to ${repair.originalHead}`
        : "",
      (await status(row.path)) ? "the worktree is not clean" : "",
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
