import { GitCompareArrows, LayoutDashboard } from "lucide-react";
import type { ReactNode } from "react";
import {
  worktreePath,
  type WorktreeView,
} from "../../hooks/useSessionRouting.ts";
import { currentDocumentOrigin } from "../../lib/historyNav.ts";

/**
 * A worktree page's views, as icons: the phone's dock row and the wide
 * header's group switch between them, in place of a row of tabs. Kept out of
 * the lazy page module so the app shell's dock can draw them.
 *
 * Files is not one of them: a file opens from the sidebar's tree (a phone's
 * header Browse sheet), and the Files view is where it is shown.
 */
export const WORKTREE_VIEWS: ReadonlyArray<{
  id: WorktreeView;
  label: string;
  icon: (size: number) => ReactNode;
}> = [
  {
    id: "overview",
    label: "Overview",
    icon: (size) => <LayoutDashboard size={size} />,
  },
  {
    id: "changes",
    label: "Review",
    icon: (size) => <GitCompareArrows size={size} />,
  },
];

/**
 * Whether the open worktree file came from OUTSIDE this worktree — a chat's
 * link, another page — so Close has somewhere to return to. A file picked in
 * the sidebar or within the worktree has none: it is where you already are.
 */
export function openedFromOutsideWorktree(worktreeId: string): boolean {
  const origin = currentDocumentOrigin();
  return Boolean(origin && !origin.href.startsWith(worktreePath(worktreeId)));
}
