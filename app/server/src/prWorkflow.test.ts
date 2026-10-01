import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import type { WorktreeRow } from "./db/worktreeStore.ts";
import type { GitHostingProvider } from "./gitHosting.ts";
import {
  hostSlashCommandRunner,
  runPrForHost,
  type SyntheticToolHost,
} from "./hostSlashCommands.ts";
import {
  beginPullRequestCard,
  orderedPullRequestTaskIds,
  resolveDiffBaseRef,
  runPrWorkflow,
  type BeginPullRequestCardResult,
  type PrWorkflowOperations,
  type PrWorkflowPresenter,
} from "./prWorkflow.ts";
import {
  cardsForSession,
  pullRequestCardRecord,
  resetPullRequestCardsStoreForTests,
} from "./pullRequestCards.ts";
import { parsePrArgs } from "./slashCommands.ts";
import type { CommitWorkflowResult } from "./commitWorkflow.ts";
import type { PushWorkflowResult } from "./pushWorkflow.ts";
import { createTask } from "./tasks.ts";

const hoisted = vi.hoisted(() => ({
  hostingProviderForRepo:
    vi.fn<(repoPath: string) => Promise<GitHostingProvider | null>>(),
  generatePullRequestJson: vi.fn(),
}));
vi.mock("./gitHosting.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gitHosting.ts")>();
  return { ...actual, hostingProviderForRepo: hoisted.hostingProviderForRepo };
});
vi.mock("./prAgent.ts", () => ({
  generatePullRequestJson: hoisted.generatePullRequestJson,
}));

const created: BeginPullRequestCardResult = {
  status: "created",
  cardId: "pr-42",
  summary: "Pull request #42 created.",
};

function commit(
  status: CommitWorkflowResult["status"],
  blockers: CommitWorkflowResult["blockers"] = [],
): CommitWorkflowResult {
  return {
    status,
    source: "slash",
    dryRun: false,
    forced: false,
    files: [],
    totals: { files: 0, additions: 0, deletions: 0 },
    blockers,
    warnings: [],
    includedUserEntryIds: [],
    sessionTouchedPaths: [],
    addressedTasks: [],
    createdAt: 0,
  };
}

function push(status: PushWorkflowResult["status"]): PushWorkflowResult {
  return {
    status,
    forced: false,
    setUpstream: false,
    output: "",
  };
}

function presenter(events: string[]): PrWorkflowPresenter {
  let toolSeq = 0;
  return {
    begin: (phase) => {
      events.push(`begin:${phase}`);
      return `tool-${++toolSeq}`;
    },
    progress: () => undefined,
    discard: () => events.push("discard"),
    finishCommit: (result) => events.push(`commit:${result.status}`),
    finishPush: (result) => events.push(`push:${result.status}`),
    finishPullRequestTool: (_message, isError) =>
      events.push(`pr:${isError ? "failed" : "ok"}`),
  };
}

function operations(
  patch: Partial<PrWorkflowOperations> = {},
): PrWorkflowOperations {
  return {
    hasChanges: async () => false,
    runCommit: async () => commit("committed"),
    needsPush: async () => false,
    runPush: async () => push("up-to-date"),
    beginPullRequestCard: async () => created,
    ...patch,
  };
}

const baseOptions = {
  cwd: process.cwd(),
  sessionManager: {},
  sessionKind: "developer" as const,
  sessionId: "session-1",
  args: {
    draft: false,
    force: false,
    forceCommit: false,
    additionalContext: "",
  },
  commandText: "/pr",
};

test("parses /pr flags and preserves quoted free-text context", () => {
  assert.deepEqual(
    parsePrArgs('--draft --base "release next" --force "mention migration"'),
    {
      draft: true,
      base: "release next",
      force: true,
      forceCommit: false,
      additionalContext: "mention migration",
    },
  );
  assert.deepEqual(parsePrArgs("--force-commit"), {
    draft: false,
    force: false,
    forceCommit: true,
    additionalContext: "",
  });
  assert.throws(() => parsePrArgs("--base --force"), /requires a branch/);
});

