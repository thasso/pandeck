/**
 * Worktree lifecycle: resolve a project's main checkout, spawn worktrees from
 * it (`git worktree add`), list them with resolved edges, and remove them with
 * unmerged/dirty guards. Live git state (dirty, ahead/behind, merged) is
 * computed by `worktreeStatus.ts`; this module owns the durable rows and the
 * git mutations, which run under {@link withRepoLock}.
 */
import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import {
  boundMergeMessage,
  type WorktreeMergePhase,
  type WorktreeRecord,
} from "@assistant/shared";
import {
  git,
  gitOptional,
  gitOptionalExit,
  repoLockKey,
  withRepoLock,
  type GitResult,
} from "../gitExec.ts";
import { errorText } from "../errors.ts";
import {
  removeManagedTree,
  restoreOwnerAccess,
  scanTreeResidue,
  type TreeResidue,
} from "../managedTreeRemoval.ts";
import { reclaimContainerResidue } from "../containerResidue.ts";
import { getSettings } from "../settings.ts";
import {
  getProject,
  listProjects,
  type ProjectRecord,
} from "../projectRegistry.ts";
import {
  assertWorktreeCommentsDeletable,
  clearWorktreeBranchCleanup,
  finalizeWorktreeRemoval,
  getWorktree,
  insertWorktree,
  linkSessionToWorktree,
  linkTaskToWorktree,
  listComments as listWorktreeCommentRows,
  listReviewSets,
  listWorktrees,
  sessionIdsForWorktree,
  taskIdsForWorktree,
  type WorktreeRow,
} from "../db/worktreeStore.ts";
import { worktreeBroadcaster } from "./worktreeEvents.ts";
import { fetchRepoIfDue } from "./worktreeFetch.ts";
import {
  broadcastComments,
  purgeMainCommentsForBranchSubject,
} from "./worktreeComments.ts";
import { registerWorktree, unregisterWorktree } from "./worktreeWatcher.ts";
import { branchContainedInBase } from "./worktreeStatus.ts";
import {
  isMainWorktreeId,
  noMainRepoMessage,
  resolveMainRepo,
  resolveMainWorktreeRow,
  type MainRepoInfo,
} from "./worktreeResolve.ts";
import { stopCheckoutProcesses } from "./checkoutProcesses.ts";

/**
 * Non-interactive git/ssh env for creation's submodule setup: fail fast instead
 * of waiting for a credential/host-key prompt with no tty. It runs OUTSIDE the
 * repo lock and writes only the unregistered worktree's private state under
 * `.git/worktrees/<name>/modules/`.
 */
const REMOTE_ENV: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND:
    "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20",
};

/** Run `fn` over `items` with at most `limit` in flight (bounds git fan-out). */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker),
  );
  return results;
}

/** Where a new worktree for this project is created: project override, else global setting. */
function worktreeRootFor(project: ProjectRecord): string {
  return project.worktreeRoot?.trim() || getSettings().worktrees.root;
}

/**
 * Where a new worktree's own branch comes from. Absent means
 * {@link NEW_BRANCH_SOURCE}, which is what every ordinary caller wants and what
 * this module did before the variant existed.
 */
type CreateWorktreeSource =
  | {
      /** Mint branch `<name>` at the local base branch's head. */
      kind: "new-branch";
    }
  | {
      /**
       * Check out an EXISTING branch of a remote: the worktree's own branch IS
       * `headBranch` and TRACKS `<remote>/<headBranch>`, so pulling it is an
       * ordinary `pull --rebase` rather than a second branch to reconcile.
       *
       * The branch name is therefore not negotiable — it is the remote's — and
       * `name` becomes the FOLDER suffix alone. A local branch of that name
       * already existing is refused ({@link WorktreeCreateRefusalError}) rather
       * than adopted: this path never moves a branch it did not create.
       */
      kind: "track-remote";
      /** Remote name in the main checkout, e.g. `origin`. */
      remote: string;
      /** Branch name on that remote — no `refs/heads/`, no remote prefix. */
      headBranch: string;
      /**
       * The EXACT commit to check out, which the caller has already verified is
       * the one it means. The branch is created at this oid and its upstream
       * configured separately, rather than branching off the remote-tracking
       * REF: that ref moves, and any fetch — including the background one this
       * very function fires before taking the lock — can move it between the
       * caller's verification and the `worktree add`, producing a checkout of a
       * commit nobody checked. Refused as `head-unreachable` when the commit is
       * no longer in the repository.
       */
      headCommit: string;
      /**
       * Preferred merge-back target, used ONLY where it exists as a local
       * branch (`refs/heads/<name>`); otherwise the main checkout's current
       * branch is recorded. The result's `baseBranch` is which one it was —
       * the caller reports that rather than assuming its preference won.
       */
      preferredBaseBranch?: string;
    };

const NEW_BRANCH_SOURCE: CreateWorktreeSource = { kind: "new-branch" };

/**
 * A creation this module refuses on a STATED precondition, as opposed to one
 * that failed. Typed because the refusals are the caller's data — the Pull
 * Requests view renders them on the pull request — and classifying them from
 * Git's prose at the call site is exactly how a refusal turns into a 500.
 */
export class WorktreeCreateRefusalError extends Error {
  constructor(
    message: string,
    readonly kind: "branch-exists" | "head-unreachable" | "base-unresolvable",
  ) {
    super(message);
    this.name = "WorktreeCreateRefusalError";
  }
}

export interface CreateWorktreeInput {
  projectId: string;
  /**
   * The name suffix; becomes the branch name and the folder suffix. With a
   * `track-remote` source the branch is the remote's, so this names the folder
   * only.
   */
  name: string;
  /**
   * Local branch to fork from and later merge back into. Defaults to the main
   * checkout's current branch; remote refs, tags and commits are not valid.
   * Ignored by `track-remote`, which states its preference in the source.
   */
  baseBranch?: string;
  /** Where the worktree's branch comes from; absent = a new branch, as before. */
  source?: CreateWorktreeSource;
  taskId?: string;
  sessionId?: string;
  /**
   * Called when the network-bound submodule checkout starts, and only when the
   * repository actually has submodules. It is the one step here that can take
   * minutes, so a caller showing progress must be able to say so rather than
   * leave "creating…" on screen for the whole clone.
   */
  onSubmodules?: () => void;
  /** Abort a long-running create, including a submodule checkout. */
  signal?: AbortSignal;
}

/**
 * Spawn a worktree from the project's main checkout: branch `<name>` off the
 * main branch, checked out at `<root>/<mainFolder>-<name>`. On collision the
 * suffix gets `-2`, `-3`, … appended. Submodules are checked out before the row
 * is recorded, so a session opening the worktree sees a complete tree.
 * Atomic for the caller: a failure after the `git worktree add` discards the
 * checkout and its branch, so a rejected create leaves nothing behind.
 * Broadcasts the updated worktree list.
 */
