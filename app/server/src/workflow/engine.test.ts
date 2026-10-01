/**
 * The Workflow Run engine against the real store ([Task-365](pa://task/365)).
 * Run it with:
 *   pnpm --filter @assistant/server test src/workflow/engine.test.ts
 *
 * Everything the engine can do is driven through FAKE executors: no sessions,
 * no git, no prompts. What is exercised is the part that must not break when
 * steps 4 and 5 plug real ones in — the advance loop, the lifecycle gates, and
 * what a restart may resume versus must pause.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, test, vi } from "vitest";
import type { WorkflowActor } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "workflow-engine-test-"));
process.env.ASSISTANT_CWD = tmp;

const store = await import("../db/workflowStore.ts");
const worktrees = await import("../db/worktreeStore.ts");
const engine = await import("./engine.ts");
const executors = await import("./executors.ts");
const contracts = await import("./resultContracts.ts");
const recipe = await import("./codeDeliveryRecipe.ts");
const cards = await import("./cardProjection.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { subagentStore } = await import("../db/subagentStore.ts");
const { closeDb } = await import("../db/index.ts");

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

const SYSTEM: WorkflowActor = { kind: "system" };
const USER: WorkflowActor = { kind: "user", id: "alice" };

/* ---------------------------------- fakes ---------------------------------- */

/**
 * Stands in for step 4's executor: it binds a session to the step and leaves it
 * RUNNING, exactly as a real agent step does — the result arrives later, when
 * the session submits it (`submitResult` below).
 */
interface FakeAgentExecutor {
  dispatched: number[];
  /** The session id the next dispatch binds, by role. */
  sessionFor(role: string): string;
  /** When set, dispatch does nothing at all: a crash right after admission. */
  inert: boolean;
  /** When set, dispatch throws it. */
  failWith?: Error;
  /**
   * Runs after the executor has been handed the step and BEFORE it starts it —
   * the window in which a real executor is still preparing its session.
   */
  beforeStart?: () => void;
}

let agent: FakeAgentExecutor;
let commitSyncRuns: number;
let commitSyncHead: string;
/** When set, the commit/sync fake throws it instead of reporting a range. */
let commitSyncFailure: Error | undefined;
/** When set, the fake reports this blocked summary — deterministically, so a
 * semantic retry re-derives the byte-identical outcome. */
let commitSyncBlock: string | undefined;

function installFakes(): void {
  agent = {
    dispatched: [],
    sessionFor: (role) => `sess-${role}`,
    inert: false,
  };
  executors.registerWorkflowAgentExecutor({
    dispatch: async ({ step, actor }) => {
      if (agent.failWith) throw agent.failWith;
      if (agent.inert) return;
      const role = String(
        (step.payload as Record<string, unknown>).role ?? "unknown",
      );
      const sessionId = agent.sessionFor(role);
      ensureSession(sessionId);
      agent.beforeStart?.();
      store.startStep(step.id, { kind: "session", id: sessionId }, actor);
      agent.dispatched.push(step.id);
      if (role === "coordinator")
        store.completeStep(step.id, {
          status: "completed",
          result: {
            status: "completed",
            summary: "simple",
            contractId: contracts.WORK_PLAN_CONTRACT_ID,
            payload: {
              complexity: "low",
              implementer: TEST_MODEL,
              reviewer: TEST_MODEL,
              rationale: "small change",
            },
          },
          actor: { kind: "agent", id: sessionId },
        });
    },
  });

  commitSyncRuns = 0;
  commitSyncHead = "head-1";
  commitSyncFailure = undefined;
  commitSyncBlock = undefined;
  const executeRangeOperation = async () => {
    commitSyncRuns += 1;
    if (commitSyncFailure) throw commitSyncFailure;
    if (commitSyncBlock)
      return { status: "blocked" as const, summary: commitSyncBlock };
    return {
      status: "completed" as const,
      summary: "committed and rebased",
      contractId: contracts.COMMIT_SYNC_RESULT_CONTRACT_ID,
      payload: { baseCommit: "base-1", headCommit: commitSyncHead },
    };
  };
  for (const id of [
    recipe.COMMIT_SYNC_OPERATION_ID,
    recipe.COMMIT_ONLY_OPERATION_ID,
    recipe.BASE_SYNC_OPERATION_ID,
  ])
    executors.registerWorkflowHostOperation({
      id,
      recoveryPolicy: "retry-safe",
      execute: executeRangeOperation,
    });
  executors.registerWorkflowHostOperation({
    id: recipe.DELIVERY_GATE_OPERATION_ID,
    recoveryPolicy: "retry-safe",
    execute: async () => ({
      status: "completed",
      summary: "delivery gate passed",
      contractId: contracts.DELIVERY_GATE_RESULT_CONTRACT_ID,
      payload: { outcome: "ready", reviewedHeadCommit: commitSyncHead },
    }),
  });
  executors.registerWorkflowHostOperation({
    id: recipe.PUBLISH_PULL_REQUEST_OPERATION_ID,
    recoveryPolicy: "retry-safe",
    execute: async () => ({
      status: "completed",
      summary: "published",
      contractId: contracts.PUBLISH_PULL_REQUEST_RESULT_CONTRACT_ID,
      payload: {
        outcome: "published",
        reviewedHeadCommit: commitSyncHead,
        cardId: "pr-1",
        sessionId: "sess-implementer",
        provider: "github",
        number: 1,
        url: "https://example.test/pull/1",
      },
    }),
  });
  executors.registerWorkflowWaitExecutor({
    id: "fake-pr-observer",
    supports: (step) => step.kind === "wait",
    dispatch: async () => undefined,
  });
}

function ensureSession(id: string): void {
  if (!sessionStore.get(id))
    sessionStore.upsert({ id, harness: "pi", agentType: "developer" });
}

/* --------------------------------- helpers --------------------------------- */

const TEST_MODEL = {
  provider: "openai-codex",
  modelId: "gpt-test",
  thinkingLevel: "medium",
  credentialProfileId: "test-profile",
  family: "gpt",
} as const;
const ROLE_SETS = {
  implementer: [TEST_MODEL],
  reviewer: [TEST_MODEL],
  fixer: [],
  verdict: [],
};

let taskId = 0;

function newRun(options: { maxIterations?: number } = {}) {
  taskId += 1;
  const run = store.createRun({
    taskId,
    recipeId: recipe.CODE_DELIVERY_RECIPE_ID,
    recipeVersion: recipe.CODE_DELIVERY_RECIPE_VERSION,
    maxIterations: options.maxIterations ?? 2,
    maxReviewPasses: 1,
    config: { coordinator: TEST_MODEL, roles: ROLE_SETS },
    actor: USER,
  });
  // Step 3 provisions the worktree before the first advance; here that is one
  // store call, since this step builds no start sheet.
  store.attachRunWorktree(
    run.id,
    { worktreeId: `wt-${run.id}`, branch: `t365-run-${run.id}` },
    SYSTEM,
  );
  return run;
}

function steps(runId: number) {
  return store
    .listSteps(runId)
    .filter(
      (step) => recipe.phaseOf(step) !== "plan" || step.status !== "completed",
    );
}

function seedCompletedPlan(runId: number): void {
  const plan = store.appendStep({
    runId,
    kind: "agent",
    payload: {
      role: "coordinator",
      objective: "plan",
      roles: ROLE_SETS,
      maxReviewPasses: 1,
      resultContract: contracts.WORK_PLAN_CONTRACT_ID,
    },
    actor: SYSTEM,
  });
  store.startStep(
    plan.id,
    { kind: "session", id: `seed-coordinator-${runId}` },
    SYSTEM,
  );
  store.completeStep(plan.id, {
    status: "completed",
    result: {
      status: "completed",
      summary: "simple",
      contractId: contracts.WORK_PLAN_CONTRACT_ID,
      payload: {
        complexity: "low",
        implementer: TEST_MODEL,
        reviewer: TEST_MODEL,
        rationale: "small change",
      },
    },
    actor: SYSTEM,
  });
}

function lastStep(runId: number) {
  const all = steps(runId);
  return all[all.length - 1]!;
}

