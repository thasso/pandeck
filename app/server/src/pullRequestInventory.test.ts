/**
 * Unit tests for the Pull Requests inventory: which pull requests it selects,
 * the repository-scoped identity its joins and de-duplication rest on, the
 * caching/coalescing of its per-pull-request reads, and what it does with a
 * provider that will not answer. Providers are faked at the `gitHosting.ts`
 * seam; the worktree rows, link edges and `/pr` cards are the real stores. Run:
 *   pnpm --filter @assistant/server test src/pullRequestInventory.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type {
  HostedPullRequest,
  PullRequestDetail,
  TaskSummary,
} from "@assistant/shared";
import {
  insertWorktree,
  linkSessionToWorktree,
  linkTaskToWorktree,
  type WorktreeRow,
} from "./db/worktreeStore.ts";
import {
  invalidateRepositoryCapabilities,
  type GitHostingProvider,
} from "./gitHosting.ts";
import {
  createPullRequestCard,
  resetPullRequestCardsStoreForTests,
  setPullRequestCardBroadcastForTests,
} from "./pullRequestCards.ts";
import { invalidateProjectPullRequests } from "./worktrees/worktreeHosting.ts";
import { mainWorktreeId } from "./worktrees/worktreeResolve.ts";

const hoisted = vi.hoisted(() => ({ provider: vi.fn() }));

vi.mock("./gitExec.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gitExec.ts")>();
  return {
    ...actual,
    resolveRepoRoot: async () => "/repo",
    gitOptional: async () => ({ code: 0, stdout: "h".repeat(40), stderr: "" }),
  };
});

vi.mock("./pushWorkflow.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pushWorkflow.ts")>();
  return {
    ...actual,
    resolvePushTarget: async () => ({ repoRoot: "/repo", remote: "origin" }),
  };
});

vi.mock("./gitHosting.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gitHosting.ts")>();
  return { ...actual, hostingProviderForRepo: hoisted.provider };
});

const {
  buildPullRequestInventory,
  pullRequestInventory,
  invalidatePullRequestInventoryReads,
  resetPullRequestInventoryCacheForTests,
} = await import("./pullRequestInventory.ts");

/* --------------------------------- fixtures -------------------------------- */

/** `hostingProviderForRepo` answers per checkout PATH, as production does. */
function serveProviders(byPath: Record<string, GitHostingProvider>): void {
  hoisted.provider.mockImplementation(
    async (path: string) => byPath[path] ?? null,
  );
}

function mainPath(projectId: string): string {
  return `/main/${projectId}`;
}

/** Web URL of one repository — the identity every join is keyed on. */
function repoWebUrl(repo: string): string {
  return `https://git.example/acme/${repo}`;
}

function pullUrl(repo: string, number: number): string {
  return `${repoWebUrl(repo)}/pulls/${number}`;
}

function mainRow(projectId: string): WorktreeRow {
  return {
    id: mainWorktreeId(projectId),
    projectId,
    mainRepoRoot: mainPath(projectId),
    path: mainPath(projectId),
    branch: "main",
    baseBranch: "main",
    baseCommit: "b".repeat(40),
    status: "active",
    mergeStateJson: null,
    createdAt: 1,
    updatedAt: 1,
    removedAt: null,
  };
}

/** A spawned row, persisted so the real link-edge readers can see it. */
function spawnedRow(
  projectId: string,
  id: string,
  branch: string,
  status: WorktreeRow["status"] = "active",
): WorktreeRow {
  const row: WorktreeRow = {
    id,
    projectId,
    mainRepoRoot: mainPath(projectId),
    path: `/worktrees/${id}`,
    branch,
    baseBranch: "main",
    baseCommit: "c".repeat(40),
    status,
    mergeStateJson: null,
    createdAt: 2,
    updatedAt: 2,
    removedAt: status === "removed" ? 3 : null,
  };
  insertWorktree(row);
  return row;
}

function pull(
  repo: string,
  number: number,
  overrides: Partial<HostedPullRequest> = {},
): HostedPullRequest {
  return {
    number,
    url: pullUrl(repo, number),
    title: `Pull ${number}`,
    headBranch: `feature-${number}`,
    baseBranch: "main",
    author: "someone",
    mine: false,
    reviewRequested: false,
    ...overrides,
  };
}

function detail(
  number: number,
  overrides: Partial<PullRequestDetail> = {},
): PullRequestDetail {
  return {
    number,
    state: "open",
    merged: false,
    mergeable: true,
    draft: false,
    headSha: "a".repeat(40),
    headBranch: `feature-${number}`,
    baseBranch: "main",
    ...overrides,
  };
}

