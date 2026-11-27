/**
 * The scheduled prompts lane (T4.23-T4.27, T5.6-T5.8): outcomes with no append and boot recovery. Through the REAL delivery
 * scheduler, production lanes, runtime and canonical log with a faked provider
 * turn (`src/test/scheduledPromptLane.ts`); seams are labelled where used and
 * never runtime evidence (`src/test/scheduledPromptSeams.ts`).
 *   pnpm --filter @assistant/server test src/schedules/scheduledPromptsLaneRecovery.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, it, vi } from "vitest";
import * as hold from "../automaticTurnHold.ts";
import { scheduleStore } from "../db/scheduleStore.ts";
import { SessionBusyError } from "../session/runtime/errors.ts";
import { LiveRuntimeSession } from "../session/runtime/liveSession.ts";
import { canonicalSessionLogPath } from "../sessionStorage.ts";
import {
  appendedThenRestarted,
  hideAttempt,
  keyed,
  owed,
  row,
} from "../test/scheduledOccurrences.ts";
import {
  D10,
  D10A,
  cleanups,
  fixture,
  seed,
  until,
  useScheduledLaneHooks,
} from "../test/scheduledPromptLane.ts";
import { scripted } from "../test/scheduledPromptSeams.ts";
import {
  recoverScheduledPromptsOnBoot,
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

describe("scheduled prompts lane: outcomes with no append and boot recovery", () => {
  describe("T4.23-T4.27 outcomes with no append (RECEIPT seam unless noted)", () => {
    it("T4.23 resolved without an append, key absent: failed (D10a), no hold, the next owed is delivered in the same pass", async () => {
      const f = fixture();
      const a = owed(f.id).occurrence;
      const b = owed(f.id).occurrence;
      scripted.set(scheduledPromptKey(a.id), async () => {});
      await f.scheduler.wake(f.id);
      await until(() => row(b.id).state === "delivered");
      assert.equal(row(a.id).state, "failed");
      assert.equal(row(a.id).error, D10A);
      scripted.clear();
      await f.scheduler.wake(f.id);
      assert.equal(f.driver.promptTexts.length, 1, "A is never offered again");
    });

    it("T4.24 runtime: a throw between the handled key and the append fails with that reason", async () => {
      const f = fixture();
      const a = owed(f.id).occurrence;
      const proto = LiveRuntimeSession.prototype as unknown as {
        appendUserEntry: (...args: unknown[]) => string;
      };
      vi.spyOn(proto, "appendUserEntry").mockImplementationOnce(() => {
        throw new Error("append failed");
      });
      await f.scheduler.wake(f.id);
      await until(() => row(a.id).state === "failed");
      assert.equal(row(a.id).error, "append failed");
      assert.ok(row(a.id).attemptedAtMs !== undefined);
      assert.equal(keyed(f.id, a.id).length, 0);
    });

    it("T4.24 a duplicate answer with the key absent: failed (D10a), never a hold", async () => {
      const f = fixture();
      const a = owed(f.id).occurrence;
      scripted.set(scheduledPromptKey(a.id), async (receipt) => {
        receipt.duplicate = true;
      });
      await f.scheduler.wake(f.id);
      assert.equal(row(a.id).state, "failed");
      assert.equal(row(a.id).error, D10A);
    });

    it("T4.25 a duplicate answer with the key in the log: delivered, no new append", async () => {
      const f = fixture();
      const a = owed(f.id).occurrence;
      await appendedThenRestarted(f, a);
      hideAttempt(a.id);
      scripted.set(scheduledPromptKey(a.id), async (receipt) => {
        receipt.duplicate = true;
      });
      await f.scheduler.wake(f.id);
      assert.equal(row(a.id).state, "delivered");
      assert.equal(keyed(f.id, a.id).length, 1);
      assert.equal(f.driver.promptTexts.length, 1);
    });

    for (const error of ["SessionBusyError", "AutomaticTurnsHeldError"])
      it(`T4.26 a ${error} after admission, key absent: a hold; the next idle wake delivers once`, async () => {
        const f = fixture();
        const a = owed(f.id).occurrence;
        const b = owed(f.id).occurrence;
        scripted.set(scheduledPromptKey(a.id), async () => {
          throw error === "SessionBusyError"
            ? new SessionBusyError(f.id)
            : new hold.AutomaticTurnsHeldError(f.id);
        });
        await f.scheduler.wake(f.id);
        assert.equal(row(a.id).state, "claimed");
        assert.ok(row(a.id).attemptedAtMs !== undefined);
        assert.equal(row(b.id).attemptedAtMs, undefined, "the pass ended");
        scripted.clear();
        await f.scheduler.wake(f.id);
        await until(() => row(b.id).state === "delivered");
        assert.equal(row(a.id).state, "delivered");
        assert.equal(keyed(f.id, a.id).length, 1);
        assert.equal(f.driver.promptTexts.length, 2);
      });

    it("T4.27 resolved without an append and an unreadable log: the D10 text, not D10a", async () => {
      const f = fixture();
      const a = owed(f.id).occurrence;
      mkdirSync(canonicalSessionLogPath(f.id), { recursive: true });
      cleanups.push(() =>
        rmSync(canonicalSessionLogPath(f.id), { recursive: true }),
      );
      scripted.set(scheduledPromptKey(a.id), async () => {});
      await f.scheduler.wake(f.id);
      assert.equal(row(a.id).state, "failed");
      assert.equal(row(a.id).error, D10);
    });
  });
});

describe("boot recovery", () => {
  it("T5.6 attempted with a keyed entry: delivered, no new append", async () => {
    const f = fixture();
    const { occurrence } = owed(f.id);
    await appendedThenRestarted(f, occurrence);
    const offered: string[] = [];
    recoverScheduledPromptsOnBoot((id) => offered.push(id));
    assert.equal(row(occurrence.id).state, "delivered");
    assert.equal(row(occurrence.id).sessionId, f.id);
    assert.deepEqual(offered, []);
    assert.equal(f.driver.promptTexts.length, 1);
  });

  it("T5.7 and T5.9 attempted with no key stays claimed; it and a not-attempted one are offered and delivered once", async () => {
    const f = fixture();
    const attempted = owed(f.id).occurrence;
    assert.equal(scheduleStore.markAttempted(attempted.id), true);
    const other = fixture();
    const fresh = owed(other.id).occurrence;
    const offered: string[] = [];
    recoverScheduledPromptsOnBoot((id) => offered.push(id));
    assert.equal(row(attempted.id).state, "claimed");
    assert.deepEqual(new Set(offered), new Set([f.id, other.id]));
    assert.equal(offered.length, 2);
    await f.scheduler.wake(f.id);
    await other.scheduler.wake(other.id);
    await until(
      () =>
        row(attempted.id).state === "delivered" &&
        row(fresh.id).state === "delivered",
    );
    assert.equal(keyed(f.id, attempted.id).length, 1);
    assert.equal(keyed(other.id, fresh.id).length, 1);
  });

  it("T5.8 attempted with an unreadable log or a torn keyed tail: failed with the D10 text", () => {
    const unreadable = seed();
    const torn = seed();
    const a = owed(unreadable.sessionId).occurrence;
    const b = owed(torn.sessionId).occurrence;
    for (const o of [a, b])
      assert.equal(scheduleStore.markAttempted(o.id), true);
    mkdirSync(canonicalSessionLogPath(unreadable.sessionId), {
      recursive: true,
    });
    const path = canonicalSessionLogPath(torn.sessionId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ v: 1, sessionId: torn.sessionId, createdAt: "x" })}\n{"type":"message","role":"user","seq":1,"clientRequestId":"${scheduledPromptKey(b.id)}"`,
    );
    try {
      const offered: string[] = [];
      recoverScheduledPromptsOnBoot((id) => offered.push(id));
      for (const o of [a, b]) {
        assert.equal(row(o.id).state, "failed");
        assert.equal(row(o.id).error, D10);
      }
      assert.deepEqual(offered, []);
    } finally {
      rmSync(canonicalSessionLogPath(unreadable.sessionId), {
        recursive: true,
      });
      rmSync(path);
    }
  });
});
