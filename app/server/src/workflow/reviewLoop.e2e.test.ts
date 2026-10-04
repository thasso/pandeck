/**
 * The Phase-1 review loop end to end ([Task-369](pa://task/369)).
 * Run it with:
 *   pnpm --filter @assistant/server test src/workflow/reviewLoop.e2e.test.ts
 *
 * Everything durable is REAL here: the SQLite store, the engine, the recipe,
 * the agent executor (with fake session drivers), the `session_submit_result`
 * tool, and the commit-sync operation over real git repositories. Only the
 * model seams are scripted — the test plays the implementer and reviewer by
 * answering their assignment prompts with worktree edits and structured
 * results, exactly the surface a live session has.
 *
 * What must hold (the step-6 contract and the doc's foundation invariants):
 * implement → commit/sync → review loops on `revise` bounded by the iteration
 * limit against the SAME role sessions; an assessment applies only to the head
 * commit it names, so a workspace change the reviewer OBSERVES (a new head at
 * verification time) forces a new range and a new assessment; a restart
 * mid-loop reconciles and continues; history stays append-only; every outcome
 * enters through a submitted result, never through transcript inference.
 *
 * Deliberately NOT claimed here: a change landing only AFTER an exact-head
 * pass. No assessment can name it, and the pure recipe never inspects the
 * worktree — the step-8 delivery gate (clean tree, HEAD equal to the reviewed
 * commit) is what refuses to ship it ([Task-371](pa://task/371)).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, test, vi } from "vitest";
import type { WorkflowActor, WorkflowJsonValue } from "@assistant/shared";
import type {
  CommitWorkflowOptions,
  CommitWorkflowResult,
} from "../commitWorkflow.ts";
import type { WorktreeRow } from "../db/worktreeStore.ts";
import type { WorkflowStepRow } from "../db/workflowStore.ts";
import type { RuntimePromptDriver } from "../session/runtimePrompt.ts";
import type { WorkflowAgentExecutorDeps } from "./agentExecutor.ts";

const testRoot = mkdtempSync(join(tmpdir(), "workflow-review-loop-e2e-"));
process.env.ASSISTANT_CWD = testRoot;
process.env.DATA_DIR = join(testRoot, "data");

const store = await import("../db/workflowStore.ts");
const worktrees = await import("../db/worktreeStore.ts");
const { createTask } = await import("../tasks.ts");
const engine = await import("./engine.ts");
const executors = await import("./executors.ts");
const contracts = await import("./resultContracts.ts");
const recipe = await import("./codeDeliveryRecipe.ts");
const agentExecutor = await import("./agentExecutor.ts");
const { workflowRunCardOf } = await import("./cardProjection.ts");
const {
  createBaseSyncOperation,
  createCommitOnlyOperation,
  createCommitSyncOperation,
} = await import("./commitSyncOperation.ts");
const { createDeliveryGateOperation } = await import("./deliveryOperations.ts");
const commitWorkflow = await import("../commitWorkflow.ts");
const { sessionSubmitResultTools } =
  await import("../tools/workflow/sessionSubmitResultTool.ts");
const { worktreeReviewTools: workshopReviewTools } =
  await import("../tools/workshop/worktreeReviewTools.ts");
const { closeDb } = await import("../db/index.ts");
const { createSession } = await import("../harnesses/create.ts");
const { piStore } = await import("../piSdk/piStore.ts");

afterAll(() => {
  closeDb();
  rmSync(testRoot, { recursive: true, force: true });
});

const USER: WorkflowActor = { kind: "user", id: "e2e" };
const SYSTEM: WorkflowActor = { kind: "system" };
const tool = sessionSubmitResultTools()[0]!;

beforeEach(() => {
  store.resetWorkflowStoreForTests();
  engine.resetWorkflowEngineForTests();
  executors.resetWorkflowExecutorsForTests();
});

/* ------------------------------- the test rig ------------------------------ */

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=e2e@example.com", "-c", "user.name=E2E", ...args],
    { cwd, encoding: "utf8" },
  );
}

interface Assignment {
  sessionId: string;
  text: string;
}

interface Rig {
  runId: number;
  worktreeId: string;
  feature: string;
  creationBase: string;
  /** The one runtime every role of this rig runs on. */
  roleConfig: WorkflowJsonValue;
  prompts: Assignment[];
  /** Install fresh executor instances, as server startup does after a boot. */
  registerExecutors(): void;
}

