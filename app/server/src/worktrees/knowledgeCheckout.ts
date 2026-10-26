/**
 * The Knowledge Base folder, read as a checkout by the worktree FILE surfaces —
 * tree, file, raw bytes, History, uncommitted Changes and Commit — so the KB
 * browser is the worktree file browser rather than a second one.
 *
 * Deliberately NOT part of {@link resolveWorktreeRow}: session placement,
 * spawning, agent worktree tools, comments and delivery resolve worktree ids
 * through that, and none of them may ever act on the KB. Only the surfaces
 * that call {@link resolveReadableWorktreeRow} see it.
 *
 * The KB is a server repository even where those surfaces browse and commit
 * it as a checkout, so its row runs its git and reads on the server, by kind:
 * {@link checkoutSideOf}.
 */
import { KNOWLEDGE_WORKTREE_ID } from "@assistant/shared";
import type { WorktreeRow } from "../db/worktreeStore.ts";
import { gitOptional } from "../serverRepoGit.ts";
import { KnowledgeBaseStore } from "../knowledgeBaseStore.ts";
import { knowledgeBaseEnabled } from "../knowledgeBaseSettings.ts";
import {
  DEFAULT_WORKER_SIDE,
  type CheckoutSide,
} from "../workers/placement.ts";
import { resolveWorktreeRow } from "./worktreeResolve.ts";

/**
 * Where a row's checkout git and reads run: the server for the Knowledge Base
 * row, the default Worker for every other. By the row's kind, never its path:
 * a project or worktree inside the KB root or `DATA_DIR` is a checkout. DB ids
 * are uuids and synthetic mains `main:<projectId>`, so no other row has the
 * KB's id, and `{...row, path}` spreads keep it.
 */
export function checkoutSideOf(row: Pick<WorktreeRow, "id">): CheckoutSide {
  return row.id === KNOWLEDGE_WORKTREE_ID ? "server" : DEFAULT_WORKER_SIDE;
}

/**
 * The KB checkout's row: like a project's main checkout, its own branch is its
 * base, so nothing is ever "ahead" and Changes are exactly the uncommitted
 * edits.
 */
async function resolveKnowledgeCheckoutRow(): Promise<WorktreeRow | undefined> {
  // Off, the checkout does not exist: its routes answer 404.
  if (!knowledgeBaseEnabled()) return undefined;
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
