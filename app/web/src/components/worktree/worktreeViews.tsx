import { FolderTree, GitCompareArrows, LayoutDashboard } from "lucide-react";
import type { ReactNode } from "react";
import type { WorktreeView } from "../../hooks/useSessionRouting.ts";

/**
 * A worktree page's views, as icons: the phone's dock row and the wide
 * header's group switch between them, in place of a row of tabs. Kept out of
 * the lazy page module so the app shell's dock can draw them.
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
  { id: "files", label: "Files", icon: (size) => <FolderTree size={size} /> },
];
