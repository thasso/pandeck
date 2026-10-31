import { afterEach, expect, test, vi } from "vitest";
import type { ApprovalCard, PullRequestCard } from "@assistant/shared";
import type { WorktreeRow } from "../../db/worktreeStore.ts";
import type { GitHostingProvider } from "../../gitHosting.ts";
import type { ToolCallContext } from "../../mcp/tool.ts";
import type { ServerTaskBudget, ServerTaskLaunch } from "../../serverTasks.ts";
import { ManagedFinishRefusedError } from "../../managedFinishRefusal.ts";
import { mergePullRequestAndProject } from "../../pullRequestMerge.ts";
import { evaluatePullRequestReadiness } from "../pullRequestCheckWatch.ts";
import {
  createWorktreeFinishPullRequestTool,
  managedMergeCore,
  type WorktreeFinishPullRequestOperations,
} from "./worktreeFinishPullRequest.ts";
import { createMergeWhenReadyRunner } from "./mergeWhenReady.ts";
import { DEFAULT_WORKER_SIDE } from "../../workers/placement.ts";

const head = "c".repeat(40);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const row: WorktreeRow = {
    id: "wt",
    projectId: "p",
    path: "/repo/wt",
    mainRepoRoot: "/repo",
    branch: "feature",
    baseBranch: "release",
    baseCommit: "abc",
    status: "active",
    mergeStateJson: null,
    createdAt: 1,
    updatedAt: 1,
    removedAt: null,
  };
  const detail = {
    number: 42,
    state: "open" as const,
    merged: false,
    mergeable: true,
    draft: false,
    headSha: head,
    headBranch: "feature",
    baseBranch: "release",
  };
  const ready = () =>
    evaluatePullRequestReadiness(
      { ...detail },
      {
        state: "success",
        total: 1,
        checks: [{ name: "ci", status: "success" }],
      },
      { changesRequested: false },
    );
  const pending = () =>
    evaluatePullRequestReadiness(
      { ...detail },
      {
        state: "pending",
        total: 1,
        checks: [{ name: "ci", status: "pending" }],
      },
      { changesRequested: false },
    );
  const provider = {
    kind: "github",
    repoWebUrl: "https://github.com/a/b",
    repository: { host: "github.com", owner: "a", repo: "b" },
    findPullRequestsForBranch: vi.fn(async () => ({
      open: [
        {
          number: 42,
          url: "https://github.com/a/b/pull/42",
          title: "PR",
          state: "open",
        },
      ],
    })),
    pullRequestDetail: vi.fn(async () => ({ ...detail })),
  } as unknown as GitHostingProvider;
  const card: PullRequestCard = {
    renderKind: "pullRequest",
    id: "card",
    sessionId: "owner",
    provider: "github",
    status: "open",
    number: 42,
    url: provider.repoWebUrl + "/pull/42",
    headBranch: "feature",
    baseBranch: "release",
    worktreeId: "wt",
    title: "PR",
    warnings: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const release = vi.fn();
  const ops: WorktreeFinishPullRequestOperations = {
    resolve: vi.fn(async () => row),
    reserve: vi.fn(() => release),
    localState: vi.fn(async () => ({ branch: row.branch, head, clean: true })),
    target: vi.fn(async () => ({
      side: DEFAULT_WORKER_SIDE,
      repoRoot: "/repo",
      remote: "origin",
      upstream: { remote: "origin", branch: row.branch },
    })),
    remoteHead: vi.fn(async () => head),
    hosting: vi.fn(async () => ({
      provider,
      repository: provider.repository!,
    })),
    capabilities: vi.fn(async () => ({
      defaultBranch: "main",
      mergeMethods: ["squash" as const],
    })),
    readiness: vi.fn(async () => pending()),
    cards: vi.fn(async () => [card]),
    merge: vi.fn(async (input) => {
      input.beforeProviderWrite?.();
      return {
        result: {
          outcome: "merged" as const,
          number: 42,
          method: "squash" as const,
          branchDeleted: true,
        },
        cardIds: ["card"],
        taskSuggestions: [],
        message: "Merged #42",
      };
    }),
    approve: vi.fn(
      (input) =>
        ({
          id: "approval",
          autoApproved: false,
          ...input,
        }) as unknown as ApprovalCard,
    ),
    followUps: vi.fn(async () => ({ warnings: [] })),
    close: vi.fn(),
    taskIds: () => [],
    task: () => undefined,
    invalidate: vi.fn(),
    projectReady: vi.fn(),
    projectRetarget: vi.fn(),
    inventoryChanged: vi.fn(),
  };
  const ctx: ToolCallContext = {
    toolCallId: "call",
    session: {
      sessionId: "owner",
      harness: "pi",
      agentType: "developer",
      cwd: row.path,
    },
  };
  const params = {
    worktreeId: "wt",
    action: "merge" as const,
    method: "squash" as const,
    whenReady: true,
  };
  let launchInput!: ServerTaskLaunch;
  let state: "running" | "completed" = "running";
  const launch = vi.fn(async (input: ServerTaskLaunch) => {
    launchInput = input;
    return { taskId: "job", state, hint: "job" };
  });
  const sleep = vi.fn(async (ms: number, signal?: AbortSignal) => {
    if (signal?.aborted) throw signal.reason;
    vi.setSystemTime(Date.now() + ms);
  });
  const run = createMergeWhenReadyRunner({
    core: managedMergeCore,
    launch,
    sleep,
    itemState: () => state,
  });
  const budget: ServerTaskBudget = {
    itemId: "job",
    timeoutMs: 1800_000,
    deadlineAt: Date.now() + 1860_000,
    signal: new AbortController().signal,
    commit: vi.fn(),
  };
  return {
    row,
    detail,
    card,
    ready,
    pending,
    ops,
    release,
    provider,
    ctx,
    params,
    launch,
    sleep,
    run,
    budget,
    job: () => launchInput.run(budget),
    input: () => launchInput,
    terminal: () => {
      state = "completed";
    },
  };
}
function payload(result: { content: unknown }) {
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
}
afterEach(() => vi.useRealTimers());
function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  return fixture();
}

