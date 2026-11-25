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
import { setStateChangeSink } from "../db/changeSet.ts";
import { getDb } from "../db/index.ts";
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
  };
}

let stops: Array<() => void> = [];
function started(h: ReturnType<typeof harness>) {
  h.clock.start();
  stops.push(() => h.clock.stop());
  return h;
}

beforeEach(() => {
  getDb().exec("DELETE FROM schedule_occurrences; DELETE FROM schedules;");
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
    scheduleStore.setEnabled(soon.id, false, h.now());
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
    h.setSettings({ paused: true });
    h.advanceTo(DEC1 + 2 * DAY + MINUTE);
    assert.deepEqual(states(schedule.id), [
      "2026-12-01T09:00:00.000Z claimed",
      "2026-12-02T09:00:00.000Z missed",
      "2026-12-03T09:00:00.000Z missed",
    ]);
    assert.equal(scheduleStore.getOccurrence(owed!.id)?.state, "claimed");
    // Restarting while paused changes nothing.
    h.clock.stop();
    const restarted = harness(DEC1 + 2 * DAY + 2 * MINUTE);
    restarted.setSettings({ paused: true });
    started(restarted);
    // Resuming inside the old grace window claims nothing missed.
    restarted.setSettings({ paused: false });
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
  });
});

describe("Pause all, resumed before the tick that would miss", () => {
  const DEC2 = DEC1 + DAY;
  const SECOND = 1000;

  /** A daily Schedule whose Dec 1 occurrence is claimed and still owed. */
  function owedSchedule(): { id: string; owedId: string } {
    const schedule = scheduleStore.create(input(), DEC1 - HOUR);
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

  /** A paused clock at Dec 2 08:59:30 whose boot sweep fails: retry 09:00:30. */
  function pausedInBackOff(store: Store = failingSweeps(1)) {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness(DEC2 - 30 * SECOND, store);
    h.setSettings({ paused: true });
    started(h);
    assert.equal(h.firesAt(), DEC2 + 30 * SECOND);
    return h;
  }

  it("misses the paused due time and keeps the owed claim (A-F002)", () => {
    const { id, owedId } = owedSchedule();
    const h = pausedInBackOff();
    h.advanceTo(DEC2 + 15 * SECOND);
    h.setSettings({ paused: false });
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
  });

  it("misses it when the timer runs late across the resume, no failure", () => {
    const { id, owedId } = owedSchedule();
    const h = harness(DEC2 - HOUR);
    h.setSettings({ paused: true });
    started(h);
    assert.equal(h.firesAt(), DEC2);
    h.stall(DEC2 + 10 * SECOND);
    h.setSettings({ paused: false });
    h.advanceTo(DEC2 + 20 * SECOND);
    assert.deepEqual(states(id), [
      "2026-12-01T09:00:00.000Z claimed",
      "2026-12-02T09:00:00.000Z missed",
    ]);
    assert.equal(scheduleStore.getOccurrence(owedId)?.state, "claimed");
    assert.deepEqual(h.claims, []);
  });

  it("misses it across several pause and resume switches and writes during the back-off", () => {
    const { id, owedId } = owedSchedule();
    const h = pausedInBackOff();
    h.advanceTo(DEC2 + 5 * SECOND);
    h.setSettings({ paused: false });
    h.setSettings({ paused: true });
    scheduleStore.create(input(), DEC2 + 6 * SECOND);
    h.setSettings({ paused: false });
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

  it("keeps the paused cutoff while the claim that applies it fails", () => {
    const { id, owedId } = owedSchedule();
    vi.spyOn(console, "warn").mockImplementation(() => {});
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
    const h = pausedInBackOff(store);
    h.advanceTo(DEC2 + 15 * SECOND);
    h.setSettings({ paused: false });
    h.advanceTo(DEC2 + 90 * SECOND);
    assert.equal(claimFailures, 0, "both retries failed");
    assert.deepEqual(states(id), ["2026-12-01T09:00:00.000Z claimed"]);
    h.advanceTo(DEC2 + 150 * SECOND);
    assert.deepEqual(states(id), [
      "2026-12-01T09:00:00.000Z claimed",
      "2026-12-02T09:00:00.000Z missed",
    ]);
    assert.equal(scheduleStore.getOccurrence(owedId)?.state, "claimed");
    assert.deepEqual(h.claims, []);
  });

  it("hears the resume through a real settings write", async () => {
    const { saveSettings } = await import("../settingsService.ts");
    const { getSettings } = await import("../settings.ts");
    const before = getSettings().schedules;
    const { id, owedId } = owedSchedule();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let nowMs = DEC2 - 30 * SECOND;
    let pending: { fire: () => void; at: number } | undefined;
    const clock = createScheduleClock({
      store: failingSweeps(1),
      now: () => nowMs,
      timers: {
        set: (fire, delayMs) => (pending = { fire, at: nowMs + delayMs }),
        clear: (handle) => {
          if (pending === handle) pending = undefined;
        },
      },
    });
    try {
      await saveSettings({ schedules: { ...before, paused: true } });
      clock.start();
      assert.equal(pending?.at, DEC2 + 30 * SECOND);
      nowMs = DEC2 + 15 * SECOND;
      await saveSettings({ schedules: { ...before, paused: true } });
      await saveSettings({ schedules: { ...before, paused: false } });
      nowMs = DEC2 + 30 * SECOND;
      pending!.fire();
      assert.deepEqual(states(id), [
        "2026-12-01T09:00:00.000Z claimed",
        "2026-12-02T09:00:00.000Z missed",
      ]);
      assert.equal(scheduleStore.getOccurrence(owedId)?.state, "claimed");
    } finally {
      clock.stop();
      await saveSettings({ schedules: before });
    }
  });

  it("counts a due time at the resume instant as paused, one after it as not", () => {
    const atResume = owedSchedule();
    const h = pausedInBackOff();
    h.advanceTo(DEC2);
    h.setSettings({ paused: false });
    h.advanceTo(DEC2 + 30 * SECOND);
    assert.deepEqual(states(atResume.id), [
      "2026-12-01T09:00:00.000Z claimed",
      "2026-12-02T09:00:00.000Z missed",
    ]);
    h.clock.stop();

    getDb().exec("DELETE FROM schedule_occurrences; DELETE FROM schedules;");
    const afterResume = owedSchedule();
    const g = pausedInBackOff();
    g.advanceTo(DEC2 - 1);
    g.setSettings({ paused: false });
    g.advanceTo(DEC2 + 30 * SECOND);
    assert.deepEqual(states(afterResume.id), [
      "2026-12-01T09:00:00.000Z superseded",
      "2026-12-02T09:00:00.000Z claimed",
    ]);
    assert.equal(g.claims.length, 1);
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
    scheduleStore.setEnabled(disabled.id, false, h.now());
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
      scheduleStore.update(disabled.id, { name: `Renamed ${t}` }, t);
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
    scheduleStore.setEnabled(disabled.id, false, h.now());
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
    scheduleStore.setEnabled(finite.id, false, h.now());
    scheduleStore.setEnabled(indefinite.id, false, h.now());
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
    h.setSettings({ paused: true });
    assert.equal(h.delays.length, armed);
    assert.equal(h.clock.maintenanceDueAtMs(), undefined);
  });
});
