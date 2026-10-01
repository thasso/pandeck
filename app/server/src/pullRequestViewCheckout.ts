/**
 * The Pull Requests view's REVIEW action, local half:
 * `POST /api/pull-requests/checkout` — create or update the worktree that
 * stands on this pull request's head branch, so a session can be opened in it.
 *
 * It addresses the pull request the way the merge and the check do — by the
 * four-component identity its route is built from — and re-derives everything
 * else here: the repository from the project's own main checkout (ASSERTED to
 * be `provider#owner/repo`, since one project can hold two), the head and base
 * branches from a provider read, the commit from a fetch of that head, and the
 * checkout to update from the row standing on that branch IN THAT REPOSITORY.
 * A branch, SHA, path or worktree id taken from the client would let a surface
 * a minute stale check out something it never showed.
 *
 * It owns no git of its own. Creation is `worktrees.ts`'s `track-remote`
 * source (the worktree's own branch IS the head branch and tracks
 * `<remote>/<head>`), and the update is `worktreeSync.ts`'s `pull-rebase`,
 * which is already exactly "bring a tracking branch to its upstream". What is
 * here is the ORDER, the identity, and the refusals:
 *
 *  1. resolve the repository and take the pull request's mutation lock, so this
 *     and a merge cannot both act on it — the loser is refused, never queued;
 *  2. read the pull request once, fetch its head into the remote-tracking ref,
 *     and prove the branch that came back IS that head;
 *  3. create, or update the one existing checkout, or report that it already
 *     stands there.
 *
 * Every refusal is DATA on a 200. A dirty checkout, a diverged branch, a branch
 * tracking something else, a head that is not on this remote: each is reported
 * as itself, because none of them is a thing this action may resolve by
 * guessing. It never resets, forces or re-points a branch it did not create.
 */
import type {
  PullRequestCheckoutBase,
  PullRequestCheckoutOutcome,
  PullRequestCheckoutRefusalKind,
  PullRequestViewCheckoutRequest,
  PullRequestViewCheckoutResponse,
  WorktreeSyncResponse,
} from "@assistant/shared";
import type { WorktreeRow } from "./db/worktreeStore.ts";
import { errorText } from "./errors.ts";
import { git, gitOptional, gitOptionalExit } from "./gitExec.ts";
import {
  hostingProviderForRepo,
  type GitHostingProvider,
} from "./gitHosting.ts";
import { pullRequestIdentityThrough } from "./pullRequestIdentity.ts";
import { invalidatePullRequestInventorySnapshot } from "./pullRequestInventorySync.ts";
import { withPullRequestMutation } from "./pullRequestMerge.ts";
import { PullRequestViewMergeError } from "./pullRequestViewMerge.ts";
import { taskIdsForWorktree } from "./db/worktreeStore.ts";
import { taskSummaryFor } from "./tasks.ts";
import { sanitizeWorktreeSuffix } from "./worktrees/worktreeNaming.ts";
import { isMainWorktreeId } from "./worktrees/worktreeResolve.ts";
import {
  syncWorktree,
  WorktreeSyncPreconditionError,
  type WorktreeSyncExpectation,
} from "./worktrees/worktreeSync.ts";
import {
  createWorktree,
  listWorktreeRows,
  WorktreeCreateRefusalError,
} from "./worktrees/worktrees.ts";

/**
 * The remote that carries this pull request's branches.
 *
 * Not a guess and not a client's word: the repository identity is PROVEN
 * through `hostingProviderForRepo`, which resolves the provider from this
 * remote's push URL. The remote whose URL says `owner/repo` is the remote whose
 * `refs/heads/<head>` is that repository's head branch.
 */
const PULL_REQUEST_REMOTE = "origin";

/**
 * Non-interactive, like every other network-bound git call here: with no tty a
 * credential or host-key prompt would hang the request instead of failing.
 */
const REMOTE_ENV: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND:
    "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20",
};

/** What one fetch of the pull request's head found. Absence is never success. */
export type PullRequestHeadFetch =
  { status: "fetched"; oid: string } | { status: "unreachable"; error: string };

