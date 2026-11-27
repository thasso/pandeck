import assert from "node:assert/strict";
import type {
  ScheduleActor,
  ScheduleTiming,
  ScheduleTimingInput,
} from "@assistant/shared/schedules";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { getDb } from "../db/index.ts";
import { permanentAssistantStore } from "../db/permanentAssistantStore.ts";
import { scheduleStore } from "../db/scheduleStore.ts";
import { sessionStore } from "../db/sessionStore.ts";
import { getSettings } from "../settings.ts";
import type { saveSettings } from "../settingsService.ts";
import {
  BERLIN,
  MINUTE,
  resetScheduleTools,
  seedSession,
  useSettings,
} from "../test/scheduleToolsFixture.ts";
import {
  SCHEDULE_USER_HISTORY_LIMIT,
  deleteScheduleAsUser,
  scheduleHistoryForUser,
  setScheduleEnabledAsUser,
  setSchedulesPausedAsUser,
  updateScheduleAsUser,
} from "./scheduleUserCommands.ts";

const USER: ScheduleActor = { kind: "user" };
const NO_FUTURE = /^Error: Schedule timing has no future occurrence$/;
/** Berlin wall time on a December 2026 day (CET, UTC+01:00). */
const local = (day: number, time: string) =>
  Date.parse(`2026-12-${String(day).padStart(2, "0")}T${time}:00+01:00`);
const DAILY_0900: ScheduleTiming = {
  kind: "daily",
  time: "09:00",
  timeZone: BERLIN,
};

let agent: string;

/**
 * A session the user sees: a seeded row with a conversation. A row with none
 * is a metadata claim the session list hides, so it is no target either.
 */
function visibleSession(): string {
  const id = seedSession();
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "developer",
    messageCount: 1,
  });
  return id;
}

beforeEach(async () => {
  await useSettings();
  agent = seedSession();
});
afterEach(() => {
  vi.useRealTimers();
  resetScheduleTools();
});

/** An agent-created, agent-controlled cardless Schedule into its own session. */
function agentSchedule(
  timing: ScheduleTiming = DAILY_0900,
  nowMs = local(1, "08:00"),
  target = agent,
) {
  const self: ScheduleActor = { kind: "session", sessionId: agent };
  return scheduleStore.create(
    {
      name: "Daily check",
      prompt: "Old prompt",
      timing,
      target: { kind: "session", sessionId: target },
      createdBy: self,
      cardless: true,
    },
    nowMs,
  );
}

function snapshot(id: string) {
  return {
    revision: scheduleStore.revision(id),
    history: scheduleStore.history(id),
    row: {
      ...(getDb()
        .prepare(
          "SELECT prompt, timing_json, next_due_at_ms, controlled_by_json FROM schedules WHERE id = ?",
        )
        .get(id) as object),
    },
  };
}

