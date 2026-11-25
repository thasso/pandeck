import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ScheduleTiming } from "@assistant/shared/schedules";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { APP_SETTINGS_PATH } from "../appSettingsFile.ts";
import { setStateChangeSink } from "./changeSet.ts";
import { closeDb, getDb } from "./index.ts";
import {
  SCHEDULE_HISTORY_LIMIT,
  SCHEDULE_RETENTION_MS,
  ScheduleAdmissionResolverMissingError,
  ScheduleCardlessLimitError,
  scheduleStore,
  type ScheduleAdmissionEvidence,
  type ScheduleCreateInput,
  type ScheduleOccurrenceRecord,
} from "./scheduleStore.ts";
import { currentId } from "./sequences.ts";
import { sessionStore } from "./sessionStore.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const at = (iso: string) => Date.parse(iso);
const GRACE = { graceMs: 60 * MINUTE };

/** 09:00 UTC daily: due instants are fixed strings, no zone arithmetic. */
const DAILY: ScheduleTiming = { kind: "daily", time: "09:00", timeZone: "UTC" };
const DEC1 = at("2026-12-01T09:00:00Z");

let seq = 0;
function input(patch: Partial<ScheduleCreateInput> = {}): ScheduleCreateInput {
  seq += 1;
  return {
    name: `Check ${seq}`,
    prompt: `Check CI for PR #${seq}`,
    timing: DAILY,
    target: { kind: "session", sessionId: `target-${seq}` },
    createdBy: { kind: "session", sessionId: `creator-${seq}` },
    cardless: true,
    ...patch,
  };
}

function states(scheduleId: string): string[] {
  return scheduleStore
    .history(scheduleId)
    .map((o) => `${new Date(o.dueAtMs).toISOString()} ${o.state}`);
}

/** Pause all with no stored row, and no settings file left by a test. */
function resetPause(): void {
  getDb().exec("DELETE FROM schedule_pause");
  rmSync(APP_SETTINGS_PATH, { force: true });
}

function writeSettingsFile(text: string): void {
  mkdirSync(dirname(APP_SETTINGS_PATH), { recursive: true });
  writeFileSync(APP_SETTINGS_PATH, text);
}

function pauseRow(): number | undefined {
  return (
    getDb().prepare("SELECT paused FROM schedule_pause WHERE id = 1").get() as
      { paused: number } | undefined
  )?.paused;
}

/** Makes the revision stamp, the LAST statement of every write, throw. */
function withFailingStamp(fn: () => void): void {
  getDb().exec(`CREATE TEMP TRIGGER fail_schedule_stamp
    BEFORE UPDATE OF revision ON schedules
    BEGIN SELECT RAISE(ABORT, 'stamp failed'); END`);
  try {
    fn();
  } finally {
    getDb().exec("DROP TRIGGER temp.fail_schedule_stamp");
  }
}

