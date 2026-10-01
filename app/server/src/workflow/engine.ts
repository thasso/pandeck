/**
 * The Workflow Run engine (`docs/agent-workflows.md`, [Task-365](pa://task/365)).
 *
 * The engine is the only thing that turns a recipe's decision into persisted
 * state. It owns three responsibilities and nothing else:
 *
 * 1. **The advance loop** — load the run and its steps, ask the recipe what is
 *    next, and act: admit a step, dispatch an open one, pause, or complete.
 * 2. **The lifecycle API** — pause, resume, cancel, with the actor that caused
 *    each transition, because the store refuses a transition without one.
 * 3. **Boot reconciliation** — decide what a restart may resume and what it
 *    must pause as indeterminate.
 *
 * It writes NO SQL: every mutation goes through `db/workflowStore.ts`, which
 * enforces the append-only invariants (see that module). It knows nothing about
 * sessions or git either — that is the executor seam (`executors.ts`) — and it
 * reaches the browser only through `workflowRuns.ts`, never through the hub. The
 * one exception is a COMPLETED run telling `sessionActivity.ts` that the
 * sessions it never gave a checkout to are done; the engine states the fact and
 * owns none of the decision.
 *
 * **Admission is the reservation.** A step row is appended BEFORE any side
 * effect runs, and the recipe derives every idempotency key from persisted
 * history, so a crash between append and dispatch is recovered by re-running
 * the pure decision: it finds the open step and dispatches it again instead of
 * appending a twin.
 *
 * **Advances are serialized per run** (`withRunLock`), so two near-simultaneous
 * completions cannot both drive the loop. Pause and cancel deliberately do NOT
 * take that lock: they are user actions that must land immediately, even while
 * a host operation is in flight. The store's pause gate is what makes that
 * safe — an advance that tries to admit or start work on a run paused underneath
 * it raises `WorkflowRunPausedError`, which the loop treats as "hold".
 *
 * **A refused decision pauses the run.** Every other failure of the advance —
 * the store refusing the step the recipe just decided above all — becomes the
 * run's pause reason, because most advances are kicked off fire-and-forget and
 * a rejection thrown there leaves an "active" run that will never move again.
 */
import {
  isTerminalWorkflowRunLifecycle,
  raiseWorkflowRunLimits,
  type WorkflowActor,
  type WorkflowCeilingRaise,
  type WorkflowJsonValue,
} from "@assistant/shared";
import { sessionStore } from "../db/sessionStore.ts";
import {
  appendEvent,
  appendStep,
  completeStep,
  getRun,
  getStep,
  listOpenRuns,
  listOpenSteps,
  requestRunCancellation,
  WorkflowValidationError,
  listSteps,
  recordStepAttempt,
  setRunLifecycle,
  startStep,
  WorkflowImmutableError,
  WorkflowRunPausedError,
  type CompleteStepInput,
  type WorkflowRunRow,
  type WorkflowStepRow,
} from "../db/workflowStore.ts";
import { errorText } from "../errors.ts";
import { sessionRuntime } from "../session/runtimeInstance.ts";
import { broadcastWorkflowRuns } from "../workflowRuns.ts";
import {
  codeDeliveryRecipe,
  BASE_SYNC_OPERATION_ID,
  baseSyncIdempotencyKey,
  baseSyncResumePayloadOf,
  COMMIT_SYNC_OPERATION_ID,
  commitSyncIdempotencyKey,
  ceilingDecisionPayloadOf,
  isRecheckablePullRequestObservation,
  mergeDecisionPayloadOf,
  operationIdempotencyKey,
  operationTriagePayloadOf,
  repairRebasePayloadOf,
  type WorkflowRecipe,
} from "./codeDeliveryRecipe.ts";
import {
  PULL_REQUEST_OBSERVATION_RESULT_CONTRACT_ID,
  readStepResult,
} from "./resultContracts.ts";
import { finalizeOperationTriage } from "./operationTriage.ts";
import { finalizeRebaseRepair } from "./rebaseRepair.ts";
import {
  getWorkflowAgentExecutor,
  getWorkflowHostOperation,
  getWorkflowWaitExecutor,
  hostOperationIdOf,
  type WorkflowHostOperation,
  type WorkflowStepContext,
} from "./executors.ts";

/** Engine decisions are the system's own; a user action passes its actor in. */
const SYSTEM_ACTOR: WorkflowActor = { kind: "system" };

type WorkflowSessionAbort = (sessionId: string) => void | Promise<void>;

async function abortRuntimeWorkflowSession(sessionId: string): Promise<void> {
  await sessionRuntime.abort(sessionId);
  // An abort signal is not the same thing as a settled tool process. Do not
  // restore Git underneath a shell command that can still write it.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!sessionRuntime.isRunning(sessionId)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `repair session ${sessionId} did not stop after cancellation; the run was not cancelled`,
  );
}

let abortWorkflowSession: WorkflowSessionAbort = abortRuntimeWorkflowSession;

export function setWorkflowSessionAbortForTests(
  abort: WorkflowSessionAbort | null,
): void {
  abortWorkflowSession = abort ?? abortRuntimeWorkflowSession;
}

/* ------------------------------ recipe registry ---------------------------- */

/**
 * Recipes by `(id, version)`. The version is part of the key on purpose: a run
 * recorded against a version whose behavior has since changed pauses as an
 * unknown recipe rather than being driven by a decision function it never
 * agreed to.
 */
const recipes = new Map<string, WorkflowRecipe>();

function recipeKey(id: string, version: number): string {
  return `${id}@${version}`;
}

export function registerWorkflowRecipe(recipe: WorkflowRecipe): void {
  recipes.set(recipeKey(recipe.id, recipe.version), recipe);
}

export function getWorkflowRecipe(
  id: string,
  version: number,
): WorkflowRecipe | undefined {
  return recipes.get(recipeKey(id, version));
}

registerWorkflowRecipe(codeDeliveryRecipe);

/* ------------------------------ serialization ------------------------------ */

const advanceChains = new Map<number, Promise<void>>();

