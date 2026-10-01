import type { SessionListItem } from "@assistant/shared";
import { pendingStatusSuggestion, type Task } from "./backlogTree.ts";
import { isTaskWorking } from "./taskActivity.ts";

/**
 * @module taskArchive
 * @purpose WHICH rows one archive act really takes, when it may happen, and when
 *   the quick (one-gesture) archive is OFFERED at all. One rule, evaluated in
 *   every archive path: the swipe, the row button, the tree's `e` key and the
 *   inspector's menu item.
 * @intent Pure and React-free so both `useBacklog` and `App.tsx`'s inspector
 *   wiring answer the question identically, and so the matrix is unit-testable.
 *
 * An archive act is SUBTREE-shaped, because a Task's subtasks are not separate
 * work: archiving a Task takes its FINISHED descendants with it (`archiveSet`).
 * The alternative is the damage this module exists to prevent — hiding one row
 * while `flattenTasks` promotes its children to the root, which leaves finished
 * subtasks scattered at the top level, detached from the epic that explained
 * them, and lets the next Backlog drag persist that detachment.
 *
 * What the cascade deliberately does NOT take is UNFINISHED descendants: being
 * marked done is not a licence to tidy away work nobody finished, so those
 * refuse the archive instead (and the refusal offers the whole subtree as its
 * escape hatch). Every rule below is therefore asked of the whole archive set,
 * not of the row you are looking at.
 */

/** Why an archive was refused, and which target was the reason. */
export type ArchiveBlocker = { taskId: string } & (
  | {
      /** Descendants are still open, and not being archived in the same act. */
      kind: "open-subtasks";
      /** The open descendants, so the caller can offer to take them along. */
      openIds: string[];
    }
  | {
      /** An agent's status claim is still waiting for the user's answer. */
      kind: "pending-suggestion";
    }
  | {
      /** A session started FROM this Task is streaming right now. */
      kind: "working";
    }
);

export interface ArchiveContext {
  /** Every Task in the list — the subtree lookup needs more than the targets. */
  tasks: Task[];
  /** Live sessions, for the OBSERVED "working" signal. */
  sessionById: Map<string, SessionListItem>;
}

type TaskIndex = {
  byId: Map<string, Task>;
  childrenByParent: Map<string, Task[]>;
};

/**
 * The id/child indexes for one Task list, cached on the ARRAY.
 *
 * These questions are asked per row per render — the tree asks
 * `quickArchiveOffered` for the swipe and again for the row button — so
 * rebuilding two full-list Maps inside each call is quadratic in a list this
 * repo sizes at ~220 rows. The callers already hand over a memoized array
 * (`useBacklog`'s `ordered`, App's `backlogTasks`), so its identity is exactly
 * the right cache key: a new array is new data, and an unchanged one is not.
 *
 * What the cache does NOT flatten is the subtree walk: `archiveBlocker` asks
 * `descendantsOf` once per member of the archive set, so one row's question
 * costs a traversal per row of its own subtree. That is fine at the shallow,
 * few-child epics this backlog holds — the walk is over the child index, not the
 * list — but a deep hierarchy would want the open-descendant scan hoisted out of
 * the per-member loop rather than a bigger cache.
 */
const indexCache = new WeakMap<Task[], TaskIndex>();

function indexOf(tasks: Task[]): TaskIndex {
  const cached = indexCache.get(tasks);
  if (cached) return cached;
  const byId = new Map<string, Task>();
  const childrenByParent = new Map<string, Task[]>();
  for (const task of tasks) {
    byId.set(task.id, task);
    if (!task.parentId) continue;
    const siblings = childrenByParent.get(task.parentId) ?? [];
    siblings.push(task);
    childrenByParent.set(task.parentId, siblings);
  }
  const index = { byId, childrenByParent };
  indexCache.set(tasks, index);
  return index;
}

/** Every descendant of `id`, depth-first and cycle-safe. Excludes `id` itself. */
export function descendantsOf(tasks: Task[], id: string): Task[] {
  const children = indexOf(tasks).childrenByParent;
  const out: Task[] = [];
  const seen = new Set<string>([id]);
  const visit = (parentId: string) => {
    for (const child of children.get(parentId) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child);
      visit(child.id);
    }
  };
  visit(id);
  return out;
}

