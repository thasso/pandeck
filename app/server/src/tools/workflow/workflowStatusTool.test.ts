import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, test } from "vitest";
import type { WorkflowActor, WorkflowJsonValue } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "workflow-status-tool-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const store = await import("../../db/workflowStore.ts");
const recipe = await import("../../workflow/codeDeliveryRecipe.ts");
const contracts = await import("../../workflow/resultContracts.ts");
const { workflowStatusTools } = await import("./workflowStatusTool.ts");
const { closeDb } = await import("../../db/index.ts");

const ACTOR: WorkflowActor = { kind: "system" };
const tool = workflowStatusTools()[0]!;
const MODEL = {
  provider: "openai-codex",
  modelId: "gpt-test",
  thinkingLevel: "medium",
  credentialProfileId: "profile-1",
  family: "gpt",
} as const;
const ROLE_SETS = {
  implementer: [MODEL],
  reviewer: [MODEL],
  fixer: [],
  verdict: [],
};
let nextTask = 2000;

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => store.resetWorkflowStoreForTests());

function context(
  sessionId: string,
  agentType: "workflow-coordinator" | "developer" = "workflow-coordinator",
) {
  return {
    toolCallId: "call-1",
    session: { sessionId, harness: "pi", agentType },
  } as never;
}

function run() {
  return store.createRun({
    taskId: ++nextTask,
    recipeId: recipe.CODE_DELIVERY_RECIPE_ID,
    recipeVersion: recipe.CODE_DELIVERY_RECIPE_VERSION,
    maxIterations: 3,
    maxReviewPasses: 2,
    config: { coordinator: MODEL, roles: ROLE_SETS },
    actor: ACTOR,
  });
}

function coordinatorStep(runId: number, sessionId: string) {
  const step = store.appendStep({
    runId,
    kind: "agent",
    payload: {
      role: "coordinator",
      objective: "plan",
      roles: ROLE_SETS,
      maxReviewPasses: 2,
      resultContract: contracts.WORK_PLAN_CONTRACT_ID,
    },
    actor: ACTOR,
  });
  store.startStep(step.id, { kind: "session", id: sessionId }, ACTOR);
  return step;
}

function complete(
  stepId: number,
  summary = "planned",
  payload: WorkflowJsonValue = {
    complexity: "low",
    implementer: MODEL,
    reviewer: MODEL,
    rationale: "small focused change",
  },
) {
  store.completeStep(stepId, {
    status: "completed",
    result: {
      status: "completed",
      summary,
      contractId: contracts.WORK_PLAN_CONTRACT_ID,
      payload,
    },
    actor: ACTOR,
  });
}

test("refuses callers outside the coordinator persona before run inference", async () => {
  const subject = run();
  const step = coordinatorStep(subject.id, "coordinator-1");
  complete(step.id);

  await assert.rejects(
    tool.execute({}, context("coordinator-1", "developer")),
    /available only in a workflow coordinator session/,
  );
});

test("returns a bounded error when the coordinator session has no run", async () => {
  await assert.rejects(
    tool.execute({}, context("unassigned")),
    /not associated with a Workflow Run/,
  );
});

test("infers a paused run from terminal assignment history and projects its wait", async () => {
  const subject = run();
  const step = coordinatorStep(subject.id, "coordinator-2");
  complete(step.id);
  store.setRunLifecycle(subject.id, "paused", {
    reason: "Waiting for the user to repair CI credentials",
    actor: ACTOR,
  });

  const result = await tool.execute({}, context("coordinator-2"));
  const status = result.details as any;
  assert.deepEqual(status.run, {
    id: String(subject.id),
    taskId: String(subject.taskId),
    recipe: `${recipe.CODE_DELIVERY_RECIPE_ID}@${recipe.CODE_DELIVERY_RECIPE_VERSION}`,
    lifecycle: "paused",
    pauseReason: "Waiting for the user to repair CI credentials",
    repeatedAttempts: 1,
    current: {
      stepId: String(step.id),
      phase: "plan",
      kind: "agent",
      status: "completed",
    },
    waitingOn: "worktree not provisioned",
  });
  assert.deepEqual(status.limits, {
    iterations: { used: 0, maximum: 3 },
    reviewPasses: { used: 0, maximum: 2 },
    // Sessions are derived from the ceilings, so the run reports what it has
    // spent and nothing it was allowed to spend.
    sessions: { used: 1 },
  });
  assert.equal(status.sessions.coordinator, "coordinator-2");
});

test("bounds step history, summaries, and structured result collections visibly", async () => {
  const subject = run();
  const sessionId = "coordinator-bounded";
  for (let index = 0; index < 25; index += 1) {
    const step = coordinatorStep(subject.id, sessionId);
    complete(step.id, `summary-${index}-${"x".repeat(500)}`, {
      values: Array.from(
        { length: 25 },
        (_, item) => `${item}-${"y".repeat(500)}`,
      ),
    });
  }

  const result = await tool.execute({}, context(sessionId));
  const status = result.details as any;
  assert.equal(status.steps.items.length, 20);
  assert.equal(status.steps.truncated, true);
  assert.equal(status.steps.omittedEarlier, 5);
  assert.equal(
    status.steps.items[0].id,
    String(store.listSteps(subject.id)[5]!.id),
  );
  const projected = status.steps.items[0].result;
  assert.equal(projected.truncated, true);
  assert.match(projected.summary, /…$/);
  assert.equal(projected.payload.values.length, 20);
  assert.ok(
    projected.payload.values.every((item: string) => item.endsWith("…")),
  );
});
