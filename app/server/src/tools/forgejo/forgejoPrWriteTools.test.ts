import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ForgejoApiConfig } from "../../forgejoClient.ts";
import type { ForgejoPullRequestApprovalBody } from "@assistant/shared";

vi.mock("../../forgejoSettings.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../forgejoSettings.ts")>()),
  getForgejoToolConfig: vi.fn(),
  getForgejoDefaultOwner: vi.fn(() => ""),
  getForgejoBaseUrl: vi.fn(() => ""),
}));

vi.mock("../../pullRequestInventorySync.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../pullRequestInventorySync.ts")>()),
  invalidateForgejoPullRequestWrite: vi.fn(),
}));

const { getForgejoToolConfig, getForgejoDefaultOwner, getForgejoBaseUrl } =
  await import("../../forgejoSettings.ts");
const { invalidateForgejoPullRequestWrite } =
  await import("../../pullRequestInventorySync.ts");
// Importing the tools module also registers the "forgejoPullRequest" executor.
const {
  forgejoCreatePullRequestTool,
  forgejoEditPullRequestTool,
  forgejoReadyPullRequestTool,
  forgejoReviewPullRequestTool,
  forgejoCommentPullRequestTool,
  forgejoClosePullRequestTool,
} = await import("./forgejoPrWriteTools.ts");
const { resolveApproval, approvalsForSession, setApprovalBroadcastForTests } =
  await import("../../pendingApprovals.ts");

const config: ForgejoApiConfig = {
  baseUrl: "https://git.example.com",
  token: "fj_test",
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
  vi.mocked(getForgejoToolConfig).mockReturnValue(config);
  vi.mocked(getForgejoDefaultOwner).mockReturnValue("");
  vi.mocked(getForgejoBaseUrl).mockReturnValue(config.baseUrl);
  setApprovalBroadcastForTests(() => {});
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  setApprovalBroadcastForTests(null);
  vi.clearAllMocks();
});