/**
 * Queue work behind whatever else is advancing this run.
 *
 * The chaining `tail` absorbs rejections so one failed advance cannot reject
 * the next caller's turn, and it stays SILENT on purpose: it would otherwise
 * log every rejection a caller handles itself. Nothing is lost by that — the
 * returned promise still rejects, `runAdvanceLoop` already pauses the run on
 * anything it cannot act on, and the fire-and-forget call sites log.
 */
function withRunLock<T>(runId: number, work: () => Promise<T>): Promise<T> {
  const previous = advanceChains.get(runId) ?? Promise.resolve();
  const result = previous.then(work, work);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  advanceChains.set(runId, tail);
  void tail.then(() => {
    if (advanceChains.get(runId) === tail) advanceChains.delete(runId);
  });
  return result;
}

/**
 * A synchronous advance settles the whole pipeline, so the bound only has to
 * exceed the longest legitimate chain (three steps per review iteration). Being
 * hit at all means a decision and the state it produced disagree, which is a
 * bug — so it pauses loudly instead of spinning.
 */
const MAX_ADVANCE_ITERATIONS = 100;

/* --------------------------------- advance --------------------------------- */

/**
 * Drive the run as far as it goes right now. Idempotent: with no work to admit
 * and nothing dispatchable it changes nothing, so a duplicate call after a
 * completion is harmless.
 */
export function advanceRun(
  runId: number,
  actor: WorkflowActor = SYSTEM_ACTOR,
): Promise<void> {
  return withRunLock(runId, () => runAdvanceLoop(runId, actor));
}

async function runAdvanceLoop(
  runId: number,
  actor: WorkflowActor,
): Promise<void> {
  let mutated = false;
  try {
    // A step dispatched in THIS pass whose executor works asynchronously is
    // still `pending` when the loop comes back around. Dispatching it twice
    // would hand the same assignment out twice, so one dispatch per pass.
    const dispatched = new Set<number>();
    for (
      let iteration = 0;
      iteration < MAX_ADVANCE_ITERATIONS;
      iteration += 1
    ) {
      const run = getRun(runId);
      if (!run) return;
      // Terminal runs are over, and a paused run holds until it is resumed.
      if (isTerminalWorkflowRunLifecycle(run.lifecycle)) return;
      if (run.lifecycle === "paused") return;

      const recipe = getWorkflowRecipe(run.recipeId, run.recipeVersion);
      if (!recipe) {
        mutated = true;
        pauseInternal(
          runId,
          `unknown recipe ${recipeKey(run.recipeId, run.recipeVersion)}`,
          actor,
        );
        return;
      }

      const steps = listSteps(runId);
      const decision = recipe.decide(run, steps);
      switch (decision.kind) {
        case "pause": {
          mutated = true;
          pauseInternal(runId, decision.reason, actor);
          return;
        }
        case "complete": {
          mutated = true;
          setRunLifecycle(runId, "completed", { actor });
          // The run is over, so any sessions it created without a checkout of
          // their own have nothing left to do. Code-delivery roles leave with
          // the checkout instead. WHICH sessions leave the inbox stays
          // `sessionActivity.ts`'s, and
          // it is imported here rather than at module scope so the engine keeps
          // its session-free dependency surface. The completion above is
          // already durable and must not be undone by a failure to shelve.
          await import("../sessionActivity.ts")
            .then((m) => m.settleCompletedWorkflowRunSessions(runId))
            .catch((err) =>
              console.warn(
                `[workflow] settling run ${runId}'s sessions failed:`,
                errorText(err),
              ),
            );
          return;
        }
        case "append": {
          mutated = true;
          appendStep({
            runId,
            kind: decision.step.kind,
            payload: decision.step.payload,
            ...(decision.step.predecessorId !== undefined
              ? { predecessorId: decision.step.predecessorId }
              : {}),
            actor,
          });
          continue;
        }
        case "executing": {
          const step = steps.find((it) => it.id === decision.stepId);
          // Already handed to its executor: the step ends when the executor
          // says so, and that call advances the run again.
          if (!step || step.status !== "pending") return;
          if (dispatched.has(step.id)) return;
          dispatched.add(step.id);
          mutated = true;
          await dispatchStep(run, step, actor);
          continue;
        }
      }
    }
    mutated = true;
    pauseInternal(
      runId,
      `workflow advance did not settle after ${MAX_ADVANCE_ITERATIONS} decisions`,
      actor,
    );
  } catch (err) {
    // Recoverable: the run was paused underneath this advance, so the work is
    // held rather than abandoned — a resume runs the same decision again.
    if (err instanceof WorkflowRunPausedError) return;
    // Anything else is the store REFUSING the engine's own decision — an
    // oversized payload, a write append-only history forbids — and the run
    // cannot proceed. Pausing with the refusal as the reason IS the loud path:
    // the card states exactly why, the event log records it, and retry/resume
    // mean something again once the cause is fixed. Rethrowing would land in a
    // `void advanceRun(...)` and leave an "active" run that never moves again.
    console.error(`[workflow] advancing run ${runId} failed:`, errorText(err));
    mutated = true;
    pauseInternal(runId, errorText(err), actor);
  } finally {
    if (mutated) broadcastWorkflowRuns();
  }
}

/* -------------------------------- dispatch --------------------------------- */

