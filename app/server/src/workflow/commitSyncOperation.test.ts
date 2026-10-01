import { applyPatch, type Patch, type WorkflowActor } from "@assistant/shared";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import type { CommitWorkflowResult } from "../commitWorkflow.ts";
import type { WorktreeRow } from "../db/worktreeStore.ts";
import type { WorkflowRunRow, WorkflowStepRow } from "../db/workflowStore.ts";
import type { CommitSyncOperationDependencies } from "./commitSyncOperation.ts";
import type { WorkflowStepContext } from "./executors.ts";

const testRoot = mkdtempSync(join(tmpdir(), "commit-sync-operation-test-"));
process.env.ASSISTANT_CWD = testRoot;
process.env.DATA_DIR = join(testRoot, "data");

const operationModule = await import("./commitSyncOperation.ts");
const recipe = await import("./codeDeliveryRecipe.ts");
const contracts = await import("./resultContracts.ts");
const commitWorkflow = await import("../commitWorkflow.ts");
const { WorktreeSyncConflictError } =
  await import("../worktrees/worktreeSync.ts");
const { closeDb } = await import("../db/index.ts");

afterAll(() => {
  closeDb();
  rmSync(testRoot, { recursive: true, force: true });
});

const ACTOR: WorkflowActor = { kind: "system" };
const OLD_BASE = "d".repeat(40);
const REFRESHED_BASE = "b".repeat(40);
const MOVED_BASE = "a".repeat(40);
const HEAD = "c".repeat(40);
const REWRITTEN_HEAD = "e".repeat(40);

const WORKTREE: WorktreeRow = {
  id: "wt-run",
  projectId: "project-one",
  mainRepoRoot: "/repo/main",
  path: "/repo/feature",
  branch: "feature",
  baseBranch: "main",
  baseCommit: OLD_BASE,
  status: "active",
  mergeStateJson: null,
  createdAt: 1,
  updatedAt: 1,
  removedAt: null,
};

const MAIN: WorktreeRow = {
  id: "main:project-one",
  projectId: "project-one",
  mainRepoRoot: "/repo/main",
  path: "/repo/main",
  branch: "main",
  baseBranch: "main",
  baseCommit: OLD_BASE,
  status: "active",
  mergeStateJson: null,
  createdAt: 0,
  updatedAt: 0,
  removedAt: null,
};

const RUN: WorkflowRunRow = {
  id: 17,
  taskId: 368,
  projectId: "project-one",
  recipeId: recipe.CODE_DELIVERY_RECIPE_ID,
  recipeVersion: recipe.CODE_DELIVERY_RECIPE_VERSION,
  worktreeId: WORKTREE.id,
  branch: WORKTREE.branch,
  lifecycle: "active",
  maxIterations: 2,
  maxReviewPasses: 1,
  createdAt: 1,
  updatedAt: 1,
};

const STEP: WorkflowStepRow = {
  id: 23,
  runId: RUN.id,
  kind: "host-operation",
  payload: {
    operation: recipe.COMMIT_SYNC_OPERATION_ID,
    idempotencyKey: recipe.commitSyncIdempotencyKey(RUN.id, 22),
  },
  status: "running",
  executor: { kind: "operation", id: recipe.COMMIT_SYNC_OPERATION_ID },
  attempt: 1,
  predecessorId: 22,
  createdAt: 1,
  updatedAt: 1,
  startedAt: 1,
};

const ORIGIN_STEP: WorkflowStepRow = {
  id: 22,
  runId: RUN.id,
  kind: "agent",
  payload: { role: "implementer" },
  status: "completed",
  attempt: 1,
  createdAt: 1,
  updatedAt: 1,
  endedAt: 1,
};

function context(
  patch: {
    run?: Patch<WorkflowRunRow>;
    step?: Patch<WorkflowStepRow>;
    predecessors?: readonly WorkflowStepRow[];
  } = {},
): WorkflowStepContext {
  return {
    run: applyPatch(RUN, patch.run ?? {}),
    step: applyPatch(STEP, patch.step ?? {}),
    ...(patch.predecessors ? { predecessors: patch.predecessors } : {}),
    actor: ACTOR,
  };
}

function commitResult(
  status: CommitWorkflowResult["status"],
  patch: Partial<CommitWorkflowResult> = {},
): CommitWorkflowResult {
  return {
    status,
    source: "tool",
    dryRun: false,
    forced: false,
    files: [],
    totals: { files: 0, additions: 0, deletions: 0 },
    blockers: [],
    warnings: [],
    includedUserEntryIds: [],
    sessionTouchedPaths: [],
    addressedTasks: [],
    createdAt: 1,
    ...patch,
  };
}

