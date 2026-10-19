import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ChevronRight,
  FolderKanban,
  Trash2,
} from "lucide-react";
import type {
  ProjectRecord,
  SessionListItem,
  TaskStatus,
} from "@assistant/shared";
import {
  Tree,
  type TreeNode,
  type TreeNodeState,
  type TreeRowAction,
  type TreeRowSwipe,
} from "./common/Tree.tsx";
import type { SwipeAction } from "./common/SwipeRow.tsx";
import { EmptyBox } from "./common/load.tsx";
import { Button } from "./ui/button.tsx";
import { Badge } from "./ui/badge.tsx";
import { TaskListRowContent } from "./TaskListRowContent.tsx";
import type { Task } from "../lib/backlogTree.ts";
import {
  buildTaskRowMeta,
  taskRowsHaveMeta,
  type TaskRowMetaContext,
  type TaskRowPresentation,
} from "../lib/taskRowMeta.ts";
import type { WorktreeHostingMap } from "../lib/worktreeHosting.ts";
import type { DirtyWorktrees } from "../lib/worktreeDirty.ts";
import type { WorkflowIndicators } from "../lib/workflowIndicator.ts";
import {
  buildProjectLayerNodes,
  buildTaskNodes,
  collectExpandableIds,
  filterNodesByProject,
  filterNodesByStatus,
  isProjectNodeKey,
  projectViewDrop,
  reorderPlacements,
  statusFilterActive,
  type BacklogDensity,
  type BacklogNode,
  type BacklogNodeData,
  type BacklogProjectFilter,
  type TaskPlacement,
} from "../lib/backlogTreeModel.ts";
import { persistentStore } from "../lib/persistentStore.ts";

const INDENT_WIDTH = 22;
const TIGHT_INDENT_WIDTH = 12;
const TASK_COLLAPSE_KEY = "backlog.collapsedTasks";
const PROJECT_COLLAPSE_KEY = "backlog.collapsedProjects";
/**
 * The longest a swiped row is held back after the list has already dropped it.
 * `SwipeRow` says when it has finished leaving and that is what normally
 * releases the row; this is the backstop for the endings that never get there —
 * a filter change or a view switch unmounting the row mid-flight — because a
 * held row nothing releases is a Task that stays on screen after it was
 * archived. It sits between the two things `SwipeRow` owns: comfortably longer
 * than the exit (~340 ms), which it must not cut short, and landing before the
 * row's own come-back (`EXIT_ABANDON_MS`), so a hold can never resurrect a row
 * already drawn back. The second half is not a comparison of the two numbers,
 * which are equal — the come-back's timer starts an exit later — so read
 * `EXIT_ABANDON_MS` before changing either.
 */
const LEAVING_MAX_MS = 1000;

/**
 * A row still leaving, with the place in the list it has to keep until it has.
 *
 * `groupId` is the SWIPED row: one archive takes a Task and its finished
 * subtasks, and every row of that subtree has to be held and then released
 * together, on the one exit the gesture animates.
 */
type LeavingRow = { task: Task; index: number; groupId: string };

export type ProjectAssignTarget = { projectId: string | null; label: string };

/**
 * @component BacklogTreePane
 * @purpose The Backlog list body, built on the generic `components/common/Tree`:
 * the Normal view (task hierarchy with drag-reorder/reparent, multi-select,
 * keyboard) and the By-Project view (projects as collapsible depth-0 nodes;
 * dragging tasks across project nodes reassigns their `projectId`). The status
 * filter (passed in) prunes both views to matching rows, keeping ancestors as
 * dimmed context.
 * @useWhen Rendering the durable-Task list (via BacklogList) on the full Tasks
 * page, in the sidebar Tasks tab, or as a Task picker — `density` says which.
 * @avoidWhen A non-Task hierarchy; use `components/common/Tree` directly.
 * @intent Presentational + interaction only; the page owns the optimistic task
 * order and project-assignment/undo state and receives `onReorder` (full
 * placements) and `onAssignProjectsForRoots` (selection roots → target project).
 * Normal-view reorder works even while filtered: the move is reconstructed
 * against the full task tree so hidden rows keep their place.
 * @related lib/backlogTreeModel.ts, components/common/Tree.tsx, TaskManagementPage.tsx
 */
