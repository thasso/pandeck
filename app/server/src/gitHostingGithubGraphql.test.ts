/**
 * GitHub's batched GraphQL reads behind the background loops: one query per
 * repository answers what used to be per-row REST reads, with the same rules —
 * forks never claim a branch, an open pull request wins over a newer merged
 * one, check runs and legacy statuses fold into one CI answer, and the open
 * list's annotations are dropped by every write so a merge is never re-offered.
 */
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { GithubApiConfig } from "./githubClient.ts";
import { getGithubToolConfig } from "./githubSettings.ts";
vi.mock("./githubSettings.ts", async (importActual) => ({
  ...(await importActual<typeof import("./githubSettings.ts")>()),
  getGithubToolConfig: vi.fn(),
}));
import {
  hostingProviderFor,
  type RemoteRepoRef,
  resetGithubOpenPullAnnotationsForTests,
} from "./gitHosting.ts";

function githubProvider(
  ref: RemoteRepoRef,
  config: GithubApiConfig,
  signal?: AbortSignal,
) {
  vi.mocked(getGithubToolConfig).mockReturnValue(config);
  return hostingProviderFor(
    { service: "github", owner: ref.owner, repo: ref.repo },
    signal,
  );
}

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
      // Raw: the hosting projection sets review gates aside, not the batch.
      ci: {
        state: "failure",
        url: "https://ci.example/2",
        total: 2,
        failedApps: [null],
        besideFailures: {
          state: "success",
          url: "https://github.com/acme/repo/runs/1",
        },
      },
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