/** What step 4's `session_submit_result` tool will do: complete, then advance. */
async function submitResult(
  runId: number,
  stepId: number,
  contractId: string,
  payload: Record<string, unknown>,
  summary = "done",
): Promise<void> {
  const step = store.getStep(stepId)!;
  store.completeStep(stepId, {
    status: "completed",
    result: {
      status: "completed",
      summary,
      contractId,
      payload: payload as never,
    },
    actor: { kind: "agent", id: step.executor?.id ?? "unknown" },
  });
  await engine.advanceRun(runId);
}

function implementationDone(runId: number): Promise<void> {
  return submitResult(
    runId,
    lastStep(runId).id,
    contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
    { notes: "implemented" },
  );
}

function assessmentDone(
  runId: number,
  verdict: "pass" | "revise" | "fail",
  findings: string[] = [],
  headCommit = commitSyncHead,
): Promise<void> {
  return submitResult(
    runId,
    lastStep(runId).id,
    contracts.ASSESSMENT_CONTRACT_ID,
    {
      verdict,
      headCommit,
      findings: findings.map((text) => ({ severity: "major" as const, text })),
    },
    `review says ${verdict}`,
  );
}

beforeEach(() => {
  store.resetWorkflowStoreForTests();
  engine.resetWorkflowEngineForTests();
  executors.resetWorkflowExecutorsForTests();
  installFakes();
});

/* -------------------------------- happy path ------------------------------- */

test("a run walks implement → review → publication and waits durably for observation", async () => {
  const run = newRun();
  await engine.advanceRun(run.id, USER);

  // One admission at a time: the implement step is out with its session, and
  // nothing else has been admitted behind it.
  let history = steps(run.id);
  assert.equal(history.length, 1);
  assert.equal(history[0]!.status, "running");
  assert.deepEqual(history[0]!.executor, {
    kind: "session",
    id: "sess-implementer",
  });

  await implementationDone(run.id);

  // The host operation ran to a conclusion inside the same advance, so the
  // review step is already out.
  history = steps(run.id);
  assert.deepEqual(
    history.map((step) => [step.kind, step.status]),
    [
      ["agent", "completed"],
      ["host-operation", "completed"],
      ["agent", "running"],
    ],
  );
  assert.equal(commitSyncRuns, 1);
  assert.deepEqual(history[1]!.executor, {
    kind: "operation",
    id: "commit-sync",
  });
  assert.equal(history[1]!.predecessorId, history[0]!.id);
  assert.deepEqual(history[2]!.payload, {
    role: "reviewer",
    objective: "review",
    commitRange: { baseCommit: "base-1", headCommit: "head-1" },
    reviewPass: 1,
    maxReviewPasses: 1,
    implementerReport: { summary: "done", notes: "implemented" },
    resultContract: contracts.ASSESSMENT_CONTRACT_ID,
  });
  // An independent session reviews what the implementer built.
  assert.equal(history[2]!.executor?.id, "sess-reviewer");

  await assessmentDone(run.id, "pass");

  const waiting = store.getRun(run.id)!;
  assert.equal(waiting.lifecycle, "active");
  const observation = lastStep(run.id);
  assert.equal(observation.kind, "wait");
  assert.equal(observation.status, "running");
  assert.deepEqual(observation.executor, {
    kind: "operation",
    id: "fake-pr-observer",
  });
  assert.equal(steps(run.id).length, 6);
});

test("completing a run shelves the sessions it never gave a checkout", async () => {
  const run = newRun();
  // Code-delivery roles execute in the run's checkout and leave the inbox WITH
  // it; this fixture models the implementer and reviewer edges explicitly.
  worktrees.linkSessionToWorktree("sess-implementer", `wt-${run.id}`);
  worktrees.linkSessionToWorktree("sess-reviewer", `wt-${run.id}`);
  await engine.advanceRun(run.id, USER);
  await implementationDone(run.id);
  await assessmentDone(run.id, "pass");
  const observation = lastStep(run.id);

  await submitResult(
    run.id,
    observation.id,
    contracts.PULL_REQUEST_OBSERVATION_RESULT_CONTRACT_ID,
    { outcome: "merged", headCommit: commitSyncHead, reason: "merged" },
    "merged while waiting",
  );

  assert.equal(store.getRun(run.id)!.lifecycle, "completed");
  assert.equal(
    sessionStore.isSettled("sess-coordinator"),
    true,
    "no checkout removal will ever reach the coordinator session, so the run's own end settles it",
  );
  assert.equal(
    sessionStore.isSettled("sess-implementer"),
    false,
    "the work sessions still settle with the checkout, so cleanup keeps saying exactly what it settles",
  );
});

test("a revise verdict chains rework onto the same run and reuses its sessions", async () => {
  const run = newRun({ maxIterations: 1 });
  await engine.advanceRun(run.id);
  await implementationDone(run.id);

  const review = lastStep(run.id);
  await assessmentDone(run.id, "revise", ["add a test"]);

  const rework = lastStep(run.id);
  assert.equal(rework.predecessorId, review.id, "the chain names its cause");
  assert.equal(rework.runId, run.id, "a causal chain never leaves its run");
  assert.deepEqual(rework.payload, {
    role: "implementer",
    objective: "revise",
    reviewedCommit: "head-1",
    findings: [{ severity: "major", text: "add a test" }],
    reviewSummary: "review says revise",
    fixerLineage: "pass-1",
    resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
  });
  // The lineage marker does NOT move the round into a fixer session: the
  // executor keys that role by the payload's `fixer`, which this round has
  // none of, so an implementer-routed round runs where design intent lives.
  assert.equal(rework.executor?.id, "sess-implementer");

  // Second round: a new commit range, a new assessment, and then the limit.
  commitSyncHead = "head-2";
  await implementationDone(run.id);
  assert.equal(commitSyncRuns, 2);
  assert.deepEqual(
    (lastStep(run.id).payload as Record<string, unknown>).commitRange,
    {
      baseCommit: "base-1",
      headCommit: "head-2",
    },
  );

  await assessmentDone(run.id, "revise", ["still not there"]);
  // The ceiling stops the automatic loop and hands the run to the user rather
  // than ending it: no third round is admitted, and a decision is open.
  const limited = store.getRun(run.id)!;
  assert.equal(limited.lifecycle, "paused");
  assert.match(limited.lifecycleReason ?? "", /reached its fix-round ceiling/);
  const tail = steps(run.id).at(-1)!;
  assert.equal(tail.kind, "user-decision");
  assert.equal(
    (tail.payload as Record<string, unknown>).decision,
    "raise-ceilings",
  );
  assert.equal(steps(run.id).length, 7, "the gate, not a third round");
});

/* -------------------------------- lifecycle -------------------------------- */

test("pausing holds admission without aborting the turn already running", async () => {
  const run = newRun();
  await engine.advanceRun(run.id);
  const implement = lastStep(run.id);

  engine.pauseRun(run.id, "user is looking at something", USER);
  assert.equal(store.getRun(run.id)!.lifecycle, "paused");

  // The running turn still finishes and its result is KEPT — that is the whole
  // difference between pausing and cancelling.
  await submitResult(
    run.id,
    implement.id,
    contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
    { notes: "finished anyway" },
  );
  const completed = store.getStep(implement.id)!;
  assert.equal(completed.status, "completed");
  assert.equal(completed.result?.contractId, "implementation-result");
  assert.equal(steps(run.id).length, 1, "a paused run admits nothing new");
  assert.equal(commitSyncRuns, 0);

  // Resuming re-derives the next step from the same history.
  await engine.resumeRun(run.id, USER);
  const resumed = store.getRun(run.id)!;
  assert.equal(resumed.lifecycle, "active");
  assert.equal(commitSyncRuns, 1);
  assert.deepEqual(
    steps(run.id).map((step) => step.status),
    ["completed", "completed", "running"],
  );
});

test("resuming an already-active run is a no-op", async () => {
  const run = newRun();
  const eventsBefore = store.listEvents(run.id);

  await engine.resumeRun(run.id, USER);

  assert.equal(store.getRun(run.id)!.lifecycle, "active");
  assert.deepEqual(
    store.listEvents(run.id),
    eventsBefore,
    "a duplicate Resume must not append an active → active event",
  );
  assert.deepEqual(steps(run.id), [], "a no-op Resume does not dispatch work");
});

