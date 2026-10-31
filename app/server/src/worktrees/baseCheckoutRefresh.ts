import type { WorktreeRow } from "../db/worktreeStore.ts";
import { listWorktrees } from "../db/worktreeStore.ts";
import { checkoutGitOn, withRepoLock, type GitResult } from "../gitExec.ts";
import type { CheckoutSide } from "../workers/placement.ts";
import { checkoutSideOf } from "./knowledgeCheckout.ts";
import {
  resolveMainWorktreeRow,
  resolveWorktreeRow,
} from "./worktreeResolve.ts";
import { invalidateWorktreeStatus } from "./worktreeStatus.ts";
import { baseBranchTarget } from "./worktreeSync.ts";
import { baseBranchRemote } from "./worktreeRemote.ts";

const REMOTE_ENV: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND:
    "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20",
};
const LOCAL_BRANCH_FETCH_ENV: NodeJS.ProcessEnv = {
  ...REMOTE_ENV,
  // The checked-out-ref refusal is classified from Git's prose. Pin its locale
  // so the specific outcome stays deterministic; unknown refusals still use
  // the honest generic fallback below.
  LC_ALL: "C",
};

export interface BaseCheckoutRefreshInput {
  worktreeId: string;
  repoPath: string;
  /** The side `repoPath` is on. */
  side: CheckoutSide;
  baseBranch: string;
}

/**
 * Side-effecting seams for the targeted post-merge refresh. Each checkout
 * operation runs on the side its caller names for `path`.
 */
export interface BaseCheckoutRefreshOperations {
  resolveWorktree(worktreeId: string): Promise<WorktreeRow | undefined>;
  resolveMainWorktree(projectId: string): Promise<WorktreeRow | undefined>;
  listSpawnedWorktrees(projectId: string): WorktreeRow[];
  repoKey(side: CheckoutSide, path: string): Promise<string>;
  currentBranch(side: CheckoutSide, path: string): Promise<string>;
  isDirty(side: CheckoutSide, path: string): Promise<boolean>;
  head(side: CheckoutSide, path: string): Promise<string>;
  baseRemote(row: WorktreeRow): Promise<string | undefined>;
  fetchBaseTarget(row: WorktreeRow, remote?: string): Promise<string>;
  isAncestor(
    side: CheckoutSide,
    path: string,
    ancestor: string,
    descendant: string,
  ): Promise<boolean>;
  localBranchOid(
    side: CheckoutSide,
    path: string,
    branch: string,
  ): Promise<string | undefined>;
  fastForwardCheckout(
    side: CheckoutSide,
    path: string,
    target: string,
  ): Promise<void>;
  updateSubmodules(side: CheckoutSide, path: string): Promise<void>;
  fastForwardLocalBranch(
    side: CheckoutSide,
    path: string,
    remote: string,
    branch: string,
  ): Promise<GitResult>;
  withRepoLock<T>(key: string, run: () => Promise<T>): Promise<T>;
  invalidateStatus(worktreeId: string): void;
}

async function currentBranch(
  side: CheckoutSide,
  path: string,
): Promise<string> {
  const result = await checkoutGitOn(side).gitOptionalExit(
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    path,
  );
  return result.code === 0 ? result.stdout.trim() : "";
}

const defaultOperations: BaseCheckoutRefreshOperations = {
  resolveWorktree: resolveWorktreeRow,
  resolveMainWorktree: resolveMainWorktreeRow,
  listSpawnedWorktrees: (projectId) => listWorktrees({ projectId }),
  repoKey: (side, path) => checkoutGitOn(side).repoLockKey(path),
  currentBranch,
  async isDirty(side, path) {
    const result = await checkoutGitOn(side).git(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      path,
    );
    return Boolean(result.stdout.trim());
  },
  async head(side, path) {
    return (
      await checkoutGitOn(side).git(["rev-parse", "--verify", "HEAD"], path)
    ).stdout.trim();
  },
  baseRemote: baseBranchRemote,
  fetchBaseTarget: (row, remote) =>
    baseBranchTarget(row, remote ? { remote } : {}),
  async isAncestor(side, path, ancestor, descendant) {
    return (
      (
        await checkoutGitOn(side).gitOptionalExit(
          ["merge-base", "--is-ancestor", ancestor, descendant],
          path,
        )
      ).code === 0
    );
  },
  async localBranchOid(side, path, branch) {
    const result = await checkoutGitOn(side).gitOptionalExit(
      ["rev-parse", "--verify", `refs/heads/${branch}`],
      path,
    );
    return result.code === 0 ? result.stdout.trim() : undefined;
  },
  async fastForwardCheckout(side, path, target) {
    await checkoutGitOn(side).git(["merge", "--ff-only", target], path);
  },
  async updateSubmodules(side, path) {
    await checkoutGitOn(side).git(
      ["submodule", "update", "--init", "--recursive"],
      path,
      undefined,
      REMOTE_ENV,
    );
  },
  fastForwardLocalBranch: (side, path, remote, branch) =>
    checkoutGitOn(side).gitOptionalExit(
      [
        "fetch",
        "--no-tags",
        "--",
        remote,
        `refs/heads/${branch}:refs/heads/${branch}`,
      ],
      path,
      undefined,
      LOCAL_BRANCH_FETCH_ENV,
    ),
  withRepoLock,
  invalidateStatus: invalidateWorktreeStatus,
};

