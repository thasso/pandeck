/**
 * The ACTIONS on a live `/pr` card (Task 324, stage 3 of Task 320): merge,
 * update-with-main, the local cleanup after a remote merge, and answering the
 * linked Task's `done` suggestion.
 *
 * Every one of them is user-initiated. Nothing here runs on a timer or as a
 * consequence of the watcher seeing something: a merge is a decision, and so is
 * deleting a checkout. The module owns the ORDER and the REFUSALS; the actual
 * work belongs to the seams it calls — `gitHosting.ts` for the provider,
 * `worktrees/` for the deterministic git operations, `tasks.ts` for the Task.
 *
 * Three rules shape the code below:
 * - The provider decides whether a merge is allowed. Branch protection and
 *   required checks are its business, so nothing here pre-judges a merge; a
 *   refusal comes back as the provider's own message on the card.
 * - Destructive local work is never forced. `cleanup` verifies the branch is
 *   contained in the base and otherwise stops with an explanation, because a
 *   `--force` removal of a worktree whose commits are not in main is exactly the
 *   irreversible mistake this button exists to avoid.
 * - A conflict is handed to the agent, not to the user. `update-with-main` runs
 *   the deterministic rebase first and only lands a prompt in the session when
 *   git aborted on a conflict it cannot resolve deterministically.
 *
 * Actions run through {@link runPullRequestCardAction}, which serializes them on
 * the card's durable `busyAction` — a second click, from this tab or another,
 * is refused rather than racing the first.
 */
import type {
  Patch,
  PullRequestCard,
  PullRequestCardAction,
  PullRequestCardActionOptions,
  WorkflowActor,
} from "@assistant/shared";
import { randomUUID } from "node:crypto";
import type { WorktreeRow } from "./db/worktreeStore.ts";
import {
  liveSessionIdsForWorktree,
  worktreeIdForSession,
} from "./db/worktreeStore.ts";
import { registerAgentHandoffOutcome } from "./agentHandoffs.ts";
import { gitOptional } from "./gitExec.ts";
import {
  hostingProviderForRepo,
  type GitHostingProvider,
} from "./gitHosting.ts";
import {
  patchPullRequestCard,
  pullRequestCardById,
  pullRequestCardRecord,
  pullRequestCardsWithBusyAction,
} from "./pullRequestCards.ts";
import { pullRequestCardRepoRoot } from "./pullRequestHosting.ts";
import {
  mergePullRequestAndProject,
  reservePullRequestObservationGenerations,
  withPullRequestMutation,
} from "./pullRequestMerge.ts";
import { runPushWorkflow } from "./pushWorkflow.ts";
import { taskSummaryOf, updateTask } from "./tasks.ts";
import {
  sessionSettleBlockedReason,
  settleSessionsForRemovedWorktree,
} from "./sessionActivity.ts";
import {
  removeWorktree,
  type RemoveWorktreeOptions,
} from "./worktrees/worktrees.ts";
import {
  mainWorktreeId,
  resolveWorktreeRow,
} from "./worktrees/worktreeResolve.ts";
import { branchContainedInBase } from "./worktrees/worktreeStatus.ts";
import {
  baseBranchTarget,
  syncWorktree,
  WorktreeSyncConflictError,
} from "./worktrees/worktreeSync.ts";
import { reserveWorktreeForRemoval } from "./session/sessionRunLease.ts";
import {
  retireWorktree,
  type WorktreeRetireOperations,
} from "./worktreeRemoval.ts";

/** Hidden-prompt lead line for the conflict handoff (mirrors the outcome marker). */
export const PULL_REQUEST_REBASE_MARKER = "[pull request rebase]";

export interface PullRequestActionResult {
  card: PullRequestCard;
  /**
   * A prompt the caller must land in the card's session: set only by the
   * conflict handoff, so the connection layer owns steering/driver resolution
   * and this module stays free of session plumbing.
   */
  agentPrompt?: string;
  /**
   * Identity of THIS action, for the late write that reports how the handoff
   * ended (see {@link recordRebaseHandoff}).
   */
  actionToken: string;
}

