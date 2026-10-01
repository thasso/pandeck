/**
 * Deterministic, user-initiated synchronization actions for worktrees.
 *
 * Every operation runs under the repository-wide mutation lock, requires clean
 * participating checkouts, and pins its target to an oid before mutating. A
 * failed rebase is aborted and reset to the original HEAD; a failed ff-only
 * merge similarly verifies/restores the main checkout before returning an
 * error. No conflict-resolution agent is involved.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  WorktreeSyncOperation,
  WorktreeSyncResponse,
} from "@assistant/shared";
import { git, gitOptional, repoLockKey, withRepoLock } from "../gitExec.ts";
import { getWorktree, type WorktreeRow } from "../db/worktreeStore.ts";
import { invalidateWorktreeStatus } from "./worktreeStatus.ts";
import { isMainWorktreeId, mainWorktreeId } from "./worktreeResolve.ts";

const REMOTE_ENV: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND:
    "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20",
};

/**
 * A rebase that stopped on a CONFLICT (and was therefore aborted and the branch
 * restored), as opposed to any other failure. Callers that can offer something
 * better than an error message — the `/pr` card hands the conflict to the
 * session's agent — must not have to pattern-match on wording to tell the two
 * apart.
 */
export class WorktreeSyncConflictError extends Error {
  constructor(
    message: string,
    readonly operation: WorktreeSyncOperation,
    readonly conflictedFiles: readonly string[] = [],
    readonly conflictedFilesTruncated = false,
    readonly originalHead?: string,
  ) {
    super(message);
    this.name = "WorktreeSyncConflictError";
  }
}

/**
 * The world moved between the state a caller verified and the moment this took
 * the repository lock, so what it was about to do is no longer what was
 * checked. Thrown BEFORE anything is mutated, and typed because the callers
 * that pin an oid report a race as its own answer rather than as a failure.
 */
export class WorktreeSyncPreconditionError extends Error {
  constructor(
    message: string,
    readonly operation: WorktreeSyncOperation,
  ) {
    super(message);
    this.name = "WorktreeSyncPreconditionError";
  }
}

/**
 * What a caller has already verified about a `pull-rebase`, re-checked here
 * UNDER the lock. Without it the fetch inside this operation is free to bring
 * back a newer upstream than the one the caller validated, and a commit that
 * appeared in the checkout since its inspection would be rebased along — both
 * as "the update you asked for".
 */
export interface WorktreeSyncExpectation {
  /** The commit the worktree stood at when the caller inspected it. */
  head: string;
  /** The upstream commit the caller verified and means to land on. */
  upstream: string;
  /**
   * WHICH upstream that commit was read from — `branch.<name>.remote` and
   * `branch.<name>.merge` as the caller saw them.
   *
   * The oid alone does not pin this. The configured upstream is ordinary local
   * config that another action can repoint, and any two refs sitting at the
   * same commit satisfy an oid check — so a branch repointed between the
   * caller's inspection and this operation would pull from somewhere else, land
   * on the expected commit, and be reported as the update that was asked for.
   */
  upstreamRemote: string;
  /** e.g. `refs/heads/feature-7`. */
  upstreamMerge: string;
}

const MAX_CONFLICTED_FILES = 20;
const MAX_CONFLICTED_FILE_CHARS = 300;

/** Best-effort evidence captured before an aborted rebase clears the index. */
async function conflictedFiles(
  cwd: string,
): Promise<{ files: string[]; truncated: boolean }> {
  const result = await gitOptional(
    ["diff", "--name-only", "--diff-filter=U", "-z"],
    cwd,
  );
  if (result.code !== 0) return { files: [], truncated: false };
  const all = result.stdout.split("\0").filter(Boolean);
  return {
    files: all
      .slice(0, MAX_CONFLICTED_FILES)
      .map((file) =>
        file.length <= MAX_CONFLICTED_FILE_CHARS
          ? file
          : `${[...file].slice(0, MAX_CONFLICTED_FILE_CHARS - 1).join("")}…`,
      ),
    truncated:
      all.length > MAX_CONFLICTED_FILES ||
      all.some((file) => [...file].length > MAX_CONFLICTED_FILE_CHARS),
  };
}

async function oid(cwd: string, ref = "HEAD"): Promise<string> {
  return (await git(["rev-parse", "--verify", ref], cwd)).stdout.trim();
}

async function branch(cwd: string): Promise<string> {
  const result = await gitOptional(
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    cwd,
  );
  return result.code === 0 ? result.stdout.trim() : "";
}

