/**
 * Schedules and their occurrences (`docs/schedules.md`, migrations 0107 and
 * 0108), and Pause all.
 *
 * Every public write is ONE transaction that stamps each Schedule it touched
 * with one fresh revision from the `schedule_revision` sequence, so a write
 * that changes a Schedule's occurrences moves that Schedule's revision too. A
 * delete leaves a tombstone carrying the revision of its delete.
 *
 * Occurrence transitions are conditional: only a row still `claimed` moves,
 * and a call that finds it already terminal changes nothing and says so. That
 * makes settlement, supersession and withdrawal idempotent, and a late or
 * repeated settle can never overwrite a terminal state or move `done_at_ms`.
 *
 * Pause all is one row (`schedule_pause`), and every switch is a transaction
 * that first settles each due Schedule under the state BEFORE the switch. So
 * every due time between a Schedule's `next_due_at_ms` and now fell in the
 * state the row holds now, and a claim only reads the row in its own
 * transaction: no instant of a pause or resume is remembered anywhere else.
 *
 * An edit or a disable is a switch too: it first settles the Schedule's due
 * times at or before its instant under the definition BEFORE it, exactly like
 * a tick, then applies the change.
 *
 * A `claimed` occurrence whose delivery was attempted may already be in its
 * target's transcript. Ending it any other way than the lane's own settle
 * (a newer claim, an edit, a Pause all switch, a disable) first asks the
 * registered {@link ScheduleAdmissionResolver}, in the same transaction, and
 * fails closed when none is registered. Only deleting a Schedule removes such
 * a row unasked, with its whole history.
 *
 * In Phase 1 only the agent tools (`schedule_manage`) create or edit
 * Schedules; the clock claims their due times and the scheduled prompts lane
 * delivers them (`docs/schedules.md`).
 */
import {
  canonicalScheduleTiming,
  nextOccurrencesAfter,
  scheduleTimingError,
  scheduleTimingsEqual,
  type ScheduleActor,
  type ScheduleOccurrenceState,
  type ScheduleOccurrenceSummary,
  type ScheduleSummary,
  type ScheduleTarget,
  type ScheduleTerminalState,
  type ScheduleTiming,
} from "@assistant/shared/schedules";
import { withChangeSet, type StateTopicWrites } from "./changeSet.ts";
import { getDb, inDbTransaction } from "./index.ts";
import { nextId } from "./sequences.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Terminal occurrences a Schedule keeps; a `claimed` one is never pruned. */
export const SCHEDULE_HISTORY_LIMIT = 50;
/** How long a `done` Schedule, and a tombstone, is kept. */
export const SCHEDULE_RETENTION_MS = 30 * DAY_MS;
/** Due times enumerated per step while catching up after downtime. */
const CATCH_UP_BATCH = 64;

interface ScheduleRow {
  id: string;
  name: string;
  prompt: string;
  enabled: number;
  timing_json: string;
  target_kind: string;
  target_session_id: string | null;
  created_by_json: string;
  controlled_by_json: string;
  cardless: number;
  next_due_at_ms: number | null;
  done_at_ms: number | null;
  revision: number;
  created_at_ms: number;
  updated_at_ms: number;
  deleted_at_ms: number | null;
}

interface OccurrenceRow {
  id: string;
  schedule_id: string;
  due_at_ms: number;
  claimed_at_ms: number | null;
  state: ScheduleOccurrenceState;
  prompt: string;
  name: string;
  time_zone: string;
  target_kind: string;
  target_session_id: string | null;
  attempted_at_ms: number | null;
  session_id: string | null;
  error: string | null;
  ended_at_ms: number | null;
}

/**
 * An occurrence with its frozen input: what delivery reads instead of the
 * Schedule, so an edit after the claim never changes what is sent.
 */
export interface ScheduleOccurrenceRecord extends ScheduleOccurrenceSummary {
  prompt: string;
  name: string;
  timeZone: string;
  target: ScheduleTarget;
  /** Set when delivery was attempted; recovery checks the transcript first. */
  attemptedAtMs?: number;
}

export interface ScheduleCreateInput {
  name: string;
  prompt: string;
  timing: ScheduleTiming;
  target: ScheduleTarget;
  createdBy: ScheduleActor;
  /** Defaults to `createdBy`. */
  controlledBy?: ScheduleActor;
  cardless?: boolean;
  enabled?: boolean;
}

export interface ScheduleUpdate {
  name?: string;
  prompt?: string;
  timing?: ScheduleTiming;
  target?: ScheduleTarget;
  controlledBy?: ScheduleActor;
}

/**
 * How the clock wants due times settled: its grace window. Pause all is not
 * part of it; the store reads its own row in the claim's transaction.
 */
export interface ScheduleClaimPolicy {
  graceMs: number;
}

/**
 * What an edit or an enable/disable needs: the grace window its cutover
 * settles under, and the writer's cardless limit when it has one.
 */
export type ScheduleWritePolicy = ScheduleClaimPolicy & {
  cardlessLimit?: number;
};

/**
 * Thrown inside a write that would bring its controller's cardless Schedules
 * over `limit`; the whole write rolls back. `count` is how many OTHER counted
 * Schedules that session already controls.
 */
export class ScheduleCardlessLimitError extends Error {
  constructor(
    readonly count: number,
    readonly limit: number,
  ) {
    super(
      `The session already controls ${count} cardless Schedules (limit ${limit})`,
    );
    this.name = "ScheduleCardlessLimitError";
  }
}

/** What a target's transcript says about an attempted occurrence's admission key. */
export type ScheduleAdmissionEvidence =
  | { kind: "present"; sessionId: string }
  | { kind: "absent" }
  | { kind: "unknown"; error: string };

/** Synchronous and total: it must not throw and must not await. */
export type ScheduleAdmissionResolver = (
  occurrence: ScheduleOccurrenceRecord,
) => ScheduleAdmissionEvidence;

