import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, test } from "vitest";
import type { WorkflowActor } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "workflow-gate-action-tool-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const store = await import("../../db/workflowStore.ts");
const cards = await import("../../pullRequestCards.ts");
const recipe = await import("../../workflow/codeDeliveryRecipe.ts");
const { workflowGateActionTools } = await import("./workflowGateActionTool.ts");
const { closeDb } = await import("../../db/index.ts");

const SYSTEM = { kind: "system" as const };
let nextTask = 4400;

beforeEach(() => {
  store.resetWorkflowStoreForTests();
  cards.resetPullRequestCardsStoreForTests();
});

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

function context(sessionId: string, agentType = "workflow-coordinator") {
  return {
    toolCallId: "gate-call",
    session: { sessionId, harness: "pi", agentType },
  } as never;
}

function runFor(sessionId: string) {
  const run = store.createRun({
    taskId: ++nextTask,
    recipeId: recipe.CODE_DELIVERY_RECIPE_ID,
    recipeVersion: recipe.CODE_DELIVERY_RECIPE_VERSION,
    maxIterations: 3,
    maxReviewPasses: 2,
    actor: SYSTEM,
  });
  const coordinator = store.appendStep({
    runId: run.id,
    kind: "agent",
    payload: { role: "coordinator" },
    actor: SYSTEM,
  });
  store.startStep(coordinator.id, { kind: "session", id: sessionId }, SYSTEM);
  store.completeStep(coordinator.id, {
    status: "completed",
    result: { status: "completed", summary: "coordinator assignment done" },
    actor: SYSTEM,
  });
  return run;
}

function pullRequestCard() {
  return cards.createPullRequestCard(
    {
      sessionId: "implementer-1",
      status: "open",
      title: "Workflow PR",
      headBranch: "feature",
      baseBranch: "main",
      provider: "github",
      number: 42,
      url: "https://example.test/pull/42",
      worktreeId: "wt-42",
    },
    {
      repoRoot: "/tmp/repo",
      sessionKind: "developer",
      sessionId: "implementer-1",
      headBranch: "feature",
      baseBranch: "main",
      draft: false,
    },
  );
}

function mergeGate(runId: number, cardId: string) {
  const step = store.appendStep({
    runId,
    kind: "user-decision",
    payload: {
      decision: "merge-pull-request",
      cardId,
      reviewedHeadCommit: "a".repeat(40),
      allowedChoices: ["merge", "cancel"],
    },
    actor: SYSTEM,
  });
  store.startStep(step.id, { kind: "operation", id: "user-decision" }, SYSTEM);
  store.setRunLifecycle(runId, "paused", {
    reason: "merge decision ready",
    actor: SYSTEM,
  });
  return step;
}

const unusedDependencies = {
  async resume() {},
  async retry() {},
  async cancel() {},
  async runPullRequestAction() {
    throw new Error("unexpected pull request action");
  },
  async mergeRun(): Promise<string> {
    throw new Error("unexpected workflow merge");
  },
  async cleanUpRun(): Promise<string> {
    throw new Error("unexpected workflow cleanup");
  },
};

test("refuses an action that the run's actual state does not offer", async () => {
  const run = runFor("coordinator-refusal");
  const tool = workflowGateActionTools(unusedDependencies)[0]!;

  await assert.rejects(
    tool.execute({ action: "resume" }, context("coordinator-refusal")),
    new RegExp(
      `cannot resume: workflow run ${run.id} is active in phase plan; recorded next action:`,
    ),
  );
});

test("routes resume and semantic retry only from their paused gates", async () => {
  const sessionId = "coordinator-recovery";
  const resumed = runFor(sessionId);
  // The state Resume is FOR: a dispatch that failed left its reservation
  // pending, so there is a step waiting to be handed out. Resume is offered
  // only where it would move the run, and a run whose recipe would pause again
  // immediately is not that — the card refuses it now, so the fixture has to
  // model the real thing rather than a run that merely happens to be paused.
  store.appendStep({
    runId: resumed.id,
    kind: "agent",
    payload: { role: "implementer", objective: "implement" },
    actor: SYSTEM,
  });
  store.setRunLifecycle(resumed.id, "paused", {
    reason: "dispatch needs another attempt",
    actor: SYSTEM,
  });
  const calls: Array<{ action: string; actor: WorkflowActor }> = [];
  const tool = workflowGateActionTools({
    ...unusedDependencies,
    async resume(_runId, actor) {
      calls.push({ action: "resume", actor });
    },
    async retry(_runId, actor) {
      calls.push({ action: "retry", actor });
    },
  })[0]!;
  await tool.execute({ action: "resume" }, context(sessionId));

  // The fake resume deliberately leaves the run paused; admit one failed tail
  // only to model the distinct semantic-retry gate.
  store.setRunLifecycle(resumed.id, "active", { actor: SYSTEM });
  const failed = store.appendStep({
    runId: resumed.id,
    kind: "agent",
    payload: { role: "implementer" },
    actor: SYSTEM,
  });
  store.startStep(failed.id, { kind: "session", id: "implementer" }, SYSTEM);
  store.completeStep(failed.id, {
    status: "failed",
    result: { status: "failed", summary: "repairable failure" },
    actor: SYSTEM,
  });
  store.setRunLifecycle(resumed.id, "paused", {
    reason: "repairable failure",
    actor: SYSTEM,
  });
  await tool.execute({ action: "retry" }, context(sessionId));

  assert.deepEqual(calls, [
    {
      action: "resume",
      actor: {
        kind: "user",
        id: `via coordinator session ${sessionId}`,
      },
    },
    {
      action: "retry",
      actor: {
        kind: "user",
        id: `via coordinator session ${sessionId}`,
      },
    },
  ]);
});