/* ------------------------------ injectable ops ----------------------------- */

/**
 * The side-effecting seams, injectable exactly like `prWorkflow.ts`'s
 * `PrWorkflowOperations`: the ORDER of these calls is the contract worth
 * testing, and a test that had to build real worktrees to see it would test
 * git instead.
 */
export interface PullRequestActionOperations {
  resolveProvider(
    repoRoot: string,
    remote?: string,
  ): Promise<GitHostingProvider | null>;
  worktreeRow(worktreeId: string): Promise<WorktreeRow | undefined>;
  mainRow(row: WorktreeRow): Promise<WorktreeRow | undefined>;
  sync(
    row: WorktreeRow,
    operation: "pull-rebase" | "rebase-main",
  ): Promise<"updated" | "up-to-date">;
  refreshBase(row: WorktreeRow): Promise<string>;
  branchContained(row: WorktreeRow, baseTarget: string): Promise<boolean>;
  removeWorktree(
    worktreeId: string,
    options: RemoveWorktreeOptions,
  ): Promise<void>;
  pushBranch(cwd: string): Promise<{ status: string; error?: string }>;
  /**
   * The commit the checkout's branch stands at, or `undefined` when it cannot
   * be read. Used only as the conflict handoff's baseline: the head the agent
   * inherits, against which the watcher recognises the republished rebase.
   */
  headCommit(cwd: string): Promise<string | undefined>;
  /**
   * Why a session may NOT leave the inbox yet, in the shared wording, or
   * `undefined` when it may. Cleanup ends by settling the card's session and
   * every other live session on its worktree, so each answers to the same
   * predicate `connection.onSettleSession` and the browser use — "still
   * running" is not the only thing that is not done enough to leave; a queued
   * prompt and a pending approval/question are not either, and this action also
   * takes the worktree away.
   */
  sessionSettleBlockedReason(sessionId: string): Promise<string | undefined>;
  /**
   * Hold the WORKTREE against any run starting on it. `undefined` = refused,
   * because a run is already in flight there. Checking "is this session
   * running" can never be enough: another connection can start a run in the gap
   * before the removal, pass its own worktree guard while the checkout still
   * exists, and be left running in a deleted directory — and holding a SNAPSHOT
   * of the worktree's sessions would still miss one linked after the snapshot
   * (see `session/sessionRunLease.ts`).
   */
  reserveWorktreeForRemoval(
    worktreeId: string,
    reason: string,
  ): (() => void) | undefined;
  /**
   * The still-LIVE sessions linked to the worktree. A worktree is one-to-many —
   * a fork inherits the checkout, a review handoff links another — and a dev
   * session plus its review sessions is the ordinary shape, not an edge case.
   * Sessions that are settled, archived or deleted are finished with the
   * checkout and are not part of the consequence this action states.
   */
  liveSessionsForWorktree(worktreeId: string): string[];
  /**
   * Settle every live session the removal takes the checkout away from, and
   * refresh the ones that keep a dead edge — one call for the whole worktree,
   * shared with the worktree page's own removal.
   */
  settleWorktreeSessions(worktreeId: string): Promise<void> | void;
}

const defaultOperations: PullRequestActionOperations = {
  resolveProvider: hostingProviderForRepo,
  worktreeRow: resolveWorktreeRow,
  mainRow: (row) => resolveWorktreeRow(mainWorktreeId(row.projectId)),
  async sync(row, operation) {
    return (await syncWorktree(row, operation)).status;
  },
  refreshBase: baseBranchTarget,
  branchContained: (row, baseTarget) =>
    branchContainedInBase(row.mainRepoRoot, row.branch, baseTarget),
  // No `force`: containment is verified first, and a forced removal is exactly
  // the loss this action exists to prevent.
  removeWorktree: (worktreeId, options) =>
    removeWorktree(worktreeId, { ...options, deleteBranch: true }),
  pushBranch: (cwd) => runPushWorkflow({ cwd, force: true }),
  async headCommit(cwd) {
    const res = await gitOptional(["rev-parse", "HEAD"], cwd);
    return res.code === 0 ? res.stdout.trim() || undefined : undefined;
  },
  // The shared predicate, so this button, the worktree page's Remove and
  // `connection.onSettleSession` block on exactly the same thing.
  sessionSettleBlockedReason,
  reserveWorktreeForRemoval,
  liveSessionsForWorktree: liveSessionIdsForWorktree,
  // The SHARED answer to "the checkout is gone, what happens to its sessions",
  // so this button and the worktree page's Remove cannot answer it differently.
  settleWorktreeSessions: settleSessionsForRemovedWorktree,
};

