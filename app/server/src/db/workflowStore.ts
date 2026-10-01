/**
 * The Workflow Run store (`docs/agent-workflows.md`, Task 364): the three
 * tables of migration `0036_workflow_runs.sql` behind one façade.
 *
 * What this module enforces, so no caller can reintroduce it:
 *
 * - **Append-only while retained.** There is no payload rewrite and no way to
 *   reopen a terminal step. A revision or semantic retry appends a successor
 *   carrying `predecessorId`; only an OPEN step's executor and attempt counter
 *   may move. The one deletion is an explicit user cleanup of a CANCELLED run,
 *   which removes that run and its whole history atomically.
 * - **One step lifecycle.** `pending → running → terminal`, no shortcuts: only
 *   a started step can report an attempt or a result.
 * - **Immutable, non-contradictory results.** A step's result is written
 *   exactly once, by the same call that makes the step terminal, and it must
 *   carry the status the step ends with. A second completion throws.
 * - **History that stays inside its run.** A step's predecessor and an event's
 *   step both belong to the same run as the row naming them.
 * - **No mutable run blob.** Run state is columns; everything an outcome
 *   carries lives in a step result as bounded metadata and durable references
 *   (commit SHAs, session ids, PR numbers).
 * - **Every transition is logged.** Each mutation appends its `workflow_events`
 *   row with the caller's actor inside the same transaction, so a transition
 *   without provenance is not expressible.
 * - **Lifecycle gates.** A PAUSED run admits and starts nothing, while a turn
 *   already running may still record attempts and its result — that is the
 *   difference between pausing and cancelling. A TERMINAL run accepts no write
 *   at all, and ending one cancels its still-open steps in the same
 *   transaction, so nothing is left waiting on a run that is over.
 * - **One active assignment per session.** Enforced by a partial unique index
 *   across all runs, not just checked, so two admissions racing for the same
 *   session cannot both win.
 *
 * The model stays generic: a step is a kind plus an opaque payload, and this
 * module knows nothing about implementers, reviewers, commits, or pull
 * requests. Recipe semantics (which step comes next) live in the recipe code;
 * result-contract validation lives with the tool that accepts results.
 */
import {
  WORKFLOW_PAYLOAD_MAX_CHARS,
  WORKFLOW_REASON_MAX_CHARS,
  WORKFLOW_SUMMARY_MAX_CHARS,
  delegationObligationReason,
  isTerminalWorkflowRunLifecycle,
  isTerminalWorkflowStepStatus,
  type WorkflowActor,
  type WorkflowEventType,
  type WorkflowRunAttention,
  type WorkflowRunAttentionKind,
  type WorkflowExecutorKind,
  type WorkflowJsonValue,
  type WorkflowResultStatus,
  type WorkflowRunLifecycle,
  type WorkflowStepKind,
  type WorkflowStepStatus,
} from "@assistant/shared";
import { broadcastWorktreeEdgeChange } from "../worktrees/worktrees.ts";
import { getDb, withDbTransaction } from "./index.ts";
import { nextId } from "./sequences.ts";
import { subagentStore } from "./subagentStore.ts";
import { linkSessionToWorktree } from "./worktreeStore.ts";

/* ---------------------------------- rows --------------------------------- */

export interface WorkflowRunRow {
  id: number;
  taskId: number;
  projectId?: string;
  recipeId: string;
  recipeVersion: number;
  worktreeId?: string;
  branch?: string;
  lifecycle: WorkflowRunLifecycle;
  lifecycleReason?: string;
  /** When the user asked for this run to end, while settlement still waits. */
  cancelRequestedAt?: number;
  maxIterations: number;
  maxReviewPasses: number;
  /** Recipe-owned start configuration, written once at creation (0037). */
  config?: WorkflowJsonValue;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
  /**
   * The run's attention cursor (0058), present once any meaningful event has
   * raised a revision. Moves only in {@link setRunLifecycle} (pause,
   * completion, cancellation) and {@link settleRun}; never on a step.
   */
  attention?: WorkflowRunAttention;
}

export interface WorkflowStepExecutorRef {
  kind: WorkflowExecutorKind;
  id: string;
}

export interface WorkflowExecutorOwnership {
  runId: number;
  stepId: number;
  sessionId: string;
  stepStatus: WorkflowStepStatus;
  runLifecycle: WorkflowRunLifecycle;
}

interface WorkflowStepResultRow {
  status: WorkflowResultStatus;
  summary: string;
  contractId?: string;
  payload?: WorkflowJsonValue;
  submittedAt: number;
}

export interface WorkflowStepRow {
  id: number;
  runId: number;
  kind: WorkflowStepKind;
  payload: WorkflowJsonValue;
  status: WorkflowStepStatus;
  executor?: WorkflowStepExecutorRef;
  result?: WorkflowStepResultRow;
  /** Executor starts while this step was open; 0 until it first runs. */
  attempt: number;
  predecessorId?: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  endedAt?: number;
}

export interface WorkflowEventRow {
  id: number;
  runId: number;
  stepId?: number;
  type: WorkflowEventType;
  actor: WorkflowActor;
  detail?: WorkflowJsonValue;
  createdAt: number;
}

/* --------------------------------- errors -------------------------------- */

/**
 * A write that append-only semantics forbid: rewriting a terminal step or its
 * result, moving a terminal run, or admitting a step into one. Always a caller
 * bug — the engine checks state before it writes — so it throws rather than
 * returning false.
 */
export class WorkflowImmutableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowImmutableError";
  }
}

/**
 * Work refused because the run is paused. Distinct from
 * {@link WorkflowImmutableError} because it is RECOVERABLE: the same call
 * succeeds after a resume, so a caller may hold the work rather than abandon
 * it. A pause stops admission and starts only — a turn already running finishes
 * and records its result.
 */
export class WorkflowRunPausedError extends Error {
  readonly runId: number;
  constructor(runId: number) {
    super(
      `workflow run ${runId} is paused; it admits no new work until resumed`,
    );
    this.name = "WorkflowRunPausedError";
    this.runId = runId;
  }
}

