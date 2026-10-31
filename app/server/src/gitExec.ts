/**
 * Shared git CLI executor for CHECKOUTS: the one way domain modules (commit
 * workflow, worktrees, diffs, status scans) run `git`. Every call runs on a
 * typed side (`docs/workers.md`): a Worker side crosses the worker protocol to
 * that Worker, which starts the process; a caller sees exactly what a local
 * run returns.
 *
 * {@link checkoutGitOn} is the only way in: every caller names the side of
 * the checkout it holds — its row's or project's (`checkoutSideOf`), its
 * session's (`sessionCheckoutSide`), its pull-request card's
 * (`pullRequestCardCheckout`) — the server included for the Knowledge Base
 * row. No path chooses a side.
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
import { checkoutFilesOn } from "./checkoutFileAccess.ts";
import { createGitFamily } from "./gitFamily.ts";
import { localGitRunner, type GitRunner } from "./gitProcess.ts";
import { workerGitRunner } from "./workers/checkoutClient.ts";
import { checkoutSideKey, type CheckoutSide } from "./workers/placement.ts";

export {
  GitCommandError,
  type GitResult,
  clearRepoLockKeysForTests,
  countGitExecutionsForTests,
  withRepoLock,
} from "./gitFamily.ts";

/**
 * One side's executors. `sideKey` names the side, one string per side, for
 * state a caller keeps per side and repository.
 */
type CheckoutGit = ReturnType<typeof createGitFamily> & {
  readonly sideKey: string;
};

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
    family = {
      ...createGitFamily(
        side === "server" ? localGitRunner : workerRunner(side.workerId),
        {
          inspect: (cwd, path) => files.inspect(cwd, path, { follow: true }),
          realpath: files.realpath,
        },
      ),
      sideKey: key,
    };
    familiesBySide.set(key, family);
  }
  return family;
}