/** Test seam for exercising the production Git operations against real repos. */
export function baseCheckoutRefreshOperationsForTests(): BaseCheckoutRefreshOperations {
  return defaultOperations;
}

function shortOid(oid: string): string {
  return oid.slice(0, 7);
}

function checkedOutRefusal(result: GitResult): boolean {
  return /checked out/i.test(`${result.stderr}\n${result.stdout}`);
}

/**
 * Refresh the one local base branch affected by a merge initiated here.
 * Expected safety refusals are returned as outcome prose; unexpected failures
 * throw so the merge projection can log and suppress them.
 */
export async function refreshBaseCheckoutAfterMerge(
  input: BaseCheckoutRefreshInput,
  operations: BaseCheckoutRefreshOperations = defaultOperations,
): Promise<string | undefined> {
  const source = await operations.resolveWorktree(input.worktreeId);
  if (!source || source.status !== "active") return undefined;

  const mergeRepoKey = await operations.repoKey(input.side, input.repoPath);
  const main = await operations.resolveMainWorktree(source.projectId);
  const candidates = [
    ...(main ? [main] : []),
    ...operations.listSpawnedWorktrees(source.projectId),
  ];
  let baseCheckout: WorktreeRow | undefined;
  for (const candidate of candidates) {
    if (
      (await operations.repoKey(checkoutSideOf(candidate), candidate.path)) ===
        mergeRepoKey &&
      (await operations.currentBranch(
        checkoutSideOf(candidate),
        candidate.path,
      )) === input.baseBranch
    ) {
      baseCheckout = candidate;
      break;
    }
  }

  const fetchRow = {
    ...(baseCheckout ?? source),
    baseBranch: input.baseBranch,
  };
  const remote = await operations.baseRemote(fetchRow);
  const target = await operations.fetchBaseTarget(fetchRow, remote);
  const statusId = baseCheckout?.id ?? main?.id;

  const outcome = await operations.withRepoLock(mergeRepoKey, async () => {
    if (baseCheckout) {
      const side = checkoutSideOf(baseCheckout);
      if (await operations.isDirty(side, baseCheckout.path))
        return `${input.baseBranch} was not updated: it has uncommitted changes.`;
      const branch = await operations.currentBranch(side, baseCheckout.path);
      if (!branch)
        return `${input.baseBranch} was not updated: its managed checkout is detached.`;
      if (branch !== input.baseBranch)
        return `${input.baseBranch} was not updated: its managed checkout moved to ${branch}.`;
      const head = await operations.head(side, baseCheckout.path);
      if (head === target) return `${input.baseBranch} was already up to date.`;
      if (!(await operations.isAncestor(side, baseCheckout.path, head, target)))
        return `${input.baseBranch} was not updated: it has local commits that are not in ${remote ? `${remote}/` : ""}${input.baseBranch}.`;
      await operations.fastForwardCheckout(side, baseCheckout.path, target);
      await operations.updateSubmodules(side, baseCheckout.path);
      return `Updated ${input.baseBranch} to ${shortOid(target)}.`;
    }

    const mainSide = checkoutSideOf(source);
    const local = await operations.localBranchOid(
      mainSide,
      source.mainRepoRoot,
      input.baseBranch,
    );
    if (!local)
      return `${input.baseBranch} was not updated: it does not exist locally.`;
    if (local === target) return `${input.baseBranch} was already up to date.`;
    if (
      !(await operations.isAncestor(
        mainSide,
        source.mainRepoRoot,
        local,
        target,
      ))
    )
      return `${input.baseBranch} was not updated: it has local commits that are not in ${remote ? `${remote}/` : ""}${input.baseBranch}.`;
    if (!remote)
      return `${input.baseBranch} was not updated: it has no configured remote.`;
    const result = await operations.fastForwardLocalBranch(
      mainSide,
      source.mainRepoRoot,
      remote,
      input.baseBranch,
    );
    if (result.code !== 0)
      return checkedOutRefusal(result)
        ? `${input.baseBranch} was not updated: it is checked out in another worktree.`
        : `${input.baseBranch} was not updated: Git refused the fast-forward.`;
    return `Fast-forwarded ${input.baseBranch} (not checked out anywhere).`;
  });

  if (statusId) operations.invalidateStatus(statusId);
  operations.invalidateStatus(input.worktreeId);
  return outcome;
}