/** Hand a pending step to its executor, or pause if nothing can run it. */
async function dispatchStep(
  run: WorkflowRunRow,
  step: WorkflowStepRow,
  actor: WorkflowActor,
): Promise<void> {
  if (step.kind === "agent") {
    const executor = getWorkflowAgentExecutor();
    if (!executor) {
      pauseInternal(
        run.id,
        `no agent executor is registered, so step ${step.id} cannot run`,
        actor,
      );
      return;
    }
    try {
      // The executor owns `startStep` — only it knows which session takes the
      // assignment — and the eventual `completeStep`.
      await executor.dispatch(workflowStepContext(run, step, actor));
    } catch (err) {
      // Store refusals are not executor failures and must not be translated
      // into one: a pause that lands while the executor is still preparing its
      // session makes `startStep` raise `WorkflowRunPausedError`, and swallowing
      // it here would overwrite the USER's pause reason with a dispatch error.
      // The loop holds on it instead, and an immutable-write bug reaches the
      // loop's own refusal path, which pauses the run naming it.
      if (isStoreRefusal(err)) throw err;
      handleDispatchFailure(run, step.id, err, actor);
    }
    return;
  }

  if (step.kind === "host-operation") {
    const operationId = hostOperationIdOf(step);
    const operation = operationId
      ? getWorkflowHostOperation(operationId)
      : undefined;
    if (!operation) {
      pauseInternal(
        run.id,
        `no executor is registered for host operation "${operationId ?? "(unnamed)"}" (step ${step.id})`,
        actor,
      );
      return;
    }
    const started = startStep(
      step.id,
      { kind: "operation", id: operation.id },
      actor,
    );
    await executeHostOperation(run, started, operation, actor);
    return;
  }

  if (step.kind === "wait") {
    const executor = getWorkflowWaitExecutor(step);
    if (!executor) {
      pauseInternal(
        run.id,
        `no executor is registered for wait step ${step.id}`,
        actor,
      );
      return;
    }
    const started = startStep(
      step.id,
      { kind: "operation", id: executor.id },
      actor,
    );
    await executor.dispatch(workflowStepContext(run, started, actor));
    return;
  }

  // A user decision has no automatic side effect, but it IS now in flight:
  // starting it before pausing means either allowed choice can finish the same
  // durable row without admitting new work through the pause gate.
  if (step.kind === "user-decision") {
    startStep(
      step.id,
      { kind: "operation", id: "user-decision" },
      SYSTEM_ACTOR,
    );
    pauseInternal(run.id, userDecisionPauseReason(step), actor);
    return;
  }
  pauseInternal(
    run.id,
    `no executor is registered for ${String(step.kind)} step ${step.id}`,
    actor,
  );
}

/**
 * Why a run holding an open user decision is paused, in the GATE's own words.
 * One implementation, because the dispatch that opens the gate and the boot
 * that finds it still open must say the same thing: a restart between the two
 * used to replace "the run reached its fix-round ceiling and wanted to …" with
 * an engine fault about a step that has no recovery path, which describes the
 * engine rather than the question the user is being asked.
 */
function userDecisionPauseReason(step: WorkflowStepRow): string {
  const ceiling = ceilingDecisionPayloadOf(step);
  return ceiling
    ? `the run reached its ${
        ceiling.blocked === "iterations" ? "fix-round" : "review-pass"
      } ceiling and wanted to ${ceiling.wanted}; ${ceilingChoiceText(
        ceiling.allowedChoices,
      )}`
    : "merge decision ready; open the live pull request card to merge, or cancel this run";
}

/**
 * Run an operation that is already `running` and record its conclusion. Also
 * the recovery path for a `retry-safe` operation at boot, which is why it takes
 * a started step rather than starting one.
 */
async function executeHostOperation(
  run: WorkflowRunRow,
  step: WorkflowStepRow,
  operation: WorkflowHostOperation,
  actor: WorkflowActor,
): Promise<void> {
  const operationActor: WorkflowActor = { kind: "system", id: operation.id };
  try {
    const outcome = await operation.execute(
      workflowStepContext(run, step, actor),
    );
    finishStep(step.id, {
      status: outcome.status,
      result: {
        status: outcome.status,
        summary: outcome.summary,
        ...(outcome.contractId ? { contractId: outcome.contractId } : {}),
        ...(outcome.payload !== undefined ? { payload: outcome.payload } : {}),
      },
      actor: operationActor,
    });
  } catch (err) {
    // The operation reported nothing, so the step ends without evidence — the
    // recipe's next decision pauses the run naming it.
    finishStep(step.id, {
      status: "failed",
      result: {
        status: "failed",
        summary: `operation ${operation.id} failed: ${errorText(err)}`,
      },
      actor: operationActor,
    });
  }
}

/** Supply the persisted causal chain without making an executor read the store. */
function workflowStepContext(
  run: WorkflowRunRow,
  step: WorkflowStepRow,
  actor: WorkflowActor,
): WorkflowStepContext {
  const predecessors: WorkflowStepRow[] = [];
  let predecessorId = step.predecessorId;
  while (predecessorId !== undefined) {
    const predecessor = getStep(predecessorId);
    if (!predecessor) break;
    predecessors.push(predecessor);
    predecessorId = predecessor.predecessorId;
  }
  return {
    run,
    step,
    ...(predecessors.length > 0 ? { predecessors } : {}),
    actor,
  };
}

/**
 * Complete a step unless it has already left the engine's hands. A cancel that
 * lands while an operation is in flight cancels the open step in the same
 * transaction, and a late completion for a step that is already terminal is a
 * benign race, not the bug that `WorkflowImmutableError` means.
 */
function finishStep(stepId: number, input: CompleteStepInput): void {
  const current = getStep(stepId);
  if (!current || current.status !== "running") return;
  completeStep(stepId, input);
}

/**
 * A refusal from the store's own gates rather than a failure of the work: the
 * run was paused underneath the call (recoverable — the loop holds), or the
 * write contradicted append-only history (a bug — it rethrows). Neither is
 * something to record as an executor's failed attempt.
 */
function isStoreRefusal(err: unknown): boolean {
  return (
    err instanceof WorkflowRunPausedError ||
    err instanceof WorkflowImmutableError
  );
}

/**
 * A dispatch that threw. If the executor had already started the step, the step
 * ends as failed and the next decision pauses naming it. If it never started,
 * the reservation is still `pending` and untouched, so the run pauses and a
 * resume dispatches the very same step again.
 */
function handleDispatchFailure(
  run: WorkflowRunRow,
  stepId: number,
  err: unknown,
  actor: WorkflowActor,
): void {
  const summary = `dispatch failed: ${errorText(err)}`;
  const current = getStep(stepId);
  if (current?.status === "running") {
    completeStep(stepId, {
      status: "failed",
      result: { status: "failed", summary },
      actor,
    });
    return;
  }
  pauseInternal(run.id, `${summary} (step ${stepId})`, actor);
}

/* -------------------------------- lifecycle -------------------------------- */

/** Pause from inside the loop; terminal runs are left alone. */
function pauseInternal(
  runId: number,
  reason: string,
  actor: WorkflowActor,
): void {
  const run = getRun(runId);
  if (!run || isTerminalWorkflowRunLifecycle(run.lifecycle)) return;
  setRunLifecycle(runId, "paused", { reason, actor });
}

