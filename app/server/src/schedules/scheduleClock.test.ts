/**
 * The schedule clock on the real store, with an injected wall clock and timer
 * (`docs/schedules.md`, Claiming, Late and missed, Pause all, Retention).
 *   pnpm --filter @assistant/server test src/schedules/scheduleClock.test.ts
 */
import assert from "node:assert/strict";
import {
  DEFAULT_SCHEDULE_SETTINGS,
  type ScheduleSettings,
  type ScheduleTiming,
} from "@assistant/shared/schedules";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { readStoredAppSettings } from "../appSettingsFile.ts";
import { setStateChangeSink } from "../db/changeSet.ts";
import { closeDb, getDb } from "../db/index.ts";
import {
  SCHEDULE_RETENTION_MS,
  scheduleStore,
  type ScheduleCreateInput,
} from "../db/scheduleStore.ts";
import { sessionStore } from "../db/sessionStore.ts";
import {
  createScheduleClock,
  SCHEDULE_CLOCK_MAX_DELAY_MS,
  SCHEDULE_CLOCK_RETRY_MS,
} from "./scheduleClock.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The write policy a store edit or switch settles under: the default grace. */
const GRACE = {
  graceMs: DEFAULT_SCHEDULE_SETTINGS.graceWindowMinutes * MINUTE,
};
const at = (iso: string) => Date.parse(iso);

/** 09:00 UTC daily: due instants are fixed strings, no zone arithmetic. */
const DAILY: ScheduleTiming = { kind: "daily", time: "09:00", timeZone: "UTC" };
const DEC1 = at("2026-12-01T09:00:00Z");
const once = (date: string): ScheduleTiming => ({
  kind: "once",
  date,
  time: "09:00",
  timeZone: "UTC",
});

let seq = 0;
function input(patch: Partial<ScheduleCreateInput> = {}): ScheduleCreateInput {
  seq += 1;
  return {
    name: `Check ${seq}`,
    prompt: `Check CI for PR #${seq}`,
    timing: DAILY,
    target: { kind: "session", sessionId: `clock-target-${seq}` },
    createdBy: { kind: "user" },
    ...patch,
  };
}

function states(scheduleId: string): string[] {
  return scheduleStore
    .history(scheduleId)
    .map((o) => `${new Date(o.dueAtMs).toISOString()} ${o.state}`)
    .sort();
}

type Store = NonNullable<
  NonNullable<Parameters<typeof createScheduleClock>[0]>["store"]
>;

/**
 * A clock on a fake wall clock and a fake one-shot timer. `advanceTo` fires
 * every timer due by then, each at its own instant, and fails on a spin.
 */
function harness(startMs: number, store?: Store) {
  let nowMs = startMs;
  let pending: { fire: () => void; at: number } | undefined;
  const delays: number[] = [];
  const settingsValue: ScheduleSettings = { ...DEFAULT_SCHEDULE_SETTINGS };
  const listeners = new Set<() => void>();
  const claims: Array<{ target: string; occurrenceId: string }> = [];
  const clock = createScheduleClock({
    now: () => nowMs,
    ...(store ? { store } : {}),
    timers: {
      set(fire, delayMs) {
        pending = { fire, at: nowMs + delayMs };
        delays.push(delayMs);
        return pending;
      },
      clear(handle) {
        if (pending === handle) pending = undefined;
      },
    },
    settings: {
      read: () => ({ ...settingsValue }),
      onChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    claimed: (target, occurrence) =>
      claims.push({ target, occurrenceId: occurrence.id }),
  });
  return {
    clock,
    claims,
    delays,
    now: () => nowMs,
    firesAt: () => pending?.at,
    advanceTo(targetMs: number) {
      for (let fired = 0; pending && pending.at <= targetMs; fired += 1) {
        if (fired > 10_000) throw new Error("the clock spins");
        const due = pending;
        pending = undefined;
        nowMs = Math.max(nowMs, due.at);
        due.fire();
      }
      nowMs = targetMs;
    },
    /** Move the wall clock without firing: a timer that runs late. */
    stall(targetMs: number) {
      nowMs = targetMs;
    },
    setSettings(patch: Partial<ScheduleSettings>) {
      Object.assign(settingsValue, patch);
      for (const listener of listeners) listener();
    },
    /** Pause all as a settings save does it: the switch, then the notice. */
    setPaused(paused: boolean) {
      scheduleStore.setPaused(
        paused,
        nowMs,
        settingsValue.graceWindowMinutes * MINUTE,
      );
      for (const listener of listeners) listener();
    },
  };
}

let stops: Array<() => void> = [];
function started(h: ReturnType<typeof harness>) {
  h.clock.start();
  stops.push(() => h.clock.stop());
  return h;
}

beforeEach(() => {
  // Pause all starts with no row, so unpaused.
  getDb().exec(
    "DELETE FROM schedule_occurrences; DELETE FROM schedules; DELETE FROM schedule_pause;",
  );
});
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
  vi.restoreAllMocks();
});

