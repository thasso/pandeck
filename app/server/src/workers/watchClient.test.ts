import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { checkoutFailureOf } from "../checkoutFileAccess.ts";
import parcelWatcher from "../parcelWatcher.ts";
import {
  captureNextNativeWatchForTests,
  holdNativeUnsubscribeForTests,
  setWatchReleaseRetryMsForTests,
} from "../worker/watch.ts";
import { CHECKOUT_GIT_METHODS } from "../workerProtocol/checkoutMethods.ts";
import {
  UNKNOWN_METHOD,
  WorkerConnection,
  WorkerMethodError,
} from "../workerProtocol/connection.ts";
import { createInProcessTransport } from "../workerProtocol/inProcessTransport.ts";
import { WATCH_METHODS, encodeEvents } from "../workerProtocol/watchMethods.ts";
import { isWorkerFailure, openOnWorker } from "./fileClient.ts";
import {
  answerNextInProcessWorkerCallForTests,
  ensureInProcessWorker,
  inProcessWorkerEpochForTests,
  inProcessWorkerFileHandlesForTests,
  inProcessWorkerQuiescentForTests,
  inProcessWorkerServedMethodForTests,
  inProcessWorkerWatchesForTests,
  writeAsInProcessWorkerForTests,
} from "./inProcessWorker.ts";
import { DEFAULT_WORKER_ID } from "./placement.ts";
import { subscribeOnWorker } from "./watchClient.ts";
import {
  holdWatchDeliveriesForTests,
  recordWatchDeliveriesForTests,
  watchDeliveries,
  watchesOn,
} from "./watchDeliveries.ts";

/**
 * The server's watch client against the real in-process Worker and codec.
 * Only the native parcel call is ever substituted; ids, queues, the release
 * owner, the server's handler and the connection stay real.
 */

let dir: string;
let file: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "watch-client-"));
  file = join(dir, "regular.txt");
  writeFileSync(file, "x\n");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const INVALID_FRAME = new Uint8Array(8);

/** End the connection and wait for its Worker to release every watch. */
async function endConnection(): Promise<void> {
  ensureInProcessWorker();
  const { released } = inProcessWorkerWatchesForTests();
  writeAsInProcessWorkerForTests(INVALID_FRAME);
  await released;
}

let recorder: ReturnType<typeof recordWatchDeliveriesForTests>;

beforeEach(() => {
  recorder = recordWatchDeliveriesForTests();
});

afterEach(async () => {
  recorder.stop();
  await endConnection();
  vi.restoreAllMocks();
});

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1)
    await new Promise<void>((done) => setImmediate(done));
}

