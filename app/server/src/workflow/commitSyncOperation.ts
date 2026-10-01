import type {
  WorkflowJsonValue,
  WorktreeSyncOperation,
} from "@assistant/shared";
import {
  isNoChangesCommitResult,
  runCommitWorkflow,
  type CommitWorkflowOptions,
  type CommitWorkflowResult,
} from "../commitWorkflow.ts";
import { getWorktree, type WorktreeRow } from "../db/worktreeStore.ts";
import { errorText } from "../errors.ts";
import { git, gitOptional, repoLockKey } from "../gitExec.ts";
import { invalidateWorktreeStatus } from "../worktrees/worktreeStatus.ts";
import {
  baseBranchTarget,
  syncWorktree,
  WorktreeSyncConflictError,
} from "../worktrees/worktreeSync.ts";
import { resolveMainWorktreeRow } from "../worktrees/worktreeResolve.ts";
import {
  BASE_SYNC_OPERATION_ID,
  baseSyncIdempotencyKey,
  COMMIT_ONLY_OPERATION_ID,
  commitOnlyIdempotencyKey,
  COMMIT_SYNC_OPERATION_ID,
  commitSyncIdempotencyKey,
  repairRebasePayloadOf,
} from "./codeDeliveryRecipe.ts";
import {
  registerWorkflowHostOperation,
  type WorkflowHostOperation,
  type WorkflowOperationOutcome,
  type WorkflowStepContext,
} from "./executors.ts";
import {
  COMMIT_RANGE_MAX_COMMITS,
  COMMIT_RANGE_MAX_FILES,
  COMMIT_RANGE_MAX_ITEM_CHARS,
  COMMIT_SYNC_RESULT_CONTRACT_ID,
  readStepResult,
  type CommitRangeChanges,
  type CommitSyncResult,
} from "./resultContracts.ts";

export interface CommitSyncOperationDependencies {
  worktree(worktreeId: string): WorktreeRow | undefined;
  mainWorktree(projectId: string): Promise<WorktreeRow | undefined>;
  commit(options: CommitWorkflowOptions): Promise<CommitWorkflowResult>;
  sync(
    row: WorktreeRow,
    operation: WorktreeSyncOperation,
    options?: { baseRemote?: string },
  ): Promise<unknown>;
  baseOid(row: WorktreeRow, options: { refresh: boolean }): Promise<string>;
  branch(cwd: string): Promise<string>;
  repositoryIdentity(cwd: string): Promise<string>;
  status(cwd: string): Promise<string>;
  commitOid(cwd: string, ref: string): Promise<string>;
  mergeBase(cwd: string, left: string, right: string): Promise<string>;
  numstat(cwd: string, base: string, head: string): Promise<string>;
  commitSubjects(cwd: string, base: string, head: string): Promise<string>;
  invalidateStatus(worktreeId: string): void;
}

const REAL_DEPENDENCIES: CommitSyncOperationDependencies = {
  worktree: getWorktree,
  mainWorktree: resolveMainWorktreeRow,
  commit: runCommitWorkflow,
  sync: syncWorktree,
  async baseOid(row, { refresh }) {
    if (refresh) return baseBranchTarget(row, { remote: "origin" });
    return (
      await git(
        [
          "rev-parse",
          "--verify",
          `refs/remotes/origin/${row.baseBranch}^{commit}`,
        ],
        row.path,
      )
    ).stdout.trim();
  },
  async branch(cwd) {
    const result = await gitOptional(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      cwd,
    );
    return result.code === 0 ? result.stdout.trim() : "";
  },
  repositoryIdentity: repoLockKey,
  async status(cwd) {
    return (
      await git(["status", "--porcelain=v1", "--untracked-files=all"], cwd)
    ).stdout;
  },
  async commitOid(cwd, ref) {
    return (
      await git(["rev-parse", "--verify", `${ref}^{commit}`], cwd)
    ).stdout.trim();
  },
  async mergeBase(cwd, left, right) {
    return (await git(["merge-base", left, right], cwd)).stdout.trim();
  },
  async numstat(cwd, base, head) {
    return (await git(["diff", "--numstat", `${base}..${head}`], cwd)).stdout;
  },
  async commitSubjects(cwd, base, head) {
    return (
      await git(["log", "--reverse", "--format=%s", `${base}..${head}`], cwd)
    ).stdout;
  },
  invalidateStatus: invalidateWorktreeStatus,
};

type OperationMode = "commit-sync" | "commit" | "base-sync";

