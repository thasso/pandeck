/**
 * The code-delivery recipe (`docs/agent-workflows.md`, "Recipe as code, steps
 * as data" and "The code-delivery recipe", [Task-365](pa://task/365)).
 *
 * V1 ships ONE recipe, implemented as ordinary TypeScript rather than a
 * declarative graph: a deterministic function that, given a run and its
 * persisted step history, decides the next step or reports what the run waits
 * on. The run records the recipe's versioned identifier, so replacing this
 * function with an interpreter later is a refactor, not a data migration.
 *
 * The function is PURE — the run row and its steps in append order are the only
 * input, and there is no clock, no I/O, and no randomness. That is what makes
 * crash recovery safe: after a restart the same history re-derives the same
 * decision, so the engine finds the step it already appended instead of
 * inventing a twin. Everything a loop would need is derived from history too;
 * there is no mutable iteration counter anywhere.
 *
 * The recipe walks plan → implement → commit/sync → review, looping on `revise`
 * up to the run's iteration limit, then runs a deterministic delivery gate and
 * publishes the reviewed commit through the existing push and `/pr` seams. An
 * assessment applies only to the head commit it names (foundation invariant 3).
 * The delivery gate catches the complementary race: a workspace change landing
 * only after an exact-head pass routes back through commit/sync and review,
 * never through publication.
 *
 * How many reviews the work needs is NOT decided at plan time: the evidence for
 * that judgement — what was actually written, and what the first reviewer made
 * of it — does not exist yet. A passing review therefore reaches a
 * `review-decision` step, where the coordinator says `deliver` or
 * `review-again` with the range's change evidence and the reviewer's own words
 * in front of it. That step runs in the coordinator's EXISTING session, so it
 * costs no session at all, and it is skipped entirely when nothing is open — a
 * one-pass run never pays for the question. The bounds stay here: another pass
 * happens only while the review-pass ceiling allows and only on a reviewer-set
 * candidate; anything else delivers.
 *
 * Reviewer and implementer never talk directly — progress comes from structured
 * results, not prose (foundation invariant 1) — so the EXCHANGE between them is
 * carried by the payloads this function writes: a rework assignment carries the
 * findings, the reviewer's own summary, and its non-blocking observations, and
 * the next review assignment carries what the implementer reported back,
 * including its answers to findings it did not simply fix. Each side sees the
 * other's words without either becoming the source of truth.
 */
import {
  isTerminalWorkflowStepStatus,
  WORKFLOW_PAYLOAD_MAX_CHARS,
  type ReviewFinding,
  type ReviewFindingResolution,
  type WorkflowJsonValue,
  type WorkflowStepKind,
} from "@assistant/shared";
import type { WorkflowRunRow, WorkflowStepRow } from "../db/workflowStore.ts";
import { clipText, TRUNCATION_MARKER } from "../textBudget.ts";
import {
  ASSESSMENT_CONTRACT_ID,
  CI_OBSERVATION_RESULT_CONTRACT_ID,
  COMMIT_SYNC_RESULT_CONTRACT_ID,
  DELIVERY_GATE_RESULT_CONTRACT_ID,
  IMPLEMENTATION_RESULT_CONTRACT_ID,
  PUBLISH_PULL_REQUEST_RESULT_CONTRACT_ID,
  PULL_REQUEST_OBSERVATION_RESULT_CONTRACT_ID,
  readStepResult,
  REVIEW_DECISION_CONTRACT_ID,
  WORKFLOW_RESULT_CONTRACTS,
  WORK_PLAN_CONTRACT_ID,
  type Assessment,
  type CommitRangeChanges,
  type CommitSyncResult,
  type FindingResponse,
  type WorkflowCiResult,
  type PullRequestObservationResult,
  type ReviewDecision,
  type WorkPlan,
  type WorkPlanRoleConfig,
} from "./resultContracts.ts";

export const CODE_DELIVERY_RECIPE_ID = "code-delivery";

/**
 * The version of THIS decision function. A change in behavior bumps it in
 * place; runs recorded against an older version then pause as an unknown
 * recipe. That is deliberate — dev-time runs are debris, not data to migrate,
 * and this repo does not carry backwards compatibility.
 */
export const CODE_DELIVERY_RECIPE_VERSION = 19;

/** Leave room for future fixed metadata without approaching the store ceiling. */
export const CODE_DELIVERY_PAYLOAD_MAX_CHARS =
  WORKFLOW_PAYLOAD_MAX_CHARS - 1_000;

/* -------------------------------- payloads -------------------------------- */

/*
 * Assignment payload shapes are RECIPE-owned and constructed as literals below:
 * the core step row stores them opaquely (`WorkflowJsonValue`), and
 * `workflow/agentExecutor.ts` reads them field by field to build the prompt
 * ([Task-367](pa://task/367)). Only a payload this module reads BACK out of the
 * store carries a named type (`CeilingDecisionStepPayload`,
 * `MergeDecisionStepPayload`, `PullRequestObservationStepPayload`).
 */

/**
 * What the implementer reported about the range now under review: its result
 * summary, its notes, and its answers to the previous pass's findings. Present
 * only once there is something to carry.
 */
type ImplementerReport = {
  summary?: string;
  notes?: string;
  responses?: FindingResponse[];
};

/** A path to recipe-owned prose, ordered from least to most load-bearing. */
type PayloadTextPath = readonly (string | number)[];

function valueAtPath(
  root: WorkflowJsonValue,
  path: PayloadTextPath,
): WorkflowJsonValue | undefined {
  let value: WorkflowJsonValue | undefined = root;
  for (const part of path) {
    if (Array.isArray(value) && typeof part === "number") value = value[part];
    else if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof part === "string"
    )
      value = value[part];
    else return undefined;
  }
  return value;
}

function setValueAtPath(
  root: WorkflowJsonValue,
  path: PayloadTextPath,
  replacement: WorkflowJsonValue,
): void {
  const parent = valueAtPath(root, path.slice(0, -1));
  const key = path[path.length - 1];
  if (Array.isArray(parent) && typeof key === "number")
    parent[key] = replacement;
  else if (
    typeof parent === "object" &&
    parent !== null &&
    !Array.isArray(parent) &&
    typeof key === "string"
  )
    parent[key] = replacement;
}

function stringPaths(
  value: WorkflowJsonValue | undefined,
  path: PayloadTextPath,
): PayloadTextPath[] {
  if (typeof value === "string") return [path];
  if (Array.isArray(value))
    return value.flatMap((item, index) => stringPaths(item, [...path, index]));
  if (typeof value === "object" && value !== null)
    return Object.entries(value).flatMap(([key, item]) =>
      stringPaths(item, [...path, key]),
    );
  return [];
}

function clippedForEncodedLimit(text: string, maxEncodedChars: number): string {
  let best = TRUNCATION_MARKER;
  let low = 0;
  let high = Math.max(0, text.length - 1);
  while (low <= high) {
    const keep = Math.floor((low + high) / 2);
    const candidate = clipText(text, keep).text;
    if (JSON.stringify(candidate).length <= maxEncodedChars) {
      best = candidate;
      low = keep + 1;
    } else high = keep - 1;
  }
  return best;
}

/**
 * Whether this item is the marker {@link omittedItemLike} leaves behind — the
 * stand-in for an array tail an assignment could not carry.
 *
 * Exported because the PROMPT is where that stand-in has to be noticed: it is
 * not a renderable finding, so the renderer drops it, and dropping it silently
 * hands an assignee a short list with nothing saying so. One predicate for both
 * sides means the shape cannot drift apart from its detection.
 */
const OMITTED_COUNT_FIELD = "omittedFromThisAssignment";

/**
 * How many items this marker stands in for, or 0 when it is not a marker.
 *
 * The COUNT matters, not the marker's presence: one marker replaces an omitted
 * tail of any length, so counting markers would report "1 omitted" for a
 * thousand dropped findings — a number more misleading than no number at all.
 */
export function omittedItemCount(value: WorkflowJsonValue): number {
  if (!isOmittedItemMarker(value)) return 0;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return 1;
  const count = value[OMITTED_COUNT_FIELD];
  return typeof count === "number" && count > 0 ? count : 1;
}

export function isOmittedItemMarker(value: WorkflowJsonValue): boolean {
  if (value === TRUNCATION_MARKER) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const fields = Object.values(value);
  return (
    fields.length > 0 &&
    fields.some((field) => field === TRUNCATION_MARKER) &&
    fields.every(
      (field) => typeof field !== "string" || field === TRUNCATION_MARKER,
    )
  );
}

/** Groups whose ITEMS may never be dropped to make a payload fit. */
function isLosslessGroup(groupPath: PayloadTextPath): boolean {
  return groupPath.length === 1 && groupPath[0] === "findings";
}

/**
 * Groups that travel WHOLE or not at all.
 *
 * `focus` is an INSTRUCTION, not evidence. Evidence survives clipping — half a
 * reviewer summary still says something true — but half of "do not take approach
 * X", or a dropped "…and preserve Y", tells the fixer the OPPOSITE of what the
 * coordinator said, while the assignment still says the remainder shapes its
 * work. Absent guidance only costs the round the coordinator's reading of the
 * findings; inverted guidance costs it the fix. So the whole key goes, and the
 * ladder over a pressured payload reads: evidence clips, focus drops entire,
 * findings never move.
 *
 * `findingRounds` is a LOOKUP TABLE, which fails the same way. It is joined to
 * the findings by thread id, and a renderer that cannot find an entry says
 * nothing — so a clipped id or a dropped tail does not shorten the evidence, it
 * silently relabels a finding three rounds deep as one nobody has tried.
 *
 * Dropping the whole table is not self-announcing either, which is why the
 * routing payload carries the key even when the answer is "no finding has any
 * history": an EMPTY table means the run looked and found nothing, an ABSENT one
 * on a routing question means the table did not fit, and the assignment says so
 * rather than letting every finding read as first-time. An empty group is
 * therefore never worth deleting — there is nothing to reclaim, and deleting it
 * would turn the honest zero into the unreadable case.
 */
function isAllOrNothingGroup(groupPath: PayloadTextPath): boolean {
  return (
    groupPath.length === 1 &&
    (groupPath[0] === "focus" || groupPath[0] === "findingRounds")
  );
}

/** Remove a whole group, for the groups a payload may not carry in part. */
function deleteValueAtPath(
  root: WorkflowJsonValue,
  path: PayloadTextPath,
): void {
  const parent = valueAtPath(root, path.slice(0, -1));
  const key = path[path.length - 1];
  if (
    typeof parent === "object" &&
    parent !== null &&
    !Array.isArray(parent) &&
    typeof key === "string"
  )
    delete parent[key];
}

/** A visible array tail that keeps the prompt renderer's expected item shape. */
function omittedItemLike(
  value: WorkflowJsonValue | undefined,
  omitted: number,
): WorkflowJsonValue {
  if (typeof value === "object" && value !== null && !Array.isArray(value))
    return {
      ...Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          typeof item === "string" ? TRUNCATION_MARKER : item,
        ]),
      ),
      [OMITTED_COUNT_FIELD]: omitted,
    };
  return TRUNCATION_MARKER;
}

/**
 * Shrink one prose group enough to hit the serialized target. Long strings go
 * first, minimizing the number of pieces that lose detail. If array structure
 * alone is material, its omitted tail is represented by the same visible
 * truncation marker rather than disappearing silently.
 */
function shrinkPayloadGroup(
  payload: WorkflowJsonValue,
  groupPath: PayloadTextPath,
): void {
  // Checked here rather than trusted from the caller: this group is reached
  // only while the payload is over budget, and dropping it is the whole of
  // what shrinking it means. An EMPTY group is left alone — it costs nothing to
  // carry, and its absence is what tells a reader the group was dropped.
  if (isAllOrNothingGroup(groupPath)) {
    const group = valueAtPath(payload, groupPath);
    if (
      !(Array.isArray(group) && group.length === 0) &&
      JSON.stringify(payload).length > CODE_DELIVERY_PAYLOAD_MAX_CHARS
    )
      deleteValueAtPath(payload, groupPath);
    return;
  }
  const paths = stringPaths(valueAtPath(payload, groupPath), groupPath).sort(
    (left, right) =>
      JSON.stringify(valueAtPath(payload, right)).length -
      JSON.stringify(valueAtPath(payload, left)).length,
  );
  let payloadSize = JSON.stringify(payload).length;
  for (const path of paths) {
    const over = payloadSize - CODE_DELIVERY_PAYLOAD_MAX_CHARS;
    if (over <= 0) return;
    const text = valueAtPath(payload, path);
    if (typeof text !== "string") continue;
    const encoded = JSON.stringify(text).length;
    const markerSize = JSON.stringify(TRUNCATION_MARKER).length;
    if (encoded <= markerSize) continue;
    const replacement = clippedForEncodedLimit(
      text,
      Math.max(markerSize, encoded - over),
    );
    const replacementSize = JSON.stringify(replacement).length;
    if (replacementSize < encoded) {
      setValueAtPath(payload, path, replacement);
      payloadSize -= encoded - replacementSize;
    }
  }

  const group = valueAtPath(payload, groupPath);
  if (
    payloadSize <= CODE_DELIVERY_PAYLOAD_MAX_CHARS ||
    !Array.isArray(group) ||
    group.length === 0 ||
    // Findings are LOSSLESS. Every successor assignment must carry all of them,
    // and a dropped one is recoverable by nothing the run can do: a retry
    // re-composes the same shortened payload, and the coordinator deciding who
    // fixes what cannot read the review threads. Their prose is clipped above
    // like anything else — what may never happen is a finding disappearing.
    // What keeps this satisfiable is the bound at submission
    // (`ASSESSMENT_FINDINGS_MAX_CHARS`), which is sized so the whole set fits
    // every successor with its metadata.
    isLosslessGroup(groupPath)
  )
    return;
  // Sized for the WORST case so the search stays honest: the real count is
  // never larger than the whole group, so the real marker never encodes longer
  // than the one the search measured against.
  const sizingMarker = omittedItemLike(group[0], group.length);
  const groupTarget = Math.max(
    0,
    JSON.stringify(group).length -
      (payloadSize - CODE_DELIVERY_PAYLOAD_MAX_CHARS),
  );
  let best: WorkflowJsonValue[] | undefined;
  let low = 0;
  let high = group.length - 1;
  while (low <= high) {
    const keep = Math.floor((low + high) / 2);
    const candidate = [...group.slice(0, keep), sizingMarker];
    if (JSON.stringify(candidate).length <= groupTarget) {
      best = candidate;
      low = keep + 1;
    } else high = keep - 1;
  }
  const kept = best ? best.length - 1 : 0;
  const collapsed = [
    ...group.slice(0, kept),
    omittedItemLike(group[0], group.length - kept),
  ];
  if (JSON.stringify(collapsed).length < JSON.stringify(group).length)
    setValueAtPath(payload, groupPath, collapsed);
}

/**
 * Recipe results are each store-bounded independently; composing several of
 * them is not. Bound the COPY carried by a successor while leaving persisted
 * source evidence intact. Priority paths run least-load-bearing first.
 */
function boundedRecipePayload(
  payload: WorkflowJsonValue,
  priorityPaths: readonly PayloadTextPath[],
): WorkflowJsonValue {
  const bounded = structuredClone(payload);
  for (const path of priorityPaths) {
    if (JSON.stringify(bounded).length <= CODE_DELIVERY_PAYLOAD_MAX_CHARS)
      break;
    shrinkPayloadGroup(bounded, path);
  }
  const size = JSON.stringify(bounded).length;
  if (size > CODE_DELIVERY_PAYLOAD_MAX_CHARS)
    throw new Error(
      `code-delivery recipe payload is ${size} chars after bounding; fixed metadata exceeds the ${CODE_DELIVERY_PAYLOAD_MAX_CHARS} char recipe budget`,
    );
  return bounded;
}

export const COMMIT_SYNC_OPERATION_ID = "commit-sync";
export const COMMIT_ONLY_OPERATION_ID = "commit";
export const BASE_SYNC_OPERATION_ID = "base-sync";
export const CI_OBSERVATION_OPERATION_ID = "observe-ci";
export const DELIVERY_GATE_OPERATION_ID = "delivery-gate";
export const PUBLISH_PULL_REQUEST_OPERATION_ID = "publish-pull-request";

/** One durable subscription to the published PR's exact reviewed head. */
export type PullRequestObservationStepPayload = {
  condition: "pull-request-ready";
  cardId: string;
  reviewedHeadCommit: string;
};

/**
 * The gate an exhausted ceiling reaches instead of stopping. A ceiling bounds
 * AUTOMATIC work, not the work itself, so the run says what it wanted to do
 * next and what it has spent, and the user raises the bound, takes the work as
 * it stands, or cancels. `deliver` is the only route by which a head no
 * discovery review passed can reach the delivery gate, and it is a human
 * choice, recorded as one.
 */
export type CeilingDecisionStepPayload = {
  decision: "raise-ceilings";
  /** Which ceiling stopped the run. */
  blocked: "review-passes" | "iterations";
  /** What the run wanted to do next, in one sentence for the card. */
  wanted: string;
  ceilings: { maxIterations: number; maxReviewPasses: number };
  spent: { iterations: number; reviewPasses: number; sessions: number };
  /** The head `deliver` would ship, when the run has one to ship. */
  reviewedHeadCommit?: string;
  /** Whether fresh eyes ever passed that head; false makes `deliver` stark. */
  headCarriesDiscoveryReview: boolean;
  /**
   * What this gate may be answered with. `deliver` is offered only when there
   * IS a head to ship: a workspace that moved out from under the review has
   * nothing to deliver, and offering the choice anyway would take the user to
   * a dead end instead of an outcome.
   */
  allowedChoices: ("raise" | "deliver" | "re-evaluate" | "cancel")[];
  /** Where the raise control starts. See {@link suggestedRaiseFor}. */
  suggestedRaise: number;
};

