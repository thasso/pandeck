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

test.each(["interrupted", "live"] as const)(
  "boot recovery protects a %s repair",
  async (mode) => {
    engine.resetWorkflowEngineForTests();
    // The repair branch of boot reconciliation restores Git FIRST and only then
    // records the failure, so the run never sits active behind a repair step
    // nothing could ever finish, with Git already restored and no record saying
    // so.
    const rig = fixture(`boot-${mode}`);
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
    const parentSessionId = "repair-session";
    sessionStore.upsert({
      id: parentSessionId,
      harness: "pi",
      agentType: "developer",
    });
    // Capture the SAME run with this reservation still pending, before the
    // current process starts it. Its later running state is not a crash leftover.
    if (mode === "live") engine.pendingWorkflowAgentsOnBoot();
    workflowStore.startStep(
      repair.id,
      { kind: "session", id: parentSessionId },
      { kind: "user" },
    );
    // The state a crash mid-repair leaves on disk.
    const rebase = spawnSync("git", ["rebase", "main"], {
      cwd: rig.feature,
      encoding: "utf8",
    });
    assert.notEqual(rebase.status, 0);
    writeFileSync(join(rig.feature, "repair-scratch.txt"), "temporary\n");

    await engine.reconcileWorkflowRunsOnBoot();

    if (mode === "live") {
      await engine.reconcileWorkflowRunsOnBoot();
      assert.equal(workflowStore.getStep(repair.id)?.status, "running");
      assert.equal(workflowStore.getRun(run.id)?.lifecycle, "active");
      assert.equal(existsSync(join(rig.feature, "repair-scratch.txt")), true);
      assert.match(git(rig.feature, "status", "--porcelain"), /UU file.txt/);
      assert.equal(workflowStore.getStep(repair.id)?.result, undefined);
      await finalizeRebaseRepair(
        workflowStore.getRun(run.id)!,
        workflowStore.getStep(repair.id)!,
        "failed",
      );
      return;
    }

    // Git first: restored to the exact pre-repair head, and the evidence for that
    // is on the step's result rather than only in the log.
    assert.equal(
      git(rig.feature, "rev-parse", "HEAD").trim(),
      rig.originalHead,
    );
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

    // And the run is actionable: Retry moves on through commit-sync.
    await engine.retryRun(run.id, { kind: "user" });
    const successor = workflowStore
      .listSteps(run.id)
      .find((step) => step.predecessorId === repair.id)!;
    assert.equal(successor.kind, "host-operation");

    // The run can still finish once the user has seen it through.
    assert.equal(
      workflowStore.setRunLifecycle(run.id, "completed", {
        actor: { kind: "user" },
      }).lifecycle,
      "completed",
    );
  },
);

/* ---------------- checkout reads (`docs/workers.md`, W3b) ----------------- */

const { MALFORMED_ANSWERS, answerForPathForTests, recordServedForTests } =
  await import("../test/workerAnswers.ts");
const { CHECKOUT_GIT_METHODS } =
  await import("../workerProtocol/checkoutMethods.ts");
const { WorkerMethodError, WorkerRequestError } =
  await import("../workerProtocol/connection.ts");
const { FILE_METHODS, MalformedWorkerAnswerError } =
  await import("../workerProtocol/fileMethods.ts");
const { isWorkerFailure } = await import("../workers/fileClient.ts");
const { holdFileForTests } = await import("../fileReads.ts");
const { writeAsInProcessWorkerForTests } =
  await import("../workers/inProcessWorker.ts");
const { repoLockKey, withRepoLock } = await import("../gitExec.ts");

const INVALID_FRAME = new Uint8Array(8);
const GIT_METHODS = Object.values(CHECKOUT_GIT_METHODS);

/** A repair whose rebase stopped on a conflict; its rebase-merge path. */
function stoppedRepair(name: string) {
  const rig = fixture(name);
  const rebase = spawnSync("git", ["rebase", "main"], {
    cwd: rig.feature,
    encoding: "utf8",
  });
  assert.notEqual(rebase.status, 0);
  const gitDir = git(rig.feature, "rev-parse", "--absolute-git-dir").trim();
  return { ...rig, rebaseMerge: join(gitDir, "rebase-merge") };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected a rejection");
}

test("a failed repair serves rebase-merge before its abort", async () => {
  const rig = stoppedRepair("served-96");
  const recorder = recordServedForTests([...GIT_METHODS, FILE_METHODS.exists]);
  try {
    await finalizeRebaseRepair(rig.run, rig.step, "failed");
  } finally {
    recorder.stop();
  }
  const served = recorder.served.map((request) =>
    request.args ? request.args.join(" ") : request.path,
  );
  const probe = served.indexOf(rig.rebaseMerge);
  assert.ok(probe >= 0, served.join("\n"));
  assert.equal(served[probe + 1], "rebase --abort");
});

test.each([
  {
    name: "a malformed answer",
    answer: async () => MALFORMED_ANSWERS[FILE_METHODS.exists]!,
    expect: (error: unknown) => error instanceof MalformedWorkerAnswerError,
  },
  {
    name: "a coded refusal",
    answer: async (): Promise<never> => {
      throw new WorkerMethodError("wrong_worker", "Not here.");
    },
    expect: (error: unknown) =>
      error instanceof WorkerRequestError && error.code === "wrong_worker",
  },
])(
  "$name at 96 rejects; no abort runs, the rebase stays, the lock is released",
  async ({ name, answer, expect }) => {
    const rig = stoppedRepair(`failed-96-${name.replace(/\W/g, "-")}`);
    const recorder = recordServedForTests(GIT_METHODS);
    const disarm = answerForPathForTests(
      FILE_METHODS.exists,
      rig.rebaseMerge,
      async () => {
        recorder.served.push({ method: "failed", path: rig.rebaseMerge });
        return answer();
      },
    );
    let error: unknown;
    try {
      error = await rejection(
        finalizeRebaseRepair(rig.run, rig.step, "failed"),
      );
    } finally {
      disarm();
      recorder.stop();
    }
    assert.ok(expect(error) && isWorkerFailure(error), String(error));
    // Nothing ran from the failed probe on: no abort, checkout, reset or clean.
    assert.deepEqual(recorder.served.at(-1), {
      method: "failed",
      path: rig.rebaseMerge,
    });
    assert.ok(existsSync(rig.rebaseMerge), "the stopped rebase stays");
    await withRepoLock(await repoLockKey(rig.main), async () => {});
    git(rig.feature, "rebase", "--abort");
  },
);

test("a held probe at 96, a connection end, then release, rejects", async () => {
  const rig = stoppedRepair("held-96");
  const held = holdFileForTests(rig.rebaseMerge, "exists");
  const pending = rejection(finalizeRebaseRepair(rig.run, rig.step, "failed"));
  await held.reached;
  writeAsInProcessWorkerForTests(INVALID_FRAME);
  held.release();
  const error = await pending;
  assert.match(String(error), /The Worker connection ended/);
  assert.ok(isWorkerFailure(error));
  assert.ok(existsSync(rig.rebaseMerge));
  await withRepoLock(await repoLockKey(rig.main), async () => {});
  git(rig.feature, "rebase", "--abort");
});
