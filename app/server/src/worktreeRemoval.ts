/**
 * Removing a worktree from the worktree page, as ONE decision (Task 340).
 *
 * Deleting a checkout is the same act the `/pr` card's cleanup performs at the
 * end of a merge, so it asks the same questions in the same order — and it has
 * to, because the sessions working in that checkout are affected either way:
 * they lose the directory they run in and they leave the inbox. Answering that
 * differently on the two surfaces is how a review session ends up settled by
 * one button and abandoned with a dead-worktree banner by the other.
 *
 * The order is the contract:
 * 1. REFUSE while a live session on the worktree may not be settled — running,
 *    or holding a queued prompt or an unanswered approval/question — before any
 *    git side effect. `settleBlockedReason` is the shared predicate; the browser
 *    and `connection.onSettleSession` block on exactly the same thing.
 * 2. HOLD the worktree (`session/sessionRunLease.ts`) so no run can START in it
 *    while the directory is being deleted, including in a session linked to it
 *    after the hold was taken. A run already in flight cannot be held and
 *    refuses the removal instead.
 * 3. Ask (1) again under the hold, then remove, then settle. Sampling a
 *    predicate is never enough on its own: another connection can start a run
 *    in the gap and pass its own worktree guard while the checkout still
 *    exists.
 *
 * Two failures arrive AFTER removal is durable and are handled alike: a branch
 * cleanup that did not land, and a checkout directory that survived because
 * another uid owns part of it (Task 659). Both settle sessions first and then
 * reach the caller, because the row is already a tombstone either way. The
 * matching pre-mutation refusal, `WorktreeUndeletableError`, is reported as
 * `"permissions"` rather than `"git-guard"`: force answers a guard about losing
 * work, and nothing answers a file this server may not delete.
 *
 * Git's guards stay owned by `worktrees/worktrees.ts`. Its typed
 * `WorktreeRemovalBlockedError` proves no mutation happened, so Retire can turn
 * it into structured refusal data. `WorktreeBranchCleanupError` means checkout
 * removal DID finish, so sessions settle before the branch error is rethrown and
 * its oid-bound cleanup can be retried. `force` overrides losing git work; it
 * never skips the session gates. Containment is asked only of a removal that
 * DELETES the branch: keeping it keeps every commit, so there is nothing to
 * consent to and nothing to force.
 *
 * Every refusal says WHAT refused (`refusalKind`), because that decides who can
 * answer it. Retire's verification is the network refresh plus containment
 * against that exact commit, and no local scan can stand in for it: a base
 * branch missing locally may still be fetchable, so a surface must escalate to
 * `force` from THIS refusal rather than from its own guess. A `"sessions"`
 * refusal is nobody's to escalate — `force` never overrides those gates.
 *
 * A retirement reports `deliveryVerified` for the same reason: `force` and
 * keeping the branch both SKIP containment, so only this seam knows whether the
 * question was answered, and a surface claiming a verification that never ran
 * would misreport precisely the safety this flow exists for.
 */
import type {
  WorktreeRetireRefusalKind,
  WorktreeRetireResponse,
} from "@assistant/shared";
import type { WorktreeRow } from "./db/worktreeStore.ts";
import {
  liveSessionIdsForWorktree,
  sessionIdsForWorktree,
} from "./db/worktreeStore.ts";
import { backgroundWorkSupervisor } from "./backgroundWork/supervisor.ts";
import {
  settleSessionsForRemovedWorktree,
  worktreeSettleBlockedReason,
} from "./sessionActivity.ts";
import { reserveWorktreeForRemoval } from "./session/sessionRunLease.ts";
import {
  removeWorktree,
  WorktreeBranchCleanupError,
  WorktreeDirectoryResidueError,
  WorktreeRemovalBlockedError,
  WorktreeUndeletableError,
  type RemoveWorktreeOptions,
} from "./worktrees/worktrees.ts";
import {
  isMainWorktreeId,
  resolveWorktreeRow,
} from "./worktrees/worktreeResolve.ts";
import { branchContainedInBase } from "./worktrees/worktreeStatus.ts";
import { baseBranchTarget } from "./worktrees/worktreeSync.ts";
import { invalidatePullRequestInventorySnapshot } from "./pullRequestInventorySync.ts";