/**
 * Stop admitting work, with the reason the card shows. A turn already running
 * is NOT aborted: its executor finishes and its `completeStep` is accepted, and
 * the advance that follows simply holds.
 */
export function pauseRun(
  runId: number,
  reason: string,
  actor: WorkflowActor = SYSTEM_ACTOR,
): void {
  setRunLifecycle(runId, "paused", { reason, actor });
  broadcastWorkflowRuns();
}

/** Resume a paused run and immediately re-derive what should happen next. */
export async function resumeRun(
  runId: number,
  actor: WorkflowActor = SYSTEM_ACTOR,
): Promise<void> {
  const run = getRun(runId);
  if (!run) throw new Error(`workflow run ${runId} does not exist`);
  // A duplicate browser command must not fabricate an active → active
  // transition in the append-only event log or dispatch work a second time.
  if (run.lifecycle === "active") return;
  // A cancellation the user already asked for is not something Resume may
  // undo, however long its settlement waits behind an in-flight operation.
  if (run.cancelRequestedAt !== undefined)
    throw new WorkflowValidationError(
      `workflow run ${runId} is being cancelled at the user's request`,
    );
  setRunLifecycle(runId, "active", { actor });
  broadcastWorkflowRuns();
  await advanceRun(runId, actor);
}

/**
 * End the run. Ordinary open steps are cancelled with the lifecycle and their
 * sessions/worktree/PR are preserved. A running rebase repair is the one safety
 * exception: abort its turn and restore the exact clean pre-repair Git state
 * before cancellation becomes terminal. Cleanup remains a separate decision.
 */
export function cancelRun(
  runId: number,
  actor: WorkflowActor = SYSTEM_ACTOR,
  reason?: string,
): Promise<void> {
  // The user's action lands NOW, ahead of the run chain: a host operation can
  // hold that chain for as long as its own deadline — CI observation polls for
  // up to half an hour — and a Cancel that visibly does nothing until then is
  // not the immediate control this module promises.
  //
  // Three things have to be true before the settlement can wait its turn: the
  // store must admit no further work (the pause gate), every client must SEE
  // it (the broadcast, which pausing internally does not do), and nothing may
  // undo it — a plain pause is resumable, and Resume on a run whose
  // cancellation is queued would hand the in-flight advance an active run to
  // append to. `cancelling` is that last piece: an intent Resume refuses and
  // only the settlement clears.
  const pending = getRun(runId);
  if (pending && !isTerminalWorkflowRunLifecycle(pending.lifecycle)) {
    requestRunCancellation(runId, actor);
    // The reason is replaced even on an already-paused run: a run that stopped
    // for some other cause must not keep announcing that cause while the user's
    // cancellation waits behind it.
    pauseInternal(runId, reason ?? "cancelling at the user's request", actor);
    broadcastWorkflowRuns();
  }
  return withRunLock(runId, async () => {
    const run = getRun(runId);
    const open = listOpenSteps(runId);
    const decision =
      open.length === 1 && mergeDecisionPayloadOf(open[0]!)
        ? open[0]
        : undefined;
    // A ceiling gate offers cancel as one of ITS recorded choices too, so the
    // step is completed with that answer rather than merely cancelled by the
    // lifecycle transition passing over it.
    const ceiling =
      open.length === 1 && ceilingDecisionPayloadOf(open[0]!)
        ? open[0]
        : undefined;
    const repair =
      open.length === 1 && repairRebasePayloadOf(open[0]!)
        ? open[0]
        : undefined;
    // An automatic triage is settled the same way: its Git contract is that it
    // left the checkout alone, and cancelling mid-turn is exactly when that has
    // to be checked and put right.
    const triage =
      open.length === 1 && operationTriagePayloadOf(open[0]!)
        ? open[0]
        : undefined;
    if (run && (repair || triage)) {
      const assignment = (repair ?? triage)!;
      const sessionId =
        assignment.executor?.kind === "session"
          ? assignment.executor.id
          : undefined;
      if (sessionId) await abortWorkflowSession(sessionId);
      const current = getStep(assignment.id);
      if (current?.status === "running") {
        const safety = repair
          ? await finalizeRebaseRepair(run, current, "failed")
          : undefined;
        const triageSafety = triage
          ? await finalizeOperationTriage(run, current, "failed")
          : undefined;
        completeStep(current.id, {
          status: "cancelled",
          observationDetail: {
            cancellation: repair
              ? "rebase-repair-restored"
              : "operation-triage-restored",
            ...(safety ? { rebaseRepairSafety: safety } : {}),
            ...(triageSafety ? { operationTriageSafety: triageSafety } : {}),
          },
          // Its turn was just aborted, so delegated work it still owes can no
          // longer be cleared by it. Enforcing that here would refuse the
          // user's cancellation and leave the run stuck CANCELLING until a
          // restart, where boot settles it by bypassing the same check.
          abandonedTurn: true,
          actor,
        });
      }
    }
    if (run && decision) {
      // Cancel is one of this gate's recorded choices, not merely a lifecycle
      // transition that happens to cancel its open row.
      if (decision.status === "pending") {
        if (run.lifecycle === "paused")
          setRunLifecycle(runId, "active", { actor });
        startStep(
          decision.id,
          { kind: "operation", id: "user-decision" },
          actor,
        );
      }
      completeStep(decision.id, {
        status: "completed",
        result: {
          status: "completed",
          summary: "user chose not to merge and cancelled the workflow run",
          payload: { choice: "cancel", source: "app" },
        },
        actor,
      });
    }
    if (run && ceiling) {
      if (ceiling.status === "pending") {
        if (run.lifecycle === "paused")
          setRunLifecycle(runId, "active", { actor });
        startStep(
          ceiling.id,
          { kind: "operation", id: "user-decision" },
          actor,
        );
      }
      completeStep(ceiling.id, {
        status: "completed",
        result: {
          status: "completed",
          summary: "user cancelled the run at its ceiling",
          payload: { choice: "cancel" },
        },
        actor,
      });
    }
    setRunLifecycle(runId, "cancelled", {
      actor,
      ...(reason ? { reason } : {}),
    });
    broadcastWorkflowRuns();
  });
}

