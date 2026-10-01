import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { GithubApiConfig } from "../../githubClient.ts";
import type { GithubPullRequestApprovalBody } from "@assistant/shared";

vi.mock("../../githubSettings.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../githubSettings.ts")>()),
  getGithubToolConfig: vi.fn(),
  getGithubDefaultOwner: vi.fn(() => ""),
}));

vi.mock("../../pullRequestInventorySync.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../pullRequestInventorySync.ts")>()),
  invalidateGithubPullRequestWrite: vi.fn(),
}));

const { getGithubToolConfig } = await import("../../githubSettings.ts");
const { invalidateGithubPullRequestWrite } =
  await import("../../pullRequestInventorySync.ts");
// Importing the tools module also registers the "githubPullRequest" approval executor.
const {
  githubCreatePullRequestTool,
  githubEditPullRequestTool,
  githubReadyPullRequestTool,
  githubReviewPullRequestTool,
  githubCommentPullRequestTool,
  githubAssignPullRequestTool,
} = await import("./githubPrWriteTools.ts");
const { resolveApproval, approvalsForSession, setApprovalBroadcastForTests } =
  await import("../../pendingApprovals.ts");

const config: GithubApiConfig = {
  token: "ghp_test",
  apiBaseUrl: "https://api.github.com",
};
const originalFetch = globalThis.fetch;

const ctxFor = (sessionId: string) => ({
  toolCallId: "c",
  session: {
    sessionId,
    harness: "pi" as const,
    agentType: "developer" as const,
  },
  signal: new AbortController().signal,
});
const latest = (sessionId: string) => approvalsForSession(sessionId).at(-1)!;

beforeEach(() => {
  vi.mocked(getGithubToolConfig).mockReturnValue(config);
  setApprovalBroadcastForTests(() => {});
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  setApprovalBroadcastForTests(null);
  vi.clearAllMocks();
});

