/**
 * Schedules and their occurrences (`docs/schedules.md`, migration 0107).
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
 * Nothing in production creates a Schedule yet: the agent tools that will
 * arrive with the scheduled prompts lane ([Task-1503](pa://task/1503)).
 */
import {
  nextOccurrencesAfter,
  scheduleTimingError,
  type ScheduleActor,
  type ScheduleOccurrenceState,
  type ScheduleOccurrenceSummary,
  type ScheduleSummary,
  type ScheduleTarget,
  type ScheduleTerminalState,
  type ScheduleTiming,
} from "@assistant/shared/schedules";
import { withChangeSet, type StateTopicWrites } from "./changeSet.ts";
import { getDb } from "./index.ts";
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

/** How the clock wants due times settled: its grace window and Pause all. */
export interface ScheduleClaimPolicy {
  graceMs: number;
  paused: boolean;
}

export interface ScheduleClaimOutcome {
  /** The occurrence claimed now, read back from its frozen row. */
  claimed?: ScheduleOccurrenceRecord;
  /** Due times recorded `missed` by this call. */
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

function checkTiming(timing: ScheduleTiming): ScheduleTiming {
  const reason = scheduleTimingError(timing);
  if (reason) throw new Error(reason);
  return timing;
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

/**
 * One write transaction with a change set. Every Schedule id `fn` adds to
 * `touched` is stamped with the transaction's `schedules` revision as its last
 * statement and reported to the topic after commit, so a throw anywhere, the
 * stamp included, rolls back the whole write and announces nothing.
 */
function write<T>(fn: (touched: Set<string>) => T): T {
  return withChangeSet((changes) => {
    const touched = new Set<string>();
    const value = fn(touched);
    changes.touch(scheduleTopicWrites, [...touched]);
    return value;
  });
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
 * transition that made it so and kept while it stays done.
 */
function refreshDone(scheduleId: string, nowMs: number): void {
  const row = liveRow(scheduleId);
  if (!row) return;
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

/** End every `claimed` occurrence of a Schedule in `state`; returns how many. */
function endClaimed(
  scheduleId: string,
  state: "superseded" | "withdrawn",
  nowMs: number,
  exceptId?: string,
): number {
  return Number(
    getDb()
      .prepare(
        `UPDATE schedule_occurrences SET state = ?, ended_at_ms = ?
         WHERE schedule_id = ? AND state = 'claimed' AND id <> ?`,
      )
      .run(state, nowMs, scheduleId, exceptId ?? "").changes,
  );
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

/* ---------------------------------- store --------------------------------- */

export const scheduleStore = {
  /**
   * Create a Schedule. Its first due time is the first occurrence after
   * `nowMs`; a timing with none left is refused.
   */
  create(input: ScheduleCreateInput, nowMs = Date.now()): ScheduleSummary {
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
      touched.add(id);
      return summaryOf(liveRow(id)!);
    });
  },

  /**
   * Change a Schedule's definition. A claimed occurrence keeps its frozen
   * input; a new timing takes effect from the first occurrence after `nowMs`.
   */
  update(
    id: string,
    patch: ScheduleUpdate,
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
    return write((touched) => {
      const row = liveRow(id);
      if (!row) return undefined;
      const nextDue =
        timing === undefined
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
          timing ? JSON.stringify(timing) : row.timing_json,
          target?.kind ?? row.target_kind,
          target?.sessionId ?? row.target_session_id,
          controlledBy ? JSON.stringify(controlledBy) : row.controlled_by_json,
          nextDue,
          nowMs,
          id,
        );
      refreshDone(id, nowMs);
      touched.add(id);
      return summaryOf(liveRow(id)!);
    });
  },

  /**
   * Enable or disable. Disabling withdraws a `claimed` occurrence in the same
   * transaction; enabling starts from the first occurrence after `nowMs`, with
   * no catch-up. Setting the state it already has writes nothing.
   */
  setEnabled(
    id: string,
    enabled: boolean,
    nowMs = Date.now(),
  ): ScheduleSummary | undefined {
    return write((touched) => {
      const row = liveRow(id);
      if (!row) return undefined;
      if ((row.enabled === 1) === enabled) return summaryOf(row);
      let nextDue: number | null = null;
      if (enabled)
        nextDue =
          nextOccurrencesAfter(
            JSON.parse(row.timing_json) as ScheduleTiming,
            nowMs,
            1,
          )[0] ?? null;
      else endClaimed(id, "withdrawn", nowMs);
      getDb()
        .prepare(
          "UPDATE schedules SET enabled = ?, next_due_at_ms = ?, updated_at_ms = ? WHERE id = ?",
        )
        .run(enabled ? 1 : 0, nextDue, nowMs, id);
      refreshDone(id, nowMs);
      prune(id);
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
   * the latest is claimed when not paused and no older than the grace window,
   * every other one is recorded `missed` (the newest
   * {@link SCHEDULE_HISTORY_LIMIT} of them), and `next_due_at_ms` advances to
   * the first occurrence after `nowMs`. A claim supersedes an earlier
   * still-`claimed` occurrence; while paused an existing claim stays owed.
   *
   * A due time already recorded (the unique `(schedule_id, due_at_ms)`)
   * inserts nothing, so a claim happens at most once across restarts.
   */
  claimDue(
    id: string,
    nowMs: number,
    policy: ScheduleClaimPolicy,
  ): ScheduleClaimOutcome {
    return write((touched) => {
      const row = liveRow(id);
      if (
        !row ||
        row.enabled !== 1 ||
        row.next_due_at_ms === null ||
        row.next_due_at_ms > nowMs
      )
        return { missed: 0 };
      const timing = JSON.parse(row.timing_json) as ScheduleTiming;
      const { due, nextDueMs } = dueTimesThrough(
        timing,
        row.next_due_at_ms,
        nowMs,
      );
      const latest = due.at(-1)!;
      const claimable = !policy.paused && nowMs - latest <= policy.graceMs;
      let claimedId: string | undefined;
      if (claimable) {
        claimedId = insertOccurrence(row, latest, "claimed", nowMs);
        if (claimedId) endClaimed(id, "superseded", nowMs, claimedId);
      }
      let missed = 0;
      for (const at of (claimable ? due.slice(0, -1) : due).slice(
        -SCHEDULE_HISTORY_LIMIT,
      ))
        if (insertOccurrence(row, at, "missed", nowMs)) missed += 1;
      getDb()
        .prepare("UPDATE schedules SET next_due_at_ms = ? WHERE id = ?")
        .run(nextDueMs ?? null, id);
      refreshDone(id, nowMs);
      prune(id);
      touched.add(id);
      const claimed = claimedId ? occurrenceRow(claimedId) : undefined;
      return {
        ...(claimed ? { claimed: occurrenceRecordOf(claimed) } : {}),
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
   * The retention sweep: prune history, delete Schedules `done` for 30 days
   * and Schedules whose target session was deleted (each leaving a
   * tombstone), and purge tombstones older than 30 days.
   */
  runMaintenance(nowMs = Date.now()): ScheduleMaintenanceOutcome {
    return write((touched) => {
      const db = getDb();
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
  },
};
