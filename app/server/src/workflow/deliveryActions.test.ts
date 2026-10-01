/**
 * The Task-side delivery seam: what it offers, what it refuses, and the one
 * consequence it adds to the live card's cleanup — settling the run.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "workflow-delivery-actions-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const store = await import("../db/workflowStore.ts");
const cards = await import("../pullRequestCards.ts");
const recipe = await import("./codeDeliveryRecipe.ts");
const contracts = await import("./resultContracts.ts");
const { workflowRunCardFor, workflowRunDeliveryOf } =
  await import("../workflowRuns.ts");
const {
  cleanUpWorkflowRunCheckout,
  mergeWorkflowRunPullRequest,
  WorkflowDeliveryRefusal,
} = await import("./deliveryActions.ts");
const { closeDb } = await import("../db/index.ts");

const SYSTEM = { kind: "system" as const };
const USER = { kind: "user" as const };
let nextTask = 7700;

beforeEach(() => {
  store.resetWorkflowStoreForTests();
  cards.resetPullRequestCardsStoreForTests();
});

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

function pullRequestCard(worktreeId = "wt-42") {
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
      worktreeId,
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

/**
 * A run that published `cardId` — the state every delivery control follows —
 * with a finished coordinator step, so the card projection names the one role
 * session the gate tool would act through.
 */
function publishedRun(cardId: string, coordinatorSessionId = "coordinator-1") {
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
  store.startStep(
    coordinator.id,
    { kind: "session", id: coordinatorSessionId },
    SYSTEM,
  );
  store.completeStep(coordinator.id, {
    status: "completed",
    result: { status: "completed", summary: "planned" },
    actor: SYSTEM,
  });
  const publish = store.appendStep({
    runId: run.id,
    kind: "host-operation",
    payload: {
      operation: "publish-pull-request",
      reviewedHeadCommit: "b".repeat(40),
      idempotencyKey: `wf${String(run.id)}:publish-pull-request:1`,
    },
    actor: SYSTEM,
  });
  store.startStep(
    publish.id,
    { kind: "operation", id: "publish-pull-request" },
    SYSTEM,
  );
  store.completeStep(publish.id, {
    status: "completed",
    result: {
      status: "completed",
      summary: "published",
      contractId: contracts.PUBLISH_PULL_REQUEST_RESULT_CONTRACT_ID,
      payload: {
        outcome: "published",
        reviewedHeadCommit: "b".repeat(40),
        cardId,
        sessionId: "implementer-1",
        provider: "github",
        number: 42,
        url: "https://example.test/pull/42",
      },
    },
    actor: SYSTEM,
  });
  return run;
}

