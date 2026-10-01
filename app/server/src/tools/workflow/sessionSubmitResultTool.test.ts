import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, test, vi } from "vitest";
import type { WorkflowActor, WorkflowResultStatus } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "workflow-submit-result-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const store = await import("../../db/workflowStore.ts");
const engine = await import("../../workflow/engine.ts");
const executors = await import("../../workflow/executors.ts");
const contracts = await import("../../workflow/resultContracts.ts");
const recipe = await import("../../workflow/codeDeliveryRecipe.ts");
const { sessionSubmitResultTools } =
  await import("./sessionSubmitResultTool.ts");
const { closeDb } = await import("../../db/index.ts");

const ACTOR: WorkflowActor = { kind: "system" };
const tool = sessionSubmitResultTools()[0]!;
let nextTask = 1000;

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  store.resetWorkflowStoreForTests();
  engine.resetWorkflowEngineForTests();
  executors.resetWorkflowExecutorsForTests();
});

function assignment(sessionId = `session-${nextTask}`) {
  const run = store.createRun({
    taskId: ++nextTask,
    recipeId: recipe.CODE_DELIVERY_RECIPE_ID,
    recipeVersion: recipe.CODE_DELIVERY_RECIPE_VERSION,
    maxIterations: 2,
    maxReviewPasses: 1,
    actor: ACTOR,
  });
  store.attachRunWorktree(
    run.id,
    { worktreeId: `wt-${run.id}`, branch: `run-${run.id}` },
    ACTOR,
  );
  const step = store.appendStep({
    runId: run.id,
    kind: "agent",
    payload: {
      role: "implementer",
      objective: "implement",
      resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
    },
    actor: ACTOR,
  });
  store.startStep(step.id, { kind: "session", id: sessionId }, ACTOR);
  return { run, step, sessionId };
}

/** The same rig, holding a review assignment instead of an implementation. */
function reviewAssignment(sessionId = `reviewer-${nextTask}`) {
  const run = store.createRun({
    taskId: ++nextTask,
    recipeId: recipe.CODE_DELIVERY_RECIPE_ID,
    recipeVersion: recipe.CODE_DELIVERY_RECIPE_VERSION,
    maxIterations: 2,
    maxReviewPasses: 1,
    actor: ACTOR,
  });
  store.attachRunWorktree(
    run.id,
    { worktreeId: `wt-${run.id}`, branch: `run-${run.id}` },
    ACTOR,
  );
  const step = store.appendStep({
    runId: run.id,
    kind: "agent",
    payload: {
      role: "reviewer",
      commitRange: { baseCommit: "aaa", headCommit: "bbb" },
      reviewPass: 1,
      maxReviewPasses: 1,
      resultContract: contracts.ASSESSMENT_CONTRACT_ID,
    },
    actor: ACTOR,
  });
  store.startStep(step.id, { kind: "session", id: sessionId }, ACTOR);
  return { run, step, sessionId };
}

function context(sessionId: string) {
  return {
    toolCallId: "call-1",
    session: {
      sessionId,
      harness: "pi",
      agentType: "developer",
    },
  } as never;
}

test("without an assignment the caller is refused", async () => {
  await assert.rejects(
    tool.execute(
      { status: "completed", summary: "done", payload: {} },
      context("unassigned"),
    ),
    /holds no active workflow step assignment/,
  );
});

