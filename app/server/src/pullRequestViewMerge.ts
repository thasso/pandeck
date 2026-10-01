/**
 * The Pull Requests view's ONE action: merge the pull request, then clean up
 * after it — `POST /api/pull-requests/merge`.
 *
 * It needs an entry point of its own because neither existing one fits. The
 * `/pr` card's actions are CARD-bound (`pullRequestCardAction`, serialized on
 * that card's `busyAction`) and the worktree page's merge is WORKTREE-bound
 * (`POST /api/worktrees/:id/merge-pr`); this view has no card and need not have
 * a worktree at all. What it has is the four-component identity its route is
 * built from — project, provider, `owner/repo`, number — and everything else is
 * re-derived here from that. A head branch, SHA or checkout path taken from the
 * client would let a surface that is a minute stale merge something it never
 * showed.
 *
 * It owns no lifecycle of its own either. The merge is
 * `pullRequestMerge.ts`'s projection (provider merge + remote branch + cards +
 * the linked Task's `done` SUGGESTION + base refresh) and the cleanup is
 * `worktreeRemoval.ts`'s `retireWorktree` (refresh the exact base target →
 * containment → removal hold → remove → settle sessions). This module is the
 * order between them and nothing more:
 *
 *  1. resolve the repository from the identity, and ASSERT the checkout it
 *     found really is that repository (a project may hold two);
 *  2. take the pull request's mutation lock for the WHOLE operation, so this
 *     view and the `/pr` card cannot both act on it — the loser is refused,
 *     never queued;
 *  3. read the pull request once to derive what is being merged;
 *  4. merge, then clean up — in that order, and never the other way. A merge
 *     that landed is reported as landed whatever the cleanup then did; that is
 *     why the two phases are separate answers on the wire.
 *
 * {@link checkPullRequestFromView} is the same resolution with NO side effect:
 * what this pull request is, read under that same lock, for a client whose
 * request went unanswered.
 */
import type {
  PullRequestViewCheckRequest,
  PullRequestViewCheckResponse,
  PullRequestViewCleanupOutcome,
  PullRequestViewMergeOutcome,
  PullRequestViewMergeRequest,
  PullRequestViewMergeResponse,
  TaskSummary,
  WorktreeRetireResponse,
} from "@assistant/shared";
import type { WorktreeRow } from "./db/worktreeStore.ts";
import { errorText } from "./errors.ts";
import {
  hostingProviderForRepo,
  type GitHostingProvider,
} from "./gitHosting.ts";
import { pullRequestIdentityThrough } from "./pullRequestIdentity.ts";
import { invalidatePullRequestInventoryReads } from "./pullRequestInventory.ts";
import {
  obsoletePullRequestInventoryBuild,
  requestPullRequestInventoryRefresh,
} from "./pullRequestInventorySync.ts";
import {
  mergePullRequestAndProjectLocked,
  withPullRequestMutation,
  type MergePullRequestInput,
  type MergePullRequestProjection,
} from "./pullRequestMerge.ts";
import { retireWorktree } from "./worktreeRemoval.ts";
import { invalidateProjectPullRequests } from "./worktrees/worktreeHosting.ts";
import { isMainWorktreeId } from "./worktrees/worktreeResolve.ts";
import {
  listWorktreeRows,
  type RemoveWorktreeOptions,
} from "./worktrees/worktrees.ts";

/**
 * A request this endpoint refuses before doing anything: an identity that
 * resolves to no repository, a missing merge method, a pull request that is no
 * longer in the state the click was for. `status` is the HTTP code, so the
 * handler classifies nothing by matching on message text.
 */
export class PullRequestViewMergeError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "PullRequestViewMergeError";
  }
}

/** The side-effecting seams, injectable as in the neighbouring modules. */
export interface PullRequestViewMergeOperations {
  worktreeRows(): Promise<WorktreeRow[]>;
  resolveProvider(path: string): Promise<GitHostingProvider | null>;
  /** The shared merge projection, called with the mutation lock ALREADY held. */
  merge(input: MergePullRequestInput): Promise<MergePullRequestProjection>;
  retire(
    worktreeId: string,
    options: RemoveWorktreeOptions,
  ): Promise<WorktreeRetireResponse>;
  /**
   * Drop what the inventory's two TTL caches remember about this pull request,
   * so the refetch that follows this action reads the repository again.
   */
  forgetInventoryReads(projectId: string, identityKey: string): void;
}