describe("arming", () => {
  it("runs maintenance at boot and then waits 24h on a quiet table", () => {
    const h = started(harness(DEC1));
    assert.equal(h.clock.maintenanceDueAtMs(), DEC1 + DAY);
    assert.equal(h.firesAt(), DEC1 + DAY);
    assert.equal(SCHEDULE_CLOCK_MAX_DELAY_MS, DAY);
  });

  it("arms at the earliest enabled due time, never more than 24h out", () => {
    const soon = scheduleStore.create(input(), DEC1 - 10 * MINUTE);
    const h = started(harness(DEC1 - 10 * MINUTE));
    assert.equal(h.firesAt(), DEC1);
    scheduleStore.setEnabled(soon.id, false, h.now(), GRACE);
    assert.equal(h.firesAt(), DEC1 - 10 * MINUTE + DAY, "disabled: 24h");
    scheduleStore.create(input({ timing: once("2026-12-05") }), h.now());
    assert.equal(h.firesAt(), DEC1 - 10 * MINUTE + DAY, "3 days out: 24h");
  });

  it("compares to the millisecond: due-1 claims nothing, due claims", () => {
    const schedule = scheduleStore.create(input(), DEC1 - 2);
    const h = started(harness(DEC1 - 1));
    assert.deepEqual(states(schedule.id), []);
    assert.equal(h.firesAt(), DEC1);
    h.advanceTo(DEC1);
    assert.deepEqual(states(schedule.id), ["2026-12-01T09:00:00.000Z claimed"]);
    const [occurrence] = scheduleStore.history(schedule.id);
    assert.equal(occurrence!.claimedAtMs, DEC1);
    assert.equal(scheduleStore.get(schedule.id)!.nextDueAtMs, DEC1 + DAY);
  });

  it("hands the hook each claim after commit, the target from the frozen row", () => {
    const schedule = scheduleStore.create(
      input({ target: { kind: "session", sessionId: "frozen-target" } }),
      DEC1 - MINUTE,
    );
    let seenState: string | undefined;
    const h = harness(DEC1 - MINUTE);
    const clock = createScheduleClock({
      now: h.now,
      timers: { set: () => undefined, clear: () => {} },
      settings: {
        read: () => DEFAULT_SCHEDULE_SETTINGS,
        onChange: () => () => {},
      },
      claimed(target, occurrence) {
        // Committed: a fresh read outside the claim's transaction sees it.
        assert.equal(getDb().isTransaction, false);
        seenState = scheduleStore.getOccurrence(occurrence.id)?.state;
        h.claims.push({ target, occurrenceId: occurrence.id });
      },
    });
    h.advanceTo(DEC1);
    clock.start();
    stops.push(() => clock.stop());
    const [occurrence] = scheduleStore.history(schedule.id);
    assert.deepEqual(h.claims, [
      { target: "frozen-target", occurrenceId: occurrence!.id },
    ]);
    assert.equal(seenState, "claimed");
    // An edit after the claim moves the Schedule, never the frozen copy.
    scheduleStore.update(
      schedule.id,
      { target: { kind: "session", sessionId: "moved-target" } },
      GRACE,
      DEC1 + MINUTE,
    );
    assert.deepEqual(scheduleStore.getOccurrence(occurrence!.id)?.target, {
      kind: "session",
      sessionId: "frozen-target",
    });
  });
});

describe("late and missed", () => {
  it("claims within the grace window and misses beyond it", () => {
    const late = scheduleStore.create(input(), DEC1 - HOUR);
    const tooLate = scheduleStore.create(
      input({ timing: { ...DAILY, time: "08:00" } }),
      DEC1 - 2 * HOUR,
    );
    const h = started(harness(DEC1 + 30 * MINUTE));
    assert.deepEqual(states(late.id), ["2026-12-01T09:00:00.000Z claimed"]);
    assert.deepEqual(states(tooLate.id), ["2026-12-01T08:00:00.000Z missed"]);
    assert.equal(h.claims.length, 1);
  });

  it("claims at most the latest late occurrence, no backlog", () => {
    const schedule = scheduleStore.create(input(), DEC1 - HOUR);
    const h = started(harness(DEC1 + 2 * DAY + 30 * MINUTE));
    assert.deepEqual(states(schedule.id), [
      "2026-12-01T09:00:00.000Z missed",
      "2026-12-02T09:00:00.000Z missed",
      "2026-12-03T09:00:00.000Z claimed",
    ]);
    assert.equal(h.claims.length, 1);
    assert.equal(scheduleStore.get(schedule.id)!.nextDueAtMs, DEC1 + 3 * DAY);
  });

  it("a restarted clock on the same database claims nothing twice", () => {
    const schedule = scheduleStore.create(input(), DEC1 - HOUR);
    const first = started(harness(DEC1));
    assert.equal(first.claims.length, 1);
    first.clock.stop();
    const second = started(harness(DEC1 + 10 * MINUTE));
    assert.equal(second.claims.length, 0);
    assert.deepEqual(states(schedule.id), ["2026-12-01T09:00:00.000Z claimed"]);
  });

  it("a restart after downtime claims within grace and misses beyond it", () => {
    const schedule = scheduleStore.create(input(), DEC1 - HOUR);
    started(harness(DEC1 - HOUR)).clock.stop();
    const back = started(harness(DEC1 + DAY + 61 * MINUTE));
    assert.equal(back.claims.length, 0);
    assert.deepEqual(states(schedule.id), [
      "2026-12-01T09:00:00.000Z missed",
      "2026-12-02T09:00:00.000Z missed",
    ]);
    assert.equal(back.firesAt(), DEC1 + 2 * DAY);
  });
});

