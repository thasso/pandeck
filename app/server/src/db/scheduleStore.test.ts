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
  scheduleStore,
  type ScheduleCreateInput,
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
    const disabled = scheduleStore.setEnabled(id, false, DEC1 + MINUTE)!;
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.nextDueAtMs, undefined);
    assert.equal(disabled.doneAtMs, undefined);
    assert.equal(scheduleStore.getOccurrence(owed.id)?.state, "withdrawn");
    const enabled = scheduleStore.setEnabled(id, true, DEC1 + 3 * DAY)!;
    assert.equal(enabled.nextDueAtMs, DEC1 + 3 * DAY + DAY);
    assert.deepEqual(scheduleStore.claimDue(id, DEC1 + 3 * DAY, GRACE), {
      missed: 0,
    });
  });

  it("setting the enabled state it already has writes nothing", () => {
    const { id } = scheduleStore.create(input(), DEC1 - DAY);
    const before = scheduleStore.revision(id);
    scheduleStore.setEnabled(id, true, DEC1);
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
      assert.throws(() => scheduleStore.setEnabled(id, false, DEC1 + 1)),
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
    scheduleStore.setEnabled(id, false, DEC1 + DAY + 1);
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
    assert.equal(scheduleStore.update(id, { name: "x" }), undefined);
    assert.equal(scheduleStore.setEnabled(id, false), undefined);
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
    scheduleStore.update(id, { prompt: "new prompt" }, DEC1 - DAY + 1);
    record(id);
    const claimed = scheduleStore.claimDue(id, DEC1, GRACE).claimed!;
    record(id);
    scheduleStore.markAttempted(claimed.id, DEC1 + 1);
    record(id);
    scheduleStore.settleOccurrence(claimed.id, "delivered", {}, DEC1 + 2);
    record(id);
    scheduleStore.setEnabled(id, false, DEC1 + 3);
    record(id);
    scheduleStore.setEnabled(id, true, DEC1 + 4);
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
    scheduleStore.setEnabled(id, false, DEC1 + 1);
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
    scheduleStore.setEnabled(once, false, DEC1 - DAY + 1);
    const indefinite = scheduleStore.create(input(), DEC1 - DAY).id;
    scheduleStore.setEnabled(indefinite, false, DEC1 - DAY + 1);
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
    scheduleStore.setEnabled(id, false, DEC1 - DAY + 1);
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
    const revived = scheduleStore.update(id, { timing: DAILY }, DEC1 + DAY)!;
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
      scheduleStore.setEnabled(created.id, true, DEC1 - 1);
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