test("--force only force-pushes; --force-commit is the safety override", async () => {
  let commitForce: boolean | undefined;
  let pushForce: boolean | undefined;
  await runPrWorkflow(
    {
      ...baseOptions,
      args: { ...baseOptions.args, force: true },
      presenter: presenter([]),
    },
    operations({
      hasChanges: async () => true,
      runCommit: async (options) => {
        commitForce = options.force;
        return commit("committed");
      },
      needsPush: async () => true,
      runPush: async (options) => {
        pushForce = options.force;
        return push("pushed");
      },
    }),
  );
  assert.equal(commitForce, false);
  assert.equal(pushForce, true);
});

test("PR diff context prefers the remote-tracking base ref", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pr-range-ref-"));
  try {
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: repo,
    });
    writeFileSync(join(repo, "file.txt"), "base\n");
    execFileSync("git", ["add", "file.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "base"], { cwd: repo });
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], {
      cwd: repo,
    });

    assert.equal(
      await resolveDiffBaseRef(repo, "main"),
      "refs/remotes/origin/main",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Task candidates preserve session relevance before worktree-only links", () => {
  assert.deepEqual(orderedPullRequestTaskIds(["322", "320"], ["320", "319"]), [
    "322",
    "320",
    "319",
  ]);
});

test("skips clean commit and up-to-date push phases", async () => {
  const events: string[] = [];
  const result = await runPrWorkflow(
    { ...baseOptions, presenter: presenter(events) },
    operations(),
  );
  assert.equal(result.status, "created");
  assert.deepEqual(events, ["begin:pull-request", "pr:ok"]);
});

test("a commit race that finds no changes discards its transient card", async () => {
  const events: string[] = [];
  await runPrWorkflow(
    { ...baseOptions, presenter: presenter(events) },
    operations({
      hasChanges: async () => true,
      runCommit: async () =>
        commit("blocked", [
          { kind: "unclear", reason: "No changes to commit." },
        ]),
    }),
  );
  assert.deepEqual(events, [
    "begin:commit",
    "discard",
    "begin:pull-request",
    "pr:ok",
  ]);
});

test("a blocked commit stops before push and pull request", async () => {
  const events: string[] = [];
  let pushCalls = 0;
  let prCalls = 0;
  const result = await runPrWorkflow(
    { ...baseOptions, presenter: presenter(events) },
    operations({
      hasChanges: async () => true,
      runCommit: async () => commit("blocked"),
      needsPush: async () => {
        pushCalls += 1;
        return true;
      },
      beginPullRequestCard: async () => {
        prCalls += 1;
        return created;
      },
    }),
  );
  assert.deepEqual(result, { status: "blocked", phase: "commit" });
  assert.deepEqual(events, ["begin:commit", "commit:blocked"]);
  assert.equal(pushCalls, 0);
  assert.equal(prCalls, 0);
});

test("up-to-date push output remains silent even when the preflight requested a push", async () => {
  const events: string[] = [];
  await runPrWorkflow(
    { ...baseOptions, presenter: presenter(events) },
    operations({
      needsPush: async () => true,
      runPush: async () => push("up-to-date"),
    }),
  );
  assert.deepEqual(events, [
    "begin:push",
    "discard",
    "begin:pull-request",
    "pr:ok",
  ]);
});

test("connection dispatch inventory includes /pr", () => {
  assert.equal(hostSlashCommandRunner("pr"), runPrForHost);
  assert.equal(hostSlashCommandRunner("unknown"), undefined);
});

test("a busy fallback preserves the original workflow error", async () => {
  const host = {
    kind: "developer",
    sessionId: "session-1",
    commitWorkflowContext: () => ({
      sessionManager: {},
      cwd: "/path/that/does/not/exist",
    }),
    beginSyntheticTool: () => {
      throw new Error("fallback was busy");
    },
  } as unknown as SyntheticToolHost;

  await assert.rejects(
    runPrForHost(host, ""),
    (error: unknown) =>
      error instanceof Error && !error.message.includes("fallback was busy"),
  );
});

/* --------------------------- reused-PR card creation ------------------------ */

