import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import {
  taskMutationKey,
  type AssistantActions,
} from "../hooks/useAssistant.ts";
import type { Prefs } from "../hooks/usePrefs.ts";
import { useBacklog, type BacklogState } from "../hooks/useBacklog.ts";
import { usePerfRenderCount } from "../lib/perfStats.ts";
import { pendingStatusSuggestion, type Task } from "../lib/backlogTree.ts";
import {
  statusFilterFor,
  taskMatchesProjectFilter,
  type BacklogDensity,
  type BacklogProjectFilter,
} from "../lib/backlogTreeModel.ts";
import { FOCUS_STATUS_OPTIONS, BacklogToolbar } from "./BacklogToolbar.tsx";
import { todayIso } from "./calendar/calendarDates.ts";
import { useUserTimeZone } from "../hooks/useUserTimeZone.ts";
import { BacklogTreePane } from "./BacklogTreePane.tsx";
import { BacklogFocusList } from "./BacklogFocusList.tsx";
import { BacklogInboxList } from "./BacklogInboxList.tsx";
import { hasInboxWork } from "../lib/backlogInbox.ts";
import { ErrorNote, Skeleton, Spinner } from "./common/load.tsx";
import { errorOf, idle, isPending } from "../lib/loadState.ts";
import type { WorktreeHostingMap } from "../lib/worktreeHosting.ts";
import type { DirtyWorktrees } from "../lib/worktreeDirty.ts";
import type { WorkflowIndicators } from "../lib/workflowIndicator.ts";

/**
 * @component BacklogList
 * @purpose The shared Backlog list surface — add-task (optional), the controls
 * toolbar (view switcher, Project filter, status chips, By-Project toggle) and
 * the list BODY for the selected view: `BacklogTreePane` (the hand-arranged
 * hierarchy with drag reorder, reparent and project reassignment),
 * `BacklogFocusList` (the when-grouped Focus list) or `BacklogInboxList` (the
 * triage queue for Tasks that arrived on their own). Backed by the `useBacklog`
 * controller so the full Backlog page and the sidebar Backlog tab behave
 * identically.
 * @useWhen A surface needs the durable-Task list with filtering + drag editing.
 * @avoidWhen The compact, non-filtering legacy sidebar list is sufficient.
 * @intent Self-contained: reads `state`, drives `actions`, and persists the
 * status filter via prefs. `density` is the HOST's decision (`BacklogDensity`)
 * and reaches the toolbar and every view: the sidebar rail is `tight`, a page —
 * or the same sidebar as a phone screen — is `comfortable`.
 * @related hooks/useBacklog.ts, BacklogToolbar.tsx, BacklogTreePane.tsx
 * @perf Memoized: it lives in the sidebar, where an unrelated session-list
 * broadcast would otherwise rebuild every Task row — measured at 6.3 ms for a
 * 226-Task production backlog, on a warm desktop CPU. Its `state` is the narrow
 * `BacklogState`, so it re-renders when the Backlog's own data moves and not
 * when the app around it does.
 */