/** What an existing checkout IS, before anything is asked of it. */
export interface CheckoutInspection {
  /**
   * The branch actually checked out there, empty when it is DETACHED. A
   * detached checkout tracks nothing whatever commit it sits on, so this is not
   * derivable from the oids below.
   */
  branch: string;
  /** `branch.<name>.remote`, empty when the branch has no upstream. */
  upstreamRemote: string;
  /** `branch.<name>.merge`, e.g. `refs/heads/feature-7`. */
  upstreamMerge: string;
  /** The commit the checkout stands at. */
  head: string;
  /** Uncommitted or untracked files are present. */
  dirty: boolean;
  /** `head` is an ancestor of (or equal to) the pull request's head commit. */
  headIsAncestorOfPullRequest: boolean;
}

/** The created checkout, as the creation reported it. */
export interface CreatedCheckout {
  worktreeId: string;
  branch: string;
  path: string;
  baseBranch: string;
  /** The commit the new checkout actually stands at, read from it. */
  head: string;
}

/** The side-effecting seams, injectable as in the neighbouring modules. */
export interface PullRequestViewCheckoutOperations {
  worktreeRows(): Promise<WorktreeRow[]>;
  resolveProvider(path: string): Promise<GitHostingProvider | null>;
  /**
   * Fetch `<remote>/<headBranch>` into its remote-tracking ref. Network-bound
   * and therefore OUTSIDE the repository lock, and it writes ONLY
   * `refs/remotes/<remote>/<headBranch>` — never a local branch, which is the
   * line the lock rule draws (`app/server/src/CLAUDE.md`). `FETCH_HEAD` counts
   * as a local write for that purpose: `worktreeSync.ts` and
   * `baseCheckoutRefresh.ts` READ it under the lock to decide what to rebase
   * onto, so a lock-free fetch that wrote it could hand a locked operation this
   * pull request's head as its target. See {@link pullRequestHeadFetchArgs}.
   */
  fetchHead(
    repoPath: string,
    remote: string,
    headBranch: string,
  ): Promise<PullRequestHeadFetch>;
  /** Read-only, so lock-free: what the existing checkout is right now. */
  inspect(row: WorktreeRow, headCommit: string): Promise<CheckoutInspection>;
  create(input: {
    projectId: string;
    name: string;
    remote: string;
    headBranch: string;
    /** The verified commit to check out; the branch is created AT it. */
    headCommit: string;
    preferredBaseBranch: string;
  }): Promise<CreatedCheckout>;
  /**
   * `pull-rebase`, which takes the repository lock itself — and which is given
   * the two oids this module verified, so it can refuse under that lock rather
   * than land on whatever its own fetch brings back.
   */
  update(
    row: WorktreeRow,
    expected: WorktreeSyncExpectation,
  ): Promise<WorktreeSyncResponse>;
  /**
   * The LIVE Tasks the server's own edges link to this checkout.
   *
   * Live, not merely linked: an archived Task is not in the projection a
   * client's Tasks list is built from either, so an edge naming only archived
   * Tasks is SPENT — and reporting it would both attach an archived Task and
   * suppress the weaker links that should then have their turn. Empty means
   * "no live Task", in exactly the sense a browser's fresh list means it.
   */
  taskIdsFor(worktreeId: string): string[];
  /** Schedule the persisted inventory to pick up a changed local checkout. */
  inventoryChanged?(): void;
}

/**
 * The fetch's exact argv, so the isolation the lock exception claims is a
 * TESTABLE fact rather than a comment.
 *
 * `--no-write-fetch-head` is the whole point beside the explicit refspec: git
 * writes `FETCH_HEAD` for every fetch unless told not to, whatever the
 * destination ref is, and this fetch deliberately runs without the repository
 * lock.
 */
export function pullRequestHeadFetchArgs(
  remote: string,
  headBranch: string,
): string[] {
  return [
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    "--",
    remote,
    `+refs/heads/${headBranch}:refs/remotes/${remote}/${headBranch}`,
  ];
}

