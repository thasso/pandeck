/**
 * `worktree_finish_pull_request` — the last managed delivery step (Task 588):
 * merge the exact managed pull request, or close it without merging.
 *
 * The tool never accepts an object to act on. It accepts a worktree id and a
 * verb; the SERVER derives the repository, provider, pull request, head, base
 * and default branch, and revalidates every one of them immediately before the
 * outward transition. Merging additionally re-runs the shared readiness read
 * (`tools/pullRequestCheckWatch.ts`) rather than trusting anything a previous
 * turn reported, and refuses a method the repository does not currently allow.
 *
 * The human boundary is the DEFAULT branch: a ready pull request into a
 * non-default base merges directly, while one into the provider-reported
 * default branch only ever stages an approval — the tool call itself performs
 * no provider merge at all, and the approval re-derives the complete state
 * before it merges through the same seam.
 *
 * Closing is direct for either base: it abandons the work rather than landing
 * it, so it requires an explicit reason (audited on the card and in the result)
 * and keeps the branch, the worktree and the linked Task exactly as they are.
 */
import { randomUUID } from "node:crypto";
import type {
  ApprovalCard,
  ManagedPullRequestMergeApprovalBody,
  PullRequestCard,
  PullRequestMergeMethod,
  PullRequestRepositoryCapabilities,
  TaskSummary,
} from "@assistant/shared";
import { PULL_REQUEST_MERGE_METHODS } from "@assistant/shared";
import {
  getWorktree,
  taskIdsForWorktree,
  type WorktreeRow,
} from "../../db/worktreeStore.ts";
import {
  defineAgentTool,
  jsonResult,
  type AgentTool,
  type ToolCallContext,
} from "../../mcp/tool.ts";
import {
  approvalCardReference,
  createApproval,
  registerApprovalExecutor,
  type ApprovalExecutor,
} from "../../pendingApprovals.ts";
import {
  repositoryCapabilitiesFor,
  type GitHostingProvider,
} from "../../gitHosting.ts";
import {
  mergePullRequestAndProject,
  openCardsForPullRequest,
  withPullRequestMutation,
  type MergePullRequestInput,
  type MergePullRequestProjection,
} from "../../pullRequestMerge.ts";
import {
  closePullRequestAndProject,
  type ClosePullRequestInput,
  type ClosePullRequestProjection,
} from "../../pullRequestClose.ts";
import {
  readPullRequestReadiness,
  type PullRequestReadiness,
} from "../pullRequestCheckWatch.ts";
import { reserveWorktreeForMutation } from "../../session/sessionRunLease.ts";
import { readTask, taskSummaryOf } from "../../tasks.ts";
import { invalidateWorktreeStatus } from "../../worktrees/worktreeStatus.ts";
import {
  invalidateProjectPullRequests,
  invalidateWorktreeHosting,
} from "../../worktrees/worktreeHosting.ts";
import { isMainWorktreeId } from "../../worktrees/worktreeResolve.ts";
import { patchPullRequestCard } from "../../pullRequestCards.ts";
import { pullRequestIdentity } from "../../pullRequestIdentity.ts";
import { invalidatePullRequestInventoryReads } from "../../pullRequestInventory.ts";
import { invalidatePullRequestInventorySnapshot } from "../../pullRequestInventorySync.ts";
import { scheduleImmediatePoll } from "../../pullRequestWatcher.ts";
import type { ResolvedPushTarget } from "../../pushWorkflow.ts";
import {
  assertManagedProviderRepository,
  readManagedLocalState,
  readManagedRemoteHead,
  resolveManagedHosting,
  resolveManagedPushTarget,
  type ManagedHostingTarget,
  type ManagedWorktreeLocalState,
} from "./managedDeliveryTargets.ts";

const MAX_REASON_CHARS = 1_000;
const BUSY_REFUSAL =
  "Another session is running or starting in this worktree. Wait until it is idle before finishing its pull request.";
const APPROVAL_RESERVATION_REASON =
  "An approved managed default-branch merge is executing for this worktree.";

