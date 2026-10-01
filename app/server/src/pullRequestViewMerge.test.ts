/**
 * The Pull Requests view's Merge & clean up: what it re-derives from the
 * four-component identity, what it refuses, and how it reports two phases that
 * can end differently. The merge seam is the REAL one (capability fail-closed
 * and the per-pull-request mutation lock are its rules, and this endpoint must
 * not be able to opt out of them) over a real temp repository; the retirement
 * is injected, because what is tested here is which options reach it and how
 * its answers are reported. Run:
 *   pnpm --filter @assistant/server test src/pullRequestViewMerge.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import type {
  PullRequestDetail,
  PullRequestMergeMethod,
  PullRequestViewMergeRequest,
  WorktreeRetireResponse,
} from "@assistant/shared";
import type { WorktreeRow } from "./db/worktreeStore.ts";
import {
  invalidateRepositoryCapabilities,
  type GitHostingProvider,
} from "./gitHosting.ts";
import {
  createPullRequestCard,
  resetPullRequestCardsStoreForTests,
} from "./pullRequestCards.ts";
import {
  mergePullRequestAndProjectLocked,
  resetPullRequestMutationsForTests,
  withPullRequestMutation,
} from "./pullRequestMerge.ts";
import {
  checkPullRequestFromView,
  mergePullRequestFromView,
  PullRequestViewMergeError,
  type PullRequestViewMergeOperations,
} from "./pullRequestViewMerge.ts";
import { mainWorktreeId } from "./worktrees/worktreeResolve.ts";

/* --------------------------------- fixtures -------------------------------- */

const PROJECT = "acme";
const REPOSITORY_KEY = "acme/repo";

function repo(): string {
  const path = mkdtempSync(join(tmpdir(), "pr-view-merge-"));
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: path });
  return path;
}

function row(id: string, path: string, branch: string): WorktreeRow {
  return {
    id,
    projectId: PROJECT,
    mainRepoRoot: path,
    path,
    branch,
    baseBranch: "main",
    baseCommit: "b".repeat(40),
    status: "active",
    mergeStateJson: null,
    createdAt: 1,
    updatedAt: 1,
    removedAt: null,
  };
}

function detail(overrides: Partial<PullRequestDetail> = {}): PullRequestDetail {
  return {
    number: 7,
    state: "open",
    merged: false,
    mergeable: true,
    draft: false,
    headSha: "a".repeat(40),
    headBranch: "feature-7",
    baseBranch: "main",
    ...overrides,
  };
}

interface ProviderOptions {
  repoWebUrl?: string;
  detail?: PullRequestDetail;
  merges?: { method: string; deleteBranch: boolean; headBranch?: string }[];
  branchDeleted?: boolean;
  branchDeleteError?: string;
  /** Runs at the moment the provider ACCEPTS, for what happens after it. */
  onMerged?: () => void;
}

function fakeProvider(options: ProviderOptions = {}): GitHostingProvider {
  return {
    kind: "forgejo",
    repoWebUrl: options.repoWebUrl ?? "https://git.example/acme/repo",
    findPullRequestForBranch: async () => null,
    findPullRequestsForBranch: async () => ({ open: [] }),
    createPullRequest: async () => {
      throw new Error("not used");
    },
    markPullRequestReady: async () => ({}),
    listOpenPullRequests: async () => [],
    ciStatus: async () => null,
    refChecks: async () => ({ state: "none", checks: [] }),
    pullRequestReview: async () => null,
    pullRequestDetail: async () => options.detail ?? detail(),
    closePullRequest: async () => {
      throw new Error("not used");
    },
    repositoryCapabilities: async () => ({
      defaultBranch: "main",
      mergeMethods: ["squash", "merge", "rebase"],
      canClose: true,
      canDeleteBranchOnMerge: true,
    }),
    mergePullRequest: async (
      number: number,
      merge: {
        method: PullRequestMergeMethod;
        deleteBranch: boolean;
        headBranch?: string;
      },
    ) => {
      options.merges?.push({
        method: merge.method,
        deleteBranch: merge.deleteBranch,
        ...(merge.headBranch ? { headBranch: merge.headBranch } : {}),
      });
      options.onMerged?.();
      return {
        number,
        method: merge.method,
        branchDeleted: options.branchDeleted !== false,
        ...(options.branchDeleteError
          ? { branchDeleteError: options.branchDeleteError }
          : {}),
      };
    },
  } as unknown as GitHostingProvider;
}

