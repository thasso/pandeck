import { afterEach, describe, expect, test, vi } from "vitest";
import type { GithubApiConfig } from "../../githubClient.ts";
import type { ToolCallContext } from "../../mcp/tool.ts";
import { listSessionAttachments } from "../../sessionAttachments.ts";
import { updateSettings } from "../../settings.ts";

// Override only the settings accessors; keep the client and tools real.
vi.mock("../../githubSettings.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../githubSettings.ts")>()),
  getGithubToolConfig: vi.fn(),
  getGithubDefaultOwner: vi.fn(),
}));

const { getGithubToolConfig, getGithubDefaultOwner } =
  await import("../../githubSettings.ts");
const {
  githubListNotificationsTool,
  githubSearchIssuesTool,
  githubGetIssueTool,
  githubOrgActivityTool,
  githubListRepositoriesTool,
  githubSearchRepositoriesTool,
  githubSearchCodeTool,
  githubGetContentTool,
  githubGetPullRequestTool,
  githubWatchPullRequestChecksTool,
  githubGetRefChecksTool,
  githubListActionsRunsTool,
  githubGetActionsRunTool,
} = await import("./githubTools.ts");

const ctxFor = (sessionId: string): ToolCallContext => ({
  toolCallId: "call",
  session: { sessionId, harness: "pi", agentType: "assistant" },
  signal: new AbortController().signal,
});

const originalFetch = globalThis.fetch;
const config: GithubApiConfig = {
  token: "ghp_test",
  apiBaseUrl: "https://api.github.com",
};

function jsonResponse(
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), { status: 200, headers });
}

function errorResponse(status: number, message = "nope"): Response {
  return new Response(JSON.stringify({ message }), { status });
}

function parse(result: Awaited<ReturnType<typeof githubGetIssueTool.execute>>) {
  return JSON.parse(
    result.content[0]!.type === "text" ? result.content[0]!.text : "{}",
  );
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

describe("github_list_notifications", () => {
  test("returns compact rows with a derived web subject URL", async () => {
    vi.mocked(getGithubToolConfig).mockReturnValue(config);
    globalThis.fetch = vi.fn(async () =>
      jsonResponse([
        {
          id: "1",
          unread: true,
          reason: "review_requested",
          updated_at: "2026-07-13T10:00:00Z",
          repository: {
            full_name: "acme/app",
            html_url: "https://github.com/acme/app",
          },
          subject: {
            type: "PullRequest",
            title: "Add widget",
            url: "https://api.github.com/repos/acme/app/pulls/42",
          },
        },
      ]),
    ) as unknown as typeof fetch;

    const result = await githubListNotificationsTool.execute(
      {} as never,
      {} as never,
    );
    const payload = parse(result);
    expect(payload.returned).toBe(1);
    const n = payload.notifications[0];
    expect(n.repo).toBe("acme/app");
    expect(n.subjectUrl).toBe("https://github.com/acme/app/pull/42");
  });
});

describe("github_search_issues", () => {
  test("maps items to compact rows and requires a query", async () => {
    vi.mocked(getGithubToolConfig).mockReturnValue(config);
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        total_count: 1,
        incomplete_results: false,
        items: [
          {
            number: 7,
            title: "Bug",
            state: "open",
            pull_request: undefined,
            repository_url: "https://api.github.com/repos/acme/app",
            html_url: "https://github.com/acme/app/issues/7",
            user: { login: "octocat" },
            labels: [{ name: "bug" }, "urgent"],
            comments: 3,
          },
        ],
      }),
    ) as unknown as typeof fetch;

    const result = await githubSearchIssuesTool.execute(
      { q: "org:acme is:issue" } as never,
      {} as never,
    );
    const payload = parse(result);
    expect(payload.totalCount).toBe(1);
    const item = payload.items[0];
    expect(item.repo).toBe("acme/app");
    expect(item.isPullRequest).toBe(false);
    expect(item.author).toBe("octocat");
    expect(item.labels).toEqual(["bug", "urgent"]);

    await expect(
      githubSearchIssuesTool.execute({ q: "  " } as never, {} as never),
    ).rejects.toThrow(/non-empty/);
  });
});