test("distinct calls without tool ids get concurrency wording, not retry wording", async () => {
  const f = setup();
  vi.mocked(f.ops.readiness).mockResolvedValue(f.ready());
  const gate = deferred<void>();
  vi.mocked(f.ops.resolve).mockImplementationOnce(async () => {
    await gate.promise;
    return f.row;
  });
  const ctx: ToolCallContext = { ...f.ctx, toolCallId: "" };
  const first = f.run(f.params, ctx, f.ops);
  const second = f.run(f.params, ctx, f.ops).catch((error: unknown) => error);
  gate.resolve();
  const concurrent = await second;
  await first;
  expect(concurrent).toMatchObject({
    message: expect.stringContaining("for this worktree is starting"),
  });
});

test("pending admits immediately with no reservation, then commits exactly once through the core", async () => {
  const f = setup();
  const result = payload(
    await f.run({ ...f.params, removeWorktree: true }, f.ctx, f.ops),
  );
  expect(result).toMatchObject({
    status: "waiting",
    taskId: "job",
    waitingFor: ["checks_pending"],
  });
  expect(result.message).toContain("this session is settled");
  expect(f.ops.reserve).not.toHaveBeenCalled();
  expect(f.input()).toMatchObject({
    kind: "merge-when-ready",
    sourceTool: "worktree_finish_pull_request",
  });
  vi.mocked(f.ops.readiness).mockImplementation(async () => f.ready());
  const ended = await f.job();
  expect(ended.payload).toMatchObject({
    status: "merged",
    whenReady: { endedBy: "ready", mode: "background" },
  });
  expect(f.budget.commit).toHaveBeenCalledTimes(1);
  expect(f.ops.reserve).toHaveBeenCalledWith("wt", "owner", expect.any(String));
  expect(f.ops.followUps).toHaveBeenCalledWith(
    expect.objectContaining({
      exemptBackgroundItem: { itemId: "job", ownerSessionId: "owner" },
      removeWorktree: true,
    }),
  );
  expect(f.release).toHaveBeenCalledTimes(1);
});