function retired(
  overrides: Partial<
    Extract<WorktreeRetireResponse, { status: "retired" }>
  > = {},
): WorktreeRetireResponse {
  return {
    worktreeId: "wt-7",
    status: "retired",
    branch: "feature-7",
    baseBranch: "main",
    branchDeleted: true,
    settledSessions: 2,
    deliveryVerified: true,
    ...overrides,
  };
}

/** The endpoint's seams: the REAL merge projection, an injected retirement. */
function operations(input: {
  rows: WorktreeRow[];
  providers: Record<string, GitHostingProvider>;
  retire?: (
    worktreeId: string,
    options: { deleteBranch?: boolean; force?: boolean },
  ) => Promise<WorktreeRetireResponse>;
  /** Records the cache drops, which is how the refetch gets a fresh answer. */
  forgotten?: { projectId: string; identityKey: string }[];
}): PullRequestViewMergeOperations {
  return {
    worktreeRows: async () => input.rows,
    resolveProvider: async (path) => input.providers[path] ?? null,
    forgetInventoryReads: (projectId, identityKey) => {
      input.forgotten?.push({ projectId, identityKey });
    },
    // The real seam, with only the LOCAL base refresh stubbed: it is
    // best-effort bookkeeping after the provider accepted, and this suite has
    // no remote for it to fetch.
    merge: (merge) =>
      mergePullRequestAndProjectLocked(merge, {
        refreshBaseCheckout: async () => undefined,
      }),
    retire:
      input.retire ??
      (async () => {
        throw new Error("retire was not expected");
      }),
  };
}

function request(
  overrides: Partial<PullRequestViewMergeRequest> = {},
): PullRequestViewMergeRequest {
  return {
    projectId: PROJECT,
    provider: "forgejo",
    repositoryKey: REPOSITORY_KEY,
    number: 7,
    method: "squash",
    ...overrides,
  };
}

/** The same request with NO method chosen — omitted, never `undefined`. */
function withoutMethod(
  overrides: Partial<PullRequestViewMergeRequest> = {},
): PullRequestViewMergeRequest {
  const { method: _method, ...rest } = request(overrides);
  return rest;
}

afterEach(() => {
  resetPullRequestCardsStoreForTests();
  resetPullRequestMutationsForTests();
  invalidateRepositoryCapabilities();
});

/* ---------------------------------- merging -------------------------------- */

// The whole action, in the order it is specified: merge through the shared
// projection, then retire the checkout the identity resolved.
test("merges the pull request and then retires its local worktree", async () => {
  const path = repo();
  const merges: ProviderOptions["merges"] = [];
  const provider = fakeProvider({ merges });
  const worktree = row("wt-7", path, "feature-7");
  const retirements: { worktreeId: string; force?: boolean }[] = [];

  const result = await mergePullRequestFromView(
    request({ removeWorktree: true }),
    operations({
      rows: [row(mainWorktreeId(PROJECT), path, "main"), worktree],
      providers: { [path]: provider },
      retire: async (worktreeId, retire) => {
        retirements.push({
          worktreeId,
          ...(retire.force === true ? { force: true } : {}),
        });
        assert.equal(retire.deleteBranch, true);
        return retired();
      },
    }),
  );

  assert.deepEqual(merges, [
    { method: "squash", deleteBranch: true, headBranch: "feature-7" },
  ]);
  assert.deepEqual(result.merge, {
    status: "merged",
    method: "squash",
    headBranch: "feature-7",
    baseBranch: "main",
    remoteBranch: "deleted",
  });
  assert.deepEqual(retirements, [{ worktreeId: "wt-7" }]);
  assert.deepEqual(result.cleanup, {
    status: "retired",
    worktreeId: "wt-7",
    branch: "feature-7",
    baseBranch: "main",
    branchDeleted: true,
    settledSessions: 2,
    deliveryVerified: true,
  });
});

