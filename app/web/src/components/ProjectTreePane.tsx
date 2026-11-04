import { applyPatch } from "@assistant/shared";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import {
  ChevronRight,
  FileDiff,
  FolderKanban,
  FolderTree,
  GitCompareArrows,
  MessageSquarePlus,
  MessagesSquare,
  SquareArrowOutUpRight,
} from "lucide-react";
import type {
  ProjectRecord,
  SessionListItem,
  WorktreeGitStatus,
  WorktreeRecord,
} from "@assistant/shared";
import { Tree, type TreeNode } from "./common/Tree.tsx";
import { Item } from "./ui/item.tsx";
import { EmptyBox, ErrorNote, Skeleton } from "./common/load.tsx";
import { errorOf, isPending, type LoadState } from "../lib/loadState.ts";
import {
  buildTaskNodes,
  type BacklogNode,
  type TaskPlacement,
} from "../lib/backlogTreeModel.ts";
import { samePlacements, type Task } from "../lib/backlogTree.ts";
import { projectColor } from "../lib/projectDisplay.ts";
import type {
  ProjectListView,
  ProjectWorktreeFacts,
} from "../lib/projectListView.ts";
import { SessionRowContent } from "./SessionRow.tsx";
import { ListRowContent } from "./common/ListRow.tsx";
import {
  ListRowActions,
  type ListRowAction,
} from "./common/ListRowActions.tsx";
import type { RowDensity } from "../lib/rowDensity.ts";
import {
  INITIAL_SESSION_LIMIT,
  SESSION_LIMIT_STEP,
  WorktreeRow,
  compareWorktrees,
  loadExpandedWorktreeIds,
  persistExpandedWorktreeIds,
  scopedKey,
} from "./worktreeRowParts.tsx";
import { persistentStore } from "../lib/persistentStore.ts";
import { worktreePath, type WorktreeView } from "../hooks/useSessionRouting.ts";
import {
  DiffStat,
  RowContentHost,
  WorktreeChangeList,
  WorktreeFilesList,
  useWorktreeChangeSets,
  useWorktreeRowActions,
  type ChangeSetKind,
  type WorktreeSectionKind,
} from "./WorktreeSections.tsx";
import { useWorktreeActionsHost } from "./worktree/WorktreeActionsHost.tsx";