describe("github_get_issue", () => {
  test("resolves a bare repo against the default owner and flags a PR", async () => {
    vi.mocked(getGithubToolConfig).mockReturnValue(config);
    vi.mocked(getGithubDefaultOwner).mockReturnValue("acme");
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      expect(url).toContain("/repos/acme/app/issues/42");
      return jsonResponse({
        number: 42,
        title: "Add widget",
        state: "open",
        pull_request: {
          url: "https://api.github.com/repos/acme/app/pulls/42",
        },
        html_url: "https://github.com/acme/app/pull/42",
        user: { login: "octocat" },
        body: "Body text",
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await githubGetIssueTool.execute(
      { repo: "app", number: 42 } as never,
      {} as never,
    );
    const payload = parse(result);
    expect(payload.repo).toBe("acme/app");
    expect(payload.issue.isPullRequest).toBe(true);
    expect(payload.issue.body).toBe("Body text");
  });

  test("throws when no owner can be resolved", async () => {
    vi.mocked(getGithubToolConfig).mockReturnValue(config);
    vi.mocked(getGithubDefaultOwner).mockReturnValue("");
    await expect(
      githubGetIssueTool.execute(
        { repo: "app", number: 1 } as never,
        {} as never,
      ),
    ).rejects.toThrow(/owner\/repo/);
  });
});

describe("github_org_activity", () => {
  const dayEvents = [
    {
      id: "3",
      type: "PullRequestEvent",
      actor: { login: "alice" },
      repo: { name: "acme/app" },
      created_at: "2026-07-13T09:00:00Z",
      payload: {
        action: "closed",
        number: 5,
        pull_request: {
          number: 5,
          title: "Feature",
          html_url: "https://github.com/acme/app/pull/5",
          merged: true,
        },
      },
    },
    {
      id: "2",
      type: "PushEvent",
      actor: { login: "bob" },
      repo: { name: "acme/app" },
      created_at: "2026-07-13T08:00:00Z",
      payload: { ref: "refs/heads/main", size: 3 },
    },
    {
      id: "1",
      type: "IssuesEvent",
      actor: { login: "alice" },
      repo: { name: "acme/lib" },
      created_at: "2026-07-12T20:00:00Z",
      payload: {
        action: "opened",
        issue: {
          number: 9,
          title: "Old bug",
          html_url: "https://github.com/acme/lib/issues/9",
        },
      },
    },
  ];

  test("uses the user org dashboard endpoint and aggregates within the Berlin day", async () => {
    vi.mocked(getGithubToolConfig).mockReturnValue(config);
    let dashboardHit = false;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/user")) return jsonResponse({ login: "alice" });
      if (url.includes("/users/alice/events/orgs/acme")) {
        dashboardHit = true;
        return jsonResponse(dayEvents);
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    // The day window is the profile zone's; pin it so the host zone is irrelevant.
    updateSettings({
      profile: {
        displayName: "",
        timeZone: "Europe/Berlin",
        effectiveTimeZone: "",
      },
    });
    const result = await githubOrgActivityTool.execute(
      { org: "acme", date: "2026-07-13" } as never,
      {} as never,
    );
    const payload = parse(result);

    expect(dashboardHit).toBe(true);
    expect(payload.source).toBe("user-dashboard");
    expect(payload.timeZone).toBe("Europe/Berlin");
    // The 2026-07-12T20:00Z event is before the Berlin-day window (00:00 CEST = 22:00Z prev day) and stops the scan.
    expect(payload.eventsInWindow).toBe(2);
    expect(payload.byType.PushEvent).toBe(1);
    expect(payload.byType.IssuesEvent).toBeUndefined();
    expect(payload.exhausted).toBe(true);

    const app = payload.repos.find(
      (r: { repo: string }) => r.repo === "acme/app",
    );
    expect(app.prsMerged).toBe(1);
    expect(app.commits).toBe(3);
    expect(app.actors.sort()).toEqual(["alice", "bob"]);
    expect(
      payload.repos.some((r: { repo: string }) => r.repo === "acme/lib"),
    ).toBe(false);
  });

  test("falls back to the public org feed when the user is not a member", async () => {
    vi.mocked(getGithubToolConfig).mockReturnValue(config);
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/user")) return jsonResponse({ login: "alice" });
      if (url.includes("/users/alice/events/orgs/other"))
        return errorResponse(404);
      if (url.includes("/orgs/other/events")) return jsonResponse([]);
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const result = await githubOrgActivityTool.execute(
      { org: "other", date: "2026-07-13" } as never,
      {} as never,
    );
    const payload = parse(result);
    expect(payload.source).toBe("public-org");
    expect(
      payload.notes.some((n: string) => /PUBLIC events feed/.test(n)),
    ).toBe(true);
  });

  test("falls back to the default owner when org is omitted", async () => {
    vi.mocked(getGithubToolConfig).mockReturnValue(config);
    vi.mocked(getGithubDefaultOwner).mockReturnValue("acme");
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/user")) return jsonResponse({ login: "alice" });
      if (url.includes("/users/alice/events/orgs/acme"))
        return jsonResponse([]);
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;
    const result = await githubOrgActivityTool.execute(
      { date: "2026-07-13" } as never,
      {} as never,
    );
    expect(parse(result).org).toBe("acme");
  });
});

const privateRepo = {
  full_name: "acme/player-docs",
  owner: { login: "acme" },
  private: true,
  visibility: "private",
  fork: false,
  archived: false,
  description: "Web Player documentation",
  html_url: "https://github.com/acme/player-docs",
  default_branch: "main",
  language: "MDX",
  topics: ["docs", "player"],
  permissions: {
    admin: false,
    maintain: false,
    push: true,
    triage: true,
    pull: true,
  },
  pushed_at: "2026-07-20T10:00:00Z",
  updated_at: "2026-07-21T10:00:00Z",
  ssh_url: "git@github.com:acme/player-docs.git",
  clone_url: "https://github.com/acme/player-docs.git",
};

describe("github_list_repositories", () => {
  test("forwards the private-inclusive affiliation default and normalizes metadata", async () => {
    vi.mocked(getGithubToolConfig).mockReturnValue(config);
    let requestedUrl = "";
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return jsonResponse([privateRepo]);
    }) as unknown as typeof fetch;

    const result = await githubListRepositoriesTool.execute(
      {} as never,
      {} as never,
    );
    const payload = parse(result);

    expect(requestedUrl).toContain("/user/repos");
    expect(requestedUrl).toContain(
      "affiliation=owner%2Ccollaborator%2Corganization_member",
    );
    expect(payload.source).toBe("user");
    expect(payload.exhausted).toBe(true);
    const repo = payload.repositories[0];
    expect(repo.fullName).toBe("acme/player-docs");
    expect(repo.private).toBe(true);
    expect(repo.owner).toBe("acme");
    expect(repo.permission).toBe("push");
    expect(repo.sshUrl).toBe("git@github.com:acme/player-docs.git");
    expect(repo.cloneUrl).toBe("https://github.com/acme/player-docs.git");
    expect(repo.topics).toEqual(["docs", "player"]);
  });

  test("uses the org endpoint and surfaces a bounded (non-exhausted) result", async () => {
    vi.mocked(getGithubToolConfig).mockReturnValue(config);
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      // First page reports a rel="next" link; the maxResults cap stops paging.
      return jsonResponse(
        [privateRepo, { ...privateRepo, full_name: "acme/second" }],
        {
          link: '<https://api.github.com/organizations/1/repos?page=2>; rel="next"',
        },
      );
    }) as unknown as typeof fetch;

    const result = await githubListRepositoriesTool.execute(
      { org: "acme", maxResults: 2 } as never,
      {} as never,
    );
    const payload = parse(result);

    expect(urls[0]).toContain("/orgs/acme/repos");
    expect(payload.source).toBe("org:acme");
    expect(payload.returned).toBe(2);
    expect(payload.exhausted).toBe(false);
  });
});