/** The side-effecting seams, injectable exactly like `PullRequestActionOperations`. */
export interface WorktreeRemovalOperations {
  settleBlockedReason(worktreeId: string): Promise<string | undefined>;
  reserveForRemoval(
    worktreeId: string,
    reason: string,
  ): (() => void) | undefined;
  sessionsToSettle(worktreeId: string): string[];
  removeWorktree(
    worktreeId: string,
    options: RemoveWorktreeOptions,
  ): Promise<void>;
  settleSessions(worktreeId: string): Promise<void>;
  stopTrackedWork?(worktreeId: string): Promise<void>;
}

const STOP_TRACKED_WORK_BUDGET_MS = 3_000;

/**
 * Stop the background work of EVERY session that ran in the checkout. A live
 * session with running work already refused the removal; what reaches here is
 * work left behind by settled or archived sessions — the dev server nobody
 * remembers. Bounded: the process sweep in `removeWorktree` is the backstop.
 */
async function stopTrackedWorkForWorktree(worktreeId: string): Promise<void> {
  const now = Date.now();
  const stops = Promise.allSettled(
    sessionIdsForWorktree(worktreeId).map((ownerSessionId) =>
      backgroundWorkSupervisor.stopAllOwner({
        ownerSessionId,
        sourceRequestId: `worktree-removal:${worktreeId}:${now}`,
        reason: "Its worktree was removed",
      }),
    ),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    stops,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, STOP_TRACKED_WORK_BUDGET_MS);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
}

const defaultOperations: WorktreeRemovalOperations = {
  settleBlockedReason: worktreeSettleBlockedReason,
  reserveForRemoval: reserveWorktreeForRemoval,
  sessionsToSettle: liveSessionIdsForWorktree,
  removeWorktree,
  settleSessions: settleSessionsForRemovedWorktree,
  stopTrackedWork: stopTrackedWorkForWorktree,
};

/** Injectable seams for the full retire sequence. */
export interface WorktreeRetireOperations {
  resolveWorktree(worktreeId: string): Promise<WorktreeRow | undefined>;
  refreshBase(row: WorktreeRow): Promise<string>;
  branchContained(row: WorktreeRow, baseTarget: string): Promise<boolean>;
  blockedReason(worktreeId: string): Promise<string | undefined>;
  reserveForRemoval(
    worktreeId: string,
    reason: string,
  ): (() => void) | undefined;
  sessionsToSettle(worktreeId: string): string[];
  removeWorktree(
    worktreeId: string,
    options: RemoveWorktreeOptions,
  ): Promise<void>;
  settleSessions(worktreeId: string): Promise<void>;
  stopTrackedWork?(worktreeId: string): Promise<void>;
  /** Drop a cleanup item whose local worktree no longer exists. */
  inventoryChanged?(): void;
}

const defaultRetireOperations: WorktreeRetireOperations = {
  resolveWorktree: resolveWorktreeRow,
  refreshBase: baseBranchTarget,
  branchContained: (row, baseTarget) =>
    branchContainedInBase(row.mainRepoRoot, row.branch, baseTarget),
  async blockedReason(worktreeId) {
    const blocked = await worktreeSettleBlockedReason(worktreeId);
    return blocked ? retireRefusal(blocked) : undefined;
  },
  reserveForRemoval: reserveWorktreeForRemoval,
  sessionsToSettle: liveSessionIdsForWorktree,
  removeWorktree,
  settleSessions: settleSessionsForRemovedWorktree,
  stopTrackedWork: stopTrackedWorkForWorktree,
  inventoryChanged: invalidatePullRequestInventorySnapshot,
};

interface GuardedRemovalOperations {
  blockedReason(worktreeId: string): Promise<string | undefined>;
  reserveForRemoval(
    worktreeId: string,
    reason: string,
  ): (() => void) | undefined;
  sessionsToSettle(worktreeId: string): string[];
  removeWorktree(
    worktreeId: string,
    options: RemoveWorktreeOptions,
  ): Promise<void>;
  settleSessions(worktreeId: string): Promise<void>;
  stopTrackedWork?(worktreeId: string): Promise<void>;
}

/** What refused, so a caller can tell a session gate from a git guard. */
type GuardedRefusalKind = "sessions" | "git-guard" | "permissions";

type GuardedRemovalResult =
  | { status: "removed"; settledSessions: number }
  | { status: "refused"; refusal: string; kind: GuardedRefusalKind };

const RUN_STARTING_REFUSAL =
  "A run is starting in this worktree right now. Nothing was removed — try again once it is idle.";

/**
 * The ONE hold → re-check → remove → settle sequence used by Remove, Retire and
 * `/pr` cleanup. `prechecked` is Retire's initial gate from before its base pull.
 */
