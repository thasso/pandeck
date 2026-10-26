import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, test } from "vitest";
import {
  checkLexicalPath,
  checkoutFailureOf,
  checkoutPathExists,
  containedRealPath,
  inspectCheckoutPath,
  readCheckoutDir,
  readCheckoutFile,
  realpathInCheckout,
  throwInCheckoutReadForTests,
} from "./checkoutFileAccess.ts";
import {
  failFileForTests,
  fileFaultArmedForTests,
  fileReadsCountsForTests,
  holdFileForTests,
} from "./fileReads.ts";
import { updateSettings } from "./settings.ts";
import { WorkerMethodError } from "./workerProtocol/connection.ts";
import {
  AnsweredFileFailure,
  FILE_METHODS,
} from "./workerProtocol/fileMethods.ts";
import { isWorkerFailure } from "./workers/fileClient.ts";
import {
  answerNextInProcessWorkerCallForTests,
  inProcessWorkerFileHandlesForTests,
  inProcessWorkerServedForTests,
  inProcessWorkerServedMethodForTests,
  writeAsInProcessWorkerForTests,
} from "./workers/inProcessWorker.ts";

/**
 * The checkout-file access on both sides: a checkout outside the Knowledge
 * Base reads through the in-process Worker over the real codec, and the
 * Knowledge Base on the server through `fileReads.ts`. Faults go in through
 * the real handlers' seams or the Worker's one-shot answer substitution,
 * never a mock transport.
 */

const INVALID_FRAME = new Uint8Array(8);
const MIB = 1024 * 1024;

let scratch: string;
/** A checkout read by the Worker. */
let onWorker: string;
/** The Knowledge Base, read on the server. */
let onServer: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "checkout-file-access-"));
  onWorker = join(scratch, "checkout");
  onServer = join(scratch, "kb");
  mkdirSync(onWorker);
  mkdirSync(onServer);
  updateSettings({
    knowledgeBase: { enabled: true, path: onServer, effectivePath: "ignored" },
  });
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Nothing is held: no handle in the table, no descriptor open anywhere. */
async function assertNothingHeld(): Promise<void> {
  await settle();
  assert.equal(inProcessWorkerFileHandlesForTests(), 0, "handles held");
  assert.equal(
    fileReadsCountsForTests().liveDescriptors,
    0,
    "descriptors open",
  );
}

afterEach(assertNothingHeld);

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1)
    await new Promise<void>((done) => setImmediate(done));
}

const SIDES = [
  ["Worker", () => onWorker],
  ["server", () => onServer],
] as const;