const defaultOperations: PullRequestViewMergeOperations = {
  worktreeRows: listWorktreeRows,
  resolveProvider: (path) => hostingProviderForRepo(path),
  merge: mergePullRequestAndProjectLocked,
  retire: retireWorktree,
  forgetInventoryReads: (projectId, identityKey) => {
    // Both halves of the projection: the per-project open-PR list this pull
    // request was selected from, and the per-pull-request detail/CI/review
    // reads that annotate it. Dropping one and not the other still answers
    // with a merged pull request described as open.
    invalidateProjectPullRequests(projectId);
    invalidatePullRequestInventoryReads(identityKey);
    requestPullRequestInventoryRefresh();
  },
};

/** The repository this identity names, and the checkout that proves it. */
interface ResolvedRepository {
  provider: GitHostingProvider;
  /** Any checkout of it; used for repo identity and the base refresh. */
  repoPath: string;
  /** `<provider>#<owner>/<repo>#<number>` — the inventory's own cache key. */
  identityKey: string;
}

/**
 * The project's active checkouts and the repository this identity names — the
 * preamble both entry points share, before either touches the lock.
 */
async function resolve(
  request: PullRequestViewCheckRequest,
  operations: PullRequestViewMergeOperations,
): Promise<{ rows: WorktreeRow[]; repository: ResolvedRepository }> {
  const rows = (await operations.worktreeRows()).filter(
    (row) => row.projectId === request.projectId && row.status === "active",
  );
  if (rows.length === 0)
    throw new PullRequestViewMergeError(
      `Project ${request.projectId} has no active checkout on this machine.`,
      404,
    );
  return {
    rows,
    repository: await resolveRepository(request, rows, operations),
  };
}

export async function mergePullRequestFromView(
  request: PullRequestViewMergeRequest,
  operations: PullRequestViewMergeOperations = defaultOperations,
): Promise<PullRequestViewMergeResponse> {
  const { rows, repository } = await resolve(request, operations);
  // The local worktree is resolved from the SAME identity, never from the
  // client: the row whose branch is this pull request's head AND whose own push
  // remote is this repository. A same-named branch publishing to a fork is
  // other work, which is exactly the join the inventory refuses to make too.
  return withPullRequestMutation(
    {
      repoPath: repository.repoPath,
      providerKind: request.provider,
      number: request.number,
    },
    "a merge & clean up",
    () => mergeAndCleanUp(request, repository, rows, operations),
  );
}

/**
 * What this pull request IS, under its own mutation lock — and nothing else.
 *
 * It answers the one question a lost RESPONSE leaves open. Re-issuing the merge
 * would answer it too, but only while that merge is still possible: a pull
 * request that has since become a draft or conflicted, or whose method the
 * repository no longer allows, refuses every attempt with an authoritative
 * guard, and the surface would stay uncertain forever over a pull request that
 * is merely unmergeable right now. Reading the state cannot refuse for any of
 * those reasons.
 *
 * The lock is what makes it an ANSWER rather than another guess: acquiring it
 * proves whatever held it — the lost request included — has finished. A caller
 * that cannot acquire it is refused as busy and still knows nothing, which is
 * the honest answer while something is still running.
 */
export async function checkPullRequestFromView(
  request: PullRequestViewCheckRequest,
  operations: PullRequestViewMergeOperations = defaultOperations,
): Promise<PullRequestViewCheckResponse> {
  const { rows, repository } = await resolve(request, operations);
  return withPullRequestMutation(
    {
      repoPath: repository.repoPath,
      providerKind: request.provider,
      number: request.number,
    },
    "a state check",
    async () => {
      const detail = await repository.provider.pullRequestDetail(
        request.number,
      );
      if (!detail)
        throw new PullRequestViewMergeError(
          `Pull request #${request.number} could not be read from ${request.provider}; its state is still unknown.`,
          409,
        );
      const local = await resolveWorktree(
        request,
        detail.headBranch,
        rows,
        operations,
      );
      // The caller refetches the inventory on this answer, and that projection
      // caches for 60 s — including, possibly, the very state this read just
      // contradicted.
      // The check may have discovered an external mutation while an older build
      // was in flight. Obsolete it before the cache invalidation schedules a
      // replacement; this endpoint still attempts no provider or git mutation.
      obsoletePullRequestInventoryBuild();
      forgetInventoryReads(request, repository, operations);
      return {
        number: request.number,
        state: detail.state,
        ...(detail.draft ? { draft: true } : {}),
        // Three-valued, so it travels whenever the detail answered at all.
        mergeable: detail.mergeable,
        // Three answers, never two: "two checkouts stand on this branch" is not
        // "there is no checkout", and a surface told the latter would announce
        // that nothing local is left while both are still there.
        checkout: local.ambiguity
          ? { status: "ambiguous", reason: local.ambiguity }
          : local.worktreeId
            ? { status: "one", worktreeId: local.worktreeId }
            : { status: "none" },
      };
    },
  );
}