/* ------------------------------ boot reconcile ----------------------------- */

/**
 * Clear a `busyAction` left behind by a restart or a crash, beside
 * `reconcilePullRequestCardsOnBoot`. The flag is durable ON PURPOSE — a merge
 * outlives a browser reload — but nothing is running after the process died, so
 * without this the card refuses every later click forever and the only way out
 * is editing a file under `DATA_DIR` by hand.
 *
 * It is left as an `actionError` rather than silently forgotten: an interrupted
 * merge may or may not have landed, and the user has to look. The watcher's own
 * poll settles which of the two it was for an `open` card.
 */
export function reconcilePullRequestCardActionsOnBoot(): void {
  for (const card of pullRequestCardsWithBusyAction()) {
    patchPullRequestCard(card.id, {
      busyAction: undefined,
      actionError: `The ${card.busyAction} action was interrupted by a server restart; it may or may not have completed. Check the pull request before retrying.`,
    });
  }
}

/* --------------------------------- entry ---------------------------------- */

export async function runPullRequestCardAction(
  cardId: string,
  action: PullRequestCardAction,
  options: PullRequestCardActionOptions = {},
  operations: PullRequestActionOperations = defaultOperations,
): Promise<PullRequestActionResult> {
  return runPullRequestCardActionAs(cardId, action, options, operations, {
    kind: "user",
  });
}

/** The same card seam, retaining the user action's coordinator attribution. */
export function runPullRequestCardActionWithActor(
  cardId: string,
  action: PullRequestCardAction,
  options: PullRequestCardActionOptions,
  actor: WorkflowActor & { kind: "user" },
  actingSessionId?: string,
  operations: PullRequestActionOperations = defaultOperations,
): Promise<PullRequestActionResult> {
  return runPullRequestCardActionAs(
    cardId,
    action,
    options,
    operations,
    actor,
    actingSessionId,
  );
}

