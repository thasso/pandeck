import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PullRequestReviewCommentInput } from "../gitHosting.ts";
import * as hosting from "../gitHosting.ts";
import { getGithubToolConfig } from "../githubSettings.ts";
import { getForgejoToolConfig } from "../forgejoSettings.ts";
import {
  invalidateGithubPullRequestWrite,
  invalidateForgejoPullRequestWrite,
} from "../pullRequestInventorySync.ts";
import {
  approvalsForSession,
  createApproval,
  resolveApproval,
  setApprovalBroadcastForTests,
} from "../pendingApprovals.ts";
import {
  githubReviewPullRequestTool,
  githubCommentPullRequestTool,
  githubAssignPullRequestTool,
  githubResolveReviewThreadTool,
  githubClosePullRequestTool,
} from "./github/githubPrWriteTools.ts";
import {
  forgejoReviewPullRequestTool,
  forgejoCommentPullRequestTool,
  forgejoClosePullRequestTool,
} from "./forgejo/forgejoPrWriteTools.ts";

vi.mock("../githubSettings.ts", async (importActual) => ({
  ...(await importActual<typeof import("../githubSettings.ts")>()),
  getGithubToolConfig: vi.fn(),
}));
vi.mock("../forgejoSettings.ts", async (importActual) => ({
  ...(await importActual<typeof import("../forgejoSettings.ts")>()),
  getForgejoToolConfig: vi.fn(),
}));
vi.mock("../pullRequestInventorySync.ts", async (importActual) => ({
  ...(await importActual<typeof import("../pullRequestInventorySync.ts")>()),
  invalidateGithubPullRequestWrite: vi.fn(),
  invalidateForgejoPullRequestWrite: vi.fn(),
}));

type Service = "github" | "forgejo";
let sequence = 0;
const context = () => {
  const controller = new AbortController();
  return {
    toolCallId: "review-port",
    session: {
      sessionId: `review-port-${++sequence}`,
      harness: "pi" as const,
      agentType: "developer" as const,
    },
    signal: controller.signal,
    controller,
  };
};
type Context = ReturnType<typeof context>;
const latest = (ctx: Context) =>
  approvalsForSession(ctx.session.sessionId).at(-1)!;
const approve = async (ctx: Context) =>
  (await resolveApproval(latest(ctx).id, "approved")).card;
const origin = (service: Service) =>
  service === "github"
    ? "https://new-api.example.invalid"
    : "https://new-forgejo.example.invalid:8443/root/api/v1";
const authorization = (service: Service) =>
  service === "github" ? "Bearer gh-new" : "token fj-new";
const invalidator = (service: Service) =>
  service === "github"
    ? invalidateGithubPullRequestWrite
    : invalidateForgejoPullRequestWrite;
