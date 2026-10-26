/**
 * A row's checkout side comes from what the row is, never from where it is:
 * only the Knowledge Base row is server-side (`docs/workers.md`).
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { KNOWLEDGE_WORKTREE_ID } from "@assistant/shared";
import { DATA_DIR } from "../config.ts";
import type { WorktreeRow } from "../db/worktreeStore.ts";
import { knowledgeBaseRoot } from "../knowledgeBaseSettings.ts";
import { checkoutSideOf } from "./knowledgeCheckout.ts";
import { mainWorktreeId } from "./worktreeResolve.ts";

function rowOf(id: string, path: string): WorktreeRow {
  return {
    id,
    projectId: "project-1",
    path,
    mainRepoRoot: path,
    branch: "main",
    baseBranch: "main",
    baseCommit: "",
    status: "active",
    mergeStateJson: null,
    branchCleanupOid: null,
    createdAt: 1,
    updatedAt: 1,
    removedAt: null,
  };
}

test("the Knowledge Base row is server-side, also when spread to another path", () => {
  const kb = rowOf(KNOWLEDGE_WORKTREE_ID, knowledgeBaseRoot());
  assert.equal(checkoutSideOf(kb), "server");
  const spread: WorktreeRow = { ...kb, path: "/elsewhere" };
  assert.equal(checkoutSideOf(spread), "server");
});

test("every other row is on the default Worker, wherever its path is", () => {
  const kbRoot = knowledgeBaseRoot();
  for (const path of [
    kbRoot,
    join(kbRoot, "nested"),
    DATA_DIR,
    join(DATA_DIR, "projects", "inside"),
    "/srv/checkout",
  ])
    for (const id of [
      "4f1c2b9e-5d8a-4e7b-9c3f-2a1b0c9d8e7f",
      mainWorktreeId("project-1"),
    ]) {
      const row = rowOf(id, path);
      assert.deepEqual(checkoutSideOf(row), { workerId: "local" }, path);
      const spread: WorktreeRow = { ...row, path: row.mainRepoRoot };
      assert.deepEqual(checkoutSideOf(spread), { workerId: "local" }, path);
    }
});
