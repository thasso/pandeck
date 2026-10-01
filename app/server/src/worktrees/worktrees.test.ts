/**
 * Unit tests for the worktree domain layer: suffix sanitizing, create/list from
 * a real temp git repo, unmerged/dirty removal guards, and edge linking. Run:
 *   pnpm --filter @assistant/server test src/worktrees/worktrees.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, vi } from "vitest";

// Real git worktrees are created, rebased and removed end to end: seconds
// locally, but a starved CI runner has pushed the tool round trip past the
// 30 s default while nothing asserted here depends on time.
vi.setConfig({ testTimeout: 120_000 });
import type { ServerMessage } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "worktrees-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.ASSISTANT_BACKGROUND_FETCH = "0";

const { sanitizeWorktreeSuffix, fallbackWorktreeSuffix, taskWorktreeName } =
  await import("./worktreeNaming.ts");
const {
  createWorktree,
  listWorktreeRecords,
  removeWorktree,
  WorktreeRemovalBlockedError,
  hasUnmergedCommits,
  mapLimit,
  broadcastWorktreeList,
} = await import("./worktrees.ts");
const {
  resolveMainRepo,
  mainWorktreeId,
  resolveWorktreeRow,
  resolveMainWorktreeRow,
  mainCheckoutPathForProject,
  canonicalWorktreeId,
  worktreeExistsSync,
  mainRepoResolveCount,
  clearMainRepoCache,
  invalidateMainRepo,
} = await import("./worktreeResolve.ts");
const { branchContainedInBase } = await import("./worktreeStatus.ts");
const { setWorktreeBroadcaster } = await import("./worktreeEvents.ts");
const { mergeWorktree } = await import("./worktreeMerge.ts");
const {
  resolveSessionCwd,
  worktreeCwdForSession,
  sessionWorktreeEdge,
  sessionWorktreeMissing,
  acknowledgeMissingSessionWorktree,
  worktreeMissingProbe,
} = await import("./sessionCwd.ts");
const {
  computeWorktreeStatus,
  invalidateWorktreeStatus,
  refreshWorktreeWorkingTree,
} = await import("./worktreeStatus.ts");
const { countGitExecutionsForTests } = await import("../gitExec.ts");
const { scanTreeEventForTests, unregisterWorktree } =
  await import("./worktreeWatcher.ts");
const {
  getWorktreeChanges,
  getWorktreeFileDiff,
  getWorktreeLog,
  getWorktreeTree,
} = await import("./worktreeDiff.ts");
const { CWD } = await import("../config.ts");
const { projectStore } = await import("../db/projectStore.ts");
const {
  getWorktree,
  insertWorktree,
  updateWorktree,
  worktreeIdForSession,
  linkSessionToWorktree,
  sessionIdsForWorktree,
  liveSessionIdsForWorktree,
} = await import("../db/worktreeStore.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { beginPromptRun } = await import("../session/sessionRunLease.ts");
const { createPullRequestCard, patchPullRequestCard } =
  await import("../pullRequestCards.ts");
const { createTask, deleteTask } = await import("../tasks.ts");
const { worktreeTools } = await import("../tools/workshop/worktreeTools.ts");

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  );
}

/** Init a repo with one commit on `main`. */
function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  sh(path, "init", "-b", "main");
  writeFileSync(join(path, "readme.md"), "hello\n");
  sh(path, "add", "-A");
  sh(path, "commit", "-m", "init");
}

const repoPath = join(tmp, "mainrepo");
const worktreeRoot = join(tmp, "wt-root");
initRepo(repoPath);