/**
 * Whether a session is mid-turn IN THIS PROCESS — the only place a turn exists.
 * Injected for tests, which drive reconciliation without a live runtime.
 */
const liveSessionTurn = (sessionId: string): boolean =>
  sessionRuntime.isRunning(sessionId);
let sessionTurnAlive: (sessionId: string) => boolean = liveSessionTurn;

export function setSessionTurnLivenessForTests(
  probe: ((sessionId: string) => boolean) | undefined,
): void {
  sessionTurnAlive = probe ?? liveSessionTurn;
}

/** The gate's own choices, in the words the pause reason offers them. */
function ceilingChoiceText(
  choices: readonly ("raise" | "deliver" | "re-evaluate" | "cancel")[],
): string {
  const wording = {
    raise: "raise the ceiling",
    deliver: "deliver the work as it stands",
    "re-evaluate": "fix the workspace and have the run look again",
    cancel: "cancel this run",
  } as const;
  const offered = choices.map((choice) => wording[choice]);
  return offered.length > 1
    ? `${offered.slice(0, -1).join(", ")}, or ${offered.at(-1)!}`
    : (offered[0] ?? "cancel this run");
}

/** Compute the ceilings a user raise requests before the engine's monotonic check. */
function requestedCeilings(
  run: WorkflowRunRow,
  adjustment: WorkflowCeilingRaise,
): { maxIterations: number; maxReviewPasses: number } {
  if (adjustment.mode === "set") {
    return raiseWorkflowRunLimits(adjustment.ceilings);
  }
  const amount = (value: number | undefined): number =>
    value === undefined || !Number.isFinite(value)
      ? 0
      : Math.max(0, Math.round(value));
  return raiseWorkflowRunLimits({
    maxIterations: run.maxIterations + amount(adjustment.amounts.maxIterations),
    maxReviewPasses:
      run.maxReviewPasses + amount(adjustment.amounts.maxReviewPasses),
  });
}

/**
 * Answer the gate an exhausted ceiling opened. Raising moves the run's bound
 * and lets the loop derive the move it was blocked on; delivering takes the
 * work as it stands, which is the only way a head no discovery review passed
 * reaches the delivery gate; cancelling ends the run through its own path.
 * Each is recorded on the durable step as the user's choice, never inferred.
 */
export async function answerCeilingDecision(
  runId: number,
  answer:
    | { choice: "raise"; adjustment: WorkflowCeilingRaise }
    | { choice: "deliver" }
    | { choice: "re-evaluate" }
    | { choice: "cancel" },
  actor: WorkflowActor,
): Promise<void> {
  if (answer.choice === "cancel") {
    await cancelRun(runId, actor, "cancelled at the run's ceiling");
    return;
  }
  await withRunLock(runId, async () => {
    const run = getRun(runId);
    if (!run) throw new Error(`workflow run ${runId} does not exist`);
    // A cancellation the user already asked for is not something an answer to
    // this gate may undo, however long its settlement waits behind an
    // in-flight operation. `cancel` itself took the branch above.
    if (run.cancelRequestedAt !== undefined)
      throw new WorkflowValidationError(
        `workflow run ${runId} is being cancelled at the user's request`,
      );
    const open = listOpenSteps(runId);
    const step = open.length === 1 ? open[0] : undefined;
    const asked = step ? ceilingDecisionPayloadOf(step) : undefined;
    if (!step || !asked)
      throw new Error(`workflow run ${runId} has no open ceiling decision`);
    // A choice this gate does not offer cannot be carried out, and recording it
    // would settle the decision into a dead end: a workspace that moved out
    // from under its review has no head to deliver.
    if (!asked.allowedChoices.includes(answer.choice))
      throw new WorkflowValidationError(
        `workflow run ${runId} does not offer "${answer.choice}" at this ceiling`,
      );
    // What the run WOULD end up with — computed, not written: a raise never
    // lowers a ceiling, so recording the request would describe a past that did
    // not happen, and a request that moves nothing must be refused BEFORE any
    // write rather than after one.
    const requested =
      answer.choice === "raise"
        ? requestedCeilings(run, answer.adjustment)
        : {
            maxIterations: run.maxIterations,
            maxReviewPasses: run.maxReviewPasses,
          };
    const ceilings = {
      maxIterations: Math.max(run.maxIterations, requested.maxIterations),
      maxReviewPasses: Math.max(run.maxReviewPasses, requested.maxReviewPasses),
    };
    if (
      answer.choice === "raise" &&
      ceilings.maxIterations === run.maxIterations &&
      ceilings.maxReviewPasses === run.maxReviewPasses
    )
      // Settling the gate on a raise that moved nothing would close the only
      // surface that can move it: the run would come straight back to the same
      // block with no controls left. The decision stays open instead.
      throw new WorkflowValidationError(
        `workflow run ${runId} is already at the ceilings this answer names`,
      );
    if (run.lifecycle === "paused") setRunLifecycle(runId, "active", { actor });
    // A gate answered before its own dispatch — a crash between the append and
    // the advance, or an answer racing boot reconciliation — is still the
    // user's to settle: the store admits no pending → completed shortcut.
    if (step.status === "pending")
      startStep(step.id, { kind: "operation", id: "user-decision" }, actor);
    completeStep(step.id, {
      status: "completed",
      // The raise rides WITH the settlement, in one transaction: a crash
      // between them would leave the run's ceiling moved and its gate open,
      // and the card would then offer a raise the run has already taken.
      ...(answer.choice === "raise"
        ? {
            raiseCeilings: {
              ceilings,
              adjustment: answer.adjustment as unknown as WorkflowJsonValue,
            },
          }
        : {}),
      result: {
        status: "completed",
        summary:
          answer.choice === "raise"
            ? `user raised the run's ceilings to ${String(
                ceilings.maxIterations,
              )} fix rounds and ${String(ceilings.maxReviewPasses)} review passes`
            : answer.choice === "re-evaluate"
              ? "user asked the run to look at the workspace again"
              : "user chose to deliver the work as it stands",
        payload:
          answer.choice === "raise"
            ? {
                choice: "raise",
                adjustment: answer.adjustment as unknown as WorkflowJsonValue,
                maxIterations: ceilings.maxIterations,
                maxReviewPasses: ceilings.maxReviewPasses,
              }
            : answer.choice === "re-evaluate"
              ? { choice: "re-evaluate" }
              : {
                  choice: "deliver",
                  ...(asked.reviewedHeadCommit
                    ? { reviewedHeadCommit: asked.reviewedHeadCommit }
                    : {}),
                },
      },
      actor,
    });
    broadcastWorkflowRuns();
  });
  await advanceRun(runId, actor);
}