/**
 * A session was handed a second step while it still holds an open one. The
 * database enforces this across every run (partial unique index), so this is
 * also what a lost race raises rather than a raw SQLite constraint error.
 */
export class WorkflowExecutorBusyError extends Error {
  constructor(sessionId: string, heldStepId?: number) {
    super(
      `session ${sessionId} already holds an active step assignment` +
        (heldStepId === undefined ? "" : ` (step ${heldStepId})`),
    );
    this.name = "WorkflowExecutorBusyError";
  }
}

/** A write refused before it touched anything: unknown row, missing reason. */
export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowValidationError";
  }
}

/** A payload/result too large for a metadata column. */
export class WorkflowPayloadTooLargeError extends Error {
  constructor(what: string, chars: number) {
    super(
      `workflow ${what} is ${chars} chars, over the ${WORKFLOW_PAYLOAD_MAX_CHARS} limit; ` +
        `store large content in its own domain store and reference it`,
    );
    this.name = "WorkflowPayloadTooLargeError";
  }
}

/* -------------------------------- mapping -------------------------------- */

interface RunDbRow {
  id: number;
  task_id: number;
  project_id: string | null;
  recipe_id: string;
  recipe_version: number;
  worktree_id: string | null;
  branch: string | null;
  lifecycle: WorkflowRunLifecycle;
  lifecycle_reason: string | null;
  cancel_requested_at_ms: number | null;
  max_iterations: number;
  max_review_passes: number;
  config_json: string | null;
  attention_revision: number;
  attention_settled_revision: number;
  attention_kind: WorkflowRunAttentionKind | null;
  attention_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
  ended_at_ms: number | null;
}

interface StepDbRow {
  id: number;
  run_id: number;
  kind: WorkflowStepKind;
  payload_json: string;
  status: WorkflowStepStatus;
  executor_kind: WorkflowExecutorKind | null;
  executor_id: string | null;
  attempt: number;
  predecessor_id: number | null;
  result_status: WorkflowResultStatus | null;
  result_summary: string | null;
  result_contract_id: string | null;
  result_payload_json: string | null;
  result_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
  started_at_ms: number | null;
  ended_at_ms: number | null;
}

interface EventDbRow {
  id: number;
  run_id: number;
  step_id: number | null;
  event_type: WorkflowEventType;
  actor_kind: WorkflowActor["kind"];
  actor_id: string | null;
  detail_json: string | null;
  created_at_ms: number;
}

function toRun(row: RunDbRow): WorkflowRunRow {
  return {
    id: row.id,
    taskId: row.task_id,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    recipeId: row.recipe_id,
    recipeVersion: row.recipe_version,
    ...(row.worktree_id ? { worktreeId: row.worktree_id } : {}),
    ...(row.branch ? { branch: row.branch } : {}),
    lifecycle: row.lifecycle,
    ...(row.lifecycle_reason ? { lifecycleReason: row.lifecycle_reason } : {}),
    ...(row.cancel_requested_at_ms
      ? { cancelRequestedAt: row.cancel_requested_at_ms }
      : {}),
    maxIterations: row.max_iterations,
    maxReviewPasses: row.max_review_passes,
    ...(row.config_json
      ? { config: decodeJson(row.config_json, `run ${row.id} config`) }
      : {}),
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
    ...(row.ended_at_ms ? { endedAt: row.ended_at_ms } : {}),
    ...(row.attention_revision > 0
      ? {
          attention: {
            revision: row.attention_revision,
            settledRevision: row.attention_settled_revision,
            // Both columns are written with every bump, so a revision above 0
            // always carries them; the fallbacks only keep the mapping total.
            kind: row.attention_kind ?? "paused",
            at: row.attention_at_ms ?? row.updated_at_ms,
          },
        }
      : {}),
  };
}

/**
 * Decode a stored JSON column. A row that cannot be parsed is a corrupted
 * write, not a recoverable state, so it fails loudly rather than degrading a
 * step's assignment to `null` and letting a recipe act on the wrong thing.
 */
