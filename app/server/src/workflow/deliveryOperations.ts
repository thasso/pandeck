import {
  WORKFLOW_CI_BOUNDS,
  WORKFLOW_CI_DEFAULTS,
  type Patch,
  type PullRequestCard,
  type WorkflowJsonValue,
} from "@assistant/shared";
import { randomUUID } from "node:crypto";
import { sessionStore } from "../db/sessionStore.ts";
import { getWorktree, type WorktreeRow } from "../db/worktreeStore.ts";
import { errorText } from "../errors.ts";
import { git, gitOptional } from "../gitExec.ts";
import {
  hostingProviderForRepo,
  type GitHostingProvider,
  type GitHostingRefChecks,
} from "../gitHosting.ts";
import {
  patchPullRequestCard,
  pullRequestCardById,
  pullRequestCardsForWorktree,
  type PullRequestCardContext,
} from "../pullRequestCards.ts";
import { scheduleImmediatePoll } from "../pullRequestWatcher.ts";
import {
  beginPullRequestCard,
  finalizePullRequestCard,
  type BeginPullRequestCardInput,
  type BeginPullRequestCardResult,
} from "../prWorkflow.ts";
import {
  readRemoteBranchOid,
  resolvePushTarget,
  runPushWorkflow,
  type PushWorkflowOptions,
  type PushWorkflowResult,
} from "../pushWorkflow.ts";
import {
  CI_OBSERVATION_OPERATION_ID,
  DELIVERY_GATE_OPERATION_ID,
  operationIdempotencyKey,
  PUBLISH_PULL_REQUEST_OPERATION_ID,
} from "./codeDeliveryRecipe.ts";
import {
  registerWorkflowHostOperation,
  type WorkflowHostOperation,
  type WorkflowOperationOutcome,
  type WorkflowStepContext,
} from "./executors.ts";
import {
  CI_OBSERVATION_RESULT_CONTRACT_ID,
  COMMIT_SYNC_RESULT_CONTRACT_ID,
  DELIVERY_GATE_RESULT_CONTRACT_ID,
  PUBLISH_PULL_REQUEST_RESULT_CONTRACT_ID,
  readStepResult,
  type DeliveryGateResult,
  type WorkflowCiCheckResult,
  type WorkflowCiResult,
} from "./resultContracts.ts";

interface DeliveryInspectionDependencies {
  worktree(worktreeId: string): WorktreeRow | undefined;
  branch(cwd: string): Promise<string>;
  status(cwd: string): Promise<string>;
  head(cwd: string): Promise<string>;
}

export interface PublishPullRequestDependencies extends DeliveryInspectionDependencies {
  push(options: PushWorkflowOptions): Promise<PushWorkflowResult>;
  /** The derived push remote and one branch's exact current remote oid. */
  remoteBranch(
    cwd: string,
    branch: string,
  ): Promise<{ remote: string; oid: string | undefined }>;
  /** Every card created for one managed worktree. */
  cards(worktreeId: string): PullRequestCard[];
  card(id: string): PullRequestCard | undefined;
  finalizeCard(cardId: string, taskId: string): Promise<PullRequestCard>;
  beginCard(
    input: BeginPullRequestCardInput,
  ): Promise<BeginPullRequestCardResult>;
  provider(cwd: string): Promise<GitHostingProvider | null>;
  updateCard(
    cardId: string,
    patch: Patch<PullRequestCard>,
    context?: Patch<PullRequestCardContext>,
  ): PullRequestCard;
  /** Ask the live-card watcher to poll this card on its next sweep. */
  schedulePoll(cardId: string): void;
}