export interface WorktreeFinishPullRequestOperations {
  resolve(worktreeId: string): Promise<WorktreeRow | undefined>;
  reserve(
    worktreeId: string,
    callerSessionId: string,
    reason: string,
  ): (() => void) | undefined;
  localState(
    row: WorktreeRow,
    signal?: AbortSignal,
  ): Promise<ManagedWorktreeLocalState>;
  target(row: WorktreeRow, signal?: AbortSignal): Promise<ResolvedPushTarget>;
  remoteHead(
    target: ResolvedPushTarget,
    branch: string,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
  hosting(
    target: ResolvedPushTarget,
    signal?: AbortSignal,
  ): Promise<ManagedHostingTarget | undefined>;
  capabilities(
    provider: GitHostingProvider,
  ): Promise<PullRequestRepositoryCapabilities>;
  readiness(
    provider: GitHostingProvider,
    number: number,
  ): Promise<PullRequestReadiness>;
  cards(input: {
    repoPath: string;
    provider: GitHostingProvider;
    number: number;
  }): Promise<PullRequestCard[]>;
  merge(input: MergePullRequestInput): Promise<MergePullRequestProjection>;
  close(input: ClosePullRequestInput): Promise<ClosePullRequestProjection>;
  approve(input: {
    sessionId: string;
    title: string;
    summary: string;
    sourceToolCallId?: string;
    body: ManagedPullRequestMergeApprovalBody;
    supersedes: (earlier: ApprovalCard) => boolean;
  }): ApprovalCard;
  taskIds(worktreeId: string): string[];
  task(taskId: string): TaskSummary | undefined;
  invalidate(worktreeId: string): void;
  projectReady(cards: PullRequestCard[], headSha: string, title?: string): void;
  inventoryChanged(provider: GitHostingProvider, number: number): void;
}

const defaultFinishPullRequestOperations: WorktreeFinishPullRequestOperations =
  {
    resolve: async (worktreeId) => getWorktree(worktreeId),
    reserve: reserveWorktreeForMutation,
    localState: readManagedLocalState,
    target: resolveManagedPushTarget,
    remoteHead: readManagedRemoteHead,
    hosting: resolveManagedHosting,
    capabilities: repositoryCapabilitiesFor,
    readiness: readPullRequestReadiness,
    cards: ({ repoPath, provider, number }) =>
      openCardsForPullRequest({
        repoPath,
        providerKind: provider.kind,
        number,
      }),
    merge: mergePullRequestAndProject,
    close: closePullRequestAndProject,
    approve: (input) =>
      createApproval({
        sessionId: input.sessionId,
        kind: "managedPullRequestMerge",
        title: input.title,
        summary: input.summary,
        ...(input.sourceToolCallId
          ? { sourceToolCallId: input.sourceToolCallId }
          : {}),
        body: input.body,
        supersedes: input.supersedes,
      }),
    taskIds: taskIdsForWorktree,
    task(taskId) {
      const task = readTask(taskId);
      return task ? taskSummaryOf(task) : undefined;
    },
    invalidate(worktreeId) {
      invalidateWorktreeStatus(worktreeId);
      invalidateWorktreeHosting(worktreeId);
    },
    projectReady(cards, headSha, title) {
      for (const card of cards) {
        // Invalidate an in-flight draft observation before it can land after
        // this write. The next poll reads the newly reviewable PR.
        patchPullRequestCard(
          card.id,
          {
            draft: undefined,
            mergeable: undefined,
            conflicts: undefined,
            ...(title ? { title } : {}),
          },
          { observationToken: randomUUID(), observedHeadSha: headSha },
        );
        scheduleImmediatePoll(card.id);
      }
    },
    inventoryChanged(provider, number) {
      invalidateProjectPullRequests();
      const identity = pullRequestIdentity(
        provider.kind,
        provider.repoWebUrl,
        number,
      );
      if (identity) invalidatePullRequestInventoryReads(identity.key);
      invalidatePullRequestInventorySnapshot();
    },
  };

export type WorktreeFinishPullRequestParams = {
  worktreeId: string;
  action: "merge" | "close";
  method?: PullRequestMergeMethod;
  deleteRemoteBranch?: boolean;
  reason?: string;
};

const finishSchema = {
  type: "object",
  additionalProperties: false,
  required: ["worktreeId", "action"],
  properties: {
    worktreeId: {
      type: "string",
      minLength: 1,
      description:
        "Active registered spawned worktree id. The server derives its repository, provider, pull request, head/base branches and exact heads; synthetic main ids and paths are refused.",
    },
    action: {
      type: "string",
      enum: ["merge", "close"],
      description:
        "merge — merge the derived managed pull request. close — close it without merging, keeping the branch, the worktree and the linked Task untouched.",
    },
    method: {
      type: "string",
      enum: [...PULL_REQUEST_MERGE_METHODS],
      description:
        "Merge method, required for merge and refused for close. It must be one the repository currently allows; the check-watch tool and the pull-request card report that set. A method the backend does not support is refused with the supported set.",
    },
    deleteRemoteBranch: {
      type: "boolean",
      default: true,
      description:
        "Delete the remote head branch as part of the merge. Defaults to true; refused for close, which always keeps the branch.",
    },
    reason: {
      type: "string",
      maxLength: MAX_REASON_CHARS,
      description:
        "Why this pull request is being finished. REQUIRED for close — closing abandons the work, and the reason is recorded on the card and in this result.",
    },
  },
} as const;

/** Build the finish tool around injectable seams so every path is testable. */
export function createWorktreeFinishPullRequestTool(
  operations: WorktreeFinishPullRequestOperations = defaultFinishPullRequestOperations,
): AgentTool<WorktreeFinishPullRequestParams> & AgentTool {
  return defineAgentTool<WorktreeFinishPullRequestParams>({
    name: "worktree_finish_pull_request",
    label: "Finish managed pull request",
    description:
      "Merge or close the canonical pull request of an active registered spawned worktree. The server re-derives and revalidates the repository, the exact open pull request, its head/base, the repository's supported merge methods and its default branch, and re-reads exact-head checks and hosted review before merging — a prior check result is never trusted. Merging a ready pull request into a NON-DEFAULT base and closing with a reason are pre-authorized; merging into the provider-reported default branch always creates one approval card and performs no merge in this call. Never accepts a repository, pull-request number, ref, SHA, branch name or path; use it instead of generic provider pull-request tools.",
    parameters: finishSchema as unknown as Record<string, unknown>,
    async execute(params, ctx) {
      return executeWorktreeFinishPullRequest(params, ctx, operations);
    },
  });
}

export function createWorktreeReadyPullRequestTool(
  operations: WorktreeFinishPullRequestOperations = defaultFinishPullRequestOperations,
): AgentTool<{ worktreeId: string }> & AgentTool {
  return defineAgentTool<{ worktreeId: string }>({
    name: "worktree_ready_pull_request",
    label: "Mark managed pull request ready",
    description:
      "Publish the canonical open draft pull request of an active registered spawned worktree for review on GitHub or Forgejo. Derives the provider and PR from the worktree, refuses ambiguous or mismatched PRs, and checks the live draft state again before writing. Pre-authorized for a managed worktree; this does NOT merge the PR or guarantee checks and review pass. Follow with the provider check watch before attempting worktree_finish_pull_request.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["worktreeId"],
      properties: {
        worktreeId: {
          type: "string",
          minLength: 1,
          description:
            "Active registered spawned worktree id; no repository, PR number or ref is accepted.",
        },
      },
    },
    async execute(params, ctx) {
      const worktreeId = params.worktreeId?.trim();
      if (!worktreeId || isMainWorktreeId(worktreeId))
        throw new Error("An active spawned worktree id is required.");
      const initial = await operations.resolve(worktreeId);
      if (!initial || initial.status !== "active")
        throw new Error("That active managed worktree is not available.");
      const release = operations.reserve(
        initial.id,
        ctx.session.sessionId,
        "A checked agent pull-request ready transition is in progress in this worktree.",
      );
      if (!release) throw new Error(BUSY_REFUSAL);
      try {
        const row = await operations.resolve(worktreeId);
        if (
          !row ||
          row.status !== "active" ||
          row.id !== initial.id ||
          row.path !== initial.path ||
          row.branch !== initial.branch ||
          row.baseBranch !== initial.baseBranch ||
          row.projectId !== initial.projectId
        )
          throw new Error(
            "The managed worktree target changed or was removed.",
          );
        const target = await resolveManagedTarget(row, operations, ctx.signal);
        if (!target.draft)
          throw new Error(
            `Pull request #${target.number} is already ready for review; nothing was changed.`,
          );
        return await withPullRequestMutation(
          {
            repoPath: row.path,
            providerKind: target.hosted.provider.kind,
            number: target.number,
          },
          "a ready-for-review transition",
          async () => {
            const detail = await target.hosted.provider.pullRequestDetail(
              target.number,
            );
            if (
              !detail ||
              detail.number !== target.number ||
              detail.state !== "open" ||
              detail.merged ||
              !detail.draft ||
              detail.headSha.toLowerCase() !== target.headSha.toLowerCase() ||
              detail.headBranch !== target.headBranch ||
              detail.baseBranch !== target.baseBranch
            )
              throw new Error(
                `Pull request #${target.number} changed while preparing to mark it ready; nothing was changed.`,
              );
            let ready: { title?: string };
            let inventoryWarning: string | undefined;
            try {
              ready = await target.hosted.provider.markPullRequestReady(
                target.number,
              );
            } finally {
              // The write may have landed even if the provider's response was
              // lost. An invalidation failure must not turn a successful write
              // into a reported provider failure either.
              try {
                operations.inventoryChanged(
                  target.hosted.provider,
                  target.number,
                );
              } catch (error) {
                inventoryWarning = `The PR inventory could not be refreshed: ${error instanceof Error ? error.message : String(error)}.`;
              }
            }
            let projectionWarning: string | undefined;
            try {
              operations.projectReady(
                target.cards,
                target.headSha,
                ready.title,
              );
            } catch (error) {
              projectionWarning = `The pull request was marked ready, but its card could not be updated: ${error instanceof Error ? error.message : String(error)}. The watcher will reconcile it.`;
              for (const card of target.cards) scheduleImmediatePoll(card.id);
            }
            return jsonResult({
              status:
                projectionWarning || inventoryWarning
                  ? "ready-partial"
                  : "ready",
              provider: target.hosted.provider.kind,
              number: target.number,
              url: target.url,
              headSha: target.headSha,
              cardIds: target.cards.map((card) => card.id),
              ...(projectionWarning ? { projectionWarning } : {}),
              ...(inventoryWarning ? { inventoryWarning } : {}),
              message: [
                "Pull request marked ready for review. Re-check checks, review and mergeability before merging.",
                inventoryWarning,
                projectionWarning,
              ]
                .filter(Boolean)
                .join(" "),
            });
          },
        );
      } finally {
        try {
          operations.invalidate(initial.id);
        } finally {
          release();
        }
      }
    },
  });
}