let rigCount = 0;

function makeRig(
  options: {
    maxIterations?: number;
    withVerdict?: boolean;
    maxReviewPasses?: number;
  } = {},
): Rig {
  rigCount += 1;
  const projectId = `project-e2e-${rigCount}`;
  const branch = `wf-run-${rigCount}`;
  const root = join(testRoot, `rig-${rigCount}`);
  const remote = join(root, "remote.git");
  const main = join(root, "main");
  const feature = join(root, "feature");
  mkdirSync(remote, { recursive: true });
  sh(remote, "init", "--bare", "-b", "main");
  mkdirSync(main);
  sh(main, "init", "-b", "main");
  writeFileSync(join(main, "base.txt"), "base\n");
  sh(main, "add", "-A");
  sh(main, "commit", "-m", "base");
  sh(main, "remote", "add", "origin", remote);
  sh(main, "push", "-u", "origin", "main");
  sh(main, "worktree", "add", "-b", branch, feature);
  const creationBase = sh(main, "rev-parse", "HEAD").trim();

  const worktreeId = `wt-e2e-${rigCount}`;
  const now = Date.now();
  worktrees.insertWorktree({
    id: worktreeId,
    projectId,
    mainRepoRoot: main,
    path: feature,
    branch,
    baseBranch: "main",
    baseCommit: creationBase,
    status: "active",
    mergeStateJson: null,
    createdAt: now,
    updatedAt: now,
    removedAt: null,
  });
  // The main checkout is the synthetic `main:<projectId>` record, never a DB
  // row; the rig resolves it directly instead of through Project registration.
  const mainRow: WorktreeRow = {
    id: `main:${projectId}`,
    projectId,
    mainRepoRoot: main,
    path: main,
    branch: "main",
    baseBranch: "main",
    baseCommit: creationBase,
    status: "active",
    mergeStateJson: null,
    createdAt: now,
    updatedAt: now,
    removedAt: null,
  };

  const task = createTask({
    title: `Review loop e2e ${rigCount}`,
    description: "Implement and review the feature end to end.",
    projectId,
    source: { createdBy: "user" },
  });
  const roleConfig: WorkflowJsonValue = {
    provider: "openai-codex",
    modelId: "gpt-test",
    thinkingLevel: "medium",
    credentialProfileId: "pi-profile",
    family: "gpt",
  };
  const run = store.createRun({
    taskId: Number(task.id),
    projectId,
    recipeId: recipe.CODE_DELIVERY_RECIPE_ID,
    recipeVersion: recipe.CODE_DELIVERY_RECIPE_VERSION,
    maxIterations: options.maxIterations ?? 2,
    // A fix moves the head, so a run that fixes anything needs a second pass to
    // buy fresh eyes on what would actually ship.
    maxReviewPasses: options.maxReviewPasses ?? 2,
    config: {
      coordinator: roleConfig,
      roles: {
        implementer: [roleConfig],
        reviewer: [roleConfig],
        fixer: [],
        verdict: options.withVerdict ? [roleConfig] : [],
      },
    },
    actor: USER,
  });
  store.attachRunWorktree(run.id, { worktreeId, branch }, SYSTEM);

  const prompts: Assignment[] = [];
  const available = new Set<string>();
  let nextSession = 0;
  const driver = (id: string): RuntimePromptDriver => {
    available.add(id);
    return {
      id,
      key: id,
      sessionId: id,
      harness: "pi",
      agentType: "developer",
      sessionFile: `/sessions/${id}.jsonl`,
      isRunning: false,
      canSteer: true,
      contextInfo: () => ({}),
      broadcastState() {},
      createRuntimeAdapter: () => {
        throw new Error("unused e2e adapter");
      },
    } as unknown as RuntimePromptDriver;
  };
  const deps: WorkflowAgentExecutorDeps = {
    newSessionId: () => `claude-${rigCount}-${++nextSession}`,
    acquireById: async (id) => (available.has(id) ? driver(id) : undefined),
    findPiModel: async (_profile, provider, id) => ({ provider, id }) as never,
    // The real creation sequence over a pi stand-in.
    create: async (spec) => {
      if (spec.harness !== "pi")
        throw new Error("the e2e rig runs pi sessions only");
      vi.spyOn(piStore, "acquireNew").mockResolvedValueOnce({
        ...driver(`sess-${rigCount}-${++nextSession}`),
        sessionMode: "build",
        rename() {},
      } as never);
      return createSession(spec);
    },
    prompt: async (live, text) => {
      if (text.includes('contract "work-plan"')) {
        await submit(live.sessionId, "completed", "simple", {
          complexity: "low",
          implementer: roleConfig,
          reviewer: roleConfig,
          ...(options.withVerdict ? { verdict: roleConfig } : {}),
          rationale: "small change",
        });
        return;
      }
      prompts.push({ sessionId: live.sessionId, text });
    },
    broadcastSessions() {},
    // The rig's sessions are never mid-turn, so no assignment ever queues.
    isSessionBusy: () => false,
    now: Date.now,
    sleep: async () => {},
    deliveryStopped: () => false,
  };

  const commit = async (
    commitOptions: CommitWorkflowOptions,
  ): Promise<CommitWorkflowResult> => {
    // A deterministic stand-in for the AI commit workflow: same observable
    // contract — commit what is there, or report the exact no-changes result
    // the operation treats as a retry-safe observation.
    const cwd = commitOptions.cwd;
    assert.ok(cwd, "the operation always names the run worktree");
    const base: CommitWorkflowResult = {
      status: "committed",
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
      createdAt: Date.now(),
    };
    if (!sh(cwd, "status", "--porcelain=v1").trim())
      return {
        ...base,
        status: "blocked",
        blockers: [
          {
            kind: "unclear",
            reason: commitWorkflow.NO_CHANGES_TO_COMMIT_REASON,
          },
        ],
      };
    sh(cwd, "add", "-A");
    sh(cwd, "commit", "-m", "workflow change");
    return base;
  };

  return {
    runId: run.id,
    worktreeId,
    feature,
    roleConfig,
    creationBase,
    prompts,
    registerExecutors() {
      executors.registerWorkflowAgentExecutor(
        agentExecutor.createWorkflowAgentExecutor(deps),
      );
      const gitOperations = {
        mainWorktree: async () => mainRow,
        commit,
      };
      executors.registerWorkflowHostOperation(
        createCommitSyncOperation(gitOperations),
      );
      executors.registerWorkflowHostOperation(
        createCommitOnlyOperation(gitOperations),
      );
      executors.registerWorkflowHostOperation(
        createBaseSyncOperation(gitOperations),
      );
      executors.registerWorkflowHostOperation(createDeliveryGateOperation());
      executors.registerWorkflowHostOperation({
        id: recipe.PUBLISH_PULL_REQUEST_OPERATION_ID,
        recoveryPolicy: "retry-safe",
        execute: async ({ step }) => ({
          status: "completed",
          summary: "published",
          contractId: contracts.PUBLISH_PULL_REQUEST_RESULT_CONTRACT_ID,
          payload: {
            outcome: "published",
            reviewedHeadCommit: String(
              (step.payload as Record<string, string>).reviewedHeadCommit,
            ),
            cardId: `pr-${rigCount}`,
            sessionId: `sess-${rigCount}`,
            provider: "github",
            number: rigCount,
            url: `https://example.test/pull/${rigCount}`,
          },
        }),
      });
      executors.registerWorkflowWaitExecutor({
        id: "fake-pr-observer",
        supports: (step) => step.kind === "wait",
        dispatch: async () => undefined,
      });
    },
  };
}