/**
 * Thrown inside a write that would end an attempted `claimed` occurrence
 * while no {@link ScheduleAdmissionResolver} is registered; the whole write
 * rolls back rather than guess how it ended.
 */
export class ScheduleAdmissionResolverMissingError extends Error {
  constructor(occurrenceId: string) {
    super(
      `No schedule admission resolver is registered to end attempted occurrence ${occurrenceId}`,
    );
    this.name = "ScheduleAdmissionResolverMissingError";
  }
}

export interface ScheduleClaimOutcome {
  /** The occurrence claimed now, read back from its frozen row. */
  claimed?: ScheduleOccurrenceRecord;
  /** Due times recorded `missed` by this call. */
  missed: number;
}

export interface SchedulePauseOutcome {
  /** False when Pause all already had this state: nothing was written. */
  changed: boolean;
  /** Occurrences the switch claimed: due before it, unpaused, within grace. */
  claimed: ScheduleOccurrenceRecord[];
  /** Due times the switch recorded `missed`. */
  missed: number;
}

export interface ScheduleMaintenanceOutcome {
  /** Schedules deleted: done for 30 days, or their target session deleted. */
  deleted: string[];
  /** Tombstones older than 30 days removed for good. */
  purged: number;
  /** Terminal occurrences pruned beyond the history limit. */
  pruned: number;
}

/* --------------------------------- mapping -------------------------------- */

function liveRow(id: string): ScheduleRow | undefined {
  return getDb()
    .prepare("SELECT * FROM schedules WHERE id = ? AND deleted_at_ms IS NULL")
    .get(id) as ScheduleRow | undefined;
}

function occurrenceRow(id: string): OccurrenceRow | undefined {
  return getDb()
    .prepare("SELECT * FROM schedule_occurrences WHERE id = ?")
    .get(id) as OccurrenceRow | undefined;
}

function targetOf(kind: string, sessionId: string | null): ScheduleTarget {
  if (kind !== "session" || !sessionId)
    throw new Error(`Unknown schedule target kind: ${kind}`);
  return { kind: "session", sessionId };
}

function occurrenceSummaryOf(row: OccurrenceRow): ScheduleOccurrenceSummary {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    state: row.state,
    dueAtMs: row.due_at_ms,
    ...(row.claimed_at_ms !== null ? { claimedAtMs: row.claimed_at_ms } : {}),
    ...(row.ended_at_ms !== null ? { endedAtMs: row.ended_at_ms } : {}),
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
  };
}

function occurrenceRecordOf(row: OccurrenceRow): ScheduleOccurrenceRecord {
  return {
    ...occurrenceSummaryOf(row),
    prompt: row.prompt,
    name: row.name,
    timeZone: row.time_zone,
    target: targetOf(row.target_kind, row.target_session_id),
    ...(row.attempted_at_ms !== null
      ? { attemptedAtMs: row.attempted_at_ms }
      : {}),
  };
}

function summaryOf(row: ScheduleRow): ScheduleSummary {
  const last = getDb()
    .prepare(
      "SELECT * FROM schedule_occurrences WHERE schedule_id = ? ORDER BY due_at_ms DESC LIMIT 1",
    )
    .get(row.id) as OccurrenceRow | undefined;
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    enabled: row.enabled === 1,
    timing: JSON.parse(row.timing_json) as ScheduleTiming,
    target: targetOf(row.target_kind, row.target_session_id),
    createdBy: JSON.parse(row.created_by_json) as ScheduleActor,
    controlledBy: JSON.parse(row.controlled_by_json) as ScheduleActor,
    cardless: row.cardless === 1,
    ...(row.next_due_at_ms !== null ? { nextDueAtMs: row.next_due_at_ms } : {}),
    ...(row.done_at_ms !== null ? { doneAtMs: row.done_at_ms } : {}),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    ...(last ? { lastOccurrence: occurrenceSummaryOf(last) } : {}),
  };
}

/* ------------------------------- validation ------------------------------- */

