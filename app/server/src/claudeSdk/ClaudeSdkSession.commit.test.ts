/**
 * Standalone test for {@link ClaudeSdkSession}'s synthetic-tool / commit-card
 * rendering (the surface `runCommitForHost` drives for `/commit`).
 *
 * Run through Vitest: `pnpm --filter @assistant/server test src/claudeSdk/ClaudeSdkSession.commit.test.ts`
 *
 * Asserts that begin → finishSyntheticCommit emits assistantStart → toolStart →
 * commitResult → assistantEnd (all sharing one id), the snapshot has exactly ONE
 * assistant turn with a single `commit` block (no duplicate), and the record
 * persists it. (No `history` envelope: on the runtime path the durable commit
 * card converges via the adapter's hostCommandResult, not an engine broadcast.)
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { CommitDisplay, ServerMessage } from "@assistant/shared";
import { entriesToDisplayMessages } from "@assistant/shared/display";
import { ClaudeSdkSession } from "./ClaudeSdkSession.ts";
import type { ClaudeSdkSeam } from "./sdkSeam.ts";

const seam: ClaudeSdkSeam = {
  query() {
    return { async *[Symbol.asyncIterator]() {} };
  },
};

function fakeCommit(): CommitDisplay {
  return {
    status: "committed",
    commitHash: "abc1234",
    commitMessage: "feat: do the thing",
    files: [],
    totals: { files: 1, additions: 2, deletions: 0 },
    blockers: [],
    warnings: [],
    addressedTasks: [],
  } as unknown as CommitDisplay;
}

function main(): void {
  const session = new ClaudeSdkSession("commit-test", {
    seam: () => Promise.resolve(seam),
  });
  const envelopes: ServerMessage[] = [];
  session.addViewer({ send: (m) => envelopes.push(m) });

  const { assistantId, toolId } = session.beginSyntheticTool("/commit", {
    command: "/commit",
    rawArgs: "",
  });
  session.updateSyntheticTool("Generating commit message…");
  session.finishSyntheticCommit(fakeCommit());

  const types = envelopes.map((e) => e.type);
  assert.ok(
    types.includes("assistantStart"),
    `assistantStart present: ${types.join(",")}`,
  );
  assert.ok(types.includes("toolStart"), "toolStart present");
  assert.ok(types.includes("commitResult"), "commitResult present");
  assert.ok(types.includes("assistantEnd"), "assistantEnd present");

  // Every turn envelope shares the synthetic assistant id.
  for (const e of envelopes) {
    if (
      e.type === "assistantStart" ||
      e.type === "toolStart" ||
      e.type === "commitResult" ||
      e.type === "assistantEnd"
    ) {
      assert.equal(
        (e as { id: string }).id,
        assistantId,
        `${e.type} id mismatch`,
      );
    }
  }

  const commitEnv = envelopes.find(
    (e): e is Extract<ServerMessage, { type: "commitResult" }> =>
      e.type === "commitResult",
  );
  assert.ok(
    commitEnv && commitEnv.commit.commitHash === "abc1234",
    "commitResult carries the commit",
  );

  // Snapshot: exactly one assistant turn, one commit block (no duplicate).
  const snapshot = session.snapshot();
  const commitMessages = snapshot.filter(
    (m) => m.role === "assistant" && m.blocks.some((b) => b.kind === "commit"),
  );
  assert.equal(
    commitMessages.length,
    1,
    `expected 1 commit turn, got ${commitMessages.length}`,
  );
  assert.equal(
    commitMessages[0]!.blocks.length,
    1,
    "commit turn has a single block",
  );
  assert.equal(
    commitMessages[0]!.blocks[0]!.kind,
    "commit",
    "block is a commit card",
  );

  // Not running after finish; persisted record keeps the commit card as a normalized timeline entry.
  assert.equal(session.isRunning, false, "not running after commit");
  const record = session.toRecord();
  const recCommits = entriesToDisplayMessages(record.entries)
    .flatMap((m) => m.blocks)
    .filter((b) => b.kind === "commit");
  assert.equal(
    recCommits.length,
    1,
    `record persists 1 commit block, got ${recCommits.length}`,
  );

  assert.ok(toolId.startsWith("slash-"), "toolId looks synthetic");
  console.log("ClaudeSdkSession synthetic-commit test: PASS");
}

test("renders synthetic commit cards once", () => {
  main();
});
