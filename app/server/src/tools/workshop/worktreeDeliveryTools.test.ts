import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import type { PullRequestCard } from "@assistant/shared";
import type { CommitWorkflowResult } from "../../commitWorkflow.ts";
import type { GitHostingProvider } from "../../gitHosting.ts";
import type {
  PushWorkflowOptions,
  PushWorkflowResult,
  ResolvedPushTarget,
} from "../../pushWorkflow.ts";
import type { WorktreeRow } from "../../db/worktreeStore.ts";
import type { ToolCallContext } from "../../mcp/tool.ts";
import {
  assertMatchingManagedPullRequestTitleIntent,
  createWorktreeCommitTool,
  defaultPullRequestOperations,
  managedCommitOverrideApprovalExecutor,
  setCommitOverrideApprovalOperationsForTests,
  createWorktreePullRequestTool,
  createWorktreePushTool,
  type WorktreeCommitOperations,
  type WorktreePullRequestOperations,
  type WorktreePushOperations,
} from "./worktreeDeliveryTools.ts";
import {
  createApproval,
  approvalForId,
  approvalGrantsForSession,
  resolveApproval,
} from "../../pendingApprovals.ts";
import {
  createPullRequestCard,
  pullRequestCardById,
  resetPullRequestCardsStoreForTests,
} from "../../pullRequestCards.ts";

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

function commitResult(
  patch: Partial<CommitWorkflowResult> = {},
): CommitWorkflowResult {
  return {
    status: "committed",
    source: "tool",
    dryRun: false,
    forced: false,
    commitHash: "123456789abc",
    commitMessage: "Add checked commit tool",
    files: [
      {
        path: "src/commit.ts",
        status: "modified",
        additions: 4,
        deletions: 1,
      },
    ],
    totals: { files: 1, additions: 4, deletions: 1 },
    blockers: [],
    warnings: [],
    includedUserEntryIds: ["prompt-1"],
    sessionTouchedPaths: ["src/commit.ts"],
    addressedTasks: [],
    createdAt: 1,
    ...patch,
  };
}

function context(progress?: ToolCallContext["progress"]): ToolCallContext {
  return {
    toolCallId: "call-1",
    session: {
      sessionId: "caller-on-another-worktree",
      harness: "pi",
      agentType: "developer",
      cwd: "/repo/worktrees/other",
      sessionManager: {
        getSessionId: () => "caller-on-another-worktree",
        getBranch: () => [],
        appendCustomEntry: () => "commit-entry",
      },
    },
    ...(progress ? { progress } : {}),
  };
}

function operations(
  overrides: Partial<WorktreeCommitOperations> = {},
): WorktreeCommitOperations & {
  calls: { released: number; invalidated: number; options?: unknown };
} {
  const calls = { released: 0, invalidated: 0, options: undefined as unknown };
  return {
    calls,
    resolve: async () => row,
    reserve: () => () => {
      calls.released += 1;
    },
    checkedOutBranch: async () => row.branch,
    runCommit: async (options) => {
      calls.options = options;
      options.onProgress?.("Generating commit message…");
      return commitResult();
    },
    approve: createApproval,
    invalidate: () => {
      calls.invalidated += 1;
    },
    ...overrides,
  };
}

afterEach(() => {
  setCommitOverrideApprovalOperationsForTests();
});