/* --------------------------------- helpers --------------------------------- */

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`did not settle: ${what}`);
}

/** The next assignment prompt a role session received. */
async function nextAssignment(rig: Rig): Promise<Assignment> {
  await waitFor(() => rig.prompts.length > 0, "an assignment prompt");
  return rig.prompts.shift()!;
}

/** What a live session does when it finishes: the real submit tool. */
async function submit(
  sessionId: string,
  status: "completed" | "blocked" | "failed",
  summary: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  await tool.execute({ status, summary, ...(payload ? { payload } : {}) }, {
    toolCallId: "e2e-call",
    session: { sessionId, harness: "pi", agentType: "developer" },
  } as never);
}

function head(rig: Rig): string {
  return sh(rig.feature, "rev-parse", "HEAD").trim();
}

/** The exact review range a commit/checkpoint step recorded. */
function rangeOf(step: WorkflowStepRow): unknown {
  const payload = step.result?.payload as Record<string, unknown> | undefined;
  return payload
    ? { baseCommit: payload.baseCommit, headCommit: payload.headCommit }
    : payload;
}

function changesOf(step: WorkflowStepRow): unknown {
  return (step.result?.payload as Record<string, unknown> | undefined)?.changes;
}

function steps(rig: Rig): WorkflowStepRow[] {
  return store
    .listSteps(rig.runId)
    .filter((step) => recipe.phaseOf(step) !== "plan");
}