// A deletion the provider did not confirm is its own answer, distinct from
// both "deleted" and the user's opt-out, and it carries the provider's reason.
test("an unconfirmed branch deletion is reported as not deleted, with its reason", async () => {
  const path = repo();

  const result = await mergePullRequestFromView(
    request(),
    operations({
      rows: [row(mainWorktreeId(PROJECT), path, "main")],
      providers: {
        [path]: fakeProvider({
          branchDeleted: false,
          branchDeleteError: "the branch is protected",
        }),
      },
    }),
  );

  assert.deepEqual(result.merge, {
    status: "merged",
    method: "squash",
    headBranch: "feature-7",
    baseBranch: "main",
    remoteBranch: "not-deleted",
    remoteBranchError: "the branch is protected",
  });
});

// Opting out of the remote-branch deletion travels with the click, and the
// outcome says which of the two actually happened.
test("the remote branch opt-out reaches the provider and is reported", async () => {
  const path = repo();
  const merges: ProviderOptions["merges"] = [];

  const result = await mergePullRequestFromView(
    request({ deleteRemoteBranch: false }),
    operations({
      rows: [row(mainWorktreeId(PROJECT), path, "main")],
      providers: { [path]: fakeProvider({ merges }) },
    }),
  );

  assert.equal(merges[0]?.deleteBranch, false);
  assert.equal(
    result.merge.status === "merged" ? result.merge.remoteBranch : "",
    "kept",
  );
  // Nothing local was asked for, so nothing local is claimed.
  assert.deepEqual(result.cleanup, { status: "not-requested" });
});

// Merging a pull request with no checkout of its own is the ordinary case for
// this view: the cleanup half is simply absent.
test("a pull request with no local worktree merges with an absent cleanup", async () => {
  const path = repo();

  const result = await mergePullRequestFromView(
    request({ removeWorktree: true }),
    operations({
      rows: [row(mainWorktreeId(PROJECT), path, "main")],
      providers: { [path]: fakeProvider() },
    }),
  );

  assert.equal(result.merge.status, "merged");
  assert.deepEqual(result.cleanup, { status: "no-worktree" });
});

// The provider has ACCEPTED by the time the local projection runs, so a card
// that vanished under it (or any other write that fails) is bookkeeping, not
// the action's verdict. Reporting it as a failure would tell the user their
// merged pull request did not merge — and would skip the cleanup half.
test("a projection that fails after the provider accepted still reports a landed merge", async () => {
  const path = repo();
  const merges: ProviderOptions["merges"] = [];
  createPullRequestCard(
    {
      sessionId: "session-7",
      status: "open",
      title: "Pull 7",
      headBranch: "feature-7",
      baseBranch: "main",
      provider: "forgejo",
      number: 7,
      url: "https://git.example/acme/repo/pulls/7",
    },
    {
      repoRoot: path,
      sessionKind: "developer",
      sessionId: "session-7",
      headBranch: "feature-7",
      baseBranch: "main",
      draft: false,
    },
  );

  const result = await mergePullRequestFromView(
    request({ removeWorktree: true }),
    operations({
      rows: [
        row(mainWorktreeId(PROJECT), path, "main"),
        row("wt-7", path, "feature-7"),
      ],
      providers: {
        [path]: fakeProvider({
          merges,
          // The card is gone the instant the merge is accepted: patching it
          // throws, exactly as a deleted session's card would.
          onMerged: () => resetPullRequestCardsStoreForTests(),
        }),
      },
      retire: async () => retired(),
    }),
  );

  assert.equal(merges.length, 1);
  assert.equal(result.merge.status, "merged");
  // And the cleanup still ran, which is the second half of the same rule.
  assert.equal(result.cleanup.status, "retired");
});