export interface CiObservationDependencies extends DeliveryInspectionDependencies {
  push(options: PushWorkflowOptions): Promise<PushWorkflowResult>;
  /** The derived push remote and one branch's exact current remote oid. */
  remoteBranch(
    cwd: string,
    branch: string,
  ): Promise<{ remote: string; oid: string | undefined }>;
  /** Every card created for one managed worktree. */
  cards(worktreeId: string): PullRequestCard[];
  card(id: string): PullRequestCard | undefined;
  finalizeCard(cardId: string, taskId: string): Promise<PullRequestCard>;
  beginCard(
    input: BeginPullRequestCardInput,
  ): Promise<BeginPullRequestCardResult>;
  provider(cwd: string): Promise<GitHostingProvider | null>;
  session(context: WorkflowStepContext): ReturnType<typeof publicationSession>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

const INSPECTION_DEPENDENCIES: DeliveryInspectionDependencies = {
  worktree: getWorktree,
  async branch(cwd) {
    const result = await gitOptional(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      cwd,
    );
    return result.code === 0 ? result.stdout.trim() : "";
  },
  async status(cwd) {
    return (
      await git(["status", "--porcelain=v1", "--untracked-files=all"], cwd)
    ).stdout;
  },
  async head(cwd) {
    return (
      await git(["rev-parse", "--verify", "HEAD^{commit}"], cwd)
    ).stdout.trim();
  },
};

async function remoteBranchTip(
  cwd: string,
  branch: string,
): Promise<{ remote: string; oid: string | undefined }> {
  const target = await resolvePushTarget(cwd, branch);
  const oid = await readRemoteBranchOid(target.repoRoot, target.remote, branch);
  return { remote: target.remote, oid };
}

const PUBLISH_DEPENDENCIES: PublishPullRequestDependencies = {
  ...INSPECTION_DEPENDENCIES,
  push: runPushWorkflow,
  remoteBranch: remoteBranchTip,
  cards: pullRequestCardsForWorktree,
  card: pullRequestCardById,
  finalizeCard: (cardId, taskId) => finalizePullRequestCard(cardId, taskId),
  beginCard: beginPullRequestCard,
  provider: hostingProviderForRepo,
  updateCard: (cardId, patch, context) =>
    patchPullRequestCard(cardId, patch, context),
  schedulePoll: scheduleImmediatePoll,
};

const CI_OBSERVATION_DEPENDENCIES: CiObservationDependencies = {
  ...INSPECTION_DEPENDENCIES,
  push: runPushWorkflow,
  remoteBranch: remoteBranchTip,
  cards: pullRequestCardsForWorktree,
  card: pullRequestCardById,
  finalizeCard: (cardId, taskId) => finalizePullRequestCard(cardId, taskId),
  beginCard: beginPullRequestCard,
  provider: hostingProviderForRepo,
  session: publicationSession,
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

interface ValidatedDelivery {
  worktree: WorktreeRow;
  reviewedHeadCommit: string;
}

interface DeliveryInspection {
  result: DeliveryGateResult;
  worktree: WorktreeRow;
}

export function createCiObservationOperation(
  overrides: Partial<CiObservationDependencies> = {},
): WorkflowHostOperation {
  const dependencies = { ...CI_OBSERVATION_DEPENDENCIES, ...overrides };
  return {
    id: CI_OBSERVATION_OPERATION_ID,
    recoveryPolicy: "retry-safe",
    execute: (context) => observeCi(context, dependencies),
  };
}

export function createDeliveryGateOperation(
  overrides: Partial<DeliveryInspectionDependencies> = {},
): WorkflowHostOperation {
  const dependencies = { ...INSPECTION_DEPENDENCIES, ...overrides };
  return {
    id: DELIVERY_GATE_OPERATION_ID,
    recoveryPolicy: "retry-safe",
    execute: async (context) => {
      try {
        const inspected = await inspectDelivery(
          context,
          DELIVERY_GATE_OPERATION_ID,
          dependencies,
        );
        return {
          status: "completed",
          summary:
            inspected.result.outcome === "ready"
              ? `delivery gate passed at ${inspected.result.reviewedHeadCommit}`
              : inspected.result.reason,
          contractId: DELIVERY_GATE_RESULT_CONTRACT_ID,
          payload: inspected.result,
        };
      } catch (err) {
        return failed(`delivery gate failed: ${errorText(err)}`);
      }
    },
  };
}

export function createPublishPullRequestOperation(
  overrides: Partial<PublishPullRequestDependencies> = {},
): WorkflowHostOperation {
  const dependencies = { ...PUBLISH_DEPENDENCIES, ...overrides };
  return {
    id: PUBLISH_PULL_REQUEST_OPERATION_ID,
    // Push is convergent, PR creation reserves a durable card before the
    // provider call, and finalize observes the branch before creating. A retry
    // therefore adopts the landed side effect instead of duplicating it.
    recoveryPolicy: "retry-safe",
    execute: (context) => publishPullRequest(context, dependencies),
  };
}

export const ciObservationOperation = createCiObservationOperation();
export const deliveryGateOperation = createDeliveryGateOperation();
export const publishPullRequestOperation = createPublishPullRequestOperation();

export function registerDeliveryOperationsRuntime(): void {
  registerWorkflowHostOperation(ciObservationOperation);
  registerWorkflowHostOperation(deliveryGateOperation);
  registerWorkflowHostOperation(publishPullRequestOperation);
}

const CI_MAX_CHECKS = 10;
const CI_EXCERPT_MAX_CHARS = 500;

async function observeCi(
  context: WorkflowStepContext,
  dependencies: CiObservationDependencies,
): Promise<WorkflowOperationOutcome> {
  const payload = record(context.step.payload);
  const headCommit = payload.reviewedHeadCommit;
  const idempotencyKey = payload.idempotencyKey;
  if (
    context.step.kind !== "host-operation" ||
    payload.operation !== CI_OBSERVATION_OPERATION_ID ||
    typeof headCommit !== "string" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(headCommit) ||
    typeof idempotencyKey !== "string" ||
    !validReservation(context, CI_OBSERVATION_OPERATION_ID, idempotencyKey)
  )
    return failed(
      `CI observation validation failed: step ${context.step.id} is not a valid ${CI_OBSERVATION_OPERATION_ID} reservation`,
    );
  if (!context.run.worktreeId || !context.run.branch)
    return failed(
      `CI observation validation failed: workflow run ${context.run.id} is missing its worktree or branch`,
    );
  const worktree = dependencies.worktree(context.run.worktreeId);
  if (!worktree || worktree.status !== "active")
    return failed(
      `CI observation validation failed: run worktree ${context.run.worktreeId} is missing or inactive`,
    );
  if (worktree.branch !== context.run.branch)
    return blocked(
      `CI observation blocked: run worktree records branch "${worktree.branch}", not "${context.run.branch}"`,
    );

  try {
    const [branch, status, observedHead] = await Promise.all([
      dependencies.branch(worktree.path),
      dependencies.status(worktree.path),
      dependencies.head(worktree.path),
    ]);
    if (branch !== context.run.branch)
      return blocked(
        `CI observation blocked: run checkout is on ${branch ? `"${branch}"` : "a detached HEAD"}, not "${context.run.branch}"`,
      );
    if (status.trim())
      return blocked(
        "CI observation blocked: run checkout has uncommitted changes after commit/sync",
      );
    if (observedHead !== headCommit)
      return blocked(
        `CI observation blocked: local run head ${observedHead} does not equal commit/sync head ${headCommit}`,
      );

    const provider = await dependencies.provider(worktree.path);
    if (!provider)
      return ciOutcome({
        outcome: "none",
        headCommit,
        checks: [],
        reason:
          "No configured git hosting provider/remote is available; the run branch was not pushed.",
      });
    const push = await dependencies.push({
      cwd: worktree.path,
      branch: context.run.branch,
      force: false,
    });
    if (push.status === "failed") {
      const recovery = await recoverRunBranchPush(
        context,
        worktree,
        context.run.branch,
        headCommit,
        dependencies,
      );
      if (!recovery.recovered)
        return failed(
          `early run-branch push failed: ${push.error || push.output || "git push failed"}${
            recovery.reason ? ` — ${recovery.reason}` : ""
          }`,
        );
    }

    await ensureDraftCard(context, worktree, dependencies);

    const config = record(context.run.config);
    const timeoutMs = ciTiming(
      config.ciTimeoutMs,
      WORKFLOW_CI_DEFAULTS.timeoutMs,
      WORKFLOW_CI_BOUNDS.timeoutMs,
    );
    const pollIntervalMs = ciTiming(
      config.ciPollIntervalMs,
      WORKFLOW_CI_DEFAULTS.pollIntervalMs,
      WORKFLOW_CI_BOUNDS.pollIntervalMs,
    );
    const startedAt = dependencies.now();
    let latest: GitHostingRefChecks = { state: "none", checks: [] };
    while (true) {
      latest = await provider.refChecks(headCommit);
      if (latest.state === "success")
        return ciOutcome({
          outcome: "green",
          headCommit,
          checks: boundedChecks(latest.checks),
          ...(latest.checks.length > CI_MAX_CHECKS ? { truncated: true } : {}),
        });
      if (latest.state === "failure")
        return ciOutcome({
          outcome: "red",
          headCommit,
          checks: boundedChecks(latest.checks),
          ...(latest.checks.length > CI_MAX_CHECKS ? { truncated: true } : {}),
          reason: "One or more CI checks failed.",
        });
      const elapsed = dependencies.now() - startedAt;
      if (elapsed >= timeoutMs)
        return latest.state === "none"
          ? ciOutcome({
              outcome: "none",
              headCommit,
              checks: [],
              reason: "No CI checks appeared for the pushed commit.",
            })
          : ciOutcome({
              outcome: "timeout",
              headCommit,
              checks: boundedChecks(latest.checks),
              ...(latest.checks.length > CI_MAX_CHECKS
                ? { truncated: true }
                : {}),
              reason: `CI did not settle within ${timeoutMs}ms.`,
            });
      await dependencies.sleep(Math.min(pollIntervalMs, timeoutMs - elapsed));
    }
  } catch (err) {
    return failed(`CI observation failed: ${errorText(err)}`);
  }
}

/**
 * Commit-sync rebases the run branch onto its refreshed base, so after the
 * base moves the early push is a non-fast-forward over commits this run itself
 * pushed earlier. That one case is recoverable without a human: the remote tip
 * must be a head a prior completed commit-sync or CI observation of THIS run
 * recorded, and the overwrite is leased on that exact oid so a write from
 * anyone else refuses instead of being destroyed. An unrecognized remote tip,
 * an unreachable remote, or a lost lease race keeps the ordinary failure.
 */
interface RunBranchPushRecovery {
  recovered: boolean;
  reason?: string;
}

async function recoverRunBranchPush(
  context: WorkflowStepContext,
  worktree: WorktreeRow,
  branch: string,
  headCommit: string,
  dependencies: Pick<CiObservationDependencies, "push" | "remoteBranch">,
): Promise<RunBranchPushRecovery> {
  let remote: string;
  let remoteOid: string | undefined;
  try {
    ({ remote, oid: remoteOid } = await dependencies.remoteBranch(
      worktree.path,
      branch,
    ));
  } catch {
    return { recovered: false };
  }
  if (!remoteOid) return { recovered: false };
  if (remoteOid === headCommit) return { recovered: true };
  if (!recordedRunHeads(context).has(remoteOid))
    return {
      recovered: false,
      reason: `the remote branch points at ${remoteOid}, a commit this run never recorded, so the workflow refuses to overwrite it`,
    };
  // The managed explicit-lease shape: the push seam itself re-checks the
  // checked-out branch, exact local HEAD, and cleanliness, and refuses a
  // `branch` argument, so the overwrite carries every local precondition the
  // caller just verified.
  const lease = await dependencies.push({
    cwd: worktree.path,
    remote,
    expectedBranch: branch,
    expectedHead: headCommit,
    requireClean: true,
    explicitLease: { expectedRemoteOid: remoteOid },
  });
  return lease.status === "failed"
    ? { recovered: false, reason: lease.error || lease.output }
    : { recovered: true };
}

/** Every head this run recorded through completed commit-sync/CI steps. */
function recordedRunHeads(context: WorkflowStepContext): Set<string> {
  const heads = new Set<string>();
  for (const step of context.predecessors ?? []) {
    const range = readStepResult(step, COMMIT_SYNC_RESULT_CONTRACT_ID);
    if (range) heads.add(range.headCommit);
    const observation = readStepResult(step, CI_OBSERVATION_RESULT_CONTRACT_ID);
    if (observation) heads.add(observation.headCommit);
  }
  return heads;
}

async function ensureDraftCard(
  context: WorkflowStepContext,
  worktree: WorktreeRow,
  dependencies: CiObservationDependencies,
): Promise<PullRequestCard> {
  let card = matchingLiveCard(dependencies.cards(worktree.id), worktree);
  if (card?.status === "choosing-task" || card?.status === "creating")
    card = await dependencies.finalizeCard(card.id, String(context.run.taskId));
  if (!card) {
    const session = dependencies.session(context);
    const result = await dependencies.beginCard({
      repoRoot: worktree.path,
      sessionKind: session.agentType,
      sessionId: session.id,
      args: {
        draft: true,
        force: false,
        forceCommit: false,
        base: worktree.baseBranch,
        additionalContext: `Workflow Run ${context.run.id} for Task-${context.run.taskId}.`,
      },
      taskId: String(context.run.taskId),
    });
    card = dependencies.card(result.cardId);
    if (result.status === "failed") throw new Error(result.summary);
    if (result.status === "choosing-task")
      throw new Error(
        "workflow draft PR creation unexpectedly requires a Task choice",
      );
  }
  if (!card || !card.provider || card.number === undefined || !card.url)
    throw new Error(
      "draft pull request service did not produce a usable live card",
    );
  return card;
}

function ciTiming(
  value: unknown,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(bounds.max, Math.max(bounds.min, Math.round(value)))
    : fallback;
}

function boundedChecks(
  checks: GitHostingRefChecks["checks"],
): WorkflowCiCheckResult[] {
  return checks.slice(0, CI_MAX_CHECKS).map((check) => ({
    name: clip(check.name, 300),
    status: clip(check.status, 100),
    ...(check.url ? { url: clip(check.url, 500) } : {}),
    ...(check.excerpt
      ? { excerpt: clip(check.excerpt, CI_EXCERPT_MAX_CHARS) }
      : {}),
  }));
}

function clip(value: string, max: number): string {
  const text = value.trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function ciOutcome(result: WorkflowCiResult): WorkflowOperationOutcome {
  return {
    status: "completed",
    summary:
      result.outcome === "green"
        ? `CI passed for ${result.headCommit}`
        : result.outcome === "red"
          ? `CI failed for ${result.headCommit}`
          : `CI ${result.outcome} for ${result.headCommit}: ${result.reason ?? "no details"}`,
    contractId: CI_OBSERVATION_RESULT_CONTRACT_ID,
    payload: result as unknown as WorkflowJsonValue,
  };
}

async function publishPullRequest(
  context: WorkflowStepContext,
  dependencies: PublishPullRequestDependencies,
): Promise<WorkflowOperationOutcome> {
  let inspected: DeliveryInspection;
  try {
    // Repeat the gate immediately before outward side effects. The persisted
    // gate step proves the intended transition; this closes the gap between
    // that step and publication if a role session changed the checkout.
    inspected = await inspectDelivery(
      context,
      PUBLISH_PULL_REQUEST_OPERATION_ID,
      dependencies,
    );
  } catch (err) {
    return failed(`publication validation failed: ${errorText(err)}`);
  }
  if (inspected.result.outcome === "review-required") {
    return {
      status: "completed",
      summary: inspected.result.reason,
      contractId: PUBLISH_PULL_REQUEST_RESULT_CONTRACT_ID,
      payload: inspected.result,
    };
  }

  const { run } = context;
  const { worktree } = inspected;
  const reviewedHeadCommit = inspected.result.reviewedHeadCommit;
  let card = matchingLiveCard(dependencies.cards(worktree.id), worktree);

  try {
    const push = await dependencies.push({
      cwd: worktree.path,
      force: false,
    });
    if (push.status === "failed") {
      const recovery: RunBranchPushRecovery = run.branch
        ? await recoverRunBranchPush(
            context,
            worktree,
            run.branch,
            reviewedHeadCommit,
            dependencies,
          )
        : { recovered: false };
      if (!recovery.recovered)
        return failed(
          `push failed: ${push.error || push.output || "git push failed"}${
            recovery.reason ? ` — ${recovery.reason}` : ""
          }`,
        );
    }

    if (card?.status === "choosing-task" || card?.status === "creating")
      card = await dependencies.finalizeCard(card.id, String(run.taskId));

    if (!card) {
      const session = publicationSession(context);
      const result = await dependencies.beginCard({
        repoRoot: worktree.path,
        sessionKind: session.agentType,
        sessionId: session.id,
        args: {
          draft: false,
          force: false,
          forceCommit: false,
          base: worktree.baseBranch,
          additionalContext: `Workflow Run ${run.id} for Task-${run.taskId}.`,
        },
        taskId: String(run.taskId),
      });
      card = dependencies.card(result.cardId);
      if (result.status === "failed") return failed(result.summary);
      if (result.status === "choosing-task")
        return failed(
          "workflow PR creation unexpectedly requires a Task choice",
        );
    }

    if (!card || !card.provider || card.number === undefined || !card.url)
      return failed("pull request service did not produce a usable live card");

    const provider = await dependencies.provider(worktree.path);
    if (!provider)
      return failed(
        "no git hosting provider is configured for the run repository",
      );
    if (provider.kind !== card.provider)
      return failed(
        `live PR card provider ${card.provider} does not match repository provider ${provider.kind}`,
      );
    const detail = await provider.pullRequestDetail(card.number);
    if (!detail)
      return failed(
        `provider returned no detail for pull request #${card.number}`,
      );
    if (detail.headSha !== reviewedHeadCommit)
      return blocked(
        `pull request #${card.number} head ${detail.headSha} does not equal reviewed head ${reviewedHeadCommit}`,
      );
    if (detail.headBranch !== run.branch)
      return blocked(
        `pull request #${card.number} uses head branch "${detail.headBranch}", not run branch "${run.branch}"`,
      );
    if (detail.baseBranch !== worktree.baseBranch)
      return blocked(
        `pull request #${card.number} targets "${detail.baseBranch}", not run base "${worktree.baseBranch}"`,
      );

    let publishedDetail = detail;
    let cardPatch: Patch<PullRequestCard> = {};
    if (card.draft || detail.draft) {
      const ready = await provider.markPullRequestReady(card.number);
      // Mergeability observed while the pull request was a DRAFT is not an
      // answer: Forgejo reports every WIP pull request as not mergeable, and a
      // card still carrying that value is what the observation wait consumes
      // half a second from here — as a terminal base conflict that pauses the
      // run (Task 535). So re-read it now that the PR is reviewable, and let
      // "unknown" stand where the re-read fails or has not settled: `conflicts`
      // is a CONFIRMED conflict, and nothing has confirmed one here.
      publishedDetail =
        (await provider.pullRequestDetail(card.number).catch(() => null)) ??
        detail;
      cardPatch = {
        draft: undefined,
        mergeable: publishedDetail.mergeable,
        conflicts: undefined,
        ...(ready.title ? { title: ready.title } : {}),
      };
    }
    if (publishedDetail.headSha !== reviewedHeadCommit)
      return blocked(
        `pull request #${card.number} head ${publishedDetail.headSha} does not equal reviewed head ${reviewedHeadCommit} after publication`,
      );
    card = dependencies.updateCard(card.id, cardPatch, {
      // Publication starts a NEWER observation episode even for an already
      // reviewable PR. A watcher may have read the previous head before the
      // push; invalidate that response, and make the exact provider head just
      // verified above the snapshot the immediately armed wait consumes.
      observationToken: randomUUID(),
      observedHeadSha: publishedDetail.headSha,
    });
    // The wait this operation arms is blocked on the card, and the card only
    // changes when the watcher polls it: without this the first post-publish
    // observation could be a slow-cadence poll away.
    dependencies.schedulePoll(card.id);

    return {
      status: "completed",
      summary: `published reviewed head ${reviewedHeadCommit} as pull request #${card.number}`,
      contractId: PUBLISH_PULL_REQUEST_RESULT_CONTRACT_ID,
      payload: {
        outcome: "published",
        reviewedHeadCommit,
        cardId: card.id,
        sessionId: card.sessionId,
        provider: card.provider!,
        number: card.number!,
        url: card.url!,
      } as WorkflowJsonValue,
    };
  } catch (err) {
    return failed(`pull request publication failed: ${errorText(err)}`);
  }
}

async function inspectDelivery(
  context: WorkflowStepContext,
  operationId: string,
  dependencies: DeliveryInspectionDependencies,
): Promise<DeliveryInspection> {
  const validated = validateDeliveryContext(context, operationId, dependencies);
  const { worktree, reviewedHeadCommit } = await validated;
  const branch = await dependencies.branch(worktree.path);
  if (branch !== context.run.branch)
    throw new Error(
      `run checkout is on ${branch ? `"${branch}"` : "a detached HEAD"}, not "${context.run.branch}"`,
    );
  const [status, observedHeadCommit] = await Promise.all([
    dependencies.status(worktree.path),
    dependencies.head(worktree.path),
  ]);
  const reasons: string[] = [];
  const worktreeDirty = Boolean(status.trim());
  if (worktreeDirty) reasons.push("the run worktree has uncommitted changes");
  if (observedHeadCommit !== reviewedHeadCommit)
    reasons.push(
      `local HEAD ${observedHeadCommit} differs from reviewed head ${reviewedHeadCommit}`,
    );
  return {
    worktree,
    result:
      reasons.length === 0
        ? { outcome: "ready", reviewedHeadCommit }
        : {
            outcome: "review-required",
            reviewedHeadCommit,
            observedHeadCommit,
            worktreeDirty,
            reason: `${reasons.join("; ")}; commit/sync and review are required again`,
          },
  };
}

async function validateDeliveryContext(
  context: WorkflowStepContext,
  operationId: string,
  dependencies: DeliveryInspectionDependencies,
): Promise<ValidatedDelivery> {
  const payload = record(context.step.payload);
  const reviewedHeadCommit = payload.reviewedHeadCommit;
  const idempotencyKey = payload.idempotencyKey;
  if (
    context.step.kind !== "host-operation" ||
    payload.operation !== operationId ||
    typeof reviewedHeadCommit !== "string" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(reviewedHeadCommit) ||
    typeof idempotencyKey !== "string" ||
    !validReservation(context, operationId, idempotencyKey)
  )
    throw new Error(
      `step ${context.step.id} is not a valid ${operationId} reservation`,
    );
  if (!context.run.worktreeId || !context.run.branch)
    throw new Error(
      `workflow run ${context.run.id} is missing its worktree or branch`,
    );
  const worktree = dependencies.worktree(context.run.worktreeId);
  if (!worktree)
    throw new Error(`run worktree ${context.run.worktreeId} does not exist`);
  if (worktree.status !== "active")
    throw new Error(
      `run worktree ${context.run.worktreeId} is ${worktree.status}`,
    );
  if (worktree.branch !== context.run.branch)
    throw new Error(
      `run worktree records branch "${worktree.branch}", not "${context.run.branch}"`,
    );
  if (context.run.projectId && worktree.projectId !== context.run.projectId)
    throw new Error(
      `run worktree belongs to Project ${worktree.projectId}, not ${context.run.projectId}`,
    );
  return { worktree, reviewedHeadCommit };
}

function validReservation(
  context: WorkflowStepContext,
  operationId: string,
  key: string,
): boolean {
  const predecessorId = context.step.predecessorId;
  if (predecessorId === undefined) return false;
  if (
    key === operationIdempotencyKey(context.run.id, operationId, predecessorId)
  )
    return true;

  let successor = context.step;
  for (const predecessor of context.predecessors ?? []) {
    if (
      successor.predecessorId !== predecessor.id ||
      predecessor.runId !== context.run.id
    )
      return false;
    const payload = record(predecessor.payload);
    if (payload.operation === operationId) {
      if (
        (predecessor.status !== "failed" && predecessor.status !== "blocked") ||
        payload.idempotencyKey !== key
      )
        return false;
      successor = predecessor;
      continue;
    }
    return (
      key ===
      operationIdempotencyKey(context.run.id, operationId, predecessor.id)
    );
  }
  return false;
}

function publicationSession(context: WorkflowStepContext) {
  for (const step of context.predecessors ?? []) {
    const payload = record(step.payload);
    if (
      step.kind === "agent" &&
      payload.role === "implementer" &&
      step.executor?.kind === "session"
    ) {
      const session = sessionStore.get(step.executor.id);
      if (session) return session;
    }
  }
  throw new Error(
    "workflow has no surviving implementer session for its live PR card",
  );
}

function matchingLiveCard(
  cards: PullRequestCard[],
  worktree: WorktreeRow,
): PullRequestCard | undefined {
  return cards
    .filter(
      (card) =>
        card.worktreeId === worktree.id &&
        card.headBranch === worktree.branch &&
        card.baseBranch === worktree.baseBranch &&
        card.status !== "failed",
    )
    .sort((left, right) => right.createdAt - left.createdAt)[0];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function bounded(summary: string): string {
  const compact = summary.replace(/\s+/g, " ").trim();
  return compact.length <= 1_500 ? compact : `${compact.slice(0, 1_497)}...`;
}

function blocked(summary: string): WorkflowOperationOutcome {
  return { status: "blocked", summary: bounded(summary) };
}

function failed(summary: string): WorkflowOperationOutcome {
  return { status: "failed", summary: bounded(summary) };
}