describe("github_search_repositories", () => {
  test("returns compact matches with totalCount and incompleteResults", async () => {
    vi.mocked(getGithubToolConfig).mockReturnValue(config);
    let requestedUrl = "";
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return jsonResponse({
        total_count: 42,
        incomplete_results: true,
        items: [privateRepo],
      });
    }) as unknown as typeof fetch;

    const result = await githubSearchRepositoriesTool.execute(
      { q: "org:acme web-player in:name,readme" } as never,
      {} as never,
    );
    const payload = parse(result);

    expect(requestedUrl).toContain("/search/repositories");
    expect(payload.totalCount).toBe(42);
    expect(payload.incompleteResults).toBe(true);
    expect(payload.items[0].fullName).toBe("acme/player-docs");

    await expect(
      githubSearchRepositoriesTool.execute({ q: "  " } as never, {} as never),
    ).rejects.toThrow(/non-empty/);
  });
});

describe("github_search_code", () => {
  test("requests text-match metadata and extracts bounded fragments", async () => {
    vi.mocked(getGithubToolConfig).mockReturnValue(config);
    let acceptHeader = "";
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        acceptHeader = String(
          (init?.headers as Record<string, string>)?.Accept ?? "",
        );
        expect(String(input)).toContain("/search/code");
        return jsonResponse({
          total_count: 5,
          incomplete_results: true,
          items: [
            {
              path: "src/player.ts",
              sha: "abc",
              html_url: "https://github.com/acme/app/blob/main/src/player.ts",
              repository: { full_name: "acme/app" },
              text_matches: [
                {
                  fragment: "export function createPlayer() {}",
                  matches: [{ text: "createPlayer" }],
                },
              ],
            },
          ],
        });
      },
    ) as unknown as typeof fetch;

    const result = await githubSearchCodeTool.execute(
      { q: "repo:acme/app createPlayer" } as never,
      ctxFor("code-search"),
    );
    const payload = parse(result);
    expect(acceptHeader).toContain("text-match");
    expect(payload.totalCount).toBe(5);
    expect(payload.incompleteResults).toBe(true);
    const item = payload.items[0];
    expect(item.repo).toBe("acme/app");
    expect(item.textMatches[0].matches).toEqual(["createPlayer"]);

    await expect(
      githubSearchCodeTool.execute({ q: "  " } as never, ctxFor("code-search")),
    ).rejects.toThrow(/non-empty/);
  });
});

