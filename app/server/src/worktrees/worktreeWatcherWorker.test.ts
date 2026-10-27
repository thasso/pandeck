/**
 * The worktree watcher's subscriptions and reads on the in-process Worker
 * (`docs/workers.md`, "Watches"): real git repos, the real Worker, codec and
 * native watcher. Only one-shot substitutes, holds and counters stand in, as
 * the watch client's own tests use them.
 *
 * Its own file: a test here ends the Worker connection, which every live
 * subscription of the module would recover from.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import type { ServerMessage } from "@assistant/shared";
import type { Payload } from "../workerProtocol/codec.ts";

const tmp = mkdtempSync(join(tmpdir(), "worktree-watcher-worker-test-"));
process.env.ASSISTANT_CWD = tmp;

const { createWorktree, removeWorktree } = await import("./worktrees.ts");
const {
  addWorktreeViewer,
  endTreeLingersForTests,
  fireRepoRetriesForTests,
  fireTreeRetriesForTests,
  gitDirIgnoreForTests,
  onWorktreeGitStateChange,
  registerWorktree,
  removeWorktreeViewer,
  repoActivityForTests,
  setTreeWatchLimitsForTests,
  treeActivityForTests,
  treeWatchLiveForTests,
  unregisterWorktree,
} = await import("./worktreeWatcher.ts");
const { default: parcelWatcher } = await import("../parcelWatcher.ts");
const { checkoutFailureOf, throwInCheckoutReadForTests } =
  await import("../checkoutFileAccess.ts");
const { DEFAULT_WORKER_ID, DEFAULT_WORKER_SIDE } =
  await import("../workers/placement.ts");
const { getWorktree } = await import("../db/worktreeStore.ts");
const { projectStore } = await import("../db/projectStore.ts");
const { setWorktreeBroadcaster } = await import("./worktreeEvents.ts");
const {
  answerNextInProcessWorkerCallForTests,
  ensureInProcessWorker,
  inProcessWorkerEpochForTests,
  inProcessWorkerFileHandlesForTests,
  inProcessWorkerQuiescentForTests,
  inProcessWorkerServedMethodForTests,
  inProcessWorkerWatchesForTests,
  writeAsInProcessWorkerForTests,
} = await import("../workers/inProcessWorker.ts");
const {
  holdWatchDeliveriesForTests,
  recordWatchDeliveriesForTests,
  watchesOn,
} = await import("../workers/watchDeliveries.ts");
const { isWorkerFailure, openOnWorker } =
  await import("../workers/fileClient.ts");
const {
  captureNextNativeWatchForTests,
  holdNativeUnsubscribeForTests,
  setWatchQueueBoundForTests,
  setWatchReleaseRetryMsForTests,
} = await import("../worker/watch.ts");
const { CHECKOUT_GIT_METHODS } =
  await import("../workerProtocol/checkoutMethods.ts");
const { FILE_METHODS, encodeFailure } =
  await import("../workerProtocol/fileMethods.ts");
const { WATCH_METHODS } = await import("../workerProtocol/watchMethods.ts");
const { UNKNOWN_METHOD, WorkerMethodError } =
  await import("../workerProtocol/connection.ts");

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  );
}

const broadcasts: ServerMessage[] = [];
setWorktreeBroadcaster({
  broadcast: (msg) => {
    broadcasts.push(msg);
  },
  broadcastWorktree: (_id, msg) => {
    broadcasts.push(msg);
  },
});

const heads: Array<{ id: string; head: string }> = [];
onWorktreeGitStateChange((id, head) => heads.push({ id, head }));

let projects = 0;

/** A fresh repo and project; its repo has no watch yet. */
function project(name: string): { id: string; repo: string; gitDir: string } {
  const repo = join(tmp, name);
  mkdirSync(repo, { recursive: true });
  sh(repo, "init", "-b", "main");
  writeFileSync(join(repo, "readme.md"), "hello\n");
  writeFileSync(join(repo, "f2.txt"), "two\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-m", "init");
  const now = new Date().toISOString();
  projectStore.put({
    id: name,
    name,
    // Keys are letters only, one per project.
    key: `WW${String.fromCharCode(65 + Math.floor(projects / 26), 65 + (projects++ % 26))}`,
    description: "",
    status: "active",
    localPaths: [{ path: repo, kind: "repo", match: "prefix" }],
    worktreeRoot: join(tmp, `${name}-worktrees`),
    createdAt: now,
    updatedAt: now,
  });
  return { id: name, repo, gitDir: join(repo, ".git") };
}

/**
 * Wait for `check` by event-loop turns, never by the clock: AC14 freezes
 * `Date`.
 */
async function until(what: string, check: () => boolean): Promise<void> {
  for (let i = 0; i < 4_000; i += 1) {
    if (check()) return;
    await new Promise<void>((done) => setTimeout(done, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** Records when `promise` settles, and how. */
function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = {
    settled: false,
  };
  void promise.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error: unknown) => Object.assign(state, { settled: true, error }),
  );
  return state;
}

const served = (method: string) => inProcessWorkerServedMethodForTests(method);
const INVALID_FRAME = new Uint8Array(8);

/**
 * End the Worker connection. The old Worker's release and quiescence are
 * read BEFORE the end: the next request dials a new Worker.
 */
function endConnection() {
  const connection = ensureInProcessWorker();
  const { released } = inProcessWorkerWatchesForTests();
  const quiescent = inProcessWorkerQuiescentForTests();
  writeAsInProcessWorkerForTests(INVALID_FRAME);
  return { ended: connection.ended, released, quiescent };
}

/** The epoch of an open connection, dialing one if needed. */
async function connectedEpoch(): Promise<number> {
  ensureInProcessWorker();
  await until(
    "the handshake",
    () => inProcessWorkerEpochForTests() !== undefined,
  );
  return inProcessWorkerEpochForTests()!;
}

/**
 * Native parcel subscriptions of `paths`: made, live and at most live. Wraps
 * the real call, which the Worker makes through the same module object.
 */
function nativeWatches(...paths: string[]) {
  const original = parcelWatcher.subscribe.bind(parcelWatcher);
  const count = { made: new Map<string, number>(), live: 0, maxLive: 0 };
  vi.spyOn(parcelWatcher, "subscribe").mockImplementation(
    async (dir, callback, options) => {
      const subscription = await original(dir, callback, options);
      if (!paths.includes(dir)) return subscription;
      count.made.set(dir, (count.made.get(dir) ?? 0) + 1);
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

/** A native capture that is released after the test, whatever happened. */
function capture(
  options?: Parameters<typeof captureNextNativeWatchForTests>[0],
) {
  const native = captureNextNativeWatchForTests(options);
  cleanups.push(() => native.releaseSubscribe());
  return native;
}

type Substitute = Parameters<typeof answerNextInProcessWorkerCallForTests>[1];

/**
 * Serve every `method` request through `handle` until stopped; `handle`
 * answers undefined to let the real handler serve it. Re-arms the one-shot
 * substitute on every call, so unrelated requests pass through.
 */
function intercept(
  method: string,
  handle: (...args: Parameters<Substitute>) => Promise<Payload> | undefined,
): () => void {
  let stopped = false;
  let disarm = () => {};
  const arm = () => {
    disarm = answerNextInProcessWorkerCallForTests(
      method,
      (payload, signal, real) => {
        if (!stopped) arm();
        return (
          (stopped ? undefined : handle(payload, signal, real)) ??
          real(payload, signal)
        );
      },
    );
  };
  arm();
  return () => {
    stopped = true;
    disarm();
  };
}

/** A file method's path. */
function pathOf(payload: Payload): string | undefined {
  const json = payload.json as { location?: { path?: unknown } } | undefined;
  return typeof json?.location?.path === "string"
    ? json.location.path
    : undefined;
}

/** The next `method` request for `path` fails as `how`; others are real. */
function failFileCallOnce(
  method: string,
  path: string,
  how: "refused" | "malformed" | "answered",
): { hits: () => number } {
  let hits = 0;
  const stop = intercept(method, (payload) => {
    if (pathOf(payload) !== path) return undefined;
    hits += 1;
    stop();
    if (how === "refused") return Promise.reject(new Error("refused"));
    if (how === "malformed") return Promise.resolve({ json: { bogus: 1 } });
    return Promise.resolve(
      encodeFailure(
        Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        }),
        // An open's failure names the step that failed.
        method === FILE_METHODS.open ? { phase: "open" } : {},
      ),
    );
  });
  cleanups.push(stop);
  return { hits: () => hits };
}

function warnings() {
  const seen: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    seen.push(args.map(String).join(" "));
  });
  return seen;
}

