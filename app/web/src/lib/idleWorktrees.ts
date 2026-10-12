/**
 * Pure shaping for the cleanup queue's worktree half (no React, no fetches):
 * which idle worktrees a row states, in what order, and in what words.
 *
 * A worktree a pull-request row already covers is left to that row — the
 * Needs cleanup group lists a terminal pull request WITH its checkout, and two
 * rows for one checkout would offer two different ways to retire it.
 */
import type {
  IdleWorktree,
  IdleWorktreeKind,
  PullRequestInventoryItem,
} from "@assistant/shared";

/** Safest to retire first: the order a row list and the bulk action read. */
const KIND_ORDER: Record<IdleWorktreeKind, number> = {
  delivered: 0,
  missing: 1,
  unmerged: 2,
  uncommitted: 3,
  unknown: 4,
};

/** The idle worktrees no pull-request row covers, safest first, most idle first. */
export function idleWorktreeRows(
  idle: readonly IdleWorktree[],
  pullRequests: readonly PullRequestInventoryItem[] | undefined,
): IdleWorktree[] {
  const covered = new Set(
    (pullRequests ?? []).flatMap((item) =>
      item.worktreeId ? [item.worktreeId] : [],
    ),
  );
  return idle
    .filter((item) => !covered.has(item.worktree.id))
    .sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        a.lastActivityAt - b.lastActivityAt ||
        a.worktree.id.localeCompare(b.worktree.id),
    );
}

/** The ones retiring loses nothing from — the only ones a bulk act may take. */
export function retirableIdleWorktrees(
  rows: readonly IdleWorktree[],
): IdleWorktree[] {
  return rows.filter((row) => row.kind === "delivered");
}

/** What is left in it, in words; `unknown` never reads as clean. */
export function idleWorktreeLabel(item: IdleWorktree): string {
  switch (item.kind) {
    case "delivered":
      return item.worktree.pullRequest?.status === "merged"
        ? "Pull request merged"
        : "Nothing unmerged";
    case "missing":
      return "Checkout missing";
    case "unmerged": {
      const count = item.ahead ?? 0;
      const commits = `${count} unmerged commit${count === 1 ? "" : "s"}`;
      return item.pushed ? `${commits} · pushed` : `${commits} · not pushed`;
    }
    case "uncommitted": {
      const count = item.changedFiles ?? 0;
      return `${count} uncommitted file${count === 1 ? "" : "s"}`;
    }
    case "unknown":
      return "State unknown";
  }
}

/** "idle 3 d", from the latest activity of anyone who held it. */
export function idleForLabel(lastActivityAt: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - lastActivityAt) / 60_000));
  if (minutes < 60) return `idle ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `idle ${hours} h`;
  return `idle ${Math.floor(hours / 24)} d`;
}
