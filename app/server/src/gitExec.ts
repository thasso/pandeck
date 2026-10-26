/**
 * Shared git CLI executor for CHECKOUTS: the one way domain modules (commit
 * workflow, worktrees, diffs, status scans) run `git`. Every call crosses the
 * worker protocol to the Worker its checkout is placed on, which starts the
 * process (`docs/workers.md`); a caller sees exactly what a local run returns.
 *
 * {@link checkoutGitOn} runs on a given side, the server included for the
 * Knowledge Base row: the modules that can hold that row take their side from
 * it (`checkoutSideOf`). The string executors exported below choose by path.
 *
 * The executors, their failure shapes, the read fan-out bound, the execution
 * counter and {@link withRepoLock} belong to the executor family
 * (`gitFamily.ts`), shared with `serverRepoGit.ts`, the family for the
 * server's own repositories. Mutating git operations (merge, rebase, worktree
 * add/remove, commit) against the same repository root must be serialized
 * through {@link withRepoLock}, because agents may commit concurrently with
 * user-driven merges. Read-only commands (status/diff/log) stay lock-free; git
 * handles concurrent readers.
 */
import {
  checkoutFilesOn,
  inspectCheckoutPath,
  realpathInCheckout,
} from "./checkoutFileAccess.ts";
import { createGitFamily } from "./gitFamily.ts";
import { localGitRunner, type GitRunner } from "./gitProcess.ts";
import { workerGitRunner } from "./workers/checkoutClient.ts";
import {
  checkoutSideKey,
  placeGitCwd,
  type CheckoutSide,
} from "./workers/placement.ts";

export {
  GitCommandError,
  type GitResult,
  clearRepoLockKeysForTests,
  countGitExecutionsForTests,
  withRepoLock,
} from "./gitFamily.ts";

/**
 * Each call goes where its directory is placed. Until W3 types the KB row,
 * a path inside the Knowledge Base stays on the server (`placement.ts`).
 */
const checkoutRunner: GitRunner = {
  run: (req) => {
    const location = placeGitCwd(req.cwd);
    return location
      ? workerGitRunner.run(location, req)
      : localGitRunner.run(req);
  },
  raw: (req) => {
    const location = placeGitCwd(req.cwd);
    return location
      ? workerGitRunner.raw(location, req)
      : localGitRunner.raw(req);
  },
  bounded: (req) => {
    const location = placeGitCwd(req.cwd);
    return location
      ? workerGitRunner.bounded(location, req)
      : localGitRunner.bounded(req);
  },
};

/** `repoLockKey`'s reads, on the side its `cwd` is placed on. */
const checkout = createGitFamily(checkoutRunner, {
  inspect: (cwd, path) => inspectCheckoutPath(cwd, path, { follow: true }),
  realpath: realpathInCheckout,
});

export const {
  git,
  gitBoundedStdout,
  gitWithInputOptional,
  gitRawStdout,
  gitOptional,
  gitReadOnlyOptional,
  gitOptionalExit,
  gitReadOnlyOptionalExit,
  resolveRepoRoot,
  repoLockKey,
} = checkout;

type CheckoutGit = ReturnType<typeof createGitFamily>;

const familiesBySide = new Map<string, CheckoutGit>();

/** Every git request goes to Worker `workerId`, in the request's `cwd`. */
function workerRunner(workerId: string): GitRunner {
  return {
    run: (req) => workerGitRunner.run({ workerId, path: req.cwd }, req),
    raw: (req) => workerGitRunner.raw({ workerId, path: req.cwd }, req),
    bounded: (req) => workerGitRunner.bounded({ workerId, path: req.cwd }, req),
  };
}

/**
 * The executors on `side`, one instance per side. `repoLockKey` reads on the
 * same side; its remembered keys, the locks, the read bound and the counter
 * are the family module's, shared by every side.
 */
export function checkoutGitOn(side: CheckoutSide): CheckoutGit {
  const key = checkoutSideKey(side);
  let family = familiesBySide.get(key);
  if (!family) {
    const files = checkoutFilesOn(side);
    family = createGitFamily(
      side === "server" ? localGitRunner : workerRunner(side.workerId),
      {
        inspect: (cwd, path) => files.inspect(cwd, path, { follow: true }),
        realpath: files.realpath,
      },
    );
    familiesBySide.set(key, family);
  }
  return family;
}
