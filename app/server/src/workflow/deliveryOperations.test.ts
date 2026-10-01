import { applyPatch } from "@assistant/shared";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { PullRequestCard, WorkflowActor } from "@assistant/shared";
import type { WorktreeRow } from "../db/worktreeStore.ts";
import type { WorkflowRunRow, WorkflowStepRow } from "../db/workflowStore.ts";
import type { GitHostingProvider } from "../gitHosting.ts";
import {
  beginPullRequestCardObservation,
  createPullRequestCard,
  patchPullRequestCardObservation,
  pullRequestCardById,
  pullRequestCardRecord,
  resetPullRequestCardsStoreForTests,
} from "../pullRequestCards.ts";
import {
  CI_OBSERVATION_OPERATION_ID,
  DELIVERY_GATE_OPERATION_ID,
  operationIdempotencyKey,
  PUBLISH_PULL_REQUEST_OPERATION_ID,
} from "./codeDeliveryRecipe.ts";
import {
  createCiObservationOperation,
  createDeliveryGateOperation,
  createPublishPullRequestOperation,
} from "./deliveryOperations.ts";
import type { WorkflowStepContext } from "./executors.ts";

const ACTOR: WorkflowActor = { kind: "system" };
const REVIEWED = "a".repeat(40);
const MOVED = "b".repeat(40);

const WORKTREE: WorktreeRow = {
  id: "wt-delivery",
  projectId: "project-one",
  mainRepoRoot: "/repo/main",
  path: "/repo/run",
  branch: "feature",
  baseBranch: "main",
  baseCommit: "c".repeat(40),
  status: "active",
  mergeStateJson: null,
  createdAt: 1,
  updatedAt: 1,
  removedAt: null,
};

const RUN: WorkflowRunRow = {
  id: 31,
  taskId: 371,
  projectId: WORKTREE.projectId,
  recipeId: "code-delivery",
  recipeVersion: 4,
  worktreeId: WORKTREE.id,
  branch: WORKTREE.branch,
  lifecycle: "active",
  maxIterations: 3,
  maxReviewPasses: 1,
  createdAt: 1,
  updatedAt: 1,
};

function context(
  operation:
    | typeof CI_OBSERVATION_OPERATION_ID
    | typeof DELIVERY_GATE_OPERATION_ID
    | typeof PUBLISH_PULL_REQUEST_OPERATION_ID,
): WorkflowStepContext {
  const predecessorId = 40;
  const step: WorkflowStepRow = {
    id: 41,
    runId: RUN.id,
    kind: "host-operation",
    payload: {
      operation,
      idempotencyKey: operationIdempotencyKey(RUN.id, operation, predecessorId),
      reviewedHeadCommit: REVIEWED,
    },
    status: "running",
    executor: { kind: "operation", id: operation },
    attempt: 1,
    predecessorId,
    createdAt: 1,
    updatedAt: 1,
  };
  return { run: RUN, step, actor: ACTOR };
}

function inspection(head = REVIEWED, status = "") {
  return {
    worktree: () => WORKTREE,
    branch: async () => WORKTREE.branch,
    status: async () => status,
    head: async () => head,
  };
}

test("delivery gate permits only a clean exact reviewed HEAD", async () => {
  const operation = createDeliveryGateOperation(inspection());
  const outcome = await operation.execute(context(DELIVERY_GATE_OPERATION_ID));
  assert.equal(outcome.status, "completed");
  assert.deepEqual(outcome.payload, {
    outcome: "ready",
    reviewedHeadCommit: REVIEWED,
  });
});

test("delivery gate reports dirty or moved work as re-review evidence", async () => {
  const operation = createDeliveryGateOperation(
    inspection(MOVED, " M changed.ts\n?? new.ts\n"),
  );
  const outcome = await operation.execute(context(DELIVERY_GATE_OPERATION_ID));
  assert.equal(outcome.status, "completed");
  assert.deepEqual(outcome.payload, {
    outcome: "review-required",
    reviewedHeadCommit: REVIEWED,
    observedHeadCommit: MOVED,
    // Uncommitted work is in no commit, so nothing downstream may offer to
    // deliver "what is there" — the recipe reads this rather than the prose.
    worktreeDirty: true,
    reason: `the run worktree has uncommitted changes; local HEAD ${MOVED} differs from reviewed head ${REVIEWED}; commit/sync and review are required again`,
  });
});

