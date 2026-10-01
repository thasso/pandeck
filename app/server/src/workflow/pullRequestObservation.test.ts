import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "workflow-pr-observation-test-"));
process.env.ASSISTANT_CWD = tmp;

const store = await import("../db/workflowStore.ts");
const cards = await import("../pullRequestCards.ts");
const engine = await import("./engine.ts");
const executors = await import("./executors.ts");
const observation = await import("./pullRequestObservation.ts");
const projection = await import("./cardProjection.ts");
const recipe = await import("./codeDeliveryRecipe.ts");
const contracts = await import("./resultContracts.ts");
const { closeDb } = await import("../db/index.ts");

const HEAD = "a".repeat(40);
const SYSTEM = { kind: "system" as const };

function createCard() {
  return cards.createPullRequestCard(
    {
      sessionId: "session-1",
      status: "open",
      title: "Observed workflow PR",
      headBranch: "feature",
      baseBranch: "main",
      provider: "github",
      number: 42,
      url: "https://example.test/pull/42",
    },
    {
      repoRoot: "/tmp/repo",
      sessionKind: "developer",
      sessionId: "session-1",
      headBranch: "feature",
      baseBranch: "main",
      draft: false,
      observedHeadSha: HEAD,
    },
  );
}

function createWaitingRun(cardId: string) {
  const run = store.createRun({
    taskId: 372,
    recipeId: recipe.CODE_DELIVERY_RECIPE_ID,
    recipeVersion: recipe.CODE_DELIVERY_RECIPE_VERSION,
    maxIterations: 3,
    maxReviewPasses: 1,
    actor: SYSTEM,
  });
  store.attachRunWorktree(
    run.id,
    { worktreeId: `wt-${run.id}`, branch: "feature" },
    SYSTEM,
  );
  const step = store.appendStep({
    runId: run.id,
    kind: "wait",
    payload: {
      condition: "pull-request-ready",
      cardId,
      reviewedHeadCommit: HEAD,
    },
    actor: SYSTEM,
  });
  return { run, step };
}

beforeEach(() => {
  store.resetWorkflowStoreForTests();
  cards.resetPullRequestCardsStoreForTests();
  engine.resetWorkflowEngineForTests();
  executors.resetWorkflowExecutorsForTests();
  observation.setWorkflowObservationNotifierForTests(async () => undefined);
  observation.registerPullRequestObservationRuntime();
});