function newSettings() {
  vi.mocked(getGithubToolConfig).mockReturnValue({
    token: "gh-new",
    apiBaseUrl: "https://new-api.example.invalid",
  });
  vi.mocked(getForgejoToolConfig).mockReturnValue({
    token: "fj-new",
    baseUrl: "https://new-forgejo.example.invalid:8443/root",
  });
}
beforeEach(() => {
  vi.mocked(getGithubToolConfig).mockReturnValue({
    token: "gh-old",
    apiBaseUrl: "https://api.github.com",
  });
  vi.mocked(getForgejoToolConfig).mockReturnValue({
    token: "fj-old",
    baseUrl: "https://git.example.com",
  });
  setApprovalBroadcastForTests(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  setApprovalBroadcastForTests(null);
});

async function stageReview(
  service: Service,
  ctx: Context,
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES",
  summary?: string,
  comments?: PullRequestReviewCommentInput[],
) {
  const common = {
    repo: "acme/app",
    number: 4,
    ...(summary !== undefined ? { summary } : {}),
    ...(comments ? { comments } : {}),
  };
  return service === "github"
    ? githubReviewPullRequestTool.execute({ ...common, event }, ctx)
    : forgejoReviewPullRequestTool.execute(
        { ...common, event: event === "APPROVE" ? "APPROVED" : event },
        ctx,
      );
}
async function stageComment(
  service: Service,
  ctx: Context,
  reply = false,
  side?: "LEFT" | "RIGHT",
) {
  const common = { repo: "acme/app", number: 4, body: " hello " };
  return service === "github"
    ? githubCommentPullRequestTool.execute(
        { ...common, ...(reply ? { replyToCommentId: "27" } : {}) },
        ctx,
      )
    : forgejoCommentPullRequestTool.execute(
        {
          ...common,
          ...(reply
            ? {
                replyToReviewId: 13,
                replyPath: " src/a.ts ",
                replyLine: 9,
                ...(side ? { replySide: side } : {}),
              }
            : {}),
        },
        ctx,
      );
}
const inline = [
  { path: "a.ts", line: 1, body: "default" },
  {
    path: "b.ts",
    line: 2,
    side: "RIGHT" as const,
    body: "right",
    suggestion: "replacement",
  },
  {
    path: "c.ts",
    line: 3,
    side: "LEFT" as const,
    body: "left",
    suggestion: "",
  },
];
// Expectations are the old tool payloads, not the port's serializers.
const wireComments = (service: Service) =>
  service === "github"
    ? [
        { path: "a.ts", line: 1, side: "RIGHT", body: "default" },
        {
          path: "b.ts",
          line: 2,
          side: "RIGHT",
          body: "right\n\n```suggestion\nreplacement\n```",
        },
        { path: "c.ts", line: 3, side: "LEFT", body: "left" },
      ]
    : [
        { path: "a.ts", new_position: 1, body: "default" },
        {
          path: "b.ts",
          new_position: 2,
          body: "right\n\n```suggestion\nreplacement\n```",
        },
        { path: "c.ts", old_position: 3, body: "left" },
      ];

for (const service of ["github", "forgejo"] as const) {
  for (const event of ["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const) {
    test.each(["absent", "empty", "present"] as const)(
      `${service} ${event} exact approved review with %s content and fresh settings/signals`,
      async (content) => {
        const ctx = context();
        const fetch = vi
          .spyOn(globalThis, "fetch")
          .mockImplementation(async (input, init) => {
            expect(String(input)).toBe(
              `${origin(service)}/repos/acme/app/pulls/4/reviews`,
            );
            expect(init?.method).toBe("POST");
            expect(new Headers(init?.headers).get("authorization")).toBe(
              authorization(service),
            );
            expect(init?.signal).not.toBe(ctx.signal);
            expect(init?.signal?.aborted).toBe(false);
            expect(JSON.parse(String(init?.body))).toEqual({
              event:
                service === "forgejo" && event === "APPROVE"
                  ? "APPROVED"
                  : event,
              ...(content === "present"
                ? { body: "summary", comments: wireComments(service) }
                : {}),
            });
            return new Response(
              JSON.stringify({ html_url: "https://returned.invalid/review" }),
            );
          });
        await stageReview(
          service,
          ctx,
          event,
          content === "absent"
            ? undefined
            : content === "empty"
              ? "  "
              : " summary ",
          content === "present" ? inline : content === "empty" ? [] : undefined,
        );
        expect(fetch).not.toHaveBeenCalled();
        newSettings();
        // Abort the ORIGINAL proposal controller, not a replacement signal.
        ctx.controller.abort();
        const card = await approve(ctx);
        expect(card.status).toBe("executed");
        expect(card.resultSummary).toBe(
          `Submitted ${service === "forgejo" && event === "APPROVE" ? "APPROVED" : event} review on #4`,
        );
        expect(card.resultUrl).toBe("https://returned.invalid/review");
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(invalidator(service)).toHaveBeenCalledTimes(1);
      },
    );
  }

  test(`${service} a restored review without event still sends only COMMENT`, async () => {
    const ctx = context();
    createApproval({
      sessionId: ctx.session.sessionId,
      kind: service === "github" ? "githubPullRequest" : "forgejoPullRequest",
      title: "Review",
      summary: "Review",
      body: {
        kind: service === "github" ? "githubPullRequest" : "forgejoPullRequest",
        operation: "review",
        repo: "acme/app",
        pullNumber: 4,
        reviewSummary: "",
        inlineComments: [],
      },
    });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        expect(JSON.parse(String(init?.body))).toEqual({ event: "COMMENT" });
        return new Response("{}");
      });
    expect((await approve(ctx)).resultSummary).toBe(
      "Submitted COMMENT review on #4",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  for (const operation of ["review", "timeline", "reply"] as const) {
    test.each([
      {},
      { html_url: "" },
      { html_url: "https://returned.invalid/comment" },
      null,
    ])(
      `${service} ${operation} retains generic URL/null policy: %j`,
      async (response) => {
        const ctx = context();
        const fetch = vi
          .spyOn(globalThis, "fetch")
          .mockResolvedValue(new Response(JSON.stringify(response)));
        if (operation === "review") await stageReview(service, ctx, "COMMENT");
        else await stageComment(service, ctx, operation === "reply");
        expect(fetch).not.toHaveBeenCalled();
        const card = await approve(ctx);
        expect(card.status).toBe(response === null ? "failed" : "executed");
        // The executor retains empty URLs, but approval persistence has always
        // omitted them by truthiness. Public-provider tests pin that distinction.
        expect(card.resultUrl).toBe(response?.html_url || undefined);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(invalidator(service)).toHaveBeenCalledTimes(
          operation === "review" ? 1 : 0,
        );
      },
    );

    test.each(["http", "timeout", "lost response"] as const)(
      `${service} ${operation} %s failure has no retry and preserves inventory ownership`,
      async (failure) => {
        const ctx = context();
        const timers: AbortController[] = [];
        vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
          expect(ms).toBe(8000);
          const controller = new AbortController();
          timers.push(controller);
          return controller.signal;
        });
        const fetch = vi
          .spyOn(globalThis, "fetch")
          .mockImplementation(async (_input, init) => {
            if (failure === "http")
              return new Response(JSON.stringify({ message: "rejected" }), {
                status: 422,
              });
            if (failure === "lost response")
              throw new Error("accepted remotely, response lost");
            const rejected = new Promise<Response>((_resolve, reject) =>
              init?.signal?.addEventListener(
                "abort",
                () =>
                  reject(
                    new Error("request aborted", {
                      cause: init.signal?.reason,
                    }),
                  ),
                { once: true },
              ),
            );
            timers.at(-1)!.abort(new DOMException("timed out", "TimeoutError"));
            return rejected;
          });
        if (operation === "review") await stageReview(service, ctx, "COMMENT");
        else await stageComment(service, ctx, operation === "reply");
        const card = await approve(ctx);
        expect(card.status).toBe("failed");
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(timers).toHaveLength(1);
        expect(invalidator(service)).toHaveBeenCalledTimes(
          operation === "review" ? 1 : 0,
        );
      },
    );

    test(`${service} rejecting ${operation} never writes or invalidates`, async () => {
      const ctx = context();
      const fetch = vi.spyOn(globalThis, "fetch");
      if (operation === "review") await stageReview(service, ctx, "COMMENT");
      else await stageComment(service, ctx, operation === "reply");
      const { card } = await resolveApproval(latest(ctx).id, "rejected");
      expect(card.status).toBe("rejected");
      expect(fetch).not.toHaveBeenCalled();
      expect(invalidator(service)).not.toHaveBeenCalled();
    });
  }

  test.each([undefined, "LEFT", "RIGHT"] as const)(
    `${service} timeline and distinct reply payloads, side=%s`,
    async (side) => {
      const ctx = context();
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => new Response("{}"));
      await stageComment(service, ctx);
      newSettings();
      ctx.controller.abort();
      expect((await approve(ctx)).resultSummary).toBe("Commented on #4");
      const replyCtx = context();
      await stageComment(service, replyCtx, true, side);
      replyCtx.controller.abort();
      expect((await approve(replyCtx)).resultSummary).toBe(
        service === "github"
          ? "Replied to review comment on #4"
          : "Replied on review 13 of #4",
      );
      expect(
        fetch.mock.calls.map(([url, init]) => ({
          url: String(url),
          method: init?.method,
          body: JSON.parse(String(init?.body)),
          auth: new Headers(init?.headers).get("authorization"),
          aborted: init?.signal?.aborted,
        })),
      ).toEqual([
        {
          url: `${origin(service)}/repos/acme/app/issues/4/comments`,
          method: "POST",
          body: { body: "hello" },
          auth: authorization(service),
          aborted: false,
        },
        {
          url: `${origin(service)}/repos/acme/app/${service === "github" ? "pulls/4/comments/27/replies" : "pulls/4/reviews/13/comments"}`,
          method: "POST",
          body:
            service === "github"
              ? { body: "hello" }
              : {
                  path: "src/a.ts",
                  body: "hello",
                  ...(side === "LEFT"
                    ? { old_position: 9 }
                    : { new_position: 9 }),
                },
          auth: authorization(service),
          aborted: false,
        },
      ]);
      expect(invalidator(service)).not.toHaveBeenCalled();
    },
  );

  test.each([
    {},
    { html_url: "" },
    { html_url: "https://returned.invalid/close-comment" },
    null,
  ])(
    `${service} close shares timeline POST, but preserves tolerant comment response %j`,
    async (response) => {
      const ctx = context();
      let closed = false;
      const calls: Array<{ method: string; url: string; body?: unknown }> = [];
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input, init) => {
          const method = init?.method ?? "GET";
          calls.push({
            method,
            url: String(input),
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
          });
          if (method === "POST") return new Response(JSON.stringify(response));
          if (method === "PATCH") {
            closed = true;
            return new Response("{}");
          }
          return new Response(
            JSON.stringify({
              number: 4,
              state: closed ? "closed" : "open",
              head: {
                ref: "feature",
                sha: "head-1",
                repo: { full_name: "acme/app" },
              },
              base: { ref: "main" },
            }),
          );
        });
      const tool =
        service === "github"
          ? githubClosePullRequestTool
          : forgejoClosePullRequestTool;
      await tool.execute(
        { repo: "acme/app", number: 4, comment: "hello" },
        ctx,
      );
      expect(calls.map((c) => c.method)).toEqual(["GET"]);
      const card = await approve(ctx);
      expect(card.status).toBe("executed");
      expect(card.resultSummary).toContain("Posted the comment");
      expect(card.resultUrl).toBe(
        response?.html_url ||
          `https://${service === "github" ? "github.com/acme/app/pull/4" : "git.example.com/acme/app/pulls/4"}`,
      );
      expect(calls.map((c) => c.method)).toEqual([
        "GET",
        "GET",
        "POST",
        "GET",
        "PATCH",
        "GET",
      ]);
      expect(calls[2]).toEqual({
        method: "POST",
        url:
          service === "github"
            ? "https://api.github.com/repos/acme/app/issues/4/comments"
            : "https://git.example.com/api/v1/repos/acme/app/issues/4/comments",
        body: { body: "hello" },
      });
      expect(fetch).toHaveBeenCalledTimes(6);
      expect(invalidator(service)).toHaveBeenCalledTimes(1);
    },
  );
}

