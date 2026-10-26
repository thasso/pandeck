import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, test } from "vitest";
import {
  failFileForTests,
  fileFaultArmedForTests,
  fileReadsCountsForTests,
  holdFileForTests,
} from "../fileReads.ts";
import { WRONG_WORKER } from "../workerProtocol/checkoutMethods.ts";
import type { Payload } from "../workerProtocol/codec.ts";
import { WorkerRequestError } from "../workerProtocol/connection.ts";
import { FILE_METHODS, UNKNOWN_HANDLE } from "../workerProtocol/fileMethods.ts";
import {
  ensureInProcessWorker,
  inProcessWorkerEpochForTests,
  inProcessWorkerFileHandlesForTests,
  writeAsInProcessWorkerForTests,
} from "../workers/inProcessWorker.ts";
import { DEFAULT_WORKER_ID } from "../workers/placement.ts";

/**
 * The Worker's file methods over the real codec, as raw requests: what any
 * server, not just this one's client, gets from them.
 */

let dir: string;
let small: string;
let fifo: string;
let sub: string;
let link: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "worker-files-"));
  small = join(dir, "small.bin");
  writeFileSync(small, Buffer.from([0, 1, 2, 0xff, 0xfe, 0, 7]));
  fifo = join(dir, "never-opened.fifo");
  execFileSync("mkfifo", [fifo]);
  sub = join(dir, "sub");
  mkdirSync(sub);
  link = join(dir, "to-small.link");
  symlinkSync(small, link);
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

const INVALID_FRAME = new Uint8Array(8);