describe("forgejo PR write approvals (unified subsystem)", () => {
  test("create stages a pending approval and does NOT write until approved", async () => {
    const sessionId = "fj-create";
    let wrote = false;
    globalThis.fetch = vi.fn(async () => {
      wrote = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await forgejoCreatePullRequestTool.execute(
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
    expect(card.kind).toBe("forgejoPullRequest");
    expect(card.status).toBe("pending");
    expect((card.body as ForgejoPullRequestApprovalBody).head).toBe("feature");
  });

  test("approving a create proposal opens the PR against the instance API root", async () => {
    const sessionId = "fj-create-approve";
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://git.example.com/api/v1/repos/acme/app/pulls",
        );
        expect(JSON.parse(String(init?.body))).toEqual({
          title: "T",
          head: "feature",
          base: "main",
          body: "",
        });
        return new Response(
          JSON.stringify({
            html_url: "https://git.example.com/acme/app/pulls/7",
            number: 7,
          }),
          { status: 200 },
        );
      },
    ) as unknown as typeof fetch;

    await forgejoCreatePullRequestTool.execute(
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
    expect(card.resultUrl).toBe("https://git.example.com/acme/app/pulls/7");
    expect(card.resultSummary).toContain("#7");
    expect(outcomePrompt).toContain("APPROVED");
    expect(outcomePrompt).toContain("executed successfully");
  });

  test("ready proposal waits for approval and removes the WIP title", async () => {
    const sessionId = "fj-ready";
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({
          url,
          method: init?.method ?? "GET",
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        return new Response(
          JSON.stringify({
            number: 42,
            title: "WIP: Feature",
            state: "open",
            merged: false,
            head: { ref: "feature", sha: "abc" },
            base: { ref: "main" },
          }),
          { status: 200 },
        );
      },
    ) as typeof fetch;
    await expect(
      forgejoReadyPullRequestTool.execute(
        { repo: "acme/app", number: 1.5 } as never,
        ctxFor(sessionId) as never,
      ),
    ).rejects.toThrow(/number/);
    await forgejoReadyPullRequestTool.execute(
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
    expect(calls.at(-1)).toMatchObject({
      url: "https://git.example.com/api/v1/repos/acme/app/issues/42",
      method: "PATCH",
      body: { title: "Feature" },
    });
    expect(vi.mocked(invalidateForgejoPullRequestWrite).mock.calls).toEqual([
      [config.baseUrl, "acme", "app", 42],
    ]);
  });

  test("description edit records the current one, waits for approval and PATCHes only the body", async () => {
    const sessionId = "fj-edit";
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://git.example.com/api/v1/repos/acme/app/pulls/42",
        );
        if (init?.method === "GET")
          return new Response(JSON.stringify({ body: null }), { status: 200 });
        expect(init?.method).toBe("PATCH");
        expect(JSON.parse(String(init?.body))).toEqual({
          body: "Revised **description**",
        });
        return new Response(
          JSON.stringify({
            html_url: "https://git.example.com/acme/app/pulls/42",
          }),
          { status: 200 },
        );
      },
    ) as unknown as typeof fetch;

    const result = await forgejoEditPullRequestTool.execute(
      {
        repo: "acme/app",
        number: 42,
        body: "Revised **description**",
      } as never,
      ctxFor(sessionId) as never,
    );
    expect(result.terminate).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(latest(sessionId).body).toMatchObject({
      operation: "edit",
      pullNumber: 42,
      prBody: "Revised **description**",
      previousPrBody: "",
    });
    const { card } = await resolveApproval(latest(sessionId).id, "approved");
    expect(card.status).toBe("executed");
    expect(card.resultUrl).toBe("https://git.example.com/acme/app/pulls/42");
  });

  test("a base-only edit retargets without touching the description", async () => {
    const sessionId = "fj-edit-base";
    await expect(
      forgejoEditPullRequestTool.execute(
        { repo: "acme/app", number: 42 } as never,
        ctxFor(sessionId) as never,
      ),
    ).rejects.toThrow(/body, a base, or both/);
    await expect(
      forgejoEditPullRequestTool.execute(
        { repo: "acme/app", number: 42, base: "  " } as never,
        ctxFor(sessionId) as never,
      ),
    ).rejects.toThrow(/base must name a branch/);
    expect(approvalsForSession(sessionId)).toHaveLength(0);
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toContain("/pulls/42");
        expect(init?.method).toBe("PATCH");
        expect(JSON.parse(String(init?.body))).toEqual({ base: "main" });
        return new Response("{}", { status: 200 });
      },
    ) as unknown as typeof fetch;
    await forgejoEditPullRequestTool.execute(
      { repo: "acme/app", number: 42, base: " main " } as never,
      ctxFor(sessionId) as never,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(latest(sessionId).title).toBe("Edit pull request base");
    expect(latest(sessionId).body).toEqual(
      expect.not.objectContaining({ prBody: expect.anything() }),
    );
    const { card } = await resolveApproval(latest(sessionId).id, "approved");
    expect(card.status).toBe("executed");
    expect(card.resultSummary).toBe("Retargeted #42 onto main");
  });

  test("an empty description clears the PR; invalid numbers stage nothing", async () => {
    const sessionId = "fj-edit-clear";
    await expect(
      forgejoEditPullRequestTool.execute(
        { repo: "acme/app", number: 0, body: "x" } as never,
        ctxFor(sessionId) as never,
      ),
    ).rejects.toThrow(/number/);
    expect(approvalsForSession(sessionId)).toHaveLength(0);
    globalThis.fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        // The current description is unreadable: the card goes without it.
        if (init?.method === "GET") return new Response("{}", { status: 500 });
        expect(JSON.parse(String(init?.body))).toEqual({ body: "" });
        return new Response("{}", { status: 200 });
      },
    ) as unknown as typeof fetch;
    await forgejoEditPullRequestTool.execute(
      { repo: "acme/app", number: 42, body: "" } as never,
      ctxFor(sessionId) as never,
    );
    expect(latest(sessionId).body).not.toHaveProperty("previousPrBody");
    await resolveApproval(latest(sessionId).id, "approved");
    expect(latest(sessionId).status).toBe("executed");
  });

  test("a description edit stopped while reading the current one proposes nothing", async () => {
    const sessionId = "fj-edit-aborted";
    globalThis.fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        init?.signal?.throwIfAborted();
        return new Response("{}", { status: 200 });
      },
    ) as unknown as typeof fetch;
    await expect(
      forgejoEditPullRequestTool.execute(
        { repo: "acme/app", number: 42, body: "x" } as never,
        { ...ctxFor(sessionId), signal: AbortSignal.abort() } as never,
      ),
    ).rejects.toThrow();
    expect(approvalsForSession(sessionId)).toHaveLength(0);
  });

  test("a draft becomes the WIP title prefix, since Forgejo has no draft field", async () => {
    const sessionId = "fj-draft";
    let sentBody: any;
    globalThis.fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        sentBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ number: 3 }), { status: 200 });
      },
    ) as unknown as typeof fetch;

    await forgejoCreatePullRequestTool.execute(
      {
        repo: "acme/app",
        title: "Add widget",
        head: "feature",
        base: "main",
        draft: true,
      } as never,
      ctxFor(sessionId) as never,
    );
    await resolveApproval(latest(sessionId).id, "approved");
    expect(sentBody.title).toBe("WIP: Add widget");
    expect(sentBody).not.toHaveProperty("draft");
  });

  test("a draft whose title already carries a WIP marker is not prefixed twice", async () => {
    const sessionId = "fj-draft-already-wip";
    const titles: string[] = [];
    globalThis.fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        titles.push(JSON.parse(String(init?.body)).title);
        return new Response(JSON.stringify({ number: 4 }), { status: 200 });
      },
    ) as unknown as typeof fetch;

    for (const title of [
      "WIP: Add widget",
      "[WIP] Add widget",
      "wip: Add widget",
      "WIP:Add widget",
    ]) {
      await forgejoCreatePullRequestTool.execute(
        {
          repo: "acme/app",
          title,
          head: "feature",
          base: "main",
          draft: true,
        } as never,
        ctxFor(sessionId) as never,
      );
      await resolveApproval(latest(sessionId).id, "approved");
    }
    expect(titles).toEqual([
      "WIP: Add widget",
      "[WIP] Add widget",
      "wip: Add widget",
      "WIP:Add widget",
    ]);
  });

  test("review approval sends Forgejo's verdict spelling and position anchors", async () => {
    const sessionId = "fj-review";
    let sentBody: any;
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toContain("/pulls/42/reviews");
        sentBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            html_url: "https://git.example.com/acme/app/pulls/42#r1",
          }),
          { status: 200 },
        );
      },
    ) as unknown as typeof fetch;

    await forgejoReviewPullRequestTool.execute(
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
          { path: "src/b.ts", line: 9, side: "LEFT", body: "why removed?" },
        ],
      } as never,
      ctxFor(sessionId) as never,
    );
    await resolveApproval(latest(sessionId).id, "approved");

    expect(sentBody.event).toBe("REQUEST_CHANGES");
    expect(sentBody.body).toBe("please fix");
    expect(sentBody.comments[0]).toMatchObject({
      path: "src/a.ts",
      new_position: 3,
    });
    expect(sentBody.comments[0]).not.toHaveProperty("line");
    expect(sentBody.comments[0]).not.toHaveProperty("side");
    expect(sentBody.comments[0].body).toContain(
      "```suggestion\nconst x = 1;\n```",
    );
    expect(sentBody.comments[1]).toMatchObject({
      path: "src/b.ts",
      old_position: 9,
    });
    expect(latest(sessionId).status).toBe("executed");
  });

  test("an APPROVED review passes the ReviewStateType through unchanged", async () => {
    const sessionId = "fj-approve";
    let sentBody: any;
    globalThis.fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        sentBody = JSON.parse(String(init?.body));
        return new Response("{}", { status: 200 });
      },
    ) as unknown as typeof fetch;
    await forgejoReviewPullRequestTool.execute(
      { repo: "acme/app", number: 5, event: "APPROVED" } as never,
      ctxFor(sessionId) as never,
    );
    await resolveApproval(latest(sessionId).id, "approved");
    expect(sentBody.event).toBe("APPROVED");
  });

  test("reject leaves no write and tells the agent it was declined", async () => {
    const sessionId = "fj-reject";
    let wrote = false;
    globalThis.fetch = vi.fn(async () => {
      wrote = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await forgejoCommentPullRequestTool.execute(
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

  test("a plain comment posts on the issues timeline", async () => {
    const sessionId = "fj-comment";
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain("/issues/9/comments");
      return new Response(JSON.stringify({ html_url: "u" }), { status: 200 });
    }) as unknown as typeof fetch;
    await forgejoCommentPullRequestTool.execute(
      { repo: "acme/app", number: 9, body: "thanks" } as never,
      ctxFor(sessionId) as never,
    );
    await resolveApproval(latest(sessionId).id, "approved");
    expect(latest(sessionId).status).toBe("executed");
  });

  test("a reply targets the review's comments endpoint with its anchor", async () => {
    const sessionId = "fj-reply";
    let sentBody: any;
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toContain("/pulls/9/reviews/555/comments");
        sentBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ html_url: "u" }), { status: 200 });
      },
    ) as unknown as typeof fetch;
    await forgejoCommentPullRequestTool.execute(
      {
        repo: "acme/app",
        number: 9,
        body: "thanks",
        replyToReviewId: 555,
        replyPath: "src/a.ts",
        replyLine: 12,
      } as never,
      ctxFor(sessionId) as never,
    );
    await resolveApproval(latest(sessionId).id, "approved");
    expect(sentBody).toMatchObject({
      path: "src/a.ts",
      new_position: 12,
      body: "thanks",
    });
    expect(latest(sessionId).status).toBe("executed");
  });

  test("a reply without an anchor is rejected before any card is staged", async () => {
    await expect(
      forgejoCommentPullRequestTool.execute(
        {
          repo: "acme/app",
          number: 9,
          body: "thanks",
          replyToReviewId: 555,
        } as never,
        ctxFor("fj-reply-invalid") as never,
      ),
    ).rejects.toThrow(/replyPath and replyLine/);
    expect(approvalsForSession("fj-reply-invalid")).toHaveLength(0);
  });

  test("a failed write surfaces the error and stays non-pending", async () => {
    const sessionId = "fj-fail";
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "not allowed" }), {
          status: 403,
        }),
    ) as unknown as typeof fetch;
    await forgejoCreatePullRequestTool.execute(
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
});