async function guardedRemoveWorktree(
  worktreeId: string,
  options: RemoveWorktreeOptions,
  operations: GuardedRemovalOperations,
  config: {
    holdReason: string;
    prechecked?: boolean;
    blockersAreRefusals: boolean;
  },
): Promise<GuardedRemovalResult> {
  if (!config.prechecked) {
    const blocked = await operations.blockedReason(worktreeId);
    if (blocked)
      return { status: "refused", refusal: blocked, kind: "sessions" };
  }

  const release = operations.reserveForRemoval(worktreeId, config.holdReason);
  if (!release)
    return {
      status: "refused",
      refusal: RUN_STARTING_REFUSAL,
      kind: "sessions",
    };
  try {
    const stillBlocked = await operations.blockedReason(worktreeId);
    if (stillBlocked)
      return { status: "refused", refusal: stillBlocked, kind: "sessions" };

    const settledSessions = operations.sessionsToSettle(worktreeId).length;
    // Two failures that are NOT failures of the removal: by the time either is
    // thrown the checkout is gone and the row is a tombstone, so the sessions
    // that ran in it must settle before the error reaches the caller. A
    // branch-cleanup failure keeps its identity-bound retry; a leftover
    // directory keeps its sentence for the user.
    let durableFailure: Error | undefined;
    try {
      const stopTrackedWork = operations.stopTrackedWork;
      await operations.removeWorktree(worktreeId, {
        ...options,
        ...(stopTrackedWork
          ? { stopTrackedWork: () => stopTrackedWork(worktreeId) }
          : {}),
      });
    } catch (err) {
      if (
        err instanceof WorktreeBranchCleanupError ||
        err instanceof WorktreeDirectoryResidueError
      ) {
        durableFailure = err;
      } else if (
        config.blockersAreRefusals &&
        err instanceof WorktreeRemovalBlockedError
      ) {
        return {
          status: "refused",
          refusal: `${err.message}${
            err instanceof WorktreeUndeletableError
              ? ""
              : " Nothing was removed."
          }`,
          // A tree owned by another user is not something `force` can answer,
          // and offering consent there would be a checkbox that buys nothing.
          kind:
            err instanceof WorktreeUndeletableError
              ? "permissions"
              : "git-guard",
        };
      } else {
        throw err;
      }
    }

    // Removal is already durable and broadcast. Session settlement refreshes
    // clients after that fact; a refresh failure must not turn a completed
    // removal into an error whose retry can only find a missing worktree.
    await operations.settleSessions(worktreeId).catch(() => undefined);
    if (durableFailure) throw durableFailure;
    return { status: "removed", settledSessions };
  } finally {
    release();
  }
}

/**
 * Refresh the exact base target, verify delivery, then remove the worktree and
 * settle its sessions. Session, containment and typed git refusals are data so
 * HTTP and `/pr` can write their own outcome sentences; other failures remain
 * errors.
 */