function lifecycle(rig: Rig): { lifecycle: string; reason?: string } {
  const run = store.getRun(rig.runId)!;
  return {
    lifecycle: run.lifecycle,
    ...(run.lifecycleReason ? { reason: run.lifecycleReason } : {}),
  };
}

async function waitingForPullRequest(rig: Rig): Promise<void> {
  await waitFor(() => {
    const last = steps(rig).at(-1);
    return last?.kind === "wait" && last.status === "running";
  }, "durable pull request observation");
  assert.equal(lifecycle(rig).lifecycle, "active");
}

/* ----------------------------------- tests --------------------------------- */

test("the loop iterates through a restart and re-reviews exactly what changed", async () => {
  const rig = makeRig({ maxIterations: 2 });
  rig.registerExecutors();
  await engine.advanceRun(rig.runId, USER);

  // Round one: the implementer works in the run worktree and submits.
  const implement = await nextAssignment(rig);
  assert.match(implement.text, /implement the attached Task/);
  writeFileSync(join(rig.feature, "feature.txt"), "v1\n");
  await submit(implement.sessionId, "completed", "implemented", {
    notes: "v1",
  });

  // The real commit-sync ran inside that advance: the review assignment names
  // the exact range git now shows, and the worktree ended clean.
  const review1 = await nextAssignment(rig);
  assert.notEqual(
    review1.sessionId,
    implement.sessionId,
    "review is an independent session",
  );
  const head1 = head(rig);
  let history = steps(rig);
  assert.equal(history.length, 3);
  assert.deepEqual(rangeOf(history[1]!), {
    baseCommit: rig.creationBase,
    headCommit: head1,
  });
  // The range carries what it CONTAINS too: the pure recipe cannot look at a
  // diff, so this is the only evidence the coordinator's decision can weigh.
  assert.deepEqual(changesOf(history[1]!), {
    filesChanged: 1,
    insertions: 1,
    deletions: 0,
    files: [{ path: "feature.txt", insertions: 1, deletions: 0 }],
    commitSubjects: ["workflow change"],
  });
  assert.match(
    review1.text,
    new RegExp(`${rig.creationBase}\\.\\.${head1}`),
    "the prompt carries the persisted range, not prose",
  );
  assert.equal(sh(rig.feature, "status", "--porcelain=v1").trim(), "");
  const settled = structuredClone(history.slice(0, 2));

  // The server restarts while the review is out. The turn died with the
  // process — nobody is left to submit that result — so reconciliation fails
  // the step and pauses with evidence rather than waiting forever, and the
  // user's Retry re-issues the same assignment into the same session.
  engine.resetWorkflowEngineForTests();
  executors.resetWorkflowExecutorsForTests();
  rig.registerExecutors();
  await engine.reconcileWorkflowRunsOnBoot();
  assert.equal(rig.prompts.length, 0, "no assignment is handed out twice");
  const abandoned = store.getStep(history[2]!.id)!;
  assert.equal(abandoned.status, "failed");
  assert.equal(lifecycle(rig).lifecycle, "paused");

  await engine.retryRun(rig.runId, USER);
  const resumedReview = await nextAssignment(rig);
  assert.equal(
    resumedReview.sessionId,
    review1.sessionId,
    "the same reviewer, its pass unchanged",
  );
  assert.deepEqual(lifecycle(rig), { lifecycle: "active" });
  assert.ok(
    store
      .listEvents(rig.runId)
      .some(
        (event) =>
          event.type === "step-completed" || event.type === "run-paused",
      ),
  );

  // The adopted reviewer submits `revise`; rework goes to the SAME implementer
  // session carrying the findings and the commit they apply to.
  await submit(resumedReview.sessionId, "completed", "revise", {
    verdict: "revise",
    headCommit: head1,
    findings: [{ severity: "major", text: "tighten the copy" }],
  });
  const rework = await nextAssignment(rig);
  assert.equal(rework.sessionId, implement.sessionId, "implementer reused");
  assert.match(rework.text, /tighten the copy/);
  assert.match(rework.text, new RegExp(head1));

  // The workspace change forces a NEW commit range, and the fix goes back to
  // the reviewer that raised the finding — its own session, asked about its own
  // findings rather than about the change as a whole.
  writeFileSync(join(rig.feature, "feature.txt"), "v2\n");
  await submit(rework.sessionId, "completed", "revised", { notes: "v2" });
  const reCheck = await nextAssignment(rig);
  assert.equal(reCheck.sessionId, review1.sessionId, "reviewer reused");
  assert.match(reCheck.text, /these are YOUR findings/);
  const head2 = head(rig);
  assert.notEqual(head2, head1, "a new range for the changed workspace");
  const reCheckStep = steps(rig).at(-1)!;
  assert.equal(
    (reCheckStep.payload as Record<string, unknown>).objective,
    "re-check",
  );
  assert.deepEqual(
    (reCheckStep.payload as Record<string, unknown>).commitRange,
    { baseCommit: rig.creationBase, headCommit: head2 },
  );

  // A cleared re-check settles the findings, not the head: what would ship is
  // a commit no fresh eyes have read, so the run buys the second pass.
  await submit(reCheck.sessionId, "completed", "resolved", {
    verdict: "pass",
    headCommit: head2,
    findings: [],
  });
  const review2 = await nextAssignment(rig);
  assert.notEqual(
    review2.sessionId,
    review1.sessionId,
    "fresh eyes, fresh session",
  );
  assert.match(review2.text, /Review pass 2 of at most 2/);
  assert.match(review2.text, new RegExp(`${rig.creationBase}\\.\\.${head2}`));

  await submit(review2.sessionId, "completed", "pass", {
    verdict: "pass",
    headCommit: head2,
    findings: [],
  });
  await waitingForPullRequest(rig);

  // Foundation invariants over the whole run: an append-only chain of exactly
  // two rounds, earlier terminal rows byte-identical to their snapshots, and
  // every agent outcome carried by a submitted, contract-validated result.
  history = steps(rig);
  assert.deepEqual(
    history.map((step) => [step.kind, step.status]),
    [
      ["agent", "completed"], // implement
      ["host-operation", "completed"], // commit-sync
      ["agent", "failed"], // discovery review, pass 1 — its turn died at restart
      ["agent", "completed"], // the same assignment, re-issued by Retry
      ["agent", "completed"], // fix
      ["host-operation", "completed"], // commit only
      ["agent", "completed"], // re-check by the author
      ["host-operation", "completed"], // post-lineage base sync
      ["agent", "completed"], // discovery review, pass 2
      ["host-operation", "completed"], // delivery freshness base sync
      ["host-operation", "completed"], // delivery gate
      ["host-operation", "completed"], // publish
      ["wait", "running"],
    ],
  );
  assert.deepEqual(history.slice(0, 2), settled, "history is append-only");
  for (let index = 1; index < history.length; index += 1)
    assert.ok(history[index]!.id > history[index - 1]!.id);
  for (const step of history) {
    if (step.kind !== "agent") continue;
    const result = step.result!;
    // The one exception is the step the restart abandoned: nobody submitted it,
    // and the run says so rather than inventing an outcome for it.
    if (result.status === "failed") {
      assert.equal(step.status, "failed");
      continue;
    }
    assert.ok(result.submittedAt, "the outcome was submitted, never inferred");
    assert.ok(
      result.contractId === contracts.IMPLEMENTATION_RESULT_CONTRACT_ID ||
        result.contractId === contracts.ASSESSMENT_CONTRACT_ID,
    );
  }
}, 60_000);