describe("scheduleStore", () => {
  it("creates with sch_<n>, the first due time strictly after now, and a revision", () => {
    const created = scheduleStore.create(input(), DEC1 - 1);
    assert.match(created.id, /^sch_\d+$/);
    assert.equal(created.nextDueAtMs, DEC1);
    assert.equal(created.enabled, true);
    assert.equal(created.cardless, true);
    assert.deepEqual(created.controlledBy, created.createdBy);
    assert.ok(scheduleStore.revision(created.id)! > 0);
    // Exactly at a due time, that one is not "after now".
    assert.equal(scheduleStore.create(input(), DEC1).nextDueAtMs, DEC1 + DAY);
  });

  it("refuses invalid input and a timing with no future occurrence", () => {
    assert.throws(
      () => scheduleStore.create(input({ name: "  " })),
      /name must be a non-empty string/,
    );
    assert.throws(
      () =>
        scheduleStore.create(
          input({ timing: { ...DAILY, time: "25:00" } as ScheduleTiming }),
        ),
      /timing.time/,
    );
    assert.throws(
      () =>
        scheduleStore.create(
          input({
            timing: {
              kind: "once",
              date: "2026-12-01",
              time: "09:00",
              timeZone: "UTC",
            },
          }),
          DEC1,
        ),
      /no future occurrence/,
    );
  });

  it("claims at the exact due millisecond, never before, and advances next due", () => {
    const { id } = scheduleStore.create(input(), DEC1 - DAY);
    assert.deepEqual(scheduleStore.claimDue(id, DEC1 - 1, GRACE), {
      missed: 0,
    });
    assert.deepEqual(scheduleStore.history(id), []);
    const outcome = scheduleStore.claimDue(id, DEC1, GRACE);
    assert.equal(outcome.missed, 0);
    assert.equal(outcome.claimed?.dueAtMs, DEC1);
    assert.equal(outcome.claimed?.claimedAtMs, DEC1);
    assert.equal(outcome.claimed?.state, "claimed");
    assert.equal(scheduleStore.get(id)?.nextDueAtMs, DEC1 + DAY);
  });

  it("claims a due time at most once: a repeat or a stale next due inserts nothing", () => {
    const { id } = scheduleStore.create(input(), DEC1 - DAY);
    const first = scheduleStore.claimDue(id, DEC1, GRACE).claimed!;
    assert.deepEqual(scheduleStore.claimDue(id, DEC1, GRACE), { missed: 0 });
    // A crash between claim and a later bookkeeping step cannot exist (one
    // transaction), but even a next due rolled back by hand re-claims nothing
    // and does not supersede the owed row.
    getDb()
      .prepare("UPDATE schedules SET next_due_at_ms = ? WHERE id = ?")
      .run(DEC1, id);
    const again = scheduleStore.claimDue(id, DEC1 + MINUTE, GRACE);
    assert.equal(again.claimed, undefined);
    assert.deepEqual(states(id), ["2026-12-01T09:00:00.000Z claimed"]);
    assert.equal(scheduleStore.getOccurrence(first.id)?.state, "claimed");
  });

  it("freezes the claimed input: a later edit never changes a claimed occurrence", () => {
    const { id } = scheduleStore.create(
      input({
        name: "Roadmap",
        prompt: "Update the roadmap",
        target: { kind: "session", sessionId: "frozen-target" },
        timing: { ...DAILY, timeZone: "Europe/Berlin", time: "10:00" },
      }),
      DEC1 - DAY,
    );
    const claimed = scheduleStore.claimDue(id, DEC1, GRACE).claimed!;
    scheduleStore.update(
      id,
      {
        name: "Renamed",
        prompt: "Something else",
        target: { kind: "session", sessionId: "other-target" },
        timing: { ...DAILY, timeZone: "Asia/Tokyo" },
      },
      GRACE,
      DEC1 + MINUTE,
    );
    const frozen = scheduleStore.getOccurrence(claimed.id)!;
    assert.equal(frozen.name, "Roadmap");
    assert.equal(frozen.prompt, "Update the roadmap");
    assert.equal(frozen.timeZone, "Europe/Berlin");
    assert.deepEqual(frozen.target, {
      kind: "session",
      sessionId: "frozen-target",
    });
    assert.deepEqual(
      scheduleStore.owedForTarget("frozen-target").map((o) => o.id),
      [claimed.id],
    );
    assert.deepEqual(scheduleStore.owedForTarget("other-target"), []);
  });

  it("a newer claim supersedes a still-claimed earlier one in the same transaction", () => {
    const { id } = scheduleStore.create(input(), DEC1 - DAY);
    scheduleStore.claimDue(id, DEC1, GRACE);
    scheduleStore.claimDue(id, DEC1 + DAY, GRACE);
    assert.deepEqual(states(id), [
      "2026-12-02T09:00:00.000Z claimed",
      "2026-12-01T09:00:00.000Z superseded",
    ]);
  });

  it("claims a late due time within the grace window and misses one older than it", () => {
    const onTime = scheduleStore.create(input(), DEC1 - DAY).id;
    assert.ok(
      scheduleStore.claimDue(onTime, DEC1 + 30 * MINUTE, GRACE).claimed,
    );
    const edge = scheduleStore.create(input(), DEC1 - DAY).id;
    assert.ok(scheduleStore.claimDue(edge, DEC1 + 60 * MINUTE, GRACE).claimed);
    const late = scheduleStore.create(input(), DEC1 - DAY).id;
    const outcome = scheduleStore.claimDue(late, DEC1 + 90 * MINUTE, GRACE);
    assert.equal(outcome.claimed, undefined);
    assert.equal(outcome.missed, 1);
    assert.deepEqual(states(late), ["2026-12-01T09:00:00.000Z missed"]);
    assert.equal(scheduleStore.get(late)?.nextDueAtMs, DEC1 + DAY);
  });

  it("replays no backlog: of three due times the latest is claimed, the rest missed", () => {
    const { id } = scheduleStore.create(input(), DEC1 - DAY);
    const outcome = scheduleStore.claimDue(id, DEC1 + 2 * DAY + MINUTE, GRACE);
    assert.equal(outcome.claimed?.dueAtMs, DEC1 + 2 * DAY);
    assert.equal(outcome.missed, 2);
    assert.deepEqual(states(id), [
      "2026-12-03T09:00:00.000Z claimed",
      "2026-12-02T09:00:00.000Z missed",
      "2026-12-01T09:00:00.000Z missed",
    ]);
    assert.equal(scheduleStore.get(id)?.nextDueAtMs, DEC1 + 3 * DAY);
  });

  it("records at most the history limit of missed due times after long downtime", () => {
    const { id } = scheduleStore.create(input(), DEC1 - DAY);
    const outcome = scheduleStore.claimDue(
      id,
      DEC1 + 200 * DAY + MINUTE,
      GRACE,
    );
    assert.equal(outcome.claimed?.dueAtMs, DEC1 + 200 * DAY);
    assert.equal(outcome.missed, SCHEDULE_HISTORY_LIMIT);
    // The claimed row plus the newest 50 terminal rows; nothing older kept.
    assert.equal(scheduleStore.history(id).length, SCHEDULE_HISTORY_LIMIT + 1);
    assert.equal(scheduleStore.get(id)?.nextDueAtMs, DEC1 + 201 * DAY);
  });

  it("while paused claims nothing, misses crossed due times and keeps an earlier claim owed (S3)", () => {
    const { id } = scheduleStore.create(input(), DEC1 - DAY);
    const owed = scheduleStore.claimDue(id, DEC1, GRACE).claimed!;
    scheduleStore.setPaused(true, DEC1 + MINUTE, GRACE.graceMs);
    const outcome = scheduleStore.claimDue(id, DEC1 + 2 * DAY, GRACE);
    assert.equal(outcome.claimed, undefined);
    assert.equal(outcome.missed, 2);
    assert.deepEqual(states(id), [
      "2026-12-03T09:00:00.000Z missed",
      "2026-12-02T09:00:00.000Z missed",
      "2026-12-01T09:00:00.000Z claimed",
    ]);
    assert.equal(scheduleStore.getOccurrence(owed.id)?.state, "claimed");
    // Resume: nothing catches up before the next due time.
    scheduleStore.setPaused(false, DEC1 + 2 * DAY + MINUTE, GRACE.graceMs);
    assert.deepEqual(
      scheduleStore.claimDue(id, DEC1 + 2 * DAY + MINUTE, GRACE),
      { missed: 0 },
    );
    assert.equal(scheduleStore.get(id)?.nextDueAtMs, DEC1 + 3 * DAY);
    assert.equal(scheduleStore.getOccurrence(owed.id)?.state, "claimed");
  });

  it("disabling withdraws the claimed occurrence; enabling resumes from now without catch-up", () => {
    const { id } = scheduleStore.create(input(), DEC1 - DAY);
    const owed = scheduleStore.claimDue(id, DEC1, GRACE).claimed!;
    const disabled = scheduleStore.setEnabled(id, false, DEC1 + MINUTE, GRACE)!;
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.nextDueAtMs, undefined);
    assert.equal(disabled.doneAtMs, undefined);
    assert.equal(scheduleStore.getOccurrence(owed.id)?.state, "withdrawn");
    const enabled = scheduleStore.setEnabled(id, true, DEC1 + 3 * DAY, GRACE)!;
    assert.equal(enabled.nextDueAtMs, DEC1 + 3 * DAY + DAY);
    assert.deepEqual(scheduleStore.claimDue(id, DEC1 + 3 * DAY, GRACE), {
      missed: 0,
    });
  });

  it("setting the enabled state it already has writes nothing", () => {
    const { id } = scheduleStore.create(input(), DEC1 - DAY);
    const before = scheduleStore.revision(id);
    scheduleStore.setEnabled(id, true, DEC1, GRACE);
    assert.equal(scheduleStore.revision(id), before);
  });

  it("rolls the whole claim back when a later statement throws", () => {
    const { id } = scheduleStore.create(input(), DEC1 - DAY);
    const owed = scheduleStore.claimDue(id, DEC1, GRACE).claimed!;
    const revision = scheduleStore.revision(id);
    withFailingStamp(() =>
      assert.throws(
        () => scheduleStore.claimDue(id, DEC1 + 2 * DAY, GRACE),
        /stamp failed/,
      ),
    );
    // No insert, no supersede, no miss, no advance, no revision.
    assert.deepEqual(states(id), ["2026-12-01T09:00:00.000Z claimed"]);
    assert.equal(scheduleStore.getOccurrence(owed.id)?.state, "claimed");
    assert.equal(scheduleStore.get(id)?.nextDueAtMs, DEC1 + DAY);
    assert.equal(scheduleStore.revision(id), revision);
  });

  it("rolls a disable's withdrawal back when a later statement throws", () => {
    const { id } = scheduleStore.create(input(), DEC1 - DAY);
    const owed = scheduleStore.claimDue(id, DEC1, GRACE).claimed!;
    withFailingStamp(() =>
      assert.throws(() => scheduleStore.setEnabled(id, false, DEC1 + 1, GRACE)),
    );
    assert.equal(scheduleStore.getOccurrence(owed.id)?.state, "claimed");
    assert.equal(scheduleStore.get(id)?.enabled, true);
  });

  it("settles conditionally and idempotently; done_at is the terminal transition time, not the claim time", () => {
    const { id } = scheduleStore.create(
      input({
        timing: {
          kind: "once",
          date: "2026-12-01",
          time: "09:00",
          timeZone: "UTC",
        },
      }),
      DEC1 - DAY,
    );
    const claimed = scheduleStore.claimDue(id, DEC1, GRACE).claimed!;
    // Claimed and owed: not done yet, though nothing is due any more.
    assert.equal(scheduleStore.get(id)?.nextDueAtMs, undefined);
    assert.equal(scheduleStore.get(id)?.doneAtMs, undefined);
    const settledAt = DEC1 + 7 * MINUTE;
    assert.equal(
      scheduleStore.settleOccurrence(
        claimed.id,
        "delivered",
        { sessionId: "target-session" },
        settledAt,
      ),
      true,
    );
    const done = scheduleStore.get(id)!;
    assert.equal(done.doneAtMs, settledAt);
    assert.equal(done.lastOccurrence?.state, "delivered");
    assert.equal(done.lastOccurrence?.sessionId, "target-session");
    assert.equal(done.lastOccurrence?.endedAtMs, settledAt);
    const revision = scheduleStore.revision(id);
    // A repeated or late settle changes nothing.
    assert.equal(
      scheduleStore.settleOccurrence(
        claimed.id,
        "failed",
        { error: "late" },
        settledAt + DAY,
      ),
      false,
    );
    assert.equal(scheduleStore.getOccurrence(claimed.id)?.state, "delivered");
    assert.equal(scheduleStore.getOccurrence(claimed.id)?.error, undefined);
    assert.equal(scheduleStore.get(id)?.doneAtMs, settledAt);
    assert.equal(scheduleStore.revision(id), revision);
    assert.equal(
      scheduleStore.settleOccurrence("occ_missing", "failed"),
      false,
    );
    assert.throws(() =>
      scheduleStore.settleOccurrence(claimed.id, "claimed" as "failed"),
    );
  });

  it("supersede and withdraw never touch a row that is already terminal", () => {
    const { id } = scheduleStore.create(input(), DEC1 - DAY);
    const first = scheduleStore.claimDue(id, DEC1, GRACE).claimed!;
    scheduleStore.settleOccurrence(
      first.id,
      "failed",
      { error: "x" },
      DEC1 + 1,
    );
    scheduleStore.claimDue(id, DEC1 + DAY, GRACE);
    scheduleStore.setEnabled(id, false, DEC1 + DAY + 1, GRACE);
    assert.deepEqual(states(id), [
      "2026-12-02T09:00:00.000Z withdrawn",
      "2026-12-01T09:00:00.000Z failed",
    ]);
    assert.equal(scheduleStore.getOccurrence(first.id)?.endedAtMs, DEC1 + 1);
  });

  it("marks an attempt only on a claimed occurrence", () => {
    const { id } = scheduleStore.create(input(), DEC1 - DAY);
    const claimed = scheduleStore.claimDue(id, DEC1, GRACE).claimed!;
    assert.equal(scheduleStore.markAttempted(claimed.id, DEC1 + 5), true);
    assert.equal(
      scheduleStore.getOccurrence(claimed.id)?.attemptedAtMs,
      DEC1 + 5,
    );
    scheduleStore.settleOccurrence(claimed.id, "delivered", {}, DEC1 + 6);
    assert.equal(scheduleStore.markAttempted(claimed.id, DEC1 + 7), false);
    assert.equal(
      scheduleStore.getOccurrence(claimed.id)?.attemptedAtMs,
      DEC1 + 5,
    );
  });

  it("keeps the newest 50 terminal occurrences and never prunes a claimed one", () => {
    const { id } = scheduleStore.create(input(), DEC1 - DAY);
    for (let day = 0; day < SCHEDULE_HISTORY_LIMIT + 1; day += 1) {
      const claimed = scheduleStore.claimDue(
        id,
        DEC1 + day * DAY,
        GRACE,
      ).claimed!;
      scheduleStore.settleOccurrence(
        claimed.id,
        "delivered",
        {},
        DEC1 + day * DAY + 1,
      );
    }
    let history = scheduleStore.history(id);
    assert.equal(history.length, SCHEDULE_HISTORY_LIMIT);
    // The 51st terminal row pruned the oldest (1 December).
    assert.equal(history.at(-1)?.dueAtMs, DEC1 + DAY);
    const owed = scheduleStore.claimDue(
      id,
      DEC1 + (SCHEDULE_HISTORY_LIMIT + 1) * DAY,
      GRACE,
    ).claimed!;
    history = scheduleStore.history(id);
    assert.equal(history.length, SCHEDULE_HISTORY_LIMIT + 1);
    assert.equal(history[0]?.id, owed.id);
    assert.equal(
      history.filter((o) => o.state !== "claimed").length,
      SCHEDULE_HISTORY_LIMIT,
    );
  });

  it("deletes with its history into a tombstone carrying the delete's revision", () => {
    const { id } = scheduleStore.create(input(), DEC1 - DAY);
    scheduleStore.claimDue(id, DEC1, GRACE);
    const before = scheduleStore.revision(id)!;
    assert.equal(scheduleStore.delete(id, DEC1 + 1), true);
    assert.equal(scheduleStore.get(id), undefined);
    assert.deepEqual(scheduleStore.history(id), []);
    assert.ok(scheduleStore.revision(id)! > before);
    assert.equal(
      scheduleStore.list().some((s) => s.id === id),
      false,
    );
    assert.equal(scheduleStore.dueIds(DEC1 + DAY).includes(id), false);
    assert.equal(scheduleStore.delete(id), false);
    assert.equal(scheduleStore.update(id, { name: "x" }, GRACE), undefined);
    assert.equal(scheduleStore.setEnabled(id, false, DEC1, GRACE), undefined);
  });

  it("deletes every Schedule that targets a session", () => {
    const a = scheduleStore.create(
      input({ target: { kind: "session", sessionId: "doomed" } }),
    ).id;
    const b = scheduleStore.create(
      input({ target: { kind: "session", sessionId: "doomed" } }),
    ).id;
    const other = scheduleStore.create(input()).id;
    assert.deepEqual(
      scheduleStore.deleteForTarget("doomed").sort(),
      [a, b].sort(),
    );
    assert.equal(scheduleStore.get(a), undefined);
    assert.ok(scheduleStore.get(other));
    assert.deepEqual(scheduleStore.deleteForTarget("doomed"), []);
  });

  it("moves the revision on every public write", () => {
    const revisions: number[] = [];
    const record = (id: string) => {
      const revision = scheduleStore.revision(id)!;
      assert.ok(
        revision > (revisions.at(-1) ?? 0),
        `revision ${revision} after ${revisions.join(",")}`,
      );
      revisions.push(revision);
    };
    const { id } = scheduleStore.create(input(), DEC1 - DAY);
    record(id);
    scheduleStore.update(id, { prompt: "new prompt" }, GRACE, DEC1 - DAY + 1);
    record(id);
    const claimed = scheduleStore.claimDue(id, DEC1, GRACE).claimed!;
    record(id);
    scheduleStore.markAttempted(claimed.id, DEC1 + 1);
    record(id);
    scheduleStore.settleOccurrence(claimed.id, "delivered", {}, DEC1 + 2);
    record(id);
    scheduleStore.setEnabled(id, false, DEC1 + 3, GRACE);
    record(id);
    scheduleStore.setEnabled(id, true, DEC1 + 4, GRACE);
    record(id);
    scheduleStore.delete(id, DEC1 + 5);
    record(id);
    const target = scheduleStore.create(
      input({ target: { kind: "session", sessionId: "rev-target" } }),
    ).id;
    record(target);
    scheduleStore.deleteForTarget("rev-target");
    record(target);
  });

  it("maintenance deletes a Schedule 30 days after it became done, keeps a disabled one, and purges old tombstones", () => {
    const once = scheduleStore.create(
      input({
        timing: {
          kind: "once",
          date: "2026-12-01",
          time: "09:00",
          timeZone: "UTC",
        },
      }),
      DEC1 - DAY,
    ).id;
    const disabled = scheduleStore.create(
      input({ enabled: false }),
      DEC1 - DAY,
    ).id;
    const claimed = scheduleStore.claimDue(once, DEC1, GRACE).claimed!;
    const doneAt = DEC1 + DAY; // settled a day after the claim
    scheduleStore.settleOccurrence(claimed.id, "delivered", {}, doneAt);

    // Counted from done_at, not from the due or claim time.
    let outcome = scheduleStore.runMaintenance(
      doneAt + SCHEDULE_RETENTION_MS - 1,
    );
    assert.equal(outcome.deleted.includes(once), false);
    assert.ok(scheduleStore.get(once));

    const before = scheduleStore.revision(once)!;
    outcome = scheduleStore.runMaintenance(doneAt + SCHEDULE_RETENTION_MS);
    assert.ok(outcome.deleted.includes(once));
    assert.equal(scheduleStore.get(once), undefined);
    assert.ok(scheduleStore.revision(once)! > before);
    assert.ok(scheduleStore.get(disabled));

    // The tombstone is purged 30 days after the delete.
    const deletedAt = doneAt + SCHEDULE_RETENTION_MS;
    scheduleStore.runMaintenance(deletedAt + SCHEDULE_RETENTION_MS - 1);
    assert.notEqual(scheduleStore.revision(once), undefined);
    outcome = scheduleStore.runMaintenance(deletedAt + SCHEDULE_RETENTION_MS);
    assert.ok(outcome.purged >= 1);
    assert.equal(scheduleStore.revision(once), undefined);
    assert.ok(scheduleStore.get(disabled));
  });

  it("maintenance marks a disabled Schedule done once its timing has expired, at the sweep, then deletes it 30 days later (A-F001)", () => {
    const DEC3 = DEC1 + 2 * DAY;
    const { id } = scheduleStore.create(
      input({ timing: { ...DAILY, endsOn: "2026-12-02" } }),
      DEC1 - 1,
    );
    scheduleStore.claimDue(id, DEC1, GRACE);
    scheduleStore.setEnabled(id, false, DEC1 + 1, GRACE);
    // Dec 2 is still ahead, so disabling does not make it done.
    assert.equal(scheduleStore.get(id)?.doneAtMs, undefined);
    assert.deepEqual(states(id), ["2026-12-01T09:00:00.000Z withdrawn"]);

    // Before the last date's due time it can still produce one: not done.
    scheduleStore.runMaintenance(DEC1 + DAY - 1);
    assert.equal(scheduleStore.get(id)?.doneAtMs, undefined);

    // The sweep that first sees it expired stamps done at its own time,
    // never backdated to a due or claim time, and moves the revision.
    const before = scheduleStore.revision(id)!;
    let outcome = scheduleStore.runMaintenance(DEC3);
    assert.equal(scheduleStore.get(id)?.doneAtMs, DEC3);
    assert.ok(scheduleStore.revision(id)! > before);
    assert.equal(outcome.deleted.includes(id), false);

    // A later sweep keeps done_at and writes nothing for it.
    const done = scheduleStore.revision(id)!;
    outcome = scheduleStore.runMaintenance(DEC3 + SCHEDULE_RETENTION_MS - 1);
    assert.equal(scheduleStore.get(id)?.doneAtMs, DEC3);
    assert.equal(scheduleStore.revision(id), done);
    assert.equal(outcome.deleted.includes(id), false);

    outcome = scheduleStore.runMaintenance(DEC3 + SCHEDULE_RETENTION_MS);
    assert.ok(outcome.deleted.includes(id));
    assert.equal(scheduleStore.get(id), undefined);
    assert.deepEqual(scheduleStore.history(id), []);
    assert.ok(scheduleStore.revision(id)! > done);
  });

  it("maintenance marks a disabled once done after its date, and never an indefinite or still-owed one", () => {
    const once = scheduleStore.create(
      input({
        timing: {
          kind: "once",
          date: "2026-12-01",
          time: "09:00",
          timeZone: "UTC",
        },
      }),
      DEC1 - DAY,
    ).id;
    scheduleStore.setEnabled(once, false, DEC1 - DAY + 1, GRACE);
    const indefinite = scheduleStore.create(input(), DEC1 - DAY).id;
    scheduleStore.setEnabled(indefinite, false, DEC1 - DAY + 1, GRACE);
    // Enabled, its last due time claimed and not settled: still owed.
    const owed = scheduleStore.create(
      input({
        timing: {
          kind: "once",
          date: "2026-12-01",
          time: "09:00",
          timeZone: "UTC",
        },
      }),
      DEC1 - DAY,
    ).id;
    assert.ok(scheduleStore.claimDue(owed, DEC1, GRACE).claimed);

    scheduleStore.runMaintenance(DEC1 - 1);
    assert.equal(scheduleStore.get(once)?.doneAtMs, undefined);

    const later = DEC1 + 400 * DAY;
    scheduleStore.runMaintenance(later);
    assert.equal(scheduleStore.get(once)?.doneAtMs, later);
    assert.equal(scheduleStore.get(indefinite)?.doneAtMs, undefined);
    assert.equal(scheduleStore.get(owed)?.doneAtMs, undefined);
    assert.equal(scheduleStore.owedForTarget(`target-${seq}`).length, 1);
  });

  it("rolls a maintenance done transition back when the stamp throws", () => {
    const { id } = scheduleStore.create(
      input({ timing: { ...DAILY, endsOn: "2026-12-01" } }),
      DEC1 - DAY,
    );
    scheduleStore.setEnabled(id, false, DEC1 - DAY + 1, GRACE);
    const before = scheduleStore.revision(id);
    withFailingStamp(() =>
      assert.throws(
        () => scheduleStore.runMaintenance(DEC1 + DAY),
        /stamp failed/,
      ),
    );
    assert.equal(scheduleStore.get(id)?.doneAtMs, undefined);
    assert.equal(scheduleStore.revision(id), before);
  });

  it("maintenance deletes Schedules whose target session was deleted", () => {
    sessionStore.upsert({
      id: "sched-gone",
      harness: "pi",
      agentType: "developer",
    });
    sessionStore.upsert({
      id: "sched-alive",
      harness: "pi",
      agentType: "developer",
    });
    const gone = scheduleStore.create(
      input({ target: { kind: "session", sessionId: "sched-gone" } }),
    ).id;
    const alive = scheduleStore.create(
      input({ target: { kind: "session", sessionId: "sched-alive" } }),
    ).id;
    assert.equal(scheduleStore.runMaintenance().deleted.includes(gone), false);
    sessionStore.markDeleted("sched-gone");
    const outcome = scheduleStore.runMaintenance();
    assert.ok(outcome.deleted.includes(gone));
    assert.equal(outcome.deleted.includes(alive), false);
    assert.equal(scheduleStore.get(gone), undefined);
    assert.ok(scheduleStore.get(alive));
  });

  it("a once missed while paused is done at once", () => {
    const { id } = scheduleStore.create(
      input({
        timing: {
          kind: "once",
          date: "2026-12-01",
          time: "09:00",
          timeZone: "UTC",
        },
      }),
      DEC1 - DAY,
    );
    scheduleStore.setPaused(true, DEC1 - 1, GRACE.graceMs);
    try {
      scheduleStore.claimDue(id, DEC1 + MINUTE, GRACE);
    } finally {
      scheduleStore.setPaused(false, DEC1 + MINUTE, GRACE.graceMs);
    }
    assert.equal(scheduleStore.get(id)?.doneAtMs, DEC1 + MINUTE);
  });

  it("an edit that gives a done Schedule a future occurrence makes it not done", () => {
    const { id } = scheduleStore.create(
      input({
        timing: {
          kind: "once",
          date: "2026-12-01",
          time: "09:00",
          timeZone: "UTC",
        },
      }),
      DEC1 - DAY,
    );
    scheduleStore.claimDue(id, DEC1 + 2 * 60 * MINUTE, GRACE);
    assert.equal(scheduleStore.get(id)?.doneAtMs, DEC1 + 2 * 60 * MINUTE);
    const revived = scheduleStore.update(
      id,
      { timing: DAILY },
      GRACE,
      DEC1 + DAY,
    )!;
    assert.equal(revived.doneAtMs, undefined);
    assert.equal(revived.nextDueAtMs, DEC1 + 2 * DAY);
  });

  it("reads the earliest enabled due time and the due Schedules in order", () => {
    getDb().exec("DELETE FROM schedules");
    assert.equal(scheduleStore.earliestDueAtMs(), undefined);
    const created = DEC1 - 60 * MINUTE;
    const later = scheduleStore.create(
      input({ timing: { ...DAILY, time: "10:00" } }),
      created,
    ).id;
    const sooner = scheduleStore.create(input(), created).id;
    scheduleStore.create(input({ enabled: false }), created);
    assert.equal(scheduleStore.earliestDueAtMs(), DEC1);
    assert.deepEqual(scheduleStore.dueIds(DEC1 - 1), []);
    assert.deepEqual(scheduleStore.dueIds(DEC1 + 60 * MINUTE), [sooner, later]);
  });
});

