/**
 * The Pull Requests view's review checkout: what it re-derives from the
 * four-component identity, which of create / update / already-current it
 * reports, and what it refuses rather than guesses. The git seams are injected
 * — `worktrees/worktreeTracking.test.ts` runs the real ones against real
 * repositories — because what is tested here is the DECISIONS: which fetch is
 * asked for, which checkout is chosen, and which fact produces which refusal.
 * The per-pull-request mutation lock is the real one. Run:
 *   pnpm --filter @assistant/server test src/pullRequestViewCheckout.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import type {
  PullRequestDetail,
  PullRequestViewCheckoutRequest,
  WorktreeSyncResponse,
} from "@assistant/shared";
import type { WorktreeRow } from "./db/worktreeStore.ts";
import type { GitHostingProvider } from "./gitHosting.ts";
import {
  resetPullRequestMutationsForTests,
  withPullRequestMutation,
} from "./pullRequestMerge.ts";
import {
  checkoutPullRequestFromView,
  pullRequestCheckoutOperationsForTests,
  pullRequestHeadFetchArgs,
  type CheckoutInspection,
  type CreatedCheckout,
  type PullRequestHeadFetch,
  type PullRequestViewCheckoutOperations,
} from "./pullRequestViewCheckout.ts";
import { PullRequestViewMergeError } from "./pullRequestViewMerge.ts";
import { mainWorktreeId } from "./worktrees/worktreeResolve.ts";
import {
  WorktreeSyncPreconditionError,
  type WorktreeSyncExpectation,
} from "./worktrees/worktreeSync.ts";
import { WorktreeCreateRefusalError } from "./worktrees/worktrees.ts";

/* --------------------------------- fixtures -------------------------------- */

const PROJECT = "acme";
const REPOSITORY_KEY = "acme/repo";
const HEAD_SHA = "a".repeat(40);

function repo(): string {
  const path = mkdtempSync(join(tmpdir(), "pr-view-checkout-"));
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
    headSha: HEAD_SHA,
    headBranch: "feature-7",
    baseBranch: "main",
    ...overrides,
  };
}

function fakeProvider(
  options: { repoWebUrl?: string; detail?: PullRequestDetail } = {},
): GitHostingProvider {
  return {
    kind: "forgejo",
    repoWebUrl: options.repoWebUrl ?? "https://git.example/acme/repo",
    pullRequestDetail: async () => options.detail ?? detail(),
  } as unknown as GitHostingProvider;
}

function inspection(
  overrides: Partial<CheckoutInspection> = {},
): CheckoutInspection {
  return {
    branch: "feature-7",
    upstreamRemote: "origin",
    upstreamMerge: "refs/heads/feature-7",
    head: "c".repeat(40),
    dirty: false,
    headIsAncestorOfPullRequest: true,
    ...overrides,
  };
}

interface Recorded {
  fetches: { repoPath: string; remote: string; headBranch: string }[];
  creates: {
    projectId: string;
    name: string;
    remote: string;
    headBranch: string;
    headCommit: string;
    preferredBaseBranch: string;
  }[];
  updates: { worktreeId: string; expected: WorktreeSyncExpectation }[];
}

function operations(input: {
  rows: WorktreeRow[];
  providers: Record<string, GitHostingProvider>;
  fetch?: PullRequestHeadFetch;
  inspect?: CheckoutInspection;
  created?: Partial<CreatedCheckout>;
  createError?: Error;
  update?: WorktreeSyncResponse | (() => Promise<WorktreeSyncResponse>);
  taskIds?: Record<string, string[]>;
  recorded?: Recorded;
}): PullRequestViewCheckoutOperations {
  return {
    worktreeRows: async () => input.rows,
    resolveProvider: async (path) => input.providers[path] ?? null,
    fetchHead: async (repoPath, remote, headBranch) => {
      input.recorded?.fetches.push({ repoPath, remote, headBranch });
      return input.fetch ?? { status: "fetched", oid: HEAD_SHA };
    },
    inspect: async () => input.inspect ?? inspection(),
    create: async (create) => {
      input.recorded?.creates.push(create);
      if (input.createError) throw input.createError;
      return {
        worktreeId: "wt-new",
        branch: create.headBranch,
        path: `/tmp/checkouts/${create.name}`,
        baseBranch: create.preferredBaseBranch,
        head: create.headCommit,
        ...input.created,
      };
    },
    update: async (row, expected) => {
      input.recorded?.updates.push({ worktreeId: row.id, expected });
      if (typeof input.update === "function") return input.update();
      return (
        input.update ?? {
          worktreeId: row.id,
          operation: "pull-rebase",
          status: "updated",
          previousHead: "c".repeat(40),
          head: HEAD_SHA,
        }
      );
    },
    taskIdsFor: (worktreeId) => input.taskIds?.[worktreeId] ?? [],
  };
}