export async function createWorktree(
  input: CreateWorktreeInput,
): Promise<WorktreeRecord> {
  const project = getProject(input.projectId);
  if (!project) throw new Error(`Unknown project: ${input.projectId}`);
  const main = await resolveMainRepo(project);
  if (!main) throw new Error(await noMainRepoMessage(project));

  throwIfAborted(input.signal);
  const mainRepoKey = await repoLockKey(main.root);
  // Reuse the background fetch's gate, cadence, coalescing and honest freshness
  // stamp. It is deliberately fire-and-forget before the repository lock; the
  // fork point below remains the local base whatever the fetch later finds.
  fetchRepoIfDue(mainRepoKey, main.root);

  const root = worktreeRootFor(project);
  mkdirSync(root, { recursive: true });
  throwIfAborted(input.signal);

  // Everything that pins the fork point runs under ONE lock acquisition:
  // suffix selection (two concurrent creates cannot pick the same free name)
  // AND the base branch/head snapshot (a commit landing between snapshot and
  // `worktree add` would make the stored baseCommit lie, polluting "vs base"
  // diffs with already-base changes).
  // Set immediately before the add so its catch can remove a checkout Git may
  // have created only partially when an abort kills it. That catch cleans up
  // while `withRepoLock` still holds the creation lock; post-lock failures use
  // the outer catch, which acquires that same repo lock for cleanup.
  let untracked: { branch: string; path: string } | undefined;
  const claim: CreationClaim = {
    take: (branch, path) => {
      untracked = { branch, path };
    },
    release: () => {
      untracked = undefined;
    },
  };
  try {
    const source = input.source ?? NEW_BRANCH_SOURCE;
    // Both variants add the checkout under THIS one acquisition and claim their
    // branch and folder before doing it, so the catch paths below own the same
    // names whichever one ran.
    const { branch, path, baseBranch, baseCommit } = await withRepoLock(
      mainRepoKey,
      () =>
        source.kind === "track-remote"
          ? addTrackingCheckout(main, root, input, source, claim)
          : addNewBranchCheckout(main, root, input, claim),
    );

    const now = Date.now();
    const row: WorktreeRow = {
      id: randomUUID(),
      projectId: project.id,
      mainRepoRoot: main.root,
      path,
      branch,
      baseBranch,
      baseCommit,
      status: "active",
      mergeStateJson: null,
      branchCleanupOid: null,
      createdAt: now,
      updatedAt: now,
      removedAt: null,
    };

    // The checkout exists on disk but NOTHING tracks it until `insertWorktree`
    // returns, so every throw in this window is undone: an orphaned add is absent
    // from the worktree list, is never cleaned up, and holds the branch and
    // folder name — the next attempt would silently land on a `-2` suffix, which
    // is exactly what the one-click retry of a failed first-send would do.
    //
    // Narrow but real. The git side cannot throw: `gitOptional` absorbs it (see
    // {@link initSubmodules}) and logs a non-zero result. What is left is the
    // caller's `onSubmodules` progress callback and `insertWorktree` — sqlite.
    // Suffix selection includes retained rows as well as live Git/filesystem
    // occupancy, so ordinary recreation after a soft removal cannot reach the
    // path UNIQUE constraint here.
    // Deliberately OUTSIDE the repo lock: a submodule clone can take minutes
    // over the network, and it writes only worktree-private state
    // (`.git/worktrees/<wt>/modules/<name>`), so it races with nothing.
    await initSubmodules(path, input.onSubmodules, input.signal);
    throwIfAborted(input.signal);
    insertWorktree(row);
    // The row is now durable, so later edge/watcher failures must not delete a
    // registered checkout.
    claim.release();

    if (input.taskId) linkTaskToWorktree(input.taskId, row.id);
    if (input.sessionId) linkSessionToWorktree(input.sessionId, row.id);
    await registerWorktree(row).catch(() => undefined);

    // Fire-and-forget: computing the list probes every project's main repo, which
    // must not sit in the critical path of a create/remove.
    void broadcastWorktreeList().catch(() => undefined);
    return toRecord(row);
  } catch (err) {
    if (untracked)
      await discardUntrackedWorktree(
        main.root,
        untracked.path,
        untracked.branch,
      );
    throw err;
  }
}

/**
 * Ownership of the branch and folder a `git worktree add` is about to take,
 * held from just before the add until the row is durable. Both cleanup paths
 * read it, so the two creation variants hand it the same two names.
 */
interface CreationClaim {
  take(branch: string, path: string): void;
  release(): void;
}

/** What the locked section settled: the row's branch, path and merge-back base. */
interface PreparedCheckout {
  branch: string;
  path: string;
  baseBranch: string;
  baseCommit: string;
}

/** The main checkout's current branch, or "" when it is detached. */
async function currentMainBranch(
  main: MainRepoInfo,
  signal?: AbortSignal,
): Promise<string> {
  const res = await git(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    main.root,
    signal,
  );
  const branch = res.stdout.trim();
  return branch === "HEAD" ? "" : branch;
}

async function localBranchExists(
  main: MainRepoInfo,
  branch: string,
  signal?: AbortSignal,
): Promise<boolean> {
  return (
    (
      await gitOptionalExit(
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        main.root,
        signal,
      )
    ).code === 0
  );
}

async function commitOf(
  main: MainRepoInfo,
  ref: string,
  signal?: AbortSignal,
): Promise<string> {
  return (
    await git(["rev-parse", "--verify", `${ref}^{commit}`], main.root, signal)
  ).stdout.trim();
}

/**
 * Today's creation, unchanged: branch `<name>` minted at the local base branch,
 * with the base verified and snapshotted under the caller's lock.
 */
async function addNewBranchCheckout(
  main: MainRepoInfo,
  root: string,
  input: CreateWorktreeInput,
  claim: CreationClaim,
): Promise<PreparedCheckout> {
  throwIfAborted(input.signal);
  const currentBranch = await currentMainBranch(main, input.signal);
  // A detached main checkout matters only for the default: an explicit
  // local base still has an unambiguous merge-back target and fork point.
  if (!input.baseBranch && !currentBranch)
    throw new Error(
      "The main checkout is on a detached HEAD; check out a branch first or name a local base branch.",
    );
  const baseBranch = input.baseBranch ?? currentBranch;
  if (!(await localBranchExists(main, baseBranch, input.signal)))
    throw new Error(
      `Base branch "${baseBranch}" must be a local branch (refs/heads/<name>); remote-tracking refs, tags and commit SHAs cannot be merge-back targets.`,
    );
  const baseCommit = await commitOf(
    main,
    `refs/heads/${baseBranch}`,
    input.signal,
  );
  const chosen = await findAvailableSuffix(
    main,
    root,
    basename(main.root),
    input.name,
    input.signal,
  );
  const target = join(root, `${basename(main.root)}-${chosen}`);
  claim.take(chosen, target);
  await addCheckout(
    main,
    ["worktree", "add", "-b", chosen, target, baseBranch],
    target,
    chosen,
    claim,
    input.signal,
  );
  return { branch: chosen, path: target, baseBranch, baseCommit };
}

/**
 * Check out a remote's EXISTING branch, tracking it.
 *
 * Two things differ from the variant above and both are deliberate. The branch
 * name is the remote's, not `name`, because a review checkout that tracks
 * `<remote>/<head>` is the only shape in which "bring it to the pull request's
 * current head" is an ordinary pull — and it is what every local join on
 * `row.branch === headBranch` already looks for. And the recorded base is a
 * LOCAL branch or nothing: `worktreeMerge.ts` refuses a merge-back unless the
 * main checkout is on that exact branch, so recording `origin/main` there would
 * produce a checkout that looks ordinary and can never merge back.
 *
 * The fetch that puts `<remote>/<headBranch>` in reach is the CALLER's, and
 * runs outside this lock. What this checks out is the caller's `headCommit`,
 * NOT that remote-tracking ref: the ref moves with every fetch — including the
 * background one `createWorktree` fires before taking this lock — so branching
 * off it would check out a commit nobody verified, under a name that says it is
 * the verified one. The upstream is configured as a second step, which is what
 * the ref is still good for.
 */