/* ----------------------------- cache invalidation -------------------------- */

// The view refetches the inventory the moment this answers, and that projection
// caches for 60 s. Without dropping this pull request from both halves, the
// refetch hands the surface back the OPEN pull request just merged.
test("a landed merge drops the inventory's cached reads for this pull request", async () => {
  const path = repo();
  const forgotten: { projectId: string; identityKey: string }[] = [];

  await mergePullRequestFromView(
    request(),
    operations({
      rows: [row(mainWorktreeId(PROJECT), path, "main")],
      providers: { [path]: fakeProvider() },
      forgotten,
    }),
  );

  // The key is the one the inventory wrote its entries under: derived from the
  // provider's own repository URL, not assembled from the request.
  assert.deepEqual(forgotten, [
    { projectId: PROJECT, identityKey: "forgejo#acme/repo#7" },
  ]);
});

// Cleaning up a terminal pull request changes what the inventory says about it
// too — it was listed for the checkout that is now gone.
test("a cleanup with no merge before it drops the same cached reads", async () => {
  const path = repo();
  const forgotten: { projectId: string; identityKey: string }[] = [];

  await mergePullRequestFromView(
    withoutMethod({ removeWorktree: true }),
    operations({
      rows: [
        row(mainWorktreeId(PROJECT), path, "main"),
        row("wt-7", path, "feature-7"),
      ],
      providers: {
        [path]: fakeProvider({
          detail: detail({ state: "merged", merged: true }),
        }),
      },
      retire: async () => retired(),
      forgotten,
    }),
  );

  assert.deepEqual(forgotten, [
    { projectId: PROJECT, identityKey: "forgejo#acme/repo#7" },
  ]);
});

// A refused cleanup changed nothing locally, and the pull request was already
// terminal, so there is nothing to forget.
test("a refused cleanup after no merge drops nothing", async () => {
  const path = repo();
  const forgotten: { projectId: string; identityKey: string }[] = [];

  await mergePullRequestFromView(
    withoutMethod({ removeWorktree: true }),
    operations({
      rows: [
        row(mainWorktreeId(PROJECT), path, "main"),
        row("wt-7", path, "feature-7"),
      ],
      providers: {
        [path]: fakeProvider({
          detail: detail({ state: "merged", merged: true }),
        }),
      },
      retire: async () => ({
        worktreeId: "wt-7",
        status: "refused",
        branch: "feature-7",
        baseBranch: "main",
        refusal: "a session is still running in it.",
        refusalKind: "sessions",
      }),
      forgotten,
    }),
  );

  assert.deepEqual(forgotten, []);
});

/* ------------------------------- the method ------------------------------- */

// The method is never defaulted: a client that sent none was looking at a pull
// request it believed terminal, and this one is open.
test("an open pull request with no method chosen is refused", async () => {
  const path = repo();
  const merges: ProviderOptions["merges"] = [];
  const error = await mergePullRequestFromView(
    withoutMethod(),
    operations({
      rows: [row(mainWorktreeId(PROJECT), path, "main")],
      providers: { [path]: fakeProvider({ merges }) },
    }),
  ).catch((err: unknown) => err);

  assert.ok(error instanceof PullRequestViewMergeError);
  assert.equal(error.status, 400);
  assert.deepEqual(merges, []);
});

/* -------------------------------- the lock --------------------------------- */

/**
 * Hold this pull request's mutation lock, and RESOLVE only once the holder is
 * actually registered.
 *
 * `withPullRequestMutation` awaits `repoLockKey` — a git call — before it
 * registers anything, so a test that raced a second caller against the bare
 * call could win that race and see no refusal at all. The lock registers before
 * it invokes its callback, so the callback STARTING is the proof.
 */