function request(
  overrides: Partial<PullRequestViewCheckoutRequest> = {},
): PullRequestViewCheckoutRequest {
  return {
    projectId: PROJECT,
    provider: "forgejo",
    repositoryKey: REPOSITORY_KEY,
    number: 7,
    ...overrides,
  };
}

function recorder(): Recorded {
  return { fetches: [], creates: [], updates: [] };
}

afterEach(() => {
  resetPullRequestMutationsForTests();
});

/* --------------------------------- creating -------------------------------- */

test("creates a tracking checkout and records the pull request's base", async () => {
  const main = repo();
  const recorded = recorder();

  const result = await checkoutPullRequestFromView(
    request(),
    operations({
      rows: [row(mainWorktreeId(PROJECT), main, "main")],
      providers: { [main]: fakeProvider() },
      recorded,
    }),
  );

  // Everything the creation was given is server-derived: the head branch and
  // the preferred base come from the PROVIDER read, the remote from the
  // repository whose push URL proved the identity.
  assert.deepEqual(recorded.fetches, [
    { repoPath: main, remote: "origin", headBranch: "feature-7" },
  ]);
  // The commit the fetch VERIFIED travels into the creation: the branch is
  // made at that oid, not at a remote-tracking ref another fetch can move.
  assert.deepEqual(recorded.creates, [
    {
      projectId: PROJECT,
      name: "feature-7",
      remote: "origin",
      headBranch: "feature-7",
      headCommit: HEAD_SHA,
      preferredBaseBranch: "main",
    },
  ]);
  assert.equal(result.headBranch, "feature-7");
  assert.deepEqual(result.outcome, {
    status: "created",
    worktreeId: "wt-new",
    branch: "feature-7",
    path: "/tmp/checkouts/feature-7",
    head: HEAD_SHA,
    base: {
      branch: "main",
      pullRequestBase: "main",
      matchesPullRequestBase: true,
    },
    // The SERVER's own edges for the new checkout, so a client never has to
    // decide from a list whose freshness it cannot vouch for.
    taskIds: [],
  });
});

// The creation falls back when the pull request's base is not a local branch,
// and the answer SAYS so: where the work would merge back is not something a
// surface may infer from a request it sent.
test("reports a recorded base that is not the pull request's base", async () => {
  const main = repo();

  const result = await checkoutPullRequestFromView(
    request(),
    operations({
      rows: [row(mainWorktreeId(PROJECT), main, "main")],
      providers: {
        [main]: fakeProvider({ detail: detail({ baseBranch: "release/9" }) }),
      },
      created: { baseBranch: "main" },
    }),
  );

  assert.equal(result.outcome.status, "created");
  assert.deepEqual(
    result.outcome.status === "created" ? result.outcome.base : undefined,
    {
      branch: "main",
      pullRequestBase: "release/9",
      matchesPullRequestBase: false,
    },
  );
});

