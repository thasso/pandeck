import type { WorkflowJsonValue } from "@assistant/shared";
import {
  getRun,
  latestStepForExecutor,
  listSteps,
  type WorkflowStepRow,
} from "../../db/workflowStore.ts";
import { defineAgentTool, jsonResult, type AgentTool } from "../../mcp/tool.ts";
import { pullRequestCardById } from "../../pullRequestCards.ts";
import { sessionsUsed } from "../../workflow/codeDeliveryRecipe.ts";
import {
  boundedWorkflowProjectionText,
  workflowRunCardOf,
  WORKFLOW_PROJECTION_MAX_LIST_ITEMS,
} from "../../workflow/cardProjection.ts";

type BoundedValue = { value: WorkflowJsonValue; truncated: boolean };

export function workflowStatusTools(): AgentTool[] {
  return [makeWorkflowStatusTool()];
}

function makeWorkflowStatusTool() {
  return defineAgentTool<Record<string, never>>({
    name: "workflow_status",
    label: "Workflow Status",
    description:
      "Read the Workflow Run recorded for this coordinator session. The server infers the run; supply no ids. Returns lifecycle and pause evidence, limit consumption, bounded step results, role session references, pull-request observation state, and the recipe-derived next wait. Read-only: it cannot change or advance the run.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    } as const,
    async execute(_params, ctx) {
      if (ctx.session.agentType !== "workflow-coordinator")
        throw new Error(
          "workflow_status is available only in a workflow coordinator session",
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
      const history = steps.slice(-WORKFLOW_PROJECTION_MAX_LIST_ITEMS);
      const latest = steps[steps.length - 1];
      const pullRequestCard = card.pullRequest
        ? pullRequestCardById(card.pullRequest.cardId)
        : undefined;

      return jsonResult({
        run: {
          id: String(run.id),
          taskId: String(run.taskId),
          recipe: `${run.recipeId}@${run.recipeVersion}`,
          lifecycle: run.lifecycle,
          ...(run.lifecycle === "paused"
            ? { pauseReason: run.lifecycleReason ?? "Pause reason unavailable" }
            : {}),
          repeatedAttempts: card.repeatedAttempts ?? 1,
          current: latest
            ? {
                stepId: String(latest.id),
                phase: card.phase,
                kind: latest.kind,
                status: latest.status,
              }
            : { phase: card.phase, status: "not-started" },
          waitingOn: card.nextAction,
        },
        limits: {
          iterations: {
            used: card.iterationsUsed,
            maximum: run.maxIterations,
          },
          reviewPasses: {
            used: latestReviewPass(steps),
            maximum: run.maxReviewPasses,
          },
          // Sessions are DERIVED from the ceilings, so the run reports what
          // it has spent rather than a number it was allowed to spend.
          sessions: { used: sessionsUsed(steps) },
        },
        sessions: {
          ...(card.coordinatorSessionId
            ? { coordinator: card.coordinatorSessionId }
            : {}),
          ...(card.implementerSessionId
            ? { implementer: card.implementerSessionId }
            : {}),
          reviewers: card.reviewerSessions ?? [],
        },
        steps: {
          items: history.map(stepStatusOf),
          truncated: history.length !== steps.length,
          ...(history.length !== steps.length
            ? { omittedEarlier: steps.length - history.length }
            : {}),
        },
        ...(card.pullRequest
          ? {
              pullRequest: {
                ...card.pullRequest,
                observed: pullRequestCard
                  ? {
                      available: true,
                      status: pullRequestCard.status,
                      ...(pullRequestCard.ci ? { ci: pullRequestCard.ci } : {}),
                      ...(pullRequestCard.review
                        ? { review: pullRequestCard.review }
                        : {}),
                      ...(pullRequestCard.mergeable !== undefined
                        ? { mergeable: pullRequestCard.mergeable }
                        : {}),
                      ...(pullRequestCard.conflicts !== undefined
                        ? { conflicts: pullRequestCard.conflicts }
                        : {}),
                      ...(pullRequestCard.draft !== undefined
                        ? { draft: pullRequestCard.draft }
                        : {}),
                      updatedAt: pullRequestCard.updatedAt,
                    }
                  : {
                      available: false,
                      reason: "The recorded pull-request card is unavailable",
                    },
              },
            }
          : {}),
      });
    },
  });
}

function latestReviewPass(steps: readonly WorkflowStepRow[]): number {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const payload = objectValue(steps[index]!.payload);
    if (payload.role !== "reviewer") continue;
    const pass = payload.reviewPass;
    return typeof pass === "number" && Number.isInteger(pass) && pass > 0
      ? pass
      : 1;
  }
  return 0;
}

function stepStatusOf(step: WorkflowStepRow) {
  const summary = step.result?.summary;
  const payload =
    step.result?.payload === undefined
      ? undefined
      : boundedValue(step.result.payload);
  const summaryTruncated =
    summary !== undefined && boundedWorkflowProjectionText(summary) !== summary;
  return {
    id: String(step.id),
    kind: step.kind,
    status: step.status,
    attempt: step.attempt,
    ...(step.executor ? { executor: step.executor } : {}),
    ...(step.result
      ? {
          result: {
            status: step.result.status,
            ...(summary
              ? { summary: boundedWorkflowProjectionText(summary) }
              : {}),
            ...(step.result.contractId
              ? { contractId: step.result.contractId }
              : {}),
            ...(payload ? { payload: payload.value } : {}),
            ...(summaryTruncated || payload?.truncated
              ? { truncated: true }
              : {}),
          },
        }
      : {}),
  };
}

function boundedValue(value: WorkflowJsonValue, depth = 0): BoundedValue {
  if (typeof value === "string") {
    const bounded = boundedWorkflowProjectionText(value);
    return { value: bounded, truncated: bounded !== value };
  }
  if (value === null || typeof value !== "object")
    return { value, truncated: false };
  if (depth >= 8)
    return { value: "[shortened: nesting limit]", truncated: true };
  if (Array.isArray(value)) {
    const items = value
      .slice(0, WORKFLOW_PROJECTION_MAX_LIST_ITEMS)
      .map((item) => boundedValue(item, depth + 1));
    return {
      value: items.map((item) => item.value),
      truncated:
        value.length > WORKFLOW_PROJECTION_MAX_LIST_ITEMS ||
        items.some((item) => item.truncated),
    };
  }
  const entries = Object.entries(value);
  const kept = entries
    .slice(0, WORKFLOW_PROJECTION_MAX_LIST_ITEMS)
    .map(([key, item]) => [key, boundedValue(item, depth + 1)] as const);
  return {
    value: Object.fromEntries(kept.map(([key, item]) => [key, item.value])),
    truncated:
      entries.length > WORKFLOW_PROJECTION_MAX_LIST_ITEMS ||
      kept.some(([, item]) => item.truncated),
  };
}

function objectValue(
  value: WorkflowJsonValue,
): Record<string, WorkflowJsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : {};
}