test("the review exchange survives the round trip in both directions", async () => {
  const rig = makeRig({ maxIterations: 2 });
  rig.registerExecutors();
  await engine.advanceRun(rig.runId, USER);

  const implement = await nextAssignment(rig);
  writeFileSync(join(rig.feature, "feature.txt"), "v1\n");
  await submit(implement.sessionId, "completed", "first cut", { notes: "v1" });

  // Outbound: what the implementer said reaches the reviewer's assignment.
  const review1 = await nextAssignment(rig);
  assert.match(review1.text, /The implementer reports on this range/);
  assert.match(review1.text, /first cut/);

  // "Accepted, but here are some small things" is refused while the reviewer
  // can still correct it — the verdict that used to drop its own findings.
  await assert.rejects(
    submit(review1.sessionId, "completed", "good with nits", {
      verdict: "pass",
      headCommit: head(rig),
      findings: [{ severity: "major", text: "tighten the copy" }],
    }),
    /empty when the verdict is "pass"/,
  );
  assert.equal(steps(rig).at(-1)!.status, "running");

  await submit(review1.sessionId, "completed", "close, but the copy is off", {
    verdict: "revise",
    headCommit: head(rig),
    findings: [{ severity: "major", text: "tighten the copy" }],
    observations: ["the helper name reads oddly"],
  });

  // Inbound: the implementer sees the reviewer's summary, findings, and the
  // remarks it explicitly did not require.
  const rework = await nextAssignment(rig);
  assert.match(rework.text, /close, but the copy is off/);
  assert.match(rework.text, /tighten the copy/);
  assert.match(rework.text, /the helper name reads oddly/);

  writeFileSync(join(rig.feature, "feature.txt"), "v2\n");
  await submit(rework.sessionId, "completed", "answered the review", {
    notes: "v2",
    responses: [
      { finding: "tighten the copy", response: "reworded the banner" },
    ],
  });

  // And the answer comes back to the reviewer as something it must resolve.
  const review2 = await nextAssignment(rig);
  assert.match(review2.text, /finding: tighten the copy/);
  assert.match(review2.text, /answer: reworded the banner/);
  assert.match(review2.text, /Resolve each answer explicitly/);

  await submit(review2.sessionId, "completed", "answers accepted", {
    verdict: "pass",
    headCommit: head(rig),
    findings: [],
    observations: ["worth a follow-up task"],
  });

  // The author accepted its own findings as answered; the fixed head still
  // needs fresh eyes before it can ship.
  const pass2 = await nextAssignment(rig);
  await submit(pass2.sessionId, "completed", "accepted", {
    verdict: "pass",
    headCommit: head(rig),
    findings: [],
    observations: ["worth a follow-up task"],
  });
  await waitingForPullRequest(rig);

  // The accepted run still carries the reviewer's words to the user's card.
  const card = workflowRunCardOf(
    store.getRun(rig.runId)!,
    store.listSteps(rig.runId),
  );
  assert.equal(card.latestAssessment?.summary, "accepted");
  assert.deepEqual(card.latestAssessment?.observations, [
    "worth a follow-up task",
  ]);
  assert.deepEqual(
    card.reviewerSessions?.map((review) => review.pass),
    [1, 2],
  );
}, 60_000);