export function BacklogTreePane({
  tasks,
  viewMode,
  statuses,
  projectFilter,
  projectFilterActive,
  projectsById,
  activeProjects,
  sessionById,
  worktreeNames,
  hosting,
  dirtyWorktrees,
  workflowIndicators,
  today,
  selectedId,
  onOpen,
  onReorder,
  onAssignProjectsForRoots,
  onArchive,
  canQuickArchive,
  onDelete,
  onOpenSession,
  onStartSession,
  onClearFilters,
  onNavigate,
  density,
  presentation = "browser",
  flush = false,
  showProjectBadge,
}: {
  tasks: Task[];
  viewMode: "normal" | "project";
  statuses: Set<TaskStatus>;
  projectFilter: BacklogProjectFilter;
  projectFilterActive: boolean;
  /**
   * Per-row project chip. Defaults to the flat view (the project-layer view
   * already groups by project); a list SCOPED to one project passes false — the
   * chip would repeat that project on every row, and on a phone it does so at
   * the cost of the title.
   */
  showProjectBadge?: boolean | undefined;
  projectsById: Map<string, ProjectRecord>;
  activeProjects: ProjectRecord[];
  /** Live sessions, for the OBSERVED row signals (`lib/taskActivity.ts`). */
  sessionById: Map<string, SessionListItem>;
  worktreeNames?: TaskRowMetaContext["worktreeNames"];
  /** The app's PR/CI projection, for the row's delivery chip; see `TaskRowMeta`. */
  hosting?: WorktreeHostingMap | undefined;
  /** Worktrees with uncommitted changes, for the row's dirty dot; same rule. */
  dirtyWorktrees?: DirtyWorktrees | undefined;
  /** Active/paused Workflow Run markers per Task. */
  workflowIndicators?: WorkflowIndicators | undefined;
  /** Today as YYYY-MM-DD; passed in so one clock drives the whole surface. */
  today: string;
  selectedId: string | null;
  onOpen: (id: string) => void;
  onReorder: (placements: TaskPlacement[]) => void;
  onAssignProjectsForRoots: (
    rootIds: string[],
    target: ProjectAssignTarget,
  ) => void;
  /**
   * Gmail-style archive (recoverable) of the focused/selected task rows.
   * Answers with the ids it archived — a Task's finished subtasks go with it —
   * or `null` when it refused (`lib/taskArchiveRun.ts` refuses out loud
   * instead). That answer is what lets a swiped row animate its whole subtree
   * out.
   */
  onArchive?: (ids: string[]) => string[] | null;
  /**
   * Whether a row may be archived in one swipe. Rows that answer false keep
   * the `e` key and inspector, which explain a refusal rather than doing nothing.
   */
  canQuickArchive?: (task: Task) => boolean;
  /** Gmail-style delete (with confirm) of the focused/selected task rows. */
  onDelete?: ((ids: string[]) => void) | undefined;
  /**
   * The browser row's session action at either density: open an existing
   * session or start one when it has none. Pass BOTH or neither.
   */
  onOpenSession?: ((sessionId: string) => void) | undefined;
  onStartSession?: ((task: Task) => void) | undefined;
  onClearFilters: () => void;
  /** How this app navigates, for the links on a row's second line
   *  (`TaskRowBody`). A surface that passes none states those facts as text. */
  onNavigate?: ((path: string) => void) | undefined;
  /** How much room a row gets, decided by the host (`BacklogDensity`). */
  density: BacklogDensity;
  /** Picker content is single-line; browser content keeps metadata at either density. */
  presentation?: TaskRowPresentation;
  /** Edge-to-edge, hairline-divided rows (`Tree`'s `flush`). */
  flush?: boolean;
}) {
  const statusActive = statusFilterActive(statuses);
  const picker = presentation === "picker";
  const rowsShowProjectBadge = showProjectBadge ?? viewMode === "normal";
  // The second line's facts, bound once for the whole list and asked per row.
  const metaContext = useMemo<TaskRowMetaContext>(
    () => ({
      today,
      sessionById,
      worktreeNames,
      ...(hosting !== undefined ? { hostingByWorktree: hosting } : {}),
      ...(dirtyWorktrees !== undefined ? { dirtyWorktrees } : {}),
      ...(workflowIndicators !== undefined
        ? { workflowByTask: workflowIndicators }
        : {}),
      // Compact pickers keep a single line; full rows put the Project above
      // the title, matching Focus.
      showProjectBadge: rowsShowProjectBadge,
    }),
    [
      today,
      sessionById,
      worktreeNames,
      hosting,
      dirtyWorktrees,
      workflowIndicators,
      rowsShowProjectBadge,
    ],
  );

  // A swiped row is archived on the wire before it can finish leaving, and the
  // Task list comes back without it a frame or two later. `leaving` holds those
  // rows in the list for exactly as long as the exit takes, so the gap closes on
  // the animation instead of on the round trip.
  const leaving = useLeavingRows();
  const rows = useMemo(
    () => mergeLeavingRows(tasks, leaving.held),
    [tasks, leaving.held],
  );

  const nodes = useMemo<BacklogNode[]>(() => {
    if (viewMode === "project") {
      return filterNodesByStatus(
        buildProjectLayerNodes(
          rows,
          projectsById,
          activeProjects,
          projectFilter,
        ),
        statuses,
      );
    }
    // Normal view: full task hierarchy pruned by project then status filter.
    return filterNodesByStatus(
      filterNodesByProject(buildTaskNodes(rows), projectFilter),
      statuses,
    );
  }, [rows, viewMode, projectsById, activeProjects, projectFilter, statuses]);

  // Collapse state, persisted per view. Tree is expansion-controlled, so we
  // store collapsed ids and expose `expandableIds \ collapsed`.
  const collapseKey =
    viewMode === "project" ? PROJECT_COLLAPSE_KEY : TASK_COLLAPSE_KEY;
  const [collapsed, setCollapsed] = useState<Set<string>>(() =>
    loadIds(collapseKey),
  );
  useEffect(() => setCollapsed(loadIds(collapseKey)), [collapseKey]);

  const expandableIds = useMemo(() => collectExpandableIds(nodes), [nodes]);
  const expandedIds = useMemo(
    () => expandableIds.filter((id) => !collapsed.has(id)),
    [expandableIds, collapsed],
  );
  const onExpandedChange = (ids: string[]) => {
    const expanded = new Set(ids);
    const next = new Set(expandableIds.filter((id) => !expanded.has(id)));
    setCollapsed(next);
    persistIds(collapseKey, next);
  };
  // Multi-selection (group ops). When it collapses to a single task we open it
  // and fall back to highlighting the route-selected row.
  const [multiSelected, setMultiSelected] = useState<string[]>([]);
  const treeSelectedIds =
    multiSelected.length > 1 ? multiSelected : selectedId ? [selectedId] : [];
  const onSelectionChange = (ids: string[]) => {
    // A row on its way out is not a row to open: it is already archived.
    const taskIds = ids.filter(
      (id) => !isProjectNodeKey(id) && !leaving.ids.has(id),
    );
    if (taskIds.length > 1) {
      setMultiSelected(taskIds);
      return;
    }
    setMultiSelected([]);
    if (taskIds.length === 1) onOpen(taskIds[0]!);
  };

  // Gmail-style row actions on the focused/selected task rows. Project nodes are
  // ignored (only task ids act) and the keys are documented in the `?` overlay.
  const rowActions = useMemo<TreeRowAction[]>(() => {
    const isTask = (node: TreeNode<unknown>) =>
      (node.data as BacklogNodeData).kind === "task";
    const taskIdsOnly = (ids: string[]) =>
      ids.filter((id) => !isProjectNodeKey(id));
    const list: TreeRowAction[] = [];
    if (onArchive) {
      list.push({
        keys: ["e"],
        label: "Archive task",
        enabled: isTask,
        run: (ids) => {
          const taskIds = taskIdsOnly(ids);
          if (taskIds.length) onArchive(taskIds);
        },
      });
    }
    if (onDelete) {
      list.push({
        keys: ["#", "delete"],
        label: "Delete task",
        enabled: isTask,
        run: (ids) => {
          const taskIds = taskIdsOnly(ids);
          if (taskIds.length) onDelete(taskIds);
        },
      });
    }
    return list;
  }, [onArchive, onDelete]);

  // The touch half of the same actions, one per side: a RIGHTWARD pull archives
  // and a LEFTWARD one deletes. Each is offered only where it will succeed — a
  // swipe cannot explain a refusal, so a row that would refuse must not slide —
  // which is why the two sides come and go independently: the quick archive is
  // narrow (a finished Task whose whole subtree passes), while delete is offered
  // wherever the `#` key is, on any Task.
  //
  // The directions are not interchangeable. Archive is the frequent, recoverable
  // one and takes the side a right thumb reaches most easily; delete faces the
  // other way, so the two cannot be confused by muscle memory, and it commits to
  // a QUESTION rather than to the act (`useBacklog`'s `deleteTasks` confirms),
  // which is what makes an irreversible action safe to put under a thumb at all.
  //
  // Not gated on the mobile breakpoint: `SwipeRow` ignores every pointer that
  // is not a finger, so this is inert on a mouse and still there on a tablet
  // wide enough to get the desktop layout.
  const quickArchive = onArchive && canQuickArchive;
  const rowSwipe = useMemo(() => {
    if (!quickArchive && !onDelete) return undefined;
    return (node: TreeNode<BacklogNodeData>): TreeRowSwipe | null => {
      const data = node.data;
      if (data.kind !== "task") return null;
      const task = data.task;
      // A row already leaving keeps its swipe: it is what is animating it out,
      // and taking it away mid-flight would snap the row back into the list.
      const held = leaving.ids.has(task.id);
      const archive: SwipeAction | undefined =
        quickArchive && (held || canQuickArchive(task))
          ? {
              // One word for the whole swipe: past the threshold the panel
              // changes treatment, not wording, so what is legible mid-gesture
              // is the state of the gesture rather than a second thing to read.
              label: "Archive",
              icon: <Archive size={14} />,
              run: () => {
                const archived = onArchive([task.id]);
                // The hold follows the ANSWER, and is batched into the render
                // the gesture ends on. A refusal leaves the row exactly as it
                // was — including the user's collapse state for it, which is
                // theirs and is persisted.
                if (!archived) return false;
                // An archive takes the row's finished subtasks with it
                // (`docs/tasks.md`), so the hold covers the whole set: the epic
                // and its subtree leave on this one exit instead of the children
                // blinking out the moment the Task list answers, a frame ahead
                // of the parent. A collapsed subtree is held too — invisible,
                // but it keeps the parent's own row identity stable while it
                // slides.
                leaving.hold(
                  archived.flatMap((id) => {
                    const index = rows.findIndex((row) => row.id === id);
                    const row = index < 0 ? undefined : rows[index];
                    return row ? [{ task: row, index }] : [];
                  }),
                  task.id,
                );
                return true;
              },
            }
          : undefined;
      const remove: SwipeAction | undefined = onDelete
        ? {
            label: "Delete",
            icon: <Trash2 size={14} />,
            tone: "danger",
            // No `true` here, and no hold: the swipe opens the confirmation and
            // the row goes home behind it. The rows leave when the answer does,
            // if it is yes — animating them out on the gesture would show the
            // deletion happening while the question is still on screen, and the
            // question is the point.
            run: () => onDelete([task.id]),
          }
        : undefined;
      if (!archive && !remove) return null;
      return {
        ...(archive !== undefined ? { right: archive } : {}),
        ...(remove !== undefined ? { left: remove } : {}),
        onExited: () => leaving.release(task.id),
      };
    };
  }, [quickArchive, onArchive, onDelete, canQuickArchive, leaving, rows]);

  if (
    nodes.length === 0 ||
    (viewMode === "project" &&
      nodes.every((n) => (n.children ?? []).length === 0) &&
      statusActive)
  ) {
    return (
      <FilteredEmptyState
        filtered={statusActive || projectFilterActive}
        onClear={onClearFilters}
      />
    );
  }

  return (
    <Tree<BacklogNodeData>
      items={nodes}
      indentWidth={picker ? TIGHT_INDENT_WIDTH : INDENT_WIDTH}
      compact={density === "tight"}
      paddedContent={false}
      getRowClassName={() => "group/item"}
      getRowDisclosure={(node) => picker || node.data.kind === "project"}
      flush={flush}
      // Only project headers and compact pickers retain a separate disclosure gutter.
      rowAlign={picker ? "center" : "stretch"}
      // A Project header is one line, so its chevron centres on it.
      getRowAlign={(node) =>
        picker || node.data.kind === "project" ? "center" : "stretch"
      }
      // Flush (the sidebar), a Project header is the rail's group band — the
      // same one the Focus view and the Pull Requests rail draw.
      getRowBand={flush ? (node) => node.data.kind === "project" : undefined}
      showGuides={false}
      aria-label="Backlog"
      expandedIds={expandedIds}
      onExpandedChange={onExpandedChange}
      selectedIds={treeSelectedIds}
      onSelectionChange={onSelectionChange}
      rowActions={rowActions.length ? rowActions : undefined}
      rowSwipe={rowSwipe}
      shortcutsTitle="Task list"
      onMove={(result) =>
        handleMoveResult(
          result,
          viewMode,
          tasks,
          nodes,
          projectsById,
          onReorder,
          onAssignProjectsForRoots,
        )
      }
      canDrag={(node) => node.data.kind === "task" && !leaving.ids.has(node.id)}
      renderNode={(node, state) => (
        <BacklogRowContent
          node={node}
          state={state}
          onToggle={() =>
            onExpandedChange(
              state.expanded
                ? expandedIds.filter((id) => id !== node.id)
                : [...expandedIds, node.id],
            )
          }
          showProjectBadge={rowsShowProjectBadge}
          projectsById={projectsById}
          metaContext={metaContext}
          onOpenSession={onOpenSession}
          onStartSession={onStartSession}
          onNavigate={onNavigate}
          density={density}
          presentation={presentation}
        />
      )}
    />
  );
}