test("terminal first observations and inline completion both release STARTING", async () => {
  const f = setup();
  const red = f.ready();
  red.canMergeNow = false;
  red.mergeBlockers = ["checks_failed"];
  vi.mocked(f.ops.readiness).mockResolvedValueOnce(red);
  await expect(f.run(f.params, f.ctx, f.ops)).rejects.toThrow(
    "not ready to merge: checks_failed",
  );
  expect(f.launch).not.toHaveBeenCalled();
  vi.mocked(f.ops.readiness).mockResolvedValue(f.ready());
  vi.mocked(f.ops.merge).mockImplementationOnce(async () => {
    vi.setSystemTime(Date.now() + 120_000);
    return {
      result: {
        outcome: "merged" as const,
        number: 42,
        method: "squash" as const,
        branchDeleted: true,
      },
      cardIds: [],
      taskSuggestions: [],
      message: "Merged",
    };
  });
  expect(
    payload(await f.run({ ...f.params, timeoutSeconds: 30 }, f.ctx, f.ops))
      .status,
  ).toBe("merged");
  vi.mocked(f.ops.readiness).mockResolvedValue(f.pending());
  expect(payload(await f.run(f.params, f.ctx, f.ops)).status).toBe("waiting");
});

test("ready and idle is byte-identical to foreground and never launches", async () => {
  const f = setup();
  vi.mocked(f.ops.readiness).mockImplementation(async () => f.ready());
  const ordinary = await createWorktreeFinishPullRequestTool(f.ops).execute(
    { ...f.params, whenReady: false },
    f.ctx,
  );
  const inline = await f.run(f.params, f.ctx, f.ops);
  expect(inline).toEqual(ordinary);
  expect(f.ops.hosting).toHaveBeenLastCalledWith(
    expect.anything(),
    f.ctx.signal,
    undefined,
  );
  expect(f.launch).not.toHaveBeenCalled();
});

test("green but busy launches and retries with the requester, without retaining a reservation", async () => {
  const f = setup();
  vi.mocked(f.ops.readiness).mockImplementation(async () => f.ready());
  vi.mocked(f.ops.reserve).mockReturnValueOnce(undefined);
  expect(payload(await f.run(f.params, f.ctx, f.ops)).status).toBe("waiting");
  expect((await f.job()).payload).toMatchObject({ status: "merged" });
  expect(f.ops.hosting).toHaveBeenLastCalledWith(
    expect.anything(),
    f.budget.signal,
    f.budget.signal,
  );
});

test.each([false, true])(
  "default base stages a ready-time card for requester, grant=%s",
  async (grant) => {
    const f = setup();
    f.detail.baseBranch = "main";
    f.row.baseBranch = "main";
    f.card.baseBranch = "main";
    vi.mocked(f.ops.approve).mockImplementation((input) => {
      expect(f.budget.commit).toHaveBeenCalledTimes(1);
      expect(input.sessionId).toBe("owner");
      expect(input.sourceToolCallId).toBeUndefined();
      return {
        id: "approval",
        title: input.title,
        autoApproved: grant,
      } as ApprovalCard;
    });
    await f.run(f.params, f.ctx, f.ops);
    expect(f.ops.approve).not.toHaveBeenCalled();
    vi.mocked(f.ops.readiness).mockImplementation(async () => f.ready());
    expect((await f.job()).payload).toMatchObject({
      status: "approval-pending",
      autoApproved: grant,
    });
    expect(f.ops.merge).not.toHaveBeenCalled();
  },
);

