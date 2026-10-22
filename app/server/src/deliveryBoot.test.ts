import assert from "node:assert/strict";
import { test } from "vitest";
import { createDeliveryBoot } from "./deliveryBoot.ts";
import {
  createDeliveryScheduler,
  type DeliveryLane,
  type DeliverySession,
} from "./deliveryScheduler.ts";

test("boot collection preserves real idle, Resume and reminder re-offers without enabling boot reminders", async () => {
  const delivered: string[] = [];
  const reminder: DeliveryLane<DeliverySession> = {
    name: "reminders",
    mayJoinRunningTurn: false,
    owes: () => true,
    deliver: async (session) => {
      delivered.push(session.sessionId);
      return "none";
    },
  };
  const scheduler = createDeliveryScheduler({
    lanes: [],
    reminder,
    live: (sessionId) => ({ sessionId, isRunning: false, canSteer: false }),
    acquire: async () => assert.fail("reminders must not acquire"),
    runAutoApprovals: async () => {},
    held: () => false,
    shutdown: () => false,
    reportError: (_id, _lane, error) => {
      throw error;
    },
  });
  const boot = createDeliveryBoot(scheduler);
  boot.offer("boot-only");
  for (const id of ["idle", "Resume", "reminder-reoffer"]) {
    boot.offer(id);
    boot.offer(id, true);
    boot.offer(id); // A later plain wake must not erase eligibility.
  }
  assert.equal(delivered.length, 0);
  await boot.release();
  assert.deepEqual(delivered.sort(), ["Resume", "idle", "reminder-reoffer"]);
  await boot.release();
  assert.equal(
    delivered.length,
    3,
    "release is idempotent, including error cleanup",
  );
  boot.offer("after-release", true);
  await scheduler.wake("after-release");
  assert.ok(delivered.includes("after-release"));
});
