/**
 * The Knowledge Base folder, read as a checkout by the worktree FILE surfaces —
 * tree, file, raw bytes, History, uncommitted Changes and Commit — so the KB
 * browser is the worktree file browser rather than a second one.
 *
 * Deliberately NOT part of {@link resolveWorktreeRow}: session placement,
 * spawning, agent worktree tools, comments and delivery resolve worktree ids
 * through that, and none of them may ever act on the KB. Only the surfaces
 * that call {@link resolveReadableWorktreeRow} see it.
 */
import { KNOWLEDGE_WORKTREE_ID } from "@assistant/shared";
import type { WorktreeRow } from "../db/worktreeStore.ts";
import { gitOptional } from "../gitExec.ts";
import { KnowledgeBaseStore } from "../knowledgeBaseStore.ts";
import { resolveWorktreeRow } from "./worktreeResolve.ts";

/**
 * The KB checkout's row: like a project's main checkout, its own branch is its
 * base, so nothing is ever "ahead" and Changes are exactly the uncommitted
 * edits.
 */
async function resolveKnowledgeCheckoutRow(): Promise<WorktreeRow | undefined> {
  const store = new KnowledgeBaseStore();
  await store.ensureInitialized();
  const res = await gitOptional(
    [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "HEAD",
      "--abbrev-ref",
      "HEAD",
    ],
    store.root,
  );
  if (res.code !== 0) return undefined;
  const [root, headOid, branch] = res.stdout
    .split("\n")
    .map((line) => line.trim());
  if (!root || !headOid || !branch) return undefined;
  return {
    id: KNOWLEDGE_WORKTREE_ID,
    projectId: "",
    mainRepoRoot: root,
    path: root,
    branch,
    baseBranch: branch,
    baseCommit: headOid,
    status: "active",
    mergeStateJson: null,
    branchCleanupOid: null,
    createdAt: 0,
    updatedAt: 0,
    removedAt: null,
  };
}

/** A worktree id as the file-browsing surfaces read it: the KB, else a worktree. */
export function resolveReadableWorktreeRow(
  id: string,
): Promise<WorktreeRow | undefined> {
  return id === KNOWLEDGE_WORKTREE_ID
    ? resolveKnowledgeCheckoutRow()
    : resolveWorktreeRow(id);
}
