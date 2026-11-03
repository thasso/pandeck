/**
 * The writer lane and login holds against a running gateway (`holds.ts`):
 * one lane item per profile at a time, a hold's acquire, evidence (b) from
 * real children of this test, the recheck on hello and once a minute, what is
 * not evidence, and the deadline's login-stuck state. Every hold whose owner
 * or writer is not a child this test spawned is observed through a fake
 * probe; no test probes or signals a process it did not spawn.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, test, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import {
  dialControl,
  endChild,
  fakeProcesses,
  spawnIdleChild,
  writeTokenFiles,
  type FakeProcesses,
} from "../test/gatewayFixtures.ts";
import type { Payload } from "../workerProtocol/codec.ts";
import type { WorkerConnection } from "../workerProtocol/connection.ts";
import { createInProcessTransport } from "../workerProtocol/inProcessTransport.ts";
import {
  CONTROL_METHODS,
  GATEWAY_CONTROL_PROTOCOL,
  decodeLoginHeld,
  encodeControlRequest,
} from "./controlMethods.ts";
import {
  startGateway,
  type GatewayOptions,
  type RunningGateway,
} from "./gateway.ts";
import { LaneHeldError, type HoldStatus } from "./holds.ts";
import { processStartTime } from "./processIdentity.ts";
import type { GatewayProfile } from "./profiles.ts";

const MINUTE = 60 * 1000;
const T0 = 1_800_000_000_000;

let profileA: GatewayProfile;
let profileB: GatewayProfile;
let profileC: GatewayProfile;
const running: RunningGateway[] = [];
const children: ReturnType<typeof spawnIdleChild>[] = [];
let lines: string[] = [];

beforeAll(async () => {
  const files = await writeTokenFiles();
  profileA = {
    id: "claude-a",
    provider: "claude",
    name: "Work Claude",
    enabled: true,
    tokenFile: files.claudeFile,
  };
  profileB = {
    id: "codex-b",
    provider: "openai-codex",
    name: "Work ChatGPT",
    enabled: true,
    tokenFile: files.codexFile,
  };
  profileC = { ...profileA, id: "claude-c", name: "Home Claude" };
});

afterEach(async () => {
  vi.useRealTimers();
  while (running.length) await running.pop()!.close();
  while (children.length) await endChild(children.pop()!);
  lines = [];
});

async function freshStateDir(): Promise<string> {
  await mkdir(DATA_DIR, { recursive: true });
  return join(await mkdtemp(join(DATA_DIR, "gateway-holds-")), "gateway");
}

/** A gateway whose holds are observed through `processes`, or for real with null. */
async function gateway(
  processes: FakeProcesses | null,
  options: GatewayOptions = {},
): Promise<RunningGateway> {
  const gw = await startGateway({
    log: (line) => lines.push(line),
    ...(processes ? { processProbe: processes.probe } : {}),
    ...options,
  });
  running.push(gw);
  return gw;
}

function child(): ReturnType<typeof spawnIdleChild> {
  const spawned = spawnIdleChild();
  children.push(spawned);
  return spawned;
}

/** A control connection whose `profiles.status` requests land in `statuses`. */
function control(gw: RunningGateway): {
  connection: WorkerConnection;
  statuses: HoldStatus[];
} {
  const statuses: HoldStatus[] = [];
  const connection = dialControl(
    createInProcessTransport(),
    gw.attachControl,
    GATEWAY_CONTROL_PROTOCOL,
    {
      [CONTROL_METHODS.status]: (payload: Payload) => {
        statuses.push(payload.json as HoldStatus);
        return Promise.resolve({ json: {} });
      },
    },
  );
  return { connection, statuses };
}

const send = (
  connection: WorkerConnection,
  method: string,
  request: object,
  signal?: AbortSignal,
) =>
  connection.request(
    method,
    encodeControlRequest(request as Parameters<typeof encodeControlRequest>[0]),
    signal,
  );

/** A connection after a hello as `serverBootId` and a sync of A, B and C. */
async function ready(
  gw: RunningGateway,
  serverBootId: string,
  pid = 4242,
  startTime: string | null = "1234",
) {
  const dialed = control(gw);
  await send(dialed.connection, CONTROL_METHODS.hello, {
    serverBootId,
    pid,
    startTime,
  });
  await send(dialed.connection, CONTROL_METHODS.syncProfiles, {
    profiles: [profileA, profileB, profileC],
  });
  return dialed;
}

