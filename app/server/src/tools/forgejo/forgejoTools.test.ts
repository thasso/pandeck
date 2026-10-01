import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ForgejoApiConfig } from "../../forgejoClient.ts";
import type { ToolCallContext } from "../../mcp/tool.ts";
import { listSessionAttachments } from "../../sessionAttachments.ts";

// Override only the settings accessors; keep the client and tools real.
vi.mock("../../forgejoSettings.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../forgejoSettings.ts")>()),
  getForgejoToolConfig: vi.fn(),
  getForgejoDefaultOwner: vi.fn(() => ""),
  getForgejoBaseUrl: vi.fn(() => ""),
}));

const { getForgejoToolConfig, getForgejoDefaultOwner, getForgejoBaseUrl } =
  await import("../../forgejoSettings.ts");
const {
  forgejoListRepositoriesTool,
  forgejoSearchRepositoriesTool,
  forgejoListNotificationsTool,
  forgejoSearchIssuesTool,
  forgejoGetIssueTool,
  forgejoGetPullRequestTool,
  forgejoGetContentTool,
  resolveForgejoRepo,
} = await import("./forgejoTools.ts");

const config: ForgejoApiConfig = {
  baseUrl: "https://git.example.com",
  token: "fj_test",
};
const originalFetch = globalThis.fetch;

const ctxFor = (sessionId: string): ToolCallContext => ({
  toolCallId: "call",
  session: { sessionId, harness: "pi", agentType: "assistant" },
  signal: new AbortController().signal,
});

function jsonResponse(
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), { status: 200, headers });
}

function parse(result: { content: Array<{ type: string; text?: string }> }) {
  const block = result.content[0]!;
  return JSON.parse(block.type === "text" ? (block.text ?? "{}") : "{}");
}