describe("Pause all", () => {
  it("misses due times while paused, keeps the earlier claim owed and does not catch up", () => {
    const schedule = scheduleStore.create(input(), DEC1 - HOUR);
    const h = started(harness(DEC1 - HOUR));
    h.advanceTo(DEC1);
    const [owed] = scheduleStore.history(schedule.id);
    h.setPaused(true);
    h.advanceTo(DEC1 + 2 * DAY + MINUTE);
    assert.deepEqual(states(schedule.id), [
      "2026-12-01T09:00:00.000Z claimed",
      "2026-12-02T09:00:00.000Z missed",
      "2026-12-03T09:00:00.000Z missed",
    ]);
    assert.equal(scheduleStore.getOccurrence(owed!.id)?.state, "claimed");
    // Restarting changes nothing: the pause is stored, not remembered.
    h.clock.stop();
    const restarted = started(harness(DEC1 + 2 * DAY + 2 * MINUTE));
    // Resuming inside the old grace window claims nothing missed.
    restarted.setPaused(false);
    restarted.advanceTo(DEC1 + 2 * DAY + 10 * MINUTE);
    assert.equal(h.claims.length + restarted.claims.length, 1);
    assert.deepEqual(states(schedule.id), [
      "2026-12-01T09:00:00.000Z claimed",
      "2026-12-02T09:00:00.000Z missed",
      "2026-12-03T09:00:00.000Z missed",
    ]);
    // The next due time after the resume is claimed as usual, superseding.
    restarted.advanceTo(DEC1 + 3 * DAY);
    assert.deepEqual(states(schedule.id), [
      "2026-12-01T09:00:00.000Z superseded",
      "2026-12-02T09:00:00.000Z missed",
      "2026-12-03T09:00:00.000Z missed",
      "2026-12-04T09:00:00.000Z claimed",
    ]);
    assert.equal(restarted.claims.length, 1);
  });
});

