/**
 * The code-delivery recipe's decision function ([Task-365](pa://task/365)).
 * Run it with:
 *   pnpm --filter @assistant/server test src/workflow/codeDeliveryRecipe.test.ts
 *
 * Pure in, pure out: synthetic step histories and the decision each must
 * produce. No database and no engine — if this file ever needs either, the
 * decision function has stopped being pure and crash recovery has stopped being
 * safe with it.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ASSESSMENT_FINDINGS_MAX_CHARS,
  ASSESSMENT_FINDINGS_MAX_COUNT,
  WORKFLOW_PAYLOAD_MAX_CHARS,
  type ReviewFinding,
  type WorkflowJsonValue,
  type WorkflowStepStatus,
  applyPatch,
  type Patch,
} from "@assistant/shared";
import type { WorkflowRunRow, WorkflowStepRow } from "../db/workflowStore.ts";
import { TRUNCATION_MARKER } from "../textBudget.ts";
import { RESOLUTION_RESPONSE_MAX_CHARS } from "./reviewSets.ts";
import {
  CODE_DELIVERY_PAYLOAD_MAX_CHARS,
  CODE_DELIVERY_RECIPE_ID,
  CODE_DELIVERY_RECIPE_VERSION,
  BASE_SYNC_OPERATION_ID,
  baseSyncIdempotencyKey,
  CI_OBSERVATION_OPERATION_ID,
  COMMIT_ONLY_OPERATION_ID,
  COMMIT_SYNC_OPERATION_ID,
  commitOnlyIdempotencyKey,
  commitSyncIdempotencyKey,
  decideNextStep as decideRecipeNextStep,
  findingResolutionsOf,
  fixerSessionKey,
  isOmittedItemMarker,
  operationIdempotencyKey,
  phaseOf,
  spentOperationTriageOf,
  type WorkflowDecision,
} from "./codeDeliveryRecipe.ts";
import {
  ASSESSMENT_CONTRACT_ID,
  CI_OBSERVATION_RESULT_CONTRACT_ID,
  COMMIT_SYNC_RESULT_CONTRACT_ID,
  DELIVERY_GATE_RESULT_CONTRACT_ID,
  IMPLEMENTATION_RESULT_CONTRACT_ID,
  PUBLISH_PULL_REQUEST_RESULT_CONTRACT_ID,
  PULL_REQUEST_OBSERVATION_RESULT_CONTRACT_ID,
  REVIEW_DECISION_CONTRACT_ID,
  WORK_PLAN_CONTRACT_ID,
  getResultContract,
  type AssessmentVerdict,
} from "./resultContracts.ts";

/* --------------------------------- fixtures -------------------------------- */

const RUN_ID = 7;
const TEST_MODEL = {
  provider: "openai-codex",
  modelId: "gpt-test",
  thinkingLevel: "medium",
  credentialProfileId: "test-profile",
  family: "gpt",
} as const;
const ROLE_SETS = {
  implementer: [TEST_MODEL],
  reviewer: [TEST_MODEL],
  fixer: [],
  verdict: [],
};
const CLAUDE_MODEL = {
  ...TEST_MODEL,
  provider: "claude-sdk",
  modelId: "claude-test",
  credentialProfileId: "claude-profile",
  family: "claude",
} as const;

function run(overrides: Patch<WorkflowRunRow> = {}): WorkflowRunRow {
  return applyPatch(
    {
      id: RUN_ID,
      taskId: 365,
      recipeId: CODE_DELIVERY_RECIPE_ID,
      recipeVersion: CODE_DELIVERY_RECIPE_VERSION,
      worktreeId: "wt-1",
      branch: "t365-workflow-engine",
      lifecycle: "active",
      maxIterations: 2,
      maxReviewPasses: 1,
      config: { coordinator: TEST_MODEL, roles: ROLE_SETS },
      createdAt: 1,
      updatedAt: 1,
    },
    overrides,
  );
}

let nextStepId = 100;

function step(
  partial: Pick<WorkflowStepRow, "kind" | "payload"> & {
    status?: WorkflowStepStatus;
    contractId?: string;
    resultPayload?: WorkflowJsonValue;
    summary?: string;
    predecessorId?: number;
  },
): WorkflowStepRow {
  const status = partial.status ?? "completed";
  const id = (nextStepId += 1);
  return {
    id,
    runId: RUN_ID,
    kind: partial.kind,
    payload: partial.payload,
    status,
    attempt: 1,
    ...(partial.predecessorId !== undefined
      ? { predecessorId: partial.predecessorId }
      : {}),
    ...(partial.contractId
      ? {
          result: {
            status: "completed" as const,
            summary: partial.summary ?? "done",
            contractId: partial.contractId,
            ...(partial.resultPayload !== undefined
              ? { payload: partial.resultPayload }
              : {}),
            submittedAt: 2,
          },
        }
      : {}),
    createdAt: 1,
    updatedAt: 2,
  };
}

function planned(
  options: {
    model?: {
      provider: string;
      modelId: string;
      thinkingLevel: "medium";
      credentialProfileId: string;
      family: string;
    };
    maxReviewPasses?: number;
  } = {},
): WorkflowStepRow {
  const model = options.model ?? TEST_MODEL;
  return step({
    kind: "agent",
    payload: {
      role: "coordinator",
      objective: "plan",
      roles: ROLE_SETS,
      maxReviewPasses: options.maxReviewPasses ?? 1,
      resultContract: WORK_PLAN_CONTRACT_ID,
    },
    contractId: WORK_PLAN_CONTRACT_ID,
    resultPayload: {
      complexity: "low",
      implementer: model,
      reviewer: model,
      rationale: "small change",
    },
  });
}

/** A completed review-decision step for the range the fixtures use. */
function decided(
  decision: "deliver" | "review-again",
  options: {
    completedReviewPass?: number;
    reviewer?: Record<string, string>;
    focus?: string[];
  } = {},
): WorkflowStepRow {
  return step({
    kind: "agent",
    payload: {
      role: "coordinator",
      objective: "review-decision",
      roles: ROLE_SETS,
      commitRange: { baseCommit: "aaa", headCommit: "bbb" },
      completedReviewPass: options.completedReviewPass ?? 1,
      maxReviewPasses: 2,
      resultContract: REVIEW_DECISION_CONTRACT_ID,
    },
    contractId: REVIEW_DECISION_CONTRACT_ID,
    resultPayload: {
      decision,
      ...(options.reviewer ? { reviewer: options.reviewer } : {}),
      ...(options.focus ? { focus: options.focus } : {}),
      rationale: "judged from the evidence",
    },
  });
}

/** The one automatic triage assignment a reproduced operation failure earns. */
function triage(
  failed: WorkflowStepRow,
  options: {
    predecessorId?: number;
    status?: WorkflowStepStatus;
    attempts?: number;
    undelivered?: boolean;
  } = {},
): WorkflowStepRow {
  const payload = failed.payload as Record<string, WorkflowJsonValue>;
  const row = step({
    kind: "agent",
    payload: {
      role: "implementer",
      objective: "triage-operation",
      failedOperation: {
        operation: payload.operation!,
        phase: phaseOf(failed)!,
        stepId: failed.id,
        status: failed.status as "failed" | "blocked",
        summary: failed.result?.summary ?? "",
        attempts: options.attempts ?? 2,
        idempotencyKey: payload.idempotencyKey!,
      },
      resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
    },
    status: options.status ?? "completed",
    ...(options.status === undefined || options.status === "completed"
      ? { contractId: IMPLEMENTATION_RESULT_CONTRACT_ID, resultPayload: {} }
      : {}),
    ...(options.predecessorId !== undefined
      ? { predecessorId: options.predecessorId }
      : {}),
  });
  return options.undelivered
    ? {
        ...row,
        result: {
          status: "failed" as const,
          summary: "prompt refused",
          payload: { assignmentUndelivered: true },
          submittedAt: 2,
        },
      }
    : row;
}

function decideNextStep(
  value: WorkflowRunRow,
  steps: WorkflowStepRow[],
): WorkflowDecision {
  return decideRecipeNextStep(
    value,
    steps.length > 0 ? [planned(), ...steps] : steps,
  );
}

function appendedPayload(decision: WorkflowDecision): WorkflowJsonValue {
  assert.equal(decision.kind, "append");
  return (decision as Extract<WorkflowDecision, { kind: "append" }>).step
    .payload;
}

function carriesTruncationMarker(value: WorkflowJsonValue): boolean {
  if (typeof value === "string") return value.includes(TRUNCATION_MARKER);
  if (Array.isArray(value)) return value.some(carriesTruncationMarker);
  if (typeof value === "object" && value !== null)
    return Object.values(value).some(carriesTruncationMarker);
  return false;
}

/** The user-decision gate an exhausted ceiling reaches instead of stopping. */
function assertCeilingGate(
  decision: WorkflowDecision,
  blocked: "review-passes" | "iterations",
): Record<string, WorkflowJsonValue> {
  const payload = appendedPayload(decision) as Record<
    string,
    WorkflowJsonValue
  >;
  assert.equal(payload.decision, "raise-ceilings");
  assert.equal(payload.blocked, blocked);
  assert.deepEqual(payload.allowedChoices, ["raise", "deliver", "cancel"]);
  return payload;
}

function assertAppendableRecipePayload(payload: WorkflowJsonValue): void {
  const size = JSON.stringify(payload).length;
  assert.ok(size <= CODE_DELIVERY_PAYLOAD_MAX_CHARS, String(size));
  assert.ok(size < WORKFLOW_PAYLOAD_MAX_CHARS, String(size));
}

function implemented(
  notes = "built it",
  responses?: { finding: string; response: string }[],
): WorkflowStepRow {
  return step({
    kind: "agent",
    payload: {
      role: "implementer",
      objective: "implement",
      resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
    },
    contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
    resultPayload: { notes, ...(responses ? { responses } : {}) },
  });
}

function committed(baseCommit = "aaa", headCommit = "bbb"): WorkflowStepRow {
  return step({
    kind: "host-operation",
    payload: { operation: "commit-sync", idempotencyKey: "wf7:commit-sync:1" },
    contractId: COMMIT_SYNC_RESULT_CONTRACT_ID,
    resultPayload: { operation: "commit-sync", baseCommit, headCommit },
  });
}

function checkpointed(
  operation: "commit-sync" | "commit" | "base-sync",
  options: {
    baseCommit?: string;
    headCommit?: string;
    baseMoved?: boolean;
    headRewritten?: boolean;
    purpose?: "discovery" | "delivery";
  } = {},
): WorkflowStepRow {
  const baseCommit = options.baseCommit ?? "aaa";
  const headCommit = options.headCommit ?? "bbb";
  return step({
    kind: "host-operation",
    payload: {
      operation,
      idempotencyKey: `wf${RUN_ID}:${operation}:1`,
      ...(options.purpose ? { purpose: options.purpose } : {}),
    },
    contractId: COMMIT_SYNC_RESULT_CONTRACT_ID,
    resultPayload: {
      operation,
      previousBaseCommit: "aaa",
      baseCommit,
      previousHeadCommit: "bbb",
      headCommit,
      baseMoved: options.baseMoved ?? false,
      headRewritten: options.headRewritten ?? false,
    },
  });
}

function observedCi(
  outcome: "green" | "red" | "none" | "timeout",
  headCommit = "bbb",
): WorkflowStepRow {
  return step({
    kind: "host-operation",
    payload: {
      operation: CI_OBSERVATION_OPERATION_ID,
      idempotencyKey: `wf7:${CI_OBSERVATION_OPERATION_ID}:1`,
      reviewedHeadCommit: headCommit,
    },
    contractId: CI_OBSERVATION_RESULT_CONTRACT_ID,
    resultPayload: {
      outcome,
      headCommit,
      checks:
        outcome === "red"
          ? [
              {
                name: "typecheck",
                status: "failure",
                excerpt: "TS2322 at app/server/src/x.ts:1",
              },
            ]
          : [],
      ...(outcome === "none" || outcome === "timeout"
        ? { reason: `CI ${outcome}` }
        : {}),
    },
  });
}

function reviewed(
  verdict: AssessmentVerdict,
  options: {
    headCommit?: string;
    findings?: (ReviewFinding | string)[];
    observations?: string[];
    summary?: string;
    reviewPass?: number;
  } = {},
): WorkflowStepRow {
  return step({
    kind: "agent",
    payload: {
      role: "reviewer",
      objective: "review",
      commitRange: { baseCommit: "aaa", headCommit: "bbb" },
      ...(options.reviewPass ? { reviewPass: options.reviewPass } : {}),
      resultContract: ASSESSMENT_CONTRACT_ID,
    },
    contractId: ASSESSMENT_CONTRACT_ID,
    resultPayload: {
      verdict,
      headCommit: options.headCommit ?? "bbb",
      // Verdict and findings must agree or the assessment is not valid
      // evidence, so a revise fixture always carries one.
      findings: (
        options.findings ?? (verdict === "revise" ? ["rework it"] : [])
      ).map((finding) =>
        typeof finding === "string"
          ? { severity: "major" as const, text: finding }
          : finding,
      ),
      ...(options.observations ? { observations: options.observations } : {}),
    },
    ...(options.summary ? { summary: options.summary } : {}),
  });
}

function delivered(
  operation: "delivery-gate" | "publish-pull-request",
  contractId: string,
  resultPayload: WorkflowJsonValue,
): WorkflowStepRow {
  return step({
    kind: "host-operation",
    payload: {
      operation,
      idempotencyKey: `wf7:${operation}:1`,
      reviewedHeadCommit: "bbb",
    },
    contractId,
    resultPayload,
  });
}

/** A passing review recorded as pass `pass` of a run capped at `cap`. */
function passAt(pass: number, cap: number): WorkflowStepRow {
  const reviewStep = reviewed("pass");
  reviewStep.payload = {
    ...(reviewStep.payload as Record<string, WorkflowJsonValue>),
    reviewPass: pass,
    maxReviewPasses: cap,
  };
  return reviewStep;
}

/** One full implement → commit/sync → review round ending in `verdict`. */
function round(
  verdict: AssessmentVerdict,
  options: {
    findings?: (ReviewFinding | string)[];
    observations?: string[];
    summary?: string;
  } = {},
): WorkflowStepRow[] {
  return [implemented(), committed(), reviewed(verdict, options)];
}

/* --------------------------------- the walk -------------------------------- */

test("an unprovisioned run still admits the worktree-free coordinator first", () => {
  const decision = decideNextStep(run({ worktreeId: undefined }), []);
  assert.equal(decision.kind, "append");
  assert.equal(
    (decision as Extract<WorkflowDecision, { kind: "append" }>).step.kind,
    "agent",
  );
});

test("recipe v19 admits the coordinator with its bounded authority", () => {
  assert.equal(CODE_DELIVERY_RECIPE_VERSION, 19);
  const decision = decideNextStep(run(), []);
  assert.equal(decision.kind, "append");
  assert.deepEqual(
    (decision as Extract<WorkflowDecision, { kind: "append" }>).step.payload,
    {
      role: "coordinator",
      objective: "plan",
      roles: ROLE_SETS,
      maxReviewPasses: 1,
      resultContract: WORK_PLAN_CONTRACT_ID,
    },
  );
});

test("a valid work plan materializes implementation and rejects authority expansion", () => {
  const accepted = planned();
  assert.deepEqual(decideRecipeNextStep(run(), [accepted]), {
    kind: "append",
    step: {
      kind: "agent",
      payload: {
        role: "implementer",
        objective: "implement",
        resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
      },
      predecessorId: accepted.id,
    },
  });

  const outside = planned({
    model: { ...TEST_MODEL, modelId: "not-allowed" },
  });
  const refused = decideRecipeNextStep(run(), [outside]);
  assert.equal(refused.kind, "pause");
  assert.match(
    (refused as Extract<WorkflowDecision, { kind: "pause" }>).reason,
    /role sets/,
  );
});

test("plan choices are accepted only from their own role sets", () => {
  const configured = run({
    config: {
      coordinator: TEST_MODEL,
      roles: {
        implementer: [TEST_MODEL],
        reviewer: [CLAUDE_MODEL],
        fixer: [],
        verdict: [],
      },
    },
  });
  const valid = planned();
  valid.result!.payload = {
    complexity: "low",
    implementer: TEST_MODEL,
    reviewer: CLAUDE_MODEL,
    rationale: "cross-family review",
  };
  assert.equal(decideRecipeNextStep(configured, [valid]).kind, "append");

  const swapped = planned();
  swapped.result!.payload = {
    complexity: "low",
    implementer: TEST_MODEL,
    reviewer: TEST_MODEL,
    rationale: "wrong role set",
  };
  const refused = decideRecipeNextStep(configured, [swapped]);
  assert.equal(refused.kind, "pause");
  assert.match((refused as { reason: string }).reason, /role sets/);
});

test("operator notes are evidence, not part of role configuration identity", () => {
  const notedImplementer = { ...TEST_MODEL, notes: "Fast on fix rounds" };
  const notedReviewer = { ...CLAUDE_MODEL, notes: "Strong discovery recall" };
  const configured = run({
    maxReviewPasses: 2,
    config: {
      coordinator: TEST_MODEL,
      roles: {
        implementer: [notedImplementer],
        reviewer: [notedReviewer],
        fixer: [],
        verdict: [],
      },
    },
  });
  const plan = planned();
  plan.result!.payload = {
    complexity: "low",
    implementer: TEST_MODEL,
    reviewer: CLAUDE_MODEL,
    rationale: "notes need not be echoed",
  };
  assert.equal(decideRecipeNextStep(configured, [plan]).kind, "append");

  const decision = decided("review-again", { reviewer: CLAUDE_MODEL });
  const next = decideRecipeNextStep(configured, [
    plan,
    implemented(),
    committed(),
    passAt(1, 2),
    decision,
  ]);
  assert.equal(next.kind, "append");
  assert.equal(
    (appendedPayload(next) as Record<string, WorkflowJsonValue>).role,
    "reviewer",
  );
});

test("a passing review reaches the coordinator's decision with the range's evidence", () => {
  const configured = run({ maxReviewPasses: 2 });
  const commit = committed();
  commit.result = {
    ...commit.result!,
    payload: {
      baseCommit: "aaa",
      headCommit: "bbb",
      changes: {
        filesChanged: 1,
        insertions: 4,
        deletions: 2,
        files: [{ path: "a.ts", insertions: 4, deletions: 2 }],
        commitSubjects: ["do the thing"],
      },
    },
  };
  const first = passAt(1, 2);
  const history = [planned(), implemented(), commit, first];
  const decision = decideRecipeNextStep(configured, history);
  assert.equal(decision.kind, "append");
  const step = (decision as Extract<WorkflowDecision, { kind: "append" }>).step;
  assert.equal(step.predecessorId, first.id);
  assert.deepEqual(step.payload, {
    role: "coordinator",
    objective: "review-decision",
    question: "deliver-or-review",
    roles: { reviewer: [TEST_MODEL], verdict: [] },
    implementer: TEST_MODEL,
    commitRange: { baseCommit: "aaa", headCommit: "bbb" },
    assessmentStepId: first.id,
    completedReviewPass: 1,
    maxReviewPasses: 2,
    remainingIterations: 2,
    priorReviewers: [TEST_MODEL],
    reviewSummary: "done",
    changes: {
      filesChanged: 1,
      insertions: 4,
      deletions: 2,
      files: [{ path: "a.ts", insertions: 4, deletions: 2 }],
      commitSubjects: ["do the thing"],
    },
    implementerReport: { summary: "done", notes: "built it" },
    resultContract: REVIEW_DECISION_CONTRACT_ID,
  });
});

test("run-39-sized evidence produces an appendable review decision", () => {
  const commit = committed();
  commit.result = {
    ...commit.result!,
    payload: {
      baseCommit: "aaa",
      headCommit: "bbb",
      changes: {
        filesChanged: 12,
        insertions: 120,
        deletions: 30,
        files: Array.from({ length: 12 }, (_, index) => ({
          path: `${String(index)}-${"p".repeat(175)}`,
          insertions: 10,
          deletions: 2,
        })),
        commitSubjects: ["the run 39 revision"],
      },
    },
  };
  const report = implemented(
    "n".repeat(500),
    Array.from({ length: 6 }, (_, index) => ({
      finding: `finding ${String(index)} ${"f".repeat(180)}`,
      response: "r".repeat(1_250),
    })),
  );
  const review = passAt(1, 2);
  review.result = {
    ...review.result!,
    summary: "s".repeat(2_500),
    payload: {
      verdict: "pass",
      headCommit: "bbb",
      findings: [],
      observations: Array.from({ length: 4 }, () => "o".repeat(625)),
    },
  };

  const payload = appendedPayload(
    decideRecipeNextStep(run({ maxReviewPasses: 2 }), [
      planned(),
      report,
      commit,
      review,
    ]),
  );
  assertAppendableRecipePayload(payload);
  assert.ok(carriesTruncationMarker(payload));
  const record = payload as Record<string, WorkflowJsonValue>;
  assert.equal(record.reviewSummary, "s".repeat(2_500));
  assert.deepEqual(
    record.observations,
    Array.from({ length: 4 }, () => "o".repeat(625)),
  );
  assert.ok(carriesTruncationMarker(record.implementerReport!));
});