/** What the user answered at a ceiling gate. Server-written, like the merge. */
type CeilingDecisionResult =
  | {
      choice: "raise";
      adjustment?: WorkflowJsonValue;
      maxIterations: number;
      maxReviewPasses: number;
    }
  | { choice: "deliver"; reviewedHeadCommit?: string }
  /** The user changed the workspace themselves; look at it again. */
  | { choice: "re-evaluate" }
  | { choice: "cancel" };

/** The deliberate human gate reached after the exact-head PR is ready. */
export type MergeDecisionStepPayload = {
  decision: "merge-pull-request";
  cardId: string;
  reviewedHeadCommit: string;
  /** Merge or cancel the run; merge details stay on the existing PR action. */
  allowedChoices: ["merge", "cancel"];
};

/** Immutable evidence recorded when the PR merge is observed. */
export type MergeDecisionResult =
  | {
      choice: "merge";
      source: "app" | "hosting";
      mergeMethod?: "merge" | "squash" | "rebase";
      deleteBranch?: boolean;
    }
  | { choice: "cancel"; source: "app" };

/** Provider evidence that superseded a still-open merge choice. */
export type MergeDecisionSupersessionResult = {
  supersededBy: "pull-request-observation";
  observation: PullRequestObservationResult;
};

export function operationIdempotencyKey(
  runId: number,
  operationId: string,
  predecessorStepId: number,
): string {
  return `wf${runId}:${operationId}:${predecessorStepId}`;
}

export function commitSyncIdempotencyKey(
  runId: number,
  predecessorStepId: number,
): string {
  return operationIdempotencyKey(
    runId,
    COMMIT_SYNC_OPERATION_ID,
    predecessorStepId,
  );
}

export function commitOnlyIdempotencyKey(
  runId: number,
  predecessorStepId: number,
): string {
  return operationIdempotencyKey(
    runId,
    COMMIT_ONLY_OPERATION_ID,
    predecessorStepId,
  );
}

export function baseSyncIdempotencyKey(
  runId: number,
  predecessorStepId: number,
): string {
  return operationIdempotencyKey(
    runId,
    BASE_SYNC_OPERATION_ID,
    predecessorStepId,
  );
}

/* -------------------------------- decisions ------------------------------- */

export type WorkflowDecision =
  | {
      kind: "append";
      step: {
        kind: WorkflowStepKind;
        payload: WorkflowJsonValue;
        predecessorId?: number;
      };
    }
  /** An open step exists: dispatch it, or keep waiting on it. */
  | { kind: "executing"; stepId: number }
  /** The engine pauses the run with this reason. */
  | { kind: "pause"; reason: string }
  | { kind: "complete" };

/** One recipe: its versioned identity plus its decision function. */
export interface WorkflowRecipe {
  id: string;
  version: number;
  decide(run: WorkflowRunRow, steps: WorkflowStepRow[]): WorkflowDecision;
}

/* --------------------------------- phases --------------------------------- */

/**
 * Every phase name, as the one value the type is derived FROM. A stored phase
 * read back out of a payload has to be narrowed against this list, and a
 * hand-kept second copy would be the place a new phase is forgotten.
 */
const RECIPE_PHASES = [
  "plan",
  "implement",
  "commit-sync",
  "commit",
  "base-sync",
  "ci",
  "review",
  "review-decision",
  "ceiling-decision",
  "delivery",
  "observe",
  "merge",
] as const;

/** Which recipe phase a persisted step belongs to, read from its payload. */
export type RecipePhase = (typeof RECIPE_PHASES)[number];

function isRecipePhase(
  value: WorkflowJsonValue | undefined,
): value is RecipePhase {
  return (
    typeof value === "string" &&
    (RECIPE_PHASES as readonly string[]).includes(value)
  );
}

function payloadRecord(
  payload: WorkflowJsonValue | undefined,
): Record<string, WorkflowJsonValue> {
  return typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload)
    ? payload
    : {};
}

export function phaseOf(step: WorkflowStepRow): RecipePhase | undefined {
  const payload = payloadRecord(step.payload);
  if (step.kind === "agent") {
    // Both coordinator assignments are the same role in the same session; the
    // objective is what separates the opening plan from a post-review call.
    if (payload.role === "coordinator")
      return payload.objective === "review-decision"
        ? "review-decision"
        : "plan";
    if (payload.role === "implementer") return "implement";
    if (payload.role === "reviewer" || payload.role === "verdict")
      return "review";
    return undefined;
  }
  if (step.kind === "host-operation") {
    if (payload.operation === COMMIT_SYNC_OPERATION_ID) return "commit-sync";
    if (payload.operation === COMMIT_ONLY_OPERATION_ID) return "commit";
    if (payload.operation === BASE_SYNC_OPERATION_ID) return "base-sync";
    if (payload.operation === CI_OBSERVATION_OPERATION_ID) return "ci";
    if (
      payload.operation === DELIVERY_GATE_OPERATION_ID ||
      payload.operation === PUBLISH_PULL_REQUEST_OPERATION_ID
    )
      return "delivery";
  }
  if (step.kind === "wait" && payload.condition === "pull-request-ready")
    return "observe";
  if (step.kind === "user-decision") {
    if (payload.decision === "merge-pull-request") return "merge";
    if (payload.decision === "raise-ceilings") return "ceiling-decision";
  }
  return undefined;
}

export function mergeDecisionPayloadOf(
  step: WorkflowStepRow,
): MergeDecisionStepPayload | undefined {
  if (phaseOf(step) !== "merge") return undefined;
  const payload = payloadRecord(step.payload);
  const choices = payload.allowedChoices;
  return typeof payload.cardId === "string" &&
    typeof payload.reviewedHeadCommit === "string" &&
    Array.isArray(choices) &&
    choices.length === 2 &&
    choices[0] === "merge" &&
    choices[1] === "cancel"
    ? (step.payload as MergeDecisionStepPayload)
    : undefined;
}

function mergeDecisionSupersessionOf(
  step: WorkflowStepRow,
): MergeDecisionSupersessionResult | undefined {
  if (
    !mergeDecisionPayloadOf(step) ||
    step.status !== "completed" ||
    step.result?.status !== "completed"
  )
    return undefined;
  const payload = payloadRecord(step.result.payload);
  const observation = payloadRecord(payload.observation);
  const outcome = observation.outcome;
  return payload.supersededBy === "pull-request-observation" &&
    (outcome === "base-conflict" ||
      outcome === "head-changed" ||
      outcome === "closed" ||
      outcome === "changes-requested" ||
      outcome === "ci-failure") &&
    typeof observation.headCommit === "string" &&
    typeof observation.reason === "string"
    ? (step.result.payload as MergeDecisionSupersessionResult)
    : undefined;
}

function mergeDecisionResultOf(
  step: WorkflowStepRow,
): MergeDecisionResult | undefined {
  if (step.status !== "completed" || step.result?.status !== "completed")
    return undefined;
  const payload = payloadRecord(step.result.payload);
  if (payload.choice === "cancel" && payload.source === "app")
    return step.result.payload as MergeDecisionResult;
  if (
    payload.choice !== "merge" ||
    (payload.source !== "app" && payload.source !== "hosting")
  )
    return undefined;
  if (
    payload.mergeMethod !== undefined &&
    payload.mergeMethod !== "merge" &&
    payload.mergeMethod !== "squash" &&
    payload.mergeMethod !== "rebase"
  )
    return undefined;
  if (
    payload.deleteBranch !== undefined &&
    typeof payload.deleteBranch !== "boolean"
  )
    return undefined;
  return step.result.payload as MergeDecisionResult;
}

export type RebaseConflictEvidence = {
  files: string[];
  truncated: boolean;
  baseBranch: string;
  originalHead: string;
};

export type RebaseRepairSafetyEvidence = {
  verified: true;
  restored: true;
  originalHead: string;
};

/** Read a blocked operation marker without weakening completed-only contracts. */
export function rebaseConflictOf(
  step: WorkflowStepRow,
): RebaseConflictEvidence | undefined {
  if (
    (phaseOf(step) !== "commit-sync" && phaseOf(step) !== "base-sync") ||
    step.status !== "blocked" ||
    step.result?.status !== "blocked"
  )
    return undefined;
  const marker = payloadRecord(
    payloadRecord(step.result.payload).rebaseConflict,
  );
  return Array.isArray(marker.files) &&
    marker.files.every((file) => typeof file === "string") &&
    typeof marker.truncated === "boolean" &&
    typeof marker.baseBranch === "string" &&
    marker.baseBranch.trim() &&
    typeof marker.originalHead === "string" &&
    marker.originalHead.trim()
    ? {
        files: marker.files as string[],
        truncated: marker.truncated,
        baseBranch: marker.baseBranch,
        originalHead: marker.originalHead,
      }
    : undefined;
}

export function repairRebasePayloadOf(
  step: WorkflowStepRow,
): RebaseConflictEvidence | undefined {
  const payload = payloadRecord(step.payload);
  return step.kind === "agent" &&
    payload.role === "implementer" &&
    payload.objective === "repair-rebase" &&
    Array.isArray(payload.files) &&
    payload.files.every((file) => typeof file === "string") &&
    typeof payload.truncated === "boolean" &&
    typeof payload.baseBranch === "string" &&
    payload.baseBranch.trim() &&
    typeof payload.originalHead === "string" &&
    payload.originalHead.trim()
    ? {
        files: payload.files as string[],
        truncated: payload.truncated,
        baseBranch: payload.baseBranch,
        originalHead: payload.originalHead,
      }
    : undefined;
}

/** Host-written proof attached only after a non-success repair was restored. */
export function rebaseRepairSafetyOf(
  step: WorkflowStepRow,
): RebaseRepairSafetyEvidence | undefined {
  if (step.status !== "blocked" && step.status !== "failed") return undefined;
  const safety = payloadRecord(
    payloadRecord(step.result?.payload).rebaseRepairSafety,
  );
  return safety.verified === true &&
    safety.restored === true &&
    typeof safety.originalHead === "string" &&
    safety.originalHead.trim()
    ? {
        verified: true,
        restored: true,
        originalHead: safety.originalHead,
      }
    : undefined;
}

/**
 * Host-written mark that an assignment never reached its agent: the prompt was
 * refused before the turn began, so the session did nothing and observed
 * nothing. Written only for refusals that provably precede delivery — a turn
 * that started and then failed is a real attempt and carries no mark.
 */
function undeliveredAssignment(step: WorkflowStepRow): boolean {
  if (step.status !== "failed") return false;
  return payloadRecord(step.result?.payload).assignmentUndelivered === true;
}

/**
 * Whether this semantic commit-sync attempt chain already followed a repair.
 *
 * The budget is one repair per conflict episode, and what spends it is an agent
 * that GOT ITS TURN. A repair assignment the runtime refused to deliver moved
 * nothing — no session saw the conflict, no file was touched — so it leaves the
 * episode's one attempt unspent, and the walk continues past it rather than
 * standing the run in front of the manual path over a prompt that never left
 * the building.
 */
function rebaseRepairSpent(
  steps: readonly WorkflowStepRow[],
  tail: WorkflowStepRow,
): boolean {
  const byId = new Map(steps.map((step) => [step.id, step]));
  let current = tail;
  while (current.predecessorId !== undefined) {
    const predecessor = byId.get(current.predecessorId);
    // Broken lineage is not authority to assign another mutating repair.
    if (!predecessor) return true;
    if (
      (phaseOf(predecessor) === "commit-sync" ||
        phaseOf(predecessor) === "base-sync") &&
      (predecessor.status === "blocked" || predecessor.status === "failed")
    ) {
      current = predecessor;
      continue;
    }
    if (repairRebasePayloadOf(predecessor) === undefined) return false;
    if (!undeliveredAssignment(predecessor)) return true;
    current = predecessor;
  }
  return false;
}

/* --------------------- automatic host-operation triage -------------------- */

/**
 * The exact host-operation failure a triage assignment is handed, and the
 * reservation it is expected to hand back.
 *
 * `idempotencyKey` is the FAILED attempt's key, carried so the pure decision
 * can still walk a chain the triage interrupted — a CI observation re-issued
 * after a triage anchors to the same commit/sync range the failed attempt
 * anchored to, and nothing else may stand in between.
 */
export type OperationTriageEvidence = {
  operation: string;
  phase: RecipePhase;
  stepId: number;
  status: "failed" | "blocked";
  summary: string;
  attempts: number;
  idempotencyKey: string;
};

/** Host-written proof about what a spent triage left behind in Git. */
export type OperationTriageSafetyEvidence = {
  verified: true;
  restored: boolean;
  originalHead: string;
  violations?: string[];
};

export function operationTriagePayloadOf(
  step: WorkflowStepRow,
): OperationTriageEvidence | undefined {
  const payload = payloadRecord(step.payload);
  if (
    step.kind !== "agent" ||
    payload.role !== "implementer" ||
    payload.objective !== "triage-operation"
  )
    return undefined;
  const failed = payloadRecord(payload.failedOperation);
  const phase = failed.phase;
  return typeof failed.operation === "string" &&
    failed.operation.trim() &&
    isRecipePhase(phase) &&
    typeof failed.stepId === "number" &&
    Number.isInteger(failed.stepId) &&
    (failed.status === "failed" || failed.status === "blocked") &&
    typeof failed.summary === "string" &&
    failed.summary.trim() &&
    typeof failed.attempts === "number" &&
    failed.attempts >= 2 &&
    typeof failed.idempotencyKey === "string" &&
    failed.idempotencyKey.trim()
    ? {
        operation: failed.operation,
        phase,
        stepId: failed.stepId,
        status: failed.status,
        summary: failed.summary,
        attempts: failed.attempts,
        idempotencyKey: failed.idempotencyKey,
      }
    : undefined;
}

/** Host-written proof attached only after a non-success triage was settled. */
export function operationTriageSafetyOf(
  step: WorkflowStepRow,
): OperationTriageSafetyEvidence | undefined {
  if (step.status === "completed") return undefined;
  const safety = payloadRecord(
    payloadRecord(step.result?.payload).operationTriageSafety,
  );
  const violations = Array.isArray(safety.violations)
    ? safety.violations.filter((item) => typeof item === "string")
    : [];
  return safety.verified === true &&
    typeof safety.restored === "boolean" &&
    typeof safety.originalHead === "string" &&
    safety.originalHead.trim()
    ? {
        verified: true,
        restored: safety.restored,
        originalHead: safety.originalHead,
        ...(violations.length > 0
          ? { violations: violations as string[] }
          : {}),
      }
    : undefined;
}

/**
 * Whether this failure episode already spent its one automatic triage.
 *
 * The budget is one triage per episode, and — exactly as for a rebase repair —
 * what spends it is an agent that GOT ITS TURN. The walk crosses the
 * failed/blocked attempts at the same operation that the semantic retry chain
 * is made of, so a user who keeps pressing Retry does not buy another agent
 * every time; it stops at the first triage assignment, and an assignment the
 * runtime refused to deliver leaves the budget unspent.
 */
function operationTriageBudget(
  steps: readonly WorkflowStepRow[],
  tail: WorkflowStepRow,
): { spent: boolean; step?: WorkflowStepRow } {
  const byId = new Map(steps.map((step) => [step.id, step]));
  let current = tail;
  while (current.predecessorId !== undefined) {
    const predecessor = byId.get(current.predecessorId);
    // Broken lineage is not authority to hand out another mutating assignment.
    if (!predecessor) return { spent: true };
    if (
      predecessor.kind === "host-operation" &&
      (predecessor.status === "blocked" || predecessor.status === "failed")
    ) {
      current = predecessor;
      continue;
    }
    if (operationTriagePayloadOf(predecessor) === undefined)
      return { spent: false };
    if (!undeliveredAssignment(predecessor))
      return { spent: true, step: predecessor };
    current = predecessor;
  }
  return { spent: false };
}

/**
 * The triage assignment that already ran for the failure this step reports —
 * the step ITSELF when the run stopped on the triage, otherwise the one its
 * episode spent before the operation was handed back and failed again.
 *
 * The card needs this to say WHOSE words the stopped tail's summary is: an
 * operation's error, or an agent's diagnosis of it.
 */
export function spentOperationTriageOf(
  steps: readonly WorkflowStepRow[],
  tail: WorkflowStepRow,
): WorkflowStepRow | undefined {
  if (operationTriagePayloadOf(tail)) return tail;
  return operationTriageBudget(steps, tail).step;
}

/**
 * ONE bounded diagnostic assignment for a host-operation failure the run has
 * now reproduced ([Task-591](pa://task/591)).
 *
 * A failed operation used to pause to the human unconditionally, even where the
 * failure was deterministic and an agent would have diagnosed it in a turn —
 * which is what a human then did by hand. `identicalTailAttempts` is the
 * determinism evidence the engine already has: the semantic retry re-ran the
 * same reservation and reached the same conclusion, so a third identical
 * attempt is not what the run needs. The triage runs in the existing
 * implementer session, sees the operation's exact failure text, and hands the
 * reservation back; the host verifies afterwards that it left Git alone
 * (`workflow/operationTriage.ts`). A run still pauses to the human — one step
 * later, with a diagnosis instead of a bare operation error.
 *
 * A rebase conflict is NOT triaged: it has its own repair with its own Git
 * contract, and a conflict that survives that one is the manual path the docs
 * promise.
 */
