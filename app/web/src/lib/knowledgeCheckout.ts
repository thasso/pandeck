import {
  KNOWLEDGE_WORKTREE_ID,
  type WorktreeGitStatus,
  type WorktreeRecord,
} from "@assistant/shared";

/**
 * The Knowledge Base folder as the worktree page reads it: the checkout
 * `knowledge`, which the server serves through the worktree file routes. It is
 * never in the worktree registry, so the record is built here. Like a
 * project's main checkout its own branch is its base (`isMain`), so the page
 * offers files, History and uncommitted Changes and no "vs base".
 */
export function knowledgeCheckoutRecord(
  status: WorktreeGitStatus | undefined,
): WorktreeRecord {
  const branch = status?.branch ?? "main";
  return {
    id: KNOWLEDGE_WORKTREE_ID,
    projectId: "",
    isMain: true,
    mainRepoRoot: "",
    path: "",
    branch,
    baseBranch: branch,
    baseCommit: status?.head ?? "",
    status: "active",
    sessionIds: [],
    taskIds: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

/** Files with uncommitted edits in the Knowledge Base, for the section badge. */
export function knowledgeUncommittedCount(
  status: WorktreeGitStatus | undefined,
): number {
  return status ? status.filesChanged + status.untracked : 0;
}
