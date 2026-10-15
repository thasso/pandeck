/**
 * The layout worker (`initiativeLayoutRunner.ts`): ELK runs in a thread of its
 * own, answers in order, fails a job alone (an ELK error, the time limit, a
 * stop, a worker that cannot start or take the job) and starts afresh for the
 * next one. Admission is bounded: a full queue, a deadline and an abort each
 * end a job, and nothing lingers after.
 */
import assert from "node:assert/strict";
import { afterAll, afterEach, beforeEach, test, vi } from "vitest";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import {
  initiativeLayoutRunnerState,
  MAX_QUEUED_LAYOUT_JOBS,
  runElkLayout,
  stopInitiativeLayoutWorker,
  TransientLayoutError,
} from "./initiativeLayoutRunner.ts";

/** Synchronous faults to inject into the next worker starts and dispatches. */
const faults = vi.hoisted(() => ({ construct: 0, dispatch: 0 }));

vi.mock("node:worker_threads", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:worker_threads")>();
  class Worker extends real.Worker {
    constructor(...args: ConstructorParameters<typeof real.Worker>) {
      if (faults.construct > 0) {
        faults.construct -= 1;
        throw new Error("ERR_WORKER_INIT_FAILED (injected)");
      }
      super(...args);
    }
    override postMessage(
      ...args: Parameters<InstanceType<typeof real.Worker>["postMessage"]>
    ): void {
      if (faults.dispatch > 0) {
        faults.dispatch -= 1;
        throw new Error("DataCloneError (injected)");
      }
      super.postMessage(...args);
    }
  }
  return { ...real, Worker };
});

const uncaught: unknown[] = [];
const onUncaught = (err: unknown) => uncaught.push(err);
beforeEach(() => {
  // Each test starts without a worker, so the next job constructs one.
  stopInitiativeLayoutWorker();
  faults.construct = 0;
  faults.dispatch = 0;
  uncaught.length = 0;
  process.on("uncaughtException", onUncaught);
});
afterEach(() => {
  process.off("uncaughtException", onUncaught);
  assert.deepEqual(uncaught, [], "nothing escaped into the process");
});
afterAll(() => stopInitiativeLayoutWorker());

/** Nothing running, nothing queued: what every failure must leave behind. */
function assertIdle(): void {
  const state = initiativeLayoutRunnerState();
  assert.equal(state.running, false, "no job or timer is left running");
  assert.equal(state.queued, 0, "no job is left queued");
}

function chain(length: number): ElkNode {
  const ids = Array.from({ length }, (_, i) => `n${i}`);
  return {
    id: "root",
    layoutOptions: { "elk.algorithm": "layered", "elk.direction": "RIGHT" },
    children: ids.map((id) => ({ id, width: 100, height: 40 })),
    edges: ids.slice(1).map((id, i) => ({
      id: `e${i}`,
      sources: [ids[i]!],
      targets: [id],
    })),
  };
}

test("lays out in the worker, one answer per job in order", async () => {
  const results = await Promise.all(
    [chain(2), chain(3), chain(4)].map((graph) => runElkLayout(graph)),
  );
  assert.deepEqual(
    results.map((graph) => graph.children?.length),
    [2, 3, 4],
  );
  const [two] = results;
  assert.ok(two!.children![1]!.x! > two!.children![0]!.x!, "left to right");
});

test("an ELK error fails its job alone", async () => {
  const broken: ElkNode = {
    id: "root",
    children: [{ id: "a", width: 10, height: 10 }],
    edges: [{ id: "e", sources: ["a"], targets: ["missing"] }],
  };
  const [failed, fine] = await Promise.allSettled([
    runElkLayout(broken),
    runElkLayout(chain(2)),
  ]);
  assert.equal(failed!.status, "rejected");
  assert.equal(fine!.status, "fulfilled");
});

test("a job past its time limit ends the worker, and the next one starts afresh", async () => {
  await assert.rejects(
    runElkLayout(chain(40), { passLimitMs: 1 }),
    (err: Error) =>
      err instanceof TransientLayoutError &&
      /took longer than/.test(err.message),
  );
  const graph = await runElkLayout(chain(3));
  assert.equal(graph.children?.length, 3);
});

