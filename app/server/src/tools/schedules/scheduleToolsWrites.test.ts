/**
 * `schedule_manage` through the store's cutovers and limits (T6.5, T6.6): an
 * edit or disable at a due time settles it under the old definition with the
 * grace window from settings, an attempted occurrence ends by its admission
 * evidence, and the cardless limit guards every move into the count.
 *   pnpm --filter @assistant/server test src/tools/schedules/scheduleToolsWrites.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import { scheduleStore } from "../../db/scheduleStore.ts";
import {
  DAY,
  MINUTE,
  NOV25_0800,
  clock,
  createDaily,
  historyStates,
  logAdmitted,
  manage,
  manageOne,
  manageThrows,
  removeLog,
  resetScheduleTools,
  seedSession,
  useSettings,
} from "../../test/scheduleToolsFixture.ts";

/** 09:00 in Berlin on 25 Nov 2026, the daily Schedule's first due. */
const DUE = NOV25_0800 + 60 * MINUTE;
const DUE_ISO = new Date(DUE).toISOString();
const OLD_PROMPT = "Check CI for PR #382 in pandeck; merge if green.";
const LIMIT = (n: number, limit: number) =>
  `This session already controls ${n} Schedules it created (limit ${limit}, disabled ones included); delete one or ask the user.`;

beforeEach(() => useSettings());
afterEach(() => resetScheduleTools());

function latest(id: string) {
  const [last] = scheduleStore.history(id);
  return last ? scheduleStore.getOccurrence(last.id)! : undefined;
}

describe("T6.5 edits and disables settle under the old definition", () => {
  it("an update exactly at due claims it with the old prompt; the cursor moves on", async () => {
    const me = seedSession();
    const id = await createDaily(me);
    clock.now = DUE;
    await manageOne(me, { operation: "update", id, prompt: "New prompt" });
    assert.deepEqual(historyStates(id), [`${DUE_ISO} claimed`]);
    assert.equal(latest(id)!.prompt, OLD_PROMPT);
    assert.equal(scheduleStore.get(id)!.prompt, "New prompt");
    assert.equal(scheduleStore.get(id)!.nextDueAtMs, DUE + DAY);
  });

  it("an identical timing keeps the cursor; a changed one starts after now", async () => {
    const me = seedSession();
    const id = await createDaily(me, me, {
      timing: { kind: "weekly", days: ["fri", "wed"], time: "09:00" },
    });
    await manageOne(me, {
      operation: "update",
      id,
      timing: { time: "09:00", days: ["wed", "fri"], kind: "weekly" },
    });
    assert.equal(scheduleStore.get(id)!.nextDueAtMs, DUE);
    assert.deepEqual(historyStates(id), []);
    clock.now = DUE + 30 * MINUTE;
    const result = await manageOne(me, {
      operation: "update",
      id,
      timing: { kind: "weekly", days: ["wed"], time: "10:00" },
    });
    assert.deepEqual(historyStates(id), [`${DUE_ISO} claimed`]);
    assert.equal(scheduleStore.get(id)!.nextDueAtMs, DUE + 60 * MINUTE);
    assert.equal(
      result.schedule.nextOccurrences[0],
      "Wed 25 Nov 2026 10:00 Europe/Berlin (UTC+01:00)",
    );
  });

  it("a disable inside the settings' grace window withdraws the due; outside it, missed", async () => {
    const me = seedSession();
    const id = await createDaily(me);
    clock.now = DUE + 10 * MINUTE;
    await manageOne(me, { operation: "disable", id });
    assert.deepEqual(historyStates(id), [`${DUE_ISO} withdrawn`]);
    assert.equal(scheduleStore.get(id)!.nextDueAtMs, undefined);
    assert.equal(scheduleStore.get(id)!.enabled, false);

    await useSettings({ graceWindowMinutes: 5 });
    clock.now = NOV25_0800;
    const short = await createDaily(me);
    clock.now = DUE + 10 * MINUTE;
    await manageOne(me, { operation: "disable", id: short });
    assert.deepEqual(historyStates(short), [`${DUE_ISO} missed`]);
  });

  it("a disable while paused records the due missed", async () => {
    const me = seedSession();
    const id = await createDaily(me);
    scheduleStore.setPaused(true, NOV25_0800 + MINUTE, 60 * MINUTE);
    clock.now = DUE + 10 * MINUTE;
    await manageOne(me, { operation: "disable", id });
    assert.deepEqual(historyStates(id), [`${DUE_ISO} missed`]);
  });

  for (const [what, row] of [
    ["disable", (id: string) => ({ operation: "disable", id })],
    [
      "update at the next due",
      (id: string) => ({ operation: "update", id, prompt: "Later prompt" }),
    ],
  ] as const)
    it(`an attempted claim whose key is logged ends delivered, never ended blind (${what})`, async () => {
      const me = seedSession();
      const id = await createDaily(me);
      scheduleStore.claimDue(id, DUE, { graceMs: 60 * MINUTE });
      const attempted = latest(id)!;
      assert.equal(scheduleStore.markAttempted(attempted.id, DUE), true);
      logAdmitted(me, attempted.id);
      try {
        clock.now =
          row(id).operation === "disable" ? DUE + 10 * MINUTE : DUE + DAY;
        await manageOne(me, row(id));
        const ended = scheduleStore.getOccurrence(attempted.id)!;
        assert.equal(ended.state, "delivered");
        assert.equal(ended.sessionId, me);
      } finally {
        removeLog(me);
      }
    });

  it("an attempted claim with no logged key is withdrawn as usual", async () => {
    const me = seedSession();
    const id = await createDaily(me);
    scheduleStore.claimDue(id, DUE, { graceMs: 60 * MINUTE });
    const attempted = latest(id)!;
    scheduleStore.markAttempted(attempted.id, DUE);
    clock.now = DUE + 10 * MINUTE;
    await manageOne(me, { operation: "disable", id });
    assert.equal(scheduleStore.getOccurrence(attempted.id)!.state, "withdrawn");
  });
});