test.each(["github", "forgejo"] as const)(
  "%s close comment failure prevents PATCH but still invalidates inventory once",
  async (service) => {
    const ctx = context();
    const methods: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      methods.push(init?.method ?? "GET");
      return init?.method === "POST"
        ? new Response(JSON.stringify({ message: "comment rejected" }), {
            status: 422,
          })
        : new Response(
            JSON.stringify({
              number: 4,
              state: "open",
              head: { ref: "feature", sha: "h" },
              base: { ref: "main" },
            }),
          );
    });
    const tool =
      service === "github"
        ? githubClosePullRequestTool
        : forgejoClosePullRequestTool;
    await tool.execute({ repo: "acme/app", number: 4, comment: "hello" }, ctx);
    const card = await approve(ctx);
    expect(card.status).toBe("failed");
    expect(methods).toEqual(["GET", "GET", "POST"]);
    expect(invalidator(service)).toHaveBeenCalledTimes(1);
  },
);

test.each(["github", "forgejo"] as const)(
  "%s public generic methods retain explicit empty API URLs",
  async (service) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response('{"html_url":""}'),
    );
    const provider = hosting.hostingProviderFor({
      service,
      owner: "acme",
      repo: "app",
    });
    expect(await provider.submitPullRequestReview(4, {})).toEqual({ url: "" });
    expect(await provider.commentPullRequest(4, "hello")).toEqual({ url: "" });
    if (service === "github")
      expect(
        await provider.replyToPullRequestReviewComment!(4, 27, "hello"),
      ).toEqual({ url: "" });
    else
      expect(
        await provider.commentOnPullRequestReview!(4, 13, {
          path: "a.ts",
          line: 1,
          body: "hello",
        }),
      ).toEqual({ url: "" });
  },
);

