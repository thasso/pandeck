/**
 * The Workflow Run store's persisted contract (Task 364). Run it with:
 *   pnpm --filter @assistant/server test src/db/workflowStore.test.ts
 *
 * Roots the data dir at an isolated temp dir, then exercises what the store
 * exists to guarantee: append-only step history, immutable results, terminal
 * runs and steps that never move again, and a transition log that cannot be
 * bypassed.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "workflow-store-test-"));
process.env.ASSISTANT_CWD = tmp;

const store = await import("./workflowStore.ts");
const { subagentStore } = await import("./subagentStore.ts");
const { sessionStore } = await import("./sessionStore.ts");
const { worktreeIdForSession } = await import("./worktreeStore.ts");
const { closeDb, getDb } = await import("./index.ts");

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

const user = { kind: "user" } as const;
const system = { kind: "system" } as const;

function newRun(taskId = 1) {
  return store.createRun({
    taskId,
    projectId: "personal-assistant",
    recipeId: "code-delivery",
    recipeVersion: 1,
    maxIterations: 3,
    maxReviewPasses: 1,
    actor: user,
  });
}

test("workflow executor results wait for immediate-child obligations", () => {
  const run = newRun(495);
  const step = store.appendStep({
    runId: run.id,
    kind: "agent",
    payload: { objective: "delegate" },
    actor: system,
  });
  const parentSessionId = `workflow-parent-${run.id}`;
  const childSessionId = `workflow-child-${run.id}`;
  sessionStore.upsert({
    id: parentSessionId,
    scope: "internal",
    harness: "pi",
    agentType: "developer",
  });
  sessionStore.upsert({
    id: childSessionId,
    scope: "subagent",
    harness: "pi",
    agentType: "developer",
  });
  store.startStep(step.id, { kind: "session", id: parentSessionId }, system);
  const delegated = subagentStore.acceptInitial({
    thread: {
      parentSessionId,
      sessionId: childSessionId,
      profile: {
        roleName: "implementer",
        baseRole: "developer",
        provider: "openai-codex",
        modelId: "gpt-5.6",
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

  const completion = {
    status: "completed" as const,
    result: { status: "completed" as const, summary: "done" },
    actor: system,
  };
  assert.throws(
    () => store.completeStep(step.id, completion),
    /active delegated work/,
  );
  subagentStore.recordQuiescence(delegated.run.id, "delegated-quiescence");
  subagentStore.finalizeRun({ runId: delegated.run.id, status: "unreported" });
  assert.throws(
    () => store.completeStep(step.id, completion),
    /managed delegated worktree/,
  );
  subagentStore.updateThreadLinkage({
    threadId: delegated.thread.id,
    worktreeId: null,
    worktreeRelation: null,
  });
  assert.equal(store.completeStep(step.id, completion).status, "completed");
});

test("a run starts active, records its creation, and owns its worktree once", () => {
  const run = newRun();
  assert.equal(run.lifecycle, "active");
  assert.equal(run.recipeId, "code-delivery");
  assert.equal(run.maxIterations, 3);
  assert.equal(run.worktreeId, undefined);

  const created = store.listEvents(run.id);
  assert.equal(created.length, 1, "creation appended exactly one event");
  assert.equal(created[0]!.type, "run-created");
  assert.equal(created[0]!.actor.kind, "user");

  const attached = store.attachRunWorktree(
    run.id,
    { worktreeId: "wt-1", branch: "t364-workflow" },
    { kind: "system" },
  );
  assert.equal(attached.worktreeId, "wt-1");
  assert.equal(attached.branch, "t364-workflow");

  // Re-attaching the same pair is a no-op, so a retried provision is safe.
  const again = store.attachRunWorktree(
    run.id,
    { worktreeId: "wt-1", branch: "t364-workflow" },
    system,
  );
  assert.equal(again.updatedAt, attached.updatedAt);

  assert.throws(
    () =>
      store.attachRunWorktree(
        run.id,
        { worktreeId: "wt-2", branch: "other" },
        system,
      ),
    store.WorkflowImmutableError,
    "a run's worktree is part of its identity and never moves",
  );
});

test("attaching a delayed worktree backfills an existing coordinator session", () => {
  const run = newRun();
  const sessionId = `coordinator-${run.id}`;
  sessionStore.upsert({
    id: sessionId,
    harness: "pi",
    agentType: "workflow-coordinator",
  });
  const step = store.appendStep({
    runId: run.id,
    kind: "agent",
    payload: { role: "coordinator", objective: "plan" },
    actor: system,
  });
  store.startStep(step.id, { kind: "session", id: sessionId }, system);

  store.attachRunWorktree(
    run.id,
    { worktreeId: `wt-coordinator-${run.id}`, branch: "delayed" },
    system,
  );

  assert.equal(worktreeIdForSession(sessionId), `wt-coordinator-${run.id}`);
});

test("a step reaches exactly one terminal status and keeps its result", () => {
  const run = newRun(2);
  const step = store.appendStep({
    runId: run.id,
    kind: "agent",
    payload: { objective: "implement", taskId: 2 },
    actor: system,
  });
  assert.equal(step.status, "pending");
  assert.equal(step.attempt, 0);
  assert.equal(step.executor, undefined);

  const running = store.startStep(
    step.id,
    { kind: "session", id: "sess-a" },
    system,
  );
  assert.equal(running.status, "running");
  assert.equal(running.attempt, 1);
  assert.deepEqual(running.executor, { kind: "session", id: "sess-a" });
  assert.ok(running.startedAt);
  assert.deepEqual(store.workflowOwnershipForExecutor("sess-a"), [
    {
      runId: run.id,
      stepId: step.id,
      sessionId: "sess-a",
      stepStatus: "running",
      runLifecycle: "active",
    },
  ]);

  assert.deepEqual(
    store.openStepForExecutor("session", "sess-a")?.id,
    step.id,
    "the session's active assignment is findable",
  );

  const retried = store.recordStepAttempt(step.id, system);
  assert.equal(
    retried.attempt,
    2,
    "operational retries count on the open step",
  );

  const done = store.completeStep(step.id, {
    status: "completed",
    result: {
      status: "completed",
      summary: "Implemented the thing",
      contractId: "implementation-result",
      payload: { headCommit: "abc1234" },
    },
    actor: { kind: "agent", id: "sess-a" },
  });
  assert.equal(done.status, "completed");
  assert.equal(done.result?.contractId, "implementation-result");
  assert.deepEqual(done.result?.payload, { headCommit: "abc1234" });
  assert.ok(done.endedAt);
  assert.equal(
    store.openStepForExecutor("session", "sess-a"),
    null,
    "a finished step releases its session",
  );

  assert.throws(
    () =>
      store.completeStep(step.id, {
        status: "failed",
        result: { status: "failed", summary: "second thoughts" },
        actor: system,
      }),
    store.WorkflowImmutableError,
    "a terminal step and its result are immutable",
  );
  assert.throws(
    () => store.startStep(step.id, { kind: "session", id: "sess-b" }, system),
    store.WorkflowImmutableError,
  );
  assert.throws(
    () => store.recordStepAttempt(step.id, system),
    store.WorkflowImmutableError,
  );
  assert.equal(
    store.getStep(step.id)!.result!.summary,
    "Implemented the thing",
    "the refused writes changed nothing",
  );

  const types = store.listEvents(run.id).map((e) => e.type);
  assert.deepEqual(types, [
    "run-created",
    "step-created",
    "step-started",
    "step-attempted",
    "result-submitted",
    "step-completed",
  ]);
});

test("a revision appends a successor instead of reopening history", () => {
  const run = newRun(3);
  const first = store.appendStep({
    runId: run.id,
    kind: "agent",
    payload: { objective: "review" },
    actor: system,
  });
  store.startStep(first.id, { kind: "session", id: "sess-r" }, system);
  store.completeStep(first.id, {
    status: "completed",
    result: {
      status: "completed",
      summary: "needs work",
      contractId: "assessment",
      payload: { verdict: "revise", headCommit: "abc1234" },
    },
    actor: { kind: "agent", id: "sess-r" },
  });

  const successor = store.appendStep({
    runId: run.id,
    kind: "agent",
    payload: { objective: "implement", revision: true },
    predecessorId: first.id,
    actor: system,
  });
  assert.equal(successor.predecessorId, first.id);

  const steps = store.listSteps(run.id);
  assert.deepEqual(
    steps.map((s) => s.id),
    [first.id, successor.id],
    "history is append-ordered and keeps the superseded step",
  );
  assert.deepEqual(
    store.listOpenSteps(run.id).map((s) => s.id),
    [successor.id],
  );
});

test("a terminal run never moves again and admits no new steps", () => {
  const run = newRun(4);
  const paused = store.setRunLifecycle(run.id, "paused", {
    reason: "CI failed on the reviewed commit",
    actor: system,
  });
  assert.equal(paused.lifecycle, "paused");
  assert.equal(paused.lifecycleReason, "CI failed on the reviewed commit");
  assert.equal(paused.endedAt, undefined);

  const resumed = store.setRunLifecycle(run.id, "active", { actor: user });
  assert.equal(resumed.lifecycle, "active");
  assert.equal(
    resumed.lifecycleReason,
    undefined,
    "a resume clears the reason",
  );

  const cancelled = store.setRunLifecycle(run.id, "cancelled", {
    reason: "user cancelled",
    actor: user,
  });
  assert.ok(cancelled.endedAt, "a terminal lifecycle stamps endedAt");

  assert.throws(
    () => store.setRunLifecycle(run.id, "active", { actor: user }),
    store.WorkflowImmutableError,
  );
  assert.throws(
    () =>
      store.appendStep({
        runId: run.id,
        kind: "host-operation",
        payload: { operation: "push" },
        actor: system,
      }),
    store.WorkflowImmutableError,
  );
  assert.deepEqual(store.listSteps(run.id), []);
});

test("only cancelled runs can be explicitly deleted with their whole history", () => {
  const run = newRun(41);
  store.appendStep({
    runId: run.id,
    kind: "agent",
    payload: { objective: "mistaken attempt" },
    actor: system,
  });

  assert.throws(
    () => store.deleteCancelledRun(run.id),
    /only a cancelled run can be deleted/,
  );
  store.setRunLifecycle(run.id, "cancelled", {
    reason: "wrong base branch",
    actor: user,
  });
  assert.ok(store.listSteps(run.id).length > 0);
  assert.ok(store.listEvents(run.id).length > 0);

  store.deleteCancelledRun(run.id);
  assert.equal(store.getRun(run.id), null);
  assert.deepEqual(store.listSteps(run.id), []);
  assert.deepEqual(store.listEvents(run.id), []);
  assert.throws(() => store.deleteCancelledRun(run.id), /does not exist/);
});

test("prose is truncated, structured payloads are refused, not cut", () => {
  const run = newRun(5);
  const step = store.appendStep({
    runId: run.id,
    kind: "host-operation",
    payload: { operation: "commit" },
    actor: system,
  });
  store.startStep(step.id, { kind: "operation", id: "commit" }, system);
  const done = store.completeStep(step.id, {
    status: "failed",
    result: { status: "failed", summary: "x".repeat(9_000) },
    actor: system,
  });
  assert.equal(
    done.result!.summary.length,
    2_000,
    "a summary is a label, so it is bounded rather than rejected",
  );

  const huge = store.appendStep({
    runId: run.id,
    kind: "agent",
    payload: { objective: "next" },
    actor: system,
  });
  store.startStep(huge.id, { kind: "session", id: "sess-c" }, system);
  assert.throws(
    () =>
      store.completeStep(huge.id, {
        status: "completed",
        result: {
          status: "completed",
          summary: "ok",
          payload: { blob: "y".repeat(20_000) },
        },
        actor: system,
      }),
    store.WorkflowPayloadTooLargeError,
    "large content belongs in its own domain store",
  );
  assert.equal(
    store.getStep(huge.id)!.status,
    "running",
    "the refused completion rolled back",
  );
});

test("a pause blocks admission and starts, but lets a running turn finish", () => {
  const run = newRun(6);
  const running = store.appendStep({
    runId: run.id,
    kind: "agent",
    payload: { objective: "implement" },
    actor: system,
  });
  store.startStep(running.id, { kind: "session", id: "sess-p1" }, system);
  const admitted = store.appendStep({
    runId: run.id,
    kind: "host-operation",
    payload: { operation: "commit" },
    actor: system,
  });

  store.setRunLifecycle(run.id, "paused", {
    reason: "user paused mid-implementation",
    actor: user,
  });

  assert.throws(
    () =>
      store.appendStep({
        runId: run.id,
        kind: "agent",
        payload: { objective: "review" },
        actor: system,
      }),
    store.WorkflowRunPausedError,
    "a paused run admits no new step",
  );
  assert.throws(
    () =>
      store.startStep(admitted.id, { kind: "operation", id: "commit" }, system),
    store.WorkflowRunPausedError,
    "a pending step may not be started while the run is paused",
  );

  // The turn already running is untouched by the pause.
  assert.equal(store.recordStepAttempt(running.id, system).attempt, 2);
  const finished = store.completeStep(running.id, {
    status: "completed",
    result: { status: "completed", summary: "finished after the pause" },
    actor: { kind: "agent", id: "sess-p1" },
  });
  assert.equal(finished.status, "completed");

  store.setRunLifecycle(run.id, "active", { actor: user });
  const started = store.startStep(
    admitted.id,
    { kind: "operation", id: "commit" },
    system,
  );
  assert.equal(started.status, "running", "a resume admits work again");
});

test("ending a run cancels its open steps and closes it to every write", () => {
  const run = newRun(7);
  const open = store.appendStep({
    runId: run.id,
    kind: "agent",
    payload: { objective: "implement" },
    actor: system,
  });
  store.startStep(open.id, { kind: "session", id: "sess-t1" }, system);
  const pending = store.appendStep({
    runId: run.id,
    kind: "wait",
    payload: { condition: "ci" },
    actor: system,
  });

  store.setRunLifecycle(run.id, "cancelled", {
    reason: "user cancelled",
    actor: user,
  });

  assert.deepEqual(
    store.listSteps(run.id).map((s) => s.status),
    ["cancelled", "cancelled"],
    "no step is left waiting on a run that is over",
  );
  assert.deepEqual(store.listOpenSteps(run.id), []);
  assert.equal(
    store.openStepForExecutor("session", "sess-t1"),
    null,
    "the cancelled step releases its session",
  );
  assert.ok(store.getStep(open.id)!.endedAt);

  for (const write of [
    () =>
      store.attachRunWorktree(
        run.id,
        { worktreeId: "wt-x", branch: "b" },
        user,
      ),
    () =>
      store.appendStep({
        runId: run.id,
        kind: "agent",
        payload: {},
        actor: system,
      }),
    () =>
      store.startStep(pending.id, { kind: "session", id: "sess-t2" }, system),
    () => store.recordStepAttempt(open.id, system),
    () => store.completeStep(open.id, { status: "failed", actor: system }),
    () => store.setRunLifecycle(run.id, "active", { actor: user }),
  ])
    assert.throws(write, store.WorkflowImmutableError);
});

test("a session holds at most one active assignment, across runs", () => {
  const runA = newRun(8);
  const runB = newRun(8);
  const inA = store.appendStep({
    runId: runA.id,
    kind: "agent",
    payload: { objective: "implement" },
    actor: system,
  });
  const inB = store.appendStep({
    runId: runB.id,
    kind: "agent",
    payload: { objective: "implement" },
    actor: system,
  });
  store.startStep(inA.id, { kind: "session", id: "sess-shared" }, system);

  assert.throws(
    () =>
      store.startStep(inB.id, { kind: "session", id: "sess-shared" }, system),
    store.WorkflowExecutorBusyError,
    "the invariant is global, not per run",
  );
  assert.equal(
    store.getStep(inB.id)!.status,
    "pending",
    "the refused start rolled back",
  );

  // A host operation is a stateless service: two runs may commit at once.
  const opA = store.appendStep({
    runId: runA.id,
    kind: "host-operation",
    payload: { operation: "commit" },
    actor: system,
  });
  const opB = store.appendStep({
    runId: runB.id,
    kind: "host-operation",
    payload: { operation: "commit" },
    actor: system,
  });
  store.startStep(opA.id, { kind: "operation", id: "commit" }, system);
  store.startStep(opB.id, { kind: "operation", id: "commit" }, system);

  store.completeStep(inA.id, {
    status: "completed",
    result: { status: "completed", summary: "done" },
    actor: { kind: "agent", id: "sess-shared" },
  });
  assert.equal(
    store.startStep(inB.id, { kind: "session", id: "sess-shared" }, system)
      .status,
    "running",
    "the session is free once its assignment ended",
  );
});

test("the schema itself backs both invariants, not only the store's checks", () => {
  const db = getDb();
  const activeSessionIndex = (
    db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='workflow_steps_active_session_idx'",
      )
      .get() as { sql?: string } | undefined
  )?.sql;
  assert.match(
    activeSessionIndex ?? "",
    /CREATE UNIQUE INDEX[\s\S]*executor_kind = 'session'[\s\S]*status IN \('pending','running'\)/,
    "a racing pair of admissions must lose at the database, not at a read",
  );

  const stepKeys = (
    db.prepare("PRAGMA foreign_key_list(workflow_steps)").all() as Array<{
      table: string;
      from: string;
      to: string;
    }>
  ).filter((fk) => fk.table === "workflow_steps");
  assert.deepEqual(
    stepKeys.map((fk) => `${fk.from}->${fk.to}`).sort(),
    ["predecessor_id->id", "run_id->run_id"],
    "the predecessor relation is keyed on (id, run_id), so it cannot cross runs",
  );

  const eventKeys = (
    db.prepare("PRAGMA foreign_key_list(workflow_events)").all() as Array<{
      table: string;
      from: string;
      to: string;
    }>
  ).filter((fk) => fk.table === "workflow_steps");
  assert.deepEqual(
    eventKeys.map((fk) => `${fk.from}->${fk.to}`).sort(),
    ["run_id->run_id", "step_id->id"],
    "an event's step is keyed the same way, so a log cannot name another run's step",
  );
});

test("only a running step reports an attempt or a result", () => {
  const run = newRun(13);
  const pending = store.appendStep({
    runId: run.id,
    kind: "agent",
    payload: { objective: "implement" },
    actor: system,
  });

  assert.throws(
    () => store.recordStepAttempt(pending.id, system),
    store.WorkflowValidationError,
    "a pending step has no in-flight work to attempt again",
  );
  assert.throws(
    () =>
      store.completeStep(pending.id, {
        status: "completed",
        result: { status: "completed", summary: "never ran" },
        actor: system,
      }),
    store.WorkflowValidationError,
    "a step cannot finish without ever having an executor",
  );
  const untouched = store.getStep(pending.id)!;
  assert.equal(untouched.status, "pending");
  assert.equal(untouched.attempt, 0);
  assert.equal(untouched.result, undefined);
});

test("a step's terminal status is the outcome its result reported", () => {
  const run = newRun(14);
  const step = store.appendStep({
    runId: run.id,
    kind: "agent",
    payload: { objective: "implement" },
    actor: system,
  });
  store.startStep(step.id, { kind: "session", id: "sess-m" }, system);

  for (const [status, resultStatus] of [
    ["completed", "failed"],
    ["failed", "completed"],
    ["cancelled", "completed"],
    ["blocked", "failed"],
  ] as const)
    assert.throws(
      () =>
        store.completeStep(step.id, {
          status,
          result: { status: resultStatus, summary: "contradiction" },
          actor: system,
        }),
      store.WorkflowValidationError,
      `${status} step must not carry a ${resultStatus} result`,
    );
  assert.equal(
    store.getStep(step.id)!.status,
    "running",
    "every refused completion rolled back",
  );

  const blocked = store.completeStep(step.id, {
    status: "blocked",
    result: { status: "blocked", summary: "needs a decision" },
    actor: { kind: "agent", id: "sess-m" },
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.result!.status, "blocked");
});

test("a run's event history names only its own steps", () => {
  const runA = newRun(15);
  const runB = newRun(15);
  const inA = store.appendStep({
    runId: runA.id,
    kind: "wait",
    payload: { condition: "ci" },
    actor: system,
  });

  assert.throws(
    () =>
      store.appendEvent({
        runId: runB.id,
        stepId: inA.id,
        type: "observation-recorded",
        actor: { kind: "external", id: "ci" },
      }),
    store.WorkflowValidationError,
    "run B may not log an event about a step of run A",
  );
  assert.throws(
    () =>
      store.appendEvent({
        runId: runB.id,
        stepId: 999_999,
        type: "observation-recorded",
        actor: system,
      }),
    store.WorkflowValidationError,
  );
  assert.deepEqual(
    store.listEvents(runB.id).map((e) => e.type),
    ["run-created"],
    "neither attempt landed",
  );

  // The legitimate shapes: a run-scoped observation, and one about its own step.
  store.appendEvent({
    runId: runA.id,
    type: "observation-recorded",
    actor: { kind: "external", id: "ci" },
    detail: { conclusion: "failure" },
  });
  store.appendEvent({
    runId: runA.id,
    stepId: inA.id,
    type: "observation-recorded",
    actor: { kind: "external", id: "ci" },
  });
  assert.deepEqual(
    store.listEvents(runA.id).map((e) => e.stepId),
    [undefined, inA.id, undefined, inA.id],
    "run-created, step-created, the run-scoped observation, then the step one",
  );
});

test("a pause must state its reason", () => {
  const run = newRun(9);
  for (const reason of [undefined, "", "   "])
    assert.throws(
      () =>
        store.setRunLifecycle(run.id, "paused", {
          ...(reason !== undefined ? { reason } : {}),
          actor: user,
        }),
      store.WorkflowValidationError,
      "a pause the user cannot interpret is worse than none",
    );
  assert.equal(
    store.getRun(run.id)!.lifecycle,
    "active",
    "the refused pause changed nothing",
  );
  assert.equal(
    store.setRunLifecycle(run.id, "paused", {
      reason: "waiting on CI",
      actor: user,
    }).lifecycleReason,
    "waiting on CI",
  );
});

test("a causal chain never crosses runs", () => {
  const runA = newRun(12);
  const runB = newRun(12);
  const inA = store.appendStep({
    runId: runA.id,
    kind: "agent",
    payload: { objective: "implement" },
    actor: system,
  });

  assert.throws(
    () =>
      store.appendStep({
        runId: runB.id,
        kind: "agent",
        payload: { objective: "implement" },
        predecessorId: inA.id,
        actor: system,
      }),
    store.WorkflowValidationError,
    "run B may not name a step of run A as its predecessor",
  );
  assert.throws(
    () =>
      store.appendStep({
        runId: runB.id,
        kind: "agent",
        payload: {},
        predecessorId: 999_999,
        actor: system,
      }),
    store.WorkflowValidationError,
  );
  assert.deepEqual(store.listSteps(runB.id), [], "neither attempt landed");
});

test("runs list newest first and filter by task and lifecycle", () => {
  store.resetWorkflowStoreForTests();
  const a = newRun(10);
  const b = newRun(10);
  const c = newRun(11);
  store.setRunLifecycle(b.id, "completed", { actor: system });

  assert.deepEqual(
    store.listRuns().map((r) => r.id),
    [c.id, b.id, a.id],
  );
  assert.deepEqual(
    store.listRuns({ taskId: 10 }).map((r) => r.id),
    [b.id, a.id],
  );
  assert.deepEqual(
    store.listOpenRuns().map((r) => r.id),
    [c.id, a.id],
    "boot reconciliation sees only the non-terminal runs",
  );
});

test("raising a run's ceilings records who allowed the extra work", () => {
  const run = store.createRun({
    taskId: 1,
    recipeId: "code-delivery",
    recipeVersion: 1,
    maxIterations: 2,
    maxReviewPasses: 1,
    config: {},
    actor: system,
  });
  const raised = store.raiseRunCeilings(run.id, { maxReviewPasses: 3 }, user);
  assert.equal(raised.maxReviewPasses, 3);
  assert.equal(raised.maxIterations, 2, "an unnamed ceiling stays put");
  const event = store
    .listEvents(run.id)
    .find((entry) => entry.type === "run-ceilings-raised");
  assert.equal(event?.actor.kind, "user");
  assert.deepEqual(event?.detail, {
    from: { maxIterations: 2, maxReviewPasses: 1 },
    to: { maxIterations: 2, maxReviewPasses: 3 },
    by: { maxIterations: 0, maxReviewPasses: 2 },
  });

  // A ceiling never comes DOWN: it would describe a past that did not happen,
  // and stopping sooner is what cancel is for.
  const lowered = store.raiseRunCeilings(run.id, { maxReviewPasses: 1 }, user);
  assert.equal(lowered.maxReviewPasses, 3);
  assert.equal(
    store.listEvents(run.id).filter((e) => e.type === "run-ceilings-raised")
      .length,
    1,
    "a no-op raise appends no event",
  );
});

/**
 * The run's attention cursor (Task-677): one revision per MEANINGFUL event —
 * a pause, a completion, a cancellation — and nothing for a resume, a step, or
 * a re-pause that changes nothing. The wake rule is what lets the inbox keep a
 * settled run down while it works and bring it back exactly when it stops.
 */
