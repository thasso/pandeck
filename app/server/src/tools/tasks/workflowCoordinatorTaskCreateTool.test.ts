import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "workflow-coordinator-task-create-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const store = await import("../../db/workflowStore.ts");
const tasks = await import("../../tasks.ts");
const recipe = await import("../../workflow/codeDeliveryRecipe.ts");
const contracts = await import("../../workflow/resultContracts.ts");
const { workflowCoordinatorTaskCreateTools } = await import("./taskTools.ts");
const { closeDb } = await import("../../db/index.ts");

const SYSTEM = { kind: "system" as const };
const tool = workflowCoordinatorTaskCreateTools()[0]!;
let sourceTaskId: string | undefined;
let createdTaskId: string | undefined;

beforeEach(() => {
  store.resetWorkflowStoreForTests();
  sourceTaskId = undefined;
  createdTaskId = undefined;
});

afterEach(() => {
  if (createdTaskId) tasks.deleteTask(createdTaskId);
  if (sourceTaskId) tasks.deleteTask(sourceTaskId);
});

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

function context(sessionId: string, agentType = "workflow-coordinator") {
  return {
    toolCallId: "task-create-call",
    session: { sessionId, harness: "pi", agentType },
  } as never;
}

function coordinatorRun(sessionId: string) {
  const source = tasks.createTask({
    title: "Workflow source",
    projectId: "personal-assistant",
    source: { createdBy: "user" },
  });
  sourceTaskId = source.id;
  const run = store.createRun({
    taskId: Number(source.id),
    projectId: "personal-assistant",
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
    result: { status: "completed", summary: "done" },
    actor: SYSTEM,
  });
  const publication = store.appendStep({
    runId: run.id,
    kind: "host-operation",
    payload: { operation: recipe.PUBLISH_PULL_REQUEST_OPERATION_ID },
    actor: SYSTEM,
  });
  store.startStep(
    publication.id,
    { kind: "operation", id: recipe.PUBLISH_PULL_REQUEST_OPERATION_ID },
    SYSTEM,
  );
  store.completeStep(publication.id, {
    status: "completed",
    result: {
      status: "completed",
      summary: "published",
      contractId: contracts.PUBLISH_PULL_REQUEST_RESULT_CONTRACT_ID,
      payload: {
        outcome: "published",
        reviewedHeadCommit: "a".repeat(40),
        cardId: "pr-follow-up",
        sessionId: "implementer",
        provider: "github",
        number: 77,
        url: "https://example.test/pull/77",
      },
    },
    actor: SYSTEM,
  });
  return run;
}

test("creates only follow-ups and adds run Task and PR provenance", async () => {
  const sessionId = "coordinator-task-create";
  const run = coordinatorRun(sessionId);
  const result = await tool.execute(
    {
      operations: [
        {
          operation: "create",
          title: "Follow up on reviewer observation",
          description: "The reviewer noticed a separate maintainability issue.",
          externalLinks: [
            {
              url: "https://example.test/pull/77",
              type: "related",
              source: "unknown",
              title: "Caller-supplied metadata must not win",
            },
          ],
        },
      ],
    },
    context(sessionId),
  );
  const changed = (result.details as any).changed;
  createdTaskId = changed[0].id;
  assert.ok(createdTaskId);
  const created = tasks.readTask(createdTaskId)!;

  assert.equal(created.projectId, "personal-assistant");
  assert.equal(created.parentId, String(run.taskId));
  assert.deepEqual(
    (created.externalLinks ?? []).map((link) => ({
      url: link.url,
      type: link.type,
      title: link.title,
    })),
    [
      {
        url: "https://example.test/pull/77",
        type: "source",
        title: `Workflow Run ${run.id} pull request #77`,
      },
    ],
  );
  assert.equal(created.source.agentType, "workflow-coordinator");
  assert.equal(created.source.sessionId, sessionId);
});

test("a deleted run Task refuses the whole create before persisting an orphan", async () => {
  const sessionId = "coordinator-deleted-source";
  const run = coordinatorRun(sessionId);
  const title = "Must not survive a missing workflow source";
  tasks.deleteTask(String(run.taskId));
  sourceTaskId = undefined;
  const before = tasks.listTasks({ includeArchived: true }).length;

  await assert.rejects(
    tool.execute(
      { operations: [{ operation: "create", title }] },
      context(sessionId),
    ),
    new RegExp(`source Task-${run.taskId} no longer exists`),
  );

  assert.equal(tasks.listTasks({ includeArchived: true }).length, before);
  assert.equal(
    tasks
      .listTasks({ includeArchived: true })
      .some((candidate) => candidate.title === title),
    false,
  );
});

test("refuses every non-create operation even through a forged direct call", async () => {
  const sessionId = "coordinator-task-refusal";
  coordinatorRun(sessionId);

  await assert.rejects(
    tool.execute(
      { operations: [{ operation: "update", id: sourceTaskId }] } as never,
      context(sessionId),
    ),
    /can only create follow-up Tasks/,
  );
});
