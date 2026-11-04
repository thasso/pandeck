import { worktreePath } from "../../hooks/useSessionRouting.ts";
import { currentDocumentOrigin } from "../../lib/historyNav.ts";

/**
 * Whether the open worktree file came from OUTSIDE this worktree — a chat's
 * link, another page — so Close has somewhere to return to. A file picked in
 * the sidebar or within the worktree has none: it is where you already are.
 */
export function openedFromOutsideWorktree(worktreeId: string): boolean {
  const origin = currentDocumentOrigin();
  return Boolean(origin && !origin.href.startsWith(worktreePath(worktreeId)));
}