test("stopping fails the job in flight, and a queued one still runs", async () => {
  const inFlight = runElkLayout(chain(30));
  const queued = runElkLayout(chain(2));
  stopInitiativeLayoutWorker();
  await assert.rejects(inFlight, /stopped/);
  assert.equal((await queued).children?.length, 2);
});

test("a worker that cannot start fails the first job at once, and the next one runs", async () => {
  faults.construct = 1;
  await assert.rejects(runElkLayout(chain(2)), (err: Error) => {
    assert.ok(err instanceof TransientLayoutError);
    assert.match(err.message, /ERR_WORKER_INIT_FAILED/);
    return true;
  });
  assertIdle();
  assert.equal((await runElkLayout(chain(3))).children?.length, 3);
});

test("a worker that cannot take the first job fails it at once, and the next one runs", async () => {
  faults.dispatch = 1;
  await assert.rejects(runElkLayout(chain(2)), /DataCloneError/);
  assertIdle();
  assert.equal(
    initiativeLayoutRunnerState().worker,
    false,
    "the broken worker is gone",
  );
  assert.equal((await runElkLayout(chain(3))).children?.length, 3);
});

for (const fault of ["construct", "dispatch"] as const)
  test(`a queued job whose replacement worker fails to ${fault} fails alone, in its own callback`, async () => {
    // The first job times out; its timer ends the worker and starts the next
    // job on a replacement, which is where the fault strikes.
    const first = runElkLayout(chain(40), { passLimitMs: 1 });
    const queued = runElkLayout(chain(2));
    faults[fault] = 1;
    await assert.rejects(first, /took longer than/);
    await assert.rejects(
      queued,
      fault === "construct" ? /ERR_WORKER_INIT_FAILED/ : /DataCloneError/,
    );
    assertIdle();
    assert.equal((await runElkLayout(chain(3))).children?.length, 3);
  });

test("a worker that keeps failing to start fails every queued job once, in order", async () => {
  const first = runElkLayout(chain(40), { passLimitMs: 1 });
  const queued = Array.from({ length: 5 }, () => runElkLayout(chain(2)));
  faults.construct = 5;
  await assert.rejects(first, /took longer than/);
  const results = await Promise.allSettled(queued);
  assert.deepEqual(
    results.map((result) => result.status),
    Array(5).fill("rejected"),
  );
  assertIdle();
  assert.equal((await runElkLayout(chain(3))).children?.length, 3);
});

test("a full queue refuses the next job at once; the admitted ones all run", async () => {
  const running = runElkLayout(chain(30));
  const admitted = Array.from({ length: MAX_QUEUED_LAYOUT_JOBS }, () =>
    runElkLayout(chain(2)),
  );
  await assert.rejects(runElkLayout(chain(2)), (err: Error) => {
    assert.ok(err instanceof TransientLayoutError);
    assert.match(err.message, /queue is full/);
    return true;
  });
  await running;
  const results = await Promise.all(admitted);
  assert.equal(results.length, MAX_QUEUED_LAYOUT_JOBS);
  assertIdle();
});

test("a job's deadline also ends its wait in the queue", async () => {
  const running = runElkLayout(chain(60));
  const late = runElkLayout(chain(2), { deadline: Date.now() + 1 });
  await assert.rejects(late, /waited too long/);
  assert.equal(initiativeLayoutRunnerState().queued, 0);
  await running;
  assertIdle();
});

test("an aborted job leaves the queue; one aborted before it is queued never enters", async () => {
  const running = runElkLayout(chain(30));
  const abort = new AbortController();
  const waiting = runElkLayout(chain(2), { signal: abort.signal });
  abort.abort();
  await assert.rejects(waiting, /cancelled/);
  await assert.rejects(
    runElkLayout(chain(2), { signal: abort.signal }),
    /cancelled/,
  );
  await running;
  assertIdle();
});
