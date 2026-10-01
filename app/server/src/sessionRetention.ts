/**
 * Automatic archival of SETTLED sessions (Task-696, `docs/session-retention.md`).
 *
 * A session the user put down stays on the Settled shelf for seven days after
 * its latest settlement and is then archived by the server: reversible, never
 * deleting anything, and recoverable through the on-demand archive view and
 * every direct session link. The point is the default session list — the one
 * serialized on every connect and rebuilt while agents stream — which must
 * scale with the ACTIVE rows rather than with everything ever finished.
 *
 * Eligibility is asked of the SAME projected rows the browser renders, through
 * the SAME `settleBlockedReason` the Settle action answers with, so retention
 * can never take a session the user could not settle themselves. On top of the
 * shared predicate it keeps its hands off a session someone is currently
 * viewing (no tab ever loses the conversation it is looking at) and off every
 * role session a working-set Workflow Run still owns, even one that is idle
 * between steps. The store rechecks the DURABLE half — scope, tombstone,
 * archive state, settlement age, acknowledged outcome revision — inside the
 * one write transaction ({@link sessionStore.archiveSettledBatch}).
 *
 * Best-effort, like Task retention: the sweep runs at boot and hourly, one
 * invocation at a time, and a failure is logged and retried by the next run
 * rather than failing startup or any user mutation.
 */
import { attentionUnknownReason } from "./attentionAvailability.ts";
import {
  settleBlockedReason,
  workflowRunOwnerBySession,
  type SessionListItem,
  type WorkflowRunCard,
} from "@assistant/shared";
import { sessionStore } from "./db/sessionStore.ts";
import { listRuns } from "./db/workflowStore.ts";
import { workflowRunCardFor, workflowRunSummaryOf } from "./workflowRuns.ts";

/**
 * A settled session is archived seven days after its LATEST settlement. One
 * full weekly cycle keeps recently finished work on the shelf through the
 * following week; a shorter window would archive Friday's work over the
 * weekend, and a longer one would leave the default list several times larger
 * than what the user still looks at.
 */
export const SESSION_AUTO_ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_AUTO_ARCHIVE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** What the sweep may not touch, beyond the rows themselves. */
export interface SessionArchiveContext {
  now: number;
  /** Sessions some connected browser is viewing right now. */
  viewed: ReadonlySet<string>;
  /** Role sessions a working-set Workflow Run owns. */
  runOwned: ReadonlySet<string>;
}

/**
 * The ids eligible for automatic archival RIGHT NOW, from the projected rows.
 *
 * Pure, so the policy is tested directly. `settledAt` on a row is already the
 * EFFECTIVE settlement — `sessions.ts` withholds it while an outcome newer than
 * the acknowledged revision is waiting — so its age is the whole durable
 * question here; the store re-asks it on write.
 */
export function selectSettledArchiveCandidates(
  rows: readonly SessionListItem[],
  ctx: SessionArchiveContext,
): string[] {
  const cutoff = ctx.now - SESSION_AUTO_ARCHIVE_AFTER_MS;
  const ids: string[] = [];
  for (const row of rows) {
    if (row.archived) continue;
    if (row.settledAt === undefined || row.settledAt > cutoff) continue;
    if (ctx.viewed.has(row.id) || ctx.runOwned.has(row.id)) continue;
    if (settleBlockedReason(row) !== undefined) continue;
    ids.push(row.id);
  }
  return ids;
}

/**
 * Every role session of every working-set run, by the shared ownership rule
 * the browser folds those sessions under their run with.
 */
function workflowRunOwnedSessionIds(): Set<string> {
  const runs = listRuns();
  const cards: Record<string, WorkflowRunCard> = {};
  for (const run of runs) {
    const card = workflowRunCardFor(run);
    if (card) cards[String(run.id)] = card;
  }
  return new Set(
    workflowRunOwnerBySession(runs.map(workflowRunSummaryOf), cards).keys(),
  );
}

let sweepRunning = false;
let sweepTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Archive every settled session whose seven days are up, and answer the ids
 * archived. One list read, one store transaction, one list broadcast — a
 * legacy backfill of thousands of settled rows is one commit and one
 * `sessions` frame per tab, not one of each per row.
 *
 * Overlapping invocations are refused (an empty answer) rather than queued:
 * the next scheduled run reconsiders whatever this one skipped. Between the
 * candidate selection and the store write there is no `await`, so a turn
 * cannot start on a candidate in between; a turn that starts afterwards runs
 * in an archived session exactly as it would after a manual archive.
 */
export async function sweepSettledSessionArchive(
  now = Date.now(),
): Promise<string[]> {
  if (sweepRunning) return [];
  sweepRunning = true;
  try {
    // Imported here, not at module scope: `hub.ts` owns the session list this
    // module reads and is itself wired from `index.ts` beside this scheduler.
    // A settled session may still owe an answer the card stores cannot show
    // right now; archiving it would bury that. Skip the pass; the next one
    // reconsiders everything once the stores are readable again.
    const unknown = attentionUnknownReason();
    if (unknown) {
      console.warn(`[sessions] auto-archive skipped: ${unknown}`);
      return [];
    }
    const { hub } = await import("./hub.ts");
    const rows = await hub.listSessions();
    const candidates = selectSettledArchiveCandidates(rows, {
      now,
      viewed: hub.viewedSessionIds(),
      runOwned: workflowRunOwnedSessionIds(),
    });
    const archived = sessionStore.archiveSettledBatch(
      candidates,
      now - SESSION_AUTO_ARCHIVE_AFTER_MS,
      now,
    );
    if (archived.length === 0) return archived;
    console.info(
      `[sessions] archived ${archived.length} settled session${archived.length === 1 ? "" : "s"} older than ${SESSION_AUTO_ARCHIVE_AFTER_MS / 86_400_000} days`,
    );
    await hub.broadcastSessions();
    return archived;
  } finally {
    sweepRunning = false;
  }
}

function runSessionAutoArchiveSweep(trigger: "boot" | "hourly"): void {
  void sweepSettledSessionArchive().catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      `[sessions] ${trigger} auto-archive sweep failed; will retry later: ${detail}`,
    );
  });
}

/** Run the best-effort retention sweep at boot and hourly thereafter. Idempotent. */
export function startSessionAutoArchiveSweep(): void {
  if (sweepTimer) return;
  runSessionAutoArchiveSweep("boot");
  sweepTimer = setInterval(
    () => runSessionAutoArchiveSweep("hourly"),
    SESSION_AUTO_ARCHIVE_SWEEP_INTERVAL_MS,
  );
  sweepTimer.unref?.();
}

export function stopSessionAutoArchiveSweep(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = undefined;
}
