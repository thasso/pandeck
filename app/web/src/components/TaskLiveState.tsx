import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { TaskSummary } from "@assistant/shared";
import type { TaskStatusRecord, UIState } from "../hooks/useAssistant.ts";

/**
 * The CURRENT state of a Task a transcript card names, published by the app
 * around the main transcript.
 *
 * A recorded `task_manage` result is frozen at mutation time, and the session
 * route holds no Task subscription, so a card asking the user to confirm a
 * status suggestion cannot tell from its own payload that the question was
 * answered — after a reload it would ask again. The card reads
 * `state.taskStatuses` instead: a confirm's `taskSaved` reply lands there, and
 * a reload asks the server for it.
 *
 * A context rather than a prop: only the cards consume it, so a read re-renders
 * them and not the memoized transcript rows around them.
 */
export interface TaskLiveSource {
  /** `state.taskStatuses`: every Task this tab has read or saved. */
  statuses: Record<string, TaskStatusRecord | null>;
  /**
   * The newest summary of each Task among the lists this tab holds: the
   * Backlog's (possibly a cached list nothing keeps fresh) and the viewed
   * session's linked and related Tasks, which the server rebroadcasts after a
   * `task_manage`. A card takes whichever of this and its record is newer.
   */
  listed: ReadonlyMap<string, TaskSummary>;
  /** A read is only sent, and a lost one only retried, while connected. */
  connected: boolean;
  /** Ask the server for one Task; a request already in flight is not repeated. */
  request: (id: string) => void;
}

const TaskLiveSourceContext = createContext<TaskLiveSource | null>(null);

export function TaskLiveSourceProvider({
  source,
  children,
}: {
  /** Hold this stable while it says the same thing — cards re-render on it. */
  source: TaskLiveSource;
  children: ReactNode;
}) {
  return (
    <TaskLiveSourceContext.Provider value={source}>
      {children}
    </TaskLiveSourceContext.Provider>
  );
}

/** The source the app publishes, from its reducer state and the detail read. */
export function useTaskLiveSourceValue(
  state: Pick<UIState, "taskStatuses" | "taskList" | "connected" | "session">,
  request: (id: string) => void,
): TaskLiveSource {
  const backlog = state.taskList?.items;
  const linked = state.session?.tasks;
  const related = state.session?.relatedGlobalTasks;
  const listed = useMemo(() => {
    const newest = new Map<string, TaskSummary>();
    for (const list of [backlog, linked, related])
      for (const task of list ?? []) {
        const held = newest.get(task.id);
        if (!held || task.updatedAt > held.updatedAt) newest.set(task.id, task);
      }
    return newest;
  }, [backlog, linked, related]);
  return useMemo(
    () => ({
      statuses: state.taskStatuses,
      listed,
      connected: state.connected,
      request,
    }),
    [state.taskStatuses, listed, state.connected, request],
  );
}

/** The app's live Task source, or null outside the shell (tests, previews). */
export function useTaskLiveSource(): TaskLiveSource | null {
  return useContext(TaskLiveSourceContext);
}
