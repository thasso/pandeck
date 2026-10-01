import type { TaskItem, TaskSessionRef } from "@assistant/shared";
import { linkSessionToObject } from "./db/sessionObjectStore.ts";
import { errorText } from "./errors.ts";
import { linkSessionToTask, readTask, updateTask } from "./tasks.ts";

/**
 * Record that a session was started from a Task and return the Task as it stands
 * after the `todo → doing` nudge. Callers build Task context from this returned
 * row so prompt context and storage cannot disagree.
 *
 * Linking is deliberately best-effort: a metadata failure must not prevent a
 * session from receiving its assignment. The Task read happens first, so even a
 * later failure still returns authoritative context.
 */
export function linkTaskStart(
  taskId: string,
  ref: TaskSessionRef,
): TaskItem | null {
  let task: TaskItem | null = null;
  try {
    task = readTask(taskId);
    if (!task) return null;
    linkSessionToTask(taskId, {
      ...ref,
      origin: "task-start",
      attachedAt: Date.now(),
    });
    linkSessionToObject(ref.sessionId, "task", taskId, "initial-context");
    if (task.status === "todo") task = updateTask(taskId, { status: "doing" });
  } catch (err) {
    console.warn("Failed to link task to session:", errorText(err));
  }
  return task;
}