const defaultOperations: PullRequestViewCheckoutOperations = {
  worktreeRows: listWorktreeRows,
  resolveProvider: (path) => hostingProviderForRepo(path, PULL_REQUEST_REMOTE),
  async fetchHead(repoPath, remote, headBranch) {
    const result = await gitOptional(
      pullRequestHeadFetchArgs(remote, headBranch),
      repoPath,
      undefined,
      REMOTE_ENV,
    );
    if (result.code !== 0)
      return {
        status: "unreachable",
        error: result.stderr.trim() || `git fetch exited ${result.code}`,
      };
    const oid = await gitOptionalExit(
      [
        "rev-parse",
        "--verify",
        `refs/remotes/${remote}/${headBranch}^{commit}`,
      ],
      repoPath,
    );
    if (oid.code !== 0)
      return {
        status: "unreachable",
        error: `the fetch left no ${remote}/${headBranch} to read`,
      };
    return { status: "fetched", oid: oid.stdout.trim() };
  },
  async inspect(row, headCommit) {
    const config = async (key: string): Promise<string> => {
      const result = await gitOptional(["config", "--get", key], row.path);
      return result.code === 0 ? result.stdout.trim() : "";
    };
    const status = await git(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      row.path,
    );
    const head = (
      await git(["rev-parse", "--verify", "HEAD"], row.path)
    ).stdout.trim();
    const symbolic = await gitOptional(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      row.path,
    );
    return {
      branch: symbolic.code === 0 ? symbolic.stdout.trim() : "",
      upstreamRemote: await config(`branch.${row.branch}.remote`),
      upstreamMerge: await config(`branch.${row.branch}.merge`),
      head,
      dirty: Boolean(status.stdout.trim()),
      headIsAncestorOfPullRequest:
        (
          await gitOptionalExit(
            ["merge-base", "--is-ancestor", head, headCommit],
            row.path,
          )
        ).code === 0,
    };
  },
  async create(input) {
    const record = await createWorktree({
      projectId: input.projectId,
      name: input.name,
      source: {
        kind: "track-remote",
        remote: input.remote,
        headBranch: input.headBranch,
        headCommit: input.headCommit,
        preferredBaseBranch: input.preferredBaseBranch,
      },
    });
    return {
      worktreeId: record.id,
      branch: record.branch,
      path: record.path,
      baseBranch: record.baseBranch,
      // The checkout's OWN head, READ from it rather than assumed to be the
      // commit that was asked for. The creation pins that commit, so the two
      // agree — but reporting the pin instead of the checkout would be a claim
      // about git rather than an observation of it.
      head: (
        await git(["rev-parse", "--verify", "HEAD"], record.path)
      ).stdout.trim(),
    };
  },
  update: (row, expected) => syncWorktree(row, "pull-rebase", { expected }),
  // Filtered through the SAME projection a client's Tasks list is built from,
  // so the two agree on what "it has no Task" means.
  taskIdsFor: (worktreeId) =>
    taskIdsForWorktree(worktreeId).filter(
      (taskId) => taskSummaryFor(taskId) !== null,
    ),
  inventoryChanged: invalidatePullRequestInventorySnapshot,
};

/** Test seam: the production git operations, for exercising them for real. */
export function pullRequestCheckoutOperationsForTests(): PullRequestViewCheckoutOperations {
  return defaultOperations;
}

