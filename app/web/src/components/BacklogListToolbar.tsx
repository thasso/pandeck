import { memo, useCallback, useMemo } from "react";
import type { TaskStatus } from "@assistant/shared";
import type { BacklogState } from "../hooks/useBacklog.ts";
import type { Prefs } from "../hooks/usePrefs.ts";
import { hasInboxWork } from "../lib/backlogInbox.ts";
import type {
  BacklogDensity,
  BacklogProjectFilter,
  BacklogView,
  BacklogViewMode,
} from "../lib/backlogTreeModel.ts";
import { buildProjectsById } from "../lib/projectDisplay.ts";
import { buildBacklogProjectFilterOptions } from "./BacklogFilters.tsx";
import { BacklogToolbar } from "./BacklogToolbar.tsx";

/**
 * @component BacklogListToolbar
 * @purpose The Backlog's view and filters, read from and written to the
 * browser-local prefs the list itself reads, so whoever draws it — the list,
 * or a host keeping it above its scroll container (`Sidebar.tsx`) — shows and
 * changes the same setup.
 * @intent Derives only what the toolbar states — the project filter's options
 * and whether anything waits in the Inbox — from the task and project lists
 * it is handed. Memoized on its props: a host passes the same narrow
 * `BacklogState` slice and stable `onUpdatePrefs` it hands the list.
 */
export const BacklogListToolbar = memo(function BacklogListToolbar({
  state,
  prefs,
  onUpdatePrefs,
  density,
  fixedProjectId,
  bar = false,
}: {
  state: BacklogState;
  prefs: Prefs;
  onUpdatePrefs: (patch: Partial<Prefs>) => void;
  density: BacklogDensity;
  /** A list scoped to one project: its filter is pinned, its views hidden. */
  fixedProjectId?: string | undefined;
  /** Drawn as the host's header bar (see `BacklogToolbar`). */
  bar?: boolean;
}) {
  const items = useMemo(() => state.taskList?.items ?? [], [state.taskList]);
  const projects = useMemo(
    () => state.projectList?.projects ?? [],
    [state.projectList],
  );
  const activeProjects = useMemo(
    () => projects.filter((project) => project.status !== "archived"),
    [projects],
  );
  const projectsById = useMemo(() => buildProjectsById(projects), [projects]);
  // Sorted by label, so the server's order serves as well as the list's.
  const projectFilterOptions = useMemo(
    () => buildBacklogProjectFilterOptions(items, activeProjects, projectsById),
    [items, activeProjects, projectsById],
  );
  // The WHOLE list, not the filtered one: work waiting under a project filter
  // you happen to have on is still waiting.
  const inboxWaiting = useMemo(() => hasInboxWork(items), [items]);
  const statuses = useMemo(
    () => new Set(prefs.backlogStatusFilter),
    [prefs.backlogStatusFilter],
  );

  const setView = useCallback(
    (next: BacklogView) => onUpdatePrefs({ backlogView: next }),
    [onUpdatePrefs],
  );
  const setViewMode = useCallback(
    (mode: BacklogViewMode) => onUpdatePrefs({ backlogViewMode: mode }),
    [onUpdatePrefs],
  );
  const setProjectFilter = useCallback(
    (filter: BacklogProjectFilter) =>
      onUpdatePrefs({ backlogProjectFilter: filter }),
    [onUpdatePrefs],
  );
  const setStatusFilter = useCallback(
    (next: TaskStatus[]) => onUpdatePrefs({ backlogStatusFilter: next }),
    [onUpdatePrefs],
  );

  // A list scoped to one project is a picker, not the Backlog: that project's
  // tree, no view switcher, never Focus.
  const fixedFilter: BacklogProjectFilter | null = fixedProjectId
    ? { kind: "project", projectId: fixedProjectId }
    : null;
  return (
    <BacklogToolbar
      density={density}
      view={fixedFilter ? "backlog" : prefs.backlogView}
      onViewChange={setView}
      viewMode={fixedFilter ? "normal" : prefs.backlogViewMode}
      onViewModeChange={setViewMode}
      projectFilter={fixedFilter ?? prefs.backlogProjectFilter}
      projectFilterOptions={projectFilterOptions}
      projectsById={projectsById}
      projectsLoaded={state.projectList !== null}
      onProjectFilterChange={setProjectFilter}
      statuses={statuses}
      onStatusFilterChange={setStatusFilter}
      inboxWaiting={inboxWaiting}
      hideProjectControls={Boolean(fixedFilter)}
      bar={bar}
    />
  );
});