describe("updateScheduleAsUser", () => {
  it("transfers control to the user and keeps the creator (AC5)", () => {
    const s = agentSchedule();
    const saved = updateScheduleAsUser(
      s.id,
      { prompt: "New prompt" },
      local(1, "08:30"),
    );
    assert.equal(saved.item.prompt, "New prompt");
    assert.deepEqual(saved.item.controlledBy, USER);
    assert.deepEqual(saved.item.createdBy, s.createdBy);
    assert.equal(saved.revision, scheduleStore.revision(s.id));
  });

  it("is cardless: no limit applies, even at 0 for a done Schedule revived", async () => {
    await useSettings({ cardlessLimit: 0 });
    const once: ScheduleTiming = {
      kind: "once",
      date: "2026-12-01",
      time: "09:00",
      timeZone: BERLIN,
    };
    const s = agentSchedule(once);
    scheduleStore.claimDue(s.id, local(1, "09:00"), { graceMs: 60 * MINUTE });
    const claimed = scheduleStore.history(s.id)[0]!;
    scheduleStore.settleOccurrence(
      claimed.id,
      "delivered",
      {},
      local(1, "09:01"),
    );
    assert.ok(scheduleStore.get(s.id)!.doneAtMs, "done");
    const saved = updateScheduleAsUser(
      s.id,
      { timing: { kind: "daily", time: "10:00" } },
      local(2, "08:00"),
    );
    assert.equal(saved.item.doneAtMs, undefined);
    assert.equal(saved.item.nextDueAtMs, local(2, "10:00"));
  });

  it("puts a supplied timing in the STORED zone, whatever the input carries", () => {
    const s = agentSchedule();
    const smuggled = {
      kind: "daily",
      time: "11:00",
      timeZone: "America/New_York",
    } as unknown as ScheduleTimingInput;
    const saved = updateScheduleAsUser(
      s.id,
      { timing: smuggled },
      local(1, "08:30"),
    );
    assert.equal(saved.item.timing.timeZone, BERLIN);
    assert.equal(saved.item.nextDueAtMs, local(1, "11:00"));
  });

  describe("refuses a timing with no future occurrence before any effect (AC6)", () => {
    const cases: Array<[string, ScheduleTimingInput]> = [
      ["a past once", { kind: "once", date: "2026-11-30", time: "09:00" }],
      [
        "a repeat whose endsOn passed",
        { kind: "daily", time: "09:00", endsOn: "2026-11-30" },
      ],
    ];
    for (const [label, timing] of cases)
      it(label, () => {
        const s = agentSchedule();
        const before = snapshot(s.id);
        assert.throws(
          () => updateScheduleAsUser(s.id, { timing }, local(1, "08:30")),
          NO_FUTURE,
        );
        assert.deepEqual(snapshot(s.id), before);
      });

    it("one equal to the stored, spent timing, with a due time inside grace", () => {
      const spent: ScheduleTiming = {
        kind: "daily",
        time: "09:00",
        timeZone: BERLIN,
        endsOn: "2026-12-01",
      };
      const s = agentSchedule(spent);
      const before = snapshot(s.id);
      // 09:10: the last due time is unticked and inside grace; a write would
      // have claimed it.
      assert.throws(
        () =>
          updateScheduleAsUser(
            s.id,
            {
              prompt: "New",
              timing: { kind: "daily", time: "09:00", endsOn: "2026-12-01" },
            },
            local(1, "09:10"),
          ),
        NO_FUTURE,
      );
      assert.deepEqual(snapshot(s.id), before);
    });
  });

  it("allows a prompt-only edit of a done Schedule whose spent timing is unchanged", () => {
    const once: ScheduleTiming = {
      kind: "once",
      date: "2026-12-01",
      time: "09:00",
      timeZone: BERLIN,
    };
    const s = agentSchedule(once);
    scheduleStore.claimDue(s.id, local(1, "09:00"), { graceMs: 60 * MINUTE });
    const claimed = scheduleStore.history(s.id)[0]!;
    scheduleStore.settleOccurrence(
      claimed.id,
      "delivered",
      {},
      local(1, "09:01"),
    );
    const saved = updateScheduleAsUser(
      s.id,
      { prompt: "Renamed task" },
      local(2, "08:00"),
    );
    assert.equal(saved.item.prompt, "Renamed task");
    assert.ok(saved.item.doneAtMs);
  });

  it("cuts over: a due time inside grace is claimed under the OLD prompt first (AC7)", () => {
    const s = agentSchedule();
    updateScheduleAsUser(s.id, { prompt: "New prompt" }, local(1, "09:10"));
    const [claimed] = scheduleStore.history(s.id);
    assert.equal(claimed?.state, "claimed");
    assert.equal(claimed?.dueAtMs, local(1, "09:00"));
    assert.equal(
      scheduleStore.getOccurrence(claimed!.id)?.prompt,
      "Old prompt",
    );
    assert.equal(scheduleStore.get(s.id)?.prompt, "New prompt");
  });

  it("refuses an unknown Schedule", () => {
    assert.throws(
      () => updateScheduleAsUser("sch_missing", { prompt: "x" }),
      /^Error: Schedule not found: sch_missing$/,
    );
  });

  describe("target scope (U4)", () => {
    it("T1 keeps an archived current target on a prompt-only edit, unchecked", () => {
      const s = agentSchedule();
      sessionStore.setArchived(agent, true);
      const saved = updateScheduleAsUser(
        s.id,
        { prompt: "New", targetSessionId: agent },
        local(1, "08:30"),
      );
      assert.equal(saved.item.target.sessionId, agent);
    });

    it("T2 accepts another archived session", () => {
      const s = agentSchedule();
      const other = visibleSession();
      sessionStore.setArchived(other, true);
      const saved = updateScheduleAsUser(
        s.id,
        { targetSessionId: other },
        local(1, "08:30"),
      );
      assert.equal(saved.item.target.sessionId, other);
    });

    it("T3 refuses a deleted session", () => {
      const s = agentSchedule();
      const gone = visibleSession();
      sessionStore.remove(gone);
      const before = snapshot(s.id);
      assert.throws(
        () =>
          updateScheduleAsUser(
            s.id,
            { targetSessionId: gone },
            local(1, "08:30"),
          ),
        new RegExp(`^Error: Session not found: ${gone}$`),
      );
      assert.deepEqual(snapshot(s.id), before);
    });

    it("T4 refuses a session hidden by scope", () => {
      const s = agentSchedule();
      const internal = `schedule-user-internal-${Date.now()}`;
      sessionStore.upsert({
        id: internal,
        harness: "pi",
        agentType: "developer",
        title: internal,
        scope: "internal",
        messageCount: 1,
      });
      try {
        assert.throws(
          () =>
            updateScheduleAsUser(
              s.id,
              { targetSessionId: internal },
              local(1, "08:30"),
            ),
          /Session not found/,
        );
      } finally {
        sessionStore.remove(internal);
      }
    });

    it("T5 refuses the Personal Assistant singleton", () => {
      const s = agentSchedule();
      const pa = visibleSession();
      const previous = permanentAssistantStore.sessionId();
      permanentAssistantStore.setSessionId(pa);
      try {
        assert.throws(
          () =>
            updateScheduleAsUser(
              s.id,
              { targetSessionId: pa },
              local(1, "08:30"),
            ),
          /^Error: The Personal Assistant can't be a Schedule target$/,
        );
      } finally {
        if (previous) permanentAssistantStore.setSessionId(previous);
        else permanentAssistantStore.clearSessionId();
      }
    });
  });
});