// A precondition the creation states is this endpoint's DATA, not a 500: the
// creation is atomic, so nothing was left behind to explain away.
test("a stated creation refusal is reported as data", async () => {
  const main = repo();

  const result = await checkoutPullRequestFromView(
    request(),
    operations({
      rows: [row(mainWorktreeId(PROJECT), main, "main")],
      providers: { [main]: fakeProvider() },
      createError: new WorktreeCreateRefusalError(
        'A local branch "feature-7" already exists here',
        "branch-exists",
      ),
    }),
  );

  assert.equal(result.outcome.status, "refused");
  if (result.outcome.status !== "refused") return;
  assert.equal(result.outcome.kind, "branch-exists");
  assert.match(result.outcome.reason, /already exists/);
});

test("a creation that fails for any other reason is not turned into a refusal", async () => {
  const main = repo();

  await assert.rejects(
    checkoutPullRequestFromView(
      request(),
      operations({
        rows: [row(mainWorktreeId(PROJECT), main, "main")],
        providers: { [main]: fakeProvider() },
        createError: new Error("disk full"),
      }),
    ),
    /disk full/,
  );
});

/* --------------------------------- updating -------------------------------- */

test("updates the existing checkout through pull-rebase", async () => {
  const main = repo();
  const other = repo();
  const recorded = recorder();
  const provider = fakeProvider();

  const result = await checkoutPullRequestFromView(
    request(),
    operations({
      rows: [
        row(mainWorktreeId(PROJECT), main, "main"),
        row("wt-7", other, "feature-7"),
      ],
      providers: { [main]: provider, [other]: provider },
      taskIds: { "wt-7": ["t-9"] },
      recorded,
    }),
  );

  assert.deepEqual(recorded.creates, []);
  // Both verified oids travel into the operation, which re-checks them under
  // the repository lock — its own fetch does not get to choose the target.
  assert.deepEqual(recorded.updates, [
    {
      worktreeId: "wt-7",
      expected: {
        head: "c".repeat(40),
        upstream: HEAD_SHA,
        // The upstream's IDENTITY as well as its commit: any two refs at one
        // commit satisfy an oid, so the pair the `not-tracking` guard accepted
        // is what the operation is held to.
        upstreamRemote: "origin",
        upstreamMerge: "refs/heads/feature-7",
      },
    },
  ]);
  assert.deepEqual(result.outcome, {
    status: "updated",
    worktreeId: "wt-7",
    branch: "feature-7",
    previousHead: "c".repeat(40),
    head: HEAD_SHA,
    base: {
      branch: "main",
      pullRequestBase: "main",
      matchesPullRequestBase: true,
    },
    taskIds: ["t-9"],
  });
});

// Standing at the head already is its OWN answer: reporting it as an update
// would claim git work that never ran.
// Already-current is still an ANSWER UNDER THE LOCK: the operation runs, with
// the same head and upstream so it has nothing to fetch or move, and reports
// what it found. Deciding this from the lock-free reads alone would be the one
// claim nothing verified.
test("a checkout already at the head answers through the locked operation", async () => {
  const main = repo();
  const other = repo();
  const recorded = recorder();
  const provider = fakeProvider();

  const result = await checkoutPullRequestFromView(
    request(),
    operations({
      rows: [
        row(mainWorktreeId(PROJECT), main, "main"),
        row("wt-7", other, "feature-7"),
      ],
      providers: { [main]: provider, [other]: provider },
      inspect: inspection({ head: HEAD_SHA }),
      update: {
        worktreeId: "wt-7",
        operation: "pull-rebase",
        status: "up-to-date",
        previousHead: HEAD_SHA,
        head: HEAD_SHA,
      },
      recorded,
    }),
  );

  // The expectation it is held to has head === upstream, which is what makes
  // the operation a no-op rather than a fetch.
  assert.deepEqual(recorded.updates, [
    {
      worktreeId: "wt-7",
      expected: {
        head: HEAD_SHA,
        upstream: HEAD_SHA,
        upstreamRemote: "origin",
        upstreamMerge: "refs/heads/feature-7",
      },
    },
  ]);
  assert.deepEqual(result.outcome, {
    status: "already-current",
    worktreeId: "wt-7",
    branch: "feature-7",
    head: HEAD_SHA,
    base: {
      branch: "main",
      pullRequestBase: "main",
      matchesPullRequestBase: true,
    },
    taskIds: [],
  });
});