async function mergeAndCleanUp(
  request: PullRequestViewMergeRequest,
  repository: ResolvedRepository,
  rows: WorktreeRow[],
  operations: PullRequestViewMergeOperations,
): Promise<PullRequestViewMergeResponse> {
  // One read, to derive what is being merged. It is NOT the identity check the
  // merge is conditioned on: the shared seam re-reads the pull request as the
  // last thing before the provider call, after its forced capability read, and
  // refuses a head or base that moved in between (`docs/pull-requests.md`).
  const detail = await repository.provider.pullRequestDetail(request.number);
  if (!detail)
    throw new PullRequestViewMergeError(
      `Pull request #${request.number} could not be read from ${request.provider}. Nothing was done — try again.`,
      409,
    );

  const local = await resolveWorktree(
    request,
    detail.headBranch,
    rows,
    operations,
  );

  let merge: PullRequestViewMergeOutcome;
  let taskSuggestions: TaskSummary[] = [];
  if (detail.state === "open") {
    // Never defaulted: merging with a strategy the user did not choose is not a
    // detail the server gets to decide. A client that sent none was looking at
    // a pull request it believed terminal, so it is asked again rather than
    // merged for.
    if (!request.method)
      throw new PullRequestViewMergeError(
        `Pull request #${request.number} is open; choose a merge method (squash, merge or rebase).`,
        400,
      );
    const projection = await operations.merge({
      provider: repository.provider,
      repoPath: repository.repoPath,
      number: request.number,
      headBranch: detail.headBranch,
      baseBranch: detail.baseBranch,
      method: request.method,
      ...(request.deleteRemoteBranch === false ? { deleteBranch: false } : {}),
      ...(local.worktreeId ? { worktreeId: local.worktreeId } : {}),
    });
    merge = {
      status: "merged",
      method: projection.result.method,
      headBranch: detail.headBranch,
      baseBranch: detail.baseBranch,
      remoteBranch:
        request.deleteRemoteBranch === false
          ? "kept"
          : projection.result.branchDeleted
            ? "deleted"
            : "not-deleted",
      ...(projection.result.branchDeleteError
        ? { remoteBranchError: projection.result.branchDeleteError }
        : {}),
    };
    taskSuggestions = projection.taskSuggestions;
    // The shared merge projection obsoletes an in-flight snapshot build. This
    // view still drops its own provider-read caches below, without bumping the
    // snapshot epoch a second time.
    forgetInventoryReads(request, repository, operations);
  } else {
    // Already merged or closed. That is not an error on THIS surface: the view
    // lists a terminal pull request precisely while its checkout survives, and
    // this same action is what clears it.
    merge = { status: "already-terminal", state: detail.state };
  }

  const cleanup = await cleanUp(request, local, operations);
  // `retireWorktree` obsoletes the snapshot when it removes the checkout. Drop
  // the provider-read caches too, without a second epoch bump.
  if (cleanup.status === "retired")
    forgetInventoryReads(request, repository, operations);

  return { number: request.number, merge, cleanup, taskSuggestions };
}

/**
 * Cache bookkeeping, and therefore best-effort like everything else that
 * happens after the provider accepted: a failure here costs one stale poll
 * period, while throwing would report a merge that LANDED as a failed action.
 */
function forgetInventoryReads(
  request: PullRequestViewCheckRequest,
  repository: ResolvedRepository,
  operations: PullRequestViewMergeOperations,
): void {
  try {
    operations.forgetInventoryReads(request.projectId, repository.identityKey);
  } catch (err) {
    console.warn(
      `[pull-request] could not drop the inventory reads for #${request.number}:`,
      err,
    );
  }
}

/** What the local half of the action found, before it is asked to do anything. */
interface LocalCheckout {
  worktreeId?: string;
  /** Why there is no single checkout to act on, when there is not. */
  ambiguity?: string;
}