function noChangesResult(): CommitWorkflowResult {
  return commitResult("blocked", {
    blockers: [
      {
        kind: "unclear",
        reason: commitWorkflow.NO_CHANGES_TO_COMMIT_REASON,
      },
    ],
  });
}

interface FakeControl {
  events: string[];
  commitResults: CommitWorkflowResult[];
  worktree?: WorktreeRow;
  main?: WorktreeRow;
  runBranches: readonly string[];
  mainBranch: string;
  runRepository: string;
  mainRepository: string;
  finalStatus: string;
  syncBaseRemotes: string[];
  syncError?: { phase: "pull-rebase" | "rebase-main"; error: Error };
  commitError?: Error;
  commitOid: string;
  baseHead: string;
  remoteBase: string;
  mergeBase: string;
}

function fake(patch: Patch<FakeControl> = {}): {
  control: FakeControl;
  dependencies: Partial<CommitSyncOperationDependencies>;
} {
  const control: FakeControl = applyPatch(
    {
      events: [],
      commitResults: [commitResult("committed")],
      worktree: WORKTREE,
      main: MAIN,
      runBranches: [WORKTREE.branch, WORKTREE.branch],
      mainBranch: WORKTREE.baseBranch,
      runRepository: "/repo/main/.git",
      mainRepository: "/repo/main/.git",
      finalStatus: "",
      syncBaseRemotes: [],
      commitOid: HEAD,
      baseHead: REFRESHED_BASE,
      remoteBase: OLD_BASE,
      mergeBase: REFRESHED_BASE,
    },
    patch,
  );
  let runBranchRead = 0;
  let commitCall = 0;
  const dependencies: Partial<CommitSyncOperationDependencies> = {
    worktree: () => control.worktree,
    mainWorktree: async () => control.main,
    commit: async (options) => {
      control.events.push("commit");
      assert.equal(options.source, "tool");
      assert.equal(options.cwd, WORKTREE.path);
      assert.equal(options.force, false);
      if (control.commitError) throw control.commitError;
      return (
        control.commitResults[
          Math.min(commitCall++, control.commitResults.length - 1)
        ] ?? commitResult("failed", { error: "missing fake result" })
      );
    },
    sync: async (row, phase, options) => {
      control.events.push(`sync:${row.id}:${phase}`);
      if (options?.baseRemote) control.syncBaseRemotes.push(options.baseRemote);
      if (control.syncError?.phase === phase) throw control.syncError.error;
    },
    baseOid: async (_row, { refresh }) => {
      control.events.push(`base-oid:${refresh ? "refresh" : "local"}`);
      return refresh ? control.baseHead : control.remoteBase;
    },
    branch: async (cwd) => {
      if (cwd === WORKTREE.path) {
        const phase = runBranchRead++ === 0 ? "validation" : "final";
        control.events.push(`${phase}:run-branch`);
        return (
          control.runBranches[
            Math.min(runBranchRead - 1, control.runBranches.length - 1)
          ] ?? ""
        );
      }
      control.events.push("validation:main-branch");
      return control.mainBranch;
    },
    repositoryIdentity: async (cwd) => {
      control.events.push(`validation:repository:${cwd}`);
      return cwd === WORKTREE.path
        ? control.runRepository
        : control.mainRepository;
    },
    status: async () => {
      control.events.push("final:status");
      return control.finalStatus;
    },
    commitOid: async (cwd) => {
      control.events.push(`range:oid:${cwd}`);
      return cwd === WORKTREE.path ? control.commitOid : control.baseHead;
    },
    mergeBase: async (_cwd, left, right) => {
      control.events.push(`range:merge-base:${left}:${right}`);
      return control.mergeBase;
    },
    invalidateStatus: () => control.events.push("invalidate:run"),
  };
  return { control, dependencies };
}

function mutationEvents(events: string[]): string[] {
  return events.filter(
    (event) => event === "commit" || event.startsWith("sync:"),
  );
}

function checkpointContext(
  operation: "commit" | "base-sync",
): WorkflowStepContext {
  const checkpoint: WorkflowStepRow = {
    ...STEP,
    id: 20,
    payload: {
      operation: recipe.COMMIT_SYNC_OPERATION_ID,
      idempotencyKey: recipe.commitSyncIdempotencyKey(RUN.id, 19),
    },
    status: "completed",
    predecessorId: 19,
    result: {
      status: "completed",
      summary: "initial synchronization checkpoint",
      contractId: contracts.COMMIT_SYNC_RESULT_CONTRACT_ID,
      payload: {
        operation: "commit-sync",
        baseCommit: REFRESHED_BASE,
        headCommit: HEAD,
      },
      submittedAt: 1,
    },
  };
  const origin = { ...ORIGIN_STEP, predecessorId: checkpoint.id };
  const operationId =
    operation === "commit"
      ? recipe.COMMIT_ONLY_OPERATION_ID
      : recipe.BASE_SYNC_OPERATION_ID;
  const key =
    operation === "commit"
      ? recipe.commitOnlyIdempotencyKey(RUN.id, origin.id)
      : recipe.baseSyncIdempotencyKey(RUN.id, origin.id);
  return context({
    step: {
      payload: { operation: operationId, idempotencyKey: key },
      executor: { kind: "operation", id: operationId },
    },
    predecessors: [origin, checkpoint],
  });
}

