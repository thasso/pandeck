/**
 * Workflow Run projection and broadcaster seam (`docs/agent-workflows.md`,
 * Task 364).
 *
 * The single mapping from the store's rows to the wire model, plus the seam the
 * hub installs so the runtime can push the `workflow` topic without importing
 * it. The runtime engine, its recipes, and the agent tools stay independent of
 * the session hub; a caller with no live hub (a unit test, a one-shot CLI) just
 * broadcasts into the default no-op.
 *
 * Projection only — no transitions. The list's card data is the recipe's pure
 * projection of persisted history, plus the one cross-domain join this seam
 * owns ({@link workflowRunDeliveryOf}); mutations remain the engine's
 * responsibility.
 */
import { pendingWorkflowRunAttention } from "@assistant/shared";
import type {
  ServerMessage,
  WorkflowRunCard,
  WorkflowRunDelivery,
  WorkflowRunSummary,
} from "@assistant/shared";
import {
  listRuns,
  listSteps,
  type WorkflowRunRow,
} from "./db/workflowStore.ts";
import { pullRequestCardForProjection } from "./pullRequestCards.ts";
import { worktreeIdForSession } from "./db/worktreeStore.ts";
import {
  canProjectWorkflowRunCard,
  workflowRunCardOf,
} from "./workflow/cardProjection.ts";

export interface WorkflowBroadcaster {
  /** Deliver to the connections currently showing runs (topic `workflow`). */
  broadcast(message: ServerMessage): void;
}

let broadcaster: WorkflowBroadcaster = {
  broadcast: () => {
    // Unit tests and one-shot callers may run without a live hub.
  },
};

export function setWorkflowBroadcaster(next: WorkflowBroadcaster): void {
  broadcaster = next;
}

/** Row → wire. Ids are strings on the wire, as every other object's are. */
export function workflowRunSummaryOf(row: WorkflowRunRow): WorkflowRunSummary {
  return {
    id: String(row.id),
    taskId: String(row.taskId),
    ...(row.projectId ? { projectId: row.projectId } : {}),
    recipeId: row.recipeId,
    recipeVersion: row.recipeVersion,
    ...(row.worktreeId ? { worktreeId: row.worktreeId } : {}),
    ...(row.branch ? { branch: row.branch } : {}),
    lifecycle: row.lifecycle,
    ...(row.lifecycleReason ? { lifecycleReason: row.lifecycleReason } : {}),
    limits: {
      maxIterations: row.maxIterations,
      maxReviewPasses: row.maxReviewPasses,
    },
    ...(row.config !== undefined ? { config: row.config } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.endedAt ? { endedAt: row.endedAt } : {}),
    ...(row.attention ? { attention: row.attention } : {}),
  };
}

/**
 * The recipe's card for this run, when the server can project one. Terminal
 * runs are projected too: a finished run's role membership has to stay
 * structurally known while its outcome is unacknowledged (Task-677), and the
 * Task page shows a completed run's review evidence from the same card.
 */
export function workflowRunCardFor(
  row: WorkflowRunRow,
): WorkflowRunCard | undefined {
  if (!canProjectWorkflowRunCard(row)) return undefined;
  const card = workflowRunCardOf(row, listSteps(row.id));
  const delivery = workflowRunDeliveryOf(row, card);
  return delivery && card.pullRequest
    ? { ...card, pullRequest: { ...card.pullRequest, delivery } }
    : card;
}

/**
 * What the run's live `/pr` card says about the two DELIVERY controls the Task
 * carries, joined here rather than in the recipe's projection: the recipe reads
 * the run's own append-only history and nothing else, and this is a read across
 * domains — the one place a Workflow card looks at a pull-request card.
 *
 * `canMerge` follows the RUN and the CARD together. The merge seam is a
 * persisted user-decision step and `mergeDecisionReady` is exactly "that step
 * is open" — but the card must still be OPEN, because that is what `mergeCard`
 * requires and the two are not the same instant: a merge landing at the
 * provider marks the card `merged` while the run stays paused until its
 * observation completes it. Offering Merge in that window would render a button
 * whose only outcome is "there is nothing to merge". Nothing about CI or
 * mergeability is re-judged here, though: a run does not reach the seam until
 * they are known good, and the merge call re-verifies the head anyway.
 *
 * `canCleanUp` follows the CARD, because a checkout is retired on the evidence
 * that its work landed: the pull request merged, a worktree still resolvable,
 * and it has not been removed already. A cancelled run is not offered this one
 * — it has its own delete action, which is about discarding work rather than
 * finishing it.
 *
 * The worktree is resolved exactly as `pullRequestActions.ts`'s `requireWorktree`
 * does — the card's own id first, the card SESSION's as the fallback — and
 * never from the run row: a run whose worktree edge differs from the card's
 * would otherwise offer a cleanup the action refuses, or hide one it would
 * happily perform.
 */
export function workflowRunDeliveryOf(
  row: WorkflowRunRow,
  card: WorkflowRunCard,
): WorkflowRunDelivery | undefined {
  // One indexed row per run: each run names its own card.
  const pullRequest = card.pullRequest
    ? pullRequestCardForProjection(card.pullRequest.cardId)
    : undefined;
  if (!pullRequest) return undefined;
  const capabilities = pullRequest.repositoryCapabilities;
  return {
    canMerge:
      card.mergeDecisionReady &&
      row.lifecycle === "paused" &&
      pullRequest.status === "open",
    canCleanUp:
      row.lifecycle === "completed" &&
      pullRequest.status === "merged" &&
      !pullRequest.cleanedUp &&
      Boolean(
        pullRequest.worktreeId ?? worktreeIdForSession(pullRequest.sessionId),
      ),
    ...(capabilities?.mergeMethods
      ? { mergeMethods: capabilities.mergeMethods }
      : {}),
    ...(capabilities?.defaultMergeMethod
      ? { defaultMergeMethod: capabilities.defaultMergeMethod }
      : {}),
    ...(pullRequest.busyAction ? { busyAction: pullRequest.busyAction } : {}),
    ...(pullRequest.cleanedUp ? { cleanedUp: true } : {}),
    // The SAME predicate the Sessions inbox decides membership with, so the
    // Task cannot claim a run still needs settling after the inbox has let it
    // go — or stay silent while it sits there.
    settleStillNeeded:
      pullRequest.cleanedUp === true &&
      pendingWorkflowRunAttention(row.attention) !== undefined,
    ...(pullRequest.actionError ? { error: pullRequest.actionError } : {}),
  };
}

/** The snapshot a subscribe answers with, and the broadcast after a change. */
export function workflowRunListMessage(): ServerMessage {
  const rows = listRuns();
  const cards: Record<string, WorkflowRunCard> = {};
  for (const row of rows) {
    const card = workflowRunCardFor(row);
    if (card) cards[String(row.id)] = card;
  }
  return {
    type: "workflowRunList",
    runs: rows.map(workflowRunSummaryOf),
    cards,
    updatedAt: Date.now(),
  };
}

/** Push the authoritative run list so every connected surface converges. */
export function broadcastWorkflowRuns(): void {
  broadcaster.broadcast(workflowRunListMessage());
}
