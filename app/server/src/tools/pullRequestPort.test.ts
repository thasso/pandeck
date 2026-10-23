import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  getGithubToolConfig,
  getGithubDefaultOwner,
} from "../githubSettings.ts";
import {
  getForgejoToolConfig,
  getForgejoDefaultOwner,
} from "../forgejoSettings.ts";
import {
  invalidateGithubPullRequestWrite,
  invalidateForgejoPullRequestWrite,
} from "../pullRequestInventorySync.ts";
import {
  approvalsForSession,
  resolveApproval,
  setApprovalBroadcastForTests,
} from "../pendingApprovals.ts";
import {
  githubCreatePullRequestTool,
  githubEditPullRequestTool,
} from "./github/githubPrWriteTools.ts";
import {
  forgejoCreatePullRequestTool,
  forgejoEditPullRequestTool,
} from "./forgejo/forgejoPrWriteTools.ts";

vi.mock("../githubSettings.ts", async (importActual) => ({
  ...(await importActual<typeof import("../githubSettings.ts")>()),
  getGithubToolConfig: vi.fn(),
  getGithubDefaultOwner: vi.fn(() => "acme"),
}));
vi.mock("../forgejoSettings.ts", async (importActual) => ({
  ...(await importActual<typeof import("../forgejoSettings.ts")>()),
  getForgejoToolConfig: vi.fn(),
  getForgejoDefaultOwner: vi.fn(() => "acme"),
}));
vi.mock("../pullRequestInventorySync.ts", async (importActual) => ({
  ...(await importActual<typeof import("../pullRequestInventorySync.ts")>()),
  invalidateGithubPullRequestWrite: vi.fn(),
  invalidateForgejoPullRequestWrite: vi.fn(),
}));

let sequence = 0;
const context = () => ({
  toolCallId: "port",
  session: {
    sessionId: `port-${++sequence}`,
    harness: "pi" as const,
    agentType: "developer" as const,
  },
  signal: new AbortController().signal,
});
const latest = (id: string) => approvalsForSession(id).at(-1)!;
const cases = [
  {
    service: "github",
    create: githubCreatePullRequestTool,
    edit: githubEditPullRequestTool,
    invalidate: invalidateGithubPullRequestWrite,
    canonical: "https://github.com/acme/app/pull/4",
  },
  {
    service: "forgejo",
    create: forgejoCreatePullRequestTool,
    edit: forgejoEditPullRequestTool,
    invalidate: invalidateForgejoPullRequestWrite,
    canonical: "https://git.example.com/acme/app/pulls/4",
  },
] as const;

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