async function holdPullRequest(
  path: string,
  what: string,
): Promise<{ release: () => void; done: Promise<void> }> {
  let release = () => undefined as void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let registered = () => undefined as void;
  const running = new Promise<void>((resolve) => {
    registered = resolve;
  });
  const done = withPullRequestMutation(
    { repoPath: path, providerKind: "forgejo", number: 7 },
    what,
    async () => {
      registered();
      await held;
    },
  );
  await running;
  return { release, done };
}

// This view has neither a card nor necessarily a worktree, so the only thing
// that keeps it off the `/pr` card's toes is the per-pull-request mutation
// lock — and the loser is REFUSED before any side effect, never queued.
test("a concurrent mutation on the same pull request is refused, not queued", async () => {
  const path = repo();
  const merges: ProviderOptions["merges"] = [];
  const holder = await holdPullRequest(path, "a merge");

  await assert.rejects(
    mergePullRequestFromView(
      request({ removeWorktree: true }),
      operations({
        rows: [row(mainWorktreeId(PROJECT), path, "main")],
        providers: { [path]: fakeProvider({ merges }) },
      }),
    ),
    /Pull request #7 is busy: a merge is running/,
  );
  assert.deepEqual(merges, []);
  holder.release();
  await holder.done;
});

/* --------------------------------- cleanup --------------------------------- */

// The one thing this endpoint must never do: report a merge that LANDED as a
// failure because the local cleanup refused afterwards.
test("a merge that landed is reported as landed when the cleanup refuses", async () => {
  const path = repo();
  const merges: ProviderOptions["merges"] = [];

  const result = await mergePullRequestFromView(
    request({ removeWorktree: true }),
    operations({
      rows: [
        row(mainWorktreeId(PROJECT), path, "main"),
        row("wt-7", path, "feature-7"),
      ],
      providers: { [path]: fakeProvider({ merges }) },
      retire: async () => ({
        worktreeId: "wt-7",
        status: "refused",
        branch: "feature-7",
        baseBranch: "main",
        refusal: "feature-7 is not contained in the refreshed main.",
        refusalKind: "delivery",
      }),
    }),
  );

  assert.equal(merges.length, 1);
  assert.equal(result.merge.status, "merged");
  assert.deepEqual(result.cleanup, {
    status: "refused",
    worktreeId: "wt-7",
    refusal: "feature-7 is not contained in the refreshed main.",
    refusalKind: "delivery",
  });
});

// A cleanup that THREW is the same rule: it is reported as itself rather than
// rethrown over a pull request that is already merged.
test("a cleanup that threw is reported beside the landed merge", async () => {
  const path = repo();

  const result = await mergePullRequestFromView(
    request({ removeWorktree: true }),
    operations({
      rows: [
        row(mainWorktreeId(PROJECT), path, "main"),
        row("wt-7", path, "feature-7"),
      ],
      providers: { [path]: fakeProvider() },
      retire: async () => {
        throw new Error("the checkout is gone");
      },
    }),
  );

  assert.equal(result.merge.status, "merged");
  assert.deepEqual(result.cleanup, {
    status: "failed",
    worktreeId: "wt-7",
    error: "the checkout is gone",
  });
});

// Consent answers the refusal the verification produced, and nothing more: the
// escalation is passed through, and the outcome states that delivery was NOT
// verified this time.
test("a consented force reaches the retirement and is reported unverified", async () => {
  const path = repo();
  const retirements: { force: boolean }[] = [];

  const result = await mergePullRequestFromView(
    request({ removeWorktree: true, forceRemoveWorktree: true }),
    operations({
      rows: [
        row(mainWorktreeId(PROJECT), path, "main"),
        row("wt-7", path, "feature-7"),
      ],
      providers: { [path]: fakeProvider() },
      retire: async (_worktreeId, options) => {
        retirements.push({ force: options.force === true });
        return retired({ deliveryVerified: false });
      },
    }),
  );

  assert.deepEqual(retirements, [{ force: true }]);
  assert.equal(
    result.cleanup.status === "retired"
      ? result.cleanup.deliveryVerified
      : true,
    false,
  );
});