function checkText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Schedule ${field} must be a non-empty string`);
  return value;
}

/** A valid timing in its canonical stored form. */
function checkTiming(timing: ScheduleTiming): ScheduleTiming {
  const reason = scheduleTimingError(timing);
  if (reason) throw new Error(reason);
  return canonicalScheduleTiming(timing);
}

function checkTarget(target: ScheduleTarget): ScheduleTarget {
  if (target?.kind !== "session" || typeof target.sessionId !== "string")
    throw new Error("Schedule target must be an existing session");
  checkText(target.sessionId, "target session");
  return { kind: "session", sessionId: target.sessionId };
}

function checkActor(actor: ScheduleActor): ScheduleActor {
  if (actor?.kind === "user") return { kind: "user" };
  if (actor?.kind === "session" && typeof actor.sessionId === "string") {
    checkText(actor.sessionId, "actor session");
    return { kind: "session", sessionId: actor.sessionId };
  }
  throw new Error("Schedule actor must be the user or a session");
}

/* ------------------------------ write helpers ----------------------------- */

/** The `schedules` topic's revisions, stamped only through a change set. */
const scheduleTopicWrites: StateTopicWrites = {
  topic: "schedules",
  sequence: "schedule_revision",
  stamp: (ids, revision) => {
    const update = getDb().prepare(
      "UPDATE schedules SET revision = ? WHERE id = ?",
    );
    for (const id of ids) update.run(revision, id);
  },
};

const writeListeners = new Set<() => void>();
const claimListeners = new Set<
  (occurrence: ScheduleOccurrenceRecord) => void
>();

function warnListener(what: string, err: unknown): void {
  console.warn(
    `[schedules] ${what} failed:`,
    err instanceof Error ? err.message : String(err),
  );
}

/** What one write did, filled in by `fn` inside its transaction. */
interface WriteEffects {
  /** Schedules written: stamped and reported to the topic. */
  touched: Set<string>;
  /** Occurrences claimed: each listener hears them once, after commit. */
  claimed: string[];
}

/**
 * Tell the listeners about a write that committed: each `onWrite` listener
 * once, then each `onClaimed` listener once per occurrence claimed and still
 * `claimed` now. A listener's throw is logged and the others still run.
 */
function afterCommit(effects: WriteEffects): void {
  if (effects.touched.size === 0) return;
  for (const listener of writeListeners)
    try {
      listener();
    } catch (err) {
      warnListener("write listener", err);
    }
  if (effects.claimed.length === 0 || claimListeners.size === 0) return;
  let records: ScheduleOccurrenceRecord[] = [];
  try {
    records = effects.claimed
      .map(occurrenceRow)
      .filter((row) => row?.state === "claimed")
      .map((row) => occurrenceRecordOf(row!));
  } catch (err) {
    warnListener("reading the committed claims", err);
  }
  for (const record of records)
    for (const listener of claimListeners)
      try {
        listener(record);
      } catch (err) {
        warnListener(`claim listener for ${record.id}`, err);
      }
}

/**
 * True when the write whose transaction minted `revision` for `touched`
 * committed, read back after it threw: a rollback restored every touched
 * row's earlier revision (or removed the row).
 */
function committedAt(touched: Set<string>, revision: number): boolean {
  try {
    const read = getDb().prepare("SELECT revision FROM schedules WHERE id = ?");
    return [...touched].some(
      (id) =>
        (read.get(id) as { revision: number } | undefined)?.revision ===
        revision,
    );
  } catch (err) {
    warnListener("reading back a failed write", err);
    return false;
  }
}

/**
 * One write transaction with a change set. Every Schedule id `fn` adds to
 * `touched` is stamped with the transaction's `schedules` revision as its last
 * statement and reported to the topic after commit, so a throw anywhere, the
 * stamp included, rolls back the whole write and announces nothing. A write
 * that touched a Schedule then tells each {@link scheduleStore.onWrite}
 * listener, and each {@link scheduleStore.onClaimed} listener about every
 * occurrence it claimed, after commit.
 *
 * When the call throws after its transaction committed (the topic hand-off
 * threw), the write stands: a committed claim is never undone. The listeners
 * still hear it, read back from what committed, and then the error throws.
 */
function write<T>(fn: (touched: Set<string>, claimed: string[]) => T): T {
  const effects: WriteEffects = { touched: new Set(), claimed: [] };
  let revision: number | undefined;
  let value: T;
  try {
    value = withChangeSet((changes) => {
      const value = fn(effects.touched, effects.claimed);
      revision = changes.touch(scheduleTopicWrites, [...effects.touched]);
      return value;
    });
  } catch (err) {
    if (revision !== undefined && committedAt(effects.touched, revision))
      afterCommit(effects);
    throw err;
  }
  afterCommit(effects);
  return value;
}

function hasClaimed(scheduleId: string): boolean {
  return (
    getDb()
      .prepare(
        "SELECT 1 FROM schedule_occurrences WHERE schedule_id = ? AND state = 'claimed' LIMIT 1",
      )
      .get(scheduleId) !== undefined
  );
}

/**
 * Keep `done_at_ms` true to the Schedule as it now stands: `done` once it can
 * produce no further occurrence and none is still `claimed`, stamped at the
 * transition that made it so and kept while it stays done. True when it
 * changed `done_at_ms`.
 */
function refreshDone(scheduleId: string, nowMs: number): boolean {
  const row = liveRow(scheduleId);
  if (!row) return false;
  const remaining =
    row.enabled === 1
      ? row.next_due_at_ms !== null
      : nextOccurrencesAfter(
          JSON.parse(row.timing_json) as ScheduleTiming,
          nowMs,
          1,
        ).length > 0;
  const done = !remaining && !hasClaimed(scheduleId);
  if (done && row.done_at_ms === null)
    getDb()
      .prepare("UPDATE schedules SET done_at_ms = ? WHERE id = ?")
      .run(nowMs, scheduleId);
  else if (!done && row.done_at_ms !== null)
    getDb()
      .prepare("UPDATE schedules SET done_at_ms = NULL WHERE id = ?")
      .run(scheduleId);
  else return false;
  return true;
}

/** Drop terminal occurrences beyond the newest {@link SCHEDULE_HISTORY_LIMIT}. */
function prune(scheduleId: string): number {
  return Number(
    getDb()
      .prepare(
        `DELETE FROM schedule_occurrences
         WHERE schedule_id = ? AND state <> 'claimed' AND id NOT IN (
           SELECT id FROM schedule_occurrences
           WHERE schedule_id = ? AND state <> 'claimed'
           ORDER BY due_at_ms DESC, id DESC
           LIMIT ?
         )`,
      )
      .run(scheduleId, scheduleId, SCHEDULE_HISTORY_LIMIT).changes,
  );
}

let admissionResolver: ScheduleAdmissionResolver | undefined;

/**
 * How an attempted `claimed` occurrence ends when `requested` would end it:
 * its admission evidence decides, read now, inside the caller's transaction.
 * Its key in the target's transcript makes it `delivered`, an unreadable
 * transcript `failed`, and only a key known absent lets `requested` stand.
 */
function admissionEnd(
  row: OccurrenceRow,
  requested: "superseded" | "withdrawn",
): { state: ScheduleTerminalState; sessionId?: string; error?: string } {
  if (!admissionResolver)
    throw new ScheduleAdmissionResolverMissingError(row.id);
  const evidence = admissionResolver(occurrenceRecordOf(row));
  switch (evidence?.kind) {
    case "present":
      return { state: "delivered", sessionId: evidence.sessionId };
    case "unknown":
      return { state: "failed", error: evidence.error };
    case "absent":
      return { state: requested };
    default:
      throw new Error(
        `The schedule admission resolver returned no evidence for ${row.id}`,
      );
  }
}

/**
 * End every `claimed` occurrence of a Schedule but `exceptId` in `requested`;
 * returns how many ended. One never offered to a runtime (no
 * `attempted_at_ms`) is ended as asked. One that was may already be in its
 * target's transcript, so {@link admissionEnd} decides it from evidence in
 * this same transaction; with no resolver registered the whole write throws
 * and rolls back. A row already terminal is never touched.
 */
function endClaimed(
  scheduleId: string,
  requested: "superseded" | "withdrawn",
  nowMs: number,
  exceptId?: string,
): number {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM schedule_occurrences
       WHERE schedule_id = ? AND state = 'claimed' AND id <> ?
       ORDER BY due_at_ms, id`,
    )
    .all(scheduleId, exceptId ?? "") as unknown as OccurrenceRow[];
  const end = db.prepare(
    `UPDATE schedule_occurrences
     SET state = ?, ended_at_ms = ?, session_id = COALESCE(?, session_id),
         error = COALESCE(?, error)
     WHERE id = ? AND state = 'claimed'`,
  );
  let ended = 0;
  for (const row of rows) {
    const outcome: {
      state: ScheduleTerminalState;
      sessionId?: string;
      error?: string;
    } =
      row.attempted_at_ms === null
        ? { state: requested }
        : admissionEnd(row, requested);
    ended += Number(
      end.run(
        outcome.state,
        nowMs,
        outcome.sessionId ?? null,
        outcome.error ?? null,
        row.id,
      ).changes,
    );
  }
  return ended;
}

