/**
 * git for the server's OWN repositories: the Knowledge Base, the skills and
 * agent libraries in `DATA_DIR`, and the app's source tree. They are not
 * checkouts and never reach a Worker (`docs/workers.md`), so this family runs
 * git on the server, with the same executors, counter, read bound and repo
 * lock as the checkout family in `gitExec.ts`.
 *
 * Only the modules `workerBoundary.test.ts` pins may import it; everything
 * else runs git in checkouts, through `gitExec.ts`.
 */
import { createGitFamily } from "./gitFamily.ts";
import { localGitRunner } from "./gitProcess.ts";

export { withRepoLock } from "./gitFamily.ts";

export const {
  git,
  gitBoundedStdout,
  gitOptional,
  gitOptionalExit,
  repoLockKey,
} = createGitFamily(localGitRunner);
