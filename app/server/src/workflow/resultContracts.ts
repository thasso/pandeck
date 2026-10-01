/**
 * Registered result contracts (`docs/agent-workflows.md`, "Structured results",
 * [Task-365](pa://task/365)).
 *
 * A step's outcome reaches the recipe as a structured result validated against
 * one of these contracts — never as prose the runtime interprets. Each contract
 * is an id, a TypeScript type, and a narrow runtime validator; the validators
 * live HERE rather than with the tool that accepts a result so the submitting
 * side and the reading side share ONE definition and cannot drift.
 *
 * Contracts are deliberately small: bounded metadata and durable references
 * (commit SHAs, findings a human reads), never content. Large content stays in
 * its own domain store.
 */
import {
  ASSESSMENT_FINDINGS_MAX_CHARS,
  ASSESSMENT_FINDINGS_MAX_COUNT,
  REVIEW_FINDING_SEVERITIES,
  THINKING_LEVELS,
  type ReviewFinding,
  type ReviewFindingResolution,
  type ThinkingLevel,
} from "@assistant/shared";
import type { WorkflowStepRow } from "../db/workflowStore.ts";

/* -------------------------------- contracts ------------------------------- */

export type WorkComplexity = "low" | "medium" | "high";

/** A model/thinking/account configuration selected from one role set. */
export interface WorkPlanRoleConfig {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  credentialProfileId: string;
  /** Free operator-supplied family evidence; the recipe never enforces it. */
  family: string;
  /** Short operator evidence carried through coordinator choices. */
  notes?: string;
}

/**
 * The coordinator's opening plan. The recipe, not the agent, validates its
 * authority: each configuration must come from its own run role set.
 *
 * It deliberately does NOT say how many review passes the run needs. That
 * decision has no evidence behind it at plan time — nothing has been written
 * yet — so it moved to the `review-decision` contract below, which the same
 * coordinator answers after each completed pass.
 */
export interface WorkPlan {
  complexity: WorkComplexity;
  implementer: WorkPlanRoleConfig;
  reviewer: WorkPlanRoleConfig;
  rationale: string;
}

/**
 * What the coordinator decides after an assessment, in its own session. One
 * contract, three questions, because they are one judgement — who acts on this
 * evidence next — asked at the three moments the run has any:
 *
 * - a discovery pass PASSED: `deliver` the reviewed commit, naming the verdict
 *   runtime when the run has a verdict set, or `review-again` for another
 *   opinion on it;
 * - a re-check CLEARED: the fix moved the head, so only `review-again` is on
 *   offer — the question is which fresh eyes read it, not whether;
 * - anything asked for changes: `fix`, naming the runtime that answers those
 *   findings, which is knowable only now that the findings exist.
 *
 * The recipe owns every bound. A named configuration must belong to its role
 * set, another pass happens only while the review-pass ceiling allows, and a
 * decision outside those bounds is never stretched into an authority — after a
 * pass the run delivers, and after a revise it falls back to the implementer.
 */
export interface ReviewDecision {
  decision: "deliver" | "review-again" | "fix";
  /**
   * The runtime the next pass should run on. Absent falls back to the PLAN's
   * reviewer, not to whichever runtime the last pass used: naming nobody is
   * read as no preference, and the plan is the run's standing answer to that.
   */
  reviewer?: WorkPlanRoleConfig;
  /**
   * What the step this decision routes to should concentrate on — where a
   * review pass looks first, or how a fix round approaches findings whose scope
   * is already settled. Bounded, and advisory: it never narrows what a pass may
   * report or what a fix round owes. This is the coordinator's only channel to
   * that step, since `rationale` is the run's record rather than a handover.
   */
  focus?: string[];
  /** Who answers these findings. Read only when the decision is `fix`. */
  assignee?: "fixer" | "implementer";
  /** The fixer runtime, required when `assignee` is `fixer`. */
  fixer?: WorkPlanRoleConfig;
  /** The final judge of the delivered head. Read only when delivering. */
  verdict?: WorkPlanRoleConfig;
  rationale: string;
}

/**
 * One answer to a review finding the implementer did not simply fix — the
 * implementer's half of the exchange. Carried into the next review assignment
 * so the reviewer resolves it explicitly instead of the disagreement surviving
 * only as another silent revise round.
 */
