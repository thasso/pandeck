/**
 * The executor seam (`docs/agent-workflows.md`, "Recipe as code, steps as
 * data", [Task-365](pa://task/365)).
 *
 * The engine decides WHICH step runs next; an executor knows HOW to run one.
 * This module owns the interfaces and the registry between them, so the engine
 * depends on neither sessions nor git: step 4 ([Task-367](pa://task/367))
 * registers the agent executor, step 5 ([Task-368](pa://task/368)) registers
 * the host operations, and step 9 ([Task-372](pa://task/372)) registers durable
 * wait observers; tests register fakes for all three.
 *
 * The kinds differ in WHO ends the step, which is why they are separate
 * interfaces rather than one:
 *
 * - An **agent executor** starts the step against a session and returns; the
 *   step ends much later, when the session submits its structured result. It
 *   therefore owns `startStep` (only it knows the session id) and the eventual
 *   `completeStep`.
 * - A **host operation** runs to a conclusion and RETURNS it. The engine binds
 *   the operation as the step's executor, records the outcome, and continues,
 *   so an operation never touches the store itself.
 * - A **wait executor** starts a durable subscription and returns while the
 *   step remains running. It may consume an already-persisted observation at
 *   dispatch/restart, or complete later when its external watcher calls it.
 *
 * An executor must never AWAIT `advanceRun` for its own run from inside
 * `dispatch`: advances are serialized per run, so awaiting one from within one
 * would wait on itself. The engine re-advances after `dispatch` returns, and an
 * executor that finishes later calls `advanceRun` from its own context.
 */
import type {
  WorkflowActor,
  WorkflowJsonValue,
  WorkflowResultStatus,
} from "@assistant/shared";
import type { WorkflowRunRow, WorkflowStepRow } from "../db/workflowStore.ts";

/**
 * What a restart may do with an operation that was already running. "Restart
 * behavior is idempotent or pauses as indeterminate" (foundation invariant 6):
 *
 * - `retry-safe` — re-running it cannot double an effect, so recovery just
 *   attempts it again.
 * - `observe-first` — the effect may or may not have landed and the operation
 *   cannot tell on its own; recovery pauses for the user to look.
 * - `indeterminate` — same, with no observation available at all.
 *
 * Only the first is recovered automatically. Guessing on the other two is how a
 * runtime pushes twice or commits a half-finished tree.
 */
type WorkflowRecoveryPolicy = "retry-safe" | "observe-first" | "indeterminate";

/**
 * What an executor is handed: the run, the step, its persisted predecessor
 * chain (nearest first) when it has one, and who caused the dispatch. Supplying
 * the chain lets an operation validate semantic retries without reaching into
 * the store.
 */
export interface WorkflowStepContext {
  run: WorkflowRunRow;
  step: WorkflowStepRow;
  predecessors?: readonly WorkflowStepRow[];
  actor: WorkflowActor;
}

/**
 * Runs `agent` steps. One executor for the kind, not one per role: the role
 * lives in the recipe-owned payload, and the executor turns it into a prompt.
 */
export interface WorkflowAgentExecutor {
  /**
   * Take a PENDING step: start or reuse a session, `startStep` it against that
   * session, and arrange for `completeStep` when the result arrives. Throwing
   * fails the step and pauses the run.
   */
  dispatch(context: WorkflowStepContext): Promise<void>;
}

/** The conclusion a host operation reports, recorded as the step's result. */
export interface WorkflowOperationOutcome {
  status: WorkflowResultStatus;
  summary: string;
  /** The registered result contract `payload` was built to satisfy. */
  contractId?: string;
  payload?: WorkflowJsonValue;
}

/** One registered deterministic operation, addressed by id from the payload. */
export interface WorkflowHostOperation {
  id: string;
  recoveryPolicy: WorkflowRecoveryPolicy;
  execute(context: WorkflowStepContext): Promise<WorkflowOperationOutcome>;
}

/**
 * Starts or reconciles one durable external subscription. It may complete the
 * step from an already-persisted observation, but must not call `advanceRun`
 * while dispatch is awaiting it; the engine loop advances after it returns.
 */
export interface WorkflowWaitExecutor {
  id: string;
  supports(step: WorkflowStepRow): boolean;
  dispatch(context: WorkflowStepContext): Promise<void>;
}

/* -------------------------------- registry -------------------------------- */

let agentExecutor: WorkflowAgentExecutor | undefined;
const hostOperations = new Map<string, WorkflowHostOperation>();
const waitExecutors = new Map<string, WorkflowWaitExecutor>();

export function registerWorkflowAgentExecutor(
  executor: WorkflowAgentExecutor,
): void {
  agentExecutor = executor;
}

export function getWorkflowAgentExecutor(): WorkflowAgentExecutor | undefined {
  return agentExecutor;
}

/**
 * Register an operation. Duplicate ids throw rather than overwrite: two
 * operations answering to one id would make which side effect a step runs
 * depend on import order.
 */
export function registerWorkflowHostOperation(
  operation: WorkflowHostOperation,
): void {
  if (hostOperations.has(operation.id))
    throw new Error(
      `workflow host operation "${operation.id}" is already registered`,
    );
  hostOperations.set(operation.id, operation);
}

export function getWorkflowHostOperation(
  id: string,
): WorkflowHostOperation | undefined {
  return hostOperations.get(id);
}

export function registerWorkflowWaitExecutor(
  executor: WorkflowWaitExecutor,
): void {
  if (waitExecutors.has(executor.id))
    throw new Error(
      `workflow wait executor "${executor.id}" is already registered`,
    );
  waitExecutors.set(executor.id, executor);
}

export function getWorkflowWaitExecutor(
  step: WorkflowStepRow,
): WorkflowWaitExecutor | undefined {
  return [...waitExecutors.values()].find((executor) =>
    executor.supports(step),
  );
}

/**
 * The operation a `host-operation` step names. Every such payload carries its
 * operation id in `operation` — the one convention the engine needs to know
 * about payloads it otherwise treats as opaque.
 */
export function hostOperationIdOf(step: WorkflowStepRow): string | undefined {
  const payload = step.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    return undefined;
  const id = payload.operation;
  return typeof id === "string" && id ? id : undefined;
}

/** The registered result contract an agent step expects from its executor. */
export function resultContractIdOf(step: WorkflowStepRow): string | undefined {
  const payload = step.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    return undefined;
  const id = payload.resultContract;
  return typeof id === "string" && id ? id : undefined;
}

/** Test-only teardown, so one suite's fakes never leak into the next. */
export function resetWorkflowExecutorsForTests(): void {
  agentExecutor = undefined;
  hostOperations.clear();
  waitExecutors.clear();
}