describe("scheduleStore.onWrite", () => {
  it("hears a committed write after commit, never a no-op or a rollback", () => {
    const heard: boolean[] = [];
    const off = scheduleStore.onWrite(() => heard.push(getDb().isTransaction));
    try {
      const created = scheduleStore.create(input(), DEC1 - 1);
      assert.deepEqual(heard, [false], "after commit");
      scheduleStore.setEnabled(created.id, true, DEC1 - 1, GRACE);
      assert.equal(heard.length, 1, "a write that changed nothing");
      withFailingStamp(() =>
        assert.throws(() => scheduleStore.delete(created.id, DEC1)),
      );
      assert.equal(heard.length, 1, "a rolled-back write");
      off();
      scheduleStore.delete(created.id, DEC1);
      assert.equal(heard.length, 1, "unsubscribed");
    } finally {
      off();
    }
  });

  it("logs a listener's throw and keeps the write", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const off = scheduleStore.onWrite(() => {
      throw new Error("listener broke");
    });
    try {
      const created = scheduleStore.create(input(), DEC1 - 1);
      assert.ok(scheduleStore.get(created.id));
      assert.match(String(warn.mock.calls[0]?.[1]), /listener broke/);
    } finally {
      off();
      warn.mockRestore();
    }
  });
});

describe("scheduleStore Pause all", () => {
  const DEC2 = DEC1 + DAY;
  const SECOND = 1000;
  const GRACE_MS = GRACE.graceMs;

  beforeEach(() => {
    getDb().exec("DELETE FROM schedule_occurrences; DELETE FROM schedules;");
    resetPause();
  });
  afterEach(() => {
    resetPause();
    vi.restoreAllMocks();
  });

  /** A daily 09:00 Schedule whose Dec 1 occurrence is claimed and owed. */
  function owedDaily(): { id: string; owedId: string } {
    const { id } = scheduleStore.create(input(), DEC1 - DAY);
    return { id, owedId: scheduleStore.claimDue(id, DEC1, GRACE).claimed!.id };
  }

  /** Everything a rolled-back write must leave as it was. */
  function snapshot(ids: string[]) {
    return {
      rows: ids.map((id) => ({
        states: states(id),
        nextDueAtMs: scheduleStore.get(id)?.nextDueAtMs,
        revision: scheduleStore.revision(id),
      })),
      occurrenceSequence: currentId("schedule_occurrence"),
      revisionSequence: currentId("schedule_revision"),
      flag: pauseRow(),
    };
  }

  /** Records the schedules topic reports, onWrite and onClaimed calls. */
  function listen() {
    const heard = { reports: 0, writes: 0, claims: [] as string[] };
    const previous = setStateChangeSink((topic, ids) => {
      if (topic === "schedules" && ids.length) heard.reports += 1;
    });
    const offWrite = scheduleStore.onWrite(() => (heard.writes += 1));
    const offClaimed = scheduleStore.onClaimed((o) => heard.claims.push(o.id));
    return {
      heard,
      off() {
        setStateChangeSink(previous);
        offWrite();
        offClaimed();
      },
    };
  }

  it("pausing claims an unticked due time that fell unpaused, superseding the owed one (S1)", () => {
    const { id, owedId } = owedDaily();
    const outcome = scheduleStore.setPaused(true, DEC2 + 15 * SECOND, GRACE_MS);
    assert.equal(outcome.changed, true);
    assert.deepEqual(
      outcome.claimed.map((o) => o.dueAtMs),
      [DEC2],
    );
    assert.deepEqual(states(id), [
      "2026-12-02T09:00:00.000Z claimed",
      "2026-12-01T09:00:00.000Z superseded",
    ]);
    assert.equal(scheduleStore.getOccurrence(owedId)?.state, "superseded");
    assert.equal(pauseRow(), 1);
    assert.equal(scheduleStore.paused(), true);
    assert.equal(scheduleStore.get(id)?.nextDueAtMs, DEC2 + DAY);
  });

  it("resuming misses a due time that fell while paused and keeps the owed claim (S2)", () => {
    const { id, owedId } = owedDaily();
    scheduleStore.setPaused(true, DEC2 - SECOND, GRACE_MS);
    const outcome = scheduleStore.setPaused(
      false,
      DEC2 + 15 * SECOND,
      GRACE_MS,
    );
    assert.deepEqual(outcome, { changed: true, claimed: [], missed: 1 });
    assert.deepEqual(states(id), [
      "2026-12-02T09:00:00.000Z missed",
      "2026-12-01T09:00:00.000Z claimed",
    ]);
    assert.equal(scheduleStore.getOccurrence(owedId)?.state, "claimed");
    assert.equal(pauseRow(), 0);
    assert.equal(scheduleStore.get(id)?.nextDueAtMs, DEC2 + DAY);
  });

  it("rolls a multi-row switch back whole, both ways: rows, sequences, flag, reports and listeners (S4)", () => {
    const a = scheduleStore.create(input(), DEC1 - DAY).id;
    const b = scheduleStore.create(input(), DEC1 - DAY).id;
    const { heard, off } = listen();
    try {
      // Pause, unpaused before: both Dec 1 due times would be claimed.
      let before = snapshot([a, b]);
      assert.equal(before.flag, undefined, "no row yet");
      withFailingStamp(() =>
        assert.throws(
          () => scheduleStore.setPaused(true, DEC1 + MINUTE, GRACE_MS),
          /stamp failed/,
        ),
      );
      assert.deepEqual(snapshot([a, b]), before);
      assert.deepEqual(heard, { reports: 0, writes: 0, claims: [] });

      scheduleStore.setPaused(true, DEC1 + MINUTE, GRACE_MS);
      assert.equal(heard.claims.length, 2);
      assert.equal(heard.reports, 1);
      heard.claims = [];
      heard.reports = 0;
      heard.writes = 0;

      // Resume, paused before: both Dec 2 due times would be missed.
      before = snapshot([a, b]);
      assert.equal(before.flag, 1);
      withFailingStamp(() =>
        assert.throws(
          () => scheduleStore.setPaused(false, DEC2 + MINUTE, GRACE_MS),
          /stamp failed/,
        ),
      );
      assert.deepEqual(snapshot([a, b]), before);
      assert.deepEqual(heard, { reports: 0, writes: 0, claims: [] });
      assert.equal(scheduleStore.paused(), true);
    } finally {
      off();
    }
  });

  it("setting the state it already has writes nothing (S5)", () => {
    const { id } = owedDaily();
    scheduleStore.setPaused(true, DEC1 + MINUTE, GRACE_MS);
    const before = snapshot([id]);
    const { heard, off } = listen();
    try {
      // Dec 2 is due, but a no-op switch settles nothing.
      assert.deepEqual(scheduleStore.setPaused(true, DEC2 + MINUTE, GRACE_MS), {
        changed: false,
        claimed: [],
        missed: 0,
      });
      assert.deepEqual(snapshot([id]), before);
      assert.deepEqual(heard, { reports: 0, writes: 0, claims: [] });
      resetPause();
      // Not paused with no row: the read writes the row, nothing else.
      assert.equal(
        scheduleStore.setPaused(false, DEC2 + MINUTE, GRACE_MS).changed,
        false,
      );
      assert.equal(pauseRow(), 0);
      assert.equal(scheduleStore.revision(id), before.rows[0]!.revision);
      assert.deepEqual(heard, { reports: 0, writes: 0, claims: [] });
    } finally {
      off();
    }
  });

  describe("onClaimed (S6)", () => {
    it("hears each claim once after commit, from a tick and from a switch, never a rollback", () => {
      const seen: Array<{
        id: string;
        inTransaction: boolean;
        state: string | undefined;
      }> = [];
      const off = scheduleStore.onClaimed((o) =>
        seen.push({
          id: o.id,
          inTransaction: getDb().isTransaction,
          state: scheduleStore.getOccurrence(o.id)?.state,
        }),
      );
      try {
        const ticked = scheduleStore.create(input(), DEC1 - DAY).id;
        const claim = scheduleStore.claimDue(ticked, DEC1, GRACE).claimed!;
        assert.deepEqual(seen, [
          { id: claim.id, inTransaction: false, state: "claimed" },
        ]);
        // A due time already recorded claims nothing and is not heard.
        scheduleStore.claimDue(ticked, DEC1, GRACE);
        assert.equal(seen.length, 1);

        const x = scheduleStore.create(input(), DEC2 - DAY).id;
        const y = scheduleStore.create(input(), DEC2 - DAY).id;
        withFailingStamp(() =>
          assert.throws(() =>
            scheduleStore.setPaused(true, DEC2 + MINUTE, GRACE_MS),
          ),
        );
        assert.equal(seen.length, 1, "a rollback is never heard");
        const switched = scheduleStore.setPaused(true, DEC2 + MINUTE, GRACE_MS);
        assert.equal(switched.claimed.length, 3, "x, y and the ticked one");
        assert.deepEqual(
          seen
            .slice(1)
            .map((s) => s.id)
            .sort(),
          switched.claimed.map((o) => o.id).sort(),
        );
        assert.ok(seen.every((s) => !s.inTransaction && s.state === "claimed"));
        assert.deepEqual(
          [x, y].map((id) => states(id)),
          [
            ["2026-12-02T09:00:00.000Z claimed"],
            ["2026-12-02T09:00:00.000Z claimed"],
          ],
        );
      } finally {
        off();
      }
    });

    it("logs a throwing listener and still runs the next", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const heard: string[] = [];
      const offBroken = scheduleStore.onClaimed(() => {
        throw new Error("claim listener broke");
      });
      const offNext = scheduleStore.onClaimed((o) => heard.push(o.id));
      try {
        const { id } = scheduleStore.create(input(), DEC1 - DAY);
        const claim = scheduleStore.claimDue(id, DEC1, GRACE).claimed!;
        assert.deepEqual(heard, [claim.id]);
        assert.equal(scheduleStore.getOccurrence(claim.id)?.state, "claimed");
        assert.ok(
          warn.mock.calls.some((call) =>
            /claim listener broke/.test(String(call[1])),
          ),
        );
      } finally {
        offBroken();
        offNext();
      }
    });

    it("a hand-off that throws after commit keeps the claims, tells the listeners once, then throws", () => {
      const { id, owedId } = owedDaily();
      const other = scheduleStore.create(input(), DEC2 - DAY / 2).id;
      const claims: string[] = [];
      let writes = 0;
      const offClaimed = scheduleStore.onClaimed((o) => claims.push(o.id));
      const offWrite = scheduleStore.onWrite(() => (writes += 1));
      const previous = setStateChangeSink(() => {
        throw new Error("sink broke");
      });
      try {
        assert.throws(
          () => scheduleStore.claimDue(id, DEC2 + MINUTE, GRACE),
          /sink broke/,
        );
        const [dec2] = scheduleStore.history(id);
        assert.equal(dec2?.state, "claimed", "the claim committed");
        assert.equal(scheduleStore.getOccurrence(owedId)?.state, "superseded");
        assert.deepEqual(claims, [dec2!.id]);
        assert.equal(writes, 1);

        // A switch whose hand-off throws: committed, flag set, heard once.
        assert.throws(
          () => scheduleStore.setPaused(true, DEC2 + MINUTE, GRACE_MS),
          /sink broke/,
        );
        assert.equal(pauseRow(), 1);
        const [otherClaim] = scheduleStore.history(other);
        assert.equal(otherClaim?.state, "claimed");
        assert.deepEqual(claims, [dec2!.id, otherClaim!.id]);
        assert.equal(writes, 2);

        // A missed-only write whose hand-off throws still re-arms (onWrite).
        assert.throws(
          () => scheduleStore.claimDue(id, DEC2 + DAY + MINUTE, GRACE),
          /sink broke/,
        );
        assert.equal(writes, 3);
        assert.equal(claims.length, 2);
      } finally {
        setStateChangeSink(previous);
        offClaimed();
        offWrite();
      }
    });
  });

  describe("SQLite alone holds Pause all (S7)", () => {
    it("with no row it starts unpaused whatever the settings file holds, and claims", () => {
      const { id } = scheduleStore.create(input(), DEC1 - DAY);
      for (const text of [
        JSON.stringify({ schedules: { paused: true } }),
        "{ not json",
      ]) {
        resetPause();
        writeSettingsFile(text);
        assert.equal(scheduleStore.paused(), false, text);
        assert.equal(pauseRow(), 0, text);
      }
      resetPause();
      writeSettingsFile(JSON.stringify({ schedules: { paused: true } }));
      assert.equal(
        scheduleStore.claimDue(id, DEC1, GRACE).claimed?.dueAtMs,
        DEC1,
      );
      assert.equal(pauseRow(), 0);
    });

    it("starts unpaused the same whether or not the settings directory can be read", () => {
      const dir = dirname(APP_SETTINGS_PATH);
      writeSettingsFile(JSON.stringify({ schedules: { paused: true } }));
      const mode = statSync(dir).mode & 0o777;
      chmodSync(dir, 0o000);
      try {
        assert.equal(scheduleStore.paused(), false);
        assert.equal(pauseRow(), 0);
        // The switch reads no file either.
        assert.equal(
          scheduleStore.setPaused(true, DEC1, GRACE_MS).changed,
          true,
        );
      } finally {
        chmodSync(dir, mode);
      }
      closeDb();
      assert.equal(scheduleStore.paused(), true, "the row, not the file");
      resetPause();
      writeSettingsFile(JSON.stringify({ schedules: { paused: true } }));
      assert.equal(scheduleStore.paused(), false, "readable: still unpaused");
      assert.equal(pauseRow(), 0);
    });

    it("a stored value is the only source, across a reopen", () => {
      scheduleStore.setPaused(true, DEC1, GRACE_MS);
      writeSettingsFile(JSON.stringify({ schedules: { paused: false } }));
      closeDb();
      assert.equal(scheduleStore.paused(), true);
      writeSettingsFile("{ not json");
      assert.equal(scheduleStore.paused(), true, "an unreadable file too");
      scheduleStore.setPaused(false, DEC1, GRACE_MS);
      writeSettingsFile(JSON.stringify({ schedules: { paused: true } }));
      closeDb();
      assert.equal(scheduleStore.paused(), false);
    });
  });

  describe("a due time at the switch instant belongs to the state before it (S8, B1)", () => {
    /** A daily 09:00 Schedule due at Dec 2 09:00 (D), not yet ticked. */
    function dueAtD(): string {
      getDb().exec("DELETE FROM schedule_occurrences; DELETE FROM schedules;");
      resetPause();
      return scheduleStore.create(input(), DEC2 - DAY / 2).id;
    }
    /** The tick that reaches D after the switch, inside the grace window. */
    const tick = (id: string) =>
      scheduleStore.claimDue(id, DEC2 + 30 * SECOND, GRACE);

    for (const [offset, expected] of [
      [-1, "missed"],
      [0, "claimed"],
      [1, "claimed"],
    ] as const)
      it(`pause at D${offset < 0 ? "-1" : offset > 0 ? "+1" : ""}: ${expected}`, () => {
        const id = dueAtD();
        scheduleStore.setPaused(true, DEC2 + offset, GRACE_MS);
        tick(id);
        assert.deepEqual(states(id), [`2026-12-02T09:00:00.000Z ${expected}`]);
      });

    for (const [offset, expected] of [
      [-1, "claimed"],
      [0, "missed"],
      [1, "missed"],
    ] as const)
      it(`resume at D${offset < 0 ? "-1" : offset > 0 ? "+1" : ""}: ${expected}`, () => {
        const id = dueAtD();
        scheduleStore.setPaused(true, DEC2 - DAY / 4, GRACE_MS);
        scheduleStore.setPaused(false, DEC2 + offset, GRACE_MS);
        tick(id);
        assert.deepEqual(states(id), [`2026-12-02T09:00:00.000Z ${expected}`]);
      });
  });
});

