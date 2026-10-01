import type {
  PullRequestCardAction,
  PullRequestMergeMethod,
  WorkflowActor,
} from "@assistant/shared";
import {
  getRun,
  latestStepForExecutor,
  listSteps,
  type WorkflowRunRow,
} from "../../db/workflowStore.ts";
import { defineAgentTool, jsonResult, type AgentTool } from "../../mcp/tool.ts";
import { pullRequestCardById } from "../../pullRequestCards.ts";
import { runPullRequestCardActionWithActor } from "../../pullRequestActions.ts";
import { workflowRunCardOf } from "../../workflow/cardProjection.ts";
import { mergeDecisionPayloadOf } from "../../workflow/codeDeliveryRecipe.ts";
import { cancelRun, resumeRun, retryRun } from "../../workflow/engine.ts";
import {
  cleanUpWorkflowRunCheckout,
  mergeWorkflowRunPullRequest,
} from "../../workflow/deliveryActions.ts";

const ACTIONS = [
  "resume",
  "retry",
  "merge",
  "mark-task-done",
  "cleanup",
  "cancel",
] as const;

type WorkflowGateAction = (typeof ACTIONS)[number];

interface Params extends Record<string, unknown> {
  action: WorkflowGateAction;
  mergeMethod?: PullRequestMergeMethod;
  deleteBranch?: boolean;
}

type CoordinatorUserActor = WorkflowActor & { kind: "user" };

interface Dependencies {
  resume(runId: number, actor: CoordinatorUserActor): Promise<void>;
  retry(runId: number, actor: CoordinatorUserActor): Promise<void>;
  cancel(runId: number, actor: CoordinatorUserActor): Promise<void>;
  runPullRequestAction(
    cardId: string,
    action: PullRequestCardAction,
    options: { mergeMethod?: PullRequestMergeMethod; deleteBranch?: boolean },
    actor: CoordinatorUserActor,
    actingSessionId: string,
  ): ReturnType<typeof runPullRequestCardActionWithActor>;
  mergeRun(
    runId: number,
    options: { mergeMethod: PullRequestMergeMethod; deleteBranch?: boolean },
    actor: CoordinatorUserActor,
    actingSessionId: string,
  ): Promise<string>;
  cleanUpRun(
    runId: number,
    actor: CoordinatorUserActor,
    actingSessionId: string,
  ): Promise<string>;
}

const defaultDependencies: Dependencies = {
  resume: resumeRun,
  retry: retryRun,
  cancel: cancelRun,
  runPullRequestAction: runPullRequestCardActionWithActor,
  mergeRun: mergeWorkflowRunPullRequest,
  cleanUpRun: cleanUpWorkflowRunCheckout,
};

export function workflowGateActionTools(
  dependencies: Dependencies = defaultDependencies,
): AgentTool[] {
  return [makeWorkflowGateActionTool(dependencies)];
}