interface ValidatedContext {
  worktree: WorktreeRow;
  mainWorktree: WorktreeRow;
  useMainCheckoutBase: boolean;
  checkpoint?: CommitSyncResult;
}

function operationId(mode: OperationMode): string {
  if (mode === "commit") return COMMIT_ONLY_OPERATION_ID;
  if (mode === "base-sync") return BASE_SYNC_OPERATION_ID;
  return COMMIT_SYNC_OPERATION_ID;
}

function idempotencyKey(
  mode: OperationMode,
  runId: number,
  predecessorId: number,
): string {
  if (mode === "commit") return commitOnlyIdempotencyKey(runId, predecessorId);
  if (mode === "base-sync") return baseSyncIdempotencyKey(runId, predecessorId);
  return commitSyncIdempotencyKey(runId, predecessorId);
}

function createOperation(
  mode: OperationMode,
  overrides: Partial<CommitSyncOperationDependencies> = {},
): WorkflowHostOperation {
  const dependencies = { ...REAL_DEPENDENCIES, ...overrides };
  return {
    id: operationId(mode),
    recoveryPolicy: "retry-safe",
    execute: (context) => executeOperation(context, dependencies, mode),
  };
}

export function createCommitSyncOperation(
  overrides: Partial<CommitSyncOperationDependencies> = {},
): WorkflowHostOperation {
  return createOperation("commit-sync", overrides);
}

export function createCommitOnlyOperation(
  overrides: Partial<CommitSyncOperationDependencies> = {},
): WorkflowHostOperation {
  return createOperation("commit", overrides);
}

export function createBaseSyncOperation(
  overrides: Partial<CommitSyncOperationDependencies> = {},
): WorkflowHostOperation {
  return createOperation("base-sync", overrides);
}

export const commitSyncOperation = createCommitSyncOperation();
export const commitOnlyOperation = createCommitOnlyOperation();
export const baseSyncOperation = createBaseSyncOperation();

export function registerCommitSyncOperationRuntime(): void {
  registerWorkflowHostOperation(commitSyncOperation);
  registerWorkflowHostOperation(commitOnlyOperation);
  registerWorkflowHostOperation(baseSyncOperation);
}

