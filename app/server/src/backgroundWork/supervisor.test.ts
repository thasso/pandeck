import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "vitest";
import type { Harness } from "@assistant/shared";
import type {
  BackgroundWorkBackendPort,
  BackgroundWorkLaunchRequest,
  BackgroundWorkStopAllRequest,
  BackgroundWorkStopRequest,
} from "./backends.ts";
import type { BackgroundWorkClock, BackgroundWorkTimer } from "./supervisor.ts";
import type { BackgroundWorkItem } from "../db/backgroundWorkStore.ts";

/** Let the Stop chain's promise hops run out before asserting on their effects. */
async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

const dataDir = mkdtempSync(join(tmpdir(), "background-supervisor-test-"));
process.env.DATA_DIR = dataDir;
process.env.ASSISTANT_CWD = dataDir;

const {
  BACKGROUND_DEPLOYMENT_STOP_REASON,
  BACKGROUND_EVENT_RATE_TERMINAL_REASON,
  BACKGROUND_STOP_ACK_DEADLINE_MS,
  BackgroundWorkSupervisor,
} = await import("./supervisor.ts");
const { backgroundCompletionDisposition } = await import("./deliveryPolicy.ts");
const { backgroundWorkStore } = await import("../db/backgroundWorkStore.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { updateSettings } = await import("../settings.ts");
const { setBackgroundWorkAdmissionsOpenForTests } =
  await import("./service.ts");

class FakeClock implements BackgroundWorkClock {
  nowMs = 1_000;
  private nextId = 0;
  private timers: Array<{
    id: number;
    at: number;
    callback: () => void;
    cancelled: boolean;
  }> = [];

  now(): number {
    return this.nowMs;
  }

  schedule(delayMs: number, callback: () => void): BackgroundWorkTimer {
    const timer = {
      id: this.nextId,
      at: this.nowMs + Math.max(0, delayMs),
      callback,
      cancelled: false,
    };
    this.nextId += 1;
    this.timers.push(timer);
    return { cancel: () => (timer.cancelled = true) };
  }

  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    for (;;) {
      const next = this.timers
        .filter((timer) => !timer.cancelled && timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      next.cancelled = true;
      this.nowMs = next.at;
      next.callback();
      await flush();
    }
    this.nowMs = target;
    await flush();
  }
}

class FakePort implements BackgroundWorkBackendPort {
  readonly backend: "host-process" | "claude-query";
  readonly launches: BackgroundWorkLaunchRequest[] = [];
  readonly stops: BackgroundWorkStopRequest[] = [];
  readonly stopAlls: BackgroundWorkStopAllRequest[] = [];
  readonly closeHosts: string[] = [];
  launchResult = { launched: true };
  stopImpl: (request: BackgroundWorkStopRequest) => Promise<{
    acknowledged: boolean;
    evidence?: string;
  }> = () => Promise.resolve({ acknowledged: true });
  stopAllImpl = () =>
    Promise.resolve({
      acknowledgedItemIds: [] as string[],
      unconfirmedItemIds: [] as string[],
    });

  constructor(backend: "host-process" | "claude-query" = "host-process") {
    this.backend = backend;
  }

  launch(request: BackgroundWorkLaunchRequest) {
    this.launches.push(request);
    return Promise.resolve(this.launchResult);
  }

  stop(request: BackgroundWorkStopRequest) {
    this.stops.push(request);
    return this.stopImpl(request);
  }

  stopAll(request: BackgroundWorkStopAllRequest) {
    this.stopAlls.push(request);
    return this.stopAllImpl();
  }

  closeHost(request: { hostEpochKey: string }) {
    this.closeHosts.push(request.hostEpochKey);
    return Promise.resolve({ closed: true });
  }
}

let serial = 0;
function owner(harness: Harness = "pi"): string {
  serial += 1;
  const id = `supervisor-owner-${serial}`;
  sessionStore.upsert({ id, scope: "user", harness, agentType: "developer" });
  return id;
}

function supervisorFor(
  clock: FakeClock,
  port: FakePort,
  options: { ordinaryTurnActive?: (ownerSessionId: string) => boolean } = {},
) {
  return new BackgroundWorkSupervisor({
    ports: [port],
    clock,
    naturalCompletionGraceMs: 100,
    ...options,
  });
}

function admitRunning(
  supervisor: InstanceType<typeof BackgroundWorkSupervisor>,
  ownerSessionId: string,
) {
  serial += 1;
  const admission = supervisor.admit({
    ownerSessionId,
    backend: "host-process",
    kind: "shell",
    label: "test command",
    sourceRequestId: `launch-${serial}`,
  });
  assert.equal(admission.admitted, true);
  if (!admission.admitted) throw new Error("admission failed");
  return supervisor.launch(admission).then((item) => {
    assert.equal(item?.state, "running");
    return item!;
  });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  setBackgroundWorkAdmissionsOpenForTests(true);
  updateSettings({
    backgroundWork: {
      enabled: true,
      ownerSessionCap: 20,
      taskLifetimeMinutes: 5,
      claudeEmptyHostGraceSeconds: 30,
    },
  });
});