function operationTriageAssignment(
  run: WorkflowRunRow,
  steps: readonly WorkflowStepRow[],
  last: WorkflowStepRow,
): WorkflowDecision | undefined {
  if (last.kind !== "host-operation") return undefined;
  if (last.status !== "failed" && last.status !== "blocked") return undefined;
  if (rebaseConflictOf(last)) return undefined;
  const phase = phaseOf(last);
  const payload = payloadRecord(last.payload);
  const operation = payload.operation;
  const idempotencyKey = payload.idempotencyKey;
  const summary = last.result?.summary?.trim();
  if (
    phase === undefined ||
    typeof operation !== "string" ||
    !operation ||
    typeof idempotencyKey !== "string" ||
    !idempotencyKey ||
    !summary
  )
    return undefined;
  // Determinism, not impatience: only a retry that reproduced the identical
  // conclusion is evidence an agent should look rather than the run try again.
  const attempts = identicalTailAttempts(steps);
  if (attempts < 2) return undefined;
  if (operationTriageBudget(steps, last).spent) return undefined;
  if (!acceptedWorkPlan(run, steps)) return undefined;
  return {
    kind: "append",
    step: {
      kind: "agent",
      payload: boundedRecipePayload(
        {
          role: "implementer",
          objective: "triage-operation",
          failedOperation: {
            operation,
            phase,
            stepId: last.id,
            status: last.status,
            summary,
            attempts,
            idempotencyKey,
          },
          resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
        },
        [["failedOperation", "summary"]],
      ),
      predecessorId: last.id,
    },
  };
}

/**
 * The operation a completed triage hands back, re-reserved against the triage
 * step itself.
 *
 * The failed step's payload travels WHOLE except for its key: a publication
 * carries the coordinator's routing fields, a base-sync its purpose, and
 * re-deriving any of that here would be a second opinion about what the run
 * already decided. Only the reservation is new, because a reservation names the
 * predecessor it was issued for.
 */
function reissuedOperationAfterTriage(
  run: WorkflowRunRow,
  steps: readonly WorkflowStepRow[],
  triage: WorkflowStepRow,
): WorkflowDecision | undefined {
  const evidence = operationTriagePayloadOf(triage);
  if (!evidence) return undefined;
  const failed = steps.find((step) => step.id === triage.predecessorId);
  if (
    !failed ||
    failed.id !== evidence.stepId ||
    failed.kind !== "host-operation" ||
    payloadRecord(failed.payload).operation !== evidence.operation
  )
    return pause(
      `triage step ${triage.id} is not attached to the ${evidence.operation} step it was assigned`,
    );
  return {
    kind: "append",
    step: {
      kind: "host-operation",
      payload: {
        ...payloadRecord(failed.payload),
        idempotencyKey: operationIdempotencyKey(
          run.id,
          evidence.operation,
          triage.id,
        ),
      },
      predecessorId: triage.id,
    },
  };
}

function describeStep(step: WorkflowStepRow): string {
  return `${phaseOf(step) ?? step.kind} step ${step.id}`;
}

/** Everything about a step's conclusion a user can see, as one comparable key. */
function outcomeKey(step: WorkflowStepRow): string {
  return [
    step.kind,
    phaseOf(step) ?? "",
    step.status,
    step.result?.summary?.trim() ?? "",
  ].join("\u0000");
}

/**
 * How many attempts in a row the tail of this history spent producing the SAME
 * outcome ([Task-399](pa://task/399)). 1 is a first attempt.
 *
 * A semantic retry appends a successor carrying its predecessor's exact payload,
 * so a DETERMINISTIC step re-derives the identical result — the run re-pauses
 * within a second and the pause reason differs by a step number alone, which
 * reads as a retry button that did nothing. Counting the chain is what lets the
 * pause reason and the card say "same result" instead of repeating themselves.
 *
 * Identical means the whole visible conclusion: same kind, same phase, same
 * status, same trimmed summary. The walk follows `predecessorId`, so two
 * unrelated steps that merely sit next to each other are never counted as
 * attempts at one thing.
 */
export function identicalTailAttempts(
  steps: readonly WorkflowStepRow[],
): number {
  const tail = steps[steps.length - 1];
  if (!tail) return 0;
  const byId = new Map(steps.map((step) => [step.id, step]));
  const key = outcomeKey(tail);
  let attempts = 1;
  let step = tail;
  while (step.predecessorId !== undefined) {
    const predecessor = byId.get(step.predecessorId);
    if (!predecessor) break;
    // An automatic triage is an INTERVENTION between attempts, not one of
    // them. Counting it would break the chain and report the attempt after a
    // triage as a first one, which is the moment the repetition matters most.
    if (operationTriagePayloadOf(predecessor)) {
      step = predecessor;
      continue;
    }
    if (outcomeKey(predecessor) !== key) break;
    attempts += 1;
    step = predecessor;
  }
  return attempts;
}

function pause(reason: string): WorkflowDecision {
  return { kind: "pause", reason };
}

/** The head commit a review step was assigned, from its recipe-owned payload. */
function assignedRangeHead(step: WorkflowStepRow): string | undefined {
  const range = payloadRecord(payloadRecord(step.payload).commitRange);
  const head = range.headCommit;
  return typeof head === "string" && head ? head : undefined;
}

function roleConfigKey(config: WorkPlanRoleConfig): string {
  return [
    config.provider.trim(),
    config.modelId.trim(),
    config.thinkingLevel.trim(),
    config.credentialProfileId.trim(),
    config.family.trim(),
  ].join("\u0000");
}

/** The exact configurations the run authorized for one role. */
function allowedRoleConfigKeys(
  run: WorkflowRunRow,
  role: "implementer" | "reviewer" | "fixer" | "verdict",
): Set<string> {
  const roles = payloadRecord(payloadRecord(run.config).roles);
  const candidates = Array.isArray(roles[role])
    ? roles[role].map(payloadRecord)
    : [];
  return new Set(
    candidates
      .filter(
        (candidate) =>
          typeof candidate.provider === "string" &&
          typeof candidate.modelId === "string" &&
          typeof candidate.thinkingLevel === "string" &&
          typeof candidate.credentialProfileId === "string" &&
          typeof candidate.family === "string",
      )
      .map((candidate) =>
        roleConfigKey(candidate as unknown as WorkPlanRoleConfig),
      ),
  );
}

/**
 * Read the coordinator's plan only when every choice remains inside
 * deterministic run authority. A structurally valid contract is not enough: the
 * recipe owns each role set, so the coordinator cannot expand one.
 */
export function acceptedWorkPlan(
  run: WorkflowRunRow,
  steps: readonly WorkflowStepRow[],
): WorkPlan | undefined {
  const planStep = [...steps]
    .reverse()
    .find(
      (step) =>
        phaseOf(step) === "plan" &&
        Boolean(readStepResult(step, WORK_PLAN_CONTRACT_ID)),
    );
  if (!planStep) return undefined;
  const plan = readStepResult(planStep, WORK_PLAN_CONTRACT_ID);
  if (!plan) return undefined;
  // Only the two roles the plan may choose. The fixer and the verdict are
  // chosen later, at the decisions that have their evidence (items 4 and 5 of
  // the recipe), so a plan naming them says nothing this run has to honor.
  const accepted =
    allowedRoleConfigKeys(run, "implementer").has(
      roleConfigKey(plan.implementer),
    ) &&
    allowedRoleConfigKeys(run, "reviewer").has(roleConfigKey(plan.reviewer));
  return accepted ? plan : undefined;
}

/**
 * The session identity of a verdict assignment: its runtime. A re-check of the
 * verdict's own findings carries the same configuration, so it returns to the
 * session that wrote them — while a LATER delivery naming a different verdict
 * runtime gets that runtime, instead of silently inheriting the session of the
 * one before it and running a model nobody chose.
 */
export function verdictSessionKey(step: WorkflowStepRow): string {
  const config = roleConfigOfPayload(payloadRecord(step.payload).verdict);
  return `verdict:${config ? roleConfigKey(config) : "unassigned"}`;
}

/**
 * The session identity of a fix assignment: which lineage's findings it answers,
 * and on which runtime. Recipe-owned because the payload is — the executor asks
 * rather than reading fields whose meaning lives here.
 */
export function fixerSessionKey(step: WorkflowStepRow): string {
  const payload = payloadRecord(step.payload);
  const lineage =
    typeof payload.fixerLineage === "string" ||
    typeof payload.fixerLineage === "number"
      ? String(payload.fixerLineage)
      : "0";
  const config = roleConfigOfPayload(payload.fixer);
  return `fixer:${lineage}:${config ? roleConfigKey(config) : "implementer"}`;
}

/** A role configuration recorded in a step payload, when it is a complete one. */
function roleConfigOfPayload(
  value: WorkflowJsonValue | undefined,
): WorkPlanRoleConfig | undefined {
  const record = payloadRecord(value);
  return typeof record.provider === "string" &&
    typeof record.modelId === "string" &&
    typeof record.thinkingLevel === "string" &&
    typeof record.credentialProfileId === "string" &&
    typeof record.family === "string"
    ? (value as unknown as WorkPlanRoleConfig)
    : undefined;
}

/**
 * The runtime a review step runs on: the one a review decision chose for it,
 * else the plan's reviewer. The step payload carries the choice, so the pass
 * that ran on it stays readable from history alone.
 */
export function reviewerConfigOf(
  run: WorkflowRunRow,
  steps: readonly WorkflowStepRow[],
  step: WorkflowStepRow,
): WorkPlanRoleConfig | undefined {
  return (
    roleConfigOfPayload(payloadRecord(step.payload).reviewer) ??
    acceptedWorkPlan(run, steps)?.reviewer
  );
}

/** The persisted fixer choice for a revise step, with implementer fallback. */
export function fixerConfigOf(
  run: WorkflowRunRow,
  steps: readonly WorkflowStepRow[],
  step: WorkflowStepRow,
): WorkPlanRoleConfig | undefined {
  return (
    roleConfigOfPayload(payloadRecord(step.payload).fixer) ??
    acceptedWorkPlan(run, steps)?.implementer
  );
}

/** Every discovery reviewer used so far, in pass order. */
function priorReviewerConfigs(
  run: WorkflowRunRow,
  steps: readonly WorkflowStepRow[],
): WorkPlanRoleConfig[] {
  return steps.filter(isDiscoveryReviewStep).flatMap((step) => {
    const config = reviewerConfigOf(run, steps, step);
    return config ? [config] : [];
  });
}

/**
 * Distinct sessions this run has opened. Reported as usage, never enforced as a
 * bound: what a run may open follows from its two ceilings.
 */
export function sessionsUsed(steps: readonly WorkflowStepRow[]): number {
  return new Set(
    steps
      .filter((step) => step.executor?.kind === "session")
      .map((step) => step.executor!.id),
  ).size;
}

/**
 * Whether the run could still run one more review pass after `completedPass`.
 * One ceiling answers it: how many independent opinions the run may buy. The
 * sessions those passes open follow from that number rather than bounding it,
 * so there is no second cap that could refuse a pass this one allows. The
 * coordinator is only ever asked a question that is still open.
 */
function canReviewAgain(
  run: WorkflowRunRow,
  _steps: readonly WorkflowStepRow[],
  completedPass: number,
): boolean {
  return completedPass < run.maxReviewPasses;
}

/**
 * The decision a completed `review-decision` step recorded, kept only while it
 * stays inside run authority: every runtime it names must belong to the role
 * set it was chosen from. An out-of-bounds choice is not stretched into one —
 * each caller falls back to what the run may do without an answer.
 */
function acceptedReviewDecision(
  run: WorkflowRunRow,
  step: WorkflowStepRow,
): ReviewDecision | undefined {
  const decision = readStepResult(step, REVIEW_DECISION_CONTRACT_ID);
  if (!decision) return undefined;
  const named: [WorkPlanRoleConfig | undefined, WorkflowRoleSetName][] = [
    [decision.reviewer, "reviewer"],
    [decision.fixer, "fixer"],
    [decision.verdict, "verdict"],
  ];
  for (const [config, role] of named)
    if (config && !allowedRoleConfigKeys(run, role).has(roleConfigKey(config)))
      return undefined;
  return decision;
}

/**
 * The focus a decision handed the step it routed to, read from the RAW result
 * rather than through `acceptedReviewDecision`.
 *
 * Deliberate, and not a loosening of run authority: that check exists because a
 * runtime outside its role set would CAUSE a step the run may not take, and it
 * refuses the whole answer to keep one bad name from smuggling the rest through.
 * Focus names no runtime and causes nothing — it is prose the next assignment
 * renders — so gating it on runtime authority would conflate two different
 * things and lose the diagnosis in exactly the case that needs it most: an
 * out-of-set fixer, where the findings go to the implementer instead and the
 * coordinator's reading of them is all that survives the refusal.
 * `latestReviewDecision` in `cardProjection.ts` reads `rationale` from the raw
 * decision for the same reason.
 */
function decisionFocusOf(step: WorkflowStepRow): string[] | undefined {
  const focus = readStepResult(
    step,
    REVIEW_DECISION_CONTRACT_ID,
  )?.focus?.filter((item) => item.trim().length > 0);
  return focus && focus.length > 0 ? focus : undefined;
}

type WorkflowRoleSetName = "implementer" | "reviewer" | "fixer" | "verdict";

/**
 * The runtime that judges the head about to ship. The coordinator names it at
 * the delivery decision, where it has the run's whole history to name it from;
 * a configured set with no usable choice still gets its gate, from the set's
 * first member, because dropping a judge the user asked for would be the one
 * outcome nobody chose.
 */
function verdictConfigFor(
  run: WorkflowRunRow,
  decision: ReviewDecision | undefined,
): WorkPlanRoleConfig | undefined {
  const set = roleSetPayload(run, "verdict");
  if (set.length === 0) return undefined;
  return decision?.verdict ?? roleConfigOfPayload(set[0]);
}

function reviewPassOf(step: WorkflowStepRow): number {
  const value = payloadRecord(step.payload).reviewPass;
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : 1;
}

/** A pass of FRESH eyes over the whole range, as opposed to a re-check. */
function isDiscoveryReviewStep(step: WorkflowStepRow): boolean {
  const payload = payloadRecord(step.payload);
  return payload.role === "reviewer" && payload.objective === "review";
}

/** How many independent opinions the run has bought so far. */
function latestDiscoveryPass(steps: readonly WorkflowStepRow[]): number {
  let pass = 0;
  for (const step of steps)
    if (isDiscoveryReviewStep(step)) pass = Math.max(pass, reviewPassOf(step));
  return pass;
}

/**
 * Files that more than one discovery pass has raised a finding in, newest
 * first, with how many passes each ([Task-592](pa://task/592)).
 *
 * A run that cycles and a run that is still exploring look identical from the
 * pass count alone, and they want opposite decisions. The difference is legible
 * in the findings themselves: across the measured runs, 75% of second-and-later
 * passes that raised anything named ZERO file a previous pass had not already
 * flagged — the reviewers were not covering new ground, they were re-deriving
 * the same unconverged seam, each paying to read the whole range again.
 *
 * Counted per PASS, never per finding: three findings in one file from one pass
 * are one reviewer's opinion, and calling that a repeat would manufacture a
 * seam out of a single thorough read.
 */
function repeatedFindingPaths(
  steps: readonly WorkflowStepRow[],
): { path: string; passes: number }[] {
  const passesByPath = new Map<string, Set<number>>();
  for (const step of steps) {
    if (!isDiscoveryReviewStep(step)) continue;
    const assessment = readStepResult(step, ASSESSMENT_CONTRACT_ID);
    if (!assessment) continue;
    const pass = reviewPassOf(step);
    for (const path of new Set(
      (assessment.findings ?? [])
        .map((finding) => finding.path)
        .filter((path): path is string => Boolean(path)),
    )) {
      const seen = passesByPath.get(path) ?? new Set<number>();
      seen.add(pass);
      passesByPath.set(path, seen);
    }
  }
  return [...passesByPath]
    .filter(([, passes]) => passes.size > 1)
    .map(([path, passes]) => ({ path, passes: passes.size }))
    .sort((left, right) => right.passes - left.passes);
}

/**
 * Whether a discovery review PASSED this exact head. A re-check judges its own
 * findings and a verdict judges their resolution; neither is fresh eyes over
 * what would ship, so neither answers this question. It is what the delivery
 * gate refuses without, because a fix round moves the head and every earlier
 * review describes a commit that is no longer being delivered.
 */
function hasPassingDiscoveryReview(
  steps: readonly WorkflowStepRow[],
  headCommit: string,
): boolean {
  const currentRange = commitRangeForHead(steps, headCommit);
  if (!currentRange) return false;
  return steps.some((step) => {
    if (!isDiscoveryReviewStep(step)) return false;
    const assigned = commitRangeOf(payloadRecord(step.payload).commitRange);
    const assessment = readStepResult(step, ASSESSMENT_CONTRACT_ID);
    return Boolean(
      assessment &&
      assigned &&
      assessment.verdict === "pass" &&
      assessment.headCommit === headCommit &&
      assigned.baseCommit === currentRange.baseCommit &&
      assigned.headCommit === currentRange.headCommit &&
      !isStaleAssessment(step, assessment),
    );
  });
}

/** Whether a verdict pass has already judged this exact head, either way. */
function hasVerdictFor(
  steps: readonly WorkflowStepRow[],
  headCommit: string,
): boolean {
  return steps.some((step) => {
    if (payloadRecord(step.payload).role !== "verdict") return false;
    const assessment = readStepResult(step, ASSESSMENT_CONTRACT_ID);
    return assessment?.headCommit === headCommit;
  });
}

