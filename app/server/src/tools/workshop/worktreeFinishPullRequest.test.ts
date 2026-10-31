/**
 * `worktree_finish_pull_request`: the merge/close end of managed delivery.
 *
 * The tool takes a worktree and a verb — never an object — so these tests drive
 * it through injected seams and assert what it REFUSES as much as what it does:
 * a method the repository does not allow, a head that moved anywhere in the
 * local/remote/provider triangle, a readiness blocker, an unknown capability,
 * and above all a default-branch merge, which may only ever stage an approval.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "vitest";
import type {
  ApprovalCard,
  ManagedPullRequestMergeApprovalBody,
  PullRequestCard,
  PullRequestMergeMethod,
  PullRequestRepositoryCapabilities,
  TaskSummary,
} from "@assistant/shared";
import type { GitHostingProvider } from "../../gitHosting.ts";
import type { WorktreeRow } from "../../db/worktreeStore.ts";
import type { ToolCallContext } from "../../mcp/tool.ts";
import type { PullRequestReadiness } from "../pullRequestCheckWatch.ts";
import {
  createWorktreeFinishPullRequestTool,
  createWorktreeReadyPullRequestTool,
  createWorktreeRetargetPullRequestTool,
  managedPullRequestMergeApprovalExecutor,
  setManagedMergeApprovalOperationsForTests,
  type WorktreeFinishPullRequestOperations,
} from "./worktreeFinishPullRequest.ts";
import { DEFAULT_WORKER_SIDE } from "../../workers/placement.ts";

const HEAD = "c".repeat(40);

const row: WorktreeRow = {
  id: "wt-target",
  projectId: "project",
  mainRepoRoot: "/repo",
  path: "/repo/worktrees/target",
  branch: "feature",
  baseBranch: "release-2",
  baseCommit: "abc",
  status: "active",
  mergeStateJson: null,
  createdAt: 1,
  updatedAt: 1,
  removedAt: null,
};

function context(): ToolCallContext {
  return {
    toolCallId: "call-finish",
    session: {
      sessionId: "caller-session",
      harness: "pi",
      agentType: "developer",
      cwd: "/repo/worktrees/target",
    },
  };
}

function provider(patch: Partial<GitHostingProvider> = {}): GitHostingProvider {
  return {
    kind: "github",
    repository: { host: "github.com", owner: "acme", repo: "project" },
    repoWebUrl: "https://github.com/acme/project",
    findPullRequestForBranch: async () => ({
      number: 91,
      url: "https://github.com/acme/project/pull/91",
      title: "Task-588: finish the loop",
      state: "open" as const,
    }),
    findPullRequestsForBranch: async () => ({
      open: [
        {
          number: 91,
          url: "https://github.com/acme/project/pull/91",
          title: "Task-588: finish the loop",
          state: "open" as const,
        },
      ],
    }),
    pullRequestDetail: async () => ({
      number: 91,
      state: "open" as const,
      merged: false,
      mergeable: true,
      draft: false,
      headSha: HEAD,
      headBranch: row.branch,
      baseBranch: row.baseBranch,
    }),
    ...patch,
  } as GitHostingProvider;
}

function readiness(
  patch: Partial<PullRequestReadiness> = {},
): PullRequestReadiness {
  return {
    detail: {
      number: 91,
      state: "open",
      merged: false,
      mergeable: true,
      draft: false,
      headSha: HEAD,
      headBranch: row.branch,
      baseBranch: row.baseBranch,
    },
    checks: { state: "success", checks: [], total: 2 },
    checksFinished: true,
    review: { changesRequested: false },
    canMergeNow: true,
    mergeBlockers: [],
    ...patch,
  };
}

interface Recorder {
  released: number;
  invalidated: number;
  merges: Array<{
    number: number;
    method: PullRequestMergeMethod;
    expectedHeadSha?: string | undefined;
    deleteBranch?: boolean | undefined;
    worktreeId?: string | undefined;
    actorKind?: string;
  }>;
  closes: Array<{ number: number; reason: string; expectedHeadSha: string }>;
  approvals: ManagedPullRequestMergeApprovalBody[];
  supersedes: Array<(earlier: ApprovalCard) => boolean>;
  /** What the merge PROJECTION reports it wrote; the tool may claim no more. */
  taskSuggestions: TaskSummary[];
}

