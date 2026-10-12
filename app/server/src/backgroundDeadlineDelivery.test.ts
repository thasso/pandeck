/**
 * A frozen-deadline Stop reaches its owner through the real chain: the
 * supervisor's own Stop, the `completionRecorded` handler `index.ts` installs,
 * the delivery policy, the outbox and the Stop hold. Only the backend port, the
 * clock and the turn itself (`offer`) are fakes.
 *   pnpm --filter @assistant/server test src/backgroundDeadlineDelivery.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "vitest";
import type {
  BackgroundWorkBackendPort,
  BackgroundWorkStopRequest,
} from "./backgroundWork/backends.ts";
import type {
  BackgroundWorkClock,
  BackgroundWorkTimer,
} from "./backgroundWork/supervisor.ts";
import type { BackgroundCompletionOffer } from "./backgroundWork/completionDelivery.ts";

const dataDir = mkdtempSync(join(tmpdir(), "background-deadline-delivery-"));
process.env.DATA_DIR = dataDir;
process.env.ASSISTANT_CWD = dataDir;

const { BackgroundWorkSupervisor } =
  await import("./backgroundWork/supervisor.ts");
const { BackgroundCompletionDelivery } =
  await import("./backgroundWork/completionDelivery.ts");
const notices = await import("./backgroundCompletionNotices.ts");
const hold = await import("./automaticTurnHold.ts");
const { backgroundDeliveryOutboxStore } =
  await import("./db/backgroundDeliveryOutboxStore.ts");
const { backgroundWorkStore } = await import("./db/backgroundWorkStore.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { updateSettings } = await import("./settings.ts");
const { setBackgroundWorkAdmissionsOpenForTests } =
  await import("./backgroundWork/service.ts");

assert.ok(
  backgroundWorkStore && dataDir.startsWith(tmpdir()),
  "this suite writes only to its own temporary data directory",
);

class FakeClock implements BackgroundWorkClock {
  nowMs = 1_000;
  private timers: Array<{ at: number; callback: () => void; off: boolean }> =
    [];

  now(): number {
    return this.nowMs;
  }

  schedule(delayMs: number, callback: () => void): BackgroundWorkTimer {
    const timer = {
      at: this.nowMs + Math.max(0, delayMs),
      callback,
      off: false,
    };
    this.timers.push(timer);
    return { cancel: () => (timer.off = true) };
  }

  async advanceTo(at: number): Promise<void> {
    for (;;) {
      const next = this.timers
        .filter((timer) => !timer.off && timer.at <= at)
        .sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.off = true;
      this.nowMs = next.at;
      next.callback();
      await settle();
    }
    this.nowMs = at;
    await settle();
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

/** A pi-like port: Stop acknowledges, and the backend reports no `completed`. */
class FakePort implements BackgroundWorkBackendPort {
  readonly backend = "host-process" as const;
  launches = 0;
  readonly stops: BackgroundWorkStopRequest[] = [];
  stopImpl: () => Promise<{ acknowledged: boolean }> = () =>
    Promise.resolve({ acknowledged: true });

  launch() {
    this.launches += 1;
    return Promise.resolve({ launched: true });
  }

  stop(request: BackgroundWorkStopRequest) {
    this.stops.push(request);
    return this.stopImpl();
  }

  stopAll() {
    return Promise.resolve({ acknowledgedItemIds: [], unconfirmedItemIds: [] });
  }
}

let serial = 0;

/** A fresh owner, titled so nothing tries to name it. */
function owner(): string {
  serial += 1;
  const id = `deadline-owner-${serial}`;
  sessionStore.upsert({
    id,
    scope: "user",
    harness: "pi",
    agentType: "developer",
    title: `deadline owner ${serial}`,
  });
  return id;
}

type Answer = "delivered" | "busy" | "unavailable";