describe("worktree_commit", () => {
  test("projects a rich CommitDisplay and caller context without force", async () => {
    const partials: unknown[] = [];
    const ops = operations();
    const result = await createWorktreeCommitTool(ops).execute(
      { worktreeId: row.id, context: "Implement the managed delivery slice" },
      context((partial) => partials.push(partial.details)),
    );

    assert.deepEqual(result.details, {
      status: "committed",
      dryRun: false,
      forced: false,
      commitHash: "123456789abc",
      commitMessage: "Add checked commit tool",
      blockers: [],
      warnings: [],
      files: [
        {
          path: "src/commit.ts",
          status: "modified",
          additions: 4,
          deletions: 1,
        },
      ],
      totals: { files: 1, additions: 4, deletions: 1 },
      addressedTasks: [],
      canAcceptDryRun: false,
    });
    assert.equal(result.content[0]?.type, "text");
    assert.deepEqual(partials, [
      { status: "running", message: "Generating commit message…" },
    ]);
    assert.deepEqual(
      {
        source: (ops.calls.options as Record<string, unknown>).source,
        force: (ops.calls.options as Record<string, unknown>).force,
        cwd: (ops.calls.options as Record<string, unknown>).cwd,
        expectedBranch: (ops.calls.options as Record<string, unknown>)
          .expectedBranch,
        additionalContext: (ops.calls.options as Record<string, unknown>)
          .additionalContext,
        stagedOnly: (ops.calls.options as Record<string, unknown>).stagedOnly,
        sessionKind: (ops.calls.options as Record<string, unknown>).sessionKind,
        sessionId: (ops.calls.options as Record<string, unknown>).sessionId,
        hasSessionManager: Boolean(
          (ops.calls.options as Record<string, unknown>).sessionManager,
        ),
      },
      {
        source: "tool",
        force: false,
        cwd: row.path,
        expectedBranch: row.branch,
        additionalContext: "Implement the managed delivery slice",
        stagedOnly: false,
        sessionKind: "developer",
        sessionId: "caller-on-another-worktree",
        hasSessionManager: true,
      },
    );
    assert.equal(ops.calls.invalidated, 1);
    assert.equal(ops.calls.released, 1);
  });

  test("stagedOnly reaches the workflow only as an explicit true and is projected", async () => {
    const ops = operations({
      runCommit: async (options) => {
        ops.calls.options = options;
        return { ...commitResult(), stagedOnly: true };
      },
    });
    const result = await createWorktreeCommitTool(ops).execute(
      { worktreeId: row.id, stagedOnly: true },
      context(),
    );
    assert.equal(
      (ops.calls.options as Record<string, unknown>).stagedOnly,
      true,
    );
    assert.equal((result.details as Record<string, unknown>).stagedOnly, true);
  });

  test("ordinary no-change and safety blocks stay structured", async () => {
    for (const blocker of [
      { kind: "unclear", reason: "No changes to commit." },
      { kind: "secret", file: ".env", reason: "Suspicious environment file." },
      { kind: "unsafe", reason: "Unresolved merge conflict." },
      { kind: "too_broad", reason: "Diff is very large." },
    ] as const) {
      const ops = operations({
        runCommit: async () => {
          const result = commitResult({
            status: "blocked",
            blockers: [blocker],
          });
          delete result.commitHash;
          return result;
        },
      });
      const result = await createWorktreeCommitTool(ops).execute(
        { worktreeId: row.id },
        context(),
      );
      assert.equal((result.details as { status: string }).status, "blocked");
      assert.deepEqual((result.details as { blockers: unknown[] }).blockers, [
        blocker,
      ]);
      assert.equal(ops.calls.released, 1);
    }
  });

  test("refuses synthetic main, unavailable rows, busy writers, and branch mismatch", async () => {
    const mainOps = operations();
    await assert.rejects(
      createWorktreeCommitTool(mainOps).execute(
        { worktreeId: "main:project" },
        context(),
      ),
      /main checkout/,
    );

    for (const unavailable of [
      undefined,
      { ...row, status: "removed" as const },
    ]) {
      const ops = operations({ resolve: async () => unavailable });
      await assert.rejects(
        createWorktreeCommitTool(ops).execute(
          { worktreeId: row.id },
          context(),
        ),
        /not available/,
      );
    }

    const busy = operations({ reserve: () => undefined });
    await assert.rejects(
      createWorktreeCommitTool(busy).execute({ worktreeId: row.id }, context()),
      /running or starting/,
    );

    const mismatched = operations({ checkedOutBranch: async () => "other" });
    await assert.rejects(
      createWorktreeCommitTool(mismatched).execute(
        { worktreeId: row.id },
        context(),
      ),
      /registered for branch feature.*other is checked out/,
    );
    assert.equal(mismatched.calls.released, 1);
    assert.equal(mismatched.calls.invalidated, 1);
  });

  test("revalidates the row and releases on failure or cancellation", async () => {
    let resolves = 0;
    const removedDuringAdmission = operations({
      resolve: async () => {
        resolves += 1;
        return resolves === 1 ? row : { ...row, status: "removed" };
      },
    });
    await assert.rejects(
      createWorktreeCommitTool(removedDuringAdmission).execute(
        { worktreeId: row.id },
        context(),
      ),
      /changed or was removed/,
    );
    assert.equal(removedDuringAdmission.calls.released, 1);

    const failedResult = operations({
      runCommit: async () =>
        commitResult({ status: "failed", error: "git add failed" }),
    });
    await assert.rejects(
      createWorktreeCommitTool(failedResult).execute(
        { worktreeId: row.id },
        context(),
      ),
      /git add failed/,
    );
    assert.equal(failedResult.calls.released, 1);
    assert.equal(failedResult.calls.invalidated, 1);

    const aborted = operations({
      runCommit: async () => {
        throw new Error("aborted");
      },
    });
    await assert.rejects(
      createWorktreeCommitTool(aborted).execute(
        { worktreeId: row.id },
        { ...context(), signal: AbortSignal.abort() },
      ),
      /aborted/,
    );
    assert.equal(aborted.calls.released, 1);
    assert.equal(aborted.calls.invalidated, 1);

    const invalidationFails = operations({
      invalidate: () => {
        throw new Error("cache failure");
      },
    });
    await assert.rejects(
      createWorktreeCommitTool(invalidationFails).execute(
        { worktreeId: row.id },
        context(),
      ),
      /cache failure/,
    );
    assert.equal(
      invalidationFails.calls.released,
      1,
      "the mutation hold releases before cache invalidation",
    );
  });

  test("force reviews without committing, proposes one-shot evidence and supersedes old cards", async () => {
    const opts: unknown[] = [];
    const ops = operations({
      runCommit: async (options) => {
        opts.push(options);
        return commitResult({
          status: "blocked",
          dryRun: true,
          changeFingerprint: "fingerprint",
          blockers: [{ kind: "unsafe", reason: "Potential issue in code" }],
        });
      },
    });
    const tool = createWorktreeCommitTool(ops);
    const params = {
      worktreeId: row.id,
      force: true,
      reason: "Covered by the regression test",
      stagedOnly: true,
    };
    const first = await tool.execute(params, context());
    const firstId = (first.details as { approvalId: string }).approvalId;
    assert.equal(first.terminate, true);
    assert.equal((opts[0] as { force: boolean }).force, false);
    assert.equal((opts[0] as { dryRun: boolean }).dryRun, true);
    const card = approvalForId(firstId)!;
    assert.equal(card.sourceToolCallId, "call-1");
    assert.equal(card.autoApproved, undefined);
    assert.equal(card.body.kind, "managedCommitOverride");
    if (card.body.kind !== "managedCommitOverride")
      throw new Error("wrong kind");
    assert.equal(card.body.reason, params.reason);
    assert.equal(card.body.stagedOnly, true);
    assert.deepEqual(card.body.commit.blockers, [
      { kind: "unsafe", reason: "Potential issue in code" },
    ]);
    const second = await tool.execute(params, context());
    const secondId = (second.details as { approvalId: string }).approvalId;
    assert.equal(approvalForId(firstId)?.status, "superseded");
    assert.equal(approvalForId(firstId)?.supersededBy, secondId);
    assert.equal(opts.length, 2);
    assert.equal(ops.calls.released, 2);
  });

  test("force requires a reason and refuses clean, secret and unresolved Git findings", async () => {
    const invalid = operations();
    await assert.rejects(
      createWorktreeCommitTool(invalid).execute(
        { worktreeId: row.id, force: true },
        context(),
      ),
      /requires a reason/,
    );
    await assert.rejects(
      createWorktreeCommitTool(invalid).execute(
        { worktreeId: row.id, reason: "why" },
        context(),
      ),
      /only used with force/,
    );
    for (const result of [
      commitResult({ status: "dry-run" }),
      commitResult({ status: "blocked", files: [] }),
      commitResult({
        status: "blocked",
        changeFingerprint: "fp",
        blockers: [{ kind: "secret", reason: "credential" }],
      }),
      commitResult({
        status: "blocked",
        changeFingerprint: "fp",
        blockers: [
          {
            kind: "unsafe",
            reason: "A merge or rebase appears to be in progress.",
          },
        ],
      }),
      commitResult({
        status: "blocked",
        changeFingerprint: "fp",
        blockers: [
          {
            kind: "unsafe",
            reason: "Unresolved merge conflict in status line: UU file",
          },
        ],
      }),
    ]) {
      let created = false;
      const ops = operations({
        runCommit: async () => result,
        approve: () => {
          created = true;
          throw new Error("unexpected approval");
        },
      });
      await assert.rejects(
        createWorktreeCommitTool(ops).execute(
          { worktreeId: row.id, force: true, reason: "why" },
          context(),
        ),
      );
      assert.equal(created, false);
      assert.equal(ops.calls.released, 1);
    }
  });

  test("approval commits only the bound proposal and returns its outcome; rejection never commits", async () => {
    const propose = operations({
      runCommit: async () =>
        commitResult({
          status: "blocked",
          dryRun: true,
          changeFingerprint: "fp",
          blockers: [{ kind: "unsafe", reason: "Potential issue" }],
        }),
    });
    const ctx = context();
    ctx.session = { ...ctx.session, sessionId: `override-${Date.now()}` };
    const request = () =>
      createWorktreeCommitTool(propose).execute(
        { worktreeId: row.id, force: true, reason: "Tested", stagedOnly: true },
        ctx,
      );
    const created = await request();
    const id = (created.details as { approvalId: string }).approvalId;
    const exec = operations();
    setCommitOverrideApprovalOperationsForTests(exec);
    const resolved = await resolveApproval(id, "approved", undefined, {
      forSession: true,
    });
    assert.equal(resolved.card.status, "executed");
    assert.deepEqual(approvalGrantsForSession(ctx.session.sessionId), []);
    assert.deepEqual(
      (exec.calls.options as { approvedChange: unknown }).approvedChange,
      { fingerprint: "fp", message: "Add checked commit tool" },
    );
    assert.equal(
      (exec.calls.options as { stagedOnly: boolean }).stagedOnly,
      true,
    );
    assert.equal((exec.calls.options as { force: boolean }).force, true);
    assert.equal(
      (exec.calls.options as { forceRefusesSecrets: boolean })
        .forceRefusesSecrets,
      true,
    );
    assert.equal(exec.calls.released, 1);
    assert.match(resolved.outcomePrompt, /Committed/);
    assert.equal(resolved.card.grantedForSession, undefined);
    const rejection = await request();
    const rejected = await resolveApproval(
      (rejection.details as { approvalId: string }).approvalId,
      "rejected",
    );
    assert.equal(rejected.card.status, "rejected");
    assert.equal(
      exec.calls.released,
      1,
      "rejection never invokes the commit executor",
    );
    assert.match(rejected.outcomePrompt, /REJECTED/);
  });

  test("approval refuses busy, removed, moved and branch-mismatched worktrees and workflow blocks", async () => {
    const proposed = await createWorktreeCommitTool(
      operations({
        runCommit: async () =>
          commitResult({
            status: "blocked",
            changeFingerprint: "fp",
            blockers: [{ kind: "unsafe", reason: "Potential issue" }],
          }),
      }),
    ).execute({ worktreeId: row.id, force: true, reason: "Tested" }, context());
    const card = approvalForId(
      (proposed.details as { approvalId: string }).approvalId,
    )!;
    for (const overrides of [
      { reserve: () => undefined },
      { resolve: async () => undefined },
      { resolve: async () => ({ ...row, path: "/different/path" }) },
      { resolve: async () => ({ ...row, branch: "other" }) },
      { resolve: async () => ({ ...row, status: "removed" as const }) },
      { checkedOutBranch: async () => "other" },
      {
        runCommit: async () =>
          commitResult({
            status: "blocked",
            blockers: [{ kind: "secret", reason: "fresh credential" }],
          }),
      },
      {
        runCommit: async () => {
          throw new Error("failed");
        },
      },
    ]) {
      const ops = operations(overrides);
      setCommitOverrideApprovalOperationsForTests(ops);
      await assert.rejects(
        managedCommitOverrideApprovalExecutor.execute(card, {
          path: row.path,
          fingerprint: "fp",
        }),
      );
      assert.equal(ops.calls.released, overrides.reserve ? 0 : 1);
    }
  });

  test("cancelled force requests create no approval", async () => {
    let created = false;
    const ops = operations({
      runCommit: async () =>
        commitResult({
          status: "blocked",
          changeFingerprint: "fp",
          blockers: [{ kind: "unsafe", reason: "Potential issue" }],
        }),
      approve: () => {
        created = true;
        throw new Error("unexpected approval");
      },
    });
    await assert.rejects(
      createWorktreeCommitTool(ops).execute(
        { worktreeId: row.id, force: true, reason: "Tested" },
        { ...context(), signal: AbortSignal.abort() },
      ),
    );
    assert.equal(created, false);
    assert.equal(ops.calls.released, 1);
  });

  test("schema offers approval requests but no path, ref, message or subset escape", () => {
    const properties = (
      createWorktreeCommitTool().parameters as {
        properties: Record<string, unknown>;
      }
    ).properties;
    assert.deepEqual(Object.keys(properties), [
      "worktreeId",
      "context",
      "stagedOnly",
      "force",
      "reason",
    ]);
    assert.equal(
      (
        createWorktreeCommitTool().parameters as {
          additionalProperties: boolean;
        }
      ).additionalProperties,
      false,
    );
  });
});