function openMergeGate(runId: number, cardId: string) {
  const step = store.appendStep({
    runId,
    kind: "user-decision",
    payload: {
      decision: "merge-pull-request",
      cardId,
      reviewedHeadCommit: "b".repeat(40),
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

test("offers merge only at the run's open merge seam", () => {
  const card = pullRequestCard();
  const run = publishedRun(card.id);
  const before = store.getRun(run.id)!;
  assert.equal(
    workflowRunDeliveryOf(before, workflowRunCardFor(before)!)?.canMerge,
    false,
  );

  openMergeGate(run.id, card.id);
  const paused = store.getRun(run.id)!;
  assert.equal(
    workflowRunDeliveryOf(paused, workflowRunCardFor(paused)!)?.canMerge,
    true,
  );
});

test("refuses a merge the run's current state no longer offers", async () => {
  const card = pullRequestCard();
  const run = publishedRun(card.id);
  let calls = 0;

  await assert.rejects(
    mergeWorkflowRunPullRequest(
      run.id,
      { mergeMethod: "squash" },
      USER,
      undefined,
      {
        async runPullRequestAction() {
          calls += 1;
          throw new Error("must not reach the card seam");
        },
        async settleRun() {
          throw new Error("must not settle");
        },
      },
    ),
    /cannot merge: workflow run \d+ is active/,
  );
  assert.equal(calls, 0);
});

test("a merge at the seam carries the click's method and branch choice", async () => {
  const card = pullRequestCard();
  const run = publishedRun(card.id);
  openMergeGate(run.id, card.id);
  let observed: unknown;

  const outcome = await mergeWorkflowRunPullRequest(
    run.id,
    { mergeMethod: "rebase", deleteBranch: false },
    USER,
    "coordinator-1",
    {
      async runPullRequestAction(cardId, action, options, actor, sessionId) {
        observed = { cardId, action, options, actor, sessionId };
        return {
          card: cards.patchPullRequestCard(cardId, {
            status: "merged",
            actionMessage: "Merged #42.",
          }),
          actionToken: "token",
        };
      },
      async settleRun() {
        throw new Error("a merge settles nothing");
      },
    },
  );

  assert.deepEqual(observed, {
    cardId: card.id,
    action: "merge",
    options: { mergeMethod: "rebase", deleteBranch: false },
    actor: USER,
    sessionId: "coordinator-1",
  });
  assert.equal(outcome, "Merged #42.");
});

test("cleanup is offered only for a completed run whose merged checkout remains", () => {
  const card = pullRequestCard();
  const run = publishedRun(card.id);
  const deliveryOf = () => {
    const row = store.getRun(run.id)!;
    return workflowRunDeliveryOf(row, workflowRunCardFor(row)!);
  };

  // Merged, but the run has not completed yet.
  cards.patchPullRequestCard(card.id, { status: "merged" });
  assert.equal(deliveryOf()?.canCleanUp, false);

  store.setRunLifecycle(run.id, "completed", { actor: SYSTEM });
  assert.equal(deliveryOf()?.canCleanUp, true);

  // Already retired, here or from the live card.
  cards.patchPullRequestCard(card.id, { cleanedUp: true });
  assert.equal(deliveryOf()?.canCleanUp, false);
  assert.equal(deliveryOf()?.cleanedUp, true);
});

test("cleanup retires the checkout and then settles the run", async () => {
  const card = pullRequestCard();
  const run = publishedRun(card.id);
  cards.patchPullRequestCard(card.id, { status: "merged" });
  store.setRunLifecycle(run.id, "completed", { actor: SYSTEM });
  const order: string[] = [];

  const outcome = await cleanUpWorkflowRunCheckout(run.id, USER, undefined, {
    async runPullRequestAction(cardId, action) {
      order.push(action);
      return {
        card: cards.patchPullRequestCard(cardId, {
          cleanedUp: true,
          actionMessage: "Removed the worktree and deleted feature.",
        }),
        actionToken: "token",
      };
    },
    async settleRun(runId) {
      order.push("settle");
      assert.equal(runId, run.id);
      return store.getRun(run.id)!;
    },
  });

  assert.deepEqual(order, ["cleanup", "settle"]);
  assert.match(outcome, /Removed the worktree and deleted feature\./);
  assert.match(outcome, /The workflow run is settled\./);
});

test("a refused settlement still reports the cleanup that landed", async () => {
  const card = pullRequestCard();
  const run = publishedRun(card.id);
  cards.patchPullRequestCard(card.id, { status: "merged" });
  store.setRunLifecycle(run.id, "completed", { actor: SYSTEM });

  const outcome = await cleanUpWorkflowRunCheckout(run.id, USER, undefined, {
    async runPullRequestAction(cardId) {
      return {
        card: cards.patchPullRequestCard(cardId, {
          cleanedUp: true,
          actionMessage: "Removed the worktree.",
        }),
        actionToken: "token",
      };
    },
    async settleRun() {
      throw new Error("a role session is still running");
    },
  });

  assert.match(outcome, /Removed the worktree\./);
  assert.match(outcome, /could not be settled yet: a role session is still/);
  // The cleanup that landed is never reported as a failure, and the card it
  // acted on is left exactly as the card seam wrote it.
  assert.equal(cards.pullRequestCardById(card.id)?.actionError, undefined);
  assert.equal(
    cards.pullRequestCardById(card.id)?.actionMessage,
    "Removed the worktree.",
  );
});

test("stops offering merge once the card is merged, before the run completes", () => {
  // The provider merge marks the card `merged` while the run stays paused until
  // its observation completes it. `mergeCard` refuses a non-open card, so a
  // Merge offered in that window could only ever answer "nothing to merge".
  const card = pullRequestCard();
  const run = publishedRun(card.id);
  openMergeGate(run.id, card.id);
  const deliveryOf = () => {
    const row = store.getRun(run.id)!;
    return workflowRunDeliveryOf(row, workflowRunCardFor(row)!);
  };

  assert.equal(deliveryOf()?.canMerge, true);
  cards.patchPullRequestCard(card.id, { status: "merged" });
  assert.equal(deliveryOf()?.canMerge, false);
});

test("resolves the cleanup worktree the way the card action does", () => {
  // The card names no worktree and its session has none, so `requireWorktree`
  // would refuse — even though the RUN owns one. Reading the run row here (as
  // an earlier cut did) offered a cleanup that could only fail.
  const card = cards.createPullRequestCard(
    {
      sessionId: "implementer-1",
      status: "merged",
      title: "Workflow PR",
      headBranch: "feature",
      baseBranch: "main",
      provider: "github",
      number: 42,
      url: "https://example.test/pull/42",
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
  const run = publishedRun(card.id);
  store.attachRunWorktree(
    run.id,
    { worktreeId: "wt-run", branch: "feature" },
    SYSTEM,
  );
  store.setRunLifecycle(run.id, "completed", { actor: SYSTEM });
  const row = store.getRun(run.id)!;

  assert.equal(row.worktreeId, "wt-run");
  assert.equal(
    workflowRunDeliveryOf(row, workflowRunCardFor(row)!)?.canCleanUp,
    false,
  );
});

test("a role session's own cleanup never tries to settle the run it belongs to", async () => {
  // How `workflow_gate_action` arrives: the coordinator is streaming the very
  // turn making this call, so the acknowledgement could only be refused on it —
  // and the turn still owes an outcome that would resurface as its own card.
  const card = pullRequestCard();
  const run = publishedRun(card.id, "coordinator-1");
  cards.patchPullRequestCard(card.id, { status: "merged" });
  store.setRunLifecycle(run.id, "completed", { actor: SYSTEM });
  let settleCalls = 0;

  const outcome = await cleanUpWorkflowRunCheckout(
    run.id,
    USER,
    "coordinator-1",
    {
      async runPullRequestAction(cardId) {
        return {
          card: cards.patchPullRequestCard(cardId, {
            cleanedUp: true,
            actionMessage: "Removed the worktree.",
          }),
          actionToken: "token",
        };
      },
      async settleRun() {
        settleCalls += 1;
        throw new Error("must not be attempted from a role session's turn");
      },
    },
  );

  assert.equal(settleCalls, 0);
  assert.match(outcome, /Removed the worktree\./);
  assert.match(outcome, /keeps its Settle in the Sessions inbox/);
});

test("an unsettled run after cleanup is a live condition that retires itself", async () => {
  // The button promised to settle the run. When that part does not happen the
  // Task has to say so — but as a CONDITION derived from the run's attention
  // cursor, not a remembered sentence: once the run is settled anywhere, the
  // Task must stop telling the user to go and settle it.
  const card = pullRequestCard();
  const run = publishedRun(card.id);
  cards.patchPullRequestCard(card.id, { status: "merged" });
  store.setRunLifecycle(run.id, "completed", { actor: SYSTEM });
  const deliveryOf = () => {
    const row = store.getRun(run.id)!;
    return workflowRunDeliveryOf(row, workflowRunCardFor(row)!);
  };
  assert.equal(deliveryOf()?.settleStillNeeded, false);

  const outcome = await cleanUpWorkflowRunCheckout(run.id, USER, undefined, {
    async runPullRequestAction(cardId) {
      return {
        card: cards.patchPullRequestCard(cardId, {
          cleanedUp: true,
          actionMessage: "Removed the worktree.",
        }),
        actionToken: "token",
      };
    },
    async settleRun() {
      throw new Error("a role session is still running.");
    },
  });
  assert.match(outcome, /could not be settled yet/);
  assert.equal(deliveryOf()?.settleStillNeeded, true);

  // Settled by hand from the inbox afterwards: the Task stops asking.
  const pending = store.getRun(run.id)!.attention!.revision;
  store.settleRun(run.id, pending);
  assert.equal(deliveryOf()?.settleStillNeeded, false);
});

test("a cleanup that settled the run asks for nothing further", async () => {
  const card = pullRequestCard();
  const run = publishedRun(card.id);
  cards.patchPullRequestCard(card.id, { status: "merged" });
  store.setRunLifecycle(run.id, "completed", { actor: SYSTEM });

  await cleanUpWorkflowRunCheckout(run.id, USER, undefined, {
    async runPullRequestAction(cardId) {
      return {
        card: cards.patchPullRequestCard(cardId, {
          cleanedUp: true,
          actionMessage: "Removed the worktree.",
        }),
        actionToken: "token",
      };
    },
    async settleRun(runId) {
      const row = store.getRun(runId)!;
      return store.settleRun(runId, row.attention?.revision ?? 0) ?? row;
    },
  });

  const row = store.getRun(run.id)!;
  const delivery = workflowRunDeliveryOf(row, workflowRunCardFor(row)!);
  assert.equal(delivery?.settleStillNeeded, false);
  assert.equal(delivery?.canCleanUp, false);
});

test("a stale gate is refused as a run refusal, before the card is touched", async () => {
  const card = pullRequestCard();
  const run = publishedRun(card.id);
  let calls = 0;

  await assert.rejects(
    cleanUpWorkflowRunCheckout(run.id, USER, undefined, {
      async runPullRequestAction() {
        calls += 1;
        throw new Error("must not reach the card seam");
      },
      async settleRun() {
        throw new Error("must not settle");
      },
    }),
    (err: unknown) => err instanceof WorkflowDeliveryRefusal,
  );
  assert.equal(calls, 0);
  assert.equal(cards.pullRequestCardById(card.id)?.actionError, undefined);
});
