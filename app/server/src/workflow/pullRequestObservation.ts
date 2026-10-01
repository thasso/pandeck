import type {
  PullRequestCard,
  PullRequestMergeMethod,
  WorkflowActor,
} from "@assistant/shared";
import {
  appendStep,
  completeStep,
  getRun,
  getStep,
  listOpenSteps,
  listRuns,
  listSteps,
  setRunLifecycle,
  startStep,
  type WorkflowRunRow,
  type WorkflowStepRow,
} from "../db/workflowStore.ts";
import { pullRequestCardRecord } from "../pullRequestCards.ts";
import {
  sendWebPushNotification,
  workflowRunAttentionNotification,
  type AppWebPushNotification,
} from "../webPush.ts";
import { advanceRun, pauseRun } from "./engine.ts";
import {
  registerWorkflowWaitExecutor,
  type WorkflowStepContext,
  type WorkflowWaitExecutor,
} from "./executors.ts";
import {
  mergeDecisionPayloadOf,
  pullRequestObservationPauseReason,
  type MergeDecisionResult,
  type MergeDecisionSupersessionResult,
  type PullRequestObservationStepPayload,
} from "./codeDeliveryRecipe.ts";
import {
  PULL_REQUEST_OBSERVATION_RESULT_CONTRACT_ID,
  type PullRequestObservationResult,
} from "./resultContracts.ts";

export const PULL_REQUEST_OBSERVER_EXECUTOR_ID = "pull-request-observer";
const EXTERNAL_ACTOR: WorkflowActor = {
  kind: "external",
  id: "git-hosting",
};

interface PullRequestSnapshot {
  card: PullRequestCard;
  headSha?: string;
}

export interface WorkflowPullRequestObservation {
  settled: number;
  /** A workflow-specific push replaced the generic CI-conclusion push. */
  suppressCiNotification: boolean;
}

type NotifySender = (notification: AppWebPushNotification) => Promise<void>;
let notify: NotifySender = sendWebPushNotification;