/**
 * The rows this list is still animating out, held past the moment the Task list
 * dropped them.
 *
 * Archiving is not optimistic — the row goes when the server's next Task list
 * says so, which on a local server is the next frame. That is far faster than
 * the swipe's exit, so without this the row would be unmounted mid-flight and
 * the list would jump exactly as it did before. A held row is released by
 * `SwipeRow`'s `onExited`, or by the backstop timer for the endings that never
 * reach it (see `LEAVING_MAX_MS`).
 */
function useLeavingRows(): {
  held: LeavingRow[];
  ids: Set<string>;
  hold: (rows: { task: Task; index: number }[], groupId: string) => void;
  release: (groupId: string) => void;
} {
  const [held, setHeld] = useState<LeavingRow[]>([]);
  const timers = useRef(new Map<string, number>());

  // Releases the whole group the swiped row leads: its subtasks left with it, so
  // they may not outlive its exit by so much as a frame.
  const release = useCallback((groupId: string) => {
    const timer = timers.current.get(groupId);
    if (timer != null) window.clearTimeout(timer);
    timers.current.delete(groupId);
    setHeld((current) =>
      current.some((row) => row.groupId === groupId)
        ? current.filter((row) => row.groupId !== groupId)
        : current,
    );
  }, []);

  const hold = useCallback(
    (rows: { task: Task; index: number }[], groupId: string) => {
      setHeld((current) => {
        const fresh = rows
          .filter(
            (row) => !current.some((kept) => kept.task.id === row.task.id),
          )
          .map((row) => ({ ...row, groupId }));
        return fresh.length === 0 ? current : [...current, ...fresh];
      });
      const running = timers.current.get(groupId);
      if (running != null) window.clearTimeout(running);
      timers.current.set(
        groupId,
        window.setTimeout(() => release(groupId), LEAVING_MAX_MS),
      );
    },
    [release],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const ids = useMemo(() => new Set(held.map((row) => row.task.id)), [held]);
  return useMemo(
    () => ({ held, ids, hold, release }),
    [held, ids, hold, release],
  );
}

/** The list plus the rows it has dropped that are still on their way out. */
function mergeLeavingRows(tasks: Task[], held: LeavingRow[]): Task[] {
  if (held.length === 0) return tasks;
  const present = new Set(tasks.map((task) => task.id));
  const missing = held.filter((row) => !present.has(row.task.id));
  if (missing.length === 0) return tasks;
  // Back at the index it was taken from, not appended: the tree orders by
  // `sortOrder` and falls back to recency, so a list the user has never dragged
  // would otherwise send the row to the bottom on its way out.
  const merged = tasks.slice();
  for (const row of missing.sort((a, b) => a.index - b.index)) {
    // An index nothing matched (`findIndex` found no row) goes to the END: a
    // hold exists to keep a row still, and the top of the list is the furthest
    // it could possibly move.
    const at =
      row.index < 0 ? merged.length : Math.min(row.index, merged.length);
    merged.splice(at, 0, row.task);
  }
  return merged;
}

// Keeps the Tree's `onMove` a thin closure: a hierarchy drag becomes placements
// for reorder; a project-view drag reassigns the dragged subtree(s) to the
// project resolved from the literal drop target.
function handleMoveResult(
  result: {
    id: string;
    ids: string[];
    parentId: string | null;
    index: number;
    overId: string | null;
    items: BacklogNode[];
  },
  viewMode: "normal" | "project",
  tasks: Task[],
  nodes: BacklogNode[],
  projectsById: Map<string, ProjectRecord>,
  onReorder: (placements: TaskPlacement[]) => void,
  onAssignProjectsForRoots: (
    rootIds: string[],
    target: ProjectAssignTarget,
  ) => void,
) {
  if (viewMode === "project") {
    const drop = projectViewDrop(tasks, nodes, projectsById, result);
    if (!drop) return;
    const anchorId = result.ids[0] ?? result.id;
    const currentProject =
      tasks.find((t) => t.id === anchorId)?.projectId?.trim() || null;
    // Cross-project: reassign the dragged subtree(s) to the target project AND
    // position them at the drop spot. Same project: just reorder.
    if (currentProject !== drop.targetProjectId) {
      onAssignProjectsForRoots(result.ids, {
        projectId: drop.targetProjectId,
        label: drop.targetLabel,
      });
    }
    onReorder(drop.placements);
    return;
  }
  // Reconstruct the move against the full tree so reorder is correct even when a
  // filter hides rows.
  onReorder(reorderPlacements(tasks, result));
}

function BacklogRowContent({
  node,
  state,
  onToggle,
  showProjectBadge,
  projectsById,
  metaContext,
  onOpenSession,
  onStartSession,
  onNavigate,
  density,
  presentation,
}: {
  node: TreeNode<BacklogNodeData>;
  state: TreeNodeState;
  onToggle: () => void;
  showProjectBadge: boolean;
  projectsById: Map<string, ProjectRecord>;
  metaContext: TaskRowMetaContext;
  onOpenSession?: ((sessionId: string) => void) | undefined;
  onStartSession?: ((task: Task) => void) | undefined;
  onNavigate?: ((path: string) => void) | undefined;
  density: BacklogDensity;
  presentation: TaskRowPresentation;
}) {
  if (node.data.kind === "project") {
    const data = node.data;
    return (
      <div
        className={`flex min-w-0 items-center gap-2 px-2 ${density === "tight" ? "" : "py-0.5"}`}
      >
        {/* The Project glyph every other surface uses — its folder in its
            colour — rather than a colour dot; muted for Unassigned and for a
            Project the registry no longer knows. */}
        <FolderKanban
          size={14}
          className={`shrink-0 ${data.dot ? "" : "opacity-70"}`}
          style={data.dot ? { color: data.dot } : undefined}
          aria-hidden
        />
        {/* No colour of its own: the row says it — the foreground on a page,
            white on the sidebar's band — and an unknown Project is dimmed. */}
        <span
          className={`min-w-0 flex-1 truncate text-sm font-semibold ${data.known || data.projectId === null ? "" : "opacity-70"}`}
        >
          {data.label}
        </span>
        <span className="shrink-0 text-sm opacity-70">{data.taskCount}</span>
      </div>
    );
  }

  const { task, context } = node.data;
  return (
    <TaskListRowContent
      task={task}
      meta={taskRowsHaveMeta(presentation) ? buildTaskRowMeta(task, metaContext) : null}
      projectsById={projectsById}
      selected={state.selected}
      dimmed={Boolean(context)}
      density={density}
      showProjectBadge={showProjectBadge}
      onOpenSession={onOpenSession}
      onStartSession={onStartSession}
      onNavigate={onNavigate}
      disclosure={state.hasChildren ? (
        <Badge
          variant="ghost"
          render={<button type="button" />}
          aria-expanded={state.expanded}
          aria-label={`${state.expanded ? "Hide" : "Show"} sub-tasks of "${task.title}"`}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          className="h-auto shrink-0 cursor-pointer border-0 px-0 py-0 font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
        >
          <ChevronRight size={12} className={state.expanded ? "rotate-90" : ""} aria-hidden />
          Sub-tasks <span>{node.children?.length}</span>
        </Badge>
      ) : undefined}
    />
  );
}

function FilteredEmptyState({
  filtered,
  onClear,
}: {
  filtered: boolean;
  onClear: () => void;
}) {
  return (
    <EmptyBox
      className="bg-card"
      action={
        filtered ? (
          <Button variant="outline" size="sm" onClick={onClear}>
            Clear filters
          </Button>
        ) : undefined
      }
    >
      {filtered
        ? "No Tasks match the current filters."
        : "No tasks yet. Add your first one above."}
    </EmptyBox>
  );
}

function loadIds(key: string): Set<string> {
  try {
    const raw = persistentStore().getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function persistIds(key: string, ids: Set<string>): void {
  try {
    persistentStore().setItem(key, JSON.stringify([...ids]));
  } catch {
    // Ignore storage failures; collapse state still applies for this render.
  }
}