/**
 * The assessment step whose findings a fix round answered — the AUTHOR that
 * re-checks it. A fix carrying machine CI findings has none: a failed check
 * names nobody to return to, and its re-check is the next CI result.
 */
function assessmentAuthorOf(
  steps: readonly WorkflowStepRow[],
): WorkflowStepRow | undefined {
  // Derived from the run's own history rather than from the fix that happens to
  // be last: an assessment that asked for changes is OUTSTANDING until its
  // author sees the answer, and a machine CI round in between is not an answer
  // to it. Reading the immediate predecessor lost the mandate whenever early CI
  // went red under a fix, and lost it again on a semantic retry, which appends
  // a COPY of the assignment under a different predecessor.
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]!;
    if (phaseOf(step) !== "review") continue;
    const assessment = readStepResult(step, ASSESSMENT_CONTRACT_ID);
    if (!assessment) continue;
    // The newest assessment settles it: a `revise` is owed a re-check by the
    // step that wrote it, and anything else means nothing is outstanding.
    return assessment.verdict === "revise" ? step : undefined;
  }
  return undefined;
}

/** What an outstanding assessment asked for, read from its own result. */
function outstandingFindings(author: WorkflowStepRow): {
  findings: ReviewFinding[];
  reviewSetId?: string;
} {
  const assessment = readStepResult(author, ASSESSMENT_CONTRACT_ID);
  return {
    findings: assessment?.findings ?? [],
    ...(assessment?.reviewSetId ? { reviewSetId: assessment.reviewSetId } : {}),
  };
}

/**
 * What the newest implementation step reported. Derived from history like
 * everything else here, so the review assignment carries the implementer's
 * words without the reviewer having to read another session's transcript.
 */
function implementerReportOf(
  steps: readonly WorkflowStepRow[],
): ImplementerReport | undefined {
  const implement = [...steps].reverse().find((step) => {
    const payload = payloadRecord(step.payload);
    return (
      phaseOf(step) === "implement" &&
      payload.objective !== "triage-operation" &&
      payload.objective !== "repair-rebase" &&
      Boolean(readStepResult(step, IMPLEMENTATION_RESULT_CONTRACT_ID))
    );
  });
  if (!implement) return undefined;
  const result = readStepResult(implement, IMPLEMENTATION_RESULT_CONTRACT_ID)!;
  const summary = implement.result?.summary?.trim();
  const notes = result.notes?.trim();
  const responses = result.responses ?? [];
  const report: ImplementerReport = {
    ...(summary ? { summary } : {}),
    ...(notes ? { notes } : {}),
    ...(responses.length > 0 ? { responses } : {}),
  };
  return Object.keys(report).length > 0 ? report : undefined;
}

/**
 * What the newest fix round left on the threads of `reviewSetId`. Read from
 * the step result the submitting side recorded rather than from the review
 * store, so the recipe stays pure and a restart re-derives the same evidence.
 *
 * The newest round FOR THIS SET, not the newest round: a fix answering set A
 * can be followed by a CI round, which answers machine failure and owns no set
 * at all, before A's author ever re-checks it. Letting that unrelated result
 * shadow the lookup would hand the author an empty record of its own findings —
 * every dispute and every fix erased — and reset the card's rollup to all-open.
 */
export function findingResolutionsOf(
  steps: readonly WorkflowStepRow[],
  reviewSetId: string,
): ReviewFindingResolution[] {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]!;
    if (phaseOf(step) !== "implement") continue;
    const result = readStepResult(step, IMPLEMENTATION_RESULT_CONTRACT_ID);
    if (!result) continue;
    if (result.reviewSetId !== reviewSetId) continue;
    return result.resolutions ?? [];
  }
  return [];
}

/**
 * What the threads of `reviewSetId` say NOW: the newest word about that set
 * from either side of the conversation — a fix round's record of what it left,
 * or the snapshot a re-check's settlement read back off the threads.
 *
 * Newest wins, whichever kind it is, because the two alternate: a fix answers,
 * its author settles, a re-check that still wants changes sends another fix.
 * Reading only the fix round would have a later judge told a finding is
 * `disputed` when its author has since accepted that dispute and closed the
 * thread — arguing a settled point back open.
 *
 * NOT what a re-check's own assignment is given: that one is handed what the
 * FIX ROUND left, because it is the step about to settle those threads and
 * would otherwise be shown the state its own previous attempt created.
 */
function threadStateOf(
  steps: readonly WorkflowStepRow[],
  reviewSetId: string,
): ReviewFindingResolution[] {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]!;
    const phase = phaseOf(step);
    if (phase === "implement") {
      const result = readStepResult(step, IMPLEMENTATION_RESULT_CONTRACT_ID);
      if (result?.reviewSetId === reviewSetId) return result.resolutions ?? [];
      continue;
    }
    if (phase !== "review") continue;
    const assessment = readStepResult(step, ASSESSMENT_CONTRACT_ID);
    if (assessment?.reviewSetId === reviewSetId && assessment.settlement)
      return assessment.settlement;
  }
  return [];
}

function reviewStep(
  predecessorId: number,
  range: { baseCommit: string; headCommit: string },
  pass: number,
  maxReviewPasses: number,
  report: ImplementerReport | undefined,
  ciResults: WorkflowCiResult | undefined,
  shape?: { focus?: string[]; reviewer?: WorkPlanRoleConfig },
): WorkflowDecision {
  const focus = (shape?.focus ?? []).filter((item) => item.trim().length > 0);
  return {
    kind: "append",
    step: {
      kind: "agent",
      payload: boundedRecipePayload(
        {
          role: "reviewer",
          objective: "review",
          commitRange: range,
          reviewPass: pass,
          maxReviewPasses,
          ...(focus.length > 0 ? { focus } : {}),
          ...(shape?.reviewer
            ? { reviewer: shape.reviewer as unknown as WorkflowJsonValue }
            : {}),
          ...(report ? { implementerReport: report } : {}),
          ...(ciResults
            ? { ciResults: ciResults as unknown as WorkflowJsonValue }
            : {}),
          resultContract: ASSESSMENT_CONTRACT_ID,
        },
        [
          ["ciResults", "checks"],
          ["implementerReport", "summary"],
          ["implementerReport", "notes"],
          ["focus"],
          ["implementerReport", "responses"],
        ],
      ),
      predecessorId,
    },
  };
}

/**
 * The author of the findings, asked whether its own findings are resolved.
 *
 * Findings return to their author because nobody else knows what one MEANT: the
 * session that wrote them still holds the reasoning, so the re-check costs no
 * session and reconstructs no argument from a diff. It runs in that session by
 * construction — the payload carries the author's role, its review pass and its
 * configuration, which is exactly what the executor keys a role session by.
 */
function reCheckStep(
  predecessorId: number,
  author: WorkflowStepRow,
  range: { baseCommit: string; headCommit: string },
  findings: ReviewFinding[],
  report: ImplementerReport | undefined,
  ciResults: WorkflowCiResult | undefined,
  reviewSet: {
    reviewSetId?: string;
    findingResolutions?: ReviewFindingResolution[];
  },
): WorkflowDecision {
  const authorPayload = payloadRecord(author.payload);
  const isVerdictAuthor = authorPayload.role === "verdict";
  const authorConfig = isVerdictAuthor
    ? authorPayload.verdict
    : authorPayload.reviewer;
  const resolutions = reviewSet.findingResolutions ?? [];
  return {
    kind: "append",
    step: {
      kind: "agent",
      payload: boundedRecipePayload(
        {
          role: isVerdictAuthor ? "verdict" : "reviewer",
          objective: "re-check",
          commitRange: range,
          findings,
          answersStepId: author.id,
          // WHICH session wrote these findings. The re-check normally runs in
          // it — that is the whole point — but a session the user deleted
          // cannot be reopened, and stranding the run over that would be worse
          // than continuing. Recording the author lets the assignment tell the
          // truth about who it is talking to instead of assuming.
          ...(author.executor?.kind === "session"
            ? { authorSessionId: author.executor.id }
            : {}),
          ...(isVerdictAuthor ? {} : { reviewPass: reviewPassOf(author) }),
          // The author's own configuration, so a restart rebuilds the session
          // that wrote these findings rather than the plan's current choice.
          ...(authorConfig
            ? isVerdictAuthor
              ? { verdict: authorConfig }
              : { reviewer: authorConfig }
            : {}),
          ...(report ? { implementerReport: report } : {}),
          ...(ciResults
            ? { ciResults: ciResults as unknown as WorkflowJsonValue }
            : {}),
          ...(reviewSet.reviewSetId
            ? { reviewSetId: reviewSet.reviewSetId }
            : {}),
          ...(resolutions.length > 0
            ? {
                findingResolutions:
                  resolutions as unknown as WorkflowJsonValue[],
              }
            : {}),
          resultContract: ASSESSMENT_CONTRACT_ID,
        },
        [
          ["ciResults", "checks"],
          ["implementerReport", "notes"],
          ["implementerReport", "summary"],
          ["implementerReport", "responses"],
          ["findingResolutions"],
          ["findings"],
        ],
      ),
      predecessorId,
    },
  };
}

/** A post-fix assessment that judges resolution rather than rediscovering. */
function verdictStep(
  predecessorId: number,
  range: { baseCommit: string; headCommit: string },
  findings: ReviewFinding[],
  report: ImplementerReport | undefined,
  verdict: WorkPlanRoleConfig,
  ciResults: WorkflowCiResult | undefined,
  reviewSet?: {
    reviewSetId?: string;
    findingResolutions?: ReviewFindingResolution[];
  },
  freshnessChecked = false,
): WorkflowDecision {
  const resolutions = reviewSet?.findingResolutions ?? [];
  return {
    kind: "append",
    step: {
      kind: "agent",
      payload: boundedRecipePayload(
        {
          role: "verdict",
          objective: "verdict",
          commitRange: range,
          findings,
          verdict: verdict as unknown as WorkflowJsonValue,
          ...(report ? { implementerReport: report } : {}),
          ...(ciResults
            ? { ciResults: ciResults as unknown as WorkflowJsonValue }
            : {}),
          ...(reviewSet?.reviewSetId
            ? { reviewSetId: reviewSet.reviewSetId }
            : {}),
          ...(resolutions.length > 0
            ? {
                findingResolutions:
                  resolutions as unknown as WorkflowJsonValue[],
              }
            : {}),
          ...(freshnessChecked ? { freshnessChecked: true } : {}),
          resultContract: ASSESSMENT_CONTRACT_ID,
        },
        [
          ["ciResults", "checks"],
          ["implementerReport", "notes"],
          ["implementerReport", "summary"],
          ["implementerReport", "responses"],
          ["findingResolutions"],
          ["findings"],
        ],
      ),
      predecessorId,
    },
  };
}

/**
 * The change evidence recorded for this exact head by the commit/sync step that
 * produced it. Matched by head commit rather than by position: an assessment
 * and its evidence must describe the same commit (foundation invariant 3).
 */
function isRangeOperationStep(step: WorkflowStepRow): boolean {
  const phase = phaseOf(step);
  return phase === "commit-sync" || phase === "commit" || phase === "base-sync";
}

function rangeChangesOf(
  steps: readonly WorkflowStepRow[],
  headCommit: string,
): CommitRangeChanges | undefined {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]!;
    if (!isRangeOperationStep(step)) continue;
    const result = readStepResult(step, COMMIT_SYNC_RESULT_CONTRACT_ID);
    if (result?.headCommit === headCommit) return result.changes;
  }
  return undefined;
}

function ciResultsOf(
  run: WorkflowRunRow,
  steps: readonly WorkflowStepRow[],
  headCommit: string,
): WorkflowCiResult | undefined {
  const config = payloadRecord(run.config);
  if (!Object.hasOwn(config, "earlyPush")) return undefined;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]!;
    if (phaseOf(step) !== "ci") continue;
    const result = readStepResult(step, CI_OBSERVATION_RESULT_CONTRACT_ID);
    if (result?.headCommit === headCommit) return result;
  }
  return {
    outcome: "none",
    headCommit,
    checks: [],
    reason:
      config.earlyPush === true
        ? "No CI observation was recorded for this commit."
        : "Early push and CI observation were disabled for this run.",
  };
}

/**
 * Which of its three questions this decision step asks. They are one judgement
 * — who acts on this evidence next — at the three moments the run HAS evidence
 * for it, and the recipe records the question so the assignment and the branch
 * that reads the answer can never disagree about what was asked.
 */
type ReviewDecisionQuestion =
  /** A discovery pass accepted this head: ship it, or buy another opinion. */
  | "deliver-or-review"
  /** A re-check cleared: the fix moved the head, so only WHICH eyes is open. */
  | "review-again"
  /** Something asked for changes: who answers findings that now exist. */
  | "route-fix";

/** The coordinator's post-assessment call, in its own session, on this range. */
function reviewDecisionStep(
  run: WorkflowRunRow,
  steps: readonly WorkflowStepRow[],
  assessmentStep: WorkflowStepRow,
  assessment: Assessment,
  range: { baseCommit: string; headCommit: string },
  completedPass: number,
  question: ReviewDecisionQuestion,
): WorkflowDecision {
  const reviewSummary = assessmentStep.result?.summary?.trim();
  const observations = assessment.observations ?? [];
  const changes = rangeChangesOf(steps, range.headCommit);
  const report = implementerReportOf(steps);
  const ciResults = ciResultsOf(run, steps, range.headCommit);
  const priorReviewers = priorReviewerConfigs(run, steps);
  const priorFixers = priorFixerRounds(steps);
  const plan = acceptedWorkPlan(run, steps);
  if (!plan) return pause("the accepted work plan is no longer readable");
  const routing = question === "route-fix";
  // Only where it is acted on: routing is the question that weighs whether a
  // finding is converging, and the other two are not choosing a fix round.
  const findingRounds = routing
    ? findingFixRounds(steps, assessment.findings)
    : [];
  const repeatedPaths = routing ? [] : repeatedFindingPaths(steps);
  const reviewSetId = assessment.reviewSetId;
  return {
    kind: "append",
    step: {
      kind: "agent",
      payload: boundedRecipePayload(
        {
          role: "coordinator",
          objective: "review-decision",
          question,
          // Only the sets an answer to THIS question may name: a decision the
          // recipe would refuse is not worth offering.
          roles: routing
            ? { fixer: roleSetPayload(run, "fixer") }
            : {
                reviewer: roleSetPayload(run, "reviewer"),
                ...(question === "deliver-or-review"
                  ? { verdict: roleSetPayload(run, "verdict") }
                  : {}),
              },
          implementer: plan.implementer as unknown as WorkflowJsonValue,
          commitRange: range,
          assessmentStepId: assessmentStep.id,
          completedReviewPass: completedPass,
          maxReviewPasses: run.maxReviewPasses,
          remainingIterations: Math.max(
            0,
            run.maxIterations - countIterations(steps),
          ),
          ...(priorReviewers.length > 0
            ? {
                priorReviewers: priorReviewers as unknown as WorkflowJsonValue,
              }
            : {}),
          ...(priorFixers.length > 0
            ? { priorFixers: priorFixers as unknown as WorkflowJsonValue }
            : {}),
          // Present on every routing question, empty included: an empty table
          // is the run saying no routed finding has been answered before, while
          // no table at all means composition could not carry it. Collapsing
          // those two would let a pressured assignment show a finding three
          // rounds deep exactly like a fresh one.
          ...(routing
            ? { findingRounds: findingRounds as unknown as WorkflowJsonValue }
            : {}),
          // Only where it is acted on: choosing the next PASS is the decision
          // that can point one at a seam, and routing a fix already has the
          // per-finding round counts for the same question.
          ...(!routing && repeatedPaths.length > 0
            ? { repeatedPaths: repeatedPaths as unknown as WorkflowJsonValue }
            : {}),
          ...(reviewSummary ? { reviewSummary } : {}),
          ...(assessment.findings.length > 0
            ? { findings: assessment.findings }
            : {}),
          ...(reviewSetId && routing
            ? {
                findingResolutions: threadStateOf(
                  steps,
                  reviewSetId,
                ) as unknown as WorkflowJsonValue[],
              }
            : {}),
          ...(observations.length > 0 ? { observations } : {}),
          ...(changes
            ? { changes: changes as unknown as WorkflowJsonValue }
            : {}),
          ...(report ? { implementerReport: report } : {}),
          ...(ciResults
            ? { ciResults: ciResults as unknown as WorkflowJsonValue }
            : {}),
          resultContract: REVIEW_DECISION_CONTRACT_ID,
        },
        // Shrink order is priority order: earlier groups give way first, and
        // FINDINGS are near the end because they are the only group that
        // becomes work. Everything historical goes ahead of them — a past
        // round's `notes` come from an implementation result with no field
        // limit of its own, and the change stat grows with the diff, so
        // leaving either unshrinkable let accumulated history squeeze the
        // findings' own text. Row survival is not the guarantee; the sentence
        // that says what is wrong is.
        [
          ["ciResults", "checks"],
          ["priorFixers"],
          // Droppable, and droppable EARLY: it is derived from history the
          // payload already carries, so losing it costs the coordinator a
          // summary of what it could otherwise infer. Left unshrinkable it
          // took its room from the findings' own text, which is the one place
          // this payload may not economize.
          ["findingRounds"],
          // Dropped early for a DIFFERENT reason than findingRounds: this one
          // is not reconstructible from the payload, which carries only the
          // current assessment's findings and not the earlier passes' this is
          // derived from. It goes early anyway because it is an advisory the
          // decision can be made without, and the findings it would otherwise
          // take room from cannot be.
          ["repeatedPaths"],
          ["changes"],
          ["priorReviewers"],
          ["implementerReport", "responses"],
          ["implementerReport", "notes"],
          ["implementerReport", "summary"],
          ["observations"],
          ["findingResolutions"],
          ["findings"],
          ["reviewSummary"],
        ],
      ),
      predecessorId: assessmentStep.id,
    },
  };
}