async function requireClean(cwd: string, label: string): Promise<void> {
  const result = await git(
    ["status", "--porcelain=v1", "--untracked-files=all"],
    cwd,
  );
  if (result.stdout.trim())
    throw new Error(
      `${label} has uncommitted changes. Commit or clean them first.`,
    );
}

async function requireBranch(
  cwd: string,
  expected: string,
  label: string,
): Promise<void> {
  const actual = await branch(cwd);
  if (actual !== expected) {
    throw new Error(
      `${label} is on "${actual || "a detached HEAD"}", not "${expected}".`,
    );
  }
}

async function rebaseInProgress(cwd: string): Promise<boolean> {
  const result = await gitOptional(["rev-parse", "--absolute-git-dir"], cwd);
  if (result.code !== 0) return false;
  const dir = result.stdout.trim();
  return (
    existsSync(join(dir, "rebase-merge")) ||
    existsSync(join(dir, "rebase-apply"))
  );
}

async function restoreAfterRebaseFailure(
  cwd: string,
  originalHead: string,
): Promise<void> {
  if (await rebaseInProgress(cwd))
    await gitOptional(["rebase", "--abort"], cwd);
  const current = await oid(cwd).catch(() => "");
  if (current !== originalHead)
    await git(["reset", "--hard", originalHead], cwd);
  if ((await oid(cwd)) !== originalHead || (await rebaseInProgress(cwd))) {
    throw new Error(
      "The rebase failed and Git could not restore the worktree automatically. Inspect it before continuing.",
    );
  }
}

function response(
  row: WorktreeRow,
  operation: WorktreeSyncOperation,
  beforeHead: string,
  afterHead: string,
): WorktreeSyncResponse {
  return {
    worktreeId: row.id,
    operation,
    status: beforeHead === afterHead ? "up-to-date" : "updated",
    previousHead: beforeHead,
    head: afterHead,
  };
}

function invalidate(row: WorktreeRow): void {
  invalidateWorktreeStatus(row.id);
  invalidateWorktreeStatus(mainWorktreeId(row.projectId));
}

async function pullRebase(
  row: WorktreeRow,
  expected?: WorktreeSyncExpectation,
): Promise<WorktreeSyncResponse> {
  if (!expected) {
    // Unchanged for callers that pin nothing.
    await requireClean(row.path, "The worktree");
    await requireBranch(row.path, row.branch, "The worktree");
  } else {
    // A caller that pinned oids decided OUTSIDE this lock, so what it decided
    // on is re-established here first — starting with which branch is checked
    // out at all. A detached checkout tracks nothing, however convincing the
    // commit under it looks, so this cannot be folded into the oid checks.
    const current = await branch(row.path);
    if (current !== row.branch)
      throw new WorktreeSyncPreconditionError(
        `That worktree is on ${current ? `"${current}"` : "a detached HEAD"}, not "${row.branch}" as this update was checked against. Nothing was changed.`,
        "pull-rebase",
      );
  }
  const before = await oid(row.path);
  if (expected && before !== expected.head)
    throw new WorktreeSyncPreconditionError(
      `"${row.branch}" is at ${before.slice(0, 12)}, not the ${expected.head.slice(0, 12)} this update was checked against. Nothing was changed.`,
      "pull-rebase",
    );
  const remote = (
    await gitOptional(
      ["config", "--get", `branch.${row.branch}.remote`],
      row.path,
    )
  ).stdout.trim();
  const mergeRef = (
    await gitOptional(
      ["config", "--get", `branch.${row.branch}.merge`],
      row.path,
    )
  ).stdout.trim();
  if (!remote || !mergeRef)
    throw new Error(`Branch "${row.branch}" has no configured upstream.`);
  // The upstream's IDENTITY, before the fetch that would follow it: a caller
  // that verified this branch tracks a particular remote ref gets that checked
  // here, where the check is under the lock, rather than trusting config a
  // concurrent action may have repointed since.
  if (
    expected &&
    (remote !== expected.upstreamRemote || mergeRef !== expected.upstreamMerge)
  )
    throw new WorktreeSyncPreconditionError(
      `"${row.branch}" now tracks ${remote}/${mergeRef.replace(/^refs\/heads\//, "")}, not the ${expected.upstreamRemote}/${expected.upstreamMerge.replace(/^refs\/heads\//, "")} this update was checked against. Nothing was fetched or changed.`,
      "pull-rebase",
    );

  // Nothing to bring: the caller already stands at the upstream commit it means
  // to land on, and everything that makes that true — the branch, the head, the
  // upstream's identity — has just been re-established UNDER this lock. So the
  // answer is given here rather than by a caller checking outside it, and it
  // costs no fetch and no mutation. Dirt is deliberately not consulted: nothing
  // is being changed, so uncommitted work is in the way of nothing.
  if (expected && expected.head === expected.upstream)
    return response(row, "pull-rebase", before, before);
  if (expected) await requireClean(row.path, "The worktree");

  await git(
    ["fetch", "--no-tags", "--", remote, mergeRef],
    row.path,
    undefined,
    REMOTE_ENV,
  );
  const target = await oid(row.path, "FETCH_HEAD");
  // Still before any mutation of the checkout: the fetch above wrote refs, not
  // the working tree, so a caller whose upstream moved is refused with the
  // branch exactly as it was.
  if (expected && target !== expected.upstream)
    throw new WorktreeSyncPreconditionError(
      `${remote}/${mergeRef.replace(/^refs\/heads\//, "")} is at ${target.slice(0, 12)}, not the ${expected.upstream.slice(0, 12)} this update was checked against. "${row.branch}" was left as it is.`,
      "pull-rebase",
    );
  const result = await gitOptional(
    ["-c", "rebase.autoStash=false", "rebase", target],
    row.path,
  );
  if (result.code !== 0) {
    const conflicted = await rebaseInProgress(row.path);
    const evidence = conflicted
      ? await conflictedFiles(row.path)
      : { files: [], truncated: false };
    await restoreAfterRebaseFailure(row.path, before);
    if (conflicted)
      throw new WorktreeSyncConflictError(
        `Pull with rebase hit a conflict. The rebase was aborted and "${row.branch}" was restored.`,
        "pull-rebase",
        evidence.files,
        evidence.truncated,
        before,
      );
    throw new Error(
      `Pull with rebase failed. "${row.branch}" was restored. ${result.stderr.trim()}`.trim(),
    );
  }
  // Match the working tree to the freshly pulled gitlinks, and initialize
  // submodules added upstream since this checkout was cloned. Pull is the ONE
  // update path now that the Project page no longer offers one, so this step
  // moved here from `projectProvision.pullProjectRepo`.
  await git(
    ["submodule", "update", "--init", "--recursive"],
    row.path,
    undefined,
    REMOTE_ENV,
  );
  invalidate(row);
  return response(row, "pull-rebase", before, await oid(row.path));
}