describe("github_get_content", () => {
  test("lists a directory with compact bounded entries", async () => {
    vi.mocked(getGithubToolConfig).mockReturnValue(config);
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain("/repos/acme/app/contents/src");
      return jsonResponse([
        {
          name: "player.ts",
          path: "src/player.ts",
          type: "file",
          size: 120,
          sha: "a",
          html_url: "https://github.com/acme/app/blob/main/src/player.ts",
        },
        {
          name: "lib",
          path: "src/lib",
          type: "dir",
          sha: "b",
          html_url: "https://github.com/acme/app/tree/main/src/lib",
        },
      ]);
    }) as unknown as typeof fetch;

    const result = await githubGetContentTool.execute(
      { repo: "acme/app", path: "src" } as never,
      ctxFor("get-dir"),
    );
    const payload = parse(result);
    expect(payload.type).toBe("dir");
    expect(payload.returned).toBe(2);
    expect(payload.entries[0].size).toBe(120);
    expect(payload.entries[1].type).toBe("dir");
  });

  test("decodes bounded UTF-8 text and flags truncation", async () => {
    vi.mocked(getGithubToolConfig).mockReturnValue(config);
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        type: "file",
        path: "README.md",
        size: 11,
        sha: "c",
        html_url: "https://github.com/acme/app/blob/main/README.md",
        encoding: "base64",
        content: Buffer.from("hello world").toString("base64"),
      }),
    ) as unknown as typeof fetch;

    const result = await githubGetContentTool.execute(
      { repo: "acme/app", path: "README.md", maxChars: 5 } as never,
      ctxFor("get-text"),
    );
    const payload = parse(result);
    expect(payload.status).toBe("content");
    expect(payload.content).toBe("hello");
    expect(payload.contentTruncated).toBe(true);
  });

  test("stages binary content as a session attachment (bytes off-context)", async () => {
    vi.mocked(getGithubToolConfig).mockReturnValue(config);
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]); // NUL byte -> binary
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        type: "file",
        path: "logo.png",
        size: binary.byteLength,
        sha: "d",
        html_url: "https://github.com/acme/app/blob/main/logo.png",
        encoding: "base64",
        content: binary.toString("base64"),
      }),
    ) as unknown as typeof fetch;

    const result = await githubGetContentTool.execute(
      { repo: "acme/app", path: "logo.png" } as never,
      ctxFor("get-binary"),
    );
    const payload = parse(result);
    expect(payload.status).toBe("saved_attachment");
    expect(payload.content).toBeUndefined();
    const staged = listSessionAttachments("get-binary").find(
      (a) => a.id === payload.attachment.id,
    );
    expect(staged?.source).toBe("agent");
  });

  test("refuses a file above the download cap without fetching bytes", async () => {
    vi.mocked(getGithubToolConfig).mockReturnValue(config);
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        type: "file",
        path: "big.bin",
        size: 5_000_000,
        sha: "e",
        html_url: "https://github.com/acme/app/blob/main/big.bin",
        // No inline content or download_url is consulted: the size gate returns first.
      }),
    ) as unknown as typeof fetch;

    const result = await githubGetContentTool.execute(
      {
        repo: "acme/app",
        path: "big.bin",
        maxDownloadBytes: 1024,
      } as never,
      ctxFor("get-big"),
    );
    const payload = parse(result);
    expect(payload.status).toBe("too_large");
  });

  test("throws when no owner can be resolved", async () => {
    vi.mocked(getGithubToolConfig).mockReturnValue(config);
    vi.mocked(getGithubDefaultOwner).mockReturnValue("");
    await expect(
      githubGetContentTool.execute(
        { repo: "app", path: "x" } as never,
        ctxFor("get-noowner"),
      ),
    ).rejects.toThrow(/owner\/repo/);
  });
});

