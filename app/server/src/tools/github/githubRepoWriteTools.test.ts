import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { GithubApiConfig } from "../../githubClient.ts";
import type { GithubBranchDeleteApprovalBody } from "@assistant/shared";

vi.mock("../../githubSettings.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../githubSettings.ts")>()),
  getGithubToolConfig: vi.fn(),
  getGithubDefaultOwner: vi.fn(() => ""),
}));

const { getGithubToolConfig } = await import("../../githubSettings.ts");
// Importing the tools module also registers the "githubBranchDelete" executor.
const { githubRerunActionsRunTool, githubDeleteBranchTool } =
  await import("./githubRepoWriteTools.ts");
const { resolveApproval, approvalsForSession, setApprovalBroadcastForTests } =
  await import("../../pendingApprovals.ts");

const config: GithubApiConfig = {
  token: "ghp_repo_writes",
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

type Call = { method: string; path: string; search: string; body: unknown };

/** Route fetches by exact `METHOD path`; unmatched requests fail the test. */
function mockGithub(routes: Record<string, (call: Call) => Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const call = {
        method: init?.method ?? "GET",
        path: url.pathname,
        search: url.search,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const route = routes[`${call.method} ${call.path}`];
      if (!route) throw new Error(`unexpected ${call.method} ${call.path}`);
      return route(call);
    },
  ) as unknown as typeof fetch;
  return calls;
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const runJson = (status: string, conclusion: string | null) => () =>
  json({
    id: 55,
    status,
    conclusion,
    run_attempt: 1,
    head_branch: "feature",
    html_url: "https://github.com/acme/app/actions/runs/55",
  });

beforeEach(() => {
  vi.mocked(getGithubToolConfig).mockReturnValue(config);
  setApprovalBroadcastForTests(() => {});
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  setApprovalBroadcastForTests(null);
  vi.clearAllMocks();
});

describe("github_rerun_actions_run", () => {
  test("re-runs a failed run's failed jobs immediately", async () => {
    const calls = mockGithub({
      "GET /repos/acme/app/actions/runs/55": runJson("completed", "failure"),
      "POST /repos/acme/app/actions/runs/55/rerun-failed-jobs": () =>
        new Response(null, { status: 201 }),
    });
    const result = await githubRerunActionsRunTool.execute(
      { repo: "acme/app", runId: 55 },
      ctxFor("rerun") as never,
    );
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      repo: "acme/app",
      runId: 55,
      rerun: "failed-jobs",
      previousConclusion: "failure",
      newAttempt: 2,
      headBranch: "feature",
      url: "https://github.com/acme/app/actions/runs/55",
    });
    expect(calls).toHaveLength(2);
    expect(approvalsForSession("rerun")).toEqual([]);
  });

  test("a job id or failedOnly: false picks the matching endpoint", async () => {
    const calls = mockGithub({
      "GET /repos/acme/app/actions/runs/55": runJson("completed", "success"),
      "GET /repos/acme/app/actions/jobs/9": () =>
        json({ id: 9, run_id: 55, status: "completed" }),
      "POST /repos/acme/app/actions/jobs/9/rerun": () =>
        new Response(null, { status: 201 }),
      "POST /repos/acme/app/actions/runs/55/rerun": () =>
        new Response(null, { status: 201 }),
    });
    await githubRerunActionsRunTool.execute(
      { repo: "acme/app", runId: 55, jobId: 9 },
      ctxFor("rerun-job") as never,
    );
    await githubRerunActionsRunTool.execute(
      { repo: "acme/app", runId: 55, failedOnly: false },
      ctxFor("rerun-all") as never,
    );
    expect(
      calls.filter((call) => call.method === "POST").map((call) => call.path),
    ).toEqual([
      "/repos/acme/app/actions/jobs/9/rerun",
      "/repos/acme/app/actions/runs/55/rerun",
    ]);
  });

  test("a job from another run, or one still running, is refused without a write", async () => {
    const calls = mockGithub({
      "GET /repos/acme/app/actions/runs/55": runJson("completed", "failure"),
      "GET /repos/acme/app/actions/jobs/9": () =>
        json({ id: 9, run_id: 77, status: "completed" }),
      "GET /repos/acme/app/actions/jobs/10": () =>
        json({ id: 10, run_id: 55, status: "in_progress" }),
    });
    const run = (jobId: number) =>
      githubRerunActionsRunTool.execute(
        { repo: "acme/app", runId: 55, jobId },
        ctxFor("rerun-foreign-job") as never,
      );
    await expect(run(9)).rejects.toThrow(/belongs to run 77, not run 55/);
    await expect(run(10)).rejects.toThrow(/still in_progress/);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  test("refuses a run still in progress, and failed-jobs of a green run", async () => {
    mockGithub({
      "GET /repos/acme/app/actions/runs/55": runJson("in_progress", null),
    });
    await expect(
      githubRerunActionsRunTool.execute(
        { repo: "acme/app", runId: 55 },
        ctxFor("rerun-busy") as never,
      ),
    ).rejects.toThrow(/still in_progress/);
    mockGithub({
      "GET /repos/acme/app/actions/runs/55": runJson("completed", "success"),
    });
    await expect(
      githubRerunActionsRunTool.execute(
        { repo: "acme/app", runId: 55 },
        ctxFor("rerun-green") as never,
      ),
    ).rejects.toThrow(/no failed jobs/);
  });
});

describe("github_delete_branch", () => {
  const repo = () => json({ default_branch: "main", node_id: "R_app" });
  /** The `updateRefs` input a GraphQL call carried. */
  const refUpdatesOf = (call: Call) =>
    (call.body as { variables: { input: Record<string, unknown> } }).variables
      .input;
  const branch =
    (sha: string, isProtected = false) =>
    () =>
      json({ protected: isProtected, commit: { sha } });

  test("stages a card listing open PRs and deletes the proposed revision only after approval", async () => {
    const sessionId = "branch-delete";
    const calls = mockGithub({
      "GET /repos/acme/app": repo,
      "GET /repos/acme/app/branches/feat/old": branch("a".repeat(40)),
      "GET /repos/acme/app/pulls": (call) =>
        json(
          call.search.includes("head=")
            ? [
                {
                  number: 4,
                  title: "Old work",
                  html_url: "https://github.com/acme/app/pull/4",
                },
              ]
            : [],
        ),
      "POST /graphql": () =>
        json({ data: { updateRefs: { clientMutationId: null } } }),
    });
    await githubDeleteBranchTool.execute(
      { repo: "acme/app", branches: ["refs/heads/feat/old"] },
      ctxFor(sessionId) as never,
    );
    const card = latest(sessionId);
    expect(card.kind).toBe("githubBranchDelete");
    expect(card.title).toBe("Delete branch feat/old");
    expect((card.body as GithubBranchDeleteApprovalBody).items).toEqual([
      {
        branch: "feat/old",
        headSha: "a".repeat(40),
        openPullRequests: [
          {
            number: 4,
            title: "Old work",
            url: "https://github.com/acme/app/pull/4",
            role: "head",
          },
        ],
      },
    ]);
    expect(calls.some((call) => call.path === "/graphql")).toBe(false);

    const { card: done } = await resolveApproval(card.id, "approved");
    expect(done.status).toBe("executed");
    expect(done.resultSummary).toBe("Deleted feat/old in acme/app");
    const deletes = calls.filter((call) => call.path === "/graphql");
    expect(deletes.map(refUpdatesOf)).toEqual([
      {
        repositoryId: "R_app",
        refUpdates: [
          {
            name: "refs/heads/feat/old",
            beforeOid: "a".repeat(40),
            afterOid: "0".repeat(40),
            force: true,
          },
        ],
      },
    ]);
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  test("a push landing between the executor's read and the delete is rejected by the atomic check", async () => {
    const sessionId = "branch-race";
    const proposed = "a".repeat(40);
    // GitHub's ref: the executor's preflight still reads the proposed tip,
    // then a push lands before the delete arrives.
    let tip = proposed;
    const calls = mockGithub({
      "GET /repos/acme/app": repo,
      "GET /repos/acme/app/branches/topic": () => {
        const answer = json({ protected: false, commit: { sha: tip } });
        if (approvalsForSession(sessionId).length) tip = "b".repeat(40);
        return answer;
      },
      "GET /repos/acme/app/pulls": () => json([]),
      "POST /graphql": (call) => {
        const update = (
          refUpdatesOf(call).refUpdates as Array<{ beforeOid: string }>
        )[0]!;
        return update.beforeOid === tip
          ? json({ data: { updateRefs: { clientMutationId: null } } })
          : json({
              data: null,
              errors: [{ message: "A ref was updated since beforeOid" }],
            });
      },
    });
    await githubDeleteBranchTool.execute(
      { repo: "acme/app", branches: ["topic"] },
      ctxFor(sessionId) as never,
    );
    const { card } = await resolveApproval(latest(sessionId).id, "approved");
    expect(card.status).toBe("failed");
    expect(card.error).toContain("updated since beforeOid");
    expect(tip).toBe("b".repeat(40));
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  test("a branch that moved while the card waited is left alone", async () => {
    const sessionId = "branch-moved";
    let sha = "a".repeat(40);
    const calls = mockGithub({
      "GET /repos/acme/app": repo,
      "GET /repos/acme/app/branches/topic": () =>
        json({ protected: false, commit: { sha } }),
      "GET /repos/acme/app/pulls": () => json([]),
    });
    await githubDeleteBranchTool.execute(
      { repo: "acme/app", branches: ["topic"] },
      ctxFor(sessionId) as never,
    );
    sha = "b".repeat(40);
    const { card } = await resolveApproval(latest(sessionId).id, "approved");
    expect(card.status).toBe("failed");
    expect(card.error).toContain("moved to bbbbbbbbbbbb");
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  test("refuses the default branch, protected branches, and missing ones", async () => {
    mockGithub({
      "GET /repos/acme/app": repo,
      "GET /repos/acme/app/branches/release": branch("c".repeat(40), true),
      "GET /repos/acme/app/branches/gone": () =>
        json({ message: "Branch not found" }, 404),
    });
    const run = (name: string) =>
      githubDeleteBranchTool.execute(
        { repo: "acme/app", branches: [name] },
        ctxFor("branch-refused") as never,
      );
    await expect(run("main")).rejects.toThrow(/default branch/);
    await expect(run("release")).rejects.toThrow(/protected branch/);
    await expect(run("gone")).rejects.toThrow(/does not exist/);
    expect(approvalsForSession("branch-refused")).toEqual([]);
  });
});
