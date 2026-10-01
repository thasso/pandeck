/**
 * Shared git CLI executor. The one place that spawns `git` for domain modules
 * (commit workflow, worktrees, diffs, status scans). Every process starts in
 * the spawn broker (`spawnBroker.ts`), never by forking this server.
 *
 * Also owns {@link withRepoLock}: mutating git operations (merge, rebase,
 * worktree add/remove, commit) against the same repository root must be
 * serialized, because agents may commit concurrently with user-driven merges.
 * Read-only commands (status/diff/log) stay lock-free; git handles concurrent
 * readers.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync, statSync } from "node:fs";
import { errorText } from "./errors.ts";
import {
  brokerBoundedStdout,
  brokerExecFile,
  type BrokerExecOutcome,
} from "./spawnBroker.ts";
import { childProcessEnv } from "./subprocessEnv.ts";

const MAX_EXEC_BUFFER = 12 * 1024 * 1024;
const GIT_EXECUTION_FAILURE_CODE = 1;

/**
 * What a read-only run may NOT do: take git's optional locks. `git status`
 * refreshes and rewrites the index by default (`index.lock` → `index` in the
 * checkout's git dir), which makes a "read" a writer: a watcher scan of a
 * linked worktree racing `git worktree remove` left the admin directory
 * non-empty mid-delete. With optional locks off the same commands answer the
 * same, without touching the repository.
 */
const READ_ONLY_GIT_ENV: NodeJS.ProcessEnv = { GIT_OPTIONAL_LOCKS: "0" };

// Six keeps a handful of short reads parallel without letting fleet-wide status
// refreshes turn into hundreds of simultaneous child processes.
const MAX_READ_ONLY_CONCURRENCY = 6;

let activeReadOnly = 0;
/** Takes the slot and reports whether it did; a waiter that gave up returns false. */
type ReadOnlyWaiter = () => boolean;
const readOnlyWaiters: ReadOnlyWaiter[] = [];
let executionCounterStorage: AsyncLocalStorage<{ count: number }> | undefined;

type GitFailureKind = "exit" | "execution";

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly result: GitResult,
    /** Whether git ran and returned an exit status, or failed to run. */
    readonly failureKind: GitFailureKind,
  ) {
    super(message);
  }
}

/**
 * Run git in `cwd`; rejects with {@link GitCommandError} on a non-zero exit or
 * an execution failure.
 */
export async function git(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<GitResult> {
  const executionCounter = executionCounterStorage?.getStore();
  if (executionCounter) executionCounter.count += 1;
  const outcome = await brokered(args, () =>
    brokerExecFile({
      file: "git",
      args,
      cwd,
      ...(signal ? { signal } : {}),
      maxBuffer: MAX_EXEC_BUFFER,
      encoding: "utf8",
      env: env ? { ...childProcessEnv(), ...env } : childProcessEnv(),
    }),
  );
  return settleExec(args, outcome);
}

/** A broker that died mid-request is an execution failure, like a lost spawn. */
async function brokered<T>(args: string[], run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw new GitCommandError(
      `git ${args.join(" ")} failed: ${errorText(err)}`,
      { stdout: "", stderr: "", code: GIT_EXECUTION_FAILURE_CODE },
      "execution",
    );
  }
}

/** `execFile`'s callback contract: a numeric code is git's exit status. */
function settleExec(
  args: string[],
  outcome: BrokerExecOutcome<string>,
): GitResult {
  const rawCode = outcome.error?.code;
  const code = outcome.error
    ? typeof rawCode === "number"
      ? rawCode
      : GIT_EXECUTION_FAILURE_CODE
    : 0;
  const result = { stdout: outcome.stdout, stderr: outcome.stderr, code };
  if (outcome.error)
    throw new GitCommandError(
      `git ${args.join(" ")} failed: ${outcome.stderr || outcome.error.message}`,
      result,
      typeof rawCode === "number" ? "exit" : "execution",
    );
  return result;
}

/**
 * Run a read-only Git command while retaining at most `maxChars` of stdout.
 * The stream is still consumed in full so callers get authoritative total-size
 * and truncation metadata without risking the shared executor's buffer limit.
 *
 * It is a READ, so it takes the same fan-out slot as {@link gitReadOnly}: a
 * command that streams a whole repository diff is exactly the kind that must
 * not spawn without bound. `signal` is the caller's cancellation — a tool call
 * that is abandoned kills the child rather than paying for the rest of a diff
 * nobody will read.
 */