describe("setScheduleEnabledAsUser", () => {
  it("transfers control with the same enabled state: one write, no cutover (R1)", () => {
    const s = agentSchedule();
    const before = scheduleStore.revision(s.id)!;
    const saved = setScheduleEnabledAsUser(s.id, true, local(1, "09:10"));
    assert.deepEqual(saved.item.controlledBy, USER);
    assert.deepEqual(saved.item.createdBy, s.createdBy);
    assert.equal(saved.item.nextDueAtMs, local(1, "09:00"));
    assert.deepEqual(scheduleStore.history(s.id), []);
    assert.ok(saved.revision > before);
    assert.equal(saved.revision, scheduleStore.revision(s.id));
  });

  it("a true no-op still answers with the authoritative item and revision", () => {
    const s = agentSchedule();
    setScheduleEnabledAsUser(s.id, true, local(1, "08:10"));
    const revision = scheduleStore.revision(s.id);
    const again = setScheduleEnabledAsUser(s.id, true, local(1, "08:20"));
    assert.equal(again.revision, revision);
    assert.deepEqual(again.item, scheduleStore.get(s.id));
  });

  it("a disable inside grace leaves the claimed occurrence withdrawn (AC7)", () => {
    const s = agentSchedule();
    const saved = setScheduleEnabledAsUser(s.id, false, local(1, "09:10"));
    assert.equal(saved.item.enabled, false);
    assert.deepEqual(saved.item.controlledBy, USER);
    assert.deepEqual(
      scheduleStore.history(s.id).map((o) => o.state),
      ["withdrawn"],
    );
  });

  it("refuses an unknown Schedule", () => {
    assert.throws(
      () => setScheduleEnabledAsUser("sch_missing", false),
      /Schedule not found: sch_missing/,
    );
  });
});

