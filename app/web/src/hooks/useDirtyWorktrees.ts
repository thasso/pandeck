import { useMemo } from "react";
import type { WorktreeGitStatus } from "@assistant/shared";
import {
  dirtyWorktreeIds,
  dirtyWorktreeKey,
  NO_DIRTY_WORKTREES,
  type DirtyWorktrees,
} from "../lib/worktreeDirty.ts";

/**
 * The Backlog's dirty-worktree slice, with a STABLE identity: the same set of
 * dirty worktrees is the same object, however many status pushes rebuilt
 * `state.worktreeStatuses` in between.
 *
 * That is the whole hook. The set reaches the memoized `BacklogList` and through
 * it every Task row, so a new object per watcher push would repaint the entire
 * Backlog to say what it already said — and the watcher pushes a full status for
 * a worktree an agent is writing in several times a second. Deriving `dirty` per
 * row from the raw record would do exactly that, which is why the raw record is
 * not in `BacklogState`.
 *
 * `scope` is the worktrees those rows can actually mark
 * (`lib/taskActivity.ts`'s `taskWorktreeIds`), so the identity does not move for
 * a worktree no row could show — see `lib/worktreeDirty.ts`. Pass it sorted and
 * referentially stable; an empty scope answers the shared empty set.
 */
export function useDirtyWorktrees(
  statuses: Record<string, WorktreeGitStatus>,
  scope: readonly string[],
): DirtyWorktrees {
  const ids = useMemo(
    () => dirtyWorktreeIds(statuses, scope),
    [statuses, scope],
  );
  const key = dirtyWorktreeKey(ids);
  // The KEY is the memo's real dependency: `ids` is a fresh array whenever any
  // status moved, and the same ids in it must not make a new Set.
  // oxlint-disable-next-line react/exhaustive-deps -- `key` IS the content of `ids`; depending on the array instead would rebuild the set on every watcher push, which is the memo this hook exists to make hold (`lib/worktreeDirty.ts`)
  return useMemo(() => (ids.length ? new Set(ids) : NO_DIRTY_WORKTREES), [key]);
}