export async function gitBoundedStdout(
  args: string[],
  cwd: string,
  maxChars: number,
  signal?: AbortSignal,
): Promise<{ patch: string; totalChars: number; truncated: boolean }> {
  return withReadOnlySlot(
    async () => {
      if (signal?.aborted) throw abortedGitError(args);
      const executionCounter = executionCounterStorage?.getStore();
      if (executionCounter) executionCounter.count += 1;
      // SIGTERM on abort ends `git diff` promptly; the broker still answers,
      // so the slot is released on the normal path.
      const outcome = await brokered(args, () =>
        brokerBoundedStdout({
          file: "git",
          args,
          cwd,
          maxChars,
          maxStderr: MAX_EXEC_BUFFER,
          ...(signal ? { signal } : {}),
          env: { ...childProcessEnv(), ...READ_ONLY_GIT_ENV },
        }),
      );
      const { patch, totalChars, stderr } = outcome;
      if (outcome.spawnError !== undefined)
        throw new GitCommandError(
          `git ${args.join(" ")} failed: ${outcome.spawnError}`,
          {
            stdout: patch.slice(0, maxChars),
            stderr,
            code: GIT_EXECUTION_FAILURE_CODE,
          },
          "execution",
        );
      if (outcome.aborted) throw abortedGitError(args);
      if (outcome.code !== 0)
        throw new GitCommandError(
          `git ${args.join(" ")} failed: ${stderr}`,
          { stdout: patch, stderr, code: outcome.code ?? 1 },
          "exit",
        );
      return { patch, totalChars, truncated: totalChars > maxChars };
    },
    signal,
    () => abortedGitError(args),
  );
}

function abortedGitError(args: string[]): GitCommandError {
  return new GitCommandError(
    `git ${args.join(" ")} was cancelled.`,
    { stdout: "", stderr: "", code: GIT_EXECUTION_FAILURE_CODE },
    "execution",
  );
}

/** Run git with validated bytes on stdin instead of reopening a path. */
async function gitWithInput(
  args: string[],
  cwd: string,
  input: string | Buffer,
): Promise<GitResult> {
  const outcome = await brokered(args, () =>
    brokerExecFile({
      file: "git",
      args,
      cwd,
      maxBuffer: MAX_EXEC_BUFFER,
      encoding: "utf8",
      env: childProcessEnv(),
      input,
    }),
  );
  return settleExec(args, outcome);
}

/** Like {@link gitWithInput}, but returns a failed command result. */
export async function gitWithInputOptional(
  args: string[],
  cwd: string,
  input: string | Buffer,
): Promise<GitResult> {
  try {
    return await gitWithInput(args, cwd, input);
  } catch (err) {
    if (err instanceof GitCommandError) return err.result;
    throw err;
  }
}

/**
 * Run git capturing stdout as RAW BYTES (`git show`/`cat-file` of binary
 * blobs; the string executors would corrupt them). Never throws: a non-zero
 * exit or execution failure (including an over-`maxBuffer` overflow) surfaces as
 * a non-zero `code`.
 */
export async function gitRawStdout(
  args: string[],
  cwd: string,
  maxBuffer = MAX_EXEC_BUFFER,
): Promise<{ content: Buffer; code: number }> {
  try {
    const outcome = await brokerExecFile({
      file: "git",
      args,
      cwd,
      maxBuffer,
      encoding: "buffer",
      env: childProcessEnv(),
    });
    const rawCode = outcome.error?.code;
    const code = outcome.error
      ? typeof rawCode === "number"
        ? rawCode
        : GIT_EXECUTION_FAILURE_CODE
      : 0;
    return { content: outcome.stdout, code };
  } catch {
    return { content: Buffer.alloc(0), code: GIT_EXECUTION_FAILURE_CODE };
  }
}

/**
 * Run a lock-free read while bounding process fan-out. Mutations deliberately
 * use {@link git} directly, so a repo-lock holder never waits for this queue.
 * Lock-free on git's side too ({@link READ_ONLY_GIT_ENV}).
 */
