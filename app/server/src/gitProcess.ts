/**
 * The git process itself: the one place a `git` child is started, always in
 * the spawn broker (`spawnBroker.ts`), never by forking this server.
 *
 * Nothing here counts, queues or settles: that is the executor family's work
 * (`gitFamily.ts`), which runs over a {@link GitRunner}. Two runners exist. The
 * {@link localGitRunner} below serves the server's own repositories
 * (`serverRepoGit.ts`); the checkout runner in `gitExec.ts` sends checkout git
 * to a Worker, whose handlers call these primitives with an exit receipt
 * (`worker/checkoutGit.ts`).
 */
import {
  brokerBoundedStdout,
  brokerExecFile,
  type BrokerBoundedOutcome,
  type BrokerExecOutcome,
} from "./spawnBroker.ts";
import { childProcessEnv } from "./subprocessEnv.ts";

/**
 * Whether the family ran this as a lock-free read (a read fan-out slot, git's
 * optional locks off) or as anything else. Carried for the Worker; the child
 * does not see it.
 */
export type GitRunMode = "mutating" | "readOnly";

interface GitRunBase {
  args: string[];
  cwd: string;
  mode: GitRunMode;
  /**
   * Applied over the child environment the process would inherit; a key set to
   * `undefined` removes that variable. Absent: no override.
   */
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Reply only after the child has exited (the broker's exit receipt). */
  awaitExit?: boolean;
}

export interface GitRunRequest extends GitRunBase {
  maxBuffer: number;
  input?: string | Buffer;
}

export interface GitRawRequest extends GitRunBase {
  maxBuffer: number;
}

export interface GitBoundedRequest extends GitRunBase {
  maxChars: number;
  maxStderr: number;
}

/** What the executor family runs over. A failure to run at all rejects. */
export interface GitRunner {
  run(req: GitRunRequest): Promise<BrokerExecOutcome<string>>;
  raw(req: GitRawRequest): Promise<BrokerExecOutcome<Buffer>>;
  bounded(req: GitBoundedRequest): Promise<BrokerBoundedOutcome>;
}

function childEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return env ? { ...childProcessEnv(), ...env } : childProcessEnv();
}

/** Run git, collecting stdout as text (`execFile`'s utf8 mode). */
export function runGit(req: GitRunRequest): Promise<BrokerExecOutcome<string>> {
  return brokerExecFile({
    file: "git",
    args: req.args,
    cwd: req.cwd,
    ...(req.signal ? { signal: req.signal } : {}),
    maxBuffer: req.maxBuffer,
    encoding: "utf8",
    env: childEnv(req.env),
    ...(req.input !== undefined ? { input: req.input } : {}),
    ...(req.awaitExit ? { awaitExit: true } : {}),
  });
}

/** Run git, collecting stdout as raw bytes. */
export function runGitRaw(
  req: GitRawRequest,
): Promise<BrokerExecOutcome<Buffer>> {
  return brokerExecFile({
    file: "git",
    args: req.args,
    cwd: req.cwd,
    ...(req.signal ? { signal: req.signal } : {}),
    maxBuffer: req.maxBuffer,
    encoding: "buffer",
    env: childEnv(req.env),
    ...(req.awaitExit ? { awaitExit: true } : {}),
  });
}

/** Run git, keeping a bounded prefix of its stdout. */
export function runGitBounded(
  req: GitBoundedRequest,
): Promise<BrokerBoundedOutcome> {
  return brokerBoundedStdout({
    file: "git",
    args: req.args,
    cwd: req.cwd,
    maxChars: req.maxChars,
    maxStderr: req.maxStderr,
    ...(req.signal ? { signal: req.signal } : {}),
    env: childEnv(req.env),
    ...(req.awaitExit ? { awaitExit: true } : {}),
  });
}

/** git started on this server, with the broker's ordinary timing. */
export const localGitRunner: GitRunner = {
  run: runGit,
  raw: runGitRaw,
  bounded: runGitBounded,
};