function provider(
  repo: string,
  overrides: Partial<GitHostingProvider> = {},
): GitHostingProvider {
  return {
    kind: "forgejo",
    // Distinct per repository, so the per-REPOSITORY capabilities cache cannot
    // answer one test's provider with another's.
    repository: { host: "git.example", owner: "acme", repo },
    repoWebUrl: repoWebUrl(repo),
    listOpenPullRequests: async () => [],
    findPullRequestForBranch: async () => null,
    pullRequestDetail: async (number: number) => detail(number),
    ciStatus: async () => ({ state: "success" as const, total: 3 }),
    pullRequestReview: async () => ({ changesRequested: false }),
    repositoryCapabilities: async () => ({
      defaultBranch: "main",
      mergeMethods: ["squash"],
    }),
    ...overrides,
  } as unknown as GitHostingProvider;
}

/** A `/pr` card for one repository's pull request, as the joins read it. */
function card(
  sessionId: string,
  repo: string,
  number: number,
  linkedTask?: TaskSummary,
): void {
  createPullRequestCard(
    {
      sessionId,
      status: "open",
      title: `Pull ${number}`,
      headBranch: `feature-${number}`,
      baseBranch: "main",
      provider: "forgejo",
      number,
      url: pullUrl(repo, number),
      ...(linkedTask ? { linkedTask } : {}),
    },
    {
      repoRoot: `/main/${repo}`,
      sessionKind: "developer",
      sessionId,
      headBranch: `feature-${number}`,
      baseBranch: "main",
      draft: false,
    },
  );
}

function task(id: string): TaskSummary {
  return { id, title: `Task ${id}`, status: "doing" } as TaskSummary;
}

afterEach(() => {
  resetPullRequestInventoryCacheForTests();
  // The per-project PR list is module state too: a project id reused by a later
  // case must not be answered from this one.
  invalidateProjectPullRequests();
  invalidateRepositoryCapabilities();
  resetPullRequestCardsStoreForTests();
  setPullRequestCardBroadcastForTests(null);
  hoisted.provider.mockReset();
});

/* -------------------------------- selection -------------------------------- */

// The view is "what wants something from me", not "what is open on the repo":
// mine and review-requested are listed, a draft of mine is listed AND flagged,
// and somebody else's pull request is not listed at all.
test("open pull requests are selected by mine or review-requested", async () => {
  const projectId = "selection";
  serveProviders({
    [mainPath(projectId)]: provider(projectId, {
      listOpenPullRequests: async () => [
        pull(projectId, 10, { mine: true, author: "me" }),
        pull(projectId, 11, { reviewRequested: true }),
        pull(projectId, 12, { mine: true, draft: true, author: "me" }),
        pull(projectId, 13),
      ],
    }),
  });

  const items = await pullRequestInventory([mainRow(projectId)]);

  assert.deepEqual(
    items.map((item) => item.number),
    [12, 11, 10],
  );
  assert.equal(items.find((item) => item.number === 12)?.draft, true);
  assert.equal(items.find((item) => item.number === 11)?.mine, false);
  assert.equal(items.find((item) => item.number === 11)?.reviewRequested, true);
  for (const item of items) assert.equal(item.state, "open");
});

// When the open list already read a pull request's detail, head CI and review
// in the same request (GitHub's GraphQL list), nothing is read per pull request.
test("an annotation from the open list replaces the per-pull-request reads", async () => {
  const projectId = "annotated";
  const perRequest = vi.fn(async () => {
    throw new Error("per-pull-request read must not run");
  });
  serveProviders({
    [mainPath(projectId)]: provider(projectId, {
      listOpenPullRequests: async () => [
        pull(projectId, 20, { mine: true, author: "me" }),
      ],
      openPullRequestAnnotation: (number: number) =>
        number === 20
          ? {
              detail: detail(20, { mergeable: false, headSha: "c".repeat(40) }),
              ci: { state: "failure" as const, total: 2 },
              review: { changesRequested: true },
            }
          : undefined,
      pullRequestDetail: perRequest,
      ciStatus: perRequest,
      pullRequestReview: perRequest,
    }),
  });

  const [item] = await pullRequestInventory([mainRow(projectId)]);

  assert.equal(perRequest.mock.calls.length, 0);
  assert.equal(item?.mergeable, false);
  assert.equal(item?.headSha, "c".repeat(40));
  assert.deepEqual(item?.ci, { state: "failure", total: 2 });
  assert.deepEqual(item?.review, { changesRequested: true });
});

