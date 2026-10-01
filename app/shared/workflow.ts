/**
 * Shared domain contracts for Workflow Runs (`docs/agent-workflows.md`,
 * [Task-364](pa://task/364)).
 *
 * A **Workflow Run** is one durable attempt to produce an outcome for a Task —
 * separate from the Task, from the sessions that execute its work, and from the
 * worktree those sessions run in. This module is the wire model for the three
 * persisted objects (run, step, event) plus the vocabularies and bounds the
 * server store and the browser both need.
 *
 * The model is deliberately GENERIC: a step is a `kind` plus a typed payload,
 * and nothing here is named after implementers, reviewers, Git, or pull
 * requests. Recipe-specific meaning lives in the payloads and result contracts
 * the server registers in code, never in a core field — if a future recipe
 * needs a core field called `reviewer`, the core is too specific.
 */

/** A JSON value, for the payloads whose shape a recipe or contract owns. */
export type WorkflowJsonValue =
  | string
  | number
  | boolean
  | null
  | WorkflowJsonValue[]
  | { [key: string]: WorkflowJsonValue };

/** Severity assigned to one actionable workflow-review finding. */
export type ReviewFindingSeverity = "critical" | "major" | "minor" | "nit";

export const REVIEW_FINDING_SEVERITIES: readonly ReviewFindingSeverity[] = [
  "critical",
  "major",
  "minor",
  "nit",
];

/** One actionable review finding, preserved from assessment through the card. */
export type ReviewFinding = {
  severity: ReviewFindingSeverity;
  text: string;
  /** Repository-relative file the finding is about, when the reviewer named one. */
  path?: string;
  /** 1-based line in `path`; an anchor needs both. */
  line?: number;
  /**
   * The durable worktree review thread this finding was published as. Written
   * by the server when it publishes the assessment's review set — never by the
   * submitting agent — so the fixer can answer the finding where the user sees
   * it (`docs/comments.md`).
   */
  commentId?: string;
};

/**
 * What a fix round did with one published finding, read back from its durable
 * thread rather than from the fixer's own prose.
 *
 * `disputed` is the state that must not collapse into either neighbour: the
 * fixer answered the finding and deliberately left it open, which is a valid
 * resolution the verdict pass has to judge — unlike `open`, which nobody
 * answered at all.
 */
type ReviewFindingResolutionState = "resolved" | "disputed" | "open";

export type ReviewFindingResolution = {
  /** The published thread, which is also the join key back to the finding. */
  commentId: string;
  state: ReviewFindingResolutionState;
  /** The fixer's own last reply on the thread, bounded by the payload budget. */
  response?: string;
};

/** Order findings from deploy risk to style. */
export function compareReviewFindings(
  left: Pick<ReviewFinding, "severity">,
  right: Pick<ReviewFinding, "severity">,
): number {
  return (
    REVIEW_FINDING_SEVERITIES.indexOf(left.severity) -
    REVIEW_FINDING_SEVERITIES.indexOf(right.severity)
  );
}

/** Content discipline included verbatim in every code-review assignment. */
export const REVIEW_REPORT_CONVENTION = `Review-report convention:
- Findings are a numbered list ordered by severity. Each finding:
  [critical|major|minor|nit] — file:line — one-line issue — one short paragraph
  on why it matters. Severity meanings: critical = data loss/corruption or
  user-visible breakage on deploy; major = violates a stated requirement or
  introduces a bug a follow-up will trip over; minor = works but wrong shape
  (conventions, dead code, stale docs); nit = style.
- The diff is evidence; commit messages and code comments asserting a property
  are not. Anchor every finding to what the code actually does.
- Do NOT pad: if the change is clean, an empty findings list with an approving
  verdict is the correct report — inventing findings is a review failure.
- End with "Not checked": what you did not verify and why, so the reader knows
  the review's boundaries.
- Treat the implementer's own verification statements as claims, not results.`;

/** How an implementer evaluates and responds to workflow-review findings. */
export const REVIEW_RESPONSE_CONVENTION = `Findings are claims, not orders. Verify each against the code before acting.
Fix what is real at the root cause — not the narrowest patch that silences the
wording of the finding; where tests are demanded, write tests that pin the
behavior, not tests that restate the implementation. If a finding is wrong or
belongs elsewhere, do NOT change the code for it: answer it with concrete
evidence (file:line, task text, or demonstrated behavior). A well-argued
rejection is a valid resolution; silently skipping a finding is not. Report a
disposition per finding: fixed | rejected | partially addressed.`;

/* ---------------------------------- runs --------------------------------- */

/**
 * Lifecycle of a run. `paused` blocks admission of new steps without aborting a
 * turn that is already running; `cancelled` prevents further work while
 * preserving the run's sessions, worktree, and any pull request.
 */