export type FindingResponse = {
  /** The finding being answered, as the reviewer wrote it. */
  finding: string;
  response: string;
};

/** What an implementation agent step reports when it finishes its assignment. */
export interface ImplementationResult {
  /** Bounded prose the next step's prompt may carry; the summary is separate. */
  notes?: string;
  responses?: FindingResponse[];
  /** The review set this fix round was handed; written by the server. */
  reviewSetId?: string;
  /**
   * What the set's threads say the fix round did, read back from the durable
   * review surface when the step finished. Server-written evidence, never the
   * agent's own claim: `docs/agent-workflows.md`, "Review and fix".
   */
  resolutions?: ReviewFindingResolution[];
}

/**
 * A review verdict. `pass` accepts the reviewed commit, `revise` asks for
 * rework, `fail` ends the automatic loop and hands the run to the user.
 */
export type AssessmentVerdict = "pass" | "revise" | "fail";

const ASSESSMENT_VERDICTS: readonly AssessmentVerdict[] = [
  "pass",
  "revise",
  "fail",
];

/**
 * A review agent step's result. `headCommit` is MANDATORY: review evidence
 * names the exact commit it assessed and applies only to that commit
 * (foundation invariant 3), so an assessment without one is not evidence.
 *
 * The two lists are separated because only one of them can reach the
 * implementer: `findings` are ACTIONABLE and travel into the rework
 * assignment, `observations` are remarks the reviewer does not want acted on
 * now and travel to the user's card. A `pass` therefore may not carry
 * findings — "accepted, but here are three things" used to be expressible, and
 * the recipe reads findings only on the revise path, so those three things
 * were silently dropped. The contract now forces the reviewer to say which of
 * the two it means.
 */
export interface Assessment {
  verdict: AssessmentVerdict;
  headCommit: string;
  /** Must be acted on before delivery; empty when the verdict is `pass`. */
  findings: ReviewFinding[];
  /** Non-blocking remarks: surfaced to the user, never a gate. */
  observations?: string[];
  /**
   * The durable review set this assessment was published as. Written by the
   * server at submission (`workflow/reviewSets.ts`), never by the reviewer.
   */
  reviewSetId?: string;
  /**
   * What the set's threads ACTUALLY say once a re-check has settled them, read
   * back off the review surface after settlement ran — server-written like
   * `reviewSetId`, and present only on a re-check.
   *
   * Read back rather than derived, because settlement is best-effort per
   * thread: a reply or a resolution that fails is warned and skipped, so the
   * disposition a re-check DECIDED and the disposition its threads HOLD can
   * differ. The card counts thread state, so it must count this snapshot and
   * not the intent behind it — a resolution that did not land has to keep
   * reading as open.
   */
  settlement?: ReviewFindingResolution[];
}

/**
 * Bounded evidence about what the reviewed range actually contains. The recipe
 * is PURE and does no I/O, so the only way it can hand the coordinator real
 * evidence about the diff is for the host operation that produced the range to
 * record it here. Shape, not content: totals, a capped per-file stat, and the
 * commit subjects — never a diff.
 */
export interface CommitRangeChanges {
  filesChanged: number;
  insertions: number;
  deletions: number;
  /** Per-file stat, capped by {@link COMMIT_RANGE_MAX_FILES}. */
  files: { path: string; insertions: number; deletions: number }[];
  /** Subjects of the commits in the range, capped and newest last. */
  commitSubjects: string[];
  /** Either list was cut to the cap; the totals above remain complete. */
  truncated?: boolean;
}

/** How much per-range evidence a `commit-sync-result` may carry. */
export const COMMIT_RANGE_MAX_FILES = 40;
export const COMMIT_RANGE_MAX_COMMITS = 20;
export const COMMIT_RANGE_MAX_ITEM_CHARS = 200;

/** The commit range a commit or synchronization host operation produced. */
export interface CommitSyncResult {
  baseCommit: string;
  headCommit: string;
  /** Which recipe-owned checkpoint action produced this evidence. */
  operation?: "commit-sync" | "commit" | "base-sync";
  /** Exact accepted checkpoint and run head observed before this action. */
  previousBaseCommit?: string;
  previousHeadCommit?: string;
  /** Whether refreshing the Project base changed the accepted checkpoint. */
  baseMoved?: boolean;
  /** Whether synchronization changed the exact run head. */
  headRewritten?: boolean;
  /** Absent when the inspection could not be taken; the range still stands. */
  changes?: CommitRangeChanges;
}