test("iteration-limit exhaustion asks the user instead of stopping", async () => {
  const rig = makeRig({ maxIterations: 1 });
  rig.registerExecutors();
  await engine.advanceRun(rig.runId, USER);

  const implement = await nextAssignment(rig);
  writeFileSync(join(rig.feature, "feature.txt"), "v1\n");
  await submit(implement.sessionId, "completed", "implemented", {});
  const review1 = await nextAssignment(rig);
  await submit(review1.sessionId, "completed", "revise", {
    verdict: "revise",
    headCommit: head(rig),
    findings: [{ severity: "major", text: "needs work" }],
  });

  const rework = await nextAssignment(rig);
  writeFileSync(join(rig.feature, "feature.txt"), "v2\n");
  await submit(rework.sessionId, "completed", "revised", {});
  const review2 = await nextAssignment(rig);
  await submit(review2.sessionId, "completed", "still not there", {
    verdict: "revise",
    headCommit: head(rig),
    findings: [{ severity: "major", text: "still not there" }],
  });

  // The run asks instead of stopping: raise the ceiling, take the work as it
  // stands, or cancel.
  await waitFor(() => {
    const tail = steps(rig).at(-1);
    return tail?.kind === "user-decision";
  }, "the ceiling gate");
  const gate = steps(rig).at(-1)!.payload as Record<string, unknown>;
  assert.equal(gate.decision, "raise-ceilings");
  assert.equal(gate.blocked, "iterations");
  assert.deepEqual(gate.allowedChoices, ["raise", "deliver", "cancel"]);
  assert.equal(steps(rig).length, 7, "no third round was admitted");
}, 60_000);