test.each([
  "checks_failed",
  "changes_requested",
  "draft",
  "provider_not_mergeable",
  "checks_inconclusive",
  "checks_truncated",
  "head_moved",
  "closed",
  "retargeted",
])("poll ends without a write on %s", async (reason) => {
  const f = setup();
  await f.run(f.params, f.ctx, f.ops);
  const snapshot = f.ready();
  if (reason === "head_moved") snapshot.detail.headSha = "d".repeat(40);
  else if (reason === "closed") snapshot.detail.state = "closed";
  else if (reason === "retargeted") snapshot.detail.baseBranch = "main";
  else {
    snapshot.mergeBlockers = [reason];
    snapshot.canMergeNow = false;
    if (reason === "checks_truncated") snapshot.checks.truncated = true;
  }
  vi.mocked(f.ops.readiness).mockResolvedValue(snapshot);
  const result = (await f.job()).payload;
  expect(result).toMatchObject({
    status: "not-merged",
    merged: false,
    whenReady: {
      endedBy:
        (
          {
            provider_not_mergeable: "not_mergeable",
            retargeted: "pull_request_changed",
            closed: "pull_request_not_open",
          } as Record<string, string>
        )[reason] ?? reason,
    },
  });
  expect(f.ops.merge).not.toHaveBeenCalled();
  expect(f.ops.approve).not.toHaveBeenCalled();
  expect(f.budget.commit).not.toHaveBeenCalled();
});

test("no checks grace and wait deadline both end without merging", async () => {
  const f = setup();
  await f.run(f.params, f.ctx, f.ops);
  vi.mocked(f.ops.readiness).mockResolvedValue(
    evaluatePullRequestReadiness(
      f.detail,
      { state: "none", total: 0, checks: [] },
      { changesRequested: false },
    ),
  );
  expect((await f.job()).payload).toMatchObject({
    whenReady: { endedBy: "no_checks" },
  });
  const g = setup();
  await g.run(g.params, g.ctx, g.ops);
  g.budget.timeoutMs = 30_000;
  expect((await g.job()).payload).toMatchObject({
    whenReady: { endedBy: "timeout" },
  });
});

test("a green observation at the deadline never gets a reservation", async () => {
  const f = setup();
  await f.run(f.params, f.ctx, f.ops);
  f.budget.timeoutMs = 30_000;
  vi.mocked(f.ops.readiness).mockImplementation(async () => f.ready());
  expect((await f.job()).payload).toMatchObject({
    whenReady: { endedBy: "timeout" },
  });
  expect(f.ops.reserve).not.toHaveBeenCalled();
});

test("deadline crossing during the final read blocks the outward request", async () => {
  const f = setup();
  await f.run(f.params, f.ctx, f.ops);
  vi.mocked(f.ops.readiness).mockImplementation(async () => f.ready());
  vi.mocked(f.ops.merge).mockImplementation(async (input) => {
    vi.setSystemTime(3_000_000);
    input.beforeProviderWrite?.();
    throw new Error("must not write");
  });
  expect((await f.job()).payload).toMatchObject({
    whenReady: { endedBy: "timeout", observedBy: "final-check" },
  });
  expect(f.budget.commit).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledTimes(1);
});

test("Stop during sleep or before the outward hook prevents commit", async () => {
  for (const atHook of [false, true]) {
    const f = setup();
    const controller = new AbortController();
    f.budget.signal = controller.signal;
    f.budget.commit = vi.fn(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
    });
    await f.run(f.params, f.ctx, f.ops);
    if (!atHook) controller.abort(new Error("Stop"));
    else {
      vi.mocked(f.ops.readiness).mockImplementation(async () => f.ready());
      vi.mocked(f.ops.merge).mockImplementation(async (input) => {
        controller.abort(new Error("Stop"));
        input.beforeProviderWrite?.();
        throw new Error("must not write");
      });
    }
    await expect(f.job()).rejects.toThrow("Stop");
  }
});

