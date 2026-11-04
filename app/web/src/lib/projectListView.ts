/**
 * The Projects browser's grouping and filters, browser-local like the other
 * lists': the bar above the tree writes them (`ProjectListToolbar`), the tree
 * reads them (`ProjectTreePane`).
 */
export type ProjectGroupBy = "hierarchy" | "activity" | "recent" | "name";
export type ProjectWorktreeFilter = "all" | "changes" | "pull-requests";

export interface ProjectListView {
  groupBy: ProjectGroupBy;
  /** Show only this project and its subprojects; null shows every one. */
  projectId: string | null;
  showArchived: boolean;
  worktrees: ProjectWorktreeFilter;
}

export const PROJECT_GROUP_BYS: readonly ProjectGroupBy[] = [
  "hierarchy",
  "activity",
  "recent",
  "name",
];

export function normalizeProjectGroupBy(value: unknown): ProjectGroupBy {
  return PROJECT_GROUP_BYS.includes(value as ProjectGroupBy)
    ? (value as ProjectGroupBy)
    : "hierarchy";
}

/** How many filters narrow the list: the bar's badge. */
export function projectFilterCount(view: ProjectListView): number {
  return (
    Number(view.projectId !== null) +
    Number(view.showArchived) +
    Number(view.worktrees !== "all")
  );
}

/** What the filters and the Activity grouping read off one worktree. */
export interface ProjectWorktreeFacts {
  /** Uncommitted, or commits ahead of its base. */
  changed: boolean;
  /** An open pull request. */
  pullRequest: boolean;
  /** When its git state last changed, where a change has been witnessed. */
  changedAt?: number | undefined;
}
