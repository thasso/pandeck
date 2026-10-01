import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { GithubApiConfig } from "../../githubClient.ts";
import type {
  ApprovalCard as ApprovalCardData,
  GithubIssueApprovalBody,
} from "@assistant/shared";

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
// Importing the tools module also registers the "githubIssue" approval executor.
const { githubMutateIssueTool } = await import("./githubIssueWriteTools.ts");
const { resolveApproval, approvalsForSession, setApprovalBroadcastForTests } =
  await import("../../pendingApprovals.ts");

// A distinct token per file: the client caches `/user` and ETags per token.
const config: GithubApiConfig = {
  token: "ghp_issue_writes",
  apiBaseUrl: "https://api.github.com",
};
const originalFetch = globalThis.fetch;

const ctxFor = (sessionId: string) => ({
  toolCallId: "c",
  session: {
    sessionId,
    harness: "pi" as const,
    agentType: "assistant" as const,
  },
  signal: new AbortController().signal,
});
const latest = (sessionId: string) => approvalsForSession(sessionId).at(-1)!;
const bodyOf = (sessionId: string) =>
  latest(sessionId).body as GithubIssueApprovalBody;

type Call = { method: string; path: string; body: unknown };

/** Route fetches by `METHOD path` prefix; unmatched requests fail the test. */
function mockGithub(routes: Record<string, (call: Call) => Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const call = {
        method: init?.method ?? "GET",
        path: url.pathname,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const key = Object.keys(routes).find((route) =>
        `${call.method} ${call.path}`.startsWith(route),
      );
      if (!key) throw new Error(`unexpected ${call.method} ${call.path}`);
      return routes[key]!(call);
    },
  ) as unknown as typeof fetch;
  return calls;
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const repoLabels = () => json([{ name: "bug" }, { name: "Needs Triage" }]);

beforeEach(() => {
  vi.mocked(getGithubToolConfig).mockReturnValue(config);
  setApprovalBroadcastForTests(() => {});
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  setApprovalBroadcastForTests(null);
  vi.clearAllMocks();
});

