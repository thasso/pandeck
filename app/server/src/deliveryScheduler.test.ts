import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createDeliveryScheduler,
  type DeliveryLane,
  type DeliveryResult,
  type DeliverySession,
} from "./deliveryScheduler.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const calls: string[] = [];
  const errors: string[] = [];
  const sessions = new Map<string, DeliverySession>();
  const debts = new Set<string>();
  const held = new Set<string>();
  const unavailable = new Set<string>();
  const acquisitionErrors = new Map<string, Error>();
  const cold: string[] = [];
  let shutdown = false;
  const lane = (
    name: string,
    mayJoinRunningTurn = false,
  ): DeliveryLane<DeliverySession> => ({
    name,
    mayJoinRunningTurn,
    owes: (id) => {
      calls.push(`owes:${name}:${id}`);
      return debts.has(`${name}:${id}`);
    },
    deliver: async (session) => {
      calls.push(`${name}:${session.sessionId}`);
      debts.delete(`${name}:${session.sessionId}`);
      return "none";
    },
  });
  const lanes = ["handoffs", "queue", "peer FIFO", "peer notices"].map((name) =>
    lane(name),
  );
  lanes.push(lane("background", true));
  const reminder = lane("reminders");
  const scheduler = createDeliveryScheduler({
    lanes,
    reminder,
    runAutoApprovals: async (id) => {
      calls.push(`approvals:${id}`);
    },
    live: (id) => sessions.get(id),
    acquire: async (id) => {
      cold.push(id);
      const error = acquisitionErrors.get(id);
      if (error) throw error;
      if (unavailable.has(id)) return undefined;
      const session = { sessionId: id, isRunning: false, canSteer: true };
      sessions.set(id, session);
      return session;
    },
    held: (id) => held.has(id),
    shutdown: () => shutdown,
    reportError: (_id, name) => {
      errors.push(name);
    },
  });
  return {
    scheduler,
    lanes,
    reminder,
    calls,
    errors,
    sessions,
    debts,
    held,
    unavailable,
    acquisitionErrors,
    cold,
    stop: () => {
      shutdown = true;
    },
    oweAll: (id = "s") => {
      for (const l of [...lanes, reminder]) debts.add(`${l.name}:${id}`);
    },
    delivered: () => calls.filter((c) => !c.startsWith("owes:")),
  };
}

test("scheduler contract: priority, no cold acquisition without debt, and restricted reminders", async () => {
  const f = fixture();
  await f.scheduler.wake("empty");
  assert.deepEqual(f.cold, []);
  f.debts.add("reminders:cold");
  await f.scheduler.offerReminders("cold");
  assert.deepEqual(f.cold, [], "reminders do not open a harness");
  f.unavailable.add("not promptable");
  f.debts.add("queue:not promptable");
  await f.scheduler.wake("not promptable");
  assert.ok(!f.delivered().includes("queue:not promptable"));
  f.oweAll();
  await f.scheduler.wake("s");
  assert.deepEqual(f.delivered(), [
    "approvals:empty",
    "approvals:cold",
    "approvals:not promptable",
    "approvals:s",
    "handoffs:s",
    "queue:s",
    "peer FIFO:s",
    "peer notices:s",
    "background:s",
  ]);
  assert.deepEqual(f.cold, ["not promptable", "s"]);
  await f.scheduler.offerReminders("s");
  assert.equal(f.delivered().at(-1), "reminders:s");
});

test("scheduler contract: an arrival after a read point reruns from the top, without parallel admission", async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  f.debts.add("background:s");
  f.lanes[4]!.deliver = async () => {
    f.calls.push("background:s");
    f.debts.delete("background:s");
    entered.resolve();
    await release.promise;
    return "none";
  };
  const pass = f.scheduler.wake("s");
  await entered.promise;
  f.debts.add("handoffs:s");
  assert.equal(f.scheduler.wake("s"), pass);
  void f.scheduler.wake("s");
  assert.ok(!f.delivered().includes("handoffs:s"));
  release.resolve();
  await pass;
  assert.deepEqual(f.delivered(), [
    "approvals:s",
    "background:s",
    "approvals:s",
    "handoffs:s",
  ]);
});

