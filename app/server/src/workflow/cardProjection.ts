import {
  compareReviewFindings,
  isTerminalWorkflowStepStatus,
  type ReviewFinding,
  type WorkflowJsonValue,
  type WorkflowRunCard,
} from "@assistant/shared";
import type { WorkflowRunRow, WorkflowStepRow } from "../db/workflowStore.ts";
import {
  CODE_DELIVERY_RECIPE_ID,
  CODE_DELIVERY_RECIPE_VERSION,
  acceptedWorkPlan,
  countIterations,
  decideNextStep,
  findingResolutionsOf,
  identicalTailAttempts,
  isRecheckablePullRequestObservation,
  isStaleAssessment,
  ceilingDecisionPayloadOf,
  mergeDecisionPayloadOf,
  phaseOf,
  rebaseConflictOf,
  rebaseRepairSafetyOf,
  operationTriagePayloadOf,
  operationTriageSafetyOf,
  spentOperationTriageOf,
  repairRebasePayloadOf,
  type RecipePhase,
  type WorkflowDecision,
} from "./codeDeliveryRecipe.ts";
import {
  ASSESSMENT_CONTRACT_ID,
  PUBLISH_PULL_REQUEST_RESULT_CONTRACT_ID,
  REVIEW_DECISION_CONTRACT_ID,
  PULL_REQUEST_OBSERVATION_RESULT_CONTRACT_ID,
  readStepResult,
  type WorkPlanRoleConfig,
} from "./resultContracts.ts";

const PHASE_ACTION: Record<RecipePhase, string> = {
  plan: "planning",
  implement: "implementation",
  "commit-sync": "commit and sync",
  commit: "commit",
  "base-sync": "base sync",
  ci: "push and CI observation",
  review: "review",
  "review-decision": "the coordinator's post-assessment decision",
  "ceiling-decision": "your decision at the run's ceiling",
  delivery: "delivery",
  observe: "CI and pull request observation",
  merge: "merge decision",
};

/**
 * Workflow list/read projections bound repeated prose and collections here
 * rather than trusting them to stay small. The originating session/store keeps
 * the complete value; each projection says when it stopped short.
 */
export const WORKFLOW_PROJECTION_MAX_LIST_ITEMS = 20;
const WORKFLOW_PROJECTION_MAX_ITEM_CHARS = 300;

function sortReviewFindings(
  findings: readonly ReviewFinding[],
): ReviewFinding[] {
  return [...findings].sort(compareReviewFindings);
}

/**
 * The newest review set that published FINDINGS, with what the fix round it was
 * handed recorded. Both halves come from step results, so the card describes
 * evidence the run holds — the worktree's review surface, not this card, is
 * where the live thread state is read.
 *
 * Newest-with-findings rather than simply newest: an accepting pass publishes an
 * approving set with nothing in it, and a verdict pass publishes one after every
 * successful fix round. Keying on the newest set would replace the answered
 * discovery findings with those zeroes exactly when the run finishes — losing
 * the resolved/disputed record precisely where a reader goes looking for it —
 * while a verdict that asks for MORE changes still takes the card over, because
 * its set is then the one a fix round is answering.
 */
function reviewSetRollup(
  steps: readonly WorkflowStepRow[],
): WorkflowRunCard["reviewSet"] {
  const published = [...steps].reverse().find((step) => {
    if (phaseOf(step) !== "review") return false;
    const assessment = readStepResult(step, ASSESSMENT_CONTRACT_ID);
    return Boolean(
      assessment?.reviewSetId &&
      assessment.findings.some((finding) => finding.commentId),
    );
  });
  if (!published) return undefined;
  const assessment = readStepResult(published, ASSESSMENT_CONTRACT_ID)!;
  const id = assessment.reviewSetId!;
  const settled = settlementRollup(steps, id);
  if (settled) return settled;
  const findingCount = assessment.findings.filter(
    (finding) => finding.commentId,
  ).length;
  const resolutions = findingResolutionsOf(steps, id);
  const counted = (state: string) =>
    resolutions.filter((resolution) => resolution.state === state).length;
  const resolvedCount = counted("resolved");
  const disputedCount = counted("disputed");
  return {
    id,
    findingCount,
    resolvedCount,
    disputedCount,
    // Findings nobody has answered yet, including a set no fix round has seen.
    openCount: Math.max(findingCount - resolvedCount - disputedCount, 0),
  };
}

