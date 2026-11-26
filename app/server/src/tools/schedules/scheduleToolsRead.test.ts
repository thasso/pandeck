/**
 * `schedule_read` and the manage echoes (T6.7, T6.9), and the timing input
 * through the tool (T6.8): zones, gaps and the past.
 *   pnpm --filter @assistant/server test src/tools/schedules/scheduleToolsRead.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import {
  formatScheduleInstant,
  nextOccurrencesAfter,
  type ScheduleOccurrenceSummary,
} from "@assistant/shared/schedules";
import { scheduleStore } from "../../db/scheduleStore.ts";
import {
  BERLIN,
  DAY,
  MINUTE,
  NOV25_0800,
  clock,
  createDaily,
  manage,
  manageOne,
  manageThrows,
  readList,
  readOne,
  resetScheduleTools,
  seedSession,
  spawnChild,
  useSettings,
} from "../../test/scheduleToolsFixture.ts";

const DUE = NOV25_0800 + 60 * MINUTE;
const D10 =
  "delivery uncertain: the target session's transcript could not be read";
const D10A =
  "delivery failed: the target runtime returned without admitting the scheduled prompt";
const fmt = (ms: number) => formatScheduleInstant(ms, BERLIN);

beforeEach(() => useSettings());
afterEach(() => {
  vi.restoreAllMocks();
  resetScheduleTools();
});

function userSchedule(target: string, n = 0) {
  return scheduleStore.create(
    {
      name: `User ${n}`,
      prompt: `User prompt ${n}`,
      timing: { kind: "daily", time: "09:00", timeZone: BERLIN },
      target: { kind: "session", sessionId: target },
      createdBy: { kind: "user" },
    },
    NOV25_0800,
  ).id;
}

describe("T6.7 schedule_read", () => {
  it("lets any session read every Schedule, and filters", async () => {
    const me = seedSession();
    const child = spawnChild(me);
    const other = seedSession();
    const mine = await createDaily(me);
    const forChild = await createDaily(me, child);
    const others = await createDaily(other);
    const users = userSchedule(me);
    await manageOne(me, { operation: "disable", id: forChild });
    const stranger = seedSession();
    const ids = async (params: Record<string, unknown> = {}) =>
      (await readList(stranger, params)).schedules.map((s) => s.id);
    assert.deepEqual(await ids(), [mine, forChild, others, users]);
    assert.deepEqual(await ids({ targetSessionId: me }), [mine, users]);
    assert.deepEqual(await ids({ createdBy: "user" }), [users]);
    assert.deepEqual(await ids({ createdBy: other }), [others]);
    assert.deepEqual(await ids({ state: "disabled" }), [forChild]);
    assert.deepEqual(await ids({ state: "enabled", createdBy: me }), [mine]);
    assert.deepEqual(await ids({ state: "done" }), []);
  });

  it("lists each Schedule with its next and last occurrence and a clipped prompt", async () => {
    const me = seedSession();
    const long = "a".repeat(199) + "😀" + "b".repeat(50);
    const id = await createDaily(me, me, { prompt: long });
    const exact = await createDaily(me, me, { prompt: "c".repeat(200) });
    scheduleStore.claimDue(id, DUE + 5 * MINUTE, { graceMs: 60 * MINUTE });
    const [occurrence] = scheduleStore.history(id);
    scheduleStore.settleOccurrence(occurrence!.id, "failed", { error: D10 });
    const list = await readList(me);
    assert.deepEqual(list.schedules[0], {
      id,
      name: "Daily check",
      state: "enabled",
      target: { sessionId: me },
      timing: { kind: "daily", time: "09:00", timeZone: BERLIN },
      next: fmt(DUE + DAY),
      lastOccurrence: { state: "failed", due: fmt(DUE), error: D10 },
      createdBy: me,
      controlledBy: me,
      cardless: true,
      prompt: `${"a".repeat(199)}😀…`,
    });
    assert.equal(list.schedules[1]!.prompt, "c".repeat(200));
    assert.equal(list.schedules[1]!.id, exact);
    assert.equal(list.count, 2);
    assert.equal(list.truncated, false);
  });

  it("reads one by id with the full prompt, next three and its history as stored", async () => {
    const me = seedSession();
    const long = "x".repeat(300);
    const id = await createDaily(me, me, { prompt: long });
    const claimedAt = DUE + 5 * MINUTE;
    scheduleStore.claimDue(id, claimedAt, { graceMs: 60 * MINUTE });
    const [first] = scheduleStore.history(id);
    scheduleStore.settleOccurrence(
      first!.id,
      "failed",
      { error: D10A },
      claimedAt + MINUTE,
    );
    scheduleStore.claimDue(id, DUE + DAY, { graceMs: 60 * MINUTE });
    clock.now = DUE + DAY + 30 * MINUTE;
    const detail = await readOne(seedSession(), id);
    assert.equal(detail.prompt, long);
    assert.deepEqual(
      detail.nextOccurrences,
      nextOccurrencesAfter(
        { kind: "daily", time: "09:00", timeZone: BERLIN },
        clock.now,
        3,
      ).map(fmt),
    );
    const second = scheduleStore.history(id)[0]!;
    assert.deepEqual(detail.history, [
      {
        id: second.id,
        state: "claimed",
        due: fmt(DUE + DAY),
        claimed: fmt(DUE + DAY),
      },
      {
        id: first!.id,
        state: "failed",
        due: fmt(DUE),
        claimed: fmt(claimedAt),
        ended: fmt(claimedAt + MINUTE),
        error: D10A,
      },
    ]);
  });

  it("shows a concrete reason as stored, and at most 50 history entries", async () => {
    const me = seedSession();
    const id = await createDaily(me);
    const reason = "r".repeat(500);
    const many: ScheduleOccurrenceSummary[] = Array.from(
      { length: 60 },
      (_, i) => ({
        id: `occ_${i}`,
        scheduleId: id,
        state: "failed",
        dueAtMs: DUE - i * DAY,
        error: reason,
      }),
    );
    vi.spyOn(scheduleStore, "history").mockReturnValue(many);
    const detail = await readOne(me, id);
    assert.equal(detail.history!.length, 50);
    assert.deepEqual(
      detail.history!.map((h) => h.id),
      many.slice(0, 50).map((h) => h.id),
    );
    assert.equal(detail.history![0]!.error, reason);
  });

  it("returns 50 by default and up to 100, marking truncation", async () => {
    const me = seedSession();
    for (let n = 0; n < 55; n++) userSchedule(me, n);
    const byDefault = await readList(me);
    assert.equal(byDefault.schedules.length, 50);
    assert.equal(byDefault.count, 50);
    assert.equal(byDefault.truncated, true);
    const all = await readList(me, { maxResults: 100 });
    assert.equal(all.count, 55);
    assert.equal(all.truncated, false);
    const three = await readList(me, { maxResults: 3 });
    // In the store's order: the oldest first.
    assert.deepEqual(three.schedules, all.schedules.slice(0, 3));
    assert.equal(three.truncated, true);
    for (const maxResults of [0, 101, 1.5, "10"])
      await assert.rejects(readList(me, { maxResults }), {
        message: "maxResults must be a whole number from 1 to 100.",
      });
  });

  it("throws for an unknown id", async () => {
    await assert.rejects(readOne(seedSession(), "sch_missing"), {
      message: "Schedule not found: sch_missing",
    });
  });
});

describe("T6.9 echoes", () => {
  it("echoes the next three occurrences in the stored zone", async () => {
    const me = seedSession();
    const result = await manageOne(me, {
      operation: "create",
      name: "Daily",
      prompt: "Daily check",
      targetSessionId: me,
      timing: { kind: "daily", time: "09:00" },
    });
    assert.deepEqual(result.schedule.nextOccurrences, [
      "Wed 25 Nov 2026 09:00 Europe/Berlin (UTC+01:00)",
      "Thu 26 Nov 2026 09:00 Europe/Berlin (UTC+01:00)",
      "Fri 27 Nov 2026 09:00 Europe/Berlin (UTC+01:00)",
    ]);
  });

  it("echoes no occurrences for a disabled or done Schedule, and a bare delete", async () => {
    const me = seedSession();
    const id = await createDaily(me);
    const disabledAtCreate = await manageOne(me, {
      operation: "create",
      name: "Off",
      prompt: "Off",
      targetSessionId: me,
      timing: { kind: "daily", time: "09:00" },
      enabled: false,
    });
    assert.deepEqual(disabledAtCreate.schedule.nextOccurrences, []);
    assert.equal(disabledAtCreate.schedule.enabled, false);
    const disabled = await manageOne(me, { operation: "disable", id });
    assert.deepEqual(disabled.schedule.nextOccurrences, []);
    const enabled = await manageOne(me, { operation: "enable", id });
    assert.equal(enabled.schedule.nextOccurrences.length, 3);

    const once = await manageOne(me, {
      operation: "create",
      name: "Once",
      prompt: "Once",
      targetSessionId: me,
      timing: { kind: "once", at: "in 10m" },
    });
    const due = NOV25_0800 + 10 * MINUTE;
    scheduleStore.claimDue(once.schedule.id, due, { graceMs: 60 * MINUTE });
    const [occ] = scheduleStore.history(once.schedule.id);
    scheduleStore.settleOccurrence(occ!.id, "delivered", { sessionId: me });
    clock.now = due + MINUTE;
    const done = await manageOne(me, {
      operation: "update",
      id: once.schedule.id,
      name: "Once, renamed",
    });
    assert.deepEqual(done.schedule.nextOccurrences, []);
    assert.equal((await readOne(me, once.schedule.id)).state, "done");
    assert.deepEqual((await readOne(me, once.schedule.id)).nextOccurrences, []);

    const [deleted] = await manage(me, [{ operation: "delete", id }]);
    assert.deepEqual(deleted, {
      operation: "delete",
      ok: true,
      id,
      deleted: true,
    });
  });
});

describe("T6.8 timing input through the tool", () => {
  it("echoes a skipped local time at the gap's end", async () => {
    const me = seedSession();
    clock.now = Date.parse("2026-03-01T00:00:00Z");
    const result = await manageOne(me, {
      operation: "create",
      name: "Gap",
      prompt: "Gap",
      targetSessionId: me,
      timing: { kind: "once", at: "2026-03-29 02:30" },
    });
    assert.equal(result.schedule.timing.time, "02:30");
    assert.deepEqual(result.schedule.nextOccurrences, [
      "Sun 29 Mar 2026 03:00 Europe/Berlin (UTC+02:00)",
    ]);
  });

  it("refuses a time already past with the store's message", async () => {
    const me = seedSession();
    assert.equal(
      await manageThrows(me, [
        {
          operation: "create",
          name: "Past",
          prompt: "Past",
          targetSessionId: me,
          timing: { kind: "once", at: "2026-11-25 07:59" },
        },
      ]),
      "Schedule timing has no future occurrence",
    );
  });

  it("creates in the current profile zone and updates in the stored zone", async () => {
    const me = seedSession();
    const id = await createDaily(me);
    await useSettings({}, "America/New_York");
    const updated = await manageOne(me, {
      operation: "update",
      id,
      timing: { kind: "once", at: "2026-11-26 10:00" },
    });
    assert.equal(updated.schedule.timeZone, BERLIN);
    assert.deepEqual(updated.schedule.nextOccurrences, [
      "Thu 26 Nov 2026 10:00 Europe/Berlin (UTC+01:00)",
    ]);
    const created = await createDaily(me);
    assert.equal(
      scheduleStore.get(created)!.timing.timeZone,
      "America/New_York",
    );
  });
});