describe("github_get_pull_request", () => {
  test("returns head/base SHAs and reviewers, and groups inline threads on demand", async () => {
    vi.mocked(getGithubToolConfig).mockReturnValue(config);
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (/\/pulls\/42\/commits/.test(url))
        return jsonResponse([
          {
            sha: "abcdef1234567890",
            commit: { message: "Fix bug\n\ndetail" },
            author: { login: "alice" },
          },
        ]);
      if (/\/pulls\/42\/files/.test(url))
        return jsonResponse([
          {
            filename: "src/a.ts",
            status: "modified",
            additions: 3,
            deletions: 1,
            patch: "@@ -1 +1 @@\n-a\n+b",
          },
        ]);
      if (/\/pulls\/42\/reviews/.test(url))
        return jsonResponse([
          {
            user: { login: "bob" },
            state: "APPROVED",
            body: "LGTM",
            submitted_at: "2026-07-20T10:00:00Z",
          },
          { user: { login: "c" }, state: "PENDING" },
        ]);
      if (/\/pulls\/42\/comments/.test(url))
        return jsonResponse([
          {
            id: 1,
            user: { login: "bob" },
            path: "src/a.ts",
            line: 5,
            diff_hunk: "@@",
            body: "nit",
            created_at: "2026-07-20T10:00:00Z",
            html_url: "https://github.com/acme/app/pull/42#c1",
          },
          {
            id: 2,
            in_reply_to_id: 1,
            user: { login: "alice" },
            body: "fixed",
            created_at: "2026-07-20T11:00:00Z",
          },
        ]);
      if (/\/pulls\/42$/.test(url))
        return jsonResponse({
          number: 42,
          title: "Add widget",
          state: "open",
          draft: false,
          merged: false,
          html_url: "https://github.com/acme/app/pull/42",
          user: { login: "alice" },
          head: {
            ref: "feature",
            sha: "headsha",
            repo: { full_name: "acme/app" },
          },
          base: {
            ref: "main",
            sha: "basesha",
            repo: { full_name: "acme/app" },
          },
          requested_reviewers: [{ login: "bob" }],
          additions: 3,
          deletions: 1,
          changed_files: 1,
          commits: 1,
          body: "Body",
        });
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const result = await githubGetPullRequestTool.execute(
      {
        repo: "acme/app",
        number: 42,
        includeCommits: true,
        includeFiles: true,
        includePatch: true,
        includeReviews: true,
        includeReviewThreads: true,
      } as never,
      ctxFor("get-pr"),
    );
    const payload = parse(result);
    const pr = payload.pullRequest;

    expect(pr.head.sha).toBe("headsha");
    expect(pr.base.ref).toBe("main");
    expect(pr.requestedReviewers).toEqual(["bob"]);
    expect(pr.commits[0].sha).toBe("abcdef123456");
    expect(pr.commits[0].message).toBe("Fix bug");
    expect(pr.files[0].patch).toContain("+b");
    // PENDING reviews are filtered out.
    expect(pr.reviews).toHaveLength(1);
    expect(pr.reviews[0].state).toBe("APPROVED");
    // The reply is grouped under its root comment's file thread.
    expect(pr.reviewThreads).toHaveLength(1);
    expect(pr.reviewThreads[0].path).toBe("src/a.ts");
    expect(pr.reviewThreads[0].comments).toHaveLength(2);
  });
});