/**
 * What each fix round so far was given to, and what came of it: the evidence
 * for escalating, keeping, or bypassing a fixer. Derived from history, like
 * everything else the coordinator is handed.
 */
function priorFixerRounds(
  steps: readonly WorkflowStepRow[],
): WorkflowJsonValue[] {
  const rounds: WorkflowJsonValue[] = [];
  for (const step of steps) {
    const payload = payloadRecord(step.payload);
    if (payload.role !== "implementer" || payload.objective !== "revise")
      continue;
    // One round per conversation: an attempt a retry replaced is that retry's
    // own beginning, not a second round the coordinator should weigh.
    if (supersededByRetry(steps, step)) continue;
    const config = roleConfigOfPayload(payload.fixer);
    const reported = readStepResult(step, IMPLEMENTATION_RESULT_CONTRACT_ID);
    rounds.push({
      assignee: config ? "fixer" : "implementer",
      ...(config ? { fixer: config as unknown as WorkflowJsonValue } : {}),
      // WHICH conversation this round belongs to. Without it the list is a flat
      // count of rounds, and "this lineage has already spent rounds on the same
      // finding" — the prompt's own re-implementation signal — is not a
      // judgement the evidence supports: two rounds answering two different
      // reviewers read exactly like two rounds failing at one. Absent on rows
      // written before every round recorded it, and then simply not stated.
      ...(typeof payload.fixerLineage === "string" ||
      typeof payload.fixerLineage === "number"
        ? { lineage: String(payload.fixerLineage) }
        : {}),
      findingCount: Array.isArray(payload.findings)
        ? payload.findings.length
        : 0,
      ...(reported?.notes ? { notes: reported.notes } : {}),
      // What the round actually WROTE, from the commit/sync that measured it.
      // A fix that outgrows the implementation it is fixing is the shape of
      // re-implementation, and the fixer's own account of its work is a claim.
      ...fixRoundOutcome(steps, step),
    });
  }
  return rounds;
}

/**
 * How many fix rounds each finding being routed has ALREADY been through.
 *
 * The count is the run's own record, not an inference: a finding keeps its
 * published thread across rounds, because a re-check that still wants it
 * restates it VERBATIM and the server adopts the existing thread rather than
 * opening a second one (`reviewSets.ts`). So a thread appearing in the findings
 * of N fix assignments was handed to N rounds and came back, which is the one
 * fact separating "the last attempt did not land" from "a reviewer found
 * something new".
 *
 * The coordinator is told to route a finding a lineage has already spent rounds
 * on to the implementer as re-implementation. That instruction predates any
 * evidence for it: the round list says how many rounds happened, never which
 * finding they were spent on, so the judgement it asked for could not be made
 * from what it was handed. This is that evidence.
 *
 * Keyed by thread, so a finding no reviewer anchored carries no count rather
 * than a guessed one, and bounded by the assessment's own finding cap
 * (`ASSESSMENT_FINDINGS_MAX_COUNT`) — small enough that it never competes with
 * the findings for room.
 *
 * The count is NOT split by lineage, and does not need to be: a thread belongs
 * to the review set it was published in, and a new discovery or verdict pass
 * publishes a new set, so a restated finding that crosses into another lineage
 * is a NEW thread whose count starts over. Within one lineage the total and the
 * per-lineage count are the same number, which is why the rule the prompt states
 * — a lineage that has already spent rounds on this finding is
 * re-implementation — is a judgement this supports. Summing across lineages is
 * not a semantic worth claiming: it would need a thread the recipe does not
 * produce, and asserting it in the prompt only invited the reader to look for a
 * distinction the number does not carry.
 */
function findingFixRounds(
  steps: readonly WorkflowStepRow[],
  findings: readonly ReviewFinding[],
): WorkflowJsonValue[] {
  const routed = new Set(
    findings
      .map((finding) => finding.commentId)
      .filter((commentId): commentId is string => Boolean(commentId)),
  );
  if (routed.size === 0) return [];
  const rounds = new Map<string, number>();
  for (const step of steps) {
    const payload = payloadRecord(step.payload);
    if (payload.role !== "implementer" || payload.objective !== "revise")
      continue;
    // The same rounds `priorFixerRounds` counts, for the same reason: an
    // attempt a retry replaced is that retry's own beginning.
    if (supersededByRetry(steps, step)) continue;
    const handed = new Set(
      (Array.isArray(payload.findings) ? payload.findings : [])
        .map((finding) => stringValueOf(payloadRecord(finding).commentId))
        .filter((commentId): commentId is string => Boolean(commentId)),
    );
    for (const commentId of handed)
      if (routed.has(commentId))
        rounds.set(commentId, (rounds.get(commentId) ?? 0) + 1);
  }
  return [...rounds]
    .filter(([, count]) => count > 0)
    .map(([commentId, count]) => ({ commentId, rounds: count }));
}

/**
 * Which conversation a fix round belongs to: the assessment lineage whose
 * findings it answers. A reviewer's is its PASS, so the rounds answering one
 * reviewer share a fixer session; the verdict's is its own name rather than a
 * number, so a verdict-routed fix can never collide with a same-numbered
 * reviewer lineage — a reachability argument would be load-bearing and
 * invisible, and this needs neither.
 */
function fixerLineageOf(assessmentStep: WorkflowStepRow): string {
  const payload = payloadRecord(assessmentStep.payload);
  return payload.role === "verdict"
    ? "verdict"
    : `pass-${String(reviewPassOf(assessmentStep))}`;
}

/**
 * The rework assignment: the findings, their author's words, and the runtime
 * the coordinator routed them to. A `fixer` in the payload is BOTH the runtime
 * and the lineage marker the executor keys that session by, so escalating to a
 * different configuration opens a fresh session rather than piling another
 * round onto the one that already stalled; no fixer means the implementer's
 * own session, which is where design intent lives.
 *
 * `focus` is the coordinator's one channel to that round: its rationale is the
 * run's record of WHO does the work, so a diagnosis it wants acted on has to
 * travel as focus or not at all.
 */
function fixStep(
  assessmentStep: WorkflowStepRow,
  assessment: Assessment,
  fixer: WorkPlanRoleConfig | undefined,
  focusList?: string[],
): WorkflowDecision {
  const reviewSummary = assessmentStep.result?.summary?.trim();
  const observations = assessment.observations ?? [];
  const focus = (focusList ?? []).filter((item) => item.trim().length > 0);
  return {
    kind: "append",
    step: {
      kind: "agent",
      payload: boundedRecipePayload(
        {
          role: "implementer",
          objective: "revise",
          reviewedCommit: assessment.headCommit,
          findings: assessment.findings,
          ...(assessment.reviewSetId
            ? { reviewSetId: assessment.reviewSetId }
            : {}),
          ...(reviewSummary ? { reviewSummary } : {}),
          ...(observations.length > 0 ? { observations } : {}),
          ...(focus.length > 0 ? { focus } : {}),
          // The lineage is recorded for EVERY round, not only a fixer's. It is
          // the fixer's session key, which is why it began there — but it is
          // also the only record of which conversation a round belongs to, and
          // the coordinator is asked to weigh how many rounds a lineage has
          // spent. An implementer-routed round left unmarked made its own
          // lineage unreadable, so a later routing decision could not tell one
          // conversation's rounds from another's. Inert for session identity:
          // `roleOf` keys a round to the fixer role by its `fixer`, never by
          // this.
          fixerLineage: fixerLineageOf(assessmentStep),
          ...(fixer ? { fixer: fixer as unknown as WorkflowJsonValue } : {}),
          resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
        },
        // Guidance gives way after the reviewer's own summary and before the
        // findings, which stay lossless: the round's mandate is the one thing a
        // shrunk assignment may not lose.
        [["observations"], ["reviewSummary"], ["focus"], ["findings"]],
      ),
      predecessorId: assessmentStep.id,
    },
  };
}

/**
 * The lineage every machine-attributed repair shares. A name rather than a
 * number, like the verdict's, so it can never collide with a `pass-N`.
 */
const CI_FIX_LINEAGE = "ci";

/**
 * Whether a checkpoint measured THIS round's work — the narrow question, not
 * `causedBy`'s. Every step in a run descends from every earlier one, so causal
 * reachability is true of the whole history and answers nothing here.
 *
 * What makes a round the author of a checkpoint is being the newest work in
 * that checkpoint's own chain: walking back, the round has to arrive before any
 * completed checkpoint does. Once an earlier checkpoint measured it, whatever a
 * later one is measuring came after, and the round's conversation is closed.
 */
function checkpointMeasures(
  steps: readonly WorkflowStepRow[],
  commitStep: WorkflowStepRow,
  round: WorkflowStepRow,
): boolean {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const seen = new Set<number>([commitStep.id]);
  let current = byId.get(commitStep.predecessorId ?? -1);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.id === round.id) return true;
    const phase = phaseOf(current);
    // A failed attempt measured nothing; its retry is the same checkpoint.
    const measured =
      current.result?.status === "completed" &&
      (phase === "commit-sync" ||
        phase === "commit" ||
        phase === "base-sync" ||
        phase === "ci");
    if (measured) return false;
    current = byId.get(current.predecessorId ?? -1);
  }
  return false;
}

/**
 * Who answers a red check. A failed check names no author to return to and
 * offers the coordinator nothing to choose between, so the recipe assigns it
 * rather than asking.
 *
 * A fixer whose OWN work is what failed cleans up after itself: its session
 * holds the round this checkpoint measured, and it is cheap. What a red check
 * may NOT do is fall through to the implementer's own session, which is this
 * run's most expensive context and the one least in need of a named failing
 * test and a CI log (Task-592: 10 of 14 measured CI repairs took that fallback,
 * at $10.15 a round against $1.03 elsewhere). Anything else opens one dedicated
 * session for the run's machine repairs, on the first fixer candidate — the
 * same deterministic index the verdict fallback picks when the recipe must
 * choose a runtime without asking.
 *
 * "Its own work" is a CAUSAL question, not a positional one. The newest fix
 * round in the list is not necessarily what this check measured: a fixer's
 * round can finish green and be accepted, and a later base-sync onto a moved
 * main can then fail a check that has nothing to do with it. Returning that
 * fixer would drop a machine repair into a settled reviewer conversation,
 * carrying a `pass-N` lineage whose findings are closed. So the checkpoint CI
 * observed has to descend from the round before that round owns the failure.
 *
 * Only an empty fixer set leaves the implementer as the single answer, which is
 * the same argument `decideNextStep` makes before skipping the routing question
 * altogether.
 */
function ciRepairAssignment(
  run: WorkflowRunRow,
  steps: readonly WorkflowStepRow[],
  /** The checkpoint this CI observation measured. */
  commitStep: WorkflowStepRow,
): Record<string, WorkflowJsonValue> {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const round = steps[index]!;
    const payload = payloadRecord(round.payload);
    if (payload.role !== "implementer" || payload.objective !== "revise")
      continue;
    const fixer = roleConfigOfPayload(payload.fixer);
    if (!fixer || !checkpointMeasures(steps, commitStep, round)) break;
    return {
      fixer: fixer as unknown as WorkflowJsonValue,
      // Whatever shape the lineage marker has — a string since fix rounds
      // learned to name their author, a number in rows written before that —
      // it must travel, or a CI round opens a session beside the fixer that is
      // already doing this run's work.
      ...(typeof payload.fixerLineage === "string" ||
      typeof payload.fixerLineage === "number"
        ? { fixerLineage: payload.fixerLineage }
        : {}),
    };
  }
  const dedicated = roleConfigOfPayload(roleSetPayload(run, "fixer")[0]);
  return dedicated
    ? {
        fixer: dedicated as unknown as WorkflowJsonValue,
        fixerLineage: CI_FIX_LINEAGE,
      }
    : {};
}

/**
 * Whether one step's causal chain reaches another: the run's own record of what
 * followed from what. Position is not that record — a semantic retry appends a
 * successor, and a blocked operation's retry appends another, so "the next
 * commit/sync in the list" can belong to an attempt that is not this one.
 */
function causedBy(
  steps: readonly WorkflowStepRow[],
  step: WorkflowStepRow,
  ancestor: WorkflowStepRow,
): boolean {
  let current: WorkflowStepRow | undefined = step;
  const seen = new Set<number>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.predecessorId === ancestor.id) return true;
    const next: WorkflowStepRow | undefined = steps.find(
      (candidate) => candidate.id === current!.predecessorId,
    );
    current = next;
  }
  return false;
}

/**
 * Whether a later attempt replaced this one. A semantic retry appends a copy of
 * the assignment whose predecessor is the attempt it replaces, so the two are
 * ONE round of the conversation; reporting both would show the coordinator two
 * rounds where one agent did one piece of work.
 */
function supersededByRetry(
  steps: readonly WorkflowStepRow[],
  fixStep: WorkflowStepRow,
): boolean {
  const payload = payloadRecord(fixStep.payload);
  return steps.some((step) => {
    if (step.predecessorId !== fixStep.id) return false;
    const candidate = payloadRecord(step.payload);
    return (
      candidate.role === payload.role &&
      candidate.objective === payload.objective
    );
  });
}

/**
 * What a fix round produced and what became of it, both tied to the COMMIT it
 * made rather than to its position in the history.
 *
 * Position lies as soon as anything happens between a round and its judgment: a
 * red CI round landing between two fixes would otherwise let the first borrow
 * the assessment that accepted the second, and report a round that broke the
 * build as accepted — to the coordinator deciding whether to keep, escalate or
 * bypass that very fixer. Size stays bounded to totals, since the judgement is
 * proportion and a per-file list of every past round would crowd out the
 * findings being routed.
 *
 * `outcome` says which of THREE things happened, because a coordinator weighing
 * whether to keep or replace a fixer cannot act on a flag that means both "a
 * reviewer read this round and wanted more" and "nothing has looked at it yet":
 * `accepted`, `rejected`, or `unjudged` — the last covering both a round no
 * assessment has reached and one that produced no commit to judge.
 */
function fixRoundOutcome(
  steps: readonly WorkflowStepRow[],
  fixStep: WorkflowStepRow,
): Record<string, WorkflowJsonValue> {
  const produced = steps.find(
    (step) =>
      step.id > fixStep.id &&
      isRangeOperationStep(step) &&
      Boolean(readStepResult(step, COMMIT_SYNC_RESULT_CONTRACT_ID)) &&
      causedBy(steps, step, fixStep),
  );
  const range = produced
    ? readStepResult(produced, COMMIT_SYNC_RESULT_CONTRACT_ID)
    : undefined;
  if (!range) return { outcome: "unjudged" };
  const head = range.headCommit;
  const changes = range.changes;
  const ciRed = steps.some((step) => {
    if (step.id <= fixStep.id || phaseOf(step) !== "ci") return false;
    const observed = readStepResult(step, CI_OBSERVATION_RESULT_CONTRACT_ID);
    return observed?.headCommit === head && observed.outcome === "red";
  });
  // What the assessments OF THIS HEAD concluded about the round. Acceptance is
  // any of them accepting it, exactly as before: a later discovery pass finding
  // something NEW in the same commit is not this round being rejected — its
  // answer was accepted by the reviewer who judged it. The split is only of the
  // old false, which said nothing about which of these two happened.
  const judgements = steps.flatMap((step) => {
    if (step.id <= fixStep.id || phaseOf(step) !== "review") return [];
    const assessment = readStepResult(step, ASSESSMENT_CONTRACT_ID);
    return assessment &&
      assessment.headCommit === head &&
      !isStaleAssessment(step, assessment)
      ? [assessment.verdict]
      : [];
  });
  const outcome = judgements.includes("pass")
    ? "accepted"
    : judgements.length > 0
      ? "rejected"
      : "unjudged";
  return {
    ...(changes
      ? {
          changed: {
            filesChanged: changes.filesChanged,
            insertions: changes.insertions,
            deletions: changes.deletions,
          },
        }
      : {}),
    ...(ciRed ? { ciRed: true } : {}),
    outcome,
  };
}

/**
 * Routing that must survive a base-sync conflict repair. It is copied from the
 * checkpoint payload rather than reconstructed from the work plan: a
 * coordinator may have deliberately selected a different reviewer or verdict
 * runtime for this pass.
 */
export function baseSyncResumePayloadOf(
  payload: WorkflowJsonValue | undefined,
): {
  purpose: "discovery" | "delivery";
  reviewer?: WorkflowJsonValue;
  focus?: string[];
  verdict?: WorkflowJsonValue;
  authorizedByUser?: true;
} {
  const record = payloadRecord(payload);
  const reviewer = roleConfigOfPayload(record.reviewer);
  const verdict = roleConfigOfPayload(record.verdict);
  const focus =
    Array.isArray(record.focus) &&
    record.focus.every((item) => typeof item === "string")
      ? (record.focus as string[])
      : undefined;
  return {
    purpose: record.purpose === "delivery" ? "delivery" : "discovery",
    ...(reviewer ? { reviewer: reviewer as unknown as WorkflowJsonValue } : {}),
    ...(focus ? { focus } : {}),
    ...(verdict ? { verdict: verdict as unknown as WorkflowJsonValue } : {}),
    ...(record.authorizedByUser === true ? { authorizedByUser: true } : {}),
  };
}