const statusOf = (id: string) =>
  broadcasts.filter(
    (msg): msg is Extract<ServerMessage, { type: "worktreeStatus" }> =>
      msg.type === "worktreeStatus" && msg.status.worktreeId === id,
  );
const changesOf = (id: string) =>
  broadcasts.filter(
    (msg): msg is Extract<ServerMessage, { type: "worktreeChanges" }> =>
      msg.type === "worktreeChanges" && msg.changes.worktreeId === id,
  );
const changed = (id: string, file: string) =>
  changesOf(id).some((msg) =>
    msg.changes.files.some((entry) => entry.path === file),
  );

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A spawned worktree of `projectId`, removed after the test. */
async function worktree(projectId: string, name: string) {
  const record = await createWorktree({ projectId, name });
  cleanups.push(async () => {
    removeWorktreeViewer(record.id);
    await removeWorktree(record.id, { force: true, deleteBranch: true });
  });
  return record;
}

function limits(next: Parameters<typeof setTreeWatchLimitsForTests>[0]) {
  const previous = setTreeWatchLimitsForTests(next);
  cleanups.push(() => setTreeWatchLimitsForTests(previous));
}

function recorder() {
  const recording = recordWatchDeliveriesForTests();
  cleanups.push(() => recording.stop());
  return recording;
}

const settled = (id: string) => treeActivityForTests(id)?.settlesPending === 0;

// --- AC1 ------------------------------------------------------------------

test("AC1: a spawned worktree's git dir and tree are subscribed on the Worker", async () => {
  const { id } = project("ac1");
  const deliveries = recorder();
  const subscribes = served(WATCH_METHODS.subscribe);
  const live = inProcessWorkerWatchesForTests().subscriptions.length;

  const record = await worktree(id, "ac1-wt");
  assert.equal(served(WATCH_METHODS.subscribe), subscribes + 1);
  assert.equal(inProcessWorkerWatchesForTests().subscriptions.length, live + 1);

  await addWorktreeViewer(record.id);
  assert.equal(served(WATCH_METHODS.subscribe), subscribes + 2);
  assert.equal(inProcessWorkerWatchesForTests().subscriptions.length, live + 2);

  const before = deliveries.records().length;
  writeFileSync(join(record.path, "edited.txt"), "x\n");
  await until("the edit's changes", () => changed(record.id, "edited.txt"));
  assert.ok(deliveries.records().length > before, "delivered as watch.events");
});

// --- AC6 ------------------------------------------------------------------

test("AC6 tree: an overflow is a bulk batch: one scan, a fresh ignore read", async () => {
  const { id } = project("ac6tree");
  const previousBound = setWatchQueueBoundForTests(10);
  cleanups.push(() => setWatchQueueBoundForTests(previousBound));
  limits({ ignoreRefreshMs: 0 });
  const record = await worktree(id, "ac6-tree");
  assert.ok(repoActivityForTests(record.id), "the repo watch is ready");

  const native = capture();
  await addWorktreeViewer(record.id);
  assert.equal((await native.subscribed).path, record.path);
  await until("the view's settles", () => settled(record.id));
  const scans = treeActivityForTests(record.id)!.scansScheduled;
  broadcasts.length = 0;

  // The substitute sees nothing, and no git-dir path changes.
  writeFileSync(join(record.path, "f2.txt"), "changed\n");

  // The ignore reads after the overflow, counted at the Worker.
  let ignoreReads = 0;
  cleanups.push(
    intercept(CHECKOUT_GIT_METHODS.run, (payload) => {
      if (JSON.stringify(payload.json).includes("--ignored")) ignoreReads += 1;
      return undefined;
    }),
  );
  const deliveries = recorder();
  const release = holdWatchDeliveriesForTests();
  cleanups.push(release);
  native.emit([join(record.path, ".git", "index")]);
  await until("the filtered delivery", () => deliveries.records().length === 1);
  const watchId = deliveries.records()[0]!.id;
  const snapshot = () =>
    inProcessWorkerWatchesForTests().subscriptions.find(
      (watch) => watch.id === watchId,
    )!;
  assert.equal(snapshot().inFlight, true);

  const paths = (prefix: string) =>
    [1, 2, 3, 4].map((n) => join(record.path, `${prefix}${n}.txt`));
  native.emit(paths("a"));
  native.emit(paths("b"));
  assert.deepEqual(
    { overflow: snapshot().overflow, queuedPaths: snapshot().queuedPaths },
    { overflow: false, queuedPaths: 8 },
  );
  native.emit(paths("c"));
  assert.equal(snapshot().overflow, true);
  release();

  await until("the overflow", () => deliveries.records().length === 2);
  assert.deepEqual(deliveries.records(), [
    { id: watchId, batchCounts: [1], overflow: false },
    { id: watchId, batchCounts: [], overflow: true },
  ]);
  await until("the overflow's scan", () => changed(record.id, "f2.txt"));
  assert.equal(treeActivityForTests(record.id)!.scansScheduled, scans + 1);
  // The overflow marked the ignore set stale: re-read after the scan.
  await until("the ignore re-read", () => ignoreReads > 0);
  await until("its settle", () => settled(record.id));
  assert.equal(treeActivityForTests(record.id)!.scansScheduled, scans + 1);

  const porcelain = sh(record.path, "status", "--porcelain")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3))
    .sort();
  const last = changesOf(record.id).at(-1)!;
  assert.deepEqual(
    last.changes.files.map((file) => file.path).sort(),
    porcelain,
  );
  assert.equal(statusOf(record.id).at(-1)?.status.dirty, true);
});

test("AC6 repo: an overflow rescans every row of the repo in full", async () => {
  const { id, gitDir } = project("ac6repo");
  const previousBound = setWatchQueueBoundForTests(10);
  cleanups.push(() => setWatchQueueBoundForTests(previousBound));
  const native = capture();
  const first = await worktree(id, "ac6-first");
  assert.equal((await native.subscribed).path, gitDir);
  const second = await worktree(id, "ac6-second");
  assert.ok(repoActivityForTests(second.id));
  const rescans = repoActivityForTests(first.id)!.fullRescans;
  broadcasts.length = 0;
  heads.length = 0;

  // The substitute sees nothing of the commit.
  sh(second.path, "commit", "--allow-empty", "-m", "unseen");
  const head = sh(second.path, "rev-parse", "HEAD").trim();
  assert.equal(repoActivityForTests(first.id)!.fullRescans, rescans);

  const deliveries = recorder();
  const release = holdWatchDeliveriesForTests();
  cleanups.push(release);
  native.emit([join(gitDir, "objects", "ab", "cdef")]);
  await until("the filtered delivery", () => deliveries.records().length === 1);
  const paths = (prefix: string) =>
    [1, 2, 3, 4].map((n) => join(gitDir, "refs", "heads", `${prefix}${n}`));
  native.emit(paths("a"));
  native.emit(paths("b"));
  native.emit(paths("c"));
  release();

  await until("the overflow", () => deliveries.records().length === 2);
  assert.equal(deliveries.records()[1]!.overflow, true);
  assert.equal(repoActivityForTests(first.id)!.fullRescans, rescans + 1);
  await until(
    "both rows' statuses",
    () =>
      statusOf(first.id).length > 0 &&
      statusOf(second.id).some((msg) => msg.status.head === head.slice(0, 12)),
  );
  await until("the listener", () => heads.length > 0);
  assert.deepEqual(heads, [{ id: second.id, head }]);
});

