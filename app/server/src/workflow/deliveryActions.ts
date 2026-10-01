/**
 * The two DELIVERY controls a finished-or-finishing run carries on its Task:
 * merge the pull request it published, and retire the checkout it worked in.
 *
 * Both already existed on the live `/pr` card, and both stay exactly that
 * action — this module adds no second merge and no second cleanup. What it adds
 * is a way to reach them from the RUN, so the Task's Workflow card is where the
 * whole delivery is finished: the run names its card, the run's own state says
 * whether the control may be offered, and the refusals are the run's, in the
 * run's words.
 *
 * Cleanup carries one thing the card's cleanup cannot know about: the run is
 * the Sessions inbox's attention owner (`docs/agent-workflows.md`), so retiring
 * its checkout normally finishes by SETTLING the run — otherwise the last click
 * of a delivery leaves an acknowledged run sitting in the inbox with nothing
 * left to do about it. That settlement is best-effort on purpose: the worktree
 * is gone by then, and reporting a finished cleanup as a failure because the
 * acknowledgement was refused would be a lie about work that landed.
 *
 * The coordinator's `workflow_gate_action` tool routes through here too, so the
 * two share one set of refusals and one set of consequences — with ONE stated
 * exception, which lives in {@link cleanUpWorkflowRunCheckout}: a cleanup run
 * by one of the run's own role sessions cannot settle the run, because it is
 * the session holding the turn that would have to be acknowledged.
 */
import { workflowRunRoleSessionIds } from "@assistant/shared";
import type {
  PullRequestMergeMethod,
  WorkflowActor,
  WorkflowRunCard,
  WorkflowRunDelivery,
} from "@assistant/shared";
import { getRun, listSteps, type WorkflowRunRow } from "../db/workflowStore.ts";
import { runPullRequestCardActionWithActor } from "../pullRequestActions.ts";
import { workflowRunCardFor, workflowRunDeliveryOf } from "../workflowRuns.ts";
import { mergeDecisionPayloadOf } from "./codeDeliveryRecipe.ts";
import { settleWorkflowRun } from "./runSettlement.ts";

/** The attribution every control here records; a run control is always a user's. */
export type WorkflowUserActor = WorkflowActor & { kind: "user" };

/**
 * A refusal raised BEFORE the pull-request card was touched: a stale gate, a
 * run this build cannot project, a missing card.
 *
 * The distinction is what lets the caller stay quiet about the other kind. Once
 * the card seam has run, a failure is written to the card as `actionError` and
 * reaches the Task on the card's own delivery projection, where the button is;
 * saying it a second time in a Task-level note would be the duplicate
 * `docs/messaging.md` exists to prevent. Nothing reports THIS one, so it has to
 * be recognisable.
 */
export class WorkflowDeliveryRefusal extends Error {}

export interface WorkflowMergeOptions {
  mergeMethod: PullRequestMergeMethod;
  /** Omitted or true deletes the remote head branch with the merge. */
  deleteBranch?: boolean;
}

interface Dependencies {
  runPullRequestAction: typeof runPullRequestCardActionWithActor;
  settleRun: typeof settleWorkflowRun;
}

const defaultDependencies: Dependencies = {
  runPullRequestAction: runPullRequestCardActionWithActor,
  settleRun: settleWorkflowRun,
};

/* -------------------------------- actions --------------------------------- */

/**
 * Merge the pull request the run published, from the run's own merge seam.
 *
 * The refusal is checked against the SAME projection the Task rendered, so a
 * click on a stale card is turned away here rather than merging a run that has
 * since been superseded, cancelled or moved past its gate.
 */
export async function mergeWorkflowRunPullRequest(
  runId: number,
  options: WorkflowMergeOptions,
  actor: WorkflowUserActor,
  actingSessionId?: string,
  dependencies: Dependencies = defaultDependencies,
): Promise<string> {
  const { run, card, delivery } = requireDelivery(runId, "merge");
  if (!delivery.canMerge) refuse("merge", run, card);
  const cardId = requirePullRequestCardId(run, card, "merge");
  const result = await dependencies.runPullRequestAction(
    cardId,
    "merge",
    {
      mergeMethod: options.mergeMethod,
      ...(options.deleteBranch === false ? { deleteBranch: false } : {}),
    },
    actor,
    actingSessionId,
  );
  return result.card.actionMessage ?? "Pull request merged.";
}