/** Append a recipe-owned synchronization checkpoint. */
function baseSyncStep(
  run: WorkflowRunRow,
  predecessor: WorkflowStepRow,
  purpose: "discovery" | "delivery",
  options: {
    reviewer?: WorkPlanRoleConfig;
    focus?: string[];
    verdict?: WorkPlanRoleConfig;
    authorizedByUser?: boolean;
  } = {},
): WorkflowDecision {
  return {
    kind: "append",
    step: {
      kind: "host-operation",
      payload: {
        operation: BASE_SYNC_OPERATION_ID,
        idempotencyKey: baseSyncIdempotencyKey(run.id, predecessor.id),
        purpose,
        ...(options.reviewer
          ? { reviewer: options.reviewer as unknown as WorkflowJsonValue }
          : {}),
        ...(options.focus ? { focus: options.focus } : {}),
        ...(options.verdict
          ? { verdict: options.verdict as unknown as WorkflowJsonValue }
          : {}),
        ...(options.authorizedByUser ? { authorizedByUser: true } : {}),
      },
      predecessorId: predecessor.id,
    },
  };
}

/** The delivery gate for a head an accepted assessment named. */
function deliveryGateStep(
  run: WorkflowRunRow,
  predecessor: WorkflowStepRow,
  reviewedHeadCommit: string,
): WorkflowDecision {
  return {
    kind: "append",
    step: {
      kind: "host-operation",
      payload: {
        operation: DELIVERY_GATE_OPERATION_ID,
        idempotencyKey: operationIdempotencyKey(
          run.id,
          DELIVERY_GATE_OPERATION_ID,
          predecessor.id,
        ),
        reviewedHeadCommit,
      },
      predecessorId: predecessor.id,
    },
  };
}

/**
 * The way to delivery, and the one place the discovery precondition is
 * enforced: a head reaches the gate only if fresh eyes passed THAT commit.
 * The configured verdict runs here, last — after the discovery pass that
 * accepted the head and the coordinator's `deliver` — because a judgment of
 * whether findings were resolved is worth having about what actually ships,
 * and is no substitute for a review of it.
 */
function deliveryStep(
  run: WorkflowRunRow,
  steps: readonly WorkflowStepRow[],
  predecessor: WorkflowStepRow,
  reviewedHeadCommit: string,
  verdict?: WorkPlanRoleConfig,
  options: { authorizedByUser?: boolean; freshnessChecked?: boolean } = {},
): WorkflowDecision {
  if (
    !options.authorizedByUser &&
    !hasPassingDiscoveryReview(steps, reviewedHeadCommit)
  ) {
    // The head needs fresh eyes, so BUY them while the ceiling allows: the gate
    // asks the user for a pass the run could take itself, and a run that gated
    // here without ever appending that review would come back to the same gate
    // however high the user raised the ceiling.
    const completedPass = latestDiscoveryPass(steps);
    const range = commitRangeForHead(steps, reviewedHeadCommit);
    if (range && canReviewAgain(run, steps, completedPass)) {
      // WHICH fresh eyes is a real question whenever the run has more than one
      // reviewer to spend a pass on, and the coordinator is asked after every
      // assessment everywhere else — including the pass `discoveryAfterFix`
      // buys, which is the same purchase from the other direction. Buying
      // silently here spent a pass on the plan's reviewer with nobody asked.
      const assessment = readStepResult(predecessor, ASSESSMENT_CONTRACT_ID);
      if (assessment && roleSetPayload(run, "reviewer").length > 1)
        return reviewDecisionStep(
          run,
          steps,
          predecessor,
          assessment,
          range,
          completedPass,
          "review-again",
        );
      return reviewStep(
        predecessor.id,
        range,
        completedPass + 1,
        run.maxReviewPasses,
        implementerReportOf(steps),
        ciResultsOf(run, steps, reviewedHeadCommit),
      );
    }
    return ceilingDecisionStep(
      run,
      steps,
      predecessor,
      "review-passes",
      `buy a discovery review of ${reviewedHeadCommit}, which the work changed under`,
      reviewedHeadCommit,
    );
  }
  if (
    !options.freshnessChecked &&
    rangeEvidenceForHead(steps, reviewedHeadCommit)?.operation !== undefined
  )
    return baseSyncStep(run, predecessor, "delivery", {
      ...(verdict ? { verdict } : {}),
      ...(options.authorizedByUser ? { authorizedByUser: true } : {}),
    });
  if (verdict) {
    const context = latestFindingsContext(steps);
    return verdictStep(
      predecessor.id,
      commitRangeForHead(steps, reviewedHeadCommit) ?? {
        baseCommit: reviewedHeadCommit,
        headCommit: reviewedHeadCommit,
      },
      context.findings,
      implementerReportOf(steps),
      verdict,
      ciResultsOf(run, steps, reviewedHeadCommit),
      {
        ...(context.reviewSetId ? { reviewSetId: context.reviewSetId } : {}),
        ...(context.reviewSetId
          ? {
              // What the threads say NOW: a dispute its author has since
              // accepted is settled, and the judge must not reopen it.
              findingResolutions: threadStateOf(steps, context.reviewSetId),
            }
          : {}),
      },
      options.freshnessChecked === true,
    );
  }
  return deliveryGateStep(run, predecessor, reviewedHeadCommit);
}

/**
 * The range a head was measured in, from the commit/sync that produced it.
 * Matched by head rather than by position, like every other piece of evidence
 * bound to a commit (foundation invariant 3).
 */
function rangeEvidenceForHead(
  steps: readonly WorkflowStepRow[],
  headCommit: string,
): CommitSyncResult | undefined {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]!;
    if (!isRangeOperationStep(step)) continue;
    const result = readStepResult(step, COMMIT_SYNC_RESULT_CONTRACT_ID);
    if (result?.headCommit === headCommit) return result;
  }
  return undefined;
}

function commitRangeForHead(
  steps: readonly WorkflowStepRow[],
  headCommit: string,
): { baseCommit: string; headCommit: string } | undefined {
  const result = rangeEvidenceForHead(steps, headCommit);
  return result
    ? { baseCommit: result.baseCommit, headCommit: result.headCommit }
    : undefined;
}

/** The findings the run last had to answer, for the verdict's own judgment. */
function latestFindingsContext(steps: readonly WorkflowStepRow[]): {
  findings: ReviewFinding[];
  reviewSetId?: string;
} {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]!;
    if (phaseOf(step) !== "review") continue;
    const assessment = readStepResult(step, ASSESSMENT_CONTRACT_ID);
    if (!assessment || assessment.findings.length === 0) continue;
    return {
      findings: assessment.findings,
      ...(assessment.reviewSetId
        ? { reviewSetId: assessment.reviewSetId }
        : {}),
    };
  }
  return { findings: [] };
}

/** One run-authorized role set for coordinator evidence. */
function roleSetPayload(
  run: WorkflowRunRow,
  role: "implementer" | "reviewer" | "fixer" | "verdict",
): WorkflowJsonValue[] {
  const value = payloadRecord(payloadRecord(run.config).roles)[role];
  return Array.isArray(value) ? value : [];
}

function usesComplexityStartingCeilings(run: WorkflowRunRow): boolean {
  return (
    payloadRecord(payloadRecord(run.config).startingCeilings).mode ===
    "plan-complexity"
  );
}

/** All run-authorized role sets for the opening plan. */
function roleSetsPayload(run: WorkflowRunRow): WorkflowJsonValue {
  return {
    implementer: roleSetPayload(run, "implementer"),
    reviewer: roleSetPayload(run, "reviewer"),
    fixer: roleSetPayload(run, "fixer"),
    verdict: roleSetPayload(run, "verdict"),
  };
}

function stringValueOf(
  value: WorkflowJsonValue | undefined,
): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** A commit range recorded in a step payload, when it is a complete one. */
function commitRangeOf(
  value: WorkflowJsonValue | undefined,
): { baseCommit: string; headCommit: string } | undefined {
  const range = payloadRecord(value);
  return typeof range.baseCommit === "string" &&
    range.baseCommit &&
    typeof range.headCommit === "string" &&
    range.headCommit
    ? { baseCommit: range.baseCommit, headCommit: range.headCommit }
    : undefined;
}

/**
 * An assessment naming a head other than the one its step was assigned. It is
 * still evidence — about the commit it names — but it says nothing about the
 * assigned range (foundation invariant 3).
 */
export function isStaleAssessment(
  step: WorkflowStepRow,
  assessment: Assessment,
): boolean {
  return assessment.headCommit !== assignedRangeHead(step);
}

/**
 * The loop iterations already recorded: `revise` verdicts plus stale `pass`
 * assessments, each of which sends the run around the loop again.
 */
export function countIterations(steps: readonly WorkflowStepRow[]): number {
  let iterations = 0;
  for (const step of steps) {
    if (phaseOf(step) !== "review") continue;
    const assessment = readStepResult(step, ASSESSMENT_CONTRACT_ID);
    if (!assessment) continue;
    if (
      assessment.verdict === "revise" ||
      (assessment.verdict === "pass" && isStaleAssessment(step, assessment))
    )
      iterations += 1;
  }
  for (const step of steps) {
    if (
      phaseOf(step) === "ci" &&
      readStepResult(step, CI_OBSERVATION_RESULT_CONTRACT_ID)?.outcome === "red"
    )
      iterations += 1;
  }
  for (const step of steps) {
    if (phaseOf(step) !== "delivery") continue;
    const gate = readStepResult(step, DELIVERY_GATE_RESULT_CONTRACT_ID);
    const publication = readStepResult(
      step,
      PUBLISH_PULL_REQUEST_RESULT_CONTRACT_ID,
    );
    if (
      gate?.outcome === "review-required" ||
      publication?.outcome === "review-required"
    )
      iterations += 1;
  }
  return iterations;
}

/** The reason a `fail` verdict pauses with: the reviewer's own words. */
function failureReason(step: WorkflowStepRow, assessment: Assessment): string {
  const summary = step.result?.summary?.trim();
  if (summary) return `review failed: ${summary}`;
  if (assessment.findings.length > 0)
    return `review failed: ${assessment.findings.map((finding) => finding.text).join("; ")}`;
  return `review failed at ${assessment.headCommit}`;
}

function missingEvidence(
  step: WorkflowStepRow,
  contractId: keyof typeof WORKFLOW_RESULT_CONTRACTS,
): string {
  return (
    `${describeStep(step)} completed without a valid ${contractId} result ` +
    `(expected ${WORKFLOW_RESULT_CONTRACTS[contractId].describe})`
  );
}

/** A completed stale-head observation may be re-read without rewriting history. */
export function isRecheckablePullRequestObservation(
  step: WorkflowStepRow,
): boolean {
  if (step.kind !== "wait" || step.status !== "completed") return false;
  return (
    readStepResult(step, PULL_REQUEST_OBSERVATION_RESULT_CONTRACT_ID)
      ?.outcome === "head-changed"
  );
}

/** User-facing reason for a terminal exact-head provider observation. */
export function pullRequestObservationPauseReason(
  outcome: PullRequestObservationResult,
): string {
  if (outcome.outcome === "ready")
    return `CI passed for reviewed head ${outcome.headCommit} and the pull request is mergeable; merge decision ready`;
  return outcome.reason;
}

/** A post-review workspace move re-enters the exact same bounded review loop. */
function deliveryReviewLoop(
  run: WorkflowRunRow,
  steps: WorkflowStepRow[],
  deliveryStep: WorkflowStepRow,
  refusal: {
    reason: string;
    observedHeadCommit: string;
    worktreeDirty: boolean;
  },
): WorkflowDecision {
  if (countIterations(steps.slice(0, -1)) >= run.maxIterations)
    // What "as it stands" would ship is the commit the WORKSPACE has — but
    // only when a commit holds all of it. Uncommitted work is in no commit at
    // all, so delivering would ship something the user did not mean and the
    // gate would refuse the same way again: that gate offers raise or cancel.
    return ceilingDecisionStep(
      run,
      steps,
      deliveryStep,
      "iterations",
      `re-review the work after the delivery gate found ${refusal.reason}`,
      refusal.worktreeDirty ? undefined : refusal.observedHeadCommit,
    );
  return {
    kind: "append",
    step: {
      kind: "host-operation",
      payload: {
        operation: COMMIT_SYNC_OPERATION_ID,
        idempotencyKey: commitSyncIdempotencyKey(run.id, deliveryStep.id),
      },
      predecessorId: deliveryStep.id,
    },
  };
}

/**
 * A ceiling stopped the run, so the USER decides what happens to the work —
 * raise the bound, take it as it stands, or cancel. This is the whole reason a
 * ceiling is not an ending: it bounds how much the run may do on its own, and
 * only the person who set it knows whether the answer is more.
 */
/**
 * Where the raise control starts, for the limit that blocked
 * ([Task-592](pa://task/592)).
 *
 * The control began at one, always. A run that needs four more rounds is then
 * four separate interruptions, each one a decision the user has already made —
 * run 111 blocked five times over nine hours of its seventeen, and granted
 * every one. Nothing about who decides changes here; only where the slider
 * starts, and every other amount remains one drag away.
 *
 * Proportional to what this run has already spent, because that is the run's
 * own evidence about its appetite: a run stopped after two rounds is a
 * different question from one stopped after sixteen. Repeat asks escalate on
 * their own, since spend only grows.
 */
function suggestedRaiseFor(spent: number): number {
  return Math.min(10, Math.max(2, Math.ceil(spent / 2)));
}

function ceilingDecisionStep(
  run: WorkflowRunRow,
  steps: readonly WorkflowStepRow[],
  predecessor: WorkflowStepRow,
  blocked: "review-passes" | "iterations",
  wanted: string,
  headCommit: string | undefined,
): WorkflowDecision {
  const payload: CeilingDecisionStepPayload = {
    decision: "raise-ceilings",
    blocked,
    wanted,
    ceilings: {
      maxIterations: run.maxIterations,
      maxReviewPasses: run.maxReviewPasses,
    },
    spent: {
      // The history BEFORE the step that hit the ceiling: the blocked demand
      // has not spent a round, and "4 of 3" describes a run that never was.
      iterations: countIterations(steps.slice(0, -1)),
      reviewPasses: latestDiscoveryPass(steps),
      sessions: sessionsUsed(steps),
    },
    ...(headCommit ? { reviewedHeadCommit: headCommit } : {}),
    headCarriesDiscoveryReview: headCommit
      ? hasPassingDiscoveryReview(steps, headCommit)
      : false,
    // Without a head there is nothing to ship. Where the WORKSPACE is what
    // refused — the delivery gate found it dirty — the user has the other way
    // to make progress: fix it themselves and have the run look again, so a
    // ceiling already at its bound never leaves cancel as the only exit. That
    // choice is offered only there, because only a fresh observation of the
    // workspace can answer differently; nothing else re-reads the world.
    allowedChoices: headCommit
      ? ["raise", "deliver", "cancel"]
      : phaseOf(predecessor) === "delivery"
        ? ["raise", "re-evaluate", "cancel"]
        : ["raise", "cancel"],
    suggestedRaise: suggestedRaiseFor(
      blocked === "iterations"
        ? countIterations(steps.slice(0, -1))
        : latestDiscoveryPass(steps),
    ),
  };
  return {
    kind: "append",
    step: {
      kind: "user-decision",
      payload: payload as unknown as WorkflowJsonValue,
      predecessorId: predecessor.id,
    },
  };
}

export function ceilingDecisionPayloadOf(
  step: WorkflowStepRow,
): CeilingDecisionStepPayload | undefined {
  if (phaseOf(step) !== "ceiling-decision") return undefined;
  const payload = payloadRecord(step.payload);
  const choices = payload.allowedChoices;
  return (payload.blocked === "review-passes" ||
    payload.blocked === "iterations") &&
    typeof payload.wanted === "string" &&
    Array.isArray(choices) &&
    choices.includes("raise") &&
    choices.includes("cancel")
    ? (step.payload as unknown as CeilingDecisionStepPayload)
    : undefined;
}

/** What the user answered at a ceiling gate, when the step is settled. */
function ceilingDecisionResultOf(
  step: WorkflowStepRow,
): CeilingDecisionResult | undefined {
  if (!ceilingDecisionPayloadOf(step) || step.result?.status !== "completed")
    return undefined;
  const result = payloadRecord(step.result.payload);
  if (result.choice === "cancel") return { choice: "cancel" };
  if (result.choice === "re-evaluate") return { choice: "re-evaluate" };
  if (result.choice === "deliver")
    return {
      choice: "deliver",
      ...(typeof result.reviewedHeadCommit === "string"
        ? { reviewedHeadCommit: result.reviewedHeadCommit }
        : {}),
    };
  if (
    result.choice === "raise" &&
    typeof result.maxIterations === "number" &&
    typeof result.maxReviewPasses === "number"
  )
    return {
      choice: "raise",
      maxIterations: result.maxIterations,
      maxReviewPasses: result.maxReviewPasses,
    };
  return undefined;
}

/**
 * A cleared re-check settles the FINDINGS, not the head. The fix moved the
 * commit that would ship, and the review that passed before it describes a
 * commit nobody is delivering, so the run buys another discovery opinion —
 * or, with no pass left to buy one, stops and says so rather than delivering
 * code no fresh eyes ever read.
 *
 * WHICH eyes is still open, and the coordinator answers it with the fix round
 * in front of it; only a run whose reviewer set holds one candidate has nothing
 * to be asked, and takes the pass directly.
 */