/** One provider check attached to the exact pushed workflow commit. */
export interface WorkflowCiCheckResult {
  name: string;
  status: string;
  url?: string;
  /** Bounded provider output/description, retained especially on failures. */
  excerpt?: string;
}

/** Machine observation of CI for one exact commit. */
export interface WorkflowCiResult {
  outcome: "green" | "red" | "none" | "timeout";
  headCommit: string;
  checks: WorkflowCiCheckResult[];
  /** Provider returned more checks than the persisted per-commit cap. */
  truncated?: boolean;
  reason?: string;
}

/** A deterministic delivery inspection either permits publication or re-review. */
export type DeliveryGateResult =
  | { outcome: "ready"; reviewedHeadCommit: string }
  | {
      outcome: "review-required";
      reviewedHeadCommit: string;
      observedHeadCommit: string;
      /**
       * Whether the refusal includes UNCOMMITTED work. It separates two very
       * different states behind one refusal: a clean checkout whose HEAD moved
       * has a commit that could still be delivered, while a dirty one has
       * changes no commit holds — so there is nothing "as it stands" could
       * ship, and the delivery gate would only refuse again.
       */
      worktreeDirty: boolean;
      reason: string;
    };

/** The publication operation's durable link to the existing live PR card. */
type PublishPullRequestResult =
  | {
      outcome: "published";
      reviewedHeadCommit: string;
      cardId: string;
      sessionId: string;
      provider: "forgejo" | "github";
      number: number;
      url: string;
    }
  | {
      outcome: "review-required";
      reviewedHeadCommit: string;
      observedHeadCommit: string;
      worktreeDirty: boolean;
      reason: string;
    };

/** The shape each registered contract id carries. */
/** A durable PR wait's terminal observation for the exact reviewed head. */
export type PullRequestObservationResult =
  | { outcome: "ready"; headCommit: string }
  | {
      outcome:
        | "ci-failure"
        | "changes-requested"
        | "base-conflict"
        | "head-changed"
        | "closed"
        | "merged";
      headCommit: string;
      reason: string;
    };

export interface WorkflowResultContractShapes {
  "work-plan": WorkPlan;
  "review-decision": ReviewDecision;
  "implementation-result": ImplementationResult;
  assessment: Assessment;
  "commit-sync-result": CommitSyncResult;
  "ci-observation-result": WorkflowCiResult;
  "delivery-gate-result": DeliveryGateResult;
  "publish-pull-request-result": PublishPullRequestResult;
  "pull-request-observation-result": PullRequestObservationResult;
}

export type WorkflowResultContractId = keyof WorkflowResultContractShapes;

export const WORK_PLAN_CONTRACT_ID = "work-plan";
export const REVIEW_DECISION_CONTRACT_ID = "review-decision";
export const IMPLEMENTATION_RESULT_CONTRACT_ID = "implementation-result";
export const ASSESSMENT_CONTRACT_ID = "assessment";
export const COMMIT_SYNC_RESULT_CONTRACT_ID = "commit-sync-result";
export const CI_OBSERVATION_RESULT_CONTRACT_ID = "ci-observation-result";
export const DELIVERY_GATE_RESULT_CONTRACT_ID = "delivery-gate-result";
export const PUBLISH_PULL_REQUEST_RESULT_CONTRACT_ID =
  "publish-pull-request-result";
export const PULL_REQUEST_OBSERVATION_RESULT_CONTRACT_ID =
  "pull-request-observation-result";

