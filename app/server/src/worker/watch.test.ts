import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import parcelWatcher from "../parcelWatcher.ts";
import {
  INVALID_PARAMS,
  WRONG_WORKER,
} from "../workerProtocol/checkoutMethods.ts";
import type { Payload } from "../workerProtocol/codec.ts";
import {
  UNKNOWN_METHOD,
  WorkerConnection,
  WorkerRequestError,
} from "../workerProtocol/connection.ts";
import { FILE_METHODS } from "../workerProtocol/fileMethods.ts";
import { createInProcessTransport } from "../workerProtocol/inProcessTransport.ts";
import {
  AnsweredWatchFailure,
  WATCH_METHODS,
  decodeWatchOutcome,
  encodeSubscribe,
  encodeUnsubscribe,
} from "../workerProtocol/watchMethods.ts";
import {
  ensureInProcessWorker,
  inProcessWorkerEpochForTests,
  inProcessWorkerWatchesForTests,
  writeAsInProcessWorkerForTests,
} from "../workers/inProcessWorker.ts";
import { DEFAULT_WORKER_ID } from "../workers/placement.ts";
import { subscribeOnWorker } from "../workers/watchClient.ts";
import {
  holdWatchDeliveriesForTests,
  recordWatchDeliveriesForTests,
} from "../workers/watchDeliveries.ts";
import { fileHandlers } from "./files.ts";
import {
  captureNextNativeWatchForTests,
  setWatchQueueBoundForTests,
  setWatchReleaseRetryMsForTests,
} from "./watch.ts";

/**
 * The Worker's watch methods over the real codec, as raw requests on the
 * in-process connection: what any server, not just this one's client, gets
 * from them. Raw ids sit far above the server client's own counter.
 */

let dir: string;
let file: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "worker-watch-"));
  file = join(dir, "regular.txt");
  writeFileSync(file, "x\n");
});

const aliasDirs: string[] = [];

afterAll(() => {
  for (const path of [dir, ...aliasDirs])
    rmSync(path, { recursive: true, force: true });
});

const INVALID_FRAME = new Uint8Array(8);

let recorder: ReturnType<typeof recordWatchDeliveriesForTests>;

beforeEach(() => {
  recorder = recordWatchDeliveriesForTests();
});

afterEach(async () => {
  recorder.stop();
  // Every case ends on a fresh connection whose Worker released everything.
  ensureInProcessWorker();
  const { released } = inProcessWorkerWatchesForTests();
  writeAsInProcessWorkerForTests(INVALID_FRAME);
  await released;
  vi.restoreAllMocks();
});

/** Let in-process deliveries run. */
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

