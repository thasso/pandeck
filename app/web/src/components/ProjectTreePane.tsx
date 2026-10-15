import { applyPatch } from "@assistant/shared";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { FolderKanban, MessageSquarePlus } from "lucide-react";
import type {
  ProjectRecord,
  SessionListItem,
  WorktreeGitStatus,
  WorktreeRecord,
} from "@assistant/shared";
import { Tree, type TreeNode } from "./common/Tree.tsx";
import { Button } from "./ui/button.tsx";
import { IconButton } from "./common/IconButton.tsx";
import { EmptyBox, ErrorNote, Skeleton } from "./common/load.tsx";
import { errorOf, isPending, type LoadState } from "../lib/loadState.ts";
import {
  buildTaskNodes,
  type BacklogNode,
  type TaskPlacement,
} from "../lib/backlogTreeModel.ts";
import { samePlacements, type Task } from "../lib/backlogTree.ts";
import { projectColor } from "../lib/projectDisplay.ts";
import { SessionRowContent } from "./SessionRow.tsx";
import {
  INITIAL_SESSION_LIMIT,
  ROW_ACTION_REVEAL,
  SESSION_LIMIT_STEP,
  WorktreeRow,
  compareWorktrees,
  loadExpandedWorktreeIds,
  persistExpandedWorktreeIds,
} from "./worktreeRowParts.tsx";
import { persistentStore } from "../lib/persistentStore.ts";

const INDENT_WIDTH = 12;
const COLLAPSE_STORAGE_KEY = "assistant.sidebarProjects.collapsed.v1";
const WORKTREE_NODE_PREFIX = "worktree:";
const SESSION_NODE_PREFIX = "session:";
const MORE_NODE_PREFIX = "more-sessions:";

/**
 * @component ProjectTreePane
 * @purpose The sidebar Projects browser: the project registry as a compact,
 * collapsible tree on the shared `components/common/Tree` chrome, with each Project
 * revealing bounded direct sessions, Worktrees, and bounded sessions under each
 * Worktree.
 * @useWhen Rendering the Projects section of the sidebar.
 * @avoidWhen Project detail or inspector surfaces; those own richer layouts.
 * @intent Project rows keep the Backlog tree model for ordering/reparenting;
 * related sessions/worktrees are read-only tree children that reuse SessionRow
 * and WorktreeBrowser row pieces. Session children are paged in the same 5-at-a-
 * time style as the Worktrees browser so the sidebar remains compact.
 * @related Sidebar, BacklogTreePane, WorktreeBrowser, SessionRow, components/common/Tree.tsx
 */