test("non-terminal activity is delivered without mutating the durable row", async () => {
  const clock = new FakeClock();
  const port = new FakePort();
  const seen: string[] = [];
  const supervisor = new BackgroundWorkSupervisor({
    ports: [port],
    clock,
    activityRecorded: (item, activity) => {
      seen.push(`${item.id}:${activity.lines.join(",")}`);
    },
  });
  const item = await admitRunning(supervisor, owner());
  const before = backgroundWorkStore.getItem(item.id)!;
  supervisor.activity({
    itemId: item.id,
    lines: ["changed"],
    bytes: 7,
    droppedEventCount: 0,
    eventId: "activity-1",
  });
  assert.deepEqual(seen, [`${item.id}:changed`]);
  assert.equal(backgroundWorkStore.getItem(item.id)?.revision, before.revision);
  supervisor.completed({ itemId: item.id, state: "completed" });
  supervisor.activity({
    itemId: item.id,
    lines: ["late"],
    bytes: 4,
    droppedEventCount: 0,
    eventId: "activity-2",
  });
  assert.equal(seen.length, 1, "terminal items ignore late activity");
});

test("an exceeded activity rate Stops the item and hands the fact to delivery", async () => {
  const clock = new FakeClock();
  const port = new FakePort();
  const delivered: BackgroundWorkItem[] = [];
  const supervisor = new BackgroundWorkSupervisor({
    ports: [port],
    clock,
    completionRecorded: (item) => void delivered.push(item),
  });
  const item = await admitRunning(supervisor, owner());
  supervisor.activityRateExceeded({
    itemId: item.id,
    eventId: `${item.id}:activity-rate:21`,
    notificationCount: 21,
    windowMs: 60_000,
  });
  await settle();
  assert.deepEqual(
    port.stops.map((request) => request.target.itemId),
    [item.id],
    "the backend port did the killing",
  );
  const stopped = backgroundWorkStore.getItem(item.id);
  assert.equal(stopped?.state, "stopped");
  // Typed, so `deliveryPolicy.ts` can separate this from a stop somebody asked
  // for without reading either side's prose.
  assert.equal(stopped?.terminalReason, BACKGROUND_EVENT_RATE_TERMINAL_REASON);
  assert.match(stopped?.stopReason ?? "", /20 notifications in 60s/);

  // The row alone is NOT the fix. A targeted Stop terminalizes the row itself
  // and the backend suppresses its own `completed`, so without this seam the
  // owner is never told and the wake branch below is unreachable.
  assert.deepEqual(
    delivered.map((entry) => entry.id),
    [item.id],
    "the owner must be told about a Stop it never asked for",
  );
  // The same evidence `index.ts` builds from that row, through the real policy.
  assert.deepEqual(
    backgroundCompletionDisposition({
      backend: delivered[0]!.backend,
      stopRequested: delivered[0]!.stopState !== "none",
      stopOrigin:
        delivered[0]!.terminalReason === BACKGROUND_EVENT_RATE_TERMINAL_REASON
          ? "system"
          : "requester",
      ownerTurnRunning: true,
    }),
    { disposition: "wake", reason: "unrequested-stop" },
  );
});

