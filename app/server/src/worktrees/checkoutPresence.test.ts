/**
 * The presence cache on the real codec: synchronous answers from the last
 * Worker answer, own-answer checks, the write rule, the bounded queue and
 * outage behavior. Interleavings use held calls, never timing.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, test, vi } from "vitest";
import { holdFileForTests } from "../fileReads.ts";
import {
  MALFORMED_ANSWERS,
  answerForPathForTests,
  answering,
} from "../test/workerAnswers.ts";
import { WorkerMethodError } from "../workerProtocol/connection.ts";
import { FILE_METHODS } from "../workerProtocol/fileMethods.ts";
import { isWorkerFailure } from "../workers/fileClient.ts";
import {
  answerNextInProcessWorkerCallForTests,
  writeAsInProcessWorkerForTests,
} from "../workers/inProcessWorker.ts";
import { DEFAULT_WORKER_SIDE } from "../workers/placement.ts";
import {
  checkPresence,
  flushPresenceForTests,
  forgetPresence,
  notePresent,
  onPresenceChange,
  presenceCountsForTests,
  presenceKey,
  presenceNow,
  presenceQueuedForTests,
  resetPresenceForTests,
  type PresenceChange,
} from "./checkoutPresence.ts";

const side = DEFAULT_WORKER_SIDE;
const root = mkdtempSync(join(tmpdir(), "checkout-presence-"));
const INVALID_FRAME = new Uint8Array(8);
let serial = 0;

/** A fresh path under the test root, created unless `create` is false. */
function folder(create = true): string {
  const path = join(root, `f${++serial}`);
  if (create) mkdirSync(path, { recursive: true });
  return path;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected a rejection");
}

