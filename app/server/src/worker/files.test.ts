import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, test } from "vitest";
import {
  failFileForTests,
  fileFaultArmedForTests,
  fileReadsCountsForTests,
} from "../fileReads.ts";
import { WRONG_WORKER } from "../workerProtocol/checkoutMethods.ts";
import type { Payload } from "../workerProtocol/codec.ts";
import { WorkerRequestError } from "../workerProtocol/connection.ts";
import { FILE_METHODS, UNKNOWN_HANDLE } from "../workerProtocol/fileMethods.ts";
import {
  ensureInProcessWorker,
  inProcessWorkerFileHandlesForTests,
} from "../workers/inProcessWorker.ts";
import { DEFAULT_WORKER_ID } from "../workers/placement.ts";

/**
 * The Worker's file methods over the real codec, as raw requests: what any
 * server, not just this one's client, gets from them.
 */

let dir: string;
let small: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "worker-files-"));
  small = join(dir, "small.bin");
  writeFileSync(small, Buffer.from([0, 1, 2, 0xff, 0xfe, 0, 7]));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Nothing is held: no handle in the table, no descriptor open. */
function assertNothingHeld(): void {
  assert.equal(inProcessWorkerFileHandlesForTests(), 0, "handles held");
  assert.equal(
    fileReadsCountsForTests().liveDescriptors,
    0,
    "descriptors open",
  );
}

afterEach(assertNothingHeld);

const ask = (method: string, json: unknown): Promise<Payload> =>
  ensureInProcessWorker().request(method, { json });

const here = (path: string) => ({ workerId: DEFAULT_WORKER_ID, path });

async function openHandle(path: string, stat = false): Promise<number> {
  const answer = await ask(FILE_METHODS.open, { location: here(path), stat });
  const { opened } = answer.json as { opened: { handle: number } };
  return opened.handle;
}

async function rejectsWith(
  answer: Promise<Payload>,
  code: string,
): Promise<void> {
  await assert.rejects(answer, (error: unknown) => {
    assert.ok(error instanceof WorkerRequestError);
    assert.equal(error.code, code);
    return true;
  });
}

describe("addressing", () => {
  test("every method refuses another Worker's id and touches nothing", async () => {
    const fifo = join(dir, "never-opened.fifo");
    execFileSync("mkfifo", [fifo]);
    const other = { workerId: "elsewhere", path: fifo };
    const handle = await openHandle(small);
    const before = fileReadsCountsForTests();

    await rejectsWith(
      ask(FILE_METHODS.stat, { location: other }),
      WRONG_WORKER,
    );
    await rejectsWith(
      ask(FILE_METHODS.realpath, { location: other }),
      WRONG_WORKER,
    );
    // A FIFO would block a real open until a writer came: this answers at once.
    await rejectsWith(
      ask(FILE_METHODS.open, { location: other, stat: true }),
      WRONG_WORKER,
    );
    // The handle exists here; another Worker's id must not even look it up.
    await rejectsWith(
      ask(FILE_METHODS.read, {
        workerId: "elsewhere",
        handle,
        position: 0,
        length: 4,
      }),
      WRONG_WORKER,
    );
    await rejectsWith(
      ask(FILE_METHODS.close, { workerId: "elsewhere", handle }),
      WRONG_WORKER,
    );
    assert.deepEqual(fileReadsCountsForTests(), before);
    assert.equal(inProcessWorkerFileHandlesForTests(), 1, "the handle stays");

    await ask(FILE_METHODS.close, { workerId: DEFAULT_WORKER_ID, handle });
  });
});

