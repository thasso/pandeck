/**
 * `worktree_update_pull_request_body`: the caller's body, or a regenerated one,
 * on the worktree's own canonical pull request and nowhere else. These tests
 * drive it through injected seams and assert the refusals — a credential in
 * caller text, another worktree's PR, a PR that moved, a regeneration from an
 * unpushed HEAD — as much as the write and its read-back.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { PullRequestCard } from "@assistant/shared";
import type { GitHostingProvider } from "../../gitHosting.ts";
import type { WorktreeRow } from "../../db/worktreeStore.ts";
import type { ToolCallContext } from "../../mcp/tool.ts";
import {
  createWorktreeUpdatePullRequestBodyTool,
  type WorktreePullRequestBodyOperations,
} from "./worktreePullRequestBody.ts";
import { DEFAULT_WORKER_SIDE } from "../../workers/placement.ts";

const HEAD = "d".repeat(40);

const row: WorktreeRow = {
  id: "wt-target",
  projectId: "project",
  mainRepoRoot: "/repo",
  path: "/repo/worktrees/target",
  branch: "feature",
  baseBranch: "main",
  baseCommit: "abc",
  status: "active",
  mergeStateJson: null,
  createdAt: 1,
  updatedAt: 1,
  removedAt: null,
};

function context(): ToolCallContext {
  return {
    toolCallId: "call-body",
    session: {
      sessionId: "caller-session",
      harness: "pi",
      agentType: "developer",
      cwd: "/repo/worktrees/other",
    },
  };
}

function card(patch: Partial<PullRequestCard> = {}): PullRequestCard {
  return {
    renderKind: "pullRequest",
    id: "card-managed",
    sessionId: "s",
    status: "open",
    provider: "github",
    number: 91,
    url: "https://github.com/acme/project/pull/91",
    title: "Task-947: caller bodies",
    headBranch: row.branch,
    baseBranch: row.baseBranch,
    warnings: [],
    worktreeId: row.id,
    linkedTask: {
      id: "947",
      title: "Caller bodies",
      status: "doing",
      source: { createdBy: "user" },
      createdAt: 1,
      updatedAt: 1,
    },
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

interface Recorder {
  released: number;
  writes: Array<{ number: number; body: string }>;
  projected: Array<{ cardIds: string[]; body: string }>;
  drafts: Array<Parameters<WorktreePullRequestBodyOperations["draft"]>[0]>;
  detailReads: number;
}

function operations(
  options: {
    provider?: Partial<GitHostingProvider>;
    stored?: string;
    overrides?: Partial<WorktreePullRequestBodyOperations>;
  } = {},
): WorktreePullRequestBodyOperations & { calls: Recorder } {
  const calls: Recorder = {
    released: 0,
    writes: [],
    projected: [],
    drafts: [],
    detailReads: 0,
  };
  let stored = options.stored ?? "Generated body";
  const provider = {
    kind: "github",
    repository: { host: "github.com", owner: "acme", repo: "project" },
    repoWebUrl: "https://github.com/acme/project",
    findPullRequestsForBranch: async () => ({
      open: [
        {
          number: 91,
          url: "https://github.com/acme/project/pull/91",
          title: "Task-947: caller bodies",
          state: "open" as const,
        },
      ],
    }),
    pullRequestDetail: async () => {
      calls.detailReads += 1;
      return {
        number: 91,
        state: "open" as const,
        merged: false,
        mergeable: true,
        draft: false,
        headSha: HEAD,
        headBranch: row.branch,
        baseBranch: row.baseBranch,
      };
    },
    pullRequestBody: async () => stored,
    editPullRequestBody: async (number: number, body: string) => {
      calls.writes.push({ number, body });
      stored = body;
      return {};
    },
    ...options.provider,
  } as GitHostingProvider;
  return {
    calls,
    resolve: async () => row,
    reserve: () => () => {
      calls.released += 1;
    },
    localState: async () => ({ branch: row.branch, head: HEAD, clean: true }),
    target: async () => ({
      side: DEFAULT_WORKER_SIDE,
      repoRoot: "/repo",
      remote: "origin",
      upstream: { remote: "origin", branch: row.branch },
    }),
    remoteHead: async () => HEAD,
    hosting: async () => ({
      provider,
      repository: { host: "github.com", owner: "acme", repo: "project" },
    }),
    capabilities: async () => ({
      defaultBranch: "main",
      mergeMethods: ["squash"],
      canClose: true,
    }),
    readiness: async () => {
      throw new Error("not used");
    },
    cards: async () => [card()],
    merge: async () => {
      throw new Error("not used");
    },
    close: async () => {
      throw new Error("not used");
    },
    approve: () => {
      throw new Error("not used");
    },
    followUps: async () => ({ warnings: [] }),
    taskIds: () => [],
    task: () => undefined,
    invalidate: () => {},
    projectReady: () => {},
    projectRetarget: () => {},
    inventoryChanged: () => {},
    draft: async (input) => {
      calls.drafts.push(input);
      return {
        title: "Ignored title",
        body: ["## Summary", "Regenerated body"],
        warnings: ["Tests are thin"],
      };
    },
    projectBody: (cards, body) => {
      calls.projected.push({ cardIds: cards.map((item) => item.id), body });
    },
    ...options.overrides,
  };
}

function details(result: { details?: unknown }): Record<string, unknown> {
  return result.details as Record<string, unknown>;
}

const tool = (ops: WorktreePullRequestBodyOperations) =>
  createWorktreeUpdatePullRequestBodyTool(ops);

describe("worktree_update_pull_request_body", () => {
  test("replaces the body with the caller's text, reads it back and projects the cards", async () => {
    const ops = operations();
    const body = "## Summary\n\nFixed.\n\n## Notes for Percy\n\n- Agreed.";
    const result = await tool(ops).execute(
      { worktreeId: row.id, body: `  ${body}\n` },
      context(),
    );
    assert.deepEqual(ops.calls.writes, [{ number: 91, body }]);
    assert.deepEqual(ops.calls.projected, [
      { cardIds: ["card-managed"], body },
    ]);
    assert.equal(ops.calls.drafts.length, 0);
    assert.equal(ops.calls.released, 1);
    assert.deepEqual(details(result), {
      status: "updated",
      provider: "github",
      number: 91,
      url: "https://github.com/acme/project/pull/91",
      source: "caller",
      bodyChars: body.length,
      cardIds: ["card-managed"],
    });
  });

  test("regenerates from the pushed head with the linked Task and context", async () => {
    const ops = operations();
    const result = await tool(ops).execute(
      { worktreeId: row.id, context: "The retry decision changed" },
      context(),
    );
    assert.equal(ops.calls.drafts.length, 1);
    const draft = ops.calls.drafts[0]!;
    assert.deepEqual(
      {
        repoRoot: draft.repoRoot,
        headBranch: draft.headBranch,
        baseBranch: draft.baseBranch,
        taskId: draft.taskId,
        additionalContext: draft.additionalContext,
        sourceSessionId: draft.helperSource.sourceSessionId,
      },
      {
        repoRoot: row.path,
        headBranch: row.branch,
        baseBranch: row.baseBranch,
        taskId: "947",
        additionalContext: "The retry decision changed",
        sourceSessionId: "caller-session",
      },
    );
    assert.deepEqual(ops.calls.writes, [
      { number: 91, body: "## Summary\n\nRegenerated body" },
    ]);
    assert.equal(details(result).source, "agent");
    assert.deepEqual(details(result).warnings, ["Tests are thin"]);
  });

  test("refuses a credential, blank or oversized body, and context with body, before any read", async () => {
    let resolved = 0;
    const ops = operations({
      overrides: {
        resolve: async () => {
          resolved += 1;
          return row;
        },
      },
    });
    for (const [params, error] of [
      [
        { body: `Staging token: ${"ghp_" + "a".repeat(36)}` },
        /body looks like it contains a credential.*cannot be overridden/,
      ],
      [
        { body: `Config:\n\n    password: ${'"' + "hunter2-but-longer"}"` },
        /body looks like it contains a credential/,
      ],
      [{ body: "   " }, /body must not be blank/],
      [{ body: "x".repeat(65_537) }, /body exceeds 65536 characters/],
      [
        { body: "Fine", context: "Also regenerate" },
        /context only guides a regenerated body/,
      ],
    ] as const)
      await assert.rejects(
        tool(ops).execute({ worktreeId: row.id, ...params }, context()),
        error,
      );
    assert.equal(resolved, 0);
    assert.deepEqual(ops.calls.writes, []);
  });

  test("never reaches a PR whose live card belongs to another worktree, or main", async () => {
    const foreign = operations({
      overrides: {
        cards: async () => [card({ worktreeId: "wt-other" })],
      },
    });
    await assert.rejects(
      tool(foreign).execute({ worktreeId: row.id, body: "Body" }, context()),
      /owned by worktree wt-other/,
    );
    // One checkout publishing to two repositories that both have a #91: the
    // card for acme/project must not authorize a write to acme/fork.
    const otherRepository = operations({
      overrides: {
        cards: async () => [
          card({ url: "https://github.com/acme/fork/pull/91" }),
        ],
      },
    });
    await assert.rejects(
      tool(otherRepository).execute(
        { worktreeId: row.id, body: "Body" },
        context(),
      ),
      /live card for acme\/fork, not acme\/project; nothing was done/,
    );
    const urlless = card();
    delete urlless.url;
    const unknownRepository = operations({
      overrides: { cards: async () => [urlless] },
    });
    await assert.rejects(
      tool(unknownRepository).execute(
        { worktreeId: row.id, body: "Body" },
        context(),
      ),
      /live card for an unknown repository/,
    );
    const unanchored = operations({ overrides: { cards: async () => [] } });
    await assert.rejects(
      tool(unanchored).execute({ worktreeId: row.id, body: "Body" }, context()),
      /no open managed card/,
    );
    const main = operations();
    await assert.rejects(
      tool(main).execute(
        { worktreeId: "main:project", body: "Body" },
        context(),
      ),
      /active spawned worktree id is required/,
    );
    assert.deepEqual(
      [
        ...foreign.calls.writes,
        ...otherRepository.calls.writes,
        ...unknownRepository.calls.writes,
        ...unanchored.calls.writes,
        ...main.calls.writes,
      ],
      [],
    );
  });

  test("refuses to regenerate from a local HEAD the PR does not hold", async () => {
    const ops = operations({
      overrides: {
        localState: async () => ({
          branch: row.branch,
          head: "e".repeat(40),
          clean: true,
        }),
      },
    });
    await assert.rejects(
      tool(ops).execute({ worktreeId: row.id }, context()),
      /is not pull request #91's head .*Nothing was changed/,
    );
    assert.equal(ops.calls.drafts.length, 0);
    assert.deepEqual(ops.calls.writes, []);
  });

  test("refuses when the PR moved before the locked write", async () => {
    let reads = 0;
    const ops = operations({
      provider: {
        pullRequestDetail: async () => ({
          number: 91,
          state: "open" as const,
          merged: false,
          mergeable: true,
          draft: false,
          // Target resolution sees HEAD; the locked re-read sees a new push.
          headSha: (reads += 1) === 1 ? HEAD : "f".repeat(40),
          headBranch: row.branch,
          baseBranch: row.baseBranch,
        }),
      },
    });
    await assert.rejects(
      tool(ops).execute({ worktreeId: row.id, body: "Body" }, context()),
      /changed while preparing its body update; nothing was changed/,
    );
    assert.deepEqual(ops.calls.writes, []);
  });

  test("an identical body writes nothing but repairs the cards", async () => {
    const ops = operations({ stored: "Same body\r\n" });
    const result = await tool(ops).execute(
      { worktreeId: row.id, body: "Same body" },
      context(),
    );
    assert.equal(details(result).status, "unchanged");
    assert.deepEqual(ops.calls.writes, []);
    assert.deepEqual(ops.calls.projected, [
      { cardIds: ["card-managed"], body: "Same body" },
    ]);
  });

  test("retrying a write whose read-back was lost repairs the stale card without another write", async () => {
    let stored = "Old body";
    let bodyReads = 0;
    const ops = operations({
      provider: {
        pullRequestBody: async () => {
          bodyReads += 1;
          // The first call's read-back times out after its write landed.
          if (bodyReads === 2) throw new Error("timeout");
          return stored;
        },
        editPullRequestBody: async (_number, body) => {
          ops.calls.writes.push({ number: 91, body });
          stored = body;
          return {};
        },
      },
    });
    const first = await tool(ops).execute(
      { worktreeId: row.id, body: "New body" },
      context(),
    );
    assert.equal(details(first).status, "updated-partial");
    assert.deepEqual(ops.calls.projected, []);

    const retry = await tool(ops).execute(
      { worktreeId: row.id, body: "New body" },
      context(),
    );
    assert.equal(details(retry).status, "unchanged");
    assert.equal(ops.calls.writes.length, 1);
    assert.deepEqual(ops.calls.projected, [
      { cardIds: ["card-managed"], body: "New body" },
    ]);
  });

  test("a failed write is judged by its read-back", async () => {
    let stored = "Old body";
    const refused = operations({
      provider: {
        pullRequestBody: async () => stored,
        editPullRequestBody: async () => {
          throw new Error("Validation Failed");
        },
      },
    });
    await assert.rejects(
      tool(refused).execute(
        { worktreeId: row.id, body: "New body" },
        context(),
      ),
      /github refused the body update for pull request #91: Validation Failed\. Nothing was changed/,
    );
    assert.deepEqual(refused.calls.projected, []);

    const landed = operations({
      provider: {
        pullRequestBody: async () => stored,
        editPullRequestBody: async (_number, body) => {
          stored = body;
          throw new Error("socket hang up");
        },
      },
    });
    const result = await tool(landed).execute(
      { worktreeId: row.id, body: "New body" },
      context(),
    );
    assert.equal(details(result).status, "updated-partial");
    assert.match(
      String(details(result).message),
      /reported an error \(socket hang up\), but the read-back shows the new body/,
    );
    assert.deepEqual(landed.calls.projected, [
      { cardIds: ["card-managed"], body: "New body" },
    ]);

    stored = "Old body";
    let bodyReads = 0;
    const unknown = operations({
      provider: {
        pullRequestBody: async () => {
          bodyReads += 1;
          if (bodyReads > 1) throw new Error("timeout");
          return stored;
        },
        editPullRequestBody: async () => {
          throw new Error("socket hang up");
        },
      },
    });
    await assert.rejects(
      tool(unknown).execute(
        { worktreeId: row.id, body: "New body" },
        context(),
      ),
      /outcome is unknown; read the pull request before retrying/,
    );
  });

  test("a write whose read-back differs or cannot be read is partial and leaves the cards", async () => {
    const differs = operations({
      provider: {
        pullRequestBody: async () => "Old body",
        editPullRequestBody: async () => ({}),
      },
    });
    const result = await tool(differs).execute(
      { worktreeId: row.id, body: "New body" },
      context(),
    );
    assert.equal(details(result).status, "updated-partial");
    assert.match(String(details(result).message), /read back differs/);
    assert.deepEqual(differs.calls.projected, []);

    let reads = 0;
    const unread = operations({
      provider: {
        pullRequestBody: async () => {
          reads += 1;
          if (reads > 1) throw new Error("timeout");
          return "Old body";
        },
        editPullRequestBody: async () => ({}),
      },
    });
    const partial = await tool(unread).execute(
      { worktreeId: row.id, body: "New body" },
      context(),
    );
    assert.equal(details(partial).status, "updated-partial");
    assert.match(String(details(partial).message), /could not be read back/);
    assert.deepEqual(unread.calls.projected, []);
  });
});