function makeWorkflowGateActionTool(dependencies: Dependencies) {
  return defineAgentTool<Params>({
    name: "workflow_gate_action",
    label: "Workflow Gate Action",
    description:
      "Use one existing user-visible control for this coordinator session's Workflow Run. Call only when the user's current message unambiguously requests this exact action; ask instead of inferring. Cancel requires the user to say cancel. Before merge, cleanup, or cancel, tell the user exactly what will happen. Merge uses the card defaults (squash and delete the remote branch) unless the user chooses otherwise. Cleanup here retires the checkout only; the run keeps its own Settle in the inbox, since this session cannot acknowledge the run from inside its own turn. The server infers the run, refuses actions not offered in its actual state, and attributes recorded transitions to the user via this coordinator session.",
    searchHint:
      "workflow run resume retry merge mark task done cleanup cancel user decision gate control",
    executionMode: "sequential",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: ACTIONS },
        mergeMethod: {
          type: "string",
          enum: ["squash", "merge", "rebase"],
          default: "squash",
          description: "Merge only; defaults to the live card's squash choice.",
        },
        deleteBranch: {
          type: "boolean",
          default: true,
          description:
            "Merge only; the live card also deletes the remote branch unless the user opts out.",
        },
      },
    } as const,
    async execute(params, ctx) {
      if (ctx.session.agentType !== "workflow-coordinator")
        throw new Error(
          "workflow_gate_action is available only in a workflow coordinator session",
        );
      const assigned = latestStepForExecutor("session", ctx.session.sessionId);
      if (!assigned)
        throw new Error(
          "this coordinator session is not associated with a Workflow Run",
        );
      const run = getRun(assigned.runId);
      if (!run)
        throw new Error(
          "the Workflow Run for this coordinator session is missing",
        );
      const steps = listSteps(run.id);
      const card = workflowRunCardOf(run, steps);
      const mergeCardId = [...steps]
        .reverse()
        .map((step) => mergeDecisionPayloadOf(step)?.cardId)
        .find((cardId) => cardId !== undefined);
      const actor: CoordinatorUserActor = {
        kind: "user",
        id: `via coordinator session ${ctx.session.sessionId}`,
      };

      switch (params.action) {
        case "resume": {
          // The tool is an alias for controls the CARD offers, so it refuses
          // wherever the card would not render Resume: a run waiting at one of
          // its gates answers through that gate, and a pause the recipe
          // re-derives from the same history would only come straight back.
          if (!card.canResume)
            refuse(params.action, run, card.phase, card.nextAction);
          await dependencies.resume(run.id, actor);
          return actionResult(params.action, run, "resumed");
        }
        case "retry": {
          if (!card.canRetry)
            refuse(params.action, run, card.phase, card.nextAction);
          await dependencies.retry(run.id, actor);
          return actionResult(params.action, run, "retry started");
        }
        case "cancel": {
          if (run.lifecycle !== "active" && run.lifecycle !== "paused")
            refuse(params.action, run, card.phase, card.nextAction);
          await dependencies.cancel(run.id, actor);
          return actionResult(
            params.action,
            run,
            "cancelled; sessions, worktree, and pull request were preserved",
          );
        }
        // Merge and cleanup are the two controls the Task's Workflow card
        // carries as well, so both go through the one seam that owns their
        // refusals and their consequences. Cleanup from HERE is the seam's one
        // exception: this session is a role of the run it would acknowledge and
        // is streaming the turn making the call, so the run keeps its Settle —
        // the returned outcome says so, and the tool description promises it.
        case "merge": {
          const mergeMethod = params.mergeMethod ?? "squash";
          const deleteBranch = params.deleteBranch !== false;
          const outcome = await dependencies.mergeRun(
            run.id,
            { mergeMethod, deleteBranch },
            actor,
            ctx.session.sessionId,
          );
          return jsonResult({
            action: params.action,
            runId: String(run.id),
            outcome,
            mergeMethod,
            deleteBranch,
            followUps: followUps(
              requirePullRequestCard(
                card.pullRequest?.cardId ?? mergeCardId,
                params.action,
                run,
                card.phase,
                card.nextAction,
              ),
            ),
          });
        }
        case "cleanup": {
          const outcome = await dependencies.cleanUpRun(
            run.id,
            actor,
            ctx.session.sessionId,
          );
          return jsonResult({
            action: params.action,
            runId: String(run.id),
            outcome,
            followUps: followUps(
              requirePullRequestCard(
                card.pullRequest?.cardId ?? mergeCardId,
                params.action,
                run,
                card.phase,
                card.nextAction,
              ),
            ),
          });
        }
        case "mark-task-done": {
          if (run.lifecycle !== "completed" && run.lifecycle !== "cancelled")
            refuse(params.action, run, card.phase, card.nextAction);
          const pullRequest = requirePullRequestCard(
            card.pullRequest?.cardId ?? mergeCardId,
            params.action,
            run,
            card.phase,
            card.nextAction,
          );
          const result = await dependencies.runPullRequestAction(
            pullRequest.id,
            params.action,
            {},
            actor,
            ctx.session.sessionId,
          );
          return jsonResult({
            action: params.action,
            runId: String(run.id),
            outcome: result.card.actionMessage ?? `${params.action} completed`,
            followUps: followUps(result.card),
          });
        }
      }
    },
  });
}

function refuse(
  action: WorkflowGateAction,
  run: WorkflowRunRow,
  phase: string,
  nextAction: string,
): never {
  throw new Error(
    `cannot ${action}: workflow run ${run.id} is ${run.lifecycle} in phase ${phase}; recorded next action: ${nextAction}`,
  );
}

function requirePullRequestCard(
  cardId: string | undefined,
  action: WorkflowGateAction,
  run: WorkflowRunRow,
  phase: string,
  nextAction: string,
) {
  const card = cardId ? pullRequestCardById(cardId) : undefined;
  if (!card)
    throw new Error(
      `cannot ${action}: workflow run ${run.id} is ${run.lifecycle} in phase ${phase}, but ${cardId ? `pull request card ${cardId} is unavailable` : "no pull request card is recorded"}; recorded next action: ${nextAction}`,
    );
  return card;
}

function actionResult(
  action: WorkflowGateAction,
  run: WorkflowRunRow,
  outcome: string,
) {
  return jsonResult({ action, runId: String(run.id), outcome });
}

function followUps(card: NonNullable<ReturnType<typeof pullRequestCardById>>) {
  return [
    {
      action: "mark-task-done",
      available: Boolean(card.linkedTask && card.linkedTask.status !== "done"),
      description: card.linkedTask
        ? `Mark Task-${card.linkedTask.id} done`
        : "No linked Task is recorded",
    },
    {
      action: "cleanup",
      available: Boolean(card.worktreeId && !card.cleanedUp),
      description: card.cleanedUp
        ? "The worktree is already cleaned up"
        : card.worktreeId
          ? `Safely remove worktree ${card.worktreeId} and its contained branch`
          : "No active worktree is recorded",
    },
  ];
}
