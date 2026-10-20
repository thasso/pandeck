import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ToolCallContext, ToolResult } from "../mcp/tool.ts";
import { sessionStore } from "../db/sessionStore.ts";
import { backgroundWorkStore } from "../db/backgroundWorkStore.ts";
import { sessionArtifactFile } from "../mcp/toolGroups/packRuntime.ts";
import { getSettings, updateSettings } from "../settings.ts";
import { backgroundWorkSupervisor } from "../backgroundWork/supervisor.ts";

vi.mock("../githubSettings.ts", async (actual) => ({
  ...(await actual<typeof import("../githubSettings.ts")>()),
  getGithubToolConfig: () => ({
    apiBaseUrl: "https://api.github.com",
    token: "ref-wait-test",
  }),
  getGithubDefaultOwner: () => "",
}));
vi.mock("../forgejoSettings.ts", async (actual) => ({
  ...(await actual<typeof import("../forgejoSettings.ts")>()),
  getForgejoToolConfig: () => ({
    baseUrl: "https://git.example.com",
    token: "ref-wait-test",
  }),
  getForgejoDefaultOwner: () => "",
  getForgejoBaseUrl: () => "https://git.example.com",
}));
const { githubGetRefChecksTool } = await import("./github/githubTools.ts");
const { forgejoGetRefChecksTool } = await import("./forgejo/forgejoCiTools.ts");
const originalFetch = globalThis.fetch;
let serial = 0;
function context(): ToolCallContext {
  const sessionId = `ref-wait-${++serial}`;
  sessionStore.upsert({
    id: sessionId,
    scope: "user",
    harness: "pi",
    agentType: "developer",
  });
  return {
    toolCallId: `call-${serial}`,
    session: { sessionId, harness: "pi", agentType: "developer" },
    signal: new AbortController().signal,
  };
}
function body(result: ToolResult) {
  return JSON.parse(
    result.content[0]!.type === "text" ? result.content[0]!.text : "{}",
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

describe.each([
  { provider: "GitHub", tool: githubGetRefChecksTool, interval: 30 },
  { provider: "Forgejo", tool: forgejoGetRefChecksTool, interval: 5 },
])("$provider ref waits", ({ provider, tool, interval }) => {
  function mock(
    states: string[],
    options: {
      total?: number;
      head?: (poll: number) => string;
      remaining?: number;
    } = {},
  ) {
    let polls = 0;
    let histories = 0;
    const signals: (AbortSignal | null | undefined)[] = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      signals.push(init?.signal);
      const headers =
        options.remaining === undefined
          ? {}
          : {
              "x-ratelimit-remaining": String(options.remaining),
              "x-ratelimit-reset": "9999999999",
            };
      if (url.includes("/statuses")) {
        histories++;
        return new Response("[]", { headers });
      }
      if (url.includes("/check-runs"))
        return new Response(JSON.stringify({ check_runs: [] }), { headers });
      const state = states[Math.min(polls, states.length - 1)]!;
      const sha = options.head?.(polls) ?? "abcdef123456";
      polls++;
      const statuses =
        state === "empty" ? [] : [{ context: "ci", state, status: state }];
      return new Response(
        JSON.stringify({
          sha,
          statuses,
          total_count: options.total ?? statuses.length,
        }),
        {
          headers: {
            ...headers,
            "x-total-count": String(options.total ?? statuses.length),
          },
        },
      );
    }) as typeof fetch;
    return { polls: () => polls, histories: () => histories, signals };
  }
  const params = { repo: "acme/app", ref: "main" };
  test("waits past pending, reports progress, and finishes on the shared verdict", async () => {
    const fetch = mock(["pending", "success"]);
    const progress = vi.fn();
    const result = tool.execute(
      { ...params, wait: true, pollIntervalSeconds: interval },
      { ...context(), progress },
    );
    await vi.advanceTimersByTimeAsync(interval * 1000);
    expect(body(await result)).toMatchObject({
      state: "success",
      finished: true,
      observation: {
        mode: "wait",
        stopReason: "checks_finished",
        polls: 2,
        pollIntervalSeconds: interval,
        headSha: "abcdef123456",
      },
    });
    expect(fetch.polls()).toBe(2);
    expect(progress).toHaveBeenCalledOnce();
  });
  test("empty ref retains raw neutral and resets grace when its head moves", async () => {
    mock(["empty"], { head: (poll) => (poll === 0 ? "old" : "new") });
    const result = tool.execute(
      { ...params, wait: true, pollIntervalSeconds: 60 },
      context(),
    );
    await vi.advanceTimersByTimeAsync(180_000);
    expect(body(await result)).toMatchObject({
      state: "neutral",
      finished: false,
      observation: {
        stopReason: "no_checks",
        elapsedSeconds: 180,
        headSha: "new",
      },
    });
  });
  test("a pending wait times out with the last snapshot", async () => {
    mock(["pending"]);
    const result = tool.execute(
      { ...params, wait: true, timeoutSeconds: 30 },
      context(),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(body(await result)).toMatchObject({
      state: "pending",
      finished: false,
      observation: { stopReason: "timeout", timeoutSeconds: 30 },
    });
  });
  test("truncated and already-finished observations return inline without admission", async () => {
    for (const [state, total, reason] of [
      ["pending", 2, "checks_truncated"],
      ["success", 1, "checks_finished"],
    ] as const) {
      mock([state], { total });
      const ctx = context();
      expect(
        body(await tool.execute({ ...params, background: true }, ctx)),
      ).toMatchObject({
        observation: { mode: "background", stopReason: reason },
      });
      expect(
        backgroundWorkStore.listItems({
          ownerSessionId: ctx.session.sessionId,
          limit: 5,
        }),
      ).toHaveLength(0);
    }
  });
  test("background continues the first observation on its own signal and keeps the foreground payload", async () => {
    mock(["pending", "success"]);
    const foreground = tool.execute(
      { ...params, wait: true, pollIntervalSeconds: interval },
      context(),
    );
    await vi.advanceTimersByTimeAsync(interval * 1000);
    const expected = body(await foreground);
    const fetch = mock(["pending", "success"]);
    const abort = new AbortController();
    const ctx = { ...context(), signal: abort.signal };
    const started = body(
      await tool.execute(
        { ...params, background: true, pollIntervalSeconds: interval },
        ctx,
      ),
    );
    expect(started).toMatchObject({
      taskId: expect.any(String),
      state: "running",
    });
    expect(fetch.polls()).toBe(1);
    abort.abort();
    await vi.advanceTimersByTimeAsync(interval * 1000);
    await vi.waitFor(() =>
      expect(backgroundWorkStore.getItem(started.taskId)?.state).toBe(
        "completed",
      ),
    );
    const row = backgroundWorkStore.getItem(started.taskId)!;
    expect(row).toMatchObject({
      backend: "server-task",
      kind: "check-watch",
      label: `${provider} checks acme/app@main`,
      outcomeSummary: "Checks finished: success, 1 check on abcdef1",
    });
    const file = sessionArtifactFile(
      ctx.session.sessionId,
      row.evidence!.artifactId!,
    );
    const artifact = JSON.parse(readFileSync(file!.path, "utf8"));
    artifact.observation.mode = "wait";
    expect(artifact).toEqual(expected);
    expect(
      fetch.signals
        .slice(provider === "GitHub" ? 2 : 1)
        .every((s) => !s?.aborted),
    ).toBe(true);
  });
  test("Stop ends a background ref wait without another provider poll", async () => {
    const fetch = mock(["pending"]);
    const ctx = context();
    const started = body(
      await tool.execute({ ...params, background: true }, ctx),
    );
    await backgroundWorkSupervisor.stopOne({
      itemId: started.taskId,
      ownerSessionId: ctx.session.sessionId,
      sourceRequestId: "stop-ref",
      reason: "test Stop",
    });
    expect(backgroundWorkStore.getItem(started.taskId)?.state).toBe("stopped");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch.polls()).toBe(1);
  });
  test("background uses the frozen Settings budget, before the deadline Stop", async () => {
    const before = getSettings().backgroundWork;
    updateSettings({ backgroundWork: { ...before, taskLifetimeMinutes: 5 } });
    try {
      mock(["pending"]);
      const ctx = context();
      const started = body(
        await tool.execute(
          { ...params, background: true, timeoutSeconds: 600 },
          ctx,
        ),
      );
      await vi.advanceTimersByTimeAsync(240_000);
      await vi.waitFor(() =>
        expect(backgroundWorkStore.getItem(started.taskId)?.state).toBe(
          "completed",
        ),
      );
      const row = backgroundWorkStore.getItem(started.taskId)!;
      expect(row.stopOrigin).toBeUndefined();
      const artifact = JSON.parse(
        readFileSync(
          sessionArtifactFile(ctx.session.sessionId, row.evidence!.artifactId!)!
            .path,
          "utf8",
        ),
      );
      expect(artifact.observation).toMatchObject({
        timeoutSeconds: 240,
        stopReason: "timeout",
      });
    } finally {
      updateSettings({ backgroundWork: before });
    }
  });
  test("Forgejo history is read only at the end; GitHub stops at low rate budget", async () => {
    const fetch = mock(
      ["pending", "success"],
      provider === "GitHub" ? { remaining: 499 } : {},
    );
    const result = tool.execute(
      {
        ...params,
        wait: true,
        includeHistory: true,
        pollIntervalSeconds: interval,
      },
      context(),
    );
    await vi.advanceTimersByTimeAsync(interval * 1000);
    expect(body(await result).observation.stopReason).toBe(
      provider === "GitHub" ? "rate_limited" : "checks_finished",
    );
    expect(fetch.histories()).toBe(provider === "GitHub" ? 0 : 1);
  });
});