/*
 * Edit and disable cutovers, cardless capacity and admission-aware ending
 * (Task-1503). Fixture: daily 09:00 Europe/Berlin (UTC+1 in December), grace
 * 60 minutes, explicit instants. Tests that end an attempted occurrence
 * register a stub resolver and the hooks reset it.
 */
describe("scheduleStore cutovers, capacity and admission (Task-1503)", () => {
  const BERLIN: ScheduleTiming = {
    kind: "daily",
    time: "09:00",
    timeZone: "Europe/Berlin",
  };
  /** Local Berlin wall time on a December 2026 day. */
  const local = (day: number, time: string) =>
    at(`2026-12-${String(day).padStart(2, "0")}T${time}:00+01:00`);
  const D1_0900 = local(1, "09:00");
  const D10 = "Delivery uncertain (stub)";

  beforeEach(() => {
    getDb().exec("DELETE FROM schedule_occurrences; DELETE FROM schedules;");
    resetPause();
    scheduleStore.setAdmissionResolver(undefined);
  });
  afterEach(() => {
    scheduleStore.setAdmissionResolver(undefined);
    resetPause();
    vi.restoreAllMocks();
  });

  /** A Berlin daily created Dec 1 08:00: its cursor is Dec 1 09:00. */
  function daily(patch: Partial<ScheduleCreateInput> = {}) {
    return scheduleStore.create(
      input({ timing: BERLIN, ...patch }),
      local(1, "08:00"),
    );
  }

  /** The Schedule's Dec 1 occurrence, claimed at 09:00 and attempted. */
  function attempted(id: string) {
    const occurrence = scheduleStore.claimDue(id, D1_0900, GRACE).claimed!;
    assert.equal(scheduleStore.markAttempted(occurrence.id, D1_0900 + 1), true);
    return occurrence;
  }

  /** Records the resolver's calls and answers with `evidence`. */
  function resolveWith(
    evidence: (o: ScheduleOccurrenceRecord) => ScheduleAdmissionEvidence,
  ): string[] {
    const asked: string[] = [];
    scheduleStore.setAdmissionResolver((o) => {
      asked.push(o.id);
      assert.equal(getDb().isTransaction, true, "inside the write");
      return evidence(o);
    });
    return asked;
  }

  function listen() {
    const heard = { writes: 0, claims: [] as ScheduleOccurrenceRecord[] };
    const offWrite = scheduleStore.onWrite(() => (heard.writes += 1));
    const offClaimed = scheduleStore.onClaimed((o) => heard.claims.push(o));
    return {
      heard,
      off() {
        offWrite();
        offClaimed();
      },
    };
  }

  const occurrence = (id: string) => scheduleStore.getOccurrence(id)!;

  describe("edit cutover (A-F006)", () => {
    it("T1.1 an edit exactly at due claims it with the OLD prompt, then patches", () => {
      const s = daily({ prompt: "Old prompt" });
      const l = listen();
      try {
        const updated = scheduleStore.update(
          s.id,
          { prompt: "New prompt" },
          GRACE,
          D1_0900,
        )!;
        const [claim] = scheduleStore.history(s.id);
        assert.deepEqual(states(s.id), ["2026-12-01T08:00:00.000Z claimed"]);
        assert.equal(occurrence(claim!.id).prompt, "Old prompt");
        assert.equal(updated.prompt, "New prompt");
        assert.equal(updated.nextDueAtMs, local(2, "09:00"));
        assert.deepEqual(
          l.heard.claims.map((o) => o.id),
          [claim!.id],
        );
      } finally {
        l.off();
      }
    });

    it("T1.2 an identical timing save, keys and days reordered, keeps the cursor and adds no rows", () => {
      const weekly: ScheduleTiming = {
        kind: "weekly",
        days: ["mon", "tue"],
        time: "09:00",
        timeZone: "Europe/Berlin",
      };
      const s = daily({ timing: weekly });
      assert.equal(s.nextDueAtMs, D1_0900, "Dec 1 2026 is a Tuesday");
      const reordered = {
        timeZone: "Europe/Berlin",
        time: "09:00",
        days: ["tue", "mon"],
        kind: "weekly",
      } as ScheduleTiming;
      const updated = scheduleStore.update(
        s.id,
        { timing: reordered },
        GRACE,
        local(1, "08:30"),
      )!;
      assert.equal(updated.nextDueAtMs, D1_0900);
      assert.deepEqual(updated.timing, weekly, "the stored form is kept");
      assert.deepEqual(states(s.id), []);
    });

    it("T1.3 a prompt-only edit before due keeps the cursor and adds no rows", () => {
      const s = daily();
      const updated = scheduleStore.update(
        s.id,
        { prompt: "Changed" },
        GRACE,
        local(1, "08:30"),
      )!;
      assert.equal(updated.nextDueAtMs, D1_0900);
      assert.deepEqual(states(s.id), []);
    });

    it("T1.4 a changed timing settles the old due first, then runs from the first new occurrence after now", () => {
      const s = daily({ prompt: "Old prompt" });
      const ten = { ...BERLIN, time: "10:00" };
      const late = scheduleStore.update(
        s.id,
        { timing: ten, prompt: "New prompt" },
        GRACE,
        local(1, "09:30"),
      )!;
      const [claim] = scheduleStore.history(s.id);
      assert.deepEqual(states(s.id), ["2026-12-01T08:00:00.000Z claimed"]);
      assert.equal(occurrence(claim!.id).prompt, "Old prompt");
      assert.equal(late.nextDueAtMs, local(1, "10:00"));

      const early = daily();
      const before = scheduleStore.update(
        early.id,
        { timing: ten },
        GRACE,
        local(1, "08:00"),
      )!;
      assert.deepEqual(states(early.id), []);
      assert.equal(before.nextDueAtMs, local(1, "10:00"));
    });

    it("T1.5 a combined prompt and target edit claims with the old prompt and target", () => {
      const s = daily({
        prompt: "Old prompt",
        target: { kind: "session", sessionId: "old-target" },
      });
      const l = listen();
      try {
        scheduleStore.update(
          s.id,
          {
            prompt: "New prompt",
            target: { kind: "session", sessionId: "new-target" },
          },
          GRACE,
          local(1, "09:10"),
        );
        const [claim] = l.heard.claims;
        assert.equal(l.heard.claims.length, 1);
        assert.equal(claim!.prompt, "Old prompt");
        assert.deepEqual(claim!.target, {
          kind: "session",
          sessionId: "old-target",
        });
        assert.deepEqual(
          scheduleStore.owedForTarget("old-target").map((o) => o.id),
          [claim!.id],
        );
        assert.deepEqual(scheduleStore.owedForTarget("new-target"), []);
        assert.deepEqual(scheduleStore.get(s.id)!.target, {
          kind: "session",
          sessionId: "new-target",
        });
      } finally {
        l.off();
      }
    });

    it("T1.6 under Pause all an edit records the due time missed and keeps an earlier claim owed", () => {
      const s = daily();
      const survivor = scheduleStore.claimDue(s.id, D1_0900, GRACE).claimed!;
      scheduleStore.setPaused(true, local(2, "08:00"), GRACE.graceMs);
      const updated = scheduleStore.update(
        s.id,
        { prompt: "Changed" },
        GRACE,
        local(2, "09:30"),
      )!;
      assert.deepEqual(states(s.id), [
        "2026-12-02T08:00:00.000Z missed",
        "2026-12-01T08:00:00.000Z claimed",
      ]);
      assert.equal(occurrence(survivor.id).state, "claimed");
      assert.equal(updated.nextDueAtMs, local(3, "09:00"));
    });

    it("T1.7 after downtime an edit claims only the latest within grace and misses the rest", () => {
      const s = daily();
      const updated = scheduleStore.update(
        s.id,
        { prompt: "Changed" },
        GRACE,
        local(3, "09:20"),
      )!;
      assert.deepEqual(states(s.id), [
        "2026-12-03T08:00:00.000Z claimed",
        "2026-12-02T08:00:00.000Z missed",
        "2026-12-01T08:00:00.000Z missed",
      ]);
      assert.equal(updated.nextDueAtMs, local(4, "09:00"));

      const beyond = daily();
      scheduleStore.update(
        beyond.id,
        { prompt: "Changed" },
        GRACE,
        local(3, "10:30"),
      );
      assert.deepEqual(states(beyond.id), [
        "2026-12-03T08:00:00.000Z missed",
        "2026-12-02T08:00:00.000Z missed",
        "2026-12-01T08:00:00.000Z missed",
      ]);
    });

    it("T1.8 an edit at due supersedes a not-attempted claim without asking the resolver", () => {
      const s = daily();
      const older = scheduleStore.claimDue(s.id, D1_0900, GRACE).claimed!;
      const asked = resolveWith(() => ({ kind: "absent" }));
      const now = local(2, "09:00");
      scheduleStore.update(s.id, { prompt: "Changed" }, GRACE, now);
      assert.equal(occurrence(older.id).state, "superseded");
      assert.equal(occurrence(older.id).endedAtMs, now);
      assert.deepEqual(asked, []);
      assert.deepEqual(states(s.id), [
        "2026-12-02T08:00:00.000Z claimed",
        "2026-12-01T08:00:00.000Z superseded",
      ]);
    });

    it("T1.9 an edit cutover rolls back whole, and a throwing hand-off after commit still tells the listeners", () => {
      const s = daily();
      const revision = scheduleStore.revision(s.id);
      const l = listen();
      try {
        withFailingStamp(() =>
          assert.throws(
            () => scheduleStore.update(s.id, { prompt: "x" }, GRACE, D1_0900),
            /stamp failed/,
          ),
        );
        assert.deepEqual(states(s.id), []);
        assert.equal(scheduleStore.get(s.id)!.nextDueAtMs, D1_0900);
        assert.notEqual(scheduleStore.get(s.id)!.prompt, "x");
        assert.equal(scheduleStore.revision(s.id), revision);
        assert.deepEqual({ ...l.heard }, { writes: 0, claims: [] });

        const previous = setStateChangeSink(() => {
          throw new Error("sink broke");
        });
        try {
          assert.throws(
            () => scheduleStore.update(s.id, { prompt: "y" }, GRACE, D1_0900),
            /sink broke/,
          );
        } finally {
          setStateChangeSink(previous);
        }
        const [claim] = scheduleStore.history(s.id);
        assert.equal(claim?.state, "claimed", "the cutover committed");
        assert.equal(scheduleStore.get(s.id)!.prompt, "y");
        assert.deepEqual(
          l.heard.claims.map((o) => o.id),
          [claim!.id],
        );
        assert.equal(l.heard.writes, 1);
      } finally {
        l.off();
      }
    });
  });

  describe("T1.10 disable cutover (D4)", () => {
    function disabledAt(nowMs: number, s = daily()) {
      const l = listen();
      try {
        const summary = scheduleStore.setEnabled(s.id, false, nowMs, GRACE)!;
        assert.equal(summary.enabled, false);
        assert.equal(summary.nextDueAtMs, undefined, "cursor null");
        const row = getDb()
          .prepare("SELECT enabled, next_due_at_ms FROM schedules WHERE id = ?")
          .get(s.id);
        assert.deepEqual({ ...row }, { enabled: 0, next_due_at_ms: null });
        return { id: s.id, heard: l.heard };
      } finally {
        l.off();
      }
    }

    it("a due time inside grace is claimed, then withdrawn, and never heard as a claim", () => {
      const { id, heard } = disabledAt(local(1, "09:10"));
      assert.deepEqual(states(id), ["2026-12-01T08:00:00.000Z withdrawn"]);
      assert.deepEqual(heard.claims, []);
      assert.equal(heard.writes, 1);
    });

    it("a due time beyond grace is missed", () => {
      const { id } = disabledAt(local(1, "10:30"));
      assert.deepEqual(states(id), ["2026-12-01T08:00:00.000Z missed"]);
    });

    it("under Pause all a due time is missed", () => {
      scheduleStore.setPaused(true, local(1, "08:30"), GRACE.graceMs);
      const { id } = disabledAt(local(1, "09:10"));
      assert.deepEqual(states(id), ["2026-12-01T08:00:00.000Z missed"]);
    });

    it("an already-owed not-attempted claim is withdrawn", () => {
      const s = daily();
      const owed = scheduleStore.claimDue(s.id, D1_0900, GRACE).claimed!;
      disabledAt(local(1, "12:00"), s);
      assert.equal(occurrence(owed.id).state, "withdrawn");
      assert.equal(occurrence(owed.id).endedAtMs, local(1, "12:00"));
    });

    it("an owed claim and a new due time inside grace both end withdrawn", () => {
      const s = daily();
      scheduleStore.claimDue(s.id, D1_0900, GRACE);
      const { id } = disabledAt(local(2, "09:10"), s);
      assert.deepEqual(states(id), [
        "2026-12-02T08:00:00.000Z withdrawn",
        "2026-12-01T08:00:00.000Z superseded",
      ]);
    });
  });

  describe("cardless capacity (F003)", () => {
    const S = { kind: "session", sessionId: "controller" } as const;
    const mine = (patch: Partial<ScheduleCreateInput> = {}) =>
      input({ createdBy: S, cardless: true, timing: BERLIN, ...patch });
    const NOW = local(1, "08:00");
    const ONCE_PAST: ScheduleTiming = {
      kind: "once",
      date: "2026-12-01",
      time: "09:00",
      timeZone: "Europe/Berlin",
    };
    /** A counted once that is done after the clock passed it beyond grace. */
    function doneOnce(): string {
      const { id } = scheduleStore.create(mine({ timing: ONCE_PAST }), NOW);
      scheduleStore.claimDue(id, local(1, "11:00"), GRACE);
      assert.ok(scheduleStore.get(id)!.doneAtMs, "done");
      return id;
    }

    it("T1.11 create counts enabled and disabled rows; done, deleted, carded and other sessions' rows do not", () => {
      const limit = { cardlessLimit: 2 };
      // Not counted: done, deleted, another session's, not cardless, or
      // controlled by someone other than its creator.
      doneOnce();
      scheduleStore.delete(scheduleStore.create(mine(), NOW).id, NOW);
      scheduleStore.create(
        input({ createdBy: { kind: "session", sessionId: "other" } }),
        NOW,
        limit,
      );
      scheduleStore.create(mine({ cardless: false }), NOW);
      scheduleStore.create(mine({ controlledBy: { kind: "user" } }), NOW);

      scheduleStore.create(mine(), NOW, limit);
      scheduleStore.create(mine({ enabled: false }), NOW, limit);
      const before = scheduleStore.list().length;
      const l = listen();
      try {
        assert.throws(
          () => scheduleStore.create(mine(), NOW, limit),
          (err: unknown) =>
            err instanceof ScheduleCardlessLimitError &&
            err.count === 2 &&
            err.limit === 2,
        );
        assert.equal(scheduleStore.list().length, before, "rolled back");
        assert.deepEqual({ ...l.heard }, { writes: 0, claims: [] });
      } finally {
        l.off();
      }
      // A carded write, or one without a limit, is never refused.
      scheduleStore.create(mine({ cardless: false }), NOW, limit);
      scheduleStore.create(mine(), NOW);
    });

    it("T1.12 reactivating a done Schedule counts it again, atomically", () => {
      const a = doneOnce();
      const b = scheduleStore.create(mine(), NOW).id;
      const limit = { ...GRACE, cardlessLimit: 1 };
      const future: ScheduleTiming = { ...ONCE_PAST, date: "2026-12-05" };
      const revision = scheduleStore.revision(a);
      const l = listen();
      try {
        assert.throws(
          () =>
            scheduleStore.update(
              a,
              { timing: future },
              limit,
              local(1, "12:00"),
            ),
          (err: unknown) =>
            err instanceof ScheduleCardlessLimitError && err.count === 1,
        );
        assert.ok(scheduleStore.get(a)!.doneAtMs, "A is still done");
        assert.equal(scheduleStore.get(a)!.nextDueAtMs, undefined);
        assert.equal(scheduleStore.revision(a), revision);
        assert.deepEqual({ ...l.heard }, { writes: 0, claims: [] });
      } finally {
        l.off();
      }
      scheduleStore.delete(b, local(1, "12:00"));
      const revived = scheduleStore.update(
        a,
        { timing: future },
        limit,
        local(1, "12:00"),
      )!;
      assert.equal(revived.doneAtMs, undefined);
      assert.equal(revived.nextDueAtMs, local(5, "09:00"));
    });

    it("T1.12 enabling a done, disabled Schedule is not refused and it stays done", () => {
      const a = doneOnce();
      scheduleStore.setEnabled(a, false, local(1, "12:00"), GRACE);
      scheduleStore.create(mine(), NOW);
      const enabled = scheduleStore.setEnabled(a, true, local(1, "13:00"), {
        ...GRACE,
        cardlessLimit: 1,
      })!;
      assert.equal(enabled.enabled, true);
      assert.ok(enabled.doneAtMs, "still done");
    });

    it("T1.13 over a lowered limit every change that moves nothing into the count still works", () => {
      const [a, b, c] = [1, 2, 3].map(
        () => scheduleStore.create(mine(), NOW).id,
      );
      const lowered = { ...GRACE, cardlessLimit: 1 };
      const at = local(1, "08:30");
      assert.ok(scheduleStore.update(a!, { prompt: "Edited" }, lowered, at));
      assert.equal(
        scheduleStore.update(
          b!,
          { timing: { ...BERLIN, time: "10:00" } },
          lowered,
          at,
        )!.nextDueAtMs,
        local(1, "10:00"),
      );
      assert.equal(
        scheduleStore.setEnabled(c!, false, at, lowered)!.enabled,
        false,
      );
      assert.equal(
        scheduleStore.setEnabled(c!, true, at, lowered)!.enabled,
        true,
        "a disabled Schedule still counts, so enabling moves nothing",
      );
      assert.equal(scheduleStore.delete(a!, at), true);
      assert.throws(
        () => scheduleStore.create(mine(), at, lowered),
        (err: unknown) =>
          err instanceof ScheduleCardlessLimitError && err.count === 2,
      );
    });
  });

  describe("admission-aware ending (B-P007)", () => {
    const cases = [
      {
        evidence: (o: ScheduleOccurrenceRecord): ScheduleAdmissionEvidence => ({
          kind: "present",
          sessionId: o.target.sessionId,
        }),
        name: "present",
      },
      {
        evidence: (): ScheduleAdmissionEvidence => ({ kind: "absent" }),
        name: "absent",
      },
      {
        evidence: (): ScheduleAdmissionEvidence => ({
          kind: "unknown",
          error: D10,
        }),
        name: "unknown",
      },
    ] as const;

    /** What the attempted A must have become for each evidence case. */
    function assertEnded(
      a: ScheduleOccurrenceRecord,
      name: (typeof cases)[number]["name"],
      requested: "superseded" | "withdrawn",
      nowMs: number,
    ): void {
      const ended = occurrence(a.id);
      assert.equal(ended.endedAtMs, nowMs);
      if (name === "present") {
        assert.equal(ended.state, "delivered");
        assert.equal(ended.sessionId, a.target.sessionId);
        assert.equal(ended.error, undefined);
      } else if (name === "unknown") {
        assert.equal(ended.state, "failed");
        assert.equal(ended.error, D10);
        assert.equal(ended.sessionId, undefined);
      } else {
        assert.equal(ended.state, requested);
        assert.equal(ended.error, undefined);
        assert.equal(ended.sessionId, undefined);
      }
    }

    for (const { name, evidence } of cases)
      it(`T1.15 a clock claim supersedes an attempted claim by its evidence: ${name}`, () => {
        const s = daily();
        const a = attempted(s.id);
        const asked = resolveWith(evidence);
        const l = listen();
        try {
          const now = local(2, "09:00");
          const b = scheduleStore.claimDue(s.id, now, GRACE).claimed!;
          assert.deepEqual(asked, [a.id]);
          assertEnded(a, name, "superseded", now);
          assert.equal(occurrence(b.id).state, "claimed");
          assert.deepEqual(
            l.heard.claims.map((o) => o.id),
            [b.id],
            "only the new claim is heard",
          );
        } finally {
          l.off();
        }
      });

    it("T1.15 the evidence and the supersede roll back with the claim", () => {
      const s = daily();
      const a = attempted(s.id);
      const asked = resolveWith((o) => ({
        kind: "present",
        sessionId: o.target.sessionId,
      }));
      withFailingStamp(() =>
        assert.throws(
          () => scheduleStore.claimDue(s.id, local(2, "09:00"), GRACE),
          /stamp failed/,
        ),
      );
      assert.deepEqual(asked, [a.id], "asked inside the rolled-back write");
      assert.equal(occurrence(a.id).state, "claimed");
      assert.equal(occurrence(a.id).endedAtMs, undefined);
      assert.deepEqual(states(s.id), ["2026-12-01T08:00:00.000Z claimed"]);
      assert.equal(scheduleStore.get(s.id)!.nextDueAtMs, local(2, "09:00"));
    });

    for (const { name, evidence } of cases) {
      it(`T1.16 a disable ends an attempted claim by its evidence: ${name}`, () => {
        const s = daily();
        const a = attempted(s.id);
        const asked = resolveWith(evidence);
        const now = local(1, "09:10");
        scheduleStore.setEnabled(s.id, false, now, GRACE);
        assert.deepEqual(asked, [a.id]);
        assertEnded(a, name, "withdrawn", now);
        assert.equal(scheduleStore.get(s.id)!.enabled, false);
      });

      it(`T1.16 an edit at due supersedes an attempted claim by its evidence: ${name}`, () => {
        const s = daily();
        const a = attempted(s.id);
        const asked = resolveWith(evidence);
        const now = local(2, "09:00");
        scheduleStore.update(s.id, { prompt: "Changed" }, GRACE, now);
        assert.deepEqual(asked, [a.id]);
        assertEnded(a, name, "superseded", now);
        assert.equal(scheduleStore.history(s.id)[0]?.state, "claimed");
      });

      it(`T1.16 a Pause all claim supersedes an attempted claim by its evidence: ${name}`, () => {
        const s = daily();
        const a = attempted(s.id);
        const asked = resolveWith(evidence);
        const now = local(2, "09:05");
        const outcome = scheduleStore.setPaused(true, now, GRACE.graceMs);
        assert.equal(outcome.claimed.length, 1);
        assert.deepEqual(asked, [a.id]);
        assertEnded(a, name, "superseded", now);
      });
    }

    it("T1.17 with no resolver, ending an attempted claim throws and rolls the whole write back", () => {
      const s = daily();
      const a = attempted(s.id);
      const revision = scheduleStore.revision(s.id);
      const l = listen();
      try {
        for (const write of [
          () => scheduleStore.claimDue(s.id, local(2, "09:00"), GRACE),
          () => scheduleStore.setEnabled(s.id, false, local(1, "10:00"), GRACE),
          () =>
            scheduleStore.update(
              s.id,
              { prompt: "x" },
              GRACE,
              local(2, "09:00"),
            ),
          () => scheduleStore.setPaused(true, local(2, "09:00"), GRACE.graceMs),
        ])
          assert.throws(write, ScheduleAdmissionResolverMissingError);
        assert.equal(occurrence(a.id).state, "claimed");
        assert.deepEqual(states(s.id), ["2026-12-01T08:00:00.000Z claimed"]);
        assert.equal(scheduleStore.get(s.id)!.nextDueAtMs, local(2, "09:00"));
        assert.equal(scheduleStore.get(s.id)!.enabled, true);
        assert.equal(scheduleStore.paused(), false);
        assert.equal(scheduleStore.revision(s.id), revision);
        assert.deepEqual({ ...l.heard }, { writes: 0, claims: [] });
      } finally {
        l.off();
      }

      // A not-attempted claim needs no resolver.
      const t = daily();
      const owed = scheduleStore.claimDue(t.id, D1_0900, GRACE).claimed!;
      scheduleStore.claimDue(t.id, local(2, "09:00"), GRACE);
      assert.equal(occurrence(owed.id).state, "superseded");
    });

    it("T1.17 a resolver that throws or returns no evidence rolls the write back", () => {
      const s = daily();
      const a = attempted(s.id);
      scheduleStore.setAdmissionResolver(() => {
        throw new Error("resolver broke");
      });
      assert.throws(
        () => scheduleStore.setEnabled(s.id, false, local(1, "10:00"), GRACE),
        /resolver broke/,
      );
      scheduleStore.setAdmissionResolver(
        () => undefined as unknown as ScheduleAdmissionEvidence,
      );
      assert.throws(
        () => scheduleStore.setEnabled(s.id, false, local(1, "10:00"), GRACE),
        /returned no evidence/,
      );
      assert.equal(occurrence(a.id).state, "claimed");
      assert.equal(scheduleStore.get(s.id)!.enabled, true);
    });

    it("T1.18 a terminal row is never changed again, whoever ended it", () => {
      const s = daily();
      const a = attempted(s.id);
      resolveWith((o) => ({ kind: "present", sessionId: o.target.sessionId }));
      scheduleStore.claimDue(s.id, local(2, "09:00"), GRACE);
      assert.equal(occurrence(a.id).state, "delivered");
      for (const state of ["failed", "superseded", "withdrawn"] as const)
        assert.equal(
          scheduleStore.settleOccurrence(a.id, state, { error: "late" }),
          false,
        );
      assert.equal(occurrence(a.id).state, "delivered");
      assert.equal(occurrence(a.id).error, undefined);
      assert.equal(scheduleStore.markAttempted(a.id), false);

      // superseded, withdrawn and failed rows are as final.
      const t = daily();
      const superseded = scheduleStore.claimDue(t.id, D1_0900, GRACE).claimed!;
      const withdrawn = scheduleStore.claimDue(
        t.id,
        local(2, "09:00"),
        GRACE,
      ).claimed!;
      scheduleStore.setEnabled(t.id, false, local(2, "09:30"), GRACE);
      const u = daily();
      const failed = attempted(u.id);
      resolveWith(() => ({ kind: "unknown", error: D10 }));
      scheduleStore.setEnabled(u.id, false, local(1, "09:30"), GRACE);
      for (const [row, state] of [
        [superseded, "superseded"],
        [withdrawn, "withdrawn"],
        [failed, "failed"],
      ] as const) {
        assert.equal(occurrence(row.id).state, state);
        assert.equal(
          scheduleStore.settleOccurrence(row.id, "delivered", {
            sessionId: "late",
          }),
          false,
        );
        assert.equal(occurrence(row.id).state, state);
      }
      assert.equal(occurrence(failed.id).error, D10);
    });

    it("T1.19 deleting a Schedule removes an attempted claim with its history, unasked", () => {
      const s = daily({
        target: { kind: "session", sessionId: "gone-target" },
      });
      const a = attempted(s.id);
      const t = daily({
        target: { kind: "session", sessionId: "gone-target" },
      });
      const b = attempted(t.id);
      const asked = resolveWith(() => ({ kind: "absent" }));
      assert.equal(scheduleStore.delete(s.id, local(1, "10:00")), true);
      assert.equal(scheduleStore.getOccurrence(a.id), undefined);
      assert.deepEqual(scheduleStore.history(s.id), []);
      assert.deepEqual(
        scheduleStore.deleteForTarget("gone-target", local(1, "10:00")),
        [t.id],
      );
      assert.equal(scheduleStore.getOccurrence(b.id), undefined);
      assert.deepEqual(asked, []);
    });
  });

  describe("reads for the scheduled prompts lane and recovery", () => {
    it("owesTarget and claimedOccurrences see only claimed rows; the resolver reads back", () => {
      const s = daily({ target: { kind: "session", sessionId: "owed-a" } });
      const t = daily({ target: { kind: "session", sessionId: "owed-b" } });
      assert.equal(scheduleStore.owesTarget("owed-a"), false);
      assert.deepEqual(scheduleStore.claimedOccurrences(), []);
      const a = scheduleStore.claimDue(s.id, D1_0900, GRACE).claimed!;
      const b = attempted(t.id);
      assert.equal(scheduleStore.owesTarget("owed-a"), true);
      assert.equal(scheduleStore.owesTarget("owed-b"), true);
      assert.equal(scheduleStore.owesTarget("owed-c"), false);
      const claimed = scheduleStore.claimedOccurrences();
      assert.deepEqual(
        claimed.map((o) => [o.id, o.target.sessionId, o.attemptedAtMs]),
        [
          [a.id, "owed-a", undefined],
          [b.id, "owed-b", D1_0900 + 1],
        ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
      );
      scheduleStore.settleOccurrence(a.id, "delivered", {
        sessionId: "owed-a",
      });
      assert.equal(scheduleStore.owesTarget("owed-a"), false);
      assert.deepEqual(
        scheduleStore.claimedOccurrences().map((o) => o.id),
        [b.id],
      );

      assert.equal(scheduleStore.hasAdmissionResolver(), false);
      resolveWith(() => ({ kind: "absent" }));
      assert.equal(scheduleStore.hasAdmissionResolver(), true);
      scheduleStore.setAdmissionResolver(undefined);
      assert.equal(scheduleStore.hasAdmissionResolver(), false);
    });
  });
});
