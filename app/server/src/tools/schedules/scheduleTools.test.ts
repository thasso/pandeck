/**
 * `schedule_manage` authority and rows (T6.1–T6.4): creates for near targets
 * only, writes only by the controlling session on a still-near target, and
 * ordered independent rows.
 *   pnpm --filter @assistant/server test src/tools/schedules/scheduleTools.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import { scheduleStore } from "../../db/scheduleStore.ts";
import { sessionStore } from "../../db/sessionStore.ts";
import {
  BERLIN,
  createDaily,
  manage,
  manageOne,
  manageThrows,
  resetScheduleTools,
  seedSession,
  spawnChild,
  useSettings,
} from "../../test/scheduleToolsFixture.ts";

const NEITHER = (id: string) =>
  `Session ${id} is neither this session nor a session it spawned and still owns; ask the user to schedule into it.`;

beforeEach(() => useSettings());
afterEach(() => resetScheduleTools());

const once = (target: string, at = "in 45m") => ({
  operation: "create",
  name: "PR CI check",
  prompt: "Check CI for PR #382 in pandeck; merge if green.",
  targetSessionId: target,
  timing: { kind: "once", at },
});

describe("T6.1 create for the own session", () => {
  it("creates a cardless Schedule the caller created and controls, in the profile zone", async () => {
    const me = seedSession();
    const result = await manageOne(me, once(me));
    assert.deepEqual(result, {
      operation: "create",
      ok: true,
      schedule: {
        id: result.schedule.id,
        name: "PR CI check",
        enabled: true,
        target: { sessionId: me },
        timing: {
          kind: "once",
          date: "2026-11-25",
          time: "08:45",
          timeZone: BERLIN,
        },
        timeZone: BERLIN,
        nextOccurrences: ["Wed 25 Nov 2026 08:45 Europe/Berlin (UTC+01:00)"],
      },
    });
    const stored = scheduleStore.get(result.schedule.id)!;
    assert.equal(stored.cardless, true);
    assert.deepEqual(stored.createdBy, { kind: "session", sessionId: me });
    assert.deepEqual(stored.controlledBy, { kind: "session", sessionId: me });
    assert.equal(stored.prompt, once(me).prompt);
  });

  it("never takes authority, cardlessness or a zone from the row", async () => {
    const me = seedSession();
    const rows = [
      { ...once(me), createdBy: "user" },
      { ...once(me), controlledBy: "user" },
      { ...once(me), cardless: false },
      { ...once(me), timeZone: "UTC" },
      { ...once(me), timing: { kind: "once", at: "in 1h", timeZone: "UTC" } },
      {
        ...once(me),
        timing: { kind: "daily", time: "09:00", timeZone: "UTC" },
      },
      { ...once(me), id: "sch_1" },
    ];
    const message = await manageThrows(me, rows);
    assert.match(message, /does not take createdBy/);
    const results = await manage(me, [...rows, once(me)]);
    assert.deepEqual(
      results.map((r) => r.ok),
      [false, false, false, false, false, false, false, true],
    );
    assert.deepEqual(
      results.slice(0, 7).map((r) => r.error),
      [
        "A create operation does not take createdBy.",
        "A create operation does not take controlledBy.",
        "A create operation does not take cardless.",
        "A create operation does not take timeZone.",
        "timing does not take timeZone.",
        "timing does not take timeZone.",
        "A create operation does not take id.",
      ],
    );
    assert.equal(scheduleStore.list().length, 1);
  });

  it("keeps the prompt and name exactly as given", async () => {
    const me = seedSession();
    const prompt = "  Line one\n\n  line two  ";
    const result = await manageOne(me, {
      ...once(me),
      name: "  Spaced   name ",
      prompt,
    });
    const stored = scheduleStore.get(result.schedule.id)!;
    assert.equal(stored.prompt, prompt);
    assert.equal(stored.name, "  Spaced   name ");
  });
});

describe("T6.2 near targets on create", () => {
  it("accepts a child the caller spawned and still owns, archived too", async () => {
    const me = seedSession();
    const child = spawnChild(me);
    const archived = spawnChild(me);
    sessionStore.setArchived(archived, true);
    const results = await manage(me, [once(child), once(archived)]);
    assert.deepEqual(
      results.map((r) => [r.ok, r.schedule?.target.sessionId]),
      [
        [true, child],
        [true, archived],
      ],
    );
  });

  it("refuses a taken-over child, a grandchild and an unrelated session", async () => {
    const me = seedSession();
    const takenOver = spawnChild(me, "taken-over");
    const grandchild = spawnChild(spawnChild(me));
    const unrelated = seedSession();
    const otherParents = spawnChild(seedSession());
    const results = await manage(me, [
      once(takenOver),
      once(grandchild),
      once(unrelated),
      once(otherParents),
      once(me),
    ]);
    assert.deepEqual(
      results.map((r) => r.error ?? "ok"),
      [
        NEITHER(takenOver),
        NEITHER(grandchild),
        NEITHER(unrelated),
        NEITHER(otherParents),
        "ok",
      ],
    );
    assert.equal(scheduleStore.list().length, 1);
  });

  it("refuses a missing or deleted session", async () => {
    const me = seedSession();
    const deleted = spawnChild(me);
    sessionStore.remove(deleted);
    const results = await manage(me, [
      once("no-such-session"),
      once(deleted),
      once(me),
    ]);
    assert.deepEqual(
      results.map((r) => r.error ?? "ok"),
      [
        "Session not found: no-such-session",
        `Session not found: ${deleted}`,
        "ok",
      ],
    );
  });
});

describe("T6.3 changes only by the controller, on a still-near target", () => {
  const changes = (id: string, target: string) => [
    { operation: "update", id, prompt: "New prompt" },
    { operation: "update", id, targetSessionId: target },
    { operation: "enable", id },
    { operation: "disable", id },
    { operation: "delete", id },
  ];

  it("refuses every write to a Schedule the user or another session controls", async () => {
    const me = seedSession();
    const other = seedSession();
    const userOwned = scheduleStore.create(
      {
        name: "User's",
        prompt: "Daily summary",
        timing: { kind: "daily", time: "09:00", timeZone: BERLIN },
        target: { kind: "session", sessionId: me },
        createdBy: { kind: "user" },
      },
      Date.parse("2026-11-25T07:00:00Z"),
    );
    const othersId = await createDaily(other);
    for (const [id, owner] of [
      [userOwned.id, "the user"],
      [othersId, `session ${other}`],
    ] as const) {
      const before = scheduleStore.get(id);
      const message = await manageThrows(me, changes(id, me));
      assert.equal(
        message,
        `Schedule ${id} is controlled by ${owner}; ask the user to change it.`,
      );
      assert.deepEqual(scheduleStore.get(id), before);
    }
  });

  it("refuses every write once the stored target is no longer near", async () => {
    const me = seedSession();
    const child = spawnChild(me);
    const id = await createDaily(me, child);
    sessionStore.setSpawnedOwnership(child, "taken-over");
    const before = scheduleStore.get(id);
    for (const row of [
      ...changes(id, me),
      // Moving it back to the caller does not lift the stored target's check.
      { operation: "update", id, targetSessionId: me },
    ])
      assert.equal(await manageThrows(me, [row]), NEITHER(child));
    assert.deepEqual(scheduleStore.get(id), before);

    const gone = spawnChild(me);
    const goneId = await createDaily(me, gone);
    sessionStore.remove(gone);
    assert.equal(
      await manageThrows(me, [{ operation: "delete", id: goneId }]),
      `Session not found: ${gone}`,
    );
    assert.ok(scheduleStore.get(goneId));
  });

  it("checks a new target too, and accepts a near one", async () => {
    const me = seedSession();
    const child = spawnChild(me);
    const unrelated = seedSession();
    const id = await createDaily(me);
    const results = await manage(me, [
      { operation: "update", id, targetSessionId: unrelated },
      { operation: "update", id, targetSessionId: "missing-session" },
      { operation: "update", id, targetSessionId: child, prompt: "To child" },
    ]);
    assert.deepEqual(
      results.map((r) => r.error ?? r.schedule?.target.sessionId),
      [NEITHER(unrelated), "Session not found: missing-session", child],
    );
    assert.equal(scheduleStore.get(id)!.prompt, "To child");
    assert.deepEqual(scheduleStore.get(id)!.controlledBy, {
      kind: "session",
      sessionId: me,
    });
  });
});

describe("T6.4 independent ordered rows", () => {
  it("reports a failing row in place and writes the others", async () => {
    const me = seedSession();
    const id = await createDaily(me);
    const results = await manage(me, [
      once(me),
      { operation: "delete", id: "sch_missing" },
      { operation: "update", id, name: "Renamed" },
    ]);
    assert.deepEqual(
      results.map(({ operation, ok, id: rowId, error }) => ({
        operation,
        ok,
        ...(rowId ? { id: rowId } : {}),
        ...(error ? { error } : {}),
      })),
      [
        { operation: "create", ok: true },
        {
          operation: "delete",
          ok: false,
          id: "sch_missing",
          error: "Schedule not found: sch_missing",
        },
        { operation: "update", ok: true },
      ],
    );
    assert.equal(scheduleStore.get(id)!.name, "Renamed");
    assert.equal(scheduleStore.list().length, 2);
  });

  it("isolates malformed rows", async () => {
    const me = seedSession();
    const id = await createDaily(me);
    const results = await manage(me, [
      "not a row",
      null,
      { operation: "rename", id },
      { id },
      { operation: "disable" },
      { operation: "disable", id: 7 },
      { operation: "update", id, enabled: false },
      { operation: "create", name: "x", prompt: "y", timing: {} },
      { operation: "update", id, name: 5 },
      { operation: "update", id, timing: { kind: "hourly", time: "09:00" } },
      { operation: "update", id, timing: { kind: "once", at: "soon" } },
      { operation: "disable", id },
    ]);
    assert.deepEqual(
      results.map((r) => r.error ?? "ok"),
      [
        "An operation must be an object.",
        "An operation must be an object.",
        "operation must be create, update, enable, disable or delete.",
        "operation must be create, update, enable, disable or delete.",
        "A disable operation needs id.",
        "id must be a string.",
        "An update operation does not take enabled.",
        "A create operation needs targetSessionId.",
        "Schedule name must be a non-empty string",
        "timing.kind must be once, daily, weekdays, weekly or monthly",
        'timing.at must be a local date-time ("2026-11-25 15:45"), an ISO time with offset, or a relative time ("in 45m", "in 2h", "in 1d").',
        "ok",
      ],
    );
    assert.equal(scheduleStore.get(id)!.enabled, false);
    assert.equal(scheduleStore.get(id)!.name, "Daily check");
  });

  it("throws the first error when every row failed", async () => {
    const me = seedSession();
    assert.equal(
      await manageThrows(me, [
        { operation: "delete", id: "sch_a" },
        { operation: "delete", id: "sch_b" },
      ]),
      "Schedule not found: sch_a",
    );
  });

  it("throws for a malformed top level", async () => {
    const me = seedSession();
    const row = once(me);
    assert.equal(
      await manageThrows(me, undefined),
      "operations must be an array of operation objects.",
    );
    assert.equal(
      await manageThrows(me, "create"),
      "operations must be an array of operation objects.",
    );
    assert.equal(
      await manageThrows(me, []),
      "operations takes 1 to 20 operations; got 0.",
    );
    assert.equal(
      await manageThrows(
        me,
        Array.from({ length: 21 }, () => row),
      ),
      "operations takes 1 to 20 operations; got 21.",
    );
    assert.equal(scheduleStore.list().length, 0);
  });
});