// --- AC7 ------------------------------------------------------------------

test("AC7: a connection end loses the watches after the release, then recovers at once", async () => {
  const { id, gitDir } = project("ac7");
  limits({ maxWatches: 1 });
  const holder = await worktree(id, "ac7-holder");
  const waiter = await worktree(id, "ac7-waiter");
  const native = nativeWatches(holder.path, waiter.path);
  // The later view ranks first: the waiter is viewed first.
  await addWorktreeViewer(waiter.id);
  const viewedAt = Date.now();
  await until("a later instant", () => Date.now() > viewedAt);
  await addWorktreeViewer(holder.id);
  await until(
    "the slot moved",
    () => native.made.get(holder.path) === 1 && native.live === 1,
  );
  assert.equal(await treeWatchLiveForTests(holder.id), true);
  assert.equal(await treeWatchLiveForTests(waiter.id), false);

  const epoch = await connectedEpoch();
  const subscribes = served(WATCH_METHODS.subscribe);
  const gitDirSubscribes = () =>
    vi
      .mocked(parcelWatcher.subscribe)
      .mock.calls.filter((call) => call[0] === gitDir).length;
  const repoBefore = gitDirSubscribes();
  const release = holdNativeUnsubscribeForTests();
  cleanups.push(release);
  const end = endConnection();
  const released = track(end.released);
  await end.ended;

  // Held: nothing is lost, nothing resubscribes, the waiter stays out.
  assert.equal(released.settled, false);
  assert.equal(treeActivityForTests(holder.id)!.recoveries, 0);
  assert.equal(repoActivityForTests(holder.id)!.recoveries, 0);
  assert.equal(served(WATCH_METHODS.subscribe), subscribes);
  assert.ok(native.maxLive <= 1);

  // The gap: an edit and a commit nobody watches.
  writeFileSync(join(holder.path, "gap.txt"), "gap\n");
  sh(holder.path, "commit", "--allow-empty", "-m", "gap commit");
  const head = sh(holder.path, "rev-parse", "HEAD").trim();
  broadcasts.length = 0;
  heads.length = 0;
  release();
  await end.released;

  await until(
    "both tiers recovered",
    () =>
      treeActivityForTests(holder.id)!.recoveries === 1 &&
      repoActivityForTests(holder.id)!.recoveries === 1,
  );
  assert.equal(inProcessWorkerEpochForTests(), epoch + 1);
  assert.equal(served(WATCH_METHODS.subscribe), subscribes + 2);
  assert.equal(gitDirSubscribes(), repoBefore + 1);
  assert.equal(treeActivityForTests(holder.id)!.retryArmed, false);
  assert.equal(repoActivityForTests(holder.id)!.retryArmed, false);
  await until(
    "the full rescan",
    () => statusOf(holder.id).length > 0 && statusOf(waiter.id).length > 0,
  );
  await until("the listener", () => heads.some((seen) => seen.head === head));
  await until("the gap edit", () => changed(holder.id, "gap.txt"));
  assert.ok(native.maxLive <= 1, "never above the cap");
  assert.equal(await treeWatchLiveForTests(waiter.id), false);

  writeFileSync(join(holder.path, "after.txt"), "after\n");
  await until("later edits", () => changed(holder.id, "after.txt"));
});

// --- AC8 / AC8b -----------------------------------------------------------

/** A held checkout git request that settles only when its handler aborts. */
function heldGit() {
  answerNextInProcessWorkerCallForTests(
    CHECKOUT_GIT_METHODS.run,
    async (_payload, signal) => {
      await new Promise<void>((done) =>
        signal.addEventListener("abort", () => done(), { once: true }),
      );
      throw new Error("git aborted");
    },
  );
  return track(
    ensureInProcessWorker().request(CHECKOUT_GIT_METHODS.run, { json: {} }),
  );
}

async function openFileOn(path: string): Promise<void> {
  const outcome = await openOnWorker(
    { workerId: DEFAULT_WORKER_ID, path },
    false,
  );
  assert.ok(!("error" in outcome));
  assert.equal(inProcessWorkerFileHandlesForTests(), 1);
}

test("AC8: a held watch.unsubscribe holds neither git rejection nor the file sweep", async () => {
  const { id, repo } = project("ac8");
  const record = await worktree(id, "ac8-wt");
  await addWorktreeViewer(record.id);
  assert.equal(await treeWatchLiveForTests(record.id), true);

  const release = holdNativeUnsubscribeForTests();
  cleanups.push(release);
  const unsubscribes = served(WATCH_METHODS.unsubscribe);
  removeWorktreeViewer(record.id);
  endTreeLingersForTests();
  await until(
    "the tree's watch.unsubscribe",
    () => served(WATCH_METHODS.unsubscribe) === unsubscribes + 1,
  );
  assert.ok(treeActivityForTests(record.id)!.settlesPending > 0);

  const git = heldGit();
  await openFileOn(join(repo, "readme.md"));
  const end = endConnection();
  const released = track(end.released);
  await end.quiescent;
  await until("git rejected", () => git.settled);
  assert.match(String(git.error), /ended/);
  assert.equal(inProcessWorkerFileHandlesForTests(), 0);
  assert.equal(released.settled, false);
  assert.ok(
    treeActivityForTests(record.id)!.settlesPending > 0,
    "the tree's unsubscribe is still pending",
  );

  release();
  await end.released;
  await until("the release settled", () => !treeActivityForTests(record.id));
  assert.equal(await treeWatchLiveForTests(record.id), false);
});

test("AC8b: a held native subscribe holds neither git rejection nor the file sweep", async () => {
  const { id, repo } = project("ac8b");
  const record = await worktree(id, "ac8b-wt");
  const native = capture({ holdSubscribe: true });
  const viewing = addWorktreeViewer(record.id);
  await native.subscribed;
  const batches = treeActivityForTests(record.id)!.eventBatches;

  const git = heldGit();
  await openFileOn(join(repo, "readme.md"));
  const end = endConnection();
  const released = track(end.released);
  await end.quiescent;
  await until("git rejected", () => git.settled);
  assert.match(String(git.error), /ended/);
  assert.equal(inProcessWorkerFileHandlesForTests(), 0);
  assert.equal(released.settled, false);
  assert.ok(treeActivityForTests(record.id)!.settlesPending > 0);
  assert.equal(treeActivityForTests(record.id)!.retryArmed, false);

  // The orphan delivers nothing, and is released once its subscribe lands.
  native.emit([join(record.path, "orphan.txt")]);
  native.releaseSubscribe();
  await end.released;
  assert.equal(native.unsubscribes, 1);
  await until(
    "the tree's backoff",
    () => treeActivityForTests(record.id)!.retryArmed,
  );
  assert.equal(treeActivityForTests(record.id)!.eventBatches, batches);
  await viewing;
});

// --- AC9 ------------------------------------------------------------------

test("AC9 I7: a Worker failure on the presence check retries, never 'missing'", async () => {
  const { id } = project("ac9i7");
  const record = await worktree(id, "ac9-i7");
  const warned = warnings();
  const failed = failFileCallOnce(FILE_METHODS.exists, record.path, "refused");
  await addWorktreeViewer(record.id);
  assert.equal(failed.hits(), 1);
  assert.equal(treeActivityForTests(record.id)!.retryArmed, true);
  assert.equal(await treeWatchLiveForTests(record.id), false);
  assert.ok(!warned.some((line) => line.includes("is missing")));
  fireTreeRetriesForTests();
  await until("the retry subscribed", () => settled(record.id));
  assert.equal(await treeWatchLiveForTests(record.id), true);
});

