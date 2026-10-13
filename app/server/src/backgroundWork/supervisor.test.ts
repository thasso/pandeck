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
  BACKGROUND_DEADLINE_TERMINAL_REASON,
  BACKGROUND_DEPLOYMENT_STOP_REASON,
  BACKGROUND_EVENT_RATE_TERMINAL_REASON,
  BACKGROUND_STOP_ACK_DEADLINE_MS,
  BackgroundWorkSupervisor,
} = await import("./supervisor.ts");
const { backgroundCompletionDisposition } = await import("./deliveryPolicy.ts");
const { backgroundWorkStore, setBackgroundWorkStateChangeNotifier } =
  await import("../db/backgroundWorkStore.ts");
const { backgroundDeliveryOutboxStore } =
  await import("../db/backgroundDeliveryOutboxStore.ts");
const { getDb } = await import("../db/index.ts");
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
  assert.equal(stopped?.stopOrigin, "system");
  assert.deepEqual(receipts(item.id), [], "scoped to deadline facts");
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
      stopOrigin: delivered[0]!.stopOrigin!,
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
  assert.equal(result.item?.stopOrigin, "requester");
  // The requester is holding the terminal row this call returned.
  assert.deepEqual(delivered, []);
  assert.deepEqual(receipts(item.id), []);
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

/** A port whose targeted Stops each wait for the test to answer them. */
function manualStops(port: FakePort) {
  const answers: Array<(ack: { acknowledged: boolean }) => void> = [];
  port.stopImpl = () =>
    new Promise((resolve) => {
      answers.push(resolve);
    });
  return answers;
}

/** The owed-fact receipts the store wrote for one item. */
function receipts(itemId: string) {
  return backgroundDeliveryOutboxStore
    .list()
    .filter((row) => row.itemId === itemId)
    .map((row) => [row.revision, row.disposition, row.retained]);
}

function supervisorRecording(clock: FakeClock, port: FakePort) {
  const delivered: BackgroundWorkItem[] = [];
  const supervisor = new BackgroundWorkSupervisor({
    ports: [port],
    clock,
    completionRecorded: (item) => void delivered.push(item),
  });
  return { supervisor, delivered };
}

test("a deadline Stop records its own origin and tells the parked owner once", async () => {
  const clock = new FakeClock();
  const port = new FakePort();
  const { supervisor, delivered } = supervisorRecording(clock, port);
  const item = await admitRunning(supervisor, owner());
  // The receipt must exist by the time the terminal row is observable at all.
  const seenAtCommit: unknown[] = [];
  setBackgroundWorkStateChangeNotifier((change) => {
    const row = backgroundWorkStore.getItem(item.id);
    if (change.itemIds.includes(item.id) && row?.state === "stopped")
      seenAtCommit.push(...receipts(item.id));
  });

  // The pi backend suppresses its own `completed` once stopping, so nothing
  // but the supervisor can carry this fact.
  await clock.advance(item.deadlineAt - clock.now());
  await settle();
  setBackgroundWorkStateChangeNotifier(undefined);
  const stopped = backgroundWorkStore.getItem(item.id)!;
  assert.deepEqual(seenAtCommit, [[stopped.revision, "wake", true]]);
  assert.deepEqual(receipts(item.id), [[stopped.revision, "wake", true]]);
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.stopOrigin, "deadline");
  assert.equal(stopped.terminalReason, BACKGROUND_DEADLINE_TERMINAL_REASON);
  assert.deepEqual(
    delivered.map((entry) => [entry.id, entry.stopOrigin]),
    [[item.id, "deadline"]],
  );
  assert.deepEqual(
    backgroundCompletionDisposition({
      backend: delivered[0]!.backend,
      stopRequested: delivered[0]!.stopState !== "none",
      stopOrigin: delivered[0]!.stopOrigin!,
      ownerTurnRunning: false,
    }),
    { disposition: "wake", reason: "deadline-expired" },
  );

  // A late provider report and a second clock pass change nothing.
  supervisor.completed({ itemId: item.id, state: "stopped" });
  await clock.advance(60_000);
  assert.equal(delivered.length, 1);
  assert.equal(port.stops.length, 1, "the work is stopped, never restarted");
  assert.equal(port.launches.length, 1);
});