async function until(what: string, check: () => boolean): Promise<void> {
  for (let i = 0; i < 2_000; i += 1) {
    if (check()) return;
    await new Promise<void>((done) => setTimeout(done, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** Records when `promise` settles, and how. */
function track<T>(promise: Promise<T>) {
  const state: {
    settled: boolean;
    value?: T;
    error?: unknown;
  } = { settled: false };
  void promise.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error: unknown) => Object.assign(state, { settled: true, error }),
  );
  return state;
}

const local = (path: string) => ({ workerId: DEFAULT_WORKER_ID, path });

/** What a subscription's callbacks and listeners received. */
function listener() {
  const seen = {
    events: [] as string[][],
    errors: [] as string[],
    overflows: 0,
    losses: 0,
  };
  return {
    seen,
    callback: (err: Error | null, events: ReadonlyArray<{ path: string }>) => {
      if (err) seen.errors.push(err.message);
      else seen.events.push(events.map((event) => event.path));
    },
    listeners: {
      onOverflow: () => (seen.overflows += 1),
      onLost: () => (seen.losses += 1),
    },
  };
}

function watchOn(path: string, ignore: readonly string[] = []) {
  const { seen, callback, listeners } = listener();
  return {
    seen,
    subscribed: subscribeOnWorker(local(path), ignore, callback, listeners),
  };
}

/** Native parcel subscriptions of `root`'s subtree, live and at most. */
function nativeLive(root: string) {
  const count = { live: 0, maxLive: 0 };
  const original = parcelWatcher.subscribe.bind(parcelWatcher);
  vi.spyOn(parcelWatcher, "subscribe").mockImplementation(
    async (path, callback, options) => {
      const subscription = await original(path, callback, options);
      if (!path.startsWith(root)) return subscription;
      count.live += 1;
      count.maxLive = Math.max(count.maxLive, count.live);
      return {
        unsubscribe: async () => {
          await subscription.unsubscribe();
          count.live -= 1;
        },
      };
    },
  );
  return count;
}

const served = (method: string) => inProcessWorkerServedMethodForTests(method);

/** The epoch of an open connection, dialing and awaiting one if needed. */
async function connectedEpoch(): Promise<number> {
  ensureInProcessWorker();
  await until(
    "the handshake",
    () => inProcessWorkerEpochForTests() !== undefined,
  );
  return inProcessWorkerEpochForTests()!;
}

const deliveredIds = () => recorder.records().map(({ id }) => id);

function scratchDir(name: string): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  return path;
}

test("events before the subscribe answer reach their own subscription exactly once", async () => {
  const a = captureNextNativeWatchForTests({ holdSubscribe: true });
  const b = captureNextNativeWatchForTests({ holdSubscribe: true });
  const first = watchOn(scratchDir("a"));
  const second = watchOn(scratchDir("b"));
  const firstState = track(first.subscribed);
  const secondState = track(second.subscribed);
  await Promise.all([a.subscribed, b.subscribed]);
  a.emit(["a1"]);
  b.emit(["b1"]);
  await until("both early deliveries", () =>
    [first, second].every((watch) => watch.seen.events.length === 1),
  );
  assert.deepEqual(first.seen.events, [["a1"]]);
  assert.deepEqual(second.seen.events, [["b1"]]);
  assert.equal(firstState.settled || secondState.settled, false);

  b.releaseSubscribe();
  a.releaseSubscribe();
  const handles = [await first.subscribed, await second.subscribed];
  a.emit(["a2"]);
  b.emit(["b2"]);
  await until("both later deliveries", () =>
    [first, second].every((watch) => watch.seen.events.length === 2),
  );
  assert.deepEqual(first.seen.events, [["a1"], ["a2"]]);
  assert.deepEqual(second.seen.events, [["b1"], ["b2"]]);

  const c = captureNextNativeWatchForTests({ holdSubscribe: true });
  const third = watchOn(scratchDir("c"));
  await c.subscribed;
  const before = deliveredIds().length;
  c.emit(["c1"]);
  await until("the early delivery", () => third.seen.events.length === 1);
  const cId = deliveredIds()[before]!;
  const unsubscribes = served(WATCH_METHODS.unsubscribe);
  c.rejectSubscribe("Not a directory");
  await assert.rejects(third.subscribed, (error: unknown) => {
    assert.equal((error as Error).message, "Not a directory");
    assert.equal(checkoutFailureOf(error), "filesystem");
    return true;
  });
  assert.equal(served(WATCH_METHODS.unsubscribe), unsubscribes, "no cleanup");
  assert.deepEqual(third.seen.events, [["c1"]]);

  const next = watchOn(scratchDir("d"));
  const handle = await next.subscribed;
  const ids = inProcessWorkerWatchesForTests().subscriptions.map(
    (watch) => watch.id,
  );
  assert.ok(ids.every((id) => id !== cId));
  assert.ok(Math.max(...ids) > cId, "ids are never reused");
  await Promise.all([...handles, handle].map((live) => live.unsubscribe()));
});

test("a delivery for an id the server does not hold is acknowledged and dropped", async () => {
  const [serverEnd, workerEnd] = createInProcessTransport();
  const deliveries = watchDeliveries();
  const released = Promise.resolve();
  const server = new WorkerConnection(serverEnd, {
    handshake: { role: "server", admit: () => undefined },
    handlers: deliveries.handlers,
  });
  deliveries.attach(server, released);
  const worker = new WorkerConnection(workerEnd, {
    handshake: { role: "worker", workerId: "w" },
  });
  try {
    const watches = watchesOn(server)!;
    const { seen, callback, listeners } = listener();
    const failed = watches.add({ callback, ...listeners });
    watches.remove(failed);
    const abandoning = watches.add({ callback, ...listeners });
    watches.setState(abandoning, "abandoning");
    for (const id of [failed, abandoning, 99])
      for (const delivery of [
        { id, batches: [{ paths: ["x"] }, { error: "e" }], overflow: false },
        { id, batches: [], overflow: true },
      ])
        assert.deepEqual(
          (await worker.request(WATCH_METHODS.events, encodeEvents(delivery)))
            .json,
          {},
        );
    assert.deepEqual(seen, { events: [], errors: [], overflows: 0, losses: 0 });
    assert.equal(server.isEnded, false);
  } finally {
    worker.end("test over");
    server.end("test over");
  }
});

test("deliveries leave a record only while a test recorder is armed", async () => {
  recorder.stop();
  /** One real-codec connection pair with a live subscription; its delivery. */
  const epoch = () => {
    const [serverEnd, workerEnd] = createInProcessTransport();
    const deliveries = watchDeliveries();
    const server = new WorkerConnection(serverEnd, {
      handshake: { role: "server", admit: () => undefined },
      handlers: deliveries.handlers,
    });
    deliveries.attach(server, Promise.resolve());
    const worker = new WorkerConnection(workerEnd, {
      handshake: { role: "worker", workerId: "w" },
    });
    const { seen, callback, listeners } = listener();
    const watches = watchesOn(server)!;
    const id = watches.add({ callback, ...listeners });
    watches.setState(id, "live");
    return {
      seen,
      id,
      deliver: (count: number) =>
        worker.request(
          WATCH_METHODS.events,
          encodeEvents({
            id,
            batches: [
              { paths: Array.from({ length: count }, (_, i) => `/${i}`) },
            ],
            overflow: false,
          }),
        ),
      end: async () => {
        worker.end("epoch over");
        server.end("epoch over");
        await server.ended;
      },
    };
  };

  // Unarmed, as in production: callbacks run and nothing is kept, across
  // ended connections.
  for (let round = 0; round < 3; round += 1) {
    const unarmed = epoch();
    for (let i = 0; i < 50; i += 1) await unarmed.deliver(1);
    assert.equal(unarmed.seen.events.length, 50);
    await unarmed.end();
  }
  const first = recordWatchDeliveriesForTests();
  const second = recordWatchDeliveriesForTests();
  try {
    assert.deepEqual(first.records(), [], "no earlier delivery was kept");
    const armed = epoch();
    await armed.deliver(2);
    first.stop();
    await armed.deliver(3);
    await armed.end();
    const next = epoch();
    await next.deliver(4);
    await next.end();
    assert.deepEqual(first.records(), [
      { id: armed.id, batchCounts: [2], overflow: false },
    ]);
    assert.deepEqual(
      second.records().map(({ batchCounts }) => batchCounts),
      [[2], [3], [4]],
      "a recorder outlives a connection",
    );
    assert.deepEqual(armed.seen.events, [
      ["/0", "/1"],
      ["/0", "/1", "/2"],
    ]);
  } finally {
    first.stop();
    second.stop();
  }
  const after = epoch();
  await after.deliver(1);
  await after.end();
  assert.equal(second.records().length, 3, "a stopped recorder stays stopped");
});

test("each batch reaches the callback in order; errors and overflow reach their listeners", async () => {
  const capture = captureNextNativeWatchForTests();
  const watch = watchOn(scratchDir("batches"));
  const handle = await watch.subscribed;
  const release = holdWatchDeliveriesForTests();
  try {
    capture.emit(["/1", "/2"]);
    await until("the first delivery", () => watch.seen.events.length === 1);
    capture.emit(["/3", "/4", "/5"]);
    capture.emitError("native error");
    capture.emit(["/6"]);
    await settle();
    assert.equal(watch.seen.events.length, 1, "acknowledgement held");
  } finally {
    release();
  }
  await until("the queued batches", () => watch.seen.events.length === 3);
  assert.deepEqual(watch.seen.events, [
    ["/1", "/2"],
    ["/3", "/4", "/5"],
    ["/6"],
  ]);
  assert.deepEqual(watch.seen.errors, ["native error"]);
  assert.equal(watch.seen.overflows, 0);
  await handle.unsubscribe();
  assert.equal(capture.unsubscribes, 1);
});

test("a live subscription is lost only once the old Worker released it", async () => {
  const native = nativeLive(dir);
  const watch = watchOn(scratchDir("lost"));
  const handle = await watch.subscribed;
  assert.equal(native.live, 1);
  const epoch = await connectedEpoch();
  const old = ensureInProcessWorker();
  const { released } = inProcessWorkerWatchesForTests();
  const release = holdNativeUnsubscribeForTests();
  writeAsInProcessWorkerForTests(INVALID_FRAME);
  await old.ended;
  // Called on a handle whose connection ended: it resolves after the release.
  const unsubscribed = track(handle.unsubscribe());
  const releasedState = track(released);
  await settle();
  // The next request dials a new Worker while the old one still releases.
  assert.equal(await connectedEpoch(), epoch + 1);
  await settle();
  assert.equal(watch.seen.losses, 0, "not lost before the release");
  assert.equal(native.live, 1);
  assert.equal(releasedState.settled || unsubscribed.settled, false);
  release();
  await released;
  await until("the loss", () => watch.seen.losses === 1);
  assert.equal(native.live, 0);
  await until("the unsubscribe", () => unsubscribed.settled);
  assert.equal(unsubscribed.error, undefined);
  await handle.unsubscribe();
  assert.equal(watch.seen.losses, 1, "lost once");
});

/** A held checkout git request that settles only when its handler aborts. */
function heldGit(): Promise<unknown> {
  answerNextInProcessWorkerCallForTests(
    CHECKOUT_GIT_METHODS.run,
    async (_payload, signal) => {
      await new Promise<void>((done) =>
        signal.addEventListener("abort", () => done(), { once: true }),
      );
      throw new Error("git aborted");
    },
  );
  return ensureInProcessWorker().request(CHECKOUT_GIT_METHODS.run, {
    json: {},
  });
}

async function openFile(): Promise<void> {
  const outcome = await openOnWorker(local(file), false);
  assert.ok(!("error" in outcome));
  assert.equal(inProcessWorkerFileHandlesForTests(), 1);
}

test("a held native unsubscribe holds neither git rejection nor the file sweep", async () => {
  const watch = watchOn(scratchDir("held-unsubscribe"));
  const handle = await watch.subscribed;
  const release = holdNativeUnsubscribeForTests();
  const before = served(WATCH_METHODS.unsubscribe);
  const unsubscribed = track(handle.unsubscribe());
  await until(
    "the unsubscribe served",
    () => served(WATCH_METHODS.unsubscribe) === before + 1,
  );
  const git = track(heldGit());
  await openFile();
  const quiescent = inProcessWorkerQuiescentForTests();
  const { released } = inProcessWorkerWatchesForTests();
  const releasedState = track(released);
  writeAsInProcessWorkerForTests(INVALID_FRAME);
  await quiescent;
  await until("git rejected", () => git.settled);
  assert.match(String(git.error), /ended/);
  assert.equal(inProcessWorkerFileHandlesForTests(), 0);
  await settle();
  assert.equal(releasedState.settled, false, "the native release is held");
  assert.equal(unsubscribed.settled, false);
  release();
  await released;
  await until("the unsubscribe", () => unsubscribed.settled);
  assert.equal(unsubscribed.error, undefined);
  assert.equal(watch.seen.losses, 0, "released by its holder, not lost");
});

test("a held native subscribe holds neither git rejection nor the file sweep", async () => {
  const capture = captureNextNativeWatchForTests({ holdSubscribe: true });
  const watch = watchOn(scratchDir("held-subscribe"));
  const subscribed = track(watch.subscribed);
  await capture.subscribed;
  const git = track(heldGit());
  await openFile();
  const quiescent = inProcessWorkerQuiescentForTests();
  const { released } = inProcessWorkerWatchesForTests();
  const releasedState = track(released);
  writeAsInProcessWorkerForTests(INVALID_FRAME);
  await quiescent;
  await until("git rejected", () => git.settled);
  assert.match(String(git.error), /ended/);
  assert.equal(inProcessWorkerFileHandlesForTests(), 0);
  capture.emit(["/orphaned"]);
  await settle();
  assert.equal(releasedState.settled, false, "the native subscribe is owned");
  assert.equal(subscribed.settled, false, "neither answered nor rejected");
  const order: string[] = [];
  void released.then(() => order.push("released"));
  capture.releaseSubscribe();
  await assert.rejects(watch.subscribed, (error: unknown) => {
    order.push("rejected");
    assert.ok(isWorkerFailure(error));
    return true;
  });
  assert.deepEqual(order, ["released", "rejected"]);
  assert.equal(capture.unsubscribes, 1, "the orphan was released at once");
  assert.deepEqual(watch.seen.events, [], "nothing delivered for it");
});

/** A `watch.subscribe` substitute: the real handler, then a malformed answer. */
function malformedAfterReal(): void {
  answerNextInProcessWorkerCallForTests(
    WATCH_METHODS.subscribe,
    async (payload, signal, real) => {
      await real(payload, signal);
      return { json: { bogus: 1 } };
    },
  );
}

for (const [name, after] of [
  ["a malformed answer", "malformed"],
  ["a failed response", "failed"],
] as const)
  test(`native success, then ${name}: the slot is held until absence is proven`, async () => {
    const native = nativeLive(dir);
    if (after === "malformed") malformedAfterReal();
    else
      answerNextInProcessWorkerCallForTests(
        WATCH_METHODS.subscribe,
        async (payload, signal, real) => {
          await real(payload, signal);
          throw new Error("failed after the native subscribe");
        },
      );
    const release = holdNativeUnsubscribeForTests();
    const epoch = await connectedEpoch();
    const before = served(WATCH_METHODS.unsubscribe);
    const watch = watchOn(scratchDir(`uncertain-${after}`));
    const subscribed = track(watch.subscribed);
    await until(
      "the cleanup unsubscribe",
      () => served(WATCH_METHODS.unsubscribe) === before + 1,
    );
    await settle();
    assert.equal(native.live, 1, "the native subscription went live");
    assert.equal(subscribed.settled, false, "the slot is still held");
    assert.equal(inProcessWorkerEpochForTests(), epoch, "same connection");
    let liveAtRejection: number | undefined;
    void watch.subscribed.catch(() => (liveAtRejection = native.live));
    release();
    await assert.rejects(watch.subscribed, (error: unknown) =>
      isWorkerFailure(error),
    );
    assert.equal(liveAtRejection, 0, "absent before the rejection");
    assert.equal(native.maxLive, 1);
    assert.deepEqual(inProcessWorkerWatchesForTests().subscriptions, []);
    assert.equal(inProcessWorkerEpochForTests(), epoch, "same connection");

    // A retry leaves exactly one subscription, under a fresh id.
    const retry = watchOn(scratchDir(`uncertain-${after}`));
    const handle = await retry.subscribed;
    assert.equal(inProcessWorkerWatchesForTests().subscriptions.length, 1);
    assert.equal(native.live, 1);
    await handle.unsubscribe();
  });

test("an answer before the native subscribe finished: the cleanup joins it", async () => {
  const capture = captureNextNativeWatchForTests({ holdSubscribe: true });
  answerNextInProcessWorkerCallForTests(
    WATCH_METHODS.subscribe,
    async (payload, signal, real) => {
      void real(payload, signal).catch(() => undefined);
      return { json: { bogus: 1 } };
    },
  );
  const epoch = await connectedEpoch();
  const before = served(WATCH_METHODS.unsubscribe);
  const watch = watchOn(scratchDir("joined"));
  const subscribed = track(watch.subscribed);
  await until(
    "the cleanup unsubscribe",
    () => served(WATCH_METHODS.unsubscribe) === before + 1,
  );
  await settle();
  assert.equal(
    subscribed.settled,
    false,
    "the cleanup waits for the native call",
  );
  capture.releaseSubscribe();
  await assert.rejects(watch.subscribed, (error: unknown) =>
    isWorkerFailure(error),
  );
  assert.equal(capture.unsubscribes, 1);
  assert.deepEqual(inProcessWorkerWatchesForTests().subscriptions, []);
  assert.equal(inProcessWorkerEpochForTests(), epoch, "same connection");
});

/**
 * A failed cleanup ends the connection; the subscribe rejects only once the
 * old Worker released every native watch, and the connection's other live
 * subscriptions are lost then too.
 */
async function failedCleanup(arm: () => { unsubscribes: () => number }) {
  const native = nativeLive(dir);
  const other = watchOn(scratchDir("bystander"));
  await other.subscribed;
  const epoch = inProcessWorkerEpochForTests()!;
  const { unsubscribes } = arm();
  const { released } = inProcessWorkerWatchesForTests();
  const order: string[] = [];
  void released.then(() => order.push("released"));
  const watch = watchOn(scratchDir("cleanup-fails"));
  await assert.rejects(watch.subscribed, (error: unknown) => {
    order.push(`rejected after ${unsubscribes()} native unsubscribes`);
    assert.ok(isWorkerFailure(error));
    return true;
  });
  await until("the bystander's loss", () => other.seen.losses === 1);
  assert.equal(await connectedEpoch(), epoch + 1, "the connection ended");
  assert.equal(native.live, 0);
  return { order, maxLive: native.maxLive };
}

test("a cleanup answered as a native failure ends the connection and awaits the release", async () => {
  const previous = setWatchReleaseRetryMsForTests(10);
  try {
    const { order } = await failedCleanup(() => {
      const capture = captureNextNativeWatchForTests({
        rejectUnsubscribeOnce: true,
      });
      malformedAfterReal();
      return { unsubscribes: () => capture.unsubscribes };
    });
    assert.deepEqual(order, [
      "released",
      "rejected after 2 native unsubscribes",
    ]);
  } finally {
    setWatchReleaseRetryMsForTests(previous);
  }
});

test("a cleanup refused as a Worker failure ends the connection and awaits the release", async () => {
  const { order, maxLive } = await failedCleanup(() => {
    malformedAfterReal();
    answerNextInProcessWorkerCallForTests(
      WATCH_METHODS.unsubscribe,
      async (payload, signal, real) => {
        await real(payload, signal);
        throw new Error("refused after the real unsubscribe");
      },
    );
    return { unsubscribes: () => 0 };
  });
  assert.equal(order[0], "released");
  assert.match(order[1] ?? "", /^rejected/);
  assert.equal(maxLive, 2);
});

test("definite outcomes reject at once and run no cleanup", async () => {
  const epoch = await connectedEpoch();
  const before = served(WATCH_METHODS.unsubscribe);
  await assert.rejects(watchOn(file).subscribed, (error: unknown) => {
    assert.equal((error as Error).message, "Not a directory");
    assert.equal(checkoutFailureOf(error), "filesystem");
    return true;
  });
  answerNextInProcessWorkerCallForTests(WATCH_METHODS.subscribe, async () => {
    throw new WorkerMethodError(UNKNOWN_METHOD, "Unknown method.");
  });
  await assert.rejects(watchOn(dir).subscribed, (error: unknown) => {
    assert.equal(checkoutFailureOf(error), "worker");
    return true;
  });
  const { callback, listeners } = listener();
  await assert.rejects(
    subscribeOnWorker(
      { workerId: "elsewhere", path: dir },
      [],
      callback,
      listeners,
    ),
    (error: unknown) => checkoutFailureOf(error) === "worker",
  );
  assert.equal(served(WATCH_METHODS.unsubscribe), before, "no cleanup ran");
  assert.equal(inProcessWorkerEpochForTests(), epoch);
});