describe("deleteScheduleAsUser", () => {
  it("removes only that Schedule and its history (D3)", () => {
    const doomed = agentSchedule();
    const sibling = agentSchedule();
    const grace = { graceMs: 60 * MINUTE };
    scheduleStore.claimDue(doomed.id, local(1, "09:00"), grace);
    scheduleStore.claimDue(sibling.id, local(1, "09:00"), grace);
    const siblingBefore = snapshot(sibling.id);
    deleteScheduleAsUser(doomed.id, local(1, "09:05"));
    assert.equal(scheduleStore.get(doomed.id), undefined);
    assert.deepEqual(scheduleStore.history(doomed.id), []);
    assert.deepEqual(snapshot(sibling.id), siblingBefore);
  });

  it("refuses a Schedule that is not live", () => {
    assert.throws(
      () => deleteScheduleAsUser("sch_missing"),
      /Schedule not found: sch_missing/,
    );
  });
});

describe("scheduleHistoryForUser", () => {
  it("answers the newest occurrences with the revision read in the same step", () => {
    const s = agentSchedule();
    const grace = { graceMs: 60 * MINUTE };
    for (const day of [1, 2, 3])
      scheduleStore.claimDue(s.id, local(day, "09:00"), grace);
    const answer = scheduleHistoryForUser(s.id);
    assert.ok(answer.items);
    assert.equal(answer.revision, scheduleStore.revision(s.id));
    assert.deepEqual(
      answer.items.map((o) => o.dueAtMs),
      [local(3, "09:00"), local(2, "09:00"), local(1, "09:00")],
    );
    assert.ok(answer.items.length <= SCHEDULE_USER_HISTORY_LIMIT);
  });

  it("answers items: null once the Schedule is gone", () => {
    const s = agentSchedule();
    scheduleStore.delete(s.id);
    assert.deepEqual(scheduleHistoryForUser(s.id), { items: null });
    assert.deepEqual(scheduleHistoryForUser("sch_missing"), { items: null });
  });
});

describe("setSchedulesPausedAsUser", () => {
  it("merges into the CURRENT section: a grace or limit saved meanwhile survives", async () => {
    // Another tab saved the numbers after this one last read settings.
    await useSettings({ graceWindowMinutes: 5, cardlessLimit: 3 });
    await setSchedulesPausedAsUser(true);
    assert.deepEqual(getSettings().schedules, {
      graceWindowMinutes: 5,
      cardlessLimit: 3,
      paused: true,
    });
    await setSchedulesPausedAsUser(false);
    assert.equal(getSettings().schedules.paused, false);
    assert.equal(getSettings().schedules.graceWindowMinutes, 5);
  });

  it("the store's switch settles under the current grace, and an owed occurrence stays claimed", async () => {
    await useSettings({ graceWindowMinutes: 5 });
    const owedSchedule = agentSchedule();
    const late = agentSchedule();
    const owed = scheduleStore.claimDue(owedSchedule.id, local(1, "09:00"), {
      graceMs: 60 * MINUTE,
    }).claimed!;
    vi.useFakeTimers({ toFake: ["Date"] });
    // 09:10: `late`'s 09:00 due time fell unpaused and unticked, 10 minutes
    // ago: inside the default 60-minute grace, outside the current 5.
    vi.setSystemTime(local(1, "09:10"));
    await setSchedulesPausedAsUser(true);
    assert.equal(scheduleStore.paused(), true);
    assert.deepEqual(
      scheduleStore.history(late.id).map((o) => o.state),
      ["missed"],
    );
    assert.equal(scheduleStore.getOccurrence(owed.id)?.state, "claimed");
  });

  it("starts the save in the same tick and resolves only once it completes", async () => {
    await useSettings({ graceWindowMinutes: 7 });
    let release!: () => void;
    const calls: unknown[] = [];
    const save = ((patch: unknown) => {
      calls.push(patch);
      return new Promise<void>((resolve) => (release = resolve));
    }) as unknown as typeof saveSettings;
    let done = false;
    const pending = setSchedulesPausedAsUser(true, save).then(() => {
      done = true;
    });
    assert.deepEqual(calls, [
      { schedules: { graceWindowMinutes: 7, cardlessLimit: 10, paused: true } },
    ]);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(done, false);
    release();
    await pending;
    assert.equal(done, true);
  });

  it("rejects with the save's own error", async () => {
    const save = (() =>
      Promise.reject(
        new Error("Settings saved, but the clock failed"),
      )) as unknown as typeof saveSettings;
    await assert.rejects(
      setSchedulesPausedAsUser(true, save),
      /Settings saved, but the clock failed/,
    );
  });
});