test("early publication pushes only the run branch, keeps one draft card, and records green checks", async () => {
  const draftCard: PullRequestCard = { ...CARD, draft: true };
  const pushed: string[] = [];
  const operation = createCiObservationOperation({
    ...inspection(),
    push: async (options) => {
      pushed.push(options.branch ?? "");
      return {
        status: "pushed",
        forced: false,
        setUpstream: true,
        output: "pushed",
      };
    },
    cards: () => [draftCard],
    card: () => draftCard,
    provider: async () =>
      ({
        kind: "github",
        refChecks: async (ref: string) => ({
          state: "success",
          checks: [{ name: "test", status: "success", excerpt: ref }],
        }),
      }) as unknown as GitHostingProvider,
  });
  const outcome = await operation.execute(context(CI_OBSERVATION_OPERATION_ID));
  assert.deepEqual(pushed, [WORKTREE.branch]);
  assert.equal(outcome.status, "completed");
  assert.deepEqual(outcome.payload, {
    outcome: "green",
    headCommit: REVIEWED,
    checks: [{ name: "test", status: "success", excerpt: REVIEWED }],
  });
});

test("a repository without a configured provider is not pushed", async () => {
  let pushes = 0;
  const operation = createCiObservationOperation({
    ...inspection(),
    provider: async () => null,
    push: async () => {
      pushes += 1;
      throw new Error("must not push without a configured provider");
    },
  });
  const outcome = await operation.execute(context(CI_OBSERVATION_OPERATION_ID));
  assert.equal(pushes, 0);
  assert.deepEqual(outcome.payload, {
    outcome: "none",
    headCommit: REVIEWED,
    checks: [],
    reason:
      "No configured git hosting provider/remote is available; the run branch was not pushed.",
  });
});

test("early publication refuses to push a run ref that moved past the commit/sync SHA", async () => {
  let pushes = 0;
  const operation = createCiObservationOperation({
    ...inspection(MOVED),
    push: async () => {
      pushes += 1;
      throw new Error("must not push an unobserved head");
    },
  });
  const outcome = await operation.execute(context(CI_OBSERVATION_OPERATION_ID));
  assert.equal(outcome.status, "blocked");
  assert.equal(pushes, 0);
  assert.match(outcome.summary, /does not equal commit\/sync head/);
});

test("the first early push reserves exactly one draft PR card", async () => {
  let began = 0;
  let created: PullRequestCard | undefined;
  const operation = createCiObservationOperation({
    ...inspection(),
    push: async () => ({
      status: "pushed",
      forced: false,
      setUpstream: true,
      output: "pushed",
    }),
    cards: () => (created ? [created] : []),
    card: () => created,
    session: () =>
      ({
        id: "workflow-session",
        harness: "pi",
        agentType: "developer",
      }) as never,
    beginCard: async (input) => {
      began += 1;
      assert.equal(input.args.draft, true);
      created = { ...CARD, draft: true };
      return { status: "created", cardId: created.id, summary: "created" };
    },
    provider: async () =>
      ({
        kind: "github",
        refChecks: async () => ({ state: "success", checks: [] }),
      }) as unknown as GitHostingProvider,
  });
  const outcome = await operation.execute(context(CI_OBSERVATION_OPERATION_ID));
  assert.equal(outcome.status, "completed");
  const retried = await operation.execute(context(CI_OBSERVATION_OPERATION_ID));
  assert.equal(retried.status, "completed");
  assert.equal(began, 1);
});

const PRIOR_HEAD = "d".repeat(40);
const FOREIGN_HEAD = "f".repeat(40);