describe("params", () => {
  test("an unknown handle, malformed params and a missing stat choice are refused", async () => {
    await rejectsWith(
      ask(FILE_METHODS.read, {
        workerId: DEFAULT_WORKER_ID,
        handle: 9999,
        position: 0,
        length: 1,
      }),
      UNKNOWN_HANDLE,
    );
    for (const [method, json] of [
      [FILE_METHODS.stat, { location: { path: small } }],
      [FILE_METHODS.realpath, null],
      [FILE_METHODS.open, { location: here(small) }],
      [FILE_METHODS.open, { location: here(small), stat: "yes" }],
      [
        FILE_METHODS.read,
        { workerId: DEFAULT_WORKER_ID, handle: 1, position: -1, length: 1 },
      ],
      [
        FILE_METHODS.read,
        { workerId: DEFAULT_WORKER_ID, handle: 1, position: 0, length: 1.5 },
      ],
      [FILE_METHODS.close, { workerId: DEFAULT_WORKER_ID, handle: 0 }],
    ] as const)
      await rejectsWith(ask(method, json), "invalid_params");
  });

  test("closing twice, or a handle never issued, is fine", async () => {
    const handle = await openHandle(small);
    const close = { workerId: DEFAULT_WORKER_ID, handle };
    assert.deepEqual((await ask(FILE_METHODS.close, close)).json, {});
    assert.deepEqual((await ask(FILE_METHODS.close, close)).json, {});
    // A closed handle reads as unknown, and its id is never issued again.
    await rejectsWith(
      ask(FILE_METHODS.read, { ...close, position: 0, length: 1 }),
      UNKNOWN_HANDLE,
    );
    const next = await openHandle(small);
    assert.ok(next > handle);
    await ask(FILE_METHODS.close, {
      workerId: DEFAULT_WORKER_ID,
      handle: next,
    });
  });
});

describe("open phases on the wire", () => {
  test("with stat, a failed descriptor stat answers phase stat and holds nothing", async () => {
    failFileForTests(small, { phase: "stat", code: "EIO" });
    const answer = await ask(FILE_METHODS.open, {
      location: here(small),
      stat: true,
    });
    assert.deepEqual(answer.json, { error: { code: "EIO", phase: "stat" } });
    assert.match(answer.text?.message ?? "", /^EIO: /);
    assertNothingHeld();

    const missing = join(dir, "missing.bin");
    const gone = await ask(FILE_METHODS.open, {
      location: here(missing),
      stat: true,
    });
    assert.deepEqual(gone.json, { error: { code: "ENOENT", phase: "open" } });
    assert.equal(
      gone.text?.message,
      `ENOENT: no such file or directory, open '${missing}'`,
    );
  });

  test("with stat, an open answers the descriptor's stat", async () => {
    const answer = await ask(FILE_METHODS.open, {
      location: here(small),
      stat: true,
    });
    const { opened } = answer.json as {
      opened: { handle: number; stat: Record<string, unknown> };
    };
    assert.equal(opened.stat.isFile, true);
    assert.equal(opened.stat.size, 7);
    await ask(FILE_METHODS.close, {
      workerId: DEFAULT_WORKER_ID,
      handle: opened.handle,
    });
  });

  test("without stat, the descriptor is never stat'ed", async () => {
    failFileForTests(small, { phase: "stat", code: "EIO" });
    const statsBefore = fileReadsCountsForTests().descriptorStats;
    const answer = await ask(FILE_METHODS.open, {
      location: here(small),
      stat: false,
    });
    const { opened } = answer.json as { opened: Record<string, unknown> };
    assert.deepEqual(Object.keys(opened), ["handle"]);
    assert.equal(fileReadsCountsForTests().descriptorStats, statsBefore);
    assert.equal(fileFaultArmedForTests(small), true, "the fault fired");
    // An open that does stat consumes it.
    await ask(FILE_METHODS.open, { location: here(small), stat: true });
    assert.equal(fileFaultArmedForTests(small), false);
    await ask(FILE_METHODS.close, {
      workerId: DEFAULT_WORKER_ID,
      handle: opened.handle as number,
    });

    const missing = join(dir, "missing.bin");
    const gone = await ask(FILE_METHODS.open, {
      location: here(missing),
      stat: false,
    });
    assert.deepEqual(gone.json, { error: { code: "ENOENT", phase: "open" } });
  });
});

describe("reads", () => {
  test("a huge length allocates and answers only the file's bytes", async () => {
    const handle = await openHandle(small);
    const answer = await ask(FILE_METHODS.read, {
      workerId: DEFAULT_WORKER_ID,
      handle,
      position: 0,
      length: 2 ** 40,
    });
    assert.deepEqual(
      [...(answer.bytes?.data ?? [])],
      [0, 1, 2, 0xff, 0xfe, 0, 7],
    );
    const past = await ask(FILE_METHODS.read, {
      workerId: DEFAULT_WORKER_ID,
      handle,
      position: 7,
      length: 10,
    });
    assert.equal(past.bytes?.data?.byteLength, 0, "empty means end of file");
    await ask(FILE_METHODS.close, { workerId: DEFAULT_WORKER_ID, handle });
  });
});
