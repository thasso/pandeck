/**
 * User-initiated git WRITE operations on a worktree: manual/agent-generated
 * commit, HEAD-scoped clean, and push (worktreeHttp.ts).
 *
 * Commit/clean mutate under the per-repository lock (agents may be committing
 * or merging concurrently). Push reuses the app-side push workflow
 * the `/push` slash command uses (non-interactive ssh env, upstream
 * resolution/setup, force-with-lease) and intentionally runs WITHOUT the repo
 * lock — see pushWorkflow.ts for why that is safe.
 *
 * Both are permitted on the synthetic `main:<projectId>` checkout: unlike
 * merge/remove (agent-lifecycle operations that stay rejected for main),
 * commit/auto-commit/clean/push are explicit user actions on the user's checkout.
 */
import type {
  WorktreeAutoCommitResponse,
  WorktreeCleanResponse,
  WorktreeCommitResponse,
  WorktreePushResponse,
} from "@assistant/shared";
import { git, gitOptional, repoLockKey, withRepoLock } from "../gitExec.ts";
import { runCommitWorkflow, toCommitDisplay } from "../commitWorkflow.ts";
import { runPushWorkflow } from "../pushWorkflow.ts";
import type { WorktreeRow } from "../db/worktreeStore.ts";
import { invalidateWorktreeStatus } from "./worktreeStatus.ts";

const MAX_COMMIT_MESSAGE_CHARS = 10_000;
const MAX_COMMIT_PATHS = 500;

function validatedPaths(paths: string[] | undefined): string[] {
  if (!paths || paths.length === 0) return [];
  if (paths.length > MAX_COMMIT_PATHS) throw new Error("Too many paths.");
  for (const path of paths) {
    // git itself refuses paths outside the worktree (and `--` blocks option
    // injection); this just rejects obviously malformed entries early.
    if (typeof path !== "string" || !path.trim() || path.startsWith("-"))
      throw new Error("Invalid path list.");
  }
  return paths;
}

export async function commitWorktree(
  row: WorktreeRow,
  input: { message: string; paths?: string[] },
): Promise<WorktreeCommitResponse> {
  const message = input.message?.trim();
  if (!message) throw new Error("Commit message cannot be empty.");
  if (message.length > MAX_COMMIT_MESSAGE_CHARS)
    throw new Error("Commit message is too long.");
  const paths = validatedPaths(input.paths);

  return withRepoLock(await repoLockKey(row.path), async () => {
    if (paths.length > 0) await git(["add", "--", ...paths], row.path);
    else await git(["add", "-A"], row.path);

    const staged = await gitOptional(["diff", "--cached", "--quiet"], row.path);
    if (staged.code === 0) {
      return { worktreeId: row.id, status: "nothing-to-commit" };
    }

    await git(["commit", "-m", message], row.path);
    invalidateWorktreeStatus(row.id);
    const head = await gitOptional(["rev-parse", "--short", "HEAD"], row.path);
    return {
      worktreeId: row.id,
      status: "committed",
      ...(head.code === 0 && head.stdout.trim()
        ? { commitHash: head.stdout.trim() }
        : {}),
    };
  });
}

export async function autoCommitWorktree(
  row: WorktreeRow,
  input: { force?: boolean },
): Promise<WorktreeAutoCommitResponse> {
  // Deliberately do not guess a linked session: the diff is authoritative and
  // the same commit workflow still performs its deterministic + agent checks.
  const result = await runCommitWorkflow({
    source: "tool",
    cwd: row.path,
    force: Boolean(input.force),
  });
  invalidateWorktreeStatus(row.id);
  return { worktreeId: row.id, result: toCommitDisplay(result) };
}

export async function cleanWorktree(
  row: WorktreeRow,
): Promise<WorktreeCleanResponse> {
  return withRepoLock(await repoLockKey(row.path), async () => {
    const before = await git(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      row.path,
    );
    const filesDiscarded = before.stdout.split("\n").filter(Boolean).length;
    if (filesDiscarded === 0)
      return {
        worktreeId: row.id,
        status: "nothing-to-clean",
        filesDiscarded: 0,
      };

    // "Clean" is intentionally HEAD-scoped: preserve every commit and ignored
    // build/cache artifact, discard tracked edits plus ordinary untracked files.
    await git(["reset", "--hard", "HEAD"], row.path);
    await git(["clean", "-fd"], row.path);
    invalidateWorktreeStatus(row.id);
    return { worktreeId: row.id, status: "cleaned", filesDiscarded };
  });
}

export async function pushWorktree(
  row: WorktreeRow,
  input: { force?: boolean },
): Promise<WorktreePushResponse> {
  const result = await runPushWorkflow({
    cwd: row.path,
    force: Boolean(input.force),
  });
  invalidateWorktreeStatus(row.id);
  return {
    worktreeId: row.id,
    status: result.status,
    ...(result.remote !== undefined ? { remote: result.remote } : {}),
    ...(result.branch !== undefined ? { branch: result.branch } : {}),
    setUpstream: result.setUpstream,
    output: result.output,
    ...(result.error ? { error: result.error } : {}),
  };
}