function decodeJson(json: string, what: string): WorkflowJsonValue {
  try {
    return JSON.parse(json) as WorkflowJsonValue;
  } catch (err) {
    throw new Error(
      `workflow ${what} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function toStep(row: StepDbRow): WorkflowStepRow {
  const executor: WorkflowStepExecutorRef | undefined =
    row.executor_kind && row.executor_id
      ? { kind: row.executor_kind, id: row.executor_id }
      : undefined;
  const result: WorkflowStepResultRow | undefined = row.result_status
    ? {
        status: row.result_status,
        summary: row.result_summary ?? "",
        ...(row.result_contract_id
          ? { contractId: row.result_contract_id }
          : {}),
        ...(row.result_payload_json
          ? {
              payload: decodeJson(
                row.result_payload_json,
                `step ${row.id} result payload`,
              ),
            }
          : {}),
        submittedAt: row.result_at_ms ?? row.updated_at_ms,
      }
    : undefined;
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    payload: decodeJson(row.payload_json, `step ${row.id} payload`),
    status: row.status,
    ...(executor ? { executor } : {}),
    ...(result ? { result } : {}),
    attempt: row.attempt,
    ...(row.predecessor_id !== null
      ? { predecessorId: row.predecessor_id }
      : {}),
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
    ...(row.started_at_ms ? { startedAt: row.started_at_ms } : {}),
    ...(row.ended_at_ms ? { endedAt: row.ended_at_ms } : {}),
  };
}

function toEvent(row: EventDbRow): WorkflowEventRow {
  return {
    id: row.id,
    runId: row.run_id,
    ...(row.step_id !== null ? { stepId: row.step_id } : {}),
    type: row.event_type,
    actor: {
      kind: row.actor_kind,
      ...(row.actor_id ? { id: row.actor_id } : {}),
    },
    ...(row.detail_json
      ? { detail: decodeJson(row.detail_json, `event ${row.id} detail`) }
      : {}),
    createdAt: row.created_at_ms,
  };
}

/* -------------------------------- encoding ------------------------------- */

function encodeJson(
  value: WorkflowJsonValue | undefined,
  what: string,
): string | null {
  if (value === undefined) return null;
  const json = JSON.stringify(value);
  if (json.length > WORKFLOW_PAYLOAD_MAX_CHARS)
    throw new WorkflowPayloadTooLargeError(what, json.length);
  return json;
}

/** Prose is truncated, never rejected: a summary is a label, not evidence. */
function boundedText(value: string | undefined, max: number): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/* --------------------------------- events -------------------------------- */

export interface AppendEventInput {
  runId: number;
  stepId?: number;
  type: WorkflowEventType;
  actor: WorkflowActor;
  detail?: WorkflowJsonValue;
}

/** Insert one transition row. Callers inside a transaction use this directly. */
function insertEvent(input: AppendEventInput, now: number): WorkflowEventRow {
  const id = nextId("workflow_event");
  getDb()
    .prepare(
      `INSERT INTO workflow_events (id, run_id, step_id, event_type, actor_kind, actor_id, detail_json, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.runId,
      input.stepId ?? null,
      input.type,
      input.actor.kind,
      input.actor.id ?? null,
      encodeJson(input.detail, `event ${input.type} detail`),
      now,
    );
  return {
    id,
    runId: input.runId,
    ...(input.stepId !== undefined ? { stepId: input.stepId } : {}),
    type: input.type,
    actor: input.actor,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    createdAt: now,
  };
}

/**
 * Record something that happened to a run without changing run or step state —
 * an observed external conclusion, a reconciliation decision at boot. Every
 * state CHANGE already appends its own event from inside the write, from the
 * row it just read, so only this outside entry point has to check that the
 * event belongs where it says: a run's log may name only that run's own steps,
 * or the log is unreadable. The composite foreign key enforces the same thing;
 * this is the readable error for it.
 */
export function appendEvent(input: AppendEventInput): WorkflowEventRow {
  requireRun(input.runId);
  if (input.stepId !== undefined) {
    const step = getStep(input.stepId);
    if (!step)
      throw new WorkflowValidationError(
        `workflow step ${input.stepId} does not exist, so no event can name it`,
      );
    if (step.runId !== input.runId)
      throw new WorkflowValidationError(
        `workflow step ${input.stepId} belongs to run ${step.runId}, not run ${input.runId}; a run's history names only its own steps`,
      );
  }
  return insertEvent(input, Date.now());
}

export function listEvents(runId: number, limit?: number): WorkflowEventRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM workflow_events WHERE run_id = ? ORDER BY id${limit ? " DESC LIMIT ?" : ""}`,
    )
    .all(...(limit ? [runId, limit] : [runId])) as unknown as EventDbRow[];
  const events = rows.map(toEvent);
  return limit ? events.reverse() : events;
}

/* ---------------------------------- runs --------------------------------- */

export interface CreateRunInput {
  taskId: number;
  projectId?: string;
  recipeId: string;
  recipeVersion: number;
  maxIterations: number;
  maxReviewPasses: number;
  /** Recipe-owned start configuration; written here and never again. */
  config?: WorkflowJsonValue;
  actor: WorkflowActor;
}

/** Start a run in `active`, with its `run-created` event, atomically. */
export function createRun(input: CreateRunInput): WorkflowRunRow {
  return withDbTransaction(() => {
    const now = Date.now();
    const id = nextId("workflow_run");
    getDb()
      .prepare(
        `INSERT INTO workflow_runs (
           id, task_id, project_id, recipe_id, recipe_version, worktree_id, branch,
           lifecycle, lifecycle_reason, max_iterations, max_review_passes, config_json,
           created_at_ms, updated_at_ms, ended_at_ms
         ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'active', NULL, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        input.taskId,
        input.projectId ?? null,
        input.recipeId,
        input.recipeVersion,
        input.maxIterations,
        input.maxReviewPasses,
        encodeJson(input.config, "run config"),
        now,
        now,
      );
    insertEvent(
      {
        runId: id,
        type: "run-created",
        actor: input.actor,
        detail: {
          taskId: input.taskId,
          recipeId: input.recipeId,
          recipeVersion: input.recipeVersion,
        },
      },
      now,
    );
    return getRun(id)!;
  });
}

export function getRun(id: number): WorkflowRunRow | null {
  const row = getDb()
    .prepare("SELECT * FROM workflow_runs WHERE id = ?")
    .get(id) as RunDbRow | undefined;
  return row ? toRun(row) : null;
}

export interface ListRunsFilter {
  taskId?: number;
  /** Restrict to these lifecycles; boot reconciliation asks for the open ones. */
  lifecycles?: readonly WorkflowRunLifecycle[];
}

/** Runs newest first. */
export function listRuns(filter: ListRunsFilter = {}): WorkflowRunRow[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filter.taskId !== undefined) {
    where.push("task_id = ?");
    params.push(filter.taskId);
  }
  if (filter.lifecycles && filter.lifecycles.length > 0) {
    where.push(`lifecycle IN (${filter.lifecycles.map(() => "?").join(", ")})`);
    params.push(...filter.lifecycles);
  }
  const rows = getDb()
    .prepare(
      `SELECT * FROM workflow_runs${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC`,
    )
    .all(...params) as unknown as RunDbRow[];
  return rows.map(toRun);
}

/** The runs boot reconciliation must decide about. */
export function listOpenRuns(): WorkflowRunRow[] {
  return listRuns({ lifecycles: ["active", "paused"] });
}

function requireRun(id: number): WorkflowRunRow {
  const run = getRun(id);
  if (!run)
    throw new WorkflowValidationError(`workflow run ${id} does not exist`);
  return run;
}

/**
 * A run that may still be written to at all. Terminal is terminal: once
 * completed or cancelled, nothing about the run or its steps moves again, so a
 * late result, a stray retry, or a reconciliation that woke up too late cannot
 * change history.
 */
function requireLiveRun(id: number): WorkflowRunRow {
  const run = requireRun(id);
  if (isTerminalWorkflowRunLifecycle(run.lifecycle))
    throw new WorkflowImmutableError(
      `workflow run ${id} is ${run.lifecycle}; a terminal run accepts no further writes`,
    );
  return run;
}