/** Every URL the tool requested, in order. */
function urlsFrom(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  vi.mocked(getForgejoToolConfig).mockReturnValue(config);
  vi.mocked(getForgejoDefaultOwner).mockReturnValue("");
  vi.mocked(getForgejoBaseUrl).mockReturnValue(config.baseUrl);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

describe("forgejo_list_repositories", () => {
  test("maps Gitea repository fields and reports the page total", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        [
          {
            full_name: "acme/app",
            owner: { login: "acme" },
            private: true,
            description: "The app",
            html_url: "https://git.example.com/acme/app",
            default_branch: "main",
            language: "TypeScript",
            topics: ["player", "web"],
            permissions: { admin: false, push: true, pull: true },
            ssh_url: "git@git.example.com:acme/app.git",
            clone_url: "https://git.example.com/acme/app.git",
            updated_at: "2026-07-01T10:00:00Z",
          },
        ],
        { "x-total-count": "12" },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await forgejoListRepositoriesTool.execute(
      {} as never,
      ctxFor("repos"),
    );
    const payload = parse(result);
    expect(urlsFrom(fetchMock)[0]).toContain(
      "https://git.example.com/api/v1/user/repos",
    );
    // "token", not "user": `user:<name>` now names a specific account.
    expect(payload.source).toBe("token");
    expect(payload.totalCount).toBe(12);
    expect(payload.exhausted).toBe(true);
    const repo = payload.repositories[0];
    expect(repo.fullName).toBe("acme/app");
    expect(repo.owner).toBe("acme");
    expect(repo.permission).toBe("push");
    expect(repo.topics).toEqual(["player", "web"]);
    expect(repo.sshUrl).toBe("git@git.example.com:acme/app.git");
  });

  test("an org reads the org endpoint instead", async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await forgejoListRepositoriesTool.execute(
      { org: "acme" } as never,
      ctxFor("repos-org"),
    );
    expect(urlsFrom(fetchMock)[0]).toContain("/api/v1/orgs/acme/repos");
    expect(parse(result).source).toBe("org:acme");
  });

  test("a personal account reads the user endpoint, which /orgs cannot serve", async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await forgejoListRepositoriesTool.execute(
      { user: "alice" } as never,
      ctxFor("repos-user"),
    );
    expect(urlsFrom(fetchMock)[0]).toContain("/api/v1/users/alice/repos");
    expect(parse(result).source).toBe("user:alice");

    await expect(
      forgejoListRepositoriesTool.execute(
        { org: "acme", user: "alice" } as never,
        ctxFor("repos-both"),
      ),
    ).rejects.toThrow(/either org or user/);
  });

  test("the token's own inventory asks for a token before spending a request", async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.mocked(getForgejoToolConfig).mockReturnValue({
      ...config,
      token: "",
    });
    await expect(
      forgejoListRepositoriesTool.execute(
        {} as never,
        ctxFor("repos-no-token"),
      ),
    ).rejects.toThrow(/Settings → Forgejo/);
    // An org or user listing still works anonymously against a public instance.
    await forgejoListRepositoriesTool.execute(
      { org: "acme" } as never,
      ctxFor("repos-no-token"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("forgejo_search_repositories", () => {
  test("unwraps the {ok,data} envelope and passes Gitea's parameter names", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { ok: true, data: [{ full_name: "acme/app" }] },
        { "x-total-count": "3" },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await forgejoSearchRepositoriesTool.execute(
      {
        q: "player",
        topic: true,
        includeDesc: true,
        mode: "source",
        maxResults: 5,
      } as never,
      ctxFor("repo-search"),
    );
    const url = new URL(urlsFrom(fetchMock)[0]!);
    expect(url.pathname).toBe("/api/v1/repos/search");
    expect(url.searchParams.get("q")).toBe("player");
    expect(url.searchParams.get("topic")).toBe("true");
    expect(url.searchParams.get("includeDesc")).toBe("true");
    expect(url.searchParams.get("mode")).toBe("source");
    expect(url.searchParams.get("limit")).toBe("5");
    const payload = parse(result);
    expect(payload.totalCount).toBe(3);
    expect(payload.exhausted).toBe(true);
    expect(payload.items[0].fullName).toBe("acme/app");

    await expect(
      forgejoSearchRepositoriesTool.execute(
        { q: "  " } as never,
        ctxFor("repo-search"),
      ),
    ).rejects.toThrow(/non-empty/);
  });

  test("pages past the per-page cap and reports a truncated result set", async () => {
    const full = Array.from({ length: 50 }, (_, i) => ({
      full_name: `acme/app-${i}`,
    }));
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: true, data: full }, { "x-total-count": "500" }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await forgejoSearchRepositoriesTool.execute(
      { q: "app", maxResults: 120 } as never,
      ctxFor("repo-search-pages"),
    );
    const pages = urlsFrom(fetchMock).map((u) =>
      new URL(u).searchParams.get("page"),
    );
    expect(pages).toEqual(["1", "2", "3"]);
    const payload = parse(result);
    expect(payload.returned).toBe(120);
    expect(payload.totalCount).toBe(500);
    // Never claim completeness while results are still waiting behind the cap.
    expect(payload.exhausted).toBe(false);
  });

  test("omits totalCount rather than fabricating one from the page size", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ ok: true, data: [{ full_name: "acme/app" }] }),
    ) as unknown as typeof fetch;
    const result = await forgejoSearchRepositoriesTool.execute(
      { q: "app" } as never,
      ctxFor("repo-search-no-total"),
    );
    const payload = parse(result);
    expect(payload.totalCount).toBeUndefined();
    expect(payload.returned).toBe(1);
  });
});

