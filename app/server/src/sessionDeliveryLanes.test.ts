import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { sessionStore } from "./db/sessionStore.ts";
import { peerPromptStore } from "./db/peerPromptStore.ts";
import { promptQueueStore } from "./db/promptQueueStore.ts";
import { agentHandoffStore } from "./db/agentHandoffStore.ts";
import { FakeRuntimeDriver } from "./test/fakeRuntimeDriver.ts";
import type { PromptQueueDriver } from "./promptQueue.ts";

const { drivers, fakeHub } = vi.hoisted(() => {
  const drivers = new Map<string, FakeRuntimeDriver & PromptQueueDriver>();
  return {
    drivers,
    fakeHub: {
      getLiveById: (id: string) => drivers.get(id),
      acquireById: async (id: string) => drivers.get(id),
      broadcastSessions: () => {},
      broadcastPeerPromptCardUpdate: () => {},
      broadcastPeerPromptQueue: () => {},
    },
  };
});
vi.mock("./hub.ts", () => ({ hub: fakeHub }));
vi.mock("./webPush.ts", () => ({ notifySessionBlocked: async () => {} }));

const peer = await import("./peerPrompt.ts");
const queue = await import("./promptQueue.ts");
const handoffs = await import("./agentHandoffs.ts");
const hold = await import("./automaticTurnHold.ts");
const { promptRuntimeSession } = await import("./session/runtimePrompt.ts");
const { offerBackgroundCompletion } =
  await import("./backgroundCompletionNotices.ts");
const { setSessionIdleHook } = await import("./session/runtime/liveSession.ts");
const { createDeliveryScheduler } = await import("./deliveryScheduler.ts");
const { setDeliveryWake } = await import("./deliveryWake.ts");
const { sessionDeliveryLanes } = await import("./sessionDeliveryLanes.ts");
const { setWorkflowAssignmentDelivery } =
  await import("./workflow/assignmentDelivery.ts");
const { BackgroundCompletionDelivery } =
  await import("./backgroundWork/completionDelivery.ts");
peer.setHubForTests(fakeHub);

let nextId = 0;
const releases: Array<() => void> = [];
const cleanups: Array<() => void | Promise<void>> = [];

function seed() {
  const id = `delivery-lanes-${nextId++}`;
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  releases.push(() => resolve());
  return { promise, resolve };
}

function holdTurn(driver: FakeRuntimeDriver) {
  const release = driver.holdTurns();
  releases.push(release);
  return release;
}

async function until(check: () => boolean, diagnostic?: () => string) {
  await vi.waitFor(() => assert.ok(check(), diagnostic?.()), {
    interval: 5,
    timeout: 2000,
  });
}