/**
 * A run that may take on NEW work — admitting a step or starting one. Adds the
 * pause gate to {@link requireLiveRun}: pausing means exactly this, that no
 * further work is admitted or started while a running turn is left to finish.
 */
function requireAdmittingRun(id: number): WorkflowRunRow {
  const run = requireLiveRun(id);
  if (run.lifecycle === "paused") throw new WorkflowRunPausedError(id);
  return run;
}

/**
 * Bind the worktree and branch the run OWNS. Write-once: a run's worktree is
 * part of its identity, and rebinding one would silently move every later step
 * — including steps whose results already name commits in the old checkout.
 * Rebinding the identical pair is a no-op, so a retried provision is safe.
 *
 * Allowed while paused (finishing a provision that was already under way is not
 * admitting new work), refused once the run is terminal.
 */
export function attachRunWorktree(
  runId: number,
  worktree: { worktreeId: string; branch: string },
  actor: WorkflowActor,
): WorkflowRunRow {
  const { run, coordinatorSessionIds } = withDbTransaction(() => {
    const run = requireLiveRun(runId);
    if (run.worktreeId || run.branch) {
      if (
        run.worktreeId === worktree.worktreeId &&
        run.branch === worktree.branch
      )
        return { run, coordinatorSessionIds: [] };
      throw new WorkflowImmutableError(
        `workflow run ${runId} already owns worktree ${run.worktreeId} (${run.branch})`,
      );
    }
    const now = Date.now();
    getDb()
      .prepare(
        "UPDATE workflow_runs SET worktree_id = ?, branch = ?, updated_at_ms = ? WHERE id = ?",
      )
      .run(worktree.worktreeId, worktree.branch, now, runId);
    insertEvent(
      {
        runId,
        type: "run-worktree-attached",
        actor,
        detail: { worktreeId: worktree.worktreeId, branch: worktree.branch },
      },
      now,
    );
    const coordinatorSessions = getDb()
      .prepare(
        `
          SELECT workflow_steps.executor_id AS session_id
          FROM workflow_steps
          JOIN session_index ON session_index.id = workflow_steps.executor_id
          WHERE workflow_steps.run_id = ?
            AND workflow_steps.executor_kind = 'session'
            AND session_index.agent_type = 'workflow-coordinator'
        `,
      )
      .all(runId) as Array<{ session_id: string }>;
    return {
      run: getRun(runId)!,
      coordinatorSessionIds: coordinatorSessions.map(
        ({ session_id }) => session_id,
      ),
    };
  });
  for (const sessionId of coordinatorSessionIds)
    linkSessionToWorktree(sessionId, worktree.worktreeId);
  if (coordinatorSessionIds.length > 0) broadcastWorktreeEdgeChange();
  return run;
}

const LIFECYCLE_EVENT: Record<WorkflowRunLifecycle, WorkflowEventType> = {
  active: "run-resumed",
  paused: "run-paused",
  completed: "run-completed",
  cancelled: "run-cancelled",
};

/**
 * Move a run's lifecycle. Terminal is terminal: a completed or cancelled run
 * never moves again, so a late observation cannot resurrect it.
 *
 * A pause MUST carry a reason. The card states why a run is paused every time,
 * and a pause the user cannot interpret is worse than none — so a blank reason
 * is refused here rather than rendered as an empty label later.
 *
 * Reaching a terminal state stamps `endedAt` and, in the SAME transaction,
 * cancels the run's still-open steps: those steps can never be started,
 * attempted, or completed again, and leaving them `pending`/`running` forever
 * would misreport a finished run as busy and hold their sessions' active
 * assignment.
 */
/**
 * Raise a run's ceilings, which only the USER may do. They are the run's bound
 * on AUTOMATIC work, not a verdict on the work, so an exhausted one asks rather
 * than ends the run — and the raise is an append-only event with the user as
 * its actor, so the history explains why more was allowed. Lowering is refused:
 * a ceiling below what the run already spent would describe a past that did not
 * happen, and stopping sooner is what cancel is for.
 *
 * This standalone entry point is NOT how the ceiling gate raises: answering a
 * gate raises and settles in one transaction through `completeStep`, so no
 * caller in the server reaches this. It stays because a raise that is not a
 * gate answer still has to be expressible — today only tests need it, and one
 * of them needs it to reconstruct the half-written state (ceiling moved, gate
 * still open) that the atomic settlement exists to prevent.
 */
export function raiseRunCeilings(
  runId: number,
  ceilings: { maxIterations?: number; maxReviewPasses?: number },
  actor: WorkflowActor,
): WorkflowRunRow {
  return withDbTransaction(() => applyCeilingRaise(runId, ceilings, actor));
}

/**
 * The raise itself, INSIDE whatever transaction its caller opened. Settling a
 * ceiling gate raises and records the answer together: two transactions could
 * leave a run whose ceiling moved but whose gate never closed, and the card
 * would then offer a raise the run has already taken — a stranded gate whose
 * only remaining exits are the ones the user did not choose.
 */
function applyCeilingRaise(
  runId: number,
  ceilings: { maxIterations?: number; maxReviewPasses?: number },
  actor: WorkflowActor,
  adjustment?: WorkflowJsonValue,
): WorkflowRunRow {
  {
    const run = requireLiveRun(runId);
    const next = {
      maxIterations: Math.max(
        run.maxIterations,
        ceilings.maxIterations ?? run.maxIterations,
      ),
      maxReviewPasses: Math.max(
        run.maxReviewPasses,
        ceilings.maxReviewPasses ?? run.maxReviewPasses,
      ),
    };
    if (
      next.maxIterations === run.maxIterations &&
      next.maxReviewPasses === run.maxReviewPasses
    )
      return run;
    const now = Date.now();
    getDb()
      .prepare(
        "UPDATE workflow_runs SET max_iterations = ?, max_review_passes = ?, updated_at_ms = ? WHERE id = ?",
      )
      .run(next.maxIterations, next.maxReviewPasses, now, runId);
    insertEvent(
      {
        runId,
        type: "run-ceilings-raised",
        actor,
        detail: {
          from: {
            maxIterations: run.maxIterations,
            maxReviewPasses: run.maxReviewPasses,
          },
          to: next,
          by: {
            maxIterations: next.maxIterations - run.maxIterations,
            maxReviewPasses: next.maxReviewPasses - run.maxReviewPasses,
          },
          ...(adjustment !== undefined ? { adjustment } : {}),
        },
      },
      now,
    );
    return requireRun(runId);
  }
}