/* ---------------------------- validation guards --------------------------- */

test.each([
  ["non-host step", { step: { kind: "agent" as const } }],
  ["missing operation", { step: { payload: {} } }],
  [
    "empty idempotency key",
    {
      step: {
        payload: {
          operation: recipe.COMMIT_SYNC_OPERATION_ID,
          idempotencyKey: " ",
        },
      },
    },
  ],
  ["missing predecessor", { step: { predecessorId: undefined } }],
  [
    "wrong deterministic key",
    {
      step: {
        payload: {
          operation: recipe.COMMIT_SYNC_OPERATION_ID,
          idempotencyKey: "wrong",
        },
      },
    },
  ],
  [
    "non-exact deterministic key",
    {
      step: {
        payload: {
          operation: recipe.COMMIT_SYNC_OPERATION_ID,
          idempotencyKey: ` ${recipe.commitSyncIdempotencyKey(RUN.id, 22)}`,
        },
      },
    },
  ],
] as const)("%s is refused before any side effect", async (_name, patch) => {
  const { control, dependencies } = fake();
  const outcome = await operationModule
    .createCommitSyncOperation(dependencies)
    .execute(context(patch));
  assert.equal(outcome.status, "failed");
  assert.match(outcome.summary, /validation failed/i);
  assert.deepEqual(control.events, []);
});

test("a semantic retry accepts the original reservation key through its failed predecessor", async () => {
  const { control, dependencies } = fake();
  const failed = { ...STEP, status: "failed" as const, endedAt: 2 };
  const outcome = await operationModule
    .createCommitSyncOperation(dependencies)
    .execute(
      context({
        step: { id: 24, predecessorId: failed.id },
        predecessors: [failed, ORIGIN_STEP],
      }),
    );
  assert.equal(outcome.status, "completed");
  assert.ok(control.events.includes("commit"));
});

test("a retry chain rooted in a spent rebase repair keeps its reservation key", async () => {
  const { control, dependencies } = fake();
  // Retry on a failed repair assignment reserves commit-sync against the repair
  // step itself, so the second Retry — the manual resolve-then-Retry path — is a
  // chain whose root is a FAILED step and must still be admitted.
  const repair: WorkflowStepRow = {
    ...ORIGIN_STEP,
    payload: {
      role: "implementer",
      objective: "repair-rebase",
      files: ["migrations.lock.json"],
      truncated: false,
      baseBranch: "main",
      originalHead: OLD_BASE,
    },
    status: "failed",
    endedAt: 2,
  };
  const blockedRetry = { ...STEP, status: "blocked" as const, endedAt: 3 };
  const outcome = await operationModule
    .createCommitSyncOperation(dependencies)
    .execute(
      context({
        step: { id: 24, predecessorId: blockedRetry.id },
        predecessors: [blockedRetry, repair],
      }),
    );
  assert.equal(outcome.status, "completed");
  assert.ok(control.events.includes("commit"));
});

test("a retry chain rooted in a failed non-repair step is refused", async () => {
  const { control, dependencies } = fake();
  const failedOrigin = {
    ...ORIGIN_STEP,
    status: "failed" as const,
    endedAt: 2,
  };
  const blockedRetry = { ...STEP, status: "blocked" as const, endedAt: 3 };
  const outcome = await operationModule
    .createCommitSyncOperation(dependencies)
    .execute(
      context({
        step: { id: 24, predecessorId: blockedRetry.id },
        predecessors: [blockedRetry, failedOrigin],
      }),
    );
  assert.equal(outcome.status, "failed");
  assert.match(outcome.summary, /validation failed/i);
  assert.deepEqual(control.events, []);
});

