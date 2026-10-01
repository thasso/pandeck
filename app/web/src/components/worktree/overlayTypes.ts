/**
 * Narrow prop types for the worktree overlays, so the lazy overlay chunk does
 * not depend on the full UIState shape.
 */
import type {
  AppSettings,
  ProjectRecord,
  WorktreeGitStatus,
  WorktreeMergePhase,
  WorktreeRecord,
} from "@assistant/shared";

export type { ProjectRecord };

export interface UIStateWorktreeSlice {
  worktrees: WorktreeRecord[] | null;
  worktreeStatuses: Record<string, WorktreeGitStatus>;
  worktreeNameProposal: { requestId: string; name: string } | null;
  worktreeMerge: Record<
    string,
    {
      phase: WorktreeMergePhase;
      message?: string;
      conflictPaths?: string[];
      agentSessionId?: string;
    }
  >;
  settings: AppSettings;
}