/**
 * Retry the paused tail without rewriting history. A failed or blocked step gets
 * a pending successor carrying the exact same assignment; a dispatch failure
 * left its reservation pending, so that case only needs to resume it.
 */
export function retryRun(
  runId: number,
  actor: WorkflowActor = SYSTEM_ACTOR,
): Promise<void> {
  return withRunLock(runId, async () => {
    const run = getRun(runId);
    if (!run) throw new Error(`workflow run ${runId} does not exist`);
    if (isTerminalWorkflowRunLifecycle(run.lifecycle))
      throw new Error(
        `workflow run ${runId} is ${run.lifecycle} and cannot be retried`,
      );
    if (run.lifecycle !== "paused")
      throw new Error(`workflow run ${runId} is not paused`);
    // A cancellation the user already asked for is not something this may
    // undo, however long its settlement waits behind an in-flight operation.
    if (run.cancelRequestedAt !== undefined)
      throw new WorkflowValidationError(
        `workflow run ${runId} is being cancelled at the user's request`,
      );

    const history = listSteps(runId);
    const last = history[history.length - 1];
    if (!last) throw new Error(`workflow run ${runId} has no step to retry`);

    if (last.status === "pending") {
      setRunLifecycle(runId, "active", { actor });
      broadcastWorkflowRuns();
      await runAdvanceLoop(runId, actor);
      return;
    }

    const recheckPullRequest = isRecheckablePullRequestObservation(last);
    if (
      last.status !== "failed" &&
      last.status !== "blocked" &&
      !recheckPullRequest
    )
      throw new Error(
        `workflow run ${runId} cannot retry its ${last.status} step ${last.id}`,
      );

    // Admission requires an active run. Resume inside this lock WITHOUT
    // advancing, append the semantic retry, then derive from that new tail.
    // A spent repair is never cloned: Retry resumes the exact checkpoint
    // operation that reported the conflict, preserving its discovery/delivery
    // purpose and coordinator-selected routing fields.
    setRunLifecycle(runId, "active", { actor });
    const repair = recheckPullRequest ? undefined : repairRebasePayloadOf(last);
    const repairCheckpoint =
      repair && last.predecessorId !== undefined
        ? history.find((step) => step.id === last.predecessorId)
        : undefined;
    const checkpointPayload =
      repairCheckpoint?.kind === "host-operation"
        ? repairCheckpoint.payload
        : undefined;
    const resumeBaseSync =
      repair &&
      typeof checkpointPayload === "object" &&
      checkpointPayload !== null &&
      !Array.isArray(checkpointPayload) &&
      (checkpointPayload as Record<string, unknown>).operation ===
        BASE_SYNC_OPERATION_ID;
    const operation = resumeBaseSync
      ? BASE_SYNC_OPERATION_ID
      : COMMIT_SYNC_OPERATION_ID;
    // A spent triage is never cloned either: its one attempt is the episode's,
    // so Retry re-runs the operation it was assigned to — the failed step's own
    // payload, re-reserved against the triage — and the SECOND identical result
    // is the pause the user came to answer.
    const triage = recheckPullRequest
      ? undefined
      : operationTriagePayloadOf(last);
    const triaged =
      triage && last.predecessorId !== undefined
        ? history.find((step) => step.id === last.predecessorId)
        : undefined;
    if (
      triage &&
      (triaged?.kind !== "host-operation" || triaged.id !== triage.stepId)
    )
      throw new Error(
        `workflow run ${runId} cannot retry triage step ${last.id}: it is not attached to the ${triage.operation} step it was assigned`,
      );
    const reissued =
      triage && triaged
        ? {
            ...(triaged.payload as Record<string, WorkflowJsonValue>),
            idempotencyKey: operationIdempotencyKey(
              runId,
              triage.operation,
              last.id,
            ),
          }
        : undefined;
    appendStep({
      runId,
      kind: repair || reissued ? "host-operation" : last.kind,
      payload: repair
        ? {
            operation,
            idempotencyKey: resumeBaseSync
              ? baseSyncIdempotencyKey(runId, last.id)
              : commitSyncIdempotencyKey(runId, last.id),
            ...(resumeBaseSync
              ? baseSyncResumePayloadOf(checkpointPayload)
              : {}),
          }
        : (reissued ?? last.payload),
      predecessorId: last.id,
      actor,
    });
    broadcastWorkflowRuns();
    await runAdvanceLoop(runId, actor);
  });
}

/**
 * User-authorized recovery from an observed base conflict. The deterministic
 * commit-sync operation attempts the rebase and then produces a fresh review
 * range. If Git reports conflicts it aborts/restores; the recipe may assign one
 * bounded repair attempt before pausing with the manual resolve-then-Retry path.
 */
export function rebaseAndReviewRun(
  runId: number,
  actor: WorkflowActor = SYSTEM_ACTOR,
): Promise<void> {
  return withRunLock(runId, async () => {
    const run = getRun(runId);
    if (!run) throw new Error(`workflow run ${runId} does not exist`);
    if (run.lifecycle !== "paused")
      throw new Error(`workflow run ${runId} is not paused`);
    // A cancellation the user already asked for is not something this may
    // undo, however long its settlement waits behind an in-flight operation.
    if (run.cancelRequestedAt !== undefined)
      throw new WorkflowValidationError(
        `workflow run ${runId} is being cancelled at the user's request`,
      );
    const history = listSteps(runId);
    const last = history[history.length - 1];
    const observation = last
      ? readStepResult(last, PULL_REQUEST_OBSERVATION_RESULT_CONTRACT_ID)
      : undefined;
    if (
      !last ||
      last.kind !== "wait" ||
      observation?.outcome !== "base-conflict"
    )
      throw new Error(
        `workflow run ${runId} is not paused on an observed base conflict`,
      );

    setRunLifecycle(runId, "active", { actor });
    appendStep({
      runId,
      kind: "host-operation",
      payload: {
        operation: COMMIT_SYNC_OPERATION_ID,
        idempotencyKey: commitSyncIdempotencyKey(runId, last.id),
      },
      predecessorId: last.id,
      actor,
    });
    broadcastWorkflowRuns();
    await runAdvanceLoop(runId, actor);
  });
}