test("a semantic retry cannot bless an invalid original reservation key", async () => {
  const { control, dependencies } = fake();
  const malformedKey = "wrong";
  const failed = {
    ...STEP,
    status: "failed" as const,
    payload: {
      operation: recipe.COMMIT_SYNC_OPERATION_ID,
      idempotencyKey: malformedKey,
    },
    endedAt: 2,
  };
  const outcome = await operationModule
    .createCommitSyncOperation(dependencies)
    .execute(
      context({
        step: {
          id: 24,
          predecessorId: failed.id,
          payload: failed.payload,
        },
        predecessors: [failed, ORIGIN_STEP],
      }),
    );
  assert.equal(outcome.status, "failed");
  assert.match(outcome.summary, /validation failed/i);
  assert.deepEqual(control.events, []);
});

test.each([
  ["missing worktree", { worktree: undefined }, {}, /does not exist/],
  [
    "removed worktree",
    { worktree: { ...WORKTREE, status: "removed" as const } },
    {},
    /removed/,
  ],
  [
    "persisted branch mismatch",
    { worktree: { ...WORKTREE, branch: "other" } },
    {},
    /records branch/,
  ],
  [
    "worktree Project mismatch",
    { worktree: { ...WORKTREE, projectId: "other-project" } },
    {},
    /belongs to Project/,
  ],
  [
    "wrong actual run branch",
    { runBranches: ["other"] },
    {},
    /run checkout is on/,
  ],
  ["missing main checkout", { main: undefined }, {}, /could not be resolved/],
  [
    "main Project mismatch",
    { main: { ...MAIN, projectId: "other-project" } },
    {},
    /does not belong/,
  ],
  [
    "different repository",
    { mainRepository: "/other/.git" },
    {},
    /different repository/,
  ],
  [
    "main switched from base branch",
    { mainBranch: "release" },
    {},
    /base branch/,
  ],
  [
    "run missing Project",
    {},
    { run: { projectId: undefined } },
    /missing its worktree, branch, or Project/,
  ],
] as const)(
  "%s is refused before commit or pull",
  async (_name, fakePatch, contextPatch, summary) => {
    const { control, dependencies } = fake(fakePatch);
    const outcome = await operationModule
      .createCommitSyncOperation(dependencies)
      .execute(context(contextPatch));
    assert.equal(outcome.status, "failed");
    assert.match(outcome.summary, summary);
    assert.deepEqual(mutationEvents(control.events), []);
  },
);

/* --------------------------- phase/result behavior ------------------------- */

test("successful execution orders commit, base refresh, run rebase, final inspection, and range", async () => {
  const { control, dependencies } = fake();
  const outcome = await operationModule
    .createCommitSyncOperation(dependencies)
    .execute(context());
  assert.equal(outcome.status, "completed");
  const ordered = control.events.filter(
    (event) =>
      event === "commit" ||
      event.startsWith("sync:") ||
      event.startsWith("final:") ||
      event.startsWith("range:"),
  );
  assert.deepEqual(ordered, [
    `range:oid:${WORKTREE.path}`,
    `range:oid:${MAIN.path}`,
    "commit",
    `range:oid:${WORKTREE.path}`,
    `sync:${MAIN.id}:pull-rebase`,
    `range:oid:${MAIN.path}`,
    `sync:${WORKTREE.id}:rebase-main`,
    "final:run-branch",
    "final:status",
    `range:oid:${WORKTREE.path}`,
    `range:oid:${MAIN.path}`,
    `range:oid:${WORKTREE.path}`,
    `range:merge-base:${HEAD}:${REFRESHED_BASE}`,
  ]);
  assert.ok(
    control.events.indexOf("invalidate:run") > control.events.indexOf("commit"),
  );
});

test("a non-main base refreshes its remote ref without touching the main checkout", async () => {
  const epicWorktree = { ...WORKTREE, baseBranch: "epic" };
  const { control, dependencies } = fake({ worktree: epicWorktree });
  const outcome = await operationModule
    .createCommitSyncOperation(dependencies)
    .execute(context());

  assert.equal(outcome.status, "completed");
  assert.deepEqual(
    control.events.filter(
      (event) =>
        event.startsWith("base-oid:") ||
        event.startsWith("sync:") ||
        event.includes(MAIN.path) ||
        event === "validation:main-branch",
    ),
    ["base-oid:local", "base-oid:refresh", `sync:${WORKTREE.id}:rebase-main`],
  );
  assert.equal(
    (outcome.payload as { baseCommit?: string } | undefined)?.baseCommit,
    REFRESHED_BASE,
  );
  assert.deepEqual(control.syncBaseRemotes, ["origin"]);
});