export type WorkflowRunLifecycle =
  "active" | "paused" | "completed" | "cancelled";

/** Lifecycle states a run never leaves again. */
const WORKFLOW_RUN_TERMINAL_LIFECYCLES: readonly WorkflowRunLifecycle[] = [
  "completed",
  "cancelled",
];

export function isTerminalWorkflowRunLifecycle(
  lifecycle: WorkflowRunLifecycle,
): boolean {
  return WORKFLOW_RUN_TERMINAL_LIFECYCLES.includes(lifecycle);
}

/**
 * The run's plain bounds. Deliberately plain numbers rather than a budget
 * ledger: v1 has no adaptive delegation to spend a budget, and a ledger is an
 * additive replacement when it does.
 */
export interface WorkflowRunLimits {
  /** Maximum fix → re-assess round trips before the run asks the user. */
  maxIterations: number;
  /** Maximum independent discovery opinions the run may buy. */
  maxReviewPasses: number;
}

/**
 * How a user moves an open ceiling. Relative raises make "N more" explicit;
 * absolute targets support callers that already know the final ceilings.
 */
export type WorkflowCeilingRaise =
  | {
      mode: "raise-by";
      amounts: Partial<WorkflowRunLimits>;
    }
  | {
      mode: "set";
      ceilings: WorkflowRunLimits;
    };

/**
 * What the start sheet offers for each limit. Defaults make the common path a
 * one-tap start; the maxima are guardrails against a typo on that form, not a
 * budget model — a raise answered at an open ceiling gate
 * ({@link raiseWorkflowRunLimits}) is not bound by them.
 */
export const WORKFLOW_RUN_LIMIT_BOUNDS = {
  maxIterations: { min: 0, max: 10, default: 3 },
  maxReviewPasses: { min: 1, max: 5, default: 2 },
} as const;

/** One limit clamped into its offered bounds, coerced to an integer. */
function clampWorkflowRunLimit(
  limit: keyof typeof WORKFLOW_RUN_LIMIT_BOUNDS,
  value: number,
): number {
  const bounds = WORKFLOW_RUN_LIMIT_BOUNDS[limit];
  if (!Number.isFinite(value)) return bounds.default;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
}

/** Every limit at its offered default — the recommended run. */
export function defaultWorkflowRunLimits(): WorkflowRunLimits {
  return {
    maxIterations: WORKFLOW_RUN_LIMIT_BOUNDS.maxIterations.default,
    maxReviewPasses: WORKFLOW_RUN_LIMIT_BOUNDS.maxReviewPasses.default,
  };
}

/**
 * Fold a partial limit change into a complete, in-bounds set.
 *
 * There is nothing to reconcile between them: the two ceilings bound different
 * events — independent opinions, and fix round trips — and the sessions a run
 * opens follow from both rather than being chosen beside them. An independently
 * chosen session cap could contradict the passes it was supposed to allow, so
 * it is derived, not configured.
 */
export function applyWorkflowRunLimits(
  current: WorkflowRunLimits,
  patch: Partial<WorkflowRunLimits>,
): WorkflowRunLimits {
  return {
    maxIterations: clampWorkflowRunLimit(
      "maxIterations",
      patch.maxIterations ?? current.maxIterations,
    ),
    maxReviewPasses: clampWorkflowRunLimit(
      "maxReviewPasses",
      patch.maxReviewPasses ?? current.maxReviewPasses,
    ),
  };
}

/** A stored or partial limit set restored as a consistent, in-bounds one. */
export function normalizeWorkflowRunLimits(
  value: Partial<WorkflowRunLimits> | undefined,
): WorkflowRunLimits {
  return applyWorkflowRunLimits(defaultWorkflowRunLimits(), value ?? {});
}

/**
 * A raise answered at an open ceiling gate. The start-form maxima are typo
 * guardrails on a one-tap sheet; a raise is the user explicitly buying more
 * automatic work for a run that already hit its bound, so each limit is
 * floored at its minimum and coerced to an integer but has NO maximum — the
 * gate re-opens at every exhausted ceiling, and only the user says "more".
 * A garbage number falls to the minimum, which the engine's never-lower rule
 * turns into a refused no-op rather than a silent raise.
 */
export function raiseWorkflowRunLimits(
  value: Partial<WorkflowRunLimits> | undefined,
): WorkflowRunLimits {
  const floored = (
    limit: keyof typeof WORKFLOW_RUN_LIMIT_BOUNDS,
    raised: number | undefined,
  ): number => {
    const bounds = WORKFLOW_RUN_LIMIT_BOUNDS[limit];
    if (raised === undefined || !Number.isFinite(raised)) return bounds.min;
    return Math.max(bounds.min, Math.round(raised));
  };
  return {
    maxIterations: floored("maxIterations", value?.maxIterations),
    maxReviewPasses: floored("maxReviewPasses", value?.maxReviewPasses),
  };
}