test("the batch names the apps behind failed checks and change requests", async () => {
  const calls = stubFetch(() => ({
    data: {
      repository: {
        b0: {
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              number: 19,
              title: "open",
              url: "https://github.com/acme/repo/pull/19",
              state: "OPEN",
              headRepository: { nameWithOwner: "acme/repo" },
              latestOpinionatedReviews: {
                nodes: [
                  {
                    state: "CHANGES_REQUESTED",
                    submittedAt: "2026-10-12T18:05:23Z",
                    author: { __typename: "Bot", login: "cl-percy" },
                  },
                  {
                    state: "CHANGES_REQUESTED",
                    submittedAt: "2026-10-12T18:06:00Z",
                    // A PERSON is never an app, whatever the login says.
                    author: { __typename: "User", login: "github-actions" },
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
                  conclusion: "FAILURE",
                  url: "https://github.com/acme/repo/runs/1",
                  checkSuite: { app: { slug: "cl-percy" } },
                },
                {
                  __typename: "CheckRun",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                  url: "https://github.com/acme/repo/runs/2",
                  checkSuite: { app: { slug: "github-actions" } },
                },
              ],
            },
          },
        },
      },
    },
  }));
  const [status] = await githubProvider(ref, config).branchStatuses!([
    { branch: "feature", headSha: sha("e") },
  ]);
  assert.match(calls[0]!.body?.query ?? "", /checkSuite \{ app \{ slug \} \}/);
  assert.match(calls[0]!.body?.query ?? "", /author \{ __typename login \}/);
  assert.deepEqual(status!.review, {
    changesRequested: true,
    changesRequestedByApps: ["cl-percy"],
  });
  assert.deepEqual(status!.ci?.failedApps, ["cl-percy"]);
  assert.deepEqual(status!.ci?.besideFailures, {
    state: "success",
    url: "https://github.com/acme/repo/runs/2",
  });
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

  // One query for the list; the viewer's teams are one REST read, cached
  // across repositories (here it answers no list, so membership is unknown).
  assert.deepEqual(
    calls.map((call) => call.path),
    ["/graphql", "/user/teams"],
  );
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
    if (url.pathname !== "/user/teams")
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

test("the open list marks your assignments and your teams' review requests", async () => {
  stubFetch((request) =>
    request.path === "/user/teams"
      ? [
          { slug: "core", organization: { login: "acme" } },
          { slug: "web", organization: { login: "other" } },
        ]
      : {
          data: {
            viewer: { login: "me" },
            repository: {
              pullRequests: {
                nodes: [
                  {
                    number: 9,
                    title: "for the team",
                    url: "https://github.com/acme/repo/pull/9",
                    headRefName: "team",
                    headRefOid: sha("d"),
                    baseRefName: "main",
                    author: { login: "someone" },
                    assignees: { nodes: [{ login: "me" }] },
                    reviewRequests: {
                      nodes: [
                        {
                          requestedReviewer: {
                            __typename: "Team",
                            slug: "core",
                            combinedSlug: "acme/core",
                          },
                        },
                        {
                          // Same slug, another organization: not yours.
                          requestedReviewer: {
                            __typename: "Team",
                            slug: "web",
                            combinedSlug: "acme/web",
                          },
                        },
                      ],
                    },
                    latestOpinionatedReviews: { nodes: [] },
                    commits: { nodes: [] },
                  },
                ],
              },
            },
          },
        },
  );

  const pull = (await githubProvider(ref, config).listOpenPullRequests())?.[0];

  assert.equal(pull?.mine, false);
  assert.equal(pull?.assignedToMe, true);
  assert.deepEqual(pull?.teamReviewRequests, ["core"]);
});

test("unknown team membership leaves team requests unknown, not empty", async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (new URL(String(input)).pathname === "/user/teams")
      return new Response("{}", { status: 403 });
    return new Response(JSON.stringify(openListAnswer()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const pulls = await githubProvider(ref, config).listOpenPullRequests();

  for (const pull of pulls ?? [])
    assert.equal("teamReviewRequests" in pull, false);
});

test("the conversation reads comments, verdicts and threads in one query", async () => {
  const calls = stubFetch(() => ({
    data: {
      repository: {
        pullRequest: {
          body: "The description",
          createdAt: "2026-09-01T00:00:00Z",
          headRefOid: sha("a"),
          author: { login: "author" },
          assignees: { nodes: [{ login: "me" }] },
          reviewRequests: {
            nodes: [
              { requestedReviewer: { __typename: "User", login: "ada" } },
              { requestedReviewer: { __typename: "Team", slug: "core" } },
            ],
          },
          comments: {
            totalCount: 1,
            nodes: [
              {
                databaseId: 1,
                author: { login: "ada" },
                body: "Looks close",
                createdAt: "2026-09-02T00:00:00Z",
                url: "https://github.com/acme/repo/pull/7#issuecomment-1",
              },
            ],
          },
          reviews: {
            totalCount: 3,
            nodes: [
              {
                databaseId: 2,
                author: { login: "bob" },
                state: "CHANGES_REQUESTED",
                body: "",
                submittedAt: "2026-09-01T12:00:00Z",
                comments: { totalCount: 1 },
              },
              {
                // Only the envelope of an inline reply: the thread shows it.
                databaseId: 3,
                author: { login: "bob" },
                state: "COMMENTED",
                body: "",
                submittedAt: "2026-09-03T00:00:00Z",
              },
              {
                databaseId: 4,
                author: { login: "bob" },
                state: "PENDING",
                body: "draft",
              },
            ],
          },
          reviewThreads: {
            totalCount: 1,
            nodes: [
              {
                id: "T1",
                isResolved: false,
                isOutdated: true,
                path: "src/a.ts",
                line: null,
                originalLine: 12,
                comments: {
                  totalCount: 1,
                  nodes: [
                    {
                      databaseId: 5,
                      author: { login: "bob" },
                      body: "Why?",
                      createdAt: "2026-09-01T12:00:00Z",
                      url: "https://github.com/acme/repo/pull/7#discussion_r5",
                      diffHunk: "@@ -1 +1 @@\n-a\n+b",
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  }));

  const conversation = await githubProvider(
    ref,
    config,
  ).pullRequestConversation(7);

  assert.equal(calls.length, 1);
  assert.equal(conversation.body, "The description");
  assert.equal(conversation.headSha, sha("a"));
  assert.deepEqual(conversation.assignees, ["me"]);
  assert.deepEqual(conversation.requestedReviewers, {
    users: ["ada"],
    teams: ["core"],
  });
  // Oldest first; the empty "commented" envelope and the pending draft are out.
  assert.deepEqual(
    conversation.timeline?.map((entry) => [
      entry.kind,
      entry.author,
      entry.kind === "review" ? entry.verdict : undefined,
    ]),
    [
      ["review", "bob", "changes-requested"],
      ["comment", "ada", undefined],
    ],
  );
  assert.deepEqual(conversation.threads, [
    {
      id: "T1",
      path: "src/a.ts",
      line: 12,
      resolved: false,
      outdated: true,
      diffHunk: "@@ -1 +1 @@\n-a\n+b",
      url: "https://github.com/acme/repo/pull/7#discussion_r5",
      comments: [
        {
          id: "5",
          author: "bob",
          body: "Why?",
          createdAt: Date.parse("2026-09-01T12:00:00Z"),
          url: "https://github.com/acme/repo/pull/7#discussion_r5",
        },
      ],
    },
  ]);
});
