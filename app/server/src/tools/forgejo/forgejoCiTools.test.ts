/**
 * The Forgejo CI tools, twin of the `github-ci` group. What is worth testing
 * here is where Forgejo does NOT behave like GitHub: `limit` the instance may
 * ignore, run numbers that are not run ids, and jobs that exist only as rows in
 * a repo-wide task feed — a reconstruction that must report "I could not see
 * that far back" rather than an empty job list, which reads as "nothing ran".
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ForgejoApiConfig } from "../../forgejoClient.ts";
import type { ToolCallContext } from "../../mcp/tool.ts";

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
  forgejoWatchPullRequestChecksTool,
  forgejoGetRefChecksTool,
  forgejoListActionsRunsTool,
  forgejoGetActionsRunTool,
} = await import("./forgejoCiTools.ts");

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

/** Route stubbed answers by URL fragment, in declaration order. */
function routedFetch(routes: Array<[string, () => Response]>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const route = routes.find(([fragment]) => url.includes(fragment));
    if (!route) throw new Error(`unexpected request: ${url}`);
    return route[1]();
  });
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

describe("forgejo_watch_pull_request_checks", () => {
  test("reports a clean open PR as mergeable now", async () => {
    const fetchMock = routedFetch([
      ["/pulls/12/reviews", () => jsonResponse([])],
      [
        "/pulls/12",
        () =>
          jsonResponse({
            number: 12,
            title: "Add checks",
            state: "open",
            merged: false,
            mergeable: true,
            head: { ref: "feature", sha: "abc123" },
            base: { ref: "main" },
          }),
      ],
      [
        "/commits/abc123/status",
        () =>
          jsonResponse(
            {
              sha: "abc123",
              statuses: [{ context: "ci", status: "success" }],
            },
            { "x-total-count": "1" },
          ),
      ],
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const payload = parse(
      await forgejoWatchPullRequestChecksTool.execute(
        { repo: "acme/app", number: 12 },
        ctxFor("pr-green"),
      ),
    );
    expect(payload.checks.state).toBe("success");
    expect(payload.canMergeNow).toBe(true);
    expect(payload.mergeBlockers).toEqual([]);
  });

  test("returns the failed status run URL as the Forgejo log handoff", async () => {
    const fetchMock = routedFetch([
      ["/pulls/12/reviews", () => jsonResponse([])],
      [
        "/pulls/12",
        () =>
          jsonResponse({
            number: 12,
            title: "Add checks",
            state: "open",
            merged: false,
            mergeable: true,
            head: { ref: "feature", sha: "abc123" },
            base: { ref: "main" },
          }),
      ],
      [
        "/commits/abc123/status",
        () =>
          jsonResponse(
            {
              sha: "abc123",
              statuses: [
                {
                  context: "ci / test",
                  status: "failure",
                  target_url: "/acme/app/actions/runs/12",
                  description: "tests failed",
                },
              ],
            },
            { "x-total-count": "1" },
          ),
      ],
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const payload = parse(
      await forgejoWatchPullRequestChecksTool.execute(
        { repo: "acme/app", number: 12 },
        ctxFor("pr-checks"),
      ),
    );
    expect(payload.checks.state).toBe("failure");
    expect(payload.checks.finished).toBe(true);
    expect(payload.checks.failedChecks[0].url).toBe(
      "https://git.example.com/acme/app/actions/runs/12",
    );
    expect(payload.checks.failureLinks).toEqual([
      "https://git.example.com/acme/app/actions/runs/12",
    ]);
    expect(payload.canMergeNow).toBe(false);
    expect(payload.mergeBlockers).toContain("checks_failed");
  });
});

describe("forgejo_get_ref_checks", () => {
  test("rolls the ref's statuses into one state without asking for history", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          sha: "0123456789abcdef",
          statuses: [
            {
              context: "ci / build",
              status: "failure",
              target_url: "/acme/app/actions/runs/12",
              description: "build failed",
            },
            { context: "ci / lint", status: "success" },
          ],
        },
        { "x-total-count": "2" },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const payload = parse(
      await forgejoGetRefChecksTool.execute(
        { repo: "acme/app", ref: "main" },
        ctxFor("checks"),
      ),
    );
    const urls = urlsFrom(fetchMock);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/api/v1/repos/acme/app/commits/main/status");
    expect(payload.state).toBe("failure");
    expect(payload.total).toBe(2);
    expect(payload.sha).toBe("0123456789abcdef");
    // Absolute, so the link works away from the instance's own pages.
    expect(payload.url).toBe(
      "https://git.example.com/acme/app/actions/runs/12",
    );
    expect(payload.statuses).toHaveLength(2);
    // Only ever present when true: its absence IS "this is the whole answer".
    expect(payload.truncated).toBeUndefined();
    expect(payload.history).toBeUndefined();
  });

  test("includeHistory adds the superseded rows from the statuses endpoint", async () => {
    const fetchMock = routedFetch([
      [
        "/commits/main/statuses",
        () =>
          jsonResponse([
            {
              context: "ci / build",
              status: "success",
              created_at: "2026-08-06T10:05:00Z",
            },
            {
              context: "ci / build",
              status: "pending",
              created_at: "2026-08-06T10:00:00Z",
            },
          ]),
      ],
      [
        "/commits/main/status",
        () =>
          jsonResponse({
            sha: "abc",
            statuses: [{ context: "ci / build", status: "success" }],
          }),
      ],
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const payload = parse(
      await forgejoGetRefChecksTool.execute(
        { repo: "acme/app", ref: "main", includeHistory: true },
        ctxFor("checks-history"),
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(payload.state).toBe("success");
    expect(payload.history).toHaveLength(2);
    expect(payload.history[0].state).toBe("success");
    expect(payload.history[1].createdAt).toBe("2026-08-06T10:00:00Z");
  });

  test("an empty ref rejects before any request", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      forgejoGetRefChecksTool.execute(
        { repo: "acme/app", ref: "   " },
        ctxFor("checks-empty"),
      ),
    ).rejects.toThrow(/non-empty branch/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("forgejo_list_actions_runs", () => {
  test("passes every filter through and compacts the runs", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        total_count: 447,
        workflow_runs: [
          {
            id: 981,
            index_in_repo: 447,
            title: "Add CI tools",
            workflow_id: "ci.yml",
            prettyref: "main",
            commit_sha: "0123456789abcdef0123",
            event: "push",
            status: "failure",
            trigger_user: { login: "alice" },
            html_url: "/acme/app/actions/runs/447",
            started: "2026-08-06T10:00:00Z",
          },
        ],
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const payload = parse(
      await forgejoListActionsRunsTool.execute(
        {
          repo: "acme/app",
          ref: "main",
          headSha: "0123456789abcdef0123",
          event: "push",
          status: "failure",
          workflowId: "ci.yml",
          runNumber: 447,
          maxResults: 5,
        },
        ctxFor("runs"),
      ),
    );
    const url = new URL(urlsFrom(fetchMock)[0]!);
    expect(url.pathname).toBe("/api/v1/repos/acme/app/actions/runs");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ref: "main",
      head_sha: "0123456789abcdef0123",
      event: "push",
      status: "failure",
      workflow_id: "ci.yml",
      run_number: "447",
      limit: "5",
    });
    expect(payload.totalCount).toBe(447);
    const run = payload.runs[0];
    // The run's id and its per-repo number are different numbers; both survive.
    expect(run.id).toBe(981);
    expect(run.runNumber).toBe(447);
    expect(run.headSha).toBe("0123456789ab");
    expect(run.actor).toBe("alice");
    expect(run.url).toBe("https://git.example.com/acme/app/actions/runs/447");
  });

  test("an instance that ignores `limit` is cut back client-side", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        total_count: 3,
        workflow_runs: [
          { id: 3, index_in_repo: 3 },
          { id: 2, index_in_repo: 2 },
          { id: 1, index_in_repo: 1 },
        ],
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const payload = parse(
      await forgejoListActionsRunsTool.execute(
        { repo: "acme/app", maxResults: 2 },
        ctxFor("runs-slice"),
      ),
    );
    expect(payload.runs).toHaveLength(2);
    expect(payload.returned).toBe(2);
    expect(payload.maxResults).toBe(2);
    // The full count is still reported, so the cut is visible rather than silent.
    expect(payload.totalCount).toBe(3);
  });
});

describe("forgejo_get_actions_run", () => {
  /** A repo-wide task feed page of exactly `TASK_PAGE_SIZE` rows. */
  function taskPage(runNumbers: number[]) {
    return jsonResponse({
      workflow_runs: runNumbers.map((runNumber, index) => ({
        id: 1000 + index,
        name: `job-${runNumber}-${index}`,
        run_number: runNumber,
        workflow_id: "ci.yml",
        status: "success",
        run_started_at: "2026-08-06T10:00:00Z",
      })),
    });
  }

  const runBody = (fields: Record<string, unknown> = {}) =>
    jsonResponse({
      id: 981,
      index_in_repo: 446,
      workflow_id: "ci.yml",
      status: "failure",
      html_url: "/acme/app/actions/runs/446",
      ...fields,
    });

  test("recovers the run's jobs from the task feed, oldest first", async () => {
    const fetchMock = routedFetch([
      // Feed order is newest task first, so the run's own jobs come back reversed.
      [
        "/actions/tasks",
        () =>
          jsonResponse({
            workflow_runs: [
              { id: 2, name: "test", run_number: 446, status: "failure" },
              { id: 1, name: "build", run_number: 446, status: "success" },
              { id: 0, name: "build", run_number: 445, status: "success" },
            ],
          }),
      ],
      ["/actions/runs/", () => runBody()],
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const payload = parse(
      await forgejoGetActionsRunTool.execute(
        { repo: "acme/app", runId: 981 },
        ctxFor("run"),
      ),
    );
    expect(payload.run.runNumber).toBe(446);
    expect(payload.run.jobs.map((job: { name: string }) => job.name)).toEqual([
      "build",
      "test",
    ]);
    expect(payload.run.jobs[1].status).toBe("failure");
    expect(payload.run.jobsNote).toBeUndefined();
  });

  test("keeps scanning past a page that still straddles the run", async () => {
    // Adjacent runs interleave in the feed, so the first row below the target is
    // NOT the end of its jobs: only a page entirely below it can stop the scan.
    const pages = [
      taskPage(Array(50).fill(447)),
      taskPage([446, 447, 446, ...Array(47).fill(445)]),
      taskPage(Array(50).fill(445)),
    ];
    let page = 0;
    const fetchMock = routedFetch([
      ["/actions/tasks", () => pages[page++]!],
      ["/actions/runs/", () => runBody()],
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const payload = parse(
      await forgejoGetActionsRunTool.execute(
        { repo: "acme/app", runId: 981 },
        ctxFor("run-interleaved"),
      ),
    );
    expect(page).toBe(3);
    expect(payload.run.jobs).toHaveLength(2);
    // The third page closed the window, so these two ARE the run's jobs.
    expect(payload.run.jobsNote).toBeUndefined();
  });

  test("jobs found with the budget ending mid-window are offered as partial", async () => {
    // Every page still straddles run 446, so the scan stops on the budget rather
    // than on evidence — the jobs it collected may not be all of them, and a
    // silent partial list is exactly what a caller cannot detect.
    let page = 0;
    const fetchMock = routedFetch([
      [
        "/actions/tasks",
        () => (page++, taskPage([446, ...Array(49).fill(447)])),
      ],
      ["/actions/runs/", () => runBody()],
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const payload = parse(
      await forgejoGetActionsRunTool.execute(
        { repo: "acme/app", runId: 981 },
        ctxFor("run-budget-mid-window"),
      ),
    );
    expect(page).toBe(4);
    expect(payload.run.jobs).toHaveLength(4);
    expect(payload.run.jobsNote).toMatch(/may be incomplete/);
    expect(payload.run.jobsNote).toMatch(/200-task scan ended inside run 446/);
  });

  test("a truncated partial list carries both notes at once", async () => {
    const fetchMock = routedFetch([
      ["/actions/tasks", () => taskPage([446, 446, ...Array(48).fill(447)])],
      ["/actions/runs/", () => runBody()],
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const payload = parse(
      await forgejoGetActionsRunTool.execute(
        { repo: "acme/app", runId: 981, maxJobs: 3 },
        ctxFor("run-budget-and-max-jobs"),
      ),
    );
    expect(payload.run.jobs).toHaveLength(3);
    expect(payload.run.jobsNote).toMatch(/Showing 3 of 8 jobs/);
    expect(payload.run.jobsNote).toMatch(/may be incomplete/);
  });

  test("a run past the scan budget is unavailable, never an empty job list", async () => {
    const fetchMock = routedFetch([
      ["/actions/tasks", () => taskPage(Array(50).fill(900))],
      ["/actions/runs/", () => runBody()],
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const payload = parse(
      await forgejoGetActionsRunTool.execute(
        { repo: "acme/app", runId: 981 },
        ctxFor("run-too-old"),
      ),
    );
    // Four task pages plus the run itself.
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(payload.run.jobs).toBeUndefined();
    expect(payload.run.jobsNote).toMatch(/Jobs unavailable/);
    expect(payload.run.jobsNote).toMatch(/200-task scan/);
  });

  test("a run the scan really did reach reports no jobs, and says so", async () => {
    const fetchMock = routedFetch([
      [
        "/actions/tasks",
        () =>
          jsonResponse({
            workflow_runs: [
              { id: 1, name: "build", run_number: 447 },
              { id: 0, name: "build", run_number: 445 },
            ],
          }),
      ],
      ["/actions/runs/", () => runBody()],
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const payload = parse(
      await forgejoGetActionsRunTool.execute(
        { repo: "acme/app", runId: 981 },
        ctxFor("run-no-jobs"),
      ),
    );
    expect(payload.run.jobs).toBeUndefined();
    expect(payload.run.jobsNote).toBe("No jobs are recorded for this run.");
  });

  test("maxJobs truncates and names the rest", async () => {
    const fetchMock = routedFetch([
      [
        "/actions/tasks",
        () =>
          jsonResponse({
            workflow_runs: [
              { id: 3, name: "c", run_number: 446 },
              { id: 2, name: "b", run_number: 446 },
              { id: 1, name: "a", run_number: 446 },
            ],
          }),
      ],
      ["/actions/runs/", () => runBody()],
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const payload = parse(
      await forgejoGetActionsRunTool.execute(
        { repo: "acme/app", runId: 981, maxJobs: 2 },
        ctxFor("run-max-jobs"),
      ),
    );
    expect(payload.run.jobs.map((job: { name: string }) => job.name)).toEqual([
      "a",
      "b",
    ]);
    expect(payload.run.jobsNote).toBe(
      "Showing 2 of 3 jobs; raise maxJobs for the rest.",
    );
  });

  test("includeJobs: false skips the task feed entirely and explains nothing", async () => {
    const fetchMock = routedFetch([["/actions/runs/", () => runBody()]]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const payload = parse(
      await forgejoGetActionsRunTool.execute(
        { repo: "acme/app", runId: 981, includeJobs: false },
        ctxFor("run-no-job-fetch"),
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(payload.run.jobs).toBeUndefined();
    // The caller asked for this, so a note would be noise.
    expect(payload.run.jobsNote).toBeUndefined();
  });

  test("a run without a run number cannot be matched to tasks, and says which", async () => {
    const fetchMock = routedFetch([
      ["/actions/runs/", () => runBody({ index_in_repo: undefined })],
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const payload = parse(
      await forgejoGetActionsRunTool.execute(
        { repo: "acme/app", runId: 981 },
        ctxFor("run-no-number"),
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(payload.run.jobsNote).toMatch(/no run number/);
  });
});