describe("forgejo_list_notifications", () => {
  test("repeats array filters as separate query params and derives a web URL", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse([
        {
          id: 4,
          unread: true,
          pinned: false,
          updated_at: "2026-07-13T10:00:00Z",
          repository: {
            full_name: "acme/app",
            html_url: "https://git.example.com/acme/app",
          },
          subject: {
            type: "Pull",
            title: "Add widget",
            state: "open",
            url: "https://git.example.com/api/v1/repos/acme/app/pulls/42",
          },
        },
      ]),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await forgejoListNotificationsTool.execute(
      {
        statusTypes: ["unread", "pinned"],
        subjectTypes: ["pull"],
      } as never,
      ctxFor("notifications"),
    );
    const url = new URL(urlsFrom(fetchMock)[0]!);
    expect(url.searchParams.getAll("status-types")).toEqual([
      "unread",
      "pinned",
    ]);
    expect(url.searchParams.getAll("subject-type")).toEqual(["pull"]);
    const n = parse(result).notifications[0];
    expect(n.repo).toBe("acme/app");
    expect(n.subjectUrl).toBe("https://git.example.com/acme/app/pulls/42");
  });

  test("prefers the subject's own html_url when the instance sends one", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse([
        {
          id: 5,
          unread: true,
          repository: { full_name: "acme/app" },
          subject: {
            type: "Issue",
            title: "Bug",
            html_url: "https://git.example.com/acme/app/issues/7",
            url: "https://git.example.com/api/v1/repos/acme/app/issues/7",
          },
        },
      ]),
    ) as unknown as typeof fetch;
    const result = await forgejoListNotificationsTool.execute(
      {} as never,
      ctxFor("notifications-html"),
    );
    expect(parse(result).notifications[0].subjectUrl).toBe(
      "https://git.example.com/acme/app/issues/7",
    );
  });
});