// `pull-rebase` re-pins under the repository lock, so a rebase that found
// nothing to do is reported as what it FOUND rather than as a move.
test("a rebase that moved nothing is reported as already-current", async () => {
  const main = repo();
  const other = repo();
  const provider = fakeProvider();

  const result = await checkoutPullRequestFromView(
    request(),
    operations({
      rows: [
        row(mainWorktreeId(PROJECT), main, "main"),
        row("wt-7", other, "feature-7"),
      ],
      providers: { [main]: provider, [other]: provider },
      update: {
        worktreeId: "wt-7",
        operation: "pull-rebase",
        status: "up-to-date",
        previousHead: HEAD_SHA,
        head: HEAD_SHA,
      },
    }),
  );

  assert.equal(result.outcome.status, "already-current");
});

/* --------------------------------- refusals -------------------------------- */

const REFUSALS: {
  name: string;
  kind: string;
  reason: RegExp;
  ops: Partial<Parameters<typeof operations>[0]>;
}[] = [
  {
    name: "a dirty checkout is left alone",
    kind: "dirty",
    reason: /uncommitted changes/,
    ops: { inspect: inspection({ dirty: true }) },
  },
  {
    name: "a diverged branch is never reset",
    kind: "diverged",
    reason: /local commits, or the branch was force-pushed/,
    ops: { inspect: inspection({ headIsAncestorOfPullRequest: false }) },
  },
  {
    name: "a branch tracking something else is not pulled",
    kind: "not-tracking",
    reason: /tracks origin\/other-branch/,
    ops: {
      inspect: inspection({ upstreamMerge: "refs/heads/other-branch" }),
    },
  },
  {
    name: "a branch with no upstream proves nothing",
    kind: "not-tracking",
    reason: /has no upstream/,
    ops: {
      inspect: inspection({ upstreamRemote: "", upstreamMerge: "" }),
    },
  },
  {
    name: "a rebase that refused is reported with its own words",
    kind: "update-failed",
    reason: /hit a conflict/,
    ops: {
      update: async () => {
        throw new Error("Pull with rebase hit a conflict.");
      },
    },
  },
];

for (const refusal of REFUSALS) {
  test(`refuses as data: ${refusal.name}`, async () => {
    const main = repo();
    const other = repo();
    const provider = fakeProvider();

    const result = await checkoutPullRequestFromView(
      request(),
      operations({
        rows: [
          row(mainWorktreeId(PROJECT), main, "main"),
          row("wt-7", other, "feature-7"),
        ],
        providers: { [main]: provider, [other]: provider },
        ...refusal.ops,
      }),
    );

    assert.equal(result.outcome.status, "refused");
    if (result.outcome.status !== "refused") return;
    assert.equal(result.outcome.kind, refusal.kind);
    assert.match(result.outcome.reason, refusal.reason);
    // A refusal about an existing checkout names it, so the surface can point
    // at the thing it is about.
    assert.equal(result.outcome.worktreeId, "wt-7");
  });
}

