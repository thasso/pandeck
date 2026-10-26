/**
 * User-initiated git WRITE operations on a worktree: manual commit and
 * HEAD-scoped clean (worktreeHttp.ts). Auto-commit and push run whole app
 * workflows on the checkout path and live in `worktreeWorkflowWrite.ts`.
 *
 * Commit/clean mutate under the per-repository lock (agents may be committing
 * or merging concurrently). Both run on the row's side (`checkoutSideOf`):
 * the Knowledge Base row commits on the server.
 *
 * Both are permitted on the synthetic `main:<projectId>` checkout: unlike
 * merge/remove (agent-lifecycle operations that stay rejected for main),
 * commit/clean are explicit user actions on the user's checkout.
 */
import type {
  WorktreeCleanResponse,
  WorktreeCommitResponse,
} from "@assistant/shared";
import { checkoutGitOn, withRepoLock } from "../gitExec.ts";
import type { WorktreeRow } from "../db/worktreeStore.ts";
import { checkoutSideOf } from "./knowledgeCheckout.ts";
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
  const { git, gitOptional, repoLockKey } = checkoutGitOn(checkoutSideOf(row));

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

export async function cleanWorktree(
  row: WorktreeRow,
): Promise<WorktreeCleanResponse> {
  const { git, repoLockKey } = checkoutGitOn(checkoutSideOf(row));
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