/** The events a run's attention revision moves on; nothing else moves it. */
export type WorkflowRunAttentionKind = "paused" | "completed" | "cancelled";

/**
 * Durable attention state for a formal Workflow Run ([Task-677](pa://task/677)):
 * the same shape and the same rules as `SessionOutcomeAttention`, one level up.
 *
 * The revision moves only on a MEANINGFUL event — the run reaching a pause or
 * gate (a failure pauses the run with its reason), completing, or being
 * cancelled. It never moves when the run or a step starts, on tool or agent
 * progress, or when the run or any of its sessions is viewed. Settle
 * acknowledges the revision the user OBSERVED, so an outcome that landed
 * between the render and the click stays awake.
 *
 * Present only once a revision has been raised: a run created before this
 * cursor existed carries none, and a terminal one from before it is not
 * resurrected into the inbox.
 */
export interface WorkflowRunAttention {
  /** Monotonic, one bump per meaningful event. */
  revision: number;
  /** The revision an explicit Settle acknowledged; 0 when never settled. */
  settledRevision: number;
  kind: WorkflowRunAttentionKind;
  at: number;
}

/**
 * The run event the user has NOT acknowledged yet, or `undefined` when the
 * run's attention is settled through its latest one. ONE derivation for both
 * sides, like `pendingSessionOutcome`: the browser decides with it whether a
 * terminal run is still an inbox item, and the server whether a Settle
 * acknowledged anything.
 */
export function pendingWorkflowRunAttention(
  attention: WorkflowRunAttention | undefined,
): WorkflowRunAttention | undefined {
  return attention && attention.revision > attention.settledRevision
    ? attention
    : undefined;
}

/**
 * A run as the browser sees it. These are the persisted run columns only:
 * anything derived from step history (which phase the run is in, what it waits
 * on) is the recipe's projection, not run state.
 */
export interface WorkflowRunSummary {
  id: string;
  /** The Task this run works on. */
  taskId: string;
  /** The Task's project at start time, when it had one. */
  projectId?: string;
  /** Which recipe drives the run, and the version of its decision function. */
  recipeId: string;
  recipeVersion: number;
  /** The worktree the run owns, once provisioned. */
  worktreeId?: string;
  /** The branch that worktree checked out. */
  branch?: string;
  lifecycle: WorkflowRunLifecycle;
  /**
   * Why the run is in this lifecycle state. A pause always has one — the store
   * refuses a blank reason — so a card rendering a paused run can rely on it.
   */
  lifecycleReason?: string;
  limits: WorkflowRunLimits;
  /**
   * The recipe-owned start configuration, captured once when the run is created
   * and never rewritten. Opaque to the core on purpose — the recipe that
   * recorded it is the only reader that knows its shape (the code-delivery
   * recipe stores a `CodeDeliveryWorkflowConfig` here).
   */
  config?: WorkflowJsonValue;
  createdAt: number;
  updatedAt: number;
  /** When the run reached a terminal lifecycle. */
  endedAt?: number;
  /**
   * The run's attention cursor, once any meaningful event has raised one.
   * Whether the run is an inbox item across its terminal boundary is read from
   * this alone ({@link pendingWorkflowRunAttention}).
   */
  attention?: WorkflowRunAttention;
}

/* --------------------------------- steps --------------------------------- */

/**
 * What executes a step. The four kinds are the whole v1 vocabulary:
 *
 * - `agent` — one bounded assignment a session completes by submitting a
 *   structured result.
 * - `host-operation` — a registered deterministic operation calling existing
 *   application services through their seams (never slash-command text, never
 *   an agent tool).
 * - `wait` — a durable subscription to an external condition, reconciled on
 *   boot.
 * - `user-decision` — a deliberate human gate recording the allowed choices and
 *   the choice made.
 */
export type WorkflowStepKind =
  "agent" | "host-operation" | "wait" | "user-decision";

/**
 * Step status. A step is admitted `pending`, becomes `running` when its
 * executor takes it, and then reaches exactly one terminal status, which is
 * final: a revision or a semantic retry APPENDS a successor step rather than
 * reopening this one.
 */
export type WorkflowStepStatus =
  "pending" | "running" | "completed" | "blocked" | "failed" | "cancelled";

/**
 * Statuses a step never leaves. `blocked` is terminal like the rest: the step
 * finished and reported that it could not proceed, and what happens next is a
 * new step, not a second life for this one.
 */