// A merged pull request is inventoried for the checkout it leaves behind: it
// stays visible exactly as long as that worktree does.
test("a merged pull request is listed while its worktree exists", async () => {
  const projectId = "cleanup";
  const row = spawnedRow(projectId, "wt-cleanup", "feature-merged");
  serveProviders({
    [mainPath(projectId)]: provider(projectId),
    [row.path]: provider(projectId, {
      findPullRequestForBranch: async () => ({
        number: 20,
        url: pullUrl(projectId, 20),
        title: "Merged work",
        state: "merged",
      }),
    }),
  });

  const items = await pullRequestInventory([mainRow(projectId), row]);

  assert.deepEqual(
    items.map((item) => [item.number, item.state, item.worktreeId]),
    [[20, "merged", row.id]],
  );
  const [item] = items;
  assert.equal(item?.headBranch, "feature-merged");
  assert.equal(item?.baseBranch, "main");
  // Nothing left to merge or review, so nothing is claimed about either.
  assert.equal(item?.mergeable, undefined);
  assert.equal(item?.review, undefined);
  assert.equal(item?.capabilities, undefined);
  // The open-PR list is the only thing that can state authorship.
  assert.equal(item?.mine, false);
});

// Without a local worktree there is nothing to clean up, so a merged pull
// request is simply gone: a removed row does not resurrect it.
test("a merged pull request without an active worktree is excluded", async () => {
  const projectId = "no-cleanup";
  const row = spawnedRow(projectId, "wt-removed", "feature-gone", "removed");
  serveProviders({
    [mainPath(projectId)]: provider(projectId),
    [row.path]: provider(projectId, {
      findPullRequestForBranch: async () => ({
        number: 21,
        url: pullUrl(projectId, 21),
        title: "Merged and cleaned",
        state: "merged",
      }),
    }),
  });

  const items = await pullRequestInventory([mainRow(projectId), row]);

  assert.deepEqual(items, []);
});

// The 15 s branch projection is fresher than the 60 s list, so a pull request
// both of them describe is inventoried ONCE, in the state that read reports.
test("a terminal branch projection supersedes the open list entry", async () => {
  const projectId = "terminal-wins";
  const row = spawnedRow(projectId, "wt-terminal-wins", "feature-22");
  serveProviders({
    [mainPath(projectId)]: provider(projectId, {
      listOpenPullRequests: async () => [
        pull(projectId, 22, { mine: true, author: "me" }),
      ],
    }),
    [row.path]: provider(projectId, {
      findPullRequestForBranch: async () => ({
        number: 22,
        url: pullUrl(projectId, 22),
        title: "Pull 22",
        state: "merged",
      }),
    }),
  });

  const items = await pullRequestInventory([mainRow(projectId), row]);

  assert.deepEqual(
    items.map((item) => [item.number, item.state]),
    [[22, "merged"]],
  );
  // The list entry is this same pull request, so its authorship is kept.
  assert.equal(items[0]?.mine, true);
  assert.equal(items[0]?.author, "me");
  assert.equal(items[0]?.worktreeId, row.id);
});

// The synthetic main record is the base branch, not a pull request: it is never
// inventoried and never joined as a worktree, whatever its branch is called.
test("the synthetic main record is never inventoried or joined", async () => {
  const projectId = "main-only";
  serveProviders({
    [mainPath(projectId)]: provider(projectId, {
      listOpenPullRequests: async () => [
        pull(projectId, 23, { mine: true, headBranch: "main" }),
      ],
      // Were a main record ever asked for its branch, this would become an item.
      findPullRequestForBranch: async () => ({
        number: 24,
        url: pullUrl(projectId, 24),
        title: "Merged base",
        state: "merged",
      }),
    }),
  });

  const items = await pullRequestInventory([mainRow(projectId)]);

  assert.deepEqual(
    items.map((item) => item.number),
    [23],
  );
  assert.equal(items[0]?.worktreeId, undefined);
});

/* --------------------------- repository identity --------------------------- */

