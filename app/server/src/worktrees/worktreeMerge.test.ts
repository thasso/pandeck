/**
 * Merge-back tests against a real temp git repo: squash and merge-commit happy
 * paths, precondition guards, and conflict detection (the merger-agent spawn
 * is exercised up to its model-unavailable fallback, which must leave the
 * merge in `conflicts` instead of failing).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { ServerMessage } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "worktree-merge-test-"));
process.env.ASSISTANT_CWD = tmp;

const { createWorktree, hasUnmergedCommits } = await import("./worktrees.ts");
const { mainWorktreeId } = await import("./worktreeResolve.ts");
const { addWorktreeComment } = await import("./worktreeComments.ts");
const { mergeWorktree, mergePhase, reconcileWorktreeMergesOnBoot } =
  await import("./worktreeMerge.ts");
const { setWorktreeBroadcaster } = await import("./worktreeEvents.ts");
const { repoLockKey, withRepoLock } = await import("../gitExec.ts");
const { getComment, getWorktree, updateWorktree } =
  await import("../db/worktreeStore.ts");
const { projectStore } = await import("../db/projectStore.ts");

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  );
}

const repoPath = join(tmp, "mergerepo");
mkdirSync(repoPath, { recursive: true });
sh(repoPath, "init", "-b", "main");
writeFileSync(join(repoPath, "readme.md"), "hello\n");
sh(repoPath, "add", "-A");
sh(repoPath, "commit", "-m", "init");

projectStore.put({
  id: "mg-proj",
  name: "Merge Project",
  key: "MG",
  description: "",
  status: "active",
  localPaths: [{ path: repoPath, kind: "repo", match: "prefix" }],
  worktreeRoot: join(tmp, "wt-root"),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const mergeUpdates: Array<{ worktreeId: string; phase: string }> = [];
const recordMergeUpdate = (msg: ServerMessage) => {
  if (msg.type === "worktreeMergeUpdate")
    mergeUpdates.push({ worktreeId: msg.worktreeId, phase: msg.phase });
};
setWorktreeBroadcaster({
  broadcast: recordMergeUpdate,
  broadcastWorktree: (_id, msg) => recordMergeUpdate(msg),
});

test("squash merge lands the branch work as one commit on main", async () => {
  const record = await createWorktree({
    projectId: "mg-proj",
    name: "squashme",
  });
  writeFileSync(join(record.path, "feature.txt"), "feature\n");
  sh(record.path, "add", "-A");
  sh(record.path, "commit", "-m", "add feature");
  writeFileSync(join(record.path, "feature.txt"), "feature v2\n");
  sh(record.path, "commit", "-am", "tweak feature");
  const root = await addWorktreeComment({
    worktreeId: mainWorktreeId("mg-proj"),
    body: "review the branch before merge",
    author: { kind: "user" },
    anchor: {
      path: "feature.txt",
      side: "new",
      line: 1,
      ref: record.branch,
    },
  });
  const reply = await addWorktreeComment({
    worktreeId: mainWorktreeId("mg-proj"),
    parentId: root.id,
    body: "reply purges with root",
    author: { kind: "user" },
  });
  assert.equal(getComment(root.id)?.ownerWorktreeId, record.id);

  await mergeWorktree(record.id, "squash");
  assert.equal(mergePhase(record.id), "done");
  // One squashed commit on main containing the file.
  assert.match(sh(repoPath, "log", "--oneline", "-1"), /./);
  assert.equal(sh(repoPath, "show", "HEAD:feature.txt"), "feature v2\n");
  assert.equal(getComment(root.id), undefined);
  assert.equal(getComment(reply.id), undefined);
  // git cherry sees the squashed patch as contained.
  assert.equal(await hasUnmergedCommits(getWorktree(record.id)!), false);
});

test("a second merge request is refused while the first waits for the repository lock", async () => {
  const record = await createWorktree({
    projectId: "mg-proj",
    name: "single-merge-request",
  });
  writeFileSync(join(record.path, "single.txt"), "one merge\n");
  sh(record.path, "add", "single.txt");
  sh(record.path, "commit", "-m", "single merge work");

  let releaseLock!: () => void;
  let markLocked!: () => void;
  const locked = new Promise<void>((resolve) => {
    markLocked = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const lock = withRepoLock(await repoLockKey(repoPath), async () => {
    markLocked();
    await hold;
  });
  await locked;

  const first = mergeWorktree(record.id, "squash");
  try {
    await assert.rejects(
      () => mergeWorktree(record.id, "squash"),
      /merge is already in progress/,
    );
  } finally {
    releaseLock();
    await lock;
  }
  await first;
  assert.equal(mergePhase(record.id), "done");
  assert.equal(sh(repoPath, "show", "HEAD:single.txt"), "one merge\n");
});

test("boot reconciliation purges a branch subject whose merge completed across restart", async () => {
  const record = await createWorktree({
    projectId: "mg-proj",
    name: "reconciled-merge",
  });
  writeFileSync(join(record.path, "reconciled.txt"), "reconciled\n");
  sh(record.path, "add", "reconciled.txt");
  sh(record.path, "commit", "-m", "reconciled branch commit");
  const state = {
    strategy: "merge",
    phase: "conflicts",
    startedAt: Date.now(),
  };
  updateWorktree(record.id, { mergeStateJson: JSON.stringify(state) });
  const comment = await addWorktreeComment({
    worktreeId: mainWorktreeId("mg-proj"),
    body: "captured during interrupted merge",
    author: { kind: "user" },
    anchor: { path: "readme.md", side: "new", line: 1 },
  });
  assert.equal(getComment(comment.id)?.ownerSource, "merge-in-flight");

  sh(repoPath, "merge", "--no-ff", record.branch, "-m", "manual completion");
  await reconcileWorktreeMergesOnBoot();
  assert.equal(mergePhase(record.id), "done");
  assert.equal(getComment(comment.id), undefined);
});

test("merge refused while the main checkout is not on the base branch", async () => {
  const record = await createWorktree({
    projectId: "mg-proj",
    name: "wrongbase",
  });
  writeFileSync(join(record.path, "wb.txt"), "x\n");
  sh(record.path, "add", "-A");
  sh(record.path, "commit", "-m", "work");

  sh(repoPath, "checkout", "-b", "elsewhere");
  try {
    await assert.rejects(
      () => mergeWorktree(record.id, "squash"),
      /not "main"/,
    );
  } finally {
    sh(repoPath, "checkout", "main");
    sh(repoPath, "branch", "-D", "elsewhere");
  }
});

test("merge preconditions: dirty worktree refused; conflicts land in conflicts phase", async () => {
  const record = await createWorktree({
    projectId: "mg-proj",
    name: "conflictme",
  });

  // Dirty guard.
  writeFileSync(join(record.path, "readme.md"), "dirty\n");
  await assert.rejects(
    () => mergeWorktree(record.id, "merge"),
    /uncommitted changes/i,
  );
  sh(record.path, "checkout", "--", "readme.md");

  // Conflicting edits on both sides of the same line.
  writeFileSync(join(record.path, "readme.md"), "worktree version\n");
  sh(record.path, "commit", "-am", "worktree edit");
  writeFileSync(join(repoPath, "readme.md"), "main version\n");
  sh(repoPath, "commit", "-am", "main edit");

  mergeUpdates.length = 0;
  await mergeWorktree(record.id, "merge");
  // No merge-agent model is available in tests → the merge must stay in
  // "conflicts" (never "done"/"failed"), with the conflict recorded.
  const phase = mergePhase(record.id);
  assert.equal(phase, "conflicts");
  assert.ok(
    mergeUpdates.some(
      (update) =>
        update.worktreeId === record.id && update.phase === "conflicts",
    ),
  );
  // The conflicted merge is in progress in the main checkout.
  assert.match(sh(repoPath, "status"), /Unmerged paths|fix conflicts/i);
  sh(repoPath, "merge", "--abort");
});