function discoveryAfterFix(
  run: WorkflowRunRow,
  steps: readonly WorkflowStepRow[],
  reCheck: WorkflowStepRow,
  assessment: Assessment,
): WorkflowDecision {
  const completedPass = latestDiscoveryPass(steps);
  if (!canReviewAgain(run, steps, completedPass))
    return ceilingDecisionStep(
      run,
      steps,
      reCheck,
      "review-passes",
      `buy fresh eyes on the fix at ${assessment.headCommit}, which its own ` +
        `reviewer cleared but no discovery pass has read`,
      assessment.headCommit,
    );
  const range = commitRangeOf(payloadRecord(reCheck.payload).commitRange);
  if (!range) return pause(`re-check step ${reCheck.id} has no valid range`);
  if (roleSetPayload(run, "reviewer").length > 1)
    return reviewDecisionStep(
      run,
      steps,
      reCheck,
      assessment,
      range,
      completedPass,
      "review-again",
    );
  if (rangeEvidenceForHead(steps, range.headCommit)?.operation === undefined)
    return reviewStep(
      reCheck.id,
      range,
      completedPass + 1,
      run.maxReviewPasses,
      implementerReportOf(steps),
      ciResultsOf(run, steps, range.headCommit),
    );
  return baseSyncStep(run, reCheck, "discovery");
}

/** Open the independent pass that follows a synchronization checkpoint. */
function discoveryAfterCheckpoint(
  run: WorkflowRunRow,
  steps: readonly WorkflowStepRow[],
  checkpoint: WorkflowStepRow,
  range: { baseCommit: string; headCommit: string },
  predecessorId: number,
  ciResults: WorkflowCiResult | undefined,
): WorkflowDecision {
  const completedPass = latestDiscoveryPass(steps);
  if (!canReviewAgain(run, steps, completedPass))
    return ceilingDecisionStep(
      run,
      steps,
      checkpoint,
      "review-passes",
      `buy fresh eyes on synchronized range ${range.baseCommit}..${range.headCommit}`,
      range.headCommit,
    );
  const payload = payloadRecord(checkpoint.payload);
  return reviewStep(
    predecessorId,
    range,
    completedPass + 1,
    run.maxReviewPasses,
    implementerReportOf(steps),
    ciResults,
    {
      ...(roleConfigOfPayload(payload.reviewer)
        ? { reviewer: roleConfigOfPayload(payload.reviewer)! }
        : {}),
      ...(Array.isArray(payload.focus)
        ? { focus: payload.focus as string[] }
        : {}),
    },
  );
}

/**
 * The same assessor, the same mandate, the recomputed range. A discovery pass
 * keeps its pass number (and therefore its session); a re-check still judges
 * the findings it was given; a verdict still judges their resolution. Only the
 * commit under it moved, and turning any of them into a different kind of
 * assessment would answer a question nobody asked.
 */
function reissueAssessment(
  run: WorkflowRunRow,
  steps: readonly WorkflowStepRow[],
  author: WorkflowStepRow,
  range: { baseCommit: string; headCommit: string },
  predecessorId: number,
  ciResults: WorkflowCiResult | undefined,
): WorkflowDecision {
  const payload = payloadRecord(author.payload);
  const report = implementerReportOf(steps);
  const findings = Array.isArray(payload.findings)
    ? (payload.findings as unknown as ReviewFinding[])
    : [];
  const reviewSetId =
    typeof payload.reviewSetId === "string" ? payload.reviewSetId : undefined;
  // Each side of the conversation is reissued with the evidence its ORIGINAL
  // assignment carried, and those differ: a re-check is about to settle these
  // threads and must see what the FIX ROUND left, or it would read the state
  // its own earlier attempt created; a verdict is a later reader and must see
  // the newest word, or it reopens a dispute the author has already accepted.
  // Sharing one object between them handed the reissued verdict the fix round's
  // superseded snapshot — the exact case the original verdict step avoids.
  const reviewSetWith = (
    resolutions: ReviewFindingResolution[],
  ): {
    reviewSetId?: string;
    findingResolutions?: ReviewFindingResolution[];
  } => (reviewSetId ? { reviewSetId, findingResolutions: resolutions } : {});
  if (payload.objective === "re-check")
    return reCheckStep(
      predecessorId,
      author,
      range,
      findings,
      report,
      ciResults,
      reviewSetWith(
        reviewSetId ? findingResolutionsOf(steps, reviewSetId) : [],
      ),
    );
  const verdict = roleConfigOfPayload(payload.verdict);
  if (payload.role === "verdict" && verdict)
    return verdictStep(
      predecessorId,
      range,
      findings,
      report,
      verdict,
      ciResults,
      reviewSetWith(reviewSetId ? threadStateOf(steps, reviewSetId) : []),
    );
  return reviewStep(
    predecessorId,
    range,
    reviewPassOf(author),
    run.maxReviewPasses,
    report,
    ciResults,
    {
      ...(roleConfigOfPayload(payload.reviewer)
        ? { reviewer: roleConfigOfPayload(payload.reviewer)! }
        : {}),
      ...(Array.isArray(payload.focus)
        ? { focus: payload.focus as string[] }
        : {}),
    },
  );
}

function reviewAfterCommitSync(
  run: WorkflowRunRow,
  steps: readonly WorkflowStepRow[],
  commitStep: WorkflowStepRow,
  range: { baseCommit: string; headCommit: string },
  predecessorId: number,
  ciResults: WorkflowCiResult | undefined,
): WorkflowDecision {
  const plan = acceptedWorkPlan(run, steps);
  if (!plan) return pause("the accepted work plan is no longer readable");
  const predecessor =
    commitStep.predecessorId === undefined
      ? undefined
      : steps.find((step) => step.id === commitStep.predecessorId);
  const report = implementerReportOf(steps);
  // A range recomputed under an assessment that named another head is still
  // that assessment's to judge, with the mandate it already had: the assessor
  // did not change, only the commit it has to name.
  if (predecessor && phaseOf(predecessor) === "review")
    return reissueAssessment(
      run,
      steps,
      predecessor,
      range,
      predecessorId,
      ciResults,
    );
  // An outstanding assessment is owed its re-check whatever produced this
  // range: the fix that answers it, or a machine CI round that landed on top
  // of that fix. Its findings and set come from the assessment ITSELF, so a CI
  // round in between cannot substitute its own findings for them.
  const author = assessmentAuthorOf(steps);
  if (author) {
    const { findings, reviewSetId } = outstandingFindings(author);
    return reCheckStep(
      predecessorId,
      author,
      range,
      findings,
      report,
      ciResults,
      {
        ...(reviewSetId ? { reviewSetId } : {}),
        ...(reviewSetId
          ? { findingResolutions: findingResolutionsOf(steps, reviewSetId) }
          : {}),
      },
    );
  }
  // Fresh eyes: the first range, and any range whose fix answered machine CI
  // with nothing outstanding. The pass number does not restart, so a CI round
  // does not silently buy the run another discovery opinion.
  return reviewStep(
    predecessorId,
    range,
    Math.max(1, latestDiscoveryPass(steps)),
    run.maxReviewPasses,
    report,
    ciResults,
  );
}

/**
 * The commit-sync step whose range a CI observation belongs to. A semantic
 * retry appends a successor carrying the failed attempt's exact payload
 * (`retryRun`), so a completed observation may sit behind failed/blocked
 * attempts at the SAME reservation; the runtime's `validReservation` already
 * dispatches that chain, and the decision side must not be stricter than what
 * it dispatched. An automatic triage re-reserves the same operation against
 * itself, so it is crossed too, and the key the walk follows becomes the one
 * the triage recorded for the attempt it was handed. Anything else between the
 * observation and its commit-sync breaks the anchor.
 */
