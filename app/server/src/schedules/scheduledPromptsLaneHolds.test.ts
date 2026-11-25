/**
 * The scheduled prompts lane (T4.6-T4.12): holds, refusals, restore and one turn per pass. Through the REAL delivery
 * scheduler, production lanes, runtime and canonical log with a faked provider
 * turn (`src/test/scheduledPromptLane.ts`); seams are labelled where used and
 * never runtime evidence (`src/test/scheduledPromptSeams.ts`).
 *   pnpm --filter @assistant/server test src/schedules/scheduledPromptsLaneHolds.test.ts
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, vi } from "vitest";
import * as hold from "../automaticTurnHold.ts";
import { BackgroundCompletionDelivery } from "../backgroundWork/completionDelivery.ts";
import { setStateChangeSink } from "../db/changeSet.ts";
import { getDb } from "../db/index.ts";
import { sessionStore } from "../db/sessionStore.ts";
import { createDeliveryScheduler } from "../deliveryScheduler.ts";
import { sessionDeliveryLanes } from "../sessionDeliveryLanes.ts";
import {
  afterMark,
  beforeAdmit,
  claim,
  keyed,
  owed,
  row,
} from "../test/scheduledOccurrences.ts";
import {
  DAY,
  DEC1,
  DEC2,
  cleanups,
  fixture,
  holdTurn,
  seed,
  until,
  useScheduledLaneHooks,
} from "../test/scheduledPromptLane.ts";
import { drivers, offers, published } from "../test/scheduledPromptSeams.ts";
import { scheduledPromptHeader } from "./scheduledPrompts.ts";

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

describe("scheduled prompts lane: holds, refusals, restore and one turn per pass", () => {
  it("T4.6 a pending runtime selection that cannot apply holds the occurrence; a reset delivers it", async () => {
    const profiles = await import("../credentialProfiles.ts");
    const { setAccountMoveHostForTests } =
      await import("../sessionAccountMove.ts");
    const {
      setSessionPendingRuntime,
      clearSessionPendingRuntime,
      setPendingRuntimeHostForTests,
    } = await import("../sessionPendingRuntime.ts");
    const account = (name: string) => {
      const p = profiles.createCredentialProfile({
        name,
        provider: "openai-codex",
      });
      writeFileSync(
        join(profiles.piAgentDir(p.id), "auth.json"),
        JSON.stringify({
          "openai-codex": {
            type: "oauth",
            access: "test-token",
            refresh: "test-refresh",
            expires: Date.now() + 86400_000,
          },
        }),
      );
      offers.set(p.id, { provider: "openai-codex", id: "gpt-5.5" });
      cleanups.push(() => {
        profiles.setCredentialProfileEnabled(p.id, false);
      });
      return p.id;
    };
    const a = account("Scheduled A");
    const b = account("Scheduled B");
    const f = fixture();
    sessionStore.upsert({
      id: f.id,
      harness: "pi",
      agentType: "assistant",
      credentialProfileId: a,
    });
    const switched: string[] = [];
    Object.assign(f.driver, {
      modelSelection: () => ({ model: offers.get(a)!, thinkingLevel: "off" }),
      switchAccount: async (next: string) => {
        switched.push(next);
      },
    });
    setAccountMoveHostForTests({ resident: async () => drivers.get(f.id) });
    setPendingRuntimeHostForTests({
      stateChanged: async () => {},
      publishRows: async () => {},
      wake: (sessionId) => void f.scheduler.wake(sessionId),
    });
    cleanups.push(() => {
      setAccountMoveHostForTests(undefined);
      setPendingRuntimeHostForTests(undefined);
    });
    await setSessionPendingRuntime(
      f.id,
      { account: { kind: "account", id: b } },
      "user",
    );
    profiles.setCredentialProfileEnabled(b, false);
    const { occurrence } = owed(f.id);
    await f.scheduler.wake(f.id);
    assert.deepEqual(f.driver.promptTexts, [], "nothing ran");
    assert.equal(row(occurrence.id).state, "claimed");
    assert.equal(row(occurrence.id).attemptedAtMs, undefined);
    await clearSessionPendingRuntime(f.id);
    await until(() => row(occurrence.id).state === "delivered");
    assert.equal(keyed(f.id, occurrence.id).length, 1);
    assert.deepEqual(switched, []);
  });

  it("T4.7 an acquisition failure keeps the occurrence claimed", async () => {
    const driver = seed();
    const background = new BackgroundCompletionDelivery({
      offer: async () => "busy",
    });
    const scheduler = createDeliveryScheduler({
      ...sessionDeliveryLanes(background),
      runAutoApprovals: async () => {},
      live: () => undefined,
      acquire: async () => {
        throw new Error("acquisition failed");
      },
      held: hold.automaticTurnsHeld,
      shutdown: () => false,
      reportError: () => {},
    });
    const { occurrence } = owed(driver.sessionId);
    await scheduler.wake(driver.sessionId);
    background.stop();
    assert.deepEqual(driver.promptTexts, []);
    assert.equal(row(occurrence.id).state, "claimed");
    assert.equal(row(occurrence.id).attemptedAtMs, undefined);
  });

  it("T4.8 a refusal before admission fails with its reason, clipped, and is never retried", async () => {
    const f = fixture();
    const { occurrence: short } = owed(f.id);
    beforeAdmit(f.driver, () => {
      throw new Error("model not offered");
    });
    await f.scheduler.wake(f.id);
    assert.equal(row(short.id).state, "failed");
    assert.equal(row(short.id).error, "model not offered");
    assert.equal(row(short.id).attemptedAtMs, undefined);

    const long = "x".repeat(600);
    const { occurrence: clipped } = owed(f.id);
    beforeAdmit(f.driver, () => {
      throw new Error(long);
    });
    await f.scheduler.wake(f.id);
    assert.equal(row(clipped.id).state, "failed");
    assert.equal(row(clipped.id).error, long.slice(0, 500));
    await f.scheduler.wake(f.id);
    assert.deepEqual(f.driver.promptTexts, [], "never retried");
  });

  it("T4.9 the survivor of a Stop is the newer claim, with its own due in the header", async () => {
    const f = fixture();
    hold.holdAutomaticTurns(f.id);
    const { scheduleId, occurrence: first } = owed(f.id);
    await f.scheduler.wake(f.id);
    const survivor = claim(scheduleId, DEC2);
    assert.equal(row(first.id).state, "superseded");
    hold.resumeAutomaticTurns(f.id);
    await until(() => row(survivor.id).state === "delivered");
    assert.equal(f.driver.promptTexts.length, 1);
    assert.ok(
      f.driver.promptTexts[0]!.startsWith(
        `${scheduledPromptHeader(survivor)}\n\n`,
      ),
    );
    assert.match(f.driver.promptTexts[0]!, /due Thu 2 Dec 09:00 UTC/);
  });

  it("T4.10 an archived, settled target is unarchived and unsettled in the restore's change set, then published", async () => {
    const f = fixture();
    sessionStore.setArchived(f.id, true);
    sessionStore.setSettled(f.id, true);
    const handed: Array<[string, readonly string[]]> = [];
    const previous = setStateChangeSink((topic, ids) => {
      handed.push([topic, ids]);
      previous?.(topic, ids);
    });
    cleanups.push(() => void setStateChangeSink(previous));
    let flagsAtMark: unknown;
    afterMark(() => {
      flagsAtMark = sessionStore.archiveFlags(f.id);
      handed.length = 0;
    });
    const { occurrence } = owed(f.id);
    await f.scheduler.wake(f.id);
    await until(() => row(occurrence.id).state === "delivered");
    // Still archived when the attempt was marked; the restore came after.
    assert.notEqual(
      (flagsAtMark as { archivedAtMs: number | null }).archivedAtMs,
      null,
    );
    assert.deepEqual(sessionStore.archiveFlags(f.id), {
      archivedAtMs: null,
      settledAtMs: null,
    });
    assert.ok(
      handed.some(([topic, ids]) => topic === "sessions" && ids.includes(f.id)),
    );
    await until(
      () => published.count > 0,
      () => `published ${published.count}`,
    );
  });

  it("T4.12 two owed occurrences take two turns on two idle edges, oldest first", async () => {
    const f = fixture();
    const later = owed(f.id, { prompt: "later" }).occurrence;
    const older = owed(f.id, { prompt: "older" }).occurrence;
    getDb()
      .prepare("UPDATE schedule_occurrences SET due_at_ms = ? WHERE id = ?")
      .run(DEC1 - DAY, older.id);
    const release = holdTurn(f.driver);
    await f.scheduler.wake(f.id);
    await until(() => f.driver.isRunning);
    assert.equal(f.driver.promptTexts.length, 1, "one turn per pass");
    assert.match(f.driver.promptTexts[0]!, /\n\nolder$/);
    assert.equal(row(later.id).attemptedAtMs, undefined);
    release();
    await until(() => f.driver.promptTexts.length === 2);
    assert.match(f.driver.promptTexts[1]!, /\n\nlater$/);
    await until(() => row(later.id).state === "delivered");
    assert.equal(row(older.id).state, "delivered");
  });
});