describe("Pause all across late ticks, back-off and restarts", () => {
  const DEC2 = DEC1 + DAY;
  const SECOND = 1000;

  /** A daily Schedule whose Dec 1 occurrence is claimed and still owed. */
  function owedSchedule(timing: ScheduleTiming = DAILY): {
    id: string;
    owedId: string;
  } {
    const schedule = scheduleStore.create(input({ timing }), DEC1 - HOUR);
    const h = started(harness(DEC1 - HOUR));
    h.advanceTo(DEC1);
    h.clock.stop();
    const [owed] = scheduleStore.history(schedule.id);
    assert.equal(owed?.state, "claimed");
    return { id: schedule.id, owedId: owed!.id };
  }

  /** A store whose sweep fails the next `failures` times. */
  function failingSweeps(failures: number): Store {
    let left = failures;
    return {
      ...scheduleStore,
      runMaintenance: (nowMs) => {
        if (left > 0) {
          left -= 1;
          throw new Error("transient maintenance fault");
        }
        return scheduleStore.runMaintenance(nowMs);
      },
    };
  }

  /** A clock at Dec 2 08:59:30 whose boot sweep fails: retry 09:00:30. */
  function inBackOff(paused: boolean, store: Store = failingSweeps(1)) {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness(DEC2 - 30 * SECOND, store);
    if (paused) h.setPaused(true);
    started(h);
    assert.equal(h.firesAt(), DEC2 + 30 * SECOND);
    return h;
  }

  it("C1: misses the paused due time and keeps the owed claim (A-F002)", () => {
    const { id, owedId } = owedSchedule();
    const h = inBackOff(true);
    h.advanceTo(DEC2 + 15 * SECOND);
    h.setPaused(false);
    h.advanceTo(DEC2 + 30 * SECOND);
    assert.deepEqual(states(id), [
      "2026-12-01T09:00:00.000Z claimed",
      "2026-12-02T09:00:00.000Z missed",
    ]);
    assert.equal(scheduleStore.getOccurrence(owedId)?.state, "claimed");
    assert.deepEqual(h.claims, []);
    // The failed boot sweep ran again and only then moved its deadline.
    assert.equal(h.clock.maintenanceDueAtMs(), DEC2 + 30 * SECOND + DAY);
    // The next due time after the resume is claimed as usual.
    h.advanceTo(DEC2 + DAY);
    assert.deepEqual(states(id), [
      "2026-12-01T09:00:00.000Z superseded",
      "2026-12-02T09:00:00.000Z missed",
      "2026-12-03T09:00:00.000Z claimed",
    ]);
    assert.equal(h.claims.length, 1);
  });

  it("C2: a restart during the back-off while still paused misses it", () => {
    const { id, owedId } = owedSchedule();
    const h = inBackOff(true);
    h.advanceTo(DEC2 + 15 * SECOND);
    h.clock.stop();
    closeDb();
    const restarted = started(harness(DEC2 + 40 * SECOND));
    assert.deepEqual(states(id), [
      "2026-12-01T09:00:00.000Z claimed",
      "2026-12-02T09:00:00.000Z missed",
    ]);
    assert.equal(scheduleStore.getOccurrence(owedId)?.state, "claimed");
    assert.deepEqual([...h.claims, ...restarted.claims], []);
  });

  it("C3: a restart after a resume during the back-off misses it and keeps the owed claim (A-F002)", () => {
    const { id, owedId } = owedSchedule();
    const h = inBackOff(true);
    h.advanceTo(DEC2 + 15 * SECOND);
    h.setPaused(false);
    h.clock.stop();
    closeDb();
    const restarted = started(harness(DEC2 + 20 * SECOND));
    assert.deepEqual(states(id), [
      "2026-12-01T09:00:00.000Z claimed",
      "2026-12-02T09:00:00.000Z missed",
    ]);
    assert.equal(scheduleStore.getOccurrence(owedId)?.state, "claimed");
    assert.deepEqual([...h.claims, ...restarted.claims], []);
    restarted.advanceTo(DEC2 + DAY);
    assert.deepEqual(states(id), [
      "2026-12-01T09:00:00.000Z superseded",
      "2026-12-02T09:00:00.000Z missed",
      "2026-12-03T09:00:00.000Z claimed",
    ]);
    assert.equal(restarted.claims.length, 1);
  });

  it("C4: a due time in the unpaused gap between two pauses is claimed by the second pause (A-F003)", () => {
    const { id, owedId } = owedSchedule();
    const h = inBackOff(true);
    h.advanceTo(DEC2 - 10 * SECOND);
    h.setPaused(false);
    h.advanceTo(DEC2 + 5 * SECOND);
    h.setPaused(true);
    h.advanceTo(DEC2 + 15 * SECOND);
    h.setPaused(false);
    h.advanceTo(DEC2 + 30 * SECOND);
    assert.deepEqual(states(id), [
      "2026-12-01T09:00:00.000Z superseded",
      "2026-12-02T09:00:00.000Z claimed",
    ]);
    const [claimed] = scheduleStore.history(id);
    assert.equal(claimed!.claimedAtMs, DEC2 + 5 * SECOND, "at the pause");
    assert.equal(scheduleStore.getOccurrence(owedId)?.state, "superseded");
    assert.deepEqual(
      h.claims.map((c) => c.occurrenceId),
      [claimed!.id],
    );
    assert.equal(scheduleStore.paused(), false);
  });

  it("C4b: of two dailies, the one due in the unpaused gap is claimed and the one due while paused is missed", () => {
    const b = owedSchedule();
    const a = scheduleStore.create(
      input({ timing: { ...DAILY, time: "08:45" } }),
      DEC2 - 2 * HOUR,
    ).id;
    const h = started(harness(DEC2 - 2 * HOUR));
    h.advanceTo(DEC2 - HOUR);
    h.setPaused(true);
    h.advanceTo(DEC2 - 30 * MINUTE);
    h.setPaused(false);
    // A's 08:45 falls unpaused, but its timer runs late.
    h.stall(DEC2 - 10 * MINUTE);
    h.setPaused(true);
    // B's 09:00 falls while paused.
    h.stall(DEC2 + 10 * MINUTE);
    h.setPaused(false);
    h.advanceTo(DEC2 + 11 * MINUTE);
    assert.deepEqual(states(a), ["2026-12-02T08:45:00.000Z claimed"]);
    assert.deepEqual(states(b.id), [
      "2026-12-01T09:00:00.000Z claimed",
      "2026-12-02T09:00:00.000Z missed",
    ]);
    assert.equal(scheduleStore.getOccurrence(b.owedId)?.state, "claimed");
    const [aClaim] = scheduleStore.history(a);
    assert.deepEqual(
      h.claims.map((c) => c.occurrenceId),
      [aClaim!.id],
    );
  });

  it("C5: counts a due time at the resume instant as paused, one after it as not", () => {
    const atResume = owedSchedule();
    const h = inBackOff(true);
    h.advanceTo(DEC2);
    h.setPaused(false);
    h.advanceTo(DEC2 + 30 * SECOND);
    assert.deepEqual(states(atResume.id), [
      "2026-12-01T09:00:00.000Z claimed",
      "2026-12-02T09:00:00.000Z missed",
    ]);
    assert.deepEqual(h.claims, []);
    h.clock.stop();

    getDb().exec(
      "DELETE FROM schedule_occurrences; DELETE FROM schedules; DELETE FROM schedule_pause;",
    );
    const afterResume = owedSchedule();
    const g = inBackOff(true);
    g.advanceTo(DEC2 - 1);
    g.setPaused(false);
    g.advanceTo(DEC2 + 30 * SECOND);
    assert.deepEqual(states(afterResume.id), [
      "2026-12-01T09:00:00.000Z superseded",
      "2026-12-02T09:00:00.000Z claimed",
    ]);
    assert.equal(g.claims.length, 1);
  });

  it("C6: an unpaused due time crossed during the back-off is claimed by a pause within grace, missed beyond it", () => {
    const within = owedSchedule();
    const h = inBackOff(false);
    h.advanceTo(DEC2 + 15 * SECOND);
    h.setPaused(true);
    assert.deepEqual(states(within.id), [
      "2026-12-01T09:00:00.000Z superseded",
      "2026-12-02T09:00:00.000Z claimed",
    ]);
    assert.equal(h.claims.length, 1);
    h.advanceTo(DEC2 + 30 * SECOND);
    assert.equal(h.claims.length, 1, "the retry claims nothing more");
    h.clock.stop();

    getDb().exec(
      "DELETE FROM schedule_occurrences; DELETE FROM schedules; DELETE FROM schedule_pause;",
    );
    const beyond = owedSchedule();
    const g = inBackOff(false);
    g.setSettings({ graceWindowMinutes: 0 });
    g.advanceTo(DEC2 + 15 * SECOND);
    g.setPaused(true);
    g.advanceTo(DEC2 + 30 * SECOND);
    assert.deepEqual(states(beyond.id), [
      "2026-12-01T09:00:00.000Z claimed",
      "2026-12-02T09:00:00.000Z missed",
    ]);
    assert.deepEqual(g.claims, []);
  });

  it("misses it when the timer runs late across the resume, no failure", () => {
    const { id, owedId } = owedSchedule();
    const h = harness(DEC2 - HOUR);
    h.setPaused(true);
    started(h);
    assert.equal(h.firesAt(), DEC2);
    h.stall(DEC2 + 10 * SECOND);
    h.setPaused(false);
    h.advanceTo(DEC2 + 20 * SECOND);
    assert.deepEqual(states(id), [
      "2026-12-01T09:00:00.000Z claimed",
      "2026-12-02T09:00:00.000Z missed",
    ]);
    assert.equal(scheduleStore.getOccurrence(owedId)?.state, "claimed");
    assert.deepEqual(h.claims, []);
  });

  it("misses it across several switches and writes during the back-off", () => {
    const { id, owedId } = owedSchedule();
    const h = inBackOff(true);
    h.advanceTo(DEC2 + 5 * SECOND);
    h.setPaused(false);
    h.setPaused(true);
    scheduleStore.create(input(), DEC2 + 6 * SECOND);
    h.setPaused(false);
    h.setSettings({ graceWindowMinutes: 90 });
    assert.equal(h.firesAt(), DEC2 + 30 * SECOND, "the back-off holds");
    h.advanceTo(DEC2 + 30 * SECOND);
    assert.deepEqual(states(id), [
      "2026-12-01T09:00:00.000Z claimed",
      "2026-12-02T09:00:00.000Z missed",
    ]);
    assert.equal(scheduleStore.getOccurrence(owedId)?.state, "claimed");
    assert.deepEqual(h.claims, []);
  });

  it("a resume needs no successful tick: failing claims cannot turn a paused due time into a claim", () => {
    const { id, owedId } = owedSchedule();
    let claimFailures = 2;
    const store: Store = {
      ...failingSweeps(1),
      claimDue: (...args) => {
        if (claimFailures > 0) {
          claimFailures -= 1;
          throw new Error("disk I/O error");
        }
        return scheduleStore.claimDue(...args);
      },
    };
    const h = inBackOff(true, store);
    // The paused retry at 09:00:30 fails to claim: retry at 09:01:30.
    h.advanceTo(DEC2 + 45 * SECOND);
    assert.equal(claimFailures, 1);
    assert.deepEqual(states(id), ["2026-12-01T09:00:00.000Z claimed"]);
    h.setPaused(false);
    assert.deepEqual(states(id), [
      "2026-12-01T09:00:00.000Z claimed",
      "2026-12-02T09:00:00.000Z missed",
    ]);
    h.advanceTo(DEC2 + 150 * SECOND);
    assert.equal(scheduleStore.getOccurrence(owedId)?.state, "claimed");
    assert.deepEqual(h.claims, []);
  });

  it("C8: a claim made while the clock is stopped stays owed, and start does not replay it", () => {
    const schedule = scheduleStore.create(input(), DEC2 - DAY / 2);
    const h = started(harness(DEC2 - HOUR));
    h.clock.stop();
    h.stall(DEC2 + MINUTE);
    h.setPaused(true);
    const [owed] = scheduleStore.history(schedule.id);
    assert.equal(owed?.state, "claimed");
    assert.deepEqual(h.claims, []);
    h.clock.start();
    h.advanceTo(DEC2 + 2 * MINUTE);
    assert.deepEqual(h.claims, [], "not replayed, not duplicated");
    closeDb();
    assert.equal(scheduleStore.getOccurrence(owed!.id)?.state, "claimed");
  });

  it("C9: hands the hook exactly one call per claim, from a tick and from a switch", () => {
    const ticked = scheduleStore.create(input(), DEC2 - DAY / 2).id;
    const switched = scheduleStore.create(
      input({ timing: { ...DAILY, time: "09:05" } }),
      DEC2 - DAY / 2,
    ).id;
    const h = started(harness(DEC2 - HOUR));
    h.advanceTo(DEC2);
    h.stall(DEC2 + 6 * MINUTE);
    h.setPaused(true);
    h.advanceTo(DEC2 + 10 * MINUTE);
    const ids = [ticked, switched].map(
      (id) => scheduleStore.history(id)[0]!.id,
    );
    assert.deepEqual(
      [ticked, switched].map((id) => states(id)),
      [
        ["2026-12-02T09:00:00.000Z claimed"],
        ["2026-12-02T09:05:00.000Z claimed"],
      ],
    );
    assert.deepEqual(
      h.claims.map((c) => c.occurrenceId),
      ids,
    );
  });

  it("C7: a real settings save switches the stored pause; the file keeps no `paused`", async () => {
    const { saveSettings, settingsPatchForWrites } =
      await import("../settingsService.ts");
    const { getSettings } = await import("../settings.ts");
    const before = getSettings().schedules;
    const { id, owedId } = owedSchedule();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["Date"] });
    let pending: { fire: () => void; at: number } | undefined;
    const claims: string[] = [];
    const clock = createScheduleClock({
      store: failingSweeps(1),
      now: () => Date.now(),
      timers: {
        set: (fire, delayMs) => (pending = { fire, at: Date.now() + delayMs }),
        clear: (handle) => {
          if (pending === handle) pending = undefined;
        },
      },
      claimed: (_target, occurrence) => claims.push(occurrence.id),
    });
    const pause = (value: boolean) =>
      saveSettings(
        settingsPatchForWrites([{ path: "schedules.paused", value }]),
      );
    try {
      vi.setSystemTime(DEC2 - 30 * SECOND);
      await pause(true);
      assert.equal(getSettings().schedules.paused, true);
      assert.equal(scheduleStore.paused(), true);
      assert.equal(
        "paused" in (readStoredAppSettings().schedules ?? {}),
        false,
      );
      clock.start();
      assert.equal(pending?.at, DEC2 + 30 * SECOND);
      vi.setSystemTime(DEC2 + 15 * SECOND);
      await pause(true);
      await pause(false);
      assert.equal(getSettings().schedules.paused, false);
      assert.equal(
        "paused" in (readStoredAppSettings().schedules ?? {}),
        false,
      );
      vi.setSystemTime(DEC2 + 30 * SECOND);
      pending!.fire();
      assert.deepEqual(states(id), [
        "2026-12-01T09:00:00.000Z claimed",
        "2026-12-02T09:00:00.000Z missed",
      ]);
      assert.equal(scheduleStore.getOccurrence(owedId)?.state, "claimed");
      assert.deepEqual(claims, []);
    } finally {
      clock.stop();
      vi.useRealTimers();
      await saveSettings({ schedules: before });
    }
  });
});

