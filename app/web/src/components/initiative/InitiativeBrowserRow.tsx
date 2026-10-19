import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import {
  ChevronRight,
  CirclePause,
  FolderKanban,
  Waypoints,
} from "lucide-react";
import type {
  InitiativeGraphNode,
  InitiativeSummary,
  ProjectRecord,
  SessionListItem,
  WorktreeGitStatus,
  WorktreeRecord,
} from "@assistant/shared";
import type { WorktreeHostingMap } from "../../lib/worktreeHosting.ts";
import { compareWorktrees, WorktreeList } from "../worktreeRowParts.tsx";

import type { InitiativeRead } from "../../hooks/useAssistant.ts";
import {
  decodeBoolean,
  useSessionStorageState,
} from "../../hooks/useSessionStorageState.ts";
import { dataOf, errorOf, type LoadState } from "../../lib/loadState.ts";
import { projectColor } from "../../lib/projectDisplay.ts";
import {
  initiativeBrowserCounts,
  type InitiativeBrowserCounts,
} from "../../lib/initiativeBrowserCounts.ts";
import { initiativeBrowserSessions } from "../../lib/initiativeBrowserSessions.ts";
import type { RowDensity } from "../../lib/rowDensity.ts";
import { followRowLink } from "../../lib/rowLink.ts";
import { initiativePath, projectPath } from "../../hooks/useSessionRouting.ts";
import { ListRow } from "../common/ListRow.tsx";
import { ListExpansionRow } from "../common/ListExpansionRow.tsx";
import { InitiativeSessionRows } from "./InitiativeSessionRows.tsx";
import {
  EmptyBox,
  ErrorNote,
  RefreshIndicator,
  Skeleton,
} from "../common/load.tsx";
import { Badge } from "../ui/badge.tsx";
import { InitiativeBrowserProgress } from "./InitiativeBrowserProgress.tsx";
import {
  InitiativeCoordinatorRows,
  type InitiativeBrowserSessions,
} from "./InitiativeCoordinatorRows.tsx";

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
  sessions: InitiativeBrowserSessions | undefined;
  onLoadDetail:
    ((id: string, collapsed?: readonly string[]) => void) | undefined;
  onNavigate: (path: string) => void;
}

const PROJECT_INDENT = { paddingLeft: "0.75rem" };
const NO_SESSION_ROWS: readonly SessionListItem[] = [];

