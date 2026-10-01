/**
 * GitHub's batched GraphQL reads behind the background loops: one query per
 * repository answers what used to be per-row REST reads, with the same rules —
 * forks never claim a branch, an open pull request wins over a newer merged
 * one, check runs and legacy statuses fold into one CI answer, and the open
 * list's annotations are dropped by every write so a merge is never re-offered.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
  githubProvider,
  resetGithubOpenPullAnnotationsForTests,
} from "./gitHosting.ts";

const ref = { host: "github.com", owner: "acme", repo: "repo" };
const config = { token: "t", apiBaseUrl: "https://api.github.com" };
const originalFetch = globalThis.fetch;

interface Captured {
  method: string;
  path: string;
  body: { query?: string; variables?: Record<string, unknown> } | null;
}

function stubFetch(answer: (request: Captured) => unknown): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const request: Captured = {
      method: init?.method ?? "GET",
      path: new URL(String(input)).pathname,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(request);
    return new Response(JSON.stringify(answer(request)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetGithubOpenPullAnnotationsForTests();
});

const sha = (digit: string) => digit.repeat(40);

test("branch statuses for many worktrees are one GraphQL request", async () => {
  const calls = stubFetch(() => ({
    data: {
      repository: {
        b0: {
          pageInfo: { hasNextPage: false },
          nodes: [
            // Newer, but a FORK's same-named branch: never ours.
            {
              number: 9,
              title: "fork",
              url: "https://github.com/fork/repo/pull/9",
              state: "OPEN",
              headRepository: { nameWithOwner: "fork/repo" },
            },
            {
              number: 5,
              title: "merged earlier",
              url: "https://github.com/acme/repo/pull/5",
              state: "MERGED",
              headRepository: { nameWithOwner: "acme/repo" },
            },
            {
              number: 7,
              title: "open",
              url: "https://github.com/acme/repo/pull/7",
              state: "OPEN",
              headRepository: { nameWithOwner: "ACME/repo" },
              latestOpinionatedReviews: {
                nodes: [
                  {
                    state: "CHANGES_REQUESTED",
                    submittedAt: "2026-09-01T00:00:00Z",
                    author: { login: "reviewer" },
                  },
                ],
              },
            },
          ],
        },
        c0: {
          statusCheckRollup: {
            contexts: {
              totalCount: 2,
              nodes: [
                {
                  __typename: "CheckRun",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                  url: "https://github.com/acme/repo/runs/1",
                },
                {
                  __typename: "StatusContext",
                  state: "FAILURE",
                  targetUrl: "https://ci.example/2",
                },
              ],
            },
          },
        },
        b1: {
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              number: 3,
              title: "done",
              url: "https://github.com/acme/repo/pull/3",
              state: "MERGED",
              headRepository: { nameWithOwner: "acme/repo" },
            },
          ],
        },
        // Not pushed: GitHub has no such commit, so no CI.
        c1: null,
        c2: {
          statusCheckRollup: {
            contexts: {
              totalCount: 1,
              nodes: [
                {
                  __typename: "CheckRun",
                  status: "IN_PROGRESS",
                  conclusion: null,
                  url: null,
                  detailsUrl: "https://ci.example/3",
                },
              ],
            },
          },
        },
      },
    },
  }));

  const statuses = await githubProvider(ref, config).branchStatuses!([
    { branch: "feature", headSha: sha("a") },
    { branch: "done", headSha: sha("b") },
    { branch: null, headSha: sha("c") },
  ]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.path, "/graphql");
  assert.deepEqual(calls[0]!.body?.variables, {
    owner: "acme",
    name: "repo",
    b0: "feature",
    c0: sha("a"),
    b1: "done",
    c1: sha("b"),
    c2: sha("c"),
  });
  assert.deepEqual(statuses, [
    {
      pr: {
        number: 7,
        url: "https://github.com/acme/repo/pull/7",
        title: "open",
        state: "open",
      },
      ci: { state: "failure", url: "https://ci.example/2", total: 2 },
      review: { changesRequested: true },
    },
    {
      pr: {
        number: 3,
        url: "https://github.com/acme/repo/pull/3",
        title: "done",
        state: "merged",
      },
      ci: null,
      review: null,
    },
    {
      pr: null,
      ci: { state: "pending", url: "https://ci.example/3", total: 1 },
      review: null,
    },
  ]);
});

test("more checks than the first page stay pending", async () => {
  stubFetch(() => ({
    data: {
      repository: {
        c0: {
          statusCheckRollup: {
            contexts: {
              totalCount: 150,
              nodes: [
                {
                  __typename: "CheckRun",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                  url: "https://github.com/acme/repo/runs/1",
                },
              ],
            },
          },
        },
      },
    },
  }));
  const [status] = await githubProvider(ref, config).branchStatuses!([
    { branch: null, headSha: sha("d") },
  ]);
  assert.equal(status!.ci?.state, "pending");
  assert.equal(status!.ci?.total, 150);
});

test("a GraphQL error answers no row at all", async () => {
  stubFetch(() => ({
    data: { repository: { b0: { nodes: [] } } },
    errors: [{ message: "API rate limit exceeded" }],
  }));
  await assert.rejects(
    githubProvider(ref, config).branchStatuses!([
      { branch: "feature", headSha: null },
    ]),
    /rate limit exceeded/,
  );
});

const openListAnswer = () => ({
  data: {
    viewer: { login: "me" },
    repository: {
      pullRequests: {
        nodes: [
          {
            number: 7,
            title: "mine",
            url: "https://github.com/acme/repo/pull/7",
            isDraft: false,
            updatedAt: "2026-09-01T00:00:00Z",
            mergeable: "CONFLICTING",
            headRefName: "feature",
            headRefOid: sha("a"),
            baseRefName: "main",
            author: { login: "me" },
            reviewRequests: { nodes: [] },
            latestOpinionatedReviews: { nodes: [] },
            commits: {
              nodes: [
                {
                  commit: {
                    oid: sha("a"),
                    statusCheckRollup: {
                      contexts: {
                        totalCount: 1,
                        nodes: [
                          {
                            __typename: "CheckRun",
                            status: "COMPLETED",
                            conclusion: "SUCCESS",
                            url: "https://github.com/acme/repo/runs/1",
                          },
                        ],
                      },
                    },
                  },
                },
              ],
            },
          },
          {
            number: 8,
            title: "theirs",
            url: "https://github.com/acme/repo/pull/8",
            isDraft: true,
            mergeable: "UNKNOWN",
            headRefName: "other",
            headRefOid: sha("b"),
            baseRefName: "main",
            author: { login: "someone" },
            reviewRequests: {
              nodes: [{ requestedReviewer: { login: "me" } }],
            },
            latestOpinionatedReviews: { nodes: [] },
            // The listed commit is not the head: no annotation for it.
            commits: { nodes: [{ commit: { oid: sha("c") } }] },
          },
        ],
      },
    },
  },
});

test("the open list reads ownership, review requests and annotations in one query", async () => {
  const calls = stubFetch(openListAnswer);
  const provider = githubProvider(ref, config);

  const pulls = await provider.listOpenPullRequests();

  assert.equal(calls.length, 1);
  assert.deepEqual(pulls, [
    {
      number: 7,
      url: "https://github.com/acme/repo/pull/7",
      title: "mine",
      headBranch: "feature",
      baseBranch: "main",
      author: "me",
      mine: true,
      reviewRequested: false,
      updatedAt: Date.parse("2026-09-01T00:00:00Z"),
    },
    {
      number: 8,
      url: "https://github.com/acme/repo/pull/8",
      title: "theirs",
      headBranch: "other",
      baseBranch: "main",
      author: "someone",
      mine: false,
      reviewRequested: true,
      draft: true,
    },
  ]);
  assert.deepEqual(provider.openPullRequestAnnotation!(7), {
    detail: {
      number: 7,
      state: "open",
      merged: false,
      mergeable: false,
      draft: false,
      headSha: sha("a"),
      headBranch: "feature",
      baseBranch: "main",
    },
    ci: {
      state: "success",
      url: "https://github.com/acme/repo/runs/1",
      total: 1,
    },
    review: { changesRequested: false },
  });
  assert.equal(provider.openPullRequestAnnotation!(8), undefined);
  // Another provider object for the same repository shares the annotations.
  assert.ok(githubProvider(ref, config).openPullRequestAnnotation!(7));
});

test("a write drops the repository's annotations", async () => {
  stubFetch(openListAnswer);
  const provider = githubProvider(ref, config);
  await provider.listOpenPullRequests();
  assert.ok(provider.openPullRequestAnnotation!(7));

  stubFetch(() => ({
    number: 9,
    html_url: "https://github.com/acme/repo/pull/9",
    title: "new",
    state: "open",
  }));
  await provider.createPullRequest({
    title: "new",
    head: "feature-2",
    base: "main",
  });

  assert.equal(provider.openPullRequestAnnotation!(7), undefined);
});

// `headRefName` matches same-named branches on every fork. A full page with
// fork pull requests on it cannot prove ours is absent, so the owner-filtered
// REST lookup answers that branch.
test("a full branch page crowded by forks falls back to the REST lookup", async () => {
  const calls = stubFetch((request) => {
    if (request.path === "/graphql")
      return {
        data: {
          repository: {
            b0: {
              nodes: [
                {
                  number: 99,
                  title: "fork",
                  url: "https://github.com/fork/repo/pull/99",
                  state: "OPEN",
                  headRepository: { nameWithOwner: "fork/repo" },
                },
              ],
              pageInfo: { hasNextPage: true },
            },
          },
        },
      };
    return [
      {
        number: 4,
        title: "ours",
        html_url: "https://github.com/acme/repo/pull/4",
        state: "closed",
        merged_at: "2026-09-01T00:00:00Z",
        head: { ref: "feature", repo: { full_name: "acme/repo" } },
      },
    ];
  });

  const [status] = await githubProvider(ref, config).branchStatuses!([
    { branch: "feature", headSha: null },
  ]);

  assert.deepEqual(
    calls.map((call) => call.path),
    ["/graphql", "/repos/acme/repo/pulls"],
  );
  assert.deepEqual(status, {
    pr: {
      number: 4,
      url: "https://github.com/acme/repo/pull/4",
      title: "ours",
      state: "merged",
    },
    ci: null,
    review: null,
  });
});

test("a branch answer without a node list is unknown, not empty", async () => {
  stubFetch(() => ({ data: { repository: { b0: {} } } }));
  await assert.rejects(
    githubProvider(ref, config).branchStatuses!([
      { branch: "feature", headSha: null },
    ]),
    /without a node list/,
  );
});

test("an open list without a node list is unknown, not empty", async () => {
  stubFetch(() => ({
    data: { viewer: { login: "me" }, repository: { pullRequests: null } },
  }));
  await assert.rejects(
    githubProvider(ref, config).listOpenPullRequests(),
    /without a node list/,
  );
});

test("an errors entry without a message still fails the query", async () => {
  stubFetch(() => ({ data: { repository: {} }, errors: [{}] }));
  await assert.rejects(
    githubProvider(ref, config).branchStatuses!([
      { branch: "feature", headSha: null },
    ]),
    /unspecified error/,
  );
});

test("review requests beyond the first page are settled by the paged REST list", async () => {
  const answer = openListAnswer();
  const theirs = answer.data.repository.pullRequests.nodes[1]!;
  theirs.reviewRequests = {
    totalCount: 150,
    nodes: [{ requestedReviewer: { login: "someone-else" } }],
  } as typeof theirs.reviewRequests;
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    const body =
      url.pathname === "/graphql"
        ? answer
        : url.searchParams.get("page") === "1"
          ? {
              // A full first page without the viewer; the viewer is on page 2.
              users: Array.from({ length: 100 }, (_, i) => ({
                login: `user-${i}`,
              })),
            }
          : { users: [{ login: "me" }] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  try {
    const pulls = await githubProvider(ref, config).listOpenPullRequests();

    assert.deepEqual(calls, [
      "/graphql",
      "/repos/acme/repo/pulls/8/requested_reviewers?per_page=100&page=1",
      "/repos/acme/repo/pulls/8/requested_reviewers?per_page=100&page=2",
    ]);
    assert.equal(
      pulls?.find((pull) => pull.number === 8)?.reviewRequested,
      true,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("a branch page without page information is unknown", async () => {
  stubFetch(() => ({
    data: {
      repository: {
        b0: {
          nodes: [
            {
              number: 3,
              title: "ours",
              url: "https://github.com/acme/repo/pull/3",
              state: "OPEN",
              headRepository: { nameWithOwner: "acme/repo" },
            },
          ],
        },
      },
    },
  }));
  await assert.rejects(
    githubProvider(ref, config).branchStatuses!([
      { branch: "feature", headSha: null },
    ]),
    /without page information/,
  );
});