test("base-sync on a non-main base uses the fetched oid and no main checkout", async () => {
  const epicWorktree = { ...WORKTREE, baseBranch: "epic" };
  const { control, dependencies } = fake({ worktree: epicWorktree });
  const outcome = await operationModule
    .createBaseSyncOperation(dependencies)
    .execute(checkpointContext("base-sync"));

  assert.equal(outcome.status, "completed");
  assert.deepEqual(
    control.events.filter(
      (event) =>
        event.startsWith("base-oid:") ||
        event.includes(MAIN.path) ||
        event === "validation:main-branch" ||
        event === `sync:${MAIN.id}:pull-rebase`,
    ),
    ["base-oid:refresh"],
  );
  assert.equal(
    (outcome.payload as { baseCommit?: string } | undefined)?.baseCommit,
    REFRESHED_BASE,
  );
  assert.deepEqual(control.syncBaseRemotes, []);
});

test("commit safety blockers become blocked and do not start sync", async () => {
  const { control, dependencies } = fake({
    commitResults: [
      commitResult("blocked", {
        blockers: [
          { kind: "secret", reason: "credential-like value in config.ts" },
        ],
      }),
    ],
  });
  const outcome = await operationModule
    .createCommitSyncOperation(dependencies)
    .execute(context());
  assert.equal(outcome.status, "blocked");
  assert.match(outcome.summary, /commit phase blocked.*credential-like/i);
  assert.deepEqual(mutationEvents(control.events), ["commit"]);
});

test.each([
  [commitResult("failed", { error: "commit command exited 1" }), /exited 1/],
  [commitResult("dry-run"), /dry-run/],
] as const)(
  "commit failures become failed and do not sync",
  async (result, summary) => {
    const { control, dependencies } = fake({ commitResults: [result] });
    const outcome = await operationModule
      .createCommitSyncOperation(dependencies)
      .execute(context());
    assert.equal(outcome.status, "failed");
    assert.match(outcome.summary, summary);
    assert.deepEqual(mutationEvents(control.events), ["commit"]);
  },
);

test("the exact no-changes commit result proceeds as a retry-safe observation", async () => {
  const { control, dependencies } = fake({
    commitResults: [noChangesResult()],
  });
  const outcome = await operationModule
    .createCommitSyncOperation(dependencies)
    .execute(context());
  assert.equal(outcome.status, "completed");
  assert.deepEqual(mutationEvents(control.events), [
    "commit",
    `sync:${MAIN.id}:pull-rebase`,
    `sync:${WORKTREE.id}:rebase-main`,
  ]);
});

test("a restored run rebase conflict is blocked without review evidence", async () => {
  const conflict = new WorktreeSyncConflictError(
    "Rebase hit a conflict and was aborted and restored.",
    "rebase-main",
    ["docs/agent-workflows.md", "app/server/src/workflow/engine.ts"],
    false,
    "a".repeat(40),
  );
  const { control, dependencies } = fake({
    syncError: { phase: "rebase-main", error: conflict },
  });
  const outcome = await operationModule
    .createCommitSyncOperation(dependencies)
    .execute(context());
  assert.equal(outcome.status, "blocked");
  assert.match(
    outcome.summary,
    /onto main conflicted.*aborted.*restored.*worktree is clean.*docs\/agent-workflows\.md/i,
  );
  assert.deepEqual(outcome.payload, {
    rebaseConflict: {
      files: ["docs/agent-workflows.md", "app/server/src/workflow/engine.ts"],
      truncated: false,
      baseBranch: "main",
      originalHead: "a".repeat(40),
    },
  });
  assert.ok(
    !control.events.some((event) => event.startsWith("range:merge-base:")),
  );
});

test.each([
  ["pull-rebase" as const, "authentication failed", /base refresh failed/],
  ["rebase-main" as const, "restore failed", /run rebase failed/],
])(
  "generic %s errors fail with the phase named",
  async (phase, message, summary) => {
    const { control, dependencies } = fake({
      syncError: { phase, error: new Error(message) },
    });
    const outcome = await operationModule
      .createCommitSyncOperation(dependencies)
      .execute(context());
    assert.equal(outcome.status, "failed");
    assert.match(outcome.summary, summary);
    assert.match(outcome.summary, new RegExp(message));
    assert.equal(outcome.payload, undefined);
    assert.ok(
      !control.events.some((event) => event.startsWith("range:merge-base:")),
    );
    assert.ok(control.events.includes("invalidate:run"));
  },
);

test.each([
  ["wrong branch", { runBranches: ["feature", "other"] }, /not "feature"/],
  [
    "detached HEAD",
    { runBranches: ["feature", ""] },
    /on a detached HEAD, not "feature"/,
  ],
  ["dirty tree", { finalStatus: " M changed.ts\n" }, /uncommitted changes/],
] as const)(
  "%s after rebase is blocked and cannot emit a range",
  async (_name, patch, summary) => {
    const { control, dependencies } = fake(patch);
    const outcome = await operationModule
      .createCommitSyncOperation(dependencies)
      .execute(context());
    assert.equal(outcome.status, "blocked");
    assert.match(outcome.summary, summary);
    assert.equal(outcome.payload, undefined);
    assert.ok(
      !control.events.some((event) => event.startsWith("range:merge-base:")),
    );
  },
);