function fakeProvider(impl: Partial<GitHostingProvider>): GitHostingProvider {
  return {
    kind: "github",
    repoWebUrl: "https://github.com/acme/repo",
    findPullRequestForBranch: async () => null,
    findPullRequestsForBranch: async () => ({ open: [] }),
    createPullRequest: async () => {
      throw new Error("not used");
    },
    markPullRequestReady: async () => ({}),
    listOpenPullRequests: async () => [],
    ciStatus: async () => null,
    refChecks: async () => ({ state: "none", checks: [] }),
    pullRequestReview: async () => null,
    pullRequestDetail: async () => null,
    mergePullRequest: async () => {
      throw new Error("not used");
    },
    closePullRequest: async () => {
      throw new Error("not used");
    },
    repositoryCapabilities: async () => ({
      defaultBranch: "main",
      mergeMethods: ["squash", "merge", "rebase"],
      canClose: true,
    }),
    ...impl,
  };
}

function branchRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "pr-reuse-"));
  execFileSync("git", ["init", "--initial-branch=feature"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repo,
  });
  writeFileSync(join(repo, "file.txt"), "x\n");
  execFileSync("git", ["add", "file.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "x"], { cwd: repo });
  return repo;
}

function managedRow(repo: string): WorktreeRow {
  return {
    id: "wt-managed",
    projectId: "project",
    mainRepoRoot: repo,
    path: repo,
    branch: "feature",
    baseBranch: "main",
    baseCommit: "base",
    status: "active",
    mergeStateJson: null,
    createdAt: 1,
    updatedAt: 1,
    removedAt: null,
  };
}

const prArgs = {
  draft: false,
  force: false,
  forceCommit: false,
  additionalContext: "",
  base: "main",
};

afterEach(() => {
  hoisted.hostingProviderForRepo.mockReset();
  hoisted.generatePullRequestJson.mockReset();
  resetPullRequestCardsStoreForTests();
});

test("the PR agent title remains the default with a linked Jira Task", async () => {
  const repo = branchRepo();
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["update-ref", "refs/heads/main", head], {
      cwd: repo,
    });
    const task = createTask({
      title: "Implement NEB-1407 — pull-request title overrides",
      jiraIssueKeys: ["NEB-1407"],
      source: { createdBy: "user" },
    });
    const generatedTitle = "NEB-1407: Fix pull-request title overrides";
    hoisted.generatePullRequestJson.mockResolvedValue({
      title: generatedTitle,
      body: ["Generated body"],
      warnings: [],
    });
    let authored:
      Parameters<GitHostingProvider["createPullRequest"]>[0] | undefined;
    hoisted.hostingProviderForRepo.mockResolvedValue(
      fakeProvider({
        createPullRequest: async (input) => {
          authored = input;
          return {
            number: 40,
            url: "https://github.com/acme/repo/pull/40",
            title: input.title,
            state: "open",
          };
        },
      }),
    );

    const result = await beginPullRequestCard({
      repoRoot: repo,
      sessionKind: "developer",
      sessionId: "jira-title-default",
      taskId: task.id,
      args: prArgs,
    });

    assert.equal(result.status, "created");
    assert.equal(authored?.title, generatedTitle);
    assert.equal(
      authored?.title,
      "NEB-1407: Fix pull-request title overrides",
      "the linked Jira Task must not prefix or replace the generated title",
    );
    const card = cardsForSession("jira-title-default")[0]!;
    assert.equal(card.title, generatedTitle);
    assert.equal(card.linkedTask?.id, task.id);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("an explicit title overrides only the title while the PR agent supplies body and warnings", async () => {
  const repo = branchRepo();
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["update-ref", "refs/heads/main", head], {
      cwd: repo,
    });
    hoisted.generatePullRequestJson.mockResolvedValue({
      title: "Generated default",
      body: ["Generated body"],
      warnings: ["Generated warning"],
    });
    let authored:
      Parameters<GitHostingProvider["createPullRequest"]>[0] | undefined;
    hoisted.hostingProviderForRepo.mockResolvedValue(
      fakeProvider({
        createPullRequest: async (input) => {
          authored = input;
          return {
            number: 41,
            url: "https://github.com/acme/repo/pull/41",
            title: input.title,
            state: "open",
          };
        },
      }),
    );

    const result = await beginPullRequestCard({
      repoRoot: repo,
      sessionKind: "developer",
      sessionId: "explicit-title",
      title: "  NEB-1407: Use caller title  ",
      args: prArgs,
    });

    assert.equal(result.status, "created");
    assert.equal(hoisted.generatePullRequestJson.mock.calls.length, 1);
    assert.equal(authored?.title, "NEB-1407: Use caller title");
    assert.equal(authored?.body, "Generated body");
    const card = cardsForSession("explicit-title")[0]!;
    assert.deepEqual(card.warnings, ["Generated warning"]);
    assert.equal(
      pullRequestCardRecord(card.id)?.context.explicitTitle,
      "NEB-1407: Use caller title",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a PR landing after card reservation is adopted into that same card", async () => {
  const repo = branchRepo();
  try {
    let observations = 0;
    hoisted.hostingProviderForRepo.mockResolvedValue(
      fakeProvider({
        findPullRequestForBranch: async () => {
          observations += 1;
          return observations === 1
            ? null
            : {
                number: 41,
                url: "https://github.com/acme/repo/pull/41",
                title: "Landed during recovery",
                state: "open",
              };
        },
        pullRequestDetail: async () => ({
          number: 41,
          state: "open",
          merged: false,
          mergeable: true,
          draft: false,
          headSha: "reviewed-head",
          headBranch: "feature",
          baseBranch: "main",
        }),
      }),
    );

    const result = await beginPullRequestCard({
      repoRoot: repo,
      sessionKind: "developer",
      sessionId: "session-recovery",
      title: "Requested replacement title",
      args: {
        draft: false,
        force: false,
        forceCommit: false,
        additionalContext: "",
        base: "main",
      },
    });

    assert.equal(result.status, "reused");
    const cards = cardsForSession("session-recovery");
    assert.equal(cards.length, 1);
    assert.equal(cards[0]!.id, result.cardId);
    assert.equal(cards[0]!.number, 41);
    assert.equal(cards[0]!.title, "Landed during recovery");
    assert.equal(cards[0]!.reused, true);
    assert.equal(
      pullRequestCardRecord(cards[0]!.id)?.context.explicitTitle,
      "Requested replacement title",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("adopting an existing PR with already-concluded CI does not notify on the first poll", async () => {
  const repo = branchRepo();
  try {
    hoisted.hostingProviderForRepo.mockResolvedValue(
      fakeProvider({
        findPullRequestForBranch: async () => ({
          number: 42,
          url: "https://github.com/acme/repo/pull/42",
          title: "Existing",
          state: "open",
        }),
        pullRequestDetail: async () => ({
          number: 42,
          state: "open",
          merged: false,
          mergeable: true,
          draft: false,
          headSha: "sha-already-green",
          headBranch: "feature",
          baseBranch: "main",
        }),
      }),
    );

    const result = await beginPullRequestCard({
      repoRoot: repo,
      sessionKind: "developer",
      sessionId: "session-1",
      args: {
        draft: false,
        force: false,
        forceCommit: false,
        additionalContext: "",
        base: "main",
      },
      sourceToolCallId: "tool-1",
    });

    assert.equal(result.status, "reused");
    const cardId = cardsForSession("session-1")[0]!.id;
    assert.equal(
      pullRequestCardRecord(cardId)?.context.notifiedHeadSha,
      "sha-already-green",
      "reuse must seed the dedupe key with the PR's current head so the watcher's first poll does not treat old CI as news",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("reuse still creates a usable card when the detail lookup fails", async () => {
  const repo = branchRepo();
  try {
    hoisted.hostingProviderForRepo.mockResolvedValue(
      fakeProvider({
        findPullRequestForBranch: async () => ({
          number: 7,
          url: "https://github.com/acme/repo/pull/7",
          title: "Existing",
          state: "open",
        }),
        pullRequestDetail: async () => {
          throw new Error("boom");
        },
      }),
    );

    const result = await beginPullRequestCard({
      repoRoot: repo,
      sessionKind: "developer",
      sessionId: "session-2",
      args: {
        draft: false,
        force: false,
        forceCommit: false,
        additionalContext: "",
        base: "main",
      },
      sourceToolCallId: "tool-2",
    });

    assert.equal(result.status, "reused");
    const cardId = cardsForSession("session-2")[0]!.id;
    assert.equal(
      pullRequestCardRecord(cardId)?.context.notifiedHeadSha,
      undefined,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("checked managed adoption requires exact existing PR head, base, and accepted SHA", async () => {
  const repo = branchRepo();
  try {
    const acceptedHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    for (const detailPatch of [
      { headBranch: "other" },
      { baseBranch: "release" },
      { headSha: "f".repeat(40) },
    ]) {
      const provider = fakeProvider({
        findPullRequestForBranch: async () => ({
          number: 77,
          url: "https://github.com/acme/repo/pull/77",
          title: "Wrong target",
          state: "open",
        }),
        pullRequestDetail: async () => ({
          number: 77,
          state: "open",
          merged: false,
          mergeable: true,
          draft: false,
          headSha: acceptedHead,
          headBranch: "feature",
          baseBranch: "main",
          ...detailPatch,
        }),
      });
      await assert.rejects(
        beginPullRequestCard({
          repoRoot: repo,
          sessionKind: "developer",
          sessionId: "managed-caller",
          sourceToolCallId: "tool-managed",
          args: prArgs,
          trustedTarget: {
            worktree: managedRow(repo),
            remote: "fork",
            acceptedHeadSha: acceptedHead,
            provider,
          },
        }),
        /does not match the checked managed target/,
      );
      assert.equal(cardsForSession("managed-caller").length, 0);
    }

    const merged = fakeProvider({
      findPullRequestForBranch: async () => ({
        number: 78,
        url: "https://github.com/acme/repo/pull/78",
        title: "Already merged",
        state: "merged",
      }),
      pullRequestDetail: async () => ({
        number: 78,
        state: "merged",
        merged: true,
        mergeable: true,
        draft: false,
        // Terminal state is the honest lifecycle answer even though this
        // branch has since moved beyond the commit that merged.
        headSha: "d".repeat(40),
        headBranch: "feature",
        baseBranch: "main",
      }),
    });
    const result = await beginPullRequestCard({
      repoRoot: repo,
      sessionKind: "developer",
      sessionId: "managed-caller",
      sourceToolCallId: "tool-managed",
      args: prArgs,
      trustedTarget: {
        worktree: managedRow(repo),
        remote: "fork",
        acceptedHeadSha: acceptedHead,
        provider: merged,
      },
    });
    assert.equal(result.status, "reused");
    const card = cardsForSession("managed-caller")[0]!;
    assert.equal(card.status, "merged");
    assert.equal(card.worktreeId, "wt-managed");
    assert.equal(card.sourceToolCallId, "tool-managed");
    assert.equal(pullRequestCardRecord(card.id)?.context.remote, "fork");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a managed PR that lands with a moved remote head stays visible with a stale warning", async () => {
  const repo = branchRepo();
  try {
    const acceptedHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["update-ref", "refs/heads/main", acceptedHead], {
      cwd: repo,
    });
    const authoringWarnings = Array.from(
      { length: 12 },
      (_, index) => `Authoring warning ${index + 1}`,
    );
    hoisted.generatePullRequestJson.mockResolvedValue({
      title: "Generated title",
      body: ["Generated body"],
      warnings: authoringWarnings,
    });
    const movedHead = "e".repeat(40);
    const provider = fakeProvider({
      findPullRequestForBranch: async () => null,
      createPullRequest: async () => ({
        number: 79,
        url: "https://github.com/acme/repo/pull/79",
        title: "Generated title",
        state: "open",
      }),
      pullRequestDetail: async () => ({
        number: 79,
        // Automation may make the just-created PR terminal before read-back;
        // accepted-head verification must remain exact in that interval.
        state: "merged",
        merged: true,
        mergeable: true,
        draft: false,
        headSha: movedHead,
        headBranch: "feature",
        baseBranch: "main",
      }),
    });

    const result = await beginPullRequestCard({
      repoRoot: repo,
      sessionKind: "developer",
      sessionId: "managed-stale",
      sourceToolCallId: "tool-stale",
      args: prArgs,
      trustedTarget: {
        worktree: managedRow(repo),
        remote: "fork",
        acceptedHeadSha: acceptedHead,
        provider,
      },
    });

    assert.equal(result.status, "created");
    const card = cardsForSession("managed-stale")[0]!;
    assert.equal(card.number, 79);
    assert.equal(card.status, "merged");
    assert.match(card.warnings[0]!, /STALE-HEAD WARNING/);
    assert.match(card.warnings[0]!, new RegExp(movedHead));
    assert.deepEqual(card.warnings.slice(1), authoringWarnings);
    assert.equal(
      pullRequestCardRecord(card.id)?.context.observedHeadSha,
      movedHead,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