/* ----------------------------- input validation ---------------------------- */

interface FinishRequest {
  worktreeId: string;
  action: "merge" | "close";
  method?: PullRequestMergeMethod;
  deleteRemoteBranch: boolean;
  reason?: string;
}

function validateRequest(
  params: WorktreeFinishPullRequestParams,
): FinishRequest {
  const worktreeId = params.worktreeId?.trim();
  if (!worktreeId) throw new Error("worktreeId is required.");
  if (isMainWorktreeId(worktreeId))
    throw new Error(
      "The main checkout has no managed pull request to finish; it is not an agent delivery target.",
    );
  const action = params.action;
  if (action !== "merge" && action !== "close")
    throw new Error('action must be "merge" or "close".');
  const reason = params.reason?.trim();
  if (reason && reason.length > MAX_REASON_CHARS)
    throw new Error(`reason exceeds ${MAX_REASON_CHARS} characters.`);

  if (action === "close") {
    if (params.method !== undefined)
      throw new Error(
        "method applies to merge only; a close never merges anything.",
      );
    if (params.deleteRemoteBranch !== undefined)
      throw new Error(
        "deleteRemoteBranch applies to merge only; a close always keeps the remote branch.",
      );
    if (!reason)
      throw new Error(
        "reason is required to close a pull request without merging.",
      );
    return { worktreeId, action, reason, deleteRemoteBranch: false };
  }

  const method = params.method;
  if (!method || !PULL_REQUEST_MERGE_METHODS.includes(method))
    throw new Error(
      `method is required for merge and must be one of ${PULL_REQUEST_MERGE_METHODS.join(", ")}.`,
    );
  return {
    worktreeId,
    action,
    method,
    deleteRemoteBranch: params.deleteRemoteBranch !== false,
    ...(reason ? { reason } : {}),
  };
}