/* ------------------------------- validators ------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((it) => typeof it === "string");
}

function isReviewFindingArray(value: unknown): value is ReviewFinding[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        REVIEW_FINDING_SEVERITIES.includes(
          item.severity as ReviewFinding["severity"],
        ) &&
        isNonEmptyString(item.text) &&
        // The anchor is optional but not partial: a path with no line has
        // nowhere to publish the finding, and a line with no path is noise.
        (item.path === undefined
          ? item.line === undefined
          : isNonEmptyString(item.path) &&
            Number.isInteger(item.line) &&
            (item.line as number) > 0) &&
        (item.commentId === undefined || typeof item.commentId === "string"),
    )
  );
}

/** Normalize persisted assessments written before findings carried severity. */
function normalizeLegacyAssessment(payload: unknown): void {
  if (!isRecord(payload) || !Array.isArray(payload.findings)) return;
  for (let index = 0; index < payload.findings.length; index += 1) {
    if (typeof payload.findings[index] === "string")
      payload.findings[index] = {
        severity: "major",
        text: payload.findings[index],
      };
  }
}

/**
 * One registered contract: its id and the predicate that decides whether a
 * submitted payload IS that contract. Plain predicates on purpose — the shapes
 * are three fields wide, and a schema library would add a dependency without
 * making any of these checks stricter.
 */
export interface WorkflowResultContract<T> {
  id: WorkflowResultContractId;
  /** Human-readable shape, for the pause reason a rejected result produces. */
  describe: string;
  validate(payload: unknown): payload is T;
}

function isRoleConfig(value: unknown): value is WorkPlanRoleConfig {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.provider) &&
    isNonEmptyString(value.modelId) &&
    THINKING_LEVELS.includes(value.thinkingLevel as ThinkingLevel) &&
    isNonEmptyString(value.credentialProfileId) &&
    isNonEmptyString(value.family) &&
    (value.notes === undefined || typeof value.notes === "string")
  );
}

const WORK_PLAN_CONTRACT: WorkflowResultContract<WorkPlan> = {
  id: WORK_PLAN_CONTRACT_ID,
  describe:
    '{ complexity: "low" | "medium" | "high", implementer: config, reviewer: config, rationale: string }',
  validate: (payload): payload is WorkPlan =>
    isRecord(payload) &&
    (payload.complexity === "low" ||
      payload.complexity === "medium" ||
      payload.complexity === "high") &&
    isRoleConfig(payload.implementer) &&
    isRoleConfig(payload.reviewer) &&
    isNonEmptyString(payload.rationale),
};

const REVIEW_DECISION_CONTRACT: WorkflowResultContract<ReviewDecision> = {
  id: REVIEW_DECISION_CONTRACT_ID,
  describe:
    '{ decision: "deliver" | "review-again" | "fix", reviewer?: config (from the reviewer role set), focus?: string[] (what the next pass should look at first, or how the fix round should approach the findings), assignee?: "fixer" | "implementer" (who answers the findings), fixer?: config (from the fixer role set, required with assignee "fixer"), verdict?: config (from the verdict role set, with decision "deliver"), rationale: string }',
  validate: (payload): payload is ReviewDecision =>
    isRecord(payload) &&
    (payload.decision === "deliver" ||
      payload.decision === "review-again" ||
      payload.decision === "fix") &&
    (payload.reviewer === undefined || isRoleConfig(payload.reviewer)) &&
    (payload.focus === undefined ||
      (isStringArray(payload.focus) &&
        payload.focus.every((item) => item.trim().length > 0))) &&
    (payload.assignee === undefined ||
      payload.assignee === "fixer" ||
      payload.assignee === "implementer") &&
    (payload.fixer === undefined || isRoleConfig(payload.fixer)) &&
    (payload.verdict === undefined || isRoleConfig(payload.verdict)) &&
    // A routing answer has to name someone: "fix" with neither an assignee nor
    // a runtime is not a decision the recipe can carry out, and refusing it
    // while the step still runs is the coordinator's chance to say who.
    (payload.decision !== "fix" ||
      payload.assignee !== undefined ||
      payload.fixer !== undefined) &&
    isNonEmptyString(payload.rationale),
};

function isFindingResponseArray(value: unknown): value is FindingResponse[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        isNonEmptyString(item.finding) &&
        isNonEmptyString(item.response),
    )
  );
}

const IMPLEMENTATION_RESULT_CONTRACT: WorkflowResultContract<ImplementationResult> =
  {
    id: IMPLEMENTATION_RESULT_CONTRACT_ID,
    describe:
      "{ notes?: string, responses?: [{ finding: string, response: string }] }",
    validate: (payload): payload is ImplementationResult =>
      isRecord(payload) &&
      (payload.notes === undefined || typeof payload.notes === "string") &&
      (payload.responses === undefined ||
        isFindingResponseArray(payload.responses)),
  };