test("a run's attention revision moves on pause, completion and cancellation alone", () => {
  const run = newRun(677);
  assert.equal(run.attention, undefined, "a new run carries no cursor");

  const step = store.appendStep({
    runId: run.id,
    kind: "agent",
    payload: { role: "implementer" },
    actor: system,
  });
  store.startStep(step.id, { kind: "session", id: "sess-a1" }, system);
  assert.equal(
    store.getRun(run.id)?.attention,
    undefined,
    "a step starting is progress, not an event the user acknowledges",
  );

  const paused = store.setRunLifecycle(run.id, "paused", {
    reason: "implementer failed",
    actor: system,
  });
  assert.deepEqual(
    { ...paused.attention, at: undefined },
    { revision: 1, settledRevision: 0, kind: "paused", at: undefined },
    "a pause is the first revision",
  );
  const samePause = store.setRunLifecycle(run.id, "paused", {
    reason: "implementer failed",
    actor: system,
  });
  assert.equal(
    samePause.attention?.revision,
    1,
    "re-deriving the pause the run already holds is not a new event",
  );
  const repaused = store.setRunLifecycle(run.id, "paused", {
    reason: "cancelling at the user's request",
    actor: user,
  });
  assert.equal(
    repaused.attention?.revision,
    2,
    "a pause for a different reason is one",
  );

  const resumed = store.setRunLifecycle(run.id, "active", { actor: user });
  assert.equal(
    resumed.attention?.revision,
    2,
    "a resume raises nothing: the run starting again is not news",
  );
  assert.equal(resumed.attention?.kind, "paused", "the last event stands");

  const cancelled = store.setRunLifecycle(run.id, "cancelled", { actor: user });
  assert.equal(cancelled.attention?.revision, 3);
  assert.equal(cancelled.attention?.kind, "cancelled");

  const done = newRun(678);
  const completed = store.setRunLifecycle(done.id, "completed", {
    actor: system,
  });
  assert.equal(completed.attention?.revision, 1);
  assert.equal(completed.attention?.kind, "completed");
});