test("cancelling ends the run's open work and touches nothing else", async () => {
  const run = newRun();
  await engine.advanceRun(run.id);
  const implement = lastStep(run.id);

  await engine.cancelRun(run.id, USER, "not needed after all");

  const cancelled = store.getRun(run.id)!;
  assert.equal(cancelled.lifecycle, "cancelled");
  assert.ok(cancelled.endedAt);
  assert.equal(store.getStep(implement.id)!.status, "cancelled");
  // Preserved on purpose: cleanup is a separate, user-visible decision.
  assert.equal(cancelled.worktreeId, `wt-${run.id}`);
  assert.ok(sessionStore.get("sess-implementer"), "the session survives");

  await engine.advanceRun(run.id);
  assert.equal(steps(run.id).length, 1, "a terminal run admits nothing");
});

/* --------------------------------- retry ---------------------------------- */

test("retry after a failed agent step appends a successor and resumes", async () => {
  const run = newRun();
  await engine.advanceRun(run.id);
  const failed = lastStep(run.id);
  store.completeStep(failed.id, { status: "failed", actor: USER });
  await engine.advanceRun(run.id);
  assert.equal(store.getRun(run.id)!.lifecycle, "paused");

  await engine.retryRun(run.id, USER);

  const history = steps(run.id);
  assert.equal(history.length, 2);
  assert.equal(history[0]!.status, "failed");
  assert.equal(history[1]!.status, "running");
  assert.equal(history[1]!.predecessorId, failed.id);
  assert.deepEqual(history[1]!.payload, failed.payload);
  assert.equal(store.getRun(run.id)!.lifecycle, "active");
});

test.each(["blocked", "failed"] as const)(
  "retry after a %s rebase repair advances through commit-sync instead of cloning the agent",
  async (status) => {
    const run = newRun();
    const repair = store.appendStep({
      runId: run.id,
      kind: "agent",
      payload: {
        role: "implementer",
        objective: "repair-rebase",
        files: ["conflict.ts"],
        truncated: false,
        baseBranch: "main",
        originalHead: "a".repeat(40),
        resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
      },
      actor: USER,
    });
    ensureSession("sess-implementer");
    store.startStep(
      repair.id,
      { kind: "session", id: "sess-implementer" },
      USER,
    );
    store.completeStep(repair.id, {
      status,
      result: { status, summary: "repair declined" },
      actor: USER,
    });
    await engine.advanceRun(run.id);
    assert.equal(store.getRun(run.id)?.lifecycle, "paused");

    await engine.retryRun(run.id, USER);

    const successor = store
      .listSteps(run.id)
      .find((step) => step.predecessorId === repair.id)!;
    assert.equal(successor.kind, "host-operation");
    assert.equal(
      (successor.payload as Record<string, unknown>).operation,
      recipe.COMMIT_SYNC_OPERATION_ID,
    );
    assert.equal(commitSyncRuns, 1);
    assert.equal(
      store
        .listSteps(run.id)
        .filter(
          (step) =>
            (step.payload as Record<string, unknown>).objective ===
            "repair-rebase",
        ).length,
      1,
    );
  },
);

test("retry after a base-sync repair resumes its checkpoint routing", async () => {
  const run = newRun();
  const checkpoint = store.appendStep({
    runId: run.id,
    kind: "host-operation",
    payload: {
      operation: recipe.BASE_SYNC_OPERATION_ID,
      idempotencyKey: "base-sync-original",
      purpose: "delivery",
      reviewer: TEST_MODEL,
      focus: ["the lease boundary"],
      verdict: TEST_MODEL,
      authorizedByUser: true,
    },
    actor: USER,
  });
  store.startStep(
    checkpoint.id,
    { kind: "operation", id: recipe.BASE_SYNC_OPERATION_ID },
    SYSTEM,
  );
  store.completeStep(checkpoint.id, {
    status: "blocked",
    result: {
      status: "blocked",
      summary: "base-sync conflicted",
    },
    actor: SYSTEM,
  });

  const repair = store.appendStep({
    runId: run.id,
    kind: "agent",
    payload: {
      role: "implementer",
      objective: "repair-rebase",
      files: ["conflict.ts"],
      truncated: false,
      baseBranch: "main",
      originalHead: "a".repeat(40),
      resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
    },
    predecessorId: checkpoint.id,
    actor: USER,
  });
  ensureSession("sess-implementer");
  store.startStep(repair.id, { kind: "session", id: "sess-implementer" }, USER);
  store.completeStep(repair.id, {
    status: "failed",
    result: { status: "failed", summary: "repair declined" },
    actor: USER,
  });
  await engine.advanceRun(run.id);
  assert.equal(store.getRun(run.id)?.lifecycle, "paused");

  await engine.retryRun(run.id, USER);

  const retry = store
    .listSteps(run.id)
    .find((step) => step.predecessorId === repair.id)!;
  assert.equal(retry.kind, "host-operation");
  assert.deepEqual(retry.payload, {
    operation: recipe.BASE_SYNC_OPERATION_ID,
    idempotencyKey: recipe.baseSyncIdempotencyKey(run.id, repair.id),
    purpose: "delivery",
    reviewer: TEST_MODEL,
    focus: ["the lease boundary"],
    verdict: TEST_MODEL,
    authorizedByUser: true,
  });
  assert.equal(commitSyncRuns, 1);
});

test("retry after failed commit-sync preserves its idempotency key", async () => {
  const run = newRun();
  await engine.advanceRun(run.id);
  commitSyncFailure = new Error("network broke after commit");
  await implementationDone(run.id);
  const failed = lastStep(run.id);
  const key = (failed.payload as Record<string, unknown>).idempotencyKey;
  assert.equal(failed.status, "failed");

  commitSyncFailure = undefined;
  await engine.retryRun(run.id, USER);

  const retried = steps(run.id).find(
    (step) => step.predecessorId === failed.id,
  )!;
  assert.equal(
    (retried.payload as Record<string, unknown>).idempotencyKey,
    key,
  );
  assert.equal(retried.status, "completed");
  assert.equal(
    lastStep(run.id).kind,
    "agent",
    "the resumed run reaches review",
  );
});

test("a retry that reproduces the same block pauses saying so", async () => {
  const run = newRun();
  await engine.advanceRun(run.id);
  commitSyncBlock = "run rebase blocked: the rebase conflicted and was aborted";
  await implementationDone(run.id);
  const first = lastStep(run.id);
  assert.equal(first.status, "blocked");
  assert.equal(
    store.getRun(run.id)!.lifecycleReason,
    `commit-sync step ${first.id} ended as blocked`,
    "a first block is simply the block",
  );

  await engine.retryRun(run.id, USER);

  // The retry reproduced the block, which is the run's evidence that the
  // failure is deterministic: it spends its ONE automatic triage before
  // stopping ([Task-591](pa://task/591)).
  const second = steps(run.id).find((step) => step.predecessorId === first.id)!;
  assert.notEqual(second.id, first.id);
  assert.equal(second.status, "blocked");
  const triage = lastStep(run.id);
  assert.equal(triage.kind, "agent");
  assert.equal(
    (triage.payload as Record<string, unknown>).objective,
    "triage-operation",
  );
  await submitResult(
    run.id,
    triage.id,
    contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
    { notes: "the remote tip is a head this run never recorded" },
  );

  // The observed failure of [Task-399](pa://task/399): the deterministic
  // operation re-derives the identical outcome in under a second, so a reason
  // that names only the step number reads as a retry that did nothing. The
  // triage between the attempts is an intervention, not an attempt of its own.
  const third = lastStep(run.id);
  assert.equal(third.status, "blocked");
  assert.equal(
    store.getRun(run.id)!.lifecycleReason,
    `commit-sync step ${third.id} ended as blocked; attempt 3 with the same result`,
  );

  await engine.retryRun(run.id, USER);
  assert.match(
    store.getRun(run.id)!.lifecycleReason ?? "",
    /attempt 4 with the same result/,
    "the chain keeps counting rather than resetting, and the triage is spent",
  );

  // Retries stay uncapped on purpose: what the step reported can be repaired
  // outside the run, and then the very same assignment ends differently.
  commitSyncBlock = undefined;
  await engine.retryRun(run.id, USER);
  assert.equal(
    lastStep(run.id).kind,
    "agent",
    "the repaired retry reaches review",
  );
});