async function cleanUp(
  request: PullRequestViewMergeRequest,
  local: LocalCheckout,
  operations: PullRequestViewMergeOperations,
): Promise<PullRequestViewCleanupOutcome> {
  if (!request.removeWorktree) return { status: "not-requested" };
  if (local.ambiguity) return { status: "failed", error: local.ambiguity };
  if (!local.worktreeId) return { status: "no-worktree" };
  try {
    const result = await operations.retire(local.worktreeId, {
      // One consequence, one answer: this item removes the checkout AND deletes
      // its local branch, which is what makes the containment question — and
      // therefore the consent ladder — apply at all.
      deleteBranch: true,
      ...(request.forceRemoveWorktree === true ? { force: true } : {}),
    });
    if (result.status === "refused")
      return {
        status: "refused",
        worktreeId: local.worktreeId,
        refusal: result.refusal,
        refusalKind: result.refusalKind,
      };
    return {
      status: "retired",
      worktreeId: local.worktreeId,
      branch: result.branch,
      baseBranch: result.baseBranch,
      branchDeleted: result.branchDeleted,
      settledSessions: result.settledSessions,
      deliveryVerified: result.deliveryVerified,
    };
  } catch (err) {
    // The merge above already landed. A cleanup that threw is reported as
    // itself and never rethrown: turning it into the action's error would
    // report a merged pull request as an unmerged one.
    return {
      status: "failed",
      worktreeId: local.worktreeId,
      error: errorText(err),
    };
  }
}

/**
 * The repository this pull request belongs to, from the project's own
 * checkouts.
 *
 * The main checkout is tried first because it is the one whose list produced
 * the item, then the spawned worktrees, because a worktree may publish to a
 * `pushurl` repository its main checkout does not list. Whichever answers, it
 * must PROVE it is `provider#owner/repo`: resolving a provider from a path and
 * then merging "#7" there is how one repository's number reaches another's pull
 * request.
 */
async function resolveRepository(
  request: PullRequestViewCheckRequest,
  rows: WorktreeRow[],
  operations: PullRequestViewMergeOperations,
): Promise<ResolvedRepository> {
  const candidates = [
    ...rows.filter((row) => isMainWorktreeId(row.id)),
    ...rows.filter((row) => !isMainWorktreeId(row.id)),
  ];
  for (const row of candidates) {
    const provider = await operations
      .resolveProvider(row.path)
      .catch(() => null);
    const identity = provider && identityOf(provider, request);
    if (provider && identity)
      return { provider, repoPath: row.path, identityKey: identity.key };
  }
  throw new PullRequestViewMergeError(
    `No checkout of project ${request.projectId} publishes to ${request.repositoryKey} on ${request.provider}, so pull request #${request.number} could not be resolved.`,
    404,
  );
}

/**
 * This pull request's identity through a resolved provider — the shared rule in
 * `pullRequestIdentity.ts`, so this endpoint and the review checkout cannot
 * drift about which repository a number belongs to.
 */
function identityOf(
  provider: GitHostingProvider,
  request: PullRequestViewCheckRequest,
): { repositoryKey: string; key: string } | undefined {
  return pullRequestIdentityThrough(provider, request);
}

/**
 * The local checkout this pull request's cleanup would remove: an ACTIVE
 * spawned worktree of this project standing on the provider-reported head
 * branch, in this same repository.
 *
 * Two of them is not a choice this endpoint gets to make on the user's behalf —
 * it would delete a checkout the dialog never named — so ambiguity is reported
 * as itself and the merge still stands.
 */
async function resolveWorktree(
  request: PullRequestViewCheckRequest,
  headBranch: string,
  rows: WorktreeRow[],
  operations: PullRequestViewMergeOperations,
): Promise<LocalCheckout> {
  const onBranch = rows.filter(
    (row) => !isMainWorktreeId(row.id) && row.branch === headBranch,
  );
  const matched: WorktreeRow[] = [];
  for (const row of onBranch) {
    const provider = await operations
      .resolveProvider(row.path)
      .catch(() => null);
    if (provider && identityOf(provider, request)) matched.push(row);
  }
  if (matched.length > 1)
    return {
      ambiguity: `${matched.length} local worktrees stand on ${headBranch} in ${request.repositoryKey}; none was removed. Remove the one you mean from its own page.`,
    };
  const worktree = matched[0];
  return worktree ? { worktreeId: worktree.id } : {};
}
