import { applyPatch } from "@assistant/shared";
import type {
  TaskSaveRequest,
  TaskStatus,
  TaskSummary,
} from "@assistant/shared";

/**
 * Shared Backlog tree logic (no React/JSX) so the sidebar Backlog tab and future
 * task list surfaces can flatten, order, and triage the same parent/child Task
 * tree without pulling a React page module into their bundles. Keep this file
 * pure: ordering, flattening,
 * status cycling, answering status suggestions, and browser-local collapse
 * persistence only.
 */
/**
 * A Backlog row. Always a SUMMARY: Task lists never carry the Markdown body —
 * that is fetched per Task (`getTask`) and cached in `useAssistant`'s
 * `taskDetails`.
 */
export type Task = TaskSummary;
export type TaskPlacement = { id: string; parentId?: string | null };
export type FlatTask = {
  item: Task;
  depth: number;
  childCount: number;
  descendantCount: number;
  doneDescendantCount: number;
  hidden: boolean;
  collapsed: boolean;
};

const EMPTY_COLLAPSED: Set<string> = new Set();

export function nextStatus(status: TaskStatus): TaskStatus {
  return status === "todo" ? "doing" : status === "doing" ? "done" : "todo";
}

/**
 * The agent suggestion still WAITING for an answer, if any.
 *
 * A suggestion whose `to` already equals the Task's status has been answered:
 * it stays on the Task as provenance — how it got there — but it is no longer a
 * question, so nothing may paint it as one. That state is reached by the
 * `userRequestedStatus` escape hatch, where the agent applies the status the
 * user asked for AND records the claim; without this rule every "done at your
 * request" Task would carry a disputed-looking amber glyph forever, with no
 * surface offering to dismiss it.
 */
export function pendingStatusSuggestion(
  task: Pick<Task, "status" | "statusSuggestion">,
): TaskSummary["statusSuggestion"] {
  const suggestion = task.statusSuggestion;
  return suggestion && suggestion.to !== task.status ? suggestion : undefined;
}

/**
 * The save that ACCEPTS a status suggestion, wherever it is answered — the Focus
 * row and the transcript's Task card must produce the same state, so they build
 * the request here rather than each assembling their own.
 *
 * It is an ordinary user save (that is what makes the server clear the claim),
 * and it clears the suggestion explicitly rather than relying on the status
 * CHANGE doing it: an agent that already applied the status at the user's
 * request leaves a suggestion whose answer changes nothing, and that row must
 * still resolve.
 *
 * It carries NO title. Confirming a status is not a rename, and one of the
 * surfaces answering a suggestion is a recorded transcript card whose title is
 * frozen at mutation time — echoing that copy back would rewrite a Task renamed
 * since. `TaskSaveRequest.title` is optional on an update for exactly this.
 */
export function acceptStatusSuggestionSave(task: {
  id: string;
  to: TaskStatus;
}): TaskSaveRequest {
  return {
    id: task.id,
    status: task.to,
    clearStatusSuggestion: true,
  };
}

/**
 * Display order: `sortOrder` within each sibling group, which the server gives
 * every Task when it joins one (`taskStore.nextSortOrder`) — so a row's place is
 * decided when it arrives and only a drag moves it afterwards.
 */
export function orderTasks(items: Task[]): Task[] {
  return flattenTasks(items).map((entry) => entry.item);
}

/**
 * Flattens the parent/child task tree into depth-tagged rows. Descendant counts
 * (used for the parent progress rollup) always reflect the full subtree, but rows
 * inside a collapsed ancestor are dropped from the output so callers render and
 * drag only the currently visible rows. Hidden children keep their `parentId`, so
 * they still follow their parent through reorder/persistence.
 */