async function addTrackingCheckout(
  main: MainRepoInfo,
  root: string,
  input: CreateWorktreeInput,
  source: Extract<CreateWorktreeSource, { kind: "track-remote" }>,
  claim: CreationClaim,
): Promise<PreparedCheckout> {
  throwIfAborted(input.signal);
  const remoteRef = `refs/remotes/${source.remote}/${source.headBranch}`;
  if (
    (
      await gitOptionalExit(
        ["show-ref", "--verify", "--quiet", remoteRef],
        main.root,
        input.signal,
      )
    ).code !== 0
  )
    throw new WorktreeCreateRefusalError(
      `${source.remote}/${source.headBranch} is not in this repository, so there is nothing to track.`,
      "head-unreachable",
    );
  // The pinned commit, re-verified under the lock: a prune or a garbage
  // collection between the caller's fetch and this add can leave the oid
  // unreachable, and checking out something else would be the whole failure
  // this pinning exists to prevent.
  if (
    (
      await gitOptionalExit(
        ["rev-parse", "--verify", "--quiet", `${source.headCommit}^{commit}`],
        main.root,
        input.signal,
      )
    ).code !== 0
  )
    throw new WorktreeCreateRefusalError(
      `The pull request's head ${source.headCommit.slice(0, 12)} is no longer in this repository; nothing was checked out.`,
      "head-unreachable",
    );
  // Adopting an existing local branch would mean deciding what to do with
  // whatever is on it — reset it, merge it, rebase it. This path decides none
  // of those; it says so instead.
  if (await localBranchExists(main, source.headBranch, input.signal))
    throw new WorktreeCreateRefusalError(
      `A local branch "${source.headBranch}" already exists here and no managed worktree stands on it. Remove or check it out yourself; this never moves a branch it did not create.`,
      "branch-exists",
    );

  const preferred = source.preferredBaseBranch?.trim();
  const baseBranch =
    preferred && (await localBranchExists(main, preferred, input.signal))
      ? preferred
      : await currentMainBranch(main, input.signal);
  if (!baseBranch)
    throw new WorktreeCreateRefusalError(
      preferred
        ? `Neither "${preferred}" nor a current branch of the main checkout can be the merge-back target: "${preferred}" does not exist locally and the main checkout is on a detached HEAD.`
        : "The main checkout is on a detached HEAD, so there is no local branch to record as the merge-back target.",
      "base-unresolvable",
    );
  const baseCommit = await commitOf(
    main,
    `refs/heads/${baseBranch}`,
    input.signal,
  );

  // Folder only: the branch is already decided, so the collision search here
  // asks about the directory alone, and exhaustion falls back to a timestamp
  // rather than failing a creation over a name.
  const folder = await findAvailableFolderSuffix(
    root,
    basename(main.root),
    input.name,
  );
  const target = join(root, `${basename(main.root)}-${folder}`);
  claim.take(source.headBranch, target);
  await addCheckout(
    main,
    ["worktree", "add", "-b", source.headBranch, target, source.headCommit],
    target,
    source.headBranch,
    claim,
    input.signal,
  );
  // Tracking is set AFTER the add, because the start point is the pinned commit
  // rather than the ref. A throw here leaves the claim standing, so the outer
  // catch discards the checkout and its branch — an untracked branch would look
  // like an ordinary worktree and could never be updated from the pull request.
  await git(
    [
      "branch",
      `--set-upstream-to=${source.remote}/${source.headBranch}`,
      source.headBranch,
    ],
    main.root,
    input.signal,
  );
  return { branch: source.headBranch, path: target, baseBranch, baseCommit };
}

/**
 * The `git worktree add` itself, with the one cleanup both variants need: keep
 * this name's ownership under the creation lock THROUGH cleanup, because an
 * aborted add can remove its own ref and path, and a queued creator would
 * otherwise claim them before the outer catch reacquires the lock.
 */
async function addCheckout(
  main: MainRepoInfo,
  args: string[],
  target: string,
  branch: string,
  claim: CreationClaim,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await git(args, main.root, signal);
  } catch (err) {
    await discardUntrackedWorktreeLocked(main.root, target, branch);
    claim.release();
    throw err;
  }
}

/**
 * Check out the submodules of a freshly added worktree. `git worktree add`
 * records the gitlinks but leaves the submodule directories EMPTY, so a build
 * in the new worktree would miss submodule sources. A linked worktree gets its
 * OWN submodule gitdir (`.git/worktrees/<wt>/modules/<name>`), so this is a
 * fresh clone even when the main checkout already has the submodule — it uses
 * {@link REMOTE_ENV} so a submodule needing credentials fails fast instead of
 * hanging on an interactive prompt with no tty.
 *
 * Never fatal: the worktree itself is already usable, so a failed checkout is
 * logged for `journalctl` and the user can re-run the submodule update there.
 * `gitOptional` absorbs the git side COMPLETELY — a non-zero exit and an
 * execution failure (no git binary, vanished cwd) both come back as non-zero
 * results, so either one is logged and the worktree remains usable. An aborted
 * signal is different: it is rethrown so the caller can clean up and cancel.
 */
async function initSubmodules(
  worktreePath: string,
  onStart?: () => void,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (!existsSync(join(worktreePath, ".gitmodules"))) return;
  onStart?.();
  throwIfAborted(signal);
  const res = await gitOptional(
    ["submodule", "update", "--init", "--recursive"],
    worktreePath,
    signal,
    REMOTE_ENV,
  );
  throwIfAborted(signal);
  if (res.code !== 0) {
    console.error(
      `[worktrees] submodule init failed in ${worktreePath}: ${res.stderr.trim() || `exit ${res.code}`}`,
    );
  }
}

/**
 * Undo a `git worktree add` whose creation then failed, freeing the checkout,
 * the registration and the branch name for the next attempt. The branch is
 * force-deleted: it was created moments ago at the base head and no row, and
 * therefore no session, ever pointed at it.
 *
 * Best effort by design — it runs on an error path, so nothing here throws; the
 * caller rethrows the ORIGINAL cause, which is the one the user needs to see.
 * But "best effort" must not mean silent: a cleanup that fails leaves behind
 * precisely the orphan this exists to prevent, and the failures cascade (with
 * the checkout still registered, git refuses to delete its branch), so EVERY
 * step reports its own non-zero exit.
 */
const ORPHAN_DIRECTORY_REMOVAL_RETRIES = 10;
const ORPHAN_DIRECTORY_REMOVAL_RETRY_DELAY_MS = 200;
const ORPHAN_DIRECTORY_SETTLE_ATTEMPTS = 5;
const ORPHAN_DIRECTORY_SETTLE_DELAY_MS = 250;