export const ProjectTreePane = memo(function ProjectTreePane({
  projects,
  loading,
  reorderState,
  relationsLoading = false,
  selectedId,
  sessions,
  currentSessionId,
  worktrees,
  worktreeStatuses,
  selectedWorktreeId,
  onReorder,
  onOpenProject,
  onOpenSession,
  onArchiveSession,
  onOpenWorktree,
  onStartSession,
  onStartSessionInWorktree,
  onVisibleWorktreeIdsChange,
  flush = false,
  rootProjectId,
}: {
  projects: ProjectRecord[];
  loading: boolean;
  reorderState?: LoadState<true> | undefined;
  relationsLoading?: boolean;
  selectedId?: string | null | undefined;
  sessions?: SessionListItem[];
  currentSessionId?: string | undefined;
  worktrees?: WorktreeRecord[] | null;
  worktreeStatuses?: Record<string, WorktreeGitStatus>;
  selectedWorktreeId?: string | null | undefined;
  /** Absent under `rootProjectId`, which has no project rows to move or open. */
  onReorder?: (
    orderedIds: string[],
    placements: { id: string; parentId?: string | null }[],
  ) => void;
  onOpenProject?: (id: string) => void;
  onOpenSession?: ((id: string) => void) | undefined;
  onArchiveSession?: ((id: string, archived: boolean) => void) | undefined;
  onOpenWorktree?: ((id: string) => void) | undefined;
  onStartSession?: (id: string) => void;
  onStartSessionInWorktree?: ((id: string) => void) | undefined;
  onVisibleWorktreeIdsChange?: (ids: string[]) => void;
  /**
   * Edge-to-edge, hairline-divided rows (the sidebar), as the Tasks tree: the
   * notes and placeholders around the tree keep their own inset.
   */
  flush?: boolean;
  /**
   * Show only what is UNDER this project — its worktrees with their sessions,
   * and its sessions outside any worktree — as the top level, without the
   * project row and without drag: the Project page's tree, the same rows,
   * paging and remembered expansion as the sidebar's.
   */
  rootProjectId?: string | undefined;
}) {
  const ordered = projects;
  const lastReorder = useRef<{
    orderedIds: string[];
    placements: { id: string; parentId?: string | null }[];
  } | null>(null);
  const reorderBusy = reorderState ? isPending(reorderState) : false;
  const reorderError = reorderState ? errorOf(reorderState) : undefined;
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() =>
    loadCollapsedIds(),
  );
  const [expandedWorktreeIds, setExpandedWorktreeIds] = useState<Set<string>>(
    () => loadExpandedWorktreeIds(),
  );
  const [sessionLimits, setSessionLimits] = useState<Record<string, number>>(
    {},
  );
  // One coarse wall clock covers every worktree row. Their memo comparator
  // folds each tick to the stale/fresh bit, so unchanged rows stay untouched.
  const now = useCoarseNow(60_000, Boolean(worktrees?.length));

  const projectById = useMemo(
    () => new Map(ordered.map((project) => [project.id, project])),
    [ordered],
  );
  const worktreesByProject = useMemo(
    () => groupByProject(worktrees ?? []),
    [worktrees],
  );
  const relationIndex = useMemo(
    () => buildProjectRelationIndex(worktreesByProject, sessions ?? []),
    [sessions, worktreesByProject],
  );
  const nodes = useMemo<ProjectBrowserNode[]>(() => {
    const pathParents = buildPathProjectParents(ordered);
    const hierarchy = projectNodesFromBacklogNodes(
      buildTaskNodes(projectsToTasks(ordered, pathParents)),
      projectById,
    );
    return withRelatedChildren(hierarchy, {
      relationIndex,
      worktreesByProject,
      statuses: worktreeStatuses ?? {},
      sessionLimits,
    });
  }, [
    ordered,
    projectById,
    relationIndex,
    worktreesByProject,
    worktreeStatuses,
    sessionLimits,
  ]);

  // One project's contents (not its subprojects), or the whole registry.
  const shownNodes = useMemo(
    () =>
      rootProjectId
        ? (findNode(nodes, rootProjectId)?.children ?? []).filter(
            (node) => node.data.kind !== "project",
          )
        : nodes,
    [nodes, rootProjectId],
  );

  const expandableProjects = useMemo(
    () => collectExpandableProjectIds(nodes),
    [nodes],
  );
  const expandableWorktrees = useMemo(
    () => collectExpandableWorktreeIds(nodes),
    [nodes],
  );
  const expandedIds = useMemo(
    () => [
      ...expandableProjects.filter((id) => !collapsedProjects.has(id)),
      ...expandableWorktrees.filter((id) =>
        expandedWorktreeIds.has(worktreeIdFromNodeId(id)),
      ),
    ],
    [
      expandableProjects,
      collapsedProjects,
      expandableWorktrees,
      expandedWorktreeIds,
    ],
  );

  const visibleWorktreeIds = useMemo(
    () => collectVisibleWorktreeIds(shownNodes, new Set(expandedIds)),
    [shownNodes, expandedIds],
  );
  useEffect(() => {
    onVisibleWorktreeIdsChange?.(visibleWorktreeIds);
  }, [onVisibleWorktreeIdsChange, visibleWorktreeIds]);

  const selectedIds = useMemo(
    () =>
      [
        selectedId ?? null,
        selectedWorktreeId ? worktreeNodeId(selectedWorktreeId) : null,
        currentSessionId ? sessionNodeId(currentSessionId) : null,
      ].filter((id): id is string => Boolean(id)),
    [selectedId, selectedWorktreeId, currentSessionId],
  );

  const onExpandedChange = (ids: string[]) => {
    const expanded = new Set(ids);
    const nextCollapsed = new Set(
      expandableProjects.filter((id) => !expanded.has(id)),
    );
    const nextWorktrees = new Set(
      expandableWorktrees
        .filter((id) => expanded.has(id))
        .map(worktreeIdFromNodeId),
    );
    // Under one project the project rows are not in the tree, so its answer
    // says nothing about them: leave the sidebar's collapsed set alone.
    if (!rootProjectId) {
      setCollapsedProjects(nextCollapsed);
      persistCollapsedIds(nextCollapsed);
    }
    setExpandedWorktreeIds(nextWorktrees);
    persistExpandedWorktreeIds(nextWorktrees);
  };

  const handleMove = (items: ProjectBrowserNode[]) => {
    const placements = projectPlacementsFromNodes(items);
    if (samePlacements(placements, projectPlacementsFromNodes(nodes))) return;
    const orderedIds = placements.map((placement) => placement.id);
    lastReorder.current = { orderedIds, placements };
    onReorder?.(orderedIds, placements);
  };

  const dataForId = useMemo(() => {
    const map = new Map<string, ProjectBrowserNodeData>();
    const visit = (node: ProjectBrowserNode) => {
      map.set(node.id, node.data);
      for (const child of node.children ?? []) visit(child);
    };
    for (const node of nodes) visit(node);
    return map;
  }, [nodes]);

  if (loading) {
    // Rows, not a sentence: this is a tree with a fixed row height, so the
    // silhouette it will become is the honest placeholder (R4).
    return (
      <div
        role="status"
        aria-label="Loading projects"
        className={`flex flex-col gap-1.5 py-1 ${flush ? "px-2" : "px-1"}`}
      >
        {[0, 1, 2, 3].map((row) => (
          <Skeleton
            key={row}
            className="h-6"
            style={{ width: `${[84, 62, 74, 56][row]}%` }}
          />
        ))}
      </div>
    );
  }
  if (projects.length === 0) {
    return (
      <div className={flush ? "mx-2" : undefined}>
        <EmptyBox>No projects in the registry yet.</EmptyBox>
      </div>
    );
  }
  return (
    <>
      {reorderError ? (
        <ErrorNote
          message={reorderError}
          retryLabel="Retry reorder"
          onRetry={() => {
            const attempted = lastReorder.current;
            if (attempted)
              onReorder?.(attempted.orderedIds, attempted.placements);
          }}
          className={flush ? "mx-2 mb-2" : "mb-2"}
        />
      ) : null}
      {relationsLoading ? (
        <div
          role="status"
          aria-label="Loading Project worktrees and sessions"
          className="mb-2 flex flex-col gap-1.5 px-5"
        >
          <Skeleton className="h-6 w-4/5" />
          <Skeleton className="h-6 w-3/5" />
        </div>
      ) : null}
      <Tree
        items={shownNodes}
        indentWidth={INDENT_WIDTH}
        compact
        flush={flush}
        showGuides
        aria-label={rootProjectId ? "Worktrees and sessions" : "Projects"}
        expandedIds={expandedIds}
        onExpandedChange={onExpandedChange}
        selectedIds={selectedIds}
        onSelectionChange={(ids) => {
          if (ids.length !== 1) return;
          const id = ids[0]!;
          if (id.startsWith(WORKTREE_NODE_PREFIX))
            onOpenWorktree?.(worktreeIdFromNodeId(id));
          else if (id.startsWith(SESSION_NODE_PREFIX))
            onOpenSession?.(sessionIdFromNodeId(id));
          else if (!id.startsWith(MORE_NODE_PREFIX)) onOpenProject?.(id);
        }}
        // Projects are reordered in the registry tree, never under one.
        {...(rootProjectId
          ? {}
          : {
              onMove: (result: { items: ProjectBrowserNode[] }) =>
                handleMove(result.items),
            })}
        canDrag={(node) => !reorderBusy && node.data.kind === "project"}
        canDrop={({ parentId }) =>
          !parentId || dataForId.get(parentId)?.kind === "project"
        }
        renderNode={(node, state) => {
          const data = node.data;
          switch (data.kind) {
            case "project":
              return (
                <ProjectRowContent
                  project={data.project}
                  selected={state.selected}
                  onStartSession={onStartSession}
                />
              );
            case "worktree":
              return (
                <WorktreeRow
                  worktree={data.worktree}
                  status={data.status}
                  now={now}
                  selected={state.selected}
                  onStartSession={onStartSessionInWorktree}
                />
              );
            case "session":
              return (
                <SessionRowContent
                  session={data.session}
                  unread={
                    Boolean(data.session.unread) &&
                    data.session.id !== currentSessionId
                  }
                  onArchive={onArchiveSession}
                />
              );
            case "moreSessions":
              return (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSessionLimits((prev) => ({
                      ...prev,
                      [data.scopeKey]:
                        (prev[data.scopeKey] ?? INITIAL_SESSION_LIMIT) +
                        SESSION_LIMIT_STEP,
                    }));
                  }}
                >
                  Show {Math.min(SESSION_LIMIT_STEP, data.remaining)} more
                  session
                  {Math.min(SESSION_LIMIT_STEP, data.remaining) === 1
                    ? ""
                    : "s"}
                </Button>
              );
          }
        }}
      />
    </>
  );
});