test("final readiness terminal is reported, nonterminal retries, plain provider errors fail", async () => {
  const f = setup();
  await f.run(f.params, f.ctx, f.ops);
  const red = f.ready();
  red.canMergeNow = false;
  red.mergeBlockers = ["changes_requested"];
  vi.mocked(f.ops.readiness)
    .mockResolvedValueOnce(f.ready())
    .mockResolvedValueOnce(red);
  expect((await f.job()).payload).toMatchObject({
    whenReady: { endedBy: "changes_requested", observedBy: "final-check" },
  });
  expect(f.ops.merge).not.toHaveBeenCalled();
  const g = setup();
  await g.run(g.params, g.ctx, g.ops);
  vi.mocked(g.ops.readiness)
    .mockResolvedValueOnce(g.ready())
    .mockResolvedValueOnce(g.pending())
    .mockResolvedValue(g.ready());
  expect((await g.job()).payload).toMatchObject({ status: "merged" });
  const h = setup();
  await h.run(h.params, h.ctx, h.ops);
  vi.mocked(h.ops.readiness).mockResolvedValue(h.ready());
  vi.mocked(h.ops.merge).mockRejectedValue(new Error("provider response lost"));
  await expect(h.job()).rejects.toThrow("provider response lost");
});

test.each([
  "head-moved",
  "branches-changed",
  "default-branch-changed",
  "not-open",
  "conflict",
  "draft",
] as const)("typed final seam refusal %s is not a failed job", async (kind) => {
  const f = setup();
  await f.run(f.params, f.ctx, f.ops);
  vi.mocked(f.ops.readiness).mockResolvedValue(f.ready());
  vi.mocked(f.ops.merge).mockRejectedValue(
    new ManagedFinishRefusedError(kind, "changed", {
      defaultBranch: "release",
      decidedDefaultBranch: "main",
    }),
  );
  expect((await f.job()).payload).toMatchObject({
    status: "not-merged",
    observed: { defaultBranch: "release" },
    whenReady: { observedBy: "final-check" },
  });
  expect(f.budget.commit).not.toHaveBeenCalled();
});

test("frozen resolver refuses replacement number, changed repository and moved head", async () => {
  for (const mutation of ["number", "repository", "head", "row"]) {
    const f = setup();
    await f.run(f.params, f.ctx, f.ops);
    vi.mocked(f.ops.readiness).mockResolvedValue(f.ready());
    if (mutation === "number")
      vi.mocked(f.provider.findPullRequestsForBranch).mockResolvedValue({
        open: [{ number: 43, url: "url", title: "PR", state: "open" }],
      });
    if (mutation === "repository")
      f.provider.repoWebUrl = "https://github.com/a/other";
    if (mutation === "head")
      vi.mocked(f.provider.pullRequestDetail).mockResolvedValue({
        ...f.detail,
        headSha: "d".repeat(40),
      });
    if (mutation === "row") f.row.path = "/elsewhere";
    expect((await f.job()).payload).toMatchObject({
      status: "not-merged",
      whenReady: {
        endedBy:
          mutation === "head"
            ? "head_moved"
            : mutation === "row"
              ? "worktree_unavailable"
              : "pull_request_changed",
      },
    });
    expect(f.ops.merge).not.toHaveBeenCalled();
  }
});

test("STARTING excludes concurrent calls and always releases after refusal or launch denial", async () => {
  const f = setup();
  const gate = deferred<WorktreeRow | undefined>();
  vi.mocked(f.ops.resolve).mockReturnValueOnce(gate.promise);
  const first = f.run(f.params, f.ctx, f.ops);
  await expect(f.run(f.params, f.ctx, f.ops)).rejects.toThrow("still starting");
  gate.resolve(undefined);
  await expect(first).rejects.toThrow("not available");
  f.launch.mockRejectedValueOnce(new Error("denied"));
  await expect(f.run(f.params, f.ctx, f.ops)).rejects.toThrow("denied");
  expect(payload(await f.run(f.params, f.ctx, f.ops)).status).toBe("waiting");
});