describe("maintenance", () => {
  let events: string[];
  let previousSink: ReturnType<typeof setStateChangeSink>;
  beforeEach(() => {
    events = [];
    previousSink = setStateChangeSink((topic, ids) => {
      if (topic === "schedules") events.push(...ids);
    });
  });
  afterEach(() => setStateChangeSink(previousSink));

  /** A `once` Schedule claimed at its due time and delivered at `t0`. */
  function doneAt(h: ReturnType<typeof harness>, t0: number): string {
    const schedule = scheduleStore.create(
      input({ timing: once("2026-12-01") }),
      h.now(),
    );
    h.advanceTo(DEC1);
    const [occurrence] = scheduleStore.history(schedule.id);
    h.advanceTo(t0);
    assert.ok(
      scheduleStore.settleOccurrence(occurrence!.id, "delivered", {}, t0),
    );
    assert.equal(scheduleStore.get(schedule.id)?.doneAtMs, t0);
    return schedule.id;
  }

  /** `id` is a tombstone at a newer revision, announced since `events` was cleared. */
  function deletedWithEvent(id: string, before: number): void {
    const revision = scheduleStore.revisionsFor([id]).get(id);
    assert.equal(revision?.live, false, `${id} is a tombstone`);
    assert.ok(revision!.revision > before, "the delete moved the revision");
    assert.ok(events.includes(id), "the delete was announced");
  }

  it("is not starved by hourly settings and store writes", () => {
    const h = started(harness(DEC1 - HOUR));
    const t0 = DEC1 + 5 * MINUTE;
    const done = doneAt(h, t0);
    const disabled = scheduleStore.create(input(), h.now());
    scheduleStore.setEnabled(disabled.id, false, h.now(), GRACE);
    const doneRevision = scheduleStore.revision(done)!;
    events.length = 0;
    const bound = t0 + SCHEDULE_RETENTION_MS + DAY;
    let deletedAt: number | undefined;
    let flip = false;
    for (let t = t0 + HOUR; t <= bound; t += HOUR) {
      h.advanceTo(t);
      const deadline = h.clock.maintenanceDueAtMs()!;
      flip = !flip;
      h.setSettings({ graceWindowMinutes: flip ? 30 : 31 });
      scheduleStore.update(disabled.id, { name: `Renamed ${t}` }, GRACE, t);
      assert.equal(h.clock.maintenanceDueAtMs(), deadline, "never postponed");
      assert.ok(h.firesAt()! <= deadline);
      if (deletedAt === undefined && !scheduleStore.get(done)) deletedAt = t;
    }
    assert.ok(deletedAt !== undefined && deletedAt <= bound);
    deletedWithEvent(done, doneRevision);
    assert.ok(scheduleStore.get(disabled.id), "the disabled one remains");
    assert.ok(Math.max(...h.delays) <= DAY);
  });

  it("deletes a done Schedule on a quiet table, kept until 30 days", () => {
    const h = started(harness(DEC1 - HOUR));
    const t0 = DEC1 + 5 * MINUTE;
    const done = doneAt(h, t0);
    const disabled = scheduleStore.create(input(), h.now());
    scheduleStore.setEnabled(disabled.id, false, h.now(), GRACE);
    const doneRevision = scheduleStore.revision(done)!;
    events.length = 0;
    h.advanceTo(t0 + SCHEDULE_RETENTION_MS - 1);
    assert.ok(scheduleStore.get(done), "kept before 30 days");
    h.advanceTo(t0 + SCHEDULE_RETENTION_MS + DAY);
    deletedWithEvent(done, doneRevision);
    assert.ok(scheduleStore.get(disabled.id));
    assert.ok(h.delays.every((delay) => delay > 0 && delay <= DAY));
  });

  it("never prunes or finishes a claimed occurrence", () => {
    const h = started(harness(DEC1 - HOUR));
    const schedule = scheduleStore.create(
      input({ timing: once("2026-12-01") }),
      h.now(),
    );
    h.advanceTo(DEC1);
    h.advanceTo(DEC1 + 2 * SCHEDULE_RETENTION_MS);
    assert.equal(scheduleStore.get(schedule.id)?.doneAtMs, undefined);
    assert.deepEqual(states(schedule.id), ["2026-12-01T09:00:00.000Z claimed"]);
  });

  it("finishes a disabled finite Schedule and keeps an indefinite one", () => {
    const h = started(harness(DEC1 - HOUR));
    const finite = scheduleStore.create(
      input({ timing: { ...DAILY, endsOn: "2026-12-02" } }),
      h.now(),
    );
    const indefinite = scheduleStore.create(input(), h.now());
    scheduleStore.setEnabled(finite.id, false, h.now(), GRACE);
    scheduleStore.setEnabled(indefinite.id, false, h.now(), GRACE);
    // Last date Dec 2 09:00; the first sweep after it stamps done.
    h.advanceTo(DEC1 + 2 * DAY);
    const doneAtMs = scheduleStore.get(finite.id)?.doneAtMs;
    assert.ok(doneAtMs !== undefined && doneAtMs > DEC1 + DAY);
    assert.ok(doneAtMs <= DEC1 + DAY + DAY);
    h.advanceTo(doneAtMs + SCHEDULE_RETENTION_MS + DAY);
    assert.equal(scheduleStore.get(finite.id), undefined);
    assert.ok(scheduleStore.get(indefinite.id));
    assert.equal(scheduleStore.get(indefinite.id)?.doneAtMs, undefined);
  });

  it("deletes at boot the Schedules whose target session was deleted", () => {
    sessionStore.upsert({
      id: "clock-gone",
      harness: "claude-sdk",
      agentType: "assistant",
    });
    const gone = scheduleStore.create(
      input({ target: { kind: "session", sessionId: "clock-gone" } }),
      DEC1 - HOUR,
    );
    const kept = scheduleStore.create(input(), DEC1 - HOUR);
    sessionStore.markDeleted("clock-gone");
    const revision = scheduleStore.revision(gone.id)!;
    events.length = 0;
    started(harness(DEC1 - 30 * MINUTE));
    deletedWithEvent(gone.id, revision);
    assert.ok(scheduleStore.get(kept.id));
  });
});