/**
 * Rebase the branch onto the BASE BRANCH AS THE REMOTE HAS IT: fetch
 * `origin/<base>` and rebase onto what came back. The local main checkout is
 * deliberately not consulted any more — it is one clone of the truth among
 * several, it may be days behind or ahead of what everyone else sees, and
 * "rebase onto main" meaning "onto whatever this machine's main checkout
 * happens to be at" is exactly the ambiguity that made the action unreadable.
 * With no remote (a local-only project) the base branch's local ref is the only
 * truth there is, so that is the fallback.
 */
async function rebaseOnMain(
  row: WorktreeRow,
  baseRemote?: string,
): Promise<WorktreeSyncResponse> {
  if (isMainWorktreeId(row.id))
    throw new Error("The main checkout cannot be rebased onto itself.");
  await requireClean(row.path, "The worktree");
  await requireBranch(row.path, row.branch, "The worktree");
  const before = await oid(row.path);
  const target = await baseBranchTarget(
    row,
    baseRemote ? { remote: baseRemote } : {},
  );
  const result = await gitOptional(
    ["-c", "rebase.autoStash=false", "rebase", target],
    row.path,
  );
  if (result.code !== 0) {
    const conflicted = await rebaseInProgress(row.path);
    const evidence = conflicted
      ? await conflictedFiles(row.path)
      : { files: [], truncated: false };
    await restoreAfterRebaseFailure(row.path, before);
    if (conflicted)
      throw new WorktreeSyncConflictError(
        `Rebase onto ${row.baseBranch} hit a conflict. The rebase was aborted and "${row.branch}" was restored.`,
        "rebase-main",
        evidence.files,
        evidence.truncated,
        before,
      );
    throw new Error(
      `Rebase onto ${row.baseBranch} failed. "${row.branch}" was restored. ${result.stderr.trim()}`.trim(),
    );
  }
  invalidate(row);
  return response(row, "rebase-main", before, await oid(row.path));
}

