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
  let settle = async (_id: string) => {};
  let approve = async (id: string) => {
    calls.push(`approvals:${id}`);
  };
  let acquire = async (id: string): Promise<DeliverySession | undefined> => {
    cold.push(id);
    const error = acquisitionErrors.get(id);
    if (error) throw error;
    if (unavailable.has(id)) return undefined;
    const session = { sessionId: id, isRunning: false, canSteer: true };
    sessions.set(id, session);
    return session;
  };
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
  const lanes = [
    "handoffs",
    "queue",
    "workflow",
    "peer FIFO",
    "peer notices",
  ].map((name) => lane(name));
  lanes.push(lane("background", true));
  const reminder = lane("reminders");
  const scheduler = createDeliveryScheduler({
    lanes,
    reminder,
    settleEarlierDeliveries: (id) => settle(id),
    runAutoApprovals: (id) => approve(id),
    live: (id) => sessions.get(id),
    acquire: (id) => acquire(id),
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
    setSettlement: (next: typeof settle) => {
      settle = next;
    },
    setAutoApprovals: (next: typeof approve) => {
      approve = next;
    },
    setAcquisition: (next: typeof acquire) => {
      acquire = next;
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
    "workflow:s",
    "peer FIFO:s",
    "peer notices:s",
    "background:s",
  ]);
  assert.deepEqual(f.cold, ["not promptable", "s"]);
  await f.scheduler.offerReminders("s");
  assert.equal(f.delivered().at(-1), "reminders:s");
});

test("scheduler contract: queued user turns precede workflow assignments, which precede peer FIFO", async () => {
  const f = fixture();
  for (const lane of f.lanes.filter((lane) =>
    ["queue", "workflow", "peer FIFO"].includes(lane.name),
  )) {
    f.debts.add(`${lane.name}:s`);
    lane.deliver = async () => {
      f.calls.push(`${lane.name}:s`);
      f.debts.delete(`${lane.name}:s`);
      return "turn";
    };
  }
  await f.scheduler.boot(["s"]);
  assert.deepEqual(f.delivered(), ["approvals:s", "queue:s"]);
  await f.scheduler.wake("s");
  assert.equal(f.delivered().at(-1), "workflow:s");
  await f.scheduler.wake("s");
  assert.equal(f.delivered().at(-1), "peer FIFO:s");
});

test("scheduler contract: after a direct send releases, queue turns precede peers and background", async () => {
  const f = fixture();
  f.sessions.set("s", { sessionId: "s", isRunning: true, canSteer: false });
  for (const name of ["queue", "peer FIFO", "background"]) {
    f.debts.add(`${name}:s`);
    const lane = f.lanes.find((lane) => lane.name === name)!;
    lane.deliver = async () => {
      f.calls.push(`${name}:s`);
      f.debts.delete(`${name}:s`);
      f.sessions.set("s", { sessionId: "s", isRunning: true, canSteer: false });
      return "turn";
    };
  }
  await f.scheduler.wake("s");
  assert.deepEqual(f.delivered(), []);
  for (const name of ["queue", "peer FIFO", "background"]) {
    f.sessions.set("s", { sessionId: "s", isRunning: false, canSteer: false });
    await f.scheduler.wake("s");
    assert.equal(f.delivered().at(-1), `${name}:s`);
    await f.scheduler.wake("s");
    assert.equal(
      f.delivered().at(-1),
      `${name}:s`,
      "no lower lane interrupts the turn",
    );
  }
  assert.equal(f.debts.size, 0);
});

test("scheduler contract: mixed held backlog stays untouched and Resume delivers each lane once", async () => {
  const f = fixture();
  f.sessions.set("s", { sessionId: "s", isRunning: false, canSteer: false });
  f.oweAll();
  const originalDebt = [...f.debts];
  f.held.add("s");
  await f.scheduler.offerReminders("s");
  assert.deepEqual([...f.debts], originalDebt);
  assert.deepEqual(f.delivered(), ["approvals:s"]);
  f.held.delete("s");
  await f.scheduler.offerReminders("s");
  await f.scheduler.wake("s");
  assert.deepEqual(
    f.delivered().filter((call) => !call.startsWith("approvals:")),
    [...f.lanes, f.reminder].map((lane) => `${lane.name}:s`),
  );
  assert.equal(f.debts.size, 0);
});