// These writes bypass the provider seam, so the inventory, the open list and
// its annotations would otherwise show the old state for a whole sync period.
describe("forgejo PR writes invalidate what the inventory remembers", () => {
  const invalidations = () =>
    vi.mocked(invalidateForgejoPullRequestWrite).mock.calls;

  test("an approved create, edit and review invalidate their pull request; comments do not", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ number: 7, body: "" }), { status: 200 }),
    ) as unknown as typeof fetch;

    await forgejoCreatePullRequestTool.execute(
      { repo: "acme/app", title: "T", head: "f", base: "main" } as never,
      ctxFor("fj-inv-create") as never,
    );
    await resolveApproval(latest("fj-inv-create").id, "approved");
    await forgejoEditPullRequestTool.execute(
      { repo: "acme/app", number: 42, body: "new" } as never,
      ctxFor("fj-inv-edit") as never,
    );
    await resolveApproval(latest("fj-inv-edit").id, "approved");
    await forgejoReviewPullRequestTool.execute(
      { repo: "acme/app", number: 43, event: "APPROVED" } as never,
      ctxFor("fj-inv-review") as never,
    );
    await resolveApproval(latest("fj-inv-review").id, "approved");
    for (const card of ["fj-inv-create", "fj-inv-edit", "fj-inv-review"])
      expect(latest(card).status).toBe("executed");
    expect(invalidations()).toEqual([
      [config.baseUrl, "acme", "app", 7],
      [config.baseUrl, "acme", "app", 42],
      [config.baseUrl, "acme", "app", 43],
    ]);

    await forgejoCommentPullRequestTool.execute(
      { repo: "acme/app", number: 42, body: "thanks" } as never,
      ctxFor("fj-inv-comment") as never,
    );
    await resolveApproval(latest("fj-inv-comment").id, "approved");
    await forgejoCommentPullRequestTool.execute(
      {
        repo: "acme/app",
        number: 42,
        body: "done",
        replyToReviewId: 9,
        replyPath: "src/a.ts",
        replyLine: 3,
      } as never,
      ctxFor("fj-inv-reply") as never,
    );
    await resolveApproval(latest("fj-inv-reply").id, "approved");
    expect(latest("fj-inv-comment").status).toBe("executed");
    expect(latest("fj-inv-reply").status).toBe("executed");
    expect(invalidations()).toHaveLength(3);
  });

  test("a failed write still invalidates: part of it may have landed", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "nope" }), { status: 422 }),
    ) as unknown as typeof fetch;

    await forgejoCreatePullRequestTool.execute(
      { repo: "acme/app", title: "T", head: "f", base: "main" } as never,
      ctxFor("fj-inv-create-fail") as never,
    );
    await resolveApproval(latest("fj-inv-create-fail").id, "approved");
    await forgejoEditPullRequestTool.execute(
      { repo: "acme/app", number: 42, base: "develop" } as never,
      ctxFor("fj-inv-edit-fail") as never,
    );
    await resolveApproval(latest("fj-inv-edit-fail").id, "approved");
    await forgejoReviewPullRequestTool.execute(
      { repo: "acme/app", number: 43, event: "COMMENT" } as never,
      ctxFor("fj-inv-review-fail") as never,
    );
    await resolveApproval(latest("fj-inv-review-fail").id, "approved");
    await forgejoCommentPullRequestTool.execute(
      { repo: "acme/app", number: 42, body: "thanks" } as never,
      ctxFor("fj-inv-comment-fail") as never,
    );
    await resolveApproval(latest("fj-inv-comment-fail").id, "approved");
    for (const card of [
      "fj-inv-create-fail",
      "fj-inv-edit-fail",
      "fj-inv-review-fail",
      "fj-inv-comment-fail",
    ])
      expect(latest(card).status).toBe("failed");
    expect(invalidations()).toEqual([
      [config.baseUrl, "acme", "app", undefined],
      [config.baseUrl, "acme", "app", 42],
      [config.baseUrl, "acme", "app", 43],
    ]);
  });
});

