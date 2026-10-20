import assert from "node:assert/strict";
import { test } from "vitest";
import {
  runManagedMergeFollowUps,
  type ManagedMergeFollowUpOperations,
} from "./managedMergeFollowUps.ts";
import { createTask, readTask } from "./tasks.ts";
import { removeWorktreeAndSettleSessions } from "./worktreeRemoval.ts";
import {
  beginPromptRun,
  reserveWorktreeForRemoval,
  resetSessionRunLeasesForTests,
  setSessionWorktreeResolverForTests,
} from "./session/sessionRunLease.ts";
import {
  WorktreeBranchCleanupError,
  WorktreeDirectoryResidueError,
} from "./worktrees/worktrees.ts";

const input = {
  worktreeId: "wt-1",
  number: 91,
  sessionId: "agent-1",
  markTaskDone: true,
  removeWorktree: true,
  taskId: "task",
};
const operations: ManagedMergeFollowUpOperations = {
  markDone: (id) => ({
    id,
    title: "Task",
    status: "done",
    source: { createdBy: "user" },
    createdAt: 1,
    updatedAt: 1,
  }),
  remove: async () => undefined,
};

test("follow-up removal carries exactly the job exemption", async () => {
  const exemptBackgroundItem = { itemId: "job", ownerSessionId: "agent-1" };
  let removed = false;
  const result = await runManagedMergeFollowUps(
    { ...input, exemptBackgroundItem },
    {
      ...operations,
      remove: async (id, exempt) => {
        assert.equal(id, input.worktreeId);
        assert.deepEqual(exempt, exemptBackgroundItem);
        removed = true;
        return undefined;
      },
    },
  );
  assert.equal(removed, true);
  assert.equal(result.worktreeRemoved, true);
});

test("completion is an applied agent write with answered provenance", async () => {
  const task = createTask({
    title: "Merge completion",
    status: "doing",
    source: { createdBy: "user" },
  });
  const result = await runManagedMergeFollowUps({
    ...input,
    taskId: task.id,
    removeWorktree: false,
  });
  assert.deepEqual(result.task, { id: task.id, status: "done" });
  const saved = readTask(task.id)!;
  assert.equal(saved.status, "done");
  assert.equal(saved.statusSuggestion?.to, "done");
  assert.equal(saved.statusSuggestion?.sessionId, "agent-1");
});

test("the requesting session running in the target still blocks cleanup", async () => {
  resetSessionRunLeasesForTests();
  setSessionWorktreeResolverForTests(() => input.worktreeId);
  const release = beginPromptRun(input.sessionId);
  try {
    const result = await runManagedMergeFollowUps(input, {
      ...operations,
      remove: (id) =>
        removeWorktreeAndSettleSessions(
          id,
          { force: false, deleteBranch: true },
          {
            settleBlockedReason: async () => undefined,
            reserveForRemoval: reserveWorktreeForRemoval,
            sessionsToSettle: () => [],
            removeWorktree: async () =>
              assert.fail("must not remove an active caller's cwd"),
            settleSessions: async () =>
              assert.fail("must not settle the caller"),
          },
        ),
    });
    assert.equal(result.worktreeRemoved, false);
    assert.match(result.warnings.join(" "), /run is starting/);
    assert.equal(result.task?.status, "done");
  } finally {
    release();
    resetSessionRunLeasesForTests();
  }
});

test("durable cleanup failures report removed rather than kept", async () => {
  for (const error of [
    new WorktreeBranchCleanupError(
      "branch remains",
      input.worktreeId,
      "feature",
      "a".repeat(40),
      true,
    ),
    new WorktreeDirectoryResidueError(
      "directory remains",
      input.worktreeId,
      "/tree",
    ),
  ]) {
    const result = await runManagedMergeFollowUps(input, {
      ...operations,
      remove: async () => {
        throw error;
      },
    });
    assert.equal(result.worktreeRemoved, true);
    assert.match(result.warnings.join(" "), /removed, but cleanup/);
  }
  const result = await runManagedMergeFollowUps(input, {
    ...operations,
    remove: async () => {
      throw new Error("inventory failed after removal");
    },
    isRemoved: () => true,
  });
  assert.equal(result.worktreeRemoved, true);
});

test("card projection failure does not misreport an applied Task write", async () => {
  const result = await runManagedMergeFollowUps(input, {
    ...operations,
    projectTask: () => {
      throw new Error("card disappeared");
    },
  });
  assert.equal(result.task?.status, "done");
  assert.equal(result.worktreeRemoved, true);
  assert.match(result.warnings.join(" "), /Task is done.*card disappeared/);
});

test("no flags leaves Task and checkout untouched", async () => {
  const result = await runManagedMergeFollowUps(
    { ...input, markTaskDone: false, removeWorktree: false },
    {
      markDone: () => assert.fail("unexpected Task write"),
      remove: async () => assert.fail("unexpected removal"),
    },
  );
  assert.deepEqual(result, { warnings: [] });
});

test("Task failure does not skip removal", async () => {
  const result = await runManagedMergeFollowUps(input, {
    ...operations,
    markDone: () => {
      throw new Error("Task gone");
    },
  });
  assert.equal(result.worktreeRemoved, true);
  assert.match(result.warnings.join(" "), /Task gone/);
});

test("removal refusal or failure preserves Task completion and reports the kept tree", async () => {
  for (const remove of [
    async () => "A session is running",
    async (): Promise<undefined> => {
      throw new Error("dirty files");
    },
  ]) {
    const result = await runManagedMergeFollowUps(input, {
      ...operations,
      remove,
    });
    assert.deepEqual(result.task, { id: "task", status: "done" });
    assert.equal(result.worktreeRemoved, false);
    assert.match(result.warnings.join(" "), /worktree was kept/);
  }
});