async function gitReadOnly(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<GitResult> {
  return withReadOnlySlot(
    () => git(args, cwd, signal, { ...READ_ONLY_GIT_ENV, ...env }),
    signal,
    () => abortedGitError(args),
  );
}

/**
 * Hold one read fan-out slot for the duration of `run`.
 *
 * WAITING is cancellable, not just running: a caller that gave up while queued
 * behind six long reads would otherwise stay pending until one of them
 * finished, which is the opposite of what cancelling a read means. A waiter
 * that abandons the queue never held a slot, so the accounting is untouched;
 * the slot goes to the next waiter that is still interested.
 */
async function withReadOnlySlot<T>(
  run: () => Promise<T>,
  signal?: AbortSignal,
  cancelled?: () => Error,
): Promise<T> {
  await acquireReadOnlySlot(signal, cancelled);
  try {
    return await run();
  } finally {
    releaseReadOnlySlot();
  }
}

function acquireReadOnlySlot(
  signal: AbortSignal | undefined,
  cancelled: (() => Error) | undefined,
): Promise<void> {
  const abortError = (): Error =>
    cancelled?.() ?? new Error("The read was cancelled.");
  if (signal?.aborted) return Promise.reject(abortError());
  if (activeReadOnly < MAX_READ_ONLY_CONCURRENCY) {
    activeReadOnly += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      const index = readOnlyWaiters.indexOf(waiter);
      if (index >= 0) readOnlyWaiters.splice(index, 1);
      reject(abortError());
    };
    const waiter: ReadOnlyWaiter = () => {
      if (settled) return false;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve();
      return true;
    };
    readOnlyWaiters.push(waiter);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function releaseReadOnlySlot(): void {
  // Hand the slot on to the first waiter that still wants it; one that gave up
  // while queued must not silently consume it.
  for (;;) {
    const next = readOnlyWaiters.shift();
    if (!next) {
      activeReadOnly -= 1;
      return;
    }
    if (next()) return;
  }
}

/** Like {@link git}, but returns the failed result instead of throwing. */
export async function gitOptional(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<GitResult> {
  try {
    return await git(args, cwd, signal, env);
  } catch (err) {
    if (err instanceof GitCommandError) return err.result;
    throw err;
  }
}

/** Bounded read-only counterpart of {@link gitOptional}. */
export async function gitReadOnlyOptional(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<GitResult> {
  try {
    return await gitReadOnly(args, cwd, signal, env);
  } catch (err) {
    if (err instanceof GitCommandError) return err.result;
    throw err;
  }
}

/**
 * Like {@link gitOptional}, but only absorbs a non-zero exit from a git process.
 * Spawn, signal, and other execution failures still reject, which is important
 * for guards where an unavailable git must not be mistaken for a negative
 * answer.
 */
export async function gitOptionalExit(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<GitResult> {
  try {
    return await git(args, cwd, signal, env);
  } catch (err) {
    if (err instanceof GitCommandError && err.failureKind === "exit")
      return err.result;
    throw err;
  }
}

/** Bounded read-only counterpart of {@link gitOptionalExit}. */
export async function gitReadOnlyOptionalExit(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<GitResult> {
  try {
    return await gitReadOnly(args, cwd, signal, env);
  } catch (err) {
    if (err instanceof GitCommandError && err.failureKind === "exit")
      return err.result;
    throw err;
  }
}

/** Test seam for asserting process-count budgets rather than timings. */
export async function countGitExecutionsForTests<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; executions: number }> {
  executionCounterStorage ??= new AsyncLocalStorage<{ count: number }>();
  const counter = { count: 0 };
  const result = await executionCounterStorage.run(counter, fn);
  return { result, executions: counter.count };
}

/** Repo root (`--show-toplevel`) for any path inside a working tree. */
export async function resolveRepoRoot(
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await git(["rev-parse", "--show-toplevel"], cwd, signal);
  return res.stdout.trim();
}

const repoLocks = new Map<string, Promise<unknown>>();

/**
 * Canonical lock key for the REPOSITORY a path belongs to: the shared (common)
 * git dir, which is identical for the main checkout and every linked worktree.
 * Locking by checkout path would give the same repository different keys — a
 * commit inside a worktree and a merge in the main checkout must serialize.
 */
export async function repoLockKey(cwd: string): Promise<string> {
  // A checkout's common git dir never changes, and this is asked before every
  // locked mutation and watch registration: remember each ANSWERED path. A
  // path that is not (yet) a repository is asked again next time, and so is
  // one whose directory or `.git` was replaced ({@link directoryIdentity}).
  const identity = directoryIdentity(cwd);
  const known = repoLockKeys.get(cwd);
  if (known && identity && known.identity === identity) return known.key;
  const res = await gitOptional(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    cwd,
  );
  const dir = res.code === 0 ? res.stdout.trim() : "";
  if (!dir) return cwd;
  let key = dir;
  try {
    key = realpathSync(dir);
  } catch {
    // Keep git's spelling.
  }
  if (!identity) return key;
  if (repoLockKeys.size >= MAX_REPO_LOCK_KEYS) repoLockKeys.clear();
  repoLockKeys.set(cwd, { key, identity });
  return key;
}

/**
 * What must stay the same for a remembered key to still hold: the directory
 * itself (a removed checkout's path reused is a new directory) and its `.git`
 * entry — a re-initialised repository is a new `.git` directory, and a linked
 * worktree repointed at another repository rewrites its `.git` pointer file.
 * Only checkout roots have one; any other path is answered by git every time.
 */
function directoryIdentity(path: string): string | undefined {
  const dir = statSync(path, { throwIfNoEntry: false, bigint: true });
  const git = statSync(`${path}/.git`, { throwIfNoEntry: false, bigint: true });
  // Below a checkout root there is no `.git` to stamp, and the directory alone
  // cannot tell whether its containing repository was replaced: not memoized.
  if (!dir || !git) return undefined;
  const gitStamp = git.isFile()
    ? `${git.dev}:${git.ino}:${git.size}:${git.mtimeNs}`
    : `${git.dev}:${git.ino}`;
  return `${dir.dev}:${dir.ino}|${gitStamp}`;
}

const MAX_REPO_LOCK_KEYS = 2_000;
const repoLockKeys = new Map<string, { key: string; identity: string }>();

/** Test seam: forget remembered repo keys so process counts start cold. */
export function clearRepoLockKeysForTests(): void {
  repoLockKeys.clear();
}

/**
 * Serialize a mutating git operation per repository. `key` MUST come from
 * {@link repoLockKey} so all checkouts of one repository share the chain.
 * Implemented as a per-key promise chain; errors in one operation do not
 * poison the chain. NOT re-entrant — never nest for the same repository.
 */
export async function withRepoLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = repoLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  repoLocks.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}