/** Whether a Schedule counts toward its controller's cardless limit. */
function countsTowardCardless(row: ScheduleRow): boolean {
  if (row.cardless !== 1 || row.deleted_at_ms !== null) return false;
  if (row.done_at_ms !== null) return false;
  const creator = JSON.parse(row.created_by_json) as ScheduleActor;
  const controller = JSON.parse(row.controlled_by_json) as ScheduleActor;
  return (
    creator.kind === "session" &&
    controller.kind === "session" &&
    creator.sessionId === controller.sessionId
  );
}

/**
 * Inside a write that may have moved Schedule `id` into its controller's
 * cardless count (`wasCounted` false before it): when it now counts and
 * `limit` is set, refuse the write if that brings the controller over
 * `limit`. A write that moves nothing into the count is never refused, so
 * every other change stays possible after the limit is lowered.
 */
function assertCardlessCapacity(
  id: string,
  wasCounted: boolean,
  limit: number | undefined,
): void {
  if (limit === undefined || wasCounted) return;
  const row = liveRow(id);
  if (!row || !countsTowardCardless(row)) return;
  const controller = row.controlled_by_json;
  const counted = (
    getDb()
      .prepare(
        `SELECT * FROM schedules
         WHERE deleted_at_ms IS NULL AND done_at_ms IS NULL AND cardless = 1`,
      )
      .all() as unknown as ScheduleRow[]
  ).filter(
    (other) =>
      countsTowardCardless(other) &&
      sameActor(other.controlled_by_json, controller),
  ).length;
  if (counted > limit) throw new ScheduleCardlessLimitError(counted - 1, limit);
}

function sameActor(a: string, b: string): boolean {
  const x = JSON.parse(a) as ScheduleActor;
  const y = JSON.parse(b) as ScheduleActor;
  return x.kind === "session" && y.kind === "session"
    ? x.sessionId === y.sessionId
    : x.kind === y.kind;
}

function tombstone(scheduleId: string, nowMs: number): void {
  const db = getDb();
  db.prepare("DELETE FROM schedule_occurrences WHERE schedule_id = ?").run(
    scheduleId,
  );
  db.prepare(
    `UPDATE schedules SET deleted_at_ms = ?, enabled = 0, next_due_at_ms = NULL
     WHERE id = ?`,
  ).run(nowMs, scheduleId);
}