describe("forgejo_search_issues", () => {
  test("sends STRUCTURED filters to the instance-wide search, not a query string", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        [
          {
            number: 7,
            title: "Bug",
            state: "open",
            repository: { full_name: "acme/app" },
            html_url: "https://git.example.com/acme/app/issues/7",
            user: { login: "alice" },
            labels: [{ name: "bug" }],
            comments: 3,
          },
        ],
        { "x-total-count": "1" },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await forgejoSearchIssuesTool.execute(
      {
        owner: "acme",
        state: "all",
        type: "pulls",
        labels: ["bug", "urgent"],
        reviewRequested: true,
      } as never,
      ctxFor("issue-search"),
    );
    const url = new URL(urlsFrom(fetchMock)[0]!);
    expect(url.pathname).toBe("/api/v1/repos/issues/search");
    expect(url.searchParams.get("owner")).toBe("acme");
    expect(url.searchParams.get("state")).toBe("all");
    expect(url.searchParams.get("type")).toBe("pulls");
    expect(url.searchParams.get("labels")).toBe("bug,urgent");
    expect(url.searchParams.get("review_requested")).toBe("true");
    const payload = parse(result);
    expect(payload.scope).toBe("owner:acme");
    expect(payload.totalCount).toBe(1);
    expect(payload.items[0].labels).toEqual(["bug"]);
    expect(payload.items[0].author).toBe("alice");
  });

  test("a repo scope uses the per-repo endpoint and names the caller for 'mine' filters", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/api/v1/user"))
        return jsonResponse({ login: "alice" });
      return jsonResponse([]);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await forgejoSearchIssuesTool.execute(
      { repo: "acme/app", assigned: true } as never,
      ctxFor("issue-search-repo"),
    );
    const listUrl = new URL(urlsFrom(fetchMock).at(-1)!);
    expect(listUrl.pathname).toBe("/api/v1/repos/acme/app/issues");
    expect(listUrl.searchParams.get("assigned_by")).toBe("alice");
    expect(listUrl.searchParams.has("assigned")).toBe(false);
    expect(parse(result).scope).toBe("acme/app");
  });

  test("refuses every filter a repo scope cannot express, rather than dropping it", async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    for (const unsupported of [
      { reviewRequested: true },
      { reviewed: true },
      { owner: "acme" },
      { team: "players" },
    ]) {
      await expect(
        forgejoSearchIssuesTool.execute(
          { repo: "acme/app", ...unsupported } as never,
          ctxFor("issue-search-invalid"),
        ),
      ).rejects.toThrow(/instance-wide search/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("forgejo_get_issue", () => {
  test("resolves a bare repo against the default owner and adds opt-in comments and timeline", async () => {
    vi.mocked(getForgejoDefaultOwner).mockReturnValue("alice");
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/issues/42/comments"))
        return jsonResponse([
          { user: { login: "bob" }, created_at: "t", body: "looks good" },
        ]);
      if (url.includes("/issues/42/timeline"))
        return jsonResponse([
          {
            type: "label",
            user: { login: "bob" },
            label: { name: "bug" },
            created_at: "t",
          },
        ]);
      return jsonResponse({
        number: 42,
        title: "Add widget",
        state: "open",
        pull_request: { draft: true, merged: false },
        html_url: "https://git.example.com/acme/app/pulls/42",
        user: { login: "alice" },
        body: "Body text",
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await forgejoGetIssueTool.execute(
      {
        repo: "app",
        number: 42,
        includeComments: true,
        includeTimeline: true,
      } as never,
      ctxFor("issue"),
    );
    const payload = parse(result);
    expect(payload.repo).toBe("alice/app");
    expect(payload.issue.isPullRequest).toBe(true);
    expect(payload.issue.draft).toBe(true);
    expect(payload.issue.body).toBe("Body text");
    expect(payload.issue.commentList[0].body).toBe("looks good");
    expect(payload.issue.timeline[0]).toMatchObject({
      type: "label",
      label: "bug",
    });
  });

  test("throws a Settings hint when no owner can be resolved", async () => {
    vi.mocked(getForgejoDefaultOwner).mockReturnValue("");
    await expect(
      forgejoGetIssueTool.execute(
        { repo: "app", number: 1 } as never,
        ctxFor("issue-no-owner"),
      ),
    ).rejects.toThrow(/owner\/repo/);
  });
});

describe("forgejo_get_pull_request", () => {
  const pull = {
    number: 42,
    title: "Add widget",
    state: "open",
    draft: false,
    merged: false,
    mergeable: true,
    html_url: "https://git.example.com/acme/app/pulls/42",
    user: { login: "alice" },
    head: { ref: "feature", sha: "abc", repo: { full_name: "acme/app" } },
    base: { ref: "main", sha: "def", repo: { full_name: "acme/app" } },
    requested_reviewers: [{ login: "bob" }],
    labels: [{ name: "enhancement" }],
    additions: 12,
    deletions: 3,
    changed_files: 2,
    body: "why",
  };

  test("reads the core model plus commits, files, and the raw diff", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/pulls/42.diff"))
        return new Response("diff --git a/a.ts b/a.ts\n+const x = 1;", {
          status: 200,
        });
      if (url.includes("/pulls/42/commits"))
        return jsonResponse([
          {
            sha: "0123456789abcdef",
            commit: { message: "Add widget\n\nDetails" },
            author: { login: "alice" },
          },
        ]);
      if (url.includes("/pulls/42/files"))
        return jsonResponse([
          { filename: "a.ts", status: "changed", additions: 12, deletions: 3 },
        ]);
      return jsonResponse(pull);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await forgejoGetPullRequestTool.execute(
      {
        repo: "acme/app",
        number: 42,
        includeCommits: true,
        includeFiles: true,
        includeDiff: true,
      } as never,
      ctxFor("pr"),
    );
    const pr = parse(result).pullRequest;
    expect(pr.head).toEqual({
      ref: "feature",
      sha: "abc",
      repo: "acme/app",
    });
    expect(pr.requestedReviewers).toEqual(["bob"]);
    expect(pr.commits[0]).toEqual({
      sha: "0123456789ab",
      message: "Add widget",
      author: "alice",
    });
    // Forgejo sends no per-file patch: files carry counts only.
    expect(pr.files[0]).toEqual({
      filename: "a.ts",
      status: "changed",
      additions: 12,
      deletions: 3,
    });
    expect(pr.diffFormat).toBe("diff");
    expect(pr.diff).toContain("+const x = 1;");
    expect(pr.diffTruncated).toBeUndefined();
  });

  test("bounds the diff and honours the patch flavour", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes(".patch"))
        return new Response("x".repeat(5000), { status: 200 });
      return jsonResponse(pull);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await forgejoGetPullRequestTool.execute(
      {
        repo: "acme/app",
        number: 42,
        includeDiff: true,
        diffFormat: "patch",
        maxDiffChars: 1000,
      } as never,
      ctxFor("pr-diff"),
    );
    const pr = parse(result).pullRequest;
    expect(urlsFrom(fetchMock).some((u) => u.endsWith("/pulls/42.patch"))).toBe(
      true,
    );
    expect(pr.diff).toHaveLength(1000);
    expect(pr.diffTruncated).toBe(true);
  });

  test("groups inline comments under the review that owns them, skipping PENDING", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/reviews/9/comments"))
        return jsonResponse([
          {
            user: { login: "bob" },
            path: "a.ts",
            position: 3,
            original_position: 0,
            body: "use const",
            diff_hunk: "@@ -1 +1 @@",
          },
          // A comment on a REMOVED line: Gitea zeroes `position` and carries the
          // line in `original_position`.
          {
            user: { login: "bob" },
            path: "b.ts",
            position: 0,
            original_position: 12,
            body: "why removed?",
          },
        ]);
      if (url.includes("/pulls/42/reviews"))
        return jsonResponse([
          {
            id: 9,
            user: { login: "bob" },
            state: "REQUEST_CHANGES",
            body: "please fix",
            comments_count: 2,
            submitted_at: "t",
          },
          { id: 10, user: { login: "eve" }, state: "PENDING" },
        ]);
      return jsonResponse(pull);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await forgejoGetPullRequestTool.execute(
      {
        repo: "acme/app",
        number: 42,
        includeReviewComments: true,
      } as never,
      ctxFor("pr-reviews"),
    );
    const reviews = parse(result).pullRequest.reviews;
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      state: "REQUEST_CHANGES",
      author: "bob",
      commentCount: 2,
    });
    expect(reviews[0].comments[0]).toMatchObject({
      path: "a.ts",
      line: 3,
      body: "use const",
    });
    expect(reviews[0].comments[0].originalLine).toBeUndefined();
    // The pre-change side keeps its own key: a deleted line must never read as
    // a current one, or a quoted "path:line" points at the wrong text.
    expect(reviews[0].comments[1]).toMatchObject({
      path: "b.ts",
      originalLine: 12,
    });
    expect(reviews[0].comments[1].line).toBeUndefined();
  });

  test("does not fetch review comments that were not asked for", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("/pulls/42/reviews"))
        return jsonResponse([
          {
            id: 9,
            user: { login: "bob" },
            state: "APPROVED",
            comments_count: 4,
          },
        ]);
      return jsonResponse(pull);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await forgejoGetPullRequestTool.execute(
      { repo: "acme/app", number: 42, includeReviews: true } as never,
      ctxFor("pr-reviews-only"),
    );
    expect(
      urlsFrom(fetchMock).some((u) => u.includes("/reviews/9/comments")),
    ).toBe(false);
    expect(parse(result).pullRequest.reviews[0].comments).toBeUndefined();
  });
});