test("an owner Stop stays silent, so the rate-limit notice is not a blanket one", async () => {
  const clock = new FakeClock();
  const port = new FakePort();
  const delivered: BackgroundWorkItem[] = [];
  const supervisor = new BackgroundWorkSupervisor({
    ports: [port],
    clock,
    completionRecorded: (item) => void delivered.push(item),
  });
  const item = await admitRunning(supervisor, owner());
  const result = await supervisor.stopOne({
    itemId: item.id,
    ownerSessionId: item.ownerSessionId,
    sourceRequestId: "owner-stop",
    reason: "no longer needed",
  });
  await settle();
  assert.equal(result.state, "stopped");
  // The requester is holding the terminal row this call returned.
  assert.deepEqual(delivered, []);
});

test("a terminal item ignores a late activity-rate report", async () => {
  const clock = new FakeClock();
  const port = new FakePort();
  const supervisor = new BackgroundWorkSupervisor({ ports: [port], clock });
  const item = await admitRunning(supervisor, owner());
  supervisor.completed({ itemId: item.id, state: "completed" });
  supervisor.activityRateExceeded({
    itemId: item.id,
    eventId: `${item.id}:activity-rate:21`,
    notificationCount: 21,
    windowMs: 60_000,
  });
  await Promise.resolve();
  assert.deepEqual(port.stops, []);
  assert.equal(backgroundWorkStore.getItem(item.id)?.state, "completed");
});

test("deadline Stop is reserved before the targeted side effect", async () => {
  const clock = new FakeClock();
  const port = new FakePort();
  const supervisor = supervisorFor(clock, port);
  const item = await admitRunning(supervisor, owner());
  port.stopImpl = (request) => {
    assert.equal(
      backgroundWorkStore.getItem(request.target.itemId)?.stopState,
      "requested",
    );
    return Promise.resolve({ acknowledged: true });
  };

  await clock.advance(item.deadlineAt - clock.now());
  assert.equal(port.stops.length, 1);
  assert.equal(backgroundWorkStore.getItem(item.id)?.state, "stopped");
  assert.equal(backgroundWorkStore.getItem(item.id)?.stopAttempts, 1);
});

test("an acknowledgement may arrive any time inside the ten-second deadline", async () => {
  const clock = new FakeClock();
  const port = new FakePort();
  const supervisor = supervisorFor(clock, port);
  const item = await admitRunning(supervisor, owner());
  let acknowledge!: (value: { acknowledged: true }) => void;
  port.stopImpl = () =>
    new Promise((resolve) => {
      acknowledge = resolve;
    });
  const stopping = supervisor.stopOne({
    itemId: item.id,
    ownerSessionId: item.ownerSessionId,
    sourceRequestId: "explicit-inside-window",
    reason: "owner requested Stop",
  });
  await clock.advance(BACKGROUND_STOP_ACK_DEADLINE_MS - 1);
  assert.equal(backgroundWorkStore.getItem(item.id)?.state, "running");
  acknowledge({ acknowledged: true });
  assert.equal((await stopping).state, "stopped");
  assert.equal(port.stops.length, 1);
});