describe("github PR write approvals (unified subsystem)", () => {
  test("create stages a pending approval and does NOT write until approved", async () => {
    const sessionId = "appr-create";
    let wrote = false;
    globalThis.fetch = vi.fn(async () => {
      wrote = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await githubCreatePullRequestTool.execute(
      {
        repo: "acme/app",
        title: "Add widget",
        head: "feature",
        base: "main",
        body: "why",
      } as never,
      ctxFor(sessionId) as never,
    );
    expect(result.terminate).toBe(true);
    expect(wrote).toBe(false);
    const card = latest(sessionId);
    expect(card.kind).toBe("githubPullRequest");
    expect(card.status).toBe("pending");
    expect((card.body as GithubPullRequestApprovalBody).head).toBe("feature");
  });

  test("approving a create proposal opens the PR and records the result", async () => {
    const sessionId = "appr-create-approve";
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toContain("/repos/acme/app/pulls");
        expect(JSON.parse(String(init?.body))).toMatchObject({
          title: "T",
          head: "feature",
          base: "main",
        });
        return new Response(
          JSON.stringify({
            html_url: "https://github.com/acme/app/pull/7",
            number: 7,
          }),
          { status: 200 },
        );
      },
    ) as unknown as typeof fetch;

    await githubCreatePullRequestTool.execute(
      {
        repo: "acme/app",
        title: "T",
        head: "feature",
        base: "main",
      } as never,
      ctxFor(sessionId) as never,
    );
    const { card, outcomePrompt } = await resolveApproval(
      latest(sessionId).id,
      "approved",
    );
    expect(card.status).toBe("executed");
    expect(card.resultUrl).toBe("https://github.com/acme/app/pull/7");
    expect(card.resultSummary).toContain("#7");
    expect(outcomePrompt).toContain("APPROVED");
    expect(outcomePrompt).toContain("executed successfully");
  });

  test("ready proposal waits for approval and publishes a draft through GraphQL", async () => {
    const sessionId = "gh-ready";
    const calls: string[] = [];
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? "GET"} ${url}`);
        return new Response(
          JSON.stringify(
            url.endsWith("/graphql")
              ? {
                  data: {
                    markPullRequestReadyForReview: {
                      pullRequest: { title: "Feature" },
                    },
                  },
                }
              : {
                  number: 42,
                  node_id: "PR_node",
                  title: "Feature",
                  state: "open",
                  draft: true,
                  head: { ref: "feature", sha: "abc" },
                  base: { ref: "main" },
                },
          ),
          { status: 200 },
        );
      },
    ) as typeof fetch;
    await expect(
      githubReadyPullRequestTool.execute(
        { repo: "acme/app", number: 0 } as never,
        ctxFor(sessionId) as never,
      ),
    ).rejects.toThrow(/number/);
    await githubReadyPullRequestTool.execute(
      { repo: "acme/app", number: 42 } as never,
      ctxFor(sessionId) as never,
    );
    expect(calls).toEqual([]);
    expect(latest(sessionId).body).toMatchObject({
      operation: "ready",
      pullNumber: 42,
    });
    const { card } = await resolveApproval(latest(sessionId).id, "approved");
    expect(card.status).toBe("executed");
    expect(calls.filter((call) => call.includes("/graphql"))).toHaveLength(1);
    expect(invalidateGithubPullRequestWrite).toHaveBeenCalledWith(
      "acme",
      "app",
      42,
    );
  });

  test("ready proposal refuses a PR that is no longer a draft", async () => {
    const sessionId = "gh-not-draft";
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            number: 42,
            state: "open",
            draft: false,
            head: { ref: "feature", sha: "abc" },
            base: { ref: "main" },
          }),
          { status: 200 },
        ),
    ) as typeof fetch;
    await githubReadyPullRequestTool.execute(
      { repo: "acme/app", number: 42 } as never,
      ctxFor(sessionId) as never,
    );
    const { card } = await resolveApproval(latest(sessionId).id, "approved");
    expect(card.status).toBe("failed");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("description edit waits for approval and PATCHes only the body", async () => {
    const sessionId = "appr-edit";
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://api.github.com/repos/acme/app/pulls/42",
        );
        expect(init?.method).toBe("PATCH");
        expect(JSON.parse(String(init?.body))).toEqual({
          body: "Revised **description**",
        });
        return new Response(
          JSON.stringify({
            html_url: "https://github.com/acme/app/pull/42",
          }),
          { status: 200 },
        );
      },
    ) as unknown as typeof fetch;

    const result = await githubEditPullRequestTool.execute(
      {
        repo: "acme/app",
        number: 42,
        body: "Revised **description**",
      } as never,
      ctxFor(sessionId) as never,
    );
    expect(result.terminate).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(latest(sessionId).body).toMatchObject({
      operation: "edit",
      pullNumber: 42,
      prBody: "Revised **description**",
    });
    const { card } = await resolveApproval(latest(sessionId).id, "approved");
    expect(card.status).toBe("executed");
    expect(card.resultUrl).toBe("https://github.com/acme/app/pull/42");
    expect(invalidateGithubPullRequestWrite).toHaveBeenCalledWith(
      "acme",
      "app",
      42,
    );
  });

  test("an empty description clears the PR; invalid numbers stage nothing", async () => {
    const sessionId = "appr-edit-clear";
    await expect(
      githubEditPullRequestTool.execute(
        { repo: "acme/app", number: 1.5, body: "x" } as never,
        ctxFor(sessionId) as never,
      ),
    ).rejects.toThrow(/number/);
    expect(approvalsForSession(sessionId)).toHaveLength(0);
    globalThis.fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toEqual({ body: "" });
        return new Response("{}", { status: 200 });
      },
    ) as unknown as typeof fetch;
    await githubEditPullRequestTool.execute(
      { repo: "acme/app", number: 42, body: "" } as never,
      ctxFor(sessionId) as never,
    );
    await resolveApproval(latest(sessionId).id, "approved");
    expect(latest(sessionId).status).toBe("executed");
  });

  test("review approval sends the verdict and fenced suggestion", async () => {
    const sessionId = "appr-review";
    let sentBody: any;
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toContain("/pulls/42/reviews");
        sentBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            html_url: "https://github.com/acme/app/pull/42#r1",
          }),
          { status: 200 },
        );
      },
    ) as unknown as typeof fetch;

    await githubReviewPullRequestTool.execute(
      {
        repo: "acme/app",
        number: 42,
        event: "REQUEST_CHANGES",
        summary: "please fix",
        comments: [
          {
            path: "src/a.ts",
            line: 3,
            body: "use const",
            suggestion: "const x = 1;",
          },
        ],
      } as never,
      ctxFor(sessionId) as never,
    );
    await resolveApproval(latest(sessionId).id, "approved");

    expect(sentBody.event).toBe("REQUEST_CHANGES");
    expect(sentBody.body).toBe("please fix");
    expect(sentBody.comments[0].body).toContain(
      "```suggestion\nconst x = 1;\n```",
    );
    expect(latest(sessionId).status).toBe("executed");
  });

  test("reject leaves no write and tells the agent it was declined", async () => {
    const sessionId = "appr-reject";
    let wrote = false;
    globalThis.fetch = vi.fn(async () => {
      wrote = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await githubCommentPullRequestTool.execute(
      { repo: "acme/app", number: 9, body: "x" } as never,
      ctxFor(sessionId) as never,
    );
    const { card, outcomePrompt } = await resolveApproval(
      latest(sessionId).id,
      "rejected",
    );
    expect(wrote).toBe(false);
    expect(card.status).toBe("rejected");
    expect(outcomePrompt).toContain("REJECTED");
  });

  test("comment reply targets the replies endpoint", async () => {
    const sessionId = "appr-reply";
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain("/pulls/9/comments/555/replies");
      return new Response(
        JSON.stringify({
          html_url: "https://github.com/acme/app/pull/9#c",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await githubCommentPullRequestTool.execute(
      {
        repo: "acme/app",
        number: 9,
        body: "thanks",
        replyToCommentId: 555,
      } as never,
      ctxFor(sessionId) as never,
    );
    await resolveApproval(latest(sessionId).id, "approved");
    expect(latest(sessionId).status).toBe("executed");
  });

  test("a failed write surfaces the error and stays non-pending", async () => {
    const sessionId = "appr-fail";
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "not allowed" }), {
          status: 403,
        }),
    ) as unknown as typeof fetch;
    await githubCreatePullRequestTool.execute(
      { repo: "acme/app", title: "T", head: "f", base: "main" } as never,
      ctxFor(sessionId) as never,
    );
    const { card, outcomePrompt } = await resolveApproval(
      latest(sessionId).id,
      "approved",
    );
    expect(card.status).toBe("failed");
    expect(card.error).toMatch(/403|not allowed/);
    expect(outcomePrompt).toContain("FAILED");
  });

  test("resolving an already-resolved approval throws", async () => {
    const sessionId = "appr-double";
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ html_url: "u", number: 1 }), {
          status: 200,
        }),
    ) as unknown as typeof fetch;
    await githubCreatePullRequestTool.execute(
      { repo: "acme/app", title: "T", head: "f", base: "main" } as never,
      ctxFor(sessionId) as never,
    );
    const id = latest(sessionId).id;
    await resolveApproval(id, "approved");
    await expect(resolveApproval(id, "approved")).rejects.toThrow(/already/);
  });
});

describe("github_assign_pull_request", () => {
  test("stages the change without writing, keeping reviewers and assignees apart", async () => {
    const sessionId = "assign-stage";
    let wrote = false;
    globalThis.fetch = vi.fn(async () => {
      wrote = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await githubAssignPullRequestTool.execute(
      {
        repo: "acme/app",
        number: 12,
        addReviewers: ["@alice", "alice", " "],
        addReviewerTeams: ["acme/platform"],
        addAssignees: ["bob"],
      } as never,
      ctxFor(sessionId) as never,
    );

    expect(result.terminate).toBe(true);
    expect(wrote).toBe(false);
    const card = latest(sessionId);
    const body = card.body as GithubPullRequestApprovalBody;
    expect(card.status).toBe("pending");
    expect(body.operation).toBe("assign");
    expect(body.addReviewers).toEqual(["alice"]);
    expect(body.addReviewerTeams).toEqual(["platform"]);
    expect(body.addAssignees).toEqual(["bob"]);
    expect(body.removeReviewers).toBeUndefined();
    expect(card.summary).toContain("request review: alice, team:platform");
    expect(card.summary).toContain("assign: bob");
  });

  test("a proposal that changes nobody is refused", async () => {
    await expect(
      githubAssignPullRequestTool.execute(
        { repo: "acme/app", number: 12, addReviewers: [] } as never,
        ctxFor("assign-empty") as never,
      ),
    ).rejects.toThrow(/at least one reviewer/i);
  });

  test("'@me' resolves to the authenticated login at proposal time", async () => {
    const sessionId = "assign-me";
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain("/user");
      return new Response(JSON.stringify({ login: "alice" }), { status: 200 });
    }) as unknown as typeof fetch;

    await githubAssignPullRequestTool.execute(
      { repo: "acme/app", number: 12, addReviewers: ["@me"] } as never,
      ctxFor(sessionId) as never,
    );
    expect(
      (latest(sessionId).body as GithubPullRequestApprovalBody).addReviewers,
    ).toEqual(["alice"]);
  });

  test("a bare 'me' is the GitHub account of that name, not the alias", async () => {
    const sessionId = "assign-literal-me";
    globalThis.fetch = vi.fn(async () => {
      throw new Error("no request should be made for a literal login");
    }) as unknown as typeof fetch;

    await githubAssignPullRequestTool.execute(
      { repo: "acme/app", number: 12, addReviewers: ["me"] } as never,
      ctxFor(sessionId) as never,
    );
    expect(
      (latest(sessionId).body as GithubPullRequestApprovalBody).addReviewers,
    ).toEqual(["me"]);
  });

  test("team slugs normalize before empties and duplicates are dropped", async () => {
    const sessionId = "assign-team-slugs";
    await githubAssignPullRequestTool.execute(
      {
        repo: "acme/app",
        number: 12,
        addReviewerTeams: ["acme/platform", "@platform", "acme/", "/"],
      } as never,
      ctxFor(sessionId) as never,
    );
    expect(
      (latest(sessionId).body as GithubPullRequestApprovalBody)
        .addReviewerTeams,
    ).toEqual(["platform"]);
  });

  test("approval calls each endpoint that has work, and only those", async () => {
    const sessionId = "assign-approve";
    const calls: { method: string; path: string; body: unknown }[] = [];
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          method: String(init?.method),
          path: new URL(String(input)).pathname,
          body: JSON.parse(String(init?.body)),
        });
        return new Response(
          JSON.stringify({
            html_url: "https://github.com/acme/app/pull/12",
          }),
          { status: 200 },
        );
      },
    ) as unknown as typeof fetch;

    await githubAssignPullRequestTool.execute(
      {
        repo: "acme/app",
        number: 12,
        addReviewers: ["alice"],
        addReviewerTeams: ["platform"],
        removeAssignees: ["carol"],
      } as never,
      ctxFor(sessionId) as never,
    );
    const { card } = await resolveApproval(latest(sessionId).id, "approved");

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/repos/acme/app/pulls/12/requested_reviewers",
        body: { reviewers: ["alice"], team_reviewers: ["platform"] },
      },
      {
        method: "DELETE",
        path: "/repos/acme/app/issues/12/assignees",
        body: { assignees: ["carol"] },
      },
    ]);
    expect(card.status).toBe("executed");
    expect(card.resultUrl).toBe("https://github.com/acme/app/pull/12");
    expect(card.resultSummary).toContain(
      "request review: alice, team:platform",
    );
    expect(card.resultSummary).toContain("unassign: carol");
  });

  test("a step failing after an earlier one names what already landed", async () => {
    const sessionId = "assign-partial";
    globalThis.fetch = vi.fn(async (input: string | URL | Request) =>
      String(input).includes("/assignees")
        ? new Response(JSON.stringify({ message: "no push access" }), {
            status: 422,
          })
        : new Response(JSON.stringify({ html_url: "u" }), { status: 200 }),
    ) as unknown as typeof fetch;

    await githubAssignPullRequestTool.execute(
      {
        repo: "acme/app",
        number: 12,
        addReviewers: ["alice"],
        addAssignees: ["outsider"],
      } as never,
      ctxFor(sessionId) as never,
    );
    const { card } = await resolveApproval(latest(sessionId).id, "approved");

    expect(card.status).toBe("failed");
    expect(card.error).toContain("already applied: request review: alice");
  });
});

// These writes bypass the provider seam, so the inventory, the open list and
// its annotations would otherwise show the old state for a whole sync period.
describe("github PR writes invalidate what the inventory remembers", () => {
  test("an approved review invalidates that pull request; a comment does not", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;

    await githubReviewPullRequestTool.execute(
      { repo: "acme/app", number: 42, event: "APPROVE" } as never,
      ctxFor("inv-review") as never,
    );
    await resolveApproval(latest("inv-review").id, "approved");
    expect(vi.mocked(invalidateGithubPullRequestWrite).mock.calls).toEqual([
      ["acme", "app", 42],
    ]);

    await githubCommentPullRequestTool.execute(
      { repo: "acme/app", number: 42, body: "thanks" } as never,
      ctxFor("inv-comment") as never,
    );
    await resolveApproval(latest("inv-comment").id, "approved");
    expect(vi.mocked(invalidateGithubPullRequestWrite).mock.calls).toHaveLength(
      1,
    );
  });

  test("a failed assignment still invalidates: earlier steps may have landed", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('{"message":"nope"}', { status: 422 }),
    ) as unknown as typeof fetch;

    await githubAssignPullRequestTool.execute(
      { repo: "acme/app", number: 7, addReviewers: ["someone"] } as never,
      ctxFor("inv-assign") as never,
    );
    await resolveApproval(latest("inv-assign").id, "approved").catch(
      () => undefined,
    );
    expect(vi.mocked(invalidateGithubPullRequestWrite).mock.calls).toEqual([
      ["acme", "app", 7],
    ]);
  });
});