test("WATCHING returns same active call, refuses another and cleans terminal rows on next read", async () => {
  const f = setup();
  await f.run(f.params, f.ctx, f.ops);
  expect(payload(await f.run(f.params, f.ctx, f.ops))).toMatchObject({
    status: "waiting",
    taskId: "job",
  });
  expect(f.launch).toHaveBeenCalledTimes(1);
  const other = { ...f.ctx, toolCallId: "other" };
  await expect(f.run(f.params, other, f.ops)).rejects.toThrow(
    "job already watches",
  );
  f.terminal();
  expect(payload(await f.run(f.params, other, f.ops))).toMatchObject({
    status: "ended",
    state: "completed",
  });
  expect(f.launch).toHaveBeenCalledTimes(2);
  expect(payload(await f.run(f.params, other, f.ops)).status).toBe("ended");
});

test.each([false, true])(
  "early job end before publication leaves no held claim, failure=%s",
  async (fails) => {
    const f = setup();
    f.launch.mockImplementationOnce(async (input) => {
      vi.mocked(f.ops.resolve).mockImplementationOnce(async () => {
        if (fails) throw new Error("startup failure");
        return undefined;
      });
      if (fails)
        await expect(input.run(f.budget)).rejects.toThrow("startup failure");
      else await input.run(f.budget);
      f.terminal();
      return { taskId: "job", state: "completed", hint: "job" };
    });
    expect(payload(await f.run(f.params, f.ctx, f.ops)).status).toBe("ended");
    expect(
      payload(await f.run(f.params, { ...f.ctx, toolCallId: "new" }, f.ops))
        .status,
    ).toBe("ended");
  },
);

test("reused running admission without running its closure stays held until the row terminalizes", async () => {
  const f = setup();
  await f.run(f.params, f.ctx, f.ops);
  expect(f.ops.merge).not.toHaveBeenCalled();
  await expect(
    f.run(f.params, { ...f.ctx, toolCallId: "another" }, f.ops),
  ).rejects.toThrow("already watches");
  f.terminal();
  await f.run(f.params, { ...f.ctx, toolCallId: "another" }, f.ops);
  expect(f.launch).toHaveBeenCalledTimes(2);
});

test("rate limit ends green-busy and review-unknown waits, but not a reservable green merge", async () => {
  for (const variant of ["busy", "unknown", "ready"]) {
    const f = setup();
    await f.run(f.params, f.ctx, f.ops);
    f.provider.rateLimit = () => ({
      remaining: 10,
      resetAt: Date.now() + 60000,
    });
    vi.mocked(f.ops.readiness).mockResolvedValue(
      variant === "unknown"
        ? {
            ...f.ready(),
            canMergeNow: false,
            mergeBlockers: ["review_unknown"],
          }
        : f.ready(),
    );
    if (variant === "busy") vi.mocked(f.ops.reserve).mockReturnValue(undefined);
    expect((await f.job()).payload).toMatchObject(
      variant === "ready"
        ? { status: "merged" }
        : { whenReady: { endedBy: "rate_limited" } },
    );
  }
});

test.each([
  "closed",
  "head",
  "base",
  "draft",
  "conflict",
  "default",
  "unreadable",
  "unsupported",
])("real seam refuses %s after the real core decision", async (change) => {
  const f = fixture();
  f.sleep.mockResolvedValue();
  await f.run(f.params, f.ctx, f.ops);
  vi.mocked(f.ops.readiness).mockResolvedValue(f.ready());
  const write = vi.fn();
  f.provider.mergePullRequest = async () => {
    write();
    return {
      outcome: "merged" as const,
      number: 42,
      method: "squash" as const,
      branchDeleted: true,
    };
  };
  f.provider.repositoryCapabilities = async () => ({
    defaultBranch: change === "default" ? "release" : "main",
    mergeMethods: change === "unsupported" ? [] : ["squash"],
  });
  const finalDetail = { ...f.detail };
  if (change === "head") finalDetail.headSha = "d".repeat(40);
  if (change === "base") finalDetail.baseBranch = "main";
  if (change === "draft") finalDetail.draft = true;
  if (change === "conflict") finalDetail.mergeable = false;
  vi.mocked(f.ops.merge).mockImplementation(async (input) => {
    f.provider.pullRequestDetail = async () =>
      change === "unreadable"
        ? null
        : change === "closed"
          ? { ...finalDetail, state: "closed" }
          : finalDetail;
    return mergePullRequestAndProject(input);
  });
  if (change === "unreadable" || change === "unsupported")
    await expect(f.job()).rejects.toThrow();
  else
    expect((await f.job()).payload).toMatchObject({
      status: "not-merged",
      whenReady: {
        observedBy: "final-check",
        endedBy: (
          {
            closed: "pull_request_not_open",
            head: "head_moved",
            base: "pull_request_changed",
            draft: "draft",
            conflict: "not_mergeable",
            default: "pull_request_changed",
          } as Record<string, string>
        )[change],
      },
      ...(change === "default"
        ? {
            observed: {
              defaultBranch: "release",
              decidedDefaultBranch: "main",
            },
          }
        : {}),
    });
  expect(write).not.toHaveBeenCalled();
  expect(f.budget.commit).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledTimes(1);
});

