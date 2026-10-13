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

/** How long a checkout must have been quiet before the bulk act may take it. */
const BULK_RETIRE_QUIET_MS = 24 * 3_600_000;

/**
 * The only ones a bulk act may take: nothing to commit or merge, SOMEBODY ever
 * held it, and nobody touched it for a day. A checkout nobody held yet — a
 * person's fresh worktree for upcoming work, a first send before its session
 * links — is still listed, and still retirable one at a time from its own
 * page, but "nothing unmerged" is no reason to assume it is finished.
 */
export function retirableIdleWorktrees(
  rows: readonly IdleWorktree[],
  now: number,
): IdleWorktree[] {
  return rows.filter(
    (row) =>
      row.kind === "delivered" &&
      (row.worktree.treeSessionIds?.length ?? 0) > 0 &&
      now - row.lastActivityAt >= BULK_RETIRE_QUIET_MS,
  );
}

/** Whether an idle row matches the browser's search, over what the row states. */
export function idleWorktreeMatches(
  item: IdleWorktree,
  needle: string,
  projectLabel: string | undefined,
): boolean {
  const query = needle.trim().toLowerCase();
  if (!query) return true;
  return [item.worktree.branch, projectLabel ?? "", idleWorktreeLabel(item)]
    .join(" ")
    .toLowerCase()
    .includes(query);
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
