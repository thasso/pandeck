/**
 * Last-known git status per worktree, for the PROJECTS ROWS' silhouette only.
 *
 * A worktree row in the Projects tree and on a Project page is two lines:
 * branch plus deltas, then the three-axis summary
 * (`components/worktreeRowParts.tsx`). Every part of it is absent while the
 * status is, so a cold Projects view paints one-line rows and then grows each
 * one as the server answers its `watchWorktree` — one git scan per worktree,
 * landing over hundreds of milliseconds, each one reflowing the pane below it.
 * The rows themselves come from the shell cache and never move; what jumps is
 * the height the status decides.
 *
 * So the shell cache carries the statuses too, and they enter the app in their
 * OWN state slice, never in `worktreeStatuses`. The split is the point:
 *
 * - `worktreeStatuses` stays exactly what it was — statuses this socket episode
 *   observed. Everything that DECIDES from a status reads it alone, and
 *   `worktreeInbox.ts`'s contract holds there unchanged: an absent projection
 *   is unknown, never clean.
 * - The cached record is a LAYOUT input, resolved one row at a time by
 *   {@link rowWorktreeStatus}. It is what git said when this browser last
 *   looked, which is a claim about the past and is rendered as one: a status
 *   whose `fetchedAt` has aged out dims its axes through the `staleFetch`
 *   modifier that already exists, and the live push replaces it within a scan.
 *
 * WHERE it may be read is the enforcement, not a rule anyone has to remember:
 * the slice reaches exactly two builders — the Projects tree's status map in
 * `components/Sidebar.tsx` and the Project page's in `App.tsx` — and
 * `worktreeRowStatusAudit.test.ts` lists both those reads and every status
 * collection any component is handed, so neither the slice nor a map resolved
 * from it can reach a new surface silently. It is deliberately NOT handed to
 * the Worktrees inbox, whose cards are a control surface: `worktreeCardActions`
 * decides from a status which of Commit, Push, Pull, Rebase and Fast-forward a
 * card offers, and `classifyWorktree` decides what the retire dialog tells you
 * it is about to remove. Those may only ever be answered by what this episode
 * observed. Contract: `docs/state-sync.md`.
 */
import type { WorktreeGitStatus, WorktreeRecord } from "@assistant/shared";

/** One shared empty record, so a browser with no cache keeps a stable prop. */
export const NO_WORKTREE_STATUSES: Record<string, WorktreeGitStatus> = {};

/**
 * What ONE Projects row lays itself out from: this episode's status where there
 * is one, the last known status where there is not.
 *
 * Per id rather than as a merged record, so the fallback cannot spread by being
 * passed on: a surface holds the two records or it holds neither.
 */
export function rowWorktreeStatus(
  live: Record<string, WorktreeGitStatus>,
  lastKnown: Record<string, WorktreeGitStatus>,
  worktreeId: string,
): WorktreeGitStatus | undefined {
  return live[worktreeId] ?? lastKnown[worktreeId];
}

/**
 * What the shell cache persists: this episode's statuses over what the browser
 * already remembered, pruned to the worktrees the cache is storing rows for.
 *
 * The merge is load-bearing rather than tidy. A browser that opens the app and
 * never visits a worktree surface observes NO status, and writing this
 * episode's record alone would erase every remembered row's height on the way
 * out — the next cold start would jump exactly like today's. Pruning is what
 * keeps the record bounded by the current worktree list instead of by every
 * worktree this browser has ever watched.
 */
export function cacheableWorktreeStatuses(
  live: Record<string, WorktreeGitStatus>,
  lastKnown: Record<string, WorktreeGitStatus>,
  worktrees: readonly WorktreeRecord[] | null,
): Record<string, WorktreeGitStatus> {
  const kept: Record<string, WorktreeGitStatus> = {};
  for (const worktree of worktrees ?? []) {
    const status = rowWorktreeStatus(live, lastKnown, worktree.id);
    if (status) kept[worktree.id] = status;
  }
  return kept;
}

/**
 * What a row would DRAW from these statuses, as one comparable string: which
 * worktrees have one, and for each the presence of the delta, the merged badge
 * and each of the three axes — never the numbers inside them.
 *
 * This is the deciding slice for the shell-cache write, and it has to be this
 * narrow in both directions. By value, because the watcher pushes a full status
 * several times a second for a worktree an agent is writing in, and every push
 * would otherwise schedule a ~217 KB serialization. And by more than the ids,
 * because `IdleWriter.flush` writes the value that was last SCHEDULED: an id
 * that only ever schedules once would persist its first status forever, so a
 * worktree that was clean when this browser first saw it would keep painting a
 * one-line row after it went dirty — the growth this cache exists to remove.
 *
 * A count moving inside a shape that is already drawn rides along with the next
 * write anything else schedules; being a second stale is the whole bargain.
 * Whenever a row learns to draw something new, it belongs in this key.
 */
export function worktreeSilhouetteKey(
  statuses: Record<string, WorktreeGitStatus>,
): string {
  return Object.keys(statuses)
    .sort()
    .map((id) => `${id}:${statusSilhouette(statuses[id]!)}`)
    .join("\n");
}

function statusSilhouette(status: WorktreeGitStatus): string {
  return [
    status.dirty ? "d" : "",
    status.merged ? "m" : "",
    status.ahead > 0 ? "a" : "",
    status.behind > 0 ? "b" : "",
    status.upstream
      ? `u${status.upstream.ahead > 0 ? "a" : ""}${status.upstream.behind > 0 ? "b" : ""}`
      : "!u",
    status.baseUpstream
      ? `p${status.baseUpstream.ahead > 0 ? "a" : ""}${status.baseUpstream.behind > 0 ? "b" : ""}`
      : "",
  ].join("");
}