// A head this remote does not carry. The fetch cannot tell a fork from an
// unreachable remote, so the refusal states BOTH readings rather than
// explaining a network outage as a fork — and it quotes what Git said.
test("refuses a head branch the remote does not have", async () => {
  const main = repo();

  const result = await checkoutPullRequestFromView(
    request(),
    operations({
      rows: [row(mainWorktreeId(PROJECT), main, "main")],
      providers: { [main]: fakeProvider() },
      fetch: {
        status: "unreachable",
        error: "couldn't find remote ref refs/heads/feature-7",
      },
    }),
  );

  assert.equal(result.outcome.status, "refused");
  if (result.outcome.status !== "refused") return;
  assert.equal(result.outcome.kind, "head-unreachable");
  assert.match(result.outcome.reason, /opened from a fork has none here/);
  assert.match(result.outcome.reason, /remote could not be reached/);
  assert.match(result.outcome.reason, /couldn't find remote ref/);
});

// The same-named branch of a DIFFERENT repository is exactly what a fork's pull
// request looks like from here, so equality with the reported head is required.
test("refuses when the fetched branch is not the pull request's head", async () => {
  const main = repo();
  const recorded = recorder();

  const result = await checkoutPullRequestFromView(
    request(),
    operations({
      rows: [row(mainWorktreeId(PROJECT), main, "main")],
      providers: { [main]: fakeProvider() },
      fetch: { status: "fetched", oid: "f".repeat(40) },
      recorded,
    }),
  );

  assert.deepEqual(recorded.creates, []);
  assert.equal(result.outcome.status, "refused");
  if (result.outcome.status !== "refused") return;
  assert.equal(result.outcome.kind, "head-moved");
  assert.match(result.outcome.reason, /on a fork/);
});

// Two checkouts on the head branch is not "no checkout": adding a third would
// be the one thing the user did not ask for.
test("refuses when two checkouts stand on the head branch", async () => {
  const main = repo();
  const first = repo();
  const second = repo();
  const provider = fakeProvider();
  const recorded = recorder();

  const result = await checkoutPullRequestFromView(
    request(),
    operations({
      rows: [
        row(mainWorktreeId(PROJECT), main, "main"),
        row("wt-a", first, "feature-7"),
        row("wt-b", second, "feature-7"),
      ],
      providers: {
        [main]: provider,
        [first]: provider,
        [second]: provider,
      },
      recorded,
    }),
  );

  assert.deepEqual(recorded.creates, []);
  assert.deepEqual(recorded.fetches, []);
  assert.equal(result.outcome.status, "refused");
  if (result.outcome.status !== "refused") return;
  assert.equal(result.outcome.kind, "ambiguous-checkout");
  assert.match(result.outcome.reason, /2 local worktrees/);
});

/* --------------------------------- identity -------------------------------- */

// A worktree on the head branch that publishes SOMEWHERE ELSE is other work.
// It is neither updated nor counted, and the checkout is created instead.
test("ignores a same-named branch that belongs to another repository", async () => {
  const main = repo();
  const fork = repo();
  const recorded = recorder();

  const result = await checkoutPullRequestFromView(
    request(),
    operations({
      rows: [
        row(mainWorktreeId(PROJECT), main, "main"),
        row("wt-fork", fork, "feature-7"),
      ],
      providers: {
        [main]: fakeProvider(),
        [fork]: fakeProvider({ repoWebUrl: "https://git.example/other/repo" }),
      },
      recorded,
    }),
  );

  assert.deepEqual(recorded.updates, []);
  assert.equal(recorded.creates.length, 1);
  assert.equal(result.outcome.status, "created");
});

test("refuses an identity the project's main checkout does not publish to", async () => {
  const main = repo();

  await assert.rejects(
    checkoutPullRequestFromView(
      request({ repositoryKey: "someone/else" }),
      operations({
        rows: [row(mainWorktreeId(PROJECT), main, "main")],
        providers: { [main]: fakeProvider() },
      }),
    ),
    (err: unknown) =>
      err instanceof PullRequestViewMergeError && err.status === 404,
  );
});

test("refuses a project with no main checkout on this machine", async () => {
  const other = repo();

  await assert.rejects(
    checkoutPullRequestFromView(
      request(),
      operations({
        rows: [row("wt-7", other, "feature-7")],
        providers: { [other]: fakeProvider() },
      }),
    ),
    (err: unknown) =>
      err instanceof PullRequestViewMergeError && err.status === 404,
  );
});

test("refuses a pull request the provider could not be read for", async () => {
  const main = repo();

  await assert.rejects(
    checkoutPullRequestFromView(
      request(),
      operations({
        rows: [row(mainWorktreeId(PROJECT), main, "main")],
        providers: {
          [main]: {
            kind: "forgejo",
            repoWebUrl: "https://git.example/acme/repo",
            pullRequestDetail: async () => null,
          } as unknown as GitHostingProvider,
        },
      }),
    ),
    (err: unknown) =>
      err instanceof PullRequestViewMergeError && err.status === 409,
  );
});

/* ----------------------------------- lock ---------------------------------- */

// The same lock the merge and the check take: a checkout cannot start while
// something else is acting on this pull request, and the loser is refused
// before any side effect rather than queued behind it.
test("is refused while another mutation holds this pull request", async () => {
  const main = repo();
  const recorded = recorder();

  await withPullRequestMutation(
    { repoPath: main, providerKind: "forgejo", number: 7 },
    "a merge & clean up",
    async () => {
      await assert.rejects(
        checkoutPullRequestFromView(
          request(),
          operations({
            rows: [row(mainWorktreeId(PROJECT), main, "main")],
            providers: { [main]: fakeProvider() },
            recorded,
          }),
        ),
        /is busy: a merge & clean up is running/,
      );
    },
  );

  assert.deepEqual(recorded.fetches, []);
  assert.deepEqual(recorded.creates, []);
});

// The lock is per pull request, not per repository: another number in the same
// repository is not this one's business.
test("is not blocked by a mutation on another pull request", async () => {
  const main = repo();

  await withPullRequestMutation(
    { repoPath: main, providerKind: "forgejo", number: 8 },
    "a merge & clean up",
    async () => {
      const result = await checkoutPullRequestFromView(
        request(),
        operations({
          rows: [row(mainWorktreeId(PROJECT), main, "main")],
          providers: { [main]: fakeProvider() },
        }),
      );
      assert.equal(result.outcome.status, "created");
    },
  );
});

/* ------------------------------ pinned oids -------------------------------- */

// A precondition the operation refused UNDER its lock is a race, not a failed
// update: nothing was mutated, and the next attempt reads the state that
// overtook this one. It must not be reported as `update-failed`, which means
// the rebase itself refused.
test("a precondition that no longer holds is reported as a race", async () => {
  const main = repo();
  const other = repo();
  const provider = fakeProvider();

  const result = await checkoutPullRequestFromView(
    request(),
    operations({
      rows: [
        row(mainWorktreeId(PROJECT), main, "main"),
        row("wt-7", other, "feature-7"),
      ],
      providers: { [main]: provider, [other]: provider },
      update: () => {
        throw new WorktreeSyncPreconditionError(
          "origin/feature-7 is at ffffffffffff, not the aaaaaaaaaaaa this update was checked against.",
          "pull-rebase",
        );
      },
    }),
  );

  assert.equal(result.outcome.status, "refused");
  if (result.outcome.status !== "refused") return;
  assert.equal(result.outcome.kind, "raced");
  assert.match(result.outcome.reason, /not the aaaaaaaaaaaa/);
  assert.equal(result.outcome.worktreeId, "wt-7");
});

// The fetch runs WITHOUT the repository lock, so its isolation has to be a
// fact about the command rather than a claim in a comment: `FETCH_HEAD` is
// what `worktreeSync.ts` and `baseCheckoutRefresh.ts` read under that lock to
// decide what to rebase onto.
test("the head fetch writes the tracking ref and nothing else", () => {
  const args = pullRequestHeadFetchArgs("origin", "feature-7");
  assert.deepEqual(args, [
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    "--",
    "origin",
    "+refs/heads/feature-7:refs/remotes/origin/feature-7",
  ]);
});

// The same claim, against a real repository: the production operation itself.
test("the real head fetch leaves FETCH_HEAD untouched", async () => {
  const remote = mkdtempSync(join(tmpdir(), "pr-checkout-remote-"));
  const sh = (cwd: string, ...args: string[]): string =>
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
      {
        cwd,
        encoding: "utf8",
      },
    );
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", remote]);
  writeFileSync(join(remote, "a.txt"), "a\n");
  sh(remote, "add", "-A");
  sh(remote, "commit", "-qm", "init");
  sh(remote, "branch", "feature-7");
  const clone = mkdtempSync(join(tmpdir(), "pr-checkout-clone-"));
  execFileSync("git", ["clone", "--quiet", remote, clone]);

  // Something else's locked operation left its target in FETCH_HEAD.
  const sentinel = `${sh(clone, "rev-parse", "HEAD").trim()}\t\tbranch 'main' of ${remote}\n`;
  const fetchHeadPath = join(clone, ".git", "FETCH_HEAD");
  writeFileSync(fetchHeadPath, sentinel);

  // The pull request's head moves, so the fetch really has work to do.
  sh(remote, "checkout", "-q", "feature-7");
  writeFileSync(join(remote, "b.txt"), "b\n");
  sh(remote, "add", "-A");
  sh(remote, "commit", "-qm", "seven");
  const head = sh(remote, "rev-parse", "HEAD").trim();

  const fetched = await pullRequestCheckoutOperationsForTests().fetchHead(
    clone,
    "origin",
    "feature-7",
  );

  assert.deepEqual(fetched, { status: "fetched", oid: head });
  assert.equal(
    sh(clone, "rev-parse", "refs/remotes/origin/feature-7").trim(),
    head,
  );
  assert.equal(readFileSync(fetchHeadPath, "utf8"), sentinel);
});

