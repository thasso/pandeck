/**
 * One-time backfill of `created_worktree` edges for worktrees created before
 * `worktree_create` recorded its caller (`docs/worktree-ownership.md`).
 *
 * The evidence is the creating session's OWN log: its `worktree_create` tool
 * call and the result paired with it by `toolCallId`, whose JSON names the new
 * worktree's id, path and project. A worktree id merely mentioned somewhere —
 * a `worktree_status` listing, a pasted path — is not a claim.
 *
 * A fork copies its parent's history, so the same call and result appear in
 * every fork made after it. The creator is therefore the claimant that
 * EXISTED when the worktree was created (session `createdAt <= row.createdAt`);
 * more than one such claimant is ambiguous and links nothing.
 *
 * It runs once per data directory, off the boot path, and records its summary
 * in `worktree_creator_backfill`. A log that cannot be read is counted and
 * skipped; any other failure records nothing, so the next start retries. A
 * creator already recorded is never replaced, and every edge written here
 * carries `{ source: "backfill" }` so exactly these can be found again.
 */
import { existsSync } from "node:fs";
import { sessionStore } from "../db/sessionStore.ts";
import {
  creatorSessionIdForWorktree,
  listWorktrees,
  recordWorktreeCreator,
  recordWorktreeCreatorBackfill,
  worktreeCreatorBackfillDone,
  type WorktreeRow,
} from "../db/worktreeStore.ts";
import { logPathFor } from "../session/log/persistence.ts";
import { broadcastWorktreeList } from "./worktrees.ts";
import {
  scanLogForCreatedWorktrees,
  type CreatedWorktreeClaim,
} from "./worktreeCreateLogScan.ts";

export interface WorktreeCreatorBackfillSummary {
  /** Worktree rows, active or removed, that had no creator. */
  candidates: number;
  /** Session logs read. */
  sessionsScanned: number;
  linked: number;
  /** Candidates more than one existing session claimed. */
  ambiguous: number;
  /** Logs that could not be read; skipped, so one bad file cannot block it. */
  unreadable: number;
}

export interface WorktreeCreatorBackfillOptions {
  /** Where a session's log lives; tests point it at fixtures. */
  logPath?: (sessionId: string) => string;
}

/**
 * Run the backfill unless it already ran. Answers what it did, or `undefined`
 * when there was nothing to do because it had completed before.
 */
export async function backfillWorktreeCreators(
  options: WorktreeCreatorBackfillOptions = {},
): Promise<WorktreeCreatorBackfillSummary | undefined> {
  if (worktreeCreatorBackfillDone()) return undefined;
  const logPath = options.logPath ?? logPathFor;
  const candidates = new Map<string, WorktreeRow>();
  for (const row of listWorktrees({ includeRemoved: true }))
    if (creatorSessionIdForWorktree(row.id) === undefined)
      candidates.set(row.id, row);

  const summary: WorktreeCreatorBackfillSummary = {
    candidates: candidates.size,
    sessionsScanned: 0,
    linked: 0,
    ambiguous: 0,
    unreadable: 0,
  };
  if (candidates.size > 0) {
    const latest = Math.max(
      ...[...candidates.values()].map((row) => row.createdAt),
    );
    const claimants = new Map<string, Set<string>>();
    // A creator existed before its worktree. `updatedAt` is NOT a bound on the
    // other side: metadata writes are best-effort, and a log can hold a
    // finalized turn its row never recorded.
    const sessions = sessionStore
      .list({ scopes: "all", includeDeleted: true })
      .filter((session) => session.createdAt <= latest);
    for (const session of sessions) {
      const path = logPath(session.id);
      if (!existsSync(path)) continue;
      summary.sessionsScanned += 1;
      let claims: CreatedWorktreeClaim[];
      try {
        claims = await scanLogForCreatedWorktrees(path);
      } catch {
        summary.unreadable += 1;
        continue;
      }
      for (const claim of claims) {
        const row = candidates.get(claim.worktreeId);
        if (
          !row ||
          row.path !== claim.path ||
          row.projectId !== claim.projectId ||
          session.createdAt > row.createdAt
        )
          continue;
        const set = claimants.get(row.id) ?? new Set<string>();
        set.add(session.id);
        claimants.set(row.id, set);
      }
    }
    for (const [worktreeId, sessionIds] of claimants) {
      if (sessionIds.size !== 1) {
        summary.ambiguous += 1;
        continue;
      }
      const [sessionId] = sessionIds;
      if (sessionId === undefined) continue;
      recordWorktreeCreator(sessionId, worktreeId, { source: "backfill" });
      summary.linked += 1;
    }
  }
  recordWorktreeCreatorBackfill(summary);
  if (summary.linked > 0) void broadcastWorktreeList().catch(() => undefined);
  return summary;
}