test("AC9 I4: a Worker failure or an unclassified error on the .git pointer leaves the row out", async () => {
  const { id } = project("ac9i4");
  // A sibling keeps the repo watch while the row is re-registered.
  await worktree(id, "ac9-i4-sibling");
  const record = await worktree(id, "ac9-i4");
  const row = getWorktree(record.id)!;
  const pointer = join(row.path, ".git");

  for (const fail of [
    () => failFileCallOnce(FILE_METHODS.open, pointer, "refused"),
    () =>
      throwInCheckoutReadForTests(new TypeError("sentinel"), { at: "read" }),
  ]) {
    await unregisterWorktree(row.id);
    assert.equal(repoActivityForTests(row.id), undefined);
    fail();
    const error = await registerWorktree(row).then(
      () => undefined,
      (err: unknown) => err,
    );
    assert.ok(error, "registerWorktree rejects");
    assert.ok(
      isWorkerFailure(error) ||
        (error instanceof TypeError && error.message === "sentinel"),
    );
    assert.equal(repoActivityForTests(row.id), undefined, "the row is out");
  }

  // An answered failure is base's main-checkout fallback: the row joins.
  failFileCallOnce(FILE_METHODS.open, pointer, "answered");
  await registerWorktree(row);
  assert.ok(repoActivityForTests(row.id));
});

/**
 * Hold the next `.git` pointer read of `path` after the Worker answered it,
 * until `release`.
 */
function holdPointerRead(path: string) {
  const pointer = join(path, ".git");
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const held = new Promise<void>((resolve) => (entered = resolve));
  const stop = intercept(FILE_METHODS.open, (payload, signal, real) => {
    if (pathOf(payload) !== pointer) return undefined;
    stop();
    return real(payload, signal).then(async (answer) => {
      entered();
      await gate;
      return answer;
    });
  });
  cleanups.push(() => {
    stop();
    release();
  });
  return { held, release: () => release() };
}

test("I4 removal: a pointer read pending past a row's removal never brings it back", async () => {
  const { id, gitDir } = project("i4removed");
  const native = nativeWatches(gitDir);
  const a = await createWorktree({ projectId: id, name: "i4-removed-a" });
  const b = await createWorktree({ projectId: id, name: "i4-removed-b" });
  assert.equal(native.live, 1);

  const read = holdPointerRead(a.path);
  const viewing = addWorktreeViewer(a.id);
  await read.held;
  await removeWorktree(a.id, { force: true, deleteBranch: true });
  assert.equal(repoActivityForTests(a.id), undefined);
  read.release();
  await viewing;
  assert.equal(repoActivityForTests(a.id), undefined, "a stays removed");
  assert.ok(repoActivityForTests(b.id), "b still holds the repo watch");
  assert.equal(native.live, 1);

  await removeWorktree(b.id, { force: true, deleteBranch: true });
  assert.equal(native.live, 0, "the last removal releases the git-dir watch");
});

test("I4 removal: the last row's removal waits for a sibling still joining", async () => {
  const { id, gitDir } = project("i4joining");
  const native = nativeWatches(gitDir);
  const a = await createWorktree({ projectId: id, name: "i4-joining-a" });
  const b = await createWorktree({ projectId: id, name: "i4-joining-b" });
  const rowB = getWorktree(b.id)!;
  await unregisterWorktree(b.id);
  assert.equal(native.live, 1);

  const read = holdPointerRead(b.path);
  const joining = registerWorktree(rowB);
  await read.held;
  await removeWorktree(a.id, { force: true, deleteBranch: true });
  assert.equal(native.live, 1, "b's pending join keeps the watch");
  read.release();
  await joining;
  assert.ok(repoActivityForTests(b.id), "b joined the live repo watch");
  assert.equal(native.live, 1);

  await removeWorktree(b.id, { force: true, deleteBranch: true });
  assert.equal(native.live, 0);
});

test("I4 removal: a first join that fails leaves no repo watch behind", async () => {
  const { id, gitDir } = project("i4failed");
  const native = nativeWatches(gitDir);
  const record = await createWorktree({ projectId: id, name: "i4-failed" });
  const row = getWorktree(record.id)!;
  await unregisterWorktree(record.id);
  assert.equal(native.live, 0);

  failFileCallOnce(FILE_METHODS.open, join(row.path, ".git"), "refused");
  const error = await registerWorktree(row).then(
    () => undefined,
    (err: unknown) => err,
  );
  assert.ok(isWorkerFailure(error), "the Worker failure still rejects");
  assert.equal(repoActivityForTests(record.id), undefined, "the row is out");
  assert.equal(native.live, 0, "nothing holds the git-dir watch");

  await registerWorktree(row);
  assert.ok(repoActivityForTests(record.id));
  assert.equal(native.live, 1);
  await removeWorktree(record.id, { force: true, deleteBranch: true });
  assert.equal(native.live, 0);
});

test("AC9 I5: a Worker failure on a linked admin dir fails the scan, with no broadcast", async () => {
  const { id, gitDir } = project("ac9i5");
  const native = capture();
  const record = await worktree(id, "ac9-i5");
  await native.subscribed;
  const warned = warnings();
  failFileCallOnce(
    FILE_METHODS.exists,
    join(gitDir, "worktrees", "ghost"),
    "refused",
  );
  broadcasts.length = 0;
  native.emit([join(gitDir, "worktrees", "ghost", "HEAD")]);
  await until("the scan failed", () =>
    warned.some((line) => line.includes("repo scan failed")),
  );
  assert.equal(statusOf(record.id).length, 0);
});

for (const [read, method, how] of [
  ["I2 presence", FILE_METHODS.exists, "refused"],
  ["I2 presence", FILE_METHODS.exists, "malformed"],
  ["I3 readdir", FILE_METHODS.readdir, "refused"],
  ["I3 readdir", FILE_METHODS.readdir, "malformed"],
  ["I3 HEAD inspect", FILE_METHODS.inspect, "refused"],
] as const)
  test(`AC9 ${read}, ${how}: arms the git-dir watch's retry`, async () => {
    const name = `ac9-${method.replace(".", "")}-${how}`;
    const { id, gitDir } = project(name.replace(/-/g, ""));
    mkdirSync(join(gitDir, "modules", "sub"), { recursive: true });
    writeFileSync(join(gitDir, "modules", "sub", "HEAD"), "ref: x\n");
    const target =
      method === FILE_METHODS.exists
        ? gitDir
        : method === FILE_METHODS.readdir
          ? join(gitDir, "modules")
          : join(gitDir, "modules", "sub", "HEAD");
    const failed = failFileCallOnce(method, target, how);
    const subscribes = served(WATCH_METHODS.subscribe);
    const record = await worktree(id, name);
    assert.equal(failed.hits(), 1);
    assert.equal(served(WATCH_METHODS.subscribe), subscribes);
    const repo = repoActivityForTests(record.id)!;
    assert.equal(repo.retryArmed, true);
    assert.equal(repo.retryMs, 5_000);
    fireRepoRetriesForTests();
    await until(
      "the retry subscribed",
      () => repoActivityForTests(record.id)!.recoveries === 1,
    );
    assert.equal(served(WATCH_METHODS.subscribe), subscribes + 1);
    assert.equal(
      repoActivityForTests(record.id)!.fullRescans,
      repo.fullRescans + 1,
    );
  });