async function executeOperation(
  context: WorkflowStepContext,
  dependencies: CommitSyncOperationDependencies,
  mode: OperationMode,
): Promise<WorkflowOperationOutcome> {
  let validated: ValidatedContext;
  try {
    validated = await validateContext(context, dependencies, mode);
  } catch (err) {
    return failed(`${operationId(mode)} validation failed: ${errorText(err)}`);
  }

  const { run } = context;
  const { worktree, checkpoint } = validated;
  let previousHead: string;
  let previousBase: string;
  try {
    previousHead = await fullCommitOid(
      dependencies,
      worktree.path,
      "HEAD",
      "run HEAD before operation",
    );
    previousBase =
      checkpoint?.baseCommit ??
      (await resolvedBaseOid(validated, dependencies, false));
    if (mode === "base-sync") {
      const beforeStatus = await dependencies.status(worktree.path);
      if (beforeStatus.trim())
        return blocked(
          "base synchronization blocked: run checkout has uncommitted changes",
        );
    }
  } catch (err) {
    return failed(`initial inspection failed: ${errorText(err)}`);
  }

  if (mode !== "base-sync") {
    let commitResult: CommitWorkflowResult;
    try {
      commitResult = await dependencies.commit({
        source: "tool",
        cwd: worktree.path,
        force: false,
        additionalContext: `Workflow Run ${run.id} for Task-${run.taskId}.`,
      });
    } catch (err) {
      return failed(`commit phase failed: ${errorText(err)}`);
    } finally {
      dependencies.invalidateStatus(worktree.id);
    }
    if (
      commitResult.status !== "committed" &&
      !isNoChangesCommitResult(commitResult)
    ) {
      if (commitResult.status === "blocked")
        return blocked(
          `commit phase blocked: ${commitFailureReason(commitResult)}`,
        );
      return failed(
        `commit phase failed: ${commitFailureReason(commitResult)}`,
      );
    }
    // For a composite initial operation this is the head that synchronization
    // may rewrite; the commit itself is not a rebase rewrite.
    if (mode === "commit-sync") {
      try {
        previousHead = await fullCommitOid(
          dependencies,
          worktree.path,
          "HEAD",
          "committed run HEAD",
        );
      } catch (err) {
        return failed(`post-commit inspection failed: ${errorText(err)}`);
      }
    }
  }

  let refreshedBase: string | undefined;
  if (mode !== "commit") {
    try {
      if (validated.useMainCheckoutBase)
        await dependencies.sync(validated.mainWorktree, "pull-rebase");
      refreshedBase = await resolvedBaseOid(validated, dependencies, true);
    } catch (err) {
      return failed(`base refresh failed: ${errorText(err)}`);
    }
    if (mode === "commit-sync" || refreshedBase !== previousBase) {
      const conflict = await rebaseRun(
        worktree,
        dependencies,
        validated.useMainCheckoutBase ? undefined : "origin",
      );
      if (conflict) return conflict;
    }
  }

  let finalBranch: string;
  let finalStatus: string;
  try {
    finalBranch = await dependencies.branch(worktree.path);
    finalStatus = await dependencies.status(worktree.path);
  } catch (err) {
    return failed(`final inspection failed: ${errorText(err)}`);
  }
  if (finalBranch !== run.branch)
    return blocked(
      `final inspection blocked: run checkout is on ${branchLabel(finalBranch)}, not "${run.branch}"`,
    );
  if (finalStatus.trim())
    return blocked(
      "final inspection blocked: run checkout has uncommitted changes",
    );

  try {
    const headCommit = await fullCommitOid(
      dependencies,
      worktree.path,
      "HEAD",
      "run HEAD",
    );
    const baseCommit =
      mode === "commit"
        ? requireFullOid(checkpoint!.baseCommit, "accepted checkpoint base")
        : validated.useMainCheckoutBase
          ? await resolvedBaseOid(validated, dependencies, true)
          : requireFullOid(
              refreshedBase ?? "",
              `refreshed ${worktree.baseBranch}`,
            );
    // Resolve the checkpoint in the run repository, then prove the exact
    // checkpoint—not a mutable branch name—is still the range ancestor.
    await fullCommitOid(
      dependencies,
      worktree.path,
      baseCommit,
      "review checkpoint base",
    );
    const ancestor = requireFullOid(
      await dependencies.mergeBase(worktree.path, headCommit, baseCommit),
      "review merge base",
    );
    if (ancestor !== baseCommit)
      throw new Error(
        `checkpoint ${baseCommit} is not an ancestor of run head ${headCommit}`,
      );
    const changes = await rangeChanges(
      dependencies,
      worktree.path,
      baseCommit,
      headCommit,
    );
    const baseMoved = baseCommit !== previousBase;
    const headRewritten = mode !== "commit" && headCommit !== previousHead;
    const action =
      mode === "commit"
        ? "committed"
        : baseMoved
          ? `synchronized ${worktree.branch} to moved base`
          : `checked ${worktree.branch} against unchanged base`;
    return {
      status: "completed",
      summary: `${action}; review range ${baseCommit}..${headCommit}`,
      contractId: COMMIT_SYNC_RESULT_CONTRACT_ID,
      payload: {
        operation: mode,
        previousBaseCommit: previousBase,
        baseCommit,
        previousHeadCommit: previousHead,
        headCommit,
        baseMoved,
        headRewritten,
        ...(changes
          ? { changes: changes as unknown as WorkflowJsonValue }
          : {}),
      },
    };
  } catch (err) {
    return failed(`review range inspection failed: ${errorText(err)}`);
  }
}

async function resolvedBaseOid(
  context: ValidatedContext,
  dependencies: CommitSyncOperationDependencies,
  refresh: boolean,
): Promise<string> {
  const { worktree, mainWorktree, useMainCheckoutBase } = context;
  if (useMainCheckoutBase)
    return fullCommitOid(
      dependencies,
      mainWorktree.path,
      "HEAD",
      `${refresh ? "refreshed" : "current"} ${worktree.baseBranch}`,
    );
  return requireFullOid(
    await dependencies.baseOid(worktree, { refresh }),
    `${refresh ? "refreshed" : "current"} ${worktree.baseBranch}`,
  );
}

async function rebaseRun(
  worktree: WorktreeRow,
  dependencies: CommitSyncOperationDependencies,
  baseRemote?: string,
): Promise<WorkflowOperationOutcome | undefined> {
  try {
    await dependencies.sync(
      worktree,
      "rebase-main",
      baseRemote ? { baseRemote } : undefined,
    );
    return undefined;
  } catch (err) {
    if (err instanceof WorktreeSyncConflictError) {
      const files = [...err.conflictedFiles];
      const fileEvidence =
        files.length > 0
          ? ` Conflicted files${err.conflictedFilesTruncated ? " (list truncated)" : ""}: ${files.join(", ")}.`
          : " Git could not determine the conflicted files.";
      return blocked(
        `run rebase blocked: rebasing onto ${worktree.baseBranch} conflicted. The rebase was aborted, ${worktree.branch} was restored, and the worktree is clean.${fileEvidence}`,
        {
          rebaseConflict: {
            files,
            truncated: err.conflictedFilesTruncated,
            baseBranch: worktree.baseBranch,
            ...(err.originalHead ? { originalHead: err.originalHead } : {}),
          },
        },
      );
    }
    return failed(`run rebase failed: ${errorText(err)}`);
  }
}