describe("forgejo_get_content", () => {
  test("returns bounded UTF-8 text for a file at a ref", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        type: "file",
        path: "README.md",
        size: 11,
        sha: "a",
        html_url: "https://git.example.com/acme/app/src/branch/main/README.md",
        encoding: "base64",
        content: Buffer.from("hello world").toString("base64"),
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await forgejoGetContentTool.execute(
      {
        repo: "acme/app",
        path: "README.md",
        ref: "main",
        maxChars: 5,
      } as never,
      ctxFor("content"),
    );
    const url = new URL(urlsFrom(fetchMock)[0]!);
    expect(url.pathname).toBe("/api/v1/repos/acme/app/contents/README.md");
    expect(url.searchParams.get("ref")).toBe("main");
    const payload = parse(result);
    expect(payload.status).toBe("content");
    expect(payload.content).toBe("hello");
    expect(payload.contentTruncated).toBe(true);
  });

  test("lists a directory compactly", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse([
        { name: "src", path: "src", type: "dir" },
        { name: "a.ts", path: "src/a.ts", type: "file", size: 10 },
      ]),
    ) as unknown as typeof fetch;
    const result = await forgejoGetContentTool.execute(
      { repo: "acme/app" } as never,
      ctxFor("content-dir"),
    );
    const payload = parse(result);
    expect(payload.type).toBe("dir");
    expect(payload.returned).toBe(2);
    expect(payload.entries[1]).toMatchObject({ path: "src/a.ts", size: 10 });
  });

  test("stages binary content as a session attachment (bytes off-context)", async () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        type: "file",
        path: "logo.png",
        size: binary.byteLength,
        sha: "d",
        encoding: "base64",
        content: binary.toString("base64"),
      }),
    ) as unknown as typeof fetch;

    const result = await forgejoGetContentTool.execute(
      { repo: "acme/app", path: "logo.png" } as never,
      ctxFor("content-binary"),
    );
    const payload = parse(result);
    expect(payload.status).toBe("saved_attachment");
    expect(payload.content).toBeUndefined();
    const staged = listSessionAttachments("content-binary").find(
      (a) => a.id === payload.attachment.id,
    );
    expect(staged?.source).toBe("agent");
  });

  test("refuses a file above the download cap without fetching bytes", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        type: "file",
        path: "big.bin",
        size: 5_000_000,
        sha: "e",
        download_url:
          "https://git.example.com/acme/app/raw/branch/main/big.bin",
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await forgejoGetContentTool.execute(
      { repo: "acme/app", path: "big.bin", maxDownloadBytes: 1024 } as never,
      ctxFor("content-big"),
    );
    expect(parse(result).status).toBe("too_large");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("authenticates the raw download only on the configured instance", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes("/raw/")) {
          expect(
            (init?.headers as Record<string, string> | undefined)
              ?.Authorization,
          ).toBe("token fj_test");
          return new Response("plain text", { status: 200 });
        }
        return jsonResponse({
          type: "file",
          path: "notes.txt",
          size: 10,
          sha: "f",
          download_url:
            "https://git.example.com/acme/app/raw/branch/main/notes.txt",
        });
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await forgejoGetContentTool.execute(
      { repo: "acme/app", path: "notes.txt" } as never,
      ctxFor("content-download"),
    );
    expect(parse(result).content).toBe("plain text");
  });
});

