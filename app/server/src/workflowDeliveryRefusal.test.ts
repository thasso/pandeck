/**
 * What the Task hears when one of a run's two DELIVERY controls is refused
 * before the pull-request card is ever touched.
 *
 * The seam stays quiet about a failure the card itself is carrying, because the
 * Workflow card renders that beside the button. A refusal raised at the gate is
 * the other kind: it never reaches the card, so nothing else would ever say it
 * — and a card still holding the LAST action's `actionError` (which only the
 * next dequeue clears) must not buy this one its silence.
 *   pnpm --filter @assistant/server test src/workflowDeliveryRefusal.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, test } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "workflow-delivery-refusal-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { Connection } = await import("./connection.ts");
const cards = await import("./pullRequestCards.ts");
const store = await import("./db/workflowStore.ts");
const recipe = await import("./workflow/codeDeliveryRecipe.ts");
const contracts = await import("./workflow/resultContracts.ts");
const { closeDb } = await import("./db/index.ts");

const SYSTEM = { kind: "system" } as const;
let nextTask = 8800;

beforeEach(() => {
  store.resetWorkflowStoreForTests();
  cards.resetPullRequestCardsStoreForTests();
});

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

/** Minimal open socket: `Connection` only reads `readyState`/`OPEN` and sends. */
function fakeSocket(sent: ServerMessage[]) {
  return {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
  } as unknown as ConstructorParameters<typeof Connection>[0];
}

function pullRequestCard() {
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
      worktreeId: "wt-42",
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

/** A run that published `cardId`, with no open merge seam: merge is refused. */
function publishedRun(cardId: string) {
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
  store.startStep(coordinator.id, { kind: "session", id: "coord-1" }, SYSTEM);
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

test("states a refused delivery on the Task even when the card holds an older failure", async () => {
  const card = pullRequestCard();
  const run = publishedRun(card.id);
  // What a PREVIOUS merge attempt left on the card. It stands until the next
  // action dequeues — and this click never gets that far.
  cards.patchPullRequestCard(card.id, {
    actionError: "The head moved while merging.",
  });

  const sent: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(sent));
  await connection.handle({
    type: "mergeWorkflowRun",
    runId: String(run.id),
    mergeMethod: "squash",
    requestId: "req-merge-1",
  } as ClientMessage);

  const failure = sent.find((message) => message.type === "error");
  assert.ok(failure, "the refusal reached the Task");
  assert.equal(failure.type === "error" && failure.target?.type, "task");
  assert.equal(
    failure.type === "error" && failure.target?.id,
    String(run.taskId),
  );
  assert.match(
    failure.type === "error" ? failure.message : "",
    /cannot merge: workflow run \d+ is active/,
  );
  // The failure carries the click's id, which is how the browser knows its
  // delivery control is answered and stops claiming the action is running.
  assert.equal(failure.type === "error" && failure.requestId, "req-merge-1");
  // A refused command settles nothing: the browser must not read this click as
  // completed work.
  assert.equal(
    sent.some((message) => message.type === "mutationSettled"),
    false,
  );
  // The card was never touched, so its own sentence is untouched too.
  assert.equal(
    cards.pullRequestCardById(card.id)?.actionError,
    "The head moved while merging.",
  );
});

test("repeats itself rather than going quiet when the old failure reads the same", async () => {
  // The seam decides by what the card's sentence WAS and what it became, which
  // cannot separate "refused at the gate over an identical old sentence" from
  // "failed at the card with the same words as last time". It errs towards
  // speaking: the Task hears about the refusal either way, at the cost of a
  // sentence that may already be on the card.
  const card = pullRequestCard();
  const run = publishedRun(card.id);

  const first: ServerMessage[] = [];
  await new Connection(fakeSocket(first)).handle({
    type: "mergeWorkflowRun",
    runId: String(run.id),
    mergeMethod: "squash",
  } as ClientMessage);
  const refusal = first.find((message) => message.type === "error");
  assert.ok(refusal && refusal.type === "error");
  // The exact refusal, as the card would be holding it from an earlier attempt.
  cards.patchPullRequestCard(card.id, {
    actionError: refusal.message.replace("Workflow delivery failed: ", ""),
  });

  const second: ServerMessage[] = [];
  await new Connection(fakeSocket(second)).handle({
    type: "mergeWorkflowRun",
    runId: String(run.id),
    mergeMethod: "squash",
  } as ClientMessage);
  assert.equal(
    second.some((message) => message.type === "error"),
    true,
    "the refusal is still stated",
  );
});

test("leaves a failure the card just persisted to the card alone", async () => {
  const card = pullRequestCard();
  const run = publishedRun(card.id);
  const step = store.appendStep({
    runId: run.id,
    kind: "user-decision",
    payload: {
      decision: "merge-pull-request",
      cardId: card.id,
      reviewedHeadCommit: "b".repeat(40),
      allowedChoices: ["merge", "cancel"],
    },
    actor: SYSTEM,
  });
  store.startStep(step.id, { kind: "operation", id: "user-decision" }, SYSTEM);
  store.setRunLifecycle(run.id, "paused", {
    reason: "merge decision ready",
    actor: SYSTEM,
  });

  const sent: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(sent));
  await connection.handle({
    type: "mergeWorkflowRun",
    runId: String(run.id),
    mergeMethod: "squash",
    requestId: "req-merge-2",
  } as ClientMessage);

  // The merge reached the card seam and failed there (no repository behind this
  // card): the card recorded why, and the Task is not told the same thing twice.
  const persisted = cards.pullRequestCardById(card.id)?.actionError;
  assert.ok(persisted, "the card persisted the failure");
  assert.equal(
    sent.some(
      (message) =>
        message.type === "error" && message.message.includes(persisted),
    ),
    false,
    "the Task note does not repeat the card's own sentence",
  );
});