// Every repository numbers its pull requests from 1, so #7 in two of them is
// ordinary: a card in one repository must not lend its session to the other.
test("same-number pull requests in two repositories join separately", async () => {
  card("session-alpha", "alpha", 7, task("task-alpha"));
  serveProviders({
    [mainPath("alpha")]: provider("alpha", {
      listOpenPullRequests: async () => [pull("alpha", 7, { mine: true })],
    }),
    [mainPath("beta")]: provider("beta", {
      listOpenPullRequests: async () => [pull("beta", 7, { mine: true })],
    }),
  });

  const items = await pullRequestInventory([mainRow("alpha"), mainRow("beta")]);

  const alpha = items.find((item) => item.projectId === "alpha");
  const beta = items.find((item) => item.projectId === "beta");
  assert.deepEqual(alpha?.sessionIds, ["session-alpha"]);
  assert.deepEqual(alpha?.taskIds, ["task-alpha"]);
  assert.deepEqual(beta?.sessionIds, []);
  assert.deepEqual(beta?.taskIds, []);
});

// One project can publish a worktree to another repository (a `pushurl` fork).
// A merged #7 there must not suppress the open #7 of the main repository.
test("a fork's terminal pull request cannot suppress the main repo's", async () => {
  const projectId = "fork-publisher";
  const row = spawnedRow(projectId, "wt-fork", "feature-7");
  serveProviders({
    [mainPath(projectId)]: provider("upstream", {
      listOpenPullRequests: async () => [
        pull("upstream", 7, { mine: true, author: "me" }),
      ],
    }),
    [row.path]: provider("fork", {
      findPullRequestForBranch: async () => ({
        number: 7,
        url: pullUrl("fork", 7),
        title: "Fork's seventh",
        state: "merged",
      }),
    }),
  });

  const items = await pullRequestInventory([mainRow(projectId), row]);

  assert.deepEqual(
    items.map((item) => [item.number, item.state, item.repoWebUrl]),
    // Same project, same number, two repositories: the repository breaks the
    // ordering tie so the list is deterministic.
    [
      [7, "merged", repoWebUrl("fork")],
      [7, "open", repoWebUrl("upstream")],
    ],
  );
  // And each one carries the repository half of its identity, which is what
  // lets a CLIENT address them apart: project + number names both.
  assert.deepEqual(
    items.map((item) => item.repositoryKey),
    ["acme/fork", "acme/upstream"],
  );
  // The merged fork pull request is the one holding the checkout; the upstream
  // pull request of the same number does not borrow it.
  assert.equal(
    items.find((item) => item.state === "open")?.worktreeId,
    undefined,
  );
  assert.equal(
    items.find((item) => item.state === "merged")?.worktreeId,
    row.id,
  );
});

/* ---------------------------------- joins ---------------------------------- */

// The client cannot make these joins: it does not know which branch a worktree
// holds, and a `/pr` card's provider identity lives only in the server's store.
test("joins carry the worktree, its sessions and Tasks, and the card's", async () => {
  const projectId = "joins";
  const row = spawnedRow(projectId, "wt-joins", "feature-30");
  linkSessionToWorktree("session-worktree", row.id);
  linkTaskToWorktree("task-worktree", row.id);
  card("session-card", projectId, 30, task("task-card"));
  serveProviders({
    [mainPath(projectId)]: provider(projectId, {
      listOpenPullRequests: async () => [pull(projectId, 30, { mine: true })],
    }),
    [row.path]: provider(projectId),
  });

  const items = await pullRequestInventory([mainRow(projectId), row]);

  assert.equal(items.length, 1);
  assert.equal(items[0]?.worktreeId, row.id);
  assert.deepEqual(items[0]?.sessionIds, ["session-worktree", "session-card"]);
  assert.deepEqual(items[0]?.taskIds, ["task-worktree", "task-card"]);
});

// A card for a DIFFERENT pull request number must not lend its session to this
// one, and a pull request with no local checkout joins nothing.
test("a pull request without local objects joins nothing", async () => {
  const projectId = "unjoined";
  card("session-other", projectId, 41);
  serveProviders({
    [mainPath(projectId)]: provider(projectId, {
      listOpenPullRequests: async () => [pull(projectId, 40, { mine: true })],
    }),
  });

  const items = await pullRequestInventory([mainRow(projectId)]);

  assert.equal(items[0]?.worktreeId, undefined);
  assert.deepEqual(items[0]?.sessionIds, []);
  assert.deepEqual(items[0]?.taskIds, []);
});

/* ------------------------------ absent = unknown --------------------------- */