test("success emits the registered full post-rebase range rather than the creation base", async () => {
  const { dependencies } = fake();
  const outcome = await operationModule
    .createCommitSyncOperation(dependencies)
    .execute(context());
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.contractId, contracts.COMMIT_SYNC_RESULT_CONTRACT_ID);
  assert.deepEqual(outcome.payload, {
    operation: "commit-sync",
    previousBaseCommit: REFRESHED_BASE,
    baseCommit: REFRESHED_BASE,
    previousHeadCommit: HEAD,
    headCommit: HEAD,
    baseMoved: false,
    headRewritten: false,
  });
  assert.notEqual(REFRESHED_BASE, WORKTREE.baseCommit);
  assert.equal(REFRESHED_BASE.length, 40);
  assert.equal(HEAD.length, 40);
});

test("a committed first attempt and no-changes retry converge to the same range", async () => {
  const { control, dependencies } = fake({
    commitResults: [commitResult("committed"), noChangesResult()],
  });
  const operation = operationModule.createCommitSyncOperation(dependencies);
  const first = await operation.execute(context());
  const retry = await operation.execute(context());
  assert.equal(first.status, "completed");
  assert.equal(retry.status, "completed");
  assert.deepEqual(retry.payload, first.payload);
  assert.equal(control.events.filter((event) => event === "commit").length, 2);
  assert.equal(
    control.events.filter((event) => event.endsWith(":pull-rebase")).length,
    2,
  );
  assert.equal(
    control.events.filter((event) => event.endsWith(":rebase-main")).length,
    2,
  );
});

test("commit-only retains the accepted checkpoint and performs no synchronization", async () => {
  const { control, dependencies } = fake();
  const outcome = await operationModule
    .createCommitOnlyOperation(dependencies)
    .execute(checkpointContext("commit"));
  assert.equal(outcome.status, "completed", outcome.summary);
  assert.deepEqual(mutationEvents(control.events), ["commit"]);
  assert.deepEqual(outcome.payload, {
    operation: "commit",
    previousBaseCommit: REFRESHED_BASE,
    baseCommit: REFRESHED_BASE,
    previousHeadCommit: HEAD,
    headCommit: HEAD,
    baseMoved: false,
    headRewritten: false,
  });
});

test("commit-only refuses a checkpoint that is not an ancestor", async () => {
  const { control, dependencies } = fake({ mergeBase: OLD_BASE });
  const outcome = await operationModule
    .createCommitOnlyOperation(dependencies)
    .execute(checkpointContext("commit"));
  assert.equal(outcome.status, "failed");
  assert.match(outcome.summary, /checkpoint .* is not an ancestor/);
  assert.deepEqual(mutationEvents(control.events), ["commit"]);
});

test("an unchanged base checkpoint refreshes without commit or run rebase", async () => {
  const { control, dependencies } = fake();
  const outcome = await operationModule
    .createBaseSyncOperation(dependencies)
    .execute(checkpointContext("base-sync"));
  assert.equal(outcome.status, "completed", outcome.summary);
  assert.deepEqual(mutationEvents(control.events), [
    `sync:${MAIN.id}:pull-rebase`,
  ]);
  assert.deepEqual(outcome.payload, {
    operation: "base-sync",
    previousBaseCommit: REFRESHED_BASE,
    baseCommit: REFRESHED_BASE,
    previousHeadCommit: HEAD,
    headCommit: HEAD,
    baseMoved: false,
    headRewritten: false,
  });
});

test("a moved base checkpoint rebases the run and records the rewritten range", async () => {
  const { control, dependencies } = fake({
    baseHead: MOVED_BASE,
    mergeBase: MOVED_BASE,
  });
  let runHeadReads = 0;
  const movedDependencies = {
    ...dependencies,
    commitOid: async (cwd: string, ref: string) => {
      control.events.push(`range:oid:${cwd}:${ref}`);
      if (cwd === WORKTREE.path && ref === "HEAD")
        return runHeadReads++ === 0 ? HEAD : REWRITTEN_HEAD;
      return MOVED_BASE;
    },
  };
  const outcome = await operationModule
    .createBaseSyncOperation(movedDependencies)
    .execute(checkpointContext("base-sync"));
  assert.equal(outcome.status, "completed", outcome.summary);
  assert.deepEqual(mutationEvents(control.events), [
    `sync:${MAIN.id}:pull-rebase`,
    `sync:${WORKTREE.id}:rebase-main`,
  ]);
  assert.deepEqual(outcome.payload, {
    operation: "base-sync",
    previousBaseCommit: REFRESHED_BASE,
    baseCommit: MOVED_BASE,
    previousHeadCommit: HEAD,
    headCommit: REWRITTEN_HEAD,
    baseMoved: true,
    headRewritten: true,
  });
});