/**
 * The set's counts once its AUTHOR has re-checked it — the last word on every
 * thread, and the one the fix round's own record cannot express. A re-check
 * resolves each thread it accepted and reopens each one it restated, so after it
 * runs the middle state is gone: nothing stays "answered and open" once the only
 * party entitled to judge an answer has judged it. Reading the fix round's
 * snapshot instead would keep announcing disputes the author already accepted,
 * and would size the set by whichever assessment happened to be newest rather
 * than by its threads.
 *
 * The counts are the SETTLEMENT SNAPSHOT the re-check's result carries: what the
 * server read back off the threads once settlement had run, not the disposition
 * settlement set out to reach. Settlement is best-effort per thread — a reply or
 * a resolution that fails is warned and skipped — so deriving these counts from
 * the assessment would have the card announce a transition that never landed. A
 * thread whose resolution failed still reads open here, which is what the user
 * sees on the review surface, and a thread that has gone away is in neither.
 */
function settlementRollup(
  steps: readonly WorkflowStepRow[],
  id: string,
): WorkflowRunCard["reviewSet"] {
  let settlement: readonly { state: string }[] | undefined;
  for (const step of steps) {
    if (phaseOf(step) !== "review") continue;
    const assessment = readStepResult(step, ASSESSMENT_CONTRACT_ID);
    if (assessment?.reviewSetId !== id || !assessment.settlement) continue;
    settlement = assessment.settlement;
  }
  if (!settlement) return undefined;
  const counted = (state: string) =>
    settlement.filter((entry) => entry.state === state).length;
  return {
    id,
    findingCount: settlement.length,
    resolvedCount: counted("resolved"),
    disputedCount: counted("disputed"),
    openCount: counted("open"),
  };
}

function projectedRoleConfig(
  config: WorkPlanRoleConfig,
): NonNullable<WorkflowRunCard["workPlan"]>["implementer"] {
  return {
    provider: config.provider,
    modelId: config.modelId,
    thinkingLevel: config.thinkingLevel,
    family: config.family,
    ...(config.notes ? { notes: config.notes } : {}),
  };
}

function payloadOf(
  step: WorkflowStepRow,
): Record<string, WorkflowJsonValue> | undefined {
  const payload = step.payload;
  return typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload)
    ? payload
    : undefined;
}

/** Reviewers are per-pass; the other runtime roles are singular. */
function newestSessionForRole(
  steps: readonly WorkflowStepRow[],
  role: "coordinator" | "implementer" | "fixer" | "verdict",
): string | undefined {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]!;
    const payload = payloadOf(step);
    if (step.kind !== "agent" || step.executor?.kind !== "session" || !payload)
      continue;
    const matches =
      role === "fixer"
        ? payload.role === "implementer" &&
          payload.objective === "revise" &&
          Boolean(payload.fixer)
        : role === "implementer"
          ? payload.role === "implementer" &&
            !(payload.objective === "revise" && payload.fixer)
          : payload.role === role;
    if (matches) return step.executor.id;
  }
  return undefined;
}

/**
 * One session per review pass, newest per pass: each pass runs in its own
 * session, so the card links them all instead of only the last one.
 */
function reviewerSessions(
  steps: readonly WorkflowStepRow[],
): { pass: number; sessionId: string }[] {
  const byPass = new Map<number, string>();
  for (const step of steps) {
    if (
      phaseOf(step) !== "review" ||
      payloadOf(step)?.role !== "reviewer" ||
      step.executor?.kind !== "session"
    )
      continue;
    const pass = payloadOf(step)?.reviewPass;
    byPass.set(
      typeof pass === "number" && Number.isInteger(pass) && pass > 0 ? pass : 1,
      step.executor.id,
    );
  }
  return [...byPass.entries()]
    .sort(([left], [right]) => left - right)
    .map(([pass, sessionId]) => ({ pass, sessionId }));
}

export function boundedWorkflowProjectionText(item: string): string {
  // By code point, not code unit: a raw index cut can split a surrogate pair.
  return item.length > WORKFLOW_PROJECTION_MAX_ITEM_CHARS
    ? `${[...item].slice(0, WORKFLOW_PROJECTION_MAX_ITEM_CHARS).join("")}…`
    : item;
}

function boundedWorkflowProjectionList(items: readonly string[]): {
  items: string[];
  truncated: boolean;
} {
  const kept = items
    .slice(0, WORKFLOW_PROJECTION_MAX_LIST_ITEMS)
    .map(boundedWorkflowProjectionText);
  return {
    items: kept,
    truncated:
      items.length > WORKFLOW_PROJECTION_MAX_LIST_ITEMS ||
      items.some((item) => item.length > WORKFLOW_PROJECTION_MAX_ITEM_CHARS),
  };
}