async function removeOrphanDirectory(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < ORPHAN_DIRECTORY_SETTLE_ATTEMPTS; attempt++) {
    try {
      rmSync(path, {
        recursive: true,
        force: true,
        maxRetries: ORPHAN_DIRECTORY_REMOVAL_RETRIES,
        retryDelay: ORPHAN_DIRECTORY_REMOVAL_RETRY_DELAY_MS,
      });
    } catch (err) {
      console.error(
        `[worktrees] discarding the incomplete worktree ${path}: directory removal failed: ${errorText(err)}`,
      );
      // A checkout with read-only directories in it (submodule artifacts, a
      // tool's output) is unlinkable until owner access is back. Repairing
      // costs one walk and turns the next attempt into a success instead of
      // leaving the generated name occupied.
      restoreOwnerAccess(path);
    }
    // An aborted `git worktree add` can leave its checkout child briefly alive.
    // A successful first rm can therefore be followed by the child recreating
    // the folder; settle before declaring the generated name available again.
    await new Promise<void>((resolve) =>
      setTimeout(resolve, ORPHAN_DIRECTORY_SETTLE_DELAY_MS),
    );
    if (!existsSync(path)) return true;
  }
  console.error(
    `[worktrees] discarding the incomplete worktree ${path}: directory remained after bounded cleanup.`,
  );
  return false;
}

async function discardUntrackedWorktreeLocked(
  mainRepoRoot: string,
  path: string,
  branch: string,
): Promise<void> {
  const report = (step: string, res: GitResult): void => {
    if (res.code === 0) return;
    console.error(
      `[worktrees] discarding the incomplete worktree ${path}: ${step} failed: ${res.stderr.trim() || `exit ${res.code}`}`,
    );
  };
  // Same shape as removeWorktree: prune is repo-global, so only run it after
  // the generated path has stayed absent through the settle window.
  if (existsSync(path)) {
    report(
      "worktree remove",
      await gitOptional(["worktree", "remove", "--force", path], mainRepoRoot),
    );
  }
  if (await removeOrphanDirectory(path))
    report(
      "worktree prune",
      await gitOptional(["worktree", "prune"], mainRepoRoot),
    );
  report(
    "branch delete",
    await gitOptional(["branch", "-D", branch], mainRepoRoot),
  );
}

async function discardUntrackedWorktree(
  mainRepoRoot: string,
  path: string,
  branch: string,
): Promise<void> {
  try {
    await withRepoLock(await repoLockKey(mainRepoRoot), () =>
      discardUntrackedWorktreeLocked(mainRepoRoot, path, branch),
    );
  } catch (err) {
    console.error(
      `[worktrees] failed to discard the incomplete worktree ${path}: ${errorText(err)}`,
    );
  }
}

/** Find a branch- and folder-collision-free variant of the requested suffix. */
async function findAvailableSuffix(
  main: MainRepoInfo,
  root: string,
  folderPrefix: string,
  requested: string,
  signal?: AbortSignal,
): Promise<string> {
  const registeredPaths = new Set(
    listWorktrees({ includeRemoved: true }).map((worktree) => worktree.path),
  );
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = attempt === 0 ? requested : `${requested}-${attempt + 1}`;
    // Naming must never block creation: execution failures count as an
    // unoccupied name here, and the authoritative `worktree add` reports the
    // failure instead of turning it into a misleading naming-exhausted error.
    const branchTaken =
      (
        await gitOptional(
          ["rev-parse", "--verify", `refs/heads/${candidate}`],
          main.root,
          signal,
        )
      ).code === 0;
    const candidatePath = join(root, `${folderPrefix}-${candidate}`);
    // Removed worktrees keep their row so Task/session history can still resolve
    // the old checkout. Their folders and branches may both be gone, but the
    // schema deliberately keeps `path` unique across that history — treating
    // only Git and the filesystem as occupancy would recreate the old path and
    // fail at insert after doing all the expensive provisioning work.
    const folderTaken =
      existsSync(candidatePath) || registeredPaths.has(candidatePath);
    if (!branchTaken && !folderTaken) return candidate;
  }
  throw new Error(`Could not find a free worktree name for "${requested}".`);
}

/**
 * A FOLDER-collision-free variant of the requested suffix, for a creation whose
 * branch name is already decided (`track-remote`).
 *
 * Exhaustion falls back to a timestamp instead of throwing: naming must never
 * block creation, and unlike the branch-and-folder search above there is no
 * name here a user ever sees or types — only a directory this process picks.
 */
async function findAvailableFolderSuffix(
  root: string,
  folderPrefix: string,
  requested: string,
): Promise<string> {
  const registeredPaths = new Set(
    listWorktrees({ includeRemoved: true }).map((worktree) => worktree.path),
  );
  const free = (candidate: string): boolean => {
    const path = join(root, `${folderPrefix}-${candidate}`);
    // Removed worktrees keep their row (and its unique `path`), so Git and the
    // filesystem alone are not occupancy — see {@link findAvailableSuffix}.
    return !existsSync(path) && !registeredPaths.has(path);
  };
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = attempt === 0 ? requested : `${requested}-${attempt + 1}`;
    if (free(candidate)) return candidate;
  }
  const stamped = `${requested}-${Date.now().toString(36)}`;
  return free(stamped) ? stamped : `${requested}-${randomUUID().slice(0, 8)}`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw (
      signal.reason ??
      new DOMException("The operation was aborted.", "AbortError")
    );
}

export interface RemoveWorktreeOptions {
  deleteBranch?: boolean;
  force?: boolean;
  /** Exact refreshed base commit to use for containment without moving its local branch. */
  branchContainmentBase?: string;
  /**
   * Stop the tracked background work of the sessions that ran here. Runs after
   * every refusal and before the checkout is deleted, so nothing is stopped
   * for a removal that is then refused.
   */
  stopTrackedWork?: () => Promise<void>;
}

/** A pre-mutation guard refused removal without changing the repository. */
export class WorktreeRemovalBlockedError extends Error {
  // Widened to `string` so subclasses can name themselves; the literal type
  // would make `WorktreeUndeletableError`'s own name unassignable.
  override readonly name: string = "WorktreeRemovalBlockedError";
}

/**
 * The checkout holds a directory owned by another uid, so no removal this
 * process can perform will ever delete it.
 *
 * A SUBCLASS on purpose: every existing `instanceof WorktreeRemovalBlockedError`
 * site keeps refusing safely without knowing about this case, and only the
 * seams that choose a refusal kind have to tell the two apart. Unlike every
 * other pre-mutation guard, `force` does NOT skip it — forcing past a tree that
 * cannot be deleted is exactly how Git ends up unregistering a worktree whose
 * directory survives.
 */
export class WorktreeUndeletableError extends WorktreeRemovalBlockedError {
  override readonly name = "WorktreeUndeletableError";

  constructor(
    message: string,
    /** The directory that blocks it, and the uid that owns it. */
    readonly residuePath: string,
    readonly residueUid: number,
  ) {
    super(message);
  }
}

/**
 * Git unregistered the checkout but its directory is still on disk.
 *
 * `git worktree remove` is NOT atomic: it deletes its administrative directory
 * even when the working tree removal failed, so the record has to follow Git or
 * the two disagree forever (the row stays active, and every retry answers "is
 * not a working tree"). Removal is therefore already DURABLE when this is
 * thrown — sessions settle, comments are purged, clients are told — and what is
 * left is one directory for the user to delete.
 */