test("Retry on a spent triage re-runs the operation, not the agent", async () => {
  const run = newRun();
  await engine.advanceRun(run.id);
  commitSyncBlock = "run rebase blocked: the working tree is unsafe";
  await implementationDone(run.id);
  const first = lastStep(run.id);
  await engine.retryRun(run.id, USER);
  const triage = lastStep(run.id);
  assert.equal(
    (triage.payload as Record<string, unknown>).objective,
    "triage-operation",
  );
  // The triage itself stops: the run is now paused ON the assignment.
  store.completeStep(triage.id, {
    status: "blocked",
    result: { status: "blocked", summary: "the cause is in the code" },
    actor: { kind: "agent", id: triage.executor!.id },
  });
  await engine.advanceRun(run.id);
  assert.equal(lastStep(run.id).id, triage.id);

  await engine.retryRun(run.id, USER);

  // Not another agent turn: the exact operation payload it was assigned,
  // re-reserved against the triage step it followed.
  const reissued = lastStep(run.id);
  assert.equal(reissued.kind, "host-operation");
  assert.deepEqual(reissued.payload, {
    ...(first.payload as Record<string, unknown>),
    idempotencyKey: recipe.operationIdempotencyKey(
      run.id,
      recipe.COMMIT_SYNC_OPERATION_ID,
      triage.id,
    ),
  });
  assert.equal(reissued.predecessorId, triage.id);
  assert.equal(reissued.status, "blocked", "and it ran");
});

test("an unrelated step with the same summary is not a repeated attempt", async () => {
  const run = newRun();
  await engine.advanceRun(run.id);
  const implement = lastStep(run.id);
  store.completeStep(implement.id, {
    status: "failed",
    result: { status: "failed", summary: "same words" },
    actor: USER,
  });
  await engine.advanceRun(run.id);
  // Appended beside the failed tail rather than after it: no predecessor link,
  // so the identical summary is a coincidence, not a second attempt at one thing.
  store.setRunLifecycle(run.id, "active", { actor: USER });
  const twin = store.appendStep({
    runId: run.id,
    kind: "agent",
    payload: implement.payload,
    actor: USER,
  });
  store.startStep(twin.id, { kind: "session", id: "sess-implementer" }, USER);
  store.completeStep(twin.id, {
    status: "failed",
    result: { status: "failed", summary: "same words" },
    actor: USER,
  });
  await engine.advanceRun(run.id);

  assert.equal(
    store.getRun(run.id)!.lifecycleReason,
    `implement step ${twin.id} ended as failed`,
  );
});

test("retry refuses a completed run", async () => {
  const run = newRun();
  store.setRunLifecycle(run.id, "completed", { actor: SYSTEM });
  await assert.rejects(
    engine.retryRun(run.id, USER),
    /is completed and cannot be retried/,
  );
});

/* ----------------------------- refused decisions --------------------------- */

/**
 * Run 39 ([Task-441](pa://task/441)): the recipe decided a step the STORE then
 * refused — a payload over the 16k cap. The refusal used to evaporate, leaving
 * an "active" run that never moved again, so what is asserted here is that a
 * refusal of the engine's own decision lands where a user can see it.
 */
const REFUSING_RECIPE_ID = "test-refusing-recipe";
/** When set, the recipe's next step carries a payload the store cannot take. */
let oversizedDecision = false;

engine.registerWorkflowRecipe({
  id: REFUSING_RECIPE_ID,
  version: 1,
  decide: (_run, history) => {
    const open = history.find(
      (step) => step.status === "pending" || step.status === "running",
    );
    if (open) return { kind: "executing", stepId: open.id };
    return {
      kind: "append",
      step: {
        kind: "agent",
        payload: {
          role: "implementer",
          objective: "implement",
          notes: oversizedDecision ? "x".repeat(20_000) : "small",
          resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
        },
      },
    };
  },
});

function newRefusingRun() {
  taskId += 1;
  const run = store.createRun({
    taskId,
    recipeId: REFUSING_RECIPE_ID,
    recipeVersion: 1,
    maxIterations: 2,
    maxReviewPasses: 1,
    config: { coordinator: TEST_MODEL, roles: ROLE_SETS },
    actor: USER,
  });
  store.attachRunWorktree(
    run.id,
    { worktreeId: `wt-${run.id}`, branch: `t443-run-${run.id}` },
    SYSTEM,
  );
  return run;
}

test("a decision the store refuses pauses the run saying exactly why", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const run = newRefusingRun();
    await engine.advanceRun(run.id, USER);
    const first = lastStep(run.id);
    assert.equal(first.status, "running");

    oversizedDecision = true;
    // Exactly what `session_submit_result` does, minus the fire-and-forget.
    store.completeStep(first.id, {
      status: "completed",
      result: {
        status: "completed",
        summary: "implemented",
        contractId: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
        payload: { notes: "implemented" },
      },
      actor: { kind: "agent", id: first.executor!.id },
    });
    // The refusal is not thrown into the void: the advance settles.
    await engine.advanceRun(run.id, USER);

    const paused = store.getRun(run.id)!;
    assert.equal(paused.lifecycle, "paused");
    assert.match(
      paused.lifecycleReason ?? "",
      /workflow step agent payload is \d+ chars, over the 16000 limit/,
      "the store's own words, so the card says what to fix",
    );
    assert.equal(
      steps(run.id).length,
      1,
      "the refused step was never admitted",
    );
    const pausedEvent = store
      .listEvents(run.id)
      .filter((event) => event.type === "run-paused")
      .at(-1);
    assert.match(
      String((pausedEvent?.detail as Record<string, unknown>)?.reason ?? ""),
      /over the 16000 limit/,
      "the event log carries the refusal too",
    );
    assert.equal(logged.mock.calls.length > 0, true, "and so does the log");

    // Once the decision fits, the same history moves again.
    oversizedDecision = false;
    await engine.resumeRun(run.id, USER);
    const resumed = store.getRun(run.id)!;
    assert.equal(resumed.lifecycle, "active");
    assert.equal(steps(run.id).length, 2);
    assert.equal(lastStep(run.id).status, "running");
  } finally {
    oversizedDecision = false;
    logged.mockRestore();
  }
});

/* ------------------------------ dispatch gaps ------------------------------ */

test("a step kind nothing can run pauses the run instead of stalling", async () => {
  const run = newRun();
  executors.resetWorkflowExecutorsForTests();
  await engine.advanceRun(run.id);
  const paused = store.getRun(run.id)!;
  assert.equal(paused.lifecycle, "paused");
  assert.match(paused.lifecycleReason ?? "", /no agent executor is registered/);
  // The reservation is untouched, so a resume dispatches that very step.
  assert.equal(lastStep(run.id).status, "pending");
});

test("a dispatch that throws before starting leaves the reservation intact", async () => {
  const run = newRun();
  agent.failWith = new Error("no session could be started");
  await engine.advanceRun(run.id);

  const paused = store.getRun(run.id)!;
  assert.equal(paused.lifecycle, "paused");
  assert.match(paused.lifecycleReason ?? "", /no session could be started/);
  const reserved = lastStep(run.id);
  assert.equal(reserved.status, "pending", "nothing ran, so nothing failed");

  // Resume dispatches that coordinator reservation, whose accepted result then
  // admits the implementation step without duplicating the plan step.
  delete agent.failWith;
  await engine.resumeRun(run.id, USER);
  assert.equal(steps(run.id).length, 1);
  assert.equal(store.getStep(reserved.id)!.status, "completed");
  assert.equal(lastStep(run.id).status, "running");
});

test("a pause landing mid-dispatch keeps its own reason and admits nothing", async () => {
  const run = newRun();
  // The user pauses while the executor is still preparing its session, so the
  // executor's own `startStep` is what the pause gate refuses.
  agent.beforeStart = () => engine.pauseRun(run.id, "user hit pause", USER);

  await engine.advanceRun(run.id);

  const paused = store.getRun(run.id)!;
  assert.equal(paused.lifecycle, "paused");
  assert.equal(
    paused.lifecycleReason,
    "user hit pause",
    "a store refusal is not an executor failure and never overwrites the reason",
  );
  const reserved = lastStep(run.id);
  assert.equal(
    reserved.status,
    "pending",
    "the assignment was never handed out",
  );

  // Resuming dispatches that same coordinator reservation and then implementation.
  delete agent.beforeStart;
  await engine.resumeRun(run.id, USER);
  assert.equal(steps(run.id).length, 1);
  assert.equal(store.getStep(reserved.id)!.status, "completed");
  assert.equal(lastStep(run.id).status, "running");
});