/**
 * Record that the user asked for this run to end. Durable on purpose: the
 * settlement may wait behind a host operation holding the run's chain, and a
 * process exit in that window must not turn a cancellation into an ordinary
 * paused run offering Resume.
 */
export function requestRunCancellation(
  runId: number,
  actor: WorkflowActor,
): WorkflowRunRow {
  return withDbTransaction(() => {
    const run = requireLiveRun(runId);
    if (run.cancelRequestedAt !== undefined) return run;
    const now = Date.now();
    getDb()
      .prepare(
        "UPDATE workflow_runs SET cancel_requested_at_ms = ?, updated_at_ms = ? WHERE id = ?",
      )
      .run(now, now, runId);
    insertEvent(
      { runId, type: "run-cancel-requested", actor, detail: {} },
      now,
    );
    return requireRun(runId);
  });
}

export function setRunLifecycle(
  runId: number,
  lifecycle: WorkflowRunLifecycle,
  options: { reason?: string; actor: WorkflowActor },
): WorkflowRunRow {
  return withDbTransaction(() => {
    const run = requireLiveRun(runId);
    if (lifecycle === "completed") {
      // A session whose turn was abandoned at boot is exempt. Its obligation is
      // already recorded on the step that abandoned it, and NOTHING in this run
      // can clear it: an unadmitted delegated result has no parent turn left to
      // admit it, and a managed worktree waits on an integrate/discard the user
      // makes out of band. Enforcing it here would refuse the terminal
      // transition after the merge was already observed, and every Resume would
      // re-derive the same refusal — the run finished, and could never say so.
      const abandoned = abandonedTurnSessions(runId);
      const executorIds = new Set(
        listSteps(runId)
          .filter((step) => step.executor?.kind === "session")
          .map((step) => step.executor!.id),
      );
      for (const sessionId of executorIds)
        if (!abandoned.has(sessionId))
          assertDelegationObligationsCleared(
            sessionId,
            // The run is finished; what is left is the user's to settle on the
            // session, so the pause says so rather than only naming the block.
            "finish or discard that delegated work on the session, then Resume",
          );
    }
    const reason = boundedText(options.reason, WORKFLOW_REASON_MAX_CHARS);
    if (lifecycle === "paused" && !reason)
      throw new WorkflowValidationError(
        `pausing workflow run ${runId} requires a reason; every pause states why`,
      );
    const now = Date.now();
    const terminal = isTerminalWorkflowRunLifecycle(lifecycle);
    // A pending cancellation is cleared by — and only by — the transition that
    // ENDS the run, in this one transaction. The marker means "the user asked
    // and settlement has not finished", so leaving it on a terminal row would
    // have the card announce cancelling forever, while clearing it any earlier
    // would reopen the window where a crash loses the request. The
    // `run-cancel-requested` event keeps the history either way.
    // The attention bump (Task-677). A pause, a completion and a cancellation
    // are the meaningful events — a resume is not, and neither is re-pausing a
    // paused run for the same reason (a boot re-deriving the pause it already
    // holds). Unconditional on the current acknowledgement: a run nobody
    // settled still records its event, so the next Settle has an exact revision
    // to acknowledge instead of a moving target.
    const wakes =
      lifecycle !== "active" &&
      (run.lifecycle !== lifecycle ||
        (run.lifecycleReason ?? "") !== (reason ?? ""));
    getDb()
      .prepare(
        `UPDATE workflow_runs
         SET lifecycle = ?, lifecycle_reason = ?, ended_at_ms = ?, updated_at_ms = ?,
             cancel_requested_at_ms = CASE WHEN ? THEN NULL ELSE cancel_requested_at_ms END,
             attention_revision = attention_revision + ?,
             attention_kind = CASE WHEN ? THEN ? ELSE attention_kind END,
             attention_at_ms = CASE WHEN ? THEN ? ELSE attention_at_ms END
         WHERE id = ?`,
      )
      .run(
        lifecycle,
        reason,
        terminal ? now : null,
        now,
        terminal ? 1 : 0,
        wakes ? 1 : 0,
        wakes ? 1 : 0,
        lifecycle === "active" ? null : lifecycle,
        wakes ? 1 : 0,
        now,
        runId,
      );
    insertEvent(
      {
        runId,
        type: LIFECYCLE_EVENT[lifecycle],
        actor: options.actor,
        detail: {
          from: run.lifecycle,
          to: lifecycle,
          ...(reason ? { reason } : {}),
        },
      },
      now,
    );
    if (terminal) {
      for (const open of listOpenSteps(runId)) {
        getDb()
          .prepare(
            "UPDATE workflow_steps SET status = 'cancelled', ended_at_ms = ?, updated_at_ms = ? WHERE id = ?",
          )
          .run(now, now, open.id);
        insertEvent(
          {
            runId,
            stepId: open.id,
            type: "step-completed",
            actor: options.actor,
            detail: { status: "cancelled", reason: `run ${lifecycle}` },
          },
          now,
        );
      }
    }
    return getRun(runId)!;
  });
}

/**
 * Acknowledge the run's attention through `throughRevision` (Task-677). The
 * one write a TERMINAL run still accepts, deliberately: the cursor is the
 * user's reading position over the run's history, not a transition of it, so
 * it appends no event and moves no lifecycle column.
 *
 * Same contract as `sessionStore.setSettled`: the observed revision is clamped
 * to the stored one (acknowledging the future is meaningless), a lower value
 * leaves the newer event unacknowledged so the run stays awake even though
 * the call succeeded, and the acknowledged revision only ever moves FORWARD —
 * two devices settle the same run out of order all the time, and letting the
 * older click win would resurrect an outcome the user already acknowledged.
 *
 * Returns the row as it stands afterwards, or `null` for an unknown run.
 */