function boundedReviewFindingList(items: readonly ReviewFinding[]): {
  items: ReviewFinding[];
  truncated: boolean;
} {
  return {
    items: items
      .slice(0, WORKFLOW_PROJECTION_MAX_LIST_ITEMS)
      .map((finding) => ({
        ...finding,
        text: boundedWorkflowProjectionText(finding.text),
      })),
    truncated:
      items.length > WORKFLOW_PROJECTION_MAX_LIST_ITEMS ||
      items.some(
        (finding) => finding.text.length > WORKFLOW_PROJECTION_MAX_ITEM_CHARS,
      ),
  };
}

/**
 * Why the run stopped, in the stopped step's own words. The recipe's pause
 * reason only names the step and its status; the explanation an executor wrote
 * sits in the step result, and without this the card never shows it.
 */
function blockedReasonOf(
  steps: readonly WorkflowStepRow[],
  step: WorkflowStepRow,
  status: "failed" | "blocked",
): WorkflowRunCard["blockedReason"] {
  const summary = step.result?.summary?.trim();
  if (!summary) return undefined;
  const phase = phaseOf(step);
  const operationConflict = rebaseConflictOf(step);
  const repairConflict = repairRebasePayloadOf(step);
  const conflict = operationConflict ?? repairConflict;
  const files = conflict
    ? boundedWorkflowProjectionList(conflict.files)
    : undefined;
  const triageStep = spentOperationTriageOf(steps, step);
  const triage = triageStep ? operationTriagePayloadOf(triageStep) : undefined;
  return {
    ...(phase ? { phase } : {}),
    status,
    summary: boundedWorkflowProjectionText(summary),
    ...(conflict
      ? {
          rebaseConflict: {
            files: files!.items,
            baseBranch: boundedWorkflowProjectionText(conflict.baseBranch),
            restored: Boolean(
              operationConflict ||
              (repairConflict && rebaseRepairSafetyOf(step)),
            ),
            ...(conflict.truncated || files!.truncated
              ? { truncated: true }
              : {}),
          },
        }
      : {}),
    ...(triage && triageStep
      ? {
          operationTriage: {
            phase: triage.phase,
            stoppedOn: triageStep.id === step.id ? "triage" : "operation",
            // A completed triage was verified clean before its result was
            // accepted, so success IS the proof; a non-success one carries the
            // host's restoration evidence instead.
            restored:
              triageStep.status === "completed" ||
              operationTriageSafetyOf(triageStep)?.restored === true,
          },
        }
      : {}),
  };
}

/**
 * What a decision actually BECAME, read from the step the recipe appended after
 * it. The answer alone cannot say: the contract accepts every discriminant for
 * every question, and the recipe converts what it may not carry out — an
 * out-of-set fixer becomes the implementer, a `deliver` answered to a routing
 * question still routes, a delivery naming no verdict still gets the set's
 * first judge. Reading the successor needs none of that logic twice, and it is
 * the run's own record rather than a re-derivation of it.
 *
 * The allowlist is only half of the run's authority in the other direction too:
 * the pass and session ceilings refuse a pass that was inside every set, so a
 * decision with nothing after it yet is one the card does not describe at all.
 */
function carriedOutDecision(
  steps: readonly WorkflowStepRow[],
  decisionStep: WorkflowStepRow,
  index: number,
):
  | {
      decision: "deliver" | "review-again" | "fix";
      assignee?: "fixer" | "implementer";
      reviewer?: WorkPlanRoleConfig;
      fixer?: WorkPlanRoleConfig;
      verdict?: WorkPlanRoleConfig;
      focus?: string[];
    }
  | undefined {
  const successor =
    steps.find(
      (step, at) => at > index && step.predecessorId === decisionStep.id,
    ) ?? steps[index + 1];
  if (!successor) return undefined;
  const payload = payloadOf(successor) ?? {};
  if (payload.role === "implementer" && payload.objective === "revise") {
    const fixer = roleConfigOf(payload.fixer);
    const focus = focusOf(payload.focus);
    return {
      decision: "fix",
      assignee: fixer ? "fixer" : "implementer",
      ...(fixer ? { fixer } : {}),
      ...(focus.length > 0 ? { focus } : {}),
    };
  }
  // A reviewer step that is not a re-check is a discovery pass, including rows
  // persisted before the objective existed.
  if (payload.role === "reviewer" && payload.objective !== "re-check") {
    const reviewer = roleConfigOf(payload.reviewer);
    const focus = focusOf(payload.focus);
    return {
      decision: "review-again",
      ...(reviewer ? { reviewer } : {}),
      ...(focus.length > 0 ? { focus } : {}),
    };
  }
  if (payload.role === "verdict" && payload.objective !== "re-check") {
    const verdict = roleConfigOf(payload.verdict);
    return { decision: "deliver", ...(verdict ? { verdict } : {}) };
  }
  if (phaseOf(successor) === "delivery") return { decision: "deliver" };
  return undefined;
}