async function rangeChanges(
  dependencies: CommitSyncOperationDependencies,
  cwd: string,
  baseCommit: string,
  headCommit: string,
): Promise<CommitRangeChanges | undefined> {
  let numstat: string;
  let log: string;
  try {
    [numstat, log] = await Promise.all([
      dependencies.numstat(cwd, baseCommit, headCommit),
      dependencies.commitSubjects(cwd, baseCommit, headCommit),
    ]);
  } catch {
    return undefined;
  }
  const parsed = numstat
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length >= 3 && Boolean(parts[2]?.trim()))
    .map((parts) => ({
      path: boundedItem(parts[2]!.trim()),
      insertions: Number.parseInt(parts[0]!, 10) || 0,
      deletions: Number.parseInt(parts[1]!, 10) || 0,
    }));
  const subjects = log
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(boundedItem);
  const files = parsed.slice(0, COMMIT_RANGE_MAX_FILES);
  const commitSubjects = subjects.slice(-COMMIT_RANGE_MAX_COMMITS);
  return {
    filesChanged: parsed.length,
    insertions: parsed.reduce((sum, file) => sum + file.insertions, 0),
    deletions: parsed.reduce((sum, file) => sum + file.deletions, 0),
    files,
    commitSubjects,
    ...(files.length < parsed.length || commitSubjects.length < subjects.length
      ? { truncated: true }
      : {}),
  };
}

function boundedItem(value: string): string {
  return value.length > COMMIT_RANGE_MAX_ITEM_CHARS
    ? `${[...value].slice(0, COMMIT_RANGE_MAX_ITEM_CHARS).join("")}…`
    : value;
}

async function validateContext(
  { run, step, predecessors = [] }: WorkflowStepContext,
  dependencies: CommitSyncOperationDependencies,
  mode: OperationMode,
): Promise<ValidatedContext> {
  const expectedOperation = operationId(mode);
  const payload = record(step.payload);
  const key = payload.idempotencyKey;
  if (
    step.kind !== "host-operation" ||
    payload.operation !== expectedOperation ||
    typeof key !== "string" ||
    !key.trim()
  )
    throw new Error(
      `step ${step.id} is not a valid ${expectedOperation} reservation`,
    );
  if (step.predecessorId === undefined)
    throw new Error(`step ${step.id} has no predecessor`);
  const expectedKey = idempotencyKey(mode, run.id, step.predecessorId);
  if (
    key !== expectedKey &&
    !matchesSemanticRetryChain(run.id, step, key, predecessors, mode)
  )
    throw new Error(
      `step ${step.id} has idempotency key "${key}", expected "${expectedKey}" or a valid failed/blocked ${expectedOperation} retry chain`,
    );

  if (!run.worktreeId || !run.branch || !run.projectId)
    throw new Error(
      `workflow run ${run.id} is missing its worktree, branch, or Project`,
    );
  const worktree = dependencies.worktree(run.worktreeId);
  if (!worktree)
    throw new Error(`run worktree ${run.worktreeId} does not exist`);
  if (worktree.status !== "active")
    throw new Error(`run worktree ${run.worktreeId} is ${worktree.status}`);
  if (worktree.projectId !== run.projectId)
    throw new Error(
      `run worktree ${run.worktreeId} belongs to Project ${worktree.projectId}, not ${run.projectId}`,
    );
  if (worktree.branch !== run.branch)
    throw new Error(
      `run worktree ${run.worktreeId} records branch "${worktree.branch}", not "${run.branch}"`,
    );
  const actualRunBranch = await dependencies.branch(worktree.path);
  if (actualRunBranch !== run.branch)
    throw new Error(
      `run checkout is on ${branchLabel(actualRunBranch)}, not "${run.branch}"`,
    );

  const mainWorktree = await dependencies.mainWorktree(run.projectId);
  if (!mainWorktree)
    throw new Error(
      `Project ${run.projectId}'s main checkout could not be resolved`,
    );
  if (
    mainWorktree.status !== "active" ||
    mainWorktree.projectId !== run.projectId
  )
    throw new Error(
      `resolved main checkout does not belong to active Project ${run.projectId}`,
    );
  const useMainCheckoutBase = mainWorktree.branch === worktree.baseBranch;
  if (
    !useMainCheckoutBase &&
    mainWorktree.mainRepoRoot !== worktree.mainRepoRoot
  )
    throw new Error(
      `Project ${run.projectId}'s main checkout points at a different repository than the run worktree`,
    );
  if (useMainCheckoutBase) {
    const [runRepository, mainRepository] = await Promise.all([
      dependencies.repositoryIdentity(worktree.path),
      dependencies.repositoryIdentity(mainWorktree.path),
    ]);
    if (!runRepository || !mainRepository || runRepository !== mainRepository)
      throw new Error(
        `Project ${run.projectId}'s main checkout points at a different repository than the run worktree`,
      );
    const actualMainBranch = await dependencies.branch(mainWorktree.path);
    if (actualMainBranch !== worktree.baseBranch)
      throw new Error(
        `main checkout is on ${branchLabel(actualMainBranch)}, not the run's base branch "${worktree.baseBranch}"`,
      );
  }

  const checkpoint = latestCheckpoint(predecessors);
  if (mode !== "commit-sync" && !checkpoint)
    throw new Error(
      `${expectedOperation} requires an accepted synchronization checkpoint`,
    );
  return {
    worktree,
    mainWorktree,
    useMainCheckoutBase,
    ...(checkpoint ? { checkpoint } : {}),
  };
}

