/**
 * User-initiated worktree writes that run a whole app workflow on the
 * checkout path (worktreeHttp.ts): agent-generated auto-commit and push. Both
 * run on the row's side (`checkoutSideOf`); the HTTP gate refuses both verbs
 * for the Knowledge Base row.
 *
 * Push reuses the app-side push workflow the `/push` slash command uses
 * (non-interactive ssh env, upstream resolution/setup, force-with-lease) and
 * intentionally runs WITHOUT the repo lock — see pushWorkflow.ts for why that
 * is safe.
 *
 * Both are permitted on the synthetic `main:<projectId>` checkout, as explicit
 * user actions on the user's checkout.
 */
import type {
  WorktreeAutoCommitResponse,
  WorktreePushResponse,
} from "@assistant/shared";
import { runCommitWorkflow, toCommitDisplay } from "../commitWorkflow.ts";
import { runPushWorkflow } from "../pushWorkflow.ts";
import type { WorktreeRow } from "../db/worktreeStore.ts";
import { checkoutSideOf } from "./knowledgeCheckout.ts";
import { invalidateWorktreeStatus } from "./worktreeStatus.ts";

export async function autoCommitWorktree(
  row: WorktreeRow,
  input: { force?: boolean },
): Promise<WorktreeAutoCommitResponse> {
  // Deliberately do not guess a linked session: the diff is authoritative and
  // the same commit workflow still performs its deterministic + agent checks.
  const result = await runCommitWorkflow({
    source: "tool",
    cwd: row.path,
    side: checkoutSideOf(row),
    force: Boolean(input.force),
  });
  invalidateWorktreeStatus(row.id);
  return { worktreeId: row.id, result: toCommitDisplay(result) };
}

export async function pushWorktree(
  row: WorktreeRow,
  input: { force?: boolean },
): Promise<WorktreePushResponse> {
  const result = await runPushWorkflow({
    cwd: row.path,
    side: checkoutSideOf(row),
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