describe("github_watch_pull_request_checks", () => {
  test("returns failed-check log links and a conservative merge preflight", async () => {
    vi.mocked(getGithubToolConfig).mockReturnValue(config);
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/pulls/42/reviews")) return jsonResponse([]);
      if (url.endsWith("/pulls/42"))
        return jsonResponse({
          number: 42,
          state: "open",
          draft: false,
          mergeable: true,
          head: { ref: "feature", sha: "abc123" },
          base: { ref: "main" },
        });
      if (url.includes("/check-runs"))
        return jsonResponse({
          check_runs: [
            {
              id: 91,
              name: "test",
              status: "completed",
              conclusion: "failure",
              html_url: "https://github.com/acme/app/actions/runs/7/job/91",
              app: { name: "GitHub Actions", slug: "github-actions" },
              output: { summary: "tests failed" },
            },
          ],
        });
      if (url.includes("/status?")) return jsonResponse({ statuses: [] });
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const payload = parse(
      await githubWatchPullRequestChecksTool.execute(
        { repo: "acme/app", number: 42 },
        ctxFor("pr-checks"),
      ),
    );
    expect(payload.checks.state).toBe("failure");
    expect(payload.checks.finished).toBe(true);
    expect(payload.checks.failedChecks[0].logUrl).toBe(
      "https://api.github.com/repos/acme/app/actions/jobs/91/logs",
    );
    expect(payload.checks.failedChecks[0].jobId).toBe(91);
    expect(payload.checks.failedChecks[0].logReader).toEqual({
      tool: "github_get_actions_job_log",
      arguments: { repo: "acme/app", jobId: 91 },
    });
    expect(payload.checks.failureLinks).toEqual([
      "https://api.github.com/repos/acme/app/actions/jobs/91/logs",
      "https://github.com/acme/app/actions/runs/7/job/91",
    ]);
    expect(payload.canMergeNow).toBe(false);
    expect(payload.mergeBlockers).toContain("checks_failed");
    expect(payload.observation.stopReason).toBe("current_status");
  });

  test("stops a wait immediately when the bounded check page is truncated", async () => {
    vi.mocked(getGithubToolConfig).mockReturnValue(config);
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/pulls/42/reviews")) return jsonResponse([]);
      if (url.endsWith("/pulls/42"))
        return jsonResponse({
          number: 42,
          state: "open",
          draft: false,
          mergeable: true,
          head: { ref: "feature", sha: "abc123" },
          base: { ref: "main" },
        });
      if (url.includes("/check-runs"))
        return jsonResponse({
          total_count: 150,
          check_runs: [
            { name: "visible", status: "completed", conclusion: "success" },
          ],
        });
      if (url.includes("/status?"))
        return jsonResponse({ total_count: 0, statuses: [] });
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const payload = parse(
      await githubWatchPullRequestChecksTool.execute(
        { repo: "acme/app", number: 42, wait: true },
        ctxFor("pr-checks-truncated"),
      ),
    );
    expect(payload.checks.truncated).toBe(true);
    expect(payload.checks.finished).toBe(false);
    expect(payload.observation.stopReason).toBe("checks_truncated");
    expect(payload.observation.polls).toBe(1);
    expect(payload.mergeBlockers).toContain("checks_truncated");
    expect(payload.mergeBlockers).not.toContain("checks_pending");
  });

  test("waits for checks to appear and then for every check to finish", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(getGithubToolConfig).mockReturnValue(config);
      let checksPoll = 0;
      globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/pulls/42/reviews")) return jsonResponse([]);
        if (url.endsWith("/pulls/42"))
          return jsonResponse({
            number: 42,
            state: "open",
            draft: false,
            mergeable: true,
            head: { ref: "feature", sha: "abc123" },
            base: { ref: "main" },
          });
        if (url.includes("/check-runs")) {
          checksPoll += 1;
          if (checksPoll === 1) return jsonResponse({ check_runs: [] });
          return jsonResponse({
            check_runs: [
              {
                name: "lint",
                status: "completed",
                conclusion: "failure",
              },
              {
                name: "test",
                status: checksPoll === 2 ? "in_progress" : "completed",
                conclusion: checksPoll === 2 ? null : "success",
              },
            ],
          });
        }
        if (url.includes("/status?")) return jsonResponse({ statuses: [] });
        throw new Error(`unexpected url ${url}`);
      }) as unknown as typeof fetch;

      const resultPromise = githubWatchPullRequestChecksTool.execute(
        {
          repo: "acme/app",
          number: 42,
          wait: true,
          // Below GitHub's 30 s floor: the wait is clamped up to it.
          pollIntervalSeconds: 5,
        },
        ctxFor("pr-checks-wait"),
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(checksPoll).toBe(2);
      await vi.advanceTimersByTimeAsync(30_000);
      const payload = parse(await resultPromise);
      expect(checksPoll).toBe(3);
      expect(payload.checks.finished).toBe(true);
      expect(payload.observation.stopReason).toBe("checks_finished");
      expect(payload.observation.polls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("gives up on a head that shows no checks after the grace window", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(getGithubToolConfig).mockReturnValue(config);
      let checksPoll = 0;
      globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/pulls/42/reviews")) return jsonResponse([]);
        if (url.endsWith("/pulls/42"))
          return jsonResponse({
            number: 42,
            state: "open",
            draft: false,
            mergeable: true,
            head: { ref: "feature", sha: "abc123" },
            base: { ref: "main" },
          });
        if (url.includes("/check-runs")) {
          checksPoll += 1;
          return jsonResponse({ check_runs: [] });
        }
        if (url.includes("/status?")) return jsonResponse({ statuses: [] });
        throw new Error(`unexpected url ${url}`);
      }) as unknown as typeof fetch;

      const resultPromise = githubWatchPullRequestChecksTool.execute(
        { repo: "acme/app", number: 42, wait: true },
        ctxFor("pr-checks-none"),
      );
      await vi.advanceTimersByTimeAsync(120_000);
      const payload = parse(await resultPromise);
      expect(checksPoll).toBe(3);
      expect(payload.checks.state).toBe("none");
      expect(payload.observation.stopReason).toBe("no_checks");
      expect(payload.mergeBlockers).toContain("checks_not_found");
    } finally {
      vi.useRealTimers();
    }
  });

  test("stops a wait when the REST budget runs low", async () => {
    // Its own token: the client remembers the budget per token.
    vi.mocked(getGithubToolConfig).mockReturnValue({
      ...config,
      token: "ghp_low_budget",
    });
    const budget = {
      "x-ratelimit-remaining": "120",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1_000) + 600),
    };
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/pulls/42/reviews")) return jsonResponse([], budget);
      if (url.endsWith("/pulls/42"))
        return jsonResponse(
          {
            number: 42,
            state: "open",
            draft: false,
            mergeable: true,
            head: { ref: "feature", sha: "abc123" },
            base: { ref: "main" },
          },
          budget,
        );
      if (url.includes("/check-runs"))
        return jsonResponse(
          { check_runs: [{ name: "test", status: "in_progress" }] },
          budget,
        );
      if (url.includes("/status?"))
        return jsonResponse({ statuses: [] }, budget);
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const payload = parse(
      await githubWatchPullRequestChecksTool.execute(
        { repo: "acme/app", number: 42, wait: true },
        ctxFor("pr-checks-budget"),
      ),
    );
    expect(payload.observation.stopReason).toBe("rate_limited");
    expect(payload.observation.polls).toBe(1);
    expect(payload.observation.rateLimitRemaining).toBe(120);
    expect(payload.checks.finished).toBe(false);
  });
});