test("one retry ends as visible nonterminal stop-unconfirmed", async () => {
  const clock = new FakeClock();
  const port = new FakePort();
  const supervisor = supervisorFor(clock, port);
  const item = await admitRunning(supervisor, owner());
  port.stopImpl = () => new Promise(() => {});
  const stopping = supervisor.stopOne({
    itemId: item.id,
    ownerSessionId: item.ownerSessionId,
    sourceRequestId: "unanswered",
    reason: "owner requested Stop",
  });
  await clock.advance(BACKGROUND_STOP_ACK_DEADLINE_MS);
  assert.equal(port.stops.length, 2, "exactly one automatic retry started");
  await clock.advance(BACKGROUND_STOP_ACK_DEADLINE_MS);
  assert.equal((await stopping).state, "stop-unconfirmed");
  const stored = backgroundWorkStore.getItem(item.id)!;
  assert.equal(stored.state, "running");
  assert.equal(stored.stopState, "unconfirmed");
  assert.equal(stored.stopAttempts, 2);
  assert.deepEqual(
    port.stops.map((request) => [request.sourceRequestId, request.attempt]),
    [
      ["unanswered", 1],
      ["unanswered", 2],
    ],
  );

  port.stopImpl = () => Promise.resolve({ acknowledged: true });
  const later = await supervisor.stopOne({
    itemId: item.id,
    ownerSessionId: item.ownerSessionId,
    sourceRequestId: "new-explicit-request",
    reason: "try again",
  });
  assert.equal(later.state, "stopped");
  assert.equal(port.stops.length, 3, "a new request is not the old retry");
});

test("fire-and-forget deadline and binding Stops contain missing-port failures", async () => {
  const clock = new FakeClock();
  const errors: string[] = [];
  const supervisor = new BackgroundWorkSupervisor({
    clock,
    reportError: (message) => errors.push(message),
  });
  const processOwner = owner();
  const processAdmission = supervisor.admit({
    ownerSessionId: processOwner,
    backend: "host-process",
    kind: "shell",
    label: "missing process port",
    sourceRequestId: "missing-process-port",
  });
  assert.equal(processAdmission.admitted, true);
  if (!processAdmission.admitted) return;
  backgroundWorkStore.markRunning({
    itemId: processAdmission.item.id,
    now: clock.now(),
  });
  await clock.advance(processAdmission.item.deadlineAt - clock.now());
  assert.match(errors[0] ?? "", /deadline Stop failed/);
  assert.match(errors[0] ?? "", /not registered/);

  const claudeOwner = owner("claude-sdk");
  const claudeAdmission = supervisor.admit({
    ownerSessionId: claudeOwner,
    backend: "claude-query",
    kind: "shell",
    label: "missing Claude port",
    sourceRequestId: "missing-claude-port",
    hostEpochKey: "epoch-missing-port",
  });
  assert.equal(claudeAdmission.admitted, true);
  if (!claudeAdmission.admitted) return;
  backgroundWorkStore.markRunning({
    itemId: claudeAdmission.item.id,
    now: clock.now(),
  });
  const waiting = await supervisor.stopOne({
    itemId: claudeAdmission.item.id,
    ownerSessionId: claudeOwner,
    sourceRequestId: "missing-binding-stop",
    reason: "owner requested Stop",
  });
  assert.equal(waiting.state, "awaiting-binding");
  supervisor.providerBound({
    itemId: claudeAdmission.item.id,
    providerTaskId: "provider-missing-port",
  });
  await flush();
  assert.match(errors[1] ?? "", /bound Stop failed/);
  assert.match(errors[1] ?? "", /not registered/);
  backgroundWorkStore.terminalize({
    itemId: processAdmission.item.id,
    state: "failed",
    reason: "test cleanup",
  });
  backgroundWorkStore.terminalize({
    itemId: claudeAdmission.item.id,
    state: "failed",
    reason: "test cleanup",
  });
});