// The cleanup queue's own case: nothing left to merge, and this same action is
// what clears the checkout that kept the pull request listed.
test("a terminal pull request is cleaned up without a second merge", async () => {
  const path = repo();
  const merges: ProviderOptions["merges"] = [];

  const result = await mergePullRequestFromView(
    withoutMethod({ removeWorktree: true }),
    operations({
      rows: [
        row(mainWorktreeId(PROJECT), path, "main"),
        row("wt-7", path, "feature-7"),
      ],
      providers: {
        [path]: fakeProvider({
          merges,
          detail: detail({ state: "merged", merged: true }),
        }),
      },
      retire: async () => retired(),
    }),
  );

  assert.deepEqual(merges, []);
  assert.deepEqual(result.merge, {
    status: "already-terminal",
    state: "merged",
  });
  assert.equal(result.cleanup.status, "retired");
});

/* -------------------------------- identity --------------------------------- */

// Every component of the identity is load-bearing. A checkout standing on the
// same branch name, publishing to ANOTHER repository, is other work: it is not
// this pull request's checkout and must not be removed by its cleanup.
test("a same-named branch in another repository is not this cleanup's worktree", async () => {
  const path = repo();
  const fork = repo();

  const result = await mergePullRequestFromView(
    request({ removeWorktree: true }),
    operations({
      rows: [
        row(mainWorktreeId(PROJECT), path, "main"),
        row("wt-fork", fork, "feature-7"),
      ],
      providers: {
        [path]: fakeProvider(),
        [fork]: fakeProvider({
          repoWebUrl: "https://git.example/acme/fork",
        }),
      },
    }),
  );

  assert.equal(result.merge.status, "merged");
  assert.deepEqual(result.cleanup, { status: "no-worktree" });
});

// Which of two checkouts on this branch the user meant is not a choice this
// endpoint gets to make for them: removing either would delete a checkout the
// dialog never named. The merge still stands, and the cleanup says why it did
// nothing.
test("two local worktrees on the head branch merge once and clean up nothing", async () => {
  const path = repo();
  const merges: ProviderOptions["merges"] = [];
  let retires = 0;

  const result = await mergePullRequestFromView(
    request({ removeWorktree: true }),
    operations({
      rows: [
        row(mainWorktreeId(PROJECT), path, "main"),
        row("wt-7", path, "feature-7"),
        row("wt-7-again", path, "feature-7"),
      ],
      providers: { [path]: fakeProvider({ merges }) },
      retire: async () => {
        retires += 1;
        return retired();
      },
    }),
  );

  assert.equal(merges.length, 1);
  assert.equal(retires, 0);
  assert.equal(result.merge.status, "merged");
  assert.equal(result.cleanup.status, "failed");
  assert.match(
    result.cleanup.status === "failed" ? result.cleanup.error : "",
    /2 local worktrees stand on feature-7 in acme\/repo; none was removed/,
  );
});

// And the repository half of the identity must be PROVEN by the checkout that
// answers for it, rather than assumed from the project.
test("an identity no checkout of the project publishes to is refused", async () => {
  const path = repo();
  const error = await mergePullRequestFromView(
    request({ repositoryKey: "acme/other" }),
    operations({
      rows: [row(mainWorktreeId(PROJECT), path, "main")],
      providers: { [path]: fakeProvider() },
    }),
  ).catch((err: unknown) => err);

  assert.ok(error instanceof PullRequestViewMergeError);
  assert.equal(error.status, 404);
  assert.match(error.message, /acme\/other/);
});

/* --------------------------------- the check ------------------------------- */