test("a monitor reaching its deadline is told the same way", async () => {
  const clock = new FakeClock();
  const port = new FakePort();
  const { supervisor, delivered } = supervisorRecording(clock, port);
  const ownerSessionId = owner();
  const admission = supervisor.admit({
    ownerSessionId,
    backend: "host-process",
    kind: "monitor-command",
    label: "watch the log",
    sourceRequestId: "deadline-monitor",
  });
  assert.equal(admission.admitted, true);
  if (!admission.admitted) return;
  const item = (await supervisor.launch(admission))!;
  await clock.advance(item.deadlineAt - clock.now());
  await settle();
  assert.equal(backgroundWorkStore.getItem(item.id)?.stopOrigin, "deadline");
  assert.deepEqual(
    delivered.map((entry) => entry.id),
    [item.id],
  );
});

test("when the provider reports the deadline Stop first, that report is the one notice", async () => {
  const clock = new FakeClock();
  const port = new FakePort("claude-query");
  const answers = manualStops(port);
  const { supervisor, delivered } = supervisorRecording(clock, port);
  const ownerSessionId = owner("claude-sdk");
  const admission = supervisor.admit({
    ownerSessionId,
    backend: "claude-query",
    kind: "shell",
    label: "claude test run",
    sourceRequestId: "claude-deadline",
    hostEpochKey: `epoch-${ownerSessionId}`,
  });
  assert.equal(admission.admitted, true);
  if (!admission.admitted) return;
  await supervisor.launch(admission);
  supervisor.providerBound({
    itemId: admission.item.id,
    providerTaskId: "task-deadline",
  });
  await clock.advance(admission.item.deadlineAt - clock.now());
  assert.equal(answers.length, 1, "the deadline Stop is in flight");

  // The CLI's task notification lands before the Stop acknowledgement.
  supervisor.completed({
    itemId: admission.item.id,
    state: "stopped",
    outcomeSummary: "Claude reported the task as stopped",
  });
  supervisor.completed({ itemId: admission.item.id, state: "stopped" });
  answers[0]!({ acknowledged: true });
  await settle();

  const row = backgroundWorkStore.getItem(admission.item.id)!;
  assert.equal(row.state, "stopped");
  assert.equal(row.stopOrigin, "deadline");
  assert.equal(row.terminalReason, BACKGROUND_DEADLINE_TERMINAL_REASON);
  assert.equal(delivered.length, 1, "one notice, not one per callback");
  assert.equal(delivered[0]!.stopOrigin, "deadline");
  assert.deepEqual(receipts(row.id), [[row.revision, "wake", true]]);
});

test("the Stop whose acknowledgement wins decides who stopped the work", async () => {
  for (const winner of ["deadline", "requester"] as const) {
    const clock = new FakeClock();
    const port = new FakePort();
    const answers = manualStops(port);
    const { supervisor, delivered } = supervisorRecording(clock, port);
    const item = await admitRunning(supervisor, owner());
    // Inside the manual Stop's acknowledgement window, so it is not retried.
    await clock.advance(item.deadlineAt - clock.now() - 1_000);
    const manual = supervisor.stopOne({
      itemId: item.id,
      ownerSessionId: item.ownerSessionId,
      sourceRequestId: `manual-${winner}`,
      reason: "no longer needed",
    });
    await settle();
    await clock.advance(1_000);
    assert.equal(answers.length, 2, `${winner}: both Stops reached the port`);
    // answers[0] is the manual Stop, answers[1] the deadline's.
    answers[winner === "deadline" ? 1 : 0]!({ acknowledged: true });
    await settle();
    answers[winner === "deadline" ? 0 : 1]!({ acknowledged: true });
    const manualResult = await manual;
    await settle();

    const row = backgroundWorkStore.getItem(item.id)!;
    assert.equal(row.stopOrigin, winner);
    assert.equal(
      manualResult.state,
      winner === "requester" ? "stopped" : "already-terminal",
    );
    assert.deepEqual(
      delivered.map((entry) => entry.stopOrigin),
      winner === "deadline" ? ["deadline"] : [],
      `${winner}: only a deadline win tells the owner`,
    );
    assert.deepEqual(
      receipts(item.id),
      winner === "deadline" ? [[row.revision, "wake", true]] : [],
      `${winner}: a lost race owes nothing`,
    );
  }
});

test("natural exit decides the outcome even with a deadline Stop outstanding", async () => {
  const clock = new FakeClock();
  const port = new FakePort();
  const answers = manualStops(port);
  const { supervisor, delivered } = supervisorRecording(clock, port);
  const item = await admitRunning(supervisor, owner());
  await clock.advance(item.deadlineAt - clock.now());
  supervisor.completed({ itemId: item.id, state: "completed", exitCode: 0 });
  answers[0]!({ acknowledged: true });
  await settle();
  const row = backgroundWorkStore.getItem(item.id)!;
  assert.equal(row.state, "completed");
  assert.equal(row.exitCode, 0);
  assert.equal(row.terminalReason, undefined, "not called a deadline Stop");
  assert.equal(delivered.length, 1);

  // Finished before the deadline: the timer is cancelled and no Stop is sent.
  const early = await admitRunning(supervisor, owner());
  supervisor.completed({ itemId: early.id, state: "completed", exitCode: 0 });
  await clock.advance(early.deadlineAt - clock.now());
  assert.equal(answers.length, 1);
  assert.equal(backgroundWorkStore.getItem(early.id)?.stopState, "none");
});