const WORKFLOW_STEP_TERMINAL_STATUSES: readonly WorkflowStepStatus[] = [
  "completed",
  "blocked",
  "failed",
  "cancelled",
];

export function isTerminalWorkflowStepStatus(
  status: WorkflowStepStatus,
): boolean {
  return WORKFLOW_STEP_TERMINAL_STATUSES.includes(status);
}

/** Whether a step's executor is a session or a registered host operation. */
export type WorkflowExecutorKind = "session" | "operation";

/**
 * The generic status an executor reports. An agent submits one of these
 * explicitly; an idle session that submits nothing is waiting or blocked per
 * the step's timeout policy — never successful.
 */
export type WorkflowResultStatus = "completed" | "blocked" | "failed";

/* --------------------------------- events -------------------------------- */

/** Who caused a transition. `external` is an observed third party (CI, a host). */
type WorkflowActorKind = "user" | "agent" | "system" | "external";

export interface WorkflowActor {
  kind: WorkflowActorKind;
  /** Session id, user id, operation id, or external system name, when known. */
  id?: string;
}

/**
 * Transition vocabulary. Additive by design: the SQL column is unconstrained so
 * a later recipe can emit a new transition without a table rebuild, and this
 * union grows with it.
 */
export type WorkflowEventType =
  | "run-created"
  | "run-paused"
  | "run-resumed"
  | "run-cancelled"
  | "run-completed"
  | "run-worktree-attached"
  | "run-ceilings-raised"
  | "run-cancel-requested"
  | "step-created"
  | "step-started"
  | "step-attempted"
  | "step-completed"
  | "result-submitted"
  | "observation-recorded";

/* --------------------------------- bounds -------------------------------- */

/** Result summaries are prose for a human; they are truncated, not rejected. */
export const WORKFLOW_SUMMARY_MAX_CHARS = 2_000;

/** Same for a lifecycle/pause reason, which is one line on the run's card. */
export const WORKFLOW_REASON_MAX_CHARS = 500;

/**
 * Step payloads and results are bounded METADATA and durable references (commit
 * SHAs, session ids, PR numbers). Oversized JSON is REJECTED rather than
 * truncated: silently cutting a structured payload would corrupt it, and large
 * content belongs in its own domain store.
 */
export const WORKFLOW_PAYLOAD_MAX_CHARS = 16_000;

/**
 * How much of an assessment its FINDINGS may take up, enforced when the
 * reviewer submits.
 *
 * Findings are the one part of a review that becomes work, and every successor
 * assignment — the fix round, the author's re-check, the verdict, the
 * coordinator's routing decision — has to carry ALL of them. Bounding them
 * anywhere later means dropping some, and a dropped finding is not recoverable
 * by any control the run has: retrying re-composes the same shortened payload,
 * and a coordinator deciding who fixes what cannot read the review threads. So
 * the bound lives where the reviewer is still live and can act on it — an
 * over-long report is refused with this limit named, and it consolidates and
 * resubmits within the same turn.
 *
 * The number leaves room for everything a successor adds on top: one thread id
 * per published finding, one resolution per finding once a fix round answers
 * them, and the assignment's own fixed metadata, all inside
 * {@link WORKFLOW_PAYLOAD_MAX_CHARS}.
 */
export const ASSESSMENT_FINDINGS_MAX_CHARS = 8_000;

/**
 * How many findings one assessment may raise, enforced with
 * {@link ASSESSMENT_FINDINGS_MAX_CHARS} at submission.
 *
 * A byte budget alone does not bound what a successor must carry, because the
 * cost per finding GROWS after submission: publication adds a thread id to each
 * one, and a fix round adds a resolution per thread. Bytes of tiny findings are
 * therefore the expensive case — a few thousand characters of one-line findings
 * becomes several times that downstream — and only a count bounds it.
 *
 * The pair is sized against the worst case a successor carries: the bytes, plus
 * one thread id and one resolution per finding, plus the assignment's fixed
 * metadata, all inside {@link WORKFLOW_PAYLOAD_MAX_CHARS}. Thirty findings
 * averaging some 260 characters is a real review with a one-line issue and an
 * anchor on each; more than that is a report to consolidate, not a payload to
 * enlarge.
 *
 * The margin is measured, not assumed: the boundary test in
 * `codeDeliveryRecipe.test.ts` drives a review at BOTH bounds — published
 * threads, a maximum-length resolution on every one, and every competing group
 * at its own maximum — through the fix round, the re-check, the verdict and the
 * coordinator's routing decision, comparing every field of every finding. That
 * test starts failing between 11,000 and 12,000 characters, so this number sits
 * a third below where findings would begin to lose their text. Raising it means
 * re-running that measurement, not adjusting the constant.
 */
export const ASSESSMENT_FINDINGS_MAX_COUNT = 30;