test("every prose-composing recipe transition stays below the store bound", () => {
  const hugeReport = implemented("n".repeat(14_500), [
    { finding: "f".repeat(100), response: "r".repeat(100) },
  ]);
  hugeReport.result!.summary = "s".repeat(2_000);

  const firstReview = appendedPayload(
    decideRecipeNextStep(run(), [planned(), hugeReport, committed()]),
  );

  const revise = reviewed("revise", {
    findings: [{ severity: "major", text: "f".repeat(5_000) }],
    observations: ["o".repeat(9_000)],
    summary: "s".repeat(2_000),
  });
  const rework = appendedPayload(
    decideRecipeNextStep(run(), [planned(), hugeReport, committed(), revise]),
  );
  const reworkRecord = rework as Record<string, WorkflowJsonValue>;
  assert.deepEqual(reworkRecord.findings, [
    { severity: "major", text: "f".repeat(5_000) },
  ]);
  assert.equal(reworkRecord.reviewSummary, "s".repeat(2_000));
  assert.ok(carriesTruncationMarker(reworkRecord.observations!));

  const commit = committed();
  commit.result = {
    ...commit.result!,
    payload: {
      baseCommit: "aaa",
      headCommit: "bbb",
      changes: {
        filesChanged: 40,
        insertions: 400,
        deletions: 200,
        files: Array.from({ length: 40 }, (_, index) => ({
          path: `${String(index)}-${"p".repeat(195)}`,
          insertions: 10,
          deletions: 5,
        })),
        commitSubjects: Array.from({ length: 20 }, () => "c".repeat(200)),
      },
    },
  };
  const pass = passAt(1, 2);
  pass.result = {
    ...pass.result!,
    summary: "s".repeat(2_000),
    payload: {
      verdict: "pass",
      headCommit: "bbb",
      findings: [],
      observations: ["o".repeat(15_000)],
    },
  };
  const reviewDecision = appendedPayload(
    decideRecipeNextStep(run({ maxReviewPasses: 2 }), [
      planned(),
      hugeReport,
      commit,
      pass,
    ]),
  );
  const decisionReport = (reviewDecision as Record<string, WorkflowJsonValue>)
    .implementerReport!;
  assert.ok(
    carriesTruncationMarker(
      (decisionReport as Record<string, WorkflowJsonValue>).responses!,
    ),
  );

  const nextReviewDecision = decided("review-again", {
    focus: ["q".repeat(15_000)],
  });
  const nextReview = appendedPayload(
    decideRecipeNextStep(run({ maxReviewPasses: 2 }), [
      planned(),
      hugeReport,
      committed(),
      passAt(1, 2),
      nextReviewDecision,
    ]),
  );

  for (const payload of [firstReview, rework, reviewDecision, nextReview]) {
    assertAppendableRecipePayload(payload);
    assert.ok(carriesTruncationMarker(payload));
  }

  // FINDINGS ARE LOSSLESS. The largest assessment the contract ACCEPTS must
  // reach every successor with every finding intact and every payload under the
  // store bound — findings are the one group composition may not shrink by
  // dropping items, because a dropped one is recoverable by nothing the run can
  // do: a retry re-composes the same shortened payload, and the coordinator
  // deciding who fixes what cannot read the review threads.
  const assessmentContractAccepts = (payload: unknown): boolean =>
    getResultContract(ASSESSMENT_CONTRACT_ID)!.validate(payload);
  // The largest set the contract accepts: BOTH bounds, whichever binds first.
  const atTheBound: ReviewFinding[] = Array.from(
    { length: ASSESSMENT_FINDINGS_MAX_COUNT },
    () => ({ severity: "major" as const, text: "x".repeat(100) }),
  );
  assert.ok(
    JSON.stringify(atTheBound).length <= ASSESSMENT_FINDINGS_MAX_CHARS,
    "and inside the byte budget too",
  );
  assert.ok(
    assessmentContractAccepts({
      verdict: "revise",
      headCommit: "bbb",
      findings: atTheBound,
    }),
    "this is the largest findings array the contract accepts",
  );
  assert.equal(atTheBound.length, ASSESSMENT_FINDINGS_MAX_COUNT);

  const maximal = reviewed("revise", { findings: atTheBound });
  const history = [planned(), implemented(), committed(), maximal];
  const carried = (payload: WorkflowJsonValue): number =>
    (
      (payload as Record<string, WorkflowJsonValue>).findings as
        WorkflowJsonValue[] | undefined
    )?.filter((finding) => !isOmittedItemMarker(finding)).length ?? 0;

  // The fix round it routes to, and the re-check and verdict that follow it.
  const fix = appendedPayload(decideRecipeNextStep(run(), history));
  assertAppendableRecipePayload(fix);
  assert.equal(carried(fix), atTheBound.length, "the fixer gets all of them");

  const fixed = step({
    kind: "agent",
    payload: fix,
    contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
    resultPayload: { notes: "answered" },
  });
  const fixCommit = committed();
  fixCommit.predecessorId = fixed.id;
  const reCheck = appendedPayload(
    decideRecipeNextStep(run(), [...history, fixed, fixCommit]),
  );
  assertAppendableRecipePayload(reCheck);
  assert.equal(
    carried(reCheck),
    atTheBound.length,
    "and so does the author re-checking them",
  );

  // And the coordinator ROUTING them, which has no threads to fall back on.
  const withFixer = run({
    config: {
      coordinator: TEST_MODEL,
      roles: {
        implementer: [TEST_MODEL],
        reviewer: [TEST_MODEL],
        fixer: [CLAUDE_MODEL],
        verdict: [],
      },
    },
  });
  const routing = appendedPayload(decideRecipeNextStep(withFixer, history));
  assertAppendableRecipePayload(routing);
  assert.equal(
    carried(routing),
    atTheBound.length,
    "the coordinator routes on the whole set",
  );
});

test("a pressured fix payload drops the focus whole rather than half-rendering it", () => {
  // Focus is an INSTRUCTION. Clipped, "do not take approach X" can become its
  // own opposite, and a dropped tail can lose the constraint the fix had to
  // preserve — while the assignment still tells the fixer that what remains
  // shapes its work. Absent guidance only costs the round the coordinator's
  // reading; inverted guidance costs it the fix. So the whole key goes, and the
  // findings it must not narrow are still all there.
  const withFixer = run({
    config: {
      coordinator: TEST_MODEL,
      roles: {
        implementer: [TEST_MODEL],
        reviewer: [TEST_MODEL],
        fixer: [CLAUDE_MODEL],
        verdict: [],
      },
    },
  });
  const findings: ReviewFinding[] = Array.from(
    { length: ASSESSMENT_FINDINGS_MAX_COUNT },
    (_, index) => ({
      severity: "major" as const,
      text: `finding ${String(index)} ${"x".repeat(100)}`,
    }),
  );
  const assessment = reviewed("revise", {
    findings,
    observations: ["o".repeat(4_000)],
    summary: "s".repeat(2_000),
  });
  const history = [planned(), implemented(), committed(), assessment];
  const routing = appendedPayload(decideRecipeNextStep(withFixer, history));
  const routed = step({
    kind: "agent",
    payload: routing,
    contractId: REVIEW_DECISION_CONTRACT_ID,
    resultPayload: {
      decision: "fix",
      assignee: "fixer",
      fixer: CLAUDE_MODEL,
      focus: ["do not widen the lock: ".concat("g".repeat(15_000))],
      rationale: "a targeted correction",
    },
  });
  const fix = appendedPayload(
    decideRecipeNextStep(withFixer, [...history, routed]),
  ) as Record<string, WorkflowJsonValue>;

  assertAppendableRecipePayload(fix);
  assert.equal(
    fix.focus,
    undefined,
    "no partial instruction reaches the fixer",
  );
  assert.equal(
    (fix.findings as WorkflowJsonValue[]).filter(
      (finding) => !isOmittedItemMarker(finding),
    ).length,
    findings.length,
    "and the findings it may not narrow all survive",
  );

  // A focus that FITS is untouched by the same path, so the drop is pressure
  // and not the rule.
  const withRoomForIt = step({
    kind: "agent",
    payload: routing,
    contractId: REVIEW_DECISION_CONTRACT_ID,
    resultPayload: {
      decision: "fix",
      assignee: "fixer",
      fixer: CLAUDE_MODEL,
      focus: ["do not widen the lock"],
      rationale: "a targeted correction",
    },
  });
  assert.deepEqual(
    (
      appendedPayload(
        decideRecipeNextStep(withFixer, [...history, withRoomForIt]),
      ) as Record<string, WorkflowJsonValue>
    ).focus,
    ["do not widen the lock"],
  );
});

test("a one-pass run never spends a turn on a decision it cannot act on", () => {
  // At the cap the only allowed answer is "deliver", so the recipe skips the
  // question entirely — that is what keeps the decision free for a cap-1 run.
  const pass = passAt(1, 1);
  const freshness = checkpointed("base-sync", { purpose: "delivery" });
  const history = [planned(), implemented(), committed(), pass, freshness];
  const decision = decideRecipeNextStep(run({ maxReviewPasses: 1 }), history);
  assert.equal(decision.kind, "append");
  assert.equal(
    (
      (decision as Extract<WorkflowDecision, { kind: "append" }>).step
        .payload as Record<string, unknown>
    ).operation,
    "delivery-gate",
  );

  // One ceiling decides that now. A run whose pass cap still allows another
  // opinion IS asked, because the sessions that pass needs follow from the
  // ceiling rather than being separately rationed.
  const open = decideRecipeNextStep(run({ maxReviewPasses: 2 }), [
    planned(),
    implemented(),
    committed(),
    passAt(1, 2),
  ]);
  assert.equal(
    (appendedPayload(open) as Record<string, unknown>).objective,
    "review-decision",
  );
});

test("review-again appends the next pass with its focus and chosen reviewer", () => {
  const configured = run({ maxReviewPasses: 2 });
  const history = [planned(), implemented(), committed(), passAt(1, 2)];
  const decision = decided("review-again", {
    focus: ["the migration"],
    reviewer: { ...TEST_MODEL },
  });
  const next = decideRecipeNextStep(configured, [...history, decision]);
  assert.equal(next.kind, "append");
  assert.deepEqual(
    (next as Extract<WorkflowDecision, { kind: "append" }>).step.payload,
    {
      role: "reviewer",
      objective: "review",
      commitRange: { baseCommit: "aaa", headCommit: "bbb" },
      reviewPass: 2,
      maxReviewPasses: 2,
      focus: ["the migration"],
      reviewer: TEST_MODEL,
      implementerReport: { summary: "done", notes: "built it" },
      resultContract: ASSESSMENT_CONTRACT_ID,
    },
  );
});

test("deliver and an out-of-allowlist reviewer both deliver; a refused ask does not", () => {
  const configured = run({ maxReviewPasses: 2 });
  const history = [planned(), implemented(), committed(), passAt(1, 2)];
  const operationOf = (steps: WorkflowStepRow[]): unknown => {
    const decision = decideRecipeNextStep(configured, steps);
    assert.equal(decision.kind, "append");
    const payload = (decision as Extract<WorkflowDecision, { kind: "append" }>)
      .step.payload as Record<string, unknown>;
    if (payload.operation !== BASE_SYNC_OPERATION_ID) return payload.operation;
    const freshness = checkpointed("base-sync", { purpose: "delivery" });
    freshness.payload = payload as WorkflowJsonValue;
    freshness.predecessorId = steps[steps.length - 1]!.id;
    const afterFreshness = decideRecipeNextStep(configured, [
      ...steps,
      freshness,
    ]);
    assert.equal(afterFreshness.kind, "append");
    return (
      (afterFreshness as Extract<WorkflowDecision, { kind: "append" }>).step
        .payload as Record<string, unknown>
    ).operation;
  };
  assert.equal(operationOf([...history, decided("deliver")]), "delivery-gate");
  assert.equal(
    operationOf([
      ...history,
      decided("review-again", {
        reviewer: { ...TEST_MODEL, modelId: "not-allowed" },
      }),
    ]),
    "delivery-gate",
  );
  // But a coordinator that ASKED for another pass and was refused by the
  // ceiling is a want the run could not satisfy — the user's to answer, not
  // something to convert quietly into delivery.
  assertCeilingGate(
    decideRecipeNextStep(configured, [
      ...history,
      passAt(2, 2),
      decided("review-again", { completedReviewPass: 2 }),
    ]),
    "review-passes",
  );
});

test("early push inserts exact-head CI observation before reviewer admission", () => {
  const commit = committed("base", "head");
  const decision = decideNextStep(
    run({
      config: {
        coordinator: TEST_MODEL,
        roles: ROLE_SETS,
        earlyPush: true,
      },
    }),
    [implemented(), commit],
  );
  assert.equal(decision.kind, "append");
  assert.deepEqual(appendedPayload(decision), {
    operation: CI_OBSERVATION_OPERATION_ID,
    idempotencyKey: `wf${RUN_ID}:${CI_OBSERVATION_OPERATION_ID}:${commit.id}`,
    reviewedHeadCommit: "head",
  });
});

test("red CI skips review and sends machine-attributed findings to revise", () => {
  const commit = committed();
  const ci = observedCi("red");
  ci.predecessorId = commit.id;
  const decision = decideNextStep(
    run({
      config: {
        coordinator: TEST_MODEL,
        roles: ROLE_SETS,
        earlyPush: true,
      },
    }),
    [implemented(), commit, ci],
  );
  assert.equal(decision.kind, "append");
  const payload = appendedPayload(decision) as Record<
    string,
    WorkflowJsonValue
  >;
  assert.equal(payload.role, "implementer");
  assert.equal(payload.objective, "revise");
  assert.equal(payload.findingSource, "ci");
  assert.match(JSON.stringify(payload.findings), /TS2322/);
});

test("a green CI observation retried past failed attempts anchors to its commit/sync range", () => {
  const commit = committed();
  // Two failed attempts at the SAME reservation, the chain retryRun appends:
  // each successor carries the failed attempt's exact payload.
  const first = step({
    kind: "host-operation",
    status: "failed",
    payload: {
      operation: CI_OBSERVATION_OPERATION_ID,
      idempotencyKey: `wf7:${CI_OBSERVATION_OPERATION_ID}:1`,
      reviewedHeadCommit: "bbb",
    },
    predecessorId: commit.id,
  });
  const second = step({
    kind: "host-operation",
    status: "failed",
    payload: first.payload,
    predecessorId: first.id,
  });
  const ci = observedCi("green");
  ci.predecessorId = second.id;
  const decision = decideNextStep(
    run({
      config: { coordinator: TEST_MODEL, roles: ROLE_SETS, earlyPush: true },
    }),
    [implemented(), commit, first, second, ci],
  );
  assert.equal(decision.kind, "append");
  const payload = appendedPayload(decision) as Record<
    string,
    WorkflowJsonValue
  >;
  assert.equal(payload.role, "reviewer");
  assert.deepEqual(payload.commitRange, {
    baseCommit: "aaa",
    headCommit: "bbb",
  });
});

test("a CI observation behind another reservation's failed attempt stays unattached", () => {
  const commit = committed();
  const foreign = step({
    kind: "host-operation",
    status: "failed",
    payload: {
      operation: CI_OBSERVATION_OPERATION_ID,
      idempotencyKey: `wf7:${CI_OBSERVATION_OPERATION_ID}:999`,
      reviewedHeadCommit: "bbb",
    },
    predecessorId: commit.id,
  });
  const ci = observedCi("green");
  ci.predecessorId = foreign.id;
  const decision = decideNextStep(
    run({
      config: { coordinator: TEST_MODEL, roles: ROLE_SETS, earlyPush: true },
    }),
    [implemented(), commit, foreign, ci],
  );
  assert.equal(decision.kind, "pause");
  assert.match(
    (decision as Extract<WorkflowDecision, { kind: "pause" }>).reason,
    /not attached to its exact commit\/sync range/,
  );
});

test("none and timeout CI states proceed and stay explicit in reviewer payloads", () => {
  for (const outcome of ["none", "timeout"] as const) {
    const commit = committed();
    const ci = observedCi(outcome);
    ci.predecessorId = commit.id;
    const decision = decideNextStep(
      run({
        config: {
          coordinator: TEST_MODEL,
          roles: ROLE_SETS,
          earlyPush: true,
        },
      }),
      [implemented(), commit, ci],
    );
    assert.equal(decision.kind, "append");
    assert.equal(
      (appendedPayload(decision) as Record<string, any>).ciResults.outcome,
      outcome,
    );
  }
});

test("red CI opens a dedicated repair session instead of the implementer's", () => {
  const commit = committed();
  const ci = observedCi("red");
  ci.predecessorId = commit.id;
  const fixerSet = { ...ROLE_SETS, fixer: [CLAUDE_MODEL] };
  const payload = appendedPayload(
    decideNextStep(
      run({
        config: { coordinator: TEST_MODEL, roles: fixerSet, earlyPush: true },
      }),
      [implemented(), commit, ci],
    ),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(payload.findingSource, "ci");
  // A named failing test and a CI log do not belong in the run's most expensive
  // context: with no fix round in flight the repair gets its own session.
  assert.deepEqual(payload.fixer, CLAUDE_MODEL);
  assert.equal(payload.fixerLineage, "ci");
});

test("every machine repair in a run shares one session, distinct from any pass", () => {
  const fixerSet = { ...ROLE_SETS, fixer: [CLAUDE_MODEL] };
  const configured = run({
    config: { coordinator: TEST_MODEL, roles: fixerSet, earlyPush: true },
    maxIterations: 8,
  });
  const history: WorkflowStepRow[] = [implemented()];
  const keys: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const commit = committed();
    const ci = observedCi("red");
    ci.predecessorId = commit.id;
    const repair = step({
      kind: "agent",
      payload: appendedPayload(
        decideNextStep(configured, [...history, commit, ci]),
      ),
      contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
      resultPayload: { notes: "green again" },
    });
    keys.push(fixerSessionKey(repair));
    history.push(commit, ci, repair);
  }
  assert.equal(keys[0], keys[1], "the run keeps ONE machine-repair session");
  // It must be a real fixer session, not the implementer fallback the old
  // routing gave both of these rounds — which was also equal to itself.
  assert.match(keys[0]!, /^fixer:ci:/);
  assert.doesNotMatch(keys[0]!, /:implementer$/);
  assert.notEqual(
    keys[0],
    // The SAME runtime answering a reviewer's findings: the only key that
    // could actually collide, and the one a numeric stand-in never tests.
    fixerSessionKey(
      step({
        kind: "agent",
        payload: {
          role: "implementer",
          objective: "revise",
          fixer: CLAUDE_MODEL,
          fixerLineage: "pass-1",
        },
      }),
    ),
    "and it can never collide with a reviewer lineage on the same runtime",
  );
});