test("attributes cancel to the user via the inferred coordinator session", async () => {
  const sessionId = "coordinator-cancel";
  const run = runFor(sessionId);
  const { cancelRun } = await import("../../workflow/engine.ts");
  const realTool = workflowGateActionTools({
    ...unusedDependencies,
    cancel: cancelRun,
  })[0]!;
  await realTool.execute({ action: "cancel" }, context(sessionId));

  const event = store
    .listEvents(run.id)
    .find((candidate) => candidate.type === "run-cancelled");
  assert.deepEqual(event?.actor, {
    kind: "user",
    id: `via coordinator session ${sessionId}`,
  });
  assert.equal(store.getRun(run.id)?.lifecycle, "cancelled");
});

test("a refused asynchronous cancel surfaces through the tool", async () => {
  const sessionId = "coordinator-cancel-refused";
  const run = runFor(sessionId);
  let cancelCalls = 0;
  const tool = workflowGateActionTools({
    ...unusedDependencies,
    async cancel(runId) {
      cancelCalls += 1;
      assert.equal(runId, run.id);
      await Promise.resolve();
      throw new Error("repair session did not stop; cancellation refused");
    },
  })[0]!;

  await assert.rejects(
    tool.execute({ action: "cancel" }, context(sessionId)),
    /repair session did not stop; cancellation refused/,
  );
  assert.equal(cancelCalls, 1);
  assert.equal(store.getRun(run.id)?.lifecycle, "active");
});

test("merge routes to the run's own delivery seam and surfaces both follow-ups", async () => {
  // The tool is an alias for the controls the Task's Workflow card carries, so
  // merge is the RUN's merge — the one place that owns its refusal — and not a
  // second route into the card seam under it.
  const sessionId = "coordinator-merge";
  const run = runFor(sessionId);
  const card = pullRequestCard();
  mergeGate(run.id, card.id);
  let observed:
    | {
        runId: number;
        options: unknown;
        actor: WorkflowActor;
        actingSessionId: string;
      }
    | undefined;
  const tool = workflowGateActionTools({
    ...unusedDependencies,
    async mergeRun(runId, options, actor, actingSessionId) {
      observed = { runId, options, actor, actingSessionId };
      cards.patchPullRequestCard(card.id, { status: "merged" });
      return "Merged with the card seam.";
    },
  })[0]!;

  const result = await tool.execute({ action: "merge" }, context(sessionId));
  assert.deepEqual(observed, {
    runId: run.id,
    options: { mergeMethod: "squash", deleteBranch: true },
    actor: {
      kind: "user",
      id: `via coordinator session ${sessionId}`,
    },
    actingSessionId: sessionId,
  });
  const details = result.details as any;
  assert.equal(details.outcome, "Merged with the card seam.");
  assert.deepEqual(
    details.followUps.map((item: any) => item.action),
    ["mark-task-done", "cleanup"],
  );
  assert.equal(details.followUps[1].available, true);
});

test("cleanup routes to the run's own delivery seam", async () => {
  const sessionId = "coordinator-cleanup";
  const run = runFor(sessionId);
  const card = pullRequestCard();
  mergeGate(run.id, card.id);
  let observed: { runId: number; actingSessionId: string } | undefined;
  const tool = workflowGateActionTools({
    ...unusedDependencies,
    async cleanUpRun(runId, _actor, actingSessionId) {
      observed = { runId, actingSessionId };
      return "Removed the worktree. The workflow run is settled.";
    },
  })[0]!;

  const result = await tool.execute({ action: "cleanup" }, context(sessionId));
  assert.deepEqual(observed, { runId: run.id, actingSessionId: sessionId });
  assert.equal(
    (result.details as any).outcome,
    "Removed the worktree. The workflow run is settled.",
  );
});

test("mark-task-done is refused until the run is finished", async () => {
  const sessionId = "coordinator-follow-up";
  const run = runFor(sessionId);
  const card = pullRequestCard();
  mergeGate(run.id, card.id);
  const tool = workflowGateActionTools(unusedDependencies)[0]!;

  await assert.rejects(
    tool.execute({ action: "mark-task-done" }, context(sessionId)),
    /cannot mark-task-done: .* is paused in phase merge/,
  );
});

test("resume is refused while the run waits at its ceiling gate", async () => {
  // The tool aliases the CARD's controls, and a run at a ceiling offers that
  // decision instead of Resume: resuming would walk back into the same block.
  const sessionId = "coordinator-ceiling";
  const blocked = runFor(sessionId);
  store.appendStep({
    runId: blocked.id,
    kind: "user-decision",
    payload: {
      decision: "raise-ceilings",
      blocked: "iterations",
      wanted: "answer the findings raised against bbb",
      ceilings: { maxIterations: 2, maxReviewPasses: 1 },
      spent: { iterations: 2, reviewPasses: 1, sessions: 3 },
      headCarriesDiscoveryReview: false,
      allowedChoices: ["raise", "deliver", "cancel"],
    },
    actor: SYSTEM,
  });
  store.setRunLifecycle(blocked.id, "paused", {
    reason: "the run reached its fix-round ceiling",
    actor: SYSTEM,
  });
  const tool = workflowGateActionTools({
    ...unusedDependencies,
    async resume() {
      throw new Error("resume must not be reached at a ceiling gate");
    },
  })[0]!;

  await assert.rejects(
    tool.execute({ action: "resume" }, context(sessionId)),
    /resume/,
  );
});