for (const entry of cases) {
  test.each([false, true])(
    `${entry.service} generic create retains exact payload and approval-time settings, draft=%s`,
    async (draft) => {
      const ctx = context();
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input, init) => {
          expect(String(input)).toBe(
            entry.service === "github"
              ? "https://new-api.example.invalid/repos/acme/app/pulls"
              : "https://new-forgejo.example.invalid:8443/root/api/v1/repos/acme/app/pulls",
          );
          expect(new Headers(init?.headers).get("authorization")).toBe(
            entry.service === "github" ? "Bearer gh-new" : "token fj-new",
          );
          expect(JSON.parse(String(init?.body))).toEqual({
            title: entry.service === "forgejo" && draft ? "WIP: T" : "T",
            head: "feature",
            base: "main",
            body: "",
            ...(entry.service === "github" ? { draft } : {}),
          });
          return new Response(
            JSON.stringify({
              number: 4,
              html_url: "https://api-returned.example.invalid/pr/4",
            }),
          );
        });
      await entry.create.execute(
        { repo: "app", title: " T ", head: " feature ", base: " main ", draft },
        ctx,
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(
        entry.service === "github"
          ? getGithubDefaultOwner
          : getForgejoDefaultOwner,
      ).toHaveBeenCalled();
      vi.mocked(getGithubToolConfig).mockReturnValue({
        token: "gh-new",
        apiBaseUrl: "https://new-api.example.invalid",
      });
      vi.mocked(getForgejoToolConfig).mockReturnValue({
        token: "fj-new",
        baseUrl: "https://new-forgejo.example.invalid:8443/root",
      });
      // The proposal signal is not retained after approval.
      ctx.signal = AbortSignal.abort();
      const { card } = await resolveApproval(
        latest(ctx.session.sessionId).id,
        "approved",
      );
      expect(card.status).toBe("executed");
      expect(card.resultSummary).toBe("Opened pull request #4");
      expect(card.resultUrl).toBe("https://api-returned.example.invalid/pr/4");
      expect(card.body).toHaveProperty("resultNumber", 4);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(entry.invalidate).toHaveBeenCalled();
    },
  );

  test(`${entry.service} create tolerates missing number and URL without a new result envelope`, async () => {
    const ctx = context();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await entry.create.execute(
      { repo: "acme/app", title: "T", head: "feature", base: "main" },
      ctx,
    );
    const { card } = await resolveApproval(
      latest(ctx.session.sessionId).id,
      "approved",
    );
    expect(card.status).toBe("executed");
    expect(card.resultSummary).toBe("Opened pull request");
    expect(card.resultUrl).toBeUndefined();
    expect(card.body).not.toHaveProperty("resultNumber");
    expect(entry.invalidate).toHaveBeenLastCalledWith(
      ...(entry.service === "github"
        ? ["acme", "app", undefined]
        : ["https://git.example.com", "acme", "app", undefined]),
    );
  });

  test.each([undefined, "https://api-returned.example.invalid/edit/4"])(
    `${entry.service} body-only edit preserves URL override or fallback: %s`,
    async (url) => {
      const ctx = context();
      const calls: unknown[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
        if (init?.method === "GET")
          return new Response(JSON.stringify({ body: "old" }));
        calls.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify(url ? { html_url: url } : {}));
      });
      await entry.edit.execute({ repo: "acme/app", number: 4, body: "" }, ctx);
      const { card } = await resolveApproval(
        latest(ctx.session.sessionId).id,
        "approved",
      );
      expect(card.status).toBe("executed");
      expect(calls).toEqual([{ body: "" }]);
      expect(card.resultSummary).toBe("Updated description on #4");
      expect(card.resultUrl).toBe(url ?? entry.canonical);
    },
  );

  test.each([false, true])(
    `${entry.service} retarget precedes body and reports partial failure=%s`,
    async (failBody) => {
      const ctx = context();
      const calls: unknown[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
        if (init?.method === "GET") return new Response("{}");
        const body = JSON.parse(String(init?.body));
        calls.push(body);
        return failBody && "body" in body
          ? new Response(JSON.stringify({ message: "body rejected" }), {
              status: 422,
            })
          : new Response("{}");
      });
      await entry.edit.execute(
        { repo: "acme/app", number: 4, base: "release", body: "new" },
        ctx,
      );
      const { card } = await resolveApproval(
        latest(ctx.session.sessionId).id,
        "approved",
      );
      expect(calls).toEqual([{ base: "release" }, { body: "new" }]);
      expect(card.status).toBe(failBody ? "failed" : "executed");
      if (failBody)
        expect(card.error).toContain(
          "already applied: Retargeted #4 onto release",
        );
      else
        expect(card.resultSummary).toBe(
          "Retargeted #4 onto release; Updated description on #4",
        );
      expect(entry.invalidate).toHaveBeenCalled();
    },
  );

  test.each(["create", "edit"] as const)(
    `${entry.service} %s deadline can lose a remotely accepted response, fails without retry and invalidates`,
    async (operation) => {
      const ctx = context();
      let deadline: AbortController | undefined;
      const timeout = vi
        .spyOn(AbortSignal, "timeout")
        .mockImplementation((ms) => {
          expect(ms).toBe(8000);
          deadline = new AbortController();
          return deadline.signal;
        });
      let accepted = 0;
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (_input, init) => {
          if (init?.method === "GET") return new Response("{}");
          accepted += 1;
          // The remote applied the write but the response never reached the client.
          expect(init?.signal).toBe(deadline!.signal);
          return await new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener(
              "abort",
              () =>
                reject(
                  new Error("The operation was aborted due to timeout", {
                    cause: init!.signal!.reason,
                  }),
                ),
              { once: true },
            );
            deadline!.abort(
              new DOMException(
                "The operation was aborted due to timeout",
                "TimeoutError",
              ),
            );
          });
        });
      if (operation === "create")
        await entry.create.execute(
          { repo: "acme/app", title: "T", head: "feature", base: "main" },
          ctx,
        );
      else
        await entry.edit.execute(
          { repo: "acme/app", number: 4, body: "new" },
          ctx,
        );
      const { card } = await resolveApproval(
        latest(ctx.session.sessionId).id,
        "approved",
      );
      expect(card.status).toBe("failed");
      expect(card.error).toContain("timeout");
      expect(card.resultSummary).toBeUndefined();
      if (operation === "create")
        expect(card.body).not.toHaveProperty("resultNumber");
      expect(accepted).toBe(1);
      expect(fetch).toHaveBeenCalledTimes(operation === "create" ? 1 : 2);
      expect(timeout).toHaveBeenCalled();
      expect(entry.invalidate).toHaveBeenCalledTimes(1);
    },
  );

  test(`${entry.service} rejected creation never reaches the provider`, async () => {
    const ctx = context();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("must not write"));
    await entry.create.execute(
      { repo: "acme/app", title: "T", head: "feature", base: "main" },
      ctx,
    );
    const { card } = await resolveApproval(
      latest(ctx.session.sessionId).id,
      "rejected",
    );
    expect(card.status).toBe("rejected");
    expect(fetch).not.toHaveBeenCalled();
    expect(entry.invalidate).not.toHaveBeenCalled();
  });
}