test("an operation that throws ends without evidence and pauses the run", async () => {
  const run = newRun();
  await engine.advanceRun(run.id);
  const implement = lastStep(run.id);

  commitSyncFailure = new Error("the worktree is dirty");
  await submitResult(
    run.id,
    implement.id,
    contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
    { notes: "implemented" },
  );

  const operation = lastStep(run.id);
  assert.equal(operation.kind, "host-operation");
  assert.equal(operation.status, "failed");
  assert.match(operation.result?.summary ?? "", /the worktree is dirty/);
  const paused = store.getRun(run.id)!;
  assert.equal(paused.lifecycle, "paused");
  assert.equal(
    paused.lifecycleReason,
    `commit-sync step ${operation.id} ended as failed`,
  );
});

test("an unknown recipe version pauses rather than guessing a decision", async () => {
  taskId += 1;
  const run = store.createRun({
    taskId,
    recipeId: recipe.CODE_DELIVERY_RECIPE_ID,
    recipeVersion: recipe.CODE_DELIVERY_RECIPE_VERSION + 1,
    maxIterations: 1,
    maxReviewPasses: 1,
    actor: USER,
  });
  await engine.advanceRun(run.id);
  const paused = store.getRun(run.id)!;
  assert.equal(paused.lifecycle, "paused");
  assert.equal(
    paused.lifecycleReason,
    `unknown recipe code-delivery@${recipe.CODE_DELIVERY_RECIPE_VERSION + 1}`,
  );
});

/* --------------------------- boot reconciliation --------------------------- */

test("a crash between admission and dispatch re-dispatches, never twins", async () => {
  const run = newRun();
  // The process dies after the reservation is appended and before its executor
  // takes it.
  agent.inert = true;
  await engine.advanceRun(run.id);
  const reserved = steps(run.id);
  assert.equal(reserved.length, 1);
  assert.equal(reserved[0]!.status, "pending");

  // "Restart": the pure decision re-derives the same step, so reconciliation
  // finds the reservation instead of appending a second one.
  agent.inert = false;
  engine.resetWorkflowEngineForTests();
  await engine.reconcileWorkflowRunsOnBoot();

  const after = steps(run.id);
  assert.equal(after.length, 1, "implementation follows the one plan row");
  assert.equal(store.getStep(reserved[0]!.id)!.status, "completed");
  assert.equal(
    store.listSteps(run.id).filter((step) => recipe.phaseOf(step) === "plan")
      .length,
    1,
    "no plan twin was admitted",
  );
  assert.equal(after[0]!.status, "running");
  assert.equal(store.getRun(run.id)!.lifecycle, "active");
});

test("a running agent step is adopted only while its turn is alive", async () => {
  const run = newRun();
  await engine.advanceRun(run.id);
  const implement = lastStep(run.id);

  engine.resetWorkflowEngineForTests();
  agent.dispatched = [];
  // A turn that is genuinely mid-flight in THIS process is inherited, not
  // duplicated. Only that case may be adopted: a session row alone proves
  // nothing once the process that drove the turn is gone.
  engine.setSessionTurnLivenessForTests(() => true);
  await engine.reconcileWorkflowRunsOnBoot();

  const adopted = store.getStep(implement.id)!;
  assert.equal(adopted.status, "running", "adopt, do not duplicate");
  assert.equal(adopted.attempt, 1, "adoption is not a retry");
  assert.deepEqual(agent.dispatched, [], "the step is not handed out twice");
  assert.equal(store.getRun(run.id)!.lifecycle, "active");

  const observation = store
    .listEvents(run.id)
    .filter((event) => event.type === "observation-recorded");
  assert.equal(observation.length, 1);
  assert.deepEqual(observation[0]!.detail, {
    reconciliation: "adopted-running-agent-step",
    sessionId: "sess-implementer",
  });
});

test("a restart fails the running step rather than waiting for a dead turn", async () => {
  // Provider turns live in this process. After a restart the session ROW is
  // still there, but nobody remains to submit a result, so adopting on the
  // strength of the row left the run active forever. Invariant 6 admits
  // idempotent recovery or an indeterminate pause; this is the pause.
  const run = newRun();
  await engine.advanceRun(run.id);
  const implement = lastStep(run.id);

  engine.resetWorkflowEngineForTests();
  agent.dispatched = [];
  engine.setSessionTurnLivenessForTests(() => false);
  await engine.reconcileWorkflowRunsOnBoot();

  const abandoned = store.getStep(implement.id)!;
  assert.equal(abandoned.status, "failed");
  assert.equal(store.getRun(run.id)!.lifecycle, "paused");
  assert.match(
    store.getRun(run.id)!.lifecycleReason ?? "",
    /interrupted|no longer|failed/i,
    "the pause says what happened",
  );

  // And the user's existing Retry is the way on: a successor carries the same
  // assignment once they have looked at the worktree.
  await engine.retryRun(run.id, USER);
  const successor = lastStep(run.id);
  assert.notEqual(successor.id, implement.id);
  assert.deepEqual(successor.payload, implement.payload);
});

/**
 * A workflow agent step interrupted mid-turn, whose session still owes
 * delegated work. Returns what boot left behind for the caller to judge.
 */
async function abandonedTurnOwing(
  owed: "active-run" | "managed-worktree",
): Promise<{ runId: number; stepId: number }> {
  // Its own parent session: the obligation seeded here outlives the store
  // reset between tests, and the shared implementer id would carry it along.
  const parentSessionId = `sess-owing-${owed}`;
  agent.sessionFor = () => parentSessionId;
  ensureSession(parentSessionId);
  const run = newRun();
  await engine.advanceRun(run.id);
  const implement = lastStep(run.id);
  const childSessionId = `sess-child-${run.id}`;
  sessionStore.upsert({
    id: childSessionId,
    scope: "subagent",
    harness: "pi",
    agentType: "developer",
  });
  const delegated = subagentStore.acceptInitial({
    thread: {
      parentSessionId,
      sessionId: childSessionId,
      profile: {
        roleName: "implementer",
        baseRole: "developer",
        provider: "openai-codex",
        modelId: "gpt-test",
        credentialProfileId: "test-profile",
        accountSource: "test",
        defaultThinking: "high",
        hardMaxThinking: "xhigh",
        executionProfileId: "test-execution",
        contractId: "implementation-result",
        contractVersion: 1,
      },
      linkage: { worktreeId: `managed-${run.id}`, worktreeRelation: "managed" },
    },
    run: { initiatedBy: "agent", actualThinking: "high" },
    parentLimit: 1,
  });
  // The worktree case has to get PAST the active run to strand on the worktree
  // the child still owns, so neither obligation family hides the other.
  if (owed === "managed-worktree") {
    subagentStore.recordQuiescence(delegated.run.id, "crash");
    subagentStore.finalizeRun({
      runId: delegated.run.id,
      status: "unreported",
    });
  }

  engine.resetWorkflowEngineForTests();
  agent.dispatched = [];
  engine.setSessionTurnLivenessForTests(() => false);
  await engine.reconcileWorkflowRunsOnBoot();
  return { runId: run.id, stepId: implement.id };
}

/** The obligation boot wrote down instead of enforcing, for one step. */
function abandonedObligationOf(runId: number, stepId: number): string[] {
  return store
    .listEvents(runId)
    .flatMap((event) =>
      event.stepId === stepId &&
      typeof event.detail === "object" &&
      event.detail !== null &&
      "abandonedDelegationObligation" in event.detail
        ? [String(event.detail.abandonedDelegationObligation)]
        : [],
    );
}

// The delegation invariant refuses to let a session finish its step while it
// owns delegated work. A dead turn can never clear such an obligation, so
// enforcing it at boot left the step RUNNING forever behind a turn nobody could
// submit for: the recipe reported it as executing, Resume did not apply, and
// Retry had no failed tail to succeed.
test("a dead turn that still owed an active child fails, and says what it owed", async () => {
  const { runId, stepId } = await abandonedTurnOwing("active-run");

  assert.equal(store.getStep(stepId)!.status, "failed", "the tail is terminal");
  assert.equal(store.getRun(runId)!.lifecycle, "paused");
  // The obligation is recorded, not dropped: the delegated work is still there
  // to settle, this step simply stopped waiting for it.
  assert.deepEqual(abandonedObligationOf(runId, stepId), [
    "it still has active delegated work.",
  ]);

  // And the run is actionable again: Retry appends the same assignment.
  await engine.retryRun(runId, USER);
  assert.notEqual(lastStep(runId).id, stepId, "Retry applies");
});

