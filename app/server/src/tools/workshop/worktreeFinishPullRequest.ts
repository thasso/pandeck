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
  PullRequestDetail,
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
import {
  runManagedMergeFollowUps,
  type ManagedMergeFollowUpInput,
  type ManagedMergeFollowUpResult,
} from "../../managedMergeFollowUps.ts";
import { invalidateWorktreeStatus } from "../../worktrees/worktreeStatus.ts";
import {
  invalidateProjectPullRequests,
  invalidateWorktreeHosting,
} from "../../worktrees/worktreeHosting.ts";
import { isMainWorktreeId } from "../../worktrees/worktreeResolve.ts";
import { patchPullRequestCard } from "../../pullRequestCards.ts";
import {
  pullRequestIdentity,
  repositoryKeyFromUrl,
} from "../../pullRequestIdentity.ts";
import { invalidatePullRequestInventoryReads } from "../../pullRequestInventory.ts";
import { invalidatePullRequestInventorySnapshot } from "../../pullRequestInventorySync.ts";
import { scheduleImmediatePoll } from "../../pullRequestPollSchedule.ts";
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

import {
  ManagedFinishRefusedError,
  WorktreeBusyError,
} from "../../managedFinishRefusal.ts";
import {
  createMergeWhenReadyRunner,
  assertFrozenMergeTarget,
  type FrozenMergeTarget,
} from "./mergeWhenReady.ts";

const MAX_REASON_CHARS = 1_000;
const BUSY_REFUSAL = new WorktreeBusyError().message;

export const managedMergeCore = {
  finishManagedMerge,
  requireMergeableLocalState,
  requireMergeCapabilities,
  requiredLinkedCardTask,
  resolveManagedTarget,
  validateRequest,
  requireCurrentReadiness,
};
const mergeWhenReady = createMergeWhenReadyRunner({ core: managedMergeCore });
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
    providerSignal?: AbortSignal,
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
  followUps(
    input: ManagedMergeFollowUpInput,
  ): Promise<ManagedMergeFollowUpResult>;
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
  projectRetarget(cards: PullRequestCard[], baseBranch: string): void;
  inventoryChanged(provider: GitHostingProvider, number: number): void;
}