test("AC9 category 2: an unreadable dir is an empty walk, an unreadable HEAD no file", async () => {
  const { gitDir } = project("ac9cat2");
  mkdirSync(join(gitDir, "modules", "sub"), { recursive: true });
  writeFileSync(join(gitDir, "modules", "sub", "HEAD"), "ref: x\n");
  assert.deepEqual(
    (await gitDirIgnoreForTests(DEFAULT_WORKER_SIDE, gitDir)).sort(),
    ["lfs", "modules/sub/objects", "objects"],
  );
  failFileCallOnce(FILE_METHODS.readdir, join(gitDir, "modules"), "answered");
  assert.deepEqual(
    (await gitDirIgnoreForTests(DEFAULT_WORKER_SIDE, gitDir)).sort(),
    ["lfs", "objects"],
  );
  failFileCallOnce(
    FILE_METHODS.inspect,
    join(gitDir, "modules", "sub", "HEAD"),
    "answered",
  );
  assert.deepEqual(
    (await gitDirIgnoreForTests(DEFAULT_WORKER_SIDE, gitDir)).sort(),
    ["lfs", "objects"],
  );
  // A Worker failure is never an empty walk.
  failFileCallOnce(FILE_METHODS.readdir, join(gitDir, "modules"), "malformed");
  const error = await gitDirIgnoreForTests(DEFAULT_WORKER_SIDE, gitDir).then(
    () => undefined,
    (err: unknown) => err,
  );
  assert.equal(checkoutFailureOf(error), "worker");
});

// --- AC10 -----------------------------------------------------------------

test("AC10: a refused git-dir subscribe is cleaned up, then retried with a full rescan", async () => {
  const { id } = project("ac10refused");
  answerNextInProcessWorkerCallForTests(WATCH_METHODS.subscribe, () =>
    Promise.reject(new Error("refused")),
  );
  const unsubscribes = served(WATCH_METHODS.unsubscribe);
  const record = await worktree(id, "ac10-refused");
  assert.equal(served(WATCH_METHODS.unsubscribe), unsubscribes + 1);
  const repo = repoActivityForTests(record.id)!;
  assert.deepEqual(
    { armed: repo.retryArmed, ms: repo.retryMs, rescans: repo.fullRescans },
    { armed: true, ms: 5_000, rescans: 0 },
  );
  fireRepoRetriesForTests();
  await until(
    "the retry subscribed",
    () => repoActivityForTests(record.id)!.recoveries === 1,
  );
  assert.equal(repoActivityForTests(record.id)!.fullRescans, 1);

  heads.length = 0;
  sh(record.path, "commit", "--allow-empty", "-m", "seen");
  const head = sh(record.path, "rev-parse", "HEAD").trim();
  await until("the commit", () => heads.some((seen) => seen.head === head));
});

test("AC10: an answered native git-dir failure is logged once and never retried", async () => {
  const { id } = project("ac10answered");
  const warned = warnings();
  const native = capture({ holdSubscribe: true });
  native.rejectSubscribe("Not a directory");
  const unsubscribes = served(WATCH_METHODS.unsubscribe);
  const record = await worktree(id, "ac10-answered");
  const subscribes = served(WATCH_METHODS.subscribe);
  assert.deepEqual(
    warned.filter((line) => line.includes("failed to watch git dir")),
    ["[worktrees] failed to watch git dir: Not a directory"],
  );
  assert.equal(served(WATCH_METHODS.unsubscribe), unsubscribes);
  assert.equal(repoActivityForTests(record.id)!.retryArmed, false);
  fireRepoRetriesForTests();
  await addWorktreeViewer(record.id);
  removeWorktreeViewer(record.id);
  // The view subscribes its tree; the git dir stays unwatched.
  assert.equal(served(WATCH_METHODS.subscribe), subscribes + 1);
});

// --- AC14 -----------------------------------------------------------------

test(
  "AC14: flapping losses back off 5 s doubling to 60 s, one rescan per recovery, reset after 60 s",
  { timeout: 60_000 },
  async () => {
    const { id, gitDir } = project("ac14");
    const record = await worktree(id, "ac14-wt");
    const native = nativeWatches(gitDir, record.path);
    await addWorktreeViewer(record.id);
    await until("the view settled", () => settled(record.id));
    // Only Date: timers, I/O and git stay real, and no retry timer elapses.
    vi.useFakeTimers({ toFake: ["Date"] });
    cleanups.push(() => vi.useRealTimers());
    const t0 = Date.now();
    vi.setSystemTime(t0);
    const scans = treeActivityForTests(record.id)!.scansScheduled;
    const rescans = repoActivityForTests(record.id)!.fullRescans;
    const made = (path: string) => native.made.get(path) ?? 0;
    assert.equal(made(record.path), 1);

    const losses: Array<{ after: number; retryMs?: number }> = [
      { after: 0 },
      { after: 1_000, retryMs: 5_000 },
      { after: 1_000, retryMs: 10_000 },
      { after: 1_000, retryMs: 20_000 },
      { after: 1_000, retryMs: 40_000 },
      { after: 59_999, retryMs: 60_000 },
      { after: 60_000 },
      { after: 1_000, retryMs: 5_000 },
    ];
    let recoveredAt = t0;
    for (const [index, loss] of losses.entries()) {
      const n = index + 1;
      vi.setSystemTime(recoveredAt + loss.after);
      const before = { tree: made(record.path), repo: made(gitDir) };
      await endConnection().released;
      const tree = () => treeActivityForTests(record.id)!;
      const repo = () => repoActivityForTests(record.id)!;
      if (loss.retryMs === undefined) {
        await until(
          `loss ${n}: the immediate recovery`,
          () => tree().recoveries === n && repo().recoveries === n,
        );
      } else {
        await until(
          `loss ${n}: both retries armed`,
          () => tree().retryArmed && repo().retryArmed,
        );
        assert.equal(tree().retryMs, loss.retryMs, `loss ${n}: tree delay`);
        assert.equal(repo().retryMs, loss.retryMs, `loss ${n}: repo delay`);
        assert.deepEqual(
          { tree: made(record.path), repo: made(gitDir) },
          before,
          `loss ${n}: nothing resubscribed before the retry`,
        );
        fireTreeRetriesForTests();
        fireRepoRetriesForTests();
        await until(
          `loss ${n}: the retried recovery`,
          () => tree().recoveries === n && repo().recoveries === n,
        );
      }
      recoveredAt = Date.now();
      assert.equal(tree().retryArmed, false, `loss ${n}: no tree retry left`);
      assert.equal(repo().retryArmed, false, `loss ${n}: no repo retry left`);
      assert.equal(tree().scansScheduled, scans + n, `loss ${n}: tree rescans`);
      assert.equal(repo().fullRescans, rescans + n, `loss ${n}: full rescans`);
      assert.deepEqual(
        { tree: made(record.path), repo: made(gitDir) },
        { tree: 1 + n, repo: before.repo + 1 },
        `loss ${n}: one subscribe per tier`,
      );
    }
    assert.equal(made(gitDir), 8, "the spy started after the git dir's first");
  },
);

/**
 * Flags the open connection's first read of its `gone`: an unsubscribe of a
 * handle whose connection has ended awaits it.
 */
function awaitingRelease(): () => boolean {
  const watches = watchesOn(ensureInProcessWorker())!;
  const gone = watches.gone;
  let read = false;
  Object.defineProperty(watches, "gone", {
    get: () => {
      read = true;
      return gone;
    },
  });
  return () => read;
}

