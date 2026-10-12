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

const { idleWorktrees, idleWorktreeKind } = await import("./idleWorktrees.ts");
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
  assert.deepEqual(idleWorktreeKind(status()), { kind: "delivered" });
  // Merged upstream by squash, local base not fetched yet: still delivered.
  assert.deepEqual(idleWorktreeKind(status({ ahead: 4 }), true), {
    kind: "delivered",
  });
  // A dirty tree is uncommitted whatever its pull request did.
  assert.equal(
    idleWorktreeKind(status({ dirty: true, filesChanged: 1 }), true).kind,
    "uncommitted",
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
  const idle = await idleWorktrees({
    exists: (path) => !path.endsWith("vanished"),
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
  const after = await idleWorktrees({
    exists: () => true,
    status: async () => {
      throw new Error("git failed");
    },
  });
  assert.deepEqual(
    after.find((item) => item.worktree.id === "handed")?.kind,
    "unknown",
  );
});