/* ------------------------ the already-current path ------------------------- */

// The bypass this path used to be: standing at the pull request's head was
// answered from the lock-free reads, so a concurrent action could repoint the
// upstream between the inspection and the answer and still get `already-current`
// — a review session opening on a checkout that follows something else.
test("a race under the lock refuses even when nothing needed fetching", async () => {
  const main = repo();
  const other = repo();
  const recorded = recorder();
  const provider = fakeProvider();

  const result = await checkoutPullRequestFromView(
    request(),
    operations({
      rows: [
        row(mainWorktreeId(PROJECT), main, "main"),
        row("wt-7", other, "feature-7"),
      ],
      providers: { [main]: provider, [other]: provider },
      inspect: inspection({ head: HEAD_SHA }),
      update: () => {
        throw new WorktreeSyncPreconditionError(
          '"feature-7" now tracks origin/decoy, not the origin/refs/heads/feature-7 this update was checked against.',
          "pull-rebase",
        );
      },
      recorded,
    }),
  );

  assert.equal(recorded.updates.length, 1, "the operation was consulted");
  assert.equal(result.outcome.status, "refused");
  if (result.outcome.status !== "refused") return;
  assert.equal(result.outcome.kind, "raced");
  assert.match(result.outcome.reason, /now tracks origin\/decoy/);
});