export async function retireWorktree(
  worktreeId: string,
  options: RemoveWorktreeOptions = {},
  operations: WorktreeRetireOperations = defaultRetireOperations,
): Promise<WorktreeRetireResponse> {
  const row = await operations.resolveWorktree(worktreeId);
  if (!row) throw new Error("That worktree is no longer available.");
  if (isMainWorktreeId(row.id))
    throw new Error("The main checkout cannot be retired.");

  const refused = (
    message: string,
    kind: WorktreeRetireRefusalKind,
  ): WorktreeRetireResponse => ({
    worktreeId: row.id,
    status: "refused",
    branch: row.branch,
    baseBranch: row.baseBranch,
    refusal: message,
    refusalKind: kind,
  });
  if (row.status === "removed") {
    if (!row.branchCleanupOid || !options.deleteBranch)
      throw new Error("That worktree is no longer available.");
    const cleanup = await guardedRemoveWorktree(row.id, options, operations, {
      holdReason: "This worktree's pending branch cleanup is being retried.",
      blockersAreRefusals: true,
    });
    if (cleanup.status === "refused")
      return refused(cleanup.refusal, cleanup.kind);
    operations.inventoryChanged?.();
    return {
      worktreeId: row.id,
      status: "retired",
      branch: row.branch,
      baseBranch: row.baseBranch,
      branchDeleted: true,
      settledSessions: cleanup.settledSessions,
      // Conservatively NOT verified, even unforced. The oid-bound cleanup does
      // check containment, but it also succeeds on a branch that is ALREADY
      // ABSENT (deleted out of band after the first failure) — nothing was
      // discarded there and nothing was proven, so an unforced success is not
      // evidence of delivery. This seam cannot tell the two apart from here,
      // and `deliveryVerified` promises that containment passed.
      deliveryVerified: false,
    };
  }

  const blocked = await operations.blockedReason(row.id);
  if (blocked) return refused(blocked, "sessions");

  // Refresh the exact merge target instead of assuming the Project's main
  // checkout is also this worktree's base. Stacked workflows deliberately use
  // another local branch as their base, and that branch may be checked out in a
  // different worktree whose local ref is still behind the remote merge.
  //
  // A base that cannot be refreshed AT ALL — deleted after a stacked base
  // landed, renamed upstream, never local — proves nothing either way, so it is
  // fatal only to the one decision it was needed for: deleting the branch
  // unconsented. Throwing instead made such a worktree unretirable by any
  // answer the dialog could give, force included.
  let baseTarget: string | undefined;
  try {
    baseTarget = await operations.refreshBase(row);
  } catch (err) {
    if (options.deleteBranch && !options.force)
      return refused(
        `${row.baseBranch} could not be refreshed, so delivery of ${row.branch} cannot be verified: ${err instanceof Error ? err.message : String(err)} Nothing was removed — keep the branch, or explicitly confirm discarding it.`,
        "delivery",
      );
  }
  // Delivery is verified for what this retirement would DISCARD. Keeping the
  // branch discards nothing — the commits stay reachable on its ref — so a
  // checkout-only retirement asks nothing of the user, and the exact target is
  // still carried into removal for the guards that do apply.
  //
  // Whether that question was ANSWERED is the outcome's to report: only a
  // containment check that ran and passed proves delivery, and a surface must
  // not describe a forced or checkout-only retirement as verified.
  let deliveryVerified = false;
  if (baseTarget !== undefined && options.deleteBranch && !options.force) {
    if (!(await operations.branchContained(row, baseTarget)))
      return refused(
        `${row.branch} is not contained in the refreshed ${row.baseBranch}. Nothing was removed — check the branch, keep it, or explicitly confirm discarding it.`,
        "delivery",
      );
    deliveryVerified = true;
  }

  const removal = await guardedRemoveWorktree(
    row.id,
    {
      ...options,
      ...(baseTarget === undefined
        ? {}
        : { branchContainmentBase: baseTarget }),
    },
    operations,
    {
      prechecked: true,
      holdReason: "This worktree is being retired.",
      blockersAreRefusals: true,
    },
  );
  if (removal.status === "refused")
    return refused(removal.refusal, removal.kind);
  operations.inventoryChanged?.();
  return {
    worktreeId: row.id,
    status: "retired",
    branch: row.branch,
    baseBranch: row.baseBranch,
    branchDeleted: options.deleteBranch === true,
    settledSessions: removal.settledSessions,
    deliveryVerified,
  };
}

/**
 * Remove a worktree and settle the sessions that ran in it.
 *
 * Returns a session REFUSAL to show the user, or `undefined` once it is done.
 * Git guards keep throwing their typed error for the WebSocket caller.
 */
export async function removeWorktreeAndSettleSessions(
  worktreeId: string,
  options: RemoveWorktreeOptions = {},
  operations: WorktreeRemovalOperations = defaultOperations,
): Promise<string | undefined> {
  const result = await guardedRemoveWorktree(
    worktreeId,
    options,
    {
      blockedReason: async (id) => {
        const blocked = await operations.settleBlockedReason(id);
        return blocked ? removalRefusal(blocked) : undefined;
      },
      reserveForRemoval: operations.reserveForRemoval,
      sessionsToSettle: operations.sessionsToSettle,
      removeWorktree: operations.removeWorktree,
      settleSessions: operations.settleSessions,
      ...(operations.stopTrackedWork
        ? { stopTrackedWork: operations.stopTrackedWork }
        : {}),
    },
    {
      holdReason: "This worktree is being removed.",
      blockersAreRefusals: false,
    },
  );
  return result.status === "refused" ? result.refusal : undefined;
}

function removalRefusal(blocked: string): string {
  return `Removing this worktree settles the sessions working in it, but ${blocked} Nothing was removed — try again once that is resolved.`;
}

function retireRefusal(blocked: string): string {
  return `Retiring this worktree settles the sessions working in it, but ${blocked} Nothing was removed — try again once that is resolved.`;
}