const LOCAL_HEAD = "1111111111111111111111111111111111111111";
const REMOTE_HEAD = "2222222222222222222222222222222222222222";

function pushResult(
  patch: Partial<PushWorkflowResult> = {},
): PushWorkflowResult {
  return {
    status: "pushed",
    remote: "origin",
    branch: row.branch,
    forced: false,
    setUpstream: false,
    output: "Pushed.",
    ...patch,
  };
}

function pushOperations(
  overrides: Partial<WorktreePushOperations> = {},
): WorktreePushOperations & {
  calls: {
    released: number;
    invalidated: number;
    remoteReads: number;
    options: PushWorkflowOptions | undefined;
  };
} {
  const target: ResolvedPushTarget = {
    repoRoot: "/repo",
    remote: "origin",
  };
  const calls = {
    released: 0,
    invalidated: 0,
    remoteReads: 0,
    options: undefined as PushWorkflowOptions | undefined,
  };
  return {
    calls,
    resolve: async () => row,
    reserve: () => () => {
      calls.released += 1;
    },
    localState: async () => ({
      branch: row.branch,
      head: LOCAL_HEAD,
      clean: true,
    }),
    target: async () => target,
    remoteHead: async () => {
      calls.remoteReads += 1;
      return REMOTE_HEAD;
    },
    runPush: async (options) => {
      calls.options = options;
      options.onProgress?.("Pushing feature → origin…");
      return pushResult({
        ...(options.remote ? { remote: options.remote } : {}),
        forced: Boolean(options.explicitLease),
      });
    },
    links: async () => undefined,
    invalidate: () => {
      calls.invalidated += 1;
    },
    ...overrides,
  };
}