// One project's outage is that project's alone; it drops out of the inventory
// (absence means unknown) and every other project still answers.
test("a project whose list cannot be read never drops another's", async () => {
  const broken = "broken";
  const healthy = "healthy";
  serveProviders({
    [mainPath(broken)]: provider(broken, {
      listOpenPullRequests: async () => {
        throw new Error("forgejo unreachable");
      },
    }),
    [mainPath(healthy)]: provider(healthy, {
      listOpenPullRequests: async () => [pull(healthy, 50, { mine: true })],
    }),
  });

  const build = await buildPullRequestInventory([
    mainRow(broken),
    mainRow(healthy),
  ]);

  assert.deepEqual(
    build.items.map((item) => [item.projectId, item.number]),
    [[healthy, 50]],
  );
  assert.deepEqual(build.projectIds, [broken, healthy]);
  assert.deepEqual(build.failedProjectIds, [broken]);
});

// A failed CI or review read leaves its field absent rather than inventing a
// clean answer — the pull request itself is still listed.
test("failed CI and review reads leave their fields absent", async () => {
  const projectId = "partial";
  serveProviders({
    [mainPath(projectId)]: provider(projectId, {
      listOpenPullRequests: async () => [pull(projectId, 60, { mine: true })],
      ciStatus: async () => {
        throw new Error("status API down");
      },
      pullRequestReview: async () => {
        throw new Error("reviews API down");
      },
    }),
  });

  const items = await pullRequestInventory([mainRow(projectId)]);

  assert.equal(items.length, 1);
  assert.equal(items[0]?.ci, undefined);
  assert.equal(items[0]?.review, undefined);
  // The detail read succeeded, so what it DID answer is still there.
  assert.equal(items[0]?.headSha, "a".repeat(40));
});

// `mergeable: null` means "ask again", never "conflicting", so it has to reach
// the client as null instead of collapsing into absent-or-false.
test("mergeable null survives as null", async () => {
  const projectId = "unknown-mergeable";
  serveProviders({
    [mainPath(projectId)]: provider(projectId, {
      listOpenPullRequests: async () => [pull(projectId, 70, { mine: true })],
      pullRequestDetail: async (number: number) =>
        detail(number, { mergeable: null }),
    }),
  });

  const items = await pullRequestInventory([mainRow(projectId)]);

  assert.equal(items.length, 1);
  assert.equal(items[0]?.mergeable, null);
  assert.ok("mergeable" in items[0]!);
});

// What the repository allows travels with an open pull request, beside the CI
// of the head the provider reported and the standing review.
test("an open pull request carries CI, review and capabilities", async () => {
  const projectId = "detail";
  serveProviders({
    [mainPath(projectId)]: provider(projectId, {
      listOpenPullRequests: async () => [pull(projectId, 80, { mine: true })],
      pullRequestReview: async () => ({
        changesRequested: true,
        unresolvedThreads: 2,
      }),
    }),
  });

  const items = await pullRequestInventory([mainRow(projectId)]);

  assert.deepEqual(items[0]?.ci, { state: "success", total: 3 });
  assert.deepEqual(items[0]?.review, {
    changesRequested: true,
    unresolvedThreads: 2,
  });
  assert.deepEqual(items[0]?.capabilities, {
    defaultBranch: "main",
    mergeMethods: ["squash"],
  });
  assert.equal(items[0]?.provider, "forgejo");
  assert.equal(items[0]?.repoWebUrl, repoWebUrl(projectId));
});

/* ---------------------------- reads: cache + retry ------------------------- */

// Only ANSWERS are cached, and each read is cached on its own: a CI outage is
// retried on the next build while the detail that answered is not asked again.
test("a failed read is retried while the answered one stays cached", async () => {
  const projectId = "retry";
  let ciCalls = 0;
  const pullRequestDetail = vi.fn(async (number: number) => detail(number));
  serveProviders({
    [mainPath(projectId)]: provider(projectId, {
      listOpenPullRequests: async () => [pull(projectId, 90, { mine: true })],
      pullRequestDetail,
      ciStatus: async () => {
        ciCalls += 1;
        if (ciCalls === 1) throw new Error("status API down");
        return { state: "failure" as const, total: 1 };
      },
    }),
  });

  const first = await pullRequestInventory([mainRow(projectId)]);
  const second = await pullRequestInventory([mainRow(projectId)]);

  assert.equal(first[0]?.ci, undefined);
  assert.deepEqual(second[0]?.ci, { state: "failure", total: 1 });
  assert.equal(ciCalls, 2);
  // The detail answered the first time and stands for the cache period.
  assert.equal(pullRequestDetail.mock.calls.length, 1);
});

