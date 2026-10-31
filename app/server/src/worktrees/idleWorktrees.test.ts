/**
 * Which worktrees the cleanup queue calls idle, and what it says retiring each
 * would lose. Git is faked: the rule under test is liveness and classification.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { WorktreeGitStatus } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "idle-worktrees-"));
process.env.ASSISTANT_CWD = tmp;
process.env.ASSISTANT_BACKGROUND_FETCH = "0";

const { computeIdleWorktrees, idleWorktreeKind, worktreeIdleRefusal } =
  await import("./idleWorktrees.ts");
const workflowStore = await import("../db/workflowStore.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { insertWorktree, linkSessionToWorktree, recordWorktreeCreator } =
  await import("../db/worktreeStore.ts");
const { createPullRequestCard, setPullRequestCardBroadcastForTests } =
  await import("../pullRequestCards.ts");

setPullRequestCardBroadcastForTests(() => {});

function status(patch: Partial<WorktreeGitStatus> = {}): WorktreeGitStatus {
  return {
    worktreeId: "x",
    branch: "b",
    head: "abc",
    dirty: false,
    filesChanged: 0,
    untracked: 0,
    additions: 0,
    deletions: 0,
    ahead: 0,
    behind: 0,
    merged: false,
    updatedAt: 0,
    ...patch,
  };
}

function row(
  id: string,
  updatedAt = 1_000,
  mergeStateJson: string | null = null,
) {
  insertWorktree({
    id,
    projectId: "proj",
    mainRepoRoot: join(tmp, "main"),
    path: join(tmp, id),
    branch: id,
    baseBranch: "main",
    baseCommit: "0".repeat(40),
    status: "active",
    mergeStateJson,
    branchCleanupOid: null,
    createdAt: updatedAt,
    updatedAt,
    removedAt: null,
  });
}

function session(id: string, updatedAt = 2_000) {
  sessionStore.upsert({ id, harness: "pi", agentType: "developer", updatedAt });
}

test("idleWorktreeKind says what retiring would lose, and never calls unknown clean", () => {
  assert.deepEqual(
    idleWorktreeKind(status({ dirty: true, filesChanged: 2, untracked: 1 })),
    { kind: "uncommitted", changedFiles: 3 },
  );
  assert.deepEqual(idleWorktreeKind(status({ baseUnresolved: true })), {
    kind: "unknown",
  });
  assert.deepEqual(idleWorktreeKind(status({ merged: true })), {
    kind: "delivered",
  });
  // Zero ahead without the read's merged proof is a count that failed.
  assert.deepEqual(idleWorktreeKind(status()), { kind: "unknown" });
  // Git never read it: not clean, whatever else the status says.
  assert.deepEqual(idleWorktreeKind(status({ head: null, merged: true })), {
    kind: "unknown",
  });
  // A merged pull request is no evidence about local commits: a squash merge
  // the local base has not caught up with, and commits pushed AFTER the merge,
  // look the same. Only local containment says delivered.
  assert.deepEqual(
    idleWorktreeKind(status({ ahead: 2, upstream: { ahead: 0, behind: 0 } })),
    { kind: "unmerged", ahead: 2, pushed: true },
  );
  assert.deepEqual(idleWorktreeKind(status({ ahead: 3, merged: true })), {
    kind: "delivered",
  });
  assert.deepEqual(
    idleWorktreeKind(status({ ahead: 2, upstream: { ahead: 0, behind: 0 } })),
    { kind: "unmerged", ahead: 2, pushed: true },
  );
  assert.deepEqual(idleWorktreeKind(status({ ahead: 2 })), {
    kind: "unmerged",
    ahead: 2,
    pushed: false,
  });
});

test("a worktree is idle only when nobody up its ownership chain is live", async () => {
  // Coordinator → peer. The peer is done; the coordinator still runs, so the
  // worktree it handed the peer is not idle.
  session("coord", 5_000);
  session("peer", 3_000);
  sessionStore.linkSpawned("coord", "peer");
  sessionStore.setSettled("peer", true);
  row("handed");
  recordWorktreeCreator("coord", "handed");
  linkSessionToWorktree("peer", "handed");

  // Everything here is settled or archived: idle.
  session("done-coord", 4_000);
  session("done-peer", 6_000);
  sessionStore.linkSpawned("done-coord", "done-peer");
  sessionStore.setSettled("done-coord", true);
  sessionStore.setArchived("done-peer", true);
  row("finished", 500);
  linkSessionToWorktree("done-peer", "finished");

  // Nobody ever held it.
  row("orphan", 100);
  // A merge is in flight.
  row("merging", 100, JSON.stringify({ strategy: "merge", phase: "merging" }));
  // A pull request is still open for it.
  row("in-review", 100);
  createPullRequestCard(
    {
      sessionId: "done-peer",
      status: "open",
      title: "t",
      headBranch: "in-review",
      baseBranch: "main",
      number: 4,
      worktreeId: "in-review",
    },
    {
      repoRoot: tmp,
      sessionKind: "developer",
      sessionId: "done-peer",
      headBranch: "in-review",
      baseBranch: "main",
      draft: false,
    },
  );
  // Gone from disk.
  row("vanished", 200);

  const statuses: Record<string, WorktreeGitStatus> = {
    finished: status({ ahead: 1, merged: true }),
    orphan: status({ dirty: true, filesChanged: 4 }),
  };
  const idle = await computeIdleWorktrees({
    exists: async (row) => !row.path.endsWith("vanished"),
    status: async (worktree) => {
      const answer = statuses[worktree.id];
      if (!answer) throw new Error("git failed");
      return answer;
    },
  });
  assert.deepEqual(
    idle.map((item) => [item.worktree.id, item.kind, item.lastActivityAt]),
    [
      ["orphan", "uncommitted", 100],
      ["vanished", "missing", 200],
      // The latest activity of anyone who held it, the archived peer included.
      ["finished", "delivered", 6_000],
    ],
  );

  // The coordinator settles: now the handed worktree is idle too, and git
  // failing for it reads as unknown.
  sessionStore.setSettled("coord", true);
  const after = await computeIdleWorktrees({
    exists: async () => true,
    status: async () => {
      throw new Error("git failed");
    },
  });
  assert.deepEqual(
    after.find((item) => item.worktree.id === "handed")?.kind,
    "unknown",
  );
});

test("an open Workflow Run's worktree is not idle, and retire re-asks the rule", async () => {
  session("run-role", 1_000);
  sessionStore.setSettled("run-role", true);
  row("run-owned", 100);
  linkSessionToWorktree("run-role", "run-owned");
  const run = workflowStore.createRun({
    taskId: 9_001,
    recipeId: "code-delivery",
    recipeVersion: 1,
    maxIterations: 1,
    maxReviewPasses: 1,
    actor: { kind: "user" },
  });
  workflowStore.attachRunWorktree(
    run.id,
    { worktreeId: "run-owned", branch: "run-owned" },
    { kind: "user" },
  );
  const listed = async () =>
    (
      await computeIdleWorktrees({
        exists: async () => true,
        status: async () => status(),
      })
    ).map((item) => item.worktree.id);
  assert.equal((await listed()).includes("run-owned"), false);
  assert.match(worktreeIdleRefusal("run-owned") ?? "", /Workflow Run/);

  // An idle one passes; a session waking up there since the snapshot refuses.
  row("quiet", 100);
  session("quiet-holder", 1_000);
  sessionStore.setSettled("quiet-holder", true);
  linkSessionToWorktree("quiet-holder", "quiet");
  assert.equal(worktreeIdleRefusal("quiet"), undefined);
  sessionStore.setSettled("quiet-holder", false);
  assert.match(worktreeIdleRefusal("quiet") ?? "", /still live/);
  assert.match(worktreeIdleRefusal("gone-row") ?? "", /no longer available/);
});

test("a requireIdle retire refuses under its hold when a holder woke since the snapshot", async () => {
  const { retireWorktree } = await import("../worktreeRemoval.ts");
  const { getWorktree } = await import("../db/worktreeStore.ts");
  row("woken", 100);
  session("woken-holder", 1_000);
  sessionStore.setSettled("woken-holder", true);
  linkSessionToWorktree("woken-holder", "woken");
  let removed = false;
  let held = 0;
  const operations = {
    resolveWorktree: async (id: string) => getWorktree(id),
    refreshBase: async () => "base-oid",
    branchContained: async () => true,
    blockedReason: async () => undefined,
    // The holder wakes up after the first check, while the hold is taken.
    reserveForRemoval: () => {
      held += 1;
      sessionStore.setSettled("woken-holder", false);
      return () => {};
    },
    sessionsToSettle: () => [],
    removeWorktree: async () => {
      removed = true;
    },
    settleSessions: async () => {},
  };
  const result = await retireWorktree(
    "woken",
    { deleteBranch: true, requireIdle: true },
    operations,
  );
  assert.equal(held, 1);
  assert.equal(removed, false);
  assert.equal(result.status, "refused");
  assert.match(
    result.status === "refused" ? result.refusal : "",
    /no longer idle/,
  );

  // Without the option the same retire is not this rule's business.
  sessionStore.setSettled("woken-holder", true);
  const plain = await retireWorktree(
    "woken",
    { deleteBranch: true },
    { ...operations, reserveForRemoval: () => () => {} },
  );
  assert.equal(plain.status, "retired");
  assert.equal(removed, true);
});

test("a checkout git cannot read is unknown, through the real status read", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const main = join(tmp, "real-main");
  mkdirSync(main, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
      { cwd: main },
    );
  git("init", "-b", "main");
  writeFileSync(join(main, "readme.md"), "x\n");
  git("add", "-A");
  git("commit", "-m", "init");
  git("branch", "broken");
  // The row names a real branch of a real repository, but its folder is a
  // plain directory: `git status` there cannot answer.
  const path = join(tmp, "broken-checkout");
  mkdirSync(path, { recursive: true });
  insertWorktree({
    id: "broken",
    projectId: "proj",
    mainRepoRoot: main,
    path,
    branch: "broken",
    baseBranch: "main",
    baseCommit: git("rev-parse", "main").toString().trim(),
    status: "active",
    mergeStateJson: null,
    branchCleanupOid: null,
    createdAt: 100,
    updatedAt: 100,
    removedAt: null,
  });
  const idle = await computeIdleWorktrees();
  assert.equal(
    idle.find((item) => item.worktree.id === "broken")?.kind,
    "unknown",
  );
});

test("a branch whose ahead count fails is unknown, through the real status read", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const main = join(tmp, "partial-main");
  mkdirSync(main, { recursive: true });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
      { cwd, encoding: "utf8" },
    ).trim();
  git(main, "init", "-b", "main");
  writeFileSync(join(main, "base.txt"), "base\n");
  git(main, "add", "-A");
  git(main, "commit", "-m", "base");
  const path = join(tmp, "partial-checkout");
  git(main, "worktree", "add", "-b", "partial", path);
  writeFileSync(join(path, "one.txt"), "1\n");
  git(path, "add", "-A");
  git(path, "commit", "-m", "one");
  const middle = git(path, "rev-parse", "HEAD");
  writeFileSync(join(path, "two.txt"), "2\n");
  git(path, "add", "-A");
  git(path, "commit", "-m", "two");
  // The middle commit's object goes missing: `git status` still reads the tip,
  // while counting main...tip fails on the broken history.
  rmSync(join(main, ".git", "objects", middle.slice(0, 2), middle.slice(2)));
  insertWorktree({
    id: "partial",
    projectId: "proj",
    mainRepoRoot: main,
    path,
    branch: "partial",
    baseBranch: "main",
    baseCommit: git(main, "rev-parse", "main"),
    status: "active",
    mergeStateJson: null,
    branchCleanupOid: null,
    createdAt: 100,
    updatedAt: 100,
    removedAt: null,
  });
  const idle = await computeIdleWorktrees();
  assert.equal(
    idle.find((item) => item.worktree.id === "partial")?.kind,
    "unknown",
  );
});