describe("resolveForgejoRepo", () => {
  test("accepts owner/repo, an instance URL, and the default owner", () => {
    expect(resolveForgejoRepo("acme/app")).toEqual({
      owner: "acme",
      repo: "app",
    });
    expect(resolveForgejoRepo("https://git.example.com/acme/app")).toEqual({
      owner: "acme",
      repo: "app",
    });
    vi.mocked(getForgejoDefaultOwner).mockReturnValue("alice");
    expect(resolveForgejoRepo("app")).toEqual({
      owner: "alice",
      repo: "app",
    });
  });

  test("throws a Settings hint when a bare name has no default owner", () => {
    vi.mocked(getForgejoDefaultOwner).mockReturnValue("");
    expect(() => resolveForgejoRepo("app")).toThrow(/Settings → Forgejo/);
  });

  test("refuses a URL on any host but the configured instance", () => {
    // Reading a foreign URL's path would silently retarget the same-named repo
    // on THIS instance, which is plausibly a different repository.
    expect(() => resolveForgejoRepo("https://github.com/acme/app")).toThrow(
      /not a URL on the configured Forgejo instance \(git\.example\.com\)/,
    );
    expect(() =>
      resolveForgejoRepo("https://git.example.com.evil.test/acme/app"),
    ).toThrow(/not a URL on the configured Forgejo instance/);
    // A port is part of the identity: the API host must match exactly.
    expect(() =>
      resolveForgejoRepo("https://git.example.com:2222/acme/app"),
    ).toThrow(/not a URL on the configured Forgejo instance/);
  });

  test("refuses any URL when no instance is configured", () => {
    vi.mocked(getForgejoBaseUrl).mockReturnValue("");
    expect(() =>
      resolveForgejoRepo("https://git.example.com/acme/app"),
    ).toThrow(/not a URL on the configured Forgejo instance/);
    // A plain owner/repo still resolves — it never depended on the host.
    expect(resolveForgejoRepo("acme/app")).toEqual({
      owner: "acme",
      repo: "app",
    });
  });
});
