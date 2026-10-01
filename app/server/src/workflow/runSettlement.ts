/**
 * Settling a formal Workflow Run ([Task-677](pa://task/677)): the one
 * acknowledgement verb for a run's outcome, and the cascade it promises.
 *
 * The run is the ATTENTION OWNER and its role sessions are evidence, so one
 * Settle on the run acknowledges the run's latest event AND puts down the
 * sessions the run structurally owns — the ids on its recipe card projection,
 * never a title — through their current outcome revisions. Only a server-side
 * settlement may assume "current": the user acknowledged the run they saw, and
 * the roles are settled on that authority, not on a revision the browser
 * rendered for each of them.
 *
 * Kept out of `engine.ts` on purpose: the engine is session-free, and this is
 * exactly the place where a run reaches into the session inbox.
 */
import {
  workflowRunRoleSessionIds,
  workflowRunSettleBlockedReason,
} from "@assistant/shared";
import {
  getRun,
  settleRun,
  WorkflowValidationError,
  type WorkflowRunRow,
} from "../db/workflowStore.ts";
import {
  sessionSettleBlockedReason,
  settleWorkflowRunRoleSessions,
} from "../sessionActivity.ts";
import {
  broadcastWorkflowRuns,
  workflowRunCardFor,
  workflowRunSummaryOf,
} from "../workflowRuns.ts";

/**
 * Why this run may not be settled right now, in the shared wording, or
 * `undefined` when it may: the run's own gate, else the first role session
 * the shared session predicate still blocks — running, queued, or waiting on
 * a human — in that session's own wording, exactly as the inbox item disables
 * its Settle. Evaluated over the SAME summary, card projection and session
 * rows the browser rendered, so the two can never disagree.
 *
 * Checked BEFORE anything is written, so the operation is all-or-nothing: a
 * run acknowledged while one of its roles stayed up would clear the item and
 * have that role resurface as a card of its own, which is exactly the flood
 * one Settle on the run promises to end.
 */
async function runSettleBlockedReason(
  run: WorkflowRunRow,
  roleSessionIds: readonly string[],
): Promise<string | undefined> {
  const own = workflowRunSettleBlockedReason(
    workflowRunSummaryOf(run),
    workflowRunCardFor(run),
  );
  if (own) return own;
  for (const sessionId of roleSessionIds) {
    const reason = await sessionSettleBlockedReason(sessionId);
    if (reason) return reason;
  }
  return undefined;
}

/**
 * Acknowledge the run through `throughRevision` and settle its role sessions.
 * Throws a {@link WorkflowValidationError} carrying the shared reason when the
 * run's current gate is an unresolved user decision or a role cannot be put
 * down; a stale revision is NOT an error — the store simply leaves the newer
 * event unacknowledged, and the item stays awake on every subscribed client.
 *
 * All-or-nothing, in two halves: the preflight above is the only place the
 * command can be refused, and once it passes the run cursor and every role are
 * written back to back with no await between them — the roles first, so an
 * interleaved reader never sees the run acknowledged while a role is still
 * up — and no write re-asks a predicate that could skip a role. Only then are
 * both lists broadcast: a Settle on the phone has to clear the item on the
 * laptop, and the SESSION list goes first and is awaited to its flush, since a
 * client that received the settled run before the settled roles would stop
 * folding them for a moment and show each as a card of its own.
 */
export async function settleWorkflowRun(
  runId: number,
  throughRevision: number,
): Promise<WorkflowRunRow> {
  const run = getRun(runId);
  if (!run)
    throw new WorkflowValidationError(`workflow run ${runId} does not exist`);
  const card = workflowRunCardFor(run);
  const roles = card ? workflowRunRoleSessionIds(card) : [];
  const blocked = await runSettleBlockedReason(run, roles);
  if (blocked) throw new WorkflowValidationError(blocked);
  // `settleWorkflowRunRoleSessions` writes every role synchronously before its
  // first await, so nothing runs between these two lines and the run write.
  const broadcastRoles = settleWorkflowRunRoleSessions(roles);
  const settled = settleRun(runId, throughRevision) ?? run;
  await broadcastRoles;
  broadcastWorkflowRuns();
  return settled;
}
