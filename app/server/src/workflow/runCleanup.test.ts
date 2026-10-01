import assert from "node:assert/strict";
import { test } from "vitest";
import type { WorkflowRunRow } from "../db/workflowStore.ts";
import type { WorktreeRow } from "../db/worktreeStore.ts";
import { deleteCancelledWorkflowRun } from "./runCleanup.ts";

function run(overrides: Partial<WorkflowRunRow> = {}): WorkflowRunRow {
  return {
    id: 7,
    taskId: 42,
    projectId: "project",
    recipeId: "code-delivery",
    recipeVersion: 1,
    worktreeId: "wt-7",
    branch: "t42-mistake",
    lifecycle: "cancelled",
    maxIterations: 2,
    maxReviewPasses: 2,
    createdAt: 1,
    updatedAt: 2,
    endedAt: 2,
    ...overrides,
  };
}

function worktree(overrides: Partial<WorktreeRow> = {}): WorktreeRow {
  return {
    id: "wt-7",
    projectId: "project",
    mainRepoRoot: "/repo",
    path: "/worktrees/t42-mistake",
    branch: "t42-mistake",
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    status: "active",
    mergeStateJson: null,
    branchCleanupOid: null,
    createdAt: 1,
    updatedAt: 1,
    removedAt: null,
    ...overrides,
  };
}

function recorder(input: {
  run?: WorkflowRunRow | null;
  worktree?: WorktreeRow;
  refusal?: string;
}) {
  const calls: string[] = [];
  return {
    calls,
    operations: {
      getRun: () => (input.run === undefined ? run() : input.run),
      getWorktree: () => input.worktree,
      workflowSessionIds: () => ["coordinator", "implementer"],
      worktreeSessionIds: () => ["implementer", "reviewer"],
      removeWorktree: async () => {
        calls.push("remove-worktree");
        return input.refusal;
      },
      archiveSessions: async (ids: readonly string[]) => {
        calls.push(`archive:${[...ids].sort().join(",")}`);
      },
      deleteRun: () => calls.push("delete-run"),
      broadcastRuns: () => calls.push("broadcast-runs"),
    },
  };
}

test("cleanup removes resources before deleting a cancelled run", async () => {
  const rec = recorder({ worktree: worktree() });
  await deleteCancelledWorkflowRun(
    7,
    { deleteWorktree: true, archiveSessions: true },
    rec.operations,
  );
  assert.deepEqual(rec.calls, [
    "remove-worktree",
    "archive:coordinator,implementer,reviewer",
    "delete-run",
    "broadcast-runs",
  ]);
});

test("cleanup options preserve resources while deleting only the run", async () => {
  const rec = recorder({ worktree: worktree() });
  await deleteCancelledWorkflowRun(
    7,
    { deleteWorktree: false, archiveSessions: false },
    rec.operations,
  );
  assert.deepEqual(rec.calls, ["delete-run", "broadcast-runs"]);
});

test("an already removed worktree is idempotent cleanup", async () => {
  const rec = recorder({ worktree: worktree({ status: "removed" }) });
  await deleteCancelledWorkflowRun(
    7,
    { deleteWorktree: true, archiveSessions: true },
    rec.operations,
  );
  assert.deepEqual(rec.calls, [
    "archive:coordinator,implementer,reviewer",
    "delete-run",
    "broadcast-runs",
  ]);
});

test("a worktree refusal preserves sessions and run history", async () => {
  const rec = recorder({
    worktree: worktree(),
    refusal: "a session is still running",
  });
  await assert.rejects(
    deleteCancelledWorkflowRun(
      7,
      { deleteWorktree: true, archiveSessions: true },
      rec.operations,
    ),
    /session is still running/,
  );
  assert.deepEqual(rec.calls, ["remove-worktree"]);
});

test("only cancelled runs admit permanent cleanup", async () => {
  const rec = recorder({ run: run({ lifecycle: "completed" }) });
  await assert.rejects(
    deleteCancelledWorkflowRun(
      7,
      { deleteWorktree: false, archiveSessions: false },
      rec.operations,
    ),
    /only a cancelled run can be deleted/,
  );
  assert.deepEqual(rec.calls, []);
});