/**
 * The rows archiving `ids` really takes: each requested Task, plus every
 * FINISHED descendant of it, parent before child and deduplicated.
 *
 * This is what keeps the hierarchy intact. A done epic's done subtasks leave
 * WITH it — they are the same finished work, and left behind they would be
 * promoted to the root, detached from the epic. Rows already archived are not
 * in the set: they need no archiving, and including them would make Undo
 * restore something the user archived earlier and separately.
 *
 * Unfinished descendants are taken only when they were REQUESTED (the refusal's
 * "Archive all N" hatch passes the whole subtree); otherwise `archiveBlocker`
 * refuses the act, so nothing is tidied away by cascade.
 */
export function archiveSet(ids: string[], ctx: ArchiveContext): string[] {
  const requested = new Set(ids);
  const { byId } = indexOf(ctx.tasks);
  const out: string[] = [];
  const seen = new Set<string>();
  const take = (id: string) => {
    if (seen.has(id)) return;
    const task = byId.get(id);
    if (!task || task.archivedAt) return;
    seen.add(id);
    out.push(id);
  };
  for (const id of ids) {
    take(id);
    for (const child of descendantsOf(ctx.tasks, id)) {
      if (child.status === "done" || requested.has(child.id)) take(child.id);
    }
  }
  return out;
}

/**
 * Why archiving `ids` (as ONE act) must not happen, or `null` when it may.
 *
 * Asked of the whole `archiveSet`, never of the requested ids alone: everything
 * the act would take has to be a row the user is done with. So an unanswered
 * status claim or a live session on a subtask the cascade would carry off
 * refuses the epic — that row is not being promoted to the root any more, so
 * archiving it really would take the question away with it.
 *
 * The set also decides what counts as stranded: an open subtask that is itself
 * being archived in the same request strands nothing, so archiving a whole epic
 * — parent and children requested together — is allowed while archiving just
 * its head is not.
 */
export function archiveBlocker(
  ids: string[],
  ctx: ArchiveContext,
): ArchiveBlocker | null {
  const taking = archiveSet(ids, ctx);
  const set = new Set(taking);
  const { byId } = indexOf(ctx.tasks);
  for (const id of taking) {
    const task = byId.get(id);
    if (!task) continue;
    // A live session outranks the rest: whatever the statuses say, someone is
    // on it right now and the row has to stay where they can see it.
    if (isTaskWorking(task, ctx.sessionById))
      return { kind: "working", taskId: id };
    // "Done" that only an agent has claimed is a QUESTION, and the Focus view
    // is the only surface that can answer one. Archiving would delete the
    // question along with the row — including when the row is a subtask the
    // cascade would take, which is why this is asked of the whole set.
    if (pendingStatusSuggestion(task))
      return { kind: "pending-suggestion", taskId: id };
    const openIds = descendantsOf(ctx.tasks, id)
      .filter((child) => child.status !== "done" && !child.archivedAt)
      .filter((child) => !set.has(child.id))
      .map((child) => child.id);
    if (openIds.length) return { kind: "open-subtasks", openIds, taskId: id };
  }
  return null;
}

/**
 * Should the QUICK archive (swipe, row button) be offered on this row?
 *
 * Narrower than "is archiving allowed": a one-gesture archive is offered only
 * for finished work. A Task you have not finished can still be archived from
 * the tree's `e` key or the inspector — deciding not to do something is a real
 * decision — but it is not something a thumb should be able to do by accident.
 */
export function quickArchiveOffered(task: Task, ctx: ArchiveContext): boolean {
  if (task.status !== "done") return false;
  if (task.archivedAt) return false;
  return archiveBlocker([task.id], ctx) === null;
}

/** The refusal, as the user reads it. */
export function archiveBlockerMessage(
  blocker: ArchiveBlocker,
  taskTitle?: string,
): string {
  const subject = taskTitle ? `“${taskTitle}”` : "That Task";
  switch (blocker.kind) {
    case "working":
      return `${subject} has a session running right now.`;
    case "pending-suggestion":
      return `${subject} is waiting on your answer to an agent's status claim.`;
    case "open-subtasks": {
      const n = blocker.openIds.length;
      return `${subject} still has ${n} unfinished ${n === 1 ? "subtask" : "subtasks"}.`;
    }
  }
}
