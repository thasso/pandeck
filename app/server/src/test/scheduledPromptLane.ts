/**
 * The scheduler fixture of the scheduled prompts lane tests
 * (`src/schedules/scheduledPromptsLane*.test.ts`): the REAL delivery
 * scheduler and production lanes, the real `SessionRuntime` and canonical
 * log, with only the provider turn faked (`FakeRuntimeDriver`). Canonical
 * runtime tests, not native Claude/pi evidence. The test file must register
 * the stand-ins of `scheduledPromptSeams.ts` first.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, vi } from "vitest";
import * as hold from "../automaticTurnHold.ts";
import { BackgroundCompletionDelivery } from "../backgroundWork/completionDelivery.ts";
import { offerBackgroundCompletion } from "../backgroundCompletionNotices.ts";
import { getDb } from "../db/index.ts";
import { createDeliveryScheduler } from "../deliveryScheduler.ts";
import { setDeliveryWake } from "../deliveryWake.ts";
import * as peer from "../peerPrompt.ts";
import * as queue from "../promptQueue.ts";
import { sessionStore } from "../db/sessionStore.ts";
import { forgetScheduledAppendsForTests } from "../schedules/scheduledPrompts.ts";
import {
  setHumanPromptHook,
  setSessionIdleHook,
} from "../session/runtime/liveSession.ts";
import { promptRuntimeSession } from "../session/runtimePrompt.ts";
import { sessionDeliveryLanes } from "../sessionDeliveryLanes.ts";
// Loaded here, with the other stand-ins, so its stand-in shares this
// worker's seam state: the lane itself loads it lazily, mid-test.
import "../stateTopics.ts";
import { FakeRuntimeDriver } from "./fakeRuntimeDriver.ts";
import {
  drivers,
  fakeHub,
  published,
  readerOverride,
  scripted,
  type LaneDriver,
} from "./scheduledPromptSeams.ts";

export const D10 =
  "delivery uncertain: the target session's transcript could not be read";
export const D10A =
  "delivery failed: the target runtime returned without admitting the scheduled prompt";
export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;
export const GRACE = { graceMs: 60 * MINUTE };
/** Due times far from the real clock, so a disable or an edit settles none. */
export const DEC1 = Date.parse("2027-12-01T09:00:00Z");
export const DEC2 = DEC1 + DAY;

let nextId = 0;
const releases: Array<() => void> = [];
export const cleanups: Array<() => void | Promise<void>> = [];

export function seed(): LaneDriver {
  const id = `scheduled-lane-${nextId++}`;
  sessionStore.upsert({ id, harness: "pi", agentType: "assistant" });
  const unsupported = () => {
    throw new Error("Host commands are not used by this fixture");
  };
  const driver = Object.assign(new FakeRuntimeDriver(id), {
    kind: "assistant" as const,
    beginSyntheticTool: unsupported,
    updateSyntheticTool: unsupported,
    finishSyntheticTool: unsupported,
    discardSyntheticTool: unsupported,
    finishSyntheticCard: unsupported,
    compactContext: unsupported,
    clearContext: unsupported,
    commitWorkflowContext: unsupported,
  });
  drivers.set(id, driver);
  return driver;
}

export function holdTurn(driver: FakeRuntimeDriver): () => void {
  const release = driver.holdTurns();
  releases.push(release);
  return release;
}

export async function until(check: () => boolean, diagnostic?: () => string) {
  await vi.waitFor(() => assert.ok(check(), diagnostic?.()), {
    interval: 5,
    timeout: 2000,
  });
}

export type Lanes = ReturnType<typeof sessionDeliveryLanes>;

export function fixture(
  options: {
    driver?: LaneDriver;
    lanes?: (lanes: Lanes) => Lanes;
  } = {},
) {
  const driver = options.driver ?? seed();
  const errors: Array<{ lane: string; error: unknown }> = [];
  const background = new BackgroundCompletionDelivery({
    offer: offerBackgroundCompletion(async (id) => drivers.get(id)),
  });
  const lanes = sessionDeliveryLanes(background);
  const scheduler = createDeliveryScheduler({
    ...(options.lanes ? options.lanes(lanes) : lanes),
    runAutoApprovals: async () => {},
    live: (id) => drivers.get(id),
    acquire: async (id) => drivers.get(id),
    held: hold.automaticTurnsHeld,
    shutdown: () => false,
    reportError: (_id, lane, error) => errors.push({ lane, error }),
  });
  setDeliveryWake((id) => void scheduler.wake(id));
  queue.setPromptQueueHost({
    live: (id) => drivers.get(id),
    publish: () => {},
    reportError: (_id, error) => errors.push({ lane: "queue", error }),
    yieldToOthers: (id) => void scheduler.wake(id),
  });
  let idlePass = Promise.resolve();
  setSessionIdleHook((id) => {
    idlePass = scheduler.offerReminders(id);
  });
  hold.setAutomaticTurnHoldHost({
    changed: () => {},
    resumed: (id) => void scheduler.offerReminders(id),
  });
  peer.setPeerPromptAutoDeliverForTests(true);
  cleanups.push(async () => {
    hold.deleteAutomaticTurnHold(driver.sessionId);
    await scheduler.wake(driver.sessionId);
    await idlePass;
    background.stop();
  });
  const id = driver.sessionId;
  return {
    driver,
    id,
    scheduler,
    background,
    errors,
    /** The user's own turn, held open until the returned release runs. */
    startUser: async () => {
      const release = holdTurn(driver);
      void promptRuntimeSession(driver, "U");
      await until(() => driver.isRunning);
      return release;
    },
  };
}

/** Reset the stores, seams and hosts around every test of the file. */
export function useScheduledLaneHooks(): void {
  peer.setHubForTests(fakeHub);
  beforeEach(() => {
    getDb().exec("DELETE FROM schedule_occurrences; DELETE FROM schedules;");
    published.count = 0;
  });

  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.restoreAllMocks();
    scripted.clear();
    readerOverride.clear();
    forgetScheduledAppendsForTests();
    peer.setPeerPromptAutoDeliverForTests(false);
    setDeliveryWake(undefined);
    setSessionIdleHook(undefined);
    setHumanPromptHook(undefined);
    hold.setAutomaticTurnHoldHost(undefined);
    drivers.clear();
  });
}