/** The production wiring, with the turn itself replaced by a recorder. */
function harness() {
  const clock = new FakeClock();
  const port = new FakePort();
  const events: string[] = [];
  const offers: Array<{ sessionId: string; offer: BackgroundCompletionOffer }> =
    [];
  const answers = new Map<string, Answer>();
  const queueCounts: Array<[string, number]> = [];
  let duringPeers: ((sessionId: string) => void) | undefined;
  let duringOffer: ((sessionId: string) => void) | undefined;
  const delivery: InstanceType<typeof BackgroundCompletionDelivery> =
    new BackgroundCompletionDelivery({
      drainPeers: async (sessionId) => {
        events.push(`peers:${sessionId}`);
        duringPeers?.(sessionId);
      },
      held: hold.automaticTurnsHeld,
      disposition: notices.completionDisposition,
      outbox: notices.backgroundDeliveryOutbox,
      queueChanged: (sessionId) =>
        queueCounts.push([sessionId, delivery.queuedCount(sessionId)]),
      offer: async (sessionId, offer) => {
        duringOffer?.(sessionId);
        // The run door refuses a held session as busy (`runtimePrompt.ts`).
        const answer = hold.automaticTurnsHeld(sessionId)
          ? "busy"
          : (answers.get(sessionId) ?? "delivered");
        events.push(`offer:${sessionId}:${answer}`);
        if (answer === "delivered") offers.push({ sessionId, offer });
        return answer;
      },
    });
  const supervisor = new BackgroundWorkSupervisor({
    ports: [port],
    clock,
    // `index.ts`'s handler; these owners are idle unless a test says so.
    completionRecorded: (item) =>
      notices.enqueueCompletionNotice(delivery, item, false),
  });
  return {
    clock,
    port,
    delivery,
    supervisor,
    events,
    offers,
    answers,
    queueCounts,
    duringPeers: (fn: typeof duringPeers) => (duringPeers = fn),
    duringOffer: (fn: typeof duringOffer) => (duringOffer = fn),
  };
}

async function launch(
  h: ReturnType<typeof harness>,
  ownerSessionId: string,
  kind: "shell" | "monitor-command" = "shell",
) {
  serial += 1;
  const admission = h.supervisor.admit({
    ownerSessionId,
    backend: "host-process",
    kind,
    label: "full test run",
    command: "pnpm run test",
    sourceRequestId: `deadline-launch-${serial}`,
  });
  assert.equal(admission.admitted, true);
  if (!admission.admitted) throw new Error("not admitted");
  const item = await h.supervisor.launch(admission);
  assert.equal(item?.state, "running");
  return item!;
}

function owed(sessionId: string) {
  return backgroundDeliveryOutboxStore
    .list()
    .filter((row) => row.sessionId === sessionId);
}

function completionOf(offer: BackgroundCompletionOffer) {
  const json = JSON.parse(offer.contextBlock.split("\n")[1]!) as {
    updates: Array<Record<string, unknown>>;
  };
  return json.updates;
}

beforeEach(() => {
  setBackgroundWorkAdmissionsOpenForTests(true);
  updateSettings({
    backgroundWork: {
      enabled: true,
      ownerSessionCap: 20,
      taskLifetimeMinutes: 60,
      claudeEmptyHostGraceSeconds: 30,
    },
  });
});

test("an idle parked owner is woken with the deadline fact, after its peers", async () => {
  const h = harness();
  const session = owner();
  for (const kind of ["shell", "monitor-command"] as const) {
    const item = await launch(h, session, kind);
    await h.clock.advanceTo(item.deadlineAt);
    await settle();
    const offered = h.offers.at(-1)!;
    assert.equal(offered.sessionId, session);
    const [update] = completionOf(offered.offer);
    assert.equal(update!.taskId, item.id);
    assert.equal(update!.state, "stopped");
    assert.equal(update!.exitCode, undefined, "no claim the work passed");
    assert.match(
      String(update!.outcomeSummary),
      /^Stopped by PA at its frozen deadline \(60 min lifetime\): the work was ended, not completed, and nothing restarted it\.$/,
    );
    assert.equal(
      update!.humanLink,
      `/background-tasks?task=${encodeURIComponent(item.id)}`,
    );
    assert.equal(
      offered.offer.presentation.updates[0]!.outcomeSummary,
      update!.outcomeSummary,
      "the card says the same",
    );
  }
  assert.deepEqual(h.events, [
    `peers:${session}`,
    `offer:${session}:delivered`,
    `peers:${session}`,
    `offer:${session}:delivered`,
  ]);
  assert.equal(h.delivery.queuedCount(session), 0);
  assert.deepEqual(owed(session), [], "delivered facts leave the outbox");
  assert.equal(h.port.launches, 2, "nothing was relaunched");
  assert.equal(h.port.stops.length, 2);
});