function ciCommitSyncAnchor(
  steps: readonly WorkflowStepRow[],
  tail: WorkflowStepRow,
): WorkflowStepRow | undefined {
  const byId = new Map(steps.map((step) => [step.id, step]));
  let key = payloadRecord(tail.payload).idempotencyKey;
  if (typeof key !== "string" || !key) return undefined;
  let step = tail;
  while (step.predecessorId !== undefined) {
    const predecessor = byId.get(step.predecessorId);
    if (!predecessor) return undefined;
    if (isRangeOperationStep(predecessor)) return predecessor;
    if (
      phaseOf(predecessor) === "ci" &&
      (predecessor.status === "failed" || predecessor.status === "blocked") &&
      payloadRecord(predecessor.payload).idempotencyKey === key
    ) {
      step = predecessor;
      continue;
    }
    const triage = operationTriagePayloadOf(predecessor);
    if (
      triage &&
      triage.operation === CI_OBSERVATION_OPERATION_ID &&
      triage.stepId === predecessor.predecessorId &&
      key ===
        operationIdempotencyKey(
          predecessor.runId,
          CI_OBSERVATION_OPERATION_ID,
          predecessor.id,
        )
    ) {
      key = triage.idempotencyKey;
      step = predecessor;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function consecutiveCiRedCount(steps: readonly WorkflowStepRow[]): number {
  let count = 0;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]!;
    if (phaseOf(step) !== "ci") continue;
    const result = readStepResult(step, CI_OBSERVATION_RESULT_CONTRACT_ID);
    if (result?.outcome !== "red") break;
    count += 1;
  }
  return count;
}

function ciFailureFindings(result: WorkflowCiResult): ReviewFinding[] {
  const failing = result.checks.filter((check) =>
    /fail|error|timed.?out|cancel|action.?required|startup/i.test(check.status),
  );
  return (failing.length > 0 ? failing : result.checks).map((check) => ({
    severity: "major" as const,
    text: `${check.name} (${check.status})${check.excerpt ? ` — ${check.excerpt}` : ""}`,
  }));
}

/* ---------------------------- the decision itself -------------------------- */

/**
 * The next thing that should happen to this run. See the module comment for why
 * this must stay pure.
 *
 * The open-step checks come first: a run executes ONE step at a time in its own
 * worktree, so while something is open the only honest answer is what it is
 * waiting on — and two open steps is an invariant breach the recipe refuses to
 * average over. After that, the LAST step decides, because history is
 * append-only and serialized: nothing is appended until its predecessor is
 * terminal, so the tail is the whole state.
 */
export function decideNextStep(
  run: WorkflowRunRow,
  steps: WorkflowStepRow[],
): WorkflowDecision {
  const open = steps.filter(
    (step) => !isTerminalWorkflowStepStatus(step.status),
  );
  if (open.length > 1)
    return pause(
      `workflow invariant breach: ${open.length} open steps (${open
        .map((step) => step.id)
        .join(", ")}); a run executes one step at a time`,
    );
  if (open.length === 1) return { kind: "executing", stepId: open[0]!.id };

  const last = steps[steps.length - 1];
  if (!last)
    return {
      kind: "append",
      step: {
        kind: "agent",
        payload: {
          role: "coordinator",
          objective: "plan",
          roles: roleSetsPayload(run),
          ...(usesComplexityStartingCeilings(run)
            ? { ceilingsFromComplexity: true }
            : { maxReviewPasses: run.maxReviewPasses }),
          resultContract: WORK_PLAN_CONTRACT_ID,
        },
      },
    };

  // Only the opening plan runs before the start service has provisioned the
  // checkout. The coordinator needs none for its review decision either, but by
  // then the run has one and everything the decision leads to uses it, so a
  // missing worktree there is a fault rather than an expected state.
  if (phaseOf(last) !== "plan" && !run.worktreeId)
    return pause("worktree not provisioned");

  // A restored rebase conflict gets ONE automatic repair assignment in the
  // run's existing implementer session. Semantic commit-sync retries keep their
  // predecessor chain, so a chain rooted in repair cannot append another one.
  const rebaseConflict = rebaseConflictOf(last);
  if (rebaseConflict && !rebaseRepairSpent(steps, last)) {
    return {
      kind: "append",
      step: {
        kind: "agent",
        payload: {
          role: "implementer",
          objective: "repair-rebase",
          files: rebaseConflict.files,
          truncated: rebaseConflict.truncated,
          baseBranch: rebaseConflict.baseBranch,
          originalHead: rebaseConflict.originalHead,
          resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
        },
        predecessorId: last.id,
      },
    };
  }

  // A host operation that reproduced its own failure gets ONE automatic triage
  // in the run's existing implementer session before the run stands in front of
  // the human with an error nobody has read.
  const triage = operationTriageAssignment(run, steps, last);
  if (triage) return triage;

  // Ended without evidence is failure, not progress. A retry that reproduced
  // the same conclusion says so in the reason itself: the pause is durable, so
  // this is also what the event log records about the attempt.
  if (last.status !== "completed") {
    const attempts = identicalTailAttempts(steps);
    const stopped = `${describeStep(last)} ended as ${last.status}`;
    return pause(
      attempts > 1
        ? `${stopped}; attempt ${attempts} with the same result`
        : stopped,
    );
  }

  const unrecognizedPayload = () =>
    pause(
      `${describeStep(last)} carries a payload the ${CODE_DELIVERY_RECIPE_ID} recipe does not recognize`,
    );

  // Narrowed out here rather than carried as a `default:`, which would count as
  // exhaustive and stop the linter noticing a NEW phase that grows no case.
  const phase = phaseOf(last);
  if (phase === undefined) return unrecognizedPayload();

  switch (phase) {
    case "plan": {
      const rawPlan = readStepResult(last, WORK_PLAN_CONTRACT_ID);
      if (!rawPlan) return pause(missingEvidence(last, WORK_PLAN_CONTRACT_ID));
      const plan = acceptedWorkPlan(run, steps);
      if (!plan)
        return pause(
          "the work plan exceeded one or more of the run's role sets",
        );
      if (!run.worktreeId) return pause("worktree not provisioned");
      return {
        kind: "append",
        step: {
          kind: "agent",
          payload: {
            role: "implementer",
            objective: "implement",
            resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
          },
          predecessorId: last.id,
        },
      };
    }
    case "implement": {
      if (!readStepResult(last, IMPLEMENTATION_RESULT_CONTRACT_ID))
        return pause(missingEvidence(last, IMPLEMENTATION_RESULT_CONTRACT_ID));
      const objective = payloadRecord(last.payload).objective;
      // A completed triage hands its reservation straight back: the SAME
      // operation with the SAME routing payload runs again, keyed to the triage
      // step so the runtime reads one direct-predecessor reservation rather
      // than a chain it has to reconstruct.
      const triaged = reissuedOperationAfterTriage(run, steps, last);
      if (triaged) return triaged;
      const commitOnly = objective === "revise";
      const repaired =
        objective === "repair-rebase"
          ? steps.find((step) => step.id === last.predecessorId)
          : undefined;
      const resumeBaseSync = repaired && phaseOf(repaired) === "base-sync";
      const operation = commitOnly
        ? COMMIT_ONLY_OPERATION_ID
        : resumeBaseSync
          ? BASE_SYNC_OPERATION_ID
          : COMMIT_SYNC_OPERATION_ID;
      return {
        kind: "append",
        step: {
          kind: "host-operation",
          payload: {
            operation,
            idempotencyKey: commitOnly
              ? commitOnlyIdempotencyKey(run.id, last.id)
              : resumeBaseSync
                ? baseSyncIdempotencyKey(run.id, last.id)
                : commitSyncIdempotencyKey(run.id, last.id),
            ...(resumeBaseSync
              ? baseSyncResumePayloadOf(repaired.payload)
              : {}),
          },
          predecessorId: last.id,
        },
      };
    }
    case "commit-sync":
    case "commit": {
      const range = readStepResult(last, COMMIT_SYNC_RESULT_CONTRACT_ID);
      if (!range)
        return pause(missingEvidence(last, COMMIT_SYNC_RESULT_CONTRACT_ID));
      const exactRange = {
        baseCommit: range.baseCommit,
        headCommit: range.headCommit,
      };
      if (payloadRecord(run.config).earlyPush === true)
        return {
          kind: "append",
          step: {
            kind: "host-operation",
            payload: {
              operation: CI_OBSERVATION_OPERATION_ID,
              idempotencyKey: operationIdempotencyKey(
                run.id,
                CI_OBSERVATION_OPERATION_ID,
                last.id,
              ),
              reviewedHeadCommit: range.headCommit,
            },
            predecessorId: last.id,
          },
        };
      return reviewAfterCommitSync(
        run,
        steps,
        last,
        exactRange,
        last.id,
        ciResultsOf(run, steps, range.headCommit),
      );
    }
    case "base-sync": {
      const range = readStepResult(last, COMMIT_SYNC_RESULT_CONTRACT_ID);
      if (!range)
        return pause(missingEvidence(last, COMMIT_SYNC_RESULT_CONTRACT_ID));
      const exactRange = {
        baseCommit: range.baseCommit,
        headCommit: range.headCommit,
      };
      const payload = payloadRecord(last.payload);
      const changed = range.baseMoved === true || range.headRewritten === true;
      if (changed && payloadRecord(run.config).earlyPush === true)
        return {
          kind: "append",
          step: {
            kind: "host-operation",
            payload: {
              operation: CI_OBSERVATION_OPERATION_ID,
              idempotencyKey: operationIdempotencyKey(
                run.id,
                CI_OBSERVATION_OPERATION_ID,
                last.id,
              ),
              reviewedHeadCommit: range.headCommit,
            },
            predecessorId: last.id,
          },
        };
      if (payload.purpose === "discovery" || changed)
        return discoveryAfterCheckpoint(
          run,
          steps,
          last,
          exactRange,
          last.id,
          ciResultsOf(run, steps, range.headCommit),
        );
      if (payload.purpose === "delivery")
        return deliveryStep(
          run,
          steps,
          last,
          range.headCommit,
          roleConfigOfPayload(payload.verdict),
          {
            authorizedByUser: payload.authorizedByUser === true,
            freshnessChecked: true,
          },
        );
      return pause(`base synchronization step ${last.id} has no valid purpose`);
    }
    case "ci": {
      const result = readStepResult(last, CI_OBSERVATION_RESULT_CONTRACT_ID);
      if (!result)
        return pause(missingEvidence(last, CI_OBSERVATION_RESULT_CONTRACT_ID));
      const commitStep = ciCommitSyncAnchor(steps, last);
      const range = commitStep
        ? readStepResult(commitStep, COMMIT_SYNC_RESULT_CONTRACT_ID)
        : undefined;
      if (!commitStep || !range || range.headCommit !== result.headCommit)
        return pause(
          `CI observation step ${last.id} is not attached to its exact commit/sync range`,
        );
      if (result.outcome === "red") {
        // One budget for every round trip: a red check spends what a reviewer's
        // revise spends, so a run cannot buy a second loop's worth of fix
        // rounds by failing CI instead of review.
        const redCount = consecutiveCiRedCount(steps);
        if (countIterations(steps.slice(0, -1)) >= run.maxIterations)
          return ceilingDecisionStep(
            run,
            steps,
            last,
            "iterations",
            `answer CI, which has failed ${redCount} ` +
              `time${redCount === 1 ? "" : "s"} in a row for ${result.headCommit}`,
            result.headCommit,
          );
        const findings = ciFailureFindings(result);
        if (findings.length === 0)
          return pause(
            `CI failed for ${result.headCommit} without provider check evidence`,
          );
        const plan = acceptedWorkPlan(run, steps);
        if (!plan) return pause("the accepted work plan is no longer readable");
        return {
          kind: "append",
          step: {
            kind: "agent",
            payload: boundedRecipePayload(
              {
                role: "implementer",
                objective: "revise",
                reviewedCommit: result.headCommit,
                findings,
                findingSource: "ci",
                reviewSummary: `Machine CI failed ${findings.length} check(s); no reviewer pass was run.`,
                ...ciRepairAssignment(run, steps, commitStep),
                resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
              },
              [["reviewSummary"], ["findings"]],
            ),
            predecessorId: last.id,
          },
        };
      }
      const exactRange = {
        baseCommit: range.baseCommit,
        headCommit: range.headCommit,
      };
      if (phaseOf(commitStep) === "base-sync")
        return discoveryAfterCheckpoint(
          run,
          steps,
          commitStep,
          exactRange,
          last.id,
          result,
        );
      return reviewAfterCommitSync(
        run,
        steps,
        commitStep,
        exactRange,
        last.id,
        result,
      );
    }
    case "review": {
      const assessment = readStepResult(last, ASSESSMENT_CONTRACT_ID);
      if (!assessment)
        return pause(missingEvidence(last, ASSESSMENT_CONTRACT_ID));
      switch (assessment.verdict) {
        case "pass": {
          if (isStaleAssessment(last, assessment)) {
            // A pass on another commit is not a pass on this range: the
            // workspace moved under the review, so the loop recomputes the
            // range and reassesses instead of carrying a stale pass toward
            // delivery. Bounded like any other iteration.
            if (countIterations(steps.slice(0, -1)) >= run.maxIterations)
              return ceilingDecisionStep(
                run,
                steps,
                last,
                "iterations",
                `re-assess ${assignedRangeHead(last) ?? "the range"}, since the ` +
                  `review passed ${assessment.headCommit} instead`,
                assignedRangeHead(last),
              );
            return {
              kind: "append",
              step: {
                kind: "host-operation",
                payload: {
                  operation: COMMIT_SYNC_OPERATION_ID,
                  idempotencyKey: commitSyncIdempotencyKey(run.id, last.id),
                },
                predecessorId: last.id,
              },
            };
          }
          const objective = payloadRecord(last.payload).objective;
          if (objective === "re-check")
            return discoveryAfterFix(run, steps, last, assessment);
          if (payloadRecord(last.payload).role === "verdict")
            // The verdict is the last word before the gate, never the first:
            // it only runs after delivery freshness was checked for its exact
            // range, and that checkpoint remains the publication preflight.
            return deliveryStep(
              run,
              steps,
              last,
              assessment.headCommit,
              undefined,
              {
                freshnessChecked:
                  payloadRecord(last.payload).freshnessChecked === true,
              },
            );
          const pass = reviewPassOf(last);
          const range = commitRangeOf(payloadRecord(last.payload).commitRange);
          if (!range)
            return pause(`review step ${last.id} has no valid commit range`);
          // Ask only while an answer could still change something. At the pass
          // ceiling another opinion is not available — but a configured verdict
          // still needs its runtime named, and that is a question with an open
          // answer, so a one-pass run pays for the turn only when it buys one.
          if (
            !canReviewAgain(run, steps, pass) &&
            roleSetPayload(run, "verdict").length === 0
          )
            return deliveryStep(run, steps, last, assessment.headCommit);
          return reviewDecisionStep(
            run,
            steps,
            last,
            assessment,
            range,
            pass,
            "deliver-or-review",
          );
        }
        case "fail":
          // The user coordinates in v1: a failed review is a decision for them.
          return pause(failureReason(last, assessment));
        case "revise": {
          const iterations = countIterations(steps.slice(0, -1));
          if (iterations >= run.maxIterations)
            return ceilingDecisionStep(
              run,
              steps,
              last,
              "iterations",
              `answer the findings raised against ${assessment.headCommit}`,
              assessment.headCommit,
            );
          // WHICH agent answers a finding is only knowable once the finding
          // exists, so the recipe asks — unless there is nothing to ask: with
          // no fixer set the implementer is the only answer.
          if (roleSetPayload(run, "fixer").length > 0) {
            const range = commitRangeOf(
              payloadRecord(last.payload).commitRange,
            );
            if (!range)
              return pause(`review step ${last.id} has no valid commit range`);
            return reviewDecisionStep(
              run,
              steps,
              last,
              assessment,
              range,
              latestDiscoveryPass(steps),
              "route-fix",
            );
          }
          return fixStep(last, assessment, undefined);
        }
      }
      // The verdict switch above covers the union, but the value is parsed from
      // an agent's result: without this, an unknown verdict would fall through
      // into `review-decision` and act on evidence that was never assessed.
      // Name the value — this only fires when agent JSON has drifted, and the
      // drifted value is the whole diagnosis.
      return pause(
        `review step ${last.id} carries an unknown verdict ${JSON.stringify(assessment.verdict)}`,
      );
    }
    case "review-decision": {
      const raw = readStepResult(last, REVIEW_DECISION_CONTRACT_ID);
      if (!raw)
        return pause(missingEvidence(last, REVIEW_DECISION_CONTRACT_ID));
      const payload = payloadRecord(last.payload);
      const range = commitRangeOf(payload.commitRange);
      if (!range)
        return pause(
          `review decision step ${last.id} has no valid commit range`,
        );
      const completedPass =
        typeof payload.completedReviewPass === "number" &&
        Number.isInteger(payload.completedReviewPass) &&
        payload.completedReviewPass > 0
          ? payload.completedReviewPass
          : 1;
      const decision = acceptedReviewDecision(run, last);
      const focus = decisionFocusOf(last);
      const question = payload.question;
      const assessmentStep = steps.find(
        (step) => step.id === payload.assessmentStepId,
      );
      const assessed = assessmentStep
        ? readStepResult(assessmentStep, ASSESSMENT_CONTRACT_ID)
        : undefined;
      if (question === "route-fix") {
        if (!assessmentStep || !assessed)
          return pause(
            `review decision step ${last.id} no longer names the assessment it routes`,
          );
        // An answer the run has no authority to carry out is not stretched into
        // one: the findings still have to reach someone, and the implementer's
        // session is the fallback the recipe always has.
        const fixer =
          decision?.decision === "fix" && decision.assignee !== "implementer"
            ? decision.fixer
            : undefined;
        // The focus travels regardless of the answer's discriminant AND of the
        // authority check the fixer went through: a diagnosis of these findings
        // holds for whoever ends up answering them, including the implementer
        // the run falls back to when it refuses the named fixer.
        return fixStep(assessmentStep, assessed, fixer, focus);
      }
      if (question === "review-again") {
        // The fix moved the head, so delivering is not on offer here: an
        // unusable answer still buys the pass, on the run's own reviewer.
        if (!canReviewAgain(run, steps, completedPass))
          return ceilingDecisionStep(
            run,
            steps,
            last,
            "review-passes",
            `buy the discovery pass the coordinator asked for on ${range.headCommit}`,
            range.headCommit,
          );
        if (
          rangeEvidenceForHead(steps, range.headCommit)?.operation !== undefined
        )
          return baseSyncStep(run, last, "discovery", {
            ...(focus ? { focus } : {}),
            ...(decision?.reviewer ? { reviewer: decision.reviewer } : {}),
          });
        return reviewStep(
          last.id,
          range,
          completedPass + 1,
          run.maxReviewPasses,
          implementerReportOf(steps),
          ciResultsOf(run, steps, range.headCommit),
          {
            ...(focus ? { focus } : {}),
            ...(decision?.reviewer ? { reviewer: decision.reviewer } : {}),
          },
        );
      }
      // A coordinator that ASKED for another pass and was refused by the
      // ceiling is a want the run could not satisfy, which is the user's to
      // answer — unlike a run nobody asked more of, where the range already
      // holds a passing review and delivering is simply what comes next.
      if (
        decision?.decision === "review-again" &&
        !canReviewAgain(run, steps, completedPass)
      )
        return ceilingDecisionStep(
          run,
          steps,
          last,
          "review-passes",
          `buy the discovery pass the coordinator asked for on ${range.headCommit}`,
          range.headCommit,
        );
      // Deliver on anything short of an in-bounds request for another pass:
      // the range already holds a pass, and a decision the run has no authority
      // to carry out must not stall work that is accepted.
      if (!decision || decision.decision !== "review-again")
        return deliveryStep(
          run,
          steps,
          last,
          range.headCommit,
          verdictConfigFor(run, decision),
        );
      return reviewStep(
        last.id,
        range,
        completedPass + 1,
        run.maxReviewPasses,
        implementerReportOf(steps),
        ciResultsOf(run, steps, range.headCommit),
        {
          ...(focus ? { focus } : {}),
          ...(decision.reviewer ? { reviewer: decision.reviewer } : {}),
        },
      );
    }
    case "ceiling-decision": {
      const answer = ceilingDecisionResultOf(last);
      const asked = ceilingDecisionPayloadOf(last);
      if (!answer || !asked)
        return pause(`ceiling decision step ${last.id} has no recorded choice`);
      if (answer.choice === "cancel")
        return pause("the user cancelled the run at its ceiling");
      if (answer.choice === "re-evaluate") {
        // Re-deriving would read the PERSISTED refusal and reach the same
        // conclusion about a workspace the user has since changed: the recipe
        // is pure, so the only way to learn what the checkout looks like now is
        // to run the gate that looks at it.
        const refused = steps.find((step) => step.id === last.predecessorId);
        const head = stringValueOf(
          payloadRecord(refused?.payload).reviewedHeadCommit,
        );
        if (!refused || !head)
          return pause(
            `ceiling decision step ${last.id} has no delivery gate to re-run`,
          );
        return {
          kind: "append",
          step: {
            kind: "host-operation",
            payload: {
              operation: DELIVERY_GATE_OPERATION_ID,
              idempotencyKey: operationIdempotencyKey(
                run.id,
                DELIVERY_GATE_OPERATION_ID,
                last.id,
              ),
              reviewedHeadCommit: head,
            },
            predecessorId: last.id,
          },
        };
      }
      // A raise moved the bound, so the run derives its blocked move again from
      // the history BEFORE the gate: the answer changed what the run may do,
      // not what it was doing.
      if (answer.choice === "deliver") {
        const head = answer.reviewedHeadCommit ?? asked.reviewedHeadCommit;
        if (!head)
          return pause(
            `ceiling decision step ${last.id} has no head to deliver`,
          );
        // The ONE route by which work no discovery review passed can ship, and
        // it is the user's choice, recorded as one.
        //
        // "As it stands" is about the CODE, not about the judge the user
        // configured: an iterations ceiling is answered on a head a discovery
        // pass has usually already accepted, and "stop spending fix rounds" is
        // not "skip my verdict". So the configured judge still speaks wherever
        // it legitimately could — on a head a discovery pass accepted, which is
        // the only head a verdict ever runs on, and only if none has judged
        // this one already, so answering the gate twice cannot buy two.
        return deliveryStep(
          run,
          steps,
          last,
          head,
          hasPassingDiscoveryReview(steps, head) && !hasVerdictFor(steps, head)
            ? roleConfigOfPayload(roleSetPayload(run, "verdict")[0])
            : undefined,
          { authorizedByUser: true },
        );
      }
      // Raised: the bound moved, so the move the run was blocked on is derived
      // again from the history BEFORE this gate — the answer changed what the
      // run may do, not what it was doing.
      // A raise that did not clear the block — the other ceiling was raised,
      // or this one was already at its bound — asks AGAIN with the current
      // numbers rather than stopping: the card's controls are the only way to
      // move a ceiling, so a dead end here would strand the run.
      return decideNextStep(run, steps.slice(0, -1));
    }
    case "delivery": {
      const operation = payloadRecord(last.payload).operation;
      if (operation === DELIVERY_GATE_OPERATION_ID) {
        const result = readStepResult(last, DELIVERY_GATE_RESULT_CONTRACT_ID);
        if (!result)
          return pause(missingEvidence(last, DELIVERY_GATE_RESULT_CONTRACT_ID));
        if (result.outcome === "review-required")
          return deliveryReviewLoop(run, steps, last, {
            reason: result.reason,
            observedHeadCommit: result.observedHeadCommit,
            worktreeDirty: result.worktreeDirty,
          });
        return {
          kind: "append",
          step: {
            kind: "host-operation",
            payload: {
              operation: PUBLISH_PULL_REQUEST_OPERATION_ID,
              idempotencyKey: operationIdempotencyKey(
                run.id,
                PUBLISH_PULL_REQUEST_OPERATION_ID,
                last.id,
              ),
              reviewedHeadCommit: result.reviewedHeadCommit,
            },
            predecessorId: last.id,
          },
        };
      }
      if (operation === PUBLISH_PULL_REQUEST_OPERATION_ID) {
        const result = readStepResult(
          last,
          PUBLISH_PULL_REQUEST_RESULT_CONTRACT_ID,
        );
        if (!result)
          return pause(
            missingEvidence(last, PUBLISH_PULL_REQUEST_RESULT_CONTRACT_ID),
          );
        if (result.outcome === "review-required")
          return deliveryReviewLoop(run, steps, last, {
            reason: result.reason,
            observedHeadCommit: result.observedHeadCommit,
            worktreeDirty: result.worktreeDirty,
          });
        return {
          kind: "append",
          step: {
            kind: "wait",
            payload: {
              condition: "pull-request-ready",
              cardId: result.cardId,
              reviewedHeadCommit: result.reviewedHeadCommit,
            },
            predecessorId: last.id,
          },
        };
      }
      break;
    }
    case "observe": {
      const observation = readStepResult(
        last,
        PULL_REQUEST_OBSERVATION_RESULT_CONTRACT_ID,
      );
      if (!observation)
        return pause(
          missingEvidence(last, PULL_REQUEST_OBSERVATION_RESULT_CONTRACT_ID),
        );
      // A provider merge is the completion condition even when it happened in
      // the hosting UI before PA could record an in-app decision.
      if (observation.outcome === "merged") return { kind: "complete" };
      if (observation.outcome !== "ready")
        return pause(pullRequestObservationPauseReason(observation));
      const payload = payloadRecord(last.payload);
      const cardId = payload.cardId;
      const reviewedHeadCommit = payload.reviewedHeadCommit;
      if (typeof cardId !== "string" || typeof reviewedHeadCommit !== "string")
        return pause(
          `observe step ${last.id} does not identify its pull request`,
        );
      return {
        kind: "append",
        step: {
          kind: "user-decision",
          payload: {
            decision: "merge-pull-request",
            cardId,
            reviewedHeadCommit,
            allowedChoices: ["merge", "cancel"],
          },
          predecessorId: last.id,
        },
      };
    }
    case "merge": {
      const decision = mergeDecisionPayloadOf(last);
      if (!decision)
        return pause(`merge decision step ${last.id} has an invalid payload`);
      const supersession = mergeDecisionSupersessionOf(last);
      if (supersession) {
        return {
          kind: "append",
          step: {
            kind: "wait",
            payload: {
              condition: "pull-request-ready",
              cardId: decision.cardId,
              reviewedHeadCommit: decision.reviewedHeadCommit,
            },
            predecessorId: last.id,
          },
        };
      }
      if (!mergeDecisionResultOf(last))
        return pause(
          `merge decision step ${last.id} completed without a recorded choice`,
        );
      // The choice is recorded only after the existing merge action succeeds,
      // or after the watcher observes the same outcome on the provider.
      return { kind: "complete" };
    }
  }

  return unrecognizedPayload();
}

export const codeDeliveryRecipe: WorkflowRecipe = {
  id: CODE_DELIVERY_RECIPE_ID,
  version: CODE_DELIVERY_RECIPE_VERSION,
  decide: decideNextStep,
};