type ProjectBrowserNodeData =
  | { kind: "project"; project: ProjectRecord }
  | { kind: "worktree"; worktree: WorktreeRecord; status?: WorktreeGitStatus }
  | { kind: "session"; session: SessionListItem }
  | { kind: "moreSessions"; scopeKey: string; remaining: number };

type ProjectBrowserNode = TreeNode<ProjectBrowserNodeData>;

const ProjectRowContent = memo(function ProjectRowContent({
  project,
  selected,
  onStartSession,
}: {
  project: ProjectRecord;
  selected: boolean;
  onStartSession?: ((id: string) => void) | undefined;
}) {
  const color = projectColor(project);
  return (
    <div
      className="group/row flex min-w-0 items-center gap-1.5"
      title={`${project.key} · ${project.name}`}
    >
      {/* The Project glyph every surface uses: its folder, in its colour. */}
      <FolderKanban
        size={14}
        className="shrink-0"
        style={{ color: color.dot }}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate text-sm">
        <span
          className={`text-foreground ${selected ? "font-semibold" : "font-medium"}`}
        >
          {project.key}
        </span>
        <span className="text-muted-foreground"> · {project.name}</span>
      </span>
      {onStartSession ? (
        <IconButton
          size="icon-xs"
          className={`shrink-0 ${ROW_ACTION_REVEAL}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onStartSession(project.id);
          }}
          label={`Start session in project: ${project.key} ${project.name}`}
        >
          <MessageSquarePlus />
        </IconButton>
      ) : null}
    </div>
  );
});

function projectNodesFromBacklogNodes(
  nodes: BacklogNode[],
  projectById: Map<string, ProjectRecord>,
): ProjectBrowserNode[] {
  return nodes.flatMap((node) => {
    const project = projectById.get(node.id);
    if (!project) return [];
    const children = projectNodesFromBacklogNodes(
      node.children ?? [],
      projectById,
    );
    return [
      {
        id: project.id,
        data: { kind: "project", project },
        ...(children.length ? { children } : {}),
      } satisfies ProjectBrowserNode,
    ];
  });
}

function withRelatedChildren(
  nodes: ProjectBrowserNode[],
  context: {
    relationIndex: ProjectRelationIndex;
    worktreesByProject: Map<string, WorktreeRecord[]>;
    statuses: Record<string, WorktreeGitStatus>;
    sessionLimits: Record<string, number>;
  },
): ProjectBrowserNode[] {
  return nodes.map((node) => {
    if (node.data.kind !== "project") return node;
    const project = node.data.project;
    const childProjects = withRelatedChildren(
      (node.children ?? []).filter((child) => child.data.kind === "project"),
      context,
    );
    const projectWorktrees = context.worktreesByProject.get(project.id) ?? [];
    const related: ProjectBrowserNode[] = [];

    for (const worktree of projectWorktrees) {
      const linkedSessions =
        context.relationIndex.sessionsByWorktree.get(worktree.id) ?? [];
      const scopeKey = `worktree:${worktree.id}`;
      const visibleLimit =
        context.sessionLimits[scopeKey] ?? INITIAL_SESSION_LIMIT;
      const visibleSessions = linkedSessions.slice(0, visibleLimit);
      const remaining = Math.max(
        0,
        linkedSessions.length - visibleSessions.length,
      );
      const childrenValue = [
        ...visibleSessions.map((session) => ({
          id: sessionNodeId(session.id),
          data: { kind: "session", session } satisfies ProjectBrowserNodeData,
        })),
        ...(remaining > 0
          ? [
              {
                id: `${MORE_NODE_PREFIX}${scopeKey}`,
                data: {
                  kind: "moreSessions",
                  scopeKey,
                  remaining,
                } satisfies ProjectBrowserNodeData,
              },
            ]
          : []),
      ];
      related.push({
        id: worktreeNodeId(worktree.id),
        data: {
          kind: "worktree",
          worktree,
          ...(context.statuses[worktree.id] !== undefined
            ? { status: context.statuses[worktree.id] }
            : {}),
        },
        ...(childrenValue !== undefined ? { children: childrenValue } : {}),
      });
    }

    const directSessions =
      context.relationIndex.sessionsByProject.get(project.id) ?? [];
    const scopeKey = `project:${project.id}`;
    const visibleLimit =
      context.sessionLimits[scopeKey] ?? INITIAL_SESSION_LIMIT;
    const visibleSessions = directSessions.slice(0, visibleLimit);
    const remaining = Math.max(
      0,
      directSessions.length - visibleSessions.length,
    );
    related.push(
      ...visibleSessions.map((session) => ({
        id: sessionNodeId(session.id),
        data: { kind: "session", session } satisfies ProjectBrowserNodeData,
      })),
    );
    if (remaining > 0)
      related.push({
        id: `${MORE_NODE_PREFIX}${scopeKey}`,
        data: { kind: "moreSessions", scopeKey, remaining },
      });

    const children = [...childProjects, ...related];
    // A project with no children must LOSE the key it may have arrived with.
    return applyPatch(node, {
      children: children.length ? children : undefined,
    });
  });
}

function findNode(
  nodes: ProjectBrowserNode[],
  id: string,
): ProjectBrowserNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children ?? [], id);
    if (found) return found;
  }
  return undefined;
}

function groupByProject(
  worktrees: WorktreeRecord[],
): Map<string, WorktreeRecord[]> {
  const grouped = new Map<string, WorktreeRecord[]>();
  for (const worktree of worktrees) {
    const list = grouped.get(worktree.projectId) ?? [];
    list.push(worktree);
    grouped.set(worktree.projectId, list);
  }
  for (const list of grouped.values()) {
    list.sort(compareWorktrees);
  }
  return grouped;
}

interface ProjectRelationIndex {
  sessionsByProject: Map<string, SessionListItem[]>;
  sessionsByWorktree: Map<string, SessionListItem[]>;
}

function buildProjectRelationIndex(
  worktreesByProject: Map<string, WorktreeRecord[]>,
  sessions: SessionListItem[],
): ProjectRelationIndex {
  const worktreeBySession = new Map<string, string>();
  for (const worktrees of worktreesByProject.values())
    for (const worktree of worktrees)
      for (const sessionId of worktree.sessionIds)
        worktreeBySession.set(sessionId, worktree.id);
  const sessionsByProject = new Map<string, SessionListItem[]>();
  const sessionsByWorktree = new Map<string, SessionListItem[]>();
  for (const session of sessions) {
    if (session.archived && !session.isStreaming) continue;
    const worktreeId = session.worktreeId ?? worktreeBySession.get(session.id);
    const map = worktreeId ? sessionsByWorktree : sessionsByProject;
    const key = worktreeId ?? session.projectId;
    if (!key) continue;
    const rows = map.get(key) ?? [];
    rows.push(session);
    map.set(key, rows);
  }
  const compare = (a: SessionListItem, b: SessionListItem) =>
    Number(Boolean(b.isStreaming)) - Number(Boolean(a.isStreaming)) ||
    b.updatedAt - a.updatedAt;
  for (const rows of sessionsByProject.values()) rows.sort(compare);
  for (const rows of sessionsByWorktree.values()) rows.sort(compare);
  return { sessionsByProject, sessionsByWorktree };
}

function collectVisibleWorktreeIds(
  nodes: ProjectBrowserNode[],
  expandedIds: ReadonlySet<string>,
): string[] {
  const ids: string[] = [];
  const visit = (node: ProjectBrowserNode) => {
    if (node.data.kind === "worktree") ids.push(node.data.worktree.id);
    if (!expandedIds.has(node.id)) return;
    for (const child of node.children ?? []) visit(child);
  };
  for (const node of nodes) visit(node);
  return ids.sort();
}

function collectExpandableProjectIds(nodes: ProjectBrowserNode[]): string[] {
  const ids: string[] = [];
  const visit = (node: ProjectBrowserNode) => {
    if (node.data.kind === "project" && (node.children?.length ?? 0) > 0)
      ids.push(node.id);
    for (const child of node.children ?? []) visit(child);
  };
  for (const node of nodes) visit(node);
  return ids;
}

function collectExpandableWorktreeIds(nodes: ProjectBrowserNode[]): string[] {
  const ids: string[] = [];
  const visit = (node: ProjectBrowserNode) => {
    if (node.data.kind === "worktree" && (node.children?.length ?? 0) > 0)
      ids.push(node.id);
    for (const child of node.children ?? []) visit(child);
  };
  for (const node of nodes) visit(node);
  return ids;
}

function projectPlacementsFromNodes(
  nodes: ProjectBrowserNode[],
  parentId: string | null = null,
): TaskPlacement[] {
  const out: TaskPlacement[] = [];
  for (const node of nodes) {
    if (node.data.kind !== "project") continue;
    out.push({ id: node.data.project.id, parentId });
    out.push(
      ...projectPlacementsFromNodes(node.children ?? [], node.data.project.id),
    );
  }
  return out;
}

function worktreeNodeId(id: string): string {
  return `${WORKTREE_NODE_PREFIX}${id}`;
}

function worktreeIdFromNodeId(id: string): string {
  return id.startsWith(WORKTREE_NODE_PREFIX)
    ? id.slice(WORKTREE_NODE_PREFIX.length)
    : id;
}

function sessionNodeId(id: string): string {
  return `${SESSION_NODE_PREFIX}${id}`;
}

function sessionIdFromNodeId(id: string): string {
  return id.startsWith(SESSION_NODE_PREFIX)
    ? id.slice(SESSION_NODE_PREFIX.length)
    : id;
}

/** Lift projects into Backlog `Task` shims so the shared tree model orders and
 * flattens them exactly like Tasks (sortOrder first, unsorted float by recency). */
function projectsToTasks(
  projects: ProjectRecord[],
  pathParents: Map<string, string>,
): Task[] {
  return projects.map((project) => {
    const parentIdValue =
      project.parentId === undefined
        ? pathParents.get(project.id)
        : (project.parentId ?? undefined);
    return {
      id: project.id,
      title: project.name,
      status: "todo",
      ...(project.description !== undefined
        ? { descriptionPreview: project.description }
        : {}),
      externalLinks: [],
      priority: "normal",
      sessionRefs: [],
      source: { createdBy: "user" },
      ...(parentIdValue !== undefined ? { parentId: parentIdValue } : {}),
      ...(project.sortOrder !== undefined
        ? { sortOrder: project.sortOrder }
        : {}),
      createdAt: Date.parse(project.createdAt ?? "") || 0,
      updatedAt: Date.parse(project.updatedAt ?? "") || 0,
    };
  });
}

/** Infer a parent for projects without an explicit `parentId`: the project whose
 * primary local path is the longest strict prefix of this project's path. */
function buildPathProjectParents(
  projects: ProjectRecord[],
): Map<string, string> {
  const pathsById = new Map(
    projects.map((project) => [project.id, primaryProjectPath(project)]),
  );
  const parents = new Map<string, string>();
  for (const project of projects) {
    if (project.parentId !== undefined) continue;
    const path = pathsById.get(project.id);
    if (!path) continue;
    let parent: { id: string; path: string } | null = null;
    for (const candidate of projects) {
      if (candidate.id === project.id) continue;
      const candidatePath = pathsById.get(candidate.id);
      if (!candidatePath || !pathStartsWithSegment(path, candidatePath))
        continue;
      if (!parent || candidatePath.length > parent.path.length)
        parent = { id: candidate.id, path: candidatePath };
    }
    if (parent) parents.set(project.id, parent.id);
  }
  return parents;
}

function primaryProjectPath(project: ProjectRecord): string | null {
  return project.primaryPath?.trim() || null;
}

function pathStartsWithSegment(path: string, base: string): boolean {
  return path !== base && path.startsWith(`${base}/`);
}

function useCoarseNow(intervalMs: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

function loadCollapsedIds(): Set<string> {
  try {
    const raw = persistentStore().getItem(COLLAPSE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

function persistCollapsedIds(ids: Set<string>): void {
  try {
    persistentStore().setItem(COLLAPSE_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Best-effort only.
  }
}