export const defaultFinishPullRequestOperations: WorktreeFinishPullRequestOperations =
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
    followUps: runManagedMergeFollowUps,
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
    projectRetarget(cards, baseBranch) {
      for (const card of cards) {
        // A new base answers mergeability and conflicts afresh; drop the old
        // base's answers and any in-flight poll that read them.
        patchPullRequestCard(
          card.id,
          { baseBranch, mergeable: undefined, conflicts: undefined },
          { baseBranch, observationToken: randomUUID() },
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
  markTaskDone?: boolean;
  removeWorktree?: boolean;
  reason?: string;
  whenReady?: boolean;
  timeoutSeconds?: number;
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
    markTaskDone: {
      type: "boolean",
      default: false,
      description:
        "After a confirmed merge, apply done to the unique Task linked on the managed PR cards, recording the requesting agent's claim. Omitted leaves the usual done suggestion. Refused for close.",
    },
    removeWorktree: {
      type: "boolean",
      default: false,
      description:
        "After a confirmed merge, remove the clean worktree and its local branch only if no session is running or otherwise blocks removal, including this caller. Never forces cleanup. A refusal or follow-up failure is reported without hiding the merge. Default-branch approval carries both follow-up choices. Refused for close.",
    },
    whenReady: {
      type: "boolean",
      description:
        "Merge only. If checks or worktree occupancy are pending, return a visible, stoppable background task. It pins this PR/head, then uses the same readiness and approval/grant path. One job per worktree; restart stops it.",
    },
    timeoutSeconds: {
      type: "number",
      description:
        "Background wait only, with whenReady. Default 1800, clamped to 30–7200 seconds and the Settings background lifetime. No effect on an inline finish.",
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
      return withReservedManagedTarget(
        params.worktreeId,
        ctx,
        operations,
        "A checked agent pull-request ready transition is in progress in this worktree.",
        {},
        async (target) => {
          if (!target.draft)
            throw new Error(
              `Pull request #${target.number} is already ready for review; nothing was changed.`,
            );
          return withPullRequestMutation(
            {
              repoPath: target.row.path,
              providerKind: target.hosted.provider.kind,
              number: target.number,
              repoUrl: target.hosted.provider.repoWebUrl,
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
                inventoryWarning = recordInventoryChange(operations, target);
              }
              let projectionWarning: string | undefined;
              try {
                operations.projectReady(
                  target.cards,
                  target.headSha,
                  ready.title,
                );
              } catch (error) {
                projectionWarning = `The pull request was marked ready, but its card could not be updated: ${errorText(error)}. The watcher will reconcile it.`;
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
        },
      );
    },
  });
}

export function createWorktreeRetargetPullRequestTool(
  operations: WorktreeFinishPullRequestOperations = defaultFinishPullRequestOperations,
): AgentTool<{ worktreeId: string }> & AgentTool {
  return defineAgentTool<{ worktreeId: string }>({
    name: "worktree_retarget_pull_request",
    label: "Retarget managed pull request",
    description:
      "Move the canonical open pull request of an active registered spawned worktree onto the worktree's recorded base on GitHub or Forgejo, e.g. after worktree_set_base when a stacked parent has merged. The base always comes from the worktree (change it with worktree_set_base first) and must already exist on the remote. Re-reads the PR under the mutation lock, refuses a moved head or ambiguous PRs, and updates the live cards. Pre-authorized for a managed worktree; it neither rebases nor merges. The new base re-decides checks, review and mergeability, so watch checks again before worktree_finish_pull_request.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["worktreeId"],
      properties: {
        worktreeId: {
          type: "string",
          minLength: 1,
          description:
            "Active registered spawned worktree id; no repository, PR number, ref or base is accepted.",
        },
      },
    },
    async execute(params, ctx) {
      return withReservedManagedTarget(
        params.worktreeId,
        ctx,
        operations,
        "A checked agent pull-request retarget is in progress in this worktree.",
        { baseMayDiffer: true },
        async (target) => {
          const base = target.row.baseBranch;
          const summary = {
            provider: target.hosted.provider.kind,
            number: target.number,
            url: target.url,
            headSha: target.headSha,
            previousBaseBranch: target.baseBranch,
            baseBranch: base,
            cardIds: target.cards.map((card) => card.id),
          };
          if (target.baseBranch === base) {
            // Nothing to write; a card that missed an earlier retarget (one
            // made in the provider UI) is brought in line with the provider.
            const stale = target.cards.filter(
              (card) => card.baseBranch !== base,
            );
            if (stale.length > 0) operations.projectRetarget(stale, base);
            return jsonResult({
              status: "unchanged",
              ...summary,
              message: `Pull request #${target.number} already targets ${base}; nothing was changed on ${target.hosted.provider.kind}.`,
            });
          }
          return withPullRequestMutation(
            {
              repoPath: target.row.path,
              providerKind: target.hosted.provider.kind,
              number: target.number,
              repoUrl: target.hosted.provider.repoWebUrl,
            },
            "a base retarget",
            async () => {
              const provider = target.hosted.provider;
              const detail = await provider.pullRequestDetail(target.number);
              if (
                !detail ||
                detail.number !== target.number ||
                detail.state !== "open" ||
                detail.merged ||
                detail.headSha.toLowerCase() !== target.headSha.toLowerCase() ||
                detail.headBranch !== target.headBranch ||
                detail.baseBranch !== target.baseBranch
              )
                throw new Error(
                  `Pull request #${target.number} changed while preparing to retarget it; nothing was changed.`,
                );
              let inventoryWarning: string | undefined;
              let writeError: unknown;
              try {
                await provider.retargetPullRequest(target.number, base);
              } catch (error) {
                // A rejected request is not proof nothing landed: a response
                // lost after the PATCH applied looks the same. The read-back
                // below decides which it was.
                writeError = error ?? new Error("unknown error");
              } finally {
                inventoryWarning = recordInventoryChange(operations, target);
              }
              // The edit has no precondition, so its outcome is what the
              // provider reports afterwards, not what was asked for.
              let after: PullRequestDetail | null = null;
              let readError: unknown;
              try {
                after = await provider.pullRequestDetail(target.number);
              } catch (error) {
                readError = error ?? new Error("unknown error");
              }
              if (writeError !== undefined) {
                for (const card of target.cards) scheduleImmediatePoll(card.id);
                if (after?.baseBranch === target.baseBranch)
                  throw new Error(
                    `${provider.kind} refused to retarget pull request #${target.number} onto ${base}: ${errorText(writeError)} If ${base} is not on the remote yet, push it first.`,
                  );
                if (after?.baseBranch !== base)
                  throw new Error(
                    `Retargeting pull request #${target.number} onto ${base} failed (${errorText(writeError)}), and whether it landed is unknown: ${after ? `the pull request now reports base ${after.baseBranch || "(unreported)"}` : `it could not be read back (${errorText(readError)})`}. Read the pull request before retrying.`,
                  );
              }
              let confirmWarning: string | undefined;
              if (!after)
                confirmWarning = `The retarget was sent, but its result could not be read back: ${errorText(readError ?? "the pull request was not found")}.`;
              else if (after.baseBranch !== base)
                confirmWarning = `The retarget was sent, but pull request #${target.number} still reports base ${after.baseBranch || "(unreported)"}.`;
              else if (
                after.number !== target.number ||
                after.state !== "open" ||
                after.merged ||
                after.headBranch !== target.headBranch ||
                after.headSha.toLowerCase() !== target.headSha.toLowerCase()
              )
                // The base landed, but on a pull request that moved under
                // the unconditioned write; its cards are the watcher's.
                confirmWarning = `Pull request #${target.number} now targets ${base}, but it also changed during the retarget (${after.merged ? "merged" : after.state}, head ${after.headBranch}@${after.headSha || "(unreported)"}); its cards are left to the watcher.`;
              const writeWarning =
                writeError !== undefined
                  ? `The provider reported an error (${errorText(writeError)}), but the pull request now targets ${base}.`
                  : undefined;
              let projectionWarning: string | undefined;
              if (confirmWarning) {
                for (const card of target.cards) scheduleImmediatePoll(card.id);
              } else {
                try {
                  operations.projectRetarget(target.cards, base);
                } catch (error) {
                  projectionWarning = `The pull request was retargeted, but its card could not be updated: ${errorText(error)}. The watcher will reconcile it.`;
                  for (const card of target.cards)
                    scheduleImmediatePoll(card.id);
                }
              }
              const warnings = [
                confirmWarning,
                writeWarning,
                inventoryWarning,
                projectionWarning,
              ].filter((warning): warning is string => Boolean(warning));
              return jsonResult({
                status:
                  warnings.length > 0 ? "retargeted-partial" : "retargeted",
                ...summary,
                ...(warnings.length > 0 ? { warnings } : {}),
                message: [
                  after?.baseBranch === base
                    ? `Pull request #${target.number} now targets ${base} instead of ${target.baseBranch}. Re-check checks, review and mergeability before merging.`
                    : `Sent a retarget of pull request #${target.number} onto ${base}; it is not confirmed.`,
                  ...warnings,
                ].join(" "),
              });
            },
          );
        },
      );
    },
  });
}

/**
 * Reserve an active spawned worktree, re-resolve it unchanged under the
 * reservation, derive its canonical pull request and run `act` on it.
 */
export async function withReservedManagedTarget<T>(
  worktreeIdParam: string | undefined,
  ctx: ToolCallContext,
  operations: WorktreeFinishPullRequestOperations,
  reservationReason: string,
  options: ResolveManagedTargetOptions,
  act: (target: ManagedPullRequestTarget) => Promise<T>,
): Promise<T> {
  const worktreeId = worktreeIdParam?.trim();
  if (!worktreeId || isMainWorktreeId(worktreeId))
    throw new Error("An active spawned worktree id is required.");
  const initial = await operations.resolve(worktreeId);
  if (!initial || initial.status !== "active")
    throw new Error("That active managed worktree is not available.");
  const release = operations.reserve(
    initial.id,
    ctx.session.sessionId,
    reservationReason,
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
      throw new Error("The managed worktree target changed or was removed.");
    return await act(
      await resolveManagedTarget(row, operations, ctx.signal, options),
    );
  } finally {
    try {
      operations.invalidate(initial.id);
    } finally {
      release();
    }
  }
}

/**
 * Drop inventory reads after a provider write that may have landed even if its
 * response was lost. A failure here must not turn that write into a reported
 * provider failure, so it comes back as a warning.
 */
export function recordInventoryChange(
  operations: WorktreeFinishPullRequestOperations,
  target: ManagedPullRequestTarget,
): string | undefined {
  try {
    operations.inventoryChanged(target.hosted.provider, target.number);
    return undefined;
  } catch (error) {
    return `The PR inventory could not be refreshed: ${errorText(error)}.`;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ----------------------------- input validation ---------------------------- */

interface FinishRequest {
  worktreeId: string;
  action: "merge" | "close";
  method?: PullRequestMergeMethod;
  deleteRemoteBranch: boolean;
  markTaskDone: boolean;
  removeWorktree: boolean;
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

  if (params.timeoutSeconds !== undefined && !params.whenReady)
    throw new Error("timeoutSeconds requires whenReady.");
  if (action === "close") {
    if (params.whenReady !== undefined)
      throw new Error("whenReady applies to merge only.");
    if (params.method !== undefined)
      throw new Error(
        "method applies to merge only; a close never merges anything.",
      );
    if (params.deleteRemoteBranch !== undefined)
      throw new Error(
        "deleteRemoteBranch applies to merge only; a close always keeps the remote branch.",
      );
    if (
      params.markTaskDone !== undefined ||
      params.removeWorktree !== undefined
    )
      throw new Error("markTaskDone and removeWorktree apply to merge only.");
    if (!reason)
      throw new Error(
        "reason is required to close a pull request without merging.",
      );
    return {
      worktreeId,
      action,
      reason,
      deleteRemoteBranch: false,
      markTaskDone: false,
      removeWorktree: false,
    };
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
    markTaskDone: params.markTaskDone === true,
    removeWorktree: params.removeWorktree === true,
    ...(reason ? { reason } : {}),
  };
}

/* --------------------------- common target resolution ---------------------- */

/** The exact managed object this call may act on, proven from current state. */
export interface ManagedPullRequestTarget {
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

interface ResolveManagedTargetOptions {
  /**
   * Accept a pull request (and live cards) whose base is not the worktree's
   * recorded one — the retarget tool exists to settle exactly that. Head
   * branch and card ownership are still required to match.
   */
  baseMayDiffer?: boolean;
  providerSignal?: AbortSignal | undefined;
}

async function resolveManagedTarget(
  row: WorktreeRow,
  operations: WorktreeFinishPullRequestOperations,
  signal: AbortSignal | undefined,
  options: ResolveManagedTargetOptions = {},
): Promise<ManagedPullRequestTarget> {
  const target = await operations.target(row, signal);
  const hosted = await operations.hosting(
    target,
    signal,
    options.providerSignal,
  );
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
    throw new ManagedFinishRefusedError(
      "ambiguous",
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
      throw new ManagedFinishRefusedError(
        "not-open",
        `Pull request #${terminal.number} for ${row.branch} is already ${terminal.state}; nothing was done.`,
        terminal,
      );
    throw new ManagedFinishRefusedError(
      "no-pull-request",
      `No pull request exists for the managed branch ${row.branch}. Create one with worktree_create_pull_request first.`,
    );
  }
  const detail = await hosted.provider.pullRequestDetail(pr.number);
  if (!detail)
    throw new Error(
      `Pull request #${pr.number} could not be re-read from ${hosted.provider.kind}; nothing was done.`,
    );
  if (detail.state !== "open" || detail.merged)
    throw new ManagedFinishRefusedError(
      "not-open",
      `Pull request #${pr.number} is ${detail.merged ? "merged" : detail.state}; nothing was done.`,
      detail,
    );
  if (!detail.headSha)
    throw new Error(
      `Pull request #${pr.number} reports no head commit; nothing was done.`,
    );
  if (
    detail.headBranch !== row.branch ||
    (!options.baseMayDiffer && detail.baseBranch !== row.baseBranch)
  )
    throw new ManagedFinishRefusedError(
      "branches-changed",
      `Pull request #${pr.number} is ${detail.headBranch} → ${detail.baseBranch}, but this worktree is registered for ${row.branch} → ${row.baseBranch}; nothing was done.${detail.headBranch === row.branch ? ` Run worktree_retarget_pull_request to move it onto ${row.baseBranch}, or worktree_set_base if ${detail.baseBranch} is the right target.` : ""}`,
      detail,
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
  // finish onto it. Cards are matched by local checkout and number, so one
  // checkout publishing to two repositories that both have this number would
  // otherwise hand repository A's card to repository B's pull request.
  const repository = repositoryKeyFromUrl(hosted.provider.repoWebUrl);
  for (const card of cards) {
    const cardRepository = card.url
      ? repositoryKeyFromUrl(card.url)
      : undefined;
    if (!repository || cardRepository !== repository)
      throw new Error(
        `Pull request #${pr.number} has a live card for ${cardRepository ?? "an unknown repository"}, not ${repository ?? hosted.provider.repoWebUrl}; nothing was done.`,
      );
    if (card.worktreeId !== undefined && card.worktreeId !== row.id)
      throw new Error(
        `Pull request #${pr.number} has a live card owned by worktree ${card.worktreeId}, not ${row.id}; nothing was done.`,
      );
    if (
      card.headBranch !== detail.headBranch ||
      (!options.baseMayDiffer && card.baseBranch !== detail.baseBranch)
    )
      throw new Error(
        `Pull request #${pr.number} has a live card for ${card.headBranch} → ${card.baseBranch}, which no longer matches the pull request; nothing was done.${card.headBranch === detail.headBranch ? " Run worktree_retarget_pull_request to bring the card in line with the pull request." : ""}`,
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
  throw new ManagedFinishRefusedError(
    "not-ready",
    `Pull request #${number} is not ready to merge: ${readiness.mergeBlockers.join(", ")}. Investigate each blocker; the provider remains the authority on branch protections and permissions.`,
    readiness.detail,
    readiness,
  );
}

/** Bind a readiness verdict to the exact current PR identity it describes. */
function requireCurrentReadiness(
  readiness: PullRequestReadiness,
  target: ManagedPullRequestTarget,
): PullRequestReadiness {
  const detail = readiness.detail;
  if (detail.number !== target.number)
    throw new ManagedFinishRefusedError(
      "other-number",
      `Readiness described pull request #${detail.number}, not managed pull request #${target.number}; nothing was merged.`,
      detail,
    );
  if (detail.state !== "open" || detail.merged)
    throw new ManagedFinishRefusedError(
      "not-open",
      `Pull request #${target.number} became ${detail.merged ? "merged" : detail.state} while readiness was checked; nothing was merged.`,
      detail,
    );
  if (detail.headSha.toLowerCase() !== target.headSha.toLowerCase())
    throw new ManagedFinishRefusedError(
      "head-moved",
      `Pull request #${target.number} head moved from ${target.headSha} to ${detail.headSha} while it was being checked; nothing was merged.`,
      detail,
    );
  if (
    detail.headBranch !== target.headBranch ||
    detail.baseBranch !== target.baseBranch
  )
    throw new ManagedFinishRefusedError(
      "branches-changed",
      `Pull request #${target.number} changed from ${target.headBranch} → ${target.baseBranch} to ${detail.headBranch} → ${detail.baseBranch} while readiness was checked; nothing was merged.`,
      detail,
    );
  if (detail.draft)
    throw new ManagedFinishRefusedError(
      "draft",
      `Pull request #${target.number} became a draft while readiness was checked; nothing was merged.`,
      detail,
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
  // Without explicit completion, worktree links are display-only evidence.
  return tasks.length === 1 ? tasks[0] : undefined;
}

function requiredLinkedCardTask(target: ManagedPullRequestTarget): TaskSummary {
  const tasks = new Map(
    target.cards.flatMap((card) =>
      card.linkedTask ? [[card.linkedTask.id, card.linkedTask] as const] : [],
    ),
  );
  if (tasks.size !== 1)
    throw new Error(
      "markTaskDone requires a unique linked Task on the managed pull-request cards; nothing was merged.",
    );
  return tasks.values().next().value!;
}

function once(release: () => void): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

function invalidateAfterFinish(
  operations: WorktreeFinishPullRequestOperations,
  worktreeId: string,
): void {
  try {
    operations.invalidate(worktreeId);
  } catch (error) {
    console.warn(`[managed-merge] invalidating ${worktreeId} failed:`, error);
  }
}

async function finishFollowUps(
  input: ManagedMergeFollowUpInput,
  operations: WorktreeFinishPullRequestOperations,
  release: () => void,
): Promise<ManagedMergeFollowUpResult> {
  release();
  try {
    return await operations.followUps(input);
  } catch (error) {
    return {
      warnings: [
        `The merge succeeded, but follow-up steps failed: ${errorText(error)}.`,
      ],
    };
  }
}

/** The requested follow-ups a merge that is not confirmed did NOT run. */
function skippedFollowUps(request: {
  markTaskDone?: boolean;
  removeWorktree?: boolean;
}): string | undefined {
  const skipped = [
    request.markTaskDone ? "marking the Task done" : undefined,
    request.removeWorktree ? "removing the worktree" : undefined,
  ].filter(Boolean);
  return skipped.length > 0
    ? `Not done, because the merge is not confirmed: ${skipped.join(" and ")}.`
    : undefined;
}

function followUpMessage(result: ManagedMergeFollowUpResult): string {
  return [
    result.task ? `Task-${result.task.id} is done.` : undefined,
    result.worktreeRemoved ? "The worktree was removed." : undefined,
    ...result.warnings,
  ]
    .filter(Boolean)
    .join(" ");
}

/* --------------------------------- execute --------------------------------- */

async function executeWorktreeFinishPullRequest(
  params: WorktreeFinishPullRequestParams,
  ctx: ToolCallContext,
  operations: WorktreeFinishPullRequestOperations,
) {
  if (params.whenReady) return mergeWhenReady(params, ctx, operations);
  const request = validateRequest(params);
  if (request.action === "merge") {
    const payload = await finishManagedMerge(
      request,
      { sessionId: ctx.session.sessionId, toolCallId: ctx.toolCallId },
      operations,
      { signal: ctx.signal },
    );
    return {
      ...jsonResult(payload),
      ...(payload.status === "approval-pending" ? { terminate: true } : {}),
    };
  }
  const initial = await operations.resolve(request.worktreeId);
  if (!initial || initial.status !== "active")
    throw new Error("That active managed worktree is not available.");

  const reservation = operations.reserve(
    initial.id,
    ctx.session.sessionId,
    `A checked agent pull-request ${request.action} is in progress in this worktree.`,
  );
  if (!reservation) throw new Error(BUSY_REFUSAL);
  const release = once(reservation);
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
    return await runClose(request, target, operations);
  } finally {
    invalidateAfterFinish(operations, initial.id);
    release();
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

interface ManagedMergeOptions {
  signal?: AbortSignal | undefined;
  providerSignal?: AbortSignal | undefined;
  frozen?: FrozenMergeTarget;
  beforeOutwardStep?: () => void;
  exemptBackgroundItem?: { itemId: string; ownerSessionId: string };
}

type MergeCaller = { sessionId: string; toolCallId?: string };

/** The foreground and background managed merge share every authority check. */
async function finishManagedMerge(
  request: FinishRequest,
  caller: MergeCaller,
  operations: WorktreeFinishPullRequestOperations,
  options: ManagedMergeOptions = {},
) {
  const initial = await operations.resolve(request.worktreeId);
  if (!initial || initial.status !== "active")
    throw new Error("That active managed worktree is not available.");
  const reservation = operations.reserve(
    initial.id,
    caller.sessionId,
    "A checked agent pull-request merge is in progress in this worktree.",
  );
  if (!reservation) throw new WorktreeBusyError();
  const release = once(reservation);
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
      throw new ManagedFinishRefusedError(
        "worktree-changed",
        "The managed worktree target changed or was removed.",
      );
    const target = await resolveManagedTarget(row, operations, options.signal, {
      providerSignal: options.providerSignal,
    });
    if (options.frozen) assertFrozenMergeTarget(target, options.frozen);
    return await runMerge(
      request,
      target,
      caller,
      operations,
      release,
      options,
    );
  } finally {
    invalidateAfterFinish(operations, initial.id);
    release();
  }
}

async function runMerge(
  request: FinishRequest,
  target: ManagedPullRequestTarget,
  caller: MergeCaller,
  operations: WorktreeFinishPullRequestOperations,
  release: () => void,
  options: ManagedMergeOptions,
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
    options.signal,
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
  const linkedTask = request.markTaskDone
    ? requiredLinkedCardTask(target)
    : linkedTaskFor(target.row.id, operations);
  const intoDefaultBranch = readiness.detail.baseBranch === defaultBranch;

  if (intoDefaultBranch)
    return stageDefaultBranchApproval({
      request,
      target,
      caller,
      options,
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
    workflowActor: { kind: "agent", id: caller.sessionId },
    ...(options.beforeOutwardStep
      ? { beforeProviderWrite: options.beforeOutwardStep }
      : {}),
    // What made this merge pre-authorized: a base that was NOT the default
    // branch, judged against this default branch. The seam re-checks both
    // against its own authoritative read, so a default branch that moves
    // between here and the provider call cannot turn this into an unapproved
    // default-branch merge.
    managedDecision: { baseIsDefaultBranch: false, defaultBranch },
  });
  const merged = projection.result;
  if (merged.outcome === "pending")
    // Accepted, not confirmed: the same partial convention as
    // `retargeted-partial`. A retry follows the request already running, and
    // no follow-up may run on a merge nobody confirmed.
    return {
      action: "merge" as const,
      status: "merge-pending" as const,
      approvalRequired: false,
      provider: target.hosted.provider.kind,
      number: target.number,
      url: target.url,
      head: { ref: target.headBranch, sha: target.headSha },
      base: { ref: target.baseBranch },
      defaultBranch,
      baseIsDefaultBranch: false,
      method: merged.method,
      supportedMethods,
      pendingReason: merged.pendingReason,
      ...(request.reason ? { reason: request.reason } : {}),
      message: [
        projection.message,
        skippedFollowUps(request),
        "Its pull-request card follows the request: it turns merged once the provider confirms, or states the failure with Merge on offer again. Check the card or the pull request before cleaning up; a merge retried meanwhile follows the same request.",
      ]
        .filter(Boolean)
        .join(" "),
    };
  const followUps = await finishFollowUps(
    {
      worktreeId: target.row.id,
      number: target.number,
      sessionId: caller.sessionId,
      ...(options.exemptBackgroundItem
        ? { exemptBackgroundItem: options.exemptBackgroundItem }
        : {}),
      markTaskDone: request.markTaskDone,
      removeWorktree: request.removeWorktree,
      ...(linkedTask ? { taskId: linkedTask.id } : {}),
    },
    operations,
    release,
  );
  return {
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
    method: merged.method,
    supportedMethods,
    remoteBranchDeleted: merged.branchDeleted,
    ...(merged.branchDeleteError
      ? { remoteBranchDeleteError: merged.branchDeleteError }
      : {}),
    ...(merged.branchKeptReason
      ? { remoteBranchKeptReason: merged.branchKeptReason }
      : {}),
    cardIds: projection.cardIds,
    // What the projection actually WROTE, never what the worktree links
    // suggested it might: the merge suggests `done` only for Tasks linked on a
    // matching card, skips an already-done or missing one, and treats a failed
    // write as bookkeeping. Reporting the pre-merge link would tell the agent a
    // suggestion exists that nobody can answer.
    taskSuggestions: projection.taskSuggestions
      .filter((task) => task.id !== followUps.task?.id)
      .map((task) => ({
        id: task.id,
        title: task.title,
        statusSuggested: "done" as const,
      })),
    ...(request.reason ? { reason: request.reason } : {}),
    followUps,
    message: [projection.message, followUpMessage(followUps)]
      .filter(Boolean)
      .join(" "),
  };
}

function stageDefaultBranchApproval(input: {
  request: FinishRequest;
  target: ManagedPullRequestTarget;
  caller: MergeCaller;
  options: ManagedMergeOptions;
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
    markTaskDone: input.request.markTaskDone,
    removeWorktree: input.request.removeWorktree,
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
  input.options.beforeOutwardStep?.();
  const card = input.operations.approve({
    sessionId: input.caller.sessionId,
    title: `Merge #${target.number} into ${input.defaultBranch}`,
    summary: `${body.repo}#${target.number}: ${target.headBranch} → ${target.baseBranch} (${input.method})`,
    ...(input.caller.toolCallId
      ? { sourceToolCallId: input.caller.toolCallId }
      : {}),
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
    action: "merge" as const,
    status: "approval-pending" as const,
    ...(input.options.beforeOutwardStep
      ? { autoApproved: card.autoApproved === true }
      : {}),
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
    markTaskDone: input.request.markTaskDone,
    removeWorktree: input.request.removeWorktree,
    merged: false,
    message: `Pull request #${target.number} targets the default branch ${input.defaultBranch}. Nothing was merged: one approval was created, replacing any earlier pending merge card for this pull request, and the merge runs only after it is approved and the complete state revalidates. ${approvalCardReference(card)}`,
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
    const reservation = operations.reserve(
      body.worktreeId,
      // Server-side execution owns the hold outright: no session may already be
      // running in the worktree while an approved merge lands.
      `approval:${card.id}`,
      APPROVAL_RESERVATION_REASON,
    );
    if (!reservation)
      throw new Error(
        "That worktree is busy: a session is running or starting in it. Nothing was merged; approve again once it is idle.",
      );
    const release = once(reservation);
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
      if (projection.result.outcome === "pending")
        // Requested, not confirmed: no merged result is recorded, no
        // follow-up runs, and the summary says so in the projection's words.
        return {
          resultSummary: [
            projection.message,
            skippedFollowUps({
              markTaskDone: body.markTaskDone === true,
              removeWorktree: body.removeWorktree === true,
            }),
          ]
            .filter(Boolean)
            .join(" "),
          resultUrl: body.url,
        };
      body.resultMerged = true;
      body.resultBranchDeleted = projection.result.branchDeleted;
      const followUps = await finishFollowUps(
        {
          worktreeId: row.id,
          number: body.number,
          sessionId: card.sessionId,
          markTaskDone: body.markTaskDone === true,
          removeWorktree: body.removeWorktree === true,
          ...(body.linkedTask ? { taskId: body.linkedTask.id } : {}),
        },
        operations,
        release,
      );
      if (followUps.task) body.resultTaskDone = followUps.task.id;
      if (followUps.worktreeRemoved !== undefined)
        body.resultWorktreeRemoved = followUps.worktreeRemoved;
      body.resultFollowUpWarnings = followUps.warnings;
      return {
        resultSummary: [projection.message, followUpMessage(followUps)]
          .filter(Boolean)
          .join(" "),
        resultUrl: body.url,
      };
    } finally {
      invalidateAfterFinish(operations, body.worktreeId);
      release();
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
  if (
    body.markTaskDone &&
    requiredLinkedCardTask(target).id !== body.linkedTask?.id
  )
    throw new Error(
      "The linked Task changed since approval was requested; nothing was merged. Decide again with the current Task.",
    );
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