/* ------------------------------ boot recovery ------------------------------ */

/**
 * Decide what a restart may resume (`app/server/src/index.ts` calls this beside
 * the other boot reconcilers). Foundation invariant 6: restart behavior is
 * idempotent or pauses as indeterminate.
 *
 * - `paused` runs stay paused — a pause holds across restarts.
 * - A `pending` step never had a side effect: advancing re-dispatches it.
 * - A `running` AGENT step is ADOPTED when its session still exists: the step
 *   keeps running and the executor re-attaches, because failing it would throw
 *   away work the session may have finished. A vanished session is the opposite
 *   — nobody will ever submit that result — so the step fails and the run
 *   pauses.
 * - A `running` HOST OPERATION follows its declared recovery policy: only
 *   `retry-safe` re-runs; anything else pauses for the user to look.
 * - A `running` WAIT is re-observed through its registered executor, which may
 *   consume the external state persisted while the process was down.
 *
 * The worktree needs nothing here: it is preserved as-is, and steps 3 and 5 own
 * its state.
 */
export async function reconcileWorkflowRunsOnBoot(): Promise<void> {
  for (const run of listOpenRuns()) {
    // A cancellation the user asked for outlives the process that could not
    // finish settling it: the request is durable, so boot finishes the job
    // rather than letting the run come back as an ordinary paused one.
    if (run.cancelRequestedAt !== undefined) {
      try {
        await cancelRun(run.id, SYSTEM_ACTOR, run.lifecycleReason);
      } catch (err) {
        console.warn(
          `[workflow] settling the cancellation of run ${run.id} failed:`,
          errorText(err),
        );
      }
      continue;
    }
    if (run.lifecycle === "paused") continue;
    try {
      await withRunLock(run.id, () => reconcileRun(run.id));
    } catch (err) {
      console.warn(
        `[workflow] reconciling run ${run.id} failed:`,
        errorText(err),
      );
    }
  }
  broadcastWorkflowRuns();
}

/** Whether the run may keep going, or this reconciliation already paused it. */
type Reconciliation = "continue" | "paused";

async function reconcileRun(runId: number): Promise<void> {
  const run = getRun(runId);
  if (!run) return;
  // The recipe is consulted BEFORE any running step is touched. A run whose
  // `(recipeId, recipeVersion)` this process no longer knows must not be driven
  // at all — recovering one of its operations first and pausing afterwards
  // would run a side effect on behalf of a decision function that is gone.
  const recipe = getWorkflowRecipe(run.recipeId, run.recipeVersion);
  if (!recipe) {
    pauseInternal(
      runId,
      `unknown recipe ${recipeKey(run.recipeId, run.recipeVersion)}`,
      SYSTEM_ACTOR,
    );
    return;
  }

  // And the same for anything else the recipe refuses to proceed from — a
  // history with two open steps above all. Asking the DECISION rather than
  // re-checking the invariant here keeps that policy in one place, and the
  // ordering is the point: recovery must not re-run an operation belonging to a
  // history the recipe would not have produced.
  const decision = recipe.decide(run, listSteps(runId));
  if (decision.kind === "pause") {
    pauseInternal(runId, decision.reason, SYSTEM_ACTOR);
    return;
  }

  const running = listOpenSteps(runId).filter(
    (step) => step.status === "running",
  );
  for (const step of running) {
    if ((await reconcileRunningStep(runId, step)) === "paused") return;
  }
  // Re-derive what comes next: dispatch a `pending` reservation the crash left
  // behind, admit the step a completion that landed just before the crash now
  // allows, or wait on an adopted agent step. The pure decision guarantees the
  // reservation is FOUND rather than duplicated.
  await runAdvanceLoop(runId, SYSTEM_ACTOR);
}

/** Recover one step that was running when the process died. */
async function reconcileRunningStep(
  runId: number,
  step: WorkflowStepRow,
): Promise<Reconciliation> {
  if (step.kind === "agent") return reconcileRunningAgentStep(runId, step);
  if (step.kind === "host-operation")
    return reconcileRunningOperationStep(runId, step);
  if (step.kind === "wait") return reconcileRunningWaitStep(runId, step);
  // An open gate needs no recovery: the row is already running and either
  // choice still completes it. What a restart must not do is describe it as a
  // fault — the card asks the user a question, so the pause states the question.
  if (step.kind === "user-decision") {
    pauseInternal(runId, userDecisionPauseReason(step), SYSTEM_ACTOR);
    return "paused";
  }
  pauseInternal(
    runId,
    `${String(step.kind)} step ${step.id} was running at restart and has no recovery path`,
    SYSTEM_ACTOR,
  );
  return "paused";
}