function managedCard(patch: Partial<PullRequestCard> = {}): PullRequestCard {
  return {
    renderKind: "pullRequest",
    id: "card-managed",
    sessionId: "s",
    status: "open",
    provider: "github",
    number: 91,
    url: "https://github.com/acme/project/pull/91",
    title: "Task-588: finish the loop",
    headBranch: row.branch,
    baseBranch: row.baseBranch,
    warnings: [],
    worktreeId: row.id,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function operations(
  overrides: Partial<WorktreeFinishPullRequestOperations> = {},
  capabilities: PullRequestRepositoryCapabilities = {
    defaultBranch: "main",
    mergeMethods: ["squash", "merge", "rebase"],
    canClose: true,
    canDeleteBranchOnMerge: true,
  },
): WorktreeFinishPullRequestOperations & { calls: Recorder } {
  const calls: Recorder = {
    released: 0,
    invalidated: 0,
    merges: [],
    closes: [],
    approvals: [],
    supersedes: [],
    taskSuggestions: [],
  };
  const hosted = provider();
  return {
    calls,
    resolve: async () => row,
    reserve: () => () => {
      calls.released += 1;
    },
    localState: async () => ({
      branch: row.branch,
      head: HEAD,
      clean: true,
    }),
    target: async () => ({
      side: DEFAULT_WORKER_SIDE,
      repoRoot: "/repo",
      remote: "origin",
      upstream: { remote: "origin", branch: row.branch },
    }),
    remoteHead: async () => HEAD,
    hosting: async () => ({
      provider: hosted,
      repository: { host: "github.com", owner: "acme", repo: "project" },
    }),
    capabilities: async () => capabilities,
    readiness: async () => readiness(),
    cards: async () => [managedCard()],
    merge: async (input) => {
      calls.merges.push({
        number: input.number,
        method: input.method,
        expectedHeadSha: input.expectedHeadSha,
        deleteBranch: input.deleteBranch,
        worktreeId: input.worktreeId,
        ...(input.workflowActor ? { actorKind: input.workflowActor.kind } : {}),
      });
      return {
        result: {
          outcome: "merged" as const,
          number: input.number,
          method: input.method,
          branchDeleted: input.deleteBranch !== false,
        },
        message: `Merged #${input.number} into ${input.baseBranch} (${input.method}).`,
        cardIds: ["card-1"],
        taskSuggestions: calls.taskSuggestions,
      };
    },
    close: async (input) => {
      calls.closes.push({
        number: input.number,
        reason: input.reason,
        expectedHeadSha: input.expectedHeadSha,
      });
      return {
        result: {
          number: input.number,
          closed: true,
          headSha: input.expectedHeadSha,
        },
        message: `Closed #${input.number} without merging: ${input.reason}`,
        cardIds: ["card-1"],
      };
    },
    approve: (input) => {
      calls.approvals.push(input.body);
      calls.supersedes.push(input.supersedes);
      return {
        renderKind: "approval",
        id: "appr-1",
        sessionId: input.sessionId,
        kind: "managedPullRequestMerge",
        status: "pending",
        title: input.title,
        createdAt: 1,
        body: input.body,
      } satisfies ApprovalCard;
    },
    followUps: async () => ({ warnings: [] }),
    taskIds: () => ["588"],
    task: (taskId) =>
      taskId === "588"
        ? {
            id: "588",
            title: "Finish the delivery loop",
            status: "doing",
            source: { createdBy: "user" },
            createdAt: 1,
            updatedAt: 1,
          }
        : undefined,
    invalidate: () => {
      calls.invalidated += 1;
    },
    ...overrides,
    projectReady: overrides.projectReady ?? (() => {}),
    projectRetarget: overrides.projectRetarget ?? (() => {}),
    inventoryChanged: overrides.inventoryChanged ?? (() => {}),
  };
}

function details(result: { details?: unknown }): Record<string, unknown> {
  return result.details as Record<string, unknown>;
}

describe("merge follow-up flags", () => {
  test("runs both choices after the merge and releases the mutation hold before cleanup", async () => {
    const events: string[] = [];
    const ops = operations({
      cards: async () => [
        managedCard({ linkedTask: operations().task("588")! }),
      ],
      reserve: () => () => {
        events.push("released");
      },
      merge: async (input) => {
        events.push("merge");
        return operations().merge(input);
      },
      followUps: async (input) => {
        events.push("follow-ups");
        assert.deepEqual(input, {
          worktreeId: row.id,
          number: 91,
          sessionId: "caller-session",
          markTaskDone: true,
          removeWorktree: true,
          taskId: "588",
        });
        return {
          task: { id: "588", status: "done" },
          worktreeRemoved: true,
          warnings: [],
        };
      },
    });
    const result = details(
      await createWorktreeFinishPullRequestTool(ops).execute(
        {
          worktreeId: row.id,
          action: "merge",
          method: "squash",
          markTaskDone: true,
          removeWorktree: true,
        },
        context(),
      ),
    );
    assert.equal(result.status, "merged");
    assert.deepEqual(result.followUps, {
      task: { id: "588", status: "done" },
      worktreeRemoved: true,
      warnings: [],
    });
    assert.deepEqual(events, ["merge", "released", "follow-ups"]);
  });

  test("a failed merge never starts follow-ups", async () => {
    const ops = operations({
      merge: async () => {
        throw new Error("provider refused");
      },
      followUps: async () => {
        assert.fail("must not run");
      },
    });
    await assert.rejects(
      createWorktreeFinishPullRequestTool(ops).execute(
        {
          worktreeId: row.id,
          action: "merge",
          method: "squash",
          removeWorktree: true,
        },
        context(),
      ),
      /provider refused/,
    );
  });

  test("follow-up and invalidation failures never hide a confirmed merge", async () => {
    const ops = operations({
      followUps: async () => {
        throw new Error("disk full");
      },
      invalidate: () => {
        throw new Error("cache failed");
      },
    });
    const result = details(
      await createWorktreeFinishPullRequestTool(ops).execute(
        {
          worktreeId: row.id,
          action: "merge",
          method: "squash",
          removeWorktree: true,
        },
        context(),
      ),
    );
    assert.equal(result.status, "merged");
    assert.match(String(result.message), /disk full/);
  });

  test("completion refuses a missing or ambiguous card Task before merging", async () => {
    for (const cards of [
      [managedCard()],
      [
        managedCard({ linkedTask: operations().task("588")! }),
        managedCard({
          id: "other",
          linkedTask: { ...operations().task("588")!, id: "other" },
        }),
      ],
    ]) {
      const ops = operations({ cards: async () => cards });
      await assert.rejects(
        createWorktreeFinishPullRequestTool(ops).execute(
          {
            worktreeId: row.id,
            action: "merge",
            method: "squash",
            markTaskDone: true,
          },
          context(),
        ),
        /unique linked Task/,
      );
      assert.deepEqual(ops.calls.merges, []);
    }
  });

  test("close refuses either follow-up flag, even false", async () => {
    const tool = createWorktreeFinishPullRequestTool(operations());
    for (const flag of [{ markTaskDone: false }, { removeWorktree: false }]) {
      await assert.rejects(
        tool.execute(
          { worktreeId: row.id, action: "close", reason: "abandoned", ...flag },
          context(),
        ),
        /merge only/,
      );
    }
  });
});

describe("managed draft to ready", () => {
  test("resolves the canonical draft, rechecks identity and updates its cards", async () => {
    const transitions: number[] = [];
    const projected: string[] = [];
    const invalidated: number[] = [];
    const hosted = provider({
      pullRequestDetail: async () => ({
        number: 91,
        state: "open",
        merged: false,
        mergeable: null,
        draft: true,
        headSha: HEAD,
        headBranch: row.branch,
        baseBranch: row.baseBranch,
      }),
      markPullRequestReady: async (number) => {
        transitions.push(number);
        return { title: "Feature" };
      },
    });
    const ops = operations({
      hosting: async () => ({
        provider: hosted,
        repository: hosted.repository!,
      }),
      projectReady: (cards, headSha, title) =>
        projected.push(`${cards[0]?.id}:${headSha}:${title}`),
      inventoryChanged: (_provider, number) => invalidated.push(number),
    });
    const tool = createWorktreeReadyPullRequestTool(ops);
    assert.deepEqual(
      Object.keys(
        (tool.parameters as { properties: Record<string, unknown> }).properties,
      ),
      ["worktreeId"],
    );
    const result = await tool.execute({ worktreeId: row.id }, context());
    assert.equal(details(result).status, "ready");
    assert.deepEqual(transitions, [91]);
    assert.deepEqual(projected, [`card-managed:${HEAD}:Feature`]);
    assert.deepEqual(invalidated, [91]);
    assert.equal(ops.calls.released, 1);
  });

  test("reports a successful provider write even if the card projection fails", async () => {
    const hosted = provider({
      pullRequestDetail: async () => ({
        number: 91,
        state: "open",
        merged: false,
        mergeable: null,
        draft: true,
        headSha: HEAD,
        headBranch: row.branch,
        baseBranch: row.baseBranch,
      }),
      markPullRequestReady: async () => ({ title: "Feature" }),
    });
    const invalidated: number[] = [];
    const ops = operations({
      hosting: async () => ({
        provider: hosted,
        repository: hosted.repository!,
      }),
      projectReady: () => {
        throw new Error("card disappeared");
      },
      inventoryChanged: (_provider, number) => invalidated.push(number),
    });
    const result = await createWorktreeReadyPullRequestTool(ops).execute(
      { worktreeId: row.id },
      context(),
    );
    assert.equal(details(result).status, "ready-partial");
    assert.match(String(details(result).projectionWarning), /card disappeared/);
    assert.deepEqual(invalidated, [91]);
  });

  test("a cache invalidation failure does not conceal a successful provider write", async () => {
    const hosted = provider({
      pullRequestDetail: async () => ({
        number: 91,
        state: "open",
        merged: false,
        mergeable: null,
        draft: true,
        headSha: HEAD,
        headBranch: row.branch,
        baseBranch: row.baseBranch,
      }),
      markPullRequestReady: async () => ({ title: "Feature" }),
    });
    const ops = operations({
      hosting: async () => ({
        provider: hosted,
        repository: hosted.repository!,
      }),
      inventoryChanged: () => {
        throw new Error("inventory unavailable");
      },
    });
    const result = await createWorktreeReadyPullRequestTool(ops).execute(
      { worktreeId: row.id },
      context(),
    );
    assert.equal(details(result).status, "ready-partial");
    assert.match(
      String(details(result).inventoryWarning),
      /inventory unavailable/,
    );
  });

  test("refuses a moved head before the provider write", async () => {
    let reads = 0;
    let wrote = false;
    const hosted = provider({
      pullRequestDetail: async () => ({
        number: 91,
        state: "open",
        merged: false,
        mergeable: null,
        draft: true,
        headSha: ++reads === 1 ? HEAD : "d".repeat(40),
        headBranch: row.branch,
        baseBranch: row.baseBranch,
      }),
      markPullRequestReady: async () => {
        wrote = true;
        return {};
      },
    });
    const ops = operations({
      hosting: async () => ({
        provider: hosted,
        repository: hosted.repository!,
      }),
    });
    await assert.rejects(
      createWorktreeReadyPullRequestTool(ops).execute(
        { worktreeId: row.id },
        context(),
      ),
      /changed while preparing/,
    );
    assert.equal(wrote, false);
    assert.equal(ops.calls.released, 1);
  });
});

describe("managed base retarget", () => {
  const OLD_BASE = "stack-parent";

  /** A provider whose pull request moves to `row.baseBranch` once retargeted. */
  function retargetable(patch: Partial<GitHostingProvider> = {}) {
    const writes: Array<{ number: number; base: string }> = [];
    let base = OLD_BASE;
    const hosted = provider({
      pullRequestDetail: async () => ({
        number: 91,
        state: "open",
        merged: false,
        mergeable: true,
        draft: false,
        headSha: HEAD,
        headBranch: row.branch,
        baseBranch: base,
      }),
      retargetPullRequest: async (number, next) => {
        writes.push({ number, base: next });
        base = next;
      },
      ...patch,
    });
    return { hosted, writes };
  }

  function retargetOperations(
    hosted: GitHostingProvider,
    overrides: Partial<WorktreeFinishPullRequestOperations> = {},
  ) {
    return operations({
      hosting: async () => ({
        provider: hosted,
        repository: hosted.repository!,
      }),
      cards: async () => [managedCard({ baseBranch: OLD_BASE })],
      ...overrides,
    });
  }

  test("moves the pull request onto the worktree's base and updates its cards", async () => {
    const { hosted, writes } = retargetable();
    const projected: string[] = [];
    const invalidated: number[] = [];
    const ops = retargetOperations(hosted, {
      projectRetarget: (cards, base) =>
        projected.push(`${cards.map((card) => card.id).join(",")}:${base}`),
      inventoryChanged: (_provider, number) => invalidated.push(number),
    });
    const tool = createWorktreeRetargetPullRequestTool(ops);
    assert.deepEqual(
      Object.keys(
        (tool.parameters as { properties: Record<string, unknown> }).properties,
      ),
      ["worktreeId"],
    );
    const result = await tool.execute({ worktreeId: row.id }, context());
    assert.equal(details(result).status, "retargeted");
    assert.equal(details(result).previousBaseBranch, OLD_BASE);
    assert.equal(details(result).baseBranch, row.baseBranch);
    assert.deepEqual(writes, [{ number: 91, base: row.baseBranch }]);
    assert.deepEqual(projected, [`card-managed:${row.baseBranch}`]);
    assert.deepEqual(invalidated, [91]);
    assert.equal(ops.calls.released, 1);
  });

  test("a pull request already on the base only repairs stale cards", async () => {
    const { hosted, writes } = retargetable();
    await hosted.retargetPullRequest(91, row.baseBranch);
    writes.length = 0;
    const projected: string[] = [];
    const ops = retargetOperations(hosted, {
      cards: async () => [
        managedCard({ id: "card-stale", baseBranch: OLD_BASE }),
        managedCard({ id: "card-current" }),
      ],
      projectRetarget: (cards, base) =>
        projected.push(`${cards.map((card) => card.id).join(",")}:${base}`),
    });
    const result = await createWorktreeRetargetPullRequestTool(ops).execute(
      { worktreeId: row.id },
      context(),
    );
    assert.equal(details(result).status, "unchanged");
    assert.deepEqual(writes, []);
    assert.deepEqual(projected, [`card-stale:${row.baseBranch}`]);
  });

  test("refuses a moved head before the provider write", async () => {
    let reads = 0;
    const { hosted, writes } = retargetable({
      pullRequestDetail: async () => ({
        number: 91,
        state: "open",
        merged: false,
        mergeable: true,
        draft: false,
        headSha: ++reads === 1 ? HEAD : "d".repeat(40),
        headBranch: row.branch,
        baseBranch: OLD_BASE,
      }),
    });
    await assert.rejects(
      createWorktreeRetargetPullRequestTool(retargetOperations(hosted)).execute(
        { worktreeId: row.id },
        context(),
      ),
      /changed while preparing to retarget/,
    );
    assert.deepEqual(writes, []);
  });

  test("a provider refusal names the base and leaves the cards alone", async () => {
    const { hosted } = retargetable({
      retargetPullRequest: async () => {
        throw new Error("Validation Failed: base does not exist");
      },
    });
    const projected: string[] = [];
    const ops = retargetOperations(hosted, {
      projectRetarget: () => projected.push("projected"),
    });
    await assert.rejects(
      createWorktreeRetargetPullRequestTool(ops).execute(
        { worktreeId: row.id },
        context(),
      ),
      /refused to retarget pull request #91 onto release-2: Validation Failed.*push it first/,
    );
    assert.deepEqual(projected, []);
    assert.equal(ops.calls.released, 1);
  });

  test("a retarget the provider does not reflect is partial and not projected", async () => {
    const { hosted } = retargetable({ retargetPullRequest: async () => {} });
    const projected: string[] = [];
    const result = await createWorktreeRetargetPullRequestTool(
      retargetOperations(hosted, {
        projectRetarget: () => projected.push("projected"),
      }),
    ).execute({ worktreeId: row.id }, context());
    assert.equal(details(result).status, "retargeted-partial");
    assert.match(
      String((details(result).warnings as string[])[0]),
      /still reports base stack-parent/,
    );
    assert.deepEqual(projected, []);
  });

  test("a write whose response was lost but which landed is reported, not refused", async () => {
    let base = OLD_BASE;
    const { hosted } = retargetable({
      pullRequestDetail: async () => ({
        number: 91,
        state: "open",
        merged: false,
        mergeable: true,
        draft: false,
        headSha: HEAD,
        headBranch: row.branch,
        baseBranch: base,
      }),
      retargetPullRequest: async (_number, next) => {
        base = next;
        throw new Error("socket hang up");
      },
    });
    const projected: string[] = [];
    const result = await createWorktreeRetargetPullRequestTool(
      retargetOperations(hosted, {
        projectRetarget: (_cards, next) => projected.push(next),
      }),
    ).execute({ worktreeId: row.id }, context());
    assert.equal(details(result).status, "retargeted-partial");
    assert.match(
      String((details(result).warnings as string[]).join(" ")),
      /reported an error \(socket hang up\), but the pull request now targets release-2/,
    );
    assert.deepEqual(projected, [row.baseBranch]);
  });

  test("a failed write whose outcome cannot be read back is unknown, not refused", async () => {
    let reads = 0;
    const { hosted } = retargetable({
      pullRequestDetail: async () => {
        if (++reads > 2) throw new Error("read timed out");
        return {
          number: 91,
          state: "open",
          merged: false,
          mergeable: true,
          draft: false,
          headSha: HEAD,
          headBranch: row.branch,
          baseBranch: OLD_BASE,
        };
      },
      retargetPullRequest: async () => {
        throw new Error("socket hang up");
      },
    });
    await assert.rejects(
      createWorktreeRetargetPullRequestTool(retargetOperations(hosted)).execute(
        { worktreeId: row.id },
        context(),
      ),
      (error: Error) =>
        /whether it landed is unknown: it could not be read back \(read timed out\)/.test(
          error.message,
        ) && !/refused/.test(error.message),
    );
  });

  test("a pull request that moved during the write is partial and left to the watcher", async () => {
    let base = OLD_BASE;
    let moved = false;
    const { hosted } = retargetable({
      pullRequestDetail: async () => ({
        number: 91,
        state: "open",
        merged: false,
        mergeable: true,
        draft: false,
        headSha: moved ? "e".repeat(40) : HEAD,
        headBranch: row.branch,
        baseBranch: base,
      }),
      retargetPullRequest: async (_number, next) => {
        base = next;
        moved = true;
      },
    });
    const projected: string[] = [];
    const result = await createWorktreeRetargetPullRequestTool(
      retargetOperations(hosted, {
        projectRetarget: () => projected.push("projected"),
      }),
    ).execute({ worktreeId: row.id }, context());
    assert.equal(details(result).status, "retargeted-partial");
    assert.match(
      String((details(result).warnings as string[])[0]),
      /also changed during the retarget .*eeee/,
    );
    assert.deepEqual(projected, []);
  });

  test("a pull request merged during the write is partial and left to the watcher", async () => {
    let base = OLD_BASE;
    let merged = false;
    const { hosted } = retargetable({
      pullRequestDetail: async () => ({
        number: 91,
        state: merged ? "merged" : "open",
        merged,
        mergeable: true,
        draft: false,
        headSha: HEAD,
        headBranch: row.branch,
        baseBranch: base,
      }),
      retargetPullRequest: async (_number, next) => {
        base = next;
        merged = true;
      },
    });
    const projected: string[] = [];
    const result = await createWorktreeRetargetPullRequestTool(
      retargetOperations(hosted, {
        projectRetarget: () => projected.push("projected"),
      }),
    ).execute({ worktreeId: row.id }, context());
    assert.equal(details(result).status, "retargeted-partial");
    assert.match(
      String((details(result).warnings as string[])[0]),
      /also changed during the retarget \(merged/,
    );
    assert.deepEqual(projected, []);
  });

  test("a card owned by another worktree still refuses", async () => {
    const { hosted, writes } = retargetable();
    await assert.rejects(
      createWorktreeRetargetPullRequestTool(
        retargetOperations(hosted, {
          cards: async () => [
            managedCard({ baseBranch: OLD_BASE, worktreeId: "wt-other" }),
          ],
        }),
      ).execute({ worktreeId: row.id }, context()),
      /owned by worktree wt-other/,
    );
    assert.deepEqual(writes, []);
  });
});

describe("input contract", () => {
  test("the schema accepts no repository, number, ref, sha or path", () => {
    const schema = createWorktreeFinishPullRequestTool().parameters as {
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(Object.keys(schema.properties), [
      "worktreeId",
      "action",
      "method",
      "deleteRemoteBranch",
      "markTaskDone",
      "removeWorktree",
      "whenReady",
      "timeoutSeconds",
      "reason",
      "comment",
    ]);
  });

  test("the main checkout is never a finish target", async () => {
    await assert.rejects(
      createWorktreeFinishPullRequestTool(operations()).execute(
        { worktreeId: "main:project", action: "close", reason: "no" },
        context(),
      ),
      /main checkout/,
    );
  });

  test("close refuses merge-only fields and requires a reason", async () => {
    const tool = createWorktreeFinishPullRequestTool(operations());
    await assert.rejects(
      tool.execute(
        { worktreeId: row.id, action: "close", method: "squash", reason: "x" },
        context(),
      ),
      /method applies to merge only/,
    );
    await assert.rejects(
      tool.execute({ worktreeId: row.id, action: "close" }, context()),
      /reason is required/,
    );
  });

  test("merge refuses a closing comment", async () => {
    await assert.rejects(
      createWorktreeFinishPullRequestTool(operations()).execute(
        {
          worktreeId: row.id,
          action: "merge",
          method: "squash",
          comment: "bye",
        },
        context(),
      ),
      /comment applies to close only/,
    );
  });

  test("merge requires a method", async () => {
    await assert.rejects(
      createWorktreeFinishPullRequestTool(operations()).execute(
        { worktreeId: row.id, action: "merge" },
        context(),
      ),
      /method is required for merge/,
    );
  });

  test("another running writer refuses the whole call", async () => {
    const ops = operations({ reserve: () => undefined });
    await assert.rejects(
      createWorktreeFinishPullRequestTool(ops).execute(
        { worktreeId: row.id, action: "close", reason: "abandoned" },
        context(),
      ),
      /Another session is running or starting/,
    );
    assert.deepEqual(ops.calls.closes, []);
  });

  test("a worktree row that changed under the reservation refuses", async () => {
    let resolved = 0;
    const ops = operations({
      resolve: async () => {
        resolved += 1;
        return resolved === 1 ? row : { ...row, branch: "other" };
      },
    });
    await assert.rejects(
      createWorktreeFinishPullRequestTool(ops).execute(
        { worktreeId: row.id, action: "close", reason: "abandoned" },
        context(),
      ),
      /changed or was removed/,
    );
    assert.deepEqual(ops.calls.closes, []);
  });
});

describe("close", () => {
  test("closes with an audited reason and keeps branch, worktree and Task", async () => {
    const ops = operations();
    const result = await createWorktreeFinishPullRequestTool(ops).execute(
      { worktreeId: row.id, action: "close", reason: "superseded by Task-590" },
      context(),
    );
    assert.deepEqual(ops.calls.closes, [
      { number: 91, reason: "superseded by Task-590", expectedHeadSha: HEAD },
    ]);
    assert.deepEqual(ops.calls.merges, []);
    const payload = details(result);
    assert.equal(payload.action, "close");
    assert.equal(payload.status, "closed");
    assert.equal(payload.number, 91);
    assert.equal(payload.reason, "superseded by Task-590");
    assert.equal(payload.remoteBranchKept, true);
    assert.equal(payload.worktreeKept, true);
    assert.equal(payload.linkedTaskUnchanged, true);
    assert.equal(payload.commentPosted, undefined);
    assert.equal(result.terminate, undefined);
  });

  test("close forwards a comment and an opt-in remote branch deletion", async () => {
    const seen: Array<{ comment?: string; deleteRemoteBranch?: boolean }> = [];
    const ops = operations({
      close: async (input) => {
        seen.push({
          ...(input.comment !== undefined ? { comment: input.comment } : {}),
          ...(input.deleteRemoteBranch !== undefined
            ? { deleteRemoteBranch: input.deleteRemoteBranch }
            : {}),
        });
        return {
          result: {
            number: input.number,
            closed: true,
            headSha: input.expectedHeadSha,
            commentUrl: "https://example.test/pr/91#c1",
            branchDeleted: true,
          },
          message: "Closed.",
          cardIds: [],
        };
      },
    });
    const payload = details(
      await createWorktreeFinishPullRequestTool(ops).execute(
        {
          worktreeId: row.id,
          action: "close",
          reason: "superseded",
          comment: "  Superseded by #95.  ",
          deleteRemoteBranch: true,
        },
        context(),
      ),
    );
    assert.deepEqual(seen, [
      { comment: "Superseded by #95.", deleteRemoteBranch: true },
    ]);
    assert.equal(payload.commentPosted, true);
    assert.equal(payload.commentUrl, "https://example.test/pr/91#c1");
    assert.equal(payload.remoteBranchKept, false);
    assert.equal(payload.localBranchKept, true);
    assert.equal(payload.worktreeKept, true);
  });

  test("close reports a kept remote branch beside the close", async () => {
    const ops = operations({
      close: async (input) => ({
        result: {
          number: input.number,
          closed: true,
          headSha: input.expectedHeadSha,
          branchDeleted: false,
          branchKeptReason: "#92 still targets it as base",
        },
        message: "Closed.",
        cardIds: [],
      }),
    });
    const payload = details(
      await createWorktreeFinishPullRequestTool(ops).execute(
        {
          worktreeId: row.id,
          action: "close",
          reason: "dead end",
          deleteRemoteBranch: true,
        },
        context(),
      ),
    );
    assert.equal(payload.status, "closed");
    assert.equal(payload.remoteBranchKept, true);
    assert.equal(
      payload.remoteBranchKeptReason,
      "#92 still targets it as base",
    );
  });

  // Abandoning is the point: a dirty tree, a missing upstream or a red build
  // must not stand between an agent and closing its own pull request.
  test("close needs neither clean state, remote equality, nor green checks", async () => {
    const ops = operations({
      localState: async () => ({ branch: "", head: "", clean: false }),
      remoteHead: async () => undefined,
      readiness: async () => {
        throw new Error("readiness must not be read for a close");
      },
    });
    const result = await createWorktreeFinishPullRequestTool(ops).execute(
      { worktreeId: row.id, action: "close", reason: "dead end" },
      context(),
    );
    assert.equal(details(result).status, "closed");
  });

  // The default branch is the MERGE boundary; closing is direct either way.
  test("close is direct for a default-branch base too", async () => {
    const ops = operations(
      {},
      {
        defaultBranch: row.baseBranch,
        mergeMethods: ["squash"],
        canClose: true,
      },
    );
    const result = await createWorktreeFinishPullRequestTool(ops).execute(
      { worktreeId: row.id, action: "close", reason: "abandoned" },
      context(),
    );
    assert.equal(details(result).status, "closed");
    assert.deepEqual(ops.calls.approvals, []);
  });

  test("unknown close support fails closed", async () => {
    const ops = operations(
      {},
      {
        defaultBranch: "main",
        mergeMethods: ["squash"],
        unknownReason: "the repository could not be read",
      },
    );
    await assert.rejects(
      createWorktreeFinishPullRequestTool(ops).execute(
        { worktreeId: row.id, action: "close", reason: "abandoned" },
        context(),
      ),
      /not confirmed/,
    );
    assert.deepEqual(ops.calls.closes, []);
  });

  test("an unconfirmed provider close is reported as a partial", async () => {
    const ops = operations({
      close: async (input) => ({
        result: {
          number: input.number,
          closed: false,
          headSha: input.expectedHeadSha,
          unconfirmedReason: "the close was sent but could not be confirmed.",
        },
        message: "sent",
        cardIds: [],
      }),
    });
    const payload = details(
      await createWorktreeFinishPullRequestTool(ops).execute(
        { worktreeId: row.id, action: "close", reason: "abandoned" },
        context(),
      ),
    );
    assert.equal(payload.status, "close-unconfirmed");
    assert.match(String(payload.unconfirmed), /could not be confirmed/);
  });
});

describe("target resolution", () => {
  test("a branch with no pull request refuses", async () => {
    const ops = operations({
      hosting: async () => ({
        provider: provider({
          findPullRequestsForBranch: async () => ({ open: [] }),
        }),
        repository: { host: "github.com", owner: "acme", repo: "project" },
      }),
    });
    await assert.rejects(
      createWorktreeFinishPullRequestTool(ops).execute(
        { worktreeId: row.id, action: "close", reason: "abandoned" },
        context(),
      ),
      /No pull request exists/,
    );
  });

  test("multiple open pull requests refuse only managed finishing", async () => {
    const openPull = {
      number: 92,
      url: "https://github.com/acme/project/pull/92",
      title: "Another target",
      state: "open" as const,
    };
    const hosted = provider({
      findPullRequestsForBranch: async () => ({
        open: [
          openPull,
          {
            number: 91,
            url: "https://github.com/acme/project/pull/91",
            title: "Task-588: finish the loop",
            state: "open" as const,
          },
        ],
      }),
      findPullRequestForBranch: async () => openPull,
    });
    const ops = operations({
      hosting: async () => ({
        provider: hosted,
        repository: { host: "github.com", owner: "acme", repo: "project" },
      }),
    });

    assert.equal(
      (await hosted.findPullRequestForBranch(row.branch))?.number,
      openPull.number,
    );
    await assert.rejects(
      createWorktreeFinishPullRequestTool(ops).execute(
        { worktreeId: row.id, action: "close", reason: "abandoned" },
        context(),
      ),
      /2 open pull requests \(#92, #91\); exactly one is required/,
    );
  });

  test("an already merged pull request refuses", async () => {
    const ops = operations({
      hosting: async () => ({
        provider: provider({
          findPullRequestsForBranch: async () => ({
            open: [],
            latestTerminal: {
              number: 91,
              url: "u",
              title: "t",
              state: "merged" as const,
            },
          }),
        }),
        repository: { host: "github.com", owner: "acme", repo: "project" },
      }),
    });
    await assert.rejects(
      createWorktreeFinishPullRequestTool(ops).execute(
        { worktreeId: row.id, action: "merge", method: "squash" },
        context(),
      ),
      /already merged/,
    );
  });

  test("a pull request whose base no longer matches the row refuses", async () => {
    const ops = operations({
      hosting: async () => ({
        provider: provider({
          pullRequestDetail: async () => ({
            number: 91,
            state: "open" as const,
            merged: false,
            mergeable: true,
            draft: false,
            headSha: HEAD,
            headBranch: row.branch,
            baseBranch: "somewhere-else",
          }),
        }),
        repository: { host: "github.com", owner: "acme", repo: "project" },
      }),
    });
    await assert.rejects(
      createWorktreeFinishPullRequestTool(ops).execute(
        { worktreeId: row.id, action: "merge", method: "squash" },
        context(),
      ),
      /this worktree is registered for .*Run worktree_retarget_pull_request/,
    );
  });

  test("a missing managed card refuses", async () => {
    const ops = operations({ cards: async () => [] });
    await assert.rejects(
      createWorktreeFinishPullRequestTool(ops).execute(
        { worktreeId: row.id, action: "merge", method: "squash" },
        context(),
      ),
      /no open managed card/,
    );
  });

  test("a live card owned by another worktree refuses", async () => {
    const ops = operations({
      cards: async () => [
        managedCard({ id: "card-other", worktreeId: "wt-somewhere-else" }),
      ],
    });
    await assert.rejects(
      createWorktreeFinishPullRequestTool(ops).execute(
        { worktreeId: row.id, action: "merge", method: "squash" },
        context(),
      ),
      /owned by worktree wt-somewhere-else/,
    );
  });

  test("a provider describing another repository refuses", async () => {
    const ops = operations({
      hosting: async () => ({
        provider: provider({
          repository: { host: "github.com", owner: "acme", repo: "other" },
        }),
        repository: { host: "github.com", owner: "acme", repo: "project" },
      }),
    });
    await assert.rejects(
      createWorktreeFinishPullRequestTool(ops).execute(
        { worktreeId: row.id, action: "close", reason: "abandoned" },
        context(),
      ),
      /does not describe the repository/,
    );
  });
});

describe("merge into a non-default base", () => {
  for (const method of ["squash", "merge", "rebase"] as const) {
    test(`merges directly with ${method}`, async () => {
      const ops = operations();
      const payload = details(
        await createWorktreeFinishPullRequestTool(ops).execute(
          { worktreeId: row.id, action: "merge", method },
          context(),
        ),
      );
      assert.deepEqual(ops.calls.merges, [
        {
          number: 91,
          method,
          expectedHeadSha: HEAD,
          deleteBranch: true,
          worktreeId: row.id,
          actorKind: "agent",
        },
      ]);
      assert.equal(payload.status, "merged");
      assert.equal(payload.approvalRequired, false);
      assert.equal(payload.baseIsDefaultBranch, false);
      assert.equal(payload.defaultBranch, "main");
      assert.equal(payload.remoteBranchDeleted, true);
      assert.deepEqual(payload.supportedMethods, ["squash", "merge", "rebase"]);
    });
  }

  // A Task suggestion is a WRITE the projection either performed or did not:
  // the projection suggests `done` only for Tasks linked on a matching card,
  // skips an already-done or missing one, and swallows a failed write. The tool
  // may therefore report exactly what came back and nothing else.
  test("reports only the Task suggestions the merge projection wrote", async () => {
    const ops = operations();
    const suggested: TaskSummary = {
      id: "588",
      title: "Finish the delivery loop",
      status: "done",
      source: { createdBy: "user" },
      createdAt: 1,
      updatedAt: 2,
    };
    ops.calls.taskSuggestions.push(suggested);
    const payload = details(
      await createWorktreeFinishPullRequestTool(ops).execute(
        { worktreeId: row.id, action: "merge", method: "squash" },
        context(),
      ),
    );
    assert.deepEqual(payload.taskSuggestions, [
      { id: "588", title: "Finish the delivery loop", statusSuggested: "done" },
    ]);
  });

  test("claims no Task suggestion when the projection wrote none", async () => {
    // The worktree still LINKS Task-588 (`operations().taskIds`), which is
    // exactly the pre-merge fact that must not be reported as a suggestion.
    const ops = operations();
    const payload = details(
      await createWorktreeFinishPullRequestTool(ops).execute(
        { worktreeId: row.id, action: "merge", method: "squash" },
        context(),
      ),
    );
    assert.deepEqual(payload.taskSuggestions, []);
    assert.equal(payload.linkedTask, undefined);
  });

  test("keeps the remote branch when asked", async () => {
    const ops = operations();
    await createWorktreeFinishPullRequestTool(ops).execute(
      {
        worktreeId: row.id,
        action: "merge",
        method: "squash",
        deleteRemoteBranch: false,
      },
      context(),
    );
    assert.equal(ops.calls.merges[0]?.deleteBranch, false);
  });

  // Accepted, not confirmed: a partial in the same convention as
  // `retargeted-partial`, telling the agent not to merge again or clean up.
  test("a merge the provider has not confirmed is reported as merge-pending", async () => {
    const ops = operations({
      merge: async (
        input: Parameters<WorktreeFinishPullRequestOperations["merge"]>[0],
      ) => ({
        result: {
          outcome: "pending" as const,
          number: input.number,
          method: input.method,
          requestId: "req-1",
          pendingReason:
            "GitHub had not finished merging it when this stopped waiting",
        },
        message: `GitHub accepted the merge of #${input.number} into ${input.baseBranch} (${input.method}) but has not confirmed it: GitHub had not finished merging it when this stopped waiting.`,
        cardIds: [],
        taskSuggestions: [],
      }),
    });
    let followUps = 0;
    ops.followUps = async () => {
      followUps++;
      return { warnings: [] };
    };
    const payload = details(
      await createWorktreeFinishPullRequestTool(ops).execute(
        {
          worktreeId: row.id,
          action: "merge",
          method: "squash",
          removeWorktree: true,
        },
        context(),
      ),
    );
    // Removing the worktree of a merge that may never land would lose work.
    assert.equal(followUps, 0);
    assert.match(
      String(payload.message),
      /Not done, because the merge is not confirmed: removing the worktree\./,
    );
    assert.equal(payload.status, "merge-pending");
    assert.equal(
      payload.pendingReason,
      "GitHub had not finished merging it when this stopped waiting",
    );
    assert.equal(payload.remoteBranchDeleted, undefined);
    assert.equal(payload.taskSuggestions, undefined);
    assert.match(
      String(payload.message),
      /has not confirmed it.*card follows the request: it turns merged once the provider confirms, or states the failure/,
    );
  });

  test("reports why a merged branch was kept", async () => {
    const ops = operations({
      merge: async (input) => ({
        result: {
          outcome: "merged" as const,
          number: input.number,
          method: input.method,
          branchDeleted: false,
          branchKeptReason: "#92 still targets it as base",
        },
        message: "Merged.",
        cardIds: [],
        taskSuggestions: [],
      }),
    });
    const payload = details(
      await createWorktreeFinishPullRequestTool(ops).execute(
        { worktreeId: row.id, action: "merge", method: "squash" },
        context(),
      ),
    );
    assert.equal(payload.remoteBranchDeleted, false);
    assert.equal(
      payload.remoteBranchKeptReason,
      "#92 still targets it as base",
    );
  });

  test("a method the repository does not allow is refused with the set", async () => {
    const ops = operations(
      {},
      {
        defaultBranch: "main",
        mergeMethods: ["merge"],
        canClose: true,
      },
    );
    await assert.rejects(
      createWorktreeFinishPullRequestTool(ops).execute(
        { worktreeId: row.id, action: "merge", method: "squash" },
        context(),
      ),
      /does not allow the squash merge method.*Supported: merge/s,
    );
    assert.deepEqual(ops.calls.merges, []);
  });

  // Unknown is never "everything is allowed", and never a guessed `main`.
  test("unknown capabilities fail closed for both classification and method", async () => {
    const noBranch = operations({}, { mergeMethods: ["squash"] });
    await assert.rejects(
      createWorktreeFinishPullRequestTool(noBranch).execute(
        { worktreeId: row.id, action: "merge", method: "squash" },
        context(),
      ),
      /default branch could not be read/,
    );
    const noMethods = operations({}, { defaultBranch: "main" });
    await assert.rejects(
      createWorktreeFinishPullRequestTool(noMethods).execute(
        { worktreeId: row.id, action: "merge", method: "squash" },
        context(),
      ),
      /supported merge methods could not be read/,
    );
    assert.deepEqual(noBranch.calls.merges, []);
    assert.deepEqual(noMethods.calls.merges, []);
  });

  test("a draft pull request is never merged", async () => {
    const ops = operations({
      hosting: async () => ({
        provider: provider({
          pullRequestDetail: async () => ({
            number: 91,
            state: "open" as const,
            merged: false,
            mergeable: true,
            draft: true,
            headSha: HEAD,
            headBranch: row.branch,
            baseBranch: row.baseBranch,
          }),
        }),
        repository: { host: "github.com", owner: "acme", repo: "project" },
      }),
    });
    await assert.rejects(
      createWorktreeFinishPullRequestTool(ops).execute(
        { worktreeId: row.id, action: "merge", method: "squash" },
        context(),
      ),
      /is a draft/,
    );
  });

  test("a dirty worktree, a moved remote head and a moved PR head each refuse", async () => {
    const dirty = operations({
      localState: async () => ({
        branch: row.branch,
        head: HEAD,
        clean: false,
      }),
    });
    await assert.rejects(
      createWorktreeFinishPullRequestTool(dirty).execute(
        { worktreeId: row.id, action: "merge", method: "squash" },
        context(),
      ),
      /staged, modified, or non-ignored untracked/,
    );

    const remoteMoved = operations({ remoteHead: async () => "d".repeat(40) });
    await assert.rejects(
      createWorktreeFinishPullRequestTool(remoteMoved).execute(
        { worktreeId: row.id, action: "merge", method: "squash" },
        context(),
      ),
      /does not equal local HEAD/,
    );

    const prMoved = operations({
      localState: async () => ({
        branch: row.branch,
        head: "e".repeat(40),
        clean: true,
      }),
      remoteHead: async () => "e".repeat(40),
    });
    await assert.rejects(
      createWorktreeFinishPullRequestTool(prMoved).execute(
        { worktreeId: row.id, action: "merge", method: "squash" },
        context(),
      ),
      /pull request head .* does not equal the managed branch head/,
    );
    assert.deepEqual(dirty.calls.merges, []);
    assert.deepEqual(remoteMoved.calls.merges, []);
    assert.deepEqual(prMoved.calls.merges, []);
  });

  test("a detached HEAD or a foreign upstream refuses", async () => {
    const detached = operations({
      localState: async () => ({ branch: "", head: HEAD, clean: true }),
    });
    await assert.rejects(
      createWorktreeFinishPullRequestTool(detached).execute(
        { worktreeId: row.id, action: "merge", method: "squash" },
        context(),
      ),
      /detached HEAD/,
    );
    const foreign = operations({
      target: async () => ({
        side: DEFAULT_WORKER_SIDE,
        repoRoot: "/repo",
        remote: "origin",
        upstream: { remote: "fork", branch: row.branch },
      }),
    });
    await assert.rejects(
      createWorktreeFinishPullRequestTool(foreign).execute(
        { worktreeId: row.id, action: "merge", method: "squash" },
        context(),
      ),
      /must track origin\/feature/,
    );
  });

  // The finish tool re-reads readiness itself: a model's memory of a green run
  // is not evidence about the head in front of it now.
  test("every readiness blocker refuses legibly", async () => {
    for (const blockers of [
      ["checks_pending"],
      ["checks_not_found"],
      ["checks_truncated"],
      ["checks_failed"],
      ["mergeability_unknown"],
      ["provider_not_mergeable"],
      ["review_unknown"],
      ["changes_requested"],
    ]) {
      const ops = operations({
        readiness: async () =>
          readiness({ canMergeNow: false, mergeBlockers: blockers }),
      });
      await assert.rejects(
        createWorktreeFinishPullRequestTool(ops).execute(
          { worktreeId: row.id, action: "merge", method: "squash" },
          context(),
        ),
        new RegExp(`not ready to merge: ${blockers[0]}`),
      );
      assert.deepEqual(ops.calls.merges, []);
    }
  });

  test("a head that moved between resolution and the readiness read refuses", async () => {
    const ops = operations({
      readiness: async () =>
        readiness({
          detail: { ...readiness().detail, headSha: "f".repeat(40) },
        }),
    });
    await assert.rejects(
      createWorktreeFinishPullRequestTool(ops).execute(
        { worktreeId: row.id, action: "merge", method: "squash" },
        context(),
      ),
      /head moved from/,
    );
    assert.deepEqual(ops.calls.merges, []);
  });

  test("a base retargeted during readiness never bypasses approval", async () => {
    const ops = operations({
      readiness: async () =>
        readiness({
          detail: { ...readiness().detail, baseBranch: "main" },
        }),
    });
    await assert.rejects(
      createWorktreeFinishPullRequestTool(ops).execute(
        { worktreeId: row.id, action: "merge", method: "squash" },
        context(),
      ),
      /changed from feature → release-2 to feature → main/,
    );
    assert.deepEqual(ops.calls.merges, []);
    assert.deepEqual(ops.calls.approvals, []);
  });

  test("a provider refusal reaches the caller unchanged", async () => {
    const ops = operations({
      merge: async () => {
        throw new Error("Required status check 'ci' is expected.");
      },
    });
    await assert.rejects(
      createWorktreeFinishPullRequestTool(ops).execute(
        { worktreeId: row.id, action: "merge", method: "squash" },
        context(),
      ),
      /Required status check/,
    );
  });
});

describe("merge into the default branch", () => {
  const defaultBaseCapabilities: PullRequestRepositoryCapabilities = {
    defaultBranch: row.baseBranch,
    mergeMethods: ["squash", "merge"],
    canClose: true,
  };

  test("stages one fully evidenced approval and merges nothing", async () => {
    const ops = operations({}, defaultBaseCapabilities);
    const result = await createWorktreeFinishPullRequestTool(ops).execute(
      {
        worktreeId: row.id,
        action: "merge",
        method: "squash",
        deleteRemoteBranch: false,
      },
      context(),
    );
    assert.deepEqual(ops.calls.merges, [], "no provider merge in this call");
    assert.equal(ops.calls.approvals.length, 1);
    const body = ops.calls.approvals[0]!;
    assert.deepEqual(body, {
      kind: "managedPullRequestMerge",
      provider: "github",
      repo: "acme/project",
      worktreeId: row.id,
      projectId: "project",
      number: 91,
      url: "https://github.com/acme/project/pull/91",
      title: "Task-588: finish the loop",
      headBranch: row.branch,
      baseBranch: row.baseBranch,
      defaultBranch: row.baseBranch,
      headSha: HEAD,
      method: "squash",
      supportedMethods: ["squash", "merge"],
      deleteRemoteBranch: false,
      markTaskDone: false,
      removeWorktree: false,
      checks: { state: "success", total: 2, finished: true },
      review: { changesRequested: false },
      mergeable: true,
      draft: false,
      linkedTask: { id: "588", title: "Finish the delivery loop" },
    });
    const payload = details(result);
    assert.equal(payload.status, "approval-pending");
    assert.equal(payload.approvalRequired, true);
    assert.equal(payload.merged, false);
    assert.equal(payload.baseIsDefaultBranch, true);
    // The turn ends: only a human answers this.
    assert.equal(result.terminate, true);

    // Re-staging the same pull request replaces the earlier card; another
    // pull request, repository or approval kind does not.
    const supersedes = ops.calls.supersedes[0]!;
    const earlier = (
      patch: Partial<ManagedPullRequestMergeApprovalBody>,
    ): ApprovalCard => ({
      renderKind: "approval",
      id: "appr-0",
      sessionId: "s",
      kind: "managedPullRequestMerge",
      status: "pending",
      title: "Merge #91 into main",
      createdAt: 0,
      body: { ...body, headSha: "0".repeat(40), ...patch },
    });
    assert.equal(supersedes(earlier({})), true);
    assert.equal(supersedes(earlier({ number: 92 })), false);
    assert.equal(supersedes(earlier({ repo: "acme/other" })), false);
    assert.equal(supersedes(earlier({ provider: "forgejo" })), false);
    assert.equal(
      supersedes({
        ...earlier({}),
        kind: "commit",
        body: { kind: "commit", message: "wip", files: [] },
      }),
      false,
    );
  });

  test("readiness and capability refusals precede the approval", async () => {
    const notReady = operations(
      {
        readiness: async () =>
          readiness({ canMergeNow: false, mergeBlockers: ["checks_failed"] }),
      },
      defaultBaseCapabilities,
    );
    await assert.rejects(
      createWorktreeFinishPullRequestTool(notReady).execute(
        { worktreeId: row.id, action: "merge", method: "squash" },
        context(),
      ),
      /not ready to merge/,
    );
    assert.deepEqual(notReady.calls.approvals, []);

    const unsupported = operations({}, defaultBaseCapabilities);
    await assert.rejects(
      createWorktreeFinishPullRequestTool(unsupported).execute(
        { worktreeId: row.id, action: "merge", method: "rebase" },
        context(),
      ),
      /does not allow the rebase merge method/,
    );
    assert.deepEqual(unsupported.calls.approvals, []);
  });
});

/* --------------------------- the approval executor -------------------------- */

describe("approved default-branch merge", () => {
  let ops: ReturnType<typeof operations>;

  const approvalBody = (
    patch: Partial<ManagedPullRequestMergeApprovalBody> = {},
  ): ManagedPullRequestMergeApprovalBody => ({
    kind: "managedPullRequestMerge",
    provider: "github",
    repo: "acme/project",
    worktreeId: row.id,
    projectId: row.projectId ?? undefined,
    number: 91,
    url: "https://github.com/acme/project/pull/91",
    title: "Task-588: finish the loop",
    headBranch: row.branch,
    baseBranch: row.baseBranch,
    defaultBranch: row.baseBranch,
    headSha: HEAD,
    method: "squash",
    supportedMethods: ["squash", "merge"],
    deleteRemoteBranch: true,
    checks: { state: "success", finished: true },
    review: { changesRequested: false },
    mergeable: true,
    draft: false,
    ...patch,
  });

  function card(
    body: ManagedPullRequestMergeApprovalBody = approvalBody(),
  ): ApprovalCard {
    return {
      renderKind: "approval",
      id: "appr-1",
      sessionId: "caller-session",
      kind: "managedPullRequestMerge",
      status: "pending",
      title: "Merge #91",
      createdAt: 1,
      body,
    };
  }

  beforeEach(() => {
    ops = operations(
      {},
      {
        defaultBranch: row.baseBranch,
        mergeMethods: ["squash", "merge"],
        canClose: true,
      },
    );
    setManagedMergeApprovalOperationsForTests(ops);
    return () => setManagedMergeApprovalOperationsForTests();
  });

  const run = managedPullRequestMergeApprovalExecutor;

  test("revalidates everything and merges through the same seam", async () => {
    await run.prepare?.(card(), undefined);
    const outcome = await run.execute(card(), {});
    assert.deepEqual(ops.calls.merges, [
      {
        number: 91,
        method: "squash",
        expectedHeadSha: HEAD,
        deleteBranch: true,
        worktreeId: row.id,
        actorKind: "user",
      },
    ]);
    assert.match(outcome.resultSummary, /Merged #91/);
  });

  test("approval carries the choices and applies them as the requesting agent after merging", async () => {
    const task = ops.task("588")!;
    ops.cards = async () => [managedCard({ linkedTask: task })];
    let followUps = 0;
    ops.followUps = async (input) => {
      assert.equal(ops.calls.merges.length, 1);
      assert.equal(ops.calls.released, 2);
      assert.equal(input.sessionId, "caller-session");
      assert.equal(input.taskId, task.id);
      assert.equal(input.markTaskDone, true);
      assert.equal(input.removeWorktree, true);
      followUps++;
      return {
        task: { id: task.id, status: "done" },
        worktreeRemoved: false,
        warnings: ["The worktree was kept: dirty"],
      };
    };
    await createWorktreeFinishPullRequestTool(ops).execute(
      {
        worktreeId: row.id,
        action: "merge",
        method: "squash",
        markTaskDone: true,
        removeWorktree: true,
      },
      context(),
    );
    assert.equal(followUps, 0);
    const body = ops.calls.approvals[0]!;
    assert.equal(body.markTaskDone, true);
    assert.equal(body.removeWorktree, true);
    const outcome = await run.execute(card(body), {});
    assert.equal(followUps, 1);
    assert.equal(body.resultMerged, true);
    assert.equal(body.resultWorktreeRemoved, false);
    assert.match(outcome.resultSummary, /Merged #91.*worktree was kept/);
  });

  test("approval follow-up failures retain the confirmed merge outcome", async () => {
    ops.followUps = async () => {
      throw new Error("cleanup unavailable");
    };
    ops.invalidate = () => {
      throw new Error("cache unavailable");
    };
    const body = approvalBody({ removeWorktree: true });
    const outcome = await run.execute(card(body), {});
    assert.equal(body.resultMerged, true);
    assert.match(outcome.resultSummary, /Merged #91.*cleanup unavailable/);
    assert.equal(ops.calls.released, 1);
  });

  test("approval refuses a changed linked Task before merging", async () => {
    ops.cards = async () => [
      managedCard({ linkedTask: { ...ops.task("588")!, id: "other" } }),
    ];
    await assert.rejects(
      run.execute(
        card(
          approvalBody({
            markTaskDone: true,
            linkedTask: { id: "588", title: "Task" },
          }),
        ),
        {},
      ),
      /linked Task changed/,
    );
    assert.deepEqual(ops.calls.merges, []);
  });

  test("an approved merge the provider has not confirmed records no merged result", async () => {
    const pendingOps = {
      ...ops,
      merge: async (
        input: Parameters<WorktreeFinishPullRequestOperations["merge"]>[0],
      ) => ({
        result: {
          outcome: "pending" as const,
          number: input.number,
          method: input.method,
          requestId: "req-1",
          pendingReason:
            "GitHub had not finished merging it when this stopped waiting",
        },
        message: `GitHub accepted the merge of #${input.number} into ${input.baseBranch} (${input.method}) but has not confirmed it: GitHub had not finished merging it when this stopped waiting.`,
        cardIds: [],
        taskSuggestions: [],
      }),
    };
    let followUps = 0;
    pendingOps.followUps = async () => {
      followUps++;
      return { warnings: [] };
    };
    setManagedMergeApprovalOperationsForTests(pendingOps);
    const subject = card(approvalBody({ removeWorktree: true }));
    const outcome = await run.execute(subject, {});
    assert.match(outcome.resultSummary, /has not confirmed it/);
    assert.match(
      outcome.resultSummary,
      /Not done, because the merge is not confirmed: removing the worktree\./,
    );
    assert.equal(followUps, 0);
    assert.equal(
      subject.body.kind === "managedPullRequestMerge" &&
        subject.body.resultMerged,
      undefined,
    );
  });

  test("a moved head refuses instead of merging what was not approved", async () => {
    ops.readiness = async () =>
      readiness({ detail: { ...readiness().detail, headSha: "9".repeat(40) } });
    ops.hosting = async () => ({
      provider: provider({
        pullRequestDetail: async () => ({
          number: 91,
          state: "open" as const,
          merged: false,
          mergeable: true,
          draft: false,
          headSha: "9".repeat(40),
          headBranch: row.branch,
          baseBranch: row.baseBranch,
        }),
      }),
      repository: { host: "github.com", owner: "acme", repo: "project" },
    });
    await assert.rejects(
      run.execute(card(), {}),
      /head moved from the approved/,
    );
    assert.deepEqual(ops.calls.merges, []);
  });

  // The approval answered ONE question. A base that is no longer the default
  // branch is a different act, never a silent direct merge.
  test("a base that is no longer the default branch refuses", async () => {
    ops.capabilities = async () => ({
      defaultBranch: "main",
      mergeMethods: ["squash", "merge"],
      canClose: true,
    });
    await assert.rejects(
      run.execute(card(), {}),
      /no longer the repository default branch/,
    );
    assert.deepEqual(ops.calls.merges, []);
  });

  // The card froze the whole set, not just the chosen method: the user answered
  // "squash, out of these". A repository that has since gained or lost another
  // method is a different question from the one that was approved.
  test("a changed supported-method set refuses even when the method survives", async () => {
    ops.capabilities = async () => ({
      defaultBranch: row.baseBranch,
      // `squash` — the approved method — is still allowed; `rebase` is new.
      mergeMethods: ["squash", "merge", "rebase"],
      canClose: true,
    });
    await assert.rejects(
      run.execute(card(), {}),
      /supported merge methods changed from the approved squash, merge to squash, merge, rebase/,
    );
    assert.deepEqual(ops.calls.merges, []);
  });

  test("a method the repository stopped allowing refuses", async () => {
    ops.capabilities = async () => ({
      defaultBranch: row.baseBranch,
      mergeMethods: ["merge"],
      canClose: true,
    });
    await assert.rejects(
      run.execute(card(), {}),
      /does not allow the squash merge method/,
    );
    assert.deepEqual(ops.calls.merges, []);
  });

  test("a busy worktree refuses the approved merge", async () => {
    ops.reserve = () => undefined;
    await assert.rejects(run.execute(card(), {}), /worktree is busy/);
    assert.deepEqual(ops.calls.merges, []);
  });

  test("a pull request closed while the card waited refuses", async () => {
    ops.hosting = async () => ({
      provider: provider({
        findPullRequestsForBranch: async () => ({
          open: [],
          latestTerminal: {
            number: 91,
            url: "u",
            title: "t",
            state: "closed" as const,
          },
        }),
      }),
      repository: { host: "github.com", owner: "acme", repo: "project" },
    });
    await assert.rejects(run.execute(card(), {}), /already closed/);
    assert.deepEqual(ops.calls.merges, []);
  });

  test("readiness that decayed while the card waited refuses", async () => {
    ops.readiness = async () =>
      readiness({ canMergeNow: false, mergeBlockers: ["changes_requested"] });
    await assert.rejects(run.execute(card(), {}), /not ready to merge/);
    assert.deepEqual(ops.calls.merges, []);
  });

  test("a worktree that now delivers another branch refuses", async () => {
    ops.resolve = async () => ({ ...row, branch: "other-branch" });
    await assert.rejects(run.execute(card(), {}), /now delivers other-branch/);
    assert.deepEqual(ops.calls.merges, []);
  });

  test("a changed repository or project refuses frozen approval evidence", async () => {
    ops.hosting = async () => ({
      provider: provider({
        repository: { host: "github.com", owner: "acme", repo: "other" },
      }),
      repository: { host: "github.com", owner: "acme", repo: "other" },
    });
    await assert.rejects(run.execute(card(), {}), /repository acme\/other/);
    assert.deepEqual(ops.calls.merges, []);

    ops = operations(
      { resolve: async () => ({ ...row, projectId: "different" }) },
      {
        defaultBranch: row.baseBranch,
        mergeMethods: ["squash", "merge"],
        canClose: true,
      },
    );
    setManagedMergeApprovalOperationsForTests(ops);
    await assert.rejects(run.execute(card(), {}), /project changed/);
    assert.deepEqual(ops.calls.merges, []);
  });
});
