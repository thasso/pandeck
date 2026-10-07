import { applyPatch } from "@assistant/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ProjectRecord,
  SessionListItem,
  TaskProjectAssignmentUpdate,
  TaskStatus,
} from "@assistant/shared";
import {
  taskMutationKey,
  type AssistantActions,
  type UIState,
} from "./useAssistant.ts";
import type { Prefs } from "./usePrefs.ts";
import {
  acceptStatusSuggestionSave,
  nextStatus,
  orderByPlacements,
  orderTasks,
  placementsFromTasks,
  samePlacements,
  type Task,
  type TaskPlacement,
} from "../lib/backlogTree.ts";
import {
  ALL_PROJECT_FILTER,
  type BacklogProjectFilter,
  type BacklogView,
  type BacklogViewMode,
} from "../lib/backlogTreeModel.ts";
import { buildProjectsById } from "../lib/projectDisplay.ts";
import {
  buildBacklogProjectFilterOptions,
  type BacklogProjectFilterOption,
} from "../components/BacklogFilters.tsx";
import type { ProjectAssignTarget } from "../components/BacklogTreePane.tsx";
import { useDialogs } from "../components/ui/dialogs.tsx";
import {
  dismissToastKey,
  PROJECT_ASSIGNMENT_TOAST_KEY,
  showToast,
  TOAST_DWELL_MS,
} from "../lib/toast.ts";
import {
  quickArchiveOffered,
  type ArchiveContext,
} from "../lib/taskArchive.ts";
import { runTaskArchive } from "../lib/taskArchiveRun.ts";
import { deleteConfirmation, deleteSet } from "../lib/taskDelete.ts";

export type { BacklogViewMode };

/**
 * Exactly the app state a Backlog surface reads.
 *
 * Narrow on purpose: the sidebar's Backlog is rendered inside a memoized
 * `Sidebar`, and taking the whole `UIState` would re-render every Task row on
 * every streamed transcript token. Widening this means widening what makes the
 * left pane re-render, so add a slice only when a Backlog surface truly needs it.
 */
// `worktreeMerge` rides along because the Worktrees inbox needs the LIVE
// conflict phase, and this narrow slice is what the memoized sidebar takes
// instead of the whole UIState.
export type BacklogState = Pick<
  UIState,
  | "connected"
  | "taskList"
  | "taskListError"
  | "projectList"
  | "taskMutations"
  | "taskProjectsAssignedSeq"
  | "sessions"
  | "worktreeMerge"
>;

/**
 * The Backlog's own writes, correlated by REQUEST rather than recognised by the
 * sentence the server sent back. A wording is not an interface: matching on one
 * put a failure about something else onto this surface, and stopped matching at
 * all the moment anyone reworded it (`docs/messaging.md`).
 */
const REORDER_MUTATION_KEY = taskMutationKey(null, "reorder");
const ASSIGN_PROJECTS_MUTATION_KEY = taskMutationKey(null, "assignProjects");
const ALL_STATUS_FILTER: TaskStatus[] = ["todo", "doing", "done"];
type ProjectAssignmentSnapshot = Array<{
  id: string;
  projectId: string | null;
}>;

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

export interface BacklogController {
  ordered: Task[];
  /**
   * Whether the Task subscription has ANSWERED. `ordered` is `[]` both before
   * the answer and when the answer is "no Tasks", and only this tells the two
   * apart — a surface that draws "No tasks yet" without checking it says the
   * user's Backlog is gone every time the list is cold (R1,
   * `app/web/docs/loading-states.md`).
   */
  loaded: boolean;
  view: BacklogView;
  setView: (view: BacklogView) => void;
  viewMode: BacklogViewMode;
  setViewMode: (mode: BacklogViewMode) => void;
  projectFilter: BacklogProjectFilter;
  setProjectFilter: (filter: BacklogProjectFilter) => void;
  projectFilterActive: boolean;
  statuses: Set<TaskStatus>;
  setStatusFilter: (next: TaskStatus[]) => void;
  projectFilterOptions: BacklogProjectFilterOption[];
  projectsLoaded: boolean;
  projectsById: Map<string, ProjectRecord>;
  activeProjects: ProjectRecord[];
  sessionById: Map<string, SessionListItem>;
  /**
   * The Task list could not be read: a CONDITION on the collection, kept by the
   * reducer from the failure's TARGET and rendered by every Backlog surface
   * whenever the user is on one (`docs/messaging.md`). Retained rows stay
   * readable underneath it (R2).
   */
  listError: string | null;
  reorderError: string | null;
  cycleStatus: (item: Task) => void;
  /** Accept an agent's status suggestion: move the Task where it says. */
  acceptSuggestion: (item: Task) => void;
  /** Dismiss the suggestion and leave the Task where it is. */
  dismissSuggestion: (item: Task) => void;
  /** Take a Task out of the Inbox: seen, nothing to do. */
  dismissFromInbox: (item: Task) => void;
  /**
   * Archive one or more Tasks as ONE act (recoverable): shows a receipt with
   * Undo, or refuses with the reason when `lib/taskArchive.ts` says the rows
   * must stay visible. Returns the ids it archived — a Task's finished subtasks
   * travel with it — or `null` when it refused, so a surface that has to move
   * the rows itself (the swipe animates them out) knows both which happened and
   * which rows are leaving.
   */
  archiveTasks: (ids: string[]) => string[] | null;
  /** Whether the QUICK archive (swipe, row button) is offered on this row. */
  canQuickArchive: (task: Task) => boolean;
  /** Permanently delete one or more Tasks after a confirmation prompt. */
  deleteTasks: (ids: string[]) => void;
  reorderTasks: (placements: TaskPlacement[]) => void;
  assignProjectsForRoots: (
    rootIds: string[],
    target: ProjectAssignTarget,
  ) => void;
  clearFilters: () => void;
}