for (const parkedIn of ["ignore read", "release"] as const)
  test(
    `AC14: a quick loss during a settle step's ${parkedIn} waits for its backoff`,
    { timeout: 60_000 },
    async () => {
      const name = parkedIn === "release" ? "ac14-release" : "ac14-ignore";
      const { id } = project(name);
      const record = await worktree(id, `${name}-wt`);
      // Untracked, so each .gitignore below changes the ignore set.
      for (const dir of ["dir2", "dir3"]) {
        mkdirSync(join(record.path, dir));
        writeFileSync(join(record.path, dir, "x.txt"), "x\n");
      }
      const native = nativeWatches(record.path);
      const made = () => native.made.get(record.path) ?? 0;
      const tree = () => treeActivityForTests(record.id)!;
      await addWorktreeViewer(record.id);
      await until("the view settled", () => settled(record.id));
      // Only Date: no retry timer elapses, and the thresholds are production.
      vi.useFakeTimers({ toFake: ["Date"] });
      cleanups.push(() => vi.useRealTimers());
      vi.setSystemTime(Date.now());

      // Loss 1 is not quick: it recovers at once and starts the run.
      await endConnection().released;
      await until(
        "loss 1: the immediate recovery",
        () => tree().recoveries === 1 && settled(record.id),
      );
      let recoveredAt = Date.now();

      for (const [index, retryMs] of [5_000, 10_000].entries()) {
        const n = index + 2;
        // A .gitignore edit marks the set stale, refreshed only 30 s after
        // the recovery's read.
        vi.setSystemTime(recoveredAt + 1_000);
        writeFileSync(
          join(record.path, ".gitignore"),
          ["dir2/", "dir3/"].slice(0, n - 1).join("\n") + "\n",
        );
        await until(
          `loss ${n}: the refresh retry armed`,
          () => tree().retryArmed && settled(record.id),
        );

        // The old Worker's release is held past the end.
        const release = holdNativeUnsubscribeForTests();
        const reading = awaitingRelease();
        const { ended, released } = endConnection();
        await ended;
        const releasing = track(released);
        let parked = false;
        let unpark = () => {};
        if (parkedIn === "ignore read") {
          const gate = new Promise<void>((resolve) => (unpark = resolve));
          const stop = intercept(
            CHECKOUT_GIT_METHODS.run,
            (payload, signal, real) => {
              const args = (payload.json as { args?: string[] }).args;
              if (
                pathOf(payload) !== record.path ||
                !args?.includes("--ignored")
              )
                return undefined;
              parked = true;
              stop();
              return gate.then(() => real(payload, signal));
            },
          );
          cleanups.push(stop);
        }

        // Still a quick loss when it lands: the refresh is due, the run is not.
        vi.setSystemTime(recoveredAt + 30_000);
        const scans = tree().scansScheduled;
        const before = made();
        fireTreeRetriesForTests();
        await until(`loss ${n}: the step parked in its ${parkedIn}`, () =>
          parkedIn === "release" ? reading() : parked,
        );
        assert.equal(releasing.settled, false, "the release is still held");

        release();
        await released;
        await until(
          `loss ${n}: the backoff armed`,
          () => tree().retryArmed && tree().retryMs === retryMs,
        );
        unpark();
        await until(`loss ${n}: the step finished`, () => settled(record.id));
        assert.equal(
          made(),
          before,
          `loss ${n}: no subscribe before the retry`,
        );
        assert.equal(tree().recoveries, n - 1, `loss ${n}: no recovery yet`);
        assert.equal(tree().scansScheduled, scans, `loss ${n}: no rescan yet`);
        assert.equal(tree().retryMs, retryMs, `loss ${n}: the backoff is kept`);

        fireTreeRetriesForTests();
        fireRepoRetriesForTests();
        await until(
          `loss ${n}: the retried recovery`,
          () => tree().recoveries === n && settled(record.id),
        );
        recoveredAt = Date.now();
        assert.equal(made(), before + 1, `loss ${n}: one subscribe`);
        assert.equal(tree().scansScheduled, scans + 1, `loss ${n}: one rescan`);
        assert.equal(tree().retryArmed, false, `loss ${n}: no retry left`);
      }
    },
  );

/**
 * A viewed spawned worktree past its first (immediate) recovery, with `Date`
 * frozen at the recovery.
 */
async function recoveredOnce(projectId: string, record: { id: string }) {
  await addWorktreeViewer(record.id);
  await until("the view settled", () => settled(record.id));
  vi.useFakeTimers({ toFake: ["Date"] });
  cleanups.push(() => vi.useRealTimers());
  vi.setSystemTime(Date.now());
  const tree = () => treeActivityForTests(record.id)!;
  await endConnection().released;
  await until(
    `${projectId}: the immediate recovery`,
    () => tree().recoveries === 1 && settled(record.id),
  );
  return tree;
}

/**
 * {@link recoveredOnce}, then a quick loss at R + 1 s with its 5 s backoff
 * armed.
 */
async function quicklyLost(projectId: string, record: { id: string }) {
  const tree = await recoveredOnce(projectId, record);
  vi.setSystemTime(Date.now() + 1_000);
  await endConnection().released;
  await until(
    `${projectId}: the backoff armed`,
    () => tree().retryMs === 5_000 && settled(record.id),
  );
  assert.equal(tree().recoveries, 1);
  return tree;
}

test("AC14: a quick loss of a tree its last viewer leaves waits for the next viewer", async () => {
  const { id } = project("ac14-linger");
  const record = await worktree(id, "ac14-linger-wt");
  const native = nativeWatches(record.path);
  const made = () => native.made.get(record.path) ?? 0;
  const tree = await quicklyLost(id, record);
  const before = made();
  const scans = tree().scansScheduled;

  // Leaving re-ranks every watch; the lingering tree must not resubscribe.
  removeWorktreeViewer(record.id);
  await until("the re-rank settled", () => settled(record.id));
  assert.equal(made(), before, "no subscribe while nobody views it");
  assert.equal(tree().recoveries, 1);

  await addWorktreeViewer(record.id);
  await until(
    "the viewer's recovery",
    () => tree().recoveries === 2 && settled(record.id),
  );
  assert.equal(made(), before + 1, "one subscribe");
  assert.equal(tree().scansScheduled, scans + 1, "one rescan");
});

test("AC14: a quick loss keeps its backoff when a re-rank takes and returns the slot", async () => {
  const { id } = project("ac14-rerank");
  limits({ maxWatches: 1 });
  const lost = await worktree(id, "ac14-rerank-lost");
  const other = await worktree(id, "ac14-rerank-other");
  const native = nativeWatches(lost.path, other.path);
  const made = (path: string) => native.made.get(path) ?? 0;
  const tree = await quicklyLost(id, lost);
  const before = made(lost.path);
  const scans = tree().scansScheduled;

  // A later view ranks first and takes the free slot.
  await addWorktreeViewer(other.id);
  await until("the other view settled", () => settled(other.id));
  assert.equal(made(other.path), 1);
  assert.equal(tree().retryMs, 5_000, "the re-rank kept the backoff");

  // Its viewer leaves: the slot returns once its release lands, and the idle
  // watch that lost its slot is forgotten.
  removeWorktreeViewer(other.id);
  await until(
    "the other released",
    () =>
      native.live === 0 && !treeActivityForTests(other.id) && settled(lost.id),
  );
  assert.equal(made(lost.path), before, "no subscribe before the retry");
  assert.equal(tree().recoveries, 1);
  assert.equal(tree().scansScheduled, scans, "no rescan before the retry");
  assert.equal(tree().retryMs, 5_000);

  fireTreeRetriesForTests();
  await until(
    "the retried recovery",
    () => tree().recoveries === 2 && settled(lost.id),
  );
  assert.equal(made(lost.path), before + 1, "one subscribe");
  assert.equal(tree().scansScheduled, scans + 1, "one rescan");
});

/** Refuse the next `watch.subscribe` of `path` before its handler runs. */
function refuseSubscribeOnce(path: string): () => boolean {
  let refused = false;
  const stop = intercept(WATCH_METHODS.subscribe, (payload) => {
    if (payload.text?.path !== path) return undefined;
    refused = true;
    stop();
    return Promise.reject(new Error("refused"));
  });
  cleanups.push(stop);
  return () => refused;
}

/**
 * The quick loss's backoff fired, and the resubscribe the Worker refused
 * doubles it: no settle step between the loss and the attempt restarted the
 * run. Then the next retry recovers, with one rescan.
 */
async function refusedRetryDoubles(
  tree: () => NonNullable<ReturnType<typeof treeActivityForTests>>,
  record: { id: string; path: string },
  made: () => number,
  attempt: () => unknown,
) {
  const before = made();
  const scans = tree().scansScheduled;
  const refused = refuseSubscribeOnce(record.path);
  await attempt();
  await until(
    "the refused resubscribe re-armed",
    () => refused() && tree().retryArmed && settled(record.id),
  );
  assert.equal(tree().retryMs, 10_000, "the failure run kept doubling");
  assert.equal(made(), before, "the refused attempt subscribed nothing");
  assert.equal(tree().recoveries, 1);
  assert.equal(tree().scansScheduled, scans);

  fireTreeRetriesForTests();
  await until(
    "the retried recovery",
    () => tree().recoveries === 2 && settled(record.id),
  );
  assert.equal(made(), before + 1, "one subscribe");
  assert.equal(tree().scansScheduled, scans + 1, "one rescan");
}