export async function checkoutPullRequestFromView(
  request: PullRequestViewCheckoutRequest,
  operations: PullRequestViewCheckoutOperations = defaultOperations,
): Promise<PullRequestViewCheckoutResponse> {
  const rows = (await operations.worktreeRows()).filter(
    (row) => row.projectId === request.projectId && row.status === "active",
  );
  const main = rows.find((row) => isMainWorktreeId(row.id));
  if (!main)
    throw new PullRequestViewMergeError(
      `Project ${request.projectId} has no main checkout on this machine, so there is nowhere to create a worktree.`,
      404,
    );
  // The MAIN checkout specifically, not any checkout that publishes here: a
  // worktree is spawned from the main checkout, so a pull request belonging to
  // some other repository the project also holds has no home here — and
  // creating one from the main repository anyway would check out a branch of a
  // repository this pull request is not in.
  const provider = await operations
    .resolveProvider(main.path)
    .catch(() => null);
  const identity = provider && pullRequestIdentityThrough(provider, request);
  if (!provider || !identity)
    throw new PullRequestViewMergeError(
      `The main checkout of project ${request.projectId} does not publish to ${request.repositoryKey} on ${request.provider}, so pull request #${request.number} cannot be checked out here.`,
      404,
    );

  const response = await withPullRequestMutation(
    {
      repoPath: main.path,
      providerKind: request.provider,
      number: request.number,
    },
    "a review checkout",
    () => checkout(request, provider, main, rows, operations),
  );
  if (response.outcome.status !== "refused") operations.inventoryChanged?.();
  return response;
}

async function checkout(
  request: PullRequestViewCheckoutRequest,
  provider: GitHostingProvider,
  main: WorktreeRow,
  rows: WorktreeRow[],
  operations: PullRequestViewCheckoutOperations,
): Promise<PullRequestViewCheckoutResponse> {
  const detail = await provider.pullRequestDetail(request.number);
  if (!detail)
    throw new PullRequestViewMergeError(
      `Pull request #${request.number} could not be read from ${request.provider}. Nothing was done — try again.`,
      409,
    );
  const answer = (
    outcome: PullRequestCheckoutOutcome,
  ): PullRequestViewCheckoutResponse => ({
    number: request.number,
    headBranch: detail.headBranch,
    outcome,
  });

  // The local half FIRST, because two checkouts on this branch is a situation
  // to report rather than one to add a third to.
  const local = await resolveWorktree(
    request,
    detail.headBranch,
    rows,
    operations,
  );
  if (local.ambiguity)
    return answer(refusal("ambiguous-checkout", local.ambiguity));

  const fetched = await operations.fetchHead(
    main.path,
    PULL_REQUEST_REMOTE,
    detail.headBranch,
  );
  if (fetched.status === "unreachable")
    // What the fetch proves is that the branch is not IN REACH, which has two
    // readings this cannot tell apart — the head is on a fork (or the branch is
    // gone), or the remote could not be talked to at all. Both are stated,
    // because asserting the first one alone would explain a network outage as a
    // fork.
    return answer(
      refusal(
        "head-unreachable",
        `${detail.headBranch} could not be fetched from ${PULL_REQUEST_REMOTE}: either it is not a branch of ${request.repositoryKey} — a pull request opened from a fork has none here — or the remote could not be reached. Git said: ${fetched.error}`,
        local.worktreeId,
      ),
    );
  // The branch that came back must BE the pull request's head. A fork's pull
  // request whose branch name collides with one in this repository would
  // otherwise check out the wrong work under the right name, and a head that
  // moved between the provider read and the fetch would be checked out as
  // though it were the reviewed one.
  if (detail.headSha && fetched.oid !== detail.headSha)
    return answer(
      refusal(
        "head-moved",
        `${PULL_REQUEST_REMOTE}/${detail.headBranch} is at ${short(fetched.oid)}, but #${request.number} reports its head as ${short(detail.headSha)}. Either the head moved just now, or this pull request's branch is on a fork. Nothing was checked out.`,
        local.worktreeId,
      ),
    );

  return answer(
    local.row
      ? await update(detail, local.row, fetched.oid, operations)
      : await create(request, detail, fetched.oid, operations),
  );
}