/* --------------------------- common target resolution ---------------------- */

/** The exact managed object this call may act on, proven from current state. */
interface ManagedPullRequestTarget {
  row: WorktreeRow;
  target: ResolvedPushTarget;
  hosted: ManagedHostingTarget;
  number: number;
  url: string;
  title: string;
  headSha: string;
  headBranch: string;
  baseBranch: string;
  draft: boolean;
  capabilities: PullRequestRepositoryCapabilities;
  cards: PullRequestCard[];
}

async function resolveManagedTarget(
  row: WorktreeRow,
  operations: WorktreeFinishPullRequestOperations,
  signal: AbortSignal | undefined,
): Promise<ManagedPullRequestTarget> {
  const target = await operations.target(row, signal);
  const hosted = await operations.hosting(target, signal);
  if (!hosted)
    throw new Error(
      `No git hosting provider is configured for the derived push remote "${target.remote}".`,
    );
  assertManagedProviderRepository(
    hosted,
    target.remote,
    "no pull request was finished.",
  );

  // The complete open set, or a throw: a truncated answer could hide a second
  // open pull request for this branch behind a page boundary.
  const pulls = await hosted.provider.findPullRequestsForBranch(row.branch);
  if (pulls.open.length > 1)
    throw new Error(
      `The managed branch ${row.branch} has ${pulls.open.length} open pull requests (${pulls.open
        .map((pull) => `#${pull.number}`)
        .join(
          ", ",
        )}); exactly one is required before managed delivery can continue.`,
    );
  const pr = pulls.open[0];
  if (!pr) {
    const terminal = pulls.latestTerminal;
    if (terminal)
      throw new Error(
        `Pull request #${terminal.number} for ${row.branch} is already ${terminal.state}; nothing was done.`,
      );
    throw new Error(
      `No pull request exists for the managed branch ${row.branch}. Create one with worktree_create_pull_request first.`,
    );
  }
  const detail = await hosted.provider.pullRequestDetail(pr.number);
  if (!detail)
    throw new Error(
      `Pull request #${pr.number} could not be re-read from ${hosted.provider.kind}; nothing was done.`,
    );
  if (detail.state !== "open" || detail.merged)
    throw new Error(
      `Pull request #${pr.number} is ${detail.merged ? "merged" : detail.state}; nothing was done.`,
    );
  if (!detail.headSha)
    throw new Error(
      `Pull request #${pr.number} reports no head commit; nothing was done.`,
    );
  if (detail.headBranch !== row.branch || detail.baseBranch !== row.baseBranch)
    throw new Error(
      `Pull request #${pr.number} is ${detail.headBranch} → ${detail.baseBranch}, but this worktree is registered for ${row.branch} → ${row.baseBranch}; nothing was done.`,
    );

  const cards = await operations.cards({
    repoPath: row.path,
    provider: hosted.provider,
    number: pr.number,
  });
  if (cards.length === 0)
    throw new Error(
      `Pull request #${pr.number} has no open managed card for worktree ${row.id}; nothing was done. Reconcile or recreate its managed pull-request card first.`,
    );
  // A live card that names ANOTHER worktree (or another branch pair) means this
  // number is being delivered by something else; refuse rather than project a
  // finish onto it.
  for (const card of cards) {
    if (card.worktreeId !== undefined && card.worktreeId !== row.id)
      throw new Error(
        `Pull request #${pr.number} has a live card owned by worktree ${card.worktreeId}, not ${row.id}; nothing was done.`,
      );
    if (
      card.headBranch !== detail.headBranch ||
      card.baseBranch !== detail.baseBranch
    )
      throw new Error(
        `Pull request #${pr.number} has a live card for ${card.headBranch} → ${card.baseBranch}, which no longer matches the pull request; nothing was done.`,
      );
  }
  if (!cards.some((card) => card.worktreeId === row.id))
    throw new Error(
      `Pull request #${pr.number} has no open card anchored to managed worktree ${row.id}; nothing was done.`,
    );

  const capabilities = await operations.capabilities(hosted.provider);
  return {
    row,
    target,
    hosted,
    number: pr.number,
    url: pr.url,
    title: pr.title,
    headSha: detail.headSha,
    headBranch: detail.headBranch,
    baseBranch: detail.baseBranch,
    draft: detail.draft,
    capabilities,
    cards,
  };
}