export function flattenTasks(
  items: Task[],
  collapsedIds: Set<string> = EMPTY_COLLAPSED,
): FlatTask[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const children = new Map<string, Task[]>();
  const directChildCount = new Map<string, number>();
  for (const item of items) {
    const parentId =
      item.parentId && item.parentId !== item.id && byId.has(item.parentId)
        ? item.parentId
        : "";
    const bucket = children.get(parentId) ?? [];
    bucket.push(item);
    children.set(parentId, bucket);
    if (parentId)
      directChildCount.set(parentId, (directChildCount.get(parentId) ?? 0) + 1);
  }

  const out: FlatTask[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (parentId: string, depth: number, hidden: boolean) => {
    const siblings = [...(children.get(parentId) ?? [])].sort(compareTaskOrder);
    for (const item of siblings) {
      if (visiting.has(item.id) || visited.has(item.id)) continue;
      visiting.add(item.id);
      const childCount = directChildCount.get(item.id) ?? 0;
      const collapsed = childCount > 0 && collapsedIds.has(item.id);
      const entry: FlatTask = {
        item,
        depth,
        childCount,
        descendantCount: 0,
        doneDescendantCount: 0,
        hidden,
        collapsed,
      };
      out.push(entry);
      const before = out.length;
      visit(item.id, depth + 1, hidden || collapsed);
      const descendants = out.slice(before);
      entry.descendantCount = descendants.length;
      entry.doneDescendantCount = descendants.filter(
        (descendant) => descendant.item.status === "done",
      ).length;
      visiting.delete(item.id);
      visited.add(item.id);
    }
  };

  visit("", 0, false);
  if (visited.size !== items.length) {
    for (const item of [...items].sort(compareTaskOrder)) {
      if (!visited.has(item.id))
        out.push({
          item,
          depth: 0,
          childCount: 0,
          descendantCount: 0,
          doneDescendantCount: 0,
          hidden: false,
          collapsed: false,
        });
    }
  }
  return out.filter((entry) => !entry.hidden);
}

/**
 * The Backlog tree is the HAND-ARRANGED view, so nothing MUTABLE may decide a
 * row's place: working on a Task — cycling its status, scheduling it, assigning
 * it a project — moves `updatedAt`, and using that as the tie-break made rows
 * jump for reasons the list never explains.
 *
 * The server now gives every Task a free position as it joins a sibling group,
 * so a tie is a LEGACY row (created before that) or a position a caller stated
 * itself through `task_manage`. Either way the fallback is arrival — newest
 * first, which is where a fresh capture belongs — and then the id, so the answer
 * is total and never depends on a field that a status change moves. This is the
 * safety net; the placement rule lives in `taskStore.nextSortOrder`.
 */
function compareTaskOrder(a: Task, b: Task): number {
  const ao = a.sortOrder;
  const bo = b.sortOrder;
  if (ao != null && bo != null) return ao - bo || compareArrival(a, b);
  if (ao != null) return 1;
  if (bo != null) return -1;
  return compareArrival(a, b);
}

function compareArrival(a: Task, b: Task): number {
  return b.createdAt - a.createdAt || compareTaskId(a.id, b.id);
}

/** Task ids are numeric strings; a lexical compare would put 10 before 9. */
function compareTaskId(a: string, b: string): number {
  const an = Number(a);
  const bn = Number(b);
  return Number.isFinite(an) && Number.isFinite(bn)
    ? an - bn
    : a < b
      ? -1
      : a > b
        ? 1
        : 0;
}

export function placementsFromTasks(
  tasks: Task[],
  collapsedIds?: Set<string>,
): TaskPlacement[] {
  return flattenTasks(tasks, collapsedIds).map((entry) => ({
    id: entry.item.id,
    parentId: entry.item.parentId ?? null,
  }));
}

export function samePlacements(
  a: TaskPlacement[],
  b: TaskPlacement[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (placement, index) =>
        placement.id === b[index]?.id &&
        (placement.parentId ?? null) === (b[index]?.parentId ?? null),
    )
  );
}

export function orderByPlacements(
  items: Task[],
  placements: TaskPlacement[],
): Task[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const restored: Task[] = [];
  const siblingIndex = new Map<string, number>();
  for (const placement of placements) {
    const item = byId.get(placement.id);
    if (!item) continue;
    const parentId = placement.parentId ?? undefined;
    const key = parentId ?? "";
    const sortOrder = siblingIndex.get(key) ?? 0;
    siblingIndex.set(key, sortOrder + 1);
    restored.push(applyPatch(item, { parentId, sortOrder }));
    seen.add(placement.id);
  }
  return [...restored, ...items.filter((item) => !seen.has(item.id))];
}