const INDENT_WIDTH = 12;
const COLLAPSE_STORAGE_KEY = "assistant.sidebarProjects.collapsed.v1";
const SECTIONS_STORAGE_KEY = "assistant.sidebarProjects.openSections.v1";
/** Open sections remembered; the oldest opened fall off past this. */
const MAX_REMEMBERED_SECTIONS = 200;
const WORKTREE_NODE_PREFIX = "worktree:";
const SESSION_NODE_PREFIX = "session:";
const MORE_NODE_PREFIX = "more-sessions:";
const SECTION_NODE_PREFIX = "wt-section:";
const GROUP_NODE_PREFIX = "project-group:";
/** How recent a project's last activity keeps it under Active. */
const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The worktree file the page has open, as its route names it. */
export type SelectedWorktreeFile = {
  view: WorktreeView;
  path: string;
  from?: string;
};
const CONTENT_NODE_PREFIX = "wt-content:";

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
  onStartSession,
  onStartSessionInWorktree,
  onVisibleWorktreeIdsChange,
  onNavigate,
  onRemoveWorktree,
  selectedFile,
  flush = false,
  density = "tight",
  rootProjectId,
  rootWorktreeIds,
  storageScope,
  view,
  worktreeFacts = NO_WORKTREE_FACTS,
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
  onOpenWorktree?: ((id: string) => void) | undefined;
  onStartSession?: (id: string) => void;
  onStartSessionInWorktree?: ((id: string) => void) | undefined;
  onVisibleWorktreeIdsChange?: (ids: string[]) => void;
  /** Opens a worktree file or changed file picked in a worktree's sections. */
  onNavigate?: ((path: string) => void) | undefined;
  /** Highlighted in its section, which unfolds to it (with `selectedWorktreeId`). */
  selectedFile?: SelectedWorktreeFile | undefined;
  /** Opens the Remove dialog for a worktree, from its row's menu. */
  onRemoveWorktree?: ((id: string) => void) | undefined;
  /**
   * Edge-to-edge, hairline-divided rows (the sidebar), as the Tasks tree: the
   * notes and placeholders around the tree keep their own inset.
   */
  flush?: boolean;
  density?: RowDensity;
  /**
   * Show only what is UNDER this project — its worktrees with their sessions,
   * and its sessions outside any worktree — as the top level, without the
   * project row and without drag: the Project page's tree, the same rows,
   * paging and remembered expansion as the sidebar's.
   */
  rootProjectId?: string | undefined;
  /**
   * Show only these worktrees, in this order, as the top level — each with
   * the sidebar's sections and sessions under it: a session inspector's
   * worktrees from its spawn tree.
   */
  rootWorktreeIds?: readonly string[] | undefined;
  /** Remember folding under its own keys, apart from the sidebar's. */
  storageScope?: string | undefined;
  /**
   * The sidebar bar's grouping and filters (`ProjectListToolbar`); absent
   * draws the arranged hierarchy, unfiltered. Not read under a root.
   */
  view?: ProjectListView | undefined;
  /** What the filters and the Activity grouping read off a worktree; stable. */
  worktreeFacts?: (worktree: WorktreeRecord) => ProjectWorktreeFacts;
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
    () => loadExpandedWorktreeIds(storageScope),
  );
  const [sessionLimits, setSessionLimits] = useState<Record<string, number>>(
    {},
  );
  // Section node ids that are open, remembered like the projects' folding;
  // a section never opened starts collapsed.
  const [expandedSections, setExpandedSectionsState] = useState<Set<string>>(
    () => loadOpenSectionIds(storageScope),
  );
  const setExpandedSections = useCallback(
    (update: (current: Set<string>) => Set<string>) =>
      setExpandedSectionsState((current) => {
        const next = update(current);
        if (next !== current) persistOpenSectionIds(next, storageScope);
        return next;
      }),
    [storageScope],
  );
  const onToggleSection = useCallback(
    (id: string) => {
      setExpandedSections((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [setExpandedSections],
  );
  // Which section holds the page's open file: Files, or the change set its
  // Review scope is (uncommitted, or the branch against its base).
  const selectedSection = useMemo(() => {
    if (!selectedWorktreeId || !selectedFile) return undefined;
    const worktree = worktrees?.find((item) => item.id === selectedWorktreeId);
    if (!worktree) return undefined;
    const kind: WorktreeSectionKind | undefined =
      selectedFile.view === "files"
        ? "files"
        : selectedFile.view !== "changes"
          ? undefined
          : !selectedFile.from
            ? "uncommitted"
            : selectedFile.from === worktree.baseCommit
              ? "changes"
              : undefined;
    return kind ? { worktree, kind, path: selectedFile.path } : undefined;
  }, [selectedWorktreeId, selectedFile, worktrees]);
  // Unfold to it once per file opened; folding it again is the reader's call.
  const selectedWorktreeForUnfold = selectedSection?.worktree;
  const selectedKind = selectedSection?.kind;
  const selectedPathForUnfold = selectedSection?.path;
  useEffect(() => {
    if (!selectedWorktreeForUnfold || !selectedKind) return;
    const { id, projectId } = selectedWorktreeForUnfold;
    setExpandedWorktreeIds((current) => {
      if (current.has(id)) return current;
      const next = new Set(current).add(id);
      persistExpandedWorktreeIds(next, storageScope);
      return next;
    });
    setCollapsedProjects((current) => {
      if (!current.has(projectId)) return current;
      const next = new Set(current);
      next.delete(projectId);
      persistCollapsedIds(next);
      return next;
    });
    setExpandedSections((current) => {
      const sectionId = sectionNodeId(id, selectedKind);
      return current.has(sectionId) ? current : new Set(current).add(sectionId);
    });
  }, [
    selectedWorktreeForUnfold,
    selectedKind,
    selectedPathForUnfold,
    setExpandedSections,
    storageScope,
  ]);
  // The change lists the open worktrees need: the branch's against its base
  // for every open worktree (its header shows the totals, and an empty one
  // hides), uncommitted only once that section is open.
  const wantedChangeSets = useMemo(() => {
    const wanted: { worktree: WorktreeRecord; kind: ChangeSetKind }[] = [];
    for (const worktree of worktrees ?? []) {
      if (!expandedWorktreeIds.has(worktree.id)) continue;
      if (!worktree.isMain) wanted.push({ worktree, kind: "changes" });
      if (expandedSections.has(sectionNodeId(worktree.id, "uncommitted")))
        wanted.push({ worktree, kind: "uncommitted" });
    }
    return wanted;
  }, [worktrees, expandedWorktreeIds, expandedSections]);
  const changeSets = useWorktreeChangeSets(
    wantedChangeSets,
    worktreeStatuses ?? NO_STATUSES,
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
      changeTotals: (worktreeId) => {
        const entry = changeSets[`${worktreeId}:changes`];
        return entry && "response" in entry ? entry.response.totals : undefined;
      },
    });
  }, [
    ordered,
    projectById,
    relationIndex,
    worktreesByProject,
    worktreeStatuses,
    sessionLimits,
    changeSets,
  ]);

  // The registry as the bar groups and filters it.
  const viewed = !rootProjectId && !rootWorktreeIds ? view : undefined;
  // When something last HAPPENED in a project: a session's turn, a worktree's
  // git state changing, a worktree being made. Not the project record's own
  // stamp, which a registry edit (a reorder) moves for every project.
  const projectActivity = useCallback(
    (projectId: string) => {
      let latest = 0;
      let running = false;
      const consider = (rows: SessionListItem[] | undefined) => {
        for (const session of rows ?? []) {
          latest = Math.max(latest, session.updatedAt);
          if (session.isStreaming) running = true;
        }
      };
      consider(relationIndex.sessionsByProject.get(projectId));
      for (const worktree of worktreesByProject.get(projectId) ?? []) {
        consider(relationIndex.sessionsByWorktree.get(worktree.id));
        // Creation is one moment like the others: it ages out of the Active
        // window, so an old worktree does not keep its project Active.
        latest = Math.max(
          latest,
          worktree.createdAt,
          worktreeFacts(worktree).changedAt ?? 0,
        );
      }
      return { latest, running };
    },
    [relationIndex, worktreesByProject, worktreeFacts],
  );
  const viewNodes = useMemo(
    () =>
      viewed
        ? applyProjectView(nodes, viewed, {
            worktreeFacts,
            activity: projectActivity,
            now,
          })
        : nodes,
    [nodes, viewed, worktreeFacts, projectActivity, now],
  );
  // Drag rearranges the registry tree, so only where it is all on screen.
  const draggable =
    !viewed ||
    (viewed.groupBy === "hierarchy" &&
      viewed.projectId === null &&
      !viewed.showArchived);

  // One project's contents (not its subprojects), or the whole registry.
  const shownNodes = useMemo(
    () =>
      rootWorktreeIds
        ? rootWorktreeIds.flatMap((id) => {
            const node = findNode(nodes, worktreeNodeId(id));
            return node ? [node] : [];
          })
        : rootProjectId
          ? (findNode(nodes, rootProjectId)?.children ?? []).filter(
              (node) => node.data.kind !== "project",
            )
          : viewNodes,
    [nodes, viewNodes, rootProjectId, rootWorktreeIds],
  );

  const expandableProjects = useMemo(
    () => collectExpandableProjectIds(viewNodes),
    [viewNodes],
  );
  const expandableWorktrees = useMemo(
    () => collectExpandableWorktreeIds(viewNodes),
    [viewNodes],
  );
  const expandableSections = useMemo(
    () => collectExpandableSectionIds(viewNodes),
    [viewNodes],
  );
  const expandedIds = useMemo(
    () => [
      ...expandableProjects.filter((id) => !collapsedProjects.has(id)),
      ...expandableWorktrees.filter((id) =>
        expandedWorktreeIds.has(worktreeIdFromNodeId(id)),
      ),
      ...expandableSections.filter((id) => expandedSections.has(id)),
    ],
    [
      expandableProjects,
      collapsedProjects,
      expandableWorktrees,
      expandedWorktreeIds,
      expandableSections,
      expandedSections,
    ],
  );

  const selectedPathIn = (worktreeId: string, kind: WorktreeSectionKind) =>
    selectedSection?.worktree.id === worktreeId && selectedSection.kind === kind
      ? selectedSection.path
      : undefined;

  const projectIconColor = (projectId: string) => {
    const project = projectById.get(projectId);
    return project ? projectColor(project).dot : undefined;
  };

  const visibleWorktreeIds = useMemo(
    () => collectVisibleWorktreeIds(shownNodes, new Set(expandedIds)),
    [shownNodes, expandedIds],
  );
  useEffect(() => {
    onVisibleWorktreeIdsChange?.(visibleWorktreeIds);
  }, [onVisibleWorktreeIdsChange, visibleWorktreeIds]);
  // Folded away (the Projects group unmounts its rows) or gone, the pane shows
  // no worktree: withdraw its report, and only its own, from the host's demand.
  useEffect(
    () => () => onVisibleWorktreeIdsChange?.([]),
    [onVisibleWorktreeIdsChange],
  );

  const selectedIds = useMemo(
    () =>
      [
        selectedId ?? null,
        selectedWorktreeId ? worktreeNodeId(selectedWorktreeId) : null,
        currentSessionId ? sessionNodeId(currentSessionId) : null,
      ].filter((id): id is string => Boolean(id)),
    [selectedId, selectedWorktreeId, currentSessionId],
  );

  // Shared by memoized Project rows so unrelated broadcasts do not redraw them.
  const onToggleProject = useCallback(
    (id: string) => {
      const next = new Set(collapsedProjects);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setCollapsedProjects(next);
      persistCollapsedIds(next);
    },
    [collapsedProjects],
  );

  // Keep this id-based handler stable for memoized Worktree rows as well.
  const onToggleWorktree = useCallback(
    (id: string) => {
      const next = new Set(expandedWorktreeIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setExpandedWorktreeIds(next);
      persistExpandedWorktreeIds(next, storageScope);
    },
    [expandedWorktreeIds, storageScope],
  );

  const onExpandedChange = (ids: string[]) => {
    const expanded = new Set(ids);
    // Rows a filter or grouping hides right now keep their folding.
    const shownProjects = new Set(expandableProjects);
    const nextCollapsed = new Set([
      ...[...collapsedProjects].filter((id) => !shownProjects.has(id)),
      ...expandableProjects.filter((id) => !expanded.has(id)),
    ]);
    const shownWorktrees = new Set(
      expandableWorktrees.map(worktreeIdFromNodeId),
    );
    const nextWorktrees = new Set([
      ...[...expandedWorktreeIds].filter((id) => !shownWorktrees.has(id)),
      ...expandableWorktrees
        .filter((id) => expanded.has(id))
        .map(worktreeIdFromNodeId),
    ]);
    // Under one project the project rows are not in the tree, so its answer
    // says nothing about them: leave the sidebar's collapsed set alone.
    if (!rootProjectId && !rootWorktreeIds) {
      setCollapsedProjects(nextCollapsed);
      persistCollapsedIds(nextCollapsed);
    }
    setExpandedWorktreeIds(nextWorktrees);
    persistExpandedWorktreeIds(nextWorktrees, storageScope);
    // Sections not in the tree right now (a folded worktree) keep their state.
    setExpandedSections((current) => {
      const next = new Set(
        [...current].filter((id) => !expandableSections.includes(id)),
      );
      for (const id of expandableSections) if (expanded.has(id)) next.add(id);
      return next;
    });
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
        paddedContent={false}
        // Projects and worktrees lead with the tree's chevron, like a band.
        getRowDisclosure={(node) =>
          node.data.kind === "group" ||
          node.data.kind === "project" ||
          node.data.kind === "worktree" ||
          node.data.kind === "section"
        }
        getRowClassName={() => "group/item"}
        getRowBand={flush ? (node) => node.data.kind === "group" : undefined}
        getRowPlain={(node) => node.data.kind === "sectionContent"}
        flush={flush}
        showGuides={false}
        aria-label={
          rootWorktreeIds
            ? "Worktrees"
            : rootProjectId
              ? "Worktrees and sessions"
              : "Projects"
        }
        expandedIds={expandedIds}
        onExpandedChange={onExpandedChange}
        selectedIds={selectedIds}
        onSelectionChange={(ids) => {
          if (ids.length !== 1) return;
          const id = ids[0]!;
          if (id.startsWith(SECTION_NODE_PREFIX)) onToggleSection(id);
          else if (id.startsWith(CONTENT_NODE_PREFIX)) return;
          // A tap on a project or worktree folds it; its Open action opens it.
          else if (id.startsWith(WORKTREE_NODE_PREFIX))
            onToggleWorktree(worktreeIdFromNodeId(id));
          else if (id.startsWith(SESSION_NODE_PREFIX))
            onOpenSession?.(sessionIdFromNodeId(id));
          else if (!id.startsWith(MORE_NODE_PREFIX)) onToggleProject(id);
        }}
        // Projects are reordered in the registry tree, never under one.
        {...(rootProjectId || rootWorktreeIds || !draggable
          ? {}
          : {
              onMove: (result: { items: ProjectBrowserNode[] }) =>
                handleMove(result.items),
            })}
        canDrag={(node) =>
          draggable && !reorderBusy && node.data.kind === "project"
        }
        canDrop={({ parentId }) =>
          !parentId || dataForId.get(parentId)?.kind === "project"
        }
        renderNode={(node, state) => {
          const data = node.data;
          switch (data.kind) {
            case "group":
              return <ProjectGroupBand label={data.label} count={data.count} />;
            case "project":
              return (
                <ProjectRowContent
                  project={data.project}
                  selected={state.selected}
                  density={density}
                  onOpen={onOpenProject}
                  onStartSession={onStartSession}
                />
              );
            case "worktree":
              return (
                <ProjectWorktreeRow
                  worktree={data.worktree}
                  status={data.status}
                  now={now}
                  selected={state.selected}
                  density={density}
                  expanded={state.expanded}
                  sessionCount={
                    relationIndex.sessionsByWorktree.get(data.worktree.id)
                      ?.length ?? 0
                  }
                  iconColor={projectIconColor(data.worktree.projectId)}
                  onStartSession={onStartSessionInWorktree}
                  onRemove={onRemoveWorktree}
                />
              );
            case "section":
              return (
                <WorktreeSectionHeader
                  data={data}
                  density={density}
                  iconColor={projectIconColor(data.worktree.projectId)}
                />
              );
            case "sectionContent": {
              const { worktree, section } = data;
              return (
                <RowContentHost>
                  {section === "files" ? (
                    <WorktreeFilesList
                      worktree={worktree}
                      selectedPath={selectedPathIn(worktree.id, "files")}
                      refreshToken={
                        worktreeStatuses?.[worktree.id]?.updatedAt ?? 0
                      }
                      onSelectFile={(path) =>
                        onNavigate?.(
                          worktreePath(worktree.id, "files", { path }),
                        )
                      }
                    />
                  ) : (
                    <WorktreeChangeList
                      entry={changeSets[`${worktree.id}:${section}`]}
                      selectedPath={selectedPathIn(worktree.id, section)}
                      onSelectFile={(path) =>
                        onNavigate?.(
                          worktreePath(worktree.id, "changes", {
                            path,
                            ...(section === "changes"
                              ? { from: worktree.baseCommit }
                              : {}),
                          }),
                        )
                      }
                    />
                  )}
                </RowContentHost>
              );
            }
            case "session":
              return (
                <SessionRowContent
                  session={data.session}
                  density={density}
                  unread={
                    Boolean(data.session.unread) &&
                    data.session.id !== currentSessionId
                  }
                />
              );
            case "moreSessions":
              return (
                <Item
                  variant="list"
                  size="list"
                  render={<button type="button" />}
                  className="min-w-0"
                  onPointerDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") e.stopPropagation();
                  }}
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
                  <ListRowContent
                    density={density}
                    identity={
                      <>
                        <ChevronRight
                          size={16}
                          className="shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                          Show {Math.min(SESSION_LIMIT_STEP, data.remaining)}{" "}
                          more session
                          {Math.min(SESSION_LIMIT_STEP, data.remaining) === 1
                            ? ""
                            : "s"}
                        </span>
                      </>
                    }
                  />
                </Item>
              );
          }
        }}
      />
    </>
  );
});

