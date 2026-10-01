import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ForgejoApiConfig } from "../../forgejoClient.ts";
import type { ForgejoPullRequestApprovalBody } from "@assistant/shared";

vi.mock("../../forgejoSettings.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../forgejoSettings.ts")>()),
  getForgejoToolConfig: vi.fn(),
  getForgejoDefaultOwner: vi.fn(() => ""),
  getForgejoBaseUrl: vi.fn(() => ""),
}));

const { getForgejoToolConfig, getForgejoDefaultOwner, getForgejoBaseUrl } =
  await import("../../forgejoSettings.ts");
// Importing the tools module also registers the "forgejoPullRequest" executor.
const {
  forgejoCreatePullRequestTool,
  forgejoEditPullRequestTool,
  forgejoReadyPullRequestTool,
  forgejoReviewPullRequestTool,
  forgejoCommentPullRequestTool,
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
        expect(JSON.parse(String(init?.body))).toMatchObject({
          title: "T",
          head: "feature",
          base: "main",
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
  });

  test("description edit waits for approval and PATCHes only the body", async () => {
    const sessionId = "fj-edit";
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://git.example.com/api/v1/repos/acme/app/pulls/42",
        );
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
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(latest(sessionId).body).toMatchObject({
      operation: "edit",
      pullNumber: 42,
      prBody: "Revised **description**",
    });
    const { card } = await resolveApproval(latest(sessionId).id, "approved");
    expect(card.status).toBe("executed");
    expect(card.resultUrl).toBe("https://git.example.com/acme/app/pulls/42");
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
        expect(JSON.parse(String(init?.body))).toEqual({ body: "" });
        return new Response("{}", { status: 200 });
      },
    ) as unknown as typeof fetch;
    await forgejoEditPullRequestTool.execute(
      { repo: "acme/app", number: 42, body: "" } as never,
      ctxFor(sessionId) as never,
    );
    await resolveApproval(latest(sessionId).id, "approved");
    expect(latest(sessionId).status).toBe("executed");
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

    for (const title of ["WIP: Add widget", "[WIP] Add widget"]) {
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
    expect(titles).toEqual(["WIP: Add widget", "[WIP] Add widget"]);
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