function fixture() {
  const driver = seed();
  const sender = seed();
  const errors: unknown[] = [];
  const offeredRunning: boolean[] = [];
  let beforePeers = async () => {};
  const offer = offerBackgroundCompletion(async (id) => drivers.get(id));
  const background = new BackgroundCompletionDelivery({
    held: hold.automaticTurnsHeld,
    drainPeers: async (id, admission) => {
      await beforePeers();
      const live = drivers.get(id);
      await peer.drainRecipient(id, {
        phase: "all",
        ...(live ? { driver: live } : {}),
        ...admission,
      });
    },
    offer: (...args) => {
      offeredRunning.push(driver.isRunning);
      return offer(...args);
    },
  });
  const scheduler = createDeliveryScheduler({
    ...sessionDeliveryLanes(background),
    runAutoApprovals: async () => {},
    live: (id) => drivers.get(id),
    acquire: async (id) => drivers.get(id),
    held: hold.automaticTurnsHeld,
    shutdown: () => false,
    reportError: (_id, _lane, error) => errors.push(error),
  });
  setDeliveryWake((id) => void scheduler.wake(id));
  queue.setPromptQueueHost({
    live: (id) => drivers.get(id),
    publish: () => {},
    reportError: (_id, error) => errors.push(error),
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
    await scheduler.wake(driver.sessionId);
    background.stop();
  });
  return {
    driver,
    sender,
    scheduler,
    background,
    errors,
    offeredRunning,
    idlePass: () => idlePass,
    setBeforePeers: (callback: () => Promise<void>) => {
      beforePeers = callback;
    },
    send: (text: string) =>
      peer.sendPeerPrompt({
        senderSessionId: sender.sessionId,
        targetSessionId: driver.sessionId,
        prompt: text,
        responseRequested: false,
      }),
    startUser: async () => {
      const release = holdTurn(driver);
      void promptRuntimeSession(driver, "U");
      await until(() => driver.isRunning);
      return release;
    },
    enqueueBackground: () =>
      background.enqueue(driver.sessionId, {
        itemId: "ci-watch",
        revision: 1,
        label: "CI watch",
        state: "completed",
        backend: "server-task",
        stopRequested: false,
        ownerTurnRunning: driver.isRunning,
        humanLink: "/background-tasks",
      }),
  };
}

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  peer.setPeerPromptAutoDeliverForTests(false);
  setDeliveryWake(undefined);
  setSessionIdleHook(undefined);
  hold.setAutomaticTurnHoldHost(undefined);
  handoffs.setAgentHandoffDeliveryStoppedForTests(true);
  handoffs.setAgentHandoffDeliveryStoppedForTests(false);
  drivers.clear();
  setWorkflowAssignmentDelivery(undefined);
});

test.each([false, true])(
  "handoffs retain priority across full-turn settlement, deferred=%s",
  async (deferredSettle) => {
    const f = fixture();
    const releaseUser = await f.startUser();
    for (const text of ["A", "B"])
      assert.equal(
        await handoffs.deliverAgentHandoff({
          sessionId: f.driver.sessionId,
          driver: f.driver,
          text,
          origin: { kind: "system", source: "approval-decision" },
        }),
        "queued",
      );
    queue.queuePrompt(f.driver.sessionId, { text: "Q" });
    const releaseSettle = deferredSettle ? f.driver.holdSettle() : () => {};
    releases.push(releaseSettle);
    releaseUser();
    await until(() => f.driver.promptTexts.length >= 2 && !f.driver.isRunning);
    // A has closed its run, but its earlier admitted drain has not settled.
    if (deferredSettle) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(f.driver.promptTexts, ["U", "A"]);
      releaseSettle();
    }
    await until(() => f.driver.promptTexts.length === 4);
    assert.deepEqual(f.driver.promptTexts, ["U", "A", "B", "Q"]);
    assert.deepEqual(f.errors, []);
  },
);