test("AC14: a release step a quick loss overtakes keeps the failure run", async () => {
  const { id } = project("ac14-seed");
  limits({ maxWatches: 1 });
  const target = await worktree(id, "ac14-seed-target");
  const waiter = await worktree(id, "ac14-seed-waiter");
  const native = nativeWatches(target.path, waiter.path);
  const made = () => native.made.get(target.path) ?? 0;
  const tree = await recoveredOnce(id, target);
  const recoveredAt = Date.now();

  // The old Worker's release is held past the end.
  vi.setSystemTime(recoveredAt + 1_000);
  const release = holdNativeUnsubscribeForTests();
  cleanups.push(release);
  const reading = awaitingRelease();
  const { ended, released } = endConnection();
  await ended;
  // A later view takes the target's slot before its loss is known: its
  // release-only step awaits the old Worker's release.
  vi.setSystemTime(recoveredAt + 2_000);
  await addWorktreeViewer(waiter.id);
  await until("the target's release step awaits the release", reading);
  release();
  await released;
  await until(
    "the loss's backoff armed and the release step finished",
    () => tree().retryMs === 5_000 && settled(target.id),
  );

  // The slot returns without touching the backoff.
  removeWorktreeViewer(waiter.id);
  await until(
    "the waiter forgotten",
    () => !treeActivityForTests(waiter.id) && settled(target.id),
  );
  assert.equal(tree().retryMs, 5_000);

  vi.setSystemTime(recoveredAt + 6_000);
  await refusedRetryDoubles(tree, target, made, fireTreeRetriesForTests);
});

test("AC14: a fired quick-loss retry that finds no slot keeps the failure run", async () => {
  const { id } = project("ac14-noslot");
  limits({ maxWatches: 1 });
  const target = await worktree(id, "ac14-noslot-target");
  const other = await worktree(id, "ac14-noslot-other");
  const native = nativeWatches(target.path, other.path);
  const made = () => native.made.get(target.path) ?? 0;
  const tree = await quicklyLost(id, target);

  // A later view takes the free slot; the backoff then fires with none left.
  await addWorktreeViewer(other.id);
  await until("the other view settled", () => settled(other.id));
  assert.equal(native.made.get(other.path), 1);
  fireTreeRetriesForTests();
  await until(
    "the fired step found no slot",
    () => !tree().retryArmed && settled(target.id),
  );

  // Its viewer leaves: once its release lands, the slot returns and the
  // target attempts at once, its backoff served.
  vi.setSystemTime(Date.now() + 5_000);
  await refusedRetryDoubles(tree, target, made, () =>
    removeWorktreeViewer(other.id),
  );
});

/**
 * Park the next presence check of `path` until released; it then answers
 * for real, or fails as a Worker failure.
 */
function parkPresence(path: string, refused: boolean) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let parked = false;
  let finished = false;
  const stop = intercept(FILE_METHODS.exists, (payload, signal, real) => {
    if (pathOf(payload) !== path) return undefined;
    parked = true;
    stop();
    return gate.then(() => {
      finished = true;
      if (refused) throw new Error("refused");
      return real(payload, signal);
    });
  });
  cleanups.push(() => {
    release();
    stop();
  });
  return { parked: () => parked, finished: () => finished, release };
}

for (const refused of [false, true])
  test(`AC14: a quick loss during a presence check ${refused ? "the Worker refuses" : "that answers"} waits for its backoff`, async () => {
    const name = refused ? "ac14-presence-refused" : "ac14-presence";
    const { id } = project(name);
    const record = await worktree(id, `${name}-wt`);
    const native = nativeWatches(record.path);
    const made = () => native.made.get(record.path) ?? 0;
    const tree = await recoveredOnce(id, record);
    const recoveredAt = Date.now();
    const before = made();
    const scans = tree().scansScheduled;

    vi.setSystemTime(recoveredAt + 1_000);
    const release = holdNativeUnsubscribeForTests();
    cleanups.push(release);
    const { ended, released } = endConnection();
    await ended;
    // A second viewer's step parks in its presence check on the new Worker.
    const presence = parkPresence(record.path, refused);
    const viewing = addWorktreeViewer(record.id);
    cleanups.push(() => removeWorktreeViewer(record.id));
    await until("the step parked in its presence check", presence.parked);
    release();
    await released;
    await until("the loss's backoff armed", () => tree().retryMs === 5_000);
    presence.release();
    await viewing;
    await until(
      "the step finished",
      () => presence.finished() && settled(record.id),
    );
    assert.equal(made(), before, "no subscribe before the retry");
    assert.equal(tree().recoveries, 1);
    assert.equal(tree().scansScheduled, scans, "no rescan before the retry");
    assert.equal(tree().retryMs, 5_000, "the backoff is kept");

    fireTreeRetriesForTests();
    await until(
      "the retried recovery",
      () => tree().recoveries === 2 && settled(record.id),
    );
    assert.equal(made(), before + 1, "one subscribe");
    assert.equal(tree().scansScheduled, scans + 1, "one rescan");
  });

test("AC14: a presence check a quick loss overtakes keeps the backoff when a re-rank takes and returns the slot", async () => {
  const { id } = project("ac14-presence-rank");
  limits({ maxWatches: 1 });
  const target = await worktree(id, "ac14-presence-rank-target");
  const waiter = await worktree(id, "ac14-presence-rank-waiter");
  const native = nativeWatches(target.path, waiter.path);
  const made = () => native.made.get(target.path) ?? 0;
  const tree = await recoveredOnce(id, target);
  const recoveredAt = Date.now();
  const before = made();
  const scans = tree().scansScheduled;

  vi.setSystemTime(recoveredAt + 1_000);
  const release = holdNativeUnsubscribeForTests();
  cleanups.push(release);
  const { ended, released } = endConnection();
  await ended;
  const presence = parkPresence(target.path, false);
  const viewing = addWorktreeViewer(target.id);
  cleanups.push(() => removeWorktreeViewer(target.id));
  await until("the step parked in its presence check", presence.parked);
  // A later view takes the target's slot while its step is parked.
  vi.setSystemTime(recoveredAt + 2_000);
  await addWorktreeViewer(waiter.id);
  release();
  await released;
  await until("the loss's backoff armed", () => tree().retryMs === 5_000);
  presence.release();
  await viewing;
  await until("the no-slot step finished", () => settled(target.id));
  assert.equal(tree().retryMs, 5_000, "the no-slot step kept the backoff");

  // The waiter leaves: the slot returns, and only the retry may use it.
  removeWorktreeViewer(waiter.id);
  await until(
    "the waiter forgotten",
    () =>
      !treeActivityForTests(waiter.id) &&
      native.live === 0 &&
      settled(target.id),
  );
  assert.equal(made(), before, "no subscribe before the retry");
  assert.equal(tree().recoveries, 1);
  assert.equal(tree().scansScheduled, scans, "no rescan before the retry");
  assert.equal(tree().retryMs, 5_000);

  fireTreeRetriesForTests();
  await until(
    "the retried recovery",
    () => tree().recoveries === 2 && settled(target.id),
  );
  assert.equal(made(), before + 1, "one subscribe");
  assert.equal(tree().scansScheduled, scans + 1, "one rescan");
  assert.equal(native.maxLive, 1, "the cap held");
});

