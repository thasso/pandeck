/**
 * The worktree half of the cleanup queue (`docs/worktree-ownership.md`): every
 * spawned worktree nobody is working in, with what is left in it.
 *
 * A worktree is IDLE when no session that holds it is live — its creator, the
 * sessions running in it, and every coordinator above any of them along the
 * spawn edges, since a coordinator may still act on what its peer left — no
 * pull-request card for it is still moving, and no merge is in flight. Live is
 * the removal guard's own sense (`liveSessionIdsForWorktree`): neither settled,
 * archived nor deleted.
 *
 * Nothing here removes anything. It answers which checkouts are left and what
 * retiring each would lose; retiring is the user's act, through the ordinary
 * retire path and its containment checks.
 */
import { existsSync } from "node:fs";
import type {
  IdleWorktree,
  IdleWorktreeKind,
  WorktreeGitStatus,
  WorktreeRecord,
} from "@assistant/shared";
import { sessionStore } from "../db/sessionStore.ts";
import { listWorktrees, type WorktreeRow } from "../db/worktreeStore.ts";
import { errorText } from "../errors.ts";
import { computeWorktreeStatus } from "./worktreeStatus.ts";
import { listWorktreeRecords, mapLimit } from "./worktrees.ts";

/** Git status reads at once: each is a few git processes. */
const STATUS_CONCURRENCY = 4;

/** A card still in these states keeps its worktree in the pull-request flow. */
const MOVING_CARD = new Set(["choosing-task", "creating", "open"]);

export interface IdleWorktreeOperations {
  status(row: WorktreeRow): Promise<WorktreeGitStatus>;
  exists(path: string): boolean;
}

const defaultOperations: IdleWorktreeOperations = {
  status: (row) => computeWorktreeStatus(row),
  exists: existsSync,
};

/**
 * Classify what retiring would lose. Status failures are `unknown`, never
 * clean. A clean tree whose pull request MERGED is `delivered` even when the
 * local base has not caught up: a squash merge lands upstream, and this read
 * never fetches. Retire refreshes the base and verifies containment before it
 * removes anything, so a wrong guess here is refused there, not lost.
 */
export function idleWorktreeKind(
  status: WorktreeGitStatus,
  pullRequestMerged = false,
): Pick<IdleWorktree, "kind" | "ahead" | "pushed" | "changedFiles"> {
  if (status.dirty)
    return {
      kind: "uncommitted",
      changedFiles: status.filesChanged + status.untracked,
    };
  if (pullRequestMerged) return { kind: "delivered" };
  if (status.baseUnresolved) return { kind: "unknown" };
  if (status.merged || status.ahead === 0) return { kind: "delivered" };
  return {
    kind: "unmerged",
    ahead: status.ahead,
    pushed: status.upstream !== undefined && status.upstream.ahead === 0,
  };
}

/** The idle worktrees, most idle first. */
export async function idleWorktrees(
  operations: IdleWorktreeOperations = defaultOperations,
): Promise<IdleWorktree[]> {
  const rows = new Map(listWorktrees().map((row) => [row.id, row]));
  const records = (await listWorktreeRecords()).filter(
    (record) => !record.isMain && rows.has(record.id),
  );

  const candidates: Array<{
    record: WorktreeRecord;
    row: WorktreeRow;
    lastActivityAt: number;
  }> = [];
  for (const record of records) {
    const row = rows.get(record.id)!;
    if (row.mergeStateJson) continue;
    if (record.pullRequest && MOVING_CARD.has(record.pullRequest.status))
      continue;
    let lastActivityAt = row.updatedAt;
    let live = false;
    // The holders and every coordinator above them, from the server's record.
    for (const sessionId of record.treeSessionIds ?? []) {
      const meta = sessionStore.get(sessionId);
      if (!meta) continue;
      lastActivityAt = Math.max(lastActivityAt, meta.updatedAt);
      if (!meta.archivedAt && !sessionStore.isSettled(sessionId)) live = true;
    }
    if (!live) candidates.push({ record, row, lastActivityAt });
  }

  const idle = await mapLimit(
    candidates,
    STATUS_CONCURRENCY,
    async ({ record, row, lastActivityAt }): Promise<IdleWorktree> => {
      const base = { worktree: record, lastActivityAt };
      if (!operations.exists(row.path))
        return { ...base, kind: "missing" as IdleWorktreeKind };
      try {
        return {
          ...base,
          ...idleWorktreeKind(
            await operations.status(row),
            record.pullRequest?.status === "merged",
          ),
        };
      } catch (err) {
        console.warn(
          `[worktrees] idle status for ${row.id} failed:`,
          errorText(err),
        );
        return { ...base, kind: "unknown" as IdleWorktreeKind };
      }
    },
  );
  return idle.sort(
    (a, b) =>
      a.lastActivityAt - b.lastActivityAt ||
      a.worktree.id.localeCompare(b.worktree.id),
  );
}