test("a dead turn that still owned a managed delegated worktree fails too", async () => {
  const { runId, stepId } = await abandonedTurnOwing("managed-worktree");

  assert.equal(store.getStep(stepId)!.status, "failed");
  assert.equal(store.getRun(runId)!.lifecycle, "paused");
  assert.deepEqual(abandonedObligationOf(runId, stepId), [
    "it still owns a managed delegated worktree.",
  ]);
  await engine.retryRun(runId, USER);
  assert.notEqual(lastStep(runId).id, stepId, "Retry applies");
});

test.each(["completed", "blocked"] as const)(
  "abandoning a turn may not end a step as %s",
  (status) => {
    // The escape hatch exists so a turn nobody can submit for cannot strand a
    // run — not so a session can claim an outcome while children it owns are
    // still working. `failed` (boot found the turn dead) and `cancelled` (the
    // user stopped the run and its turn was aborted) are the two ways a turn is
    // gone; `completed` and `blocked` report an outcome for one that is not.
    const run = newRun();
    const step = store.appendStep({
      runId: run.id,
      kind: "agent",
      payload: { objective: "delegate" },
      actor: SYSTEM,
    });
    const sessionId = `sess-abandon-${status}`;
    ensureSession(sessionId);
    store.startStep(step.id, { kind: "session", id: sessionId }, SYSTEM);
    assert.throws(
      () =>
        store.completeStep(step.id, {
          status,
          result: { status, summary: "done" },
          abandonedTurn: true,
          actor: SYSTEM,
        }),
      /as an abandoned turn/,
    );
    assert.equal(store.getStep(step.id)!.status, "running");
  },
);

test("a cancelled turn may be abandoned, so cancelling never gets stuck", () => {
  // A user cancellation aborts the turn and then settles its step. If that
  // settlement were held to an obligation the aborted turn can no longer clear,
  // the run would stay CANCELLING until a restart — where boot settles it by
  // bypassing the very check the live path could not.
  const run = newRun();
  const step = store.appendStep({
    runId: run.id,
    kind: "agent",
    payload: { objective: "delegate" },
    actor: SYSTEM,
  });
  ensureSession("sess-cancel-abandon");
  store.startStep(
    step.id,
    { kind: "session", id: "sess-cancel-abandon" },
    SYSTEM,
  );
  assert.equal(
    store.completeStep(step.id, {
      status: "cancelled",
      abandonedTurn: true,
      actor: SYSTEM,
    }).status,
    "cancelled",
  );
});

test("a running agent step whose session vanished fails and pauses the run", async () => {
  const run = newRun();
  agent.sessionFor = () => "sess-gone";
  ensureSession("sess-gone");
  await engine.advanceRun(run.id);
  const implement = lastStep(run.id);
  sessionStore.remove("sess-gone");

  engine.resetWorkflowEngineForTests();
  await engine.reconcileWorkflowRunsOnBoot();

  const failed = store.getStep(implement.id)!;
  assert.equal(failed.status, "failed");
  assert.match(
    failed.result?.summary ?? "",
    /session sess-gone no longer exists/,
  );
  const paused = store.getRun(run.id)!;
  assert.equal(paused.lifecycle, "paused");
  assert.match(paused.lifecycleReason ?? "", /sess-gone no longer exists/);
});

test("a retry-safe operation is re-run at boot; the run then continues", async () => {
  const run = newRun();
  seedCompletedPlan(run.id);
  // The persisted state a crash mid-operation leaves behind.
  const step = store.appendStep({
    runId: run.id,
    kind: "host-operation",
    payload: {
      operation: recipe.COMMIT_SYNC_OPERATION_ID,
      idempotencyKey: recipe.commitSyncIdempotencyKey(run.id, 0),
    },
    actor: SYSTEM,
  });
  store.startStep(
    step.id,
    { kind: "operation", id: recipe.COMMIT_SYNC_OPERATION_ID },
    SYSTEM,
  );

  await engine.reconcileWorkflowRunsOnBoot();

  const recovered = store.getStep(step.id)!;
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.attempt, 2, "the re-run counts as an attempt");
  assert.equal(commitSyncRuns, 1);
  assert.equal(store.getRun(run.id)!.lifecycle, "active");
  // And the advance that follows admits what its result allows.
  const review = lastStep(run.id);
  assert.equal(review.kind, "agent");
  assert.equal(review.status, "running");
});

test("boot never re-runs an operation for a recipe version it no longer knows", async () => {
  taskId += 1;
  const run = store.createRun({
    taskId,
    recipeId: recipe.CODE_DELIVERY_RECIPE_ID,
    recipeVersion: recipe.CODE_DELIVERY_RECIPE_VERSION + 1,
    maxIterations: 1,
    maxReviewPasses: 1,
    actor: USER,
  });
  store.attachRunWorktree(
    run.id,
    { worktreeId: `wt-${run.id}`, branch: `t365-run-${run.id}` },
    SYSTEM,
  );
  // A retry-safe operation was in flight when the process died — but this
  // process no longer has the decision function that admitted it.
  const step = store.appendStep({
    runId: run.id,
    kind: "host-operation",
    payload: {
      operation: recipe.COMMIT_SYNC_OPERATION_ID,
      idempotencyKey: recipe.commitSyncIdempotencyKey(run.id, 0),
    },
    actor: SYSTEM,
  });
  store.startStep(
    step.id,
    { kind: "operation", id: recipe.COMMIT_SYNC_OPERATION_ID },
    SYSTEM,
  );

  await engine.reconcileWorkflowRunsOnBoot();

  assert.equal(commitSyncRuns, 0, "no side effect ran for an unknown recipe");
  const untouched = store.getStep(step.id)!;
  assert.equal(untouched.status, "running");
  assert.equal(untouched.attempt, 1, "not even an attempt was recorded");
  const paused = store.getRun(run.id)!;
  assert.equal(paused.lifecycle, "paused");
  assert.equal(
    paused.lifecycleReason,
    `unknown recipe code-delivery@${recipe.CODE_DELIVERY_RECIPE_VERSION + 1}`,
  );
});

test("boot pauses a two-open-step history instead of recovering into it", async () => {
  const run = newRun();
  // A retry-safe operation was in flight, and the persisted history also holds
  // a second open reservation — a state the recipe would never have produced.
  const operation = store.appendStep({
    runId: run.id,
    kind: "host-operation",
    payload: {
      operation: recipe.COMMIT_SYNC_OPERATION_ID,
      idempotencyKey: recipe.commitSyncIdempotencyKey(run.id, 0),
    },
    actor: SYSTEM,
  });
  store.startStep(
    operation.id,
    { kind: "operation", id: recipe.COMMIT_SYNC_OPERATION_ID },
    SYSTEM,
  );
  const stray = store.appendStep({
    runId: run.id,
    kind: "agent",
    payload: { role: "implementer", objective: "implement" },
    actor: SYSTEM,
  });

  await engine.reconcileWorkflowRunsOnBoot();

  assert.equal(commitSyncRuns, 0, "the breach is detected before any recovery");
  const untouched = store.getStep(operation.id)!;
  assert.equal(untouched.status, "running");
  assert.equal(untouched.attempt, 1, "not even an attempt was recorded");
  assert.equal(store.getStep(stray.id)!.status, "pending");
  const paused = store.getRun(run.id)!;
  assert.equal(paused.lifecycle, "paused");
  assert.equal(
    paused.lifecycleReason,
    `workflow invariant breach: 2 open steps (${operation.id}, ${stray.id}); a run executes one step at a time`,
  );
});

for (const policy of ["observe-first", "indeterminate"] as const) {
  test(`a running ${policy} operation pauses at boot instead of re-running`, async () => {
    const run = newRun();
    executors.registerWorkflowHostOperation({
      id: "risky",
      recoveryPolicy: policy,
      execute: async () => {
        throw new Error("must not run");
      },
    });
    const step = store.appendStep({
      runId: run.id,
      kind: "host-operation",
      payload: { operation: "risky", idempotencyKey: "k" },
      actor: SYSTEM,
    });
    store.startStep(step.id, { kind: "operation", id: "risky" }, SYSTEM);

    await engine.reconcileWorkflowRunsOnBoot();

    const paused = store.getRun(run.id)!;
    assert.equal(paused.lifecycle, "paused");
    assert.match(
      paused.lifecycleReason ?? "",
      new RegExp(`is ${policy} after a restart`),
    );
    assert.equal(store.getStep(step.id)!.status, "running", "left untouched");
  });
}