/**
 * Shared Backlog list controller: optimistic task order (with reorder
 * error-recovery), view mode, project + status filters, project registry/session
 * derivations, and the project-assignment (with undo toast) + reorder handlers.
 * Used by both the full Backlog page and the sidebar Backlog tab so they behave
 * identically. View mode, project filter, and status filter are all persisted
 * via prefs (browser-local), so a chosen filter setup sticks across reloads and
 * stays consistent across both surfaces.
 */
export function useBacklog(
  state: BacklogState,
  actions: AssistantActions,
  prefs: Prefs,
  onUpdatePrefs: (patch: Partial<Prefs>) => void,
): BacklogController {
  const dialogs = useDialogs();
  const view = prefs.backlogView;
  const setView = (next: BacklogView) => onUpdatePrefs({ backlogView: next });
  const viewMode = prefs.backlogViewMode;
  const setViewMode = (mode: BacklogViewMode) =>
    onUpdatePrefs({ backlogViewMode: mode });
  const projectFilter = prefs.backlogProjectFilter;
  const setProjectFilter = (filter: BacklogProjectFilter) =>
    onUpdatePrefs({ backlogProjectFilter: filter });
  const statuses = useMemo(
    () => new Set(prefs.backlogStatusFilter),
    [prefs.backlogStatusFilter],
  );

  const items = useMemo(() => state.taskList?.items ?? [], [state.taskList]);
  // `null` is NOT LOADED, and the `?? []` above deliberately erases that for
  // every derivation that only wants rows. `loaded` carries it out instead, so
  // the surfaces can gate their empty states on it.
  const loaded = state.taskList !== null;
  const [ordered, setOrdered] = useState<Task[]>(() => orderTasks(items));
  const [reorderError, setReorderError] = useState<string | null>(null);

  useEffect(() => {
    setOrdered(orderTasks(items));
  }, [items]);

  const reorderMutation = state.taskMutations[REORDER_MUTATION_KEY];
  useEffect(() => {
    if (reorderMutation?.status !== "error") return;
    // Only the Backlog's own voice for the failure. The RECOVERY is not this
    // hook's job any more: a refused reorder re-reads the authoritative list
    // (docs/state-sync.md — recovery is a refetch, never a stored inverse), and
    // restoring a remembered order here would fight that answer and could undo
    // a concurrent writer's move with nothing left to repair it.
    setReorderError("Couldn't move that Task. Restoring the previous order.");
  }, [reorderMutation]);

  const projectFilterActive = projectFilter.kind !== "all";

  const reorderTasks = (placements: TaskPlacement[]) => {
    if (samePlacements(placements, placementsFromTasks(ordered))) return;
    setReorderError(null);
    setOrdered((current) => orderByPlacements(current, placements));
    actions.reorderTasks(
      placements.map((placement) => placement.id),
      placements,
    );
  };

  const cycleStatus = (item: Task) => {
    actions.saveTask({
      id: item.id,
      status: nextStatus(item.status),
    });
  };

  // Both answers to a status suggestion are ordinary user saves, which is what
  // makes the server clear it: accepting is a status CHANGE, while rejecting
  // changes nothing and so has to say so explicitly.
  const acceptSuggestion = (item: Task) => {
    const to = item.statusSuggestion?.to;
    if (!to) return;
    actions.saveTask(acceptStatusSuggestionSave({ id: item.id, to }));
  };

  const dismissSuggestion = (item: Task) => {
    actions.saveTask({
      id: item.id,
      status: item.status,
      clearStatusSuggestion: true,
    });
  };

  // Every other way of processing a Task already triages it server-side, so
  // this is only the act that changes nothing else.
  const dismissFromInbox = (item: Task) => {
    actions.saveTask({
      id: item.id,
      status: item.status,
      triaged: true,
    });
  };

  const byId = useMemo(
    () => new Map(ordered.map((task) => [task.id, task])),
    [ordered],
  );

  const confirmDeleteTasks = async (ids: string[]) => {
    const targets = ids.filter((id) => byId.has(id));
    if (targets.length === 0) return;
    // Subtree-shaped, and deepest first (`lib/taskDelete.ts`): the server
    // promotes a deleted Task's children to roots, so deleting a parent alone
    // scatters its subtasks instead of removing them.
    const doomed = deleteSet(ordered, targets);
    const { title, body } = deleteConfirmation(ordered, targets, doomed);
    const confirmed = await dialogs.confirm({
      title,
      body,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    for (const id of doomed) actions.deleteTask(id);
  };
  // The Backlog's `deleteTasks` is a plain `() => void` action: the
  // confirmation settles rather than rejecting, and each `deleteTask` reports
  // through the task list's own error state.
  const deleteTasks = (ids: string[]) => void confirmDeleteTasks(ids);

  const projectsLoaded = state.projectList !== null;
  const projects = useMemo(
    () => state.projectList?.projects ?? [],
    [state.projectList],
  );
  const activeProjects = useMemo(
    () => projects.filter((p) => p.status !== "archived"),
    [projects],
  );
  const projectsById = useMemo(() => buildProjectsById(projects), [projects]);
  const projectFilterOptions = useMemo(
    () =>
      buildBacklogProjectFilterOptions(ordered, activeProjects, projectsById),
    [ordered, activeProjects, projectsById],
  );
  const sessionById = useMemo(() => {
    const map = new Map<string, SessionListItem>();
    for (const session of state.sessions) map.set(session.id, session);
    return map;
  }, [state.sessions]);

  // Archiving reads the whole list (a Task's subtree decides whether it may go)
  // and the live sessions, so it is bound once here and asked per row.
  const archiveContext = useMemo<ArchiveContext>(
    () => ({ tasks: ordered, sessionById }),
    [ordered, sessionById],
  );
  const archiveTasks = useCallback(
    (ids: string[]) => runTaskArchive(ids, archiveContext, actions),
    [archiveContext, actions],
  );
  const canQuickArchive = useCallback(
    (task: Task) => quickArchiveOffered(task, archiveContext),
    [archiveContext],
  );

  const pendingProjectUndoRef = useRef<{
    snapshot: ProjectAssignmentSnapshot;
    targetLabel: string;
    count: number;
  } | null>(null);
  const projectUndoToastUpdateRef = useRef<number | null>(null);

  const childrenByParentId = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const item of ordered) {
      if (!item.parentId) continue;
      const children = map.get(item.parentId) ?? [];
      children.push(item);
      map.set(item.parentId, children);
    }
    return map;
  }, [ordered]);

  const subtreeSnapshotFor = (id: string): ProjectAssignmentSnapshot => {
    const byId = new Map(ordered.map((item) => [item.id, item]));
    const snapshot: ProjectAssignmentSnapshot = [];
    const visit = (taskId: string) => {
      const item = byId.get(taskId);
      if (!item) return;
      snapshot.push({ id: item.id, projectId: item.projectId ?? null });
      for (const child of childrenByParentId.get(taskId) ?? []) visit(child.id);
    };
    visit(id);
    return snapshot;
  };

  const applyLocalProjectAssignments = (
    updates: TaskProjectAssignmentUpdate[],
  ) => {
    const byId = new Map(
      updates.map((update) => [
        update.id,
        update.projectId?.trim() || undefined,
      ]),
    );
    setOrdered((current) =>
      current.map((item) =>
        byId.has(item.id)
          ? applyPatch(item, { projectId: byId.get(item.id) })
          : item,
      ),
    );
  };

  const assignProjectsForRoots = (
    rootIds: string[],
    target: ProjectAssignTarget,
  ) => {
    const seen = new Set<string>();
    const snapshot: ProjectAssignmentSnapshot = [];
    for (const rootId of rootIds) {
      for (const item of subtreeSnapshotFor(rootId)) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        snapshot.push(item);
      }
    }
    const updates = snapshot
      .filter((item) => (item.projectId ?? null) !== target.projectId)
      .map((item) => ({ id: item.id, projectId: target.projectId }));
    if (updates.length === 0) return;
    pendingProjectUndoRef.current = {
      snapshot,
      targetLabel: target.label,
      count: updates.length,
    };
    projectUndoToastUpdateRef.current = null;
    dismissToastKey(PROJECT_ASSIGNMENT_TOAST_KEY);
    applyLocalProjectAssignments(updates);
    actions.assignTaskProjects(updates);
  };

  const setStatusFilter = (next: TaskStatus[]) =>
    onUpdatePrefs({ backlogStatusFilter: next });
  const clearFilters = () => {
    onUpdatePrefs({
      backlogProjectFilter: ALL_PROJECT_FILTER,
      backlogStatusFilter: ALL_STATUS_FILTER,
    });
  };

  // The write landing is an ARRIVAL, reported by the reducer's counter. This
  // used to watch for a notice whose wording it recognised — which is not an
  // interface, and broke as soon as that notice was deleted for announcing a
  // change the user can already see (`docs/messaging.md`).
  useEffect(() => {
    if (state.taskProjectsAssignedSeq === 0) return;
    const pending = pendingProjectUndoRef.current;
    if (!pending) return;
    if (projectUndoToastUpdateRef.current === state.taskList?.updatedAt) return;
    projectUndoToastUpdateRef.current = state.taskList?.updatedAt ?? null;
    showToast(
      `Assigned ${pending.count} ${plural(pending.count, "Task")} to ${pending.targetLabel}.`,
      {
        key: PROJECT_ASSIGNMENT_TOAST_KEY,
        tone: "success",
        durationMs: TOAST_DWELL_MS,
        action: {
          label: "Undo",
          onClick: () => {
            const current = pendingProjectUndoRef.current;
            if (!current) return;
            const updates = current.snapshot.map((item) => ({
              id: item.id,
              projectId: item.projectId,
            }));
            applyLocalProjectAssignments(updates);
            actions.assignTaskProjects(updates);
            pendingProjectUndoRef.current = null;
            dismissToastKey(PROJECT_ASSIGNMENT_TOAST_KEY);
          },
        },
      },
    );
    // `actions` is stable for the life of the app, and the two refs above gate
    // this to one receipt per landed write, so listing it changes nothing.
  }, [state.taskProjectsAssignedSeq, state.taskList?.updatedAt, actions]);

  // Bookkeeping, and deliberately NOT a message: the failure itself is said at
  // its arrival (`useAssistant`, into this same toast slot), because a receipt
  // raised from the stored record would be re-announced by every remount that
  // found it still there. This only drops the Undo the failed write can no
  // longer offer — without it, the receipt effect above pairs that dead
  // snapshot with a later assignment's counter and offers an Undo of nothing.
  //
  // What this record isolates is THIS write from every other message, which is
  // what the old text match could not do: reading a global carrier's CONTENT
  // meant a later successful retry showed its Undo and then had it torn down
  // again by the previous attempt's failure. It does NOT isolate one assignment
  // from the next — the record is keyed by operation, and the pending snapshot
  // beside it is a single slot the newer assignment has already overwritten. So
  // two overlapping assignments share one receipt, and the failure of either
  // ends it. Separating them means giving the receipt a snapshot per request,
  // which is a change to the receipt, not to this teardown.
  const assignmentMutation = state.taskMutations[ASSIGN_PROJECTS_MUTATION_KEY];
  useEffect(() => {
    if (assignmentMutation?.status !== "error") return;
    pendingProjectUndoRef.current = null;
  }, [assignmentMutation]);

  return {
    ordered,
    loaded,
    view,
    setView,
    viewMode,
    setViewMode,
    projectFilter,
    setProjectFilter,
    projectFilterActive,
    statuses,
    setStatusFilter,
    projectFilterOptions,
    projectsLoaded,
    projectsById,
    activeProjects,
    sessionById,
    listError: state.taskListError,
    reorderError,
    cycleStatus,
    acceptSuggestion,
    dismissSuggestion,
    dismissFromInbox,
    archiveTasks,
    canQuickArchive,
    deleteTasks,
    reorderTasks,
    assignProjectsForRoots,
    clearFilters,
  };
}