describe("forgejo close pull request approvals", () => {
  test("binds the head when proposed, then comments and closes on approval", async () => {
    const sessionId = "fj-close";
    const calls: string[] = [];
    let closed = false;
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push(`${method} ${url}`);
        if (method === "POST")
          return new Response(
            JSON.stringify({
              html_url: "https://git.example.com/acme/app/pulls/42#c1",
            }),
            { status: 201 },
          );
        if (method === "PATCH") closed = true;
        return new Response(
          JSON.stringify({
            number: 42,
            state: closed ? "closed" : "open",
            merged: false,
            head: {
              ref: "feature",
              sha: "abc",
              repo: { full_name: "acme/app" },
            },
            base: { ref: "main" },
          }),
          { status: 200 },
        );
      },
    ) as unknown as typeof fetch;
    await forgejoClosePullRequestTool.execute(
      { repo: "acme/app", number: 42, comment: "Not needed." } as never,
      ctxFor(sessionId) as never,
    );
    expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
    const card = latest(sessionId);
    expect(card.title).toBe("Close pull request");
    expect(card.body).toMatchObject({
      kind: "forgejoPullRequest",
      operation: "close",
      pullNumber: 42,
      headSha: "abc",
      commentBody: "Not needed.",
    });
    expect((card.body as ForgejoPullRequestApprovalBody).deleteBranch).toBe(
      undefined,
    );
    const { card: done } = await resolveApproval(card.id, "approved");
    expect(done.status).toBe("executed");
    expect(done.resultSummary).toBe(
      "Closed #42 without merging. Posted the comment.",
    );
    expect(calls.filter((call) => !call.startsWith("GET "))).toEqual([
      "POST https://git.example.com/api/v1/repos/acme/app/issues/42/comments",
      "PATCH https://git.example.com/api/v1/repos/acme/app/pulls/42",
    ]);
    expect(invalidateForgejoPullRequestWrite).toHaveBeenCalledWith(
      config.baseUrl,
      "acme",
      "app",
      42,
    );
  });

  test("an empty comment is refused rather than closing silently", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    await expect(
      forgejoClosePullRequestTool.execute(
        { repo: "acme/app", number: 42, comment: "   " } as never,
        ctxFor("fj-close-empty") as never,
      ),
    ).rejects.toThrow(/comment must not be empty/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