test("a running operation with no registered executor pauses at boot", async () => {
  const run = newRun();
  const step = store.appendStep({
    runId: run.id,
    kind: "host-operation",
    payload: { operation: "gone-away", idempotencyKey: "k" },
    actor: SYSTEM,
  });
  store.startStep(step.id, { kind: "operation", id: "gone-away" }, SYSTEM);

  await engine.reconcileWorkflowRunsOnBoot();

  const paused = store.getRun(run.id)!;
  assert.equal(paused.lifecycle, "paused");
  assert.match(
    paused.lifecycleReason ?? "",
    /"gone-away".*has no registered executor/,
  );
});

test("boot leaves paused runs paused", async () => {
  const run = newRun();
  await engine.advanceRun(run.id);
  engine.pauseRun(run.id, "waiting on the user", USER);

  engine.resetWorkflowEngineForTests();
  agent.dispatched = [];
  await engine.reconcileWorkflowRunsOnBoot();

  const still = store.getRun(run.id)!;
  assert.equal(still.lifecycle, "paused");
  assert.equal(still.lifecycleReason, "waiting on the user");
  assert.deepEqual(agent.dispatched, []);
});

test("a failed review settles the run: no Resume, and Cancel keeps the work", async () => {
  // `fail` is the one deliberate dead end (docs/agent-workflows.md). The card
  // must say so rather than offer a Resume that re-derives the same pause the
  // instant it is pressed — the assessment COMPLETED, so Retry does not apply
  // either, and a run with two controls that do nothing is the exact shape this
  // engine exists to eliminate.
  const run = newRun();
  await engine.advanceRun(run.id);
  await implementationDone(run.id);
  await assessmentDone(run.id, "fail", ["the approach is wrong"]);

  const stopped = store.getRun(run.id)!;
  assert.equal(stopped.lifecycle, "paused");
  const card = cards.workflowRunCardOf(stopped, store.listSteps(run.id));
  assert.equal(card.canResume, false, "Resume would come straight back");
  assert.equal(card.canRetry, false, "and a completed step is not retryable");

  // Resuming anyway re-derives the identical pause rather than moving.
  await engine.resumeRun(run.id, USER);
  const again = store.getRun(run.id)!;
  assert.equal(again.lifecycle, "paused");
  assert.equal(again.lifecycleReason, stopped.lifecycleReason);

  // Cancel is the exit, and it keeps everything the user might want.
  await engine.cancelRun(run.id, USER);
  const cancelled = store.getRun(run.id)!;
  assert.equal(cancelled.lifecycle, "cancelled");
  assert.equal(cancelled.worktreeId, `wt-${run.id}`);
});

test("a restart across an open gate keeps the gate's own question", async () => {
  // The window between starting the user-decision row and pausing on it. Boot
  // used to find a running step of a kind it had no branch for and pause with
  // "has no recovery path" — describing the engine instead of the question the
  // card is asking, on a gate that was answerable the whole time.
  const run = newRun({ maxIterations: 1 });
  await engine.advanceRun(run.id);
  await implementationDone(run.id);
  await assessmentDone(run.id, "revise", ["fix it"]);
  await implementationDone(run.id);
  await assessmentDone(run.id, "revise", ["still not there"]);
  const gate = lastStep(run.id);
  assert.equal(gate.kind, "user-decision");
  const asked = store.getRun(run.id)!.lifecycleReason;
  assert.match(asked ?? "", /ceiling and wanted to/);

  // The crash: an active run whose gate row is already running.
  store.setRunLifecycle(run.id, "active", { actor: SYSTEM });
  engine.resetWorkflowEngineForTests();
  agent.dispatched = [];
  await engine.reconcileWorkflowRunsOnBoot();

  const recovered = store.getRun(run.id)!;
  assert.equal(recovered.lifecycle, "paused");
  assert.equal(recovered.lifecycleReason, asked, "the gate's own words");
  assert.equal(store.getStep(gate.id)!.status, "running", "still answerable");

  // And it is: answering settles the same row rather than a replacement.
  await engine.answerCeilingDecision(
    run.id,
    { choice: "cancel" },
    { kind: "user" },
  );
  assert.equal(store.getStep(gate.id)!.status, "completed");
});

test("a ceiling gate records the user's answer, whichever one it is", async () => {
  const run = newRun({ maxIterations: 1 });
  await engine.advanceRun(run.id);
  await implementationDone(run.id);
  await assessmentDone(run.id, "revise", ["fix it"]);
  await implementationDone(run.id);
  await assessmentDone(run.id, "revise", ["still not there"]);

  const gate = lastStep(run.id);
  assert.equal(gate.kind, "user-decision");

  // A raise that moves nothing is refused: settling the gate on it would close
  // the only surface that can move the ceiling.
  await assert.rejects(
    engine.answerCeilingDecision(
      run.id,
      {
        choice: "raise",
        adjustment: {
          mode: "set",
          ceilings: { maxIterations: 1, maxReviewPasses: 1 },
        },
      },
      { kind: "user" },
    ),
    /already at the ceilings this answer names/,
  );
  assert.equal(store.getStep(gate.id)!.status, "running", "the gate is open");

  // A choice this gate never offered is refused for the same reason: recording
  // it would settle the decision into an outcome the run cannot carry out.
  // The shape is pinned first and the refusal is unconditional: guarding the
  // rejection behind a check of the same list let it stop running silently —
  // which is what it was doing, since this gate DOES offer `deliver`.
  const offered = (store.getStep(gate.id)!.payload as Record<string, unknown>)
    .allowedChoices as string[];
  assert.deepEqual(
    offered,
    ["raise", "deliver", "cancel"],
    "a head to ship means deliver is on offer and re-evaluate is not",
  );
  await assert.rejects(
    engine.answerCeilingDecision(
      run.id,
      { choice: "re-evaluate" },
      { kind: "user" },
    ),
    /does not offer "re-evaluate"/,
  );

  // Cancelling is one of the gate's own choices, so it is COMPLETED with that
  // answer rather than swept up by the lifecycle transition.
  await engine.cancelRun(run.id, { kind: "user" });
  const settled = store.getStep(gate.id)!;
  assert.equal(settled.status, "completed");
  assert.deepEqual(settled.result?.payload, { choice: "cancel" });
  assert.equal(store.getRun(run.id)!.lifecycle, "cancelled");
});

test("raising a ceiling resumes the work the run was blocked on", async () => {
  const run = newRun({ maxIterations: 1 });
  await engine.advanceRun(run.id);
  await implementationDone(run.id);
  await assessmentDone(run.id, "revise", ["fix it"]);
  await implementationDone(run.id);
  await assessmentDone(run.id, "revise", ["still not there"]);

  const gate = lastStep(run.id);
  await engine.answerCeilingDecision(
    run.id,
    {
      choice: "raise",
      adjustment: { mode: "raise-by", amounts: { maxIterations: 2 } },
    },
    { kind: "user" },
  );

  assert.equal(store.getRun(run.id)!.maxIterations, 3);
  assert.equal(store.getStep(gate.id)!.result?.status, "completed");
  const resumed = lastStep(run.id);
  assert.equal(
    (resumed.payload as Record<string, unknown>).objective,
    "revise",
    "the fix round the ceiling was blocking",
  );
  assert.equal(store.getRun(run.id)!.lifecycle, "active");
});

test("a raise is not bound by the start-form maxima", async () => {
  // The start sheet's bounds guard a one-tap form against a typo; a raise at
  // an open gate is the user's explicit decision to let the run continue, so
  // the engine takes the numbers as given — clamping them back would leave a
  // run at the wire maximum with no way to be continued.
  const run = newRun({ maxIterations: 1 });
  await engine.advanceRun(run.id);
  await implementationDone(run.id);
  await assessmentDone(run.id, "revise", ["fix it"]);
  await implementationDone(run.id);
  await assessmentDone(run.id, "revise", ["still not there"]);

  const gate = lastStep(run.id);
  await engine.answerCeilingDecision(
    run.id,
    {
      choice: "raise",
      adjustment: {
        mode: "set",
        ceilings: { maxIterations: 12, maxReviewPasses: 6 },
      },
    },
    { kind: "user" },
  );

  assert.equal(store.getStep(gate.id)!.result?.status, "completed");
  const raised = store.getRun(run.id)!;
  assert.equal(raised.maxIterations, 12);
  assert.equal(raised.maxReviewPasses, 6);
});