projectStore.put({
  id: "wt-proj",
  name: "Worktree Project",
  key: "WT",
  description: "",
  status: "active",
  localPaths: [{ path: repoPath, kind: "repo", match: "prefix" }],
  worktreeRoot,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

// A second repo for main-checkout tests, with a NON-git dir listed first to
// exercise multi-path selection (resolveMainRepo skips it; the sync helper must
// too). Plus a repo-less project to prove no phantom main is fabricated.
const mainRepoPath = join(tmp, "mainreadsrepo");
initRepo(mainRepoPath);
const nonGitDir = join(tmp, "not-a-repo");
mkdirSync(nonGitDir, { recursive: true });

projectStore.put({
  id: "main-proj",
  name: "Main Project",
  key: "MP",
  description: "",
  status: "active",
  localPaths: [
    { path: nonGitDir, kind: "repo", match: "prefix" },
    { path: mainRepoPath, kind: "repo", match: "prefix" },
  ],
  worktreeRoot,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

// A superproject with one local submodule. Cloning a submodule over the `file`
// transport is refused by default (CVE-2022-39253), and our production git call
// carries no `-c` overrides — so the allowance is injected through the git
// environment for the whole test process, the way a host would configure it.
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow";
process.env.GIT_CONFIG_VALUE_0 = "always";

const submodulePath = join(tmp, "sublib");
initRepo(submodulePath);
writeFileSync(join(submodulePath, "lib.txt"), "lib\n");
sh(submodulePath, "add", "-A");
sh(submodulePath, "commit", "-m", "lib");

const superRepoPath = join(tmp, "superrepo");
initRepo(superRepoPath);
sh(superRepoPath, "submodule", "add", submodulePath, "sub");
sh(superRepoPath, "commit", "-m", "add submodule");

projectStore.put({
  id: "sub-proj",
  name: "Submodule Project",
  key: "SUB",
  description: "",
  status: "active",
  localPaths: [{ path: superRepoPath, kind: "repo", match: "prefix" }],
  worktreeRoot,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

projectStore.put({
  id: "nogit-proj",
  name: "No Git Project",
  key: "NG",
  description: "",
  status: "active",
  localPaths: [{ path: nonGitDir, kind: "repo", match: "prefix" }],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

test("sanitizeWorktreeSuffix clamps to branch-safe kebab-case", () => {
  assert.equal(sanitizeWorktreeSuffix("Fix Login Flow!"), "fix-login-flow");
  assert.equal(sanitizeWorktreeSuffix("  --weird__NAME--  "), "weird-name");
  assert.equal(sanitizeWorktreeSuffix("a".repeat(60)), "a".repeat(24));
  assert.equal(sanitizeWorktreeSuffix("???"), undefined);
  assert.match(fallbackWorktreeSuffix(), /^wt-[a-z0-9]+$/);
});

test("Task worktree names prefer Jira and preserve the reference", () => {
  assert.equal(
    taskWorktreeName(
      { id: "42", jiraIssueKeys: ["NEB-1234", "VIDEO-9"] },
      "Fix Playback Retry",
    ),
    "neb-1234-fix-playback-retry",
  );
  assert.equal(
    taskWorktreeName({ id: "42" }, "Fix Playback Retry"),
    "t42-fix-playback-retry",
  );
  assert.equal(
    taskWorktreeName(
      { id: "42", jiraIssueKeys: ["NEB-1234"] },
      "neb-1234-fix-playback",
    ),
    "neb-1234-fix-playback",
    "a model or user may supply the reference without duplicating it",
  );
  assert.equal(
    taskWorktreeName({ id: "Task-42/../../unsafe" }, "Fix Playback"),
    "ttask-42-unsafe-fix-playback",
    "an untrusted fallback id cannot escape the branch/path slug",
  );
  assert.equal(
    taskWorktreeName({ id: "42", jiraIssueKeys: ["not-a-key"] }, "Fix"),
    "t42-fix",
  );
  const long = taskWorktreeName(
    { id: "42", jiraIssueKeys: ["VERYLONGPROJECTKEY12-12"] },
    "x".repeat(100),
  );
  assert.equal(long.length, 48);
  assert.match(long, /^verylongprojectkey12-12-x{24}$/);
});

test("resolveMainRepo finds the project's git root", async () => {
  const project = projectStore.get("wt-proj")!;
  const main = await resolveMainRepo(project);
  assert.ok(main);
  // git resolves symlinks (macOS /var → /private/var), so compare realpaths.
  assert.equal(main.root, realpathSync(repoPath));
  assert.equal(main.branch, "main");
  assert.match(main.headOid, /^[0-9a-f]{40}$/);
});

test("createWorktree accepts a named local base branch", async () => {
  sh(repoPath, "branch", "stack-base");
  const baseCommit = sh(repoPath, "rev-parse", "stack-base").trim();
  const record = await createWorktree({
    projectId: "wt-proj",
    name: "stacked",
    baseBranch: "stack-base",
  });
  assert.equal(record.baseBranch, "stack-base");
  assert.equal(record.baseCommit, baseCommit);
  assert.equal(sh(record.path, "rev-parse", "HEAD").trim(), baseCommit);

  await assert.rejects(
    () =>
      createWorktree({
        projectId: "wt-proj",
        name: "bad-base",
        baseBranch: "HEAD",
      }),
    /must be a local branch.*remote-tracking refs, tags and commit SHAs/i,
  );

  let detached: Awaited<ReturnType<typeof createWorktree>> | undefined;
  sh(repoPath, "checkout", "--detach");
  try {
    detached = await createWorktree({
      projectId: "wt-proj",
      name: "detached-explicit-base",
      baseBranch: "stack-base",
    });
    assert.equal(detached.baseBranch, "stack-base");
    await assert.rejects(
      () => createWorktree({ projectId: "wt-proj", name: "detached-default" }),
      /detached HEAD.*name a local base branch/i,
    );
  } finally {
    sh(repoPath, "checkout", "main");
  }
  await removeWorktree(record.id, { deleteBranch: true });
  await removeWorktree(detached!.id, { deleteBranch: true });
  sh(repoPath, "branch", "-D", "stack-base");
});

test("createWorktree never awaits a disabled fetch and forks the local ref", async () => {
  const local = join(tmp, "create-fetch-local");
  const remote = join(tmp, "create-fetch-remote.git");
  const publisher = join(tmp, "create-fetch-publisher");
  initRepo(local);
  sh(tmp, "init", "--bare", "-b", "main", remote);
  sh(local, "remote", "add", "origin", remote);
  sh(local, "push", "-u", "origin", "main");
  sh(tmp, "clone", remote, publisher);
  writeFileSync(join(publisher, "remote.txt"), "new upstream commit\n");
  sh(publisher, "add", "-A");
  sh(publisher, "commit", "-m", "advance remote");
  sh(publisher, "push", "origin", "main");

  projectStore.put({
    id: "create-fetch-proj",
    name: "Create Fetch Project",
    key: "CF",
    description: "",
    status: "active",
    localPaths: [{ path: local, kind: "repo", match: "prefix" }],
    worktreeRoot,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const localBase = sh(local, "rev-parse", "refs/heads/main").trim();
  assert.equal(
    sh(local, "rev-parse", "refs/remotes/origin/main").trim(),
    localBase,
  );
  const created = await createWorktree({
    projectId: "create-fetch-proj",
    name: "disabled-fetch-does-not-block",
  });
  assert.equal(
    sh(local, "rev-parse", "refs/remotes/origin/main").trim(),
    localBase,
    "the explicit instance gate leaves the stale tracking ref untouched",
  );
  assert.equal(created.baseCommit, localBase);
  assert.equal(
    sh(created.path, "rev-parse", "HEAD").trim(),
    localBase,
    "the fork point remains the local base rather than its remote",
  );

  await removeWorktree(created.id, { deleteBranch: true });
});

test("createWorktree spawns a worktree + branch and records edges", async () => {
  const record = await createWorktree({
    projectId: "wt-proj",
    name: "feature-x",
    taskId: "42",
  });
  assert.equal(record.branch, "feature-x");
  assert.equal(record.baseBranch, "main");
  assert.equal(record.path, join(worktreeRoot, "mainrepo-feature-x"));
  assert.ok(existsSync(join(record.path, "readme.md")));
  assert.deepEqual(record.taskIds, ["42"]);

  // Branch exists in the main repo; suffix collision picks -2.
  const second = await createWorktree({
    projectId: "wt-proj",
    name: "feature-x",
  });
  assert.equal(second.branch, "feature-x-2");

  // Session edge helpers. A session has at most ONE worktree: relinking
  // replaces the edge instead of appending a second one.
  linkSessionToWorktree("sess-1", record.id);
  assert.equal(worktreeIdForSession("sess-1"), record.id);
  assert.deepEqual(sessionIdsForWorktree(record.id), ["sess-1"]);
  linkSessionToWorktree("sess-1", second.id);
  assert.equal(worktreeIdForSession("sess-1"), second.id);
  assert.deepEqual(sessionIdsForWorktree(record.id), []);

  // The synthetic main record leads the list; spawned worktrees follow.
  const listed = await listWorktreeRecords("wt-proj");
  assert.equal(listed[0]?.isMain, true);
  assert.equal(listed[0]?.id, mainWorktreeId("wt-proj"));
  assert.equal(listed.filter((w) => !w.isMain).length, 2);

  await removeWorktree(second.id, { deleteBranch: true });
  assert.equal(getWorktree(second.id)?.status, "removed");
  assert.equal(
    (await listWorktreeRecords("wt-proj")).filter((w) => !w.isMain).length,
    1,
  );
});

// The edges are insert-only, so "every session ever linked" is the wrong
// question for anything that acts on the checkout: one worktree normally
// carries a dev session plus the review/fork sessions spun off it, and those
// stay linked long after they are done.
test("liveSessionIdsForWorktree skips settled, archived and deleted sessions", async () => {
  const record = await createWorktree({ projectId: "wt-proj", name: "live-x" });
  for (const id of ["dev", "review", "old-review", "gone"])
    sessionStore.upsert({
      id: `live-${id}`,
      harness: "pi",
      agentType: "developer",
    });
  for (const id of ["dev", "review", "old-review", "gone"])
    linkSessionToWorktree(`live-${id}`, record.id);

  sessionStore.setSettled("live-review", true);
  sessionStore.setArchived("live-old-review", true);
  sessionStore.remove("live-gone");

  assert.equal(sessionIdsForWorktree(record.id).length, 4);
  assert.deepEqual(liveSessionIdsForWorktree(record.id), ["live-dev"]);

  // And a settled session comes back with it when it is unsettled again.
  sessionStore.setSettled("live-review", false);
  assert.deepEqual(liveSessionIdsForWorktree(record.id), [
    "live-dev",
    "live-review",
  ]);
});

test("managed worktree tools create, inspect and force-remove through their execute paths", async () => {
  const sessionBase = await createWorktree({
    projectId: "wt-proj",
    name: "tool-session-base",
  });
  const sessionId = "worktree-tool-session";
  linkSessionToWorktree(sessionId, sessionBase.id);
  const ctx = {
    toolCallId: "worktree-tool-test",
    session: {
      sessionId,
      harness: "pi" as const,
      agentType: "developer" as const,
    },
  };
  const tool = (name: string) =>
    worktreeTools.find((candidate) => candidate.name === name)!;
  const task = createTask({
    title: "Tool worktree task",
    projectId: "wt-proj",
    jiraIssueKeys: ["TOOLS-42"],
    source: { createdBy: "user" },
  });
  try {
    const created = await tool("worktree_create").execute(
      { name: "Fix Tool!", taskId: task.id },
      ctx,
    );
    const payload = created.details as {
      id: string;
      projectId: string;
      branch: string;
      path: string;
      baseCommit: string;
    };
    assert.equal(
      payload.projectId,
      "wt-proj",
      "uses the calling session project",
    );
    assert.equal(payload.branch, "tools-42-fix-tool");

    const detail = await tool("worktree_status").execute(
      { worktreeId: payload.id },
      ctx,
    );
    assert.equal(
      (detail.details as { worktree: { id: string } }).worktree.id,
      payload.id,
    );
    assert.equal(
      (await tool("worktree_status").execute({}, ctx)).details instanceof
        Object,
      true,
      "list execution stays available without an id",
    );

    sh(repoPath, "branch", "tool-new-base");
    const newBaseCommit = sh(
      repoPath,
      "rev-parse",
      "refs/heads/tool-new-base",
    ).trim();
    await assert.rejects(
      () =>
        tool("worktree_set_base").execute(
          { worktreeId: mainWorktreeId("wt-proj"), baseBranch: "main" },
          ctx,
        ),
      /main checkout/,
    );
    await assert.rejects(
      () =>
        tool("worktree_set_base").execute(
          { worktreeId: payload.id, baseBranch: "does-not-exist" },
          ctx,
        ),
      /existing local branch/,
    );

    updateWorktree(payload.id, {
      mergeStateJson: JSON.stringify({
        strategy: "merge",
        phase: "merging",
        startedAt: Date.now(),
      }),
    });
    await assert.rejects(
      () =>
        tool("worktree_set_base").execute(
          { worktreeId: payload.id, baseBranch: "tool-new-base" },
          ctx,
        ),
      /merge in progress/,
    );
    updateWorktree(payload.id, { mergeStateJson: null });

    const busySessionId = "worktree-tool-base-busy";
    sessionStore.upsert({
      id: busySessionId,
      harness: "pi",
      agentType: "developer",
    });
    linkSessionToWorktree(busySessionId, payload.id);
    const releaseBusyRun = beginPromptRun(busySessionId);
    try {
      await assert.rejects(
        () =>
          tool("worktree_set_base").execute(
            { worktreeId: payload.id, baseBranch: "tool-new-base" },
            ctx,
          ),
        /Another session is running/,
      );
    } finally {
      releaseBusyRun();
      sessionStore.remove(busySessionId);
    }

    const openCard = createPullRequestCard(
      {
        sessionId,
        status: "open",
        title: "Existing managed pull request",
        headBranch: payload.branch,
        baseBranch: "main",
        provider: "forgejo",
        number: 42,
        url: "https://forgejo.example/pulls/42",
        worktreeId: payload.id,
      },
      {
        repoRoot: payload.path,
        sessionKind: "developer",
        sessionId,
        headBranch: payload.branch,
        baseBranch: "main",
        draft: false,
      },
    );
    const baseChanged = await tool("worktree_set_base").execute(
      { worktreeId: payload.id, baseBranch: "tool-new-base" },
      ctx,
    );
    assert.deepEqual(baseChanged.details, {
      worktreeId: payload.id,
      branch: payload.branch,
      previousBaseBranch: "main",
      previousBaseCommit: payload.baseCommit,
      baseBranch: "tool-new-base",
      baseCommit: newBaseCommit,
      changed: true,
      openPullRequests: [
        {
          provider: "forgejo",
          number: 42,
          url: "https://forgejo.example/pulls/42",
          baseBranch: "main",
        },
      ],
      warnings: [
        "1 open managed pull request still uses the provider base recorded on the existing card. This metadata change did not retarget them; do not create another pull request until you inspect and settle the existing one.",
      ],
    });
    patchPullRequestCard(openCard.id, { status: "closed" });
    assert.equal(getWorktree(payload.id)?.baseBranch, "tool-new-base");
    assert.equal(getWorktree(payload.id)?.baseCommit, newBaseCommit);
    assert.equal(
      (
        (
          await tool("worktree_set_base").execute(
            { worktreeId: payload.id, baseBranch: "tool-new-base" },
            ctx,
          )
        ).details as { changed: boolean }
      ).changed,
      false,
      "setting the recorded base again is a no-op and preserves its pivot",
    );
    const movedBaseCommit = sh(
      repoPath,
      "commit-tree",
      "HEAD^{tree}",
      "-p",
      "HEAD",
      "-m",
      "move tool base",
    ).trim();
    sh(repoPath, "branch", "-f", "tool-new-base", movedBaseCommit);
    const divergedBase = await tool("worktree_set_base").execute(
      { worktreeId: payload.id, baseBranch: "tool-new-base" },
      ctx,
    );
    assert.equal((divergedBase.details as { changed: boolean }).changed, false);
    assert.equal(
      getWorktree(payload.id)?.baseCommit,
      newBaseCommit,
      "a diverged base keeps the common-ancestor diff pivot",
    );
    sh(payload.path, "rebase", "tool-new-base");
    const baseRefreshed = await tool("worktree_set_base").execute(
      { worktreeId: payload.id, baseBranch: "tool-new-base" },
      ctx,
    );
    assert.equal((baseRefreshed.details as { changed: boolean }).changed, true);
    assert.equal(getWorktree(payload.id)?.baseCommit, movedBaseCommit);

    sh(repoPath, "tag", "tool-tag-only");
    await assert.rejects(
      () =>
        tool("worktree_set_base").execute(
          { worktreeId: payload.id, baseBranch: "tool-tag-only" },
          ctx,
        ),
      /existing local branch/,
    );
    await assert.rejects(
      () =>
        tool("worktree_set_base").execute(
          { worktreeId: payload.id, baseBranch: payload.branch },
          ctx,
        ),
      /own merge-back target/,
    );

    writeFileSync(join(payload.path, "tool-dirty.txt"), "dirty\n");
    const removed = await tool("worktree_remove").execute(
      { worktreeId: payload.id, force: true },
      ctx,
    );
    assert.deepEqual((removed.details as { discarded?: unknown }).discarded, {
      dirtyFiles: 1,
      unmergedCommits: 0,
    });
    await assert.rejects(
      () => tool("worktree_status").execute({ worktreeId: payload.id }, ctx),
      /Unknown worktree/,
    );

    const vanished = await tool("worktree_create").execute(
      { projectId: "wt-proj", name: "vanished-unmerged" },
      ctx,
    );
    const vanishedPayload = vanished.details as { id: string; path: string };
    writeFileSync(join(vanishedPayload.path, "commit.txt"), "commit\n");
    sh(vanishedPayload.path, "add", "commit.txt");
    sh(vanishedPayload.path, "commit", "-m", "unmerged work");
    rmSync(vanishedPayload.path, { recursive: true, force: true });
    const vanishedRemoved = await tool("worktree_remove").execute(
      { worktreeId: vanishedPayload.id, force: true },
      ctx,
    );
    assert.deepEqual(
      (vanishedRemoved.details as { discarded?: unknown }).discarded,
      { dirtyFiles: 0, unmergedCommits: 1 },
      "loss reporting uses containment even after the checkout folder is gone",
    );

    sh(repoPath, "branch", "missing-loss-base");
    const missingBase = await tool("worktree_create").execute(
      {
        projectId: "wt-proj",
        name: "missing-base-loss",
        baseBranch: "missing-loss-base",
      },
      ctx,
    );
    const missingBasePayload = missingBase.details as {
      id: string;
      path: string;
    };
    writeFileSync(join(missingBasePayload.path, "commit.txt"), "commit\n");
    sh(missingBasePayload.path, "add", "commit.txt");
    sh(missingBasePayload.path, "commit", "-m", "base disappeared");
    sh(repoPath, "branch", "-D", "missing-loss-base");
    const missingBaseRemoved = await tool("worktree_remove").execute(
      { worktreeId: missingBasePayload.id, force: true },
      ctx,
    );
    assert.deepEqual(
      (missingBaseRemoved.details as { discarded?: unknown }).discarded,
      { dirtyFiles: 0, unmergedCommits: "unknown" },
      "a missing base never becomes a fictitious zero-loss report",
    );
  } finally {
    deleteTask(task.id);
    await removeWorktree(sessionBase.id, { deleteBranch: true });
  }
});

test("createWorktree checks out submodules and announces that step", async () => {
  // `git worktree add` only writes the gitlink; without an explicit submodule
  // update the new worktree's submodule directory stays empty.
  let announced = 0;
  const record = await createWorktree({
    projectId: "sub-proj",
    name: "with-sub",
    onSubmodules: () => {
      announced += 1;
    },
  });
  assert.ok(existsSync(join(record.path, ".gitmodules")));
  assert.ok(existsSync(join(record.path, "sub", "lib.txt")));
  // The clone is the minutes-long step, so a caller showing progress is told
  // when it starts rather than leaving "creating…" up for all of it.
  assert.equal(announced, 1, "the submodule checkout was announced once");
});

test("removeWorktree removes a clean worktree that has submodules", async () => {
  // Git refuses `worktree remove` outright once a checkout carries submodules,
  // and only `--force` skips that. Without it a superproject's worktrees could
  // never be removed the ordinary, unforced way.
  const record = await createWorktree({
    projectId: "sub-proj",
    name: "removable-sub",
  });
  assert.ok(existsSync(join(record.path, "sub", "lib.txt")));
  await removeWorktree(record.id, { deleteBranch: true });
  assert.equal(existsSync(record.path), false);
  assert.equal(
    sh(superRepoPath, "worktree", "list", "--porcelain").includes(record.path),
    false,
  );
});

test("removeWorktree still refuses a dirty worktree that has submodules", async () => {
  // The submodule allowance must not become a blanket force: our own dirty
  // guard runs first and still protects uncommitted work.
  const record = await createWorktree({
    projectId: "sub-proj",
    name: "dirty-sub",
  });
  writeFileSync(join(record.path, "scratch.txt"), "wip\n");
  await assert.rejects(() => removeWorktree(record.id), /uncommitted changes/);
  assert.ok(existsSync(record.path));
  await removeWorktree(record.id, { force: true, deleteBranch: true });
  assert.equal(existsSync(record.path), false);
});

test("removeWorktree refuses when a submodule holds work no remote has", async () => {
  // The gitlink ends up back where it started, so the superproject sees a clean
  // tree — but the branch commit lives ONLY in the submodule gitdir that
  // removal deletes. Nothing outside the submodule can reveal it.
  const record = await createWorktree({
    projectId: "sub-proj",
    name: "sub-local-work",
  });
  const sub = join(record.path, "sub");
  const pinned = sh(sub, "rev-parse", "HEAD").trim();
  sh(sub, "checkout", "-q", "-b", "local-work");
  writeFileSync(join(sub, "lib.txt"), "local\n");
  sh(sub, "commit", "-qam", "submodule-only work");
  sh(sub, "checkout", "-q", "--detach", pinned);
  assert.equal(sh(record.path, "status", "--porcelain=v1", "-uall").trim(), "");

  // A refusal decided under the repo lock stops nothing either.
  const shell = spawn("sh", ["-c", "sleep 30 & wait"], {
    cwd: record.path,
    stdio: "ignore",
  });
  const shellExited = new Promise<void>((resolve) =>
    shell.once("exit", () => resolve()),
  );
  let trackedStops = 0;
  const stopTrackedWork = async (): Promise<void> => {
    trackedStops += 1;
  };
  await assert.rejects(
    () => removeWorktree(record.id, { stopTrackedWork }),
    /no remote or tag has/,
  );
  assert.ok(existsSync(record.path));
  assert.equal(trackedStops, 0);
  assert.equal(shell.exitCode, null);
  await removeWorktree(record.id, {
    force: true,
    deleteBranch: true,
    stopTrackedWork,
  });
  assert.equal(trackedStops, 1);
  await shellExited;
  assert.equal(existsSync(record.path), false);
});

test("removeWorktree ignores an upstream tag no submodule branch reaches", async () => {
  // A clone fetches tags, so a tag on history no branch reaches (rewritten
  // history, a deleted release branch) arrives in every fresh submodule
  // checkout. Counting it as local work would make this superproject
  // permanently unremovable unforced — the bug this whole path fixes.
  sh(submodulePath, "checkout", "-q", "-b", "orphan-src");
  writeFileSync(join(submodulePath, "orphan.txt"), "orphan\n");
  sh(submodulePath, "add", "-A");
  sh(submodulePath, "commit", "-qm", "orphan release");
  sh(submodulePath, "tag", "v-orphan");
  sh(submodulePath, "checkout", "-q", "main");
  sh(submodulePath, "branch", "-qD", "orphan-src");

  const record = await createWorktree({
    projectId: "sub-proj",
    name: "orphan-tag",
  });
  assert.ok(
    sh(join(record.path, "sub"), "tag", "--list").includes("v-orphan"),
    "the orphan tag reached the submodule checkout",
  );
  await removeWorktree(record.id, { deleteBranch: true });
  assert.equal(existsSync(record.path), false);
});

test("createWorktree announces no submodule step for a repo without submodules", async () => {
  let announced = 0;
  await createWorktree({
    projectId: "wt-proj",
    name: "no-sub",
    onSubmodules: () => {
      announced += 1;
    },
  });
  assert.equal(announced, 0, "nothing to check out, nothing to report");
});

test("createWorktree removes an unregistered interrupted checkout on cancellation", async () => {
  const controller = new AbortController();
  const name = "cancelled-submodule";
  const path = join(worktreeRoot, `superrepo-${name}`);
  let recreated = false;
  await assert.rejects(
    () =>
      createWorktree({
        projectId: "sub-proj",
        name,
        signal: controller.signal,
        onSubmodules: () => {
          // Simulate an interrupted `git worktree add`: Git has dropped the
          // admin entry but its checkout child left a directory behind. This
          // makes `git worktree remove` fail with "not a working tree".
          sh(superRepoPath, "worktree", "remove", "--force", path);
          mkdirSync(path);
          writeFileSync(join(path, "partial.txt"), "partial\n");
          controller.abort(new Error("cancelled"));
          // The real checkout child can recreate the directory after a first
          // successful rm. The settle loop must observe and delete this one.
          setTimeout(() => {
            mkdirSync(path, { recursive: true });
            writeFileSync(join(path, "recreated.txt"), "recreated\n");
            recreated = true;
          }, 50);
        },
      }),
    /cancelled/,
  );
  assert.equal(
    recreated,
    true,
    "the directory was recreated after first removal",
  );
  assert.equal(existsSync(path), false);
  assert.equal(sh(superRepoPath, "branch", "--list", name).trim(), "");
  assert.equal(
    sh(superRepoPath, "worktree", "list", "--porcelain").includes(path),
    false,
  );
});

test("createWorktree settles a directory recreated after successful Git removal", async () => {
  const controller = new AbortController();
  const name = "cancelled-registered";
  const path = join(worktreeRoot, `superrepo-${name}`);
  let recreated = false;
  await assert.rejects(
    () =>
      createWorktree({
        projectId: "sub-proj",
        name,
        signal: controller.signal,
        onSubmodules: () => {
          controller.abort(new Error("cancelled"));
          // Let `git worktree remove` complete, then model the checkout child
          // recreating its directory after Git reported success.
          setTimeout(() => {
            mkdirSync(path, { recursive: true });
            writeFileSync(join(path, "recreated.txt"), "recreated\n");
            recreated = true;
          }, 150);
        },
      }),
    /cancelled/,
  );
  assert.equal(recreated, true);
  assert.equal(existsSync(path), false);
  assert.equal(sh(superRepoPath, "branch", "--list", name).trim(), "");
});

test("createWorktree discards the checkout when a post-add step throws", async () => {
  // The `onSubmodules` progress callback is one of the two things that can
  // actually throw between `worktree add` and the row insert: the git side
  // cannot, because `gitOptional` absorbs non-zero exits AND execution
  // failures (both surface as non-zero results). This is the path behind the
  // first-send provisioning card's Retry.
  const before = (await listWorktreeRecords("sub-proj")).length;
  await assert.rejects(
    () =>
      createWorktree({
        projectId: "sub-proj",
        name: "doomed",
        taskId: "310",
        onSubmodules: () => {
          throw new Error("boom");
        },
      }),
    /boom/,
    "the original cause reaches the caller, not a cleanup error",
  );

  // Nothing left behind: no folder, no registration, no branch, no row.
  const doomedPath = join(worktreeRoot, "superrepo-doomed");
  assert.equal(existsSync(doomedPath), false, "the checkout is gone");
  assert.ok(!sh(superRepoPath, "worktree", "list").includes(doomedPath));
  assert.equal(
    sh(superRepoPath, "branch", "--list", "doomed").trim(),
    "",
    "the branch is gone",
  );
  assert.equal((await listWorktreeRecords("sub-proj")).length, before);

  // …so the retry gets the name it asked for instead of a `-2` suffix.
  const retry = await createWorktree({ projectId: "sub-proj", name: "doomed" });
  assert.equal(retry.branch, "doomed");
  assert.equal(retry.path, doomedPath);
  assert.ok(existsSync(join(retry.path, "sub", "lib.txt")));
});

test("createWorktree skips paths retained by soft-removed rows", async () => {
  // A removed worktree keeps its row so historical Task/session edges remain
  // resolvable. Its branch and folder are gone, but `path` remains UNIQUE, so
  // suffix selection must treat the persisted path as occupied too.
  const takenPath = join(worktreeRoot, "superrepo-taken");
  insertWorktree({
    id: "ghost-row",
    projectId: "sub-proj",
    mainRepoRoot: realpathSync(superRepoPath),
    path: takenPath,
    branch: "taken",
    baseBranch: "main",
    baseCommit: "0".repeat(40),
    status: "removed",
    mergeStateJson: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    removedAt: Date.now(),
  });

  const record = await createWorktree({
    projectId: "sub-proj",
    name: "taken",
  });

  assert.equal(record.branch, "taken-2");
  assert.equal(record.path, join(worktreeRoot, "superrepo-taken-2"));
  assert.equal(existsSync(takenPath), false, "the retired path stays unused");
  assert.equal(getWorktree("ghost-row")?.status, "removed");
});

test("synthetic main worktree: resolveWorktreeRow, cwd binding, and no merge/remove", async () => {
  // resolveWorktreeRow builds a synthetic row for the project's main checkout.
  const mainId = mainWorktreeId("wt-proj");
  const mainRow = await resolveWorktreeRow(mainId);
  assert.ok(mainRow);
  assert.equal(mainRow.id, mainId);
  assert.equal(mainRow.branch, "main");
  assert.equal(mainRow.baseBranch, "main"); // self → dirty-only status
  assert.equal(mainRow.path, realpathSync(repoPath));

  // A session bound to the synthetic main node resolves to the checkout root,
  // aligned with the synthetic row's (realpath'd) path.
  assert.equal(mainCheckoutPathForProject("wt-proj"), realpathSync(repoPath));
  linkSessionToWorktree("main-sess", mainId);
  assert.equal(worktreeCwdForSession("main-sess"), realpathSync(repoPath));
  assert.equal(resolveSessionCwd("main-sess"), realpathSync(repoPath));

  // Main is read + session only.
  await assert.rejects(
    () => removeWorktree(mainId),
    /main checkout cannot be removed/i,
  );
  await assert.rejects(() => mergeWorktree(mainId), /no branch to merge/i);
});

test("main worktree: id canonicalization, git-validation, and multi-path selection", async () => {
  // An aliased/mis-cased id normalizes to the project's canonical id, so the
  // synthetic row/edges match the `main:<projectId>` row worktreeList emits.
  const aliasRow = await resolveWorktreeRow("main:MAIN-PROJ");
  assert.ok(aliasRow);
  assert.equal(aliasRow.id, mainWorktreeId("main-proj"));
  assert.equal(aliasRow.projectId, "main-proj");
  // resolveMainRepo skips the non-git path and selects the real repo.
  assert.equal(aliasRow.path, realpathSync(mainRepoPath));
  assert.equal(aliasRow.branch, "main");
  assert.equal(aliasRow.baseBranch, "main");

  // The sync cwd helper aligns: it prefers the git-backed path over the
  // first-listed non-git directory (returned as the realpath'd root).
  assert.equal(
    mainCheckoutPathForProject("main-proj"),
    realpathSync(mainRepoPath),
  );

  // A project with no git repo yields no synthetic main (no phantom worktree
  // for a session to bind to).
  assert.equal(await resolveMainWorktreeRow("nogit-proj"), undefined);
  assert.equal(
    await resolveWorktreeRow(mainWorktreeId("nogit-proj")),
    undefined,
  );
});

test("main worktree read surfaces: dirty-only status + changes/diff/tree/log", async () => {
  const row = (await resolveWorktreeRow(mainWorktreeId("main-proj")))!;

  // Clean checkout → dirty-only semantics: nothing dirty, no ahead/behind.
  let status = await computeWorktreeStatus(row, { force: true });
  assert.equal(status.dirty, false);
  assert.equal(status.ahead, 0);
  assert.equal(status.behind, 0);
  assert.equal(status.upstream, undefined);

  sh(mainRepoPath, "checkout", "--detach");
  status = await computeWorktreeStatus(row, { force: true });
  assert.equal(status.branch, null);
  assert.equal(status.upstream, undefined);
  assert.equal(status.head?.length, 12);
  sh(mainRepoPath, "checkout", "main");

  // A working-tree edit surfaces as dirty with a change list + diff.
  writeFileSync(join(mainRepoPath, "readme.md"), "hello\nmain-edit\n");
  writeFileSync(join(mainRepoPath, "untracked.txt"), "x\n");
  status = await computeWorktreeStatus(row, { force: true });
  assert.equal(status.dirty, true);
  assert.equal(status.filesChanged, 1);
  assert.equal(status.untracked, 1);
  assert.equal(status.additions, 2);
  assert.equal(status.deletions, 0);
  assert.equal(status.ahead, 0); // still no "ahead" — main has no fork base
  const changes = await getWorktreeChanges(row, { kind: "workingTree" });
  assert.deepEqual(
    changes.files.map((f) => [f.path, f.status]),
    [
      ["readme.md", "modified"],
      ["untracked.txt", "untracked"],
    ],
  );
  const diff = await getWorktreeFileDiff(row, "readme.md", {
    kind: "workingTree",
  });
  assert.match(diff.diff, /\+main-edit/);

  const tree = await getWorktreeTree(row, "");
  assert.ok(tree.some((e) => e.path === "readme.md"));
  const log = await getWorktreeLog(row, 10);
  assert.equal(log.entries[0]?.subject, "init");
});

test("mapLimit bounds concurrency and preserves order", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (n) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded limit`);
});

test("main repo resolution is cached (bounds git subprocess fan-out)", async () => {
  clearMainRepoCache();
  const before = mainRepoResolveCount();
  // Repeated resolves of the same project within the TTL do NOT re-shell git.
  await resolveMainWorktreeRow("main-proj");
  await resolveMainWorktreeRow("main-proj");
  await resolveWorktreeRow(mainWorktreeId("main-proj"));
  assert.equal(mainRepoResolveCount() - before, 1);

  // Listing across projects resolves each git-backed project at most once, and a
  // second list within the TTL adds no further git work.
  clearMainRepoCache();
  const listBase = mainRepoResolveCount();
  const first = await listWorktreeRecords();
  const coldAfterFirst = mainRepoResolveCount() - listBase;
  await listWorktreeRecords();
  assert.equal(mainRepoResolveCount() - listBase, coldAfterFirst); // cache hit on 2nd list
  // main-proj + wt-proj resolve (nogit-proj resolves too but yields no repo).
  assert.ok(
    first.some((w) => w.isMain && w.id === mainWorktreeId("main-proj")),
  );
});

test("invalidateMainRepo forces a fresh resolution before the TTL expires", async () => {
  clearMainRepoCache();
  const base = mainRepoResolveCount();
  await resolveMainWorktreeRow("main-proj");
  await resolveMainWorktreeRow("main-proj");
  assert.equal(mainRepoResolveCount() - base, 1); // second call cached
  invalidateMainRepo("main-proj");
  await resolveMainWorktreeRow("main-proj");
  assert.equal(mainRepoResolveCount() - base, 2); // re-resolved after invalidation
});

test("invalidation mid-resolve is not clobbered by the in-flight resolve's write-back", async () => {
  clearMainRepoCache();
  // Kick off a resolve, invalidate while it's in flight, then let it complete.
  const inFlight = resolveMainWorktreeRow("main-proj");
  invalidateMainRepo("main-proj"); // bumps generation → the pending write-back is dropped
  await inFlight;
  // The stale result must NOT have populated the cache: the next read re-resolves.
  const base = mainRepoResolveCount();
  await resolveMainWorktreeRow("main-proj");
  assert.equal(mainRepoResolveCount() - base, 1);
});

test("a resolved main checkout stays cached until its HEAD or ref moves", async () => {
  const stampRepo = join(tmp, "stamp-repo");
  initRepo(stampRepo);
  projectStore.put({
    id: "stamp-proj",
    name: "Stamp Project",
    key: "SP",
    description: "",
    status: "active",
    localPaths: [{ path: stampRepo, kind: "repo", match: "prefix" }],
    worktreeRoot,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  // Metadata written in the same second as the resolve is not trusted as a
  // stamp, so age it like a checkout nobody touched for an hour.
  const hourAgo = new Date(Date.now() - 3_600_000);
  for (const file of ["HEAD", "refs/heads/main"])
    utimesSync(join(stampRepo, ".git", file), hourAgo, hourAgo);
  clearMainRepoCache();
  const base = mainRepoResolveCount();
  const first = await resolveMainWorktreeRow("stamp-proj");

  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
  try {
    // Well past the old 3 s TTL, nothing moved: no git process.
    await resolveMainWorktreeRow("stamp-proj");
    assert.equal(mainRepoResolveCount() - base, 1);

    sh(stampRepo, "commit", "--allow-empty", "-m", "next");
    const moved = await resolveMainWorktreeRow("stamp-proj");
    assert.equal(mainRepoResolveCount() - base, 2);
    assert.notEqual(moved?.baseCommit, first?.baseCommit);
    assert.equal(moved?.baseCommit, sh(stampRepo, "rev-parse", "HEAD").trim());
  } finally {
    clock.mockRestore();
  }
});

test("project_registry_write tool invalidates the main-repo cache", async () => {
  clearMainRepoCache();
  await resolveMainWorktreeRow("main-proj"); // warm the cache
  const base = mainRepoResolveCount();
  await resolveMainWorktreeRow("main-proj");
  assert.equal(mainRepoResolveCount() - base, 0); // confirm it's cached

  const { projectRegistryWriteTool } =
    await import("../tools/core/projectRegistryTools.ts");
  const execute = projectRegistryWriteTool.execute as (
    p: unknown,
    c: unknown,
  ) => Promise<unknown>;
  await execute(
    {
      operation: "updateProject",
      id: "main-proj",
      project: { description: "touched via tool" },
    },
    {},
  );

  // Cache dropped by the tool → the next resolve is a fresh (cold) one.
  const after = mainRepoResolveCount();
  await resolveMainWorktreeRow("main-proj");
  assert.equal(mainRepoResolveCount() - after, 1);
});

test("mainCheckoutPathForProject aligns with resolveMainRepo for a nested localPath (via cache)", async () => {
  const sub = join(mainRepoPath, "sub", "dir");
  mkdirSync(sub, { recursive: true });
  projectStore.put({
    id: "nested-proj",
    name: "Nested Project",
    key: "NP",
    description: "",
    status: "active",
    localPaths: [{ path: sub, kind: "repo", match: "prefix" }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  clearMainRepoCache();
  // Cold cache: git-free fallback returns the configured (sub)directory (realpath'd).
  assert.equal(mainCheckoutPathForProject("nested-proj"), realpathSync(sub));
  // Warm cache: returns the resolved git ROOT, matching the synthetic row path.
  const row = await resolveMainWorktreeRow("nested-proj");
  assert.equal(row?.path, realpathSync(mainRepoPath));
  assert.equal(
    mainCheckoutPathForProject("nested-proj"),
    realpathSync(mainRepoPath),
  );
});

test("broadcastWorktreeList coalesces so the last send reflects current state", async () => {
  const captured: ServerMessage[] = [];
  const lastList = () =>
    [...captured]
      .reverse()
      .find(
        (m): m is Extract<ServerMessage, { type: "worktreeList" }> =>
          m.type === "worktreeList",
      );
  setWorktreeBroadcaster({
    broadcast: (msg) => {
      captured.push(msg);
    },
    broadcastWorktree: (_id, msg) => {
      captured.push(msg);
    },
  });
  try {
    const wt = await createWorktree({ projectId: "wt-proj", name: "order" });
    // Overlapping broadcasts around a removal: coalescing serializes them onto
    // one loop that recomputes at send time, so the FINAL list drops the row —
    // a stale create-era broadcast can never land last.
    void broadcastWorktreeList();
    await removeWorktree(wt.id, { force: true, deleteBranch: true });
    void broadcastWorktreeList();

    // The coalesced loop settles asynchronously; poll until it converges, then
    // confirm it stays converged (no late stale re-send).
    for (let i = 0; i < 50; i++) {
      await broadcastWorktreeList();
      await new Promise((r) => setTimeout(r, 5));
      if (lastList() && !lastList()!.worktrees.some((w) => w.id === wt.id))
        break;
    }
    assert.ok(lastList(), "expected a worktreeList broadcast");
    assert.ok(
      !lastList()!.worktrees.some((w) => w.id === wt.id),
      "final list must exclude the removed worktree",
    );
  } finally {
    setWorktreeBroadcaster({
      broadcast: () => undefined,
      broadcastWorktree: () => undefined,
    });
  }
});

test("canonicalWorktreeId and worktreeExistsSync normalize/guard ids", () => {
  assert.equal(
    canonicalWorktreeId("main:MAIN-PROJ"),
    mainWorktreeId("main-proj"),
  );
  assert.equal(
    canonicalWorktreeId(mainWorktreeId("main-proj")),
    mainWorktreeId("main-proj"),
  );
  assert.equal(
    canonicalWorktreeId("main:no-such-project"),
    "main:no-such-project",
  ); // unknown passes through
  assert.equal(canonicalWorktreeId("some-uuid"), "some-uuid"); // spawned ids untouched

  assert.equal(worktreeExistsSync(mainWorktreeId("main-proj")), true);
  assert.equal(worktreeExistsSync("main:no-such-project"), false);
  assert.equal(worktreeExistsSync("some-uuid"), false);
});

test("concurrent creates with the same name take distinct suffixes", async () => {
  const [a, b] = await Promise.all([
    createWorktree({ projectId: "wt-proj", name: "race" }),
    createWorktree({ projectId: "wt-proj", name: "race" }),
  ]);
  const branches = [a.branch, b.branch].sort();
  assert.deepEqual(branches, ["race", "race-2"]);
  await removeWorktree(a.id, { force: true, deleteBranch: true });
  await removeWorktree(b.id, { force: true, deleteBranch: true });
});

test("resolveSessionCwd follows the in_worktree edge and falls back to CWD", async () => {
  const record = await createWorktree({
    projectId: "wt-proj",
    name: "cwd-check",
  });
  linkSessionToWorktree("cwd-sess", record.id);
  assert.equal(worktreeCwdForSession("cwd-sess"), record.path);
  assert.equal(resolveSessionCwd("cwd-sess"), record.path);
  assert.deepEqual(sessionWorktreeEdge("cwd-sess"), {
    kind: "live",
    worktreeId: record.id,
    path: record.path,
  });

  // A session that never had an edge runs in the app CWD BY DESIGN: no edge,
  // nothing missing, nothing to acknowledge (Task 321).
  assert.equal(resolveSessionCwd("unlinked-sess"), CWD);
  assert.deepEqual(sessionWorktreeEdge("unlinked-sess"), { kind: "none" });
  assert.equal(sessionWorktreeMissing("unlinked-sess"), false);
  assert.equal(acknowledgeMissingSessionWorktree("unlinked-sess"), undefined);

  // A removed worktree is a DEAD edge, not "no worktree": the plain cwd
  // fallback stays (the session can still be opened and read), but the session
  // is flagged so every run-starting path refuses it.
  await removeWorktree(record.id, { deleteBranch: true });
  assert.equal(worktreeCwdForSession("cwd-sess"), undefined);
  assert.equal(resolveSessionCwd("cwd-sess"), CWD);
  assert.deepEqual(sessionWorktreeEdge("cwd-sess"), {
    kind: "missing",
    worktreeId: record.id,
  });
  assert.equal(sessionWorktreeMissing("cwd-sess"), true);
  assert.equal(worktreeMissingProbe()(record.id), true);

  // The acknowledgement clears the flag for THAT worktree only.
  assert.equal(acknowledgeMissingSessionWorktree("cwd-sess"), record.id);
  assert.equal(sessionWorktreeMissing("cwd-sess"), false);
  assert.equal(resolveSessionCwd("cwd-sess"), CWD);

  // Relinked to another worktree that then disappears: the old answer does not
  // carry over.
  const second = await createWorktree({ projectId: "wt-proj", name: "cwd-2" });
  linkSessionToWorktree("cwd-sess", second.id);
  assert.equal(sessionWorktreeMissing("cwd-sess"), false);
  await removeWorktree(second.id, { deleteBranch: true });
  assert.equal(sessionWorktreeMissing("cwd-sess"), true);
});

test("a retired coordinator worktree never blocks a later conversation", async () => {
  const record = await createWorktree({
    projectId: "wt-proj",
    name: "coordinator-retired",
  });
  sessionStore.upsert({
    id: "retired-coordinator",
    harness: "pi",
    agentType: "workflow-coordinator",
  });
  linkSessionToWorktree("retired-coordinator", record.id);

  await removeWorktree(record.id, { deleteBranch: true });

  assert.equal(
    sessionWorktreeMissing("retired-coordinator"),
    false,
    "the coordinator cannot be retargeted through file or shell tools",
  );
});

test("status, changes, file diffs, log, and tree read surfaces", async () => {
  const record = await createWorktree({ projectId: "wt-proj", name: "reads" });
  const row = getWorktree(record.id)!;
  // This test owns every status scan it counts. A base-ref watcher scan racing
  // the assertions could populate the merged-tip cache first.
  await unregisterWorktree(row.id);

  // Clean at creation: not dirty, nothing ahead, trivially merged. A full
  // status scan stays within the durable five-process budget (the fifth is the
  // one per-repository branch-upstream map).
  const cleanScan = await countGitExecutionsForTests(() =>
    computeWorktreeStatus(row, { force: true }),
  );
  let status = cleanScan.result;
  assert.ok(
    cleanScan.executions <= 5,
    `status spawned ${cleanScan.executions} git processes`,
  );
  assert.equal(status.dirty, false);
  assert.equal(status.ahead, 0);
  assert.equal(status.merged, true);
  assert.equal(status.upstream, undefined);

  const cleanTreeEvent = await countGitExecutionsForTests(() =>
    scanTreeEventForTests(row, true),
  );
  assert.equal(cleanTreeEvent.executions, 2);
  assert.equal(
    cleanTreeEvent.result.changes,
    undefined,
    "a repeated clean event spends zero additional git reads on changes",
  );

  // Working-tree scope: an edit + an untracked file.
  writeFileSync(join(record.path, "readme.md"), "hello\nworld\n");
  writeFileSync(join(record.path, "new.txt"), "fresh\n");
  // Caller mutations invalidate full reads, but the tree tier must retain its
  // reference baseline and still avoid rev-list/containment work.
  invalidateWorktreeStatus(row.id);
  const legacyTreeEvent = await countGitExecutionsForTests(async () => {
    await refreshWorktreeWorkingTree(row);
    return getWorktreeChanges(row, { kind: "workingTree" });
  });
  assert.equal(
    legacyTreeEvent.executions,
    6,
    "the old file-event composition read status/diff twice plus two rev-parses",
  );
  const treeScan = await countGitExecutionsForTests(() =>
    scanTreeEventForTests(row, undefined),
  );
  assert.equal(
    treeScan.executions,
    2,
    "the shared file event runs one status and one numstat",
  );
  assert.deepEqual(
    {
      dirty: treeScan.result.status.dirty,
      filesChanged: treeScan.result.status.filesChanged,
      untracked: treeScan.result.status.untracked,
      ahead: treeScan.result.status.ahead,
      behind: treeScan.result.status.behind,
      merged: treeScan.result.status.merged,
    },
    {
      dirty: true,
      filesChanged: 1,
      untracked: 1,
      ahead: 0,
      behind: 0,
      merged: true,
    },
    "the working half moves while the cached reference half is reused",
  );
  const working = treeScan.result.changes!;
  assert.deepEqual(
    working.files.map((f) => [f.path, f.status]),
    [
      ["new.txt", "untracked"],
      ["readme.md", "modified"],
    ],
  );

  const fileDiff = await getWorktreeFileDiff(row, "readme.md", {
    kind: "workingTree",
  });
  assert.match(fileDiff.diff, /\+world/);
  assert.equal(fileDiff.oldContent, "hello\n");
  assert.equal(fileDiff.newContent, "hello\nworld\n");
  const untrackedFileDiff = await getWorktreeFileDiff(row, "new.txt", {
    kind: "workingTree",
  });
  assert.match(untrackedFileDiff.diff, /\+fresh/);

  // Commit → dirty clears, ahead grows, range scopes work.
  sh(record.path, "add", "-A");
  sh(record.path, "commit", "-m", "edit readme + add file");
  writeFileSync(join(repoPath, "base-only.txt"), "base\n");
  sh(repoPath, "add", "-A");
  sh(repoPath, "commit", "-m", "advance base independently");
  sh(record.path, "branch", "--set-upstream-to=main", record.branch);
  status = await computeWorktreeStatus(row, { force: true });
  // One assertion over the whole live triple, plus the two counts `dirty` is
  // derived from: a failure then shows WHICH part went stale — a scan that
  // began before the commit reports `ahead: 0` too — rather than just `true`.
  assert.deepEqual(
    {
      dirty: status.dirty,
      filesChanged: status.filesChanged,
      untracked: status.untracked,
      ahead: status.ahead,
      merged: status.merged,
    },
    { dirty: false, filesChanged: 0, untracked: 0, ahead: 1, merged: false },
  );
  // Porcelain v2 reports `+ahead -behind`; pin the orientation explicitly.
  assert.deepEqual(status.upstream, {
    ahead: 1,
    behind: 1,
    name: "main",
  });

  const memoizedScan = await countGitExecutionsForTests(() =>
    computeWorktreeStatus(row, { force: true }),
  );
  status = memoizedScan.result;
  assert.ok(
    memoizedScan.executions <= 6,
    `unchanged tip pair must reuse the containment probe (${memoizedScan.executions} processes)`,
  );
  writeFileSync(join(repoPath, "base-again.txt"), "base again\n");
  sh(repoPath, "add", "-A");
  sh(repoPath, "commit", "-m", "move the base tip again");
  const movedBaseScan = await countGitExecutionsForTests(() =>
    computeWorktreeStatus(row, { force: true }),
  );
  status = movedBaseScan.result;
  assert.ok(
    movedBaseScan.executions > 6,
    "a new base oid must recompute containment",
  );

  const lastCommit = await getWorktreeChanges(row, {
    kind: "range",
    from: "HEAD~1",
    to: "HEAD",
  });
  assert.deepEqual(
    lastCommit.files.map((f) => [f.path, f.status]),
    [
      ["new.txt", "added"],
      ["readme.md", "modified"],
    ],
  );
  const rangeDiff = await getWorktreeFileDiff(row, "readme.md", {
    kind: "range",
    from: record.baseCommit,
    to: "HEAD",
  });
  assert.match(rangeDiff.diff, /\+world/);
  assert.equal(rangeDiff.oldContent, "hello\n");

  // Open-ended range (base → working tree) includes uncommitted edits.
  writeFileSync(join(record.path, "readme.md"), "hello\nworld\nagain\n");
  const sinceBase = await getWorktreeFileDiff(row, "readme.md", {
    kind: "range",
    from: record.baseCommit,
  });
  assert.match(sinceBase.diff, /\+again/);
  assert.equal(sinceBase.newContent, "hello\nworld\nagain\n");

  const log = await getWorktreeLog(row, 10);
  assert.equal(log.entries[0]?.subject, "edit readme + add file");
  assert.equal(log.entries[0]?.onBase, undefined);
  assert.equal(log.entries[1]?.onBase, true);

  writeFileSync(
    join(record.path, ".gitignore"),
    "agent-output/\nempty-output/\n",
  );
  mkdirSync(join(record.path, "agent-output"));
  mkdirSync(join(record.path, "empty-output"));
  writeFileSync(join(record.path, "agent-output", "result.md"), "secret\n");

  const tree = await getWorktreeTree(row, "");
  assert.deepEqual(
    tree.map((e) => [e.path, e.kind]),
    [
      [".gitignore", "file"],
      ["new.txt", "file"],
      ["readme.md", "file"],
    ],
  );
  const treeWithIgnored = await getWorktreeTree(row, "", true);
  assert.deepEqual(
    treeWithIgnored.map((e) => [e.path, e.kind]),
    [
      ["agent-output", "dir"],
      ["empty-output", "dir"],
      [".gitignore", "file"],
      ["new.txt", "file"],
      ["readme.md", "file"],
    ],
  );
  assert.deepEqual(await getWorktreeTree(row, "agent-output"), []);
  assert.deepEqual(
    (await getWorktreeTree(row, "agent-output", true)).map((e) => [
      e.path,
      e.kind,
    ]),
    [["agent-output/result.md", "file"]],
  );

  await removeWorktree(record.id, { force: true, deleteBranch: true });
});

test("shared v2 tree snapshot matches v1 changes for renames and exact paths", async () => {
  const record = await createWorktree({
    projectId: "wt-proj",
    name: "snapshot-paths",
  });
  const row = getWorktree(record.id)!;
  await unregisterWorktree(row.id);

  writeFileSync(join(record.path, "rename source.txt"), "rename me\n");
  sh(record.path, "add", "-A");
  sh(record.path, "commit", "-m", "add rename source");
  await computeWorktreeStatus(row, { force: true });

  sh(record.path, "mv", "rename source.txt", "renamed café file.txt");
  writeFileSync(
    join(record.path, "renamed café file.txt"),
    "rename me\nchanged\n",
  );
  writeFileSync(join(record.path, "untracked space.txt"), "one\ntwo\n");
  const v1 = await getWorktreeChanges(row, { kind: "workingTree" });
  const v2 = await scanTreeEventForTests(row, undefined);

  assert.deepEqual(v2.changes?.files, v1.files);
  assert.deepEqual(v2.changes?.totals, v1.totals);
  assert.deepEqual(v2.changes?.totals, {
    files: 2,
    additions: 3,
    deletions: 0,
  });
  assert.deepEqual(
    v2.changes?.files.map((file) => [file.path, file.oldPath, file.status]),
    [
      ["renamed café file.txt", "rename source.txt", "renamed"],
      ["untracked space.txt", undefined, "untracked"],
    ],
  );

  await removeWorktree(record.id, { force: true, deleteBranch: true });
});

test("a forced status never adopts a scan that started before the change", async () => {
  const record = await createWorktree({
    projectId: "wt-proj",
    name: "forced-read",
  });
  const row = getWorktree(record.id)!;

  writeFileSync(join(record.path, "readme.md"), "hello\nworld\n");
  // A plain read puts a scan in flight that observes the DIRTY tree. Nothing
  // awaits it: this is the watcher-tick-vs-user-action overlap in miniature.
  const inFlight = computeWorktreeStatus(row);

  sh(record.path, "add", "-A");
  sh(record.path, "commit", "-m", "commit while a scan is in flight");

  // Forced = authoritative. Coalescing onto the pending pre-commit scan would
  // report the checkout as dirty and 0 ahead well after it was committed.
  const forced = await computeWorktreeStatus(row, { force: true });
  assert.deepEqual(
    { dirty: forced.dirty, ahead: forced.ahead },
    { dirty: false, ahead: 1 },
  );

  await inFlight.catch(() => undefined);
  await removeWorktree(record.id, { force: true, deleteBranch: true });
});

test("containment guards propagate git execution failures", async () => {
  const missingRepo = join(tmp, "missing-containment-repo");
  const row = {
    id: "missing-containment",
    projectId: "wt-proj",
    mainRepoRoot: missingRepo,
    path: missingRepo,
    branch: "feature",
    baseBranch: "main",
    baseCommit: "0".repeat(40),
    status: "active" as const,
    mergeStateJson: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    removedAt: null,
  };

  await assert.rejects(() => hasUnmergedCommits(row), /git rev-parse .*failed/);
  await assert.rejects(
    () => branchContainedInBase(missingRepo, "feature", "main"),
    /git merge-base .*failed/,
  );
});

test("removeWorktree stops what still runs in the checkout, but only once it will remove", async () => {
  const record = await createWorktree({
    projectId: "wt-proj",
    name: "running",
  });
  // A dev server stand-in, started below a shell like an agent's: it keeps
  // rewriting its cache into the checkout.
  const writer = spawn(
    "sh",
    [
      "-c",
      "sh -c 'while true; do mkdir -p .cache && touch .cache/deps; sleep 0.05; done' & wait",
    ],
    { cwd: record.path, stdio: "ignore" },
  );
  const writerExited = new Promise<void>((resolve) =>
    writer.once("exit", () => resolve()),
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  let trackedStops = 0;
  const stopTrackedWork = async (): Promise<void> => {
    trackedStops += 1;
  };

  // Refused (the cache makes it dirty): nothing is stopped.
  await assert.rejects(
    () => removeWorktree(record.id, { stopTrackedWork }),
    (err) => err instanceof WorktreeRemovalBlockedError,
  );
  assert.equal(trackedStops, 0);
  assert.equal(writer.exitCode, null);
  assert.equal(writer.signalCode, null);

  await removeWorktree(record.id, { force: true, stopTrackedWork });
  await writerExited;
  assert.equal(trackedStops, 1);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(!existsSync(record.path), "nothing recreated the checkout");
});

test("removeWorktree refuses dirty and unmerged worktrees unless forced", async () => {
  const record = await createWorktree({ projectId: "wt-proj", name: "guards" });

  // Dirty guard.
  writeFileSync(join(record.path, "dirty.txt"), "wip\n");
  await assert.rejects(
    () => removeWorktree(record.id),
    (err) =>
      err instanceof WorktreeRemovalBlockedError &&
      /uncommitted changes/i.test(err.message),
  );

  // Unmerged-commit guard: it guards the BRANCH DELETION, so it refuses only
  // the removal that would discard those commits.
  sh(record.path, "add", "-A");
  sh(record.path, "commit", "-m", "wip");
  assert.equal(await hasUnmergedCommits(getWorktree(record.id)!), true);
  await assert.rejects(
    () => removeWorktree(record.id, { deleteBranch: true }),
    (err) =>
      err instanceof WorktreeRemovalBlockedError &&
      /not merged/i.test(err.message),
  );

  // Merged into main → removable, branch deletable.
  sh(repoPath, "merge", record.branch);
  assert.equal(await hasUnmergedCommits(getWorktree(record.id)!), false);
  await removeWorktree(record.id, { deleteBranch: true });
  assert.equal(getWorktree(record.id)?.status, "removed");
  assert.ok(!existsSync(record.path));

  // Force path: dirty + unmerged, removed anyway with branch force-deleted.
  const forced = await createWorktree({ projectId: "wt-proj", name: "forced" });
  writeFileSync(join(forced.path, "x.txt"), "x\n");
  sh(forced.path, "add", "-A");
  sh(forced.path, "commit", "-m", "unmerged");
  writeFileSync(join(forced.path, "y.txt"), "dirty\n");
  await removeWorktree(forced.id, { force: true, deleteBranch: true });
  assert.equal(getWorktree(forced.id)?.status, "removed");
  assert.ok(!existsSync(forced.path));
});

test("removeWorktree keeps an undelivered branch without force when asked to keep it", async () => {
  const record = await createWorktree({ projectId: "wt-proj", name: "keeper" });
  writeFileSync(join(record.path, "keep.txt"), "keep\n");
  sh(record.path, "add", "-A");
  sh(record.path, "commit", "-m", "undelivered work");
  const head = sh(record.path, "rev-parse", "HEAD");
  assert.equal(await hasUnmergedCommits(getWorktree(record.id)!), true);

  // Nothing is discarded, so nothing is consented to: the commits stay on the
  // branch ref, which is the whole point of leaving it behind.
  await removeWorktree(record.id);
  assert.equal(getWorktree(record.id)?.status, "removed");
  assert.ok(!existsSync(record.path));
  assert.equal(sh(repoPath, "rev-parse", record.branch), head);
});

test("a base branch that resolves to nothing reports unknown containment, not merged", async () => {
  sh(repoPath, "branch", "vanishing-base");
  const record = await createWorktree({
    projectId: "wt-proj",
    name: "orphan-base",
    baseBranch: "vanishing-base",
  });
  writeFileSync(join(record.path, "work.txt"), "work\n");
  sh(record.path, "add", "-A");
  sh(record.path, "commit", "-m", "work on a stacked base");
  sh(repoPath, "branch", "-D", "vanishing-base");
  invalidateWorktreeStatus(record.id);

  // ahead/behind cannot be counted against a ref that is gone. Reporting the
  // resulting 0 as "merged" told the Remove dialog this branch was delivered
  // precisely when removal's own containment guard was about to refuse it.
  const status = await computeWorktreeStatus(getWorktree(record.id)!);
  assert.equal(status.baseUnresolved, true);
  assert.equal(status.merged, false);
  assert.equal(status.ahead, 0);

  await assert.rejects(
    () => removeWorktree(record.id, { deleteBranch: true }),
    (err) =>
      err instanceof WorktreeRemovalBlockedError &&
      /not merged/i.test(err.message),
  );
  await removeWorktree(record.id, { deleteBranch: true, force: true });
  assert.equal(getWorktree(record.id)?.status, "removed");
  assert.ok(!existsSync(record.path));
});

test("removeWorktree accepts an exact refreshed base without moving the stale local base", async () => {
  sh(repoPath, "branch", "stale-cleanup-base");
  const record = await createWorktree({
    projectId: "wt-proj",
    name: "stacked-cleanup",
    baseBranch: "stale-cleanup-base",
  });
  writeFileSync(join(record.path, "delivered.txt"), "delivered\n");
  sh(record.path, "add", "-A");
  sh(record.path, "commit", "-m", "delivered work");

  const refreshedBase = sh(
    repoPath,
    "commit-tree",
    `${record.branch}^{tree}`,
    "-p",
    "stale-cleanup-base",
    "-p",
    record.branch,
    "-m",
    "remote merge",
  ).trim();
  assert.equal(await hasUnmergedCommits(getWorktree(record.id)!), true);
  assert.equal(
    await hasUnmergedCommits(getWorktree(record.id)!, refreshedBase),
    false,
  );

  await removeWorktree(record.id, {
    deleteBranch: true,
    branchContainmentBase: refreshedBase,
  });

  assert.equal(getWorktree(record.id)?.status, "removed");
  assert.ok(!existsSync(record.path));
  assert.equal(sh(repoPath, "branch", "--list", record.branch).trim(), "");
  sh(repoPath, "branch", "-D", "stale-cleanup-base");
});

/**
 * The incident this guards (Task 659): `git worktree remove` is NOT atomic. When
 * the working tree cannot be deleted it still deletes its administrative
 * directory, so Git stops registering the checkout while the folder survives.
 * The row used to stay active, and every retry answered "is not a working tree",
 * which left the worktree unremovable through the app for good.
 *
 * The state is reproduced by deleting the admin directory directly — the same
 * half-removal, without needing a root-owned file to provoke it.
 */
test("a checkout git already unregistered is still removable", async () => {
  const record = await createWorktree({
    projectId: "wt-proj",
    name: "half-removed",
  });
  const adminDir = join(repoPath, ".git", "worktrees", basename(record.path));
  assert.ok(existsSync(adminDir));
  rmSync(adminDir, { recursive: true, force: true });
  assert.equal(
    sh(repoPath, "worktree", "list").includes(record.path),
    false,
    "git must no longer register the checkout",
  );
  assert.ok(existsSync(record.path), "but its directory is still on disk");

  await removeWorktree(record.id, { deleteBranch: true });

  assert.equal(getWorktree(record.id)?.status, "removed");
  assert.ok(!existsSync(record.path));
  assert.equal(sh(repoPath, "branch", "--list", record.branch).trim(), "");
});

/**
 * Owner-locked directories are NOT residue. pytest's read-only artifact
 * directories are the everyday case, and refusing them would refuse removals the
 * app performs routinely; restoring owner access is what reclaims them.
 *
 * Root bypasses the mode check, so on a root test runner the fixture is simply
 * deletable and there is nothing to discriminate.
 */
test.skipIf(process.getuid?.() === 0)(
  "a read-only directory in the checkout does not block removal",
  async () => {
    const record = await createWorktree({
      projectId: "wt-proj",
      name: "readonly-artifacts",
    });
    const artifacts = join(record.path, "artifacts");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "output.png"), "x");
    chmodSync(artifacts, 0o555);

    // This is the PARTIAL failure, live: git cannot unlink through a read-only
    // directory, so `git worktree remove` fails after having deleted its admin
    // directory. The warning proves the recovery branch ran rather than the
    // whole thing quietly succeeding.
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await removeWorktree(record.id, { deleteBranch: true, force: true });
      assert.ok(
        warned.mock.calls.some((call) =>
          String(call[0]).includes("git unregistered"),
        ),
        "removal must have recovered from a half-finished git worktree remove",
      );
    } finally {
      warned.mockRestore();
    }

    assert.equal(getWorktree(record.id)?.status, "removed");
    assert.ok(!existsSync(record.path));
    assert.equal(sh(repoPath, "worktree", "list").includes(record.path), false);
    assert.equal(sh(repoPath, "branch", "--list", record.branch).trim(), "");
  },
);

/**
 * `git worktree prune` exits 0 without pruning a LOCKED worktree, so its
 * success proves nothing. Finalizing the row on it would hand back exactly the
 * disagreement this work removes — and the branch could never be deleted, since
 * Git still considers the ref checked out.
 */
test("a locked worktree whose folder is gone refuses instead of finalizing", async () => {
  const record = await createWorktree({
    projectId: "wt-proj",
    name: "locked-missing",
  });
  sh(repoPath, "worktree", "lock", record.path);
  rmSync(record.path, { recursive: true, force: true });

  await assert.rejects(
    () => removeWorktree(record.id, { deleteBranch: true }),
    (err: Error) =>
      err.name === "WorktreeRemovalBlockedError" && /locked/.test(err.message),
  );
  assert.equal(getWorktree(record.id)?.status, "active");

  // Once the lock is gone the same call completes, record and git together.
  sh(repoPath, "worktree", "unlock", record.path);
  await removeWorktree(record.id, { deleteBranch: true });
  assert.equal(getWorktree(record.id)?.status, "removed");
  assert.equal(sh(repoPath, "worktree", "list").includes(record.path), false);
  assert.equal(sh(repoPath, "branch", "--list", record.branch).trim(), "");
});
