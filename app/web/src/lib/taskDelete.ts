import { descendantsOf } from "./taskArchive.ts";
import type { Task } from "./backlogTree.ts";

/**
 * @module taskDelete
 * @purpose WHICH rows one delete act really takes, and how that act asks for
 *   permission. One rule for every delete path: the swipe, the tree's `#` key,
 *   the row menu.
 * @intent A delete is SUBTREE-shaped for the same structural reason an archive
 *   is (`taskArchive.ts`): the SERVER promotes a deleted Task's children to
 *   roots rather than removing them, so deleting an epic on its own scatters its
 *   subtasks across the top level, detached from the Task that explained them
 *   and with no way back. Taking the subtree is what makes "delete this Task"
 *   mean what it looks like it means.
 * @intent Where the two acts part company is UNFINISHED work. The archive
 *   cascade refuses to tidy away subtasks nobody finished, and can afford to:
 *   the parent is still there, one Undo away. A delete has no such offer, so
 *   there is nothing to leave the unfinished rows attached TO — the cascade
 *   takes them, and the confirmation is where they are declared. That is why
 *   this module hands its caller a count to show rather than deciding alone.
 * @intent Pure and React-free, so the set and the wording are unit-testable and
 *   every path asks the same question.
 */

/**
 * The rows deleting `ids` really takes: each requested Task and every
 * descendant, deduplicated, DEEPEST FIRST.
 *
 * The order is not cosmetic. Each `deleteTask` reports the deleted Task's
 * children as newly parentless, so a parent removed first makes the list
 * momentarily draw its subtasks as roots — rows jumping to the top level in the
 * instant before they too disappear. Removing leaves first means every Task is
 * childless by the time it goes, and nothing is ever promoted.
 */
export function deleteSet(tasks: Task[], ids: string[]): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const out: string[] = [];
  const seen = new Set<string>();
  const take = (id: string) => {
    if (seen.has(id) || !byId.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const id of ids) {
    take(id);
    for (const child of descendantsOf(tasks, id)) take(child.id);
  }
  // Depth is read off the TREE rather than off the walk, so the order does not
  // depend on the order the ids arrived in: a child requested before its own
  // parent still sorts below it.
  const depthOf = (id: string): number => {
    let depth = 0;
    let current = byId.get(id);
    const guard = new Set<string>();
    while (current && !guard.has(current.id)) {
      guard.add(current.id);
      const parent = current.parentId ? byId.get(current.parentId) : undefined;
      if (!parent) break;
      depth += 1;
      current = parent;
    }
    return depth;
  };
  const depth = new Map(out.map((id) => [id, depthOf(id)]));
  return out.sort((a, b) => (depth.get(b) ?? 0) - (depth.get(a) ?? 0));
}

/**
 * What the confirmation says. The subtree is named in the QUESTION, not left
 * for the user to discover afterwards: "Delete this Task?" answered on a row
 * with children is a different act from the one it appears to be, and this is
 * the only moment at which that can still be declined.
 */
export function deleteConfirmation(
  tasks: Task[],
  targets: string[],
  doomed: string[],
): { title: string; body: string } {
  const title = (() => {
    if (targets.length === 1) {
      const task = tasks.find((item) => item.id === targets[0]);
      return `Delete Task “${task?.title ?? ""}”?`;
    }
    return `Delete ${targets.length} Tasks?`;
  })();
  const extra = doomed.length - targets.length;
  const subtasks =
    extra > 0
      ? ` This also deletes ${extra} ${extra === 1 ? "subtask" : "subtasks"}.`
      : "";
  return { title, body: `This cannot be undone.${subtasks}` };
}