describe("failure", () => {
  it("retries a failed claim after a bounded delay, never at once", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const schedule = scheduleStore.create(input(), DEC1 - HOUR);
    let failing = true;
    const store: Store = {
      ...scheduleStore,
      claimDue: (...args) => {
        if (failing) throw new Error("disk I/O error");
        return scheduleStore.claimDue(...args);
      },
    };
    const h = started(harness(DEC1 - HOUR, store));
    h.advanceTo(DEC1);
    assert.equal(h.firesAt(), DEC1 + SCHEDULE_CLOCK_RETRY_MS);
    // A store write during the back-off does not fire sooner.
    scheduleStore.create(input(), DEC1 + 1);
    h.setSettings({ graceWindowMinutes: 45 });
    assert.equal(h.firesAt(), DEC1 + SCHEDULE_CLOCK_RETRY_MS);
    h.advanceTo(DEC1 + 30 * SCHEDULE_CLOCK_RETRY_MS - 1);
    assert.equal(h.claims.length, 0);
    assert.ok(h.delays.every((delay) => delay > 0));
    failing = false;
    h.advanceTo(DEC1 + 30 * SCHEDULE_CLOCK_RETRY_MS);
    assert.deepEqual(states(schedule.id), ["2026-12-01T09:00:00.000Z claimed"]);
    // The next maintenance deadline: a day after the boot sweep.
    assert.equal(h.firesAt(), DEC1 - HOUR + DAY);
  });

  it("keeps the maintenance deadline until a sweep completes", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let failing = true;
    let sweeps = 0;
    const store: Store = {
      ...scheduleStore,
      runMaintenance: (nowMs) => {
        sweeps += 1;
        if (failing) throw new Error("database is locked");
        return scheduleStore.runMaintenance(nowMs);
      },
    };
    const h = started(harness(DEC1, store));
    assert.equal(h.clock.maintenanceDueAtMs(), DEC1, "not advanced");
    assert.equal(h.firesAt(), DEC1 + SCHEDULE_CLOCK_RETRY_MS);
    assert.match(String(warn.mock.calls[0]?.[1]), /database is locked/);
    h.advanceTo(DEC1 + 3 * SCHEDULE_CLOCK_RETRY_MS);
    assert.equal(sweeps, 4);
    failing = false;
    h.advanceTo(DEC1 + 4 * SCHEDULE_CLOCK_RETRY_MS);
    assert.equal(
      h.clock.maintenanceDueAtMs(),
      DEC1 + 4 * SCHEDULE_CLOCK_RETRY_MS + DAY,
    );
    assert.equal(h.firesAt(), DEC1 + 4 * SCHEDULE_CLOCK_RETRY_MS + DAY);
  });

  it("retries when the settings cannot be read, and still sweeps", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    scheduleStore.create(input(), DEC1 - HOUR);
    const clockNow = DEC1;
    let armedDelay: number | undefined;
    const clock = createScheduleClock({
      now: () => clockNow,
      timers: {
        set: (_fire, delayMs) => (armedDelay = delayMs),
        clear: () => {},
      },
      settings: {
        read: () => {
          throw new Error("settings.json is not valid JSON");
        },
        onChange: () => () => {},
      },
    });
    clock.start();
    stops.push(() => clock.stop());
    assert.equal(armedDelay, SCHEDULE_CLOCK_RETRY_MS);
    assert.equal(clock.maintenanceDueAtMs(), DEC1 + DAY);
  });

  it("a stopped clock no longer arms on writes", () => {
    const h = started(harness(DEC1 - HOUR));
    h.clock.stop();
    const armed = h.delays.length;
    scheduleStore.create(input(), DEC1 - HOUR);
    h.setPaused(true);
    h.setSettings({ graceWindowMinutes: 30 });
    assert.equal(h.delays.length, armed);
    assert.equal(h.clock.maintenanceDueAtMs(), undefined);
  });
});
