import { memo, useCallback, useEffect, useMemo } from "react";
import { Ban, ChevronRight, CirclePause, FolderKanban, Waypoints } from "lucide-react";
import type { InitiativeSummary, ProjectRecord, WorktreeGitStatus, WorktreeRecord } from "@assistant/shared";
import type { WorktreeHostingMap } from "../../lib/worktreeHosting.ts";
import { compareWorktrees, WorktreeList } from "../worktreeRowParts.tsx";

import type { InitiativeRead } from "../../hooks/useAssistant.ts";
import { decodeBoolean, useSessionStorageState } from "../../hooks/useSessionStorageState.ts";
import { dataOf, errorOf, type LoadState } from "../../lib/loadState.ts";
import { projectColor } from "../../lib/projectDisplay.ts";
import type { RowDensity } from "../../lib/rowDensity.ts";
import { followRowLink } from "../../lib/rowLink.ts";
import { initiativePath, projectPath } from "../../hooks/useSessionRouting.ts";
import { ListRow } from "../common/ListRow.tsx";
import { EmptyBox, ErrorNote, RefreshIndicator, Skeleton } from "../common/load.tsx";
import { Badge } from "../ui/badge.tsx";
import { Progress } from "../ui/progress.tsx";

export interface InitiativeBrowserWorktrees {
  items: readonly WorktreeRecord[] | null;
  fresh: boolean;
  statuses: Record<string, WorktreeGitStatus>;
  hosting: WorktreeHostingMap;
  selectedId: string | null | undefined;
  onOpen: (id: string) => void;
  onVisible: (initiativeId: string, ids: string[]) => void;
}

interface Props {
  initiative: InitiativeSummary;
  detailState: LoadState<InitiativeRead | null> | undefined;
  projects: readonly ProjectRecord[];
  selected: boolean;
  selectedProjectId: string | null | undefined;
  density: RowDensity;
  progressCountChars: number;
  worktrees: InitiativeBrowserWorktrees | undefined;
  onLoadDetail: ((id: string, collapsed?: readonly string[]) => void) | undefined;
  onNavigate: (path: string) => void;
}

const PROJECT_INDENT = { paddingLeft: "0.75rem" };

function decodeExpandedProjects(raw: string): string[] | null {
  const value: unknown = JSON.parse(raw);
  return Array.isArray(value) && value.every((id) => typeof id === "string") ? value : null;
}