test("scheduler contract: an arrival after a read point reruns from the top, without parallel admission", async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  f.debts.add("background:s");
  f.lanes[5]!.deliver = async () => {
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

test("scheduler contract: Stop during settlement holds handoffs and queue debt until Resume", async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  f.setSettlement(async () => {
    entered.resolve();
    await release.promise;
  });
  for (const name of ["handoffs", "queue"]) {
    f.debts.add(`${name}:s`);
    const lane = f.lanes.find((lane) => lane.name === name)!;
    lane.deliver = async () => {
      f.calls.push(`${name}:s`);
      f.debts.delete(`${name}:s`);
      return "turn";
    };
  }
  const pass = f.scheduler.wake("s");
  await entered.promise;
  f.held.add("s");
  release.resolve();
  await pass;
  assert.deepEqual(f.delivered(), ["approvals:s"]);
  assert.ok(!f.calls.some((call) => call.startsWith("owes:")));
  assert.deepEqual(f.cold, []);
  assert.deepEqual([...f.debts], ["handoffs:s", "queue:s"]);
  f.held.delete("s");
  await f.scheduler.offerReminders("s");
  assert.equal(f.delivered().at(-1), "handoffs:s");
  await f.scheduler.offerReminders("s");
  assert.equal(f.delivered().at(-1), "queue:s");
});

test("scheduler contract: post-settlement shutdown, running and released state govern admission", async () => {
  for (const state of ["shutdown", "running", "released"] as const) {
    const f = fixture();
    const entered = deferred();
    const release = deferred();
    f.oweAll();
    f.setSettlement(async () => {
      entered.resolve();
      await release.promise;
    });
    const pass = f.scheduler.wake("s");
    await entered.promise;
    if (state === "shutdown") f.stop();
    else
      f.sessions.set("s", {
        sessionId: "s",
        isRunning: state === "running",
        canSteer: false,
        released: state === "released",
      });
    release.resolve();
    await pass;
    assert.deepEqual(
      f.delivered(),
      state === "released" ? ["approvals:s"] : [],
    );
    assert.deepEqual(f.cold, []);
  }
});

for (const boundary of [
  "approvals",
  "refused approvals",
  "acquire",
  "lane",
  "refused lane",
] as const) {
  for (const change of [
    "shutdown",
    "Stop",
    "released",
    "running",
    "steerable",
  ] as const) {
    test(`scheduler contract: ${change} during ${boundary} governs later admission`, async () => {
      const f = fixture();
      const session = {
        sessionId: "s",
        isRunning: false,
        canSteer: false,
        released: false,
      };
      const entered = deferred();
      const release = deferred();
      f.oweAll();
      if (boundary !== "acquire") f.sessions.set("s", session);
      const wait = async () => {
        entered.resolve();
        await release.promise;
      };
      if (boundary === "approvals" || boundary === "refused approvals")
        f.setAutoApprovals(async () => {
          await wait();
          if (boundary === "refused approvals")
            throw new Error("pre-pass refused");
        });
      else if (boundary === "acquire")
        f.setAcquisition(async () => {
          await wait();
          return session;
        });
      else
        f.lanes[0]!.deliver = async () => {
          await wait();
          if (boundary === "refused lane")
            throw new Error("refused before append");
          return "none";
        };
      const pass = f.scheduler.wake("s");
      await entered.promise;
      if (change === "shutdown") f.stop();
      else if (change === "Stop") f.held.add("s");
      else if (change === "released") session.released = true;
      else {
        session.isRunning = true;
        session.canSteer = change === "steerable";
      }
      release.resolve();
      await pass;
      assert.deepEqual(
        f.delivered().filter((call) => !call.startsWith("approvals:")),
        change === "steerable" ? ["background:s"] : [],
      );
      assert.ok(f.debts.has("queue:s"), "nonjoinable debt stays queued");
      assert.deepEqual(
        f.errors,
        boundary === "refused lane"
          ? ["handoffs"]
          : boundary === "refused approvals"
            ? ["auto-approvals"]
            : [],
      );
      if (boundary === "approvals" || boundary === "refused approvals")
        assert.deepEqual(f.cold, []);
    });
  }
}

test("scheduler contract: approvals refresh the live driver before debt and acquisition", async () => {
  const f = fixture();
  f.debts.add("queue:s");
  f.setAutoApprovals(async () => {
    f.sessions.set("s", { sessionId: "s", isRunning: false, canSteer: false });
  });
  await f.scheduler.wake("s");
  assert.deepEqual(f.cold, [], "the pre-pass already resumed the session");
  assert.deepEqual(f.delivered(), ["queue:s"]);
});

test("scheduler contract: losing steering after a steer stops later joinable lanes", async () => {
  const f = fixture();
  const session = { sessionId: "s", isRunning: true, canSteer: true };
  f.sessions.set("s", session);
  f.debts.add("background:s");
  f.lanes[5]!.deliver = async () => {
    session.canSteer = false;
    return "steer";
  };
  let laterDelivered = false;
  f.lanes.push({
    ...f.lanes[5]!,
    name: "later joinable",
    deliver: async () => {
      laterDelivered = true;
      return "steer";
    },
  });
  await f.scheduler.wake("s");
  assert.equal(laterDelivered, false, "steering is no longer possible");
});

test("scheduler contract: a reminder offer while unsteerably running does not carry into an ordinary wake", async () => {
  const f = fixture();
  const session = { sessionId: "s", isRunning: true, canSteer: false };
  f.sessions.set("s", session);
  f.debts.add("reminders:s");
  await f.scheduler.offerReminders("s");
  session.isRunning = false;
  await f.scheduler.wake("s");
  assert.ok(
    f.debts.has("reminders:s"),
    "only an eligible reminder offer admits it",
  );
  await f.scheduler.offerReminders("s");
  assert.equal(f.debts.has("reminders:s"), false);
});

test("scheduler contract: running joinable offers bypass earlier settlement", async () => {
  const f = fixture();
  f.sessions.set("s", { sessionId: "s", isRunning: true, canSteer: true });
  f.debts.add("background:s");
  f.setSettlement(async () =>
    assert.fail("a steer must not wait for its own turn"),
  );
  await f.scheduler.wake("s");
  assert.deepEqual(f.delivered(), ["background:s"]);
});

test("scheduler contract: running sessions ask only joinable lanes, steering requires canSteer", async () => {
  const f = fixture();
  f.oweAll();
  f.sessions.set("s", { sessionId: "s", isRunning: true, canSteer: false });
  await f.scheduler.offerReminders("s");
  assert.deepEqual(f.calls, []);
  f.sessions.set("s", { sessionId: "s", isRunning: true, canSteer: true });
  f.lanes[5]!.deliver = async () => {
    f.calls.push("steer:s");
    return "steer";
  };
  const joinable = {
    ...f.lanes[5]!,
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
      "workflow:fast",
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