describe("github_get_ref_checks", () => {
  test("aggregates check-runs and commit statuses into an overall state", async () => {
    vi.mocked(getGithubToolConfig).mockReturnValue(config);
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (/\/check-runs/.test(url))
        return jsonResponse({
          check_runs: [
            {
              name: "build",
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/acme/app/runs/1",
              app: { name: "GitHub Actions" },
            },
            {
              name: "test",
              status: "completed",
              conclusion: "failure",
              html_url: "https://github.com/acme/app/runs/2",
              app: { name: "GitHub Actions" },
            },
          ],
        });
      if (/\/status\?/.test(url))
        return jsonResponse({
          state: "success",
          statuses: [
            { context: "legacy", state: "success", target_url: "https://ci/x" },
          ],
        });
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const result = await githubGetRefChecksTool.execute(
      { repo: "acme/app", ref: "main" } as never,
      ctxFor("checks"),
    );
    const payload = parse(result);
    expect(payload.state).toBe("failure");
    expect(payload.total).toBe(3);
    expect(payload.url).toContain("/runs/2");
  });
});

describe("github_list_actions_runs", () => {
  test("forwards filters and returns compact runs", async () => {
    vi.mocked(getGithubToolConfig).mockReturnValue(config);
    let requestedUrl = "";
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return jsonResponse({
        total_count: 1,
        workflow_runs: [
          {
            id: 100,
            name: "CI",
            head_branch: "feature",
            head_sha: "deadbeefcafebabe",
            event: "push",
            status: "completed",
            conclusion: "failure",
            run_number: 7,
            html_url: "https://github.com/acme/app/actions/runs/100",
            actor: { login: "alice" },
          },
        ],
      });
    }) as unknown as typeof fetch;

    const result = await githubListActionsRunsTool.execute(
      { repo: "acme/app", branch: "feature", status: "failure" } as never,
      ctxFor("runs"),
    );
    const payload = parse(result);
    expect(requestedUrl).toContain("/actions/runs");
    expect(requestedUrl).toContain("branch=feature");
    expect(requestedUrl).toContain("status=failure");
    expect(payload.runs[0].id).toBe(100);
    expect(payload.runs[0].headSha).toBe("deadbeefcafe");
    expect(payload.runs[0].conclusion).toBe("failure");
  });
});