/** The oid to rebase onto: the selected remote's base, else the local ref. */
export async function baseBranchTarget(
  row: WorktreeRow,
  options: { remote?: string } = {},
): Promise<string> {
  const remote = options.remote ?? (await baseBranchRemote(row));
  if (remote) {
    const namedRemote = (await remoteNames(row)).includes(remote);
    // Fetch is network-bound and therefore outside the repo lock's concern. It
    // always updates FETCH_HEAD; a configured remote name also gets its
    // remote-tracking ref. Ad-hoc paths/URLs and `.` have no tracking ref.
    await git(
      [
        "fetch",
        "--no-tags",
        "--",
        remote,
        namedRemote
          ? `+refs/heads/${row.baseBranch}:refs/remotes/${remote}/${row.baseBranch}`
          : `refs/heads/${row.baseBranch}`,
      ],
      row.path,
      undefined,
      REMOTE_ENV,
    );
    return oid(row.path, "FETCH_HEAD");
  }
  const local = await gitOptional(
    ["rev-parse", "--verify", `refs/heads/${row.baseBranch}`],
    row.path,
  );
  if (local.code !== 0)
    throw new Error(
      `Cannot rebase: "${row.baseBranch}" exists neither on a remote nor locally.`,
    );
  return local.stdout.trim();
}

async function remoteNames(row: WorktreeRow): Promise<string[]> {
  return (await gitOptional(["remote"], row.path)).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** The remote that carries the base branch, if the repository has one. */
export async function baseBranchRemote(
  row: WorktreeRow,
): Promise<string | undefined> {
  const configured = (
    await gitOptional(
      ["config", "--get", `branch.${row.baseBranch}.remote`],
      row.path,
    )
  ).stdout.trim();
  if (configured) return configured;
  const remotes = await remoteNames(row);
  if (remotes.includes("origin")) return "origin";
  if (remotes.length > 1) {
    // A fork/upstream repository with neither `origin` nor a configured remote
    // for the base branch: picking one would rewrite the branch against a
    // history the user never named. Refuse and say how to settle it.
    throw new Error(
      `Cannot rebase: "${row.baseBranch}" has no configured remote and this repository has several (${remotes.join(", ")}). Set branch.${row.baseBranch}.remote to say which one is the truth.`,
    );
  }
  return remotes[0];
}

async function fastForwardMain(
  row: WorktreeRow,
): Promise<WorktreeSyncResponse> {
  if (isMainWorktreeId(row.id))
    throw new Error("The main checkout cannot be merged into itself.");
  await requireClean(row.path, "The worktree");
  await requireClean(row.mainRepoRoot, "The main checkout");
  await requireBranch(row.path, row.branch, "The worktree");
  await requireBranch(row.mainRepoRoot, row.baseBranch, "The main checkout");
  const before = await oid(row.mainRepoRoot);
  const source = await oid(row.path);
  const result = await gitOptional(
    ["merge", "--ff-only", source],
    row.mainRepoRoot,
  );
  if (result.code !== 0) {
    const current = await oid(row.mainRepoRoot).catch(() => "");
    if (current !== before)
      await git(["reset", "--hard", before], row.mainRepoRoot);
    if ((await oid(row.mainRepoRoot)) !== before) {
      throw new Error(
        "The fast-forward merge failed and Git could not restore the main checkout automatically. Inspect it before continuing.",
      );
    }
    throw new Error(
      `Could not fast-forward main from "${row.branch}". The main checkout was left unchanged.`,
    );
  }
  invalidate(row);
  return response(
    row,
    "fast-forward-main",
    before,
    await oid(row.mainRepoRoot),
  );
}

export async function syncWorktree(
  row: WorktreeRow,
  operation: WorktreeSyncOperation,
  options: {
    baseRemote?: string;
    /** `pull-rebase` only: what the caller verified, re-checked under the lock. */
    expected?: WorktreeSyncExpectation;
  } = {},
): Promise<WorktreeSyncResponse> {
  return withRepoLock(await repoLockKey(row.mainRepoRoot), async () => {
    let current = row;
    if (!isMainWorktreeId(row.id)) {
      // A base retarget can land while this action waits for the repository
      // lock. Persisted production rows must use the serialized base. Tests and
      // standalone callers may supply an unregistered row, which remains valid.
      const persisted = getWorktree(row.id);
      if (persisted) {
        if (
          persisted.status !== "active" ||
          persisted.path !== row.path ||
          persisted.branch !== row.branch ||
          persisted.mainRepoRoot !== row.mainRepoRoot
        )
          throw new Error("The managed worktree changed or was removed.");
        current = persisted;
      }
    }
    if (operation === "pull-rebase")
      return pullRebase(current, options.expected);
    if (operation === "rebase-main")
      return rebaseOnMain(current, options.baseRemote);
    return fastForwardMain(current);
  });
}