/** The exact local facts a merge needs; a close deliberately asks for none. */
async function requireMergeableLocalState(
  row: WorktreeRow,
  headSha: string,
  operations: WorktreeFinishPullRequestOperations,
  target: ResolvedPushTarget,
  signal: AbortSignal | undefined,
): Promise<ManagedWorktreeLocalState> {
  const local = await operations.localState(row, signal);
  if (local.branch !== row.branch)
    throw new Error(
      `The worktree is registered for branch ${row.branch}, but ${local.branch || "a detached HEAD"} is checked out.`,
    );
  if (!local.head)
    throw new Error("The managed branch HEAD could not be read.");
  if (!local.clean)
    throw new Error(
      "The worktree has staged, modified, or non-ignored untracked changes. Commit or discard them before merging its pull request.",
    );
  if (!target.upstream)
    throw new Error(
      "The managed branch has no upstream. Call worktree_push before merging its pull request.",
    );
  if (
    target.upstream.remote !== target.remote ||
    target.upstream.branch !== row.branch
  )
    throw new Error(
      `The managed branch must track ${target.remote}/${row.branch}; it currently tracks ${target.upstream.remote}/${target.upstream.branch}.`,
    );
  const remoteHead = await operations.remoteHead(target, row.branch, signal);
  if (!remoteHead)
    throw new Error(
      "The tracked remote branch does not exist. Call worktree_push before merging its pull request.",
    );
  if (remoteHead.toLowerCase() !== local.head.toLowerCase())
    throw new Error(
      `The remote branch head ${remoteHead} does not equal local HEAD ${local.head}. Push the managed branch and re-check before merging.`,
    );
  if (headSha.toLowerCase() !== local.head.toLowerCase())
    throw new Error(
      `The pull request head ${headSha} does not equal the managed branch head ${local.head}. Push the managed branch and re-check before merging.`,
    );
  return local;
}

/** Capability facts a merge needs, refused legibly while any is unknown. */
function requireMergeCapabilities(
  capabilities: PullRequestRepositoryCapabilities,
  method: PullRequestMergeMethod,
  number: number,
): { defaultBranch: string; supportedMethods: PullRequestMergeMethod[] } {
  const unknown = capabilities.unknownReason
    ? ` (${capabilities.unknownReason})`
    : "";
  if (!capabilities.defaultBranch)
    throw new Error(
      `The repository's default branch could not be read${unknown}, so pull request #${number} cannot be classified as a default-branch merge. Nothing was merged.`,
    );
  if (!capabilities.mergeMethods)
    throw new Error(
      `The repository's supported merge methods could not be read${unknown}, so no method may be used for pull request #${number}. Nothing was merged.`,
    );
  if (!capabilities.mergeMethods.includes(method))
    throw new Error(
      `The repository does not allow the ${method} merge method for pull request #${number}. Supported: ${capabilities.mergeMethods.join(", ") || "none"}.`,
    );
  return {
    defaultBranch: capabilities.defaultBranch,
    supportedMethods: capabilities.mergeMethods,
  };
}

function requireReady(
  readiness: PullRequestReadiness,
  number: number,
): PullRequestReadiness {
  if (readiness.canMergeNow) return readiness;
  throw new Error(
    `Pull request #${number} is not ready to merge: ${readiness.mergeBlockers.join(", ")}. Investigate each blocker; the provider remains the authority on branch protections and permissions.`,
  );
}

/** Bind a readiness verdict to the exact current PR identity it describes. */
function requireCurrentReadiness(
  readiness: PullRequestReadiness,
  target: ManagedPullRequestTarget,
): PullRequestReadiness {
  const detail = readiness.detail;
  if (detail.number !== target.number)
    throw new Error(
      `Readiness described pull request #${detail.number}, not managed pull request #${target.number}; nothing was merged.`,
    );
  if (detail.state !== "open" || detail.merged)
    throw new Error(
      `Pull request #${target.number} became ${detail.merged ? "merged" : detail.state} while readiness was checked; nothing was merged.`,
    );
  if (detail.headSha.toLowerCase() !== target.headSha.toLowerCase())
    throw new Error(
      `Pull request #${target.number} head moved from ${target.headSha} to ${detail.headSha} while it was being checked; nothing was merged.`,
    );
  if (
    detail.headBranch !== target.headBranch ||
    detail.baseBranch !== target.baseBranch
  )
    throw new Error(
      `Pull request #${target.number} changed from ${target.headBranch} → ${target.baseBranch} to ${detail.headBranch} → ${detail.baseBranch} while readiness was checked; nothing was merged.`,
    );
  if (detail.draft)
    throw new Error(
      `Pull request #${target.number} became a draft while readiness was checked; nothing was merged.`,
    );
  return requireReady(readiness, target.number);
}

function currentRepositoryName(target: ManagedPullRequestTarget): string {
  return `${target.hosted.repository.owner}/${target.hosted.repository.repo}`;
}

function linkedTaskFor(
  worktreeId: string,
  operations: WorktreeFinishPullRequestOperations,
): TaskSummary | undefined {
  const ids = [...new Set(operations.taskIds(worktreeId))];
  const tasks = ids.flatMap((id) => {
    const task = operations.task(id);
    return task ? [task] : [];
  });
  // Several links are ambiguous EVIDENCE, not an error: the finish tool
  // neither writes nor needs the Task, so it simply states nothing.
  return tasks.length === 1 ? tasks[0] : undefined;
}

/* --------------------------------- execute --------------------------------- */