test("Stop before launch prevents the backend effect", async () => {
  const clock = new FakeClock();
  const port = new FakePort();
  const supervisor = supervisorFor(clock, port);
  const ownerSessionId = owner();
  const admission = supervisor.admit({
    ownerSessionId,
    backend: "host-process",
    kind: "shell",
    label: "never starts",
    sourceRequestId: "pre-launch",
  });
  assert.equal(admission.admitted, true);
  if (!admission.admitted) return;
  const stopped = await supervisor.stopOne({
    itemId: admission.item.id,
    ownerSessionId,
    sourceRequestId: "pre-launch-stop",
    reason: "owner changed their mind",
  });
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.item.state, "not-started");
  await supervisor.launch(admission);
  assert.equal(port.launches.length, 0);
});

test("Stop awaiting a Claude binding fires when binding arrives", async () => {
  const clock = new FakeClock();
  const port = new FakePort("claude-query");
  const supervisor = supervisorFor(clock, port);
  const ownerSessionId = owner("claude-sdk");
  const admission = supervisor.admit({
    ownerSessionId,
    backend: "claude-query",
    kind: "shell",
    label: "provider task",
    sourceRequestId: "binding-race",
    hostEpochKey: "epoch-binding-race",
  });
  assert.equal(admission.admitted, true);
  if (!admission.admitted) return;
  backgroundWorkStore.markRunning({
    itemId: admission.item.id,
    now: clock.now(),
  });
  const waiting = await supervisor.stopOne({
    itemId: admission.item.id,
    ownerSessionId,
    sourceRequestId: "binding-race-stop",
    reason: "owner requested Stop",
  });
  assert.equal(waiting.state, "awaiting-binding");
  assert.equal(port.stops.length, 0);

  supervisor.providerBound({
    itemId: admission.item.id,
    providerTaskId: "task-provider-1",
  });
  await flush();
  assert.equal(port.stops.length, 1);
  assert.equal(
    backgroundWorkStore.getItem(admission.item.id)?.state,
    "stopped",
  );
});

test("Stop-all reserves every item and protects an ordinary prompted turn", async () => {
  const clock = new FakeClock();
  const port = new FakePort();
  const ownerSessionId = owner();
  let ordinaryTurnActive = true;
  const supervisor = supervisorFor(clock, port, {
    ordinaryTurnActive: (id) => id === ownerSessionId && ordinaryTurnActive,
  });
  const first = await admitRunning(supervisor, ownerSessionId);
  const second = await admitRunning(supervisor, ownerSessionId);
  port.stopAllImpl = () => {
    for (const item of [first, second])
      assert.equal(
        backgroundWorkStore.getItem(item.id)?.stopState,
        "requested",
      );
    return Promise.resolve({
      acknowledgedItemIds: [first.id, second.id],
      unconfirmedItemIds: [],
    });
  };
  const results = await supervisor.stopAllOwner({
    ownerSessionId,
    sourceRequestId: "stop-all-owner",
    reason: "stop everything",
  });
  assert.deepEqual(
    results.map((result) => result.state),
    ["stopped", "stopped"],
  );
  assert.equal(port.stopAlls[0]?.protectOrdinaryTurn, true);
  assert.equal(port.stopAlls[0]?.sourceRequestId, "stop-all-owner");
  assert.equal(port.stopAlls[0]?.attempt, 1);
  await supervisor.stopAllOwner({
    ownerSessionId,
    sourceRequestId: "stop-all-owner",
    reason: "stop everything",
  });
  assert.equal(
    port.stopAlls.length,
    1,
    "the same request has no second effect",
  );

  ordinaryTurnActive = false;
  const backgroundTurnItem = await admitRunning(supervisor, ownerSessionId);
  port.stopAllImpl = () =>
    Promise.resolve({
      acknowledgedItemIds: [backgroundTurnItem.id],
      unconfirmedItemIds: [],
    });
  await supervisor.stopAllOwner({
    ownerSessionId,
    sourceRequestId: "human-stop-all-background-turn",
    reason: "stop background turn",
  });
  assert.equal(
    port.stopAlls[1]?.protectOrdinaryTurn,
    false,
    "a background-origin turn is interruptible by human Stop-all",
  );
});