function latestCheckpoint(
  predecessors: readonly WorkflowStepContext["step"][],
): CommitSyncResult | undefined {
  for (const step of predecessors) {
    const result = readStepResult(step, COMMIT_SYNC_RESULT_CONTRACT_ID);
    if (!result) continue;
    const operation = record(step.payload).operation;
    if (
      result.operation === "commit-sync" ||
      result.operation === "base-sync" ||
      operation === COMMIT_SYNC_OPERATION_ID ||
      operation === BASE_SYNC_OPERATION_ID
    )
      return result;
  }
  return undefined;
}

function matchesSemanticRetryChain(
  runId: number,
  step: WorkflowStepContext["step"],
  key: string,
  predecessors: readonly WorkflowStepContext["step"][],
  mode: OperationMode,
): boolean {
  let successor = step;
  const expectedOperation = operationId(mode);
  for (const predecessor of predecessors) {
    if (
      successor.predecessorId !== predecessor.id ||
      predecessor.runId !== runId
    )
      return false;
    const payload = record(predecessor.payload);
    if (
      predecessor.kind === "host-operation" &&
      payload.operation === expectedOperation
    ) {
      if (
        (predecessor.status !== "failed" && predecessor.status !== "blocked") ||
        payload.idempotencyKey !== key
      )
        return false;
      successor = predecessor;
      continue;
    }
    if (key !== idempotencyKey(mode, runId, predecessor.id)) return false;
    return (
      predecessor.status === "completed" ||
      ((predecessor.status === "failed" || predecessor.status === "blocked") &&
        mode !== "commit" &&
        repairRebasePayloadOf(predecessor) !== undefined)
    );
  }
  return false;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function branchLabel(branch: string): string {
  return branch ? `"${branch}"` : "a detached HEAD";
}

function requireFullOid(value: string, label: string): string {
  const oid = value.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid))
    throw new Error(`${label} did not resolve to a full commit oid`);
  return oid;
}

async function fullCommitOid(
  dependencies: CommitSyncOperationDependencies,
  cwd: string,
  ref: string,
  label: string,
): Promise<string> {
  return requireFullOid(await dependencies.commitOid(cwd, ref), label);
}

function commitFailureReason(result: CommitWorkflowResult): string {
  const reasons = [
    ...result.blockers.map((item) => item.reason),
    ...(result.error ? [result.error] : []),
  ].filter((item, index, all) => item && all.indexOf(item) === index);
  return boundedSummary(
    reasons.join("; ") || `commit returned ${result.status}`,
  );
}

function boundedSummary(summary: string): string {
  const compact = summary.replace(/\s+/g, " ").trim();
  return compact.length <= 1_500 ? compact : `${compact.slice(0, 1_497)}...`;
}

function blocked(
  summary: string,
  payload?: WorkflowJsonValue,
): WorkflowOperationOutcome {
  return {
    status: "blocked",
    summary: boundedSummary(summary),
    ...(payload !== undefined ? { payload } : {}),
  };
}

function failed(summary: string): WorkflowOperationOutcome {
  return { status: "failed", summary: boundedSummary(summary) };
}