/** Create the checkout: a new worktree whose branch tracks the head branch. */
async function create(
  request: PullRequestViewCheckoutRequest,
  detail: { headBranch: string; baseBranch: string },
  headCommit: string,
  operations: PullRequestViewCheckoutOperations,
): Promise<PullRequestCheckoutOutcome> {
  try {
    const created = await operations.create({
      projectId: request.projectId,
      // The folder's name only — the branch is the remote's. The sanitizer's
      // fallback is a timestamp, so a head branch with nothing name-like in it
      // still gets a folder rather than blocking the creation.
      name: sanitizeWorktreeSuffix(detail.headBranch) ?? `pr-${request.number}`,
      remote: PULL_REQUEST_REMOTE,
      headBranch: detail.headBranch,
      // The commit this action VERIFIED, carried through so the checkout is of
      // that commit and not of wherever the remote-tracking ref has since been
      // moved by another fetch.
      headCommit,
      preferredBaseBranch: detail.baseBranch,
    });
    return {
      status: "created",
      worktreeId: created.worktreeId,
      branch: created.branch,
      path: created.path,
      head: created.head,
      base: baseOf(created.baseBranch, detail.baseBranch),
      taskIds: operations.taskIdsFor(created.worktreeId),
    };
  } catch (err) {
    // A stated precondition of the creation — a local branch of that name, a
    // detached main checkout — is this action's refusal, not its failure. The
    // creation is atomic, so nothing is left behind either way.
    if (err instanceof WorktreeCreateRefusalError)
      return refusal(err.kind, err.message);
    throw err;
  }
}

/**
 * Bring the existing checkout to the pull request's current head.
 *
 * Every refusal here is about work that is already in that checkout, and none
 * of them is resolved by guessing: the user is told what it is and decides.
 *
 * Every answer, INCLUDING "it already stands there", comes from the locked
 * operation. The reads below are made outside the lock, so on their own they
 * can only say what was true a moment ago — and "nothing to do" asserted from
 * outside a lock is the same claim as "this is what I did", made with less
 * evidence.
 */
async function update(
  detail: { headBranch: string; baseBranch: string },
  row: WorktreeRow,
  headCommit: string,
  operations: PullRequestViewCheckoutOperations,
): Promise<PullRequestCheckoutOutcome> {
  const base = baseOf(row.baseBranch, detail.baseBranch);
  const state = await operations.inspect(row, headCommit);
  const expectedMerge = `refs/heads/${detail.headBranch}`;
  // A DETACHED checkout, or one standing on some other branch, tracks nothing —
  // whatever commit it happens to sit on. Its head can equal the pull request's
  // exactly and still mean nothing about what it follows.
  if (state.branch !== row.branch)
    return refusal(
      "not-tracking",
      `That checkout is on ${state.branch ? `${state.branch}` : "a detached HEAD"}, not ${row.branch}, so it does not follow this pull request. Nothing was changed.`,
      row.id,
    );
  if (
    state.upstreamRemote !== PULL_REQUEST_REMOTE ||
    state.upstreamMerge !== expectedMerge
  )
    return refusal(
      "not-tracking",
      state.upstreamRemote || state.upstreamMerge
        ? `The checkout on ${row.branch} tracks ${state.upstreamRemote || "?"}/${(state.upstreamMerge || "?").replace(/^refs\/heads\//, "")}, not ${PULL_REQUEST_REMOTE}/${detail.headBranch}, so updating it would pull something else. Nothing was changed.`
        : `The checkout on ${row.branch} has no upstream, so there is nothing to say it is this pull request's head. Nothing was changed.`,
      row.id,
    );
  // Already at the head? Then dirt and divergence are not asked about at all: a
  // checkout that needs no git work has nothing for uncommitted changes to be
  // in the way of, and refusing over them would block a review for no reason.
  // The operation below still runs — it is what verifies, under the lock, that
  // this is still true — and answers `up-to-date` without fetching or mutating.
  const current = state.head === headCommit;
  if (!current && state.dirty)
    return refusal(
      "dirty",
      `The checkout on ${row.branch} has uncommitted changes, so it was left alone. Commit or clean them, then try again.`,
      row.id,
    );
  if (!current && !state.headIsAncestorOfPullRequest)
    return refusal(
      "diverged",
      `The checkout on ${row.branch} is at ${short(state.head)}, which is not in the pull request's head ${short(headCommit)} — it has local commits, or the branch was force-pushed. It was left exactly as it is; reconcile it yourself.`,
      row.id,
    );
  try {
    // Everything this function checked travels INTO the operation, which
    // re-reads it under the repository lock before touching anything. Without
    // that the update's own reads decide what it does — it could land on an
    // upstream that moved after the ancestor check, replay a commit that
    // appeared in the checkout since it was inspected, or follow an upstream
    // repointed since the `not-tracking` check above (any two refs at the same
    // commit satisfy an oid alone) — and each would be reported as the update
    // that was asked for.
    const sync = await operations.update(row, {
      head: state.head,
      upstream: headCommit,
      // The values the guard above ACCEPTED, which is what makes them the
      // thing to hold the operation to.
      upstreamRemote: PULL_REQUEST_REMOTE,
      upstreamMerge: expectedMerge,
    });
    // Reported from what the operation DID, never from the oids above.
    if (sync.status === "up-to-date")
      return {
        status: "already-current",
        worktreeId: row.id,
        branch: row.branch,
        head: sync.head,
        base,
        taskIds: operations.taskIdsFor(row.id),
      };
    return {
      status: "updated",
      worktreeId: row.id,
      branch: row.branch,
      previousHead: sync.previousHead,
      head: sync.head,
      base,
      taskIds: operations.taskIdsFor(row.id),
    };
  } catch (err) {
    // A precondition that no longer holds is a RACE, not a failed update: the
    // operation refused before mutating anything, and asking again reads the
    // state that overtook it.
    if (err instanceof WorktreeSyncPreconditionError)
      return refusal("raced", err.message, row.id);
    // `pull-rebase` restores the branch before it throws (a conflict aborts the
    // rebase and resets to the original head), so this is a refusal with the
    // checkout unchanged rather than a half-done update.
    return refusal("update-failed", errorText(err), row.id);
  }
}

