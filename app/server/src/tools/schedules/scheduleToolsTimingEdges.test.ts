/**
 * Supplied timings at their edges through `schedule_manage`. B-F001: every
 * supplied timing, on create and on update, needs a future occurrence, and a
 * refused update writes nothing, not even the old-definition cutover. B-F002:
 * a Schedule on the calendar's last day creates, echoes, reads and persists
 * alike.
 *   pnpm --filter @assistant/server test src/tools/schedules/scheduleToolsTimingEdges.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import { scheduleStore } from "../../db/scheduleStore.ts";
import {
  BERLIN,
  DAY,
  MINUTE,
  NOV25_0800,
  clock,
  createDaily,
  historyStates,
  manage,
  manageOne,
  manageThrows,
  readOne,
  resetScheduleTools,
  seedSession,
  useSettings,
} from "../../test/scheduleToolsFixture.ts";

const NO_FUTURE = "Schedule timing has no future occurrence";
/** 09:00 in Berlin on 25 Nov 2026, a daily Schedule's first due. */
const DUE = NOV25_0800 + 60 * MINUTE;
const DUE_ISO = new Date(DUE).toISOString();
const PAST_ONCE = { kind: "once", at: "2026-11-25 07:59" };
const EXPIRED_REPEAT = { kind: "daily", time: "09:00", endsOn: "2026-11-24" };

beforeEach(() => useSettings());
afterEach(() => resetScheduleTools());

/** Everything a write could change: the Schedule and its history. */
function snapshot(id: string) {
  return {
    schedule: scheduleStore.get(id),
    history: scheduleStore.history(id),
  };
}

/** A once Schedule delivered at its due: done, legitimately. */
async function doneOnce(me: string): Promise<string> {
  const id = (
    await manageOne(me, {
      operation: "create",
      name: "Once",
      prompt: "Once",
      targetSessionId: me,
      timing: { kind: "once", at: "in 45m" },
    })
  ).schedule.id;
  const due = scheduleStore.get(id)!.nextDueAtMs!;
  scheduleStore.claimDue(id, due, { graceMs: 60 * MINUTE });
  const [occurrence] = scheduleStore.history(id);
  scheduleStore.settleOccurrence(occurrence!.id, "delivered", {
    sessionId: me,
  });
  clock.now = due + MINUTE;
  assert.ok(scheduleStore.get(id)!.doneAtMs !== undefined);
  return id;
}

describe("B-F001 every supplied timing needs a future occurrence", () => {
  for (const [what, timing] of [
    ["a past once", PAST_ONCE],
    ["an expired repeat", EXPIRED_REPEAT],
  ] as const) {
    it(`create refuses ${what} and writes nothing`, async () => {
      const me = seedSession();
      assert.equal(
        await manageThrows(me, [
          {
            operation: "create",
            name: "Past",
            prompt: "Past",
            targetSessionId: me,
            timing,
          },
        ]),
        NO_FUTURE,
      );
      assert.equal(scheduleStore.list().length, 0);
    });

    it(`an update at the old due refuses ${what} before any cutover; the next row applies`, async () => {
      const me = seedSession();
      const id = await createDaily(me);
      const other = await createDaily(me);
      clock.now = DUE;
      const before = snapshot(id);
      const results = await manage(me, [
        { operation: "update", id, prompt: "Changed", timing },
        { operation: "update", id: other, prompt: "Sibling" },
      ]);
      assert.deepEqual(
        results.map((r) => r.error ?? "ok"),
        [NO_FUTURE, "ok"],
      );
      assert.deepEqual(snapshot(id), before);
      assert.deepEqual(historyStates(id), []);
      assert.equal(scheduleStore.get(id)!.nextDueAtMs, DUE);
      assert.equal(scheduleStore.get(other)!.prompt, "Sibling");
    });

    it(`a disabled Schedule refuses ${what} and stays as it was`, async () => {
      const me = seedSession();
      const id = await createDaily(me, me, { enabled: false });
      const before = snapshot(id);
      assert.equal(
        await manageThrows(me, [{ operation: "update", id, timing }]),
        NO_FUTURE,
      );
      assert.deepEqual(snapshot(id), before);
      assert.equal(scheduleStore.get(id)!.doneAtMs, undefined);
    });

    it(`a done Schedule refuses ${what} and stays as it was`, async () => {
      const me = seedSession();
      const id = await doneOnce(me);
      const before = snapshot(id);
      assert.equal(
        await manageThrows(me, [{ operation: "update", id, timing }]),
        NO_FUTURE,
      );
      assert.deepEqual(snapshot(id), before);
    });
  }

  it("refuses a timing identical to the stored one once it has expired", async () => {
    const me = seedSession();
    const timing = { kind: "daily", time: "09:00", endsOn: "2026-11-25" };
    const id = await createDaily(me, me, { timing });
    clock.now = DUE + 2 * DAY;
    const before = snapshot(id);
    assert.equal(
      await manageThrows(me, [
        { operation: "update", id, timing: { ...timing } },
      ]),
      NO_FUTURE,
    );
    assert.deepEqual(snapshot(id), before);
  });

  it("leaves a patch without timing to the store: the expired one settles and is done", async () => {
    const me = seedSession();
    const id = await createDaily(me, me, {
      timing: { kind: "daily", time: "09:00", endsOn: "2026-11-25" },
    });
    clock.now = DUE + 2 * DAY;
    const result = await manageOne(me, {
      operation: "update",
      id,
      name: "Old",
    });
    assert.deepEqual(result.schedule.nextOccurrences, []);
    assert.deepEqual(historyStates(id), [`${DUE_ISO} missed`]);
    assert.equal((await readOne(me, id)).state, "done");

    const done = await doneOnce(me);
    const renamed = await manageOne(me, {
      operation: "update",
      id: done,
      prompt: "Still editable",
    });
    assert.deepEqual(renamed.schedule.nextOccurrences, []);
  });

  it("still applies a future timing at the old due, after its cutover", async () => {
    const me = seedSession();
    const id = await createDaily(me);
    clock.now = DUE;
    const result = await manageOne(me, {
      operation: "update",
      id,
      timing: { kind: "once", at: "in 2h" },
    });
    assert.deepEqual(historyStates(id), [`${DUE_ISO} claimed`]);
    assert.deepEqual(result.schedule.nextOccurrences, [
      "Wed 25 Nov 2026 11:00 Europe/Berlin (UTC+01:00)",
    ]);
  });
});