function BacklogListImpl({
  state,
  actions,
  prefs,
  onUpdatePrefs,
  selectedId,
  onOpenTask,
  onOpenSession,
  onStartSessionForTask,
  onNavigate,
  hosting,
  dirtyWorktrees,
  workflowIndicators,
  fixedProjectId,
  density,
  toolbarDensity,
  showAddTask = false,
}: {
  state: BacklogState;
  actions: AssistantActions;
  prefs: Prefs;
  onUpdatePrefs: (patch: Partial<Prefs>) => void;
  selectedId: string | null;
  onOpenTask: (id: string) => void;
  /**
   * The tree row's gutter action at `comfortable` density: the session a Task's
   * work already happens in, or a new one for a Task with none. Both or neither
   * (see `BacklogTreePane`); a picker passes neither.
   */
  onOpenSession?: (sessionId: string) => void;
  onStartSessionForTask?: (taskId: string, title: string) => void;
  /**
   * How this app navigates, for the objects a two-line row NAMES on its second
   * line: the Task's id, its session, its worktree, its Project (`TaskRowBody`).
   * One handler rather than four, because every one of them is a route and the
   * links carry the `href` themselves. A surface that passes none — a picker,
   * where leaving the field would abandon what is being picked — states the same
   * facts as plain text.
   */
  onNavigate?: ((path: string) => void) | undefined;
  /**
   * The app's PR/CI projection (`hooks/useWorktreeHosting.ts`), for the delivery
   * chip on a row's second line. Optional, and only two-line surfaces pass it: a
   * `tight` list has no line 2 to put it on, and a picker states no delivery
   * rather than making the app poll for one.
   */
  hosting?: WorktreeHostingMap;
  /**
   * The worktrees with uncommitted changes (`hooks/useDirtyWorktrees.ts`), for
   * the dirty dot beside a row's worktree glyph. Passed by the same surfaces
   * and for the same reason as `hosting`: this list is memoized, so it takes a
   * slice whose identity moves only when a worktree's dirty flag flips — never
   * the raw `worktreeStatuses`, which every watcher push rebuilds.
   */
  dirtyWorktrees?: DirtyWorktrees;
  /** Active/paused Workflow Run markers, with content-stable identity. */
  workflowIndicators?: WorkflowIndicators | undefined;
  /** Scope the list to one project (e.g. the project inspector): pins the project filter and hides the project/view controls. New tasks are created in that project. */
  fixedProjectId?: string | undefined;
  /** How much room a row gets. The host decides; see `BacklogDensity`. */
  density: BacklogDensity;
  /**
   * How much room the TOOLBAR gets, when that is a different question. A row is
   * constrained by height and a row of chips by WIDTH, and the desktop rail is
   * where the two disagree: it has all the height its two-line rows need and not
   * nearly the width its filters would like, so it takes `comfortable` rows and a
   * `tight` toolbar. Defaults to `density`.
   */
  toolbarDensity?: BacklogDensity;
  showAddTask?: boolean;
}) {
  usePerfRenderCount("BacklogList");
  const c = useBacklog(state, actions, prefs, onUpdatePrefs);
  const [newTitle, setNewTitle] = useState("");
  const createSubmittedRef = useRef(false);
  const createMutation =
    state.taskMutations?.[taskMutationKey(null, "create")] ?? idle<true>();
  const createPending = isPending(createMutation);
  const createError = errorOf(createMutation);
  const reorderMutation =
    state.taskMutations?.[taskMutationKey(null, "reorder")] ?? idle<true>();
  const reorderError = errorOf(reorderMutation) ?? c.reorderError;
  useEffect(() => {
    if (!createSubmittedRef.current || createMutation.status !== "ready")
      return;
    createSubmittedRef.current = false;
    setNewTitle("");
  }, [createMutation]);
  // The gutter action's start half, bound to the row's own Task. Left undefined
  // when the host offers none — which is how a picker says it has no gutter.
  const startSessionForRow = useMemo(
    () =>
      onStartSessionForTask
        ? (task: Task) => onStartSessionForTask(task.id, task.title)
        : undefined,
    [onStartSessionForTask],
  );

  const fixedFilter: BacklogProjectFilter | null = fixedProjectId
    ? { kind: "project", projectId: fixedProjectId }
    : null;
  const projectFilter = fixedFilter ?? c.projectFilter;
  const viewMode = fixedFilter ? "normal" : c.viewMode;
  // A surface SCOPED to one project is a picker, not the Backlog: it shows that
  // project's tree and offers no view switcher, so it can never land in Focus.
  const view = fixedFilter ? "backlog" : c.view;

  // Focus filters here rather than in `BacklogTreePane`, which prunes a TREE
  // (keeping ancestors as dimmed context). A flat list has no ancestors to keep,
  // so the same filters are a plain predicate.
  // Focus NEVER shows a done Task, whatever the status filter says. It answers
  // "what should I work on", and finished work is not work — a struck-through
  // row under TODAY is noise at the top of the one view meant to be scannable.
  // It also makes the client agree with the server, whose `scheduled`/`due`
  // filters exclude done for the same reason (`app/server/src/tasks.ts`); the
  // Backlog tree stays the place completed Tasks are visible.
  //
  // An UNANSWERED status suggestion is the one exception, and it bypasses the
  // status chips with it: an agent saying a finished Task is not actually done
  // is a question, not work, and that rationale does not reach it. Focus is the
  // only surface that can answer one, so filtering it out would strand it.
  const focusTasks = useMemo(() => {
    if (view !== "focus") return [];
    // Canonical semantics: empty-or-all means NO filter. Reading the raw set
    // directly made turning both offered chips off empty the list.
    const keep = statusFilterFor(c.statuses, FOCUS_STATUS_OPTIONS);
    return c.ordered.filter((task) => {
      if (!taskMatchesProjectFilter(task, projectFilter)) return false;
      if (pendingStatusSuggestion(task)) return true;
      return task.status !== "done" && (!keep || keep.has(task.status));
    });
  }, [view, c.ordered, projectFilter, c.statuses]);
  // The Inbox honours the project filter (you may be triaging one project's
  // intake) but NOT the status chips: what is waiting is waiting, and its own
  // rules already exclude done.
  const inboxTasks = useMemo(
    () =>
      view === "inbox"
        ? c.ordered.filter((task) =>
            taskMatchesProjectFilter(task, projectFilter),
          )
        : [],
    [view, c.ordered, projectFilter],
  );
  // One clock for the whole surface. Re-read per render rather than kept in
  // state: nothing here animates, and the list is rebuilt on every task change
  // anyway — a midnight rollover lands on the next interaction, which is soon
  // enough for a list you read, not a clock you watch.
  const timeZone = useUserTimeZone();
  const today = todayIso(timeZone);
  // The dot on the Inbox chip reads the WHOLE list, not the filtered one: work
  // waiting under a project filter you happen to have on is still waiting.
  const inboxWaiting = useMemo(() => hasInboxWork(c.ordered), [c.ordered]);

  const addTask = () => {
    const title = newTitle.trim();
    if (!title) return;
    if (createPending) return;
    createSubmittedRef.current = true;
    actions.saveTask(
      {
        title,
        status: "todo",
        linkCurrentSession: false,
        ...(fixedProjectId ? { projectId: fixedProjectId } : {}),
      },
      "create",
    );
  };

  return (
    <div className="flex flex-col gap-2">
      {showAddTask ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 rounded-xl border border-line bg-panel p-2">
            <Plus size={16} className="ml-1 shrink-0 text-muted-foreground" />
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addTask();
              }}
              placeholder="Add a task…"
              className="min-w-0 flex-1 bg-transparent px-1 py-1.5 text-sm text-fg outline-none placeholder:text-faint"
            />
            <button
              type="button"
              onClick={addTask}
              disabled={!newTitle.trim() || createPending}
              aria-busy={createPending || undefined}
              className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {createPending ? <Spinner size="sm" /> : null} Add
            </button>
          </div>
          {createError ? <ErrorNote message={createError} /> : null}
        </div>
      ) : null}

      <BacklogToolbar
        density={toolbarDensity ?? density}
        view={view}
        onViewChange={c.setView}
        viewMode={viewMode}
        onViewModeChange={c.setViewMode}
        projectFilter={projectFilter}
        projectFilterOptions={c.projectFilterOptions}
        projectsById={c.projectsById}
        projectsLoaded={c.projectsLoaded}
        onProjectFilterChange={c.setProjectFilter}
        statuses={c.statuses}
        onStatusFilterChange={c.setStatusFilter}
        inboxWaiting={inboxWaiting}
        hideProjectControls={Boolean(fixedFilter)}
      />

      {/* The list could not be read: a condition on the COLLECTION, so it is
          here whenever the user is, and the retained rows stay readable below
          it (R2). Retried by asking for the list again. */}
      {c.listError ? (
        <ErrorNote
          message={c.listError}
          onRetry={() => actions.listTasks({})}
        />
      ) : null}
      {reorderError ? <ErrorNote message={reorderError} /> : null}
      {density === "comfortable" &&
      view === "backlog" &&
      c.viewMode === "project" ? (
        <p className="px-1 text-sm text-faint">
          Drag a Task onto another Project to reassign it, or within a Project
          to reorder. Collapse a Project to fold it away.
        </p>
      ) : null}

      {!c.loaded ? (
        // The Task subscription has not answered yet. Every view below draws an
        // empty state from a list that is `[]` for BOTH reasons, so none of them
        // may render until it has (R1); the rows are held open instead.
        <BacklogRowsSkeleton density={density} />
      ) : view === "inbox" ? (
        <BacklogInboxList
          tasks={inboxTasks}
          projectsById={c.projectsById}
          showProjectBadge={!fixedFilter}
          selectedId={selectedId}
          onOpen={onOpenTask}
          onCycle={c.cycleStatus}
          onDismiss={c.dismissFromInbox}
          density={density}
        />
      ) : view === "focus" ? (
        <BacklogFocusList
          tasks={focusTasks}
          today={today}
          projectsById={c.projectsById}
          sessionById={c.sessionById}
          hosting={hosting}
          dirtyWorktrees={dirtyWorktrees}
          workflowIndicators={workflowIndicators}
          showProjectBadge={!fixedFilter}
          selectedId={selectedId}
          onOpen={onOpenTask}
          onCycle={c.cycleStatus}
          onAcceptSuggestion={c.acceptSuggestion}
          onDismissSuggestion={c.dismissSuggestion}
          onNavigate={onNavigate}
          density={density}
        />
      ) : (
        <BacklogTreePane
          tasks={c.ordered}
          density={density}
          viewMode={viewMode}
          statuses={c.statuses}
          projectFilter={projectFilter}
          // A FIXED project scope (the Project page's Tasks section) is not a
          // filter anyone can clear, so it must not make an empty list claim that
          // "no Tasks match the current filters" and offer a Clear button that
          // changes nothing. A project with no tasks has no tasks yet.
          projectFilterActive={c.projectFilterActive}
          // Scoped to one project: the per-row chip would repeat it on every row.
          showProjectBadge={fixedFilter ? false : undefined}
          projectsById={c.projectsById}
          activeProjects={c.activeProjects}
          sessionById={c.sessionById}
          hosting={hosting}
          dirtyWorktrees={dirtyWorktrees}
          workflowIndicators={workflowIndicators}
          today={today}
          selectedId={selectedId}
          onOpen={onOpenTask}
          onCycle={c.cycleStatus}
          onReorder={c.reorderTasks}
          onAssignProjectsForRoots={c.assignProjectsForRoots}
          onArchive={c.archiveTasks}
          canQuickArchive={c.canQuickArchive}
          onDelete={c.deleteTasks}
          onOpenSession={onOpenSession}
          onStartSession={startSessionForRow}
          onNavigate={onNavigate}
          onClearFilters={c.clearFilters}
        />
      )}
    </div>
  );
}

/**
 * The first load's silhouette: task rows at the height the density gives them,
 * so the list does not jump when the answer lands (R4). Six rows — enough to
 * read as a list on the shortest surface that hosts one (the composer's Task
 * picker) without overshooting the sidebar rail.
 */
function BacklogRowsSkeleton({ density }: { density: BacklogDensity }) {
  const tight = density === "tight";
  return (
    <div
      role="status"
      aria-label="Loading Tasks"
      className={`flex flex-col ${tight ? "gap-1" : "gap-2"}`}
    >
      {[0, 1, 2, 3, 4, 5].map((row) => (
        <Skeleton
          key={row}
          className={tight ? "h-7" : "h-11"}
          // A real list is ragged: rows that all end together read as a table.
          style={{ width: `${[92, 78, 86, 70, 88, 64][row]}%` }}
        />
      ))}
    </div>
  );
}

export const BacklogList = memo(BacklogListImpl);