test("base-sync refuses before side effects without an accepted checkpoint", async () => {
  const { control, dependencies } = fake();
  const outcome = await operationModule
    .createBaseSyncOperation(dependencies)
    .execute(
      context({
        step: {
          payload: {
            operation: recipe.BASE_SYNC_OPERATION_ID,
            idempotencyKey: recipe.baseSyncIdempotencyKey(
              RUN.id,
              ORIGIN_STEP.id,
            ),
          },
        },
        predecessors: [ORIGIN_STEP],
      }),
    );
  assert.equal(outcome.status, "failed");
  assert.match(
    outcome.summary,
    /requires an accepted synchronization checkpoint/,
  );
  assert.deepEqual(mutationEvents(control.events), []);
});

test("base-sync blocks a dirty run checkout before refreshing the base", async () => {
  const { control, dependencies } = fake({ finalStatus: " M file.txt" });
  const outcome = await operationModule
    .createBaseSyncOperation(dependencies)
    .execute(checkpointContext("base-sync"));
  assert.equal(outcome.status, "blocked");
  assert.match(outcome.summary, /uncommitted changes/);
  assert.deepEqual(mutationEvents(control.events), []);
});

test("the real operations declare retry-safe recovery", () => {
  assert.equal(operationModule.commitSyncOperation.id, "commit-sync");
  assert.equal(operationModule.commitOnlyOperation.id, "commit");
  assert.equal(operationModule.baseSyncOperation.id, "base-sync");
  assert.equal(
    operationModule.commitSyncOperation.recoveryPolicy,
    "retry-safe",
  );
  assert.equal(
    operationModule.commitOnlyOperation.recoveryPolicy,
    "retry-safe",
  );
  assert.equal(operationModule.baseSyncOperation.recoveryPolicy, "retry-safe");
});

/* ----------------------------- real Git seams ----------------------------- */

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args],
    { cwd, encoding: "utf8" },
  );
}