const assignment = {
  repo: "acme/app",
  number: 4,
  addReviewers: ["alice"],
  addReviewerTeams: ["dev"],
  removeReviewers: ["bob"],
  removeReviewerTeams: ["ops"],
  addAssignees: ["carol"],
  removeAssignees: ["dave"],
};
const labels = [
  "request review: alice, team:dev",
  "cancel review request: bob, team:ops",
  "assign: carol",
  "unassign: dave",
];
const assignmentRequests = [
  {
    method: "POST",
    path: "/pulls/4/requested_reviewers",
    body: { reviewers: ["alice"], team_reviewers: ["dev"] },
  },
  {
    method: "DELETE",
    path: "/pulls/4/requested_reviewers",
    body: { reviewers: ["bob"], team_reviewers: ["ops"] },
  },
  {
    method: "POST",
    path: "/issues/4/assignees",
    body: { assignees: ["carol"] },
  },
  {
    method: "DELETE",
    path: "/issues/4/assignees",
    body: { assignees: ["dave"] },
  },
];

test.each([0, 1, 2, 3, 4])(
  "assignment failure at step %s preserves ordered payloads and confirmed suffix",
  async (failAt) => {
    const ctx = context();
    const calls: unknown[] = [];
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer gh-new",
        );
        expect(init?.signal?.aborted).toBe(false);
        calls.push({
          method: init?.method,
          path: String(input).replace(`${origin("github")}/repos/acme/app`, ""),
          body: JSON.parse(String(init?.body)),
        });
        return calls.length === failAt
          ? new Response(JSON.stringify({ message: "step rejected" }), {
              status: 422,
            })
          : new Response(
              JSON.stringify({
                html_url:
                  calls.length === 1
                    ? ""
                    : "https://returned.invalid/assignment",
              }),
            );
      });
    await githubAssignPullRequestTool.execute(assignment, ctx);
    expect(fetch).not.toHaveBeenCalled();
    newSettings();
    ctx.controller.abort();
    const card = await approve(ctx);
    expect(calls).toEqual(assignmentRequests.slice(0, failAt || 4));
    expect(invalidateGithubPullRequestWrite).toHaveBeenCalledTimes(1);
    if (failAt) {
      expect(card.status).toBe("failed");
      expect(card.error).toContain("step rejected");
      if (failAt === 1) expect(card.error).not.toContain("already applied");
      else
        expect(card.error).toContain(
          ` — already applied: ${labels.slice(0, failAt - 1).join("; ")}`,
        );
    } else {
      expect(card.status).toBe("executed");
      expect(card.resultSummary).toBe(`#4 — ${labels.join("; ")}`);
      expect(card.resultUrl).toBe("https://returned.invalid/assignment");
    }
  },
);