afterAll(() => {
  observation.setWorkflowObservationNotifierForTests(null);
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

test("a stale-head observation can be retried after the live card catches up", async () => {
  const card = createCard();
  const { run, step } = createWaitingRun(card.id);
  await engine.advanceRun(run.id);

  const staleHead = "b".repeat(40);
  const stale = cards.patchPullRequestCard(
    card.id,
    {
      ci: { state: "success", total: 2 },
      review: { changesRequested: false },
      mergeable: true,
      conflicts: false,
    },
    { observedHeadSha: staleHead },
  );
  await observation.observePullRequestCardForWorkflows(stale, staleHead);

  const paused = store.getRun(run.id)!;
  assert.equal(paused.lifecycle, "paused");
  assert.equal(
    projection.workflowRunCardOf(paused, store.listSteps(run.id)).canRetry,
    true,
  );
  assert.deepEqual(store.getStep(step.id)?.result?.payload, {
    outcome: "head-changed",
    headCommit: staleHead,
    reason: `pull request #42 head ${staleHead} no longer equals reviewed head ${HEAD}; commit/sync and review are required again`,
  });

  cards.patchPullRequestCard(card.id, {}, { observedHeadSha: HEAD });
  await engine.retryRun(run.id, { kind: "user" });

  const steps = store.listSteps(run.id);
  const retriedWait = steps.find(
    (candidate) => candidate.predecessorId === step.id,
  );
  assert.equal(retriedWait?.kind, "wait");
  assert.deepEqual(retriedWait?.result?.payload, {
    outcome: "ready",
    headCommit: HEAD,
  });
  const decision = steps.at(-1)!;
  assert.equal(decision.kind, "user-decision");
  assert.equal(decision.status, "running");
  assert.equal(store.getRun(run.id)?.lifecycle, "paused");
});

test("green exact-head CI, mergeability, and hosted review make the merge decision ready", async () => {
  const card = createCard();
  const { run, step } = createWaitingRun(card.id);
  const notifications: import("../webPush.ts").AppWebPushNotification[] = [];
  observation.setWorkflowObservationNotifierForTests(async (value) => {
    notifications.push(value);
  });

  await engine.advanceRun(run.id);
  assert.equal(store.getStep(step.id)?.status, "running");

  const ready = cards.patchPullRequestCard(card.id, {
    ci: { state: "success", total: 2 },
    review: { changesRequested: false },
    mergeable: true,
    conflicts: false,
  });
  const result = await observation.observePullRequestCardForWorkflows(
    ready,
    HEAD,
  );

  assert.deepEqual(result, { settled: 1, suppressCiNotification: true });
  assert.equal(store.getRun(run.id)?.lifecycle, "paused");
  assert.match(
    store.getRun(run.id)?.lifecycleReason ?? "",
    /merge decision ready/,
  );
  assert.deepEqual(store.getStep(step.id)?.result?.payload, {
    outcome: "ready",
    headCommit: HEAD,
  });
  assert.equal(
    store.getStep(step.id)?.result?.contractId,
    contracts.PULL_REQUEST_OBSERVATION_RESULT_CONTRACT_ID,
  );
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.title, "Workflow ready to merge");
  assert.equal(notifications[0]?.navigatePath, "/tasks/372");
  const decision = store.listSteps(run.id).at(-1)!;
  assert.equal(decision.kind, "user-decision");
  assert.equal(decision.status, "running");
  assert.deepEqual(decision.payload, {
    decision: "merge-pull-request",
    cardId: card.id,
    reviewedHeadCommit: HEAD,
    allowedChoices: ["merge", "cancel"],
  });
  assert.ok(
    store
      .listEvents(run.id)
      .some(
        (event) =>
          event.type === "observation-recorded" && event.stepId === step.id,
      ),
  );
});

test("cancelling at the merge gate records the other allowed choice", async () => {
  const card = createCard();
  const { run } = createWaitingRun(card.id);
  await engine.advanceRun(run.id);
  const ready = cards.patchPullRequestCard(card.id, {
    ci: { state: "success", total: 1 },
    review: { changesRequested: false },
    mergeable: true,
  });
  await observation.observePullRequestCardForWorkflows(ready, HEAD);

  await engine.cancelRun(run.id, { kind: "user" });

  assert.equal(store.getRun(run.id)?.lifecycle, "cancelled");
  const decision = store.listSteps(run.id).at(-1)!;
  assert.equal(decision.status, "completed");
  assert.deepEqual(decision.result?.payload, {
    choice: "cancel",
    source: "app",
  });
});

test("the existing merge action records its choice and completes on the observed merge", async () => {
  const card = createCard();
  const { run } = createWaitingRun(card.id);
  await engine.advanceRun(run.id);
  const ready = cards.patchPullRequestCard(card.id, {
    ci: { state: "success", total: 2 },
    review: { changesRequested: false },
    mergeable: true,
  });
  await observation.observePullRequestCardForWorkflows(ready, HEAD);

  const merged = cards.patchPullRequestCard(card.id, { status: "merged" });
  assert.equal(
    await observation.recordPullRequestMergeForWorkflows(merged, {
      mergeMethod: "squash",
      deleteBranch: false,
      actor: {
        kind: "user",
        id: "via coordinator session coordinator-42",
      },
    }),
    1,
  );

  assert.equal(store.getRun(run.id)?.lifecycle, "completed");
  const decision = store.listSteps(run.id).at(-1)!;
  assert.equal(decision.kind, "user-decision");
  assert.equal(decision.status, "completed");
  assert.deepEqual(decision.result?.payload, {
    choice: "merge",
    source: "app",
    mergeMethod: "squash",
    deleteBranch: false,
  });
  const events = store.listEvents(run.id);
  assert.ok(
    events.some(
      (event) =>
        event.type === "step-completed" &&
        event.stepId === decision.id &&
        event.actor.kind === "user" &&
        event.actor.id === "via coordinator session coordinator-42",
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "run-completed" && event.actor.kind === "external",
    ),
  );
});

test("a merge from the hosting UI completes a run waiting on its decision", async () => {
  const card = createCard();
  const { run } = createWaitingRun(card.id);
  await engine.advanceRun(run.id);
  const ready = cards.patchPullRequestCard(card.id, {
    ci: { state: "success", total: 1 },
    review: { changesRequested: false },
    mergeable: true,
  });
  await observation.observePullRequestCardForWorkflows(ready, HEAD);

  const merged = cards.patchPullRequestCard(card.id, { status: "merged" });
  const result = await observation.observePullRequestCardForWorkflows(
    merged,
    HEAD,
  );

  assert.equal(result.settled, 1);
  assert.equal(store.getRun(run.id)?.lifecycle, "completed");
  assert.deepEqual(store.listSteps(run.id).at(-1)?.result?.payload, {
    choice: "merge",
    source: "hosting",
  });
});

test("an externally merged PR completes directly from the running wait", async () => {
  const card = createCard();
  const { run } = createWaitingRun(card.id);
  await engine.advanceRun(run.id);
  engine.pauseRun(run.id, "paused by user", { kind: "user" });

  const merged = cards.patchPullRequestCard(card.id, { status: "merged" });
  await observation.observePullRequestCardForWorkflows(merged, "b".repeat(40));

  assert.equal(store.getRun(run.id)?.lifecycle, "completed");
  assert.deepEqual(store.listSteps(run.id).at(-1)?.result?.payload, {
    outcome: "merged",
    headCommit: "b".repeat(40),
    reason: "pull request #42 merged while the workflow was waiting",
  });
});

test("failure, hosted changes, and base conflict are terminal attention routes", () => {
  const card = createCard();
  const payload = {
    condition: "pull-request-ready" as const,
    cardId: card.id,
    reviewedHeadCommit: HEAD,
  };
  const cases = [
    {
      card: { ...card, ci: { state: "failure" as const, total: 1 } },
      outcome: "ci-failure",
    },
    {
      card: { ...card, review: { changesRequested: true } },
      outcome: "changes-requested",
    },
    {
      card: { ...card, mergeable: false, conflicts: true },
      outcome: "base-conflict",
    },
  ];
  for (const item of cases)
    assert.equal(
      observation.evaluatePullRequestObservation(payload, {
        card: item.card,
        headSha: HEAD,
      })?.outcome,
      item.outcome,
    );
});

// Completing a wait pauses the run and cannot be re-settled, so a conflict has
// to be POSITIVE evidence: an unconfirmed `mergeable: false` means "ask again",
// and a draft's mergeability means nothing at all — Forgejo reports every WIP
// pull request as not mergeable (Task 535).
test("mergeability that is unconfirmed, or a draft's, is not a base conflict", () => {
  const card = createCard();
  const payload = {
    condition: "pull-request-ready" as const,
    cardId: card.id,
    reviewedHeadCommit: HEAD,
  };
  const cases: Array<Partial<import("@assistant/shared").PullRequestCard>> = [
    // A single conflicting read the watcher has not confirmed yet.
    { mergeable: false },
    // A draft, whatever the provider says about merging it.
    { draft: true, mergeable: false, conflicts: true },
    // Green everything, but still a draft: not ready to merge either.
    {
      draft: true,
      mergeable: true,
      ci: { state: "success", total: 1 },
      review: { changesRequested: false },
    },
  ];
  for (const patch of cases)
    assert.equal(
      observation.evaluatePullRequestObservation(payload, {
        card: { ...card, ...patch },
        headSha: HEAD,
      }),
      undefined,
      JSON.stringify(patch),
    );
});

// Run 78: #180 was created as a draft at 15:14, so Forgejo answered
// `mergeable: false` for the two hours it stayed one. Publication un-drafted it
// and the wait consumed the card half a second later — reading that stale value
// as a terminal base conflict, pausing the run, and buying a rebase that had
// nothing to rebase.
test("a draft-era mergeable:false is not latched into a conflict at publish", async () => {
  const card = createCard();
  const { run, step } = createWaitingRun(card.id);
  await engine.advanceRun(run.id);

  const drafted = cards.patchPullRequestCard(card.id, {
    draft: true,
    mergeable: false,
    ci: { state: "success", total: 2 },
    review: { changesRequested: false },
  });
  assert.deepEqual(
    await observation.observePullRequestCardForWorkflows(drafted, HEAD),
    { settled: 0, suppressCiNotification: false },
  );

  // What `publishPullRequest` writes once the PR is reviewable: the draft flag
  // gone and mergeability re-read, still unanswered right after the un-draft.
  const published = cards.patchPullRequestCard(card.id, {
    draft: undefined,
    mergeable: null,
    conflicts: undefined,
  });
  assert.deepEqual(
    await observation.observePullRequestCardForWorkflows(published, HEAD),
    { settled: 0, suppressCiNotification: false },
  );
  assert.equal(store.getStep(step.id)?.status, "running");
  assert.equal(store.getRun(run.id)?.lifecycle, "active");

  // The same run then reaches the merge decision from the answered poll.
  const answered = cards.patchPullRequestCard(card.id, { mergeable: true });
  assert.deepEqual(
    await observation.observePullRequestCardForWorkflows(answered, HEAD),
    { settled: 1, suppressCiNotification: true },
  );
  assert.deepEqual(store.getStep(step.id)?.result?.payload, {
    outcome: "ready",
    headCommit: HEAD,
  });
  assert.equal(store.listSteps(run.id).at(-1)?.kind, "user-decision");
});

test("a stale poll cannot supersede while a newer reactive observation is in flight", async () => {
  const card = createCard();
  const { run } = createWaitingRun(card.id);
  await engine.advanceRun(run.id);
  const ready = cards.patchPullRequestCard(card.id, {
    ci: { state: "success", total: 1 },
    review: { changesRequested: false },
    mergeable: true,
  });
  await observation.observePullRequestCardForWorkflows(ready, HEAD);
  const decision = store.listSteps(run.id).at(-1)!;
  assert.equal(decision.kind, "user-decision");

  const stalePoll = cards.beginPullRequestCardObservation(card.id);
  const reactive = cards.beginPullRequestCardObservation(card.id);
  const stale = cards.patchPullRequestCardObservation(
    card.id,
    stalePoll,
    { mergeable: false, conflicts: true },
    { observedHeadSha: HEAD },
  );
  assert.equal(stale, undefined);
  assert.equal(store.getStep(decision.id)?.status, "running");
  assert.equal(store.listSteps(run.id).at(-1)?.id, decision.id);

  const current = cards.patchPullRequestCardObservation(
    card.id,
    reactive,
    { mergeable: false, conflicts: true },
    { observedHeadSha: HEAD },
  )!;
  await observation.observePullRequestCardForWorkflows(current, HEAD);
  assert.equal(store.getStep(decision.id)?.status, "completed");
  assert.deepEqual(store.listSteps(run.id).at(-1)?.result?.payload, {
    outcome: "base-conflict",
    headCommit: HEAD,
    reason:
      "pull request #42 conflicts with its base; choose rebase and re-review to attempt a clean deterministic rebase",
  });
});

test("a base conflict supersedes an open merge decision and returns to observation", async () => {
  const card = createCard();
  const { run } = createWaitingRun(card.id);
  await engine.advanceRun(run.id);
  const ready = cards.patchPullRequestCard(card.id, {
    ci: { state: "success", total: 1 },
    review: { changesRequested: false },
    mergeable: true,
  });
  await observation.observePullRequestCardForWorkflows(ready, HEAD);
  const decision = store.listSteps(run.id).at(-1)!;
  assert.equal(decision.kind, "user-decision");

  const conflicted = cards.patchPullRequestCard(card.id, {
    mergeable: false,
    conflicts: true,
  });
  const result = await observation.observePullRequestCardForWorkflows(
    conflicted,
    HEAD,
  );

  assert.equal(result.settled, 1);
  assert.deepEqual(store.getStep(decision.id)?.result?.payload, {
    supersededBy: "pull-request-observation",
    observation: {
      outcome: "base-conflict",
      headCommit: HEAD,
      reason:
        "pull request #42 conflicts with its base; choose rebase and re-review to attempt a clean deterministic rebase",
    },
  });
  const tail = store.listSteps(run.id).at(-1)!;
  assert.equal(tail.kind, "wait");
  assert.equal(tail.status, "completed");
  assert.deepEqual(tail.result?.payload, {
    outcome: "base-conflict",
    headCommit: HEAD,
    reason:
      "pull request #42 conflicts with its base; choose rebase and re-review to attempt a clean deterministic rebase",
  });
  assert.equal(store.getRun(run.id)?.lifecycle, "paused");
  assert.match(
    store.getRun(run.id)?.lifecycleReason ?? "",
    /conflicts with its base/,
  );
});

test("a successful exact-head merge completes even after supersession settled the wait", async () => {
  const card = createCard();
  const { run } = createWaitingRun(card.id);
  await engine.advanceRun(run.id);
  const ready = cards.patchPullRequestCard(card.id, {
    ci: { state: "success", total: 1 },
    review: { changesRequested: false },
    mergeable: true,
  });
  await observation.observePullRequestCardForWorkflows(ready, HEAD);
  assert.equal(observation.reviewedHeadForMergeDecision(card.id), HEAD);

  const conflicted = cards.patchPullRequestCard(card.id, {
    mergeable: false,
    conflicts: true,
  });
  await observation.observePullRequestCardForWorkflows(conflicted, HEAD);
  assert.equal(store.listOpenSteps(run.id).length, 0);
  assert.equal(store.getRun(run.id)?.lifecycle, "paused");

  const merged = cards.patchPullRequestCard(card.id, { status: "merged" });
  await observation.recordPullRequestMergeForWorkflows(merged, {
    mergeMethod: "squash",
    deleteBranch: true,
    expectedHeadCommit: HEAD,
  });

  assert.equal(store.getRun(run.id)?.lifecycle, "completed");
  assert.deepEqual(store.listSteps(run.id).at(-1)?.result?.payload, {
    outcome: "merged",
    headCommit: HEAD,
    reason: "pull request #42 merged while the workflow was waiting",
  });
});

test("a base conflict exposes a user-authorized rebase and re-review successor", async () => {
  const card = createCard();
  const { run } = createWaitingRun(card.id);
  await engine.advanceRun(run.id);
  const conflicted = cards.patchPullRequestCard(card.id, {
    mergeable: false,
    conflicts: true,
  });
  await observation.observePullRequestCardForWorkflows(conflicted, HEAD);
  assert.match(
    store.getRun(run.id)?.lifecycleReason ?? "",
    /conflicts with its base/,
  );

  // Drop the observer registration to prove this action does not ask an agent
  // to repair anything: it appends only the existing deterministic operation.
  executors.resetWorkflowExecutorsForTests();
  await engine.rebaseAndReviewRun(run.id, { kind: "user" });
  const last = store.listSteps(run.id).at(-1)!;
  assert.equal(last.kind, "host-operation");
  assert.equal(
    (last.payload as Record<string, unknown>).operation,
    recipe.COMMIT_SYNC_OPERATION_ID,
  );
  assert.match(store.getRun(run.id)?.lifecycleReason ?? "", /no executor/);
});

test("boot reconciliation consumes a merged card left beside a paused decision", async () => {
  const card = createCard();
  const { run } = createWaitingRun(card.id);
  await engine.advanceRun(run.id);
  const ready = cards.patchPullRequestCard(card.id, {
    ci: { state: "success", total: 1 },
    review: { changesRequested: false },
    mergeable: true,
  });
  await observation.observePullRequestCardForWorkflows(ready, HEAD);
  assert.equal(store.getRun(run.id)?.lifecycle, "paused");
  assert.equal(store.listSteps(run.id).at(-1)?.kind, "user-decision");

  // The provider merge and card projection landed, then the process died before
  // workflow bookkeeping could record the choice.
  cards.patchPullRequestCard(card.id, { status: "merged" });
  engine.resetWorkflowEngineForTests();
  await observation.reconcilePullRequestObservationsOnBoot();

  assert.equal(store.getRun(run.id)?.lifecycle, "completed");
  assert.deepEqual(store.listSteps(run.id).at(-1)?.result?.payload, {
    choice: "merge",
    source: "hosting",
  });
});

test("boot reconciliation re-observes a persisted running subscription", async () => {
  const card = createCard();
  const { run, step } = createWaitingRun(card.id);
  await engine.advanceRun(run.id);
  assert.equal(store.getStep(step.id)?.status, "running");

  // The provider observation landed durably, then the process died before the
  // workflow observer consumed it.
  cards.patchPullRequestCard(card.id, {
    ci: { state: "success", total: 1 },
    review: { changesRequested: false },
    mergeable: true,
  });
  engine.resetWorkflowEngineForTests();
  executors.resetWorkflowExecutorsForTests();
  observation.registerPullRequestObservationRuntime();

  await engine.reconcileWorkflowRunsOnBoot();

  assert.equal(store.getStep(step.id)?.status, "completed");
  assert.equal(store.getRun(run.id)?.lifecycle, "paused");
  assert.match(
    store.getRun(run.id)?.lifecycleReason ?? "",
    /merge decision ready/,
  );
});