/** Let in-process deliveries and filesystem callbacks run. */
async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1)
    await new Promise<void>((done) => setImmediate(done));
}

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

  test("the path methods refuse another Worker's id before any path call", async () => {
    const methods = [
      [FILE_METHODS.exists, {}, "exists"],
      [FILE_METHODS.inspect, { follow: true }, "inspect"],
      [FILE_METHODS.inspect, { follow: false }, "inspect"],
      [FILE_METHODS.readdir, {}, "readdir"],
      [FILE_METHODS.readlink, {}, "readlink"],
    ] as const;
    for (const path of [fifo, sub, small, link])
      for (const [method, extra, phase] of methods) {
        const held = holdFileForTests(path, phase);
        let reached = false;
        void held.reached.then(() => (reached = true));
        const before = fileReadsCountsForTests();
        await rejectsWith(
          ask(method, { location: { workerId: "elsewhere", path }, ...extra }),
          WRONG_WORKER,
        );
        await settle();
        assert.deepEqual(fileReadsCountsForTests(), before, method);
        assert.equal(reached, false, `${method} reached ${path}`);
        // Disarm, as the positive control: a well-formed call takes the
        // barrier and makes its path call.
        held.release();
        await ask(method, { location: here(path), ...extra });
        assert.equal(reached, true);
        assert.equal(
          fileReadsCountsForTests().pathCalls,
          before.pathCalls + 1,
          `${method} made its path call`,
        );
      }
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

  test("the path methods refuse malformed params before any path call", async () => {
    const before = fileReadsCountsForTests().pathCalls;
    for (const [method, json] of [
      [FILE_METHODS.exists, null],
      [FILE_METHODS.exists, {}],
      [FILE_METHODS.exists, { location: { path: small } }],
      [
        FILE_METHODS.exists,
        { location: { workerId: DEFAULT_WORKER_ID, path: 5 } },
      ],
      [FILE_METHODS.inspect, { location: here(small) }],
      [FILE_METHODS.inspect, { location: here(small), follow: "yes" }],
      [FILE_METHODS.inspect, { follow: true }],
      [FILE_METHODS.readdir, null],
      [FILE_METHODS.readdir, { location: { workerId: DEFAULT_WORKER_ID } }],
      [FILE_METHODS.readdir, { location: "x" }],
      [FILE_METHODS.readlink, null],
      [FILE_METHODS.readlink, {}],
      [FILE_METHODS.readlink, { location: { path: link } }],
      [
        FILE_METHODS.readlink,
        { location: { workerId: DEFAULT_WORKER_ID, path: 5 } },
      ],
    ] as const)
      await rejectsWith(ask(method, json), "invalid_params");
    assert.equal(fileReadsCountsForTests().pathCalls, before);
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

describe("path methods on the wire", () => {
  test("exists answers as existsSync, never a failure", async () => {
    for (const [path, exists] of [
      [small, true],
      [sub, true],
      [fifo, true],
      [join(dir, "missing"), false],
      [join(small, "below-a-file"), false],
    ] as const) {
      assert.equal(existsSync(path), exists, `oracle for ${path}`);
      assert.deepEqual(
        (await ask(FILE_METHODS.exists, { location: here(path) })).json,
        { exists },
        path,
      );
    }
  });

  test("inspect answers kind, mode and full-precision identity, both ways on a link", async () => {
    const digits = (stats: BigIntStats) => ({
      dev: String(stats.dev),
      ino: String(stats.ino),
      size: String(stats.size),
      mtimeNs: String(stats.mtimeNs),
      mode: String(stats.mode),
    });
    for (const [path, follow, kind, oracle] of [
      [link, true, "file", statSync(link, { bigint: true })],
      [link, false, "symlink", lstatSync(link, { bigint: true })],
      [sub, true, "directory", statSync(sub, { bigint: true })],
      [fifo, false, "other", lstatSync(fifo, { bigint: true })],
    ] as const)
      assert.deepEqual(
        (await ask(FILE_METHODS.inspect, { location: here(path), follow }))
          .json,
        { inspection: { kind, ...digits(oracle) } },
      );
    for (const [path, code] of [
      [join(dir, "missing"), "ENOENT"],
      [join(small, "below-a-file"), "ENOTDIR"],
    ] as const) {
      const answer = await ask(FILE_METHODS.inspect, {
        location: here(path),
        follow: true,
      });
      assert.deepEqual(answer.json, { error: { code } });
      assert.match(answer.text?.message ?? "", new RegExp(`^${code}: `));
    }
  });

  test("readlink answers the link text as readlinkSync, a failure with its code", async () => {
    const before = fileReadsCountsForTests().pathCalls;
    assert.deepEqual(
      (await ask(FILE_METHODS.readlink, { location: here(link) })).json,
      { target: readlinkSync(link) },
    );
    assert.equal(fileReadsCountsForTests().pathCalls, before + 1);
    for (const [path, code] of [
      [small, "EINVAL"],
      [join(dir, "missing"), "ENOENT"],
      [join(small, "below-a-file"), "ENOTDIR"],
    ] as const) {
      let oracle: NodeJS.ErrnoException | undefined;
      try {
        readlinkSync(path);
      } catch (error) {
        oracle = error as NodeJS.ErrnoException;
      }
      assert.equal(oracle?.code, code, `oracle for ${path}`);
      const answer = await ask(FILE_METHODS.readlink, { location: here(path) });
      assert.deepEqual(answer.json, { error: { code } });
      assert.equal(answer.text?.message, oracle?.message);
    }
  });

  test("readdir answers entries in readdir order, a directory link as not a directory", async () => {
    const listed = join(dir, "listed");
    mkdirSync(join(listed, "inner"), { recursive: true });
    writeFileSync(join(listed, "file.txt"), "x");
    symlinkSync(join(listed, "inner"), join(listed, "inner.link"));
    const answer = await ask(FILE_METHODS.readdir, { location: here(listed) });
    const { entries } = answer.json as {
      entries: { name: string; directory: boolean }[];
    };
    assert.deepEqual(
      entries,
      readdirSync(listed, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        directory: entry.isDirectory(),
      })),
    );
    assert.deepEqual(
      Object.fromEntries(entries.map((e) => [e.name, e.directory])),
      { "file.txt": false, inner: true, "inner.link": false },
    );
    const notDir = await ask(FILE_METHODS.readdir, { location: here(small) });
    assert.deepEqual(notDir.json, { error: { code: "ENOTDIR" } });
  });

  test("an injected path fault answers its code, as a native failure does", async () => {
    failFileForTests(small, { phase: "inspect", code: "EIO" });
    const answer = await ask(FILE_METHODS.inspect, {
      location: here(small),
      follow: false,
    });
    assert.deepEqual(answer.json, { error: { code: "EIO" } });
    assert.match(answer.text?.message ?? "", /^EIO: injected fault, stat /);

    failFileForTests(link, { phase: "readlink", code: "EIO" });
    const linkAnswer = await ask(FILE_METHODS.readlink, {
      location: here(link),
    });
    assert.deepEqual(linkAnswer.json, { error: { code: "EIO" } });
    assert.match(
      linkAnswer.text?.message ?? "",
      /^EIO: injected fault, readlink /,
    );
  });
});

describe("quiescence of the path methods", () => {
  test.each([
    [FILE_METHODS.exists, {}, "exists"],
    [FILE_METHODS.inspect, { follow: true }, "inspect"],
    [FILE_METHODS.readdir, {}, "readdir"],
    [FILE_METHODS.readlink, {}, "readlink"],
  ] as const)(
    "%s held at connection end rejects only after release, while a replacement serves",
    async (method, extra, phase) => {
      const held = holdFileForTests(sub, phase);
      const epoch = inProcessWorkerEpochForTests();
      let settled = false;
      const pending = ask(method, { location: here(sub), ...extra }).finally(
        () => (settled = true),
      );
      await held.reached;
      writeAsInProcessWorkerForTests(INVALID_FRAME);
      await settle();
      assert.equal(settled, false, "held until the handler settles");

      // A new epoch serves meanwhile.
      const replacement = await ask(FILE_METHODS.exists, {
        location: here(small),
      });
      assert.deepEqual(replacement.json, { exists: true });
      assert.ok(epoch !== undefined);
      assert.equal(inProcessWorkerEpochForTests(), epoch + 1);
      assert.equal(settled, false);

      held.release();
      await assert.rejects(pending, /The Worker connection ended/);
    },
  );
});