describe("github_get_actions_run", () => {
  test("returns jobs/steps and fetches annotations only for failed jobs", async () => {
    vi.mocked(getGithubToolConfig).mockReturnValue(config);
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (/\/actions\/runs\/100\/jobs/.test(url))
        return jsonResponse({
          jobs: [
            {
              id: 9,
              name: "build",
              status: "completed",
              conclusion: "failure",
              steps: [
                {
                  name: "compile",
                  status: "completed",
                  conclusion: "failure",
                  number: 1,
                },
              ],
            },
          ],
        });
      if (/\/check-runs\/9\/annotations/.test(url))
        return jsonResponse([
          {
            path: "src/a.ts",
            start_line: 3,
            annotation_level: "failure",
            title: "tsc",
            message: "type error",
          },
        ]);
      if (/\/actions\/runs\/100$/.test(url))
        return jsonResponse({
          id: 100,
          name: "CI",
          head_branch: "feature",
          status: "completed",
          conclusion: "failure",
          html_url: "https://github.com/acme/app/actions/runs/100",
        });
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const result = await githubGetActionsRunTool.execute(
      { repo: "acme/app", runId: 100, includeAnnotations: true } as never,
      ctxFor("run"),
    );
    const payload = parse(result);
    expect(payload.run.jobs[0].conclusion).toBe("failure");
    expect(payload.run.jobs[0].steps[0].name).toBe("compile");
    expect(payload.run.jobs[0].annotations[0].message).toBe("type error");
    expect(urls.some((u) => /\/check-runs\/9\/annotations/.test(u))).toBe(true);
  });
});
