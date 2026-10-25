/**
 * Shared git CLI executor for CHECKOUTS: the one way domain modules (commit
 * workflow, worktrees, diffs, status scans) run `git`. Every call crosses the
 * worker protocol to the Worker its checkout is placed on, which starts the
 * process (`docs/workers.md`); a caller sees exactly what a local run returns.
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
import { createGitFamily } from "./gitFamily.ts";
import { localGitRunner, type GitRunner } from "./gitProcess.ts";
import { workerGitRunner } from "./workers/checkoutClient.ts";
import { placeGitCwd } from "./workers/placement.ts";

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

const checkout = createGitFamily(checkoutRunner);

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