describe("T6.6 the cardless limit", () => {
  it("refuses a create over the limit with the approved message", async () => {
    await useSettings({ cardlessLimit: 1 });
    const me = seedSession();
    await createDaily(me);
    assert.equal(await manageThrows(me, [{ ...dailyRow(me) }]), LIMIT(1, 1));
    // A disabled one counts too.
    await useSettings({ cardlessLimit: 2 });
    await createDaily(me, me, { enabled: false });
    assert.equal(await manageThrows(me, [dailyRow(me)]), LIMIT(2, 2));
    // Another session's Schedules do not.
    await createDaily(seedSession());
  });

  it("refuses reactivating a done Schedule over the limit; the next row still applies", async () => {
    const me = seedSession();
    const done = (
      await manageOne(me, {
        ...dailyRow(me),
        timing: { kind: "once", at: "in 45m" },
      })
    ).schedule.id;
    const due = NOV25_0800 + 45 * MINUTE;
    scheduleStore.claimDue(done, due, { graceMs: 60 * MINUTE });
    scheduleStore.settleOccurrence(latest(done)!.id, "delivered", {
      sessionId: me,
    });
    assert.ok(scheduleStore.get(done)!.doneAtMs !== undefined);
    const active = await createDaily(me);
    await useSettings({ cardlessLimit: 1 });
    clock.now = due + MINUTE;
    const results = await manage(me, [
      { operation: "update", id: done, timing: { kind: "once", at: "in 2h" } },
      { operation: "update", id: active, prompt: "Still editable" },
    ]);
    assert.deepEqual(
      results.map((r) => r.error ?? "ok"),
      [LIMIT(1, 1), "ok"],
    );
    assert.ok(scheduleStore.get(done)!.doneAtMs !== undefined);
    assert.equal(scheduleStore.get(done)!.timing.time, "08:45");
    assert.equal(scheduleStore.get(active)!.prompt, "Still editable");
  });

  it("keeps every change that adds nothing to the count usable over a lowered limit", async () => {
    const me = seedSession();
    const [a, b, c] = [
      await createDaily(me),
      await createDaily(me),
      await createDaily(me),
    ];
    await useSettings({ cardlessLimit: 1 });
    const results = await manage(me, [
      { operation: "update", id: a, prompt: "Edited" },
      { operation: "update", id: a, timing: { kind: "daily", time: "10:00" } },
      { operation: "disable", id: b },
      { operation: "enable", id: b },
      { operation: "delete", id: c },
      dailyRow(me),
    ]);
    assert.deepEqual(
      results.map((r) => r.error ?? "ok"),
      ["ok", "ok", "ok", "ok", "ok", LIMIT(2, 1)],
    );
    assert.equal(scheduleStore.get(c), undefined);
  });
});

function dailyRow(target: string) {
  return {
    operation: "create",
    name: "Another check",
    prompt: "Check the nightly build.",
    targetSessionId: target,
    timing: { kind: "daily", time: "09:00" },
  };
}