/** The Initiative's scoped browser, not the urgency-oriented Attention card. */
export const InitiativeBrowserRow = memo(function InitiativeBrowserRow({
  initiative,
  detailState,
  projects,
  selected,
  selectedProjectId,
  density,
  progressCountChars,
  worktrees,
  onLoadDetail,
  onNavigate,
}: Props) {
  const [storedExpanded, setExpanded] = useSessionStorageState(
    `assistant.initiativeBrowser.expanded.v1:${initiative.id}`,
    false,
    decodeBoolean,
  );
  const [expandedProjects, setExpandedProjects] = useSessionStorageState<string[]>(
    `assistant.initiativeBrowser.projects.v1:${initiative.id}`,
    [],
    decodeExpandedProjects,
  );
  const expanded = storedExpanded && Boolean(onLoadDetail);
  const read = detailState ? dataOf(detailState) : undefined;
  const error = detailState ? errorOf(detailState) : undefined;
  const status = detailState?.status ?? "idle";
  const href = initiativePath(initiative.id);
  const { progress } = initiative;
  const showContext = initiative.state === "paused" || progress.blocked > 0;

  const load = useCallback(() => {
    // Preserve a map page's layout choice when reusing its keyed graph read.
    onLoadDetail?.(initiative.id, read?.requestedCollapsed);
  }, [initiative.id, onLoadDetail, read?.requestedCollapsed]);

  useEffect(() => {
    if (!expanded) return;
    // The selected Initiative's page owns refreshes of its map read. Other
    // open browsers re-read stale graphs; the action deduplicates in-flight reads.
    if (status === "idle" || (!selected && (status === "loading" || status === "refreshing")))
      load();
  }, [expanded, selected, status, detailState, load]);

  const groups = useMemo(() => {
    if (!read) return [];
    const byProject = new Map<string | undefined, { total: number; done: number; taskIds: Set<string> }>();
    for (const node of read.item.nodes) {
      const group = byProject.get(node.projectId) ?? { total: 0, done: 0, taskIds: new Set<string>() };
      group.total += 1;
      if (node.status === "done") group.done += 1;
      group.taskIds.add(node.id);
      byProject.set(node.projectId, group);
    }
    const registry = new Map(projects.map((project, index) => [project.id, { project, index }]));
    return Array.from(byProject, ([id, counts]) => ({
      id,
      ...counts,
      project: id ? registry.get(id)?.project : undefined,
      order: id ? (registry.get(id)?.index ?? projects.length) : projects.length + 1,
      worktrees: (worktrees?.items ?? []).filter((worktree) =>
        worktree.projectId === id && worktree.status !== "removed" &&
        worktree.taskIds.some((taskId) => counts.taskIds.has(taskId)),
      ).sort(compareWorktrees),
    })).sort((a, b) => a.order - b.order || (a.id ?? "").localeCompare(b.id ?? ""));
  }, [read, projects, worktrees?.items]);
  const projectCount = groups.filter((group) => group.id !== undefined).length;
  const visibleWorktreeIds = useMemo(() => expanded ? groups
    .filter((group) => expandedProjects.includes(group.id ? `project:${group.id}` : "unassigned"))
    .flatMap((group) => group.worktrees.map((worktree) => worktree.id)).sort() : [],
  [expanded, expandedProjects, groups]);
  const onVisibleWorktrees = worktrees?.onVisible;
  useEffect(() => {
    onVisibleWorktrees?.(initiative.id, visibleWorktreeIds);
  }, [onVisibleWorktrees, initiative.id, visibleWorktreeIds]);
  useEffect(() => () => onVisibleWorktrees?.(initiative.id, []), [onVisibleWorktrees, initiative.id]);

  return (
    <li className="border-b border-border/60">
      <ListRow
        interaction="content"
        divider={false}
        density={density}
        active={selected}
        data-list-row-id={`initiative:${initiative.id}`}
        onOpen={() => onNavigate(href)}
        context={showContext ? (
          <>
            {initiative.state === "paused" ? (
              <Badge variant="secondary"><CirclePause aria-hidden />Paused</Badge>
            ) : null}
            {progress.blocked > 0 ? (
              <Badge variant="warning"><Ban aria-hidden />{progress.blocked} blocked</Badge>
            ) : null}
          </>
        ) : undefined}
        identity={
          <>
            <Waypoints size={16} className="shrink-0 text-primary" aria-hidden />
            <a
              href={href}
              aria-current={selected ? "page" : undefined}
              className="min-w-0 flex-1 truncate text-sm font-medium text-foreground hover:underline"
              onClick={(event) => followRowLink(event, href, onNavigate)}
            >
              {initiative.title}
            </a>
            <span
              className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted-foreground"
              title={`${progress.done} of ${progress.total} Tasks done`}
            >
              {progress.total > 0 ? (
                <Progress
                  value={(progress.done / progress.total) * 100}
                  className={`w-10 ${progress.done === progress.total ? "[&_[data-slot=progress-indicator]]:bg-success" : ""}`}
                  aria-hidden
                />
              ) : null}
              <span className="shrink-0 whitespace-nowrap text-right" style={{ width: `${progressCountChars}ch` }}>
                {progress.total > 0 ? `${progress.done}/${progress.total}` : "0 Tasks"}
                {progress.total > 0 ? <span className="sr-only"> Tasks done</span> : null}
              </span>
            </span>
          </>
        }
        signals={onLoadDetail ? (
          <>
            <Badge
              variant="ghost"
              render={<button type="button" />}
              aria-expanded={expanded}
              aria-controls={`initiative-browser-contents:${initiative.id}`}
              aria-label={`${expanded ? "Hide" : "Show"} contents of ${initiative.title}`}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                setExpanded((open) => !open);
              }}
              className="h-auto shrink-0 cursor-pointer border-0 px-0 py-0 font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
            >
              <ChevronRight size={12} className={expanded ? "rotate-90" : ""} aria-hidden />
              Contents
            </Badge>
            {read && (expanded || status !== "refreshing") ? <span>{projectCount} Project{projectCount === 1 ? "" : "s"}</span> : null}
            {expanded && status === "refreshing" ? <RefreshIndicator label="Refreshing Initiative contents" /> : null}
          </>
        ) : undefined}
      />
      {expanded ? (
        <div id={`initiative-browser-contents:${initiative.id}`}>
          {error ? <ErrorNote className="mx-2 my-1" message={error} onRetry={load} /> : null}
          {read === undefined && !error ? (
            <div role="status" aria-label="Loading Initiative Projects" className="flex flex-col gap-2 px-5 py-2">
              <Skeleton className="h-7 w-4/5" />
              <Skeleton className="h-7 w-3/5" />
            </div>
          ) : null}
          {read === null ? (
            <div className="mx-2 my-1"><EmptyBox>This Initiative is no longer available.</EmptyBox></div>
          ) : read && groups.length === 0 ? (
            <div className="mx-2 my-1"><EmptyBox>No member Tasks yet.</EmptyBox></div>
          ) : read ? (
            <ul>
              {groups.map((group) => {
                const project = group.project;
                const title = project?.name ?? (group.id ? `Project ${group.id}` : "No Project");
                const projectHref = group.id ? projectPath(group.id) : undefined;
                const groupKey = group.id ? `project:${group.id}` : "unassigned";
                const projectExpanded = expandedProjects.includes(groupKey);
                const contentsId = `initiative:${initiative.id}:${groupKey}:contents`;
                return (
                  <li key={groupKey}>
                    <ListRow
                      interaction="content"
                      divider={false}
                      density={density}
                      active={Boolean(group.id && group.id === selectedProjectId)}
                      data-list-row-id={`initiative:${initiative.id}:project:${group.id ?? "none"}`}
                      className="border-t border-border/60"
                      style={PROJECT_INDENT}
                      onOpen={projectHref ? () => onNavigate(projectHref) : undefined}
                      identity={
                        <>
                          <FolderKanban size={16} className="shrink-0 text-muted-foreground" style={project ? { color: projectColor(project).dot } : undefined} aria-hidden />
                          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                            {projectHref ? (
                              <a href={projectHref} onClick={(event) => followRowLink(event, projectHref, onNavigate)} className="hover:underline">{title}</a>
                            ) : title}
                            {project ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">{project.key}</span> : null}
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted-foreground" title={`${group.done} of ${group.total} Initiative Tasks done in ${title}`}>
                            <Progress
                              value={(group.done / group.total) * 100}
                              className={`w-10 ${group.done === group.total ? "[&_[data-slot=progress-indicator]]:bg-success" : ""}`}
                              aria-hidden
                            />
                            <span className="shrink-0 whitespace-nowrap text-right" style={{ width: `${progressCountChars}ch` }}>
                              {group.done}/{group.total}
                              <span className="sr-only"> Initiative Tasks done</span>
                            </span>
                          </span>
                        </>
                      }
                      signals={worktrees ? (
                        <>
                          {group.worktrees.length > 0 || !worktrees.fresh || projectExpanded ? (
                            <Badge
                              variant="ghost"
                              render={<button type="button" />}
                              aria-expanded={projectExpanded}
                              aria-controls={contentsId}
                              aria-label={`${projectExpanded ? "Hide" : "Show"} Initiative contents of ${title}`}
                              onPointerDown={(event) => event.stopPropagation()}
                              onKeyDown={(event) => event.stopPropagation()}
                              onClick={(event) => {
                                event.stopPropagation();
                                setExpandedProjects((ids) => ids.includes(groupKey) ? ids.filter((id) => id !== groupKey) : [...ids, groupKey]);
                              }}
                              className="h-auto shrink-0 cursor-pointer border-0 px-0 py-0 font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
                            >
                              <ChevronRight size={12} className={projectExpanded ? "rotate-90" : ""} aria-hidden />
                              Contents
                            </Badge>
                          ) : null}
                          {group.worktrees.length > 0 ? (
                            <span>{group.worktrees.length} Worktree{group.worktrees.length === 1 ? "" : "s"}</span>
                          ) : worktrees.fresh ? <span>No linked Worktrees</span> : null}
                          {!worktrees.fresh && projectExpanded ? <RefreshIndicator label="Refreshing Worktrees" /> : null}
                        </>
                      ) : undefined}
                    />
                    {projectExpanded && worktrees ? (
                      <div id={contentsId} className="pl-6">
                        {worktrees.items === null ? (
                          <div role="status" aria-label="Loading Initiative Worktrees" className="flex flex-col gap-2 px-2 py-2">
                            <Skeleton className="h-8 w-4/5" />
                            <Skeleton className="h-8 w-3/5" />
                          </div>
                        ) : group.worktrees.length > 0 ? (
                          <WorktreeList worktrees={group.worktrees} statuses={worktrees.statuses} hosting={worktrees.hosting} selectedWorktreeId={worktrees.selectedId} onOpen={worktrees.onOpen} />
                        ) : worktrees.fresh ? (
                          <div className="mx-2 my-1"><EmptyBox>No linked Worktrees for these member Tasks.</EmptyBox></div>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </li>
  );
});