test("a settled fixer does not inherit a later base-sync's red check", () => {
  const fixerSet = { ...ROLE_SETS, fixer: [CLAUDE_MODEL, TEST_MODEL] };
  const configured = run({
    config: { coordinator: TEST_MODEL, roles: fixerSet, earlyPush: true },
    maxIterations: 8,
  });
  // Pass 1's fixer finished, its work went green, and its conversation closed.
  const settled = step({
    kind: "agent",
    payload: {
      role: "implementer",
      objective: "revise",
      fixer: TEST_MODEL,
      fixerLineage: "pass-1",
      resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
    },
    contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
    resultPayload: { notes: "fixed" },
  });
  const fixCommit = committed();
  fixCommit.predecessorId = settled.id;
  const green = observedCi("green");
  green.predecessorId = fixCommit.id;
  // Main moved; the run re-based onto it and THAT is what failed. The newest
  // fix round in the list is still pass-1's, but it did not cause this.
  const moved = checkpointed("base-sync", { baseMoved: true });
  moved.predecessorId = green.id;
  const red = observedCi("red");
  red.predecessorId = moved.id;

  const payload = appendedPayload(
    decideNextStep(configured, [
      implemented(),
      settled,
      fixCommit,
      green,
      moved,
      red,
    ]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(payload.findingSource, "ci");
  assert.deepEqual(
    payload.fixer,
    CLAUDE_MODEL,
    "an unrelated failure goes to the run's machine-repair session",
  );
  assert.equal(
    payload.fixerLineage,
    "ci",
    "and never into a reviewer conversation whose findings are closed",
  );
});

test("a fix round already in flight answers the red check it caused", () => {
  const fixerSet = { ...ROLE_SETS, fixer: [CLAUDE_MODEL, TEST_MODEL] };
  const configured = run({
    config: { coordinator: TEST_MODEL, roles: fixerSet, earlyPush: true },
    maxIterations: 8,
  });
  // The SECOND candidate is mid-conversation: its session holds the round CI
  // just judged, so the repair continues there rather than opening a third.
  const inFlight = step({
    kind: "agent",
    payload: {
      role: "implementer",
      objective: "revise",
      fixer: TEST_MODEL,
      fixerLineage: "pass-1",
    },
    contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
    resultPayload: { notes: "fixed" },
  });
  const commit = committed();
  commit.predecessorId = inFlight.id;
  const ci = observedCi("red");
  ci.predecessorId = commit.id;
  const payload = appendedPayload(
    decideNextStep(configured, [implemented(), inFlight, commit, ci]),
  ) as Record<string, WorkflowJsonValue>;
  assert.deepEqual(payload.fixer, TEST_MODEL);
  assert.equal(payload.fixerLineage, "pass-1");
});

test("with no fixer set the implementer stays the only answer to red CI", () => {
  const commit = committed();
  const ci = observedCi("red");
  ci.predecessorId = commit.id;
  const payload = appendedPayload(
    decideNextStep(
      run({
        config: { coordinator: TEST_MODEL, roles: ROLE_SETS, earlyPush: true },
      }),
      [implemented(), commit, ci],
    ),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(payload.fixer, undefined);
  assert.equal(payload.fixerLineage, undefined);
});

test("the ceiling gate starts the raise control where the run's spend points", () => {
  // The control began at one, always — so a run needing four more rounds was
  // four interruptions granting a decision the user had already made. This is
  // a STARTING POINT: nothing about who decides, or what may be answered,
  // changes with it.
  // An iteration is a REVISE assessment, so the run's spend is built from
  // those: `rounds` of them before the one that finds the ceiling spent.
  const gateAfter = (rounds: number) => {
    const history: WorkflowStepRow[] = [implemented()];
    for (let index = 0; index <= rounds; index += 1)
      history.push(committed(), reviewed("revise", { findings: ["again"] }));
    return assertCeilingGate(
      decideNextStep(run({ maxIterations: rounds }), history),
      "iterations",
    );
  };
  // Never below two: one is the value that made a run ask repeatedly.
  assert.equal(gateAfter(1).suggestedRaise, 2);
  assert.equal(gateAfter(2).suggestedRaise, 2);
  // Proportional past that, so a repeat ask escalates on its own.
  assert.equal(gateAfter(8).suggestedRaise, 4);
  assert.equal(gateAfter(15).suggestedRaise, 8);
  // And capped, because the control's own range ends at ten.
  assert.equal(gateAfter(30).suggestedRaise, 10);

  // A review-pass gate measures PASSES, not fix rounds — and the two have to
  // be DIFFERENT numbers here or the assertion proves nothing. Six revise
  // assessments all at pass 1: iterations would suggest 3, passes suggest the
  // floor of 2, so reading the wrong input is visible.
  const many = run({ maxIterations: 20, maxReviewPasses: 1 });
  const history = [
    planned(),
    implemented(),
    ...Array.from({ length: 6 }, () => [
      committed(),
      reviewed("revise", { findings: [{ severity: "major", text: "race" }] }),
    ]).flat(),
  ];
  const fixed = step({
    kind: "agent",
    payload: appendedPayload(decideNextStep(many, history)),
    contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
    resultPayload: { notes: "fixed" },
  });
  const fixCommit = committed();
  fixCommit.predecessorId = fixed.id;
  const reCheck = step({
    kind: "agent",
    payload: appendedPayload(
      decideNextStep(many, [...history, fixed, fixCommit]),
    ),
    contractId: ASSESSMENT_CONTRACT_ID,
    resultPayload: { verdict: "pass", headCommit: "bbb", findings: [] },
  });
  const passGate = appendedPayload(
    decideNextStep(many, [...history, fixed, fixCommit, reCheck]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(passGate.blocked, "review-passes");
  assert.equal(
    passGate.suggestedRaise,
    2,
    "one discovery pass spent, so the floor — not the iteration count",
  );
});

test("consecutive red CI loops stop at the revision-round cap", () => {
  const history: WorkflowStepRow[] = [implemented()];
  for (let index = 0; index < 3; index += 1) {
    const commit = committed();
    const ci = observedCi("red");
    ci.predecessorId = commit.id;
    history.push(commit, ci);
  }
  const decision = decideNextStep(
    run({
      maxIterations: 2,
      config: {
        coordinator: TEST_MODEL,
        roles: ROLE_SETS,
        earlyPush: true,
      },
    }),
    history,
  );
  // Red CI spends the same ceiling as any other round, so exhausting it asks
  // the user rather than stopping the run.
  const gate = assertCeilingGate(decision, "iterations");
  assert.match(String(gate.wanted), /CI, which has failed 3 times in a row/);
});

test("the recipe walks implement → commit/sync → review", () => {
  const implement = implemented();
  const commitSync = decideNextStep(run(), [implement]);
  assert.deepEqual(commitSync, {
    kind: "append",
    step: {
      kind: "host-operation",
      payload: {
        operation: "commit-sync",
        // Derived from persisted history, never from a clock: the same history
        // re-derives the same key after a crash.
        idempotencyKey: commitSyncIdempotencyKey(RUN_ID, implement.id),
      },
      predecessorId: implement.id,
    },
  });

  const commit = committed("base1", "head1");
  assert.deepEqual(decideNextStep(run(), [implement, commit]), {
    kind: "append",
    step: {
      kind: "agent",
      payload: {
        role: "reviewer",
        objective: "review",
        commitRange: { baseCommit: "base1", headCommit: "head1" },
        reviewPass: 1,
        maxReviewPasses: 1,
        // What the implementer said about this range travels with the
        // assignment: the reviewer answers a person, not just a diff.
        implementerReport: { summary: "done", notes: "built it" },
        resultContract: ASSESSMENT_CONTRACT_ID,
      },
      predecessorId: commit.id,
    },
  });
});

test("fix rounds commit only and retain synchronization for the cleared lineage", () => {
  const fix = implemented("fixed it");
  fix.payload = {
    role: "implementer",
    objective: "revise",
    resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
  };
  assert.deepEqual(decideNextStep(run(), [fix]), {
    kind: "append",
    step: {
      kind: "host-operation",
      payload: {
        operation: COMMIT_ONLY_OPERATION_ID,
        idempotencyKey: commitOnlyIdempotencyKey(RUN_ID, fix.id),
      },
      predecessorId: fix.id,
    },
  });

  const reCheck = step({
    kind: "agent",
    payload: {
      role: "reviewer",
      objective: "re-check",
      commitRange: { baseCommit: "aaa", headCommit: "ccc" },
      resultContract: ASSESSMENT_CONTRACT_ID,
    },
    contractId: ASSESSMENT_CONTRACT_ID,
    resultPayload: { verdict: "pass", headCommit: "ccc", findings: [] },
  });
  const history = [
    checkpointed("commit-sync"),
    reviewed("revise"),
    fix,
    checkpointed("commit", { headCommit: "ccc" }),
    reCheck,
  ];
  assert.deepEqual(decideNextStep(run({ maxReviewPasses: 2 }), history), {
    kind: "append",
    step: {
      kind: "host-operation",
      payload: {
        operation: BASE_SYNC_OPERATION_ID,
        idempotencyKey: baseSyncIdempotencyKey(RUN_ID, reCheck.id),
        purpose: "discovery",
      },
      predecessorId: reCheck.id,
    },
  });
});

test("checkpoint outcomes skip redundant CI or require exact-head CI after rewrite", () => {
  const unchanged = checkpointed("base-sync", {
    headCommit: "ccc",
    purpose: "discovery",
  });
  const direct = decideNextStep(run({ maxReviewPasses: 2 }), [
    reviewed("pass"),
    unchanged,
  ]);
  const directPayload = appendedPayload(direct) as Record<
    string,
    WorkflowJsonValue
  >;
  assert.equal(directPayload.objective, "review");
  assert.equal(directPayload.reviewPass, 2);
  assert.deepEqual(directPayload.commitRange, {
    baseCommit: "aaa",
    headCommit: "ccc",
  });

  const moved = checkpointed("base-sync", {
    baseCommit: "ddd",
    headCommit: "eee",
    baseMoved: true,
    headRewritten: true,
    purpose: "discovery",
  });
  const ci = decideNextStep(
    run({
      maxReviewPasses: 2,
      config: { coordinator: TEST_MODEL, roles: ROLE_SETS, earlyPush: true },
    }),
    [reviewed("pass"), moved],
  );
  assert.equal(
    (appendedPayload(ci) as Record<string, WorkflowJsonValue>).operation,
    CI_OBSERVATION_OPERATION_ID,
  );
});

test("delivery checks base freshness and changed range identity requires discovery", () => {
  const initial = checkpointed("commit-sync");
  const pass = reviewed("pass");
  assert.deepEqual(decideNextStep(run(), [initial, pass]), {
    kind: "append",
    step: {
      kind: "host-operation",
      payload: {
        operation: BASE_SYNC_OPERATION_ID,
        idempotencyKey: baseSyncIdempotencyKey(RUN_ID, pass.id),
        purpose: "delivery",
      },
      predecessorId: pass.id,
    },
  });

  const unchanged = checkpointed("base-sync", { purpose: "delivery" });
  const gate = appendedPayload(
    decideNextStep(run(), [initial, pass, unchanged]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(gate.operation, "delivery-gate");

  const changedRange = checkpointed("base-sync", {
    baseCommit: "ddd",
    purpose: "delivery",
    baseMoved: true,
  });
  const discovery = appendedPayload(
    decideNextStep(run({ maxReviewPasses: 2 }), [initial, pass, changedRange]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(discovery.objective, "review");
  assert.deepEqual(discovery.commitRange, {
    baseCommit: "ddd",
    headCommit: "bbb",
  });
});

test("delivery freshness preserves the synchronized range for a configured verdict", () => {
  const verdict = { ...CLAUDE_MODEL, modelId: "judge" };
  const configured = run({
    config: {
      coordinator: TEST_MODEL,
      roles: { ...ROLE_SETS, verdict: [verdict] },
    },
  });
  const initial = checkpointed("commit-sync");
  const pass = reviewed("pass");
  const decision = decided("deliver");
  decision.result = {
    ...decision.result!,
    payload: { ...((decision.result?.payload ?? {}) as object), verdict },
  };
  const freshness = appendedPayload(
    decideRecipeNextStep(configured, [initial, pass, decision]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(freshness.operation, BASE_SYNC_OPERATION_ID);
  assert.deepEqual(freshness.verdict, verdict);

  const synchronized = checkpointed("base-sync", { purpose: "delivery" });
  synchronized.payload = freshness;
  synchronized.predecessorId = decision.id;
  const next = appendedPayload(
    decideRecipeNextStep(configured, [initial, pass, decision, synchronized]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(next.role, "verdict");
  assert.deepEqual(next.commitRange, {
    baseCommit: "aaa",
    headCommit: "bbb",
  });
});

test("a base-sync repair resumes its coordinator-selected routing", () => {
  const reviewer = { ...CLAUDE_MODEL, modelId: "second-reviewer" };
  const verdict = { ...CLAUDE_MODEL, modelId: "judge" };
  const conflict = checkpointed("base-sync", { purpose: "delivery" });
  conflict.payload = {
    ...(conflict.payload as Record<string, WorkflowJsonValue>),
    reviewer,
    focus: ["the lease boundary"],
    verdict,
    authorizedByUser: true,
  };
  conflict.status = "blocked";
  conflict.result = {
    ...conflict.result!,
    status: "blocked",
    payload: {
      rebaseConflict: {
        files: ["conflict.ts"],
        truncated: false,
        baseBranch: "main",
        originalHead: "a".repeat(40),
      },
    },
  };
  const repair = appendedPayload(
    decideRecipeNextStep(run(), [conflict]),
  ) as Record<string, WorkflowJsonValue>;
  const repairStep = step({
    kind: "agent",
    payload: repair,
    contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
    resultPayload: { notes: "resolved the conflict" },
  });
  repairStep.predecessorId = conflict.id;
  const resumed = appendedPayload(
    decideRecipeNextStep(run(), [conflict, repairStep]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(resumed.operation, BASE_SYNC_OPERATION_ID);
  assert.equal(resumed.purpose, "delivery");
  assert.deepEqual(resumed.reviewer, reviewer);
  assert.deepEqual(resumed.focus, ["the lease boundary"]);
  assert.deepEqual(resumed.verdict, verdict);
  assert.equal(resumed.authorizedByUser, true);
});

test("an open step is always executing, never a second admission", () => {
  const pending = step({
    kind: "agent",
    payload: { role: "implementer", objective: "implement" },
    status: "pending",
  });
  assert.deepEqual(decideNextStep(run(), [pending]), {
    kind: "executing",
    stepId: pending.id,
  });

  const running = step({
    kind: "agent",
    payload: {
      role: "reviewer",
      objective: "review",
      commitRange: { baseCommit: "a", headCommit: "b" },
    },
    status: "running",
  });
  assert.deepEqual(
    decideNextStep(run(), [implemented(), committed(), running]),
    {
      kind: "executing",
      stepId: running.id,
    },
  );
});

test("two open steps are an invariant breach, not something to average over", () => {
  const first = step({
    kind: "agent",
    payload: { role: "implementer", objective: "implement" },
    status: "running",
  });
  const second = step({
    kind: "host-operation",
    payload: { operation: "commit-sync", idempotencyKey: "k" },
    status: "pending",
  });
  const decision = decideNextStep(run(), [first, second]);
  assert.equal(decision.kind, "pause");
  assert.match(
    (decision as { reason: string }).reason,
    /2 open steps.*one step at a time/,
  );
});

/* -------------------------------- verdicts --------------------------------- */

test("a configured fixer is persisted on revise and the fix returns to its author", () => {
  const fixer = { ...TEST_MODEL, modelId: "gpt-fixer", notes: "fast fixes" };
  const verdict = { ...CLAUDE_MODEL, modelId: "opus-verdict" };
  const configured = run({
    config: {
      coordinator: TEST_MODEL,
      roles: {
        implementer: [TEST_MODEL],
        reviewer: [TEST_MODEL],
        fixer: [fixer],
        verdict: [verdict],
      },
    },
  });
  const plan = planned();
  const passes2 = { ...configured, maxReviewPasses: 2 };
  const initialReview = reviewed("revise", {
    findings: [{ severity: "major", text: "fix the race" }],
  });
  const history = [plan, implemented(), committed(), initialReview];

  // A revise no longer routes itself: with a fixer set the coordinator is
  // asked who answers these findings, and its answer is what the run carries.
  const routing = decideRecipeNextStep(passes2, history);
  const routingPayload = appendedPayload(routing) as Record<
    string,
    WorkflowJsonValue
  >;
  assert.equal(routingPayload.objective, "review-decision");
  assert.equal(routingPayload.question, "route-fix");
  assert.deepEqual(routingPayload.roles, { fixer: [fixer] });
  const routed = step({
    kind: "agent",
    payload: routingPayload,
    contractId: REVIEW_DECISION_CONTRACT_ID,
    resultPayload: {
      decision: "fix",
      assignee: "fixer",
      fixer,
      focus: ["the lock is missing on every retry path, not only this one"],
      rationale: "a targeted correction",
    },
  });
  const revisePayload = appendedPayload(
    decideRecipeNextStep(passes2, [...history, routed]),
  ) as Record<string, WorkflowJsonValue>;
  assert.deepEqual(revisePayload.fixer, fixer);
  assert.equal(revisePayload.fixerLineage, "pass-1", "the lineage it answers");
  // The routing answer is the coordinator's only chance to tell the round what
  // it diagnosed; the rationale is the run's record and never handed over.
  assert.deepEqual(revisePayload.focus, [
    "the lock is missing on every retry path, not only this one",
  ]);

  // And a decision that named no focus must not leave an empty list behind for
  // the assignment to render a heading over.
  const routedWithoutFocus = step({
    kind: "agent",
    payload: routingPayload,
    contractId: REVIEW_DECISION_CONTRACT_ID,
    resultPayload: {
      decision: "fix",
      assignee: "fixer",
      fixer,
      rationale: "a targeted correction",
    },
  });
  assert.equal(
    (
      appendedPayload(
        decideRecipeNextStep(passes2, [...history, routedWithoutFocus]),
      ) as Record<string, WorkflowJsonValue>
    ).focus,
    undefined,
  );

  // An out-of-set fixer is refused as a RUNTIME — the findings go to the
  // implementer — but the diagnosis of those findings is not the coordinator's
  // authority to name a session, and it is worth most in exactly this case:
  // whoever answers them still needs to know what the coordinator read. So the
  // focus is taken from the raw answer, past the authority check the fixer
  // failed.
  const routedOutOfSet = step({
    kind: "agent",
    payload: routingPayload,
    contractId: REVIEW_DECISION_CONTRACT_ID,
    resultPayload: {
      decision: "fix",
      assignee: "fixer",
      fixer: { ...fixer, modelId: "never-authorized" },
      focus: ["the lock is missing on every retry path, not only this one"],
      rationale: "wants a fixer the run never authorized",
    },
  });
  const fallback = appendedPayload(
    decideRecipeNextStep(passes2, [...history, routedOutOfSet]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(fallback.fixer, undefined, "the runtime is still refused");
  assert.deepEqual(fallback.focus, [
    "the lock is missing on every retry path, not only this one",
  ]);

  const fixed = step({
    kind: "agent",
    payload: revisePayload,
    contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
    resultPayload: {
      notes: "fixed it",
      responses: [{ finding: "fix the race", response: "fixed: locked it" }],
    },
  });
  const fixCommit = committed();
  fixCommit.predecessorId = fixed.id;
  // The fix goes back to the reviewer that raised the findings — in ITS pass,
  // so the executor rebuilds that same session — not to the verdict.
  const reCheckDecision = decideRecipeNextStep(passes2, [
    ...history,
    routed,
    fixed,
    fixCommit,
  ]);
  assert.equal(reCheckDecision.kind, "append");
  const reCheckStep = (
    reCheckDecision as Extract<WorkflowDecision, { kind: "append" }>
  ).step;
  assert.deepEqual(reCheckStep.payload, {
    role: "reviewer",
    objective: "re-check",
    commitRange: { baseCommit: "aaa", headCommit: "bbb" },
    findings: [{ severity: "major", text: "fix the race" }],
    answersStepId: initialReview.id,
    reviewPass: 1,
    implementerReport: {
      summary: "done",
      notes: "fixed it",
      responses: [{ finding: "fix the race", response: "fixed: locked it" }],
    },
    resultContract: ASSESSMENT_CONTRACT_ID,
  });

  // A cleared re-check settles the findings, not the head: the fix moved the
  // commit that would ship, so the run buys another discovery opinion.
  const reChecked = step({
    kind: "agent",
    payload: reCheckStep.payload,
    contractId: ASSESSMENT_CONTRACT_ID,
    resultPayload: { verdict: "pass", headCommit: "bbb", findings: [] },
  });
  const afterFix = [...history, routed, fixed, fixCommit, reChecked];
  const syncPayload = appendedPayload(
    decideRecipeNextStep(passes2, afterFix),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(syncPayload.operation, BASE_SYNC_OPERATION_ID);
  const sync = checkpointed("base-sync", { purpose: "discovery" });
  sync.payload = syncPayload;
  sync.predecessorId = reChecked.id;
  const discoveryHistory = [...afterFix, sync];
  const discovery = appendedPayload(
    decideRecipeNextStep(passes2, discoveryHistory),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(discovery.role, "reviewer");
  assert.equal(discovery.objective, "review");
  assert.equal(discovery.reviewPass, 2);

  // Only THAT pass admits delivery — through the coordinator, which names the
  // verdict runtime with the whole run in front of it.
  const secondPass = step({
    kind: "agent",
    payload: discovery,
    contractId: ASSESSMENT_CONTRACT_ID,
    resultPayload: { verdict: "pass", headCommit: "bbb", findings: [] },
  });
  const deliverPayload = appendedPayload(
    decideRecipeNextStep(passes2, [...discoveryHistory, secondPass]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(deliverPayload.question, "deliver-or-review");
  assert.deepEqual(deliverPayload.roles, {
    reviewer: [TEST_MODEL],
    verdict: [verdict],
  });
  const delivered = step({
    kind: "agent",
    payload: deliverPayload,
    contractId: REVIEW_DECISION_CONTRACT_ID,
    resultPayload: {
      decision: "deliver",
      verdict,
      rationale: "two passes agree",
    },
  });
  const afterDeliver = [...discoveryHistory, secondPass, delivered];

  // The verdict judges last, after delivery freshness confirms the checkpoint.
  const deliveryFreshnessPayload = appendedPayload(
    decideRecipeNextStep(passes2, afterDeliver),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(deliveryFreshnessPayload.operation, BASE_SYNC_OPERATION_ID);
  const deliveryFreshness = checkpointed("base-sync", {
    purpose: "delivery",
  });
  deliveryFreshness.payload = deliveryFreshnessPayload;
  deliveryFreshness.predecessorId = delivered.id;
  const verdictPayload = appendedPayload(
    decideRecipeNextStep(passes2, [...afterDeliver, deliveryFreshness]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(verdictPayload.role, "verdict");
  assert.equal(verdictPayload.objective, "verdict");
  assert.deepEqual(verdictPayload.verdict, verdict);

  const passedVerdict = step({
    kind: "agent",
    payload: verdictPayload,
    contractId: ASSESSMENT_CONTRACT_ID,
    resultPayload: { verdict: "pass", headCommit: "bbb", findings: [] },
  });
  const delivery = decideRecipeNextStep(passes2, [
    ...afterDeliver,
    passedVerdict,
  ]);
  assert.equal(
    (appendedPayload(delivery) as Record<string, WorkflowJsonValue>).operation,
    "delivery-gate",
  );
});

test("a verdict pass alone never reaches the delivery gate", () => {
  // Run 72's path: a review found eight things, a fixer answered them, the
  // post-fix verdict passed, and the larger half of the change was delivered
  // without any discovery review of the commit that shipped.
  const verdict = { ...CLAUDE_MODEL, modelId: "opus-verdict" };
  const configured = run({
    config: {
      coordinator: TEST_MODEL,
      roles: {
        implementer: [TEST_MODEL],
        reviewer: [TEST_MODEL],
        fixer: [],
        verdict: [verdict],
      },
    },
  });
  const plan = planned();
  plan.result!.payload = {
    complexity: "medium",
    implementer: TEST_MODEL,
    reviewer: TEST_MODEL,
    verdict,
    rationale: "judge the fix independently",
  };
  const history = [
    plan,
    implemented(),
    committed(),
    reviewed("revise", { findings: [{ severity: "major", text: "race" }] }),
  ];
  const fixed = step({
    kind: "agent",
    payload: appendedPayload(decideRecipeNextStep(configured, history)),
    contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
    resultPayload: { notes: "fixed" },
  });
  const fixCommit = committed("aaa", "ccc");
  fixCommit.predecessorId = fixed.id;
  const passedVerdict = step({
    kind: "agent",
    payload: {
      role: "verdict",
      objective: "verdict",
      commitRange: { baseCommit: "aaa", headCommit: "ccc" },
      verdict,
      resultContract: ASSESSMENT_CONTRACT_ID,
    },
    contractId: ASSESSMENT_CONTRACT_ID,
    resultPayload: { verdict: "pass", headCommit: "ccc", findings: [] },
  });
  const decision = decideRecipeNextStep(configured, [
    ...history,
    fixed,
    fixCommit,
    passedVerdict,
  ]);
  // It does not stop the run either: an exhausted ceiling is the user's to
  // answer, and shipping ccc unreviewed is one of the answers offered.
  const gate = appendedPayload(decision) as Record<string, WorkflowJsonValue>;
  assert.equal(gate.decision, "raise-ceilings");
  assert.equal(gate.blocked, "review-passes");
  assert.equal(gate.reviewedHeadCommit, "ccc");
  assert.equal(gate.headCarriesDiscoveryReview, false);
  assert.deepEqual(gate.allowedChoices, ["raise", "deliver", "cancel"]);
});

test("a cleared re-check asks the user when no pass is left to buy fresh eyes", () => {
  const history = [
    planned(),
    implemented(),
    committed(),
    reviewed("revise", { findings: [{ severity: "major", text: "race" }] }),
  ];
  const fixed = step({
    kind: "agent",
    payload: appendedPayload(decideRecipeNextStep(run(), history)),
    contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
    resultPayload: { notes: "fixed" },
  });
  const fixCommit = committed();
  fixCommit.predecessorId = fixed.id;
  const reCheck = step({
    kind: "agent",
    payload: appendedPayload(
      decideRecipeNextStep(run(), [...history, fixed, fixCommit]),
    ),
    contractId: ASSESSMENT_CONTRACT_ID,
    resultPayload: { verdict: "pass", headCommit: "bbb", findings: [] },
  });
  // The default fixture allows a single pass, which the discovery review
  // already spent: the run stops rather than delivering unreviewed work.
  const decision = decideRecipeNextStep(run(), [
    ...history,
    fixed,
    fixCommit,
    reCheck,
  ]);
  const gate = appendedPayload(decision) as Record<string, WorkflowJsonValue>;
  assert.equal(gate.decision, "raise-ceilings");
  assert.equal(gate.blocked, "review-passes");
  assert.match(String(gate.wanted), /fresh eyes on the fix/);
});

test("the published review set travels from assessment to fixer to re-check", () => {
  const verdict = { ...CLAUDE_MODEL, modelId: "opus-verdict" };
  const configured = run({
    config: {
      coordinator: TEST_MODEL,
      roles: {
        implementer: [TEST_MODEL],
        reviewer: [TEST_MODEL],
        fixer: [],
        verdict: [verdict],
      },
    },
  });
  const plan = planned();
  plan.result!.payload = {
    complexity: "medium",
    implementer: TEST_MODEL,
    reviewer: TEST_MODEL,
    verdict,
    rationale: "verify the fix independently",
  };
  const review = reviewed("revise", {
    findings: [
      {
        severity: "major",
        text: "fix the race",
        path: "src/lock.ts",
        line: 12,
        commentId: "thread-1",
      },
    ],
  });
  review.result!.payload = {
    ...(review.result!.payload as Record<string, WorkflowJsonValue>),
    reviewSetId: "set-1",
  };
  const history = [plan, implemented(), committed(), review];

  const revisePayload = appendedPayload(
    decideRecipeNextStep(configured, history),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(revisePayload.reviewSetId, "set-1");

  // The fix round's own step result carries what its threads ended up saying,
  // which is what its author's re-check is given — not the fixer's account.
  const fixed = step({
    kind: "agent",
    payload: revisePayload,
    contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
    resultPayload: {
      notes: "answered on the thread",
      reviewSetId: "set-1",
      resolutions: [
        {
          commentId: "thread-1",
          state: "disputed",
          response: "the caller already holds the lock",
        },
      ],
    },
  });
  const fixCommit = committed();
  fixCommit.predecessorId = fixed.id;
  const reCheckPayload = appendedPayload(
    decideRecipeNextStep(configured, [...history, fixed, fixCommit]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(reCheckPayload.objective, "re-check");
  assert.equal(reCheckPayload.reviewSetId, "set-1");
  assert.deepEqual(reCheckPayload.findingResolutions, [
    {
      commentId: "thread-1",
      state: "disputed",
      response: "the caller already holds the lock",
    },
  ]);
});

test("a CI round between fix and re-check does not erase the set's evidence", () => {
  // A fix answering set-1 can be followed by a CI round, which answers machine
  // failure and owns no review set at all, before the author ever re-checks.
  // Reading the newest implementation result rather than the newest one FOR
  // THIS SET handed the author an empty record of its own findings — every
  // dispute and every fix erased — and reset the card's rollup to all-open.
  const review = reviewed("revise", {
    findings: [
      {
        severity: "major",
        text: "fix the race",
        path: "src/lock.ts",
        line: 12,
        commentId: "thread-1",
      },
    ],
  });
  review.result!.payload = {
    ...(review.result!.payload as Record<string, WorkflowJsonValue>),
    reviewSetId: "set-1",
  };
  const history = [planned(), implemented(), committed(), review];

  const revisePayload = appendedPayload(
    decideRecipeNextStep(run(), history),
  ) as Record<string, WorkflowJsonValue>;
  const resolutions = [
    {
      commentId: "thread-1",
      state: "disputed",
      response: "the caller already holds the lock",
    },
  ];
  const fixed = step({
    kind: "agent",
    payload: revisePayload,
    contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
    resultPayload: {
      notes: "answered on the thread",
      reviewSetId: "set-1",
      resolutions,
    },
  });
  const fixCommit = committed();
  fixCommit.predecessorId = fixed.id;
  // Machine failure on the fixed head, and the round that answers it. A CI fix
  // carries no set: it is answering the build, not a reviewer.
  const ciRed = observedCi("red");
  ciRed.predecessorId = fixCommit.id;
  const ciFixPayload = appendedPayload(
    decideRecipeNextStep(run(), [...history, fixed, fixCommit, ciRed]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(ciFixPayload.reviewSetId, undefined, "a CI round owns no set");
  const ciFix = step({
    kind: "agent",
    payload: ciFixPayload,
    contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
    resultPayload: { notes: "fixed the type error" },
  });
  const ciCommit = committed();
  ciCommit.predecessorId = ciFix.id;
  const ciGreen = observedCi("green");
  ciGreen.predecessorId = ciCommit.id;

  const reCheckPayload = appendedPayload(
    decideRecipeNextStep(run(), [
      ...history,
      fixed,
      fixCommit,
      ciRed,
      ciFix,
      ciCommit,
      ciGreen,
    ]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(reCheckPayload.objective, "re-check");
  assert.equal(reCheckPayload.reviewSetId, "set-1");
  assert.deepEqual(
    reCheckPayload.findingResolutions,
    resolutions,
    "the author still sees what its own findings ended up saying",
  );
  // And the helper itself, so the reason this holds is pinned directly.
  assert.deepEqual(
    findingResolutionsOf([...history, fixed, ciFix], "set-1"),
    resolutions,
  );
  assert.deepEqual(
    findingResolutionsOf([...history, fixed, ciFix], "set-2"),
    [],
    "a set no fix round has answered still reads empty",
  );
});

test("a judge reads the author's settlement, not the fix round it superseded", () => {
  // The fixer records what it left on each thread; the author then re-checks
  // and settles them. A judge handed the FIX ROUND's record is told a finding
  // is `disputed` after its author has already accepted that dispute and closed
  // the thread — and would argue a settled point back open.
  const verdict = { ...CLAUDE_MODEL, modelId: "opus-verdict" };
  const configured = run({
    config: {
      coordinator: TEST_MODEL,
      roles: {
        implementer: [TEST_MODEL],
        reviewer: [TEST_MODEL],
        fixer: [],
        verdict: [verdict],
      },
    },
  });
  const plan = planned();
  plan.result!.payload = {
    complexity: "medium",
    implementer: TEST_MODEL,
    reviewer: TEST_MODEL,
    verdict,
    rationale: "judge the resolution",
  };
  const review = reviewed("revise", {
    findings: [
      {
        severity: "major",
        text: "fix the race",
        path: "src/lock.ts",
        line: 12,
        commentId: "thread-1",
      },
    ],
  });
  review.result!.payload = {
    ...(review.result!.payload as Record<string, WorkflowJsonValue>),
    reviewSetId: "set-1",
  };
  const history = [plan, implemented(), committed(), review];
  const fixed = step({
    kind: "agent",
    payload: appendedPayload(decideRecipeNextStep(configured, history)),
    contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
    resultPayload: {
      notes: "argued it",
      reviewSetId: "set-1",
      resolutions: [
        {
          commentId: "thread-1",
          state: "disputed",
          response: "the caller already holds the lock",
        },
      ],
    },
  });
  const fixCommit = committed();
  fixCommit.predecessorId = fixed.id;
  // The author re-checks, accepts the argument, and its settlement says so.
  const reCheck = step({
    kind: "agent",
    payload: appendedPayload(
      decideRecipeNextStep(configured, [...history, fixed, fixCommit]),
    ),
    contractId: ASSESSMENT_CONTRACT_ID,
    resultPayload: {
      verdict: "pass",
      headCommit: "bbb",
      findings: [],
      reviewSetId: "set-1",
      settlement: [{ commentId: "thread-1", state: "resolved" }],
    },
  });
  const cleared = reviewed("pass");
  cleared.predecessorId = reCheck.id;
  const historyThroughDiscovery = [
    ...history,
    fixed,
    fixCommit,
    reCheck,
    cleared,
  ];
  const decision = step({
    kind: "agent",
    payload: appendedPayload(
      decideRecipeNextStep(configured, historyThroughDiscovery),
    ),
    contractId: REVIEW_DECISION_CONTRACT_ID,
    resultPayload: { decision: "deliver", verdict, rationale: "ship" },
  });

  const deliveryFreshnessPayload = appendedPayload(
    decideRecipeNextStep(configured, [...historyThroughDiscovery, decision]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(deliveryFreshnessPayload.operation, BASE_SYNC_OPERATION_ID);
  const deliveryFreshness = checkpointed("base-sync", {
    purpose: "delivery",
  });
  deliveryFreshness.payload = deliveryFreshnessPayload;
  deliveryFreshness.predecessorId = decision.id;
  const judge = appendedPayload(
    decideRecipeNextStep(configured, [
      ...historyThroughDiscovery,
      decision,
      deliveryFreshness,
    ]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(judge.role, "verdict");
  assert.deepEqual(
    judge.findingResolutions,
    [{ commentId: "thread-1", state: "resolved" }],
    "the newest word about the set, which is its author's",
  );
});

test("a discovery pass bought at delivery is routed, not spent silently", () => {
  // A verdict reissued on a moved range can pass a head no discovery pass ever
  // read, and delivery refuses that. The recipe buys the missing pass — but
  // WHICH fresh eyes is a real question whenever the run has more than one
  // reviewer, and the coordinator is asked after every other assessment.
  const second = { ...CLAUDE_MODEL, modelId: "opus-reviewer" };
  const twoReviewers = run({
    maxReviewPasses: 2,
    config: {
      coordinator: TEST_MODEL,
      roles: {
        implementer: [TEST_MODEL],
        reviewer: [TEST_MODEL, second],
        fixer: [],
        verdict: [TEST_MODEL],
      },
    },
  });
  // The verdict judged — and passed — the range the workspace moved it to.
  const movedTo = committed("aaa", "ccc");
  const judged = step({
    kind: "agent",
    payload: {
      role: "verdict",
      objective: "verdict",
      commitRange: { baseCommit: "aaa", headCommit: "ccc" },
      resultContract: ASSESSMENT_CONTRACT_ID,
    },
    contractId: ASSESSMENT_CONTRACT_ID,
    resultPayload: { verdict: "pass", headCommit: "ccc", findings: [] },
  });
  const history = [
    planned(),
    implemented(),
    committed(),
    reviewed("pass"),
    movedTo,
    judged,
  ];

  const asked = appendedPayload(
    decideRecipeNextStep(twoReviewers, history),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(asked.role, "coordinator");
  assert.equal(asked.question, "review-again");
  assert.deepEqual(asked.commitRange, { baseCommit: "aaa", headCommit: "ccc" });

  // With nothing to choose between, there is no question: the pass is bought.
  const oneReviewer = run({
    maxReviewPasses: 2,
    config: {
      coordinator: TEST_MODEL,
      roles: {
        implementer: [TEST_MODEL],
        reviewer: [TEST_MODEL],
        fixer: [],
        verdict: [TEST_MODEL],
      },
    },
  });
  const bought = appendedPayload(
    decideRecipeNextStep(oneReviewer, history),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(bought.role, "reviewer");
  assert.equal(bought.objective, "review");
});

test("a verdict REISSUED on a moved range reads the settlement too", () => {
  // The reissue path exists because the workspace can move under an assessment.
  // Both sides of the conversation are reissued through it, and they need
  // different evidence: a re-check is about to settle these threads and must
  // see what the FIX ROUND left, while a verdict is a later reader and must see
  // the newest word. One shared object handed the reissued verdict the snapshot
  // the author's settlement had already superseded.
  const verdict = { ...CLAUDE_MODEL, modelId: "opus-verdict" };
  const configured = run({
    config: {
      coordinator: TEST_MODEL,
      roles: {
        implementer: [TEST_MODEL],
        reviewer: [TEST_MODEL],
        fixer: [],
        verdict: [verdict],
      },
    },
  });
  const disputed = {
    commentId: "thread-1",
    state: "disputed",
    response: "the caller already holds the lock",
  };
  const settled = { commentId: "thread-1", state: "resolved" };
  const fixed = step({
    kind: "agent",
    payload: {
      role: "implementer",
      objective: "revise",
      reviewSetId: "set-1",
      resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
    },
    contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
    resultPayload: {
      notes: "argued it",
      reviewSetId: "set-1",
      resolutions: [disputed],
    },
  });
  // Its author re-checked and accepted the argument: the thread is resolved.
  const reCheck = step({
    kind: "agent",
    payload: {
      role: "reviewer",
      objective: "re-check",
      reviewSetId: "set-1",
      commitRange: { baseCommit: "aaa", headCommit: "bbb" },
      resultContract: ASSESSMENT_CONTRACT_ID,
    },
    contractId: ASSESSMENT_CONTRACT_ID,
    resultPayload: {
      verdict: "pass",
      headCommit: "bbb",
      findings: [],
      reviewSetId: "set-1",
      settlement: [settled],
    },
  });
  // A verdict was assigned bbb but named ccc: the workspace moved under it.
  const stale = step({
    kind: "agent",
    payload: {
      role: "verdict",
      objective: "verdict",
      reviewSetId: "set-1",
      verdict,
      commitRange: { baseCommit: "aaa", headCommit: "bbb" },
      resultContract: ASSESSMENT_CONTRACT_ID,
    },
    contractId: ASSESSMENT_CONTRACT_ID,
    resultPayload: { verdict: "pass", headCommit: "ccc", findings: [] },
  });
  const resynced = committed("aaa", "ccc");
  resynced.predecessorId = stale.id;
  const history = [
    planned(),
    implemented(),
    committed(),
    reviewed("revise"),
    fixed,
    reCheck,
    reviewed("pass"),
    stale,
    resynced,
  ];

  const reissued = appendedPayload(
    decideRecipeNextStep(configured, history),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(reissued.role, "verdict");
  assert.deepEqual(reissued.commitRange, {
    baseCommit: "aaa",
    headCommit: "ccc",
  });
  assert.deepEqual(
    reissued.findingResolutions,
    [settled],
    "the author's settlement, not the dispute it superseded",
  );
});

/**
 * The largest review the contract accepts: BOTH bounds at once — exactly
 * `ASSESSMENT_FINDINGS_MAX_COUNT` findings whose reviewer-written form fills
 * `ASSESSMENT_FINDINGS_MAX_CHARS`. Anything smaller does not test the boundary
 * the guarantee is stated at.
 */
function maximalFindings(): ReviewFinding[] {
  const build = (textLength: number): ReviewFinding[] =>
    Array.from({ length: ASSESSMENT_FINDINGS_MAX_COUNT }, (_unused, index) => ({
      severity: "major" as const,
      text: `finding ${index} ${"y".repeat(textLength)}`,
      path: `src/some/deeper/path/module-${index}.ts`,
      line: index + 1,
    }));
  // Widening all thirty together moves in steps of thirty characters, which
  // would leave the "largest accepted" set up to twenty-nine characters short
  // of the bound — and then "one more" would be thirty more, testing something
  // else. Widen together first, then spend the remainder on ONE finding, so the
  // set sits exactly at the limit and a single extra character crosses it.
  let textLength = 1;
  while (
    JSON.stringify(build(textLength + 1)).length <=
    ASSESSMENT_FINDINGS_MAX_CHARS
  )
    textLength += 1;
  const findings = build(textLength);
  const remainder =
    ASSESSMENT_FINDINGS_MAX_CHARS - JSON.stringify(findings).length;
  findings[0] = {
    ...findings[0]!,
    text: `${findings[0]!.text}${"y".repeat(remainder)}`,
  };
  return findings;
}

/** Each finding as the server stores it once publication anchors a thread. */
function published(findings: readonly ReviewFinding[]): ReviewFinding[] {
  return findings.map((finding, index) => ({
    ...finding,
    commentId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  }));
}

test("the largest accepted review survives INTACT into every successor", () => {
  // Findings are the one payload group composition may never shorten, and
  // "never" has to hold at the boundary the contract actually accepts — not
  // comfortably inside it. A dropped finding is recoverable by nothing the run
  // has: a retry re-composes the same shortened assignment, and the coordinator
  // deciding who fixes what has no review threads to fall back on.
  //
  // Row-level survival is not enough either. Clipping runs BEFORE the array is
  // protected, so a finding could keep its place and lose the sentence that
  // says what is wrong — an assignment that looks complete and is not. Every
  // field is therefore compared, not counted.
  const written = maximalFindings();
  assert.equal(written.length, ASSESSMENT_FINDINGS_MAX_COUNT);
  assert.equal(
    JSON.stringify(written).length,
    ASSESSMENT_FINDINGS_MAX_CHARS,
    "the fixture sits exactly ON the byte bound",
  );
  assert.ok(
    getResultContract(ASSESSMENT_CONTRACT_ID)!.validate({
      verdict: "revise",
      headCommit: "bbb",
      findings: written,
    }),
    "and the contract accepts exactly this",
  );
  assert.ok(
    !getResultContract(ASSESSMENT_CONTRACT_ID)!.validate({
      verdict: "revise",
      headCommit: "bbb",
      findings: [
        { ...written[0]!, text: `${written[0]!.text}y` },
        ...written.slice(1),
      ],
    }),
    "one single character more is refused",
  );

  const anchored = published(written);
  const withFixerAndVerdict = run({
    maxReviewPasses: 2,
    config: {
      coordinator: TEST_MODEL,
      roles: {
        implementer: [TEST_MODEL],
        reviewer: [TEST_MODEL, CLAUDE_MODEL],
        fixer: [CLAUDE_MODEL],
        verdict: [CLAUDE_MODEL],
      },
    },
  });
  // Every competing group at ITS maximum, so findings are the last thing that
  // could give: a full implementer report, a summary, observations, and — once
  // a fix round has answered — a maximum-length response on every thread.
  const loaded = implemented("n".repeat(3_000));
  const assessment = reviewed("revise", {
    findings: anchored,
    summary: "s".repeat(1_000),
    observations: ["o".repeat(1_000)],
  });
  assessment.result!.payload = {
    ...(assessment.result!.payload as Record<string, WorkflowJsonValue>),
    reviewSetId: "set-1",
  };
  const history = [planned(), loaded, committed(), assessment];

  const carriedFindings = (payload: WorkflowJsonValue): WorkflowJsonValue[] =>
    ((payload as Record<string, WorkflowJsonValue>).findings ??
      []) as WorkflowJsonValue[];
  const assertIntact = (payload: WorkflowJsonValue, shape: string): void => {
    assertAppendableRecipePayload(payload);
    assert.deepEqual(
      carriedFindings(payload),
      anchored as unknown as WorkflowJsonValue[],
      `${shape} carries every finding, whole: severity, text, path, line, thread`,
    );
  };

  // 1. The coordinator's route-fix decision — the shape with no threads to fall
  //    back on, so a shortened list there is unrecoverable by anything.
  const routing = appendedPayload(
    decideRecipeNextStep(withFixerAndVerdict, history),
  );
  assert.equal(
    (routing as Record<string, WorkflowJsonValue>).question,
    "route-fix",
  );
  assertIntact(routing, "the coordinator's routing decision");

  // 2. The fix round it routes to.
  const routed = step({
    kind: "agent",
    payload: routing,
    contractId: REVIEW_DECISION_CONTRACT_ID,
    resultPayload: {
      decision: "fix",
      assignee: "fixer",
      fixer: CLAUDE_MODEL,
      rationale: "r".repeat(400),
    },
  });
  const fix = appendedPayload(
    decideRecipeNextStep(withFixerAndVerdict, [...history, routed]),
  );
  assertIntact(fix, "the fix assignment");

  // 3. The author's re-check, with a maximum-length response on every thread.
  const fixed = step({
    kind: "agent",
    payload: fix,
    contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
    resultPayload: {
      notes: "n".repeat(2_000),
      reviewSetId: "set-1",
      resolutions: anchored.map((finding) => ({
        commentId: finding.commentId!,
        state: "disputed",
        response: "r".repeat(RESOLUTION_RESPONSE_MAX_CHARS),
      })),
    },
  });
  const fixCommit = committed();
  fixCommit.predecessorId = fixed.id;
  const afterFix = [...history, routed, fixed, fixCommit];
  const reCheck = appendedPayload(
    decideRecipeNextStep(withFixerAndVerdict, afterFix),
  );
  assert.equal(
    (reCheck as Record<string, WorkflowJsonValue>).objective,
    "re-check",
  );
  assertIntact(reCheck, "the author's re-check");

  // 4. The verdict, which judges the resolution of those same findings.
  const cleared = step({
    kind: "agent",
    payload: reCheck,
    contractId: ASSESSMENT_CONTRACT_ID,
    resultPayload: {
      verdict: "pass",
      headCommit: "bbb",
      findings: [],
      reviewSetId: "set-1",
    },
  });
  const secondPass = reviewed("pass");
  secondPass.predecessorId = cleared.id;
  const deliverDecision = step({
    kind: "agent",
    payload: appendedPayload(
      decideRecipeNextStep(withFixerAndVerdict, [
        ...afterFix,
        cleared,
        secondPass,
      ]),
    ),
    contractId: REVIEW_DECISION_CONTRACT_ID,
    resultPayload: {
      decision: "deliver",
      verdict: CLAUDE_MODEL,
      rationale: "ship",
    },
  });
  const deliveryFreshnessPayload = appendedPayload(
    decideRecipeNextStep(withFixerAndVerdict, [
      ...afterFix,
      cleared,
      secondPass,
      deliverDecision,
    ]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(deliveryFreshnessPayload.operation, BASE_SYNC_OPERATION_ID);
  const deliveryFreshness = checkpointed("base-sync", {
    purpose: "delivery",
  });
  deliveryFreshness.payload = deliveryFreshnessPayload;
  deliveryFreshness.predecessorId = deliverDecision.id;
  const verdict = appendedPayload(
    decideRecipeNextStep(withFixerAndVerdict, [
      ...afterFix,
      cleared,
      secondPass,
      deliverDecision,
      deliveryFreshness,
    ]),
  );
  assert.equal((verdict as Record<string, WorkflowJsonValue>).role, "verdict");
  assertIntact(verdict, "the verdict pass");
});

test("a LATER routing decision still carries every finding whole", () => {
  // The first route-fix has no history behind it. A later one carries the
  // cumulative record — every prior fix round with its own `notes`, which come
  // from an implementation result with no field limit, plus prior reviewers and
  // the range's change stat. Left unshrinkable, that history squeezed the
  // findings' TEXT: thirty rows survive and the sentences saying what is wrong
  // do not, which is an assignment that looks complete and is not.
  const written = maximalFindings();
  const anchored = published(written);
  const bigNotes = "n".repeat(12_000);
  const configured = run({
    maxIterations: 4,
    maxReviewPasses: 3,
    config: {
      coordinator: TEST_MODEL,
      roles: {
        implementer: [TEST_MODEL],
        reviewer: [TEST_MODEL, CLAUDE_MODEL],
        fixer: [CLAUDE_MODEL, TEST_MODEL],
        verdict: [CLAUDE_MODEL],
      },
    },
  });
  const fatCommit = (base: string, head: string): WorkflowStepRow => {
    const commit = committed(base, head);
    commit.result = {
      ...commit.result!,
      payload: {
        baseCommit: base,
        headCommit: head,
        changes: {
          filesChanged: 40,
          insertions: 9_000,
          deletions: 4_000,
          files: Array.from({ length: 40 }, (_unused, index) => ({
            path: `src/very/deeply/nested/area/module-${index}.ts`,
            insertions: 200,
            deletions: 90,
          })),
          commitSubjects: Array.from(
            { length: 20 },
            (_unused, index) => `fix round ${index}: ${"s".repeat(60)}`,
          ),
        },
      },
    };
    return commit;
  };
  /** One completed fix round, reported with the largest notes a result holds. */
  const round = (reviewSetId: string): WorkflowStepRow[] => {
    const fix = step({
      kind: "agent",
      payload: {
        role: "implementer",
        objective: "revise",
        reviewSetId,
        fixer: CLAUDE_MODEL,
        findings: anchored as unknown as WorkflowJsonValue,
        resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
      },
      contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
      resultPayload: { notes: bigNotes, reviewSetId },
    });
    const commit = fatCommit("aaa", "bbb");
    commit.predecessorId = fix.id;
    return [fix, commit];
  };

  // Two rounds already spent, then a fresh assessment at the accepted bound.
  const latest = reviewed("revise", {
    findings: anchored,
    summary: "s".repeat(1_000),
    observations: ["o".repeat(1_000)],
  });
  latest.result!.payload = {
    ...(latest.result!.payload as Record<string, WorkflowJsonValue>),
    reviewSetId: "set-3",
  };
  const history = [
    planned(),
    implemented("i".repeat(3_000)),
    fatCommit("aaa", "bbb"),
    reviewed("revise", { findings: anchored }),
    ...round("set-1"),
    ...round("set-2"),
    latest,
  ];

  const routing = appendedPayload(decideRecipeNextStep(configured, history));
  const record = routing as Record<string, WorkflowJsonValue>;
  assert.equal(record.question, "route-fix");
  assertAppendableRecipePayload(routing);
  // Real pressure, not a comfortable payload: composition had to shrink to get
  // here, so something gave.
  assert.ok(
    JSON.stringify(routing).length >
      CODE_DELIVERY_PAYLOAD_MAX_CHARS - JSON.stringify(anchored).length,
    "the assignment is genuinely up against its budget",
  );
  assert.ok(
    carriesTruncationMarker(record.priorFixers!),
    "and what gave was the HISTORY — notes, rounds, or both",
  );
  assert.deepEqual(
    record.findings,
    anchored as unknown as WorkflowJsonValue[],
    "while every finding arrives whole: severity, text, path, line, thread",
  );
});

test("the submission bound is what protects composition, upstream of it", () => {
  // Where the guarantee actually comes from. `isLosslessGroup` stops the
  // array-collapse phase for findings, but at the contract's own bounds
  // composition never needs that phase at all — the boundary test above proves
  // the whole set survives with room to spare. The rule is the belt; the
  // SUBMISSION BOUND is the braces, and it sits upstream: an assessment over
  // the bound is not readable evidence, so no successor is ever composed from
  // one.
  //
  // The consequence is worth stating where someone will find it: lowering these
  // constants makes previously valid results unreadable, and a run holding one
  // would pause with nothing able to shrink it. They are a floor, not a dial.
  const flood: ReviewFinding[] = Array.from(
    { length: ASSESSMENT_FINDINGS_MAX_COUNT + 1 },
    (_unused, index) => ({
      severity: "major" as const,
      text: `finding ${index}`,
      path: `src/module-${index}.ts`,
      line: index + 1,
    }),
  );
  assert.ok(
    !getResultContract(ASSESSMENT_CONTRACT_ID)!.validate({
      verdict: "revise",
      headCommit: "bbb",
      findings: flood,
    }),
    "one finding past the count is not a valid assessment",
  );

  const decision = decideRecipeNextStep(run(), [
    planned(),
    implemented(),
    committed(),
    reviewed("revise", { findings: flood }),
  ]);
  assert.equal(decision.kind, "pause");
  assert.match(
    (decision as Extract<WorkflowDecision, { kind: "pause" }>).reason,
    /without a valid assessment result/,
    "and the recipe refuses to compose from it rather than shortening it",
  );
});

test("a fix returns to its author whether or not a verdict is configured", () => {
  const plan = planned();
  const firstReview = reviewed("revise");
  const revise = decideRecipeNextStep(run(), [
    plan,
    implemented(),
    committed(),
    firstReview,
  ]);
  assert.equal(revise.kind, "append");
  const fixed = step({
    kind: "agent",
    payload: (revise as Extract<WorkflowDecision, { kind: "append" }>).step
      .payload,
    contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
    resultPayload: {},
  });
  const fixCommit = committed();
  fixCommit.predecessorId = fixed.id;
  const next = appendedPayload(
    decideRecipeNextStep(run(), [
      plan,
      implemented(),
      committed(),
      firstReview,
      fixed,
      fixCommit,
    ]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(next.role, "reviewer");
  assert.equal(next.objective, "re-check");
  assert.equal(next.reviewPass, 1);
});

test("a CI round under a fix does not discard the author's pending re-check", () => {
  // Early CI goes red on the fix commit, a CI-attributed round lands on top,
  // and the reviewer's own findings are still owed an answer from their author.
  const review = reviewed("revise", {
    findings: [
      {
        severity: "major",
        text: "fix the race",
        path: "src/lock.ts",
        line: 12,
      },
    ],
  });
  review.result!.payload = {
    ...(review.result!.payload as Record<string, WorkflowJsonValue>),
    reviewSetId: "set-1",
  };
  const history = [planned(), implemented(), committed(), review];
  const fixed = step({
    kind: "agent",
    payload: appendedPayload(decideRecipeNextStep(run(), history)),
    contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
    resultPayload: {
      notes: "fixed",
      reviewSetId: "set-1",
      resolutions: [{ commentId: "thread-1", state: "resolved" }],
    },
  });
  const ciFix = step({
    kind: "agent",
    payload: {
      role: "implementer",
      objective: "revise",
      reviewedCommit: "bbb",
      findingSource: "ci",
      findings: [{ severity: "critical", text: "check `test` failed" }],
      resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
    },
    contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
    resultPayload: { notes: "green now" },
  });
  const ciCommit = committed();
  ciCommit.predecessorId = ciFix.id;
  const next = appendedPayload(
    decideRecipeNextStep(run(), [...history, fixed, ciFix, ciCommit]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(next.objective, "re-check");
  assert.equal(next.answersStepId, review.id);
  // Its own findings and its own set, never the CI round's.
  assert.deepEqual(next.findings, [
    { severity: "major", text: "fix the race", path: "src/lock.ts", line: 12 },
  ]);
  assert.equal(next.reviewSetId, "set-1");
});

test("a fix answering machine CI goes to fresh eyes, which have no author", () => {
  const history = [planned(), implemented(), committed()];
  const ciFix = step({
    kind: "agent",
    payload: {
      role: "implementer",
      objective: "revise",
      reviewedCommit: "bbb",
      findingSource: "ci",
      findings: [{ severity: "critical", text: "check `test` failed" }],
      resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
    },
    contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
    resultPayload: { notes: "green now" },
  });
  const fixCommit = committed();
  fixCommit.predecessorId = ciFix.id;
  const next = appendedPayload(
    decideRecipeNextStep(run(), [...history, ciFix, fixCommit]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(next.objective, "review", "a failed check names no author");
});

test("an exact-head pass admits the delivery freshness checkpoint", () => {
  const steps = round("pass");
  const review = steps[2]!;
  assert.deepEqual(decideNextStep(run(), steps), {
    kind: "append",
    step: {
      kind: "host-operation",
      payload: {
        operation: BASE_SYNC_OPERATION_ID,
        idempotencyKey: baseSyncIdempotencyKey(RUN_ID, review.id),
        purpose: "delivery",
      },
      predecessorId: review.id,
    },
  });
});

test("a passing gate admits publication and a published PR waits at step 9", () => {
  const reviewRound = round("pass");
  const freshness = checkpointed("base-sync", { purpose: "delivery" });
  const gate = delivered("delivery-gate", DELIVERY_GATE_RESULT_CONTRACT_ID, {
    outcome: "ready",
    reviewedHeadCommit: "bbb",
  });
  assert.deepEqual(decideNextStep(run(), [...reviewRound, freshness, gate]), {
    kind: "append",
    step: {
      kind: "host-operation",
      payload: {
        operation: "publish-pull-request",
        idempotencyKey: `wf${RUN_ID}:publish-pull-request:${gate.id}`,
        reviewedHeadCommit: "bbb",
      },
      predecessorId: gate.id,
    },
  });

  const publication = delivered(
    "publish-pull-request",
    PUBLISH_PULL_REQUEST_RESULT_CONTRACT_ID,
    {
      outcome: "published",
      reviewedHeadCommit: "bbb",
      cardId: "pr-1",
      sessionId: "impl-1",
      provider: "github",
      number: 12,
      url: "https://example.test/pull/12",
    },
  );
  assert.deepEqual(decideNextStep(run(), [...reviewRound, gate, publication]), {
    kind: "append",
    step: {
      kind: "wait",
      payload: {
        condition: "pull-request-ready",
        cardId: "pr-1",
        reviewedHeadCommit: "bbb",
      },
      predecessorId: publication.id,
    },
  });

  const ready = step({
    kind: "wait",
    payload: {
      condition: "pull-request-ready",
      cardId: "pr-1",
      reviewedHeadCommit: "bbb",
    },
    contractId: PULL_REQUEST_OBSERVATION_RESULT_CONTRACT_ID,
    resultPayload: { outcome: "ready", headCommit: "bbb" },
  });
  const mergeDecision = decideNextStep(run(), [
    ...reviewRound,
    gate,
    publication,
    ready,
  ]);
  assert.deepEqual(mergeDecision, {
    kind: "append",
    step: {
      kind: "user-decision",
      payload: {
        decision: "merge-pull-request",
        cardId: "pr-1",
        reviewedHeadCommit: "bbb",
        allowedChoices: ["merge", "cancel"],
      },
      predecessorId: ready.id,
    },
  });

  const chosen = step({
    kind: "user-decision",
    payload: mergeDecision.kind === "append" ? mergeDecision.step.payload : {},
  });
  chosen.result = {
    status: "completed",
    summary: "merged",
    payload: {
      choice: "merge",
      source: "app",
      mergeMethod: "squash",
      deleteBranch: true,
    },
    submittedAt: 1,
  };
  assert.deepEqual(
    decideNextStep(run(), [...reviewRound, gate, publication, ready, chosen]),
    { kind: "complete" },
  );
});

test("provider evidence superseding a merge choice appends a fresh observation", () => {
  const decision = step({
    kind: "user-decision",
    payload: {
      decision: "merge-pull-request",
      cardId: "pr-1",
      reviewedHeadCommit: "bbb",
      allowedChoices: ["merge", "cancel"],
    },
  });
  decision.result = {
    status: "completed",
    summary: "merge decision superseded by a base conflict",
    payload: {
      supersededBy: "pull-request-observation",
      observation: {
        outcome: "base-conflict",
        headCommit: "bbb",
        reason: "the base moved",
      },
    },
    submittedAt: 2,
  };

  assert.deepEqual(decideNextStep(run(), [decision]), {
    kind: "append",
    step: {
      kind: "wait",
      payload: {
        condition: "pull-request-ready",
        cardId: "pr-1",
        reviewedHeadCommit: "bbb",
      },
      predecessorId: decision.id,
    },
  });
});

test("a dirty or moved delivery gate routes back through commit/sync and review", () => {
  const history = round("pass");
  const gate = delivered("delivery-gate", DELIVERY_GATE_RESULT_CONTRACT_ID, {
    outcome: "review-required",
    reviewedHeadCommit: "bbb",
    observedHeadCommit: "ccc",
    worktreeDirty: false,
    reason: "workspace moved; commit/sync and review are required again",
  });
  assert.deepEqual(decideNextStep(run(), [...history, gate]), {
    kind: "append",
    step: {
      kind: "host-operation",
      payload: {
        operation: "commit-sync",
        idempotencyKey: `wf${RUN_ID}:commit-sync:${gate.id}`,
      },
      predecessorId: gate.id,
    },
  });
});

test("a pass applies only to the head it names: a stale pass forces a new range and assessment", () => {
  const steps = round("pass", {});
  const review = steps[2]!;
  // The reviewer verified HEAD and it was NOT the assigned range head: the
  // workspace changed after commit/sync, so nothing may move toward delivery.
  review.result!.payload = { verdict: "pass", headCommit: "ccc", findings: [] };
  assert.deepEqual(decideNextStep(run(), steps), {
    kind: "append",
    step: {
      kind: "host-operation",
      payload: {
        operation: "commit-sync",
        idempotencyKey: commitSyncIdempotencyKey(RUN_ID, review.id),
      },
      predecessorId: review.id,
    },
  });
});

test("stale passes consume iterations like revisions, and the limit stops them", () => {
  const stalePass = () => reviewed("pass", { headCommit: "ccc" });
  const limitOne = run({ maxIterations: 1 });

  // One stale pass already forced a re-assessment; a second one is the limit.
  const twice = [
    implemented(),
    committed(),
    stalePass(),
    committed(),
    stalePass(),
  ];
  const stopped = assertCeilingGate(
    decideNextStep(limitOne, twice),
    "iterations",
  );
  assert.match(String(stopped.wanted), /re-assess bbb/);

  // A stale pass and a revision count into the SAME budget: after one stale
  // pass, a revise verdict is already at the limit of one.
  const mixed = [implemented(), committed(), stalePass(), committed()];
  assertCeilingGate(
    decideNextStep(limitOne, [...mixed, reviewed("revise")]),
    "iterations",
  );
  // And under a higher limit the same histories keep going.
  assert.equal(decideNextStep(run({ maxIterations: 2 }), twice).kind, "append");
});

test("a seam more than one pass has returned to is named to the coordinator", () => {
  let line = 0;
  // A finding anchors with path AND line or not at all; the contract rejects
  // a partial anchor, so a seam is only ever counted from anchored findings.
  const finding = (path: string, text: string) => ({
    severity: "major" as const,
    path,
    line: (line += 10),
    text,
  });
  const decision = decideNextStep(run({ maxReviewPasses: 4 }), [
    implemented(),
    committed(),
    reviewed("revise", {
      reviewPass: 1,
      findings: [
        finding("src/gitHosting.ts", "the read order races"),
        finding("src/oneOff.ts", "a typo"),
      ],
    }),
    committed(),
    reviewed("revise", {
      reviewPass: 2,
      // Same seam, different defect — and a second file nobody revisits.
      findings: [finding("src/gitHosting.ts", "and the retry path too")],
    }),
    committed(),
    reviewed("pass", { reviewPass: 3 }),
  ]);
  const payload = appendedPayload(decision) as Record<
    string,
    WorkflowJsonValue
  >;
  assert.deepEqual(
    payload.repeatedPaths,
    [{ path: "src/gitHosting.ts", passes: 2 }],
    "a file one pass raised twice is one opinion, not a seam",
  );
});

test("a run still exploring names no seam at all", () => {
  const decision = decideNextStep(run({ maxReviewPasses: 4 }), [
    implemented(),
    committed(),
    reviewed("revise", {
      reviewPass: 1,
      // Two findings, one pass, one file: thoroughness, not repetition.
      findings: [
        { severity: "major", path: "src/a.ts", line: 10, text: "first" },
        { severity: "major", path: "src/a.ts", line: 20, text: "second" },
      ],
    }),
    committed(),
    reviewed("pass", { reviewPass: 2 }),
  ]);
  const payload = appendedPayload(decision) as Record<
    string,
    WorkflowJsonValue
  >;
  assert.equal(payload.repeatedPaths, undefined);
});

test("a failing review pauses with the reviewer's own summary", () => {
  const steps = [
    implemented(),
    committed(),
    reviewed("fail", { summary: "the approach cannot work" }),
  ];
  assert.deepEqual(decideNextStep(run(), steps), {
    kind: "pause",
    reason: "review failed: the approach cannot work",
  });
});

test("a revise verdict appends rework carrying the findings and its predecessor", () => {
  const steps = round("revise", {
    findings: [
      { severity: "major", text: "missing test" },
      { severity: "major", text: "naming" },
    ],
  });
  const review = steps[2]!;
  assert.deepEqual(decideNextStep(run(), steps), {
    kind: "append",
    step: {
      kind: "agent",
      payload: {
        role: "implementer",
        objective: "revise",
        reviewedCommit: "bbb",
        findings: [
          { severity: "major", text: "missing test" },
          { severity: "major", text: "naming" },
        ],
        reviewSummary: "done",
        // Recorded on an implementer-routed round too: it is the only record of
        // which conversation the round answered, and the coordinator weighs
        // rounds per lineage.
        fixerLineage: "pass-1",
        resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
      },
      predecessorId: review.id,
    },
  });
});

test("rework carries the reviewer's summary and non-blocking observations", () => {
  const steps = round("revise", {
    findings: [{ severity: "major", text: "missing test" }],
    observations: ["the helper name reads oddly"],
    summary: "close, but the retry path is unguarded",
  });
  const decision = decideNextStep(run(), steps);
  assert.equal(decision.kind, "append");
  assert.deepEqual(
    (decision as Extract<WorkflowDecision, { kind: "append" }>).step.payload,
    {
      role: "implementer",
      objective: "revise",
      reviewedCommit: "bbb",
      findings: [{ severity: "major", text: "missing test" }],
      reviewSummary: "close, but the retry path is unguarded",
      observations: ["the helper name reads oddly"],
      fixerLineage: "pass-1",
      resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
    },
  );
});

test("the next assessment carries the implementer's answers to findings", () => {
  const answered = implemented("v2", [
    { finding: "missing test", response: "covered by the existing e2e case" },
  ]);
  const reviewed1 = round("revise", {
    findings: [{ severity: "major", text: "missing test" }],
  });
  const decision = decideNextStep(run(), [
    ...reviewed1,
    answered,
    committed("aaa", "ccc"),
  ]);
  assert.equal(decision.kind, "append");
  assert.deepEqual(
    (decision as Extract<WorkflowDecision, { kind: "append" }>).step.payload,
    {
      role: "reviewer",
      objective: "re-check",
      commitRange: { baseCommit: "aaa", headCommit: "ccc" },
      findings: [{ severity: "major", text: "missing test" }],
      answersStepId: reviewed1[2]!.id,
      reviewPass: 1,
      implementerReport: {
        summary: "done",
        notes: "v2",
        responses: [
          {
            finding: "missing test",
            response: "covered by the existing e2e case",
          },
        ],
      },
      resultContract: ASSESSMENT_CONTRACT_ID,
    },
  );
});

test("triage results do not replace the implementer's assessment report", () => {
  const answered = implemented("fixer notes", [
    { finding: "missing test", response: "added regression coverage" },
  ]);
  const reviewed1 = round("revise", {
    findings: [{ severity: "major", text: "missing test" }],
  });
  const triaged = step({
    kind: "agent",
    payload: {
      role: "implementer",
      objective: "triage-operation",
      resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
    },
    contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
    resultPayload: { notes: "diagnosed provider outage" },
  });
  const decision = decideNextStep(run(), [
    ...reviewed1,
    answered,
    triaged,
    committed("aaa", "ccc"),
  ]);
  assert.equal(decision.kind, "append");
  const payload = appendedPayload(decision) as Record<
    string,
    WorkflowJsonValue
  >;
  assert.deepEqual(payload.implementerReport, {
    summary: "done",
    notes: "fixer notes",
    responses: [
      { finding: "missing test", response: "added regression coverage" },
    ],
  });
});

test("the iteration limit is counted from history, and stops the loop", () => {
  const limitOne = run({ maxIterations: 1 });
  // First revise: nothing prior, so one rework round is still allowed.
  assert.equal(decideNextStep(limitOne, round("revise")).kind, "append");

  // Second revise: one revision already recorded, which is the limit.
  const twoRounds = [...round("revise"), ...round("revise")];
  assertCeilingGate(decideNextStep(limitOne, twoRounds), "iterations");

  // The same history under a higher limit keeps going: nothing is remembered
  // outside the steps themselves.
  assert.equal(
    decideNextStep(run({ maxIterations: 2 }), twoRounds).kind,
    "append",
  );
  assertCeilingGate(
    decideNextStep(run({ maxIterations: 2 }), [
      ...twoRounds,
      ...round("revise"),
    ]),
    "iterations",
  );
});

/* -------------------------- rebase conflict repair ------------------------- */

test("a blocked rebase conflict gets one implementer repair assignment", () => {
  const conflict = step({
    kind: "host-operation",
    payload: { operation: "commit-sync", idempotencyKey: "repair-1" },
    status: "blocked",
  });
  conflict.result = {
    status: "blocked",
    summary: "restored after conflict",
    payload: {
      rebaseConflict: {
        files: ["docs/reference/web-diff.md"],
        truncated: false,
        baseBranch: "main",
        originalHead: "a".repeat(40),
      },
    },
    submittedAt: 2,
  };

  assert.deepEqual(decideNextStep(run(), [implemented(), conflict]), {
    kind: "append",
    step: {
      kind: "agent",
      payload: {
        role: "implementer",
        objective: "repair-rebase",
        files: ["docs/reference/web-diff.md"],
        truncated: false,
        baseBranch: "main",
        originalHead: "a".repeat(40),
        resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
      },
      predecessorId: conflict.id,
    },
  });
});

test("a commit-sync retry chain rooted in repair cannot append another repair", () => {
  const repair = step({
    kind: "agent",
    payload: {
      role: "implementer",
      objective: "repair-rebase",
      files: ["conflict.ts"],
      truncated: false,
      baseBranch: "main",
      originalHead: "a".repeat(40),
      resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
    },
    contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
    resultPayload: {},
  });
  const conflict = step({
    kind: "host-operation",
    payload: { operation: "commit-sync", idempotencyKey: "repair-2" },
    status: "blocked",
    predecessorId: repair.id,
  });
  conflict.result = {
    status: "blocked",
    summary: "restored after conflict",
    payload: {
      rebaseConflict: {
        files: ["conflict.ts"],
        truncated: false,
        baseBranch: "main",
        originalHead: "a".repeat(40),
      },
    },
    submittedAt: 2,
  };
  const retry = {
    ...conflict,
    id: conflict.id + 1,
    predecessorId: conflict.id,
  };

  for (const history of [
    [repair, conflict],
    [repair, conflict, retry],
  ]) {
    const decision = decideNextStep(run(), history);
    assert.equal(decision.kind, "pause");
    assert.match(
      (decision as Extract<WorkflowDecision, { kind: "pause" }>).reason,
      /commit-sync step .* ended as blocked/,
    );
  }
});

test("a repair assignment that never reached its agent leaves the budget unspent", () => {
  const conflictPayload = {
    rebaseConflict: {
      files: ["conflict.ts"],
      truncated: false,
      baseBranch: "main",
      originalHead: "a".repeat(40),
    },
  };
  const undelivered = step({
    kind: "agent",
    payload: {
      role: "implementer",
      objective: "repair-rebase",
      files: ["conflict.ts"],
      truncated: false,
      baseBranch: "main",
      originalHead: "a".repeat(40),
      resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
    },
    status: "failed",
  });
  undelivered.result = {
    status: "failed",
    summary:
      "workflow assignment prompt failed: Session s is busy with an active run.",
    payload: { assignmentUndelivered: true },
    submittedAt: 2,
  };
  const conflict = step({
    kind: "host-operation",
    payload: { operation: "commit-sync", idempotencyKey: "repair-3" },
    status: "blocked",
    predecessorId: undelivered.id,
  });
  conflict.result = {
    status: "blocked",
    summary: "restored after conflict",
    payload: conflictPayload,
    submittedAt: 3,
  };

  // The refused assignment is walked past, so the episode still has its one
  // automatic repair — the same decision as a first conflict.
  assert.deepEqual(decideNextStep(run(), [undelivered, conflict]), {
    kind: "append",
    step: {
      kind: "agent",
      payload: {
        role: "implementer",
        objective: "repair-rebase",
        files: ["conflict.ts"],
        truncated: false,
        baseBranch: "main",
        originalHead: "a".repeat(40),
        resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
      },
      predecessorId: conflict.id,
    },
  });

  // A repair that DID get its turn and failed keeps spending the budget: the
  // mark, not the failed status, is what makes an attempt not count.
  const attempted = {
    ...undelivered,
    result: { ...undelivered.result, payload: {} },
  };
  const decision = decideNextStep(run(), [attempted, conflict]);
  assert.equal(decision.kind, "pause");
  assert.match(
    (decision as Extract<WorkflowDecision, { kind: "pause" }>).reason,
    /commit-sync step .* ended as blocked/,
  );
});

/* ------------------------------ ended badly -------------------------------- */

const BAD_ENDINGS: WorkflowStepStatus[] = ["blocked", "failed", "cancelled"];

for (const status of BAD_ENDINGS) {
  test(`a step that ended ${status} pauses the run naming it`, () => {
    const ended = step({
      kind: "agent",
      payload: { role: "implementer", objective: "implement" },
      status,
    });
    assert.deepEqual(decideNextStep(run(), [ended]), {
      kind: "pause",
      reason: `implement step ${ended.id} ended as ${status}`,
    });
  });
}

test("a retry that reproduced the same outcome pauses saying which attempt it is", () => {
  const blockedBy = (summary: string, predecessorId?: number) => {
    const row = step({
      kind: "host-operation",
      payload: {
        operation: "commit-sync",
        idempotencyKey: "wf7:commit-sync:1",
      },
      status: "blocked",
      ...(predecessorId !== undefined ? { predecessorId } : {}),
    });
    // A bare operation reports a status and a summary, no contract.
    return {
      ...row,
      result: { status: "blocked" as const, summary, submittedAt: 2 },
    };
  };
  const conflicted = "run rebase blocked: the rebase conflicted";
  const first = blockedBy(conflicted);
  const second = blockedBy(conflicted, first.id);
  // The repetition earns ONE automatic triage; the pause the user reads comes
  // after it, and the attempt count still counts operation attempts only.
  const triaged = triage(second, { predecessorId: second.id });
  const third = blockedBy(conflicted, triaged.id);

  assert.deepEqual(decideNextStep(run(), [implemented(), first]), {
    kind: "pause",
    reason: `commit-sync step ${first.id} ended as blocked`,
  });
  assert.deepEqual(
    decideNextStep(run(), [implemented(), first, second, triaged, third]),
    {
      kind: "pause",
      reason: `commit-sync step ${third.id} ended as blocked; attempt 3 with the same result`,
    },
  );

  // A result that differs at all is a NEW outcome: something the retry did, or
  // something the user repaired, changed what the step reported.
  const moved = blockedBy(
    "run rebase blocked: the checkout is dirty",
    first.id,
  );
  assert.deepEqual(decideNextStep(run(), [implemented(), first, moved]), {
    kind: "pause",
    reason: `commit-sync step ${moved.id} ended as blocked`,
  });
});

test("completing without the expected contract is ending without evidence", () => {
  const cases: Array<{ steps: WorkflowStepRow[]; contract: string }> = [
    {
      steps: [
        step({
          kind: "agent",
          payload: { role: "implementer", objective: "implement" },
        }),
      ],
      contract: IMPLEMENTATION_RESULT_CONTRACT_ID,
    },
    {
      steps: [
        implemented(),
        step({
          kind: "host-operation",
          payload: { operation: "commit-sync", idempotencyKey: "k" },
          contractId: COMMIT_SYNC_RESULT_CONTRACT_ID,
          // A range missing its head commit is not a range.
          resultPayload: { baseCommit: "aaa" },
        }),
      ],
      contract: COMMIT_SYNC_RESULT_CONTRACT_ID,
    },
    {
      steps: [
        implemented(),
        committed(),
        step({
          kind: "agent",
          payload: {
            role: "reviewer",
            commitRange: { baseCommit: "aaa", headCommit: "bbb" },
          },
          contractId: ASSESSMENT_CONTRACT_ID,
          // Review evidence must name the commit it assessed.
          resultPayload: { verdict: "pass", findings: [] },
        }),
      ],
      contract: ASSESSMENT_CONTRACT_ID,
    },
  ];
  for (const { steps, contract } of cases) {
    const decision = decideNextStep(run(), steps);
    assert.equal(decision.kind, "pause", contract);
    assert.match(
      (decision as { reason: string }).reason,
      new RegExp(`completed without a valid ${contract} result`),
    );
  }
});

test("a payload the recipe does not recognize pauses rather than guesses", () => {
  const stray = step({ kind: "wait", payload: { condition: "ci" } });
  const decision = decideNextStep(run(), [stray]);
  assert.equal(decision.kind, "pause");
  assert.match((decision as { reason: string }).reason, /does not recognize/);
});

/* ------------------------------- determinism ------------------------------- */

test("the same history always yields the same decision", () => {
  const histories: WorkflowStepRow[][] = [
    [],
    [implemented()],
    [implemented(), committed()],
    round("revise", { findings: [{ severity: "major", text: "again" }] }),
    round("pass"),
    [implemented(), committed(), reviewed("pass", { headCommit: "stale" })],
    [...round("revise"), ...round("fail")],
  ];
  for (const history of histories) {
    const before = structuredClone(history);
    const first: WorkflowDecision = decideNextStep(run(), history);
    const second = decideNextStep(run(), history);
    assert.deepEqual(second, first);
    // And the input is untouched: the decision reads history, never edits it.
    assert.deepEqual(history, before);
  }
});

test("an out-of-bounds routing answer sends the findings to the implementer", () => {
  const fixer = { ...TEST_MODEL, modelId: "gpt-fixer" };
  const configured = run({
    config: {
      coordinator: TEST_MODEL,
      roles: {
        implementer: [TEST_MODEL],
        reviewer: [TEST_MODEL],
        fixer: [fixer],
        verdict: [],
      },
    },
  });
  const review = reviewed("revise", {
    findings: [{ severity: "major", text: "guard it" }],
  });
  const history = [planned(), implemented(), committed(), review];
  const routing = appendedPayload(
    decideRecipeNextStep(configured, history),
  ) as Record<string, WorkflowJsonValue>;
  const routed = step({
    kind: "agent",
    payload: routing,
    contractId: REVIEW_DECISION_CONTRACT_ID,
    resultPayload: {
      decision: "fix",
      assignee: "fixer",
      // A runtime this run never authorized.
      fixer: { ...TEST_MODEL, modelId: "smuggled-in" },
      rationale: "not mine to give",
    },
  });
  const fix = appendedPayload(
    decideRecipeNextStep(configured, [...history, routed]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(fix.objective, "revise");
  assert.equal(fix.fixer, undefined, "the implementer takes it instead");
  assert.deepEqual(fix.findings, [{ severity: "major", text: "guard it" }]);
});

test("routing to the implementer keeps the findings out of a fixer session", () => {
  const fixer = { ...TEST_MODEL, modelId: "gpt-fixer" };
  const configured = run({
    config: {
      coordinator: TEST_MODEL,
      roles: {
        implementer: [TEST_MODEL],
        reviewer: [TEST_MODEL],
        fixer: [fixer],
        verdict: [],
      },
    },
  });
  const review = reviewed("revise", {
    findings: [{ severity: "critical", text: "this projection cannot exist" }],
  });
  const history = [planned(), implemented(), committed(), review];
  const routed = step({
    kind: "agent",
    payload: appendedPayload(decideRecipeNextStep(configured, history)),
    contractId: REVIEW_DECISION_CONTRACT_ID,
    resultPayload: {
      decision: "fix",
      assignee: "implementer",
      rationale: "the design is what is disputed",
    },
  });
  const fix = appendedPayload(
    decideRecipeNextStep(configured, [...history, routed]),
  ) as Record<string, WorkflowJsonValue>;
  // No FIXER is what keeps it out of a fixer session: that is the field the
  // executor keys the role by. The lineage travels either way — it records which
  // conversation the round answered, and the coordinator weighs rounds per
  // lineage — and `engine.test.ts` pins that an implementer-routed round with a
  // lineage still runs in the implementer's own session.
  assert.equal(fix.fixer, undefined);
  assert.equal(fix.fixerLineage, "pass-1");
});

test("a cleared re-check asks which fresh eyes read the fix", () => {
  const second = { ...CLAUDE_MODEL, modelId: "opus-second" };
  const configured = run({
    maxReviewPasses: 2,
    config: {
      coordinator: TEST_MODEL,
      roles: {
        implementer: [TEST_MODEL],
        reviewer: [TEST_MODEL, second],
        fixer: [],
        verdict: [],
      },
    },
  });
  const review = reviewed("revise", {
    findings: [{ severity: "major", text: "race" }],
  });
  const history = [planned(), implemented(), committed(), review];
  const fixed = step({
    kind: "agent",
    payload: appendedPayload(decideRecipeNextStep(configured, history)),
    contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
    resultPayload: { notes: "fixed" },
  });
  const fixCommit = checkpointed("commit");
  fixCommit.predecessorId = fixed.id;
  const reCheck = step({
    kind: "agent",
    payload: appendedPayload(
      decideRecipeNextStep(configured, [...history, fixed, fixCommit]),
    ),
    contractId: ASSESSMENT_CONTRACT_ID,
    resultPayload: { verdict: "pass", headCommit: "bbb", findings: [] },
  });
  const afterFix = [...history, fixed, fixCommit, reCheck];
  const asked = appendedPayload(
    decideRecipeNextStep(configured, afterFix),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(asked.question, "review-again", "delivering is not on offer");
  assert.deepEqual(asked.roles, { reviewer: [TEST_MODEL, second] });

  const decided = step({
    kind: "agent",
    payload: asked,
    contractId: REVIEW_DECISION_CONTRACT_ID,
    resultPayload: {
      decision: "review-again",
      reviewer: second,
      focus: ["the new baseline seeding"],
      rationale: "the fix is bigger than the build",
    },
  });
  const syncPayload = appendedPayload(
    decideRecipeNextStep(configured, [...afterFix, decided]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(syncPayload.operation, BASE_SYNC_OPERATION_ID);
  assert.equal(syncPayload.purpose, "discovery");
  assert.deepEqual(syncPayload.reviewer, second);
  assert.deepEqual(syncPayload.focus, ["the new baseline seeding"]);
  const sync = checkpointed("base-sync", { purpose: "discovery" });
  sync.payload = syncPayload;
  sync.predecessorId = decided.id;
  const pass2 = appendedPayload(
    decideRecipeNextStep(configured, [...afterFix, decided, sync]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(pass2.objective, "review");
  assert.equal(pass2.reviewPass, 2);
  assert.deepEqual(pass2.reviewer, second, "the named fresh eyes");
  assert.deepEqual(pass2.focus, ["the new baseline seeding"]);
});

test("a delivery naming no verdict still gets the gate its set configured", () => {
  const verdict = { ...CLAUDE_MODEL, modelId: "opus-verdict" };
  const configured = run({
    config: {
      coordinator: TEST_MODEL,
      roles: {
        implementer: [TEST_MODEL],
        reviewer: [TEST_MODEL],
        fixer: [],
        verdict: [verdict],
      },
    },
  });
  const passed = round("pass");
  const decision = step({
    kind: "agent",
    payload: {
      role: "coordinator",
      objective: "review-decision",
      question: "deliver-or-review",
      roles: { reviewer: [TEST_MODEL], verdict: [verdict] },
      commitRange: { baseCommit: "aaa", headCommit: "bbb" },
      assessmentStepId: passed[2]!.id,
      completedReviewPass: 1,
      maxReviewPasses: 1,
      resultContract: REVIEW_DECISION_CONTRACT_ID,
    },
    contractId: REVIEW_DECISION_CONTRACT_ID,
    resultPayload: { decision: "deliver", rationale: "looks right" },
  });
  const freshnessPayload = appendedPayload(
    decideNextStep(configured, [...passed, decision]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(freshnessPayload.operation, BASE_SYNC_OPERATION_ID);
  assert.deepEqual(freshnessPayload.verdict, verdict);
  const freshness = checkpointed("base-sync", { purpose: "delivery" });
  freshness.payload = freshnessPayload;
  freshness.predecessorId = decision.id;
  const next = appendedPayload(
    decideNextStep(configured, [...passed, decision, freshness]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(next.role, "verdict", "the configured judge is not dropped");
  assert.deepEqual(next.verdict, verdict);
});

test("routing evidence carries what each fix round actually wrote", () => {
  const fixer = { ...TEST_MODEL, modelId: "gpt-fixer" };
  const configured = run({
    maxIterations: 4,
    config: {
      coordinator: TEST_MODEL,
      roles: {
        implementer: [TEST_MODEL],
        reviewer: [TEST_MODEL],
        fixer: [fixer],
        verdict: [],
      },
    },
  });
  const sized = (
    base: string,
    head: string,
    insertions: number,
  ): WorkflowStepRow => {
    const commit = committed(base, head);
    commit.result = {
      ...commit.result!,
      payload: {
        baseCommit: base,
        headCommit: head,
        changes: {
          filesChanged: 5,
          insertions,
          deletions: 2,
          files: [{ path: "a.ts", insertions, deletions: 2 }],
          commitSubjects: ["fix"],
        },
      },
    };
    return commit;
  };

  const firstReview = reviewed("revise", {
    findings: [{ severity: "major", text: "race" }],
  });
  const history = [planned(), implemented(), committed(), firstReview];
  const routed = step({
    kind: "agent",
    payload: appendedPayload(decideRecipeNextStep(configured, history)),
    contractId: REVIEW_DECISION_CONTRACT_ID,
    resultPayload: {
      decision: "fix",
      assignee: "fixer",
      fixer,
      rationale: "a",
    },
  });
  const fixed = step({
    kind: "agent",
    payload: appendedPayload(
      decideRecipeNextStep(configured, [...history, routed]),
    ),
    contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
    // The fixer's own account of a rewrite it calls a tweak.
    resultPayload: { notes: "small tweak" },
  });
  const fixCommit = sized("aaa", "ccc", 520);
  fixCommit.predecessorId = fixed.id;
  const reCheck = step({
    kind: "agent",
    payload: appendedPayload(
      decideRecipeNextStep(configured, [...history, routed, fixed, fixCommit]),
    ),
    contractId: ASSESSMENT_CONTRACT_ID,
    resultPayload: {
      verdict: "revise",
      headCommit: "ccc",
      findings: [{ severity: "major", text: "still racy" }],
    },
  });

  // The next routing question weighs the round that just ran: the size comes
  // from the commit/sync that measured it, not from the fixer's prose.
  const next = appendedPayload(
    decideRecipeNextStep(configured, [
      ...history,
      routed,
      fixed,
      fixCommit,
      reCheck,
    ]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(next.question, "route-fix");
  assert.deepEqual(next.priorFixers, [
    {
      assignee: "fixer",
      fixer,
      // Which conversation the round answered. Without it "two rounds" cannot
      // be told apart from "two rounds on the same finding", which is the
      // re-implementation signal the prompt asks the coordinator to weigh.
      lineage: "pass-1",
      findingCount: 1,
      notes: "small tweak",
      changed: { filesChanged: 5, insertions: 520, deletions: 2 },
      // The re-check read this exact head and asked for more: rejected, which
      // the old single flag could not tell apart from nothing having looked.
      outcome: "rejected",
    },
  ]);
});

test("routing evidence says which findings earlier rounds already answered", () => {
  // The prompt tells the coordinator to route a finding a lineage has already
  // spent rounds on to the implementer, as re-implementation. Until now the
  // evidence could not support that: the round list said how many rounds
  // happened, never which finding they were spent on, so "two rounds" read the
  // same whether one finding kept coming back or two different ones were fixed.
  const fixer = { ...TEST_MODEL, modelId: "gpt-fixer" };
  const configured = run({
    maxIterations: 5,
    config: {
      coordinator: TEST_MODEL,
      roles: {
        implementer: [TEST_MODEL],
        reviewer: [TEST_MODEL],
        fixer: [fixer],
        verdict: [],
      },
    },
  });
  const [stubborn, settled] = published([
    { severity: "major", text: "the lock is missing on the retry path" },
    { severity: "minor", text: "the helper name reads oddly" },
  ]) as [ReviewFinding, ReviewFinding];

  /** One fix round handed exactly these threads. */
  const spentRound = (handed: ReviewFinding[]): WorkflowStepRow =>
    step({
      kind: "agent",
      payload: {
        role: "implementer",
        objective: "revise",
        reviewSetId: "set-1",
        fixer,
        fixerLineage: "pass-1",
        findings: handed as unknown as WorkflowJsonValue,
        resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
      },
      contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
      resultPayload: { notes: "tried" },
    });

  // Two rounds saw the stubborn finding; only the first also saw the other one,
  // which that round settled.
  const history = [
    planned(),
    implemented(),
    committed(),
    spentRound([stubborn, settled]),
    spentRound([stubborn]),
    reviewed("revise", { findings: [stubborn] }),
  ];
  const routing = appendedPayload(
    decideRecipeNextStep(configured, history),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(routing.question, "route-fix");
  assert.deepEqual(
    routing.findingRounds,
    [{ commentId: stubborn.commentId, rounds: 2 }],
    "counted per thread, and only for the finding actually being routed",
  );

  // A finding nobody has answered yet gets no ENTRY, so nothing marks it — but
  // the table itself is still there and empty, which is how the assignment can
  // tell "looked, found nothing" apart from "could not carry the table".
  const firstTime = published([
    { severity: "major", text: "a brand new problem" },
  ]);
  const fresh = appendedPayload(
    decideRecipeNextStep(configured, [
      planned(),
      implemented(),
      committed(),
      reviewed("revise", { findings: firstTime }),
    ]),
  ) as Record<string, WorkflowJsonValue>;
  assert.deepEqual(fresh.findingRounds, []);
});

test("a retried fix round is one round, not two, in the finding's count", () => {
  // The same rule `priorFixerRounds` follows: a semantic retry appends a
  // successor carrying the predecessor's exact payload, so counting both would
  // report a finding as one round deeper than the run actually took it — and
  // that count is what the coordinator weighs when deciding whether the
  // lineage is converging.
  const configured = run({
    maxIterations: 5,
    config: {
      coordinator: TEST_MODEL,
      roles: {
        implementer: [TEST_MODEL],
        reviewer: [TEST_MODEL],
        fixer: [{ ...TEST_MODEL, modelId: "gpt-fixer" }],
        verdict: [],
      },
    },
  });
  const [finding] = published([
    { severity: "major", text: "the lock is missing" },
  ]) as [ReviewFinding];
  const fixPayload = {
    role: "implementer",
    objective: "revise",
    reviewSetId: "set-1",
    findings: [finding] as unknown as WorkflowJsonValue,
    resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
  };
  const abandoned = step({ kind: "agent", payload: fixPayload });
  const retry = step({
    kind: "agent",
    payload: fixPayload,
    contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
    resultPayload: { notes: "second attempt" },
  });
  retry.predecessorId = abandoned.id;

  const routing = appendedPayload(
    decideRecipeNextStep(configured, [
      planned(),
      implemented(),
      committed(),
      abandoned,
      retry,
      reviewed("revise", { findings: [finding] }),
    ]),
  ) as Record<string, WorkflowJsonValue>;
  assert.deepEqual(routing.findingRounds, [
    { commentId: finding.commentId, rounds: 1 },
  ]);
});

test("a pressured routing payload drops the round counts whole", () => {
  // The counts are a lookup table joined to the findings by thread. Half of one
  // does not shorten the evidence — it relabels a finding three rounds deep as
  // one nobody has tried, because a renderer that cannot find an entry says
  // nothing. So it drops entire, and it drops EARLY: it is derived from history
  // the payload already carries, and the findings' own text is the one thing
  // this assignment may not economize to keep it.
  const anchored = published(maximalFindings());
  const configured = run({
    maxIterations: 4,
    config: {
      coordinator: TEST_MODEL,
      roles: {
        implementer: [TEST_MODEL],
        reviewer: [TEST_MODEL],
        fixer: [CLAUDE_MODEL],
        verdict: [],
      },
    },
  });
  const spent = (notes: string): WorkflowStepRow =>
    step({
      kind: "agent",
      payload: {
        role: "implementer",
        objective: "revise",
        reviewSetId: "set-1",
        fixer: CLAUDE_MODEL,
        fixerLineage: "pass-1",
        findings: anchored as unknown as WorkflowJsonValue,
        resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
      },
      contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
      resultPayload: { notes },
    });
  const historyWith = (notes: string): WorkflowStepRow[] => [
    planned(),
    implemented("i".repeat(3_000)),
    committed(),
    spent(notes),
    reviewed("revise", { findings: anchored, summary: "s".repeat(1_000) }),
  ];

  const routing = appendedPayload(
    decideRecipeNextStep(configured, historyWith("n".repeat(12_000))),
  );
  const record = routing as Record<string, WorkflowJsonValue>;
  assertAppendableRecipePayload(routing);
  assert.equal(
    record.findingRounds,
    undefined,
    "no partial lookup table reaches the coordinator",
  );
  assert.deepEqual(
    record.findings,
    anchored as unknown as WorkflowJsonValue[],
    "and it gave way for the findings' own text, not the reverse",
  );

  // The same history with room to spare DOES carry the counts, so the assertion
  // above is about pressure — not about a payload that never had them.
  const unpressured = appendedPayload(
    decideRecipeNextStep(configured, historyWith("brief")),
  ) as Record<string, WorkflowJsonValue>;
  assert.ok(
    Array.isArray(unpressured.findingRounds) &&
      unpressured.findingRounds.length === anchored.length,
    "a count for every finding when the payload has room for the table",
  );
});

test("a routing question carries an EMPTY round table rather than none", () => {
  // The absence of the key is what tells the assignment the table was dropped
  // under pressure, so "no finding has been answered before" may not be
  // expressed the same way: it is an empty table, not a missing one. Otherwise a
  // pressured assignment shows a finding several rounds deep exactly like a
  // fresh one, which is the defect this evidence exists to remove.
  const configured = run({
    config: {
      coordinator: TEST_MODEL,
      roles: {
        implementer: [TEST_MODEL],
        reviewer: [TEST_MODEL],
        fixer: [CLAUDE_MODEL],
        verdict: [],
      },
    },
  });
  const routing = appendedPayload(
    decideRecipeNextStep(configured, [
      planned(),
      implemented(),
      committed(),
      reviewed("revise", {
        findings: published([{ severity: "major", text: "a first problem" }]),
      }),
    ]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(routing.question, "route-fix");
  assert.deepEqual(routing.findingRounds, []);

  // And only the routing question: the other two are not choosing a fix round.
  const deciding = appendedPayload(
    decideRecipeNextStep(run({ maxReviewPasses: 2 }), [
      planned(),
      implemented(),
      committed(),
      reviewed("pass"),
    ]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(deciding.question, "deliver-or-review");
  assert.equal(deciding.findingRounds, undefined);
});

test("a raised ceiling resumes the move the run was blocked on", () => {
  const limitOne = run({ maxIterations: 1 });
  const blocked = [...round("revise"), ...round("revise")];
  const gate = step({
    kind: "agent",
    payload: appendedPayload(decideNextStep(limitOne, blocked)),
    status: "completed",
  });
  gate.kind = "user-decision";
  gate.result = {
    status: "completed",
    summary: "raised",
    payload: { choice: "raise", maxIterations: 3, maxReviewPasses: 1 },
    contractId: undefined as unknown as string,
    submittedAt: 1,
  } as unknown as NonNullable<typeof gate.result>;

  // The raise moved the bound; the recipe re-derives what it wanted to do
  // rather than remembering it, so the blocked fix round is simply appended.
  const resumed = appendedPayload(
    decideNextStep(run({ maxIterations: 3 }), [...blocked, gate]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(resumed.role, "implementer");
  assert.equal(resumed.objective, "revise");
});

test("delivering at a ceiling is the one route past the discovery precondition", () => {
  const configured = run({ maxIterations: 1 });
  const blocked = [...round("revise"), ...round("revise")];
  const asked = appendedPayload(decideNextStep(configured, blocked)) as Record<
    string,
    WorkflowJsonValue
  >;
  const gate = step({
    kind: "user-decision",
    payload: asked,
    status: "completed",
  });
  gate.result = {
    status: "completed",
    summary: "ship it",
    payload: { choice: "deliver", reviewedHeadCommit: "bbb" },
  } as unknown as NonNullable<typeof gate.result>;

  // No discovery review passed bbb — the recipe refuses that on its own, and
  // the user's recorded choice is what admits it. Freshness is still checked
  // before the gate.
  const freshnessPayload = appendedPayload(
    decideNextStep(configured, [...blocked, gate]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(freshnessPayload.operation, BASE_SYNC_OPERATION_ID);
  const freshness = checkpointed("base-sync", { purpose: "delivery" });
  freshness.payload = freshnessPayload;
  freshness.predecessorId = gate.id;
  const delivered = appendedPayload(
    decideNextStep(configured, [...blocked, gate, freshness]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(delivered.operation, "delivery-gate");
  assert.equal(delivered.reviewedHeadCommit, "bbb");
});

test("delivering at a ceiling still runs the judge the user configured", () => {
  // "As it stands" is about the CODE. An iterations ceiling is answered on a
  // head a discovery pass has already accepted, and "stop spending fix rounds"
  // is not "skip the verdict I configured" — the doc's own rule is that a
  // configured judge is filled in rather than dropped.
  const verdict = { ...CLAUDE_MODEL, modelId: "opus-verdict" };
  const configured = run({
    maxIterations: 1,
    config: {
      coordinator: TEST_MODEL,
      roles: {
        implementer: [TEST_MODEL],
        reviewer: [TEST_MODEL],
        fixer: [],
        verdict: [verdict],
      },
    },
  });
  // The two facts this turns on: the run is out of fix rounds, and a discovery
  // pass has accepted the head being delivered. The gate is the one a spent
  // iterations ceiling opens; the accepted head is what makes a judge possible.
  const spent = [...round("revise"), ...round("revise")];
  const accepted = reviewed("pass");
  const blocked = [...spent, accepted];
  const gate = step({
    kind: "user-decision",
    payload: appendedPayload(decideNextStep(configured, spent)),
    status: "completed",
  });
  gate.result = {
    status: "completed",
    summary: "ship it",
    payload: { choice: "deliver", reviewedHeadCommit: "bbb" },
  } as unknown as NonNullable<typeof gate.result>;

  const freshnessPayload = appendedPayload(
    decideNextStep(configured, [...blocked, gate]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(freshnessPayload.operation, BASE_SYNC_OPERATION_ID);
  assert.deepEqual(freshnessPayload.verdict, verdict);
  const freshness = checkpointed("base-sync", { purpose: "delivery" });
  freshness.payload = freshnessPayload;
  freshness.predecessorId = gate.id;
  const judged = appendedPayload(
    decideNextStep(configured, [...blocked, gate, freshness]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(judged.role, "verdict");
  assert.deepEqual(judged.verdict, verdict);

  // And answering the gate again cannot buy a second one: the head has been
  // judged, so the next answer goes to the gate itself.
  const spoken = step({
    kind: "agent",
    payload: judged,
    contractId: ASSESSMENT_CONTRACT_ID,
    resultPayload: { verdict: "pass", headCommit: "bbb", findings: [] },
  });
  const again = step({
    kind: "user-decision",
    payload: gate.payload,
    status: "completed",
  });
  again.result = gate.result!;
  const secondFreshnessPayload = appendedPayload(
    decideNextStep(configured, [...blocked, gate, freshness, spoken, again]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(secondFreshnessPayload.operation, BASE_SYNC_OPERATION_ID);
  const secondFreshness = checkpointed("base-sync", { purpose: "delivery" });
  secondFreshness.payload = secondFreshnessPayload;
  secondFreshness.predecessorId = again.id;
  const delivered = appendedPayload(
    decideNextStep(configured, [
      ...blocked,
      gate,
      freshness,
      spoken,
      again,
      secondFreshness,
    ]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(delivered.operation, "delivery-gate");
});

test("delivering a head no discovery pass read ships without a judge", () => {
  // The other half of the same choice: with no passing discovery review there
  // is nothing for a verdict to judge — it only ever runs on a head a discovery
  // pass accepted — so "as it stands" means exactly that.
  const verdict = { ...CLAUDE_MODEL, modelId: "opus-verdict" };
  const configured = run({
    maxIterations: 1,
    config: {
      coordinator: TEST_MODEL,
      roles: {
        implementer: [TEST_MODEL],
        reviewer: [TEST_MODEL],
        fixer: [],
        verdict: [verdict],
      },
    },
  });
  const blocked = [...round("revise"), ...round("revise")];
  const gate = step({
    kind: "user-decision",
    payload: appendedPayload(decideNextStep(configured, blocked)),
    status: "completed",
  });
  gate.result = {
    status: "completed",
    summary: "ship it",
    payload: { choice: "deliver", reviewedHeadCommit: "bbb" },
  } as unknown as NonNullable<typeof gate.result>;

  const freshnessPayload = appendedPayload(
    decideNextStep(configured, [...blocked, gate]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(freshnessPayload.operation, BASE_SYNC_OPERATION_ID);
  const freshness = checkpointed("base-sync", { purpose: "delivery" });
  freshness.payload = freshnessPayload;
  freshness.predecessorId = gate.id;
  const delivered = appendedPayload(
    decideNextStep(configured, [...blocked, gate, freshness]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(delivered.operation, "delivery-gate");
});

test("cancelling at a ceiling stops the run with the user's reason", () => {
  const configured = run({ maxIterations: 1 });
  const blocked = [...round("revise"), ...round("revise")];
  const gate = step({
    kind: "user-decision",
    payload: appendedPayload(decideNextStep(configured, blocked)),
    status: "completed",
  });
  gate.result = {
    status: "completed",
    summary: "no",
    payload: { choice: "cancel" },
  } as unknown as NonNullable<typeof gate.result>;
  const decision = decideNextStep(configured, [...blocked, gate]);
  assert.equal(decision.kind, "pause");
  assert.match(
    (decision as Extract<WorkflowDecision, { kind: "pause" }>).reason,
    /cancelled the run at its ceiling/,
  );
});

test("a ceiling at the delivery loop offers the head the workspace has", () => {
  // The gate refused because the workspace moved under the review. What
  // "as it stands" would ship is what is THERE now, so the decision names the
  // observed head rather than offering a choice with nothing behind it.
  const configured = run({ maxIterations: 1 });
  const history = [
    ...round("revise"),
    ...round("revise"),
    delivered("delivery-gate", DELIVERY_GATE_RESULT_CONTRACT_ID, {
      outcome: "review-required",
      reviewedHeadCommit: "bbb",
      observedHeadCommit: "ddd",
      worktreeDirty: false,
      reason: "the worktree moved after review",
    }),
  ];
  const decision = decideNextStep(configured, history);
  assert.equal(decision.kind, "append");
  const gate = appendedPayload(decision) as Record<string, WorkflowJsonValue>;
  assert.equal(gate.decision, "raise-ceilings");
  assert.equal(gate.reviewedHeadCommit, "ddd", "what is there now");
  assert.deepEqual(gate.allowedChoices, ["raise", "deliver", "cancel"]);
  assert.equal(
    gate.headCarriesDiscoveryReview,
    false,
    "and the card says plainly that no pass accepted it",
  );
});

test("a dirty worktree at the ceiling has no commit to offer", () => {
  // Same refusal, different state: the observed head exists, but uncommitted
  // work is in no commit, so "as it stands" would ship something the user did
  // not mean and the gate would refuse again. Only raise and cancel are real.
  const gate = appendedPayload(
    decideNextStep(run({ maxIterations: 1 }), [
      ...round("revise"),
      ...round("revise"),
      delivered("delivery-gate", DELIVERY_GATE_RESULT_CONTRACT_ID, {
        outcome: "review-required",
        reviewedHeadCommit: "bbb",
        observedHeadCommit: "ddd",
        worktreeDirty: true,
        reason: "the run worktree has uncommitted changes",
      }),
    ]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(gate.decision, "raise-ceilings");
  // The workspace is what refused, so the user can fix it and have the run
  // look again — the one gate where a fresh observation can answer differently.
  assert.deepEqual(gate.allowedChoices, ["raise", "re-evaluate", "cancel"]);
  assert.equal(gate.reviewedHeadCommit, undefined);
});

test("a ceiling with nothing to ship does not offer to ship it", () => {
  // Not every block has a head behind it: a stale pass whose own step never
  // recorded a range leaves the recipe nothing to deliver. The gate then offers
  // only what it can carry out, so the user never reaches a dead end.
  const rangeless = step({
    kind: "agent",
    payload: {
      role: "reviewer",
      objective: "review",
      resultContract: ASSESSMENT_CONTRACT_ID,
    },
    contractId: ASSESSMENT_CONTRACT_ID,
    resultPayload: { verdict: "pass", headCommit: "ccc", findings: [] },
  });
  const gate = appendedPayload(
    decideNextStep(run({ maxIterations: 0 }), [
      implemented(),
      committed(),
      rangeless,
    ]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(gate.decision, "raise-ceilings");
  assert.deepEqual(gate.allowedChoices, ["raise", "cancel"]);
  assert.equal(gate.reviewedHeadCommit, undefined);
});

test("a head with no discovery review buys one instead of gating", () => {
  // The path that used to strand a run: a stale verdict re-issued onto a
  // recomputed range passes a head no discovery pass has read. The recipe owes
  // that head fresh eyes, and while the ceiling allows it BUYS them — a gate
  // here would ask the user for a pass the run could take itself, and no raise
  // would ever produce it.
  const verdict = { ...CLAUDE_MODEL, modelId: "opus-verdict" };
  const configured = run({ maxReviewPasses: 3, maxIterations: 4 });
  const verdictStep = step({
    kind: "agent",
    payload: {
      role: "verdict",
      objective: "verdict",
      commitRange: { baseCommit: "aaa", headCommit: "ccc" },
      verdict,
      resultContract: ASSESSMENT_CONTRACT_ID,
    },
    contractId: ASSESSMENT_CONTRACT_ID,
    resultPayload: { verdict: "pass", headCommit: "ccc", findings: [] },
  });
  const decision = decideNextStep(configured, [
    ...round("pass"),
    committed("aaa", "ccc"),
    verdictStep,
  ]);
  const next = appendedPayload(decision) as Record<string, WorkflowJsonValue>;
  assert.equal(next.role, "reviewer");
  assert.equal(next.objective, "review", "fresh eyes, not a question");
  assert.deepEqual(next.commitRange, { baseCommit: "aaa", headCommit: "ccc" });
  assert.equal(next.reviewPass, 2);
});

test("the same head gates only once the pass ceiling truly blocks", () => {
  const verdict = { ...CLAUDE_MODEL, modelId: "opus-verdict" };
  const capped = run({ maxReviewPasses: 1, maxIterations: 4 });
  const verdictStep = step({
    kind: "agent",
    payload: {
      role: "verdict",
      objective: "verdict",
      commitRange: { baseCommit: "aaa", headCommit: "ccc" },
      verdict,
      resultContract: ASSESSMENT_CONTRACT_ID,
    },
    contractId: ASSESSMENT_CONTRACT_ID,
    resultPayload: { verdict: "pass", headCommit: "ccc", findings: [] },
  });
  const history = [...round("pass"), committed("aaa", "ccc"), verdictStep];
  const gate = assertCeilingGate(
    decideNextStep(capped, history),
    "review-passes",
  );
  assert.equal(gate.reviewedHeadCommit, "ccc");

  // And raising it produces the review the gate asked for, rather than the
  // same gate again.
  const raised = step({
    kind: "user-decision",
    payload: gate,
    status: "completed",
  });
  raised.result = {
    status: "completed",
    summary: "raised",
    payload: { choice: "raise", maxIterations: 4, maxReviewPasses: 2 },
  } as unknown as NonNullable<typeof raised.result>;
  const next = appendedPayload(
    decideNextStep(run({ maxReviewPasses: 2, maxIterations: 4 }), [
      ...history,
      raised,
    ]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(next.objective, "review");
  assert.equal(next.reviewPass, 2);
});

test("a verdict-routed fix never shares a fixer session with a review pass", () => {
  // The lineage key is the AUTHOR's identity, not a number that a verdict and a
  // reviewer could both land on.
  const fixer = { ...TEST_MODEL, modelId: "gpt-fixer" };
  const verdictAuthored = step({
    kind: "agent",
    payload: {
      role: "verdict",
      objective: "verdict",
      commitRange: { baseCommit: "aaa", headCommit: "bbb" },
      resultContract: ASSESSMENT_CONTRACT_ID,
    },
    contractId: ASSESSMENT_CONTRACT_ID,
    resultPayload: {
      verdict: "revise",
      headCommit: "bbb",
      findings: [{ severity: "major", text: "not resolved" }],
    },
  });
  const configured = run({
    config: {
      coordinator: TEST_MODEL,
      roles: {
        implementer: [TEST_MODEL],
        reviewer: [TEST_MODEL],
        fixer: [fixer],
        verdict: [TEST_MODEL],
      },
    },
  });
  const routed = step({
    kind: "agent",
    payload: appendedPayload(
      decideRecipeNextStep(configured, [
        planned(),
        implemented(),
        committed(),
        verdictAuthored,
      ]),
    ),
    contractId: REVIEW_DECISION_CONTRACT_ID,
    resultPayload: {
      decision: "fix",
      assignee: "fixer",
      fixer,
      rationale: "x",
    },
  });
  const fix = appendedPayload(
    decideRecipeNextStep(configured, [
      planned(),
      implemented(),
      committed(),
      verdictAuthored,
      routed,
    ]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(fix.fixerLineage, "verdict", "its own name, not a pass number");
});

test("look again re-observes the workspace instead of re-reading the refusal", () => {
  // The recipe is pure: re-deriving would read the PERSISTED dirty refusal and
  // reach the same conclusion about a workspace the user has since fixed, so
  // the answer has to run the gate that looks at it again.
  const configured = run({ maxIterations: 1 });
  const refusal = delivered("delivery-gate", DELIVERY_GATE_RESULT_CONTRACT_ID, {
    outcome: "review-required",
    reviewedHeadCommit: "bbb",
    observedHeadCommit: "bbb",
    worktreeDirty: true,
    reason: "the run worktree has uncommitted changes",
  });
  const history = [...round("revise"), ...round("revise"), refusal];
  const gate = appendedPayload(decideNextStep(configured, history)) as Record<
    string,
    WorkflowJsonValue
  >;
  assert.deepEqual(gate.allowedChoices, ["raise", "re-evaluate", "cancel"]);

  const answered = step({
    kind: "user-decision",
    payload: gate,
    status: "completed",
    predecessorId: refusal.id,
  });
  answered.result = {
    status: "completed",
    summary: "look again",
    payload: { choice: "re-evaluate" },
  } as unknown as NonNullable<typeof answered.result>;
  const next = appendedPayload(
    decideNextStep(configured, [...history, answered]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(next.operation, "delivery-gate", "the workspace is read again");
  assert.equal(next.reviewedHeadCommit, "bbb");
  assert.notEqual(
    next.idempotencyKey,
    (refusal.payload as Record<string, unknown>).idempotencyKey,
    "a fresh observation, not the recorded one",
  );
});

test("a CI round continues in the fixer session already doing the work", () => {
  // The lineage marker travels whatever shape it has, or the CI round opens a
  // session beside the fixer instead of continuing in it.
  const fixer = { ...TEST_MODEL, modelId: "gpt-fixer" };
  const configured = run({
    maxIterations: 4,
    config: {
      coordinator: TEST_MODEL,
      roles: {
        implementer: [TEST_MODEL],
        reviewer: [TEST_MODEL],
        fixer: [fixer],
        verdict: [],
      },
      earlyPush: true,
    },
  });
  const review = reviewed("revise", {
    findings: [{ severity: "major", text: "race" }],
  });
  const history = [planned(), implemented(), committed(), review];
  const routed = step({
    kind: "agent",
    payload: appendedPayload(decideRecipeNextStep(configured, history)),
    contractId: REVIEW_DECISION_CONTRACT_ID,
    resultPayload: {
      decision: "fix",
      assignee: "fixer",
      fixer,
      rationale: "x",
    },
  });
  const fix = step({
    kind: "agent",
    payload: appendedPayload(
      decideRecipeNextStep(configured, [...history, routed]),
    ),
    contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
    resultPayload: { notes: "fixed" },
  });
  const fixCommit = committed("aaa", "ccc");
  fixCommit.predecessorId = fix.id;
  const red = observedCi("red", "ccc");
  red.predecessorId = fixCommit.id;
  const ciFix = appendedPayload(
    decideRecipeNextStep(configured, [...history, routed, fix, fixCommit, red]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(ciFix.findingSource, "ci");
  assert.deepEqual(ciFix.fixer, fixer);
  assert.equal(
    ciFix.fixerLineage,
    "pass-1",
    "the same conversation, not a new session",
  );
});

test("a fix round broken by CI is not reported as accepted", () => {
  // Round 1 produced a head CI rejected; round 2 fixed it and was accepted.
  // Reading position instead of the commit let round 1 borrow round 2's
  // assessment — telling the coordinator that a fixer which broke the build was
  // accepted, which is the very evidence it routes on.
  const fixer = { ...TEST_MODEL, modelId: "gpt-fixer" };
  const configured = run({
    maxIterations: 5,
    config: {
      coordinator: TEST_MODEL,
      roles: {
        implementer: [TEST_MODEL],
        reviewer: [TEST_MODEL],
        fixer: [fixer],
        verdict: [],
      },
      earlyPush: true,
    },
  });
  const fixRound = (reviewedCommit: string, ci: boolean): WorkflowStepRow =>
    step({
      kind: "agent",
      payload: {
        role: "implementer",
        objective: "revise",
        reviewedCommit,
        ...(ci ? { findingSource: "ci" } : {}),
        findings: [{ severity: "major", text: "something" }],
        fixer,
        fixerLineage: "pass-1",
        resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
      },
      contractId: IMPLEMENTATION_RESULT_CONTRACT_ID,
      resultPayload: { notes: ci ? "green now" : "first attempt" },
    });
  // Built in the order they happened AND chained the way the recipe chains
  // them: the evidence follows causality, not position.
  const firstFix = fixRound("bbb", false);
  const firstCommit = committed("aaa", "ccc");
  firstCommit.predecessorId = firstFix.id;
  const red = observedCi("red", "ccc");
  red.predecessorId = firstCommit.id;
  const secondFix = fixRound("ccc", true);
  secondFix.predecessorId = red.id;
  const secondCommit = committed("aaa", "ddd");
  secondCommit.predecessorId = secondFix.id;
  const history = [
    planned(),
    implemented(),
    committed(),
    reviewed("revise"),
    firstFix,
    firstCommit,
    red,
    secondFix,
    secondCommit,
  ];
  const cleared = step({
    kind: "agent",
    payload: {
      role: "reviewer",
      objective: "re-check",
      commitRange: { baseCommit: "aaa", headCommit: "ddd" },
      reviewPass: 1,
      findings: [],
      resultContract: ASSESSMENT_CONTRACT_ID,
    },
    contractId: ASSESSMENT_CONTRACT_ID,
    resultPayload: { verdict: "pass", headCommit: "ddd", findings: [] },
  });
  const nextReview = reviewed("revise", {
    headCommit: "ddd",
    findings: [{ severity: "major", text: "one more thing" }],
  });
  nextReview.payload = {
    ...(nextReview.payload as Record<string, WorkflowJsonValue>),
    commitRange: { baseCommit: "aaa", headCommit: "ddd" },
  };

  const routing = appendedPayload(
    decideRecipeNextStep(configured, [...history, cleared, nextReview]),
  ) as Record<string, WorkflowJsonValue>;
  assert.equal(routing.question, "route-fix");
  const rounds = routing.priorFixers as Record<string, WorkflowJsonValue>[];
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0]!.outcome, "unjudged", "the round CI rejected");
  assert.equal(rounds[0]!.ciRed, true, "and the evidence says why");
  assert.equal(rounds[1]!.outcome, "accepted", "the round that was accepted");
  assert.equal(rounds[1]!.ciRed, undefined);
});

test("a reproduced host-operation failure earns one triage, then pauses", () => {
  const failedBy = (summary: string, predecessorId?: number) => {
    const row = step({
      kind: "host-operation",
      payload: {
        operation: COMMIT_SYNC_OPERATION_ID,
        idempotencyKey: "wf7:commit-sync:1",
      },
      status: "failed",
      ...(predecessorId !== undefined ? { predecessorId } : {}),
    });
    return {
      ...row,
      result: { status: "failed" as const, summary, submittedAt: 2 },
    };
  };
  const rejected = "push rejected: non-fast-forward";
  const first = failedBy(rejected);
  const second = failedBy(rejected, first.id);

  // One attempt is just a failure: nothing says it is deterministic yet.
  assert.deepEqual(decideNextStep(run(), [implemented(), first]), {
    kind: "pause",
    reason: `commit-sync step ${first.id} ended as failed`,
  });

  // The retry reproduced it, so the implementer gets the exact failure text.
  const assigned = decideNextStep(run(), [implemented(), first, second]);
  assert.deepEqual(assigned, {
    kind: "append",
    step: {
      kind: "agent",
      payload: {
        role: "implementer",
        objective: "triage-operation",
        failedOperation: {
          operation: COMMIT_SYNC_OPERATION_ID,
          phase: "commit-sync",
          stepId: second.id,
          status: "failed",
          summary: rejected,
          attempts: 2,
          idempotencyKey: "wf7:commit-sync:1",
        },
        resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
      },
      predecessorId: second.id,
    },
  });

  // A completed triage hands the SAME operation payload back, re-reserved
  // against itself so the runtime reads one direct-predecessor reservation.
  const spent = triage(second, { predecessorId: second.id });
  assert.deepEqual(
    decideNextStep(run(), [implemented(), first, second, spent]),
    {
      kind: "append",
      step: {
        kind: "host-operation",
        payload: {
          operation: COMMIT_SYNC_OPERATION_ID,
          idempotencyKey: operationIdempotencyKey(
            RUN_ID,
            COMMIT_SYNC_OPERATION_ID,
            spent.id,
          ),
        },
        predecessorId: spent.id,
      },
    },
  );

  // And the budget is one per episode: the operation failing again pauses.
  const third = failedBy(rejected, spent.id);
  assert.deepEqual(
    decideNextStep(run(), [implemented(), first, second, spent, third]),
    {
      kind: "pause",
      reason: `commit-sync step ${third.id} ended as failed; attempt 3 with the same result`,
    },
  );
  assert.equal(
    spentOperationTriageOf([implemented(), first, second, spent, third], third)
      ?.id,
    spent.id,
  );
});

test("a triage the runtime never delivered leaves the episode's budget unspent", () => {
  const failedBy = (predecessorId?: number) => {
    const row = step({
      kind: "host-operation",
      payload: {
        operation: COMMIT_SYNC_OPERATION_ID,
        idempotencyKey: "wf7:commit-sync:1",
      },
      status: "failed",
      ...(predecessorId !== undefined ? { predecessorId } : {}),
    });
    return {
      ...row,
      result: {
        status: "failed" as const,
        summary: "provider said no",
        submittedAt: 2,
      },
    };
  };
  const first = failedBy();
  const second = failedBy(first.id);
  const refused = triage(second, {
    predecessorId: second.id,
    status: "failed",
    undelivered: true,
  });
  const third = failedBy(refused.id);

  const decision = decideNextStep(run(), [
    implemented(),
    first,
    second,
    refused,
    third,
  ]);
  assert.equal(decision.kind, "append");
  assert.equal(
    (appendedPayload(decision) as Record<string, WorkflowJsonValue>).objective,
    "triage-operation",
  );
});

test("a restored rebase conflict keeps its own repair instead of a triage", () => {
  const conflicted = (predecessorId?: number) =>
    ({
      ...step({
        kind: "host-operation",
        payload: {
          operation: COMMIT_SYNC_OPERATION_ID,
          idempotencyKey: "wf7:commit-sync:1",
        },
        status: "blocked",
        ...(predecessorId !== undefined ? { predecessorId } : {}),
      }),
      result: {
        status: "blocked" as const,
        summary: "the rebase conflicted",
        payload: {
          rebaseConflict: {
            files: ["a.ts"],
            truncated: false,
            baseBranch: "main",
            originalHead: "a".repeat(40),
          },
        },
        submittedAt: 2,
      },
    }) satisfies WorkflowStepRow;
  const first = conflicted();
  const second = conflicted(first.id);

  const decision = decideNextStep(run(), [implemented(), first, second]);
  assert.equal(decision.kind, "append");
  assert.equal(
    (appendedPayload(decision) as Record<string, WorkflowJsonValue>).objective,
    "repair-rebase",
  );
});

test("a CI observation re-issued after a triage still anchors to its exact range", () => {
  const synced = step({
    kind: "host-operation",
    payload: {
      operation: COMMIT_SYNC_OPERATION_ID,
      idempotencyKey: commitSyncIdempotencyKey(RUN_ID, 1),
    },
    contractId: COMMIT_SYNC_RESULT_CONTRACT_ID,
    resultPayload: {
      operation: "commit-sync",
      baseCommit: "b".repeat(40),
      headCommit: "c".repeat(40),
    },
  });
  const ciKey = operationIdempotencyKey(
    RUN_ID,
    CI_OBSERVATION_OPERATION_ID,
    synced.id,
  );
  const failedCi = {
    ...step({
      kind: "host-operation",
      payload: {
        operation: CI_OBSERVATION_OPERATION_ID,
        idempotencyKey: ciKey,
        reviewedHeadCommit: "c".repeat(40),
      },
      status: "failed",
      predecessorId: synced.id,
    }),
    result: {
      status: "failed" as const,
      summary: "push rejected: non-fast-forward",
      submittedAt: 2,
    },
  };
  const spent = triage(failedCi, { predecessorId: failedCi.id });
  const green = step({
    kind: "host-operation",
    payload: {
      operation: CI_OBSERVATION_OPERATION_ID,
      idempotencyKey: operationIdempotencyKey(
        RUN_ID,
        CI_OBSERVATION_OPERATION_ID,
        spent.id,
      ),
      reviewedHeadCommit: "c".repeat(40),
    },
    predecessorId: spent.id,
    contractId: CI_OBSERVATION_RESULT_CONTRACT_ID,
    resultPayload: {
      outcome: "green",
      headCommit: "c".repeat(40),
      checks: [],
    },
  });

  const decision = decideNextStep(run(), [
    implemented(),
    synced,
    failedCi,
    spent,
    green,
  ]);
  assert.equal(decision.kind, "append", JSON.stringify(decision));
  assert.equal(
    (appendedPayload(decision) as Record<string, WorkflowJsonValue>).role,
    "reviewer",
  );
});