// A DETACHED checkout tracks nothing, however convincing the commit under it
// looks. Sitting at the pull request's head exactly is not evidence about what
// it follows, and it must not be answered as `already-current`.
test("a detached checkout at the pull request's head is not already-current", async () => {
  const main = repo();
  const other = repo();
  const recorded = recorder();
  const provider = fakeProvider();

  const result = await checkoutPullRequestFromView(
    request(),
    operations({
      rows: [
        row(mainWorktreeId(PROJECT), main, "main"),
        row("wt-7", other, "feature-7"),
      ],
      providers: { [main]: provider, [other]: provider },
      inspect: inspection({ head: HEAD_SHA, branch: "" }),
      recorded,
    }),
  );

  assert.deepEqual(recorded.updates, [], "nothing was asked of the checkout");
  assert.equal(result.outcome.status, "refused");
  if (result.outcome.status !== "refused") return;
  assert.equal(result.outcome.kind, "not-tracking");
  assert.match(result.outcome.reason, /a detached HEAD/);
});

test("a checkout standing on another branch is not already-current either", async () => {
  const main = repo();
  const other = repo();
  const provider = fakeProvider();

  const result = await checkoutPullRequestFromView(
    request(),
    operations({
      rows: [
        row(mainWorktreeId(PROJECT), main, "main"),
        row("wt-7", other, "feature-7"),
      ],
      providers: { [main]: provider, [other]: provider },
      inspect: inspection({ head: HEAD_SHA, branch: "something-else" }),
    }),
  );

  assert.equal(result.outcome.status, "refused");
  if (result.outcome.status !== "refused") return;
  assert.equal(result.outcome.kind, "not-tracking");
  assert.match(result.outcome.reason, /is on something-else, not feature-7/);
});