export function settleRun(
  runId: number,
  throughRevision: number,
): WorkflowRunRow | null {
  const observed = Math.max(0, Math.trunc(throughRevision));
  if (!Number.isFinite(observed)) return getRun(runId);
  getDb()
    .prepare(
      `UPDATE workflow_runs
          SET attention_settled_revision = MAX(
                attention_settled_revision,
                MIN(attention_revision, ?)
              )
        WHERE id = ?`,
    )
    .run(observed, runId);
  return getRun(runId);
}

/* --------------------------------- steps --------------------------------- */

export interface AppendStepInput {
  runId: number;
  kind: WorkflowStepKind;
  payload: WorkflowJsonValue;
  /** The step this one causally follows (a successor after a revision/retry). */
  predecessorId?: number;
  actor: WorkflowActor;
}

/**
 * Append a `pending` step. Admission requires an ACTIVE run: a terminal run
 * would never execute the step, and a paused one is paused precisely so that
 * nothing new is admitted. A predecessor must be a step of the same run — the
 * database enforces that too (composite foreign key), and this is the readable
 * error for it.
 */
export function appendStep(input: AppendStepInput): WorkflowStepRow {
  return withDbTransaction(() => {
    requireAdmittingRun(input.runId);
    if (input.predecessorId !== undefined) {
      const predecessor = getStep(input.predecessorId);
      if (!predecessor)
        throw new WorkflowValidationError(
          `workflow step ${input.predecessorId} does not exist, so it cannot be a predecessor`,
        );
      if (predecessor.runId !== input.runId)
        throw new WorkflowValidationError(
          `workflow step ${input.predecessorId} belongs to run ${predecessor.runId}, not run ${input.runId}; a causal chain never crosses runs`,
        );
    }
    const now = Date.now();
    const id = nextId("workflow_step");
    getDb()
      .prepare(
        `INSERT INTO workflow_steps (
           id, run_id, kind, payload_json, status, executor_kind, executor_id, attempt,
           predecessor_id, result_status, result_summary, result_contract_id,
           result_payload_json, result_at_ms, created_at_ms, updated_at_ms,
           started_at_ms, ended_at_ms
         ) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, 0, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL)`,
      )
      .run(
        id,
        input.runId,
        input.kind,
        encodeJson(input.payload, `step ${input.kind} payload`),
        input.predecessorId ?? null,
        now,
        now,
      );
    insertEvent(
      {
        runId: input.runId,
        stepId: id,
        type: "step-created",
        actor: input.actor,
        detail: {
          kind: input.kind,
          ...(input.predecessorId !== undefined
            ? { predecessorId: input.predecessorId }
            : {}),
        },
      },
      now,
    );
    return getStep(id)!;
  });
}

export function getStep(id: number): WorkflowStepRow | null {
  const row = getDb()
    .prepare("SELECT * FROM workflow_steps WHERE id = ?")
    .get(id) as StepDbRow | undefined;
  return row ? toStep(row) : null;
}

/** A run's steps in append order — which, ids being monotonic, is `id`. */
export function listSteps(runId: number): WorkflowStepRow[] {
  const rows = getDb()
    .prepare("SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY id")
    .all(runId) as unknown as StepDbRow[];
  return rows.map(toStep);
}

/**
 * The run's steps that have not reached a terminal status. The recipe keeps
 * this at one at a time (each run serializes work in its own worktree), so a
 * second row here is a bug the caller should refuse to widen, not average over.
 */
export function listOpenSteps(runId: number): WorkflowStepRow[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM workflow_steps WHERE run_id = ? AND status IN ('pending','running') ORDER BY id",
    )
    .all(runId) as unknown as StepDbRow[];
  return rows.map(toStep);
}

/**
 * The open step an executor currently holds, if any — the read behind "a
 * session executes at most one active step assignment at a time".
 */
