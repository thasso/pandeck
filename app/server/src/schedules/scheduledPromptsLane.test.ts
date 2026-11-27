/**
 * The scheduled prompts lane (T4.1-T4.5, T4.11): delivery, ordering, the final guard and Stop. Through the REAL delivery
 * scheduler, production lanes, runtime and canonical log with a faked provider
 * turn (`src/test/scheduledPromptLane.ts`); seams are labelled where used and
 * never runtime evidence (`src/test/scheduledPromptSeams.ts`).
 *   pnpm --filter @assistant/server test src/schedules/scheduledPromptsLane.test.ts
 */
import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import * as hold from "../automaticTurnHold.ts";
import * as queue from "../promptQueue.ts";
import * as peer from "../peerPrompt.ts";
import { BackgroundCompletionDelivery } from "../backgroundWork/completionDelivery.ts";
import {
  scheduleStore,
  type ScheduleOccurrenceRecord,
} from "../db/scheduleStore.ts";
import { peerPromptStore } from "../db/peerPromptStore.ts";
import { sessionStore } from "../db/sessionStore.ts";
import { setHumanPromptHook } from "../session/runtime/liveSession.ts";
import { promptRuntimeSession } from "../session/runtimePrompt.ts";
import { sessionDeliveryLanes } from "../sessionDeliveryLanes.ts";
import {
  beforeAdmit,
  claim,
  keyed,
  owed,
  row,
  userEntries,
} from "../test/scheduledOccurrences.ts";
import {
  DEC1,
  DEC2,
  GRACE,
  fixture,
  seed,
  until,
  useScheduledLaneHooks,
} from "../test/scheduledPromptLane.ts";
import {
  scheduledAppendRecordedForTests,
  scheduledPromptHeader,
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

describe("scheduled prompts lane: delivery, ordering, the final guard and Stop", () => {
  it("T4.1 delivers one turn: header to the model, the prompt alone in the log", async () => {
    const f = fixture();
    const { scheduleId, occurrence } = owed(f.id, {
      name: "PR  CI\ncheck",
      prompt: "Check CI",
    });
    await f.scheduler.wake(f.id);
    await until(() => row(occurrence.id).state === "delivered");
    await until(() => !f.driver.isRunning);
    assert.deepEqual(f.driver.promptTexts, [
      `${scheduledPromptHeader(occurrence)}\n\nCheck CI`,
    ]);
    assert.match(
      f.driver.promptTexts[0]!,
      /^⏰ Scheduled prompt "PR CI check" · schedule `sch_\d+` · due Wed 1 Dec 09:00 UTC\n\nCheck CI$/,
    );
    const entries = userEntries(f.id);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.clientRequestId, `schedule:${occurrence.id}`);
    assert.deepEqual(entries[0]!.origin, {
      kind: "schedule",
      scheduleId,
      occurrenceId: occurrence.id,
      dueAtMs: DEC1,
    });
    assert.deepEqual(
      entries[0]!.content.map((block) => block.text),
      ["Check CI"],
    );
    assert.equal(row(occurrence.id).sessionId, f.id);
    // O6: an ordinary committed settle leaves no append record behind once
    // the receipt resolves.
    await until(() => !scheduledAppendRecordedForTests(occurrence.id));
    assert.deepEqual(f.errors, []);
  });

  describe("T4.2 ordering", () => {
    it("the lane sits after peer notices and before completions, never joining", () => {
      const background = new BackgroundCompletionDelivery({
        offer: async () => "busy",
      });
      const lanes = sessionDeliveryLanes(background);
      background.stop();
      const names = lanes.lanes.map((lane) => lane.name);
      const at = names.indexOf("scheduled prompts");
      assert.equal(names[at - 1], "peer notices");
      assert.equal(names[at + 1], "background completions");
      assert.equal(lanes.lanes[at]!.mayJoinRunningTurn, false);
      assert.deepEqual(lanes.deferOnDecline["user queue"], [
        "peer fifo",
        "peer notices",
        "scheduled prompts",
      ]);
    });

    it("peer FIFO goes first, then the scheduled prompt, then background completions", async () => {
      const f = fixture();
      const sender = seed();
      const releaseUser = await f.startUser();
      const { occurrence } = owed(f.id, { prompt: "S" });
      await f.scheduler.wake(f.id);
      assert.deepEqual(f.driver.promptTexts, ["U"], "a running S gets nothing");
      assert.equal(row(occurrence.id).attemptedAtMs, undefined);
      await peer.sendPeerPrompt({
        senderSessionId: sender.sessionId,
        targetSessionId: f.id,
        prompt: "P",
        responseRequested: false,
      });
      f.background.enqueue(f.id, {
        itemId: "ci-watch",
        revision: 1,
        label: "CI watch",
        state: "completed",
        backend: "server-task",
        stopRequested: false,
        ownerTurnRunning: true,
        humanLink: "/background-tasks",
      });
      releaseUser();
      await until(
        () => f.driver.promptTexts.length === 4,
        () => JSON.stringify(f.driver.promptTexts),
      );
      assert.match(f.driver.promptTexts[1]!, /P/);
      assert.match(f.driver.promptTexts[2]!, /\n\nS$/);
      assert.match(f.driver.promptTexts[3]!, /Background work updated/);
      // Never steered: each ran as its own turn.
      assert.ok(f.driver.promptOptions.every((o) => o?.steer !== true));
      assert.equal(row(occurrence.id).state, "delivered");
    });

    it("a user queue that declines while still owing defers scheduled prompts", async () => {
      let decline = true;
      const f = fixture({
        lanes: (lanes) => ({
          ...lanes,
          lanes: lanes.lanes.map((lane) =>
            lane.name === "user queue"
              ? {
                  ...lane,
                  deliver: (session, canAdmit) =>
                    decline
                      ? Promise.resolve("none" as const)
                      : lane.deliver(session, canAdmit),
                }
              : lane,
          ),
        }),
      });
      queue.queuePrompt(f.id, { text: "Q" });
      const { occurrence } = owed(f.id, { prompt: "S" });
      await f.scheduler.wake(f.id);
      assert.deepEqual(f.driver.promptTexts, []);
      assert.equal(row(occurrence.id).attemptedAtMs, undefined);
      decline = false;
      await f.scheduler.wake(f.id);
      await until(() => f.driver.promptTexts.length === 2);
      assert.deepEqual(f.driver.promptTexts[0], "Q");
      assert.match(f.driver.promptTexts[1]!, /\n\nS$/);
    });
  });

  describe("T4.3 final guard", () => {
    for (const end of ["supersede", "disable", "delete", "stop"] as const)
      it(`a ${end} committed between the offer and admit prevents the append`, async () => {
        const f = fixture();
        const { scheduleId, occurrence } = owed(f.id);
        let survivor: ScheduleOccurrenceRecord | undefined;
        beforeAdmit(f.driver, () => {
          if (end === "supersede") survivor = claim(scheduleId, DEC2);
          if (end === "disable")
            scheduleStore.setEnabled(scheduleId, false, Date.now(), GRACE);
          if (end === "delete") scheduleStore.delete(scheduleId);
          if (end === "stop") hold.holdAutomaticTurns(f.id);
        });
        await f.scheduler.wake(f.id);
        assert.deepEqual(f.driver.promptTexts, []);
        assert.equal(keyed(f.id, occurrence.id).length, 0);
        const after = scheduleStore.getOccurrence(occurrence.id);
        if (end === "supersede") {
          assert.equal(after?.state, "superseded");
          assert.equal(after?.attemptedAtMs, undefined);
          // The survivor is delivered as its own turn with its own header.
          await f.scheduler.wake(f.id);
          await until(() => row(survivor!.id).state === "delivered");
          assert.deepEqual(f.driver.promptTexts, [
            `${scheduledPromptHeader(survivor!)}\n\n${survivor!.prompt}`,
          ]);
        }
        if (end === "disable") assert.equal(after?.state, "withdrawn");
        if (end === "delete") assert.equal(after, undefined);
        if (end === "stop") {
          assert.equal(after?.state, "claimed");
          assert.equal(after?.attemptedAtMs, undefined);
          assert.deepEqual(f.driver.promptTexts, []);
        }
      });
  });

  it("T4.4 a running turn holds: no attempt recorded", async () => {
    const f = fixture();
    const releaseUser = await f.startUser();
    const { occurrence } = owed(f.id);
    await f.scheduler.wake(f.id);
    assert.equal(row(occurrence.id).state, "claimed");
    assert.equal(row(occurrence.id).attemptedAtMs, undefined);
    releaseUser();
    await until(() => row(occurrence.id).state === "delivered");
  });

  it("T4.5 and T4.11 Stop holds, never lifts and never counts as a human prompt; Resume delivers", async () => {
    const f = fixture();
    const human: string[] = [];
    setHumanPromptHook((id) => human.push(id));
    hold.holdAutomaticTurns(f.id);
    sessionStore.setArchived(f.id, true);
    sessionStore.setSettled(f.id, true);
    const { occurrence } = owed(f.id);
    await f.scheduler.wake(f.id);
    assert.deepEqual(f.driver.promptTexts, []);
    assert.equal(row(occurrence.id).state, "claimed");
    assert.equal(row(occurrence.id).attemptedAtMs, undefined);
    assert.equal(hold.automaticTurnsHeld(f.id), true, "a held S stays held");
    // T4.10: a Stop-held archived target stays archived and settled.
    assert.equal(sessionStore.isArchived(f.id), true);
    assert.equal(sessionStore.isSettled(f.id), true);
    hold.resumeAutomaticTurns(f.id);
    await until(() => row(occurrence.id).state === "delivered");
    assert.deepEqual(human, [], "the human-prompt hook never runs");
    assert.equal(keyed(f.id, occurrence.id).length, 1);
  });

  it("T4.11 an open peer chain with spent hops survives a Stop-held and a resumed scheduled prompt; a human prompt closes it", async () => {
    const f = fixture();
    const peerSession = seed();
    // The production hook, observed: every human prompt closes its chains.
    const human: string[] = [];
    setHumanPromptHook((id) => {
      human.push(id);
      peer.closeChainsForHumanPrompt(id);
    });
    const chainId = peerPromptStore.createChain();
    assert.equal(peerPromptStore.reserveHop(chainId), 1);
    assert.equal(peerPromptStore.reserveHop(chainId), 2);
    peerPromptStore.addParticipant(chainId, peerSession.sessionId);
    peerPromptStore.addParticipant(chainId, f.id);
    const chain = () => ({
      state: peerPromptStore.getChain(chainId),
      participants: [...peerPromptStore.participantsOf(chainId)].sort(),
      ofTarget: peerPromptStore.chainsForSession(f.id),
    });
    const before = chain();
    assert.equal(before.state?.nextHop, 3);
    assert.equal(before.state?.closed, false);
    assert.deepEqual(before.ofTarget, [chainId]);

    hold.holdAutomaticTurns(f.id);
    const { occurrence } = owed(f.id);
    await f.scheduler.wake(f.id);
    assert.equal(row(occurrence.id).state, "claimed");
    assert.equal(hold.automaticTurnsHeld(f.id), true, "Stop is not lifted");
    assert.deepEqual(
      chain(),
      before,
      "a held scheduled prompt changes nothing",
    );

    hold.resumeAutomaticTurns(f.id);
    await until(() => row(occurrence.id).state === "delivered");
    await until(() => !f.driver.isRunning);
    assert.equal(keyed(f.id, occurrence.id).length, 1);
    assert.deepEqual(human, [], "a scheduled prompt is not a human prompt");
    assert.deepEqual(chain(), before, "the chain, its hops and members stay");

    // Positive control: the same hook does close the chain for a human turn.
    await promptRuntimeSession(f.driver, "A human prompt");
    await until(() => !f.driver.isRunning);
    assert.deepEqual(human, [f.id]);
    const after = chain();
    assert.equal(after.state?.closed, true);
    assert.equal(after.state?.nextHop, 3, "closing spends no hop");
    assert.deepEqual(after.participants, before.participants);
  });
});