async function loginHold(
  connection: WorkerConnection,
  profileId: string,
  holdId: string,
  signal?: AbortSignal,
) {
  return decodeLoginHeld(
    await send(
      connection,
      CONTROL_METHODS.loginHold,
      { profileId, holdId },
      signal,
    ),
  );
}

async function loginWriter(
  connection: WorkerConnection,
  holdId: string,
  pid: number,
  startTime: string | null,
): Promise<void> {
  await send(connection, CONTROL_METHODS.loginWriter, {
    holdId,
    pid,
    startTime,
  });
}

const holdIds = (gw: RunningGateway) => gw.holds().map((hold) => hold.holdId);

/** Lets `n` macrotask turns pass: what is pending stays pending. */
async function turns(n = 2): Promise<void> {
  for (let i = 0; i < n; i += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A promise's state, readable without awaiting it. */
function track<T>(promise: Promise<T>): {
  settled: boolean;
  promise: Promise<T>;
} {
  const tracked = { settled: false, promise };
  promise.then(
    () => (tracked.settled = true),
    () => (tracked.settled = true),
  );
  return tracked;
}

test("AC3: one lane item per profile at a time, in order with acquires; a failing item frees the lane", async () => {
  const gw = await gateway(fakeProcesses());
  const { connection } = await ready(gw, "boot-x");
  const d1 = deferred<string>();
  const d2 = deferred<string>();
  const started: string[] = [];
  const w1 = gw.lane.run(profileA.id, () => {
    started.push("w1");
    return d1.promise;
  });
  const w2 = gw.lane.run(profileA.id, () => {
    started.push("w2");
    return d2.promise;
  });
  const hold = track(loginHold(connection, profileA.id, "h1"));
  const wb = gw.lane.run(profileB.id, () => {
    started.push("wb");
    return Promise.resolve("b");
  });
  assert.equal(await wb, "b");
  await turns();
  assert.deepEqual(started, ["w1", "wb"]);
  assert.equal(hold.settled, false);

  d1.reject(new Error("w1 fails"));
  await assert.rejects(w1, /w1 fails/);
  await turns();
  assert.deepEqual(started, ["w1", "wb", "w2"]);
  assert.equal(hold.settled, false);

  d2.resolve("w2");
  assert.equal(await w2, "w2");
  assert.deepEqual(await hold.promise, { held: true });
  let called = false;
  await assert.rejects(
    gw.lane.run(profileA.id, () => {
      called = true;
      return Promise.resolve();
    }),
    LaneHeldError,
  );
  assert.equal(called, false);
  assert.equal(
    await gw.lane.run(profileB.id, () => Promise.resolve("b2")),
    "b2",
  );
});

test("AC3: an item queued behind an acquire is refused at its turn", async () => {
  const gw = await gateway(fakeProcesses());
  const { connection } = await ready(gw, "boot-x");
  const d = deferred();
  const first = gw.lane.run(profileA.id, () => d.promise);
  const hold = loginHold(connection, profileA.id, "h1");
  // The request reaches the gateway's lane first.
  await turns();
  let called = false;
  const later = gw.lane.run(profileA.id, () => {
    called = true;
    return Promise.resolve();
  });
  d.resolve();
  await first;
  assert.deepEqual(await hold, { held: true });
  await assert.rejects(later, LaneHeldError);
  assert.equal(called, false);
});

test("AC4: an acquire whose connection ends, or whose request is cancelled, while it waits leaves no hold", async () => {
  const gw = await gateway(fakeProcesses());
  for (const how of ["end", "cancel"] as const) {
    const { connection } = await ready(gw, "boot-x");
    const d = deferred();
    const item = gw.lane.run(profileA.id, () => d.promise);
    const cancel = new AbortController();
    const waiting = loginHold(
      connection,
      profileA.id,
      `h-${how}`,
      cancel.signal,
    );
    await turns();
    if (how === "end") connection.end("the test ends it");
    else cancel.abort();
    d.resolve();
    await item;
    await assert.rejects(waiting);
    await turns();
    assert.deepEqual(gw.holds(), [], how);
    const { connection: next } = await ready(gw, "boot-x");
    assert.deepEqual(await loginHold(next, profileA.id, `h2-${how}`), {
      held: true,
    });
    await send(next, CONTROL_METHODS.loginRelease, { holdId: `h2-${how}` });
    next.end("done");
  }
});

test("AC7: release (b) needs the observed exit of the owner and of a Claude hold's writer; a pi hold's owner alone", async () => {
  // Real processes: every owner and writer is an idle child of this test.
  const gw = await gateway(null);
  const owner1 = child();
  const writer1 = child();
  const owner2 = child();
  const writer2 = child();
  const owner3 = child();
  const start = (c: { pid: number }) => processStartTime(c.pid);
  if (process.platform === "linux")
    for (const c of [owner1, writer1, owner2, writer2, owner3])
      assert.match(start(c) ?? "", /^\d+$/);

  const x1 = await ready(gw, "boot-1", owner1.pid, start(owner1));
  assert.deepEqual(await loginHold(x1.connection, profileA.id, "h1"), {
    held: true,
  });
  await loginWriter(x1.connection, "h1", writer1.pid, start(writer1));
  const x2 = await ready(gw, "boot-2", owner2.pid, start(owner2));
  assert.deepEqual(await loginHold(x2.connection, profileC.id, "h2"), {
    held: true,
  });
  await loginWriter(x2.connection, "h2", writer2.pid, start(writer2));
  const x3 = await ready(gw, "boot-3", owner3.pid, start(owner3));
  assert.deepEqual(await loginHold(x3.connection, profileB.id, "h3"), {
    held: true,
  });
  // Boot Y holds nothing, so its pid is never observed.
  await ready(gw, "boot-y");
  assert.deepEqual(holdIds(gw).sort(), ["h1", "h2", "h3"]);

  // One of the two exits is not enough, whichever it is.
  await endChild(writer1);
  await endChild(owner2);
  gw.checkHolds();
  assert.deepEqual(holdIds(gw).sort(), ["h1", "h2", "h3"]);

  await endChild(owner1);
  await endChild(writer2);
  gw.checkHolds();
  assert.deepEqual(holdIds(gw), ["h3"]);

  // A pi login writes from its owner: its exit alone releases.
  await endChild(owner3);
  gw.checkHolds();
  assert.deepEqual(gw.holds(), []);
});

test("AC8: a hello rechecks every earlier boot's hold at once; a live owner keeps its hold, and a boot's own hold is never checked", async () => {
  const processes = fakeProcesses();
  processes.set(5001, "exited");
  processes.set(5002, "exited");
  processes.set(5004, "exited");
  // No timer fires during the test.
  const gw = await gateway(processes, { holdCheckIntervalMs: 3_600_000 });
  const x1 = await ready(gw, "boot-x1", 5001, "11");
  await loginHold(x1.connection, profileA.id, "h1");
  await loginWriter(x1.connection, "h1", 5002, "12");
  gw.checkHolds();
  assert.deepEqual(holdIds(gw), ["h1"], "boot X1 is current");
  assert.equal(processes.probed.length, 0);

  const x2 = await ready(gw, "boot-x2", 5003, "13");
  assert.deepEqual(holdIds(gw), [], "released by the hello, before any timer");
  await loginHold(x2.connection, profileB.id, "h2");

  const y = await ready(gw, "boot-y", 5004, "14");
  await loginHold(y.connection, profileC.id, "h3");
  gw.checkHolds();
  assert.deepEqual(holdIds(gw).sort(), ["h2", "h3"]);
  assert.ok(
    !processes.probed.includes(5004),
    "the current boot is not observed",
  );
});

test("AC9: no hold ends on what is not evidence; an uncertain observation is alive", async () => {
  const processes = fakeProcesses();
  let now = T0;
  const gw = await gateway(processes, {
    now: () => now,
    holdCheckIntervalMs: 3_600_000,
  });
  const x = await ready(gw, "boot-x", 6001, "1234");
  await loginHold(x.connection, profileA.id, "h1");
  await loginWriter(x.connection, "h1", 6002, "5678");
  // A Claude hold whose owner is gone but that never named a writer.
  await loginHold(x.connection, profileC.id, "h2");
  processes.set(6001, "exited");
  const kept = () => assert.deepEqual(holdIds(gw).sort(), ["h1", "h2"]);

  x.connection.end("the test ends it");
  await turns();
  kept();
  processes.set(6001, "running");
  const y = await ready(gw, "boot-y");
  await send(y.connection, CONTROL_METHODS.syncProfiles, {
    profiles: [profileA, profileB, profileC],
  });
  kept();
  await send(y.connection, CONTROL_METHODS.removeProfile, {
    profileId: profileA.id,
  });
  kept();
  now = T0 + 29 * MINUTE;
  gw.checkHolds();
  kept();
  // EPERM: alive, whatever its start time.
  processes.set(6001, "eperm");
  processes.set(6002, "eperm");
  gw.checkHolds();
  kept();
  // Both answer signal 0, and neither current start time is readable.
  processes.set(6001, "running");
  processes.set(6002, "running");
  gw.checkHolds();
  kept();
  assert.ok(gw.holds().every((hold) => hold.stuckAt === undefined));

  // The owner of the writerless hold is gone, and its deadline passes.
  processes.set(6001, "exited");
  now = T0 + 30 * MINUTE;
  gw.checkHolds();
  kept();
  assert.ok(gw.holds().every((hold) => hold.stuckAt === now));
});

test("AC10: at the deadline a hold becomes login-stuck, reported once, still held; evidence then releases it", async () => {
  const processes = fakeProcesses();
  let now = T0;
  const stateDir = await freshStateDir();
  const gw = await gateway(processes, {
    now: () => now,
    stateDir,
    holdCheckIntervalMs: 3_600_000,
  });
  const x = await ready(gw, "boot-x", 7001, "1");
  await loginHold(x.connection, profileA.id, "h1");
  await loginWriter(x.connection, "h1", 7002, "2");

  now = T0 + 30 * MINUTE - 1;
  gw.checkHolds();
  await turns();
  assert.deepEqual(x.statuses, []);
  now = T0 + 30 * MINUTE;
  gw.checkHolds();
  await turns();
  const stuck = { profileId: profileA.id, loginStuck: true, holdId: "h1" };
  assert.deepEqual(x.statuses, [stuck]);
  const saved = JSON.parse(
    await readFile(join(stateDir, "holds.json"), "utf8"),
  ) as { holds: { holdId: string; stuckAt?: number }[] };
  assert.equal(saved.holds[0]?.stuckAt, now);
  gw.checkHolds();
  await turns();
  assert.deepEqual(x.statuses, [stuck], "a second check sends nothing");

  assert.deepEqual(await loginHold(x.connection, profileA.id, "h9"), {
    held: false,
    refusal: "login_stuck",
    holdId: "h1",
  });
  await assert.rejects(
    gw.lane.run(profileA.id, () => Promise.resolve()),
    LaneHeldError,
  );

  const y = await ready(gw, "boot-y");
  await turns();
  assert.deepEqual(y.statuses, [stuck], "a new hello hears of it");
  processes.set(7001, "exited");
  processes.set(7002, "exited");
  gw.checkHolds();
  await turns();
  assert.deepEqual(gw.holds(), []);
  assert.deepEqual(y.statuses, [stuck, { ...stuck, loginStuck: false }]);
});

test("AC13: the holds are rechecked once a minute, and the timer ends with the gateway", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const before = vi.getTimerCount();
  const processes = fakeProcesses();
  const gw = await gateway(processes);
  const x = await ready(gw, "boot-x", 8001, "1");
  await loginHold(x.connection, profileB.id, "h1");
  await ready(gw, "boot-y");
  assert.deepEqual(holdIds(gw), ["h1"]);

  processes.set(8001, "exited");
  vi.advanceTimersByTime(59_999);
  assert.deepEqual(holdIds(gw), ["h1"]);
  vi.advanceTimersByTime(1);
  assert.deepEqual(gw.holds(), []);

  await running.pop()!.close();
  assert.equal(vi.getTimerCount(), before);
});