test("settling a run acknowledges what was observed, never the future, and only forward", () => {
  const run = newRun(679);
  store.setRunLifecycle(run.id, "paused", { reason: "one", actor: system });
  store.setRunLifecycle(run.id, "active", { actor: user });
  store.setRunLifecycle(run.id, "completed", { actor: system });
  assert.equal(store.getRun(run.id)?.attention?.revision, 2);

  const stale = store.settleRun(run.id, 1);
  assert.equal(
    stale?.attention?.settledRevision,
    1,
    "a stale click acknowledges the pause it saw, and the completion stays awake",
  );
  assert.ok(
    stale && stale.attention!.revision > stale.attention!.settledRevision,
  );

  const future = store.settleRun(run.id, 99);
  assert.equal(
    future?.attention?.settledRevision,
    2,
    "acknowledging beyond the stored revision clamps to it",
  );

  const backwards = store.settleRun(run.id, 1);
  assert.equal(
    backwards?.attention?.settledRevision,
    2,
    "an older observation arriving later cannot un-acknowledge the newer one",
  );

  assert.equal(
    store
      .listEvents(run.id)
      .some((event) => String(event.type).includes("settle")),
    false,
    "the cursor is the user's reading position, not a transition: no event",
  );
  assert.equal(
    store.getRun(run.id)?.lifecycle,
    "completed",
    "and the terminal run is otherwise untouched",
  );
  assert.equal(store.settleRun(999_999, 1), null, "an unknown run is null");
});