async function reconcileRunningAgentStep(
  runId: number,
  step: WorkflowStepRow,
): Promise<Reconciliation> {
  const sessionId =
    step.executor?.kind === "session" ? step.executor.id : undefined;
  // A repair may have been interrupted at any Git instruction. Never adopt it
  // across a server restart: restore its exact pre-repair head first, record the
  // verified safety evidence, and let the user decide when to Retry through
  // commit-sync.
  if (repairRebasePayloadOf(step)) {
    const run = getRun(runId);
    let safety;
    let recoveryError: string | undefined;
    try {
      safety = run
        ? await finalizeRebaseRepair(run, step, "failed")
        : undefined;
    } catch (err) {
      recoveryError = errorText(err);
    }
    const summary = `server restarted during rebase repair${safety ? "; the original branch and clean worktree were restored" : `; ${recoveryError ?? "restoration could not be verified"}`}`;
    completeStep(step.id, {
      status: "failed",
      result: {
        status: "failed",
        summary,
        ...(safety ? { payload: { rebaseRepairSafety: safety } } : {}),
      },
      // A repair agent delegates like any other developer session, and its turn
      // died with the process too. Refusing this completion would strand the
      // run behind a step nothing can finish — here with Git already restored,
      // which is the state the user most needs to see recorded.
      abandonedTurn: true,
      actor: SYSTEM_ACTOR,
    });
    pauseInternal(runId, summary, SYSTEM_ACTOR);
    return "paused";
  }
  // A triage is judged against the exact Git state it was handed, and the turn
  // that would have submitted its result died with the process. Settle it the
  // same way: restore first, record what was found, and let the user look.
  if (operationTriagePayloadOf(step)) {
    const run = getRun(runId);
    let safety;
    let recoveryError: string | undefined;
    try {
      safety = run
        ? await finalizeOperationTriage(run, step, "failed")
        : undefined;
    } catch (err) {
      recoveryError = errorText(err);
    }
    const unrestored =
      recoveryError ??
      (safety?.violations
        ? `the run branch could not be fully restored, and ${safety.violations.join("; ")}`
        : "restoration could not be verified");
    const summary = `server restarted during automatic operation triage; ${
      safety?.restored
        ? "the run branch was restored to the state the triage was handed"
        : unrestored
    }`;
    completeStep(step.id, {
      status: "failed",
      result: {
        status: "failed",
        summary,
        ...(safety ? { payload: { operationTriageSafety: safety } } : {}),
      },
      // A triage agent delegates like any other developer session, and its turn
      // died with the process too; refusing this completion would strand the
      // run behind a step nothing can finish.
      abandonedTurn: true,
      actor: SYSTEM_ACTOR,
    });
    pauseInternal(runId, summary, SYSTEM_ACTOR);
    return "paused";
  }
  // Adopt only a turn that is still ALIVE. A session ROW outliving the process
  // that drove it proves nothing: provider turns run in memory, so after a
  // restart nobody remains to call `session_submit_result`, and a step adopted
  // on the strength of the row would leave the run active forever, waiting for
  // a result that cannot arrive. Foundation invariant 6 admits exactly two
  // answers — idempotent recovery, or a pause as indeterminate — and the
  // conservative one is the pause: re-dispatching an assignment whose dead turn
  // may already have changed the worktree would redo mutating work nobody
  // watched. The recovery path below marks it failed with its evidence, and the
  // existing Retry appends a successor once the user has looked.
  if (sessionId && sessionStore.get(sessionId) && sessionTurnAlive(sessionId)) {
    // Adopt, don't duplicate. The step stays running; the observation records
    // that this process inherited it rather than started it.
    appendEvent({
      runId,
      stepId: step.id,
      type: "observation-recorded",
      actor: SYSTEM_ACTOR,
      detail: { reconciliation: "adopted-running-agent-step", sessionId },
    });
    return "continue";
  }
  // Nobody will ever submit this result. A repair assignment first restores
  // its exact pre-repair head under the repository lock; only verified recovery
  // is projected as safe.
  const run = getRun(runId);
  let safety;
  let recoveryError: string | undefined;
  try {
    safety = run ? await finalizeRebaseRepair(run, step, "failed") : undefined;
  } catch (err) {
    recoveryError = errorText(err);
  }
  const interrupted = Boolean(sessionId && sessionStore.get(sessionId));
  const summary = interrupted
    ? `step ${step.id}'s turn on session ${sessionId} was interrupted — the session is still there, but the turn that would have submitted its result is not, so nothing can complete it${recoveryError ? `; ${recoveryError}` : ""}`
    : `step ${step.id}'s session ${sessionId ?? "(unassigned)"} no longer exists, so its result can never arrive${recoveryError ? `; ${recoveryError}` : ""}`;
  completeStep(step.id, {
    status: "failed",
    result: {
      status: "failed",
      summary,
      ...(safety ? { payload: { rebaseRepairSafety: safety } } : {}),
    },
    // The turn that owed this session's delegated children is gone with the
    // process, so no obligation it left can ever be cleared by it. Recording
    // the failure is what keeps the run actionable; refusing it would leave a
    // running step with nothing behind it, which neither Resume nor Retry can
    // reach.
    abandonedTurn: true,
    actor: SYSTEM_ACTOR,
  });
  pauseInternal(runId, summary, SYSTEM_ACTOR);
  return "paused";
}

async function reconcileRunningWaitStep(
  runId: number,
  step: WorkflowStepRow,
): Promise<Reconciliation> {
  const executor = getWorkflowWaitExecutor(step);
  const run = getRun(runId);
  if (!executor || !run) {
    pauseInternal(
      runId,
      `wait step ${step.id} has no registered executor after a restart`,
      SYSTEM_ACTOR,
    );
    return "paused";
  }
  appendEvent({
    runId,
    stepId: step.id,
    type: "observation-recorded",
    actor: SYSTEM_ACTOR,
    detail: {
      reconciliation: "re-observed-running-wait",
      executor: executor.id,
    },
  });
  await executor.dispatch(workflowStepContext(run, step, SYSTEM_ACTOR));
  return "continue";
}

async function reconcileRunningOperationStep(
  runId: number,
  step: WorkflowStepRow,
): Promise<Reconciliation> {
  const operationId = hostOperationIdOf(step);
  const operation = operationId
    ? getWorkflowHostOperation(operationId)
    : undefined;
  const run = getRun(runId);
  if (run && operation?.recoveryPolicy === "retry-safe") {
    const attempted = recordStepAttempt(step.id, SYSTEM_ACTOR);
    await executeHostOperation(run, attempted, operation, SYSTEM_ACTOR);
    return "continue";
  }
  pauseInternal(
    runId,
    operation
      ? `operation ${operation.id} (step ${step.id}) is ${operation.recoveryPolicy} after a restart; it needs a look before it runs again`
      : `operation "${operationId ?? "(unnamed)"}" (step ${step.id}) has no registered executor after a restart`,
    SYSTEM_ACTOR,
  );
  return "paused";
}

/** Test-only: drop the per-run advance chains between suites. */
export function resetWorkflowEngineForTests(): void {
  advanceChains.clear();
  setWorkflowSessionAbortForTests(null);
  // Every injected seam goes back to the real one: a probe left behind by an
  // earlier case would decide a later case's behaviour invisibly.
  setSessionTurnLivenessForTests(undefined);
}