test("an owner Stop-all protects the provider/tool turn even when no ordinary turn is active", async () => {
  const clock = new FakeClock();
  const port = new FakePort("claude-query");
  const ownerSessionId = owner("claude-sdk");
  const supervisor = supervisorFor(clock, port, {
    ordinaryTurnActive: () => false,
  });
  const admission = supervisor.admit({
    ownerSessionId,
    backend: "claude-query",
    kind: "shell",
    label: "provider task",
    sourceRequestId: "owner-tool-stop-all",
    hostEpochKey: "owner-tool-epoch",
  });
  assert.equal(admission.admitted, true);
  if (!admission.admitted) return;
  await supervisor.launch(admission);

  await supervisor.stopAllOwner({
    ownerSessionId,
    callerSessionId: ownerSessionId,
    sourceRequestId: "owner-tool-stop-all-request",
    reason: "stop the rest",
  });
  assert.equal(port.stopAlls[0]?.protectOrdinaryTurn, true);
  assert.deepEqual(port.closeHosts, []);
  backgroundWorkStore.terminalize({
    itemId: admission.item.id,
    state: "stopped",
    reason: "test cleanup",
  });
});

test("completion is durable before delivery is offered", async () => {
  const clock = new FakeClock();
  const port = new FakePort();
  let deliveryOffers = 0;
  let deliveredAfterPersist = false;
  const supervisor = new BackgroundWorkSupervisor({
    ports: [port],
    clock,
    completionRecorded: (item) => {
      deliveryOffers += 1;
      deliveredAfterPersist =
        backgroundWorkStore.getItem(item.id)?.state === "completed";
    },
  });
  const item = await admitRunning(supervisor, owner());
  supervisor.completed({
    itemId: item.id,
    state: "completed",
    outcomeSummary: "tests passed",
    eventId: "completion-1",
  });
  assert.equal(deliveredAfterPersist, true);
  assert.equal(
    backgroundWorkStore.getItem(item.id)?.outcomeSummary,
    "tests passed",
  );
  supervisor.completed({
    itemId: item.id,
    state: "completed",
    outcomeSummary: "tests passed",
    eventId: "completion-1",
  });
  assert.equal(
    deliveryOffers,
    1,
    "repeated completion evidence offers no new turn",
  );
});

test("active background work does not raise the hub prompted-turn count", async () => {
  const clock = new FakeClock();
  const port = new FakePort();
  const supervisor = supervisorFor(clock, port);
  const item = await admitRunning(supervisor, owner());
  assert.equal(
    backgroundWorkStore.activityByOwner().get(item.ownerSessionId)?.activeCount,
    1,
    "the durable registry has active background execution",
  );
  const { hub } = await import("../hub.ts");
  assert.equal(
    hub.runningCount(),
    0,
    "that background execution is not a prompted runtime turn",
  );
});

test("deployment drain closes admission, waits grace, then records its distinct outcome", async () => {
  const clock = new FakeClock();
  const port = new FakePort();
  const supervisor = supervisorFor(clock, port);
  const item = await admitRunning(supervisor, owner());
  port.stopAllImpl = () =>
    Promise.resolve({
      acknowledgedItemIds: [item.id],
      unconfirmedItemIds: [],
    });
  const draining = supervisor.drain();
  const denied = supervisor.admit({
    ownerSessionId: item.ownerSessionId,
    backend: "host-process",
    kind: "shell",
    label: "too late",
    sourceRequestId: "during-drain",
  });
  assert.equal(denied.admitted, false);
  if (!denied.admitted) assert.equal(denied.reason, "draining");
  assert.equal(port.stopAlls.length, 0);
  await clock.advance(100);
  await draining;
  assert.ok(
    port.stopAlls.some(
      (request) => request.ownerSessionId === item.ownerSessionId,
    ),
  );
  assert.equal(
    backgroundWorkStore.getItem(item.id)?.terminalReason,
    BACKGROUND_DEPLOYMENT_STOP_REASON,
  );
});