test("an unconfirmed deadline Stop sends nothing until the work really ends", async () => {
  const clock = new FakeClock();
  const port = new FakePort();
  port.stopImpl = () => Promise.resolve({ acknowledged: false });
  const { supervisor, delivered } = supervisorRecording(clock, port);
  const item = await admitRunning(supervisor, owner());
  await clock.advance(item.deadlineAt - clock.now());
  await settle();
  assert.equal(port.stops.length, 2, "one retry, then it stops trying");
  assert.equal(backgroundWorkStore.getItem(item.id)?.stopState, "unconfirmed");
  assert.deepEqual(delivered, []);

  supervisor.completed({ itemId: item.id, state: "stopped" });
  const row = backgroundWorkStore.getItem(item.id)!;
  assert.equal(row.stopOrigin, "deadline");
  assert.equal(row.terminalReason, BACKGROUND_DEADLINE_TERMINAL_REASON);
  assert.equal(delivered.length, 1);
  assert.equal(port.stops.length, 2, "no automatic retry");
});

test("a deadline Stop parked for its binding notifies once the binding lands", async () => {
  const clock = new FakeClock();
  const port = new FakePort("claude-query");
  const { supervisor, delivered } = supervisorRecording(clock, port);
  const ownerSessionId = owner("claude-sdk");
  const admission = supervisor.admit({
    ownerSessionId,
    backend: "claude-query",
    kind: "shell",
    label: "unbound claude run",
    sourceRequestId: "claude-unbound-deadline",
    hostEpochKey: `epoch-${ownerSessionId}`,
  });
  assert.equal(admission.admitted, true);
  if (!admission.admitted) return;
  await supervisor.launch(admission);
  await clock.advance(admission.item.deadlineAt - clock.now());
  assert.equal(
    backgroundWorkStore.getItem(admission.item.id)?.stopState,
    "awaiting-binding",
  );
  assert.deepEqual(port.stops, []);
  supervisor.providerBound({
    itemId: admission.item.id,
    providerTaskId: "task-late",
  });
  await settle();
  assert.equal(
    backgroundWorkStore.getItem(admission.item.id)?.state,
    "stopped",
  );
  assert.deepEqual(
    delivered.map((entry) => entry.stopOrigin),
    ["deadline"],
  );
});

test("a deadline Stop during deployment drain stays silent", async () => {
  const clock = new FakeClock();
  const port = new FakePort();
  const { supervisor, delivered } = supervisorRecording(clock, port);
  const item = await admitRunning(supervisor, owner());
  supervisor.closeAdmissions();
  await clock.advance(item.deadlineAt - clock.now());
  await settle();
  assert.equal(backgroundWorkStore.getItem(item.id)?.state, "stopped");
  assert.deepEqual(delivered, [], "the hub stopped delivery with admission");
  assert.deepEqual(receipts(item.id), [], "drain stays silent across restart");
  setBackgroundWorkAdmissionsOpenForTests(true);
});

test("a deadline fact owes nothing if its receipt cannot be written: the terminal transition rolls back with it", async () => {
  const clock = new FakeClock();
  const port = new FakePort();
  const errors: string[] = [];
  const delivered: BackgroundWorkItem[] = [];
  const supervisor = new BackgroundWorkSupervisor({
    ports: [port],
    clock,
    completionRecorded: (item) => void delivered.push(item),
    reportError: (message) => errors.push(message),
  });
  const item = await admitRunning(supervisor, owner());
  getDb().exec(
    `CREATE TEMP TRIGGER refuse_receipt BEFORE INSERT ON background_delivery_outbox
     BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END`,
  );
  try {
    await clock.advance(item.deadlineAt - clock.now());
    await settle();
  } finally {
    getDb().exec("DROP TRIGGER refuse_receipt");
  }
  const row = backgroundWorkStore.getItem(item.id)!;
  assert.equal(row.state, "running", "no terminal row without its receipt");
  assert.equal(row.stopOrigin, "deadline");
  assert.deepEqual(receipts(item.id), []);
  assert.deepEqual(delivered, []);
  assert.match(errors[0] ?? "", /deadline Stop failed.*outbox unavailable/);
  // The work's real end, reported later, is still owed and told once.
  supervisor.completed({ itemId: item.id, state: "stopped" });
  supervisor.completed({ itemId: item.id, state: "stopped" });
  const ended = backgroundWorkStore.getItem(item.id)!;
  assert.deepEqual(receipts(item.id), [[ended.revision, "wake", true]]);
  assert.equal(delivered.length, 1);
});