test("real non-main sync rebases onto origin despite an upstream branch remote", async () => {
  const root = mkdtempSync(join(tmpdir(), "commit-sync-origin-base-"));
  try {
    const originRemote = join(root, "origin.git");
    const upstreamRemote = join(root, "upstream.git");
    const main = join(root, "main");
    const feature = join(root, "feature");
    mkdirSync(originRemote);
    sh(originRemote, "init", "--bare", "-b", "main");
    mkdirSync(main);
    sh(main, "init", "-b", "main");
    writeFileSync(join(main, "base.txt"), "base\n");
    sh(main, "add", "-A");
    sh(main, "commit", "-m", "base");
    sh(main, "remote", "add", "origin", originRemote);
    sh(main, "push", "-u", "origin", "main");
    sh(main, "branch", "epic");
    sh(main, "push", "-u", "origin", "epic");
    sh(root, "clone", "--bare", originRemote, upstreamRemote);
    sh(main, "remote", "add", "upstream", upstreamRemote);
    sh(main, "config", "branch.epic.remote", "upstream");
    const creationBase = sh(main, "rev-parse", "epic").trim();
    sh(main, "worktree", "add", "-b", "feature", feature, "epic");
    writeFileSync(join(feature, "feature.txt"), "feature\n");
    sh(feature, "add", "-A");
    sh(feature, "commit", "-m", "feature");

    const originClone = join(root, "origin-clone");
    sh(root, "clone", "--branch", "epic", originRemote, originClone);
    writeFileSync(join(originClone, "origin-only.txt"), "origin\n");
    sh(originClone, "add", "-A");
    sh(originClone, "commit", "-m", "advance origin epic");
    sh(originClone, "push");
    const originHead = sh(originClone, "rev-parse", "HEAD").trim();

    const upstreamClone = join(root, "upstream-clone");
    sh(root, "clone", "--branch", "epic", upstreamRemote, upstreamClone);
    writeFileSync(join(upstreamClone, "upstream-only.txt"), "upstream\n");
    sh(upstreamClone, "add", "-A");
    sh(upstreamClone, "commit", "-m", "advance upstream epic");
    sh(upstreamClone, "push");
    const upstreamHead = sh(upstreamClone, "rev-parse", "HEAD").trim();
    assert.notEqual(upstreamHead, originHead);

    const row: WorktreeRow = {
      ...WORKTREE,
      mainRepoRoot: main,
      path: feature,
      baseBranch: "epic",
      baseCommit: creationBase,
    };
    const mainRow: WorktreeRow = {
      ...MAIN,
      mainRepoRoot: main,
      path: main,
      baseCommit: creationBase,
    };
    const operation = operationModule.createCommitSyncOperation({
      worktree: () => row,
      mainWorktree: async () => mainRow,
      commit: async () => noChangesResult(),
      invalidateStatus() {},
    });
    const outcome = await operation.execute(
      context({ run: { worktreeId: row.id, branch: row.branch } }),
    );

    assert.equal(outcome.status, "completed", outcome.summary);
    const payload = outcome.payload as {
      baseCommit: string;
      headCommit: string;
    };
    assert.equal(payload.baseCommit, originHead);
    assert.equal(
      sh(feature, "merge-base", payload.headCommit, originHead).trim(),
      originHead,
    );
    assert.notEqual(payload.baseCommit, upstreamHead);
    assert.equal(existsSync(join(feature, "origin-only.txt")), true);
    assert.equal(existsSync(join(feature, "upstream-only.txt")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real sync seams refresh main, rebase the run, and derive a clean range", async () => {
  const root = mkdtempSync(join(tmpdir(), "commit-sync-real-git-"));
  try {
    const remote = join(root, "remote.git");
    const main = join(root, "main");
    const feature = join(root, "feature");
    mkdirSync(remote);
    sh(remote, "init", "--bare", "-b", "main");
    mkdirSync(main);
    sh(main, "init", "-b", "main");
    writeFileSync(join(main, "base.txt"), "base\n");
    sh(main, "add", "-A");
    sh(main, "commit", "-m", "base");
    sh(main, "remote", "add", "origin", remote);
    sh(main, "push", "-u", "origin", "main");
    sh(main, "worktree", "add", "-b", "feature", feature);
    writeFileSync(join(feature, "feature.txt"), "feature\n");
    sh(feature, "add", "-A");
    sh(feature, "commit", "-m", "feature");
    const oldFeatureHead = sh(feature, "rev-parse", "HEAD").trim();
    const creationBase = sh(main, "rev-parse", "HEAD").trim();

    const upstream = join(root, "upstream");
    sh(root, "clone", "--branch", "main", remote, upstream);
    writeFileSync(join(upstream, "upstream.txt"), "new base\n");
    sh(upstream, "add", "-A");
    sh(upstream, "commit", "-m", "advance base");
    sh(upstream, "push", "origin", "main");
    const refreshedBase = sh(upstream, "rev-parse", "HEAD").trim();

    const row: WorktreeRow = {
      ...WORKTREE,
      mainRepoRoot: main,
      path: feature,
      baseCommit: creationBase,
    };
    const mainRow: WorktreeRow = {
      ...MAIN,
      mainRepoRoot: main,
      path: main,
      baseCommit: creationBase,
    };
    const realContext = context({
      run: { worktreeId: row.id, branch: row.branch },
    });
    const operation = operationModule.createCommitSyncOperation({
      worktree: () => row,
      mainWorktree: async () => mainRow,
      commit: async () => noChangesResult(),
      invalidateStatus() {},
    });
    const outcome = await operation.execute(realContext);

    assert.equal(outcome.status, "completed");
    assert.equal(outcome.contractId, contracts.COMMIT_SYNC_RESULT_CONTRACT_ID);
    const payload = outcome.payload as {
      baseCommit: string;
      headCommit: string;
    };
    assert.equal(payload.baseCommit, refreshedBase);
    assert.notEqual(payload.baseCommit, creationBase);
    assert.notEqual(payload.headCommit, oldFeatureHead);
    assert.equal(sh(feature, "status", "--porcelain=v1").trim(), "");
    assert.equal(sh(feature, "branch", "--show-current").trim(), "feature");
    assert.equal(
      sh(feature, "merge-base", payload.headCommit, refreshedBase).trim(),
      refreshedBase,
    );

    // Exercise the REAL symbolic-branch reader after mutation: detached HEAD is
    // an observable blocked state, not a git-command failure from --quiet.
    const detachedOperation = operationModule.createCommitSyncOperation({
      worktree: () => row,
      mainWorktree: async () => mainRow,
      commit: async () => noChangesResult(),
      async sync(_row, phase) {
        if (phase === "rebase-main")
          sh(feature, "checkout", "--detach", "HEAD");
      },
      invalidateStatus() {},
    });
    const detached = await detachedOperation.execute(realContext);
    assert.equal(detached.status, "blocked");
    assert.match(detached.summary, /on a detached HEAD, not "feature"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