type ProjectBrowserNodeData =
  | { kind: "group"; label: string; count: number }
  | { kind: "project"; project: ProjectRecord }
  | { kind: "worktree"; worktree: WorktreeRecord; status?: WorktreeGitStatus }
  | { kind: "session"; session: SessionListItem }
  | { kind: "moreSessions"; scopeKey: string; remaining: number }
  | {
      kind: "section";
      worktree: WorktreeRecord;
      section: WorktreeSectionKind;
      count?: number;
      stat?: { additions: number; deletions: number };
    }
  | {
      kind: "sectionContent";
      worktree: WorktreeRecord;
      section: Exclude<WorktreeSectionKind, "sessions">;
    };

const NO_STATUSES: Record<string, WorktreeGitStatus> = {};

const SECTION_LABEL: Record<WorktreeSectionKind, string> = {
  sessions: "Sessions",
  uncommitted: "Uncommitted",
  changes: "Changes",
  files: "Files",
};

const SECTION_ICON: Record<WorktreeSectionKind, typeof FileDiff> = {
  sessions: MessagesSquare,
  uncommitted: FileDiff,
  changes: GitCompareArrows,
  files: FolderTree,
};

/** A worktree row with its git actions in the menu (`useWorktreeRowActions`). */
function ProjectWorktreeRow({
  onRemove,
  ...props
}: ComponentProps<typeof WorktreeRow> & {
  onRemove: ((id: string) => void) | undefined;
}) {
  const fallback = useWorktreeRowActions(
    props.worktree,
    props.status,
    onRemove,
  );
  const host = useWorktreeActionsHost();
  const worktreeId = props.worktree.id;
  const hostActions = host?.actionsFor(worktreeId);
  const prepare = host?.prepare;
  const onMenuIntent = useMemo(
    () => (prepare ? () => prepare(worktreeId) : undefined),
    [prepare, worktreeId],
  );
  // The state the row's marks show asks for one act: a delivered branch is
  // retired, an abandoned pull request's worktree removed.
  const { worktree, status } = props;
  const prStatus = worktree.pullRequest?.status;
  const delivered =
    !worktree.isMain &&
    (prStatus === "merged" || Boolean(status?.merged && status.ahead > 0));
  const abandoned = !worktree.isMain && !delivered && prStatus === "closed";
  const menuActions = useMemo<ListRowAction[]>(
    () =>
      hostActions
        ? hostActions.map((action) => ({
            id: action.key,
            label: action.label,
            icon: action.icon,
            onSelect: action.onRun,
            disabled: Boolean(action.disabled || action.busy),
            ...(action.disabled && action.disabledReason
              ? { accessibleLabel: action.disabledReason }
              : {}),
            ...(action.key === "remove" || action.key === "retire"
              ? { variant: "destructive" as const }
              : {}),
            highlighted:
              (delivered && action.key === "retire") ||
              (abandoned && action.key === "remove"),
          }))
        : fallback,
    [hostActions, fallback, delivered, abandoned],
  );
  return (
    <WorktreeRow
      {...props}
      // The host's list leads with Start session itself.
      {...(hostActions ? { onStartSession: undefined } : {})}
      menuActions={menuActions}
      onMenuIntent={onMenuIntent}
    />
  );
}