test.each(["capabilities", "detail"])(
  "Stop at the real seam's gated %s read prevents provider write",
  async (where) => {
    const f = fixture();
    f.sleep.mockResolvedValue();
    const controller = new AbortController();
    f.budget.signal = controller.signal;
    f.budget.commit = () => {
      if (controller.signal.aborted) throw controller.signal.reason;
    };
    await f.run(f.params, f.ctx, f.ops);
    vi.mocked(f.ops.readiness).mockResolvedValue(f.ready());
    const reached = deferred<void>();
    const unblock = deferred<void>();
    const write = vi.fn();
    f.provider.repositoryCapabilities = async () => {
      if (where === "capabilities") {
        reached.resolve();
        await unblock.promise;
      }
      return { defaultBranch: "main", mergeMethods: ["squash"] };
    };
    f.provider.mergePullRequest = async () => {
      write();
      return {
        outcome: "merged" as const,
        number: 42,
        method: "squash" as const,
        branchDeleted: true,
      };
    };
    vi.mocked(f.ops.merge).mockImplementation(async (input) => {
      f.provider.pullRequestDetail = async () => {
        if (where === "detail") {
          reached.resolve();
          await unblock.promise;
        }
        return f.detail;
      };
      return mergePullRequestAndProject(input);
    });
    const job = f.job();
    await reached.promise;
    controller.abort(new Error("Stop"));
    unblock.resolve();
    await expect(job).rejects.toThrow("Stop");
    expect(write).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
  },
);

// GitHub accepted the merge but did not confirm it within the wait. The job
// ends with the same `merge-pending` partial as a foreground call, and no
// follow-up runs: removing the worktree of a merge that may never land would
// lose its work.
test("a background merge the provider has not confirmed ends merge-pending with no follow-ups", async () => {
  const f = setup();
  const result = payload(
    await f.run({ ...f.params, removeWorktree: true }, f.ctx, f.ops),
  );
  expect(result.status).toBe("waiting");
  vi.mocked(f.ops.readiness).mockImplementation(async () => f.ready());
  vi.mocked(f.ops.merge).mockImplementationOnce(async (input) => {
    input.beforeProviderWrite?.();
    return {
      result: {
        outcome: "pending" as const,
        number: 42,
        method: "squash" as const,
        requestId: "req-1",
        pendingReason: "waiting for GitHub's answer was cancelled",
      },
      cardIds: [],
      taskSuggestions: [],
      message:
        "GitHub accepted the merge of #42 into release (squash) but has not confirmed it: waiting for GitHub's answer was cancelled.",
    };
  });
  const ended = await f.job();
  expect(ended.payload).toMatchObject({
    status: "merge-pending",
    pendingReason: "waiting for GitHub's answer was cancelled",
    whenReady: { endedBy: "ready", mode: "background" },
  });
  expect(String(ended.summary)).toContain(
    "Not done, because the merge is not confirmed: removing the worktree.",
  );
  expect(f.budget.commit).toHaveBeenCalledTimes(1);
  expect(f.ops.followUps).not.toHaveBeenCalled();
});