export class WorktreeDirectoryResidueError extends Error {
  override readonly name = "WorktreeDirectoryResidueError";

  constructor(
    message: string,
    readonly worktreeId: string,
    readonly path: string,
  ) {
    super(message);
  }
}

/** Checkout removal succeeded, but its identity-bound branch cleanup did not. */
export class WorktreeBranchCleanupError extends Error {
  override readonly name = "WorktreeBranchCleanupError";

  constructor(
    message: string,
    readonly worktreeId: string,
    readonly branch: string,
    readonly expectedOid: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * Populated submodule checkouts under `root`, recursively, as absolute paths.
 * Refuses removal outright when a SUBMODULE's index cannot be read: its
 * interior would go unchecked below. An unreadable root index is different —
 * answering "no submodules" there derives no force, which hands the decision
 * back to Git's own refusal.
 */
async function populatedSubmodules(root: string): Promise<string[]> {
  const found: string[] = [];
  const pending = [root];
  while (pending.length) {
    const dir = pending.shift()!;
    // `-z` so a path Git would otherwise quote still resolves on disk.
    const staged = await gitOptionalExit(["ls-files", "--stage", "-z"], dir);
    if (staged.code !== 0) {
      if (dir === root) continue;
      throw new WorktreeRemovalBlockedError(unverifiableMessage(root, dir));
    }
    for (const entry of staged.stdout.split("\0")) {
      if (!entry.startsWith("160000 ")) continue;
      const path = join(dir, entry.slice(entry.indexOf("\t") + 1));
      // Git counts a gitlink only when its directory is a real checkout, and a
      // nested submodule lives inside one, so this both filters and recurses.
      if (!existsSync(join(path, ".git"))) continue;
      found.push(path);
      pending.push(path);
    }
  }
  return found;
}

/**
 * Whether Git would refuse `worktree remove` for this checkout with "working
 * trees containing submodules cannot be moved or removed". Only `--force` skips
 * that refusal, and creation checks submodules out ({@link initSubmodules}), so
 * without this every worktree of a superproject would be unremovable. The two
 * conditions mirror Git's own `validate_no_submodules`: the worktree's private
 * `modules` gitdir, or a populated gitlink in its index.
 */
async function hasSubmoduleCheckout(worktreePath: string): Promise<boolean> {
  const gitDir = await gitOptionalExit(
    ["rev-parse", "--absolute-git-dir"],
    worktreePath,
  );
  if (gitDir.code === 0) {
    const modules = statSync(join(gitDir.stdout.trim(), "modules"), {
      throwIfNoEntry: false,
    });
    if (modules?.isDirectory()) return true;
  }
  // Submodules cloned outside our creation path keep their gitdir in the
  // checkout, so the index is the only remaining evidence.
  return (await populatedSubmodules(worktreePath)).length > 0;
}

function unverifiableMessage(root: string, submodule: string): string {
  return `Submodule ${relative(root, submodule)} could not be checked for unpushed work. Force-remove to delete it anyway.`;
}

/**
 * The first submodule under the worktree holding commits or stash entries that
 * neither a remote nor a tag has, relative to `worktreePath`; `null` when there
 * is none. A submodule that cannot be probed refuses removal rather than
 * passing.
 *
 * Removing the worktree deletes each submodule's gitdir with it, and NOTHING in
 * the superproject's own status reveals that content: a branch or stash made
 * inside a submodule, or a commit on its detached HEAD later reset back to the
 * gitlink, all leave `git status` clean. So the removal path has to look inside
 * before deriving `--force`, which skips exactly the Git refusal that used to
 * cover this.
 *
 * Both negations earn their place. `--remotes` lets a fresh checkout pass:
 * `git submodule update` CLONES, so the submodule owns local branches at their
 * remote-tracking tips. `--tags` covers the other half of what a clone fetches:
 * an upstream tag on history no branch reaches (rewritten history, a deleted
 * release branch) is local-only by refs alone, and would otherwise make every
 * such superproject permanently unremovable unforced. The residue is a commit
 * whose ONLY local ref is a tag the user made here — far rarer than upstream
 * orphan tags, and never protected before this change either.
 */
async function submoduleWorkAtRisk(
  worktreePath: string,
): Promise<string | null> {
  for (const path of await populatedSubmodules(worktreePath)) {
    const localOnly = await gitOptionalExit(
      ["rev-list", "--count", "-1", "--all", "--not", "--remotes", "--tags"],
      path,
    );
    if (localOnly.code !== 0)
      throw new WorktreeRemovalBlockedError(
        unverifiableMessage(worktreePath, path),
      );
    if (localOnly.stdout.trim() !== "0") return relative(worktreePath, path);
  }
  return null;
}

/**
 * Whether removal must pass `--force` for Git's submodule refusal, refusing
 * instead when that would discard work. The dirty check is REPEATED here
 * because a derived `--force` also skips Git's own at-removal cleanliness
 * check, which was the backstop for the window between the caller's guards and
 * this point under the repo lock. A caller-requested force never lands here: it
 * has already accepted the loss.
 *
 * Every probe fails CLOSED. A guard that cannot answer must not hand back the
 * force that disables it; refusing still leaves force-remove as the way out.
 */
async function deriveSubmoduleForce(worktreePath: string): Promise<boolean> {
  if (!(await hasSubmoduleCheckout(worktreePath))) return false;
  const status = await gitOptionalExit(
    ["status", "--porcelain=v1", "-uall"],
    worktreePath,
  );
  if (status.code !== 0)
    throw new WorktreeRemovalBlockedError(
      "Worktree cleanliness could not be verified. Force-remove to discard whatever is in it.",
    );
  if (status.stdout.trim())
    throw new WorktreeRemovalBlockedError(
      "Worktree has uncommitted changes. Commit them or force-remove to discard.",
    );
  const risky = await submoduleWorkAtRisk(worktreePath);
  if (risky)
    throw new WorktreeRemovalBlockedError(
      `Submodule ${risky} has commits or stashed changes that no remote or tag has. Removing this worktree deletes them, so push them or force-remove to lose them.`,
    );
  return true;
}

/**
 * Where worktrees for this row's project may live: the project override and the
 * global setting. The reclaim container mounts a host directory, so it is given
 * the roots the APP controls rather than being trusted with whatever path a row
 * happens to carry.
 */
function worktreeRootsFor(row: WorktreeRow): string[] {
  const roots = [getSettings().worktrees.root];
  const project = getProject(row.projectId);
  const override = project?.worktreeRoot?.trim();
  if (override) roots.push(override);
  return roots.filter((root) => root.length > 0);
}

/** Ask the runtime that created the residue to hand it back; never throws. */
function reclaimFor(
  row: WorktreeRow,
): (
  path: string,
) => Promise<Awaited<ReturnType<typeof reclaimContainerResidue>>> {
  return (path) =>
    reclaimContainerResidue({ path, allowedRoots: worktreeRootsFor(row) });
}

function residueSentence(residue: TreeResidue, reason?: string): string {
  return `${residue.path} belongs to uid ${residue.uid}, so this server cannot delete it${
    reason ? ` and it could not be reclaimed: ${reason}` : ""
  }.`;
}

/**
 * Refuse a removal whose checkout holds a foreign-owned directory — but only
 * after trying to reclaim it, which is an ordinary cleanup step on a removal the
 * user already asked for.
 *
 * This runs BEFORE any git mutation and is NOT skipped by `force`. Force is
 * consent to lose work; it cannot make another user's files deletable, and
 * forcing on is precisely what leaves Git and the row disagreeing.
 */
async function assertCheckoutDeletable(row: WorktreeRow): Promise<void> {
  const scan = scanTreeResidue(row.path);
  if (!scan.foreign) return;
  const outcome = await reclaimFor(row)(row.path);
  if (outcome.status === "reclaimed" && !scanTreeResidue(row.path).foreign)
    return;
  const reason =
    outcome.status === "reclaimed"
      ? "the tree still holds files owned by another user"
      : outcome.reason;
  throw new WorktreeUndeletableError(
    `${residueSentence(scan.foreign, reason)} Nothing was removed — hand it back with sudo chown -R $(id -u):$(id -g) ${row.path}, or delete it with sudo rm -rf ${row.path}, then remove the worktree again.`,
    scan.foreign.path,
    scan.foreign.uid,
  );
}

/** Whether Git still registers `path` as a worktree of this repository. */
async function isRegisteredWorktree(
  mainRepoRoot: string,
  path: string,
): Promise<boolean> {
  const res = await gitOptionalExit(
    ["worktree", "list", "--porcelain"],
    mainRepoRoot,
  );
  if (res.code !== 0)
    throw new Error(
      `git could not list the worktrees of ${mainRepoRoot}: ${res.stderr.trim() || `exit ${res.code}`}`,
    );
  return res.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .some((listed) => listed === path || sameRealPath(listed, path));
}

function sameRealPath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * Prove Git has let the checkout go before the record follows it.
 *
 * `git worktree prune` exits 0 without pruning a LOCKED worktree, so its
 * success is not evidence (verified on git 2.54: lock, delete the folder,
 * prune, and `worktree list` still reports it). Finalizing the row on that
 * would recreate exactly the disagreement this work exists to end — and with
 * the ref still checked out as far as Git is concerned, the branch cleanup
 * could never succeed either. Nothing has been finalized at this point, so a
 * refusal here leaves the record untouched.
 *
 * Called where a prune is the ONLY evidence. The branch that catches a failed
 * `git worktree remove` already probed registration to get there, and pruning
 * cannot re-register a worktree, so it needs no second probe.
 */
async function assertGitUnregistered(row: WorktreeRow): Promise<void> {
  if (!(await isRegisteredWorktree(row.mainRepoRoot, row.path))) return;
  throw new WorktreeRemovalBlockedError(
    `Git still registers ${row.path} as a worktree after pruning it, which usually means it is locked. Run git worktree unlock ${row.path} in ${row.mainRepoRoot} (or git worktree remove --force it) and try again. Nothing was removed.`,
  );
}

/**
 * Delete a checkout directory Git has already stopped registering, repairing
 * what can be repaired. Returns what is still in the way, if anything.
 */
async function removeUnregisteredCheckout(
  row: WorktreeRow,
): Promise<string | undefined> {
  const result = await removeManagedTree(row.path, {
    reclaim: reclaimFor(row),
  });
  if (result.removed) return undefined;
  const sentence = result.residue
    ? residueSentence(result.residue, result.reclaimReason)
    : `${row.path} could not be deleted.`;
  console.warn(
    `[worktrees] ${row.path} survived removal of worktree ${row.id}: ${sentence}`,
  );
  return sentence;
}

/**
 * Remove a worktree. Refused (unless `force`) while the working tree is dirty
 * or the branch has commits not contained in the base branch — both would lose
 * work. Optionally deletes the branch afterwards.
 */
export async function removeWorktree(
  id: string,
  opts: RemoveWorktreeOptions = {},
): Promise<void> {
  if (isMainWorktreeId(id))
    throw new Error("The main checkout cannot be removed.");
  const row = getWorktree(id);
  if (!row) throw new Error("Unknown worktree.");
  const retryBranchOnly = row.status === "removed";
  if (retryBranchOnly && (!opts.deleteBranch || !row.branchCleanupOid))
    throw new Error("Unknown worktree.");

  if (!retryBranchOnly && !opts.force && row.mergeStateJson) {
    const phase = (JSON.parse(row.mergeStateJson) as { phase?: string }).phase;
    if (
      phase === "merging" ||
      phase === "conflicts" ||
      phase === "agent_resolving"
    ) {
      throw new WorktreeRemovalBlockedError(
        "A merge is in progress for this worktree. Finish or abort it first.",
      );
    }
  }

  if (!retryBranchOnly && !opts.force && existsSync(row.path)) {
    const status = await gitOptionalExit(
      ["status", "--porcelain=v1", "-uall"],
      row.path,
    );
    if (status.stdout.trim()) {
      throw new WorktreeRemovalBlockedError(
        "Worktree has uncommitted changes. Commit them or force-remove to discard.",
      );
    }
  }
  // Containment guards the BRANCH DELETION, not the checkout: commits live on
  // the branch ref, so removing the folder while keeping the branch loses none
  // of them and has nothing to consent to. Refusing it anyway made an
  // undelivered worktree unremovable without discarding the very work the user
  // asked to keep.
  if (!retryBranchOnly && !opts.force && opts.deleteBranch) {
    const unmerged = await hasUnmergedCommits(row, opts.branchContainmentBase);
    if (unmerged) {
      throw new WorktreeRemovalBlockedError(
        `Branch ${row.branch} has commits not merged into ${row.baseBranch}. Merge first, keep the branch, or force-remove to lose them.`,
      );
    }
  }

  // Deletability is checked for EVERY removal, forced or not: `force` consents
  // to losing work, and no consent makes another user's files deletable. A
  // reclaim is attempted first, so the common case never reaches the user.
  if (!retryBranchOnly && existsSync(row.path))
    await assertCheckoutDeletable(row);

  /**
   * Whatever still runs in the checkout goes before Git deletes it, or a dev
   * server rewrites its cache into the deleted folder. Called under the repo
   * lock after every refusal of our own; what can still refuse afterwards is
   * Git's own check of a tree that changed in the meantime.
   */
  const releaseCheckout = async (): Promise<void> => {
    await opts.stopTrackedWork?.().catch((err: unknown) => {
      console.warn(
        `[worktrees] stopping background work before removing ${row.path} failed: ${errorText(err)}`,
      );
    });
    const stopped = await stopCheckoutProcesses(row.path);
    if (stopped.terminated.length > 0)
      console.info(
        `[worktrees] stopped ${stopped.terminated.length} process(es) still running in ${row.path}${
          stopped.killed.length > 0
            ? ` (${stopped.killed.length} needed SIGKILL)`
            : ""
        }.`,
      );
  };

  let finalized = false;
  /** What is still on disk once Git has stopped registering the checkout. */
  let residue: string | undefined;
  try {
    await withRepoLock(await repoLockKey(row.mainRepoRoot), async () => {
      // A queued retry must re-read its durable claim only after acquiring the
      // repo lock. A second waiter cannot act on an oid the first already cleared.
      let branchCleanupOid = retryBranchOnly
        ? (getWorktree(id)?.branchCleanupOid ?? null)
        : null;
      let branchAlreadyAbsent = false;
      if (retryBranchOnly && !branchCleanupOid)
        throw new Error("Unknown worktree.");
      if (!retryBranchOnly && opts.deleteBranch) {
        const branch = await probeLocalBranch(row);
        branchCleanupOid = branch.kind === "present" ? branch.oid : null;
        branchAlreadyAbsent = branch.kind === "absent";
      }
      if (!retryBranchOnly) {
        // Historical malformed reply chains must be caught before Git removes
        // the checkout; normal inserts cannot create a cross-scope parent.
        assertWorktreeCommentsDeletable(id);
        if (!existsSync(row.path)) {
          // Folder already gone (deleted externally): Git cleanup must still
          // succeed before comment lifetime can end.
          await git(["worktree", "prune"], row.mainRepoRoot);
          await assertGitUnregistered(row);
        } else if (await isRegisteredWorktree(row.mainRepoRoot, row.path)) {
          const force = opts.force || (await deriveSubmoduleForce(row.path));
          await releaseCheckout();
          const args = [
            "worktree",
            "remove",
            ...(force ? ["--force"] : []),
            row.path,
          ];
          try {
            await git(args, row.mainRepoRoot);
          } catch (err) {
            // `git worktree remove` is NOT atomic: it deletes its
            // administrative directory even when removing the working tree
            // failed. Which half happened decides everything, so ask rather
            // than assume — still registered means nothing durable happened and
            // the caller's guarantee ("nothing was removed") still holds.
            if (await isRegisteredWorktree(row.mainRepoRoot, row.path))
              throw err;
            console.warn(
              `[worktrees] git unregistered ${row.path} but could not delete it: ${errorText(err)}`,
            );
            residue = await removeUnregisteredCheckout(row);
            await git(["worktree", "prune"], row.mainRepoRoot);
          }
        } else {
          // On disk but unregistered: an earlier partial removal already took
          // Git's half. Finish the directory and let the record follow, which is
          // what unsticks a row whose every retry answered "not a working tree".
          await git(["worktree", "prune"], row.mainRepoRoot);
          await releaseCheckout();
          residue = await removeUnregisteredCheckout(row);
          if (!residue) await assertGitUnregistered(row);
        }
        const deletedThreadIds = listWorktreeCommentRows(id)
          .filter((comment) => !comment.parentId)
          .map((comment) => comment.id);
        const deletedReviewSetIds = listReviewSets(id).map((set) => set.id);
        const deletedComments = finalizeWorktreeRemoval(id, branchCleanupOid);
        finalized = true;
        console.info(
          `[worktrees] deleted ${deletedComments} review comment(s) for removed worktree ${id}.`,
        );
        await broadcastComments(id, deletedThreadIds, deletedReviewSetIds);
        if (opts.deleteBranch && branchAlreadyAbsent)
          purgeMainCommentsForBranchSubject(row, "branch-deleted");
      }
      if (opts.deleteBranch && branchCleanupOid) {
        try {
          await deletePendingWorktreeBranch(
            row,
            branchCleanupOid,
            opts.force,
            opts.branchContainmentBase,
          );
        } catch (err) {
          // Both facts have to survive. The branch error owns the throw — it
          // carries the oid-bound retry — so the directory that is still on
          // disk rides along in its message; losing it would leave the user
          // with a folder nobody ever mentioned, and a successful retry would
          // erase the only chance to say so.
          if (residue && err instanceof WorktreeBranchCleanupError)
            throw new WorktreeBranchCleanupError(
              `${err.message} The checkout directory is also still on disk: ${residue} Delete it with sudo rm -rf ${row.path}.`,
              err.worktreeId,
              err.branch,
              err.expectedOid,
              err.retryable,
              { cause: err },
            );
          throw err;
        }
      }
    });
  } finally {
    if (finalized) {
      await unregisterWorktree(id).catch(() => undefined);
      // Fire-and-forget: computing the list probes every project's main repo,
      // which must not sit in the critical path of a create/remove.
      void broadcastWorktreeList().catch(() => undefined);
    }
  }
  // Reached only when the record IS gone: Git no longer registers the checkout
  // and the row is a tombstone, so the two agree. What is left is a directory
  // the user has to delete, and saying so is the last thing this owes them.
  if (residue)
    throw new WorktreeDirectoryResidueError(
      `Removed the ${row.branch} worktree, but its directory is still on disk: ${residue} Delete it with sudo rm -rf ${row.path}.`,
      id,
      row.path,
    );
}

type LocalBranchProbe = { kind: "absent" } | { kind: "present"; oid: string };

async function probeLocalBranch(row: WorktreeRow): Promise<LocalBranchProbe> {
  const ref = `refs/heads/${row.branch}`;
  // `--verify --quiet` rather than `--exists`: exit 1 means "no such ref" and
  // anything else means the probe itself failed, which is the distinction this
  // guard needs, and unlike `--exists` (git 2.43+) it works on the git shipped
  // by the CI container.
  const exists = await gitOptionalExit(
    ["show-ref", "--verify", "--quiet", ref],
    row.mainRepoRoot,
  );
  if (exists.code === 1) return { kind: "absent" };
  if (exists.code !== 0)
    throw new Error(
      `git could not determine whether ${ref} exists: ${exists.stderr.trim() || `exit ${exists.code}`}`,
    );
  const resolved = await git(
    ["rev-parse", "--verify", `${ref}^{commit}`],
    row.mainRepoRoot,
  );
  const oid = resolved.stdout.trim();
  if (!oid) throw new Error(`git returned no oid for ${ref}.`);
  return { kind: "present", oid };
}

async function deletePendingWorktreeBranch(
  row: WorktreeRow,
  expectedOid: string,
  force = false,
  containmentBase = row.baseBranch,
): Promise<void> {
  let branch: LocalBranchProbe;
  try {
    branch = await probeLocalBranch(row);
  } catch (cause) {
    throw new WorktreeBranchCleanupError(
      `Worktree was removed, but branch ${row.branch} could not be inspected: ${errorText(cause)}`,
      row.id,
      row.branch,
      expectedOid,
      true,
      { cause },
    );
  }
  if (branch.kind === "absent") {
    purgeMainCommentsForBranchSubject(row, "branch-deleted");
    clearPendingBranchClaim(row, expectedOid);
    return;
  }
  if (branch.oid !== expectedOid) {
    clearPendingBranchClaim(row, expectedOid);
    throw new WorktreeBranchCleanupError(
      `Branch ${row.branch} changed after worktree removal; the newer branch was not deleted.`,
      row.id,
      row.branch,
      expectedOid,
      false,
    );
  }
  let worktreeList: string;
  try {
    worktreeList = (
      await git(["worktree", "list", "--porcelain"], row.mainRepoRoot)
    ).stdout;
  } catch (cause) {
    throw new WorktreeBranchCleanupError(
      `Worktree was removed, but branch ${row.branch} checkout state could not be inspected: ${errorText(cause)}`,
      row.id,
      row.branch,
      expectedOid,
      true,
      { cause },
    );
  }
  if (
    worktreeList
      .split("\n")
      .some((line) => line === `branch refs/heads/${row.branch}`)
  ) {
    throw new WorktreeBranchCleanupError(
      `Worktree was removed, but branch ${row.branch} is checked out in another worktree and was not deleted.`,
      row.id,
      row.branch,
      expectedOid,
      true,
    );
  }
  if (!force) {
    let contained: boolean;
    try {
      contained = await branchContainedInBase(
        row.mainRepoRoot,
        expectedOid,
        containmentBase,
      );
    } catch (cause) {
      throw new WorktreeBranchCleanupError(
        `Worktree was removed, but branch ${row.branch} containment could not be inspected: ${errorText(cause)}`,
        row.id,
        row.branch,
        expectedOid,
        true,
        { cause },
      );
    }
    if (!contained) {
      throw new WorktreeBranchCleanupError(
        `Worktree was removed, but branch ${row.branch} could not be deleted because it is not contained in ${row.baseBranch}. Retry with force only to discard it.`,
        row.id,
        row.branch,
        expectedOid,
        true,
      );
    }
  }
  try {
    // The expected old oid makes deletion atomic with the identity check: even
    // an external ref rewrite in this narrow window cannot delete its replacement.
    await git(
      ["update-ref", "-d", `refs/heads/${row.branch}`, expectedOid],
      row.mainRepoRoot,
    );
  } catch (cause) {
    throw new WorktreeBranchCleanupError(
      `Worktree was removed, but branch ${row.branch} could not be deleted: ${errorText(cause)}`,
      row.id,
      row.branch,
      expectedOid,
      true,
      { cause },
    );
  }
  purgeMainCommentsForBranchSubject(row, "branch-deleted");
  clearPendingBranchClaim(row, expectedOid);
}

function clearPendingBranchClaim(row: WorktreeRow, expectedOid: string): void {
  try {
    if (!clearWorktreeBranchCleanup(row.id, expectedOid))
      throw new Error("the pending claim no longer matched");
  } catch (cause) {
    throw new WorktreeBranchCleanupError(
      `Worktree was removed, but branch ${row.branch} cleanup state could not be updated: ${errorText(cause)}`,
      row.id,
      row.branch,
      expectedOid,
      true,
      { cause },
    );
  }
}

/**
 * Whether the worktree branch has WORK the base branch does not contain.
 * Ancestry covers real merges; for squash merges (any number of commits) the
 * branch is contained when merging it would change nothing: the
 * `git merge-tree --write-tree` result equals the base tree.
 */
export async function hasUnmergedCommits(
  row: WorktreeRow,
  containmentBase = row.baseBranch,
): Promise<boolean> {
  const branchExists =
    (
      await gitOptionalExit(
        ["rev-parse", "--verify", `refs/heads/${row.branch}`],
        row.mainRepoRoot,
      )
    ).code === 0;
  if (!branchExists) return false;
  return !(await branchContainedInBase(
    row.mainRepoRoot,
    row.branch,
    containmentBase,
  ));
}

/* --------------------------------- listing -------------------------------- */

/**
 * All worktree records for the section/inspector: the synthetic main record of
 * every git-backed project (sorted first within its project) followed by that
 * project's spawned worktrees.
 */
export async function listWorktreeRecords(
  projectId?: string,
): Promise<WorktreeRecord[]> {
  const spawned = listWorktrees({
    ...(projectId !== undefined ? { projectId } : {}),
  }).map((row) => toRecord(row));
  const projectIds = projectId
    ? [projectId]
    : listProjects().map((project) => project.id);
  // Bounded fan-out (+ the resolveMainRepo cache) so listing across many
  // projects never spawns hundreds of concurrent git processes.
  const mains = (
    await mapLimit(projectIds, 8, (id) => resolveMainWorktreeRow(id))
  )
    .filter((row): row is WorktreeRow => row !== undefined)
    .map((row) => toRecord(row, true));

  const byProject = new Map<string, WorktreeRecord[]>();
  for (const record of [...mains, ...spawned]) {
    const list = byProject.get(record.projectId) ?? [];
    list.push(record);
    byProject.set(record.projectId, list);
  }
  // Main first within each project; spawned worktrees keep creation order.
  return [...byProject.values()].flatMap((list) =>
    list.sort((a, b) => (b.isMain ? 1 : 0) - (a.isMain ? 1 : 0)),
  );
}

/**
 * The same set as {@link listWorktreeRecords} but as ROWS, for the callers that
 * need to act on a checkout (hosting lookups) rather than describe one. Main
 * checkouts are included because they carry CI for the base branch, and their
 * resolution is the cached `resolveMainWorktreeRow` path.
 */
export async function listWorktreeRows(): Promise<WorktreeRow[]> {
  const spawned = listWorktrees({});
  const mains = (
    await mapLimit(
      listProjects().map((project) => project.id),
      8,
      (id) => resolveMainWorktreeRow(id),
    )
  ).filter((row): row is WorktreeRow => row !== undefined);
  return [...mains, ...spawned];
}

/**
 * Broadcast the current worktree list, COALESCED and SERIALIZED. Callers fire
 * this without awaiting (create/remove), and the list is computed asynchronously
 * (main-repo resolution). Running these concurrently would let a slower/older
 * computation land after a newer one and re-send a stale list (e.g. a create's
 * broadcast finishing after a remove's). One computation runs at a time; any
 * request that arrives while running sets a pending flag so the loop recomputes
 * from CURRENT state and sends again — the last send always reflects latest.
 */
let broadcastRunning = false;
let broadcastPending = false;

/** A relation-only change still invalidates the worktree list projection. */
export function broadcastWorktreeEdgeChange(): void {
  void broadcastWorktreeList().catch(() => undefined);
}

export async function broadcastWorktreeList(): Promise<void> {
  broadcastPending = true;
  if (broadcastRunning) return;
  broadcastRunning = true;
  try {
    while (broadcastPending) {
      broadcastPending = false;
      const worktrees = await listWorktreeRecords();
      worktreeBroadcaster().broadcast({
        type: "worktreeList",
        worktrees,
        updatedAt: Date.now(),
      });
    }
  } finally {
    broadcastRunning = false;
  }
}

function toRecord(row: WorktreeRow, isMain = false): WorktreeRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    ...(isMain ? { isMain: true } : {}),
    mainRepoRoot: row.mainRepoRoot,
    path: row.path,
    branch: row.branch,
    baseBranch: row.baseBranch,
    baseCommit: row.baseCommit,
    status: row.status,
    sessionIds: sessionIdsForWorktree(row.id),
    taskIds: taskIdsForWorktree(row.id),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.removedAt !== null ? { removedAt: row.removedAt } : {}),
    ...mergeProjection(row),
  };
}

/**
 * The phase of a merge that has NOT finished, from persisted state. Carried on
 * the record so a reconnecting browser learns about a merge stuck on conflicts:
 * `worktreeMergeUpdate` is an event, and an event that fired before you
 * subscribed is an event you never hear.
 */
function mergeProjection(row: WorktreeRow): {
  mergePhase?: WorktreeMergePhase;
  mergeMessage?: string;
} {
  if (!row.mergeStateJson) return {};
  try {
    const state = JSON.parse(row.mergeStateJson) as {
      phase?: WorktreeMergePhase;
      message?: string;
    };
    if (!state.phase || state.phase === "idle" || state.phase === "done")
      return {};
    const message = boundMergeMessage(state.message);
    return {
      mergePhase: state.phase,
      ...(message ? { mergeMessage: message } : {}),
    };
  } catch {
    return {};
  }
}
