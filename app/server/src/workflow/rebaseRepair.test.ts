import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import type { WorkflowRunRow, WorkflowStepRow } from "../db/workflowStore.ts";

const tmp = mkdtempSync(join(tmpdir(), "workflow-rebase-repair-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const worktrees = await import("../db/worktreeStore.ts");
const workflowStore = await import("../db/workflowStore.ts");
const { closeDb } = await import("../db/index.ts");
const engine = await import("./engine.ts");
const recipe = await import("./codeDeliveryRecipe.ts");
const { finalizeRebaseRepair } = await import("./rebaseRepair.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { subagentStore } = await import("../db/subagentStore.ts");

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
    { cwd, encoding: "utf8" },
  );
}

function fixture(name: string) {
  const main = join(tmp, `${name}-main`);
  const feature = join(tmp, `${name}-feature`);
  git(tmp, "init", "--initial-branch=main", main);
  writeFileSync(join(main, "file.txt"), "base\n");
  git(main, "add", "-A");
  git(main, "commit", "-m", "base");
  git(main, "worktree", "add", "-b", `${name}-feature`, feature);
  writeFileSync(join(feature, "file.txt"), "feature\n");
  git(feature, "add", "-A");
  git(feature, "commit", "-m", "feature");
  const originalHead = git(feature, "rev-parse", "HEAD").trim();
  writeFileSync(join(main, "file.txt"), "main\n");
  git(main, "add", "-A");
  git(main, "commit", "-m", "main");

  const id = `wt-${name}`;
  worktrees.insertWorktree({
    id,
    projectId: `project-${name}`,
    mainRepoRoot: main,
    path: feature,
    branch: `${name}-feature`,
    baseBranch: "main",
    baseCommit: git(main, "rev-parse", "HEAD").trim(),
    status: "active",
    mergeStateJson: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    removedAt: null,
  });
  const run: WorkflowRunRow = {
    id: Math.floor(Math.random() * 1_000_000),
    taskId: 400,
    projectId: `project-${name}`,
    recipeId: "code-delivery",
    recipeVersion: 12,
    worktreeId: id,
    branch: `${name}-feature`,
    lifecycle: "active",
    maxIterations: 2,
    maxReviewPasses: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const step: WorkflowStepRow = {
    id: run.id,
    runId: run.id,
    kind: "agent",
    payload: {
      role: "implementer",
      objective: "repair-rebase",
      files: ["file.txt"],
      truncated: false,
      baseBranch: "main",
      originalHead,
      resultContract: "implementation-result",
    },
    status: "running",
    attempt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  return { id, main, feature, originalHead, run, step };
}

afterAll(() => {
  engine.setWorkflowSessionAbortForTests(null);
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

test("a non-success repair is aborted and reset to its exact clean original head", async () => {
  const rig = fixture("blocked");
  const rebase = spawnSync("git", ["rebase", "main"], {
    cwd: rig.feature,
    encoding: "utf8",
  });
  assert.notEqual(rebase.status, 0);
  writeFileSync(join(rig.feature, "repair-scratch.txt"), "temporary\n");

  const safety = await finalizeRebaseRepair(rig.run, rig.step, "blocked");

  assert.deepEqual(safety, {
    verified: true,
    restored: true,
    originalHead: rig.originalHead,
  });
  assert.equal(git(rig.feature, "rev-parse", "HEAD").trim(), rig.originalHead);
  assert.equal(git(rig.feature, "status", "--porcelain").trim(), "");
  assert.equal(existsSync(join(rig.feature, "repair-scratch.txt")), false);
});

test("cancelling a running repair aborts its turn and restores Git before the run becomes terminal", async () => {
  const rig = fixture("cancelled");
  const run = workflowStore.createRun({
    taskId: 400,
    ...(rig.run.projectId !== undefined
      ? { projectId: rig.run.projectId }
      : {}),
    recipeId: recipe.CODE_DELIVERY_RECIPE_ID,
    recipeVersion: recipe.CODE_DELIVERY_RECIPE_VERSION,
    maxIterations: 2,
    maxReviewPasses: 1,
    actor: { kind: "user" },
  });
  workflowStore.attachRunWorktree(
    run.id,
    { worktreeId: rig.id, branch: rig.run.branch! },
    { kind: "user" },
  );
  const repair = workflowStore.appendStep({
    runId: run.id,
    kind: "agent",
    payload: rig.step.payload,
    actor: { kind: "user" },
  });
  workflowStore.startStep(
    repair.id,
    { kind: "session", id: "repair-session" },
    { kind: "user" },
  );
  const rebase = spawnSync("git", ["rebase", "main"], {
    cwd: rig.feature,
    encoding: "utf8",
  });
  assert.notEqual(rebase.status, 0);
  let aborted = false;
  engine.setWorkflowSessionAbortForTests(async (sessionId) => {
    assert.equal(sessionId, "repair-session");
    aborted = true;
  });

  await engine.cancelRun(run.id, { kind: "user" });

  assert.equal(aborted, true);
  assert.equal(workflowStore.getRun(run.id)?.lifecycle, "cancelled");
  assert.equal(workflowStore.getStep(repair.id)?.status, "cancelled");
  assert.equal(git(rig.feature, "rev-parse", "HEAD").trim(), rig.originalHead);
  assert.equal(git(rig.feature, "status", "--porcelain").trim(), "");
  assert.ok(
    workflowStore
      .listEvents(run.id)
      .some(
        (event) =>
          event.type === "observation-recorded" &&
          (event.detail as Record<string, unknown>)?.cancellation ===
            "rebase-repair-restored",
      ),
  );
});

test("a completed repair is refused while Git is still rebasing", async () => {
  const rig = fixture("completed");
  const rebase = spawnSync("git", ["rebase", "main"], {
    cwd: rig.feature,
    encoding: "utf8",
  });
  assert.notEqual(rebase.status, 0);

  await assert.rejects(
    finalizeRebaseRepair(rig.run, rig.step, "completed"),
    /rebase is still in progress/,
  );
  await finalizeRebaseRepair(rig.run, rig.step, "failed");
});

test("a restart restores Git and fails an interrupted repair that still owed delegated work", async () => {
  // The repair branch of boot reconciliation restores Git FIRST and only then
  // records the failure. A repair agent delegates like any other developer
  // session, and the delegation invariant refused that completion — leaving the
  // run active behind a repair step nothing could ever finish, with Git already
  // restored and no record saying so.
  const rig = fixture("interrupted");
  const run = workflowStore.createRun({
    taskId: 400,
    ...(rig.run.projectId !== undefined
      ? { projectId: rig.run.projectId }
      : {}),
    recipeId: recipe.CODE_DELIVERY_RECIPE_ID,
    recipeVersion: recipe.CODE_DELIVERY_RECIPE_VERSION,
    maxIterations: 2,
    maxReviewPasses: 1,
    actor: { kind: "user" },
  });
  workflowStore.attachRunWorktree(
    run.id,
    { worktreeId: rig.id, branch: rig.run.branch! },
    { kind: "user" },
  );
  const repair = workflowStore.appendStep({
    runId: run.id,
    kind: "agent",
    payload: rig.step.payload,
    actor: { kind: "user" },
  });
  const parentSessionId = "repair-owing-session";
  sessionStore.upsert({
    id: parentSessionId,
    harness: "pi",
    agentType: "developer",
  });
  sessionStore.upsert({
    id: "repair-child-session",
    scope: "subagent",
    harness: "pi",
    agentType: "developer",
  });
  workflowStore.startStep(
    repair.id,
    { kind: "session", id: parentSessionId },
    { kind: "user" },
  );
  subagentStore.acceptInitial({
    thread: {
      parentSessionId,
      sessionId: "repair-child-session",
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
    },
    run: { initiatedBy: "agent", actualThinking: "high" },
    parentLimit: 1,
  });
  // The state a crash mid-repair leaves on disk.
  const rebase = spawnSync("git", ["rebase", "main"], {
    cwd: rig.feature,
    encoding: "utf8",
  });
  assert.notEqual(rebase.status, 0);
  writeFileSync(join(rig.feature, "repair-scratch.txt"), "temporary\n");

  await engine.reconcileWorkflowRunsOnBoot();

  // Git first: restored to the exact pre-repair head, and the evidence for that
  // is on the step's result rather than only in the log.
  assert.equal(git(rig.feature, "rev-parse", "HEAD").trim(), rig.originalHead);
  assert.equal(git(rig.feature, "status", "--porcelain").trim(), "");
  assert.equal(existsSync(join(rig.feature, "repair-scratch.txt")), false);
  const failed = workflowStore.getStep(repair.id)!;
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.result?.payload, {
    rebaseRepairSafety: {
      verified: true,
      restored: true,
      originalHead: rig.originalHead,
    },
  });
  assert.match(failed.result?.summary ?? "", /restored/);
  assert.equal(workflowStore.getRun(run.id)?.lifecycle, "paused");
  // The obligation is recorded rather than enforced against a dead turn.
  assert.deepEqual(
    workflowStore
      .listEvents(run.id)
      .flatMap((event) =>
        event.stepId === repair.id &&
        typeof event.detail === "object" &&
        event.detail !== null &&
        "abandonedDelegationObligation" in event.detail
          ? [String(event.detail.abandonedDelegationObligation)]
          : [],
      ),
    ["it still has active delegated work."],
  );

  // And the run is actionable: Retry moves on through commit-sync.
  await engine.retryRun(run.id, { kind: "user" });
  const successor = workflowStore
    .listSteps(run.id)
    .find((step) => step.predecessorId === repair.id)!;
  assert.equal(successor.kind, "host-operation");

  // The obligation outlives the run, and NOTHING in the run can clear it: the
  // parent turn that would admit a delegated result is gone, and a managed
  // worktree waits on the user. Refusing the terminal transition for it would
  // refuse it after the merge was already observed, and every Resume would
  // re-derive the same refusal — a run that finished but could never say so.
  assert.equal(
    workflowStore.setRunLifecycle(run.id, "completed", {
      actor: { kind: "user" },
    }).lifecycle,
    "completed",
  );
});