async function executeWorktreeFinishPullRequest(
  params: WorktreeFinishPullRequestParams,
  ctx: ToolCallContext,
  operations: WorktreeFinishPullRequestOperations,
) {
  const request = validateRequest(params);
  const initial = await operations.resolve(request.worktreeId);
  if (!initial || initial.status !== "active")
    throw new Error("That active managed worktree is not available.");

  const release = operations.reserve(
    initial.id,
    ctx.session.sessionId,
    `A checked agent pull-request ${request.action} is in progress in this worktree.`,
  );
  if (!release) throw new Error(BUSY_REFUSAL);
  try {
    const row = await operations.resolve(request.worktreeId);
    if (
      !row ||
      row.status !== "active" ||
      row.id !== initial.id ||
      row.path !== initial.path ||
      row.branch !== initial.branch ||
      row.baseBranch !== initial.baseBranch ||
      row.projectId !== initial.projectId
    )
      throw new Error("The managed worktree target changed or was removed.");

    const target = await resolveManagedTarget(row, operations, ctx.signal);
    return request.action === "close"
      ? await runClose(request, target, operations)
      : await runMerge(request, target, ctx, operations);
  } finally {
    try {
      operations.invalidate(initial.id);
    } finally {
      release();
    }
  }
}

async function runClose(
  request: FinishRequest,
  target: ManagedPullRequestTarget,
  operations: WorktreeFinishPullRequestOperations,
) {
  // Close support is a CAPABILITY, not an assumption: an unknown answer refuses
  // rather than sending a write the backend may not implement.
  if (target.capabilities.canClose !== true)
    throw new Error(
      `Closing pull requests is not confirmed for this ${target.hosted.provider.kind} repository${target.capabilities.unknownReason ? ` (${target.capabilities.unknownReason})` : ""}; nothing was closed.`,
    );
  const reason = request.reason ?? "";
  const projection = await operations.close({
    provider: target.hosted.provider,
    repoPath: target.row.path,
    number: target.number,
    headBranch: target.headBranch,
    baseBranch: target.baseBranch,
    expectedHeadSha: target.headSha,
    reason,
    worktreeId: target.row.id,
  });
  return jsonResult({
    action: "close" as const,
    status: projection.result.closed ? "closed" : "close-unconfirmed",
    provider: target.hosted.provider.kind,
    number: target.number,
    url: target.url,
    head: { ref: target.headBranch, sha: target.headSha },
    base: { ref: target.baseBranch },
    reason,
    remoteBranchKept: true,
    localBranchKept: true,
    worktreeKept: true,
    linkedTaskUnchanged: true,
    cardIds: projection.cardIds,
    message: projection.message,
    ...(projection.result.unconfirmedReason
      ? { unconfirmed: projection.result.unconfirmedReason }
      : {}),
  });
}

async function runMerge(
  request: FinishRequest,
  target: ManagedPullRequestTarget,
  ctx: ToolCallContext,
  operations: WorktreeFinishPullRequestOperations,
) {
  const method = request.method!;
  if (target.draft)
    throw new Error(
      `Pull request #${target.number} is a draft; call worktree_ready_pull_request before merging.`,
    );
  await requireMergeableLocalState(
    target.row,
    target.headSha,
    operations,
    target.target,
    ctx.signal,
  );
  // The readiness read is REDONE here, through the same function the check
  // watch tools use: a previous turn's verdict describes a head and a check set
  // that may both have moved.
  const readiness = requireCurrentReadiness(
    await operations.readiness(target.hosted.provider, target.number),
    target,
  );
  const { defaultBranch, supportedMethods } = requireMergeCapabilities(
    target.capabilities,
    method,
    target.number,
  );
  const linkedTask = linkedTaskFor(target.row.id, operations);
  const intoDefaultBranch = readiness.detail.baseBranch === defaultBranch;

  if (intoDefaultBranch)
    return stageDefaultBranchApproval({
      request,
      target,
      ctx,
      operations,
      method,
      defaultBranch,
      supportedMethods,
      readiness,
      ...(linkedTask ? { linkedTask } : {}),
    });

  const projection = await operations.merge({
    provider: target.hosted.provider,
    repoPath: target.row.path,
    number: target.number,
    headBranch: target.headBranch,
    baseBranch: target.baseBranch,
    method,
    expectedHeadSha: readiness.detail.headSha,
    deleteBranch: request.deleteRemoteBranch,
    worktreeId: target.row.id,
    workflowActor: { kind: "agent", id: ctx.session.sessionId },
    // What made this merge pre-authorized: a base that was NOT the default
    // branch, judged against this default branch. The seam re-checks both
    // against its own authoritative read, so a default branch that moves
    // between here and the provider call cannot turn this into an unapproved
    // default-branch merge.
    managedDecision: { baseIsDefaultBranch: false, defaultBranch },
  });
  return jsonResult({
    action: "merge" as const,
    status: "merged" as const,
    approvalRequired: false,
    provider: target.hosted.provider.kind,
    number: target.number,
    url: target.url,
    head: { ref: target.headBranch, sha: target.headSha },
    base: { ref: target.baseBranch },
    defaultBranch,
    baseIsDefaultBranch: false,
    method: projection.result.method,
    supportedMethods,
    remoteBranchDeleted: projection.result.branchDeleted,
    ...(projection.result.branchDeleteError
      ? { remoteBranchDeleteError: projection.result.branchDeleteError }
      : {}),
    cardIds: projection.cardIds,
    // What the projection actually WROTE, never what the worktree links
    // suggested it might: the merge suggests `done` only for Tasks linked on a
    // matching card, skips an already-done or missing one, and treats a failed
    // write as bookkeeping. Reporting the pre-merge link would tell the agent a
    // suggestion exists that nobody can answer.
    taskSuggestions: projection.taskSuggestions.map((task) => ({
      id: task.id,
      title: task.title,
      statusSuggested: "done" as const,
    })),
    ...(request.reason ? { reason: request.reason } : {}),
    message: projection.message,
  });
}