/**
 * Retire the run's checkout and then acknowledge the run itself.
 *
 * Order matters and is the whole point: the cleanup settles every session on
 * the worktree, which is what makes the run's own settlement possible — a role
 * still up would block it.
 *
 * ONE case skips the settlement instead of attempting it: a cleanup run BY one
 * of the run's own role sessions, which is how the coordinator's
 * `workflow_gate_action` reaches this. That session is streaming its own tool
 * turn, so `settleWorkflowRun` would refuse on it every single time — and it is
 * right to: the turn still has an outcome to produce, and a run acknowledged
 * before it lands would have that role resurface as a card of its own moments
 * later. So the run keeps its own Settle there, and the outcome says so rather
 * than reporting a refusal the caller could never have avoided.
 *
 * Every other refusal is REPORTED rather than thrown: the checkout is gone
 * either way, so failing the whole action would claim work that landed did not.
 * The returned sentence is for the CALLER — the coordinator tool tells its
 * agent what happened with it — and nothing is written back to the card. A user
 * who clicked a button promising to settle the run learns that it did not from
 * `settleStillNeeded`, which the projection derives live from the run's own
 * attention cursor; a remembered sentence would still be telling them to go and
 * settle a run they settled an hour ago.
 */
export async function cleanUpWorkflowRunCheckout(
  runId: number,
  actor: WorkflowUserActor,
  actingSessionId?: string,
  dependencies: Dependencies = defaultDependencies,
): Promise<string> {
  const { run, card, delivery } = requireDelivery(runId, "clean up");
  if (!delivery.canCleanUp) refuse("clean up", run, card);
  const cardId = requirePullRequestCardId(run, card, "clean up");
  const actingRole =
    actingSessionId !== undefined &&
    workflowRunRoleSessionIds(card).includes(actingSessionId);
  const result = await dependencies.runPullRequestAction(
    cardId,
    "cleanup",
    {},
    actor,
    actingSessionId,
  );
  const cleaned = result.card.actionMessage ?? "Removed the worktree.";
  const settlement = actingRole
    ? "This session is one of the run's own, so the run keeps its Settle in the Sessions inbox."
    : await settleRunAfterCleanup(runId, run, dependencies);
  return settlement === null
    ? `${cleaned} The workflow run is settled.`
    : `${cleaned} ${settlement}`;
}

/** `null` when the run was settled, else what to say about why it was not. */
async function settleRunAfterCleanup(
  runId: number,
  run: WorkflowRunRow,
  dependencies: Dependencies,
): Promise<string | null> {
  try {
    // Through the run's CURRENT revision: the user just finished the delivery
    // this run exists for, so there is no earlier state their click could have
    // been about. `settleWorkflowRun` broadcasts the run list, which is also
    // what refreshes the delivery projection this cleanup just changed.
    await dependencies.settleRun(runId, run.attention?.revision ?? 0);
    return null;
  } catch (err) {
    return `The run itself could not be settled yet: ${
      err instanceof Error ? err.message : String(err)
    } It keeps its Settle in the Sessions inbox.`;
  }
}

/* -------------------------------- helpers --------------------------------- */

/** The run, its card and its delivery state, or the refusal that replaces them. */
function requireDelivery(
  runId: number,
  verb: string,
): {
  run: WorkflowRunRow;
  card: WorkflowRunCard;
  delivery: WorkflowRunDelivery;
} {
  const run = getRun(runId);
  if (!run)
    throw new WorkflowDeliveryRefusal(
      `cannot ${verb}: workflow run ${runId} is missing`,
    );
  const card = workflowRunCardFor(run);
  if (!card)
    throw new WorkflowDeliveryRefusal(
      `cannot ${verb}: this build cannot project a card for workflow run ${runId}`,
    );
  const delivery = workflowRunDeliveryOf(run, card);
  if (!delivery)
    throw new WorkflowDeliveryRefusal(
      `cannot ${verb}: workflow run ${runId} has no live pull request card`,
    );
  return { run, card, delivery };
}

function requirePullRequestCardId(
  run: WorkflowRunRow,
  card: WorkflowRunCard,
  verb: string,
): string {
  const cardId =
    card.pullRequest?.cardId ??
    [...listSteps(run.id)]
      .reverse()
      .map((step) => mergeDecisionPayloadOf(step)?.cardId)
      .find((id) => id !== undefined);
  if (!cardId)
    throw new WorkflowDeliveryRefusal(
      `cannot ${verb}: no pull request card is recorded for workflow run ${run.id}`,
    );
  return cardId;
}

function refuse(
  verb: string,
  run: WorkflowRunRow,
  card: WorkflowRunCard,
): never {
  throw new WorkflowDeliveryRefusal(
    `cannot ${verb}: workflow run ${run.id} is ${run.lifecycle} in phase ${card.phase}; recorded next action: ${card.nextAction}`,
  );
}
