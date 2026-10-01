/**
 * What is actually HAPPENING to a Task right now, derived from its linked
 * sessions rather than from its status field.
 *
 * Status is the user's judgement and is routinely stale: agents start work and
 * forget to move a Task to `doing`, and a Task left in `doing` says nothing
 * about whether anyone is on it. So "working" is OBSERVED — a linked session is
 * streaming — which needs no agent to be honest about anything.
 *
 * The link filter is the whole point. `TaskSessionRef.origin` distinguishes a
 * session STARTED from the Task (`task-start`) from one that merely REFERENCES
 * it (`reference`) — which is what a
 * scanner, a search, or a conversation that happened to mention the Task
 * produces. Counting those would light up a Task because something looked at
 * it, which is exactly the false signal this must not give.
 */
import type { SessionListItem, TaskSessionRef } from "@assistant/shared";
import type { Task } from "./backlogTree.ts";

/** Does this reference mean the session WORKED on the Task, not just saw it? */
export function isWorkingRef(ref: TaskSessionRef): boolean {
  return ref.origin === "task-start";
}

/** True when a session that was started FROM this Task is streaming right now. */
export function isTaskWorking(
  task: Task,
  sessionById: Map<string, SessionListItem>,
): boolean {
  for (const ref of task.sessionRefs ?? []) {
    if (!isWorkingRef(ref)) continue;
    if (sessionById.get(ref.sessionId)?.isStreaming) return true;
  }
  return false;
}

/**
 * The DISTINCT worktrees a list of Tasks has work in, by the same rule a row
 * draws its worktree glyph from ({@link taskStartSession}).
 *
 * This is the Backlog's whole reach into worktree state, and both halves of it
 * read this one answer: what the app holds a live git-status WATCH for while
 * these rows are on screen, and which worktrees' dirty flags may reach the
 * memoized list (`lib/worktreeDirty.ts`). Watched set, marked set, and
 * re-render trigger are then the same set by construction — a worktree these
 * Tasks have nothing to do with can go dirty without repainting a single row.
 *
 * Sorted, so the caller's identity key answers on content.
 */
export function taskWorktreeIds(
  tasks: readonly Task[],
  sessionById: Map<string, SessionListItem>,
): string[] {
  const ids = new Set<string>();
  for (const task of tasks) {
    const worktreeId = taskStartSession(task, sessionById)?.worktreeId;
    if (worktreeId) ids.add(worktreeId);
  }
  return [...ids].sort();
}

/**
 * The ONE session a Task row acts on: the work that was started from this Task,
 * streaming first and otherwise the most recently touched.
 *
 * Only sessions the caller's map actually holds count, and never an ARCHIVED
 * one: a row's primary action must not lead nowhere (which is why the old hover
 * `+` came off these rows) and must not depend on whether the user happens to
 * have expanded the sidebar's archive — a broadcast omits archived rows until
 * then, so counting them would make the same Task offer "open" or "start"
 * depending on an unrelated piece of sidebar state. A Task whose only session is
 * gone or put away offers to start the work again.
 *
 * The caller's map must be as fresh as this claim: `lib/sessionRows.ts`'s
 * `backlogSessionsKey` is what keeps the Backlog's gated copy fresh in the
 * fields read here. The `updatedAt` tie-break is the one exception it cannot
 * cover (see that key) — it picks between sessions that both exist.
 */
export function taskStartSession(
  task: Task,
  sessionById: Map<string, SessionListItem>,
): SessionListItem | null {
  let best: SessionListItem | null = null;
  for (const ref of task.sessionRefs ?? []) {
    if (!isWorkingRef(ref)) continue;
    const session = sessionById.get(ref.sessionId);
    if (!session || session.archived) continue;
    if (session.isStreaming) return session;
    if (!best || session.updatedAt > best.updatedAt) best = session;
  }
  return best;
}