/** The focus list a decision handed the step it routed to, as it was recorded. */
function focusOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** A role configuration recorded in a step payload, when it is a complete one. */
function roleConfigOf(value: unknown): WorkPlanRoleConfig | undefined {
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return typeof record.provider === "string" &&
    typeof record.modelId === "string" &&
    typeof record.thinkingLevel === "string" &&
    typeof record.credentialProfileId === "string" &&
    typeof record.family === "string"
    ? (record as unknown as WorkPlanRoleConfig)
    : undefined;
}

/**
 * The coordinator's newest decision as the run CARRIED IT OUT.
 *
 * Authority is never consulted here, and deliberately so: an answer the run's
 * bounds refused is exactly the case where what happened differs from what was
 * said, and gating on acceptance first would drop the entry instead of
 * describing the fallback the run actually took. Only two things are read from
 * the answer — that it exists and is structurally valid, and its rationale,
 * which is the coordinator's own words either way. Everything the card states
 * about the ACTION comes from the step that followed.
 */
function latestReviewDecision(
  steps: readonly WorkflowStepRow[],
): WorkflowRunCard["reviewDecision"] {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]!;
    if (phaseOf(step) !== "review-decision") continue;
    const decision = readStepResult(step, REVIEW_DECISION_CONTRACT_ID);
    if (!decision) continue;
    const payload = payloadOf(step) ?? {};
    const pass = payload.completedReviewPass;
    const afterPass =
      typeof pass === "number" && Number.isInteger(pass) && pass > 0 ? pass : 1;
    const carriedOut = carriedOutDecision(steps, step, index);
    if (!carriedOut) continue;
    const focus = boundedWorkflowProjectionList(carriedOut.focus ?? []);
    const rationale = boundedWorkflowProjectionText(decision.rationale);
    return {
      decision: carriedOut.decision,
      afterPass,
      rationale,
      ...(focus.items.length > 0 ? { focus: focus.items } : {}),
      ...(carriedOut.reviewer
        ? {
            reviewer: projectedRoleConfig(carriedOut.reviewer),
          }
        : {}),
      ...(carriedOut.assignee ? { assignee: carriedOut.assignee } : {}),
      ...(carriedOut.fixer
        ? { fixer: projectedRoleConfig(carriedOut.fixer) }
        : {}),
      ...(carriedOut.verdict
        ? { verdict: projectedRoleConfig(carriedOut.verdict) }
        : {}),
      ...(focus.truncated || rationale !== decision.rationale
        ? { truncated: true }
        : {}),
    };
  }
  return undefined;
}

function nextActionOf(
  run: WorkflowRunRow,
  steps: WorkflowStepRow[],
  decision: WorkflowDecision,
): string {
  if (run.lifecycle === "completed") return "Run complete";
  if (run.lifecycle === "cancelled") return "Run cancelled";
  // A paused run makes no move, so the recipe's would-be next step must not be
  // announced as one: the store REFUSING that very step is one of the ways a
  // run pauses, and "Next: the post-review decision" would then describe a step
  // that does not exist. The recipe's own `pause` reason is kept — it explains
  // the stopped tail, which the persisted reason need not (a user pause says
  // only that a user paused).
  if (run.lifecycle === "paused" && decision.kind !== "pause")
    return run.lifecycleReason ?? "Paused";
  switch (decision.kind) {
    case "append": {
      const projected: WorkflowStepRow = {
        id: -1,
        runId: run.id,
        kind: decision.step.kind,
        payload: decision.step.payload,
        status: "pending",
        attempt: 0,
        createdAt: 0,
        updatedAt: 0,
      };
      const phase = phaseOf(projected);
      return phase ? `Next: ${PHASE_ACTION[phase]}` : "Next: workflow step";
    }
    case "executing": {
      const step = steps.find((candidate) => candidate.id === decision.stepId);
      const phase = step ? phaseOf(step) : undefined;
      const action = phase ? PHASE_ACTION[phase] : (step?.kind ?? "work");
      if (step?.kind === "user-decision") return `Decision required: ${action}`;
      return step?.status === "running"
        ? `Working: ${action}`
        : `Waiting to start: ${action}`;
    }
    case "pause":
      return decision.reason;
    case "complete":
      return "Run complete";
  }
}

