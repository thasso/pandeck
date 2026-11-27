/**
 * The scheduled prompts lane (T4.18-T4.22): strict restore and store ends of an attempted claim. Through the REAL delivery
 * scheduler, production lanes, runtime and canonical log with a faked provider
 * turn (`src/test/scheduledPromptLane.ts`); seams are labelled where used and
 * never runtime evidence (`src/test/scheduledPromptSeams.ts`).
 *   pnpm --filter @assistant/server test src/schedules/scheduledPromptsLaneRestore.test.ts
 */
import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { setStateChangeSink } from "../db/changeSet.ts";
import { getDb } from "../db/index.ts";
import { INITIATIVE_STORE_SQL } from "../db/initiativeStore.ts";
import { scheduleStore } from "../db/scheduleStore.ts";
import { sessionStore } from "../db/sessionStore.ts";
import {
  afterMark,
  appendedThenRestarted,
  claim,
  keyed,
  owed,
  row,
} from "../test/scheduledOccurrences.ts";
import {
  D10,
  DEC2,
  GRACE,
  cleanups,
  fixture,
  holdTurn,
  until,
  useScheduledLaneHooks,
} from "../test/scheduledPromptLane.ts";
import { published, readerOverride } from "../test/scheduledPromptSeams.ts";
import {
  recoverScheduledPromptsOnBoot,
  scheduledAppendRecordedForTests,
  scheduledPromptKey,
} from "./scheduledPrompts.ts";

vi.mock("../hub.ts", async () =>
  (await import("../test/scheduledPromptSeams.ts")).hubMock(),
);
vi.mock("../harnesses/models.ts", async (load) =>
  (await import("../test/scheduledPromptSeams.ts")).modelsMock(await load()),
);
vi.mock("../webPush.ts", async (load) =>
  (await import("../test/scheduledPromptSeams.ts")).webPushMock(await load()),
);
vi.mock("../session/runtimePrompt.ts", async (load) =>
  (await import("../test/scheduledPromptSeams.ts")).runtimePromptMock(
    await load(),
  ),
);
vi.mock("../session/log/admittedUserEntry.ts", async (load) =>
  (await import("../test/scheduledPromptSeams.ts")).readerMock(await load()),
);
vi.mock("../stateTopics.ts", async (load) =>
  (await import("../test/scheduledPromptSeams.ts")).stateTopicsMock(
    await load(),
  ),
);

useScheduledLaneHooks();