const ASSESSMENT_CONTRACT: WorkflowResultContract<Assessment> = {
  id: ASSESSMENT_CONTRACT_ID,
  describe: `{ verdict: "pass" | "revise" | "fail", headCommit: string, findings: [{ severity: "critical" | "major" | "minor" | "nit", text: string, path?: string, line?: integer (path and line travel together and publish the finding as an anchored review comment) }] (empty when the verdict is "pass"; "revise" requires at least one, since findings are the only part of a review the implementer is given), observations?: string[] }. The findings array must serialize to at most ${ASSESSMENT_FINDINGS_MAX_CHARS} characters, because every later assignment has to carry all of it: if your report exceeds that, consolidate related points and keep the blocking ones rather than dropping detail silently. At most ${ASSESSMENT_FINDINGS_MAX_COUNT} findings, for the same reason: each one costs more once it becomes a review thread a fix round has to answer.`,
  validate: (payload): payload is Assessment =>
    isRecord(payload) &&
    ASSESSMENT_VERDICTS.includes(payload.verdict as AssessmentVerdict) &&
    isNonEmptyString(payload.headCommit) &&
    isReviewFindingArray(payload.findings) &&
    // Bounded HERE, where the reviewer is still running and can consolidate,
    // because every successor assignment must carry every finding and none of
    // them can bound it without losing one (`ASSESSMENT_FINDINGS_MAX_CHARS`).
    submittedFindingsSize(payload.findings) <= ASSESSMENT_FINDINGS_MAX_CHARS &&
    payload.findings.length <= ASSESSMENT_FINDINGS_MAX_COUNT &&
    // The only cross-field rules in any contract, and deliberately here rather
    // than in the recipe: the submitting side rejects a verdict that does not
    // match its findings while the step is still running and the reviewer can
    // correct it. Both directions exist for one reason — `findings` is the only
    // part of an assessment that becomes a rework assignment, so an accepting
    // verdict that lists changes drops them, and a rework verdict that lists
    // none asks for changes nobody is told about.
    (payload.verdict !== "pass" || payload.findings.length === 0) &&
    (payload.verdict !== "revise" || payload.findings.length > 0) &&
    (payload.observations === undefined || isStringArray(payload.observations)),
};

/**
 * The size of what the REVIEWER wrote, ignoring the thread id the server adds
 * when it publishes each finding.
 *
 * Measuring the stored shape instead would make a legitimate assessment fail
 * its own contract the moment it was published — and the recipe reads results
 * through that contract, so the run would pause on evidence it had just
 * accepted, with nothing able to shrink it. The ids are bounded separately, by
 * {@link ASSESSMENT_FINDINGS_MAX_COUNT}.
 */
function submittedFindingsSize(findings: readonly ReviewFinding[]): number {
  return JSON.stringify(
    findings.map(({ commentId: _thread, ...written }) => written),
  ).length;
}

function isCommitRangeChanges(value: unknown): value is CommitRangeChanges {
  if (!isRecord(value)) return false;
  return (
    Number.isInteger(value.filesChanged) &&
    Number.isInteger(value.insertions) &&
    Number.isInteger(value.deletions) &&
    Array.isArray(value.files) &&
    value.files.length <= COMMIT_RANGE_MAX_FILES &&
    value.files.every(
      (file) =>
        isRecord(file) &&
        isNonEmptyString(file.path) &&
        Number.isInteger(file.insertions) &&
        Number.isInteger(file.deletions),
    ) &&
    isStringArray(value.commitSubjects) &&
    value.commitSubjects.length <= COMMIT_RANGE_MAX_COMMITS &&
    (value.truncated === undefined || typeof value.truncated === "boolean")
  );
}