function insertOccurrence(
  row: ScheduleRow,
  dueAtMs: number,
  state: "claimed" | "missed",
  nowMs: number,
): string | undefined {
  const id = `occ_${nextId("schedule_occurrence")}`;
  const inserted = getDb()
    .prepare(
      `INSERT OR IGNORE INTO schedule_occurrences (
         id, schedule_id, due_at_ms, claimed_at_ms, state, prompt, name,
         time_zone, target_kind, target_session_id, ended_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      row.id,
      dueAtMs,
      state === "claimed" ? nowMs : null,
      state,
      row.prompt,
      row.name,
      (JSON.parse(row.timing_json) as ScheduleTiming).timeZone,
      row.target_kind,
      row.target_session_id,
      state === "claimed" ? null : nowMs,
    );
  return Number(inserted.changes) > 0 ? id : undefined;
}

/**
 * Every due time from `firstDueMs` up to `nowMs` (inclusive): the newest
 * {@link SCHEDULE_HISTORY_LIMIT} + 1 of them, and the first one after `nowMs`.
 */
function dueTimesThrough(
  timing: ScheduleTiming,
  firstDueMs: number,
  nowMs: number,
): { due: number[]; nextDueMs: number | undefined } {
  const due = [firstDueMs];
  let cursor = firstDueMs;
  for (;;) {
    const batch = nextOccurrencesAfter(timing, cursor, CATCH_UP_BATCH);
    for (const at of batch) {
      if (at > nowMs) return { due, nextDueMs: at };
      due.push(at);
      if (due.length > SCHEDULE_HISTORY_LIMIT + 1) due.shift();
    }
    if (batch.length < CATCH_UP_BATCH) return { due, nextDueMs: undefined };
    cursor = batch.at(-1)!;
  }
}

/**
 * Pause all as stored, inside the caller's transaction. SQLite is its only
 * source: with no row yet, the row is created unpaused.
 */
function pausedIn(): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT paused FROM schedule_pause WHERE id = 1")
    .get() as { paused: number } | undefined;
  if (row) return row.paused === 1;
  db.prepare("INSERT INTO schedule_pause (id, paused) VALUES (1, 0)").run();
  return false;
}

/**
 * Settle every due time of one due Schedule up to `nowMs`: with a `claim`
 * policy the latest is claimed when no older than the grace window, every
 * other one is recorded `missed` (the newest {@link SCHEDULE_HISTORY_LIMIT}),
 * and `next_due_at_ms` advances to the first occurrence after `nowMs`. A claim
 * supersedes an earlier still-`claimed` occurrence (through
 * {@link endClaimed}, so an attempted one ends by its admission evidence).
 * Without one (paused), nothing is claimed and an existing claim stays owed.
 * The frozen input comes from `row`, the definition the due times fell under.
 */
function settleDue(
  row: ScheduleRow,
  nowMs: number,
  claim: ScheduleClaimPolicy | null,
  effects: { touched: Set<string>; claimed: string[] },
): { claimedId?: string; missed: number } {
  const timing = JSON.parse(row.timing_json) as ScheduleTiming;
  const { due, nextDueMs } = dueTimesThrough(
    timing,
    row.next_due_at_ms!,
    nowMs,
  );
  const latest = due.at(-1)!;
  const claimable = claim !== null && nowMs - latest <= claim.graceMs;
  let claimedId: string | undefined;
  if (claimable) {
    claimedId = insertOccurrence(row, latest, "claimed", nowMs);
    if (claimedId) {
      endClaimed(row.id, "superseded", nowMs, claimedId);
      effects.claimed.push(claimedId);
    }
  }
  let missed = 0;
  for (const at of (claimable ? due.slice(0, -1) : due).slice(
    -SCHEDULE_HISTORY_LIMIT,
  ))
    if (insertOccurrence(row, at, "missed", nowMs)) missed += 1;
  getDb()
    .prepare("UPDATE schedules SET next_due_at_ms = ? WHERE id = ?")
    .run(nextDueMs ?? null, row.id);
  refreshDone(row.id, nowMs);
  prune(row.id);
  effects.touched.add(row.id);
  return { ...(claimedId ? { claimedId } : {}), missed };
}

/** An enabled Schedule due at or before `nowMs`, live. */
function dueRow(id: string, nowMs: number): ScheduleRow | undefined {
  const row = liveRow(id);
  return row &&
    row.enabled === 1 &&
    row.next_due_at_ms !== null &&
    row.next_due_at_ms <= nowMs
    ? row
    : undefined;
}

function dueIdsAt(nowMs: number): string[] {
  return (
    getDb()
      .prepare(
        `SELECT id FROM schedules
         WHERE deleted_at_ms IS NULL AND enabled = 1
           AND next_due_at_ms IS NOT NULL AND next_due_at_ms <= ?
         ORDER BY next_due_at_ms, id`,
      )
      .all(nowMs) as Array<{ id: string }>
  ).map((row) => row.id);
}

/* ---------------------------------- store --------------------------------- */

export const scheduleStore = {
  /**
   * Create a Schedule. Its first due time is the first occurrence after
   * `nowMs`; a timing with none left is refused. With `cardlessLimit`, a
   * create that would bring its controller over that many counted cardless
   * Schedules throws {@link ScheduleCardlessLimitError} and writes nothing.
   */
  create(
    input: ScheduleCreateInput,
    nowMs = Date.now(),
    options: { cardlessLimit?: number } = {},
  ): ScheduleSummary {
    const name = checkText(input.name, "name");
    const prompt = checkText(input.prompt, "prompt");
    const timing = checkTiming(input.timing);
    const target = checkTarget(input.target);
    const createdBy = checkActor(input.createdBy);
    const controlledBy = checkActor(input.controlledBy ?? input.createdBy);
    const enabled = input.enabled ?? true;
    const [first] = nextOccurrencesAfter(timing, nowMs, 1);
    if (first === undefined)
      throw new Error("Schedule timing has no future occurrence");
    return write((touched) => {
      const id = `sch_${nextId("schedule")}`;
      getDb()
        .prepare(
          `INSERT INTO schedules (
             id, name, prompt, enabled, timing_json, target_kind,
             target_session_id, created_by_json, controlled_by_json, cardless,
             next_due_at_ms, created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          name,
          prompt,
          enabled ? 1 : 0,
          JSON.stringify(timing),
          target.kind,
          target.sessionId,
          JSON.stringify(createdBy),
          JSON.stringify(controlledBy),
          input.cardless ? 1 : 0,
          enabled ? first : null,
          nowMs,
          nowMs,
        );
      assertCardlessCapacity(id, false, options.cardlessLimit);
      touched.add(id);
      return summaryOf(liveRow(id)!);
    });
  },

  /**
   * Change a Schedule's definition at `nowMs`, in ONE transaction. First its
   * due times at or before `nowMs` are settled under the definition BEFORE
   * the change, exactly like a tick (unless Pause all is on, the latest
   * within `policy.graceMs` is claimed with the old frozen input, the rest
   * are `missed`). Then the patch applies. A timing that differs from the
   * stored one (key and day order aside) takes effect from its first
   * occurrence after `nowMs`; any other patch leaves `next_due_at_ms` where
   * the settle left it. A claimed occurrence keeps its frozen input. With
   * `policy.cardlessLimit`, a change that makes the Schedule count again (a
   * done one given a future occurrence) throws
   * {@link ScheduleCardlessLimitError} over the limit and writes nothing.
   */
  update(
    id: string,
    patch: ScheduleUpdate,
    policy: ScheduleWritePolicy,
    nowMs = Date.now(),
  ): ScheduleSummary | undefined {
    const name =
      patch.name === undefined ? undefined : checkText(patch.name, "name");
    const prompt =
      patch.prompt === undefined
        ? undefined
        : checkText(patch.prompt, "prompt");
    const timing =
      patch.timing === undefined ? undefined : checkTiming(patch.timing);
    const target =
      patch.target === undefined ? undefined : checkTarget(patch.target);
    const controlledBy =
      patch.controlledBy === undefined
        ? undefined
        : checkActor(patch.controlledBy);
    return write((touched, claimed) => {
      const before = liveRow(id);
      if (!before) return undefined;
      const wasCounted = countsTowardCardless(before);
      const due = dueRow(id, nowMs);
      if (due)
        settleDue(due, nowMs, pausedIn() ? null : policy, { touched, claimed });
      const row = liveRow(id)!;
      const timingChanged =
        timing !== undefined &&
        !scheduleTimingsEqual(
          JSON.parse(row.timing_json) as ScheduleTiming,
          timing,
        );
      const nextDue = !timingChanged
        ? row.next_due_at_ms
        : row.enabled === 1
          ? (nextOccurrencesAfter(timing, nowMs, 1)[0] ?? null)
          : null;
      getDb()
        .prepare(
          `UPDATE schedules SET name = ?, prompt = ?, timing_json = ?,
             target_kind = ?, target_session_id = ?, controlled_by_json = ?,
             next_due_at_ms = ?, updated_at_ms = ?
           WHERE id = ?`,
        )
        .run(
          name ?? row.name,
          prompt ?? row.prompt,
          timingChanged ? JSON.stringify(timing) : row.timing_json,
          target?.kind ?? row.target_kind,
          target?.sessionId ?? row.target_session_id,
          controlledBy ? JSON.stringify(controlledBy) : row.controlled_by_json,
          nextDue,
          nowMs,
          id,
        );
      refreshDone(id, nowMs);
      assertCardlessCapacity(id, wasCounted, policy.cardlessLimit);
      touched.add(id);
      return summaryOf(liveRow(id)!);
    });
  },

  /**
   * Enable or disable at `nowMs`, in ONE transaction. Disabling first settles
   * the due times at or before `nowMs` under the enabled state, exactly like
   * a tick (a due time within `policy.graceMs` is claimed, an older one, or
   * any while Pause all is on, is `missed`), then withdraws every `claimed`
   * occurrence (an attempted one ends by its admission evidence) and clears
   * the next due time. Enabling starts from the first occurrence after
   * `nowMs`, with no catch-up. Setting the state it already has writes
   * nothing. With `policy.cardlessLimit`, a switch that makes the Schedule
   * count again throws {@link ScheduleCardlessLimitError} over the limit.
   */
  setEnabled(
    id: string,
    enabled: boolean,
    nowMs: number,
    policy: ScheduleWritePolicy,
  ): ScheduleSummary | undefined {
    return write((touched, claimed) => {
      const row = liveRow(id);
      if (!row) return undefined;
      if ((row.enabled === 1) === enabled) return summaryOf(row);
      const wasCounted = countsTowardCardless(row);
      let nextDue: number | null = null;
      if (enabled)
        nextDue =
          nextOccurrencesAfter(
            JSON.parse(row.timing_json) as ScheduleTiming,
            nowMs,
            1,
          )[0] ?? null;
      else {
        const due = dueRow(id, nowMs);
        if (due)
          settleDue(due, nowMs, pausedIn() ? null : policy, {
            touched,
            claimed,
          });
        endClaimed(id, "withdrawn", nowMs);
      }
      getDb()
        .prepare(
          "UPDATE schedules SET enabled = ?, next_due_at_ms = ?, updated_at_ms = ? WHERE id = ?",
        )
        .run(enabled ? 1 : 0, nextDue, nowMs, id);
      refreshDone(id, nowMs);
      prune(id);
      assertCardlessCapacity(id, wasCounted, policy.cardlessLimit);
      touched.add(id);
      return summaryOf(liveRow(id)!);
    });
  },

  /**
   * Delete a Schedule with its history, a `claimed` occurrence included, and
   * leave a tombstone carrying the delete's revision. False when none is live.
   */
  delete(id: string, nowMs = Date.now()): boolean {
    return write((touched) => {
      if (!liveRow(id)) return false;
      tombstone(id, nowMs);
      touched.add(id);
      return true;
    });
  },

  /** Delete every live Schedule that targets `sessionId`; returns their ids. */
  deleteForTarget(sessionId: string, nowMs = Date.now()): string[] {
    return write((touched) => {
      const ids = (
        getDb()
          .prepare(
            "SELECT id FROM schedules WHERE target_session_id = ? AND deleted_at_ms IS NULL",
          )
          .all(sessionId) as Array<{ id: string }>
      ).map((row) => row.id);
      for (const id of ids) {
        tombstone(id, nowMs);
        touched.add(id);
      }
      return ids;
    });
  },

  /**
   * Settle every due time of one Schedule up to `nowMs` in ONE transaction:
   * unless Pause all is on (read in this transaction), the latest is claimed
   * when no older than the grace window; every other one is recorded `missed`
   * (the newest {@link SCHEDULE_HISTORY_LIMIT} of them), and `next_due_at_ms`
   * advances to the first occurrence after `nowMs`. A claim supersedes an
   * earlier still-`claimed` occurrence; while paused nothing is claimed and an
   * existing claim stays owed.
   *
   * A due time already recorded (the unique `(schedule_id, due_at_ms)`)
   * inserts nothing, so a claim happens at most once across restarts.
   */
  claimDue(
    id: string,
    nowMs: number,
    policy: ScheduleClaimPolicy,
  ): ScheduleClaimOutcome {
    return write((touched, claimed) => {
      const row = dueRow(id, nowMs);
      if (!row) return { missed: 0 };
      const { claimedId, missed } = settleDue(
        row,
        nowMs,
        pausedIn() ? null : policy,
        { touched, claimed },
      );
      const claimedRow = claimedId ? occurrenceRow(claimedId) : undefined;
      return {
        ...(claimedRow ? { claimed: occurrenceRecordOf(claimedRow) } : {}),
        missed,
      };
    });
  },

  /**
   * Pause all, or resume, at `nowMs` in ONE transaction. First every due
   * Schedule is settled under the state before the switch: a due time at or
   * before `nowMs` belongs to it. Pausing claims the latest within `graceMs`
   * that fell unpaused and not yet ticked; resuming records the due times that
   * fell while paused `missed`, with no catch-up and no supersession. Then the
   * row flips. Setting the state it already has writes nothing.
   */
  setPaused(
    paused: boolean,
    nowMs: number,
    graceMs: number,
  ): SchedulePauseOutcome {
    return write((touched, claimed) => {
      const prior = pausedIn();
      if (prior === paused) return { changed: false, claimed: [], missed: 0 };
      const claimedIds: string[] = [];
      let missed = 0;
      for (const id of dueIdsAt(nowMs)) {
        const row = dueRow(id, nowMs)!;
        const settled = settleDue(row, nowMs, prior ? null : { graceMs }, {
          touched,
          claimed,
        });
        if (settled.claimedId) claimedIds.push(settled.claimedId);
        missed += settled.missed;
      }
      getDb()
        .prepare("UPDATE schedule_pause SET paused = ? WHERE id = 1")
        .run(paused ? 1 : 0);
      return {
        changed: true,
        claimed: claimedIds.map((id) => occurrenceRecordOf(occurrenceRow(id)!)),
        missed,
      };
    });
  },

  /**
   * Move a `claimed` occurrence to a terminal state. Conditional: a row that
   * is gone or already terminal is left as it is and false comes back, so a
   * repeated or late settle never overwrites a state or moves `done_at_ms`.
   */
  settleOccurrence(
    occurrenceId: string,
    state: ScheduleTerminalState,
    details: { sessionId?: string; error?: string } = {},
    nowMs = Date.now(),
  ): boolean {
    if ((state as ScheduleOccurrenceState) === "claimed")
      throw new Error("An occurrence settles into a terminal state");
    return write((touched) => {
      const row = occurrenceRow(occurrenceId);
      if (!row || row.state !== "claimed") return false;
      const changed = getDb()
        .prepare(
          `UPDATE schedule_occurrences
           SET state = ?, ended_at_ms = ?, session_id = COALESCE(?, session_id),
               error = COALESCE(?, error)
           WHERE id = ? AND state = 'claimed'`,
        )
        .run(
          state,
          nowMs,
          details.sessionId ?? null,
          details.error ?? null,
          occurrenceId,
        );
      if (Number(changed.changes) === 0) return false;
      refreshDone(row.schedule_id, nowMs);
      prune(row.schedule_id);
      touched.add(row.schedule_id);
      return true;
    });
  },

  /** Record a delivery attempt on a still-`claimed` occurrence; false otherwise. */
  markAttempted(occurrenceId: string, nowMs = Date.now()): boolean {
    return write((touched) => {
      const row = occurrenceRow(occurrenceId);
      if (!row || row.state !== "claimed") return false;
      getDb()
        .prepare(
          "UPDATE schedule_occurrences SET attempted_at_ms = ? WHERE id = ? AND state = 'claimed'",
        )
        .run(nowMs, occurrenceId);
      touched.add(row.schedule_id);
      return true;
    });
  },

  /**
   * The retention sweep: mark done a Schedule whose timing expired with no
   * write to notice it (a disabled finite one), prune history, delete
   * Schedules `done` for 30 days and Schedules whose target session was
   * deleted (each leaving a tombstone), and purge tombstones older than 30
   * days.
   */
  runMaintenance(nowMs = Date.now()): ScheduleMaintenanceOutcome {
    return write((touched) => {
      const db = getDb();
      // Only a not-yet-done row is looked at, so a sweep can stamp done_at
      // at its own time but never move or clear one.
      for (const { id } of db
        .prepare(
          "SELECT id FROM schedules WHERE deleted_at_ms IS NULL AND done_at_ms IS NULL",
        )
        .all() as Array<{ id: string }>)
        if (refreshDone(id, nowMs)) touched.add(id);
      let pruned = 0;
      for (const { id } of db
        .prepare("SELECT id FROM schedules WHERE deleted_at_ms IS NULL")
        .all() as Array<{ id: string }>)
        pruned += prune(id);
      const doomed = db
        .prepare(
          `SELECT id FROM schedules
           WHERE deleted_at_ms IS NULL AND done_at_ms IS NOT NULL
             AND done_at_ms <= ?
           UNION
           SELECT s.id FROM schedules s
           JOIN session_index si ON si.id = s.target_session_id
           WHERE s.deleted_at_ms IS NULL AND si.deleted_at_ms IS NOT NULL
           ORDER BY id`,
        )
        .all(nowMs - SCHEDULE_RETENTION_MS) as Array<{ id: string }>;
      const deleted: string[] = [];
      for (const { id } of doomed) {
        tombstone(id, nowMs);
        touched.add(id);
        deleted.push(id);
      }
      const purged = Number(
        db
          .prepare(
            "DELETE FROM schedules WHERE deleted_at_ms IS NOT NULL AND deleted_at_ms <= ?",
          )
          .run(nowMs - SCHEDULE_RETENTION_MS).changes,
      );
      return { deleted, purged, pruned };
    });
  },

  /* ---------------------------------- reads --------------------------------- */

  get(id: string): ScheduleSummary | undefined {
    const row = liveRow(id);
    return row ? summaryOf(row) : undefined;
  },

  /** Every live Schedule, oldest first. */
  list(): ScheduleSummary[] {
    return (
      getDb()
        .prepare(
          "SELECT * FROM schedules WHERE deleted_at_ms IS NULL ORDER BY created_at_ms, id",
        )
        .all() as unknown as ScheduleRow[]
    ).map(summaryOf);
  },

  /**
   * `{revision, live}` for exactly these ids, tombstones included (not live);
   * a purged id is absent.
   */
  revisionsFor(
    ids: readonly string[],
  ): Map<string, { revision: number; live: boolean }> {
    const read = getDb().prepare(
      "SELECT revision, deleted_at_ms FROM schedules WHERE id = ?",
    );
    const out = new Map<string, { revision: number; live: boolean }>();
    for (const id of ids) {
      const row = read.get(id) as
        { revision: number; deleted_at_ms: number | null } | undefined;
      if (row)
        out.set(id, {
          revision: row.revision,
          live: row.deleted_at_ms === null,
        });
    }
    return out;
  },

  /** `{id, revision}` of every live Schedule, for the topic's digest. */
  digest(): Array<{ id: string; revision: number }> {
    return getDb()
      .prepare(
        "SELECT id, revision FROM schedules WHERE deleted_at_ms IS NULL ORDER BY id",
      )
      .all() as Array<{ id: string; revision: number }>;
  },

  /** A Schedule's revision, its tombstone's included; undefined once purged. */
  revision(id: string): number | undefined {
    const row = getDb()
      .prepare("SELECT revision FROM schedules WHERE id = ?")
      .get(id) as { revision: number } | undefined;
    return row?.revision;
  },

  getOccurrence(id: string): ScheduleOccurrenceRecord | undefined {
    const row = occurrenceRow(id);
    return row ? occurrenceRecordOf(row) : undefined;
  },

  /** A Schedule's occurrences, newest due time first. */
  history(scheduleId: string): ScheduleOccurrenceSummary[] {
    return (
      getDb()
        .prepare(
          "SELECT * FROM schedule_occurrences WHERE schedule_id = ? ORDER BY due_at_ms DESC, id DESC",
        )
        .all(scheduleId) as unknown as OccurrenceRow[]
    ).map(occurrenceSummaryOf);
  },

  /** The occurrences still owed to a session, oldest due time first. */
  owedForTarget(sessionId: string): ScheduleOccurrenceRecord[] {
    return (
      getDb()
        .prepare(
          `SELECT * FROM schedule_occurrences
           WHERE target_session_id = ? AND state = 'claimed'
           ORDER BY due_at_ms, id`,
        )
        .all(sessionId) as unknown as OccurrenceRow[]
    ).map(occurrenceRecordOf);
  },

  /** Whether any occurrence is still owed to a session: the lane's cheap check. */
  owesTarget(sessionId: string): boolean {
    return (
      getDb()
        .prepare(
          "SELECT 1 FROM schedule_occurrences WHERE target_session_id = ? AND state = 'claimed' LIMIT 1",
        )
        .get(sessionId) !== undefined
    );
  },

  /** Every occurrence still `claimed`, oldest due time first: boot recovery. */
  claimedOccurrences(): ScheduleOccurrenceRecord[] {
    return (
      getDb()
        .prepare(
          `SELECT * FROM schedule_occurrences WHERE state = 'claimed'
           ORDER BY due_at_ms, id`,
        )
        .all() as unknown as OccurrenceRow[]
    ).map(occurrenceRecordOf);
  },

  /**
   * Hear about every committed write that touched a Schedule: the clock
   * re-arms on it. A listener's throw is logged and never fails the write.
   */
  onWrite(listener: () => void): () => void {
    writeListeners.add(listener);
    return () => writeListeners.delete(listener);
  },

  /**
   * Hear about each occurrence claimed, by a tick or by a Pause all switch:
   * once, after its claim committed, never for a rollback. A wake for whoever
   * listens now, not a durable event: a claim committed with no listener
   * stays owed and is not replayed to a later one. A listener's throw is
   * logged; the others still run.
   */
  onClaimed(
    listener: (occurrence: ScheduleOccurrenceRecord) => void,
  ): () => void {
    claimListeners.add(listener);
    return () => claimListeners.delete(listener);
  },

  /**
   * Register how an attempted `claimed` occurrence's admission is found, or
   * clear it with `undefined`. Every write that would end such a row other
   * than by its own settle (a newer claim, an edit, a Pause all switch, a
   * disable) calls it inside its transaction; with none registered that
   * write throws {@link ScheduleAdmissionResolverMissingError} and rolls back.
   */
  setAdmissionResolver(resolver: ScheduleAdmissionResolver | undefined): void {
    admissionResolver = resolver;
  },

  /** Whether an admission resolver is registered now. */
  hasAdmissionResolver(): boolean {
    return admissionResolver !== undefined;
  },

  /**
   * Pause all as stored. The first read creates the row unpaused (its own
   * transaction, or the caller's).
   */
  paused(): boolean {
    const row = getDb()
      .prepare("SELECT paused FROM schedule_pause WHERE id = 1")
      .get() as { paused: number } | undefined;
    return row ? row.paused === 1 : inDbTransaction(pausedIn);
  },

  /** The earliest due time among enabled Schedules, for arming the clock. */
  earliestDueAtMs(): number | undefined {
    const row = getDb()
      .prepare(
        `SELECT MIN(next_due_at_ms) AS due FROM schedules
         WHERE deleted_at_ms IS NULL AND enabled = 1 AND next_due_at_ms IS NOT NULL`,
      )
      .get() as { due: number | null } | undefined;
    return row?.due ?? undefined;
  },

  /** Enabled Schedules due at or before `nowMs`, earliest first. */
  dueIds(nowMs: number): string[] {
    return dueIdsAt(nowMs);
  },
};