export function setWorkflowObservationNotifierForTests(
  sender: NotifySender | null,
): void {
  notify = sender ?? sendWebPushNotification;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function waitPayload(
  step: WorkflowStepRow,
): PullRequestObservationStepPayload | undefined {
  if (step.kind !== "wait") return undefined;
  const payload = record(step.payload);
  return payload.condition === "pull-request-ready" &&
    typeof payload.cardId === "string" &&
    typeof payload.reviewedHeadCommit === "string"
    ? (payload as PullRequestObservationStepPayload)
    : undefined;
}

/** Pure interpretation of one live-card snapshot for an exact reviewed head. */
export function evaluatePullRequestObservation(
  payload: PullRequestObservationStepPayload,
  snapshot: PullRequestSnapshot,
): PullRequestObservationResult | undefined {
  const { card, headSha } = snapshot;
  if (!headSha) return undefined;
  // A merged PR is the run's observed completion condition. Record it even if
  // the provider says the final head differs from the reviewed head: the run
  // must not stay permanently open after its delivery object has merged.
  if (card.status === "merged")
    return {
      outcome: "merged",
      headCommit: headSha,
      reason: `pull request #${card.number ?? "?"} merged while the workflow was waiting`,
    };
  if (headSha !== payload.reviewedHeadCommit)
    return {
      outcome: "head-changed",
      headCommit: headSha,
      reason: `pull request #${card.number ?? "?"} head ${headSha} no longer equals reviewed head ${payload.reviewedHeadCommit}; commit/sync and review are required again`,
    };
  if (card.status === "closed")
    return {
      outcome: "closed",
      headCommit: headSha,
      reason: `pull request #${card.number ?? "?"} was closed without merging`,
    };
  if (card.status !== "open") return undefined;
  // POSITIVE evidence only, and `mergeable === false` is not it: the card sets
  // `conflicts` once a conflicting read has been CONFIRMED (a second read of
  // the same head, or a refused merge), and a draft's mergeability says nothing
  // at all — Forgejo reports every WIP pull request as not mergeable. Pausing a
  // run is terminal for its wait step, so a first `false` must mean "ask
  // again": a draft-era value latched at publish paused run 78 on a conflict
  // that never existed (Task 535).
  if (card.conflicts && !card.draft)
    return {
      outcome: "base-conflict",
      headCommit: headSha,
      reason: `pull request #${card.number ?? "?"} conflicts with its base; choose rebase and re-review to attempt a clean deterministic rebase`,
    };
  if (card.review?.changesRequested)
    return {
      outcome: "changes-requested",
      headCommit: headSha,
      reason: `hosted review requested changes on pull request #${card.number ?? "?"}`,
    };
  if (card.ci?.state === "failure" || card.ci?.state === "error")
    return {
      outcome: "ci-failure",
      headCommit: headSha,
      reason: `CI ${card.ci.state === "error" ? "errored" : "failed"} for reviewed head ${headSha} on pull request #${card.number ?? "?"}`,
    };
  if (
    card.ci?.state === "success" &&
    card.mergeable === true &&
    card.review?.changesRequested === false &&
    // A draft is not offered for merge either: both providers refuse it, and
    // publication is what clears this flag.
    !card.draft
  )
    return { outcome: "ready", headCommit: headSha };
  return undefined;
}

function snapshotFromStoredCard(
  cardId: string,
): PullRequestSnapshot | undefined {
  const stored = pullRequestCardRecord(cardId);
  if (!stored) return undefined;
  return {
    card: stored.card,
    ...(stored.context.observedHeadSha
      ? { headSha: stored.context.observedHeadSha }
      : {}),
  };
}

async function settleWait(
  run: WorkflowRunRow,
  step: WorkflowStepRow,
  snapshot: PullRequestSnapshot,
  advanceAfter: boolean,
): Promise<boolean> {
  const payload = waitPayload(step);
  if (!payload) return false;
  const result = evaluatePullRequestObservation(payload, snapshot);
  if (!result) return false;
  const current = getStep(step.id);
  if (!current || current.status !== "running") return false;

  completeStep(step.id, {
    status: "completed",
    result: {
      status: "completed",
      summary: pullRequestObservationPauseReason(result),
      contractId: PULL_REQUEST_OBSERVATION_RESULT_CONTRACT_ID,
      payload: result,
    },
    observationDetail: {
      cardId: payload.cardId,
      outcome: result.outcome,
      headCommit: result.headCommit,
      ci: snapshot.card.ci?.state ?? null,
      mergeable: snapshot.card.mergeable ?? null,
      changesRequested: snapshot.card.review?.changesRequested ?? null,
    },
    actor: EXTERNAL_ACTOR,
  });

  if (advanceAfter) {
    const wasPaused = getRun(run.id)?.lifecycle === "paused";
    // Merge completion is observed state, not new work. It therefore completes
    // even across an older manual pause; other conclusions keep the pause and
    // replace its reason with the newer attention evidence.
    if (wasPaused && result.outcome === "merged")
      setRunLifecycle(run.id, "active", { actor: EXTERNAL_ACTOR });
    await advanceRun(run.id, EXTERNAL_ACTOR);
    if (wasPaused && result.outcome !== "merged")
      pauseRun(
        run.id,
        pullRequestObservationPauseReason(result),
        EXTERNAL_ACTOR,
      );
  }

  if (result.outcome !== "merged")
    await notify(
      workflowRunAttentionNotification(run, snapshot.card, result),
    ).catch(() => undefined);
  return true;
}

interface RecordedMergeChoice {
  source: "app" | "hosting";
  mergeMethod?: PullRequestMergeMethod;
  deleteBranch?: boolean;
  actor?: WorkflowActor;
}

/** Finish the durable decision row, then let the recipe observe completion. */
async function settleMergeDecision(
  run: WorkflowRunRow,
  step: WorkflowStepRow,
  card: PullRequestCard,
  choice: RecordedMergeChoice,
): Promise<boolean> {
  const payload = mergeDecisionPayloadOf(step);
  if (!payload || payload.cardId !== card.id || card.status !== "merged")
    return false;
  const current = getStep(step.id);
  if (
    !current ||
    (current.status !== "pending" && current.status !== "running")
  )
    return false;

  const actor: WorkflowActor =
    choice.source === "app"
      ? (choice.actor ?? { kind: "user" })
      : EXTERNAL_ACTOR;
  if (current.status === "pending") {
    if (getRun(run.id)?.lifecycle === "paused")
      setRunLifecycle(run.id, "active", { actor });
    startStep(
      step.id,
      {
        kind: "operation",
        id:
          choice.source === "app"
            ? "pull-request-merge-action"
            : "pull-request-observer",
      },
      actor,
    );
  }
  const result: MergeDecisionResult = {
    choice: "merge",
    source: choice.source,
    ...(choice.mergeMethod ? { mergeMethod: choice.mergeMethod } : {}),
    ...(choice.deleteBranch !== undefined
      ? { deleteBranch: choice.deleteBranch }
      : {}),
  };
  completeStep(step.id, {
    status: "completed",
    result: {
      status: "completed",
      summary:
        choice.source === "app"
          ? `merged pull request #${card.number ?? "?"} with the existing merge action`
          : `observed pull request #${card.number ?? "?"} merged on the hosting provider`,
      payload: result,
    },
    observationDetail: {
      cardId: card.id,
      outcome: "merged",
      source: choice.source,
    },
    actor,
  });
  // Completion is caused by observing the merged PR, not merely by choosing a
  // method, including for the in-app action that produced this card update.
  if (getRun(run.id)?.lifecycle === "paused")
    setRunLifecycle(run.id, "active", { actor: EXTERNAL_ACTOR });
  await advanceRun(run.id, EXTERNAL_ACTOR);
  return true;
}

/** Replace an obsolete open merge choice with immutable provider evidence. */
async function settleSupersededMergeDecision(
  run: WorkflowRunRow,
  step: WorkflowStepRow,
  snapshot: PullRequestSnapshot,
): Promise<boolean> {
  const decision = mergeDecisionPayloadOf(step);
  if (!decision || decision.cardId !== snapshot.card.id) return false;
  const observation = evaluatePullRequestObservation(
    {
      condition: "pull-request-ready",
      cardId: decision.cardId,
      reviewedHeadCommit: decision.reviewedHeadCommit,
    },
    snapshot,
  );
  if (
    !observation ||
    observation.outcome === "ready" ||
    observation.outcome === "merged"
  )
    return false;
  const current = getStep(step.id);
  if (
    !current ||
    (current.status !== "pending" && current.status !== "running")
  )
    return false;

  if (getRun(run.id)?.lifecycle === "paused")
    setRunLifecycle(run.id, "active", { actor: EXTERNAL_ACTOR });
  if (current.status === "pending")
    startStep(
      step.id,
      { kind: "operation", id: PULL_REQUEST_OBSERVER_EXECUTOR_ID },
      EXTERNAL_ACTOR,
    );
  const result: MergeDecisionSupersessionResult = {
    supersededBy: "pull-request-observation",
    observation,
  };
  completeStep(step.id, {
    status: "completed",
    result: {
      status: "completed",
      summary: `merge decision superseded: ${pullRequestObservationPauseReason(observation)}`,
      payload: result,
    },
    observationDetail: {
      cardId: decision.cardId,
      outcome: observation.outcome,
      headCommit: observation.headCommit,
      supersededDecision: true,
    },
    actor: EXTERNAL_ACTOR,
  });
  // The recipe appends a fresh wait, whose executor consumes this same stored
  // snapshot and owns the ordinary pause reason and Web Push notification.
  await advanceRun(run.id, EXTERNAL_ACTOR);
  return true;
}

const pullRequestWaitExecutor: WorkflowWaitExecutor = {
  id: PULL_REQUEST_OBSERVER_EXECUTOR_ID,
  supports: (step) => waitPayload(step) !== undefined,
  async dispatch(context: WorkflowStepContext) {
    const payload = waitPayload(context.step);
    if (!payload) return;
    const snapshot = snapshotFromStoredCard(payload.cardId);
    if (snapshot) await settleWait(context.run, context.step, snapshot, false);
  },
};

export function registerPullRequestObservationRuntime(): void {
  registerWorkflowWaitExecutor(pullRequestWaitExecutor);
}

/**
 * Consume a merged card persisted just before a crash. Merged cards no longer
 * belong to the live-card poller, and paused runs are intentionally skipped by
 * generic workflow boot reconciliation, so this domain observer owns the seam.
 */
export async function reconcilePullRequestObservationsOnBoot(): Promise<void> {
  for (const run of listRuns({ lifecycles: ["active", "paused"] })) {
    for (const step of listOpenSteps(run.id)) {
      const wait = waitPayload(step);
      const decision = mergeDecisionPayloadOf(step);
      const cardId = wait?.cardId ?? decision?.cardId;
      if (!cardId) continue;
      const snapshot = snapshotFromStoredCard(cardId);
      if (!snapshot) continue;
      if (
        snapshot.card.status === "merged" &&
        step.status === "running" &&
        wait
      )
        await settleWait(run, step, snapshot, true);
      else if (
        snapshot.card.status === "merged" &&
        (step.status === "pending" || step.status === "running") &&
        decision
      )
        await settleMergeDecision(run, step, snapshot.card, {
          source: "hosting",
        });
      else if (decision)
        await settleSupersededMergeDecision(run, step, snapshot);
    }
  }
}

/**
 * Is a live workflow run currently parked on THIS card — a running observation
 * wait, or a merge decision a fresh observation could still supersede? The
 * watcher reads it to keep such a card on the fast cadence: the answer the run
 * is blocked on arrives only from its own next poll.
 */
export function workflowObservationArmedForCard(cardId: string): boolean {
  for (const run of listRuns({ lifecycles: ["active", "paused"] }))
    for (const step of listOpenSteps(run.id))
      if (
        waitPayload(step)?.cardId === cardId ||
        mergeDecisionPayloadOf(step)?.cardId === cardId
      )
        return true;
  return false;
}

/**
 * Feed the PR watcher's newest durable card snapshot into every matching wait.
 * The workflow's push is more specific than the generic CI-conclusion push, so
 * the watcher suppresses that generic notification when this settles a wait.
 */
export async function observePullRequestCardForWorkflows(
  card: PullRequestCard,
  headSha: string,
): Promise<WorkflowPullRequestObservation> {
  let settled = 0;
  for (const run of listRuns({ lifecycles: ["active", "paused"] })) {
    for (const step of listOpenSteps(run.id)) {
      const payload = waitPayload(step);
      if (
        step.status === "running" &&
        payload?.cardId === card.id &&
        (await settleWait(run, step, { card, headSha }, true))
      ) {
        settled += 1;
        continue;
      }
      if (
        card.status === "merged" &&
        (await settleMergeDecision(run, step, card, { source: "hosting" }))
      ) {
        settled += 1;
        continue;
      }
      if (
        mergeDecisionPayloadOf(step)?.cardId === card.id &&
        (await settleSupersededMergeDecision(run, step, { card, headSha }))
      )
        settled += 1;
    }
  }
  return { settled, suppressCiNotification: settled > 0 };
}

/**
 * Record a successful click from either existing merge surface. The merge has
 * already succeeded and projected the card to `merged`; workflow bookkeeping
 * is therefore best-effort and cannot turn that external success into a
 * reported merge failure.
 */
export function reviewedHeadForMergeDecision(
  cardId: string,
): string | undefined {
  const heads = new Set<string>();
  for (const run of listRuns({ lifecycles: ["active", "paused"] })) {
    const decision = [...listSteps(run.id)]
      .reverse()
      .map(mergeDecisionPayloadOf)
      .find((item) => item?.cardId === cardId);
    if (decision) heads.add(decision.reviewedHeadCommit);
  }
  if (heads.size > 1)
    throw new Error(
      `pull request card ${cardId} has merge decisions for different reviewed heads`,
    );
  return heads.values().next().value;
}

export async function recordPullRequestMergeForWorkflows(
  card: PullRequestCard,
  options: {
    mergeMethod: PullRequestMergeMethod;
    deleteBranch: boolean;
    expectedHeadCommit?: string;
    actor?: WorkflowActor;
  },
): Promise<number> {
  let settled = 0;
  for (const run of listRuns({ lifecycles: ["active", "paused"] })) {
    let settledRun = false;
    for (const step of listOpenSteps(run.id)) {
      const wait = waitPayload(step);
      if (wait?.cardId === card.id) {
        if (step.status === "pending") {
          if (getRun(run.id)?.lifecycle === "paused")
            setRunLifecycle(run.id, "active", { actor: EXTERNAL_ACTOR });
          startStep(
            step.id,
            { kind: "operation", id: PULL_REQUEST_OBSERVER_EXECUTOR_ID },
            EXTERNAL_ACTOR,
          );
        }
        const current = getStep(step.id);
        if (
          current?.status === "running" &&
          (await settleWait(
            run,
            current,
            {
              card,
              headSha: options.expectedHeadCommit ?? wait.reviewedHeadCommit,
            },
            true,
          ))
        ) {
          settled += 1;
          settledRun = true;
          continue;
        }
      }
      if (
        await settleMergeDecision(run, step, card, {
          source: "app",
          mergeMethod: options.mergeMethod,
          deleteBranch: options.deleteBranch,
          ...(options.actor ? { actor: options.actor } : {}),
        })
      ) {
        settled += 1;
        settledRun = true;
      }
    }
    if (settledRun || !options.expectedHeadCommit) continue;

    // A provider snapshot can supersede and settle the decision while its merge
    // request is already in flight. The provider's expected-head guard proves
    // the exact reviewed head merged; append one final merged observation so
    // append-only history reaches the same completion instead of staying on the
    // now-obsolete pause.
    const history = listSteps(run.id);
    const decision = [...history]
      .reverse()
      .map(mergeDecisionPayloadOf)
      .find(
        (item) =>
          item?.cardId === card.id &&
          item.reviewedHeadCommit === options.expectedHeadCommit,
      );
    const last = history.at(-1);
    if (!decision || !last || listOpenSteps(run.id).length > 0) continue;
    if (getRun(run.id)?.lifecycle === "paused")
      setRunLifecycle(run.id, "active", { actor: EXTERNAL_ACTOR });
    appendStep({
      runId: run.id,
      kind: "wait",
      payload: {
        condition: "pull-request-ready",
        cardId: card.id,
        reviewedHeadCommit: options.expectedHeadCommit,
      },
      predecessorId: last.id,
      actor: EXTERNAL_ACTOR,
    });
    await advanceRun(run.id, EXTERNAL_ACTOR);
    settled += 1;
  }
  return settled;
}