describe("github_mutate_issue", () => {
  test("create stages a card, maps label casing, flags new labels, and writes only once approved", async () => {
    const sessionId = "issue-create";
    const calls = mockGithub({
      "GET /repos/acme/app/labels": repoLabels,
      "POST /repos/acme/app/issues": () =>
        json({
          number: 12,
          html_url: "https://github.com/acme/app/issues/12",
          labels: [
            { name: "bug" },
            { name: "Needs Triage" },
            { name: "flaky" },
          ],
          assignees: [],
        }),
    });

    const result = await githubMutateIssueTool.execute(
      {
        repo: "acme/app",
        operation: "create",
        title: " Crash on start ",
        body: "Steps",
        labels: ["BUG", "needs triage", "flaky"],
      },
      ctxFor(sessionId) as never,
    );
    expect(result.terminate).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
    expect(bodyOf(sessionId)).toMatchObject({
      kind: "githubIssue",
      operation: "create",
      title: "Crash on start",
      labels: ["bug", "Needs Triage", "flaky"],
      newLabels: ["flaky"],
    });
    expect(latest(sessionId).kind).toBe("githubIssue");

    const { card } = await resolveApproval(latest(sessionId).id, "approved");
    expect(card.status).toBe("executed");
    expect(card.resultSummary).toBe("Created acme/app#12");
    expect(card.resultUrl).toBe("https://github.com/acme/app/issues/12");
    expect(calls.at(-1)).toMatchObject({
      method: "POST",
      body: {
        title: "Crash on start",
        body: "Steps",
        labels: ["bug", "Needs Triage", "flaky"],
      },
    });
  });

  test("label on a pull request adds, removes, and treats an absent label as removed", async () => {
    const sessionId = "issue-label";
    const calls = mockGithub({
      "GET /repos/acme/app/labels": repoLabels,
      "POST /repos/acme/app/issues/7/labels": () => json([{ name: "bug" }]),
      "DELETE /repos/acme/app/issues/7/labels/Needs%20Triage": () =>
        json({ message: "Label does not exist" }, 404),
      "GET /repos/acme/app/issues/7": () =>
        json({ number: 7, labels: [{ name: "bug" }] }),
    });

    await githubMutateIssueTool.execute(
      {
        repo: "acme/app",
        operation: "label",
        number: 7,
        addLabels: ["bug"],
        removeLabels: ["Needs Triage"],
      },
      ctxFor(sessionId) as never,
    );
    expect(latest(sessionId).title).toBe("Change labels on acme/app#7");
    const { card } = await resolveApproval(latest(sessionId).id, "approved");
    expect(card.status).toBe("executed");
    expect(card.resultSummary).toBe(
      "acme/app#7 — add label bug; remove label Needs Triage",
    );
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /repos/acme/app/labels",
      "POST /repos/acme/app/issues/7/labels",
      "DELETE /repos/acme/app/issues/7/labels/Needs%20Triage",
      "GET /repos/acme/app/issues/7",
    ]);
    expect(invalidateGithubPullRequestWrite).toHaveBeenCalledWith(
      "acme",
      "app",
      7,
    );
  });

  test("edit closes as not planned, resolves @me, and names the steps that landed before a failure", async () => {
    const sessionId = "issue-edit";
    const calls = mockGithub({
      "GET /user": () => json({ login: "alice" }),
      "PATCH /repos/acme/app/issues/3": () => json({ state: "closed" }),
      "POST /repos/acme/app/issues/3/assignees": () =>
        json({ message: "boom" }, 422),
    });

    await githubMutateIssueTool.execute(
      {
        repo: "acme/app",
        operation: "edit",
        number: 3,
        state: "closed",
        stateReason: "not_planned",
        addAssignees: ["@me"],
      },
      ctxFor(sessionId) as never,
    );
    expect(bodyOf(sessionId).addAssignees).toEqual(["alice"]);
    expect(latest(sessionId).summary).toBe(
      "close (not planned) · assign alice",
    );
    const { card } = await resolveApproval(latest(sessionId).id, "approved");
    expect(card.status).toBe("failed");
    expect(card.error).toContain("HTTP 422");
    expect(card.error).toContain("already applied: close (not planned)");
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
      state: "closed",
      state_reason: "not_planned",
    });
  });

  test("a 2xx that silently ignored an assignment fails the card and names what landed", async () => {
    const sessionId = "issue-ignored-assign";
    mockGithub({
      "PATCH /repos/acme/app/issues/5": () => json({ state: "open" }),
      "POST /repos/acme/app/issues/5/assignees": () =>
        json({ number: 5, assignees: [] }),
    });
    await githubMutateIssueTool.execute(
      {
        repo: "acme/app",
        operation: "edit",
        number: 5,
        title: "Renamed",
        addAssignees: ["octo"],
      },
      ctxFor(sessionId) as never,
    );
    const { card } = await resolveApproval(latest(sessionId).id, "approved");
    expect(card.status).toBe("failed");
    expect(card.error).toContain("did not assign octo");
    expect(card.error).toContain("already applied: retitle");
  });

  test("an unassignment GitHub ignored is a failure, not a success", async () => {
    const sessionId = "issue-ignored-unassign";
    mockGithub({
      "DELETE /repos/acme/app/issues/5/assignees": () =>
        json({ number: 5, assignees: [{ login: "Octo" }] }),
    });
    await githubMutateIssueTool.execute(
      {
        repo: "acme/app",
        operation: "edit",
        number: 5,
        removeAssignees: ["octo"],
      },
      ctxFor(sessionId) as never,
    );
    const { card } = await resolveApproval(latest(sessionId).id, "approved");
    expect(card.status).toBe("failed");
    expect(card.error).toContain("did not unassign octo");
  });

  test("a create whose labels or assignees GitHub dropped stays executed with a warning", async () => {
    const sessionId = "issue-create-dropped";
    mockGithub({
      "GET /repos/acme/app/labels": repoLabels,
      "POST /repos/acme/app/issues": () =>
        json({ number: 13, labels: [], assignees: [] }),
    });
    await githubMutateIssueTool.execute(
      {
        repo: "acme/app",
        operation: "create",
        title: "T",
        labels: ["bug"],
        assignees: ["octo"],
      },
      ctxFor(sessionId) as never,
    );
    const { card } = await resolveApproval(latest(sessionId).id, "approved");
    expect(card.status).toBe("executed");
    expect(card.resultSummary).toMatch(
      /^Created acme\/app#13; warning: GitHub did not apply label bug, assignee octo/,
    );
  });

  test("a label-removal 404 counts as removed only when the issue is readable without that label", async () => {
    const run = async (
      sessionId: string,
      issue: () => Response,
    ): Promise<ApprovalCardData> => {
      mockGithub({
        "DELETE /repos/acme/app/issues/8/labels/wip": () =>
          json({ message: "Not Found" }, 404),
        "GET /repos/acme/app/issues/8": issue,
      });
      await githubMutateIssueTool.execute(
        {
          repo: "acme/app",
          operation: "label",
          number: 8,
          removeLabels: ["wip"],
        },
        ctxFor(sessionId) as never,
      );
      return (await resolveApproval(latest(sessionId).id, "approved")).card;
    };
    expect(
      (await run("label-404-absent", () => json({ labels: [] }))).status,
    ).toBe("executed");
    const deleted = await run("label-404-gone", () =>
      json({ message: "Not Found" }, 404),
    );
    expect(deleted.status).toBe("failed");
    expect(deleted.error).toContain("HTTP 404");
    const stillThere = await run("label-404-present", () =>
      json({ labels: [{ name: "WIP" }] }),
    );
    expect(stillThere.status).toBe("failed");
  });

  test("a dot-only label cannot be removed, since the URL would address another endpoint", async () => {
    mockGithub({});
    for (const name of [".", ".."])
      await expect(
        githubMutateIssueTool.execute(
          {
            repo: "acme/app",
            operation: "label",
            number: 1,
            removeLabels: [name],
          },
          ctxFor("label-dots") as never,
        ),
      ).rejects.toThrow(/only dots/);
    expect(approvalsForSession("label-dots")).toEqual([]);
  });

  test("comment posts to the issue timeline after approval", async () => {
    const sessionId = "issue-comment";
    mockGithub({
      "POST /repos/acme/app/issues/9/comments": (call) => {
        expect(call.body).toEqual({ body: "Fixed in #10" });
        return json({
          html_url: "https://github.com/acme/app/issues/9#c1",
        });
      },
    });
    await githubMutateIssueTool.execute(
      {
        repo: "acme/app",
        operation: "comment",
        number: 9,
        comment: " Fixed in #10 ",
      },
      ctxFor(sessionId) as never,
    );
    const { card } = await resolveApproval(latest(sessionId).id, "approved");
    expect(card.resultSummary).toBe("Commented on acme/app#9");
    expect(card.resultUrl).toBe("https://github.com/acme/app/issues/9#c1");
  });

  test("proposals missing their substance are refused before any card", async () => {
    const sessionId = "issue-invalid";
    mockGithub({});
    const run = (params: Record<string, unknown>) =>
      githubMutateIssueTool.execute(
        { repo: "acme/app", ...params } as never,
        ctxFor(sessionId) as never,
      );
    await expect(run({ operation: "edit" })).rejects.toThrow(/number/);
    await expect(run({ operation: "edit", number: 1 })).rejects.toThrow(
      /at least one field/,
    );
    await expect(run({ operation: "label", number: 1 })).rejects.toThrow(
      /at least one label/,
    );
    await expect(
      run({ operation: "edit", number: 1, stateReason: "completed" }),
    ).rejects.toThrow(/state: closed/);
    await expect(run({ operation: "create", title: " " })).rejects.toThrow(
      /title/,
    );
    await expect(
      run({ operation: "comment", number: 1, comment: "" }),
    ).rejects.toThrow(/comment text/);
    expect(approvalsForSession(sessionId)).toEqual([]);
  });
});
