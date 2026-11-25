/**
 * The scheduled prompts lane (T4.13-T4.17): failures after admission and progress. Through the REAL delivery
 * scheduler, production lanes, runtime and canonical log with a faked provider
 * turn (`src/test/scheduledPromptLane.ts`); seams are labelled where used and
 * never runtime evidence (`src/test/scheduledPromptSeams.ts`).
 *   pnpm --filter @assistant/server test src/schedules/scheduledPromptsLaneFailures.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { describe, it, vi } from "vitest";
import * as hold from "../automaticTurnHold.ts";
import { setStateChangeSink } from "../db/changeSet.ts";
import { scheduleStore } from "../db/scheduleStore.ts";
import { canonicalSessionLogPath } from "../sessionStorage.ts";
import {
  afterMark,
  appendedThenRestarted,
  beforeAdmit,
  hideAttempt,
  keyed,
  owed,
  row,
} from "../test/scheduledOccurrences.ts";
import {
  D10,
  cleanups,
  fixture,
  holdTurn,
  until,
  useScheduledLaneHooks,
} from "../test/scheduledPromptLane.ts";
import { readerOverride, scripted } from "../test/scheduledPromptSeams.ts";
import {
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

describe("scheduled prompts lane: failures after admission and progress", () => {
  describe("T4.13 a failure after admission, attempt marked", () => {
    it("with no keyed entry: failed with that reason", async () => {
      const f = fixture();
      const { occurrence } = owed(f.id);
      afterMark(() => {
        Object.defineProperty(f.driver, "released", {
          value: true,
          configurable: true,
        });
      });
      await f.scheduler.wake(f.id);
      await until(() => row(occurrence.id).state === "failed");
      assert.match(row(occurrence.id).error!, /was released from memory/);
      assert.ok(row(occurrence.id).attemptedAtMs !== undefined);
      assert.deepEqual(f.driver.promptTexts, []);
    });

    it("with an unreadable log: failed with the D10 text", async () => {
      const f = fixture();
      const { occurrence } = owed(f.id);
      mkdirSync(canonicalSessionLogPath(f.id), { recursive: true });
      cleanups.push(() =>
        rmSync(canonicalSessionLogPath(f.id), { recursive: true }),
      );
      afterMark(() => {
        Object.defineProperty(f.driver, "released", {
          value: true,
          configurable: true,
        });
      });
      await f.scheduler.wake(f.id);
      await until(() => row(occurrence.id).state === "failed");
      assert.equal(row(occurrence.id).error, D10);
    });

    it("with the key present: delivered, no second append", async () => {
      const f = fixture();
      const { occurrence } = owed(f.id);
      await appendedThenRestarted(f, occurrence);
      hideAttempt(occurrence.id);
      // RECEIPT seam: a failure after admission with no append in this run.
      scripted.set(scheduledPromptKey(occurrence.id), async () => {
        throw new Error("provider failed");
      });
      await f.scheduler.wake(f.id);
      assert.equal(row(occurrence.id).state, "delivered");
      assert.equal(keyed(f.id, occurrence.id).length, 1);
      assert.equal(f.driver.promptTexts.length, 1);
    });
  });

  describe("T4.14 the append observer never throws", () => {
    it("(a) a rolled-back settle is reconciled after the receipt", async () => {
      const f = fixture();
      const { occurrence } = owed(f.id);
      const original = scheduleStore.settleOccurrence.bind(scheduleStore);
      let calls = 0;
      vi.spyOn(scheduleStore, "settleOccurrence").mockImplementation(
        (...args) => {
          calls += 1;
          if (calls === 1) throw new Error("settle rolled back");
          return original(...args);
        },
      );
      await f.scheduler.wake(f.id);
      await until(() => row(occurrence.id).state === "delivered");
      await until(() => !f.driver.isRunning);
      assert.equal(f.driver.promptTexts.length, 1, "the provider ran once");
      assert.equal(keyed(f.id, occurrence.id).length, 1);
      assert.equal(calls, 2);
      assert.equal(scheduledAppendRecordedForTests(occurrence.id), false);
      assert.deepEqual(f.errors, [], "nothing escaped");
    });

    it("(b) a post-commit hand-off throw leaves the committed delivery", async () => {
      const f = fixture();
      const { occurrence } = owed(f.id);
      let thrown = 0;
      const previous = setStateChangeSink((topic, ids) => {
        if (
          topic === "schedules" &&
          thrown === 0 &&
          scheduleStore.getOccurrence(occurrence.id)?.state === "delivered"
        ) {
          thrown += 1;
          throw new Error("hand-off failed");
        }
        previous?.(topic, ids);
      });
      cleanups.push(() => void setStateChangeSink(previous));
      await f.scheduler.wake(f.id);
      await until(
        () => !f.driver.isRunning && f.driver.promptTexts.length === 1,
      );
      await until(() => !scheduledAppendRecordedForTests(occurrence.id));
      assert.equal(thrown, 1);
      assert.equal(row(occurrence.id).state, "delivered");
      assert.equal(keyed(f.id, occurrence.id).length, 1);
      assert.deepEqual(f.errors, []);
    });

    it("with the reconcile failing too, the next pass settles it with no second append", async () => {
      const f = fixture();
      const { occurrence } = owed(f.id);
      const second = owed(f.id).occurrence;
      const original = scheduleStore.settleOccurrence.bind(scheduleStore);
      let failures = 2;
      vi.spyOn(scheduleStore, "settleOccurrence").mockImplementation(
        (id, ...rest) => {
          if (id === occurrence.id && failures > 0) {
            failures -= 1;
            throw new Error("settle rolled back");
          }
          return original(id, ...rest);
        },
      );
      const release = holdTurn(f.driver);
      await f.scheduler.wake(f.id);
      await until(() => f.driver.promptTexts.length === 1);
      release();
      await until(() => failures === 0 && !f.driver.isRunning);
      // The idle edge's pass resolves it from this process's record first,
      // then delivers the second occurrence.
      await until(() => row(second.id).state === "delivered");
      assert.equal(row(occurrence.id).state, "delivered");
      assert.equal(row(occurrence.id).sessionId, f.id);
      assert.equal(keyed(f.id, occurrence.id).length, 1);
      assert.equal(f.driver.promptTexts.length, 2);
      assert.equal(scheduledAppendRecordedForTests(occurrence.id), false);
      assert.deepEqual(f.errors, []);
    });
  });

  it("T4.15 a recovered first occurrence is settled without an append; the second follows in the same pass", async () => {
    const f = fixture();
    const first = owed(f.id).occurrence;
    await appendedThenRestarted(f, first);
    const second = owed(f.id).occurrence;
    await f.scheduler.wake(f.id);
    await until(() => row(second.id).state === "delivered");
    assert.equal(row(first.id).state, "delivered");
    assert.equal(keyed(f.id, first.id).length, 1);
    assert.equal(f.driver.promptTexts.length, 2);
  });

  it("T4.16 an unreadable first item fails with the D10 text; the second is delivered", async () => {
    const f = fixture();
    const first = owed(f.id).occurrence;
    assert.equal(scheduleStore.markAttempted(first.id), true);
    const second = owed(f.id).occurrence;
    readerOverride.set(scheduledPromptKey(first.id), "unknown");
    await f.scheduler.wake(f.id);
    await until(() => row(second.id).state === "delivered");
    assert.equal(row(first.id).state, "failed");
    assert.equal(row(first.id).error, D10);
    assert.equal(f.driver.promptTexts.length, 1);
  });

  describe("T4.17 progress without a busy loop", () => {
    it("a refusal of the first prompt fails it; the second is delivered", async () => {
      const f = fixture();
      const first = owed(f.id).occurrence;
      const second = owed(f.id).occurrence;
      beforeAdmit(f.driver, () => {
        throw new Error("first refused");
      });
      await f.scheduler.wake(f.id);
      await until(() => row(second.id).state === "delivered");
      assert.equal(row(first.id).state, "failed");
      assert.equal(row(first.id).error, "first refused");
    });

    it("two owed while Stop-held: one bounded pass, both stay claimed", async () => {
      const f = fixture();
      hold.holdAutomaticTurns(f.id);
      const a = owed(f.id).occurrence;
      const b = owed(f.id).occurrence;
      const owes = vi.spyOn(scheduleStore, "owesTarget");
      await f.scheduler.wake(f.id);
      assert.equal(owes.mock.calls.length <= 1, true);
      for (const o of [a, b]) {
        assert.equal(row(o.id).state, "claimed");
        assert.equal(row(o.id).attemptedAtMs, undefined);
      }
      assert.deepEqual(f.driver.promptTexts, []);
    });

    it("a markAttempted failure is a store failure: one try, the row stays claimed", async () => {
      const f = fixture();
      const a = owed(f.id).occurrence;
      const b = owed(f.id).occurrence;
      const mark = vi
        .spyOn(scheduleStore, "markAttempted")
        .mockImplementation(() => {
          throw new Error("mark failed");
        });
      await f.scheduler.wake(f.id);
      assert.equal(mark.mock.calls.length, 1);
      assert.equal(row(a.id).state, "claimed");
      assert.equal(row(a.id).attemptedAtMs, undefined);
      assert.equal(row(b.id).attemptedAtMs, undefined, "the walk stopped");
      assert.deepEqual(f.driver.promptTexts, []);
    });
  });
});