test.each([
  { addReviewers: ["alice"] },
  { addReviewerTeams: ["dev"] },
  { removeReviewerTeams: ["ops"] },
  { addAssignees: ["carol"] },
  { removeAssignees: ["dave"] },
])("assignment emits only populated lists %j", async (changes) => {
  const ctx = context();
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}"));
  await githubAssignPullRequestTool.execute(
    { repo: "acme/app", number: 4, ...changes },
    ctx,
  );
  const card = await approve(ctx);
  expect(card.status).toBe("executed");
  const expected = changes.addReviewers
    ? { reviewers: ["alice"] }
    : changes.addReviewerTeams
      ? { team_reviewers: ["dev"] }
      : changes.removeReviewerTeams
        ? { team_reviewers: ["ops"] }
        : changes.addAssignees
          ? { assignees: ["carol"] }
          : { assignees: ["dave"] };
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(expected);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each([undefined, "", "https://returned.invalid/one"])(
  "assignment URL selection retains absent/empty/present %s",
  async (url) => {
    const ctx = context();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(url === undefined ? {} : { html_url: url })),
    );
    await githubAssignPullRequestTool.execute(
      { repo: "acme/app", number: 4, addReviewers: ["alice"] },
      ctx,
    );
    expect((await approve(ctx)).resultUrl).toBe(url || undefined);
  },
);