test("an invalid completed payload is refused and the step stays running", async () => {
  const { step, sessionId } = assignment();
  await assert.rejects(
    tool.execute(
      {
        status: "completed",
        summary: "done",
        payload: { notes: 42 },
      },
      context(sessionId),
    ),
    /\{ notes\?: string, responses\?: /,
  );
  assert.equal(store.getStep(step.id)!.status, "running");
  assert.equal(store.getStep(step.id)!.result, undefined);
});

test("a work plan sizes automatic starting ceilings before implementation", async () => {
  const candidate = {
    provider: "claude-sdk",
    modelId: "sonnet",
    thinkingLevel: "medium" as const,
    credentialProfileId: "profile-1",
    family: "claude",
  };
  const run = store.createRun({
    taskId: ++nextTask,
    recipeId: recipe.CODE_DELIVERY_RECIPE_ID,
    recipeVersion: recipe.CODE_DELIVERY_RECIPE_VERSION,
    maxIterations: 0,
    maxReviewPasses: 1,
    config: {
      startingCeilings: { mode: "plan-complexity" },
      roles: {
        implementer: [candidate],
        reviewer: [candidate],
        fixer: [],
        verdict: [],
      },
    },
    actor: ACTOR,
  });
  const step = store.appendStep({
    runId: run.id,
    kind: "agent",
    payload: {
      role: "coordinator",
      objective: "plan",
      resultContract: contracts.WORK_PLAN_CONTRACT_ID,
    },
    actor: ACTOR,
  });
  const sessionId = `coordinator-${run.id}`;
  store.startStep(step.id, { kind: "session", id: sessionId }, ACTOR);

  await tool.execute(
    {
      status: "completed",
      summary: "planned a complex run",
      payload: {
        complexity: "high",
        implementer: candidate,
        reviewer: candidate,
        rationale: "The change crosses protocol, server, and web seams.",
      },
    },
    context(sessionId),
  );

  const sized = store.getRun(run.id)!;
  assert.equal(sized.maxIterations, 6);
  assert.equal(sized.maxReviewPasses, 6);
  const event = store
    .listEvents(run.id)
    .find((item) => item.type === "run-ceilings-raised");
  assert.deepEqual(event?.detail, {
    from: { maxIterations: 0, maxReviewPasses: 1 },
    to: { maxIterations: 6, maxReviewPasses: 6 },
    by: { maxIterations: 6, maxReviewPasses: 5 },
    adjustment: { mode: "plan-complexity", complexity: "high" },
  });
});

test("a valid implementation result is immutable and advances to the host-operation seam", async () => {
  const { run, step, sessionId } = assignment();
  const result = await tool.execute(
    {
      status: "completed",
      summary: "implemented",
      payload: { notes: "tests pass" },
    },
    context(sessionId),
  );
  assert.equal(
    result.content[0]!.type === "text" ? result.content[0]!.text : "",
    JSON.stringify({ runId: run.id, stepId: step.id, status: "completed" }),
  );

  await waitFor(() => store.getRun(run.id)!.lifecycle === "paused");
  const completed = store.getStep(step.id)!;
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.result, {
    status: "completed",
    summary: "implemented",
    contractId: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
    payload: { notes: "tests pass" },
    submittedAt: completed.result!.submittedAt,
  });
  const history = store.listSteps(run.id);
  assert.equal(history.length, 2);
  assert.equal(history[1]!.kind, "host-operation");
  assert.equal(history[1]!.status, "pending");
  assert.match(
    store.getRun(run.id)!.lifecycleReason ?? "",
    /no executor is registered for host operation "commit-sync"/,
  );

  await assert.rejects(
    tool.execute(
      { status: "completed", summary: "again", payload: {} },
      context(sessionId),
    ),
    /holds no active workflow step assignment/,
  );
});

/**
 * Run 39 ([Task-441](pa://task/441)) end to end: the advance this tool kicks
 * off is fire-and-forget, and the step it decided next was REFUSED by the store
 * for an oversized payload. The refusal used to vanish with the promise; the
 * run must pause with it instead.
 */