const COMMIT_SYNC_RESULT_CONTRACT: WorkflowResultContract<CommitSyncResult> = {
  id: COMMIT_SYNC_RESULT_CONTRACT_ID,
  describe:
    '{ baseCommit: string, headCommit: string, operation?: "commit-sync" | "commit" | "base-sync", previousBaseCommit?: string, previousHeadCommit?: string, baseMoved?: boolean, headRewritten?: boolean, changes?: { filesChanged, insertions, deletions, files: [{ path, insertions, deletions }], commitSubjects: string[], truncated?: boolean } }',
  validate: (payload): payload is CommitSyncResult =>
    isRecord(payload) &&
    isNonEmptyString(payload.baseCommit) &&
    isNonEmptyString(payload.headCommit) &&
    (payload.operation === undefined ||
      payload.operation === "commit-sync" ||
      payload.operation === "commit" ||
      payload.operation === "base-sync") &&
    (payload.previousBaseCommit === undefined ||
      isNonEmptyString(payload.previousBaseCommit)) &&
    (payload.previousHeadCommit === undefined ||
      isNonEmptyString(payload.previousHeadCommit)) &&
    (payload.baseMoved === undefined ||
      typeof payload.baseMoved === "boolean") &&
    (payload.headRewritten === undefined ||
      typeof payload.headRewritten === "boolean") &&
    (payload.changes === undefined || isCommitRangeChanges(payload.changes)),
};

function isCiCheck(value: unknown): value is WorkflowCiCheckResult {
  return (
    isRecord(value) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.status) &&
    (value.url === undefined || typeof value.url === "string") &&
    (value.excerpt === undefined || typeof value.excerpt === "string")
  );
}

const CI_OBSERVATION_RESULT_CONTRACT: WorkflowResultContract<WorkflowCiResult> =
  {
    id: CI_OBSERVATION_RESULT_CONTRACT_ID,
    describe:
      '{ outcome: "green" | "red" | "none" | "timeout", headCommit: string, checks: [{ name, status, url?, excerpt? }], truncated?: boolean, reason?: string }',
    validate: (payload): payload is WorkflowCiResult =>
      isRecord(payload) &&
      (payload.outcome === "green" ||
        payload.outcome === "red" ||
        payload.outcome === "none" ||
        payload.outcome === "timeout") &&
      isNonEmptyString(payload.headCommit) &&
      Array.isArray(payload.checks) &&
      payload.checks.every(isCiCheck) &&
      (payload.truncated === undefined ||
        typeof payload.truncated === "boolean") &&
      (payload.reason === undefined || typeof payload.reason === "string"),
  };

function isReviewRequiredResult(value: Record<string, unknown>): boolean {
  return (
    value.outcome === "review-required" &&
    isNonEmptyString(value.reviewedHeadCommit) &&
    isNonEmptyString(value.observedHeadCommit) &&
    typeof value.worktreeDirty === "boolean" &&
    isNonEmptyString(value.reason)
  );
}

const DELIVERY_GATE_RESULT_CONTRACT: WorkflowResultContract<DeliveryGateResult> =
  {
    id: DELIVERY_GATE_RESULT_CONTRACT_ID,
    describe:
      '{ outcome: "ready" | "review-required", reviewedHeadCommit: string, ... }',
    validate: (payload): payload is DeliveryGateResult =>
      isRecord(payload) &&
      ((payload.outcome === "ready" &&
        isNonEmptyString(payload.reviewedHeadCommit)) ||
        isReviewRequiredResult(payload)),
  };

const PUBLISH_PULL_REQUEST_RESULT_CONTRACT: WorkflowResultContract<PublishPullRequestResult> =
  {
    id: PUBLISH_PULL_REQUEST_RESULT_CONTRACT_ID,
    describe:
      '{ outcome: "published" | "review-required", reviewedHeadCommit: string, ... }',
    validate: (payload): payload is PublishPullRequestResult =>
      isRecord(payload) &&
      (isReviewRequiredResult(payload) ||
        (payload.outcome === "published" &&
          isNonEmptyString(payload.reviewedHeadCommit) &&
          isNonEmptyString(payload.cardId) &&
          isNonEmptyString(payload.sessionId) &&
          (payload.provider === "forgejo" || payload.provider === "github") &&
          Number.isInteger(payload.number) &&
          (payload.number as number) > 0 &&
          isNonEmptyString(payload.url))),
  };

const TERMINAL_PULL_REQUEST_OBSERVATIONS = [
  "ci-failure",
  "changes-requested",
  "base-conflict",
  "head-changed",
  "closed",
  "merged",
] as const;