test("scheduler contract: running sessions ask only joinable lanes, steering requires canSteer", async () => {
  const f = fixture();
  f.oweAll();
  f.sessions.set("s", { sessionId: "s", isRunning: true, canSteer: false });
  await f.scheduler.offerReminders("s");
  assert.deepEqual(f.calls, []);
  f.sessions.set("s", { sessionId: "s", isRunning: true, canSteer: true });
  f.lanes[4]!.deliver = async () => {
    f.calls.push("steer:s");
    return "steer";
  };
  const joinable = {
    ...f.lanes[4]!,
    name: "second steer",
    deliver: async (): Promise<DeliveryResult> => {
      f.calls.push("second steer:s");
      return "steer";
    },
  };
  f.lanes.push(joinable);
  await f.scheduler.wake("s");
  assert.deepEqual(f.calls, [
    "owes:background:s",
    "owes:background:s",
    "steer:s",
    "second steer:s",
  ]);
  assert.deepEqual(f.cold, []);
});

test("scheduler contract: a new turn ends the pass, a refused lane logs and skips", async () => {
  const f = fixture();
  f.oweAll();
  f.lanes[0]!.deliver = async () => {
    throw new Error("refused before append");
  };
  f.lanes[1]!.deliver = async () => {
    f.calls.push("turn:s");
    return "turn";
  };
  await f.scheduler.offerReminders("s");
  assert.deepEqual(f.errors, ["handoffs"]);
  assert.deepEqual(f.delivered(), ["approvals:s", "turn:s"]);
});

test("scheduler contract: approvals execute under Stop, released sessions and shutdown admit nothing", async () => {
  const f = fixture();
  f.oweAll();
  f.held.add("s");
  await f.scheduler.offerReminders("s");
  assert.deepEqual(f.delivered(), ["approvals:s"]);
  assert.deepEqual(f.cold, []);
  f.held.delete("s");
  f.sessions.set("s", {
    sessionId: "s",
    isRunning: false,
    canSteer: true,
    released: true,
  });
  await f.scheduler.wake("s");
  assert.deepEqual(f.delivered(), ["approvals:s", "approvals:s"]);
  f.sessions.delete("s");
  f.stop();
  await f.scheduler.wake("s");
  assert.deepEqual(f.cold, []);
});

test("scheduler contract: one failed acquisition notifies only owed lanes once, including a failing hook's siblings", async () => {
  for (const kind of ["error", "unavailable"] as const) {
    const f = fixture();
    if (kind === "error")
      f.acquisitionErrors.set("s", new Error("resume failed"));
    else f.unavailable.add("s");
    f.debts.add("handoffs:s");
    f.debts.add("background:s");
    const notified: string[] = [];
    for (const lane of [...f.lanes, f.reminder]) {
      lane.unavailable = (id, failure) => {
        notified.push(`${lane.name}:${id}:${failure.kind}`);
        if (lane.name === "handoffs") throw new Error("hook refused");
      };
    }
    await f.scheduler.wake("s");
    assert.deepEqual(f.cold, ["s"]);
    assert.deepEqual(notified, [`handoffs:s:${kind}`, `background:s:${kind}`]);
    assert.deepEqual(f.errors, ["acquire", "handoffs"]);
    assert.deepEqual(f.delivered(), ["approvals:s"]);
  }
});

test("scheduler contract: boot is ordered per session, parallel across sessions, with no reminders", async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  f.oweAll("slow");
  f.oweAll("fast");
  const handoffs = f.lanes[0]!.deliver;
  f.lanes[0]!.deliver = async (s) => {
    if (s.sessionId === "slow") {
      entered.resolve();
      await release.promise;
    }
    return handoffs(s);
  };
  const boot = f.scheduler.boot(["slow", "fast", "fast"]);
  await entered.promise;
  await f.scheduler.wake("fast");
  assert.deepEqual(
    f.delivered().filter((c) => c.endsWith(":fast")),
    [
      "approvals:fast",
      "handoffs:fast",
      "queue:fast",
      "peer FIFO:fast",
      "peer notices:fast",
      "background:fast",
      "approvals:fast",
    ],
  );
  assert.ok(!f.delivered().includes("queue:slow"));
  release.resolve();
  await boot;
  assert.ok(!f.delivered().some((c) => c.startsWith("reminders:")));
});