// Two clients polling at once are ONE provider conversation: the second build
// joins the in-flight read instead of issuing its own.
test("concurrent builds coalesce onto one detail read", async () => {
  const projectId = "coalesce";
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  const pullRequestDetail = vi.fn(async (number: number) => {
    await gate;
    return detail(number);
  });
  serveProviders({
    [mainPath(projectId)]: provider(projectId, {
      listOpenPullRequests: async () => [pull(projectId, 91, { mine: true })],
      pullRequestDetail,
    }),
  });

  const builds = Promise.all([
    pullRequestInventory([mainRow(projectId)]),
    pullRequestInventory([mainRow(projectId)]),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  const [first, second] = await builds;

  assert.equal(pullRequestDetail.mock.calls.length, 1);
  assert.equal(first[0]?.headSha, "a".repeat(40));
  assert.equal(second[0]?.headSha, "a".repeat(40));
});

// Reusing the worktree projection's review SKIPS the read rather than caching
// an absent one, so a later build whose projection has none still reads it.
test("the review read falls back when no projection answers it", async () => {
  const projectId = "review-reuse";
  const row = spawnedRow(projectId, "wt-review-reuse", "feature-92");
  const pullRequestReview = vi.fn(async () => ({ changesRequested: true }));
  serveProviders({
    [mainPath(projectId)]: provider(projectId, {
      listOpenPullRequests: async () => [pull(projectId, 92, { mine: true })],
      pullRequestReview,
    }),
    // The worktree's own provider answers the projection's review, which the
    // first build then reuses instead of asking the repository again.
    [row.path]: provider(projectId, {
      findPullRequestForBranch: async () => ({
        number: 92,
        url: pullUrl(projectId, 92),
        title: "Pull 92",
        state: "open",
      }),
      pullRequestReview: async () => ({ changesRequested: false }),
    }),
  });

  const withWorktree = await pullRequestInventory([mainRow(projectId), row]);
  assert.deepEqual(withWorktree[0]?.review, { changesRequested: false });
  assert.equal(pullRequestReview.mock.calls.length, 0);

  // The checkout is gone; nothing cached a review, so it is read now.
  const withoutWorktree = await pullRequestInventory([mainRow(projectId)]);
  assert.deepEqual(withoutWorktree[0]?.review, { changesRequested: true });
  assert.equal(pullRequestReview.mock.calls.length, 1);
});

/* ------------------------------- invalidation ------------------------------ */

// An action on a pull request is followed IMMEDIATELY by a refetch of this
// projection, and both of its sources cache for 60 s. Without dropping what
// they remember about that pull request, the refetch hands the surface back the
// pull request the action just merged — still open.
test("invalidating one pull request lets the next read see the merge", async () => {
  const projectId = "invalidate";
  let open = true;
  serveProviders({
    [mainPath(projectId)]: provider(projectId, {
      listOpenPullRequests: async () =>
        open ? [pull(projectId, 30, { mine: true, author: "me" })] : [],
    }),
  });

  const before = await pullRequestInventory([mainRow(projectId)]);
  assert.deepEqual(
    before.map((item) => [item.number, item.state]),
    [[30, "open"]],
  );

  // The merge lands: the repository no longer lists it.
  open = false;
  // Without invalidation the 60 s list still describes it as open — which is
  // exactly the stale answer an action's own refetch would receive.
  assert.equal(
    (await pullRequestInventory([mainRow(projectId)]))[0]?.state,
    "open",
  );

  invalidateProjectPullRequests(projectId);
  invalidatePullRequestInventoryReads(`forgejo#acme/${projectId}#30`);

  assert.deepEqual(await pullRequestInventory([mainRow(projectId)]), []);
});

// A read that STARTED before the invalidation describes the repository from
// before the merge. It may still answer its own caller, but writing it into the
// cache afterwards would repopulate exactly what the action just dropped.
test("a list read in flight when the invalidation lands never repopulates the cache", async () => {
  const projectId = "generation";
  let release = () => undefined as void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  serveProviders({
    [mainPath(projectId)]: provider(projectId, {
      listOpenPullRequests: async () => {
        calls += 1;
        if (calls === 1) {
          await gate;
          return [pull(projectId, 31, { mine: true, author: "me" })];
        }
        return [];
      },
    }),
  });

  const inFlight = pullRequestInventory([mainRow(projectId)]);
  // The merge happens while that read is still out.
  invalidateProjectPullRequests(projectId);
  release();
  assert.equal((await inFlight)[0]?.number, 31);

  // The next read must ask the provider again rather than be served the answer
  // the in-flight read carried.
  assert.deepEqual(await pullRequestInventory([mainRow(projectId)]), []);
  assert.equal(calls, 2);
});