function stageDefaultBranchApproval(input: {
  request: FinishRequest;
  target: ManagedPullRequestTarget;
  ctx: ToolCallContext;
  operations: WorktreeFinishPullRequestOperations;
  method: PullRequestMergeMethod;
  defaultBranch: string;
  supportedMethods: PullRequestMergeMethod[];
  readiness: PullRequestReadiness;
  linkedTask?: TaskSummary;
}) {
  const { target, readiness } = input;
  const repository = target.hosted.repository;
  const body: ManagedPullRequestMergeApprovalBody = {
    kind: "managedPullRequestMerge",
    provider: target.hosted.provider.kind,
    repo: `${repository.owner}/${repository.repo}`,
    worktreeId: target.row.id,
    ...(target.row.projectId ? { projectId: target.row.projectId } : {}),
    number: target.number,
    url: target.url,
    title: target.title,
    headBranch: target.headBranch,
    baseBranch: target.baseBranch,
    defaultBranch: input.defaultBranch,
    headSha: target.headSha,
    method: input.method,
    supportedMethods: input.supportedMethods,
    deleteRemoteBranch: input.request.deleteRemoteBranch,
    checks: {
      state: readiness.checks.state,
      ...(readiness.checks.total !== undefined
        ? { total: readiness.checks.total }
        : {}),
      finished: readiness.checksFinished,
      ...(readiness.checks.truncated ? { truncated: true } : {}),
    },
    ...(readiness.review ? { review: readiness.review } : {}),
    mergeable: readiness.detail.mergeable,
    draft: readiness.detail.draft,
    ...(input.linkedTask
      ? {
          linkedTask: {
            id: input.linkedTask.id,
            title: input.linkedTask.title,
          },
        }
      : {}),
  };
  const card = input.operations.approve({
    sessionId: input.ctx.session.sessionId,
    title: `Merge #${target.number} into ${input.defaultBranch}`,
    summary: `${body.repo}#${target.number}: ${target.headBranch} → ${target.baseBranch} (${input.method})`,
    ...(input.ctx.toolCallId ? { sourceToolCallId: input.ctx.toolCallId } : {}),
    body,
    // A re-staged merge of the same pull request — typically after new commits
    // moved its head — replaces the earlier card: approving the stale one would
    // only fail revalidation, and two cards read as two merges.
    supersedes: (earlier) =>
      earlier.body.kind === "managedPullRequestMerge" &&
      earlier.body.provider === body.provider &&
      earlier.body.repo === body.repo &&
      earlier.body.number === body.number,
  });
  return {
    ...jsonResult({
      action: "merge" as const,
      status: "approval-pending" as const,
      approvalRequired: true,
      approvalId: card.id,
      provider: body.provider,
      number: target.number,
      url: target.url,
      head: { ref: target.headBranch, sha: target.headSha },
      base: { ref: target.baseBranch },
      defaultBranch: input.defaultBranch,
      baseIsDefaultBranch: true,
      method: input.method,
      supportedMethods: input.supportedMethods,
      deleteRemoteBranch: input.request.deleteRemoteBranch,
      merged: false,
      message: `Pull request #${target.number} targets the default branch ${input.defaultBranch}. Nothing was merged: one approval was created, replacing any earlier pending merge card for this pull request, and the merge runs only after it is approved and the complete state revalidates. ${approvalCardReference(card)}`,
    }),
    // The turn ENDS here. The approval outcome resumes this session; polling
    // for it would burn a turn on a decision only a human can make.
    terminate: true,
  };
}

/* ------------------------------- the approval ------------------------------ */

/**
 * The seams the approval executes through. It runs server-side, long after the
 * tool call that proposed it, so it owns its own resolution rather than
 * inheriting anything from that turn.
 */
let approvalOperations: WorktreeFinishPullRequestOperations =
  defaultFinishPullRequestOperations;

/** Test seam: drive the approval executor against injected seams. */
export function setManagedMergeApprovalOperationsForTests(
  operations?: WorktreeFinishPullRequestOperations,
): void {
  approvalOperations = operations ?? defaultFinishPullRequestOperations;
}

/**
 * Execute an approved default-branch merge.
 *
 * `prepare` performs the COMPLETE common + merge revalidation again — the card
 * has been sitting in front of a human, so every frozen fact is re-derived from
 * current state and the merge is refused (leaving the card pending) on any
 * drift. It notably re-checks that the base is STILL the repository's default
 * branch: an approval for a default-branch merge must never degrade into a
 * direct merge somewhere else.
 */