test("a refused next step pauses the run the fire-and-forget advance drove", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    engine.registerWorkflowRecipe({
      id: "test-oversized-recipe",
      version: 1,
      decide: () => ({
        kind: "append",
        step: {
          kind: "agent",
          payload: {
            role: "reviewer",
            objective: "review",
            implementerReport: { notes: "x".repeat(20_000) },
            resultContract: contracts.ASSESSMENT_CONTRACT_ID,
          },
        },
      }),
    });
    const run = store.createRun({
      taskId: ++nextTask,
      recipeId: "test-oversized-recipe",
      recipeVersion: 1,
      maxIterations: 2,
      maxReviewPasses: 1,
      actor: ACTOR,
    });
    const step = store.appendStep({
      runId: run.id,
      kind: "agent",
      payload: {
        role: "implementer",
        objective: "implement",
        resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
      },
      actor: ACTOR,
    });
    const sessionId = `oversized-${run.id}`;
    store.startStep(step.id, { kind: "session", id: sessionId }, ACTOR);

    await tool.execute(
      {
        status: "completed",
        summary: "implemented",
        payload: { notes: "tests pass" },
      },
      context(sessionId),
    );

    await waitFor(() => store.getRun(run.id)!.lifecycle === "paused");
    assert.match(
      store.getRun(run.id)!.lifecycleReason ?? "",
      /workflow step agent payload is \d+ chars, over the 16000 limit/,
    );
    assert.equal(store.getStep(step.id)!.status, "completed");
    assert.equal(
      store.listSteps(run.id).length,
      1,
      "the refused step was never admitted",
    );
    assert.equal(logged.mock.calls.length > 0, true);
  } finally {
    logged.mockRestore();
  }
});

for (const status of ["blocked", "failed"] as WorkflowResultStatus[]) {
  test(`${status} ends the step without payload and pauses the run naming it`, async () => {
    const { run, step, sessionId } = assignment();
    await tool.execute(
      { status, summary: `${status} evidence` },
      context(sessionId),
    );
    await waitFor(() => store.getRun(run.id)!.lifecycle === "paused");
    const ended = store.getStep(step.id)!;
    assert.equal(ended.status, status);
    assert.equal(
      ended.result?.contractId,
      contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
    );
    assert.equal(ended.result?.payload, undefined);
    assert.equal(
      store.getRun(run.id)!.lifecycleReason,
      `implement step ${step.id} ended as ${status}`,
    );
  });
}

test("accepting while still asking for changes is refused, not silently dropped", async () => {
  const { step, sessionId } = reviewAssignment();
  await assert.rejects(
    tool.execute(
      {
        status: "completed",
        summary: "good overall, a few small things",
        payload: {
          verdict: "pass",
          headCommit: "bbb",
          findings: [
            { severity: "major", text: "rename the helper" },
            { severity: "major", text: "drop the dead branch" },
          ],
        },
      },
      context(sessionId),
    ),
    /empty when the verdict is "pass"/,
  );
  // The step is still the reviewer's to correct: it can revise, or move the
  // remarks to observations.
  assert.equal(store.getStep(step.id)!.status, "running");

  await tool.execute(
    {
      status: "completed",
      summary: "good overall, a few small things",
      payload: {
        verdict: "pass",
        headCommit: "bbb",
        findings: [],
        observations: ["rename the helper", "drop the dead branch"],
      },
    },
    context(sessionId),
  );
  assert.deepEqual(store.getStep(step.id)!.result?.payload, {
    verdict: "pass",
    headCommit: "bbb",
    findings: [],
    observations: ["rename the helper", "drop the dead branch"],
  });
});

test("an unknown finding severity is refused without completing the review", async () => {
  const { step, sessionId } = reviewAssignment();
  await assert.rejects(
    tool.execute(
      {
        status: "completed",
        summary: "needs a fix",
        payload: {
          verdict: "revise",
          headCommit: "bbb",
          findings: [{ severity: "urgent", text: "this is not a severity" }],
        },
      },
      context(sessionId),
    ),
    /workflow result payload must match/,
  );
  assert.equal(store.getStep(step.id)!.status, "running");
});

