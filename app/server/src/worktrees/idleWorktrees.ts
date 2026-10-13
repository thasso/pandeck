/**
 * The worktree half of the cleanup queue (`docs/worktree-ownership.md`): every
 * spawned worktree nobody is working in, with what is left in it.
 *
 * A worktree is IDLE when no session that holds it is live — its creator, the
 * sessions running in it, and every coordinator above any of them along the
 * spawn edges, since a coordinator may still act on what its peer left — no
 * pull-request card for it is still moving, no merge is in flight, and no open
 * Workflow Run owns it (a run's roles may all be settled between steps). Live
 * is the removal guard's own sense (`liveSessionIdsForWorktree`): neither
 * settled, archived nor deleted.
 *
 * Nothing here removes anything. It answers which checkouts are left and what
 * retiring each would lose; retiring is the user's act, through the ordinary
 * retire path and its containment checks — and a retire that asks
 * `requireIdle` has this same rule re-checked under its removal hold
 * ({@link worktreeIdleRefusal}), so a snapshot that went stale cannot settle a
 * session that started working there since.
 */
import { existsSync } from "node:fs";
import type {
  IdleWorktree,
  IdleWorktreeKind,
  WorktreeGitStatus,
  WorktreeRecord,
} from "@assistant/shared";
import { sessionStore } from "../db/sessionStore.ts";
import { listOpenRuns } from "../db/workflowStore.ts";
import {
  getWorktree,
  listWorktrees,
  type WorktreeRow,
} from "../db/worktreeStore.ts";
import { errorText } from "../errors.ts";
import { computeWorktreeStatus } from "./worktreeStatus.ts";
import {
  listWorktreeRecords,
  mapLimit,
  worktreeRecordOf,
} from "./worktrees.ts";

/** How long one answer serves every tab polling it; a retire drops it. */
const CACHE_MS = 30_000;

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
 * local base has not caught up — a squash merge lands upstream, and this read
 * never fetches — unless its upstream holds commits it has not pushed. Retire refreshes the base and verifies containment before it
 * removes anything, so a wrong guess here is refused there, not lost.
 */
export function idleWorktreeKind(
  status: WorktreeGitStatus,
  pullRequestMerged = false,
): Pick<IdleWorktree, "kind" | "ahead" | "pushed" | "changedFiles"> {
  // No HEAD means git never read this checkout — the status seam absorbs a
  // failed `git status` into zeros — so its clean, level counts are not an
  // answer about it. Nothing below may call that delivered.
  if (status.head === null) return { kind: "unknown" };
  if (status.dirty)
    return {
      kind: "uncommitted",
      changedFiles: status.filesChanged + status.untracked,
    };
  // Unless the upstream shows commits made after it: those are work the
  // shortcut would hide.
  if (pullRequestMerged && !(status.upstream && status.upstream.ahead > 0))
    return { kind: "delivered" };
  if (status.baseUnresolved) return { kind: "unknown" };
  if (status.merged || status.ahead === 0) return { kind: "delivered" };
  return {
    kind: "unmerged",
    ahead: status.ahead,
    pushed: status.upstream !== undefined && status.upstream.ahead === 0,
  };
}

/** Why a worktree is not idle, or `undefined` when it is. */
function notIdleReason(
  record: WorktreeRecord,
  row: WorktreeRow,
  runWorktreeIds: ReadonlySet<string>,
): { reason?: string; lastActivityAt: number } {
  let lastActivityAt = row.updatedAt;
  if (row.mergeStateJson)
    return { reason: "A merge is in flight there.", lastActivityAt };
  if (record.pullRequest && MOVING_CARD.has(record.pullRequest.status))
    return { reason: "Its pull request is still open.", lastActivityAt };
  if (runWorktreeIds.has(record.id))
    return { reason: "An open Workflow Run works there.", lastActivityAt };
  let live: string | undefined;
  // The holders and every coordinator above them, from the server's record.
  for (const sessionId of record.treeSessionIds ?? []) {
    const meta = sessionStore.get(sessionId);
    if (!meta) continue;
    lastActivityAt = Math.max(lastActivityAt, meta.updatedAt);
    if (!live && !meta.archivedAt && !sessionStore.isSettled(sessionId))
      live = `A session holding it is still live (${meta.title}).`;
  }
  return live ? { reason: live, lastActivityAt } : { lastActivityAt };
}

function openRunWorktreeIds(): Set<string> {
  return new Set(
    listOpenRuns().flatMap((run) => (run.worktreeId ? [run.worktreeId] : [])),
  );
}

/**
 * The idle rule re-asked for ONE worktree at retire time: a refusal sentence,
 * or `undefined` when it is still idle. The retire path calls it before and
 * again under its removal hold.
 */
export function worktreeIdleRefusal(worktreeId: string): string | undefined {
  const row = getWorktree(worktreeId);
  if (!row || row.status !== "active")
    return "That worktree is no longer available.";
  const { reason } = notIdleReason(
    worktreeRecordOf(row),
    row,
    openRunWorktreeIds(),
  );
  return reason
    ? `It is no longer idle: ${reason} Nothing was removed.`
    : undefined;
}

let cached: { at: number; value: IdleWorktree[] } | undefined;
let inflight: Promise<IdleWorktree[]> | undefined;
let generation = 0;

/** Drop the cached answer: something was retired, or changed under it. */
export function invalidateIdleWorktrees(): void {
  generation += 1;
  cached = undefined;
}

/**
 * The idle worktrees, most idle first: ONE computation shared by every tab
 * polling it (single-flight), served for {@link CACHE_MS}. Each runs git
 * status for every candidate, so a tab per minute each was seconds of git work.
 */
export function idleWorktrees(): Promise<IdleWorktree[]> {
  if (cached && Date.now() - cached.at < CACHE_MS)
    return Promise.resolve(cached.value);
  if (inflight) return inflight;
  const started = generation;
  const run = computeIdleWorktrees()
    .then((value) => {
      if (generation === started) cached = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      if (inflight === run) inflight = undefined;
    });
  inflight = run;
  return run;
}

/** The idle worktrees, most idle first, computed now. */
export async function computeIdleWorktrees(
  operations: IdleWorktreeOperations = defaultOperations,
): Promise<IdleWorktree[]> {
  const rows = new Map(listWorktrees().map((row) => [row.id, row]));
  const records = (await listWorktreeRecords()).filter(
    (record) => !record.isMain && rows.has(record.id),
  );
  const runWorktrees = openRunWorktreeIds();

  const candidates: Array<{
    record: WorktreeRecord;
    row: WorktreeRow;
    lastActivityAt: number;
  }> = [];
  for (const record of records) {
    const row = rows.get(record.id)!;
    const { reason, lastActivityAt } = notIdleReason(record, row, runWorktrees);
    if (!reason) candidates.push({ record, row, lastActivityAt });
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