describe("B-F002 a Schedule on the calendar's last day", () => {
  const LAST_0900 = "Fri 31 Dec 9999 09:00 Europe/Berlin (UTC+01:00)";
  const LAST_DAY = { startsOn: "9999-12-31", endsOn: "9999-12-31" };

  it("creates, echoes, reads and persists its one occurrence alike", async () => {
    await useSettings({ cardlessLimit: 1 });
    const me = seedSession();
    const [created] = await manage(me, [
      {
        operation: "create",
        name: "Last day",
        prompt: "Last day",
        targetSessionId: me,
        timing: { kind: "daily", time: "09:00", ...LAST_DAY },
      },
    ]);
    assert.equal(created!.ok, true, JSON.stringify(created));
    assert.deepEqual(created!.schedule!.nextOccurrences, [LAST_0900]);
    const stored = scheduleStore.list();
    assert.deepEqual(
      stored.map((s) => s.id),
      [created!.schedule!.id],
    );
    assert.equal(stored[0]!.nextDueAtMs, Date.parse("9999-12-31T08:00:00Z"));
    const read = await readOne(me, created!.schedule!.id);
    assert.equal(read.state, "enabled");
    assert.deepEqual(read.nextOccurrences, [LAST_0900]);
    // It counts once toward the limit, as the one it is.
    assert.match(
      await manageThrows(me, [
        {
          operation: "create",
          name: "Another",
          prompt: "Another",
          targetSessionId: me,
          timing: { kind: "daily", time: "09:00" },
        },
      ]),
      /already controls 1 Schedules it created \(limit 1/,
    );
  });

  it("echoes what remains of an unbounded weekly, a monthly and a once", async () => {
    const me = seedSession();
    const echo = async (timing: Record<string, unknown>) =>
      (
        await manageOne(me, {
          operation: "create",
          name: "Edge",
          prompt: "Edge",
          targetSessionId: me,
          timing,
        })
      ).schedule.nextOccurrences;
    assert.deepEqual(
      await echo({
        kind: "weekly",
        days: ["mon", "fri"],
        time: "09:00",
        startsOn: "9999-12-21",
      }),
      [
        "Fri 24 Dec 9999 09:00 Europe/Berlin (UTC+01:00)",
        "Mon 27 Dec 9999 09:00 Europe/Berlin (UTC+01:00)",
        LAST_0900,
      ],
    );
    assert.deepEqual(
      await echo({
        kind: "monthly",
        day: 31,
        time: "09:00",
        startsOn: "9999-12-01",
      }),
      [LAST_0900],
    );
    assert.deepEqual(await echo({ kind: "once", at: "9999-12-31 23:59" }), [
      "Fri 31 Dec 9999 23:59 Europe/Berlin (UTC+01:00)",
    ]);
  });

  it("is done once the clock has claimed and delivered its last occurrence", () => {
    const me = seedSession();
    // Straight through the store, so the clock's own step is what is tested.
    const id = scheduleStore.create(
      {
        name: "Last day",
        prompt: "Last day",
        timing: {
          kind: "daily",
          time: "09:00",
          timeZone: BERLIN,
          ...LAST_DAY,
        },
        target: { kind: "session", sessionId: me },
        createdBy: { kind: "user" },
      },
      NOV25_0800,
    ).id;
    const last = Date.parse("9999-12-31T08:00:00Z");
    scheduleStore.claimDue(id, last, { graceMs: 60 * MINUTE });
    const [occurrence] = scheduleStore.history(id);
    assert.equal(occurrence!.state, "claimed");
    assert.equal(scheduleStore.get(id)!.nextDueAtMs, undefined);
    scheduleStore.settleOccurrence(occurrence!.id, "delivered", {
      sessionId: me,
    });
    assert.ok(scheduleStore.get(id)!.doneAtMs !== undefined);
  });
});
