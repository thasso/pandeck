/**
 * The session list's one clock input (`docs/session-list.md`, "Deadline
 * watermark"). A peer request stops being owed when its reply deadline
 * passes, with no write to say so. The row builder therefore never asks the
 * wall clock: it reads {@link deadlineWatermark} W, and W moves only inside
 * {@link advancePeerDeadlines}, which first touches the sender and recipient
 * of every request whose deadline it crosses. So a request reads as expired
 * exactly when `expires_at_ms <= W`, and no build sees a crossing before its
 * touch.
 *
 * The timer is armed over a deliberate SUPERSET: every status from which a
 * `response_requested` request is, or can still become, owed. A deadline is in
 * that set from the write that stores it until its request closes for good,
 * and nothing leaves a closed status (`transitionInTxn` refuses to), so no
 * status change needs a hook of its own.
 */
import { touchAllSessionRows, touchSessionRows } from "./sessionListChanges.ts";
import { getDb } from "./index.ts";
import type { PeerPromptStatus } from "./peerPromptStore.ts";

/**
 * Every status, classified. `scheduled`: the request is or can still become
 * owed, so its deadline must be on the timer. `closed`: no outgoing
 * transition, nothing owed. A `Record` so a new status fails to compile until
 * it is classified here.
 */
const DEADLINE_SCHEDULING: Record<PeerPromptStatus, "scheduled" | "closed"> = {
  held: "scheduled",
  queued: "scheduled",
  dispatching: "scheduled",
  admitted: "scheduled",
  acknowledged: "scheduled",
  completed: "scheduled",
  awaiting_response: "scheduled",
  retryable_failed: "scheduled",
  replied: "scheduled",
  settled: "closed",
  failed: "closed",
  interrupted: "closed",
  cancelled: "closed",
  expired: "closed",
};

export const DEADLINE_SCHEDULED_STATUSES = (
  Object.keys(DEADLINE_SCHEDULING) as PeerPromptStatus[]
).filter((status) => DEADLINE_SCHEDULING[status] === "scheduled");

export const CLOSED_PEER_PROMPT_STATUSES = (
  Object.keys(DEADLINE_SCHEDULING) as PeerPromptStatus[]
).filter((status) => DEADLINE_SCHEDULING[status] === "closed");

const SCHEDULED_IN = DEADLINE_SCHEDULED_STATUSES.map((s) => `'${s}'`).join(
  ", ",
);

/** The participants of every scheduled request whose deadline lies in (W, now]. */
export const DUE_DEADLINE_PARTICIPANTS_SQL = `
  SELECT DISTINCT sender_session_id, recipient_session_id
    FROM peer_prompts
   WHERE status IN (${SCHEDULED_IN}) AND response_requested = 1
     AND expires_at_ms > ? AND expires_at_ms <= ?`;

/** The next scheduled deadline after W: one MIN seek per status on `peer_prompts_expiry_idx`. */
export const NEXT_DEADLINE_SQL = `
  SELECT MIN(next) AS next FROM (${DEADLINE_SCHEDULED_STATUSES.map(
    (status) =>
      `SELECT MIN(expires_at_ms) AS next FROM peer_prompts WHERE status = '${status}' AND expires_at_ms > ?`,
  ).join(" UNION ALL ")})`;

/** `setTimeout`'s range; the 30-day reply TTL is beyond it. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const RETRY_AFTER_FAILURE_MS = 60_000;

let watermark = Date.now();
let started = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let armedFor: number | undefined;

/** The time the session list reads peer deadlines at. Never moves backwards. */
export function deadlineWatermark(): number {
  return watermark;
}

/**
 * Move W to `now`, touching the participants of every request whose deadline
 * it crosses first, in one synchronous step. `now <= W` only re-arms.
 * Participants of a request that was not owed (still `queued`) are a harmless
 * over-touch.
 */
export function advancePeerDeadlines(now = Date.now()): void {
  if (now > watermark) {
    const rows = getDb()
      .prepare(DUE_DEADLINE_PARTICIPANTS_SQL)
      .all(watermark, now) as {
      sender_session_id: string;
      recipient_session_id: string;
    }[];
    touchSessionRows(
      rows.flatMap((row) => [row.sender_session_id, row.recipient_session_id]),
    );
    watermark = now;
  }
  arm();
}

/** Starts the timer (the hub, at boot). Before it, nothing is armed. */
export function startPeerDeadlineClock(): void {
  started = true;
  arm();
}

/**
 * A write stored deadline `ms`: arm earlier when it precedes the armed one.
 * Called by every write of `expires_at_ms` (the inserts and the `expiresAt`
 * patch). A deadline already `<= W` changes the projection by itself and is
 * touched by that write.
 */
export function noteDeadline(ms: number | null | undefined): void {
  if (!started || ms == null || ms <= watermark) return;
  if (armedFor !== undefined && armedFor <= ms) return;
  schedule(ms);
}

function arm(): void {
  if (!started) return;
  let next: number | null;
  try {
    next = (
      getDb()
        .prepare(NEXT_DEADLINE_SQL)
        .get(...DEADLINE_SCHEDULED_STATUSES.map(() => watermark)) as {
        next: number | null;
      }
    ).next;
  } catch (err) {
    failed(err);
    return;
  }
  if (next === null) {
    clear();
    return;
  }
  schedule(next);
}

function schedule(target: number): void {
  clear();
  armedFor = target;
  const delay = Math.min(Math.max(1, target - Date.now()), MAX_TIMER_MS);
  timer = setTimeout(fire, delay);
  timer.unref?.();
}

function fire(): void {
  timer = undefined;
  armedFor = undefined;
  try {
    // An early fire (a clamped delay) finds nothing new and only re-arms.
    advancePeerDeadlines();
  } catch (err) {
    failed(err);
  }
}

/** W stays put, so content stays what the last touch described. */
function failed(err: unknown): void {
  console.warn(
    "[sessions] advancing peer reply deadlines failed:",
    err instanceof Error ? err.message : String(err),
  );
  clear();
  timer = setTimeout(fire, RETRY_AFTER_FAILURE_MS);
  timer.unref?.();
}

function clear(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  armedFor = undefined;
}

/** Test seam: the deadline the timer is armed for, if any. */
export function armedPeerDeadlineForTests(): number | undefined {
  return armedFor;
}

/**
 * Test seam: restart the clock at `now`, stopped, as at boot before the hub.
 * W may move either way here, so every row is rebuilt.
 */
export function resetPeerDeadlineClockForTests(now = Date.now()): void {
  clear();
  if (now !== watermark) touchAllSessionRows("peer deadline clock reset");
  watermark = now;
  started = false;
}