describe("scheduled prompts lane: strict restore and store ends of an attempted claim", () => {
  describe("T4.18 strict restore", () => {
    const failures = {
      update: `CREATE TEMP TRIGGER fail_restore BEFORE UPDATE OF archived_at_ms ON session_index
        BEGIN SELECT RAISE(ABORT, 'restore update failed'); END`,
      touch: `CREATE TEMP TRIGGER fail_restore BEFORE INSERT ON session_list_revisions
        BEGIN SELECT RAISE(ABORT, 'row touch failed'); END`,
    };
    for (const [kind, trigger] of Object.entries(failures))
      for (const archived of [true, false])
        it(`a ${kind} failure, ${archived ? "archived and settled" : "settled only"}: no append, failed, flags kept, the pass ends`, async () => {
          const f = fixture();
          if (archived) sessionStore.setArchived(f.id, true);
          sessionStore.setSettled(f.id, true);
          const before = sessionStore.archiveFlags(f.id);
          const a = owed(f.id).occurrence;
          const b = owed(f.id).occurrence;
          afterMark(() => getDb().exec(trigger));
          cleanups.push(() =>
            getDb().exec("DROP TRIGGER IF EXISTS temp.fail_restore"),
          );
          await f.scheduler.wake(f.id);
          getDb().exec("DROP TRIGGER IF EXISTS temp.fail_restore");
          assert.equal(row(a.id).state, "failed");
          assert.match(
            row(a.id).error!,
            kind === "update" ? /restore update failed/ : /row touch failed/,
          );
          assert.deepEqual(sessionStore.archiveFlags(f.id), before);
          assert.equal(row(b.id).attemptedAtMs, undefined, "the walk stopped");
          assert.deepEqual(f.driver.promptTexts, []);
          assert.equal(keyed(f.id, a.id).length, 0);
        });

    it("a post-commit hand-off throw: the cleared flags are verified, the prompt is appended and published", async () => {
      const f = fixture();
      sessionStore.setArchived(f.id, true);
      sessionStore.setSettled(f.id, true);
      const previous = setStateChangeSink(undefined);
      setStateChangeSink(previous);
      cleanups.push(() => void setStateChangeSink(previous));
      afterMark(() => {
        let once = true;
        setStateChangeSink((topic, ids) => {
          if (once && topic === "sessions") {
            once = false;
            setStateChangeSink(previous);
            throw new Error("sessions hand-off failed");
          }
          previous?.(topic, ids);
        });
      });
      const a = owed(f.id).occurrence;
      await f.scheduler.wake(f.id);
      await until(() => row(a.id).state === "delivered");
      assert.deepEqual(sessionStore.archiveFlags(f.id), {
        archivedAtMs: null,
        settledAtMs: null,
      });
      assert.equal(keyed(f.id, a.id).length, 1);
      await until(
        () => published.count > 0,
        () => `published ${published.count}`,
      );
    });

    it("a liveness listener failure stays best-effort: restored and delivered, the fan-out warning logged", async () => {
      const f = fixture();
      sessionStore.setArchived(f.id, true);
      const off = sessionStore.subscribeLiveness(() => {
        throw new Error("listener failed");
      });
      cleanups.push(off);
      const db = getDb();
      const prepare = db.prepare.bind(db);
      vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
        if (sql === INITIATIVE_STORE_SQL.sessionTasks)
          throw new Error("initiative read failed");
        return prepare(sql);
      });
      const warn = vi.spyOn(console, "warn");
      const a = owed(f.id).occurrence;
      await f.scheduler.wake(f.id);
      await until(() => row(a.id).state === "delivered");
      assert.equal(sessionStore.isArchived(f.id), false);
      assert.ok(
        warn.mock.calls.some((call) =>
          String(call[0]).includes("[initiatives] session fan-out failed"),
        ),
      );
    });
  });

  describe("T4.19-T4.20 a held provider while the first settle rolled back", () => {
    async function heldAfterRolledBackSettle() {
      const f = fixture();
      const { scheduleId, occurrence } = owed(f.id);
      const original = scheduleStore.settleOccurrence.bind(scheduleStore);
      const settle = vi
        .spyOn(scheduleStore, "settleOccurrence")
        .mockImplementationOnce(() => {
          throw new Error("settle rolled back");
        })
        .mockImplementation(original);
      const release = holdTurn(f.driver);
      await f.scheduler.wake(f.id);
      await until(
        () => f.driver.isRunning && f.driver.promptTexts.length === 1,
      );
      assert.equal(row(occurrence.id).state, "claimed");
      assert.ok(row(occurrence.id).attemptedAtMs !== undefined);
      return { f, scheduleId, occurrence, release, settle };
    }

    it("T4.19 a disable resolves it delivered and never stops the turn", async () => {
      const { f, scheduleId, occurrence, release, settle } =
        await heldAfterRolledBackSettle();
      scheduleStore.setEnabled(scheduleId, false, Date.now(), GRACE);
      assert.equal(row(occurrence.id).state, "delivered");
      assert.equal(row(occurrence.id).sessionId, f.id);
      assert.equal(f.driver.isRunning, true, "the turn is not stopped");
      release();
      await until(() => !f.driver.isRunning);
      await until(() => !scheduledAppendRecordedForTests(occurrence.id));
      assert.equal(keyed(f.id, occurrence.id).length, 1);
      assert.equal(settle.mock.calls.length, 1, "the reconcile wrote nothing");
      const after = scheduleStore.get(scheduleId)!;
      assert.equal(after.enabled, false);
      assert.equal(after.nextDueAtMs, undefined);
    });

    it("O6 a disable whose outer transaction rolls back keeps the claim and the local record; a later disable delivers it", async () => {
      const { f, scheduleId, occurrence, release, settle } =
        await heldAfterRolledBackSettle();
      const key = scheduledPromptKey(occurrence.id);
      // Only this process's record can say `present` now: the log is unknown.
      readerOverride.set(key, "unknown");
      assert.equal(scheduledAppendRecordedForTests(occurrence.id), true);
      // `setEnabled` ends the claim (consulting the resolver) BEFORE it writes
      // `enabled`, so this trigger aborts the whole outer transaction after
      // the resolver answered.
      getDb()
        .exec(`CREATE TEMP TRIGGER fail_disable BEFORE UPDATE OF enabled ON schedules
        BEGIN SELECT RAISE(ABORT, 'disable failed'); END`);
      cleanups.push(() =>
        getDb().exec("DROP TRIGGER IF EXISTS temp.fail_disable"),
      );
      assert.throws(
        () => scheduleStore.setEnabled(scheduleId, false, Date.now(), GRACE),
        /disable failed/,
      );
      getDb().exec("DROP TRIGGER temp.fail_disable");
      assert.equal(row(occurrence.id).state, "claimed", "rolled back");
      assert.equal(row(occurrence.id).sessionId, undefined);
      assert.equal(scheduleStore.get(scheduleId)!.enabled, true);
      assert.equal(
        scheduledAppendRecordedForTests(occurrence.id),
        true,
        "the local record survives the rollback",
      );
      assert.equal(f.driver.isRunning, true);

      scheduleStore.setEnabled(scheduleId, false, Date.now(), GRACE);
      // Delivered, not D10: the retained record answered, the log could not.
      assert.equal(row(occurrence.id).state, "delivered");
      assert.equal(row(occurrence.id).sessionId, f.id);
      assert.equal(row(occurrence.id).error, undefined);
      assert.equal(f.driver.isRunning, true, "the turn is not stopped");
      assert.equal(
        scheduledAppendRecordedForTests(occurrence.id),
        true,
        "kept until the receipt settles",
      );
      release();
      await until(() => !f.driver.isRunning);
      await until(() => !scheduledAppendRecordedForTests(occurrence.id));
      assert.equal(row(occurrence.id).state, "delivered");
      assert.equal(keyed(f.id, occurrence.id).length, 1);
      assert.equal(settle.mock.calls.length, 1, "the reconcile wrote nothing");
    });

    for (const how of ["clock claim", "edit cutover"] as const)
      it(`T4.20 a newer ${how} resolves it delivered; the next is its own turn`, async () => {
        const { f, scheduleId, occurrence, release } =
          await heldAfterRolledBackSettle();
        const newer =
          how === "clock claim"
            ? claim(scheduleId, DEC2)
            : (() => {
                scheduleStore.update(
                  scheduleId,
                  { prompt: "edited" },
                  GRACE,
                  DEC2,
                );
                return scheduleStore.owedForTarget(f.id)[0]!;
              })();
        assert.equal(row(occurrence.id).state, "delivered");
        assert.equal(row(newer.id).state, "claimed");
        release();
        await until(() => row(newer.id).state === "delivered");
        await until(() => !f.driver.isRunning);
        assert.equal(keyed(f.id, occurrence.id).length, 1);
        assert.equal(keyed(f.id, newer.id).length, 1);
        assert.equal(f.driver.promptTexts.length, 2);
      });
  });

  describe("T4.21 a restart: the canonical log decides a newer claim's end", () => {
    it("present: delivered from the log", async () => {
      const f = fixture();
      const { scheduleId, occurrence } = owed(f.id);
      await appendedThenRestarted(f, occurrence);
      const newer = claim(scheduleId, DEC2);
      assert.equal(row(occurrence.id).state, "delivered");
      assert.equal(row(occurrence.id).sessionId, f.id);
      assert.equal(row(newer.id).state, "claimed");
    });

    it("unreadable: failed with the D10 text", async () => {
      const f = fixture();
      const { scheduleId, occurrence } = owed(f.id);
      assert.equal(scheduleStore.markAttempted(occurrence.id), true);
      readerOverride.set(scheduledPromptKey(occurrence.id), "unknown");
      claim(scheduleId, DEC2);
      assert.equal(row(occurrence.id).state, "failed");
      assert.equal(row(occurrence.id).error, D10);
    });

    it("absent: superseded, then the newer one is delivered normally", async () => {
      const f = fixture();
      const { scheduleId, occurrence } = owed(f.id);
      assert.equal(scheduleStore.markAttempted(occurrence.id), true);
      const newer = claim(scheduleId, DEC2);
      assert.equal(row(occurrence.id).state, "superseded");
      await f.scheduler.wake(f.id);
      await until(() => row(newer.id).state === "delivered");
      assert.equal(keyed(f.id, occurrence.id).length, 0);
      assert.equal(keyed(f.id, newer.id).length, 1);
    });
  });

  it("T4.22 a boot-recovery settle failure, then the clock: the end resolves it delivered", async () => {
    const f = fixture();
    const { scheduleId, occurrence } = owed(f.id);
    await appendedThenRestarted(f, occurrence);
    const original = scheduleStore.settleOccurrence.bind(scheduleStore);
    vi.spyOn(scheduleStore, "settleOccurrence")
      .mockImplementationOnce(() => {
        throw new Error("recovery settle failed");
      })
      .mockImplementation(original);
    const offered: string[] = [];
    recoverScheduledPromptsOnBoot((id) => offered.push(id));
    assert.equal(row(occurrence.id).state, "claimed");
    assert.deepEqual(offered, [f.id]);
    const newer = claim(scheduleId, DEC2);
    assert.equal(row(occurrence.id).state, "delivered");
    assert.equal(row(newer.id).state, "claimed");
  });
});