function fixture(root: string, name: string, bytes: Buffer | string): string {
  const path = join(root, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

/** Bytes that are every value, in a fixed order. */
function binary(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let at = 0; at < size; at += 1) bytes[at] = (at * 151 + 7) & 0xff;
  return bytes;
}

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** How many requests of each method the in-process Worker served for `run`. */
async function servedBy<T>(
  methods: string[],
  run: () => Promise<T>,
): Promise<{ result: T; served: Record<string, number> }> {
  const before = methods.map(inProcessWorkerServedMethodForTests);
  const result = await run();
  return {
    result,
    served: Object.fromEntries(
      methods.map((method, at) => [
        method,
        inProcessWorkerServedMethodForTests(method) - before[at]!,
      ]),
    ),
  };
}

/** The error a promise rejects with. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected a rejection");
}

/** The error `run` throws. */
function rejectionSync(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  assert.fail("expected a throw");
}

describe("each read runs on the side of its checkout root", () => {
  test("a checkout outside the Knowledge Base reads through the Worker", async () => {
    const file = fixture(onWorker, "routed/a.txt", "alpha\n");
    const dir = join(onWorker, "routed");
    const cases: [string, () => Promise<unknown>, unknown][] = [
      [FILE_METHODS.exists, () => checkoutPathExists(onWorker, file), true],
      [
        FILE_METHODS.inspect,
        async () =>
          (await inspectCheckoutPath(onWorker, file, { follow: false })).kind,
        "file",
      ],
      [
        FILE_METHODS.readdir,
        () => readCheckoutDir(onWorker, dir),
        [{ name: "a.txt", directory: false }],
      ],
      [
        FILE_METHODS.realpath,
        () => realpathInCheckout(onWorker, file),
        realpathSync(file),
      ],
    ];
    for (const [method, run, expected] of cases) {
      const { result, served } = await servedBy([method], run);
      assert.deepEqual(result, expected, method);
      assert.equal(served[method], 1, method);
    }
    const { result, served } = await servedBy(
      [FILE_METHODS.open, FILE_METHODS.read, FILE_METHODS.close],
      () => readCheckoutFile(onWorker, file),
    );
    assert.equal(result.toString(), "alpha\n");
    assert.deepEqual(served, {
      [FILE_METHODS.open]: 1,
      [FILE_METHODS.read]: 1,
      [FILE_METHODS.close]: 1,
    });
  });

  test("the Knowledge Base reads on the server and sends the Worker nothing", async () => {
    const file = fixture(onServer, "routed/a.txt", "alpha\n");
    const before = inProcessWorkerServedForTests();
    const pathCalls = fileReadsCountsForTests().pathCalls;
    assert.equal(await checkoutPathExists(onServer, file), true);
    assert.equal(
      (await inspectCheckoutPath(onServer, file, { follow: true })).kind,
      "file",
    );
    assert.deepEqual(
      await readCheckoutDir(onServer, join(onServer, "routed")),
      [{ name: "a.txt", directory: false }],
    );
    assert.equal(await realpathInCheckout(onServer, file), realpathSync(file));
    assert.equal(
      (await readCheckoutFile(onServer, file)).toString(),
      "alpha\n",
    );
    assert.equal(inProcessWorkerServedForTests(), before, "no Worker request");
    assert.equal(fileReadsCountsForTests().pathCalls, pathCalls + 4);
  });

  test.each(SIDES)(
    "%s: an entry modified before 1970 inspects to its native digits, both ways on a link",
    async (_side, root) => {
      const file = fixture(root(), "pre-epoch/a.txt", "x");
      const link = join(root(), "pre-epoch/a.link");
      symlinkSync(file, link);
      const before1970 = new Date("1960-01-01T00:00:00Z");
      utimesSync(file, before1970, before1970);
      lutimesSync(link, before1970, before1970);
      for (const [follow, kind, oracle] of [
        [true, "file", statSync(link, { bigint: true })],
        [false, "symlink", lstatSync(link, { bigint: true })],
      ] as const) {
        assert.ok(oracle.mtimeNs < 0n, "the fixture predates the epoch");
        assert.deepEqual(await inspectCheckoutPath(root(), link, { follow }), {
          kind,
          dev: String(oracle.dev),
          ino: String(oracle.ino),
          size: String(oracle.size),
          mtimeNs: String(oracle.mtimeNs),
        });
      }
    },
  );
});

describe("where an error came from", () => {
  test("anything unmarked is unclassified, even with a code", () => {
    assert.equal(
      checkoutFailureOf(Object.assign(new Error("x"), { code: "ENOENT" })),
      undefined,
    );
    assert.equal(
      checkoutFailureOf(
        Object.assign(new Error("x"), { code: "ENOENT", errno: -2 }),
      ),
      undefined,
      "only a primitive's own rejection is marked",
    );
    assert.equal(checkoutFailureOf(new AnsweredFileFailure("x")), undefined);
    assert.equal(checkoutFailureOf(undefined), undefined);
    assert.equal(checkoutFailureOf("ENOENT"), undefined);
  });

  test("a lexical escape is the server's verdict", () => {
    for (const rel of ["", "/etc/passwd", "../x", "a/../../x", "."]) {
      const error = rejectionSync(() => checkLexicalPath(onWorker, rel));
      assert.equal(checkoutFailureOf(error), "verdict", rel);
      assert.equal((error as Error).message, "Invalid file path.");
    }
    assert.equal(checkLexicalPath(onWorker, "a/b"), join(onWorker, "a/b"));
  });

  test.each(SIDES)(
    "%s: a filesystem failure is marked where it was answered",
    async (_side, root) => {
      const missing = join(root(), "missing");
      const file = fixture(root(), "marked.txt", "x");
      for (const error of [
        await rejection(inspectCheckoutPath(root(), missing, { follow: true })),
        await rejection(readCheckoutDir(root(), file)),
        await rejection(realpathInCheckout(root(), missing)),
        await rejection(readCheckoutFile(root(), missing)),
      ]) {
        assert.equal(checkoutFailureOf(error), "filesystem", String(error));
        assert.equal(isWorkerFailure(error), false);
      }
      // An answered failure with no code is still the filesystem's.
      if (root() === onWorker) {
        answerNextInProcessWorkerCallForTests(
          FILE_METHODS.inspect,
          async () => ({
            json: { error: { code: null } },
            text: { message: "Odd." },
          }),
        );
        const error = await rejection(
          inspectCheckoutPath(root(), file, { follow: true }),
        );
        assert.equal(checkoutFailureOf(error), "filesystem");
        assert.equal("code" in (error as object), false);
      }
    },
  );

  test("a local rejection is the filesystem's only with a native errno", async () => {
    const file = fixture(onServer, "errno.txt", "x");
    failFileForTests(file, { phase: "inspect", code: "EIO" });
    const native = await rejection(
      inspectCheckoutPath(onServer, file, { follow: false }),
    );
    assert.equal(checkoutFailureOf(native), "filesystem");
    failFileForTests(file, { phase: "inspect", code: "EIO", bare: true });
    const bare = await rejection(
      inspectCheckoutPath(onServer, file, { follow: false }),
    );
    assert.equal((bare as NodeJS.ErrnoException).code, "EIO");
    assert.equal(checkoutFailureOf(bare), undefined);
  });

  test("no answer from the Worker is a Worker failure: malformed, refused or ended", async () => {
    const file = fixture(onWorker, "worker-failure.txt", "x");
    answerNextInProcessWorkerCallForTests(FILE_METHODS.exists, async () => ({
      json: { exists: "yes" },
    }));
    const malformed = await rejection(checkoutPathExists(onWorker, file));
    assert.equal(checkoutFailureOf(malformed), "worker");

    answerNextInProcessWorkerCallForTests(FILE_METHODS.readdir, async () => {
      throw new WorkerMethodError("wrong_worker", "Not here.");
    });
    const refused = await rejection(readCheckoutDir(onWorker, onWorker));
    assert.equal(checkoutFailureOf(refused), "worker");

    const held = holdFileForTests(file, "inspect");
    const pending = rejection(
      inspectCheckoutPath(onWorker, file, { follow: true }),
    );
    await held.reached;
    writeAsInProcessWorkerForTests(INVALID_FRAME);
    held.release();
    const ended = await pending;
    assert.match(String(ended), /The Worker connection ended/);
    assert.equal(checkoutFailureOf(ended), "worker");
  });
});

describe("containedRealPath", () => {
  test.each(SIDES)(
    "%s: inside, missing and escaping, as base",
    async (_side, root) => {
      const file = fixture(root(), "contained/in.txt", "x");
      assert.equal(
        await containedRealPath(root(), "contained/in.txt"),
        realpathSync(file),
      );
      // A missing file answers its lexical path, without resolving the root.
      const { result, served } = await servedBy([FILE_METHODS.realpath], () =>
        containedRealPath(root(), "contained/missing.txt"),
      );
      assert.equal(result, join(root(), "contained/missing.txt"));
      assert.equal(served[FILE_METHODS.realpath], root() === onWorker ? 1 : 0);
      symlinkSync(scratch, join(root(), "contained/out"));
      const escape = await rejection(
        containedRealPath(root(), "contained/out"),
      );
      assert.equal(checkoutFailureOf(escape), "verdict");
      assert.equal((escape as Error).message, "Invalid file path.");
      const lexical = await rejection(containedRealPath(root(), "../kb"));
      assert.equal(checkoutFailureOf(lexical), "verdict");
    },
  );

  test("an unresolvable root falls back to itself only on a filesystem failure", async () => {
    const file = fixture(onWorker, "fallback/in.txt", "x");
    // The second realpath, of the root, answers a filesystem failure.
    let calls = 0;
    const answerRootFailure = () =>
      answerNextInProcessWorkerCallForTests(
        FILE_METHODS.realpath,
        async (payload, signal, real) => {
          calls += 1;
          if (calls === 1) {
            answerRootFailure();
            return real(payload, signal);
          }
          return {
            json: { error: { code: "EACCES" } },
            text: { message: "EACCES: denied" },
          };
        },
      );
    answerRootFailure();
    assert.equal(
      await containedRealPath(onWorker, "fallback/in.txt"),
      realpathSync(file),
    );
    assert.equal(calls, 2);
  });

  test("a Worker failure at either realpath rejects, never falls back", async () => {
    fixture(onWorker, "nofallback/in.txt", "x");
    answerNextInProcessWorkerCallForTests(FILE_METHODS.realpath, async () => ({
      json: { path: 5 },
    }));
    const first = await rejection(
      containedRealPath(onWorker, "nofallback/in.txt"),
    );
    assert.equal(checkoutFailureOf(first), "worker");

    let calls = 0;
    const second = () =>
      answerNextInProcessWorkerCallForTests(
        FILE_METHODS.realpath,
        async (payload, signal, real) => {
          calls += 1;
          if (calls === 1) {
            second();
            return real(payload, signal);
          }
          throw new WorkerMethodError("unknown_method", "No such method.");
        },
      );
    second();
    const root = await rejection(
      containedRealPath(onWorker, "nofallback/in.txt"),
    );
    assert.equal(checkoutFailureOf(root), "worker");
    assert.equal(calls, 2);
  });

  test("an unclassified local realpath failure propagates", async () => {
    const file = fixture(onServer, "bare/in.txt", "x");
    failFileForTests(file, { phase: "realpath", code: "ENOENT", bare: true });
    const error = await rejection(containedRealPath(onServer, "bare/in.txt"));
    assert.equal(checkoutFailureOf(error), undefined);
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
  });
});

describe("readCheckoutFile follows production's readFile", () => {
  test("Node pins: readFile and readFileSync reject a directory with EISDIR", async () => {
    await assert.rejects(readFile(scratch), { code: "EISDIR" });
    assert.throws(() => readFileSync(scratch), { code: "EISDIR" });
  });

  test.each(SIDES)(
    "%s: no descriptor stat, and the content",
    async (_side, root) => {
      const file = fixture(root(), "nostat.bin", binary(3000));
      failFileForTests(file, { phase: "stat", code: "EIO" });
      const stats = fileReadsCountsForTests().descriptorStats;
      assert.ok((await readCheckoutFile(root(), file)).equals(binary(3000)));
      assert.ok(
        (await readCheckoutFile(root(), file, 100)).equals(
          binary(3000).subarray(0, 100),
        ),
      );
      // The fault stays armed on this test's own path: nothing stat'ed it.
      assert.equal(fileFaultArmedForTests(file), true, "still armed");
      assert.equal(fileReadsCountsForTests().descriptorStats, stats);
    },
  );

  test.each(SIDES)(
    "%s: bytes appended after the open are read, up to the limit",
    async (_side, root) => {
      const file = fixture(root(), "grow.txt", "abc");
      const held = holdFileForTests(file, "after-open");
      const reading = readCheckoutFile(root(), file);
      await held.reached;
      appendFileSync(file, "def");
      held.release();
      assert.equal((await reading).toString(), "abcdef");

      writeFileSync(file, "abc");
      const capped = holdFileForTests(file, "after-open");
      const limited = readCheckoutFile(root(), file, 5);
      await capped.reached;
      appendFileSync(file, "def");
      capped.release();
      assert.equal((await limited).toString(), "abcde");
    },
  );

  test.each(SIDES)(
    "%s: a file shrunk after the open reads short; an empty one reads nothing",
    async (_side, root) => {
      const file = fixture(root(), "shrink.txt", "abcdef");
      const held = holdFileForTests(file, "after-open");
      const reading = readCheckoutFile(root(), file);
      await held.reached;
      truncateSync(file, 2);
      held.release();
      assert.equal((await reading).toString(), "ab");
      const empty = fixture(root(), "empty.txt", "");
      assert.equal((await readCheckoutFile(root(), empty)).byteLength, 0);
      assert.equal((await readCheckoutFile(root(), empty, 10)).byteLength, 0);
    },
  );

  test.each(SIDES)(
    "%s: a directory is the filesystem's EISDIR",
    async (_side, root) => {
      for (const limit of [undefined, 10]) {
        const error = await rejection(readCheckoutFile(root(), root(), limit));
        assert.equal((error as NodeJS.ErrnoException).code, "EISDIR");
        assert.equal(checkoutFailureOf(error), "filesystem");
      }
    },
  );

  test("an uncapped read takes 8 MiB requests until one comes back short", async () => {
    const bytes = binary(20 * MIB + 3);
    const file = fixture(onWorker, "multi.bin", bytes);
    const { result, served } = await servedBy(
      [FILE_METHODS.open, FILE_METHODS.read, FILE_METHODS.close],
      () => readCheckoutFile(onWorker, file),
    );
    assert.equal(result.byteLength, 20 * MIB + 3);
    assert.equal(sha256(result), sha256(bytes));
    assert.deepEqual(served, {
      [FILE_METHODS.open]: 1,
      [FILE_METHODS.read]: 3,
      [FILE_METHODS.close]: 1,
    });

    // At an exact multiple, the end is the empty answer after it.
    const exact = fixture(onWorker, "exact.bin", binary(16 * MIB));
    const twice = await servedBy([FILE_METHODS.read], () =>
      readCheckoutFile(onWorker, exact),
    );
    assert.equal(sha256(twice.result), sha256(binary(16 * MIB)));
    assert.equal(twice.served[FILE_METHODS.read], 3);

    const local = fixture(onServer, "multi.bin", bytes);
    assert.equal(
      sha256(await readCheckoutFile(onServer, local)),
      sha256(bytes),
    );
  });

  test("a capped read is one request for at most the limit", async () => {
    const file = fixture(onWorker, "capped.bin", binary(1000));
    for (const [limit, length] of [
      [998, 998],
      [1000, 1000],
      [1001, 1000],
    ] as const) {
      const { result, served } = await servedBy(
        [FILE_METHODS.open, FILE_METHODS.read, FILE_METHODS.close],
        () => readCheckoutFile(onWorker, file, limit),
      );
      assert.ok(result.equals(binary(1000).subarray(0, length)));
      assert.deepEqual(Object.values(served), [1, 1, 1], String(limit));
    }
  });

  test("a held open ended by the connection rejects with a Worker failure", async () => {
    const file = fixture(onWorker, "held-open.txt", "x");
    const held = holdFileForTests(file, "before-open");
    const pending = rejection(readCheckoutFile(onWorker, file));
    await held.reached;
    writeAsInProcessWorkerForTests(INVALID_FRAME);
    held.release();
    const error = await pending;
    assert.equal(checkoutFailureOf(error), "worker");
  });
});

describe("read and close failures", () => {
  test.each(SIDES)(
    "%s: an error thrown by the reader's own logic is never mapped",
    async (_side, root) => {
      const file = fixture(root(), "sentinel.txt", "x");
      const sentinel = new TypeError("sentinel");
      throwInCheckoutReadForTests(sentinel, { at: "read" });
      assert.equal(await rejection(readCheckoutFile(root(), file)), sentinel);
      // A successful read with an unclassified close error throws it.
      throwInCheckoutReadForTests(sentinel, { at: "close" });
      assert.equal(await rejection(readCheckoutFile(root(), file)), sentinel);
      assert.equal(checkoutFailureOf(sentinel), undefined);
    },
  );

  test.each(SIDES)(
    "%s: (iv) a filesystem read failure loses to an unclassified close error",
    async (_side, root) => {
      const sentinel = new TypeError("sentinel");
      throwInCheckoutReadForTests(sentinel, { at: "close" });
      // The read of a directory fails EISDIR, answered or native.
      assert.equal(await rejection(readCheckoutFile(root(), root())), sentinel);
    },
  );

  test("(i) a malformed read wins over a close answered EIO", async () => {
    const file = fixture(onWorker, "pair-i.txt", "x");
    answerNextInProcessWorkerCallForTests(FILE_METHODS.read, async () => ({
      json: {},
    }));
    answerNextInProcessWorkerCallForTests(
      FILE_METHODS.close,
      async (payload, signal, real) => {
        await real(payload, signal);
        return {
          json: { error: { code: "EIO" } },
          text: { message: "EIO: close" },
        };
      },
    );
    const error = await rejection(readCheckoutFile(onWorker, file));
    assert.match(String(error), /malformed file bytes/);
    assert.equal(checkoutFailureOf(error), "worker");
    assert.equal(inProcessWorkerFileHandlesForTests(), 0);
  });

  test("(ii) a read answered EIO loses to a refused close", async () => {
    const file = fixture(onWorker, "pair-ii.txt", "x");
    answerNextInProcessWorkerCallForTests(FILE_METHODS.read, async () => ({
      json: { error: { code: "EIO" } },
      text: { message: "EIO: read" },
    }));
    answerNextInProcessWorkerCallForTests(FILE_METHODS.close, async () => {
      throw new WorkerMethodError("unknown_handle", "No such handle.");
    });
    const error = await rejection(readCheckoutFile(onWorker, file));
    assert.equal((error as Error).message, "No such handle.");
    assert.equal(checkoutFailureOf(error), "worker");
    // The refused close left the handle; a connection end sweeps it.
    assert.equal(inProcessWorkerFileHandlesForTests(), 1);
    writeAsInProcessWorkerForTests(INVALID_FRAME);
  });

  test("(iii) a good read with a close answered EIO is the close's filesystem failure", async () => {
    const file = fixture(onWorker, "pair-iii.txt", "x");
    answerNextInProcessWorkerCallForTests(
      FILE_METHODS.close,
      async (payload, signal, real) => {
        await real(payload, signal);
        return {
          json: { error: { code: "EIO" } },
          text: { message: "EIO: close" },
        };
      },
    );
    const error = await rejection(readCheckoutFile(onWorker, file));
    assert.equal((error as NodeJS.ErrnoException).code, "EIO");
    assert.equal(checkoutFailureOf(error), "filesystem");
  });

  test("a read and a close both answered failures throw the read's", async () => {
    const file = fixture(onWorker, "pair-fs.txt", "x");
    answerNextInProcessWorkerCallForTests(FILE_METHODS.read, async () => ({
      json: { error: { code: "EIO" } },
      text: { message: "EIO: read" },
    }));
    answerNextInProcessWorkerCallForTests(
      FILE_METHODS.close,
      async (payload, signal, real) => {
        await real(payload, signal);
        return {
          json: { error: { code: "EBADF" } },
          text: { message: "EBADF: close" },
        };
      },
    );
    const error = await rejection(readCheckoutFile(onWorker, file));
    assert.equal((error as Error).message, "EIO: read");
    assert.equal(checkoutFailureOf(error), "filesystem");
  });

  test("a read failing in the Worker wins over a close answered EIO", async () => {
    const file = fixture(onWorker, "pair-close-worker.txt", "x");
    answerNextInProcessWorkerCallForTests(FILE_METHODS.read, async () => ({
      json: { error: { code: "EIO" } },
      text: { message: "EIO: read" },
    }));
    answerNextInProcessWorkerCallForTests(FILE_METHODS.close, async () => ({
      json: 5,
    }));
    const error = await rejection(readCheckoutFile(onWorker, file));
    assert.match(String(error), /malformed file answer/);
    assert.equal(checkoutFailureOf(error), "worker");
    writeAsInProcessWorkerForTests(INVALID_FRAME);
  });
});
