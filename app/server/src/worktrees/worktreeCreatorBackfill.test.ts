/**
 * The one-time creator backfill: which log evidence names a creator, how a
 * fork's copied history is told apart from the original, and that it runs once.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "worktree-creator-backfill-"));
process.env.ASSISTANT_CWD = tmp;
process.env.ASSISTANT_BACKGROUND_FETCH = "0";

const { backfillWorktreeCreators, scanLogForCreatedWorktrees } =
  await import("./worktreeCreatorBackfill.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const {
  creatorSessionIdForWorktree,
  insertWorktree,
  recordWorktreeCreator,
  worktreeCreatorBackfillDone,
} = await import("../db/worktreeStore.ts");

const logs = join(tmp, "logs");
mkdirSync(logs, { recursive: true });
const logPath = (sessionId: string) => join(logs, `${sessionId}.jsonl`);

function writeLog(sessionId: string, entries: unknown[]): void {
  writeFileSync(
    logPath(sessionId),
    [{ v: 1, sessionId }, ...entries]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
}

function createCall(toolCallId: string, name = "worktree_create") {
  return {
    type: "message",
    role: "assistant",
    content: [
      { type: "text", text: "Creating a worktree." },
      { type: "toolCall", toolCallId, name, input: { name: "x" } },
    ],
  };
}

function result(toolCallId: string, row: { id: string; path: string }) {
  return {
    type: "message",
    role: "toolResult",
    toolCallId,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { id: row.id, path: row.path, projectId: "proj", branch: "b" },
          null,
          2,
        ),
      },
    ],
  };
}

function row(id: string, createdAt: number) {
  const value = {
    id,
    projectId: "proj",
    mainRepoRoot: join(tmp, "main"),
    path: join(tmp, `wt-${id}`),
    branch: `branch-${id}`,
    baseBranch: "main",
    baseCommit: "0".repeat(40),
    status: "active" as const,
    mergeStateJson: null,
    branchCleanupOid: null,
    createdAt,
    updatedAt: createdAt,
    removedAt: null,
  };
  insertWorktree(value);
  return value;
}

function session(id: string, createdAt: number, updatedAt = 10_000) {
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "developer",
    createdAt,
    updatedAt,
  });
}

test("scanLogForCreatedWorktrees pairs worktree_create calls with their results only", async () => {
  const a = { id: "scan-a", path: "/w/a" };
  const b = { id: "scan-b", path: "/w/b" };
  writeLog("scan", [
    createCall("call-a"),
    // Another tool's result naming a worktree is not a claim.
    {
      type: "message",
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "status", name: "x" }],
    },
    result("status", { id: "listed", path: "/w/listed" }),
    result("call-a", a),
    createCall("call-b", "mcp__pa__worktree_create"),
    // A failed call's error text is not JSON.
    createCall("call-err"),
    {
      type: "message",
      role: "toolResult",
      toolCallId: "call-err",
      content: [{ type: "text", text: "Unknown project: nope" }],
    },
    result("call-b", b),
    // A result repeated after its call was paired is not a second claim.
    result("call-a", a),
  ]);
  assert.deepEqual(await scanLogForCreatedWorktrees(logPath("scan")), [
    { worktreeId: "scan-a", path: "/w/a", projectId: "proj" },
    { worktreeId: "scan-b", path: "/w/b", projectId: "proj" },
  ]);
});

test("backfillWorktreeCreators links the session that existed at creation, once", async () => {
  const plain = row("plain", 1_000);
  const forked = row("forked", 2_000);
  const mismatched = row("mismatched", 3_000);
  const kept = row("kept", 4_000);
  row("orphan", 5_000);
  const twin = row("twin", 6_000);

  session("coord", 500);
  // Forked from the coordinator after `forked` existed: its log copies the
  // call and result, but it is not the creator.
  session("fork", 2_500);
  session("liar", 900);
  session("prior", 100);
  session("late-claimant", 3_900);
  recordWorktreeCreator("prior", kept.id);
  // Two sessions that both existed before `twin` both claim it: no answer.
  session("twin-a", 5_500);
  session("twin-b", 5_600);

  writeLog("coord", [
    createCall("c1"),
    result("c1", plain),
    createCall("c2"),
    result("c2", forked),
  ]);
  writeLog("fork", [createCall("c2"), result("c2", forked)]);
  // Names a candidate's id with another path: not that worktree.
  writeLog("liar", [
    createCall("l1"),
    result("l1", { id: mismatched.id, path: "/elsewhere" }),
  ]);
  writeLog("late-claimant", [createCall("k1"), result("k1", kept)]);
  writeLog("twin-a", [createCall("t1"), result("t1", twin)]);
  writeLog("twin-b", [createCall("t2"), result("t2", twin)]);

  const summary = await backfillWorktreeCreators({ logPath });
  assert.ok(summary);
  assert.equal(summary.candidates, 5, "every creator-less row, not `kept`");
  assert.equal(summary.linked, 2);
  assert.equal(summary.ambiguous, 1);
  assert.equal(creatorSessionIdForWorktree(twin.id), undefined);
  assert.equal(creatorSessionIdForWorktree(plain.id), "coord");
  assert.equal(creatorSessionIdForWorktree(forked.id), "coord");
  assert.equal(creatorSessionIdForWorktree(mismatched.id), undefined);
  assert.equal(creatorSessionIdForWorktree("orphan"), undefined);
  assert.equal(creatorSessionIdForWorktree(kept.id), "prior");
  assert.equal(worktreeCreatorBackfillDone(), true);

  // Recorded as done: a second start reads nothing.
  writeLog("liar", [
    createCall("l2"),
    result("l2", { id: mismatched.id, path: mismatched.path }),
  ]);
  assert.equal(await backfillWorktreeCreators({ logPath }), undefined);
  assert.equal(creatorSessionIdForWorktree(mismatched.id), undefined);
});