// The question a lost RESPONSE leaves open, and the only one that can always be
// answered: what IS this pull request. It attempts nothing — which is the whole
// point, since a merge re-issued after the pull request turned into a draft (or
// lost its method) would be refused by an authoritative guard forever.
test("a check answers the state under the lock and merges nothing", async () => {
  const path = repo();
  const merges: ProviderOptions["merges"] = [];
  const forgotten: { projectId: string; identityKey: string }[] = [];

  const answer = await checkPullRequestFromView(
    {
      projectId: PROJECT,
      provider: "forgejo",
      repositoryKey: REPOSITORY_KEY,
      number: 7,
    },
    operations({
      rows: [
        row(mainWorktreeId(PROJECT), path, "main"),
        row("wt-7", path, "feature-7"),
      ],
      providers: {
        [path]: fakeProvider({
          merges,
          // A pull request that has become a draft again: every merge attempt
          // would now be refused, and this read still answers.
          detail: detail({ draft: true, mergeable: false }),
        }),
      },
      forgotten,
    }),
  );

  assert.deepEqual(merges, []);
  assert.deepEqual(answer, {
    number: 7,
    state: "open",
    draft: true,
    mergeable: false,
    checkout: { status: "one", worktreeId: "wt-7" },
  });
  // The caller refetches on this answer, so the cached reads go with it.
  assert.deepEqual(forgotten, [
    { projectId: PROJECT, identityKey: "forgejo#acme/repo#7" },
  ]);
});

// TWO checkouts on the head branch is a situation, not an absence. A response
// that dropped it would let the surface announce that nothing local is left
// while both are still there — and suppress the cleanup that deals with them.
test("a check reports ambiguous local checkouts rather than none", async () => {
  const path = repo();

  const answer = await checkPullRequestFromView(
    {
      projectId: PROJECT,
      provider: "forgejo",
      repositoryKey: REPOSITORY_KEY,
      number: 7,
    },
    operations({
      rows: [
        row(mainWorktreeId(PROJECT), path, "main"),
        row("wt-7", path, "feature-7"),
        row("wt-7-again", path, "feature-7"),
      ],
      providers: {
        [path]: fakeProvider({
          detail: detail({ state: "merged", merged: true }),
        }),
      },
    }),
  );

  assert.equal(answer.checkout.status, "ambiguous");
  assert.match(
    answer.checkout.status === "ambiguous" ? answer.checkout.reason : "",
    /2 local worktrees stand on feature-7 in acme\/repo; none was removed/,
  );
});

// A terminal answer is what tells a client its lost request DID merge, and the
// checkout it names is what is left to do about it.
test("a check reports a merged pull request and its surviving checkout", async () => {
  const path = repo();

  const answer = await checkPullRequestFromView(
    {
      projectId: PROJECT,
      provider: "forgejo",
      repositoryKey: REPOSITORY_KEY,
      number: 7,
    },
    operations({
      rows: [
        row(mainWorktreeId(PROJECT), path, "main"),
        row("wt-7", path, "feature-7"),
      ],
      providers: {
        [path]: fakeProvider({
          detail: detail({ state: "merged", merged: true }),
        }),
      },
    }),
  );

  assert.equal(answer.state, "merged");
  assert.deepEqual(answer.checkout, { status: "one", worktreeId: "wt-7" });
});

// While something still HOLDS the lock, nothing is known — and saying so is the
// honest answer. This is the case where the lost request is still running.
test("a check is refused while the pull request is busy", async () => {
  const path = repo();
  const holder = await holdPullRequest(path, "a merge & clean up");

  await assert.rejects(
    checkPullRequestFromView(
      {
        projectId: PROJECT,
        provider: "forgejo",
        repositoryKey: REPOSITORY_KEY,
        number: 7,
      },
      operations({
        rows: [row(mainWorktreeId(PROJECT), path, "main")],
        providers: { [path]: fakeProvider() },
      }),
    ),
    /Pull request #7 is busy: a merge & clean up is running/,
  );
  holder.release();
  await holder.done;
});