/** A completed commit-sync predecessor recording one prior pushed head. */
function commitSyncPredecessor(headCommit: string): WorkflowStepRow {
  return {
    id: 40,
    runId: RUN.id,
    kind: "host-operation",
    payload: {
      operation: "commit-sync",
      idempotencyKey: `wf${RUN.id}:commit-sync:39`,
    },
    status: "completed",
    result: {
      status: "completed",
      summary: "committed",
      contractId: "commit-sync-result",
      payload: { baseCommit: "e".repeat(40), headCommit },
      submittedAt: 1,
    },
    attempt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

test("a rejected early push over this run's own prior head recovers with an exact lease", async () => {
  const draftCard: PullRequestCard = { ...CARD, draft: true };
  const leases: (string | undefined)[] = [];
  const operation = createCiObservationOperation({
    ...inspection(),
    push: async (options) => {
      leases.push(options.explicitLease?.expectedRemoteOid);
      if (!options.explicitLease)
        return {
          status: "failed",
          forced: false,
          setUpstream: false,
          output: "",
          error: "non-fast-forward",
        };
      // The push seam accepts an explicit lease only in the managed shape:
      // derived remote plus branch/HEAD/cleanliness preconditions, no branch.
      assert.equal(options.branch, undefined);
      assert.equal(options.remote, "origin");
      assert.equal(options.expectedBranch, WORKTREE.branch);
      assert.equal(options.expectedHead, REVIEWED);
      assert.equal(options.requireClean, true);
      return {
        status: "pushed",
        forced: true,
        setUpstream: false,
        output: "forced update",
      };
    },
    remoteBranch: async () => ({ remote: "origin", oid: PRIOR_HEAD }),
    cards: () => [draftCard],
    card: () => draftCard,
    provider: async () =>
      ({
        kind: "github",
        refChecks: async () => ({ state: "success", checks: [] }),
      }) as unknown as GitHostingProvider,
  });
  const outcome = await operation.execute({
    ...context(CI_OBSERVATION_OPERATION_ID),
    predecessors: [commitSyncPredecessor(PRIOR_HEAD)],
  });
  assert.equal(outcome.status, "completed");
  // One ordinary push, then exactly one overwrite leased on the recorded head.
  assert.deepEqual(leases, [undefined, PRIOR_HEAD]);
});

test("a rejected early push refuses to overwrite a remote tip the run never recorded", async () => {
  let leasePushes = 0;
  const operation = createCiObservationOperation({
    ...inspection(),
    push: async (options) => {
      if (options.explicitLease) leasePushes += 1;
      return {
        status: "failed",
        forced: false,
        setUpstream: false,
        output: "",
        error: "non-fast-forward",
      };
    },
    remoteBranch: async () => ({ remote: "origin", oid: FOREIGN_HEAD }),
    provider: async () =>
      ({
        kind: "github",
        refChecks: async () => ({ state: "success", checks: [] }),
      }) as unknown as GitHostingProvider,
  });
  const outcome = await operation.execute({
    ...context(CI_OBSERVATION_OPERATION_ID),
    predecessors: [commitSyncPredecessor(PRIOR_HEAD)],
  });
  assert.equal(outcome.status, "failed");
  assert.equal(leasePushes, 0);
  assert.match(outcome.summary, /never recorded/);
});

test("non-fast-forward recovery executes through the real push contract", async () => {
  const sh = (cwd: string, ...args: string[]): string =>
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
      { cwd, encoding: "utf8" },
    );
  const tmp = mkdtempSync(join(tmpdir(), "wf-push-recovery-"));
  try {
    const bare = join(tmp, "remote.git");
    const work = join(tmp, "work");
    mkdirSync(bare, { recursive: true });
    sh(bare, "init", "--bare", "-b", "main");
    execFileSync("git", ["clone", bare, work], { encoding: "utf8" });
    writeFileSync(join(work, "readme.md"), "hello\n");
    sh(work, "add", "-A");
    sh(work, "commit", "-m", "init");
    sh(work, "checkout", "-b", WORKTREE.branch);
    writeFileSync(join(work, "feature.md"), "one\n");
    sh(work, "add", "-A");
    sh(work, "commit", "-m", "one");
    sh(work, "push", "-u", "origin", WORKTREE.branch);
    const prior = sh(work, "rev-parse", "HEAD").trim();
    // The rewrite commit-sync's rebase produces: the remote still holds `prior`.
    sh(work, "commit", "--amend", "-m", "one rewritten");
    const rewritten = sh(work, "rev-parse", "HEAD").trim();

    const draftCard: PullRequestCard = { ...CARD, draft: true };
    const operation = createCiObservationOperation({
      // Real push, remoteBranch, and local git inspection; only the worktree
      // row, cards, and provider are test doubles.
      worktree: () => ({ ...WORKTREE, path: work }),
      cards: () => [draftCard],
      card: () => draftCard,
      provider: async () =>
        ({
          kind: "github",
          refChecks: async () => ({ state: "success", checks: [] }),
        }) as unknown as GitHostingProvider,
    });
    const base = context(CI_OBSERVATION_OPERATION_ID);
    const outcome = await operation.execute({
      ...base,
      step: {
        ...base.step,
        payload: {
          ...(base.step.payload as object),
          reviewedHeadCommit: rewritten,
        },
      },
      predecessors: [commitSyncPredecessor(prior)],
    });
    assert.equal(outcome.status, "completed", outcome.summary);
    assert.equal(
      sh(bare, "rev-parse", `refs/heads/${WORKTREE.branch}`).trim(),
      rewritten,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a rejected early push with the remote already at the observed head proceeds", async () => {
  const draftCard: PullRequestCard = { ...CARD, draft: true };
  let pushes = 0;
  const operation = createCiObservationOperation({
    ...inspection(),
    push: async () => {
      pushes += 1;
      return {
        status: "failed",
        forced: false,
        setUpstream: false,
        output: "",
        error: "remote ref update refused",
      };
    },
    remoteBranch: async () => ({ remote: "origin", oid: REVIEWED }),
    cards: () => [draftCard],
    card: () => draftCard,
    provider: async () =>
      ({
        kind: "github",
        refChecks: async () => ({ state: "success", checks: [] }),
      }) as unknown as GitHostingProvider,
  });
  const outcome = await operation.execute(context(CI_OBSERVATION_OPERATION_ID));
  assert.equal(outcome.status, "completed");
  assert.equal(pushes, 1, "no overwrite is attempted for an up-to-date remote");
});

const CARD: PullRequestCard = {
  renderKind: "pullRequest",
  id: "pr-live",
  sessionId: "implementer-session",
  status: "open",
  provider: "github",
  number: 12,
  url: "https://github.test/acme/repo/pull/12",
  title: "Task-371",
  headBranch: WORKTREE.branch,
  baseBranch: WORKTREE.baseBranch,
  warnings: [],
  worktreeId: WORKTREE.id,
  createdAt: 1,
  updatedAt: 1,
};

function provider(headSha: string): GitHostingProvider {
  return {
    kind: "github",
    pullRequestDetail: async () => ({
      number: 12,
      state: "open",
      merged: false,
      mergeable: true,
      draft: false,
      headSha,
      headBranch: WORKTREE.branch,
      baseBranch: WORKTREE.baseBranch,
    }),
  } as unknown as GitHostingProvider;
}

test("publication composes with an existing live PR card and verifies remote exact-head evidence", async () => {
  let began = false;
  let observedHeadSha: string | undefined;
  const operation = createPublishPullRequestOperation({
    ...inspection(),
    push: async () => ({
      status: "up-to-date",
      forced: false,
      setUpstream: false,
      output: "",
    }),
    cards: () => [CARD],
    card: () => CARD,
    beginCard: async () => {
      began = true;
      throw new Error("must not duplicate the live card");
    },
    provider: async () => provider(REVIEWED),
    updateCard: (_id, patch, contextPatch) => {
      observedHeadSha = contextPatch?.observedHeadSha;
      return applyPatch(CARD, patch);
    },
  });
  const outcome = await operation.execute(
    context(PUBLISH_PULL_REQUEST_OPERATION_ID),
  );
  assert.equal(began, false);
  assert.equal(outcome.status, "completed");
  assert.equal(observedHeadSha, REVIEWED);
  assert.deepEqual(outcome.payload, {
    outcome: "published",
    reviewedHeadCommit: REVIEWED,
    cardId: CARD.id,
    sessionId: CARD.sessionId,
    provider: "github",
    number: 12,
    url: CARD.url,
  });
});

test("delivery marks the existing draft card ready without creating another PR", async () => {
  let began = 0;
  let readied = 0;
  let draft: PullRequestCard = { ...CARD, draft: true };
  const hosted = provider(REVIEWED);
  hosted.markPullRequestReady = async () => {
    readied += 1;
    return { title: "Task-371" };
  };
  const operation = createPublishPullRequestOperation({
    ...inspection(),
    push: async () => ({
      status: "up-to-date",
      forced: false,
      setUpstream: false,
      output: "",
    }),
    cards: () => [draft],
    card: () => draft,
    beginCard: async () => {
      began += 1;
      throw new Error("must not create a second card");
    },
    provider: async () => hosted,
    updateCard: (_id, patch) => (draft = applyPatch(draft, patch)),
  });
  const outcome = await operation.execute(
    context(PUBLISH_PULL_REQUEST_OPERATION_ID),
  );
  assert.equal(outcome.status, "completed");
  const retried = await operation.execute(
    context(PUBLISH_PULL_REQUEST_OPERATION_ID),
  );
  assert.equal(retried.status, "completed");
  assert.equal(began, 0);
  assert.equal(readied, 1);
});

// A draft's mergeability is not an answer — Forgejo reports every WIP pull
// request as not mergeable — and the observation wait consumes this card half a
// second after publication. So the value is re-read AFTER the un-draft, and
// never carried over as a conflict (Task 535).
test("publication re-reads mergeability after marking the PR ready", async () => {
  let draft: PullRequestCard = {
    ...CARD,
    draft: true,
    mergeable: null,
    conflicts: true,
  };
  let readied = false;
  const polled: string[] = [];
  const hosted = provider(REVIEWED);
  hosted.markPullRequestReady = async () => {
    readied = true;
    return { title: "Task-371" };
  };
  hosted.pullRequestDetail = async () => ({
    number: 12,
    state: "open",
    merged: false,
    // The draft-era read cannot answer it; the post-publish one can.
    mergeable: readied ? true : null,
    draft: !readied,
    headSha: REVIEWED,
    headBranch: WORKTREE.branch,
    baseBranch: WORKTREE.baseBranch,
  });
  const operation = createPublishPullRequestOperation({
    ...inspection(),
    push: async () => ({
      status: "up-to-date",
      forced: false,
      setUpstream: false,
      output: "",
    }),
    cards: () => [draft],
    card: () => draft,
    provider: async () => hosted,
    updateCard: (_id, patch) => (draft = applyPatch(draft, patch)),
    schedulePoll: (cardId) => polled.push(cardId),
  });

  const outcome = await operation.execute(
    context(PUBLISH_PULL_REQUEST_OPERATION_ID),
  );

  assert.equal(outcome.status, "completed");
  assert.equal(draft.draft, undefined);
  assert.equal(draft.mergeable, true);
  assert.equal(draft.conflicts, undefined);
  assert.deepEqual(polled, [CARD.id]);
});

// A watcher poll that began while the PR was still a draft must not land after
// publication: it would restore `draft: true` and the draft-era mergeability
// over the fresh ones, and reschedule the card on the slow cadence with the run
// parked on that stale state.
test("publication invalidates a poll that began while the PR was a draft", async () => {
  resetPullRequestCardsStoreForTests();
  const card = createPullRequestCard(
    {
      sessionId: "implementer-session",
      status: "open",
      title: "WIP: Task-371",
      headBranch: WORKTREE.branch,
      baseBranch: WORKTREE.baseBranch,
      provider: "github",
      number: 12,
      ...(CARD.url !== undefined ? { url: CARD.url } : {}),
      worktreeId: WORKTREE.id,
      draft: true,
    },
    {
      repoRoot: WORKTREE.path,
      sessionKind: "developer",
      sessionId: "implementer-session",
      headBranch: WORKTREE.branch,
      baseBranch: WORKTREE.baseBranch,
      draft: true,
      // This is the previous watcher snapshot that publication must replace
      // before its exact-head wait is armed.
      observedHeadSha: MOVED,
    },
  );
  // The draft-era poll: its generation is reserved BEFORE publication runs.
  const draftEraPoll = beginPullRequestCardObservation(card.id);
  let readied = false;
  const hosted = provider(REVIEWED);
  hosted.markPullRequestReady = async () => {
    readied = true;
    return { title: "Task-371" };
  };
  hosted.pullRequestDetail = async () => ({
    number: 12,
    state: "open",
    merged: false,
    mergeable: readied ? true : null,
    draft: !readied,
    headSha: REVIEWED,
    headBranch: WORKTREE.branch,
    baseBranch: WORKTREE.baseBranch,
  });
  const operation = createPublishPullRequestOperation({
    ...inspection(),
    push: async () => ({
      status: "up-to-date",
      forced: false,
      setUpstream: false,
      output: "",
    }),
    provider: async () => hosted,
    schedulePoll: () => undefined,
  });

  const outcome = await operation.execute(
    context(PUBLISH_PULL_REQUEST_OPERATION_ID),
  );
  assert.equal(outcome.status, "completed");

  const landed = patchPullRequestCardObservation(
    card.id,
    draftEraPoll,
    { draft: true, mergeable: false, conflicts: true },
    { observedHeadSha: REVIEWED },
  );

  assert.equal(landed, undefined, "the draft-era poll is a superseded episode");
  const published = pullRequestCardById(card.id);
  assert.equal(published?.draft, undefined);
  assert.equal(published?.mergeable, true);
  assert.equal(published?.conflicts, undefined);
  assert.equal(
    pullRequestCardRecord(card.id)?.context.observedHeadSha,
    REVIEWED,
  );
  resetPullRequestCardsStoreForTests();
});

test("publication blocks when the remote PR head is not the reviewed commit", async () => {
  const operation = createPublishPullRequestOperation({
    ...inspection(),
    push: async () => ({
      status: "pushed",
      forced: false,
      setUpstream: true,
      output: "pushed",
    }),
    cards: () => [CARD],
    card: () => CARD,
    provider: async () => provider(MOVED),
  });
  const outcome = await operation.execute(
    context(PUBLISH_PULL_REQUEST_OPERATION_ID),
  );
  assert.equal(outcome.status, "blocked");
  assert.match(outcome.summary, /does not equal reviewed head/);
  assert.equal(outcome.payload, undefined);
});