const PULL_REQUEST_OBSERVATION_RESULT_CONTRACT: WorkflowResultContract<PullRequestObservationResult> =
  {
    id: PULL_REQUEST_OBSERVATION_RESULT_CONTRACT_ID,
    describe:
      '{ outcome: "ready" | "ci-failure" | "changes-requested" | "base-conflict" | "head-changed" | "closed" | "merged", headCommit: string, reason?: string }',
    validate: (payload): payload is PullRequestObservationResult =>
      isRecord(payload) &&
      isNonEmptyString(payload.headCommit) &&
      (payload.outcome === "ready" ||
        (TERMINAL_PULL_REQUEST_OBSERVATIONS.includes(
          payload.outcome as (typeof TERMINAL_PULL_REQUEST_OBSERVATIONS)[number],
        ) &&
          isNonEmptyString(payload.reason))),
  };

/** Every contract the server knows, by id. */
export const WORKFLOW_RESULT_CONTRACTS: {
  [K in WorkflowResultContractId]: WorkflowResultContract<
    WorkflowResultContractShapes[K]
  >;
} = {
  [WORK_PLAN_CONTRACT_ID]: WORK_PLAN_CONTRACT,
  [REVIEW_DECISION_CONTRACT_ID]: REVIEW_DECISION_CONTRACT,
  [IMPLEMENTATION_RESULT_CONTRACT_ID]: IMPLEMENTATION_RESULT_CONTRACT,
  [ASSESSMENT_CONTRACT_ID]: ASSESSMENT_CONTRACT,
  [COMMIT_SYNC_RESULT_CONTRACT_ID]: COMMIT_SYNC_RESULT_CONTRACT,
  [CI_OBSERVATION_RESULT_CONTRACT_ID]: CI_OBSERVATION_RESULT_CONTRACT,
  [DELIVERY_GATE_RESULT_CONTRACT_ID]: DELIVERY_GATE_RESULT_CONTRACT,
  [PUBLISH_PULL_REQUEST_RESULT_CONTRACT_ID]:
    PUBLISH_PULL_REQUEST_RESULT_CONTRACT,
  [PULL_REQUEST_OBSERVATION_RESULT_CONTRACT_ID]:
    PULL_REQUEST_OBSERVATION_RESULT_CONTRACT,
};

/** Any registered contract, for a caller holding an id it has not narrowed. */
export type AnyWorkflowResultContract =
  (typeof WORKFLOW_RESULT_CONTRACTS)[WorkflowResultContractId];

function isWorkflowResultContractId(
  id: string,
): id is WorkflowResultContractId {
  return Object.hasOwn(WORKFLOW_RESULT_CONTRACTS, id);
}

/**
 * The contract a submitted result names, or `undefined` when nothing is
 * registered under that id. The submission side ([Task-367](pa://task/367))
 * validates through this, so a payload the recipe would later reject is refused
 * at the moment it is offered.
 */
export function getResultContract(
  id: string,
): AnyWorkflowResultContract | undefined {
  return isWorkflowResultContractId(id)
    ? WORKFLOW_RESULT_CONTRACTS[id]
    : undefined;
}

/* --------------------------------- reading -------------------------------- */

/**
 * The contract-shaped payload a COMPLETED step carries, or `undefined` when the
 * step did not end with that evidence — it ended in another status, named
 * another contract, or submitted a payload that does not validate.
 *
 * One reader for all three cases on purpose: "ended without the expected
 * evidence" is a single condition for the recipe, which pauses rather than
 * guessing what a malformed payload meant.
 */
export function readStepResult<K extends WorkflowResultContractId>(
  step: WorkflowStepRow,
  contractId: K,
): WorkflowResultContractShapes[K] | undefined {
  if (step.status !== "completed") return undefined;
  const result = step.result;
  if (!result || result.status !== "completed") return undefined;
  if (result.contractId !== contractId) return undefined;
  if (contractId === ASSESSMENT_CONTRACT_ID)
    normalizeLegacyAssessment(result.payload);
  const contract = WORKFLOW_RESULT_CONTRACTS[contractId];
  return contract.validate(result.payload) ? result.payload : undefined;
}