test("asking for changes only in the summary is refused too", async () => {
  const { step, sessionId } = reviewAssignment();
  // The mirror of the pass rule: findings are the only part of a review the
  // implementer is handed, so a rework verdict listing none asks for changes
  // nobody is told about.
  await assert.rejects(
    tool.execute(
      {
        status: "completed",
        summary: "the locking is wrong throughout; please rework it",
        payload: { verdict: "revise", headCommit: "bbb", findings: [] },
      },
      context(sessionId),
    ),
    /"revise" requires at least one/,
  );
  assert.equal(store.getStep(step.id)!.status, "running");

  await tool.execute(
    {
      status: "completed",
      summary: "the locking is wrong throughout; please rework it",
      payload: {
        verdict: "revise",
        headCommit: "bbb",
        findings: [
          {
            severity: "major",
            text: "take the repo lock around the whole commit sequence",
          },
        ],
      },
    },
    context(sessionId),
  );
  assert.equal(store.getStep(step.id)!.status, "completed");
});

test("an implementation result may answer findings it did not fix", async () => {
  const { step, sessionId } = assignment();
  await assert.rejects(
    tool.execute(
      {
        status: "completed",
        summary: "revised",
        payload: { responses: [{ finding: "add a test" }] },
      },
      context(sessionId),
    ),
    /finding: string, response: string/,
  );
  assert.equal(store.getStep(step.id)!.status, "running");

  await tool.execute(
    {
      status: "completed",
      summary: "revised",
      payload: {
        notes: "fixed the race",
        responses: [
          { finding: "add a test", response: "the e2e case covers it" },
        ],
      },
    },
    context(sessionId),
  );
  assert.deepEqual(store.getStep(step.id)!.result?.payload, {
    notes: "fixed the race",
    responses: [{ finding: "add a test", response: "the e2e case covers it" }],
  });
});

test("a review decision is refused until it is a decision the recipe can read", async () => {
  const run = store.createRun({
    taskId: ++nextTask,
    recipeId: recipe.CODE_DELIVERY_RECIPE_ID,
    recipeVersion: recipe.CODE_DELIVERY_RECIPE_VERSION,
    maxIterations: 2,
    maxReviewPasses: 2,
    actor: ACTOR,
  });
  store.attachRunWorktree(
    run.id,
    { worktreeId: `wt-${run.id}`, branch: `run-${run.id}` },
    ACTOR,
  );
  const sessionId = `coordinator-${nextTask}`;
  const step = store.appendStep({
    runId: run.id,
    kind: "agent",
    payload: {
      role: "coordinator",
      objective: "review-decision",
      commitRange: { baseCommit: "aaa", headCommit: "bbb" },
      completedReviewPass: 1,
      maxReviewPasses: 2,
      resultContract: contracts.REVIEW_DECISION_CONTRACT_ID,
    },
    actor: ACTOR,
  });
  store.startStep(step.id, { kind: "session", id: sessionId }, ACTOR);

  // A focus entry nobody can act on is not focus, and a decision that only
  // exists in the summary is not a decision.
  await assert.rejects(
    tool.execute(
      {
        status: "completed",
        summary: "one more pass",
        payload: { decision: "review-again", focus: ["  "], rationale: "big" },
      },
      context(sessionId),
    ),
    /must match/,
  );
  assert.equal(store.getStep(step.id)!.status, "running");

  await tool.execute(
    {
      status: "completed",
      summary: "one more pass",
      payload: {
        decision: "review-again",
        focus: ["the migration"],
        rationale: "the diff is broad and touches persisted data",
      },
    },
    context(sessionId),
  );
  assert.deepEqual(store.getStep(step.id)!.result?.payload, {
    decision: "review-again",
    focus: ["the migration"],
    rationale: "the diff is broad and touches persisted data",
  });
});

test("blocked and failed submissions forbid payload", async () => {
  const { step, sessionId } = assignment();
  await assert.rejects(
    tool.execute(
      { status: "blocked", summary: "waiting", payload: {} },
      context(sessionId),
    ),
    /must not include payload/,
  );
  assert.equal(store.getStep(step.id)!.status, "running");
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition did not settle");
}