test("review findings become a durable set the fixer answers and its author re-checks", async () => {
  const rig = makeRig({ maxIterations: 2, withVerdict: true });
  rig.registerExecutors();
  await engine.advanceRun(rig.runId, USER);

  const implement = await nextAssignment(rig);
  writeFileSync(join(rig.feature, "feature.txt"), "alpha\nbeta\ngamma\n");
  await submit(implement.sessionId, "completed", "implemented", {
    notes: "v1",
  });

  const review = await nextAssignment(rig);
  assert.match(
    review.text,
    /Anchor each finding with the path and 1-based line/,
    "the reviewer is told its submission is what publishes the threads",
  );
  const reviewedHead = head(rig);

  // The server restarts while the review is out. The dead turn cannot submit,
  // so the run pauses and Retry re-issues the review into the same session;
  // publication then happens on the submission after that.
  engine.resetWorkflowEngineForTests();
  executors.resetWorkflowExecutorsForTests();
  rig.registerExecutors();
  await engine.reconcileWorkflowRunsOnBoot();
  assert.equal(lifecycle(rig).lifecycle, "paused");
  await engine.retryRun(rig.runId, USER);
  const reissued = await nextAssignment(rig);
  assert.equal(reissued.sessionId, review.sessionId);

  await submit(reissued.sessionId, "completed", "two real problems", {
    verdict: "revise",
    headCommit: reviewedHead,
    findings: [
      {
        severity: "major",
        text: "alpha is not validated",
        path: "feature.txt",
        line: 1,
      },
      {
        severity: "minor",
        text: "beta reads oddly",
        path: "feature.txt",
        line: 2,
      },
      { severity: "nit", text: "the branch name is long" },
    ],
  });

  // One set, closed with the verdict and the reviewer's own summary, with a
  // thread per anchored finding.
  const sets = worktrees.listReviewSets(rig.worktreeId);
  assert.equal(sets.length, 1);
  const set = sets[0]!;
  assert.equal(set.verdict, "request-changes");
  assert.equal(set.summary, "two real problems");
  assert.equal(set.blind, false);
  assert.equal(set.authorSessionId, review.sessionId);
  const threads = worktrees
    .listComments(rig.worktreeId)
    .filter((comment) => !comment.parentId);
  assert.deepEqual(
    threads.map((thread) => [thread.body, thread.severity, thread.anchorLine]),
    [
      ["alpha is not validated", "major", 1],
      ["beta reads oddly", "minor", 2],
    ],
  );

  // The fixer's assignment carries the set once, with the claims framing.
  const fix = await nextAssignment(rig);
  assert.equal(fix.sessionId, implement.sessionId, "the implementer fixes");
  assert.match(fix.text, /## Review comments/);
  assert.match(fix.text, new RegExp(`comment id: ${threads[0]!.id}`));
  assert.match(fix.text, /feature\.txt:1/);
  assert.equal(fix.text.split("Findings are claims, not orders").length - 1, 1);
  assert.equal(fix.text.split("alpha is not validated").length - 1, 1);
  assert.match(
    fix.text,
    /- \[nit\] the branch name is long/,
    "a finding with no anchor has no thread, so it is listed inline",
  );

  // The fixer answers through the real review tools: one fixed and resolved,
  // one argued and deliberately left open.
  const toolCtx = {
    toolCallId: "e2e-review-tool",
    session: {
      sessionId: fix.sessionId,
      harness: "pi",
      agentType: "developer",
    },
  } as never;
  const reviewTools = new Map(
    workshopReviewTools.map((entry) => [entry.name, entry]),
  );
  await reviewTools
    .get("review_comment_reply")!
    .execute(
      { commentId: threads[0]!.id, text: "fixed: alpha is validated now" },
      toolCtx,
    );
  await reviewTools
    .get("review_comment_resolve")!
    .execute({ commentId: threads[0]!.id, resolved: true }, toolCtx);
  await reviewTools
    .get("review_comment_reply")!
    .execute(
      { commentId: threads[1]!.id, text: "rejected: beta matches the caller" },
      toolCtx,
    );

  writeFileSync(join(rig.feature, "feature.txt"), "alpha!\nbeta\ngamma\n");
  await submit(fix.sessionId, "completed", "one fixed, one argued", {
    notes: "answered both on their threads",
    responses: [
      { finding: "beta reads oddly", response: "rejected: matches the caller" },
    ],
  });

  // The findings go back to the author that wrote them, in its own session,
  // consuming the thread state rather than the fixer's account of it.
  const reCheck = await nextAssignment(rig);
  assert.equal(reCheck.sessionId, review.sessionId, "its author re-checks");
  assert.match(reCheck.text, /these are YOUR findings/);
  assert.match(
    reCheck.text,
    /- \[major\] feature\.txt:1 — alpha is not validated\n {2}answered: resolved/,
  );
  assert.match(
    reCheck.text,
    /- \[minor\] feature\.txt:2 — beta reads oddly\n {2}answered: disputed — rejected: beta matches the caller/,
  );
  assert.match(reCheck.text, /judge a dispute on its argument/);

  const rollup = {
    id: set.id,
    findingCount: 2,
    resolvedCount: 1,
    disputedCount: 1,
    openCount: 0,
  };
  assert.deepEqual(
    workflowRunCardOf(store.getRun(rig.runId)!, steps(rig)).reviewSet,
    rollup,
  );

  await submit(reCheck.sessionId, "completed", "the dispute holds", {
    verdict: "pass",
    headCommit: head(rig),
    findings: [],
  });

  // A re-check settles the threads it opened rather than opening a second set
  // beside them: one conversation per finding, raised and answered in place.
  assert.deepEqual(
    worktrees.listReviewSets(rig.worktreeId).map((entry) => entry.verdict),
    ["request-changes"],
  );

  // And the card follows that settlement. The author restated neither finding,
  // so it accepted both — the fix AND the dispute — and nothing is left
  // "answered and open" once the only party entitled to judge the answer has.
  const settledRollup = {
    id: set.id,
    findingCount: 2,
    resolvedCount: 2,
    disputedCount: 0,
    openCount: 0,
  };
  assert.deepEqual(
    workflowRunCardOf(store.getRun(rig.runId)!, steps(rig)).reviewSet,
    settledRollup,
  );
  assert.deepEqual(
    worktrees
      .listComments(rig.worktreeId)
      .filter((comment) => !comment.parentId)
      .map((comment) => comment.resolvedAt !== null),
    [true, true],
    "the counts describe the threads' own state",
  );

  // Fresh eyes on the fixed head, and only then the verdict's last word.
  const pass2 = await nextAssignment(rig);
  assert.notEqual(pass2.sessionId, review.sessionId, "a new pass, new session");
  await submit(pass2.sessionId, "completed", "reads well now", {
    verdict: "pass",
    headCommit: head(rig),
    findings: [],
  });

  // Delivery goes through the coordinator, which names the verdict runtime.
  const deliverDecision = await nextAssignment(rig);
  assert.match(deliverDecision.text, /decide what happens now/);
  await submit(deliverDecision.sessionId, "completed", "ship it", {
    decision: "deliver",
    verdict: rig.roleConfig,
    rationale: "both passes agree",
  });

  const verdict = await nextAssignment(rig);
  assert.match(verdict.text, /judge whether the fix round resolved/);
  await submit(verdict.sessionId, "completed", "resolution holds", {
    verdict: "pass",
    headCommit: head(rig),
    findings: [],
  });
  await waitingForPullRequest(rig);
  // The later passes published their own approving sets beside the reviewer's —
  // and the card still reports the discovery set the fix round answered, which
  // those empty approving sets must not displace on the finished run.
  assert.deepEqual(
    worktrees.listReviewSets(rig.worktreeId).map((entry) => entry.verdict),
    ["request-changes", "approve", "approve"],
  );
  assert.deepEqual(
    workflowRunCardOf(store.getRun(rig.runId)!, steps(rig)).reviewSet,
    settledRollup,
  );
}, 60_000);