/** A worktree section's heading row: a standard one-line row; a tap folds it. */
const WorktreeSectionHeader = memo(function WorktreeSectionHeader({
  data,
  density,
  iconColor,
}: {
  data: Extract<ProjectBrowserNodeData, { kind: "section" }>;
  density: RowDensity;
  iconColor: string | undefined;
}) {
  const Icon = SECTION_ICON[data.section];
  const label =
    data.section === "changes"
      ? `Changes vs ${data.worktree.baseBranch}`
      : SECTION_LABEL[data.section];
  return (
    <ListRowContent
      density={density}
      leading={
        <Icon
          className="shrink-0 text-muted-foreground"
          style={iconColor ? { color: iconColor } : undefined}
          aria-hidden
        />
      }
      title={label}
      trailing={
        data.count !== undefined ? (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {data.count}
          </span>
        ) : data.stat ? (
          <DiffStat
            additions={data.stat.additions}
            deletions={data.stat.deletions}
          />
        ) : undefined
      }
    />
  );
});

type ProjectBrowserNode = TreeNode<ProjectBrowserNodeData>;

const ProjectRowContent = memo(function ProjectRowContent({
  project,
  selected,
  density,
  onOpen,
  onStartSession,
}: {
  project: ProjectRecord;
  selected: boolean;
  density: RowDensity;
  onOpen?: ((id: string) => void) | undefined;
  onStartSession?: ((id: string) => void) | undefined;
}) {
  const color = projectColor(project);
  return (
    <ListRowContent
      density={density}
      leading={
        <FolderKanban
          className="shrink-0"
          style={{ color: color.dot }}
          aria-hidden
        />
      }
      title={
        <>
          {project.name}
          <span className="ml-1.5 text-xs font-normal text-muted-foreground">
            {project.key}
          </span>
        </>
      }
      actions={
        onStartSession || onOpen ? (
          <ListRowActions
            menuOnly
            actions={[
              ...(onOpen
                ? [
                    {
                      id: "open",
                      label: "Open project",
                      accessibleLabel: `Open project: ${project.key} ${project.name}`,
                      icon: <SquareArrowOutUpRight />,
                      onSelect: () => onOpen(project.id),
                    },
                  ]
                : []),
              ...(onStartSession
                ? [
                    {
                      id: "start-session",
                      label: "Start session",
                      accessibleLabel: `Start session in project: ${project.key} ${project.name}`,
                      icon: <MessageSquarePlus />,
                      onSelect: () => onStartSession(project.id),
                    },
                  ]
                : []),
            ]}
            label="More project actions"
            alwaysVisible={selected}
          />
        ) : undefined
      }
    />
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
    changeTotals: (
      worktreeId: string,
    ) => { files: number; additions: number; deletions: number } | undefined;
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
      const sessionNodes = [
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
      const status = context.statuses[worktree.id];
      const totals = worktree.isMain
        ? undefined
        : context.changeTotals(worktree.id);
      const section = (
        kind: WorktreeSectionKind,
        children: ProjectBrowserNode[],
        extra: {
          count?: number;
          stat?: { additions: number; deletions: number };
        } = {},
      ): ProjectBrowserNode => ({
        id: sectionNodeId(worktree.id, kind),
        data: { kind: "section", worktree, section: kind, ...extra },
        children,
      });
      const content = (
        kind: Exclude<WorktreeSectionKind, "sessions">,
      ): ProjectBrowserNode[] => [
        {
          id: `${CONTENT_NODE_PREFIX}${worktree.id}:${kind}`,
          data: { kind: "sectionContent", worktree, section: kind },
        },
      ];
      const childrenValue: ProjectBrowserNode[] = [
        ...(linkedSessions.length > 0
          ? [
              section("sessions", sessionNodes, {
                count: linkedSessions.length,
              }),
            ]
          : []),
        ...(status?.dirty
          ? [
              section("uncommitted", content("uncommitted"), {
                stat: {
                  additions: status.additions,
                  deletions: status.deletions,
                },
              }),
            ]
          : []),
        ...(totals && totals.files > 0
          ? [
              section("changes", content("changes"), {
                stat: {
                  additions: totals.additions,
                  deletions: totals.deletions,
                },
              }),
            ]
          : []),
        section("files", content("files")),
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

const NO_WORKTREE_FACTS = (): ProjectWorktreeFacts => ({
  changed: false,
  pullRequest: false,
});

/** An Activity grouping's band, as the Tasks tree draws a project's. */
function ProjectGroupBand({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex min-w-0 items-center gap-2 px-2">
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">
        {label}
      </span>
      <span className="shrink-0 text-sm opacity-70">{count}</span>
    </div>
  );
}

/**
 * The registry tree as the bar asks for it: worktrees narrowed by the filter,
 * projects without work dropped when asked, and — past Hierarchy — every
 * project flat at the top (its subprojects beside it, not under it), sorted or
 * banded into Active and Quiet.
 */
function applyProjectView(
  nodes: ProjectBrowserNode[],
  view: ProjectListView,
  context: {
    worktreeFacts: (worktree: WorktreeRecord) => ProjectWorktreeFacts;
    activity: (projectId: string) => { latest: number; running: boolean };
    now: number;
  },
): ProjectBrowserNode[] {
  const keepWorktree = (worktree: WorktreeRecord) => {
    if (view.worktrees === "all") return true;
    const facts = context.worktreeFacts(worktree);
    return view.worktrees === "changes" ? facts.changed : facts.pullRequest;
  };
  // A chosen project narrows the list to it and its subprojects, without its
  // ancestors. One no longer listed (archived while hidden, or removed)
  // narrows nothing rather than leaving the list empty.
  const find = (list: ProjectBrowserNode[]): ProjectBrowserNode | undefined => {
    for (const node of list) {
      if (node.data.kind !== "project") continue;
      if (node.data.project.id === view.projectId) return node;
      const found = find(node.children ?? []);
      if (found) return found;
    }
    return undefined;
  };
  const chosen = view.projectId === null ? undefined : find(nodes);
  const scoped = chosen ? [chosen] : nodes;
  // Worktrees filtered by the Worktrees filter.
  const filter = (list: ProjectBrowserNode[]): ProjectBrowserNode[] =>
    list.flatMap((node) => {
      if (node.data.kind !== "project") return [node];
      const children = filter(node.children ?? []).filter(
        (child) =>
          child.data.kind !== "worktree" || keepWorktree(child.data.worktree),
      );
      return [
        applyPatch(node, { children: children.length ? children : undefined }),
      ];
    });
  const filtered = filter(scoped);
  if (view.groupBy === "hierarchy") return filtered;

  const flat: ProjectBrowserNode[] = [];
  const visit = (node: ProjectBrowserNode) => {
    if (node.data.kind !== "project") return;
    const own = (node.children ?? []).filter(
      (child) => child.data.kind !== "project",
    );
    flat.push(applyPatch(node, { children: own.length ? own : undefined }));
    for (const child of node.children ?? []) visit(child);
  };
  for (const node of filtered) visit(node);
  const name = (node: ProjectBrowserNode) =>
    node.data.kind === "project" ? node.data.project.name : "";
  const byName = (a: ProjectBrowserNode, b: ProjectBrowserNode) =>
    name(a).localeCompare(name(b));
  const byRecent = (a: ProjectBrowserNode, b: ProjectBrowserNode) =>
    context.activity(b.id).latest - context.activity(a.id).latest ||
    byName(a, b);
  if (view.groupBy === "name") return flat.sort(byName);
  if (view.groupBy === "recent") return flat.sort(byRecent);

  // Running now, or touched within the window: unpushed commits or an open
  // pull request nobody has moved in a week are not activity.
  const active = (node: ProjectBrowserNode): boolean => {
    const { latest, running } = context.activity(node.id);
    return running || context.now - latest < ACTIVE_WINDOW_MS;
  };
  const groups = [
    { id: "active", label: "Active", rows: flat.filter(active) },
    {
      id: "quiet",
      label: "Quiet",
      rows: flat.filter((node) => !active(node)),
    },
  ];
  return groups
    .filter((group) => group.rows.length > 0)
    .map((group) => ({
      id: `${GROUP_NODE_PREFIX}${group.id}`,
      data: { kind: "group", label: group.label, count: group.rows.length },
      children: group.rows.sort(byRecent),
    }));
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
    if (
      (node.data.kind === "project" || node.data.kind === "group") &&
      (node.children?.length ?? 0) > 0
    )
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

function sectionNodeId(worktreeId: string, kind: WorktreeSectionKind): string {
  return `${SECTION_NODE_PREFIX}${worktreeId}:${kind}`;
}

function collectExpandableSectionIds(nodes: ProjectBrowserNode[]): string[] {
  const ids: string[] = [];
  const visit = (node: ProjectBrowserNode) => {
    if (node.data.kind === "section") ids.push(node.id);
    for (const child of node.children ?? []) visit(child);
  };
  for (const node of nodes) visit(node);
  return ids;
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

function loadOpenSectionIds(scope: string | undefined): Set<string> {
  try {
    const raw = persistentStore().getItem(
      scopedKey(SECTIONS_STORAGE_KEY, scope),
    );
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

function persistOpenSectionIds(
  ids: Set<string>,
  scope: string | undefined,
): void {
  // Before the backend answered, this window's copy is empty: writing now
  // would replace every remembered section with this render's few.
  if (!persistentStore().isLoaded()) return;
  try {
    // A Set keeps insertion order, so the last ones are the latest opened.
    persistentStore().setItem(
      scopedKey(SECTIONS_STORAGE_KEY, scope),
      JSON.stringify([...ids].slice(-MAX_REMEMBERED_SECTIONS)),
    );
  } catch {
    // Best-effort only.
  }
}

function persistCollapsedIds(ids: Set<string>): void {
  try {
    persistentStore().setItem(COLLAPSE_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Best-effort only.
  }
}