test("each assignment request has its own 8-second deadline, with no overall deadline or retry", async () => {
  const ctx = context();
  const timers: AbortController[] = [];
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    expect(ms).toBe(8000);
    const controller = new AbortController();
    timers.push(controller);
    return controller.signal;
  });
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_input, init) => {
      if (timers.length < 3) return new Response("{}");
      const rejected = new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener(
          "abort",
          () =>
            reject(
              new Error("request aborted", { cause: init.signal?.reason }),
            ),
          { once: true },
        ),
      );
      timers.at(-1)!.abort(new DOMException("timed out", "TimeoutError"));
      return rejected;
    });
  await githubAssignPullRequestTool.execute(assignment, ctx);
  const card = await approve(ctx);
  expect(card.status).toBe("failed");
  expect(card.error).toContain(
    ` — already applied: ${labels.slice(0, 2).join("; ")}`,
  );
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(timers).toHaveLength(3);
  expect(new Set(fetch.mock.calls.map(([, init]) => init?.signal)).size).toBe(
    3,
  );
  expect(invalidateGithubPullRequestWrite).toHaveBeenCalledTimes(1);
});

for (const capability of [
  "updatePullRequestReviewers",
  "updatePullRequestAssignees",
  "replyToPullRequestReviewComment",
  "setPullRequestReviewThreadResolved",
  "commentOnPullRequestReview",
] as const) {
  test(`missing ${capability} fails before any write or fallback`, async () => {
    const service =
      capability === "commentOnPullRequestReview" ? "forgejo" : "github";
    const provider = hosting.hostingProviderFor({
      service,
      owner: "acme",
      repo: "app",
    });
    delete provider[capability];
    vi.spyOn(hosting, "hostingProviderFor").mockReturnValue(provider);
    const fetch = vi.spyOn(globalThis, "fetch");
    const ctx = context();
    if (capability.startsWith("update"))
      await githubAssignPullRequestTool.execute(assignment, ctx);
    else if (capability === "setPullRequestReviewThreadResolved")
      await githubResolveReviewThreadTool.execute(
        { repo: "acme/app", number: 4, threadId: "PRRT_one", resolved: true },
        ctx,
      );
    else await stageComment(service, ctx, true);
    const card = await approve(ctx);
    expect(card.status).toBe("failed");
    expect(card.error).toContain("does not support");
    expect(fetch).not.toHaveBeenCalled();
  });
}