test("a host lost under a deadline Stop owes its child's fact in the same transaction", async () => {
  const clock = new FakeClock();
  const port = new FakePort("claude-query");
  manualStops(port);
  const { supervisor, delivered } = supervisorRecording(clock, port);
  const ownerSessionId = owner("claude-sdk");
  const epoch = `epoch-${ownerSessionId}`;
  const admission = supervisor.admit({
    ownerSessionId,
    backend: "claude-query",
    kind: "shell",
    label: "claude run on a dying host",
    sourceRequestId: "claude-host-lost-deadline",
    hostEpochKey: epoch,
  });
  assert.equal(admission.admitted, true);
  if (!admission.admitted) return;
  await supervisor.launch(admission);
  supervisor.providerBound({
    itemId: admission.item.id,
    providerTaskId: "task-host-lost",
  });
  await clock.advance(admission.item.deadlineAt - clock.now());
  supervisor.hostLost(ownerSessionId, epoch, "the Claude process exited");
  const row = backgroundWorkStore.getItem(admission.item.id)!;
  assert.equal(row.state, "lost");
  assert.equal(row.stopOrigin, "deadline");
  assert.deepEqual(receipts(row.id), [[row.revision, "wake", true]]);
  assert.equal(delivered.length, 1);
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

/** Admit and launch one owner task on a Claude host, for owner Stop-all. */
async function ownerHostTask(id: string) {
  const clock = new FakeClock();
  const port = new FakePort("claude-query");
  const ownerSessionId = owner("claude-sdk");
  const supervisor = supervisorFor(clock, port, {
    ordinaryTurnActive: () => true,
  });
  const admission = supervisor.admit({
    ownerSessionId,
    backend: "claude-query",
    kind: "shell",
    label: "provider task",
    sourceRequestId: `${id}-admit`,
    hostEpochKey: `${id}-epoch`,
  });
  assert.equal(admission.admitted, true);
  if (!admission.admitted) throw new Error("not admitted");
  await supervisor.launch(admission);
  supervisor.providerBound({
    itemId: admission.item.id,
    providerTaskId: `${id}-task`,
  });
  return { port, supervisor, ownerSessionId, itemId: admission.item.id };
}

test("an owner Stop-all whose Stops all landed reserves no host close", async () => {
  // Reserved anyway, the close would fire at the end of the owner's turn and
  // kill the work it started after the Stop-all.
  const { port, supervisor, ownerSessionId, itemId } = await ownerHostTask(
    "owner-settled-stop-all",
  );
  port.stopAllImpl = () =>
    Promise.resolve({ acknowledgedItemIds: [itemId], unconfirmedItemIds: [] });
  const results = await supervisor.stopAllOwner({
    ownerSessionId,
    callerSessionId: ownerSessionId,
    sourceRequestId: "owner-settled-stop-all-request",
    reason: "superseded runs",
  });
  assert.deepEqual(
    results.map((result) => result.state),
    ["stopped"],
  );
  assert.equal(
    backgroundWorkStore.hostForOwner(ownerSessionId)?.stopAllRequestedAt,
    undefined,
  );
  assert.deepEqual(port.closeHosts, []);
});

test("an owner Stop-all reserves the host close for a Stop it could not confirm", async () => {
  const { port, supervisor, ownerSessionId, itemId } = await ownerHostTask(
    "owner-unsettled-stop-all",
  );
  const results = await supervisor.stopAllOwner({
    ownerSessionId,
    callerSessionId: ownerSessionId,
    sourceRequestId: "owner-unsettled-stop-all-request",
    reason: "superseded runs",
  });
  assert.deepEqual(
    results.map((result) => result.state),
    ["stop-unconfirmed"],
  );
  assert.notEqual(
    backgroundWorkStore.hostForOwner(ownerSessionId)?.stopAllRequestedAt,
    undefined,
    "the turn boundary closes the host as the backstop",
  );
  assert.deepEqual(port.closeHosts, [], "not before the owner's turn ends");
  backgroundWorkStore.terminalize({
    itemId,
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