export const managedPullRequestMergeApprovalExecutor: ApprovalExecutor = {
  async prepare(card) {
    const body = requireMergeApprovalBody(card);
    await revalidateApprovedMerge(body);
    return body;
  },
  async execute(card) {
    const body = requireMergeApprovalBody(card);
    // The reservation from the original tool turn is long gone; take a fresh
    // one, and re-derive under it exactly as the tool did.
    const operations = approvalOperations;
    const release = operations.reserve(
      body.worktreeId,
      // Server-side execution owns the hold outright: no session may already be
      // running in the worktree while an approved merge lands.
      `approval:${card.id}`,
      APPROVAL_RESERVATION_REASON,
    );
    if (!release)
      throw new Error(
        "That worktree is busy: a session is running or starting in it. Nothing was merged; approve again once it is idle.",
      );
    try {
      const { target, row } = await revalidateApprovedMerge(body);
      const projection = await operations.merge({
        provider: target.hosted.provider,
        repoPath: row.path,
        number: body.number,
        headBranch: body.headBranch,
        baseBranch: body.baseBranch,
        method: body.method,
        expectedHeadSha: target.headSha,
        deleteBranch: body.deleteRemoteBranch,
        worktreeId: row.id,
        workflowActor: { kind: "user" },
        // What the human answered: merge THIS base, which was the default
        // branch, out of THESE methods. The seam re-checks all three against
        // its own authoritative read, so an approval cannot execute after its
        // base stopped being the default or its offered set changed.
        managedDecision: {
          baseIsDefaultBranch: true,
          defaultBranch: body.defaultBranch,
          approvedMethods: body.supportedMethods,
        },
      });
      body.resultMerged = true;
      body.resultBranchDeleted = projection.result.branchDeleted;
      return {
        resultSummary: projection.message,
        resultUrl: body.url,
      };
    } finally {
      try {
        operations.invalidate(body.worktreeId);
      } finally {
        release();
      }
    }
  },
};

registerApprovalExecutor(
  "managedPullRequestMerge",
  managedPullRequestMergeApprovalExecutor,
);

function requireMergeApprovalBody(
  card: ApprovalCard,
): ManagedPullRequestMergeApprovalBody {
  if (card.body.kind !== "managedPullRequestMerge")
    throw new Error("Mismatched approval body for managedPullRequestMerge.");
  return card.body;
}

/**
 * Re-derive the approved merge from CURRENT state and refuse on any drift from
 * the frozen decision. Returns the freshly resolved target, so the merge that
 * follows uses what this proved rather than what the card remembers.
 */
async function revalidateApprovedMerge(
  body: ManagedPullRequestMergeApprovalBody,
): Promise<{ target: ManagedPullRequestTarget; row: WorktreeRow }> {
  const operations = approvalOperations;
  const row = await operations.resolve(body.worktreeId);
  if (!row || row.status !== "active")
    throw new Error(
      "That managed worktree is no longer available; nothing was merged.",
    );
  if (row.branch !== body.headBranch || row.baseBranch !== body.baseBranch)
    throw new Error(
      `The managed worktree now delivers ${row.branch} → ${row.baseBranch}, not ${body.headBranch} → ${body.baseBranch}; nothing was merged.`,
    );
  if ((row.projectId ?? undefined) !== body.projectId)
    throw new Error(
      `The managed worktree project changed from ${body.projectId ?? "none"} to ${row.projectId ?? "none"}; nothing was merged.`,
    );
  const target = await resolveManagedTarget(row, operations, undefined);
  const repository = currentRepositoryName(target);
  if (repository.toLowerCase() !== body.repo.toLowerCase())
    throw new Error(
      `The managed worktree now resolves to repository ${repository}, not the approved ${body.repo}; nothing was merged.`,
    );
  if (target.number !== body.number)
    throw new Error(
      `The managed branch now has pull request #${target.number}, not the approved #${body.number}; nothing was merged.`,
    );
  if (target.hosted.provider.kind !== body.provider)
    throw new Error(
      `The repository now resolves to ${target.hosted.provider.kind}, not the approved ${body.provider}; nothing was merged.`,
    );
  if (target.headSha.toLowerCase() !== body.headSha.toLowerCase())
    throw new Error(
      `Pull request #${body.number} head moved from the approved ${body.headSha} to ${target.headSha}; nothing was merged. Re-check it and ask again.`,
    );
  if (target.draft)
    throw new Error(
      `Pull request #${body.number} is a draft again; nothing was merged.`,
    );
  await requireMergeableLocalState(
    row,
    target.headSha,
    operations,
    target.target,
    undefined,
  );
  const readiness = requireCurrentReadiness(
    await operations.readiness(target.hosted.provider, target.number),
    target,
  );
  if (readiness.detail.headSha.toLowerCase() !== body.headSha.toLowerCase())
    throw new Error(
      `Pull request #${body.number} head moved from the approved ${body.headSha} to ${readiness.detail.headSha}; nothing was merged.`,
    );
  const { defaultBranch, supportedMethods } = requireMergeCapabilities(
    target.capabilities,
    body.method,
    body.number,
  );
  // The card froze the whole supported set, not just the chosen method: the
  // user answered "merge with squash, out of these". A repository that has
  // since gained or lost a method is a different question, so the decision is
  // no longer the one being executed.
  if (
    supportedMethods.length !== body.supportedMethods.length ||
    supportedMethods.some(
      (current, index) => current !== body.supportedMethods[index],
    )
  )
    throw new Error(
      `The repository's supported merge methods changed from the approved ${body.supportedMethods.join(", ") || "none"} to ${supportedMethods.join(", ") || "none"}; nothing was merged. Decide again with the current set.`,
    );
  // The approval answered ONE question: merge into the default branch. If the
  // base is no longer the default, this is a different act and needs a
  // different decision — never a silent direct merge under a stale approval.
  if (target.baseBranch !== defaultBranch)
    throw new Error(
      `Pull request #${body.number} now targets ${target.baseBranch}, which is no longer the repository default branch ${defaultBranch}; nothing was merged.`,
    );
  if (defaultBranch !== body.defaultBranch)
    throw new Error(
      `The repository default branch changed from the approved ${body.defaultBranch} to ${defaultBranch}; nothing was merged.`,
    );
  return { target, row };
}
