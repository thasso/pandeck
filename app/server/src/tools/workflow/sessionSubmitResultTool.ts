import {
  WORKFLOW_PAYLOAD_MAX_CHARS,
  WORKFLOW_SUMMARY_MAX_CHARS,
  type WorkflowJsonValue,
  type WorkflowResultStatus,
} from "@assistant/shared";
import {
  completeStep,
  getRun,
  openStepForExecutor,
} from "../../db/workflowStore.ts";
import { errorText } from "../../errors.ts";
import { defineAgentTool, type AgentTool } from "../../mcp/tool.ts";
import { advanceRun } from "../../workflow/engine.ts";
import { resultContractIdOf } from "../../workflow/executors.ts";
import { finalizeOperationTriage } from "../../workflow/operationTriage.ts";
import { finalizeRebaseRepair } from "../../workflow/rebaseRepair.ts";
import {
  getResultContract,
  WORK_PLAN_CONTRACT_ID,
  type WorkComplexity,
} from "../../workflow/resultContracts.ts";
import { withReviewSetEvidence } from "../../workflow/reviewSets.ts";
import { startingCeilingUpdateForPlan } from "../../workflow/runStart.ts";
import { broadcastWorkflowRuns } from "../../workflowRuns.ts";

type SubmitResultParams = {
  status?: string;
  summary?: string;
  payload?: unknown;
};

export function sessionSubmitResultTools(): AgentTool[] {
  return [makeSessionSubmitResultTool()];
}

function makeSessionSubmitResultTool() {
  return defineAgentTool<SubmitResultParams>({
    name: "session_submit_result",
    label: "Submit Workflow Result",
    description:
      "Finish the active Workflow Run step assigned to this session. The server infers the run, step, and registered result contract from your assignment; never supply ids or an inline schema. Submit completed only with a payload matching that contract. Submit blocked or failed with evidence in summary and no payload. A rejected submission leaves the step running so you can correct it and try again. Never finish an assignment by going idle without calling this tool.",
    searchHint:
      "workflow assignment finish complete blocked failed structured result assessment implementation",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["status", "summary"],
      properties: {
        status: {
          type: "string",
          enum: ["completed", "blocked", "failed"],
          description: "The terminal outcome of this assignment.",
        },
        summary: {
          type: "string",
          description: `A concise human-readable outcome or blocking/failure evidence. Maximum ${WORKFLOW_SUMMARY_MAX_CHARS} characters; longer text is bounded by the store.`,
        },
        payload: {
          type: "object",
          description: `The assignment's registered contract payload. Required for completed; forbidden for blocked/failed. JSON metadata is limited to ${WORKFLOW_PAYLOAD_MAX_CHARS} characters.`,
        },
      },
    } as const,
    async execute(params, ctx) {
      const sessionId = ctx.session.sessionId;
      const step = openStepForExecutor("session", sessionId);
      if (!step)
        throw new Error(
          "this session holds no active workflow step assignment",
        );

      const status = resultStatus(params.status);
      const summary = requiredSummary(params.summary);
      const contractId = resultContractIdOf(step);
      const contract = contractId ? getResultContract(contractId) : undefined;
      if (!contract)
        throw new Error(
          `workflow step ${step.id} has no registered result contract`,
        );

      let payload: WorkflowJsonValue | undefined;
      if (status === "completed") {
        if (!isObject(params.payload))
          throw new Error(
            `completed workflow result requires payload matching ${contract.describe}`,
          );
        if (!contract.validate(params.payload))
          throw new Error(
            `workflow result payload must match ${contract.describe}`,
          );
        payload = params.payload as WorkflowJsonValue;
      } else if (params.payload !== undefined) {
        throw new Error(`${status} workflow result must not include payload`);
      }

      const run = getRun(step.runId);
      if (!run) throw new Error(`workflow run ${step.runId} does not exist`);
      const safety = await finalizeRebaseRepair(run, step, status);
      const triageSafety = await finalizeOperationTriage(run, step, status);
      // Review-set publication and read-back happen HERE, before the step
      // becomes terminal: a result is written once, so the ids the reviewer's
      // set was published under have to be part of it (`workflow/reviewSets.ts`).
      const reviewed =
        payload === undefined
          ? undefined
          : await withReviewSetEvidence(
              run,
              step,
              contract.id,
              payload,
              summary,
            );
      const hostSafety =
        safety || triageSafety
          ? ({
              ...(safety ? { rebaseRepairSafety: safety } : {}),
              ...(triageSafety ? { operationTriageSafety: triageSafety } : {}),
            } as WorkflowJsonValue)
          : undefined;
      const resultPayload = reviewed ?? hostSafety;
      const actor = { kind: "agent" as const, id: sessionId };
      const startingCeilings =
        status === "completed" &&
        contract.id === WORK_PLAN_CONTRACT_ID &&
        isObject(payload) &&
        typeof payload.complexity === "string"
          ? startingCeilingUpdateForPlan(
              run,
              payload.complexity as WorkComplexity,
            )
          : undefined;
      completeStep(step.id, {
        status,
        ...(startingCeilings ? { raiseCeilings: startingCeilings } : {}),
        result: {
          status,
          summary,
          contractId: contract.id,
          ...(resultPayload !== undefined ? { payload: resultPayload } : {}),
        },
        actor,
      });
      // A paused run's advance intentionally broadcasts nothing, so publish the
      // immutable result before kicking the next (possibly long) step loose.
      broadcastWorkflowRuns();
      // The result is already durable, so the advance is deliberately not
      // awaited — but a rejection is nobody else's to see: the engine pauses
      // the run on anything it cannot act on, and whatever still escapes that
      // is logged here rather than disappearing into the void.
      void advanceRun(step.runId, actor).catch((err: unknown) =>
        console.error(
          `[workflow] advancing run ${step.runId} after step ${step.id} failed:`,
          errorText(err),
        ),
      );

      const confirmation = {
        runId: step.runId,
        stepId: step.id,
        status,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(confirmation) }],
        details: confirmation,
      };
    },
  });
}

function resultStatus(value: unknown): WorkflowResultStatus {
  if (value === "completed" || value === "blocked" || value === "failed")
    return value;
  throw new Error('status must be "completed", "blocked", or "failed"');
}

function requiredSummary(value: unknown): string {
  const summary = typeof value === "string" ? value.trim() : "";
  if (!summary) throw new Error("summary is required");
  return summary;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