export function openStepForExecutor(
  kind: WorkflowExecutorKind,
  id: string,
): WorkflowStepRow | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM workflow_steps
       WHERE executor_kind = ? AND executor_id = ? AND status IN ('pending','running')
       ORDER BY id LIMIT 1`,
    )
    .get(kind, id) as StepDbRow | undefined;
  return row ? toStep(row) : null;
}

/**
 * Durable workflow run/step ownership edges for one executor session. The
 * engine remains lifecycle authority; a subagent records this session as its
 * immediate parent rather than pointing at the engine itself.
 */
export function workflowOwnershipForExecutor(
  sessionId: string,
): WorkflowExecutorOwnership[] {
  const rows = getDb()
    .prepare(
      `SELECT s.run_id, s.id AS step_id, s.executor_id, s.status, r.lifecycle
       FROM workflow_steps s
       JOIN workflow_runs r ON r.id = s.run_id
       WHERE s.executor_kind = 'session' AND s.executor_id = ?
       ORDER BY s.id DESC`,
    )
    .all(sessionId) as Array<{
    run_id: number;
    step_id: number;
    executor_id: string;
    status: WorkflowStepStatus;
    lifecycle: WorkflowRunLifecycle;
  }>;
  return rows.map((row) => ({
    runId: row.run_id,
    stepId: row.step_id,
    sessionId: row.executor_id,
    stepStatus: row.status,
    runLifecycle: row.lifecycle,
  }));
}

/** Newest step ever assigned to an executor, including terminal history. */
export function latestStepForExecutor(
  kind: WorkflowExecutorKind,
  id: string,
): WorkflowStepRow | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM workflow_steps
       WHERE executor_kind = ? AND executor_id = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(kind, id) as StepDbRow | undefined;
  return row ? toStep(row) : null;
}

/**
 * Sessions this run recorded an abandoned delegation obligation for — read from
 * the events {@link completeStep} wrote, which is where that fact is durable.
 */
function abandonedTurnSessions(runId: number): Set<string> {
  const rows = getDb()
    .prepare(
      `SELECT detail_json FROM workflow_events
       WHERE run_id = ? AND event_type = 'observation-recorded'
         AND detail_json LIKE '%abandonedDelegationObligation%'`,
    )
    .all(runId) as Array<{ detail_json: string | null }>;
  const sessions = new Set<string>();
  for (const row of rows) {
    if (!row.detail_json) continue;
    try {
      const detail = JSON.parse(row.detail_json) as Record<string, unknown>;
      if (
        typeof detail.abandonedDelegationObligation === "string" &&
        typeof detail.sessionId === "string" &&
        detail.sessionId
      )
        sessions.add(detail.sessionId);
    } catch {
      // A detail this process cannot read is not evidence of an exemption.
    }
  }
  return sessions;
}

function assertDelegationObligationsCleared(
  sessionId: string,
  remedy?: string,
): void {
  const reason = delegationObligationReason(
    subagentStore.delegationObligations(sessionId),
  );
  if (reason)
    throw new WorkflowValidationError(
      `workflow executor session ${sessionId} cannot complete because ${reason}${remedy ? ` To finish the run, ${remedy}.` : ""}`,
    );
}

function requireOpenStep(id: number): WorkflowStepRow {
  const step = getStep(id);
  if (!step)
    throw new WorkflowValidationError(`workflow step ${id} does not exist`);
  if (isTerminalWorkflowStepStatus(step.status))
    throw new WorkflowImmutableError(
      `workflow step ${id} is ${step.status}; a terminal step is immutable — append a successor instead`,
    );
  return step;
}

/**
 * A step that is actually executing. The lifecycle is `pending → running →
 * terminal` with no shortcuts, so nothing can persist an attempted or finished
 * step that never had an executor or a start time. Abandoning work that never
 * started is a RUN-level decision — ending a run cancels its pending steps —
 * not a step that completes without ever running.
 */
function requireRunningStep(id: number): WorkflowStepRow {
  const step = requireOpenStep(id);
  if (step.status !== "running")
    throw new WorkflowValidationError(
      `workflow step ${id} is ${step.status}; start it before recording an attempt or a result`,
    );
  return step;
}

/** SQLite's message for the partial unique index on active session executors. */
function isActiveSessionConflict(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.includes("workflow_steps.executor_id") &&
    err.message.includes("UNIQUE")
  );
}

/**
 * Hand a pending step to its executor: `running`, attempt 1, executor bound.
 * The executor is bound here and never rebound — a step's result must be
 * attributable to the session or operation that produced it.
 *
 * Starting is new work, so it needs an active run (see
 * {@link requireAdmittingRun}). A session may hold only ONE active assignment
 * at a time: the check below reports the step it already holds, and the
 * database's partial unique index is what makes that atomic when two admissions
 * race for the same session across runs.
 */
export function startStep(
  stepId: number,
  executor: WorkflowStepExecutorRef,
  actor: WorkflowActor,
): WorkflowStepRow {
  return withDbTransaction(() => {
    const step = requireOpenStep(stepId);
    if (step.status !== "pending")
      throw new WorkflowImmutableError(
        `workflow step ${stepId} is already ${step.status}`,
      );
    requireAdmittingRun(step.runId);
    if (executor.kind === "session") {
      const held = openStepForExecutor("session", executor.id);
      if (held) throw new WorkflowExecutorBusyError(executor.id, held.id);
    }
    const now = Date.now();
    try {
      getDb()
        .prepare(
          `UPDATE workflow_steps
         SET status = 'running', executor_kind = ?, executor_id = ?, attempt = 1,
             started_at_ms = ?, updated_at_ms = ?
         WHERE id = ? AND status = 'pending'`,
        )
        .run(executor.kind, executor.id, now, now, stepId);
    } catch (err) {
      if (executor.kind === "session" && isActiveSessionConflict(err))
        throw new WorkflowExecutorBusyError(executor.id);
      throw err;
    }
    insertEvent(
      {
        runId: step.runId,
        stepId,
        type: "step-started",
        actor,
        detail: { executorKind: executor.kind, executorId: executor.id },
      },
      now,
    );
    return getStep(stepId)!;
  });
}

/**
 * Count one more operational attempt at a step that is still open (a host
 * operation retried after a transient failure). A SEMANTIC retry — new work,
 * new evidence — is a new step, not a higher number here.
 *
 * The step must be RUNNING: an attempt is a re-try of work in flight, so a
 * pending step has nothing to attempt again. Allowed while the run is paused —
 * this is a turn already under way, and a pause does not abort one — and
 * impossible once the run is terminal, which cancels every open step as it
 * ends.
 */
export function recordStepAttempt(
  stepId: number,
  actor: WorkflowActor,
): WorkflowStepRow {
  return withDbTransaction(() => {
    const step = requireRunningStep(stepId);
    requireLiveRun(step.runId);
    const now = Date.now();
    const attempt = step.attempt + 1;
    getDb()
      .prepare(
        "UPDATE workflow_steps SET attempt = ?, updated_at_ms = ? WHERE id = ?",
      )
      .run(attempt, now, stepId);
    insertEvent(
      {
        runId: step.runId,
        stepId,
        type: "step-attempted",
        actor,
        detail: { attempt },
      },
      now,
    );
    return getStep(stepId)!;
  });
}

export interface CompleteStepInput {
  /**
   * Ceilings to raise as PART of this completion. The run's new bound and the
   * record explaining the adjustment land in the same transaction as the step
   * settlement, so no crash can leave either half behind.
   */
  raiseCeilings?: {
    ceilings: { maxIterations?: number; maxReviewPasses?: number };
    adjustment?: WorkflowJsonValue;
  };
  /**
   * The terminal status this step reached. When a result is supplied, this must
   * be the result's own status — the step's status IS the outcome the executor
   * reported, not a second opinion about it.
   */
  status: Extract<
    WorkflowStepStatus,
    "completed" | "blocked" | "failed" | "cancelled"
  >;
  /**
   * The structured result, when the executor produced one. Written with the
   * terminal status in one transaction, and never written again.
   */
  result?: {
    status: WorkflowResultStatus;
    summary: string;
    contractId?: string;
    payload?: WorkflowJsonValue;
  };
  /** External state consumed by this completion, logged in the same transaction. */
  observationDetail?: WorkflowJsonValue;
  /**
   * The executor's turn is GONE and can never submit anything, in one of the
   * two ways that happens: boot reconciliation found it dead (the step then
   * ends `failed`), or the user cancelled the run and its turn was aborted
   * (the step then ends `cancelled`). Nothing else may set this.
   *
   * The delegation invariant is then RECORDED rather than enforced. What that
   * invariant protects against is a session claiming its step SUCCEEDED while
   * children it owns are still working; a dead turn can never clear an
   * obligation, so enforcing it here would leave the step running forever with
   * no turn behind it — neither Resume nor Retry applies to a tail that never
   * became terminal, and the run is stranded for good. The same is true of a
   * cancellation: the user asked the run to stop, its turn was aborted, and
   * refusing to settle it because a child it owns is unfinished leaves the run
   * stuck CANCELLING until a restart — the boot path then bypasses the very
   * check the live path could not. There is no invariant that a user-cancelled
   * step must satisfy and a boot-abandoned one may skip.
   *
   * So this is accepted for `failed` and `cancelled` and NOTHING else: a turn
   * nobody can submit for never ends in success, and the obligation it still
   * held is written to the step's event log rather than silently dropped.
   * `completed` and `blocked` stay refused — an exception for turns that are
   * gone must not become a way to report an outcome for one that is not.
   */
  abandonedTurn?: boolean;
  actor: WorkflowActor;
}

/**
 * Finish a step: terminal status and (optionally) its immutable result, in one
 * transaction. A cancelled step may end without a result; anything else that
 * ends without one ended without evidence, which the recipe must treat as a
 * failure rather than progress.
 *
 * Allowed while the run is paused — that is the whole point of pausing rather
 * than cancelling: the turn already running finishes and its result is kept.
 *
 * The step must be RUNNING (see {@link requireRunningStep}), and a supplied
 * result must carry the same status the step ends with: a `completed` step
 * holding a `failed` result would be a history that contradicts itself, and a
 * later reader has no way to tell which half is true.
 */
export function completeStep(
  stepId: number,
  input: CompleteStepInput,
): WorkflowStepRow {
  return withDbTransaction(() => {
    const step = requireRunningStep(stepId);
    requireLiveRun(step.runId);
    if (
      input.abandonedTurn &&
      input.status !== "failed" &&
      input.status !== "cancelled"
    )
      throw new WorkflowValidationError(
        `workflow step ${stepId} cannot end as ${input.status} as an abandoned turn; a turn nobody can submit for ends in failure or cancellation`,
      );
    let abandonedObligation: string | undefined;
    if (step.executor?.kind === "session") {
      if (input.abandonedTurn)
        abandonedObligation = delegationObligationReason(
          subagentStore.delegationObligations(step.executor.id),
        );
      else assertDelegationObligationsCleared(step.executor.id);
    }
    if (input.raiseCeilings)
      applyCeilingRaise(
        step.runId,
        input.raiseCeilings.ceilings,
        input.actor,
        input.raiseCeilings.adjustment,
      );
    const result = input.result;
    if (result && result.status !== input.status)
      throw new WorkflowValidationError(
        `workflow step ${stepId} cannot end as ${input.status} carrying a ${result.status} result; the step's status is the outcome the executor reported`,
      );
    const now = Date.now();
    getDb()
      .prepare(
        `UPDATE workflow_steps
         SET status = ?, result_status = ?, result_summary = ?, result_contract_id = ?,
             result_payload_json = ?, result_at_ms = ?, ended_at_ms = ?, updated_at_ms = ?
         WHERE id = ?`,
      )
      .run(
        input.status,
        result?.status ?? null,
        result ? boundedText(result.summary, WORKFLOW_SUMMARY_MAX_CHARS) : null,
        result?.contractId ?? null,
        result
          ? encodeJson(result.payload, `step ${stepId} result payload`)
          : null,
        result ? now : null,
        now,
        now,
        stepId,
      );
    if (input.observationDetail !== undefined)
      insertEvent(
        {
          runId: step.runId,
          stepId,
          type: "observation-recorded",
          actor: input.actor,
          detail: input.observationDetail,
        },
        now,
      );
    // The obligation outlives the step, so it is written down where a reader
    // looking at why this step failed will find it: the delegated work is still
    // there to settle, this step simply stopped waiting for it.
    if (abandonedObligation)
      insertEvent(
        {
          runId: step.runId,
          stepId,
          type: "observation-recorded",
          actor: input.actor,
          detail: {
            abandonedDelegationObligation: abandonedObligation,
            sessionId:
              step.executor?.kind === "session" ? step.executor.id : "",
          },
        },
        now,
      );
    if (result)
      insertEvent(
        {
          runId: step.runId,
          stepId,
          type: "result-submitted",
          actor: input.actor,
          detail: {
            status: result.status,
            ...(result.contractId ? { contractId: result.contractId } : {}),
          },
        },
        now,
      );
    insertEvent(
      {
        runId: step.runId,
        stepId,
        type: "step-completed",
        actor: input.actor,
        detail: { status: input.status },
      },
      now,
    );
    return getStep(stepId)!;
  });
}

/**
 * Permanently discard one cancelled attempt and its cascading step/event
 * history. Active, paused, and completed runs remain immutable and retained;
 * cleanup is deliberately narrower than a generic delete primitive.
 */
export function deleteCancelledRun(id: number): void {
  withDbTransaction(() => {
    const run = requireRun(id);
    if (run.lifecycle !== "cancelled")
      throw new WorkflowValidationError(
        `workflow run ${id} is ${run.lifecycle}; only a cancelled run can be deleted`,
      );
    const result = getDb()
      .prepare(
        "DELETE FROM workflow_runs WHERE id = ? AND lifecycle = 'cancelled'",
      )
      .run(id);
    if (result.changes !== 1)
      throw new WorkflowValidationError(
        `workflow run ${id} could not be deleted`,
      );
  });
}

/** Test-only teardown for every retained workflow row. */
export function resetWorkflowStoreForTests(): void {
  const db = getDb();
  db.prepare("DELETE FROM workflow_events").run();
  db.prepare("DELETE FROM workflow_steps").run();
  db.prepare("DELETE FROM workflow_runs").run();
}