test("workflow admissions share settlement waits and keep queue/workflow/peer priority", async () => {
  const f = fixture();
  const releaseUser = await f.startUser();
  const assignments = ["W1", "W2"];
  setWorkflowAssignmentDelivery({
    owes: (id) => id === f.driver.sessionId && assignments.length > 0,
    unavailable: () => assert.fail("live workflow driver was available"),
    deliver: async (_session, shouldStart) => {
      while (assignments.length && shouldStart())
        await promptRuntimeSession(f.driver, assignments.shift()!);
    },
  });
  queue.queuePrompt(f.driver.sessionId, { text: "Q" });
  await f.send("P");
  const releaseSettle = f.driver.holdSettle();
  releases.push(releaseSettle);
  releaseUser();
  await until(
    () => f.driver.promptTexts.length === 3 && !f.driver.isRunning,
    () =>
      JSON.stringify({
        prompts: f.driver.promptTexts,
        running: f.driver.isRunning,
        errors: f.errors,
      }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(f.driver.promptTexts, ["U", "Q", "W1"]);
  releaseSettle();
  await until(
    () => f.driver.promptTexts.length === 5,
    () =>
      JSON.stringify({
        prompts: f.driver.promptTexts,
        running: f.driver.isRunning,
        assignments,
        errors: f.errors,
      }),
  );
  assert.deepEqual(f.driver.promptTexts.slice(0, 4), ["U", "Q", "W1", "W2"]);
  assert.match(f.driver.promptTexts[4]!, /P/);
  assert.deepEqual(f.errors, []);
});

test("background debt survives replies arriving across two peer turns", async () => {
  const f = fixture();
  const releaseUser = await f.startUser();
  f.enqueueBackground();
  await f.send("P1");
  releaseUser();
  const releasePeer = holdTurn(f.driver);
  await until(() => f.driver.promptTexts.length === 2 && f.driver.isRunning);
  await f.send("P2");
  releasePeer();
  await until(
    () => f.driver.promptTexts.length === 4,
    () =>
      JSON.stringify({
        prompts: f.driver.promptTexts,
        wakeOwed: f.background.wakeOwed(f.driver.sessionId),
        errors: f.errors,
      }),
  );
  assert.match(f.driver.promptTexts[1]!, /P1/);
  assert.match(f.driver.promptTexts[2]!, /P2/);
  assert.match(f.driver.promptTexts[3]!, /Background work updated/);
  await until(() => !f.background.wakeOwed(f.driver.sessionId));
  assert.deepEqual(f.errors, []);
});

test("background debt survives a reply arriving inside its peer phase", async () => {
  const f = fixture();
  const releaseUser = await f.startUser();
  f.enqueueBackground();
  const entered = deferred();
  const open = deferred();
  f.setBeforePeers(async () => {
    entered.resolve();
    await open.promise;
  });
  releaseUser();
  await entered.promise;
  await f.send("P1");
  open.resolve();
  await until(
    () => f.driver.promptTexts.length === 3,
    () =>
      JSON.stringify({
        prompts: f.driver.promptTexts,
        wakeOwed: f.background.wakeOwed(f.driver.sessionId),
        errors: f.errors,
      }),
  );
  assert.match(f.driver.promptTexts[1]!, /P1/);
  assert.match(f.driver.promptTexts[2]!, /Background work updated/);
  await until(() => !f.background.wakeOwed(f.driver.sessionId));
  assert.deepEqual(f.errors, []);
});

test("peer FIFO stays ahead of notices after an earlier FIFO admission", async () => {
  const f = fixture();
  const releaseUser = await f.startUser();
  await f.send("P1");
  const chainId = peerPromptStore.createChain();
  const notice = peerPromptStore.enqueue({
    conversationId: "interruption-notice",
    chainId,
    hop: peerPromptStore.reserveHop(chainId),
    senderSessionId: f.driver.sessionId,
    recipientSessionId: f.sender.sessionId,
    prompt: "reply owed",
    responseRequested: true,
  });
  peerPromptStore.claimNext(f.sender.sessionId, "test", 60_000);
  peerPromptStore.markAdmitted(notice.id);
  peerPromptStore.markAcknowledged(notice.id);
  peerPromptStore.markInterrupted(notice.id, "the process died", "restart");
  releaseUser();
  const releasePeer = holdTurn(f.driver);
  await until(() => f.driver.promptTexts.length === 2 && f.driver.isRunning);
  await f.send("P2");
  releasePeer();
  await until(() => f.driver.promptTexts.length === 4);
  assert.match(f.driver.promptTexts[2]!, /P2/);
  assert.ok(peerPromptStore.getById(notice.id)?.senderNotifiedAt);
  assert.deepEqual(f.errors, []);
});

test("an idle settlement wait warns without releasing its admission gate", async () => {
  const f = fixture();
  const releaseUser = await f.startUser();
  for (const text of ["A", "B"])
    handoffs.enqueueAgentHandoff({
      sessionId: f.driver.sessionId,
      text,
      origin: { kind: "system", source: "approval-decision" },
    });
  const releaseSettle = f.driver.holdSettle();
  releases.push(releaseSettle);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.useFakeTimers();
  try {
    releaseUser();
    await until(() => f.driver.promptTexts.length === 2 && !f.driver.isRunning);
    await vi.advanceTimersByTimeAsync(30_000);
    assert.equal(warn.mock.calls.length, 1);
    assert.match(
      String(warn.mock.calls[0]?.[0]),
      /is idle but 1 earlier drain\(s\) have not settled after 30s/,
    );
    assert.deepEqual(f.driver.promptTexts, ["U", "A"]);
    await vi.advanceTimersByTimeAsync(30_000);
    assert.equal(warn.mock.calls.length, 1, "one diagnostic, not polling");
  } finally {
    releaseSettle();
    await f.scheduler.wake(f.driver.sessionId);
    vi.useRealTimers();
    warn.mockRestore();
  }
  await until(() => f.driver.promptTexts.length === 3);
  assert.deepEqual(f.driver.promptTexts, ["U", "A", "B"]);
});

test("a preappend rejection settles once without debt spinning and a new wake can retry", async () => {
  const f = fixture();
  const releaseUser = await f.startUser();
  f.enqueueBackground();
  const error = new Error("peer phase refused before append");
  let attempts = 0;
  f.setBeforePeers(async () => {
    attempts++;
    throw error;
  });
  releaseUser();
  await until(() => !f.driver.isRunning);
  await f.idlePass();
  assert.equal(attempts, 1);
  assert.deepEqual(f.errors, [error]);
  assert.deepEqual(f.driver.promptTexts, ["U"]);
  assert.equal(f.background.wakeOwed(f.driver.sessionId), true);
  f.setBeforePeers(async () => {});
  await f.scheduler.wake(f.driver.sessionId);
  await until(() => f.driver.promptTexts.length === 2);
  assert.match(f.driver.promptTexts[1]!, /Background work updated/);
});

test("a Stop during failed acquisition spends no handoff retry or queue failure", async () => {
  const driver = seed();
  const id = driver.sessionId;
  handoffs.enqueueAgentHandoff({
    sessionId: id,
    text: "A",
    origin: { kind: "system", source: "approval-decision" },
  });
  promptQueueStore.append({ id: `queued-${id}`, sessionId: id, text: "Q" });
  const background = new BackgroundCompletionDelivery({
    drainPeers: async () => {},
    offer: async () => "busy",
  });
  const scheduler = createDeliveryScheduler({
    ...sessionDeliveryLanes(background),
    runAutoApprovals: async () => {},
    live: () => undefined,
    acquire: async () => {
      hold.holdAutomaticTurns(id);
      throw new Error("acquisition failed after Stop");
    },
    held: hold.automaticTurnsHeld,
    shutdown: () => false,
    reportError: () => {},
  });
  await scheduler.wake(id);
  assert.equal(agentHandoffStore.next(id)?.attempts, 0);
  assert.equal(promptQueueStore.isPaused(id), false);
  assert.equal(promptQueueStore.list(id)[0]?.error, undefined);
  assert.deepEqual(driver.promptTexts, []);
  background.stop();
});

test("running joinable offers do not await the handoff turn they may steer", async () => {
  const f = fixture();
  // The real offer answers busy when the non-steering fake provider refuses
  // steerOnly. Advertising the capability lets us check scheduler admission.
  Object.defineProperty(f.driver, "canSteer", { value: true });
  const releaseUser = await f.startUser();
  handoffs.enqueueAgentHandoff({
    sessionId: f.driver.sessionId,
    text: "A",
    origin: { kind: "system", source: "approval-decision" },
  });
  releaseUser();
  const releaseHandoff = holdTurn(f.driver);
  await until(() => f.driver.promptTexts.length === 2 && f.driver.isRunning);
  f.enqueueBackground();
  await f.scheduler.wake(f.driver.sessionId);
  assert.deepEqual(f.offeredRunning, [true]);
  assert.equal(f.driver.isRunning, true);
  releaseHandoff();
  await until(() => f.driver.promptTexts.length === 3);
  assert.match(f.driver.promptTexts[2]!, /Background work updated/);
  assert.deepEqual(f.errors, []);
});
