import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import type { WorkflowJsonValue } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "workflow-operation-triage-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const worktrees = await import("../db/worktreeStore.ts");
const store = await import("../db/workflowStore.ts");
const { closeDb } = await import("../db/index.ts");
const recipe = await import("./codeDeliveryRecipe.ts");
const contracts = await import("./resultContracts.ts");
const { finalizeOperationTriage, recordOperationTriageSnapshot } =
  await import("./operationTriage.ts");
const engine = await import("./engine.ts");

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
    { cwd, encoding: "utf8" },
  );
}

/**
 * A run stopped on a reproduced commit-sync failure, with its triage assignment
 * already appended — the state `recordOperationTriageSnapshot` is called in.
 */
function fixture(name: string, captureBeforeStart = false) {
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

  const worktreeId = `wt-${name}`;
  worktrees.insertWorktree({
    id: worktreeId,
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
  const run = store.createRun({
    taskId: 591,
    projectId: `project-${name}`,
    recipeId: recipe.CODE_DELIVERY_RECIPE_ID,
    recipeVersion: recipe.CODE_DELIVERY_RECIPE_VERSION,
    maxIterations: 2,
    maxReviewPasses: 1,
    actor: { kind: "user" },
  });
  store.attachRunWorktree(
    run.id,
    { worktreeId, branch: `${name}-feature` },
    { kind: "user" },
  );
  const failed = store.appendStep({
    runId: run.id,
    kind: "host-operation",
    payload: {
      operation: recipe.COMMIT_SYNC_OPERATION_ID,
      idempotencyKey: recipe.commitSyncIdempotencyKey(run.id, 1),
    },
    actor: { kind: "user" },
  });
  store.startStep(
    failed.id,
    { kind: "operation", id: "commit-sync" },
    {
      kind: "user",
    },
  );
  store.completeStep(failed.id, {
    status: "failed",
    result: { status: "failed", summary: "push rejected: non-fast-forward" },
    actor: { kind: "user" },
  });
  const step = store.appendStep({
    runId: run.id,
    kind: "agent",
    payload: {
      role: "implementer",
      objective: "triage-operation",
      failedOperation: {
        operation: recipe.COMMIT_SYNC_OPERATION_ID,
        phase: "commit-sync",
        stepId: failed.id,
        status: "failed",
        summary: "push rejected: non-fast-forward",
        attempts: 2,
        idempotencyKey: recipe.commitSyncIdempotencyKey(run.id, 1),
      },
      resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
    } as WorkflowJsonValue,
    predecessorId: failed.id,
    actor: { kind: "user" },
  });
  // A boot-pending reservation may start while another run recovers.
  if (captureBeforeStart) engine.pendingWorkflowAgentsOnBoot();
  store.startStep(
    step.id,
    { kind: "session", id: `sess-${name}` },
    {
      kind: "user",
    },
  );
  return { main, feature, originalHead, run: store.getRun(run.id)!, step };
}

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

test("a triage that changed nothing completes with no evidence to record", async () => {
  const rig = fixture("clean");
  await recordOperationTriageSnapshot(rig.run, rig.step);

  assert.equal(
    await finalizeOperationTriage(rig.run, rig.step, "completed"),
    undefined,
  );
});

test("a retry replaces a snapshot recorded before a refused dispatch", async () => {
  const rig = fixture("retry-snapshot");
  await recordOperationTriageSnapshot(rig.run, rig.step);
  writeFileSync(join(rig.feature, "file.txt"), "changed before retry\\n");
  git(rig.feature, "commit", "-am", "user change before retry");
  const retryHead = git(rig.feature, "rev-parse", "HEAD").trim();

  // A second dispatch records its own checkout rather than reusing the
  // snapshot left by a prior start that never reached the agent.
  await recordOperationTriageSnapshot(rig.run, rig.step);
  writeFileSync(join(rig.feature, "scratch.txt"), "triage output\\n");
  const safety = await finalizeOperationTriage(rig.run, rig.step, "blocked");

  assert.equal(safety?.restored, true);
  assert.equal(safety?.originalHead, retryHead);
  assert.equal(git(rig.feature, "rev-parse", "HEAD").trim(), retryHead);
  assert.equal(git(rig.feature, "status", "--porcelain").trim(), "");
});

test("a completed triage that moved HEAD is refused, and nothing is undone", async () => {
  const rig = fixture("moved");
  await recordOperationTriageSnapshot(rig.run, rig.step);
  writeFileSync(join(rig.feature, "file.txt"), "triaged\n");
  git(rig.feature, "commit", "-am", "an unreviewed commit");
  const moved = git(rig.feature, "rev-parse", "HEAD").trim();

  await assert.rejects(
    finalizeOperationTriage(rig.run, rig.step, "completed"),
    /HEAD moved from/,
  );
  // The agent still holds its turn, so its work is left for it to undo rather
  // than destroyed underneath a result it believes it just finished.
  assert.equal(git(rig.feature, "rev-parse", "HEAD").trim(), moved);
});

test("a blocked triage is restored to the exact clean state it was handed", async () => {
  const rig = fixture("blocked");
  await recordOperationTriageSnapshot(rig.run, rig.step);
  writeFileSync(join(rig.feature, "file.txt"), "triaged\n");
  git(rig.feature, "commit", "-am", "an unreviewed commit");
  writeFileSync(join(rig.feature, "scratch.txt"), "temporary\n");
  const rebase = spawnSync("git", ["rebase", "main"], {
    cwd: rig.feature,
    encoding: "utf8",
  });
  assert.notEqual(rebase.status, 0);

  const safety = await finalizeOperationTriage(rig.run, rig.step, "blocked");

  assert.equal(safety?.verified, true);
  assert.equal(safety?.restored, true);
  assert.equal(safety?.originalHead, rig.originalHead);
  assert.ok(
    safety?.violations?.some((item) => item.includes("HEAD moved from")),
    `violations should name the moved head: ${JSON.stringify(safety?.violations)}`,
  );
  assert.equal(git(rig.feature, "rev-parse", "HEAD").trim(), rig.originalHead);
  assert.equal(git(rig.feature, "status", "--porcelain").trim(), "");
  assert.equal(existsSync(join(rig.feature, "scratch.txt")), false);
});

test("a failed run-branch checkout never resets or cleans the other branch", async () => {
  const rig = fixture("checkout-fails");
  await recordOperationTriageSnapshot(rig.run, rig.step);
  const otherBranch = "checkout-fails-other";
  git(rig.feature, "checkout", "-b", otherBranch, "main");
  writeFileSync(join(rig.feature, "file.txt"), "other branch work\\n");
  const otherHead = git(rig.feature, "rev-parse", "HEAD").trim();
  writeFileSync(join(rig.feature, "scratch.txt"), "preserve me\\n");

  const safety = await finalizeOperationTriage(rig.run, rig.step, "blocked");

  assert.equal(safety?.restored, false);
  assert.match(
    safety?.violations?.join(" ") ?? "",
    /no reset or clean was performed/,
  );
  assert.equal(
    git(rig.feature, "branch", "--show-current").trim(),
    otherBranch,
  );
  assert.equal(git(rig.feature, "rev-parse", "HEAD").trim(), otherHead);
  assert.equal(
    git(rig.feature, "status", "--porcelain").includes("scratch.txt"),
    true,
  );
  assert.equal(git(rig.feature, "show", "HEAD:file.txt").trim(), "main");
  assert.equal(
    readFileSync(join(rig.feature, "file.txt"), "utf8"),
    "other branch work\\n",
  );
});

test("a triage handed uncommitted work gets its branch back without losing it", async () => {
  const rig = fixture("dirty");
  // Exactly the state a failed commit-sync leaves: work nobody committed yet.
  writeFileSync(join(rig.feature, "file.txt"), "work in progress\n");
  writeFileSync(join(rig.feature, "new.txt"), "also uncommitted\n");
  await recordOperationTriageSnapshot(rig.run, rig.step);
  git(rig.feature, "add", "-A");
  git(rig.feature, "commit", "-m", "the triage committed it");

  const safety = await finalizeOperationTriage(rig.run, rig.step, "failed");

  assert.equal(safety?.restored, true);
  assert.equal(git(rig.feature, "rev-parse", "HEAD").trim(), rig.originalHead);
  // Not one byte of the user's uncommitted work was discarded to get there.
  assert.equal(
    git(rig.feature, "show", "HEAD:file.txt").trim(),
    "feature",
    "the committed file is back to what the triage was handed",
  );
  assert.match(git(rig.feature, "status", "--porcelain"), /file\.txt/);
  assert.equal(existsSync(join(rig.feature, "new.txt")), true);
});

test("a triage with no recorded snapshot is refused rather than guessed at", async () => {
  const rig = fixture("unsnapshotted");

  await assert.rejects(
    finalizeOperationTriage(rig.run, rig.step, "blocked"),
    /no recorded pre-assignment Git snapshot/,
  );
});

test("a snapshot is refused while the checkout is mid-rebase", async () => {
  const rig = fixture("midrebase");
  const rebase = spawnSync("git", ["rebase", "main"], {
    cwd: rig.feature,
    encoding: "utf8",
  });
  assert.notEqual(rebase.status, 0);

  await assert.rejects(
    recordOperationTriageSnapshot(rig.run, rig.step),
    /cannot start while a rebase is in progress/,
  );
  spawnSync("git", ["rebase", "--abort"], { cwd: rig.feature });
});

test.each(["interrupted", "live"] as const)(
  "boot recovery protects a %s triage",
  async (mode) => {
    engine.resetWorkflowEngineForTests();
    const rig = fixture(`boot-${mode}`, mode === "live");
    await recordOperationTriageSnapshot(rig.run, rig.step);
    // The state a crash mid-triage leaves on disk.
    writeFileSync(join(rig.feature, "scratch.txt"), "temporary\n");
    const rebase = spawnSync("git", ["rebase", "main"], {
      cwd: rig.feature,
      encoding: "utf8",
    });
    assert.notEqual(rebase.status, 0);

    await engine.reconcileWorkflowRunsOnBoot();

    if (mode === "live") {
      await engine.reconcileWorkflowRunsOnBoot();
      assert.equal(store.getStep(rig.step.id)?.status, "running");
      assert.equal(store.getRun(rig.run.id)?.lifecycle, "active");
      assert.equal(existsSync(join(rig.feature, "scratch.txt")), true);
      assert.match(git(rig.feature, "status", "--porcelain"), /UU file.txt/);
      assert.equal(store.getStep(rig.step.id)?.result, undefined);
      await finalizeOperationTriage(rig.run, rig.step, "failed");
      return;
    }

    assert.equal(
      git(rig.feature, "rev-parse", "HEAD").trim(),
      rig.originalHead,
    );
    assert.equal(git(rig.feature, "status", "--porcelain").trim(), "");
    assert.equal(existsSync(join(rig.feature, "scratch.txt")), false);
    const failed = store.getStep(rig.step.id)!;
    assert.equal(failed.status, "failed");
    assert.match(failed.result?.summary ?? "", /restored to the state/);
    assert.equal(
      (failed.result!.payload as Record<string, Record<string, unknown>>)
        .operationTriageSafety?.restored,
      true,
    );
    assert.equal(store.getRun(rig.run.id)?.lifecycle, "paused");
  },
);

test("anything but a triage assignment is left alone by both halves", async () => {
  const rig = fixture("other");
  const implement = store.appendStep({
    runId: rig.run.id,
    kind: "agent",
    payload: { role: "implementer", objective: "implement" },
    actor: { kind: "user" },
  });

  await recordOperationTriageSnapshot(rig.run, implement);
  assert.equal(
    await finalizeOperationTriage(rig.run, implement, "failed"),
    undefined,
  );
  assert.equal(
    store
      .listEvents(rig.run.id)
      .filter(
        (event) =>
          event.stepId === implement.id &&
          typeof event.detail === "object" &&
          event.detail !== null &&
          "operationTriageSnapshot" in event.detail,
      ).length,
    0,
  );
});

/* ---------------- checkout reads (`docs/workers.md`, W3b) ----------------- */

const { MALFORMED_ANSWERS, answerForPathForTests, recordServedForTests } =
  await import("../test/workerAnswers.ts");
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
/** `IN_PROGRESS_MARKERS`, in its order. */
const TRIAGE_MARKERS = [
  ["rebase-merge", "a rebase"],
  ["rebase-apply", "a rebase"],
  ["MERGE_HEAD", "a merge"],
  ["CHERRY_PICK_HEAD", "a cherry-pick"],
  ["REVERT_HEAD", "a revert"],
  ["BISECT_LOG", "a bisect"],
] as const;

const gitDirOf = (cwd: string) =>
  git(cwd, "rev-parse", "--absolute-git-dir").trim();

/** Places `marker` in the git dir as git would: a directory or a file. */
function placeTriageMarker(gitDir: string, marker: string): () => void {
  const path = join(gitDir, marker);
  if (marker.startsWith("rebase-")) mkdirSync(path);
  else writeFileSync(path, "0000000000000000000000000000000000000000\n");
  return () => rmSync(path, { recursive: true, force: true });
}

const snapshotEvents = (runId: number) =>
  store
    .listEvents(runId)
    .filter(
      (event) =>
        typeof event.detail === "object" &&
        event.detail !== null &&
        "operationTriageSnapshot" in event.detail,
    );

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected a rejection");
}

test("a dispatch onto a stopped rebase serves the first marker, and only it", async () => {
  const rig = fixture("served-162");
  const rebase = spawnSync("git", ["rebase", "main"], {
    cwd: rig.feature,
    encoding: "utf8",
  });
  assert.notEqual(rebase.status, 0);
  const gitDir = gitDirOf(rig.feature);
  const recorder = recordServedForTests([FILE_METHODS.exists]);
  try {
    await assert.rejects(
      recordOperationTriageSnapshot(rig.run, rig.step),
      /cannot start while a rebase is in progress/,
    );
  } finally {
    recorder.stop();
    spawnSync("git", ["rebase", "--abort"], { cwd: rig.feature });
  }
  assert.deepEqual(recorder.pathsOf(FILE_METHODS.exists), [
    join(gitDir, "rebase-merge"),
  ]);
});

test("each marker refuses a dispatch with its label; the first in order wins", async () => {
  const rig = fixture("each-marker");
  const gitDir = gitDirOf(rig.feature);
  for (const [marker, label] of TRIAGE_MARKERS) {
    const remove = placeTriageMarker(gitDir, marker);
    try {
      await assert.rejects(
        recordOperationTriageSnapshot(rig.run, rig.step),
        (error: Error) =>
          error.message ===
          `a workflow triage cannot start while ${label} is in progress`,
      );
    } finally {
      remove();
    }
  }
  for (const [first, second, label] of [
    ["CHERRY_PICK_HEAD", "REVERT_HEAD", "a cherry-pick"],
    ["MERGE_HEAD", "BISECT_LOG", "a merge"],
    ["rebase-apply", "MERGE_HEAD", "a rebase"],
  ] as const) {
    // Placed latest-first, so creation order cannot decide.
    const removeSecond = placeTriageMarker(gitDir, second);
    const removeFirst = placeTriageMarker(gitDir, first);
    try {
      await assert.rejects(
        recordOperationTriageSnapshot(rig.run, rig.step),
        (error: Error) => error.message.includes(`while ${label} is`),
      );
    } finally {
      removeFirst();
      removeSecond();
    }
  }
  assert.deepEqual(snapshotEvents(rig.run.id), []);
  await recordOperationTriageSnapshot(rig.run, rig.step);
  assert.equal(snapshotEvents(rig.run.id).length, 1);
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
  "$name at 162 refuses the dispatch: no snapshot, the lock released",
  async ({ name, answer, expect }) => {
    const rig = fixture(`failed-162-${name.replace(/\W/g, "-")}`);
    const first = join(gitDirOf(rig.feature), "rebase-merge");
    const disarm = answerForPathForTests(FILE_METHODS.exists, first, answer);
    let error: unknown;
    try {
      error = await rejection(recordOperationTriageSnapshot(rig.run, rig.step));
    } finally {
      disarm();
    }
    assert.ok(expect(error) && isWorkerFailure(error), String(error));
    assert.deepEqual(snapshotEvents(rig.run.id), []);
    await withRepoLock(await repoLockKey(rig.main), async () => {});
  },
);

test("a held probe at 162, a connection end, then release, refuses the dispatch", async () => {
  const rig = fixture("held-162");
  const held = holdFileForTests(
    join(gitDirOf(rig.feature), "rebase-merge"),
    "exists",
  );
  const pending = rejection(recordOperationTriageSnapshot(rig.run, rig.step));
  await held.reached;
  writeAsInProcessWorkerForTests(INVALID_FRAME);
  held.release();
  const error = await pending;
  assert.match(String(error), /The Worker connection ended/);
  assert.ok(isWorkerFailure(error));
  assert.deepEqual(snapshotEvents(rig.run.id), []);
  await withRepoLock(await repoLockKey(rig.main), async () => {});
});