describe("worktree_push", () => {
  test("ordinary publication derives exact local preconditions and projects PushDisplay", async () => {
    const partials: unknown[] = [];
    const ops = pushOperations({
      runPush: async (options) => {
        ops.calls.options = options;
        options.onProgress?.("Pushing feature → origin…");
        return pushResult({ status: "up-to-date" });
      },
    });
    const result = await createWorktreePushTool(ops).execute(
      { worktreeId: row.id },
      context((partial) => partials.push(partial.details)),
    );

    assert.deepEqual(result.details, {
      status: "up-to-date",
      remote: "origin",
      branch: "feature",
      forced: false,
      setUpstream: false,
      localHead: LOCAL_HEAD,
    });
    assert.deepEqual(partials, [
      { status: "running", message: "Pushing feature → origin…" },
    ]);
    assert.deepEqual(
      {
        cwd: ops.calls.options?.cwd,
        force: ops.calls.options?.force,
        remote: ops.calls.options?.remote,
        expectedBranch: ops.calls.options?.expectedBranch,
        expectedHead: ops.calls.options?.expectedHead,
        requireClean: ops.calls.options?.requireClean,
        explicitLease: ops.calls.options?.explicitLease,
      },
      {
        cwd: row.path,
        force: false,
        remote: "origin",
        expectedBranch: row.branch,
        expectedHead: LOCAL_HEAD,
        requireClean: true,
        explicitLease: undefined,
      },
    );
    assert.equal(ops.calls.remoteReads, 0);
    assert.equal(ops.calls.released, 1);
    assert.equal(ops.calls.invalidated, 1);
  });

  test("forced publication leases the authoritative remote oid exactly", async () => {
    const target: ResolvedPushTarget = {
      repoRoot: "/repo",
      remote: "upstream",
      upstream: { remote: "upstream", branch: row.branch },
    };
    const ops = pushOperations({ target: async () => target });
    const result = await createWorktreePushTool(ops).execute(
      { worktreeId: row.id, forceWithLease: true },
      context(),
    );

    assert.deepEqual(ops.calls.options?.explicitLease, {
      expectedRemoteOid: REMOTE_HEAD,
    });
    assert.equal(ops.calls.options?.force, false);
    assert.equal(ops.calls.options?.remote, "upstream");
    assert.equal(ops.calls.remoteReads, 1);
    assert.deepEqual(result.details, {
      status: "pushed",
      remote: "upstream",
      branch: "feature",
      forced: true,
      setUpstream: false,
      localHead: LOCAL_HEAD,
      expectedRemoteHead: REMOTE_HEAD,
    });
  });

  test("hosted links resolved for the push result ride on the agent-facing result", async () => {
    const hosted = {
      provider: "github" as const,
      branchUrl: "https://github.com/acme/repo/tree/feature",
      pullRequest: {
        number: 42,
        url: "https://github.com/acme/repo/pull/42",
        title: "Feature",
        state: "open" as const,
      },
    };
    let linked: PushWorkflowResult | undefined;
    const ops = pushOperations({
      links: async (result) => {
        linked = result;
        return hosted;
      },
    });
    const result = await createWorktreePushTool(ops).execute(
      { worktreeId: row.id },
      context(),
    );

    assert.equal(linked?.status, "pushed");
    assert.deepEqual((result.details as { hosted?: unknown }).hosted, hosted);
  });

  test("refuses synthetic main, unavailable rows, busy writers, detached/mismatched branches, and dirt", async () => {
    await assert.rejects(
      createWorktreePushTool(pushOperations()).execute(
        { worktreeId: "main:project" },
        context(),
      ),
      /main checkout/,
    );
    for (const unavailable of [
      undefined,
      { ...row, status: "removed" as const },
    ]) {
      await assert.rejects(
        createWorktreePushTool(
          pushOperations({ resolve: async () => unavailable }),
        ).execute({ worktreeId: row.id }, context()),
        /not available/,
      );
    }
    await assert.rejects(
      createWorktreePushTool(
        pushOperations({ reserve: () => undefined }),
      ).execute({ worktreeId: row.id }, context()),
      /running or starting/,
    );
    for (const branch of ["", "other"]) {
      const ops = pushOperations({
        localState: async () => ({ branch, head: LOCAL_HEAD, clean: true }),
      });
      await assert.rejects(
        createWorktreePushTool(ops).execute({ worktreeId: row.id }, context()),
        /registered for branch feature/,
      );
      assert.equal(ops.calls.released, 1);
    }
    for (const dirtyKind of ["modified", "staged", "untracked"]) {
      const ops = pushOperations({
        localState: async () => ({
          branch: row.branch,
          head: LOCAL_HEAD,
          clean: false,
        }),
      });
      await assert.rejects(
        createWorktreePushTool(ops).execute({ worktreeId: row.id }, context()),
        /worktree_commit/,
        dirtyKind,
      );
      assert.equal(ops.calls.released, 1);
      assert.equal(ops.calls.invalidated, 1);
    }
  });

  test("revalidates the row and releases after workflow failure or cancellation", async () => {
    let resolves = 0;
    const drift = pushOperations({
      resolve: async () => {
        resolves += 1;
        return resolves === 1 ? row : { ...row, path: "/moved" };
      },
    });
    await assert.rejects(
      createWorktreePushTool(drift).execute({ worktreeId: row.id }, context()),
      /changed or was removed/,
    );
    assert.equal(drift.calls.released, 1);

    const failed = pushOperations({
      runPush: async () =>
        pushResult({
          status: "failed",
          error: "non-fast-forward",
          output: "non-fast-forward",
        }),
    });
    await assert.rejects(
      createWorktreePushTool(failed).execute({ worktreeId: row.id }, context()),
      /Inspect why the branch diverged/,
    );
    assert.equal(failed.calls.released, 1);
    assert.equal(failed.calls.invalidated, 1);

    const cancelled = pushOperations({
      runPush: async () => {
        throw new Error("aborted");
      },
    });
    await assert.rejects(
      createWorktreePushTool(cancelled).execute(
        { worktreeId: row.id },
        { ...context(), signal: AbortSignal.abort() },
      ),
      /aborted/,
    );
    assert.equal(cancelled.calls.released, 1);
  });

  test("force-with-lease requires a matching existing upstream and remote branch", async () => {
    for (const [target, message] of [
      [{ repoRoot: "/repo", remote: "origin" }, /existing upstream/],
      [
        {
          repoRoot: "/repo",
          remote: "origin",
          upstream: { remote: "other", branch: row.branch },
        },
        /must track origin\/feature/,
      ],
      [
        {
          repoRoot: "/repo",
          remote: "origin",
          upstream: { remote: "origin", branch: "other" },
        },
        /must track origin\/feature/,
      ],
    ] as const) {
      const ops = pushOperations({ target: async () => target });
      await assert.rejects(
        createWorktreePushTool(ops).execute(
          { worktreeId: row.id, forceWithLease: true },
          context(),
        ),
        message,
      );
      assert.equal(ops.calls.remoteReads, 0);
      assert.equal(ops.calls.released, 1);
    }

    const missing = pushOperations({
      target: async () => ({
        repoRoot: "/repo",
        remote: "origin",
        upstream: { remote: "origin", branch: row.branch },
      }),
      remoteHead: async () => undefined,
    });
    await assert.rejects(
      createWorktreePushTool(missing).execute(
        { worktreeId: row.id, forceWithLease: true },
        context(),
      ),
      /does not exist.*ordinary worktree_push/,
    );
  });

  test("lease failure is a hard refusal with investigation guidance", async () => {
    const ops = pushOperations({
      target: async () => ({
        repoRoot: "/repo",
        remote: "origin",
        upstream: { remote: "origin", branch: row.branch },
      }),
      runPush: async () =>
        pushResult({
          status: "failed",
          forced: true,
          error: "stale info",
          output: "stale info",
        }),
    });
    await assert.rejects(
      createWorktreePushTool(ops).execute(
        { worktreeId: row.id, forceWithLease: true },
        context(),
      ),
      /stale info.*Investigate the remote head/,
    );
  });

  test("schema exposes no remote, branch, refspec, raw force, or expected oid", () => {
    const schema = createWorktreePushTool().parameters as {
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(Object.keys(schema.properties), [
      "worktreeId",
      "forceWithLease",
    ]);
  });
});

const ACCEPTED_HEAD = "3333333333333333333333333333333333333333";

function managedProvider(
  patch: Partial<GitHostingProvider> = {},
): GitHostingProvider {
  return {
    kind: "github",
    repository: { host: "github.com", owner: "acme", repo: "project" },
    repoWebUrl: "https://github.com/acme/project",
    ...patch,
  } as GitHostingProvider;
}

function pullRequestOperations(
  overrides: Partial<WorktreePullRequestOperations> = {},
): WorktreePullRequestOperations & {
  calls: {
    released: number;
    invalidated: number;
    scheduled: string[];
    beginInput?: Parameters<WorktreePullRequestOperations["begin"]>[0];
    card?: PullRequestCard;
  };
} {
  const calls: {
    released: number;
    invalidated: number;
    scheduled: string[];
    beginInput?: Parameters<WorktreePullRequestOperations["begin"]>[0];
    card?: PullRequestCard;
  } = { released: 0, invalidated: 0, scheduled: [] };
  const provider = managedProvider();
  return {
    calls,
    resolve: async () => row,
    reserve: () => () => {
      calls.released += 1;
    },
    localState: async () => ({
      branch: row.branch,
      head: ACCEPTED_HEAD,
      clean: true,
    }),
    target: async () => ({
      repoRoot: "/repo",
      remote: "origin",
      upstream: { remote: "origin", branch: row.branch },
    }),
    remoteHead: async () => ACCEPTED_HEAD,
    hosting: async () => ({
      provider,
      repository: { host: "github.com", owner: "acme", repo: "project" },
    }),
    taskIds: () => ["587"],
    task: (taskId) =>
      taskId === "587"
        ? {
            id: "587",
            title: "Agent-facing PR creation",
            status: "doing",
            source: { createdBy: "user" },
            createdAt: 1,
            updatedAt: 1,
          }
        : undefined,
    recover: async () => undefined,
    begin: async (input) => {
      calls.beginInput = input;
      const card: PullRequestCard = {
        renderKind: "pullRequest",
        id: "pr-managed",
        sessionId: input.sessionId,
        ...(input.sourceToolCallId
          ? { sourceToolCallId: input.sourceToolCallId }
          : {}),
        status: "open",
        provider: "github",
        number: 91,
        url: "https://github.com/acme/project/pulls/91",
        title: "Task-587: Agent-facing PR creation",
        headBranch: row.branch,
        baseBranch: row.baseBranch,
        ...(input.args.draft ? { draft: true } : {}),
        warnings: [],
        ...(input.taskId
          ? {
              linkedTask: {
                id: input.taskId,
                title: "Agent-facing PR creation",
                status: "doing",
                source: { createdBy: "user" },
                createdAt: 1,
                updatedAt: 1,
              },
            }
          : {}),
        worktreeId: row.id,
        createdAt: 1,
        updatedAt: 1,
      };
      calls.card = card;
      return {
        status: "created",
        cardId: card.id,
        summary: "created",
      };
    },
    card: () => calls.card,
    invalidate: () => {
      calls.invalidated += 1;
    },
    schedulePoll: (cardId) => calls.scheduled.push(cardId),
    ...overrides,
  };
}

describe("worktree_create_pull_request", () => {
  test("creates the canonical caller-owned card from exact managed target evidence", async () => {
    const partials: unknown[] = [];
    const ops = pullRequestOperations({
      begin: async (input) => {
        ops.calls.beginInput = input;
        input.onProgress?.("Drafting pull request…");
        const card: PullRequestCard = {
          renderKind: "pullRequest",
          id: "pr-managed",
          sessionId: input.sessionId,
          ...(input.sourceToolCallId
            ? { sourceToolCallId: input.sourceToolCallId }
            : {}),
          status: "open",
          provider: "github",
          number: 91,
          url: "https://github.com/acme/project/pulls/91",
          title: "Task-587: Agent-facing PR creation",
          headBranch: row.branch,
          baseBranch: row.baseBranch,
          draft: true,
          warnings: ["Authoring note"],
          linkedTask: {
            id: "587",
            title: "Agent-facing PR creation",
            status: "doing",
            source: { createdBy: "user" },
            createdAt: 1,
            updatedAt: 1,
          },
          worktreeId: row.id,
          createdAt: 1,
          updatedAt: 1,
        };
        ops.calls.card = card;
        return {
          status: "created",
          cardId: card.id,
          summary: "created",
        };
      },
    });

    const result = await createWorktreePullRequestTool(ops).execute(
      {
        worktreeId: row.id,
        taskId: "587",
        context: "Use the checked delivery context",
        draft: true,
      },
      context((partial) => partials.push(partial.details)),
    );

    assert.deepEqual(result.details, {
      cardId: "pr-managed",
      status: "created",
      pullRequestState: "open",
      provider: "github",
      number: 91,
      url: "https://github.com/acme/project/pulls/91",
      head: row.branch,
      base: row.baseBranch,
      acceptedHeadSha: ACCEPTED_HEAD,
      draft: true,
      linkedTask: { id: "587", title: "Agent-facing PR creation" },
      warnings: ["Authoring note"],
      partial: false,
    });
    assert.deepEqual(partials, [
      { status: "running", message: "Drafting pull request…" },
    ]);
    assert.equal(ops.calls.beginInput?.sessionId, "caller-on-another-worktree");
    assert.equal(ops.calls.beginInput?.sourceToolCallId, "call-1");
    assert.equal(ops.calls.beginInput?.trustedTarget?.worktree.id, row.id);
    assert.equal(
      ops.calls.beginInput?.trustedTarget?.acceptedHeadSha,
      ACCEPTED_HEAD,
    );
    assert.equal(ops.calls.beginInput?.trustedTarget?.remote, "origin");
    assert.equal(ops.calls.beginInput?.args.base, row.baseBranch);
    assert.equal(ops.calls.beginInput?.title, undefined);
    assert.equal(
      ops.calls.beginInput?.args.additionalContext,
      "Use the checked delivery context",
    );
    assert.deepEqual(ops.calls.scheduled, ["pr-managed"]);
    assert.equal(ops.calls.released, 1);
    assert.equal(ops.calls.invalidated, 2);
  });

  test("trims and forwards an explicit title through recovery and creation", async () => {
    let recoveredTitle: string | undefined;
    const ops = pullRequestOperations({
      recover: async (input) => {
        recoveredTitle = input.title;
        return undefined;
      },
    });

    await createWorktreePullRequestTool(ops).execute(
      {
        worktreeId: row.id,
        title: "  NEB-1407: Fix pull-request title overrides  ",
      },
      context(),
    );

    assert.equal(recoveredTitle, "NEB-1407: Fix pull-request title overrides");
    assert.equal(
      ops.calls.beginInput?.title,
      "NEB-1407: Fix pull-request title overrides",
    );
  });

  test("validates explicit title shape before reading the worktree", async () => {
    let resolved = 0;
    const ops = pullRequestOperations({
      resolve: async () => {
        resolved += 1;
        return row;
      },
    });
    for (const [title, message] of [
      ["   ", /must not be blank/],
      ["first\nsecond", /single line/],
      ["x".repeat(121), /exceeds 120 characters/],
    ] as const)
      await assert.rejects(
        createWorktreePullRequestTool(ops).execute(
          { worktreeId: row.id, title },
          context(),
        ),
        message,
      );
    assert.equal(resolved, 0);
  });

  test("recovery refuses a conflicting explicit-title intent", () => {
    assert.doesNotThrow(() =>
      assertMatchingManagedPullRequestTitleIntent(undefined, undefined),
    );
    assert.doesNotThrow(() =>
      assertMatchingManagedPullRequestTitleIntent("Exact title", "Exact title"),
    );
    assert.throws(
      () =>
        assertMatchingManagedPullRequestTitleIntent(undefined, "Exact title"),
      /agent-generated title.*explicit title "Exact title"/,
    );
    assert.throws(
      () => assertMatchingManagedPullRequestTitleIntent("Old", "New"),
      /explicit title "Old".*explicit title "New"/,
    );
  });

  test("reuses an existing managed PR despite different title intent", async () => {
    resetPullRequestCardsStoreForTests();
    try {
      const card = createPullRequestCard(
        {
          sessionId: "existing-pr-caller",
          status: "open",
          title: "Provider-owned title",
          headBranch: row.branch,
          baseBranch: row.baseBranch,
          provider: "github",
          number: 90,
          url: "https://github.com/acme/project/pulls/90",
          warnings: [],
          worktreeId: row.id,
        },
        {
          repoRoot: row.path,
          sessionKind: "developer",
          sessionId: "existing-pr-caller",
          headBranch: row.branch,
          baseBranch: row.baseBranch,
          draft: false,
          remote: "origin",
          acceptedHeadSha: ACCEPTED_HEAD,
          explicitTitle: "Original explicit title",
        },
      );
      const provider = managedProvider({
        pullRequestDetail: async () => ({
          number: 90,
          state: "open",
          merged: false,
          mergeable: true,
          draft: false,
          headSha: ACCEPTED_HEAD,
          headBranch: row.branch,
          baseBranch: row.baseBranch,
        }),
      });

      const result = await defaultPullRequestOperations.recover({
        row,
        callerSessionId: "existing-pr-caller",
        remote: "origin",
        acceptedHeadSha: ACCEPTED_HEAD,
        provider,
        title: "Different retry title",
      });

      assert.equal(result?.status, "reused");
      assert.equal(result?.cardId, card.id);
      assert.equal(pullRequestCardById(card.id)?.title, "Provider-owned title");
      assert.equal(pullRequestCardById(card.id)?.reused, true);
    } finally {
      resetPullRequestCardsStoreForTests();
    }
  });

  test("reuses retry recovery before reserving another card", async () => {
    let began = 0;
    const ops = pullRequestOperations({
      recover: async (input) => {
        assert.equal(input.acceptedHeadSha, ACCEPTED_HEAD);
        assert.equal(input.remote, "origin");
        ops.calls.card = {
          renderKind: "pullRequest",
          id: "pr-recovered",
          sessionId: "caller-on-another-worktree",
          status: "merged",
          provider: "github",
          number: 90,
          url: "https://github.com/acme/project/pulls/90",
          title: "Recovered",
          headBranch: row.branch,
          baseBranch: row.baseBranch,
          warnings: ["Existing pull request #90 is merged."],
          worktreeId: row.id,
          createdAt: 1,
          updatedAt: 1,
        };
        return {
          status: "reused",
          cardId: "pr-recovered",
          summary: "reused",
        };
      },
      begin: async () => {
        began += 1;
        throw new Error("must not reserve a second card");
      },
    });

    const result = await createWorktreePullRequestTool(ops).execute(
      { worktreeId: row.id },
      context(),
    );

    assert.equal(began, 0);
    assert.equal((result.details as { status: string }).status, "reused");
    assert.equal(
      (result.details as { pullRequestState: string }).pullRequestState,
      "merged",
    );
    assert.deepEqual(ops.calls.scheduled, []);
  });

  test("refuses synthetic main, unavailable or busy targets, and releases after row drift", async () => {
    await assert.rejects(
      createWorktreePullRequestTool(pullRequestOperations()).execute(
        { worktreeId: "main:project" },
        context(),
      ),
      /main checkout/,
    );
    for (const unavailable of [
      undefined,
      { ...row, status: "removed" as const },
    ])
      await assert.rejects(
        createWorktreePullRequestTool(
          pullRequestOperations({ resolve: async () => unavailable }),
        ).execute({ worktreeId: row.id }, context()),
        /not available/,
      );
    await assert.rejects(
      createWorktreePullRequestTool(
        pullRequestOperations({ reserve: () => undefined }),
      ).execute({ worktreeId: row.id }, context()),
      /running or starting/,
    );

    for (const changed of [
      { path: "/moved" },
      { branch: "other" },
      { baseBranch: "release" },
      { projectId: "other-project" },
    ]) {
      let reads = 0;
      const ops = pullRequestOperations({
        resolve: async () => (++reads === 1 ? row : { ...row, ...changed }),
      });
      await assert.rejects(
        createWorktreePullRequestTool(ops).execute(
          { worktreeId: row.id },
          context(),
        ),
        /target changed/,
      );
      assert.equal(ops.calls.released, 1);
    }
  });

  test("requires the registered checkout branch, readable HEAD, and a clean tree", async () => {
    for (const [state, message] of [
      [{ branch: "", head: ACCEPTED_HEAD, clean: true }, /detached HEAD/],
      [
        { branch: "other", head: ACCEPTED_HEAD, clean: true },
        /other is checked out/,
      ],
      [{ branch: row.branch, head: "", clean: true }, /HEAD could not be read/],
      [
        { branch: row.branch, head: ACCEPTED_HEAD, clean: false },
        /worktree_commit/,
      ],
    ] as const) {
      const ops = pullRequestOperations({ localState: async () => state });
      await assert.rejects(
        createWorktreePullRequestTool(ops).execute(
          { worktreeId: row.id },
          context(),
        ),
        message,
      );
      assert.equal(ops.calls.released, 1);
    }
  });

  test("requires a same-named upstream and exact authoritative remote HEAD", async () => {
    for (const [target, message] of [
      [{ repoRoot: "/repo", remote: "origin" }, /no upstream.*worktree_push/],
      [
        {
          repoRoot: "/repo",
          remote: "origin",
          upstream: { remote: "fork", branch: row.branch },
        },
        /must track origin\/feature/,
      ],
      [
        {
          repoRoot: "/repo",
          remote: "origin",
          upstream: { remote: "origin", branch: "other" },
        },
        /must track origin\/feature/,
      ],
    ] as const) {
      await assert.rejects(
        createWorktreePullRequestTool(
          pullRequestOperations({ target: async () => target }),
        ).execute({ worktreeId: row.id }, context()),
        message,
      );
    }
    await assert.rejects(
      createWorktreePullRequestTool(
        pullRequestOperations({ remoteHead: async () => undefined }),
      ).execute({ worktreeId: row.id }, context()),
      /does not exist.*ordinary worktree_push/,
    );
    for (const remoteHead of ["1".repeat(40), "4".repeat(40), "5".repeat(40)])
      await assert.rejects(
        createWorktreePullRequestTool(
          pullRequestOperations({ remoteHead: async () => remoteHead }),
        ).execute({ worktreeId: row.id }, context()),
        /does not equal local HEAD.*forceWithLease/,
      );
  });

  test("binds the provider to the derived push repository", async () => {
    await assert.rejects(
      createWorktreePullRequestTool(
        pullRequestOperations({
          hosting: async () => ({
            provider: managedProvider({
              repository: {
                host: "github.com",
                owner: "other",
                repo: "project",
              },
            }),
            repository: {
              host: "github.com",
              owner: "acme",
              repo: "project",
            },
          }),
        }),
      ).execute({ worktreeId: row.id }, context()),
      /does not describe.*push remote/,
    );
  });

  test("selects zero or one target-worktree Task and refuses ambiguous or unrelated ids", async () => {
    const none = pullRequestOperations({ taskIds: () => [] });
    await createWorktreePullRequestTool(none).execute(
      { worktreeId: row.id },
      context(),
    );
    assert.equal(none.calls.beginInput?.taskId, undefined);

    const one = pullRequestOperations();
    await createWorktreePullRequestTool(one).execute(
      { worktreeId: row.id },
      context(),
    );
    assert.equal(one.calls.beginInput?.taskId, "587");

    const many = pullRequestOperations({
      taskIds: () => ["587", "588"],
      task: (id) => ({
        id,
        title: `Task ${id}`,
        status: "todo",
        source: { createdBy: "user" },
        createdAt: 1,
        updatedAt: 1,
      }),
    });
    await assert.rejects(
      createWorktreePullRequestTool(many).execute(
        { worktreeId: row.id },
        context(),
      ),
      /several linked Tasks.*Task-587.*Task-588/,
    );
    await createWorktreePullRequestTool(many).execute(
      { worktreeId: row.id, taskId: "588" },
      context(),
    );
    assert.equal(many.calls.beginInput?.taskId, "588");

    await assert.rejects(
      createWorktreePullRequestTool(pullRequestOperations()).execute(
        { worktreeId: row.id, taskId: "999" },
        context(),
      ),
      /does not exist/,
    );
    await assert.rejects(
      createWorktreePullRequestTool(
        pullRequestOperations({
          task: (id) => ({
            id,
            title: "Other",
            status: "todo",
            source: { createdBy: "user" },
            createdAt: 1,
            updatedAt: 1,
          }),
        }),
      ).execute({ worktreeId: row.id, taskId: "999" }, context()),
      /not linked/,
    );
  });

  test("returns landed stale-head warnings as partial success and releases on failures", async () => {
    const partial = pullRequestOperations({
      begin: async (input) => {
        partial.calls.beginInput = input;
        partial.calls.card = {
          renderKind: "pullRequest",
          id: "pr-stale",
          sessionId: input.sessionId,
          status: "open",
          provider: "github",
          number: 92,
          url: "https://github.com/acme/project/pulls/92",
          title: "Created but moved",
          headBranch: row.branch,
          baseBranch: row.baseBranch,
          warnings: [
            ...Array.from(
              { length: 12 },
              (_, index) => `Authoring warning ${index + 1}`,
            ),
            `STALE-HEAD WARNING: provider reports ${"9".repeat(40)}.`,
          ],
          createdAt: 1,
          updatedAt: 1,
        };
        return {
          status: "created",
          cardId: partial.calls.card.id,
          summary: "created",
        };
      },
    });
    const result = await createWorktreePullRequestTool(partial).execute(
      { worktreeId: row.id },
      context(),
    );
    assert.equal((result.details as { partial: boolean }).partial, true);
    assert.equal(
      (result.details as { warnings: string[] }).warnings.some((warning) =>
        warning.startsWith("STALE-HEAD WARNING:"),
      ),
      false,
      "the safety state is computed before warning projection bounds",
    );

    const failed = pullRequestOperations({
      begin: async () => {
        throw new Error("provider unavailable");
      },
    });
    await assert.rejects(
      createWorktreePullRequestTool(failed).execute(
        { worktreeId: row.id },
        context(),
      ),
      /provider unavailable/,
    );
    assert.equal(failed.calls.released, 1);
    assert.equal(failed.calls.invalidated, 1);
  });

  test("schema exposes title but no repository, refs, SHA, or body", () => {
    const schema = createWorktreePullRequestTool().parameters as {
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(Object.keys(schema.properties), [
      "worktreeId",
      "taskId",
      "context",
      "title",
      "draft",
    ]);
    assert.deepEqual(schema.properties.title, {
      type: "string",
      minLength: 1,
      maxLength: 120,
      description:
        "Optional exact title for a newly created pull request. Outer whitespace is trimmed; the remainder must be nonblank, one line, and at most 120 characters. Existing pull requests are adopted without renaming.",
    });
  });
});