function decodeExpandedIds(raw: string): string[] | null {
  const value: unknown = JSON.parse(raw);
  return Array.isArray(value) && value.every((id) => typeof id === "string")
    ? value
    : null;
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
  sessions,
  onLoadDetail,
  onNavigate,
}: Props) {
  const [storedExpanded, setExpanded] = useSessionStorageState(
    `assistant.initiativeBrowser.expanded.v1:${initiative.id}`,
    false,
    decodeBoolean,
  );
  const [expandedProjects, setExpandedProjects] = useSessionStorageState<
    string[]
  >(
    `assistant.initiativeBrowser.projects.v1:${initiative.id}`,
    [],
    decodeExpandedIds,
  );
  const [expandedWorktreeSessions, setExpandedWorktreeSessions] =
    useSessionStorageState<string[]>(
      `assistant.initiativeBrowser.sessions.v1:${initiative.id}`,
      [],
      decodeExpandedIds,
    );
  const [expandedOtherSessions, setExpandedOtherSessions] =
    useSessionStorageState(
      `assistant.initiativeBrowser.otherSessions.v1:${initiative.id}`,
      false,
      decodeBoolean,
    );
  // Id-addressed callbacks remain stable across sibling disclosure changes.
  const onToggleWorktreeSessions = useCallback(
    (id: string) => {
      setExpandedWorktreeSessions((ids) =>
        ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id],
      );
    },
    [setExpandedWorktreeSessions],
  );
  const sessionExpansion = useMemo(
    () => ({
      ids: expandedWorktreeSessions,
      toggle: onToggleWorktreeSessions,
      change: setExpandedWorktreeSessions,
    }),
    [
      expandedWorktreeSessions,
      onToggleWorktreeSessions,
      setExpandedWorktreeSessions,
    ],
  );
  const expanded = storedExpanded && Boolean(onLoadDetail);
  const read = detailState ? dataOf(detailState) : undefined;
  const error = detailState ? errorOf(detailState) : undefined;
  const status = detailState?.status ?? "idle";
  const href = initiativePath(initiative.id);
  const counts = useMemo(
    () => (read ? initiativeBrowserCounts(read.item.nodes) : undefined),
    [read],
  );
  // Retain only the small derived counters when the shared graph LRU evicts
  // this read. Never copy the graph or re-fetch an idle eviction in a loop.
  const heldCounts = useRef<InitiativeBrowserCounts | undefined>(undefined);
  const requestedSummary = useRef<InitiativeSummary | undefined>(undefined);
  if (counts) heldCounts.current = counts;
  const browserCounts = counts ?? heldCounts.current;

  const load = useCallback(() => {
    // Preserve a map page's layout choice when reusing its keyed graph read.
    onLoadDetail?.(initiative.id, read?.requestedCollapsed);
  }, [initiative.id, onLoadDetail, read?.requestedCollapsed]);

  useEffect(() => {
    if (!onLoadDetail) return;
    // The header now needs the member graph to partition doing/blocked and
    // archived Tasks exactly. Read once per summary even before expansion.
    if (
      !expanded &&
      status === "idle" &&
      heldCounts.current &&
      requestedSummary.current === initiative
    )
      return;
    // The selected map page still owns refreshes of its layout choice.
    if (
      status === "idle" ||
      (!selected && (status === "loading" || status === "refreshing"))
    ) {
      requestedSummary.current = initiative;
      load();
    }
  }, [expanded, selected, status, detailState, load, initiative, onLoadDetail]);

  const relations = useMemo(
    () =>
      read && sessions
        ? initiativeBrowserSessions({
            initiative,
            members: read.item.nodes,
            sessions: sessions.items,
            worktrees: worktrees?.items ?? [],
            runs: sessions.runs,
            cards: sessions.cards,
          })
        : undefined,
    [read, initiative, sessions, worktrees?.items],
  );
  const memberGroups = useMemo(() => {
    if (!read) return [];
    const byProject = new Map<
      string | undefined,
      { members: InitiativeGraphNode[]; taskIds: Set<string> }
    >();
    for (const node of read.item.nodes) {
      const group = byProject.get(node.projectId) ?? {
        members: [],
        taskIds: new Set<string>(),
      };
      group.members.push(node);
      group.taskIds.add(node.id);
      byProject.set(node.projectId, group);
    }
    const registry = new Map(
      projects.map((project, index) => [project.id, { project, index }]),
    );
    return Array.from(byProject, ([id, group]) => ({
      id,
      ...initiativeBrowserCounts(group.members),
      taskIds: group.taskIds,
      project: id ? registry.get(id)?.project : undefined,
      order: id
        ? (registry.get(id)?.index ?? projects.length)
        : projects.length + 1,
    })).sort(
      (a, b) => a.order - b.order || (a.id ?? "").localeCompare(b.id ?? ""),
    );
  }, [read, projects]);
  const groups = useMemo(
    () =>
      memberGroups.map((group) => ({
        ...group,
        worktrees: (worktrees?.items ?? [])
          .filter(
            (worktree) =>
              worktree.projectId === group.id &&
              worktree.status !== "removed" &&
              (worktree.taskIds.some((taskId) => group.taskIds.has(taskId)) ||
                relations?.byWorktree.has(worktree.id)),
          )
          .sort(compareWorktrees),
        directSessions: relations?.byProject.get(group.id) ?? NO_SESSION_ROWS,
      })),
    [memberGroups, worktrees?.items, relations],
  );
  const projectCount = groups.filter((group) => group.id !== undefined).length;
  const scopedWorktrees = useMemo(
    () => groups.flatMap((group) => group.worktrees),
    [groups],
  );
  const inProgressByWorktree = useMemo(() => {
    const tasks = new Map(
      (read?.item.nodes ?? [])
        .filter((node) => node.status === "doing" && !node.archived)
        .map((node) => [node.id, node]),
    );
    return new Map(
      (worktrees?.items ?? []).map(
        (worktree) =>
          [
            worktree.id,
            worktree.taskIds.flatMap((id) => {
              const task = tasks.get(id);
              return task ? [task] : [];
            }),
          ] as const,
      ),
    );
  }, [read, worktrees?.items]);
  const visibleWorktreeIds = useMemo(
    () =>
      expanded
        ? groups
            .filter((group) =>
              expandedProjects.includes(
                group.id ? `project:${group.id}` : "unassigned",
              ),
            )
            .flatMap((group) => group.worktrees.map((worktree) => worktree.id))
            .sort()
        : [],
    [expanded, expandedProjects, groups],
  );
  const onVisibleWorktrees = worktrees?.onVisible;
  useEffect(() => {
    onVisibleWorktrees?.(initiative.id, visibleWorktreeIds);
  }, [onVisibleWorktrees, initiative.id, visibleWorktreeIds]);
  useEffect(
    () => () => onVisibleWorktrees?.(initiative.id, []),
    [onVisibleWorktrees, initiative.id],
  );

  return (
    <li className="border-b border-border/60">
      <ListRow
        interaction="content"
        divider={false}
        density={density}
        active={selected}
        data-list-row-id={`initiative:${initiative.id}`}
        onOpen={() => onNavigate(href)}
        context={
          initiative.state === "paused" ? (
            <Badge variant="secondary">
              <CirclePause aria-hidden />
              Paused
            </Badge>
          ) : undefined
        }
        identity={
          <>
            <Waypoints
              size={16}
              className="shrink-0 text-primary"
              aria-hidden
            />
            <a
              href={href}
              aria-current={selected ? "page" : undefined}
              className="min-w-0 flex-1 truncate text-sm font-medium text-foreground hover:underline"
              onClick={(event) => followRowLink(event, href, onNavigate)}
            >
              {initiative.title}
            </a>
            <InitiativeBrowserProgress
              progress={initiative.progress}
              counts={browserCounts}
              countChars={progressCountChars}
              label={initiative.title}
              loading={Boolean(onLoadDetail) && !error && status !== "ready"}
            />
          </>
        }
        signals={
          onLoadDetail ? (
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
                <ChevronRight
                  size={12}
                  className={expanded ? "rotate-90" : ""}
                  aria-hidden
                />
                Contents
              </Badge>
              {read && (expanded || status !== "refreshing") ? (
                <span>
                  {projectCount} Project{projectCount === 1 ? "" : "s"}
                </span>
              ) : null}
              {status === "refreshing" ||
              (status === "loading" && heldCounts.current) ? (
                <RefreshIndicator label="Refreshing Initiative counts and contents" />
              ) : null}
            </>
          ) : undefined
        }
      />
      {error ? (
        <ErrorNote className="mx-2 my-1" message={error} onRetry={load} />
      ) : null}
      {expanded ? (
        <div id={`initiative-browser-contents:${initiative.id}`}>
          {read === undefined && !error ? (
            <div
              role="status"
              aria-label="Loading Initiative Projects"
              className="flex flex-col gap-2 px-5 py-2"
            >
              <Skeleton className="h-7 w-4/5" />
              <Skeleton className="h-7 w-3/5" />
            </div>
          ) : null}
          {read === null ? (
            <div className="mx-2 my-1">
              <EmptyBox>This Initiative is no longer available.</EmptyBox>
            </div>
          ) : read && groups.length === 0 ? (
            <div className="mx-2 my-1">
              <EmptyBox>No member Tasks yet.</EmptyBox>
            </div>
          ) : read ? (
            <>
              {sessions ? (
                <InitiativeCoordinatorRows
                  initiative={initiative}
                  members={read.item.nodes}
                  worktrees={scopedWorktrees}
                  sessions={sessions}
                  density={density}
                  onNavigate={onNavigate}
                />
              ) : null}
              <ul>
                {groups.map((group) => {
                  const project = group.project;
                  const title =
                    project?.name ??
                    (group.id ? `Project ${group.id}` : "No Project");
                  const projectHref = group.id
                    ? projectPath(group.id)
                    : undefined;
                  const groupKey = group.id
                    ? `project:${group.id}`
                    : "unassigned";
                  const projectExpanded = expandedProjects.includes(groupKey);
                  const contentsId = `initiative:${initiative.id}:${groupKey}:contents`;
                  const sessionCount =
                    group.directSessions.length +
                    group.worktrees.reduce(
                      (count, worktree) =>
                        count +
                        (relations?.byWorktree.get(worktree.id)?.length ?? 0),
                      0,
                    );
                  return (
                    <li key={groupKey}>
                      <ListRow
                        interaction="content"
                        divider={false}
                        density={density}
                        active={Boolean(
                          group.id && group.id === selectedProjectId,
                        )}
                        data-list-row-id={`initiative:${initiative.id}:project:${group.id ?? "none"}`}
                        className="border-t border-border/60"
                        style={PROJECT_INDENT}
                        onOpen={
                          projectHref
                            ? () => onNavigate(projectHref)
                            : undefined
                        }
                        identity={
                          <>
                            <FolderKanban
                              size={16}
                              className="shrink-0 text-muted-foreground"
                              style={
                                project
                                  ? { color: projectColor(project).dot }
                                  : undefined
                              }
                              aria-hidden
                            />
                            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                              {projectHref ? (
                                <a
                                  href={projectHref}
                                  onClick={(event) =>
                                    followRowLink(
                                      event,
                                      projectHref,
                                      onNavigate,
                                    )
                                  }
                                  className="hover:underline"
                                >
                                  {title}
                                </a>
                              ) : (
                                title
                              )}
                              {project ? (
                                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                                  {project.key}
                                </span>
                              ) : null}
                            </span>
                            <InitiativeBrowserProgress
                              progress={group}
                              counts={group}
                              countChars={progressCountChars}
                              label={`${title} Initiative Tasks`}
                            />
                          </>
                        }
                        signals={
                          worktrees || sessions ? (
                            <>
                              {group.worktrees.length > 0 ||
                              sessionCount > 0 ||
                              !worktrees?.fresh ||
                              projectExpanded ? (
                                <Badge
                                  variant="ghost"
                                  render={<button type="button" />}
                                  aria-expanded={projectExpanded}
                                  aria-controls={contentsId}
                                  aria-label={`${projectExpanded ? "Hide" : "Show"} Initiative contents of ${title}`}
                                  onPointerDown={(event) =>
                                    event.stopPropagation()
                                  }
                                  onKeyDown={(event) => event.stopPropagation()}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setExpandedProjects((ids) =>
                                      ids.includes(groupKey)
                                        ? ids.filter((id) => id !== groupKey)
                                        : [...ids, groupKey],
                                    );
                                  }}
                                  className="h-auto shrink-0 cursor-pointer border-0 px-0 py-0 font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
                                >
                                  <ChevronRight
                                    size={12}
                                    className={
                                      projectExpanded ? "rotate-90" : ""
                                    }
                                    aria-hidden
                                  />
                                  Contents
                                </Badge>
                              ) : null}
                              {group.worktrees.length > 0 ? (
                                <span>
                                  {group.worktrees.length} Worktree
                                  {group.worktrees.length === 1 ? "" : "s"}
                                </span>
                              ) : null}
                              {sessionCount > 0 ? (
                                <span>
                                  {sessionCount} Session
                                  {sessionCount === 1 ? "" : "s"}
                                </span>
                              ) : null}
                              {worktrees?.fresh &&
                              group.worktrees.length === 0 &&
                              sessionCount === 0 ? (
                                <span>
                                  No linked Worktrees or known sessions
                                </span>
                              ) : null}
                              {worktrees &&
                              !worktrees.fresh &&
                              projectExpanded ? (
                                <RefreshIndicator label="Refreshing Worktrees" />
                              ) : null}
                            </>
                          ) : undefined
                        }
                      />
                      {projectExpanded ? (
                        <div id={contentsId} className="pl-6">
                          {worktrees?.items === null ? (
                            <div
                              role="status"
                              aria-label="Loading Initiative Worktrees"
                              className="flex flex-col gap-2 px-2 py-2"
                            >
                              <Skeleton className="h-8 w-4/5" />
                              <Skeleton className="h-8 w-3/5" />
                            </div>
                          ) : null}
                          {group.worktrees.length > 0 && worktrees ? (
                            <WorktreeList
                              worktrees={group.worktrees}
                              statuses={worktrees.statuses}
                              hosting={worktrees.hosting}
                              selectedWorktreeId={worktrees.selectedId}
                              onOpen={worktrees.onOpen}
                              density={density}
                              tasksByWorktree={inProgressByWorktree}
                              onNavigate={onNavigate}
                              sessionsByWorktree={relations?.byWorktree}
                              selectedSessionId={sessions?.selectedId}
                              sessionExpansion={sessionExpansion}
                              scopeId={`initiative:${initiative.id}:${groupKey}`}
                            />
                          ) : null}
                          {sessions ? (
                            <InitiativeSessionRows
                              sessions={group.directSessions}
                              scopeId={`initiative:${initiative.id}:${groupKey}`}
                              currentId={sessions.selectedId}
                              density={density}
                              onNavigate={onNavigate}
                            />
                          ) : null}
                          {worktrees?.fresh &&
                          group.worktrees.length === 0 &&
                          group.directSessions.length === 0 ? (
                            <div className="mx-2 my-1">
                              <EmptyBox>
                                No linked Worktrees or known sessions for these
                                member Tasks.
                              </EmptyBox>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {relations && relations.unplaced.length > 0 && sessions ? (
                <ListExpansionRow
                  rowId={`initiative:${initiative.id}:other-sessions`}
                  label="Other related sessions"
                  count={relations.unplaced.length}
                  accessibleLabel={`Related sessions whose Project or Worktree placement is unavailable for ${initiative.title}`}
                  expanded={expandedOtherSessions}
                  density={density}
                  tabbable
                  onToggle={() => setExpandedOtherSessions((open) => !open)}
                >
                  <div className="pl-3">
                    <InitiativeSessionRows
                      sessions={relations.unplaced}
                      scopeId={`initiative:${initiative.id}:unplaced`}
                      currentId={sessions.selectedId}
                      density={density}
                      onNavigate={onNavigate}
                    />
                  </div>
                </ListExpansionRow>
              ) : null}
              {relations?.incomplete ? (
                <ListRow
                  interaction="content"
                  divider={false}
                  density={density}
                  data-list-row-id={`initiative:${initiative.id}:session-coverage`}
                  identity={
                    <span className="min-w-0 text-xs text-muted-foreground">
                      Some session relationships or details aren't loaded. Only
                      known Task-related sessions are shown.
                    </span>
                  }
                />
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
});