test.each([false, true])(
  "thread inventory invalidates exactly once on failure=%s",
  async (fail) => {
    const ctx = context();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer gh-new",
        );
        expect(init?.signal?.aborted).toBe(false);
        if (fail)
          return new Response(
            JSON.stringify({ errors: [{ message: "no access" }] }),
          );
        const body = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            data: body.query.startsWith("query")
              ? {
                  node: {
                    __typename: "PullRequestReviewThread",
                    id: "PRRT_one",
                    isResolved: false,
                    pullRequest: {
                      number: 4,
                      repository: { nameWithOwner: "acme/app" },
                    },
                  },
                }
              : {
                  resolveReviewThread: {
                    thread: { id: "PRRT_one", isResolved: true },
                  },
                },
          }),
        );
      });
    await githubResolveReviewThreadTool.execute(
      { repo: "acme/app", number: 4, threadId: "PRRT_one", resolved: true },
      ctx,
    );
    expect(fetch).not.toHaveBeenCalled();
    newSettings();
    ctx.controller.abort();
    const card = await approve(ctx);
    expect(card.status).toBe(fail ? "failed" : "executed");
    expect(invalidateGithubPullRequestWrite).toHaveBeenCalledTimes(1);
  },
);

test.each(["github", "forgejo"] as const)(
  "%s settings failure preserves its existing invalidation boundary",
  async (service) => {
    const ctx = context();
    const fetch = vi.spyOn(globalThis, "fetch");
    await stageReview(service, ctx, "COMMENT");
    const getter =
      service === "github" ? getGithubToolConfig : getForgejoToolConfig;
    vi.mocked(getter).mockImplementation(() => {
      throw new Error("integration unavailable");
    });
    const card = await approve(ctx);
    expect(card.status).toBe("failed");
    expect(card.error).toContain("integration unavailable");
    expect(fetch).not.toHaveBeenCalled();
    expect(invalidator(service)).toHaveBeenCalledTimes(
      service === "github" ? 1 : 0,
    );
  },
);

test.each(["review", "timeline", "reply"] as const)(
  "Forgejo anonymous %s still attempts HTTP while close refuses before any read",
  async (operation) => {
    vi.mocked(getForgejoToolConfig).mockReturnValue({
      baseUrl: "https://git.example.com:8443/root",
      token: "",
    });
    const ctx = context();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        expect(String(input)).toContain(
          "https://git.example.com:8443/root/api/v1/",
        );
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        return new Response("{}");
      });
    if (operation === "review") await stageReview("forgejo", ctx, "COMMENT");
    else await stageComment("forgejo", ctx, operation === "reply");
    expect((await approve(ctx)).status).toBe("executed");
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockClear();
    const provider = hosting.hostingProviderFor({
      service: "forgejo",
      owner: "acme",
      repo: "app",
    });
    await expect(
      provider.closePullRequest(4, { expectedHeadSha: "h", comment: "hello" }),
    ).rejects.toThrow(/token/);
    expect(fetch).not.toHaveBeenCalled();
  },
);

test.each(["github", "forgejo"] as const)(
  "%s encodes repository parts and honors explicit parent cancellation",
  async (service) => {
    const parent = new AbortController();
    parent.abort();
    const provider = hosting.hostingProviderFor(
      { service, owner: "org name", repo: "repo#name" },
      parent.signal,
    );
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        expect(String(input)).toContain(
          "/repos/org%20name/repo%23name/issues/4/comments",
        );
        expect(init?.signal?.aborted).toBe(true);
        init?.signal?.throwIfAborted();
        throw new Error("unreachable");
      });
    await expect(provider.commentPullRequest(4, "hello")).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);