test("a ceiling gate refuses a choice it never offered", async () => {
  // A block with no head behind it offers raise and cancel only; accepting
  // "deliver" anyway would settle the decision into a dead end.
  const run = newRun();
  store.appendStep({
    runId: run.id,
    kind: "user-decision",
    payload: {
      decision: "raise-ceilings",
      blocked: "iterations",
      wanted: "re-review work whose head moved",
      ceilings: { maxIterations: 2, maxReviewPasses: 1 },
      spent: { iterations: 2, reviewPasses: 1, sessions: 3 },
      headCarriesDiscoveryReview: false,
      allowedChoices: ["raise", "cancel"],
    },
    actor: USER,
  });
  await engine.advanceRun(run.id);

  await assert.rejects(
    engine.answerCeilingDecision(
      run.id,
      { choice: "deliver" },
      { kind: "user" },
    ),
    /does not offer "deliver"/,
  );
  assert.equal(lastStep(run.id).status, "running", "the gate stays open");
});

test("a raise and its gate settle together, and a half-applied one still finishes", async () => {
  const run = newRun({ maxIterations: 1 });
  await engine.advanceRun(run.id);
  await implementationDone(run.id);
  await assessmentDone(run.id, "revise", ["fix it"]);
  await implementationDone(run.id);
  await assessmentDone(run.id, "revise", ["still not there"]);
  const gate = lastStep(run.id);

  // Atomic: the ceiling and the answer that allowed it land together, so no
  // crash can leave one without the other.
  await engine.answerCeilingDecision(
    run.id,
    {
      choice: "raise",
      adjustment: {
        mode: "set",
        ceilings: { maxIterations: 3, maxReviewPasses: 1 },
      },
    },
    { kind: "user" },
  );
  assert.equal(store.getRun(run.id)!.maxIterations, 3);
  const settled = store.getStep(gate.id)!;
  assert.equal(settled.status, "completed");
  assert.deepEqual(settled.result?.payload, {
    choice: "raise",
    adjustment: {
      mode: "set",
      ceilings: { maxIterations: 3, maxReviewPasses: 1 },
    },
    maxIterations: 3,
    maxReviewPasses: 1,
  });
  const raises = store
    .listEvents(run.id)
    .filter((event) => event.type === "run-ceilings-raised");
  assert.equal(raises.length, 1, "one raise, one record");
  assert.deepEqual(raises[0]!.detail, {
    from: { maxIterations: 1, maxReviewPasses: 1 },
    to: { maxIterations: 3, maxReviewPasses: 1 },
    by: { maxIterations: 2, maxReviewPasses: 0 },
    adjustment: {
      mode: "set",
      ceilings: { maxIterations: 3, maxReviewPasses: 1 },
    },
  });
});

test("a run whose ceiling already moved can still answer its open gate", async () => {
  // The state a crash between two writes used to leave: the ceiling is raised
  // and the gate is still open. The card reads the RUN's ceilings, so the raise
  // it offers is a real move and the gate settles instead of stranding.
  const run = newRun({ maxIterations: 1 });
  await engine.advanceRun(run.id);
  await implementationDone(run.id);
  await assessmentDone(run.id, "revise", ["fix it"]);
  await implementationDone(run.id);
  await assessmentDone(run.id, "revise", ["still not there"]);
  const gate = lastStep(run.id);

  // Simulate the interrupted half: the ceiling moved on its own.
  store.raiseRunCeilings(run.id, { maxIterations: 2 }, { kind: "user" });
  const card = cards.workflowRunCardOf(
    store.getRun(run.id)!,
    store.listSteps(run.id),
  );
  assert.deepEqual(card.ceilingDecision?.ceilings, {
    maxIterations: 2,
    maxReviewPasses: 1,
  });

  // Answering with what that card offers (one more of the blocked ceiling) is
  // accepted, settles the gate, and continues the run.
  await engine.answerCeilingDecision(
    run.id,
    {
      choice: "raise",
      adjustment: {
        mode: "set",
        ceilings: { maxIterations: 3, maxReviewPasses: 1 },
      },
    },
    { kind: "user" },
  );
  assert.equal(store.getStep(gate.id)!.status, "completed");
  assert.equal(store.getRun(run.id)!.maxIterations, 3);
  assert.equal(
    (lastStep(run.id).payload as Record<string, unknown>).objective,
    "revise",
    "the fix round the ceiling was blocking",
  );
});

async function settle(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition did not settle");
}

test("cancel lands before the run chain, not behind a long host operation", async () => {
  // A host operation can hold the per-run chain for as long as its own deadline
  // — CI observation polls for up to half an hour — and a Cancel that visibly
  // does nothing until then is not the immediate control this module promises.
  const run = newRun();
  let release: (() => void) | undefined;
  executors.registerWorkflowHostOperation({
    id: "slow-operation",
    recoveryPolicy: "indeterminate",
    async execute() {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { status: "completed", summary: "eventually" };
    },
  });
  const slow = store.appendStep({
    runId: run.id,
    kind: "host-operation",
    payload: { operation: "slow-operation", idempotencyKey: "wf:slow:1" },
    actor: USER,
  });
  const advancing = engine.advanceRun(run.id, USER);
  await settle(() => store.getStep(slow.id)!.status === "running");

  // The operation is still in flight and holding the chain.
  const cancelling = engine.cancelRun(run.id, { kind: "user" }, "stop it");
  await settle(() => store.getRun(run.id)!.lifecycle !== "active");
  assert.equal(
    store.getStep(slow.id)!.status,
    "running",
    "the operation has not finished",
  );
  assert.match(
    store.getRun(run.id)!.lifecycleReason ?? "",
    /stop it/,
    "the user's cancel landed immediately",
  );

  // What the USER sees while the operation still holds the chain: a card that
  // says cancelling and offers no control that contradicts it.
  const card = cards.workflowRunCardOf(
    store.getRun(run.id)!,
    store.listSteps(run.id),
  );
  assert.equal(card.cancelRequested, true);

  // And Resume cannot defeat a queued cancellation.
  await assert.rejects(
    engine.resumeRun(run.id, USER),
    /being cancelled at the user's request/,
  );
  assert.equal(store.getRun(run.id)!.lifecycle, "paused");

  release!();
  await advancing;
  await cancelling;
  const settled = store.getRun(run.id)!;
  assert.equal(settled.lifecycle, "cancelled");
  // Settlement finished, so the pending marker is gone: a terminal run that
  // still announced "cancelling" would describe work that is no longer waiting.
  assert.equal(settled.cancelRequestedAt, undefined);
  assert.equal(
    cards.workflowRunCardOf(settled, store.listSteps(run.id)).cancelRequested,
    undefined,
  );
});

test("cancelling an already-paused run replaces its reason and still settles", async () => {
  const run = newRun();
  store.setRunLifecycle(run.id, "paused", {
    reason: "paused for something else",
    actor: USER,
  });
  await engine.cancelRun(run.id, { kind: "user" }, "no longer wanted");
  assert.equal(store.getRun(run.id)!.lifecycle, "cancelled");
  const events = store.listEvents(run.id);
  assert.ok(
    events.some((event) => event.type === "run-cancel-requested"),
    "the request is recorded before the settlement",
  );
});

test("a cancellation recorded before a crash is settled at boot", async () => {
  // The durable half of the same guarantee: the process that took the request
  // never finished settling it, and the run must not come back as an ordinary
  // paused run offering Resume.
  const run = newRun();
  store.requestRunCancellation(run.id, USER);
  store.setRunLifecycle(run.id, "paused", {
    reason: "cancelling at the user's request",
    actor: USER,
  });

  engine.resetWorkflowEngineForTests();
  await engine.reconcileWorkflowRunsOnBoot();

  const settled = store.getRun(run.id)!;
  assert.equal(settled.lifecycle, "cancelled");
  assert.equal(settled.cancelRequestedAt, undefined, "the request is settled");
});