function refusal(
  kind: PullRequestCheckoutRefusalKind,
  reason: string,
  worktreeId?: string,
): PullRequestCheckoutOutcome {
  return {
    status: "refused",
    kind,
    reason,
    ...(worktreeId ? { worktreeId } : {}),
  };
}

/**
 * What was RECORDED as the merge-back target, beside what the pull request
 * merges into. Stated rather than assumed: the two differ whenever the pull
 * request's base is not a local branch here, and where the work would land is
 * not something a surface should have to infer.
 */
function baseOf(
  recorded: string,
  pullRequestBase: string,
): PullRequestCheckoutBase {
  return {
    branch: recorded,
    pullRequestBase,
    matchesPullRequestBase: recorded === pullRequestBase,
  };
}

function short(oid: string): string {
  return oid.slice(0, 12);
}

/** What the local half found, before it is asked to do anything. */
interface LocalCheckout {
  row?: WorktreeRow;
  worktreeId?: string;
  /** Why there is no single checkout to act on, when there is not. */
  ambiguity?: string;
}

/**
 * The checkout this pull request already has: an ACTIVE spawned worktree of
 * this project standing on the provider-reported head branch, in this same
 * repository — the same join the merge's cleanup makes, so the two surfaces
 * cannot disagree about which checkout belongs to a pull request.
 */
async function resolveWorktree(
  request: PullRequestViewCheckoutRequest,
  headBranch: string,
  rows: WorktreeRow[],
  operations: PullRequestViewCheckoutOperations,
): Promise<LocalCheckout> {
  const onBranch = rows.filter(
    (row) => !isMainWorktreeId(row.id) && row.branch === headBranch,
  );
  const matched: WorktreeRow[] = [];
  for (const row of onBranch) {
    const provider = await operations
      .resolveProvider(row.path)
      .catch(() => null);
    if (provider && pullRequestIdentityThrough(provider, request))
      matched.push(row);
  }
  if (matched.length > 1)
    return {
      ambiguity: `${matched.length} local worktrees stand on ${headBranch} in ${request.repositoryKey}; none was touched. Open the one you mean from its own page.`,
    };
  const row = matched[0];
  return row ? { row, worktreeId: row.id } : {};
}