test("a tree's answered native failure retries, and its success ends the failure run", async () => {
  const { id } = project("native-success");
  limits({ ignoreRefreshMs: 0 });
  const record = await worktree(id, "native-success-wt");
  mkdirSync(join(record.path, "dir2"));
  writeFileSync(join(record.path, "dir2", "x.txt"), "x\n");
  const tree = () => treeActivityForTests(record.id)!;
  const native = capture({ holdSubscribe: true });
  native.rejectSubscribe("Not a directory");
  await addWorktreeViewer(record.id);
  assert.equal(await treeWatchLiveForTests(record.id), false);
  assert.deepEqual(
    { armed: tree().retryArmed, ms: tree().retryMs },
    { armed: true, ms: 5_000 },
  );
  fireTreeRetriesForTests();
  await until("the retry subscribed", () => settled(record.id));
  assert.equal(await treeWatchLiveForTests(record.id), true);

  // No loss: a changed ignore set replaces the subscription, and the Worker
  // refuses the new one. Its delay starts the run again.
  const refused = refuseSubscribeOnce(record.path);
  writeFileSync(join(record.path, ".gitignore"), "dir2/\n");
  await until(
    "the refused replacement re-armed",
    () => refused() && tree().retryArmed && settled(record.id),
  );
  assert.equal(tree().retryMs, 5_000);
  assert.equal(tree().recoveries, 0, "no loss was involved");
});

// --- AC16 -----------------------------------------------------------------

/** A `watch.subscribe` substitute: the real handler, then `after`. */
function afterRealSubscribe(after: "malformed" | "failed"): void {
  answerNextInProcessWorkerCallForTests(
    WATCH_METHODS.subscribe,
    async (payload, signal, real) => {
      await real(payload, signal);
      if (after === "failed") throw new Error("failed after the native call");
      return { json: { bogus: 1 } };
    },
  );
}

/**
 * Two viewed trees under a cap of 1: `target` subscribes first (the
 * uncertain one), and `waiter`, viewed while it does, ranks first and waits.
 */
async function capOfOne(name: string) {
  const { id, gitDir } = project(name);
  limits({ maxWatches: 1 });
  const target = await worktree(id, `${name}-target`);
  const waiter = await worktree(id, `${name}-waiter`);
  const native = nativeWatches(target.path, waiter.path);
  const view = () => {
    const viewing = addWorktreeViewer(target.id);
    return {
      viewing,
      waiter: async () => {
        const viewedAt = Date.now();
        await until("a later instant", () => Date.now() > viewedAt);
        void addWorktreeViewer(waiter.id);
      },
    };
  };
  return { gitDir, target, waiter, native, view };
}

for (const after of ["malformed", "failed"] as const)
  test(`AC16: native success, then a ${after} answer, keeps the slot until absence is proven`, async () => {
    const { target, waiter, native, view } = await capOfOne(`ac16${after}`);
    const epoch = await connectedEpoch();
    const unsubscribes = served(WATCH_METHODS.unsubscribe);
    afterRealSubscribe(after);
    const release = holdNativeUnsubscribeForTests();
    cleanups.push(release);
    const { viewing, waiter: viewWaiter } = view();
    await until(
      "the cleanup unsubscribe",
      () => served(WATCH_METHODS.unsubscribe) === unsubscribes + 1,
    );
    assert.equal(native.maxLive, 1, "the native subscription went live");
    await viewWaiter();
    await until("the waiter's settle", () => settled(waiter.id));
    // Held: the target still subscribes, and the waiter cannot.
    assert.ok(treeActivityForTests(target.id)!.settlesPending > 0);
    assert.equal(treeActivityForTests(target.id)!.retryArmed, false);
    assert.equal(native.live, 1);
    assert.equal(inProcessWorkerEpochForTests(), epoch, "the connection stays");

    release();
    await until("the target's backoff", () =>
      Boolean(treeActivityForTests(target.id)?.retryArmed),
    );
    await viewing;
    await until("the waiter took the slot", () =>
      Boolean(native.made.get(waiter.path)),
    );
    fireTreeRetriesForTests();
    await until("both settled", () => settled(target.id) && settled(waiter.id));
    assert.equal(native.live, 1);
    assert.equal(native.maxLive, 1, "never above the cap");
    assert.equal(await treeWatchLiveForTests(waiter.id), true);
    assert.equal(await treeWatchLiveForTests(target.id), false);
  });

test("AC16: an answer before the native call finishes: the cleanup joins it", async () => {
  const { target } = await capOfOne("ac16early");
  const native = capture({ holdSubscribe: true });
  answerNextInProcessWorkerCallForTests(
    WATCH_METHODS.subscribe,
    async (payload, signal, real) => {
      void real(payload, signal).catch(() => undefined);
      await native.subscribed;
      return { json: { bogus: 1 } };
    },
  );
  const unsubscribes = served(WATCH_METHODS.unsubscribe);
  const viewing = addWorktreeViewer(target.id);
  await until(
    "the cleanup unsubscribe",
    () => served(WATCH_METHODS.unsubscribe) === unsubscribes + 1,
  );
  assert.ok(treeActivityForTests(target.id)!.settlesPending > 0);
  assert.equal(native.unsubscribes, 0);

  native.releaseSubscribe();
  await until("the target's backoff", () =>
    Boolean(treeActivityForTests(target.id)?.retryArmed),
  );
  assert.equal(native.unsubscribes, 1);
  await viewing;
});

for (const cleanup of [
  "an answered unsubscribe failure",
  "a refused unsubscribe",
] as const)
  test(`AC16: a cleanup failing with ${cleanup} ends the connection and awaits the release`, async () => {
    const { target } = await capOfOne(
      cleanup.startsWith("an") ? "ac16answered" : "ac16refused",
    );
    const previousRetry = setWatchReleaseRetryMsForTests(10);
    cleanups.push(() => setWatchReleaseRetryMsForTests(previousRetry));
    const epoch = await connectedEpoch();
    const { released } = inProcessWorkerWatchesForTests();
    const releasedState = track(released);
    const repoRecoveries = repoActivityForTests(target.id)!.recoveries;
    const native = capture({
      rejectUnsubscribeOnce: cleanup.startsWith("an"),
    });
    afterRealSubscribe("malformed");
    if (!cleanup.startsWith("an"))
      answerNextInProcessWorkerCallForTests(
        WATCH_METHODS.unsubscribe,
        async (payload, signal, real) => {
          await real(payload, signal);
          throw new Error("refused after the real unsubscribe");
        },
      );
    const viewing = addWorktreeViewer(target.id);
    await native.subscribed;
    await until(
      "the connection ended",
      () => inProcessWorkerEpochForTests() !== epoch,
    );
    await released;
    // The subscribe rejected only after the release.
    await until("the target's backoff", () =>
      Boolean(treeActivityForTests(target.id)?.retryArmed),
    );
    assert.ok(releasedState.settled);
    if (cleanup.startsWith("an")) assert.equal(native.unsubscribes, 2);
    else assert.ok(native.unsubscribes >= 1);
    // The bystander git-dir watch was lost after the release and recovered.
    await until(
      "the git-dir watch recovered",
      () => repoActivityForTests(target.id)!.recoveries === repoRecoveries + 1,
    );
    await viewing;
  });

for (const definite of [
  "an answered native failure",
  "unknown_method",
] as const)
  test(`AC16: ${definite} runs no cleanup and rejects at once`, async () => {
    const { target } = await capOfOne(
      definite === "unknown_method" ? "ac16unknown" : "ac16native",
    );
    if (definite === "unknown_method")
      answerNextInProcessWorkerCallForTests(WATCH_METHODS.subscribe, () =>
        Promise.reject(new WorkerMethodError(UNKNOWN_METHOD, "no such method")),
      );
    else capture({ holdSubscribe: true }).rejectSubscribe("Not a directory");
    const unsubscribes = served(WATCH_METHODS.unsubscribe);
    await addWorktreeViewer(target.id);
    assert.equal(served(WATCH_METHODS.unsubscribe), unsubscribes);
    assert.equal(treeActivityForTests(target.id)!.retryArmed, true);
  });