/** Wait for `check` by event-loop turns, never by a timer. */
async function turnsUntil(what: string, check: () => boolean): Promise<void> {
  for (let i = 0; i < 10_000; i += 1) {
    if (check()) return;
    await new Promise<void>((done) => setImmediate(done));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** Whether `promise` has settled, after the in-process hops ran. */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await settle();
  return settled;
}

let rawId = 900_000;

const ask = (method: string, payload: Payload): Promise<Payload> =>
  ensureInProcessWorker().request(method, payload);

const subscribe = (id: number, path = dir, workerId = DEFAULT_WORKER_ID) =>
  ask(
    WATCH_METHODS.subscribe,
    encodeSubscribe({ workerId, id, path, ignore: [] }),
  );

const unsubscribe = (id: number) =>
  ask(
    WATCH_METHODS.unsubscribe,
    encodeUnsubscribe({ workerId: DEFAULT_WORKER_ID, id }),
  );

/** Native parcel subscribes, counted through the module object. */
function countNativeSubscribes(): { calls: number } {
  const counter = { calls: 0 };
  const original = parcelWatcher.subscribe.bind(parcelWatcher);
  vi.spyOn(parcelWatcher, "subscribe").mockImplementation((...args) => {
    counter.calls += 1;
    return original(...args);
  });
  return counter;
}

function refusedWith(code: string) {
  return (error: unknown) =>
    error instanceof WorkerRequestError && error.code === code;
}

const deliveredFor = (id: number) =>
  recorder.records().filter((record) => record.id === id);

test("a subscribe naming another Worker or a bad or held id is refused before any native call", async () => {
  const native = countNativeSubscribes();
  await assert.rejects(
    subscribe(++rawId, dir, "elsewhere"),
    refusedWith(WRONG_WORKER),
  );
  await assert.rejects(unsubscribe(0), refusedWith(INVALID_PARAMS));
  for (const id of [0, -3, 1.5])
    await assert.rejects(subscribe(id), refusedWith(INVALID_PARAMS));

  const capture = captureNextNativeWatchForTests({ holdSubscribe: true });
  const held = ++rawId;
  const first = subscribe(held);
  await capture.subscribed;
  // Still subscribing, then live: the id is held either way.
  await assert.rejects(subscribe(held), refusedWith(INVALID_PARAMS));
  capture.releaseSubscribe();
  assert.deepEqual((await first).json, {});
  await assert.rejects(subscribe(held), refusedWith(INVALID_PARAMS));
  assert.equal(native.calls, 0, "no native subscribe for a refused request");

  assert.deepEqual((await unsubscribe(++rawId)).json, {}, "unknown id");
  assert.deepEqual((await unsubscribe(held)).json, {});
  assert.equal(capture.unsubscribes, 1);
});

test("an unsubscribe of an id still subscribing joins the native subscribe", async () => {
  const resolved = captureNextNativeWatchForTests({ holdSubscribe: true });
  const a = ++rawId;
  const subscribed = subscribe(a);
  await resolved.subscribed;
  const released = unsubscribe(a);
  assert.equal(await isSettled(released), false, "waits for the subscribe");
  resolved.releaseSubscribe();
  assert.deepEqual((await subscribed).json, {});
  assert.deepEqual((await released).json, {});
  assert.equal(resolved.unsubscribes, 1);

  const rejected = captureNextNativeWatchForTests({ holdSubscribe: true });
  const b = ++rawId;
  const failing = subscribe(b);
  await rejected.subscribed;
  const nothing = unsubscribe(b);
  assert.equal(await isSettled(nothing), false);
  rejected.rejectSubscribe("Not a directory");
  const failure = await failing;
  assert.throws(() => decodeWatchOutcome(failure), AnsweredWatchFailure);
  assert.deepEqual((await nothing).json, {});
  assert.equal(rejected.unsubscribes, 0, "nothing went live");
  assert.deepEqual(inProcessWorkerWatchesForTests().subscriptions, []);
});

test("a native subscribe failure is an answer carrying parcel's message", async () => {
  const answer = await subscribe(++rawId, file);
  assert.deepEqual(answer.json, { error: {} });
  assert.throws(
    () => decodeWatchOutcome(answer),
    (error: unknown) =>
      error instanceof AnsweredWatchFailure &&
      error.message === "Not a directory",
  );
  assert.deepEqual(inProcessWorkerWatchesForTests().subscriptions, []);
});

test("a real native subscription delivers its events and is released", async () => {
  const id = ++rawId;
  assert.deepEqual((await subscribe(id)).json, {});
  assert.deepEqual(
    inProcessWorkerWatchesForTests().subscriptions.map((watch) => watch.id),
    [id],
  );
  writeFileSync(join(dir, "seen.txt"), "x\n");
  await until("a delivery", () => deliveredFor(id).length > 0);
  assert.deepEqual((await unsubscribe(id)).json, {});
  assert.deepEqual(inProcessWorkerWatchesForTests().subscriptions, []);
});

/** A link to `dir`, and the event paths a client subscribed through it gets. */
async function subscribeThroughLink(): Promise<{
  alias: string;
  real: string;
  seen: string[];
  handle: Promise<{ unsubscribe(): Promise<void> }>;
}> {
  const real = realpathSync(dir);
  const aliasDir = mkdtempSync(join(tmpdir(), "worker-watch-alias-"));
  aliasDirs.push(aliasDir);
  const alias = join(aliasDir, "a");
  symlinkSync(real, alias);
  const seen: string[] = [];
  const handle = subscribeOnWorker(
    { workerId: DEFAULT_WORKER_ID, path: alias },
    [],
    (err, events) => {
      if (!err) seen.push(...events.map((event) => event.path));
    },
    { onOverflow: () => undefined, onLost: () => undefined },
  );
  return { alias, real, seen, handle };
}

test("a root named through a link is watched natively at its real path, its events spelled as asked", async () => {
  const capture = captureNextNativeWatchForTests();
  const { alias, real, seen, handle } = await subscribeThroughLink();
  assert.equal((await capture.subscribed).path, real);
  const live = await handle;
  capture.emit([real, join(real, "a", "b.txt"), `${real}-sibling/x`, "/else"]);
  await until("the delivery", () => seen.length === 4);
  // Only paths under the real root are respelled; a prefix is not a parent.
  assert.deepEqual(seen, [
    alias,
    join(alias, "a", "b.txt"),
    `${real}-sibling/x`,
    "/else",
  ]);
  await live.unsubscribe();
});

test("a real native subscription through a link reports paths under the link", async () => {
  // macOS FSEvents names real paths whatever was subscribed (`/var` is
  // `/private/var`); a consumer relates events to the root it asked for.
  const { alias, seen, handle } = await subscribeThroughLink();
  const live = await handle;
  writeFileSync(join(alias, "through-link.txt"), "x\n");
  await until("the file's event", () =>
    seen.includes(join(alias, "through-link.txt")),
  );
  assert.ok(
    seen.every((path) => path === alias || path.startsWith(`${alias}/`)),
    seen.join("\n"),
  );
  await live.unsubscribe();
});

test("a failed native unsubscribe before any end answers failure and keeps delivering", async () => {
  const capture = captureNextNativeWatchForTests({
    rejectUnsubscribeOnce: true,
  });
  const id = ++rawId;
  await subscribe(id);
  const failed = await unsubscribe(id);
  assert.throws(() => decodeWatchOutcome(failed), AnsweredWatchFailure);
  assert.equal(inProcessWorkerWatchesForTests().subscriptions.length, 1);
  capture.emit(["/still/delivered"]);
  await until("the kept delivery", () => deliveredFor(id).length === 1);
  assert.deepEqual((await unsubscribe(id)).json, {});
  assert.equal(capture.unsubscribes, 2);
});

test("after end, a failed native release retries and `released` waits for it", async () => {
  const previous = setWatchReleaseRetryMsForTests(10);
  try {
    const capture = captureNextNativeWatchForTests({
      rejectUnsubscribeOnce: true,
    });
    await subscribe(++rawId);
    const { released } = inProcessWorkerWatchesForTests();
    // The retry's clock is the test's: under load real 10 ms pass while the
    // checks below run. Only timers are faked; immediates and microtasks,
    // which carry the release itself, stay real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      writeAsInProcessWorkerForTests(INVALID_FRAME);
      await turnsUntil(
        "the first release and its armed retry",
        () => capture.unsubscribes === 1 && vi.getTimerCount() === 1,
      );
      assert.equal(await isSettled(released), false, "retry still owed");
      vi.advanceTimersByTime(9);
      assert.equal(await isSettled(released), false, "not before its delay");
      assert.equal(capture.unsubscribes, 1);
      vi.advanceTimersByTime(1);
      await released;
      assert.equal(capture.unsubscribes, 2);
    } finally {
      // A failure above still lets the owed retry run, so teardown can end.
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  } finally {
    setWatchReleaseRetryMsForTests(previous);
  }
});

test("one delivery in flight per subscription; the queue keeps batch boundaries", async () => {
  const capture = captureNextNativeWatchForTests();
  const id = ++rawId;
  await subscribe(id);
  const release = holdWatchDeliveriesForTests();
  try {
    capture.emit(["/a", "/b"]);
    await until("the first delivery", () => deliveredFor(id).length === 1);
    capture.emit(["/c", "/d", "/e"]);
    capture.emitError("callback failed");
    capture.emit(["/f"]);
    await settle();
    assert.equal(deliveredFor(id).length, 1, "one in flight");
    assert.deepEqual(inProcessWorkerWatchesForTests().subscriptions, [
      { id, inFlight: true, queuedPaths: 5, overflow: false },
    ]);
  } finally {
    release();
  }
  await until("the queued delivery", () => deliveredFor(id).length === 2);
  assert.deepEqual(
    deliveredFor(id).map(({ batchCounts, overflow }) => ({
      batchCounts,
      overflow,
    })),
    [
      { batchCounts: [2], overflow: false },
      { batchCounts: [3, 1, 1], overflow: false },
    ],
  );
});

test("a queue above its bound collapses into one overflow marker", async () => {
  const previous = setWatchQueueBoundForTests(10);
  try {
    const capture = captureNextNativeWatchForTests();
    const id = ++rawId;
    await subscribe(id);
    const release = holdWatchDeliveriesForTests();
    const watch = () => inProcessWorkerWatchesForTests().subscriptions[0]!;
    try {
      capture.emit(["/in-flight"]);
      await until("the first delivery", () => deliveredFor(id).length === 1);
      capture.emit(["/1", "/2", "/3", "/4"]);
      capture.emit(["/5", "/6", "/7", "/8"]);
      assert.deepEqual(
        { queuedPaths: watch().queuedPaths, overflow: watch().overflow },
        { queuedPaths: 8, overflow: false },
      );
      capture.emit(["/9", "/10", "/11", "/12"]);
      assert.deepEqual(
        { queuedPaths: watch().queuedPaths, overflow: watch().overflow },
        { queuedPaths: 0, overflow: true },
      );
      capture.emit(["/absorbed"]);
      assert.equal(watch().queuedPaths, 0);
    } finally {
      release();
    }
    await until("the overflow", () => deliveredFor(id).length === 2);
    assert.deepEqual(
      deliveredFor(id).map(({ batchCounts, overflow }) => ({
        batchCounts,
        overflow,
      })),
      [
        { batchCounts: [1], overflow: false },
        { batchCounts: [], overflow: true },
      ],
    );
    assert.equal(watch().overflow, false, "the marker was delivered");
  } finally {
    setWatchQueueBoundForTests(previous);
  }
});

test("a Worker on a 1.3 handler table answers watch.subscribe unknown_method and stays open", async () => {
  const [serverEnd, workerEnd] = createInProcessTransport();
  const server = new WorkerConnection(serverEnd, {
    handshake: { role: "server", admit: () => undefined },
  });
  const worker = new WorkerConnection(workerEnd, {
    handshake: { role: "worker", workerId: "w" },
    handlers: fileHandlers("w").handlers,
  });
  try {
    await assert.rejects(
      server.request(
        WATCH_METHODS.subscribe,
        encodeSubscribe({ workerId: "w", id: 1, path: dir, ignore: [] }),
      ),
      refusedWith(UNKNOWN_METHOD),
    );
    assert.equal(server.isEnded, false);
    const answer = await server.request(FILE_METHODS.exists, {
      json: { location: { workerId: "w", path: dir } },
    });
    assert.deepEqual(answer.json, { exists: true });
  } finally {
    server.end("test over");
    worker.end("test over");
  }
});

test("ending the connection drops queues and stops deliveries", async () => {
  const capture = captureNextNativeWatchForTests();
  const id = ++rawId;
  await subscribe(id);
  const epoch = inProcessWorkerEpochForTests();
  const release = holdWatchDeliveriesForTests();
  try {
    capture.emit(["/first"]);
    await until("the first delivery", () => deliveredFor(id).length === 1);
    capture.emit(["/queued"]);
    const { released } = inProcessWorkerWatchesForTests();
    writeAsInProcessWorkerForTests(INVALID_FRAME);
    await released;
    capture.emit(["/after"]);
    assert.equal(capture.unsubscribes, 1);
  } finally {
    release();
  }
  ensureInProcessWorker();
  await settle();
  assert.equal(deliveredFor(id).length, 1, "nothing delivered after end");
  assert.equal(inProcessWorkerEpochForTests(), epoch! + 1);
});