beforeEach(() => resetPresenceForTests());
afterEach(async () => {
  vi.restoreAllMocks();
  await flushPresenceForTests();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("synchronous reads", () => {
  test("never-verified is unverified; one probe later the Worker's answer", async () => {
    const path = folder();
    assert.equal(presenceNow(side, path), "unverified");
    await flushPresenceForTests();
    assert.equal(presenceNow(side, path), "present");
    await flushPresenceForTests();

    rmSync(path, { recursive: true });
    // The read before its probe answers keeps the last answer (D14).
    assert.equal(presenceNow(side, path), "present");
    await flushPresenceForTests();
    assert.equal(presenceNow(side, path), "absent");
  });

  test("changed answers notify; none → present does not", async () => {
    const changes: PresenceChange[] = [];
    const off = onPresenceChange((batch) => changes.push(...batch));
    try {
      const path = folder();
      const key = presenceKey(side, path);
      presenceNow(side, path);
      await flushPresenceForTests();
      assert.deepEqual(changes, [], "none → present");

      rmSync(path, { recursive: true });
      presenceNow(side, path);
      await flushPresenceForTests();
      assert.deepEqual(changes, [{ key, answer: "absent" }]);

      presenceNow(side, path);
      await flushPresenceForTests();
      assert.equal(changes.length, 1, "an unchanged answer is silent");

      mkdirSync(path);
      presenceNow(side, path);
      await flushPresenceForTests();
      assert.deepEqual(changes[1], { key, answer: "present" });

      const never = folder(false);
      presenceNow(side, never);
      await flushPresenceForTests();
      assert.deepEqual(changes[2], {
        key: presenceKey(side, never),
        answer: "absent",
      });
      assert.equal(changes.length, 3);
    } finally {
      off();
    }
  });

  test("a seed answers at once and outranks a probe already running", async () => {
    const path = folder(false);
    const held = holdFileForTests(path, "exists");
    presenceNow(side, path);
    await held.reached;
    notePresent(side, path);
    assert.equal(presenceNow(side, path), "present");
    const dropped = presenceCountsForTests().droppedLate;
    held.release();
    await flushPresenceForTests();
    assert.equal(presenceCountsForTests().droppedLate - dropped, 1);
    assert.equal(presenceNow(side, path), "present");
  });
});

describe("awaited checks", () => {
  test("a check issues its own request during a background probe, and its answer wins", async () => {
    const path = folder();
    const held = holdFileForTests(path, "exists");
    presenceNow(side, path);
    await held.reached;
    const issued = presenceCountsForTests().probesIssued;

    rmSync(path, { recursive: true });
    assert.equal(await checkPresence(side, path), false);
    assert.equal(presenceCountsForTests().probesIssued - issued, 1);

    // The older background probe now finds the folder again; it is dropped.
    mkdirSync(path);
    const dropped = presenceCountsForTests().droppedLate;
    held.release();
    await flushPresenceForTests();
    assert.equal(presenceCountsForTests().droppedLate - dropped, 1);
    assert.equal(presenceNow(side, path), "absent");
  });

  test("a forgotten entry's late completion is dropped and recreates nothing", async () => {
    const path = folder();
    const held = holdFileForTests(path, "exists");
    presenceNow(side, path);
    await held.reached;
    forgetPresence(side, path);
    assert.equal(presenceCountsForTests().entries, 0);

    const dropped = presenceCountsForTests().droppedLate;
    held.release();
    await flushPresenceForTests();
    assert.equal(presenceCountsForTests().droppedLate - dropped, 1);
    assert.equal(presenceCountsForTests().entries, 0);
  });
});

/** Each Worker failure kind, armed for the next `files.exists` naming `path`. */
const FAILURES: Array<{
  name: string;
  /** Runs `start` with the failure armed; answers its settlement. */
  run: (path: string, start: () => Promise<unknown>) => Promise<unknown>;
}> = [
  {
    name: "a coded refusal",
    run: (path, start) => {
      answerForPathForTests(FILE_METHODS.exists, path, async () => {
        throw new WorkerMethodError("wrong_worker", "Not here.");
      });
      return start();
    },
  },
  {
    name: "a malformed answer",
    run: (path, start) => {
      answerForPathForTests(
        FILE_METHODS.exists,
        path,
        answering(MALFORMED_ANSWERS[FILE_METHODS.exists]!),
      );
      return start();
    },
  },
  {
    name: "a connection end while held",
    run: async (path, start) => {
      const held = holdFileForTests(path, "exists");
      const settled = start().then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await held.reached;
      writeAsInProcessWorkerForTests(INVALID_FRAME);
      held.release();
      const outcome = await settled;
      if ("error" in outcome) throw outcome.error;
      return outcome.value;
    },
  },
];

describe("Worker failures (B15, RD-W3d-1)", () => {
  test.each(FAILURES)(
    "$name: an awaited check rejects and writes nothing",
    async ({ run }) => {
      const path = folder();
      assert.equal(await checkPresence(side, path), true);
      rmSync(path, { recursive: true });
      const error = await rejection(run(path, () => checkPresence(side, path)));
      assert.ok(isWorkerFailure(error), String(error));
      assert.equal(presenceNow(side, path), "present", "frozen, not absent");

      const never = folder(false);
      const neverError = await rejection(
        run(never, () => checkPresence(side, never)),
      );
      assert.ok(isWorkerFailure(neverError), String(neverError));
      assert.equal(presenceNow(side, never), "unverified", "never missing");
    },
  );

  test.each(FAILURES)(
    "$name: a background probe keeps the last answer and logs once",
    async ({ run }) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const path = folder(false);
      assert.equal(await checkPresence(side, path), false);
      await run(path, async () => {
        presenceNow(side, path);
        await flushPresenceForTests();
      });
      assert.equal(presenceNow(side, path), "absent");
      await run(path, async () => {
        presenceNow(side, path);
        await flushPresenceForTests();
      });
      assert.equal(presenceNow(side, path), "absent");
      assert.equal(
        warn.mock.calls.filter(([message]) => String(message).includes(path))
          .length,
        1,
        "once per key per outage",
      );
    },
  );

  test("a verified absence stays frozen through an outage and 5,000 other reads", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const path = folder(false);
    assert.equal(await checkPresence(side, path), false);

    let outage = true;
    const refuse: Parameters<
      typeof answerNextInProcessWorkerCallForTests
    >[1] = async () => {
      if (outage)
        answerNextInProcessWorkerCallForTests(FILE_METHODS.exists, refuse);
      throw new WorkerMethodError("unavailable", "Worker down.");
    };
    answerNextInProcessWorkerCallForTests(FILE_METHODS.exists, refuse);
    try {
      for (let i = 0; i < 5_000; i++)
        presenceNow(side, join(root, "outage", String(i)));
      presenceNow(side, path);
      await flushPresenceForTests();
      assert.equal(presenceNow(side, path), "absent");
      await flushPresenceForTests();
    } finally {
      outage = false;
    }
    assert.equal(presenceNow(side, path), "absent");
  });
});

describe("bounds (AC11)", () => {
  test("the queue holds each entry at most once under eight held probes, and unlinks eagerly", async () => {
    const paths = Array.from({ length: 1_008 }, (_, i) =>
      join(root, "queue", String(i)),
    );
    const holds = paths
      .slice(0, 8)
      .map((path) => holdFileForTests(path, "exists"));
    for (const path of paths) presenceNow(side, path);
    await Promise.all(holds.map((held) => held.reached));
    for (const path of paths) presenceNow(side, path);

    let counts = presenceCountsForTests();
    assert.equal(counts.backgroundInFlight, 8);
    assert.equal(counts.probesIssued, 8, "at most eight background probes");
    assert.equal(counts.coalesced, paths.length, "a second read coalesces");
    assert.ok(counts.entries <= paths.length);
    assert.ok(counts.queued <= counts.entries - counts.backgroundInFlight);
    assert.equal(counts.queued, 1_000);

    // Half the rows go: map and queue shrink with them.
    for (const path of paths.slice(8, 508)) forgetPresence(side, path);
    counts = presenceCountsForTests();
    assert.ok(counts.entries <= 508, String(counts.entries));
    assert.ok(counts.queued <= 500, String(counts.queued));
    assert.equal(presenceQueuedForTests(side, paths[8]!), false);

    for (const held of holds) held.release();
    await flushPresenceForTests();
    counts = presenceCountsForTests();
    assert.equal(counts.queued, 0);
    assert.ok(counts.probesIssued <= 508, "each probed at most once");
    assert.equal(counts.backgroundInFlight, 0);
  });
});