test("an explicit Stop keeps its deferral and is not retained across restart", async () => {
  const h = harness();
  const session = owner();
  const item = await launch(h, session);
  // A provider that reports the Stop itself, as the Claude CLI does.
  let acknowledge!: (ack: { acknowledged: boolean }) => void;
  h.port.stopImpl = () => new Promise((resolve) => (acknowledge = resolve));
  const stopping = h.supervisor.stopOne({
    itemId: item.id,
    ownerSessionId: session,
    sourceRequestId: "agent-stop",
    reason: "no longer needed",
  });
  await settle();
  h.supervisor.completed({ itemId: item.id, state: "stopped" });
  acknowledge({ acknowledged: true });
  await stopping;
  await settle();

  assert.equal(h.offers.length, 0, "no turn of its own");
  assert.equal(h.delivery.queuedCount(session), 1, "it rides the next turn");
  assert.deepEqual(
    owed(session).map((row) => [row.disposition, row.retained]),
    [["defer", false]],
  );
  const carried = h.delivery.peekDeferredContext(session)!;
  assert.match(carried.block, new RegExp(item.id));
  assert.doesNotMatch(carried.block, /frozen deadline/);
  carried.commit();
  assert.deepEqual(owed(session), []);
});

test("a held owner is never woken; its deadline fact waits for Resume and goes once", async () => {
  const h = harness();
  const session = owner();
  const item = await launch(h, session);
  hold.holdAutomaticTurns(session);
  await h.clock.advanceTo(item.deadlineAt);
  await settle();

  assert.equal(backgroundWorkStore.getItem(item.id)?.state, "stopped");
  assert.equal(hold.automaticTurnsHeld(session), true, "the hold stands");
  assert.equal(h.offers.length, 0);
  assert.ok(
    !h.events.some((event) => event.startsWith("offer:")),
    "not even offered",
  );
  assert.equal(h.delivery.queuedCount(session), 1);
  assert.deepEqual(
    owed(session).map((row) => [row.disposition, row.retained]),
    [["wake", true]],
  );

  // An idle edge while held changes nothing.
  await h.delivery.drain(session);
  assert.equal(h.offers.length, 0);

  hold.resumeAutomaticTurns(session);
  await h.delivery.requestDrain(session);
  await h.delivery.requestDrain(session);
  assert.deepEqual(
    h.offers.map((offer) => completionOf(offer.offer)[0]!.taskId),
    [item.id],
  );
  assert.equal(h.delivery.queuedCount(session), 0);
  assert.deepEqual(owed(session), []);
});

test("a Stop landing in the peer phase or during the offer keeps the fact for Resume", async () => {
  for (const phase of ["peers", "offer"] as const) {
    const h = harness();
    const session = owner();
    const item = await launch(h, session);
    let stopped = false;
    const stop = (sessionId: string) => {
      if (stopped || sessionId !== session) return;
      stopped = true;
      hold.holdAutomaticTurns(session);
    };
    if (phase === "peers") h.duringPeers(stop);
    else h.duringOffer(stop);
    await h.clock.advanceTo(item.deadlineAt);
    await settle();
    assert.equal(h.offers.length, 0, `${phase}: nothing delivered while held`);
    assert.equal(h.delivery.queuedCount(session), 1, phase);
    assert.deepEqual(
      owed(session).map((row) => row.retained),
      [true],
      phase,
    );
    hold.resumeAutomaticTurns(session);
    await h.delivery.requestDrain(session);
    assert.deepEqual(
      h.offers.map((offer) => completionOf(offer.offer)[0]!.taskId),
      [item.id],
      phase,
    );
    assert.deepEqual(owed(session), [], phase);
  }
});

test("a busy owner keeps the deadline fact until its next idle edge", async () => {
  const h = harness();
  const session = owner();
  const item = await launch(h, session);
  h.answers.set(session, "busy");
  await h.clock.advanceTo(item.deadlineAt);
  await settle();
  assert.equal(h.offers.length, 0);
  assert.equal(h.delivery.queuedCount(session), 1);
  assert.deepEqual(
    owed(session).map((row) => [row.disposition, row.retained]),
    [["wake", true]],
  );
  h.answers.delete(session);
  await h.delivery.drain(session);
  assert.deepEqual(
    h.offers.map((offer) => completionOf(offer.offer)[0]!.taskId),
    [item.id],
  );
  assert.deepEqual(owed(session), []);
  // Every count change was announced, ending at nothing queued.
  assert.deepEqual(h.queueCounts.filter(([id]) => id === session).at(-1), [
    session,
    0,
  ]);
});
