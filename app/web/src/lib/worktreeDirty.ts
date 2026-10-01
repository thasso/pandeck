/**
 * Which of a Backlog's OWN worktrees have uncommitted changes — the one derived
 * slice of `worktreeStatuses` that may reach a memoized Task row.
 *
 * The full statuses record cannot: it is rewritten by every watcher push (a
 * moved HEAD, a changed file count, a fresh `updatedAt` on a scan that found
 * nothing), and the Backlog it would reach is the memoized sidebar list — ~226
 * rows, measured at 6.3 ms, on a phone. So the slice is narrowed twice over.
 * By VALUE: a worktree being dirty is a boolean that flips a handful of times a
 * day, while the counts behind it (`4 files +120 −38`) move on every keystroke
 * an agent makes. And by SCOPE: only the worktrees the loaded Tasks actually
 * link to (`lib/taskActivity.ts`'s `taskWorktreeIds`) are looked at, so the
 * worktree behind the conversation you have open — watched, and going dirty as
 * you work in it — cannot repaint a list where no row could have changed.
 *
 * {@link dirtyWorktreeKey} is what makes it hold: the same dirty set must be the
 * same OBJECT across broadcasts, or the memo it feeds is decorative.
 */
import type { WorktreeGitStatus } from "@assistant/shared";

/** Worktree ids with uncommitted changes. Absent id = clean OR not known. */
export type DirtyWorktrees = ReadonlySet<string>;

/** One shared empty set, so a surface with no statuses keeps a stable prop. */
export const NO_DIRTY_WORKTREES: DirtyWorktrees = new Set<string>();

/**
 * The dirty ids among `scope`, in a stable order so {@link dirtyWorktreeKey}
 * answers on CONTENT.
 *
 * It walks the SCOPE rather than the statuses, which is what keeps the slice
 * bounded by the Backlog rather than by however many worktrees this browser has
 * ever watched. A scoped id with no status yet is left out — unknown, not clean.
 */
export function dirtyWorktreeIds(
  statuses: Record<string, WorktreeGitStatus>,
  scope: readonly string[],
): string[] {
  const ids: string[] = [];
  for (const id of scope) if (statuses[id]?.dirty) ids.push(id);
  return ids.sort();
}

/** Whether a fresh derivation SAYS anything new; see {@link dirtyWorktreeIds}. */
export function dirtyWorktreeKey(ids: readonly string[]): string {
  return ids.join("\n");
}
