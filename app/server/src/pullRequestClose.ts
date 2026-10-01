/**
 * The ONE server-side projection of a pull request CLOSED without merging
 * (Task 588), beside `pullRequestMerge.ts` and under the same per-PR mutation
 * lock: closing and merging are two outward transitions of one object, and a
 * close that raced a merge would otherwise project onto a card the merge is
 * already rewriting.
 *
 * Closing is deliberately NOT a merge with a different verb. It abandons the
 * work, so it:
 *   - never suggests the linked Task `done` — nothing landed;
 *   - never records a merge in a Workflow Run, only the observed closure;
 *   - never deletes the remote branch, the local branch or the worktree. The
 *     branch is what the work still lives in, and reopening/cleanup are the
 *     user's decisions on their own surfaces.
 *
 * A close that LANDED but whose confirmation or projection failed is an honest
 * partial success: the provider write is not retried and not disowned, and the
 * existing watcher/boot reconciliation settles the card.
 */
import type {
  PullRequestCard,
  PullRequestCloseResult,
} from "@assistant/shared";
import { randomUUID } from "node:crypto";
import type { GitHostingProvider } from "./gitHosting.ts";
import {
  beginPullRequestCardObservation,
  patchPullRequestCard,
} from "./pullRequestCards.ts";
import { pullRequestIdentity } from "./pullRequestIdentity.ts";
import { invalidatePullRequestInventoryReads } from "./pullRequestInventory.ts";
import {
  openCardsForPullRequest,
  withPullRequestMutation,
} from "./pullRequestMerge.ts";
import { invalidatePullRequestInventorySnapshot } from "./pullRequestInventorySync.ts";
import {
  invalidateProjectPullRequests,
  invalidateWorktreeHosting,
} from "./worktrees/worktreeHosting.ts";
import { observePullRequestCardForWorkflows } from "./workflow/pullRequestObservation.ts";

export interface ClosePullRequestInput {
  provider: GitHostingProvider;
  /** Any checkout of the repository; used for repo identity, never for display. */
  repoPath: string;
  number: number;
  headBranch: string;
  baseBranch: string;
  /** Exact head the caller decided about; the provider refuses any other. */
  expectedHeadSha: string;
  /** The caller's stated reason, retained on the card and in the transcript. */
  reason: string;
  /** Worktree whose hosting cache must be dropped, when the caller knows it. */
  worktreeId?: string;
}

export interface ClosePullRequestProjection {
  result: PullRequestCloseResult;
  /** What happened, in one sentence: the close, then what was KEPT. */
  message: string;
  /** Cards this close moved to `closed` (a card surface may not exist at all). */
  cardIds: string[];
}

export interface ClosePullRequestOperations {
  inventoryChanged?(input: ClosePullRequestInput): void;
}

const defaultCloseOperations: ClosePullRequestOperations = {
  inventoryChanged(input) {
    invalidateProjectPullRequests();
    const identity = pullRequestIdentity(
      input.provider.kind,
      input.provider.repoWebUrl,
      input.number,
    );
    if (identity) invalidatePullRequestInventoryReads(identity.key);
    invalidatePullRequestInventorySnapshot();
  },
};

/** Close and project. The single entry point for closing a managed PR. */
export async function closePullRequestAndProject(
  input: ClosePullRequestInput,
  operations: ClosePullRequestOperations = defaultCloseOperations,
): Promise<ClosePullRequestProjection> {
  return withPullRequestMutation(
    {
      repoPath: input.repoPath,
      providerKind: input.provider.kind,
      number: input.number,
    },
    "a close",
    () => closeAndProject(input, operations),
  );
}

async function closeAndProject(
  input: ClosePullRequestInput,
  operations: ClosePullRequestOperations,
): Promise<ClosePullRequestProjection> {
  // Revalidate the exact object under the lock. The provider read below is the
  // authority; this one only refuses early, before any write, when the world
  // has visibly moved on.
  const detail = await input.provider.pullRequestDetail(input.number);
  if (!detail)
    throw new Error(
      `Pull request #${input.number} could not be read; nothing was closed.`,
    );
  if (detail.state !== "open" || detail.merged)
    throw new Error(
      `Pull request #${input.number} is already ${detail.merged ? "merged" : detail.state}; nothing was closed.`,
    );
  if (detail.headSha.toLowerCase() !== input.expectedHeadSha.toLowerCase())
    throw new Error(
      `Pull request #${input.number} head moved from ${input.expectedHeadSha} to ${detail.headSha}; nothing was closed.`,
    );
  if (
    detail.headBranch !== input.headBranch ||
    detail.baseBranch !== input.baseBranch
  )
    throw new Error(
      `Pull request #${input.number} is ${detail.headBranch} → ${detail.baseBranch}, not ${input.headBranch} → ${input.baseBranch}; nothing was closed.`,
    );

  const cards = await openCardsForPullRequest({
    repoPath: input.repoPath,
    providerKind: input.provider.kind,
    number: input.number,
  });
  // Reserve BEFORE the provider write: every older poll describes state from
  // before this close and may no longer settle a workflow observation.
  for (const card of cards) beginPullRequestCardObservation(card.id);

  const result = await input.provider.closePullRequest(input.number, {
    expectedHeadSha: detail.headSha,
  });

  const message = [
    result.closed
      ? `Closed #${input.number} (${input.headBranch} → ${input.baseBranch}) without merging: ${input.reason}`
      : `Sent a request to close #${input.number} (${input.headBranch} → ${input.baseBranch}) without merging, but closure is unconfirmed: ${input.reason}`,
    `The remote branch ${input.headBranch} and the local worktree were kept.`,
    ...(result.unconfirmedReason ? [result.unconfirmedReason] : []),
  ].join(" ");

  const invalidated = new Set<string>(
    input.worktreeId ? [input.worktreeId] : [],
  );
  const projectedCards: PullRequestCard[] = [];
  for (const card of cards) {
    projectedCards.push(
      patchPullRequestCard(
        card.id,
        {
          // An unconfirmed write is deliberately left open so its watcher keeps
          // polling and can reconcile the provider's eventual state.
          status: result.closed ? "closed" : "open",
          ...(result.closed
            ? {
                // Mergeability is only meaningful while the PR is open.
                mergeable: undefined,
                conflicts: undefined,
              }
            : {}),
          busyAction: undefined,
          actionError: undefined,
          actionMessage: message,
        },
        {
          // Supersede older actions and polls in both outcomes. A partial mints
          // a fresh open observation generation; the watcher starts after it.
          actionToken: randomUUID(),
          observationToken: randomUUID(),
          observedHeadSha: detail.headSha,
        },
      ),
    );
    if (card.worktreeId) invalidated.add(card.worktreeId);
  }
  if (result.closed) {
    // Only confirmed closure is a terminal Workflow observation. A partial
    // remains open and is settled by the ordinary watcher/boot reconciliation.
    for (const card of projectedCards)
      await observePullRequestCardForWorkflows(card, detail.headSha).catch(
        (err) =>
          console.warn(
            `[workflow] could not record the close of pull request #${input.number}:`,
            err,
          ),
      );
  }
  // Refresh both confirmed and partial outcomes: a post-write read may have
  // failed, and the worktree page must not keep a stale pre-write snapshot.
  for (const worktreeId of invalidated) invalidateWorktreeHosting(worktreeId);
  operations.inventoryChanged?.(input);
  // A confirmed card left `open`, so its watcher stops; a partial stays open.

  return { result, message, cardIds: cards.map((card) => card.id) };
}