async function runPullRequestCardActionAs(
  cardId: string,
  action: PullRequestCardAction,
  options: PullRequestCardActionOptions,
  operations: PullRequestActionOperations,
  actor: WorkflowActor & { kind: "user" },
  actingSessionId?: string,
): Promise<PullRequestActionResult> {
  const record = pullRequestCardRecord(cardId);
  if (!record) throw new Error("Pull request card not found.");
  if (record.card.busyAction)
    throw new Error(
      `This card is already running its ${record.card.busyAction} action.`,
    );

  // The running action is durable card state, not a local spinner: merging and
  // cleanup outlive a browser reload, and the refusal above must hold for every
  // viewer rather than for the tab that clicked first. The token identifies
  // THIS action so a late outcome can prove it is still the current one.
  const actionToken = randomUUID();
  patchPullRequestCard(
    cardId,
    {
      busyAction: action,
      actionError: undefined,
      actionMessage: undefined,
      // A new action supersedes the previous handoff: whatever the agent did
      // with the last rebase, this click is now the card's current story.
      rebaseHandedOff: undefined,
    },
    // The previous handoff's baseline goes with it. It describes ONE handoff —
    // the head that agent inherited — so an action that establishes no new one
    // must not inherit it either: the branch may have moved out of band since,
    // and the watcher would read that stale SHA as this rebase being published.
    { actionToken, rebaseHandoffHeadSha: undefined },
  );
  try {
    if (
      action === "update-with-main" &&
      record.card.number !== undefined &&
      record.card.provider
    )
      await reservePullRequestObservationGenerations({
        repoPath: record.context.repoRoot,
        providerKind: record.card.provider,
        number: record.card.number,
      });
    const result = await perform(
      record.card,
      record.context.repoRoot,
      record.context.remote,
      action,
      options,
      operations,
      actor,
      actingSessionId,
    );
    let card: PullRequestCard;
    try {
      card = patchPullRequestCard(
        cardId,
        {
          ...result.patch,
          busyAction: undefined,
        },
        // The handoff's baseline is written with the outcome, BEFORE the prompt
        // is offered to the session: `recordRebaseHandoff` may land much later,
        // and a watcher poll in between must already know which head the agent
        // inherited (see `handoffHeadSha`). Written unconditionally, absent
        // included: this action's answer is the only one that may stand, and a
        // conflict that could read no head at all says so.
        { rebaseHandoffHeadSha: result.handoffHeadSha },
      );
    } catch (err) {
      // The action already happened — the pull request is merged, the worktree
      // removed — and this write is its bookkeeping. Reporting it as a failure
      // would tell the user an external side effect that LANDED did not, and
      // the error path below would then try the very same store. So it is
      // logged, and the card is answered as it currently reads.
      console.warn(
        `[pull-request] recording the ${action} outcome on card ${cardId} failed:`,
        err,
      );
      card = pullRequestCardById(cardId) ?? record.card;
    }
    return {
      card,
      ...(result.agentPrompt ? { agentPrompt: result.agentPrompt } : {}),
      actionToken,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A failed action leaves the card's STATE alone — a refused merge is still
    // an open pull request — and says why, where the button is.
    patchPullRequestCard(cardId, {
      busyAction: undefined,
      actionError: message,
    });
    throw err;
  }
}

interface ActionOutcome {
  /** A clearing patch: `undefined` REMOVES the field. */
  patch: Patch<PullRequestCard>;
  agentPrompt?: string;
  /**
   * The head the branch stands at as the agent takes the conflict over. The
   * card's last provider observation when it has one — that is what the next
   * poll compares against — and the LOCAL branch head otherwise: a card whose
   * first poll has not landed yet would adopt the agent's rebased head as its
   * own baseline and never recognise the republished branch.
   */
  handoffHeadSha?: string;
}

function perform(
  card: PullRequestCard,
  repoRoot: string,
  remote: string | undefined,
  action: PullRequestCardAction,
  options: PullRequestCardActionOptions,
  operations: PullRequestActionOperations,
  actor: WorkflowActor & { kind: "user" },
  actingSessionId?: string,
): Promise<ActionOutcome> {
  switch (action) {
    case "merge":
      return mergeCard(card, repoRoot, remote, options, operations, actor);
    case "update-with-main":
      return updateWithMain(card, operations);
    case "cleanup":
      return cleanup(card, operations, actingSessionId);
    case "mark-task-done":
      return markTaskDone(card, actor);
  }
}

/* --------------------------------- merge ---------------------------------- */

async function mergeCard(
  card: PullRequestCard,
  repoRoot: string,
  remote: string | undefined,
  options: PullRequestCardActionOptions,
  operations: PullRequestActionOperations,
  actor: WorkflowActor & { kind: "user" },
): Promise<ActionOutcome> {
  const method = options.mergeMethod;
  if (!method) throw new Error("Choose a merge method.");
  if (card.status !== "open")
    throw new Error(
      `This pull request is ${card.status}; there is nothing to merge.`,
    );
  if (card.number === undefined)
    throw new Error("This card has no pull request to merge yet.");
  // Through the main checkout when the card's worktree has been removed: the
  // pull request is the provider's, and a retired checkout must not be what
  // stops the one action that can still answer a Workflow Run's merge gate
  // (`pullRequestHosting.ts`).
  const cardRepoRoot = pullRequestCardRepoRoot({
    repoRoot,
    ...(card.worktreeId ? { worktreeId: card.worktreeId } : {}),
  });
  const provider = await operations.resolveProvider(cardRepoRoot, remote);
  if (!provider)
    throw new Error(
      "No git hosting provider is configured for this repository.",
    );

  // The whole outcome — this card, any OTHER card on the same pull request, the
  // linked Task's suggestion and the worktree page's cached hosting state — is
  // written by the shared projection, so the two merge surfaces cannot drift.
  // It patches this card itself; the returned patch only re-states the message
  // for the action's own bookkeeping.
  const { message, cardIds } = await mergePullRequestAndProject({
    provider,
    repoPath: cardRepoRoot,
    number: card.number,
    headBranch: card.headBranch,
    baseBranch: card.baseBranch,
    method,
    // Deleting the remote branch stays the default; only an explicit `false`
    // from the click keeps it, so an older client that sends nothing merges
    // exactly as before.
    ...(options.deleteBranch === false ? { deleteBranch: false } : {}),
    ...(card.worktreeId ? { worktreeId: card.worktreeId } : {}),
    workflowActor: actor,
  });
  // `cardIds` are the cards the projection actually WROTE. Everything after the
  // provider accepts is best-effort there, so this card can be missing from it
  // — and then clearing `busyAction` over an `open` card would offer Merge
  // again for a pull request that is already in, until a watcher poll happens
  // to correct it. This action is the one writer that still has that card in
  // hand, so its own patch carries the terminal state instead of only the
  // message. It cannot fail the action either way: the merge LANDED.
  if (cardIds.includes(card.id)) return { patch: { actionMessage: message } };
  return {
    patch: {
      status: "merged",
      // Mergeability is a question about an OPEN pull request; the same
      // clearing the projection performs, for the same reason.
      mergeable: undefined,
      conflicts: undefined,
      actionError: undefined,
      actionMessage: message,
    },
  };
}

/* ---------------------------- update with main ----------------------------- */

async function updateWithMain(
  card: PullRequestCard,
  operations: PullRequestActionOperations,
): Promise<ActionOutcome> {
  if (card.status !== "open")
    throw new Error(
      `This pull request is ${card.status}; there is nothing to update.`,
    );
  const row = await requireWorktree(card, operations, "update");
  // Rebasing rewrites the branch this pull request is made of and republishes
  // it, so it must not run while the SAME pull request is being merged from
  // anywhere else — including the worktree page, which has no card and no
  // `busyAction`. Held for the whole operation, refused (never queued) when
  // something else already owns the pull request.
  if (card.number !== undefined && card.provider)
    return withPullRequestMutation(
      { repoPath: row.path, providerKind: card.provider, number: card.number },
      "an update with main",
      () => updateWithMainLocked(card, row, operations),
    );
  return updateWithMainLocked(card, row, operations);
}

async function updateWithMainLocked(
  card: PullRequestCard,
  row: WorktreeRow,
  operations: PullRequestActionOperations,
): Promise<ActionOutcome> {
  const main = await operations.mainRow(row);
  if (!main)
    throw new Error(
      "The project's main checkout could not be resolved, so there is nothing to rebase onto.",
    );

  // The base is refreshed FIRST: rebasing onto a stale main is the shape of
  // "updated with main" that leaves the pull request just as conflicted. A
  // failure here is reported as-is rather than handed to the agent — a dirty or
  // diverged main checkout is a user decision, not a merge conflict.
  try {
    await operations.sync(main, "pull-rebase");
  } catch (err) {
    throw new Error(
      `Could not update ${row.baseBranch} before rebasing: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    await operations.sync(row, "rebase-main");
  } catch (err) {
    if (err instanceof WorktreeSyncConflictError) {
      // Deterministic resolution is out of options: the rebase was aborted and
      // the branch restored, so the agent starts from the same clean state the
      // user would.
      // The message states ONLY what happened. Whether the agent took the work
      // is the caller's business and is recorded by `recordRebaseHandoff` once
      // the prompt is actually appended — a durable card must not claim a
      // handoff that a missing session or a rejected prompt then undoes, and a
      // restart in between must leave a sentence that is still true.
      //
      // The abort restored the branch, so its head right now is exactly what
      // the agent inherits — the baseline a later poll needs to tell the
      // republished rebase from the head that was always there. The card's own
      // last observation is preferred where it exists (the watcher compares
      // provider SHAs), and the local read covers the card that has not been
      // polled yet.
      const observed = pullRequestCardRecord(card.id)?.context.observedHeadSha;
      const handoffHeadSha =
        observed ?? (await operations.headCommit(row.path));
      return {
        patch: {
          actionMessage: `Rebasing ${card.headBranch} onto ${card.baseBranch} hit a conflict.`,
        },
        agentPrompt: rebaseConflictPrompt(
          card,
          err.conflictedFiles,
          err.conflictedFilesTruncated,
        ),
        ...(handoffHeadSha ? { handoffHeadSha } : {}),
      };
    }
    throw err;
  }

  // The pull request only sees the rebase once the branch is republished. Mint
  // again immediately before the head-changing push: a watcher may have started
  // after action admission while the local rebase was running.
  if (card.number !== undefined && card.provider)
    await reservePullRequestObservationGenerations({
      repoPath: row.path,
      providerKind: card.provider,
      number: card.number,
    });
  // A rebase always rewrites history, so this is a lease-guarded force push,
  // the same one `/push --force` performs.
  const push = await operations.pushBranch(row.path);
  if (push.status === "failed")
    throw new Error(
      `Rebased onto ${card.baseBranch}, but publishing the branch failed: ${push.error ?? "the push was rejected."} Push it yourself with /push --force.`,
    );
  return {
    patch: {
      actionMessage: `Rebased ${card.headBranch} onto ${card.baseBranch} and force-pushed it with lease.`,
      // The provider recomputes mergeability against the new head; the watcher
      // fills it in again on its next poll.
      mergeable: null,
      conflicts: undefined,
    },
  };
}

/**
 * The handoff-queue outcome kind that reports back here. A rebase prompt a
 * mid-turn session could not take is queued (`agentHandoffs.ts`) and may land
 * after a restart, by which time no closure survives — so the card names itself
 * durably and this handler answers for it whenever the answer arrives.
 */
export const PULL_REQUEST_REBASE_OUTCOME = "pull-request-rebase";

registerAgentHandoffOutcome(PULL_REQUEST_REBASE_OUTCOME, {
  delivered: (ref) =>
    recordRebaseHandoff(ref.id, { ok: true }, ref.token ?? ""),
  dropped: (ref, reason) =>
    recordRebaseHandoff(ref.id, { ok: false, reason }, ref.token ?? ""),
});

/**
 * Record how the conflict handoff actually ended, DURABLY. The action itself
 * can only report that the rebase conflicted; whether the session accepted the
 * prompt is known one layer up, and a failure there used to reach the user as
 * an ephemeral socket error while the card still read as a successful handoff.
 */
export function recordRebaseHandoff(
  cardId: string,
  outcome: { ok: true } | { ok: false; reason: string },
  /**
   * The token of the action this outcome belongs to. The write below can land
   * much later — a prompt rejection, or the append of a turn the user waited on
   * — by which time another action may own the card. Only an action mints a new
   * token (a merge from either surface rotates it too), so this correlates
   * exactly: the watcher's routine CI/review patches leave it alone and must not
   * suppress a valid outcome, while a genuinely newer action invalidates it.
   * `updatedAt` cannot do this job — the watcher bumps it every poll.
   */
  actionToken: string,
): void {
  const record = pullRequestCardRecord(cardId);
  const card = record?.card;
  if (!card || record?.context.actionToken !== actionToken) return;
  patchPullRequestCard(
    cardId,
    outcome.ok
      ? {
          actionMessage: `Rebasing ${card.headBranch} onto ${card.baseBranch} hit a conflict; handed it to this session's agent.`,
          actionError: undefined,
          // The prompt IS in the session now, so the button stops offering the
          // rebase and says who has it. Set only on the accepted path: a prompt
          // that never landed leaves the click to be made again.
          rebaseHandedOff: true,
        }
      : {
          actionMessage: undefined,
          actionError: `Rebasing ${card.headBranch} onto ${card.baseBranch} hit a conflict and it could not be handed to this session's agent: ${outcome.reason} Rebase it yourself, or open the session and ask there.`,
          rebaseHandedOff: undefined,
        },
  );
}

/** What the session's agent is asked to do when the deterministic rebase aborts. */
export function rebaseConflictPrompt(
  card: PullRequestCard,
  conflictedFiles: readonly string[] = [],
  conflictedFilesTruncated = false,
): string {
  return [
    PULL_REQUEST_REBASE_MARKER,
    `The user asked to update pull request #${card.number ?? "?"} (${card.headBranch} → ${card.baseBranch}) with ${card.baseBranch}.`,
    "The deterministic rebase hit a conflict and was ABORTED, so the branch is back at its original commit and the working tree is clean.",
    ...(conflictedFiles.length > 0
      ? [
          `Conflicted files${conflictedFilesTruncated ? " (truncated; inspect Git for the complete set)" : ""}:`,
          ...conflictedFiles.map((file) => `- ${file}`),
        ]
      : ["Git could not determine the conflicted file names."]),
    "",
    "Please:",
    `1. Rebase ${card.headBranch} onto the up-to-date ${card.baseBranch} yourself and resolve the conflicts, preserving the intent of both sides minimally.`,
    "2. Run the project's checks on the result.",
    "3. Push the rebased branch with `--force-with-lease` so the pull request picks it up.",
    "4. If a conflict cannot be resolved safely, stop, abort the rebase, and explain which file and why.",
  ].join("\n");
}

/* -------------------------------- cleanup ---------------------------------- */

async function cleanup(
  card: PullRequestCard,
  operations: PullRequestActionOperations,
  actingSessionId?: string,
): Promise<ActionOutcome> {
  if (card.status !== "merged")
    throw new Error(
      "Cleanup is only offered once the pull request is merged; nothing was removed.",
    );
  if (card.cleanedUp) throw new Error("This worktree was already cleaned up.");
  const row = await requireWorktree(card, operations, "clean up");
  // Adapt the card's injectable seams to the shared retire sequence. Its own
  // session stays first so this surface can preserve its subject-aware refusal
  // and outcome wording; the inbox uses the worktree-wide defaults directly.
  const retireOperations: WorktreeRetireOperations = {
    resolveWorktree: operations.worktreeRow,
    refreshBase: operations.refreshBase,
    branchContained: operations.branchContained,
    async blockedReason() {
      try {
        await requireSettleable(
          sessionsToSettle(card, row, operations).filter(
            (sessionId) => sessionId !== actingSessionId,
          ),
          operations,
        );
        return undefined;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    reserveForRemoval: (worktreeId) =>
      operations.reserveWorktreeForRemoval(
        worktreeId,
        `This worktree is being cleaned up after pull request #${card.number ?? "?"} merged.`,
      ),
    sessionsToSettle: () => sessionsToSettle(card, row, operations),
    removeWorktree: (worktreeId, options) =>
      operations.removeWorktree(worktreeId, options),
    async settleSessions(worktreeId) {
      await operations.settleWorktreeSessions(worktreeId);
    },
  };
  const result = await retireWorktree(
    row.id,
    { deleteBranch: true },
    retireOperations,
  );
  if (result.status === "refused") throw new Error(result.refusal);

  return {
    patch: {
      cleanedUp: true,
      actionMessage: `Removed the worktree and deleted ${result.branch}; ${result.baseBranch} is up to date and ${settledPhrase(result.settledSessions)}.`,
    },
  };
}

/**
 * Every session this cleanup settles: the card's own first — it is the one the
 * button speaks for — then the other LIVE sessions on the checkout.
 *
 * Sessions that are settled, archived or deleted are left out: a finished
 * review session must not stand between a merged pull request and its worktree,
 * and a dev session plus one or two review/fork sessions on one checkout is the
 * normal shape, so counting every session ever linked refused the common case.
 */
function sessionsToSettle(
  card: PullRequestCard,
  row: WorktreeRow,
  operations: PullRequestActionOperations,
): string[] {
  return [
    card.sessionId,
    ...operations
      .liveSessionsForWorktree(row.id)
      .filter((sessionId) => sessionId !== card.sessionId),
  ];
}

/** How the outcome names what was settled, siblings included. */
function settledPhrase(count: number): string {
  const others = count - 1;
  if (others <= 0) return "this session is settled";
  return `this session and ${others} other${others === 1 ? "" : "s"} on this worktree are settled`;
}

/* ------------------------------ linked Task -------------------------------- */

async function markTaskDone(
  card: PullRequestCard,
  actor: WorkflowActor & { kind: "user" },
): Promise<ActionOutcome> {
  const linked = card.linkedTask;
  if (!linked) throw new Error("This pull request has no linked Task.");
  // The button ANSWERS the suggestion a merge left behind, so it exists only
  // once there is one. Without this guard a stale or hand-made message could
  // close the Task while the pull request is still open — the client hides the
  // button then, but client gating is not a rule.
  if (card.status !== "merged")
    throw new Error(
      `This pull request is ${card.status}; its Task is not answered by merging yet.`,
    );
  // Written as the USER, not suggested: the click IS the answer to the
  // suggestion the merge left behind, and a suggestion answering itself would
  // be one more thing to confirm.
  const updated = updateTask(linked.id, {
    status: "done",
    actor,
    clearStatusSuggestion: true,
  });
  return {
    patch: {
      linkedTask: taskSummaryOf(updated),
      actionMessage: `Marked Task-${updated.id} done.`,
    },
  };
}

/* --------------------------------- helpers --------------------------------- */

/**
 * Refuse unless EVERY session this cleanup would settle may leave the inbox —
 * the SHARED predicate, so cleanup blocks on exactly what
 * `connection.onSettleSession` and the browser block on. A sibling still
 * running (or holding a queued prompt or a pending approval) is the one case
 * that refuses outright: settling it would be settling work that is not done.
 * Called twice on purpose: once up front, and once immediately before the
 * removal (see the note there).
 */
async function requireSettleable(
  sessionIds: string[],
  operations: PullRequestActionOperations,
): Promise<void> {
  for (const [index, sessionId] of sessionIds.entries()) {
    const blocked = await operations.sessionSettleBlockedReason(sessionId);
    if (!blocked) continue;
    const subject =
      index === 0 ? "this session" : "another session on this worktree";
    throw new Error(
      `Cleanup ends by settling ${subject}, but ${blocked} Nothing was removed — try again once that is resolved.`,
    );
  }
}

async function requireWorktree(
  card: PullRequestCard,
  operations: PullRequestActionOperations,
  verb: string,
): Promise<WorktreeRow> {
  const worktreeId = card.worktreeId ?? worktreeIdForSession(card.sessionId);
  const row = worktreeId ? await operations.worktreeRow(worktreeId) : undefined;
  if (!row || row.status !== "active")
    throw new Error(
      `This pull request's session has no active worktree, so there is nothing to ${verb} here.`,
    );
  // `/pr --base <branch>` can target a base the worktree does not track. Both
  // local actions then talk about the wrong branch: `rebase-main` rebases onto
  // the MAIN CHECKOUT's branch (`row.baseBranch`) and containment is verified
  // against it, while the card would report the base the user chose. Refuse
  // rather than act on one branch and claim the other.
  if (row.baseBranch !== card.baseBranch)
    throw new Error(
      `This pull request targets ${card.baseBranch}, but its worktree tracks ${row.baseBranch}. Nothing was done — ${verb} it against ${card.baseBranch} by hand.`,
    );
  return row;
}
