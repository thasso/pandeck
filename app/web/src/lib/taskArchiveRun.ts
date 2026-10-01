import { dismissToastKey, showToast, TOAST_DWELL_MS } from "./toast.ts";
import {
  archiveBlocker,
  archiveBlockerMessage,
  archiveSet,
  descendantsOf,
  type ArchiveContext,
} from "./taskArchive.ts";

/**
 * @module taskArchiveRun
 * @purpose Running an archive: the rules from `taskArchive.ts`, the refusal and
 *   its escape hatch, and the Undo receipt. Every archive path in the app goes
 *   through here — the swipe, the row button, the tree's `e` key, the
 *   inspector's menu item — so the same act cannot mean two things.
 * @intent Archiving asks NO confirmation and offers Undo instead: it is
 *   reversible on the wire (`archiveTask` with `archived: false`), and a prompt
 *   in front of a gesture meant to be fast would defeat the gesture. A REFUSAL,
 *   by contrast, is loud: silently doing nothing to a row that just slid under
 *   the finger reads as a bug.
 */

const ARCHIVE_TOAST_KEY = "backlog-archive";

export interface TaskArchiveActions {
  /** `archived=false` restores; see `useAssistant`'s `archiveTask`. */
  archiveTask: (id: string, archived?: boolean) => void;
}

function titleOf(ctx: ArchiveContext, id: string): string {
  return ctx.tasks.find((task) => task.id === id)?.title ?? "Task";
}

/**
 * The whole subtree, unfinished rows included and deduplicated: the set "Archive
 * all" sends. Rows already archived are left out so the offer's count is the
 * number of rows that will actually leave the list.
 */
function withSubtrees(ctx: ArchiveContext, ids: string[]): string[] {
  const every = ids.flatMap((id) => [
    id,
    ...descendantsOf(ctx.tasks, id).map((task) => task.id),
  ]);
  // Requesting every descendant explicitly is what makes the unfinished ones
  // part of the act rather than a cascade; `archiveSet` still owns the order,
  // the deduplication and dropping rows that are already archived.
  return archiveSet(every, ctx);
}

/** The receipt's wording: what left the list, and whether a subtree came along. */
function archiveReceipt(
  ctx: ArchiveContext,
  targets: string[],
  archived: string[],
): string {
  if (archived.length === 1) return `Archived “${titleOf(ctx, archived[0]!)}”.`;
  // One row swiped, a subtree gone: name the Task and count what followed it,
  // because "Archived 4 Tasks" after touching one row reads as a bug.
  if (targets.length === 1) {
    const extra = archived.length - 1;
    return `Archived “${titleOf(ctx, targets[0]!)}” and ${extra} ${extra === 1 ? "subtask" : "subtasks"}.`;
  }
  return `Archived ${archived.length} Tasks.`;
}

/**
 * Archive `ids` as one act, or refuse and say why. Returns the ids it archived —
 * the requested rows plus the finished subtree that went with them — or `null`
 * when nothing was archived, so a caller showing the Task can leave the surface
 * only on success and the swipe knows which rows it has to animate out.
 *
 * The refusal for an epic with open subtasks carries the honest alternative:
 * archiving the whole subtree strands nothing, so an abandoned epic is not a
 * Task the user can never get out of their list — but it has to be ASKED for,
 * which is the guardrail. "Marked done" alone never takes UNFINISHED subtasks
 * with it; the finished ones travel with their parent by construction, because
 * leaving them behind is what detaches them (see `taskArchive.ts`).
 */
export function runTaskArchive(
  ids: string[],
  ctx: ArchiveContext,
  actions: TaskArchiveActions,
): string[] | null {
  const known = new Set(ctx.tasks.map((task) => task.id));
  const targets = ids.filter((id) => known.has(id));
  // Silent by construction: every caller acts on rows it is rendering from this
  // same list, so an id the list does not know is a stale click, not a refusal
  // worth a toast. A caller that can pass unknown ids owes the user its own
  // feedback.
  if (targets.length === 0) return null;

  const blocker = archiveBlocker(targets, ctx);
  if (blocker) {
    // Name the Task that actually blocked, not the one the user happened to
    // click first — in a multi-select those are routinely different rows.
    const subject = titleOf(ctx, blocker.taskId);
    const whole =
      blocker.kind === "open-subtasks" ? withSubtrees(ctx, targets) : null;
    showToast(archiveBlockerMessage(blocker, subject), {
      key: ARCHIVE_TOAST_KEY,
      tone: "error",
      durationMs: TOAST_DWELL_MS,
      ...(whole
        ? {
            action: {
              label: `Archive all ${whole.length}`,
              onClick: () => runTaskArchive(whole, ctx, actions),
            },
          }
        : {}),
    });
    return null;
  }

  const archived = archiveSet(targets, ctx);
  // Every target was already archived: nothing happened, and a receipt for it
  // would be a lie. Same silence as an unknown id, for the same reason.
  if (archived.length === 0) return null;

  for (const id of archived) actions.archiveTask(id, true);
  showToast(archiveReceipt(ctx, targets, archived), {
    key: ARCHIVE_TOAST_KEY,
    tone: "success",
    durationMs: TOAST_DWELL_MS,
    action: {
      label: "Undo",
      onClick: () => {
        // Exactly what this act archived, parents included: the hierarchy comes
        // back because no edge was ever touched, only `archivedAt`.
        for (const id of archived) actions.archiveTask(id, false);
        dismissToastKey(ARCHIVE_TOAST_KEY);
      },
    },
  });
  return archived;
}