/** Whether this projection knows the exact recipe recorded by the run. */
export function canProjectWorkflowRunCard(run: WorkflowRunRow): boolean {
  return (
    run.recipeId === CODE_DELIVERY_RECIPE_ID &&
    run.recipeVersion === CODE_DELIVERY_RECIPE_VERSION
  );
}

/** Pure recipe-owned projection for the Task's live Workflow Run card. */
export function workflowRunCardOf(
  run: WorkflowRunRow,
  steps: WorkflowStepRow[],
): WorkflowRunCard {
  if (!canProjectWorkflowRunCard(run))
    throw new Error(
      `no Workflow Run card projection is registered for ${run.recipeId}@${run.recipeVersion}`,
    );
  // The recipe's own answer for this exact history, computed once: it says both
  // what comes next and whether anything comes next at all.
  const decision = decideNextStep(run, steps);
  const newestPhasedStep = [...steps]
    .reverse()
    .find((step) => phaseOf(step) !== undefined);
  const open = steps.filter(
    (step) => !isTerminalWorkflowStepStatus(step.status),
  );
  const latestReview = [...steps].reverse().find((step) => {
    if (phaseOf(step) !== "review") return false;
    return Boolean(readStepResult(step, ASSESSMENT_CONTRACT_ID));
  });
  const assessment = latestReview
    ? readStepResult(latestReview, ASSESSMENT_CONTRACT_ID)
    : undefined;
  const publication = [...steps]
    .reverse()
    .find((step) =>
      Boolean(readStepResult(step, PUBLISH_PULL_REQUEST_RESULT_CONTRACT_ID)),
    );
  const publicationResult = publication
    ? readStepResult(publication, PUBLISH_PULL_REQUEST_RESULT_CONTRACT_ID)
    : undefined;
  const observationStep = [...steps]
    .reverse()
    .find((step) =>
      Boolean(
        readStepResult(step, PULL_REQUEST_OBSERVATION_RESULT_CONTRACT_ID),
      ),
    );
  const observation = observationStep
    ? readStepResult(
        observationStep,
        PULL_REQUEST_OBSERVATION_RESULT_CONTRACT_ID,
      )
    : undefined;
  const last = steps[steps.length - 1];
  const coordinatorSessionId = newestSessionForRole(steps, "coordinator");
  const implementerSessionId = newestSessionForRole(steps, "implementer");
  const fixerSessionId = newestSessionForRole(steps, "fixer");
  const verdictSessionId = newestSessionForRole(steps, "verdict");
  const reviewSessions = reviewerSessions(steps);
  const workPlan = acceptedWorkPlan(run, steps);
  const reviewDecision = latestReviewDecision(steps);
  const findings = boundedReviewFindingList(
    sortReviewFindings(assessment?.findings ?? []),
  );
  const observations = boundedWorkflowProjectionList(
    assessment?.observations ?? [],
  );
  const reviewSummary = latestReview?.result?.summary?.trim();
  const reviewSet = reviewSetRollup(steps);
  // The gate is OPEN only while its step is: once answered, what the run did
  // with the answer is the card's story, not the question.
  const openCeilingDecision =
    last && !isTerminalWorkflowStepStatus(last.status)
      ? ceilingDecisionPayloadOf(last)
      : undefined;
  const stoppedTail =
    run.lifecycle === "paused" &&
    last &&
    (last.status === "failed" || last.status === "blocked")
      ? { step: last, status: last.status }
      : undefined;
  const blockedReason = stoppedTail
    ? blockedReasonOf(steps, stoppedTail.step, stoppedTail.status)
    : undefined;
  // Only a REPEAT is worth a word: the first block is simply the block, and
  // saying "attempt 1" about it would be noise.
  const repeatedAttempts = stoppedTail ? identicalTailAttempts(steps) : 1;
  const mergeDecisionReady = Boolean(
    run.lifecycle === "paused" &&
    last !== undefined &&
    !isTerminalWorkflowStepStatus(last.status) &&
    mergeDecisionPayloadOf(last),
  );
  const canRebaseAndReview =
    last?.id === observationStep?.id &&
    observation?.outcome === "base-conflict";
  const cancelling = run.cancelRequestedAt !== undefined;

  return {
    runId: String(run.id),
    phase: newestPhasedStep ? phaseOf(newestPhasedStep)! : "starting",
    ...(open.length === 1
      ? {
          activity:
            open[0]!.kind !== "user-decision" && open[0]!.status === "running"
              ? "running"
              : "waiting",
        }
      : {}),
    ...(coordinatorSessionId ? { coordinatorSessionId } : {}),
    ...(implementerSessionId ? { implementerSessionId } : {}),
    ...(fixerSessionId ? { fixerSessionId } : {}),
    ...(verdictSessionId ? { verdictSessionId } : {}),
    ...(reviewSessions.length > 0 ? { reviewerSessions: reviewSessions } : {}),
    ...(workPlan
      ? {
          workPlan: {
            complexity: workPlan.complexity,
            implementer: projectedRoleConfig(workPlan.implementer),
            reviewer: projectedRoleConfig(workPlan.reviewer),
            rationale: workPlan.rationale,
          },
        }
      : {}),
    ...(reviewDecision ? { reviewDecision } : {}),
    iterationsUsed: countIterations(steps),
    ...(latestReview && assessment
      ? {
          latestAssessment: {
            verdict: assessment.verdict,
            headCommit: assessment.headCommit,
            stale: isStaleAssessment(latestReview, assessment),
            ...(reviewSummary ? { summary: reviewSummary } : {}),
            findings: findings.items,
            ...(observations.items.length > 0
              ? { observations: observations.items }
              : {}),
            ...(findings.truncated || observations.truncated
              ? { truncated: true }
              : {}),
          },
        }
      : {}),
    ...(reviewSet ? { reviewSet } : {}),
    ...(publicationResult?.outcome === "published"
      ? {
          pullRequest: {
            cardId: publicationResult.cardId,
            sessionId: publicationResult.sessionId,
            number: publicationResult.number,
            url: publicationResult.url,
          },
        }
      : {}),
    nextAction: nextActionOf(run, steps, decision),
    ...(openCeilingDecision
      ? {
          ceilingDecision: {
            blocked: openCeilingDecision.blocked,
            wanted: boundedWorkflowProjectionText(openCeilingDecision.wanted),
            allowedChoices: openCeilingDecision.allowedChoices,
            // The RUN's ceilings, not the snapshot the gate was written with:
            // the card's raise is computed from these, and a number that had
            // moved since would offer a raise the run has already taken.
            ceilings: {
              maxIterations: run.maxIterations,
              maxReviewPasses: run.maxReviewPasses,
            },
            spent: openCeilingDecision.spent,
            headCarriesDiscoveryReview:
              openCeilingDecision.headCarriesDiscoveryReview,
            // Rows written before the gate carried one start where the control
            // always used to: at one.
            suggestedRaise: openCeilingDecision.suggestedRaise ?? 1,
          },
        }
      : {}),
    ...(run.cancelRequestedAt !== undefined ? { cancelRequested: true } : {}),
    mergeDecisionReady,
    // A cancellation the user has asked for takes every control with it, not
    // just Resume: the engine refuses Retry and rebase-and-review while one is
    // pending, so offering them renders buttons that can only fail. The state
    // is durable, not a flicker — boot logs and moves on when settling a
    // recorded cancellation fails, leaving the marker set on a paused run.
    canRebaseAndReview: canRebaseAndReview && !cancelling,
    canRetry:
      (stoppedTail !== undefined ||
        (last !== undefined && isRecheckablePullRequestObservation(last))) &&
      !cancelling,
    // Resume is offered only where it would MOVE something. A pause the recipe
    // re-derives from the same history — a `fail` verdict, a stopped tail whose
    // way on is Retry — would come straight back, and a run waiting at one of
    // its own gates is answered through that gate instead.
    canResume:
      run.lifecycle === "paused" &&
      decision.kind !== "pause" &&
      !cancelling &&
      openCeilingDecision === undefined &&
      !mergeDecisionReady &&
      !canRebaseAndReview,
    ...(blockedReason ? { blockedReason } : {}),
    ...(repeatedAttempts > 1 ? { repeatedAttempts } : {}),
  };
}
