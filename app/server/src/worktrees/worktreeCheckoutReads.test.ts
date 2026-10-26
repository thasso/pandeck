import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, test } from "vitest";
import {
  checkoutFailureOf,
  throwInCheckoutReadForTests,
} from "../checkoutFileAccess.ts";
import type { WorktreeRow } from "../db/worktreeStore.ts";
import {
  mintDocumentTargetGrant,
  type DocumentGrantResolverDependencies,
} from "../documentGrantTargets.ts";
import {
  failFileForTests,
  fileFaultArmedForTests,
  fileReadsCountsForTests,
  holdFileForTests,
} from "../fileReads.ts";
import {
  clearRepoLockKeysForTests,
  countGitExecutionsForTests,
  repoLockKey,
} from "../gitExec.ts";
import { updateSettings } from "../settings.ts";
import {
  MALFORMED_ANSWERS,
  answerForPathForTests,
  answeredFailure,
  answering,
} from "../test/workerAnswers.ts";
import {
  WorkerMethodError,
  WorkerRequestError,
} from "../workerProtocol/connection.ts";
import {
  AnsweredFileFailure,
  FILE_METHODS,
  MalformedWorkerAnswerError,
} from "../workerProtocol/fileMethods.ts";
import { isWorkerFailure } from "../workers/fileClient.ts";
import {
  answerNextInProcessWorkerCallForTests,
  inProcessWorkerFileHandlesForTests,
  inProcessWorkerQuiescentForTests,
  inProcessWorkerServedForTests,
  inProcessWorkerServedMethodForTests,
  writeAsInProcessWorkerForTests,
} from "../workers/inProcessWorker.ts";
import {
  getWorktreeFileContent,
  getWorktreeFileRaw,
  getWorktreeTree,
} from "./worktreeDiff.ts";
import {
  computeWorktreeStatus,
  refreshWorktreeWorkingTree,
} from "./worktreeStatus.ts";

/**
 * The worktree surfaces' checkout reads (`docs/workers.md`, "Checkout
 * files"): a checkout outside the Knowledge Base reads through the in-process
 * Worker over the real codec, the Knowledge Base on the server. Every expected
 * value is base's: its `readFile`, `lstat`, `readdir` and `realpathSync`.
 */

const INVALID_FRAME = new Uint8Array(8);
const KIB = 1024;
const MIB = 1024 * KIB;
const MAX_TEXT_BYTES = 512 * KIB;
const MAX_RAW_BYTES = 20 * MIB;

let scratch: string;
let outside: string;
let workerRow: WorktreeRow;
let serverRow: WorktreeRow;

function rowOf(id: string, path: string): WorktreeRow {
  return {
    id,
    projectId: "project-1",
    path,
    mainRepoRoot: path,
    branch: "main",
    baseBranch: "main",
    baseCommit: "",
    status: "active",
    mergeStateJson: null,
    branchCleanupOid: null,
    createdAt: 1,
    updatedAt: 1,
    removedAt: null,
  };
}

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function checkout(path: string): void {
  mkdirSync(path);
  sh(path, "init", "-q", "-b", "main");
  writeFileSync(join(path, "a.txt"), "alpha\n");
  mkdirSync(join(path, "dir"));
  writeFileSync(join(path, "dir", "b.txt"), "beta\n");
  symlinkSync(join(outside, "secret.txt"), join(path, "escape.txt"));
  symlinkSync(outside, join(path, "escape-dir"));
  sh(path, "add", "a.txt", "dir/b.txt");
  sh(path, "commit", "-qm", "init");
}

beforeAll(() => {
  // Canonical from the start, so git's and the Worker's spellings agree.
  scratch = mkdtempSync(join(realpathSync(tmpdir()), "worktree-reads-"));
  outside = join(scratch, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "SECRET");
  const onWorker = join(scratch, "checkout");
  const onServer = join(scratch, "kb");
  checkout(onWorker);
  checkout(onServer);
  updateSettings({
    knowledgeBase: { enabled: true, path: onServer, effectivePath: "ignored" },
  });
  workerRow = rowOf("worktree-on-worker", onWorker);
  serverRow = rowOf("worktree-on-server", onServer);
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1)
    await new Promise<void>((done) => setImmediate(done));
}

afterEach(async () => {
  await settle();
  assert.equal(inProcessWorkerFileHandlesForTests(), 0, "handles held");
  assert.equal(
    fileReadsCountsForTests().liveDescriptors,
    0,
    "descriptors open",
  );
});

const SIDES = [
  ["Worker", () => workerRow],
  ["server", () => serverRow],
] as const;

function fixture(row: WorktreeRow, name: string, bytes: Buffer | string) {
  const path = join(row.path, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

/** Bytes that are every value but zero, in a fixed order. */
function nonZero(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let at = 0; at < size; at += 1) bytes[at] = ((at * 151 + 7) % 255) + 1;
  return bytes;
}

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const READ_METHODS = [
  FILE_METHODS.open,
  FILE_METHODS.read,
  FILE_METHODS.close,
] as const;

/** How many requests of each method the in-process Worker served for `run`. */
async function servedBy<T>(
  methods: readonly string[],
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

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected a rejection");
}

const text = (row: WorktreeRow, path: string) =>
  getWorktreeFileContent(row, path).then(({ content, binary, truncated }) => ({
    content,
    binary,
    truncated,
  }));
const EMPTY = { content: "", binary: false, truncated: false };

describe("AC3 working-tree text at the 512 KiB boundary", () => {
  test.each(SIDES)("%s", async (_side, row) => {
    const exact = "a".repeat(MAX_TEXT_BYTES);
    fixture(row(), "text/exact.txt", exact);
    assert.deepEqual(await text(row(), "text/exact.txt"), {
      content: exact,
      binary: false,
      truncated: false,
    });
    fixture(row(), "text/over.txt", `${exact}b`);
    assert.deepEqual(await text(row(), "text/over.txt"), {
      content: exact,
      binary: false,
      truncated: true,
    });
    // The NUL is the 524,289th byte: past the text, so not binary.
    fixture(
      row(),
      "text/nul.txt",
      Buffer.concat([Buffer.from(exact), Buffer.from([0])]),
    );
    assert.deepEqual(await text(row(), "text/nul.txt"), {
      content: exact,
      binary: false,
      truncated: true,
    });
  });
});

describe("AC4 working-tree raw at the 20 MiB boundary", () => {
  test("exactly 20 MiB is served whole, one open, read and close", async () => {
    const bytes = nonZero(MAX_RAW_BYTES);
    fixture(workerRow, "raw/exact.bin", bytes);
    const { result, served } = await servedBy(READ_METHODS, () =>
      getWorktreeFileRaw(workerRow, "raw/exact.bin"),
    );
    assert.equal(result.content.length, 20_971_520);
    assert.equal(sha256(result.content), sha256(bytes));
    assert.deepEqual(Object.values(served), [1, 1, 1]);
  });

  test.each([1, 2])(
    "20 MiB + %i is refused, one open, read and close",
    async (over) => {
      fixture(workerRow, `raw/over-${over}.bin`, nonZero(MAX_RAW_BYTES + over));
      const { result, served } = await servedBy(READ_METHODS, () =>
        rejection(getWorktreeFileRaw(workerRow, `raw/over-${over}.bin`)),
      );
      assert.equal(
        (result as Error).message,
        "File is too large to serve raw.",
      );
      assert.deepEqual(Object.values(served), [1, 1, 1]);
    },
  );

  test.each(SIDES)(
    "%s: an escaping link and a missing file keep base's messages",
    async (_side, row) => {
      await assert.rejects(getWorktreeFileRaw(row(), "escape.txt"), {
        message: "Invalid file path.",
      });
      await assert.rejects(getWorktreeFileRaw(row(), "missing.txt"), {
        message: "File not found.",
      });
    },
  );
});

/** Base's `includeIgnored` listing: `readdir` Dirents, `lstat` sizes. */
function baseListing(dir: string, prefix: string) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.name !== ".git")
    .map((entry) => ({
      name: entry.name,
      path: `${prefix}${entry.name}`,
      kind: entry.isDirectory() ? ("dir" as const) : ("file" as const),
      ...(entry.isDirectory()
        ? {}
        : { size: lstatSync(join(dir, entry.name)).size }),
    }))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

describe("AC5 tree listings", () => {
  test.each(SIDES)(
    "%s: a directory link lists as a file with its own size",
    async (_side, row) => {
      const dir = join(row().path, "listing");
      fixture(row(), "listing/file.txt", "12345");
      mkdirSync(join(dir, "sub"));
      symlinkSync(join(dir, "sub"), join(dir, "link-dir"));
      const listing = await getWorktreeTree(row(), "listing", true);
      assert.deepEqual(listing, baseListing(dir, "listing/"));
      assert.deepEqual(
        listing.find((entry) => entry.name === "link-dir"),
        {
          name: "link-dir",
          path: "listing/link-dir",
          kind: "file",
          size: lstatSync(join(dir, "link-dir")).size,
        },
      );
    },
  );

  test.each(SIDES)(
    "%s: an entry whose lstat fails has no size, in both listings",
    async (_side, row) => {
      const file = fixture(row(), "unsized/file.txt", "12345");
      failFileForTests(file, { phase: "inspect", code: "EACCES" });
      const ignored = await getWorktreeTree(row(), "unsized", true);
      assert.deepEqual(ignored, [
        { name: "file.txt", path: "unsized/file.txt", kind: "file" },
      ]);
      sh(row().path, "add", "unsized/file.txt");
      failFileForTests(file, { phase: "inspect", code: "EACCES" });
      const tracked = await getWorktreeTree(row(), "unsized");
      assert.deepEqual(tracked, [
        { name: "file.txt", path: "unsized/file.txt", kind: "file" },
      ]);
    },
  );
});

/** One surface read failing at one Worker request. */
interface Site {
  name: string;
  method: string;
  /** The path the request names; the hold's path. */
  path: () => string;
  phase: Parameters<typeof holdFileForTests>[1];
  /** Runs before the failure is armed. */
  prepare?: () => Promise<unknown>;
  run: () => Promise<unknown>;
}

const workerFile = () => join(workerRow.path, "a.txt");
const grantDependencies = (row: () => WorktreeRow) =>
  ({
    dataDir: join(scratch, "data"),
    resolveWorktree: async () => row(),
  }) satisfies DocumentGrantResolverDependencies;
const grant = (row: () => WorktreeRow, path: string) =>
  mintDocumentTargetGrant(
    {
      target: {
        kind: "worktreeFile",
        worktreeId: row().id,
        path,
        view: "file",
      },
      scope: "file",
      delivery: "attachment",
    },
    grantDependencies(row),
  );
const lockKey = () => {
  clearRepoLockKeysForTests();
  return repoLockKey(workerRow.path);
};

const SITES: Site[] = [
  {
    name: "status exists",
    method: FILE_METHODS.exists,
    path: () => workerRow.path,
    phase: "exists",
    run: () => computeWorktreeStatus(workerRow, { force: true }),
  },
  {
    name: "working-tree status exists",
    method: FILE_METHODS.exists,
    path: () => workerRow.path,
    phase: "exists",
    // With a full status remembered, the refresh takes the working-tree path.
    prepare: () => computeWorktreeStatus(workerRow, { force: true }),
    run: () => refreshWorktreeWorkingTree(workerRow),
  },
  {
    name: "file text",
    method: FILE_METHODS.open,
    path: workerFile,
    phase: "before-open",
    run: () => getWorktreeFileContent(workerRow, "a.txt"),
  },
  {
    name: "raw",
    method: FILE_METHODS.open,
    path: workerFile,
    phase: "before-open",
    run: () => getWorktreeFileRaw(workerRow, "a.txt"),
  },
  {
    name: "tree readdir",
    method: FILE_METHODS.readdir,
    path: () => workerRow.path,
    phase: "readdir",
    run: () => getWorktreeTree(workerRow, "", true),
  },
  {
    name: "tree lstat (includeIgnored)",
    method: FILE_METHODS.inspect,
    path: workerFile,
    phase: "inspect",
    run: () => getWorktreeTree(workerRow, "", true),
  },
  {
    name: "tree lstat",
    method: FILE_METHODS.inspect,
    path: workerFile,
    phase: "inspect",
    run: () => getWorktreeTree(workerRow, ""),
  },
  {
    name: "containedRealPath, the file's realpath",
    method: FILE_METHODS.realpath,
    path: workerFile,
    phase: "realpath",
    run: () => getWorktreeFileContent(workerRow, "a.txt"),
  },
  {
    name: "containedRealPath, the root's realpath",
    method: FILE_METHODS.realpath,
    path: () => workerRow.path,
    phase: "realpath",
    run: () => getWorktreeFileContent(workerRow, "a.txt"),
  },
  {
    name: "grant",
    method: FILE_METHODS.realpath,
    path: workerFile,
    phase: "realpath",
    run: () => grant(() => workerRow, "a.txt"),
  },
  {
    name: "repoLockKey inspect",
    method: FILE_METHODS.inspect,
    path: () => workerRow.path,
    phase: "inspect",
    run: lockKey,
  },
  {
    name: "repoLockKey realpath",
    method: FILE_METHODS.realpath,
    path: () => join(workerRow.path, ".git"),
    phase: "realpath",
    run: lockKey,
  },
];

describe("AC7b a Worker failure rejects every surface", () => {
  test.each(SITES)("$name: a malformed answer", async (site) => {
    await site.prepare?.();
    const disarm = answerForPathForTests(
      site.method,
      site.path(),
      answering(MALFORMED_ANSWERS[site.method]!),
    );
    try {
      const error = await rejection(site.run());
      assert.ok(error instanceof MalformedWorkerAnswerError, String(error));
      assert.ok(isWorkerFailure(error));
    } finally {
      disarm();
    }
  });

  test.each(SITES)("$name: a coded refusal", async (site) => {
    await site.prepare?.();
    const disarm = answerForPathForTests(site.method, site.path(), async () => {
      throw new WorkerMethodError("wrong_worker", "Not here.");
    });
    try {
      const error = await rejection(site.run());
      assert.ok(error instanceof WorkerRequestError, String(error));
      assert.equal(error.code, "wrong_worker");
      assert.ok(isWorkerFailure(error));
    } finally {
      disarm();
    }
  });

  test.each(SITES)(
    "$name: a held call, a connection end, then release",
    async (site) => {
      await site.prepare?.();
      const held = holdFileForTests(site.path(), site.phase);
      const pending = rejection(site.run());
      await held.reached;
      writeAsInProcessWorkerForTests(INVALID_FRAME);
      held.release();
      const error = await pending;
      assert.match(String(error), /The Worker connection ended/);
      assert.ok(isWorkerFailure(error));
    },
  );
});

describe("AC7c an answered filesystem failure maps as base", () => {
  test.each([
    ["ENOENT", "ENOENT: no such file or directory"],
    [null, "an uncoded failure"],
  ] as const)("code %s", async (code, message) => {
    const file = workerFile();
    const opened = answeredFailure(code, message, "open");

    answerForPathForTests(FILE_METHODS.open, file, answering(opened));
    assert.deepEqual(await text(workerRow, "a.txt"), EMPTY, "file");

    answerForPathForTests(FILE_METHODS.open, file, answering(opened));
    await assert.rejects(getWorktreeFileRaw(workerRow, "a.txt"), {
      message: "File not found.",
    });

    answerForPathForTests(
      FILE_METHODS.inspect,
      file,
      answering(answeredFailure(code, message)),
    );
    const tree = await getWorktreeTree(workerRow, "", true);
    assert.deepEqual(
      tree.find((entry) => entry.name === "a.txt"),
      { name: "a.txt", path: "a.txt", kind: "file" },
      "tree size left out",
    );

    // Both realpaths fall back to the lexical path, which reads as base.
    for (const path of [file, workerRow.path]) {
      answerForPathForTests(
        FILE_METHODS.realpath,
        path,
        answering(answeredFailure(code, message)),
      );
      assert.equal((await text(workerRow, "a.txt")).content, "alpha\n", path);
    }
  });

  test("identity: ENOENT is absence, so nothing is remembered", async () => {
    const key = realpathSync(join(workerRow.path, ".git"));
    assert.equal(await lockKey(), key);
    answerForPathForTests(
      FILE_METHODS.inspect,
      workerRow.path,
      answering(answeredFailure("ENOENT", "ENOENT: gone")),
    );
    // No identity: the remembered key is not trusted and git is asked again.
    const { result, executions } = await countGitExecutionsForTests(() =>
      repoLockKey(workerRow.path),
    );
    assert.equal(result, key);
    assert.equal(executions, 1);
  });

  // ENOTDIR throws as Bun's base did; Node's base read it as absent (E2).
  test.each([
    ["ENOTDIR", "ENOTDIR: not a directory"],
    ["EIO", "EIO: i/o error"],
    [null, "an uncoded failure"],
  ] as const)("identity: %s throws as base", async (code, message) => {
    answerForPathForTests(
      FILE_METHODS.inspect,
      workerRow.path,
      answering(answeredFailure(code, message)),
    );
    const error = await rejection(lockKey());
    assert.ok(error instanceof AnsweredFileFailure);
    assert.equal(error.message, message);
    assert.equal(checkoutFailureOf(error), "filesystem");
  });

  test("the common dir's realpath falls back to git's spelling", async () => {
    answerForPathForTests(
      FILE_METHODS.realpath,
      join(workerRow.path, ".git"),
      answering(answeredFailure(null, "an uncoded failure")),
    );
    assert.equal(await lockKey(), join(workerRow.path, ".git"));
  });
});

describe("AC7d the containment verdict as base", () => {
  test.each(SIDES)("%s: an escaping link", async (_side, row) => {
    assert.deepEqual(await text(row(), "escape.txt"), EMPTY);
    await assert.rejects(getWorktreeFileRaw(row(), "escape.txt"), {
      message: "Invalid file path.",
    });
    await assert.rejects(grant(row, "escape.txt"), {
      message: "Invalid file path.",
    });
    await assert.rejects(getWorktreeTree(row(), "escape-dir", true), {
      message: "Invalid file path.",
    });
  });
});

describe("AC7e unclassified errors and cleanup precedence", () => {
  test.each(SIDES)(
    "%s: the reader's own error reaches file text and raw",
    async (_side, row) => {
      for (const run of [
        () => getWorktreeFileContent(row(), "a.txt"),
        () => getWorktreeFileRaw(row(), "a.txt"),
      ]) {
        const sentinel = new TypeError("sentinel");
        throwInCheckoutReadForTests(sentinel, { at: "read" });
        assert.equal(await rejection(run()), sentinel);
      }
    },
  );

  test("server: a tree entry's lstat maps only a native-shaped failure", async () => {
    const file = fixture(serverRow, "boundary/file.txt", "12345");
    failFileForTests(file, { phase: "inspect", code: "EIO" });
    assert.deepEqual(await getWorktreeTree(serverRow, "boundary", true), [
      { name: "file.txt", path: "boundary/file.txt", kind: "file" },
    ]);
    failFileForTests(file, { phase: "inspect", code: "EIO", bare: true });
    const error = await rejection(getWorktreeTree(serverRow, "boundary", true));
    assert.match(String(error), /EIO: injected fault/);
    assert.equal(checkoutFailureOf(error), undefined);
  });

  const closeAnsweredEio = () =>
    answerNextInProcessWorkerCallForTests(
      FILE_METHODS.close,
      async (payload, signal, real) => {
        await real(payload, signal);
        return answeredFailure("EIO", "EIO: close");
      },
    );

  test("(i) a malformed read wins over a close answered EIO", async () => {
    answerNextInProcessWorkerCallForTests(
      FILE_METHODS.read,
      answering({ json: {} }),
    );
    closeAnsweredEio();
    const error = await rejection(getWorktreeFileContent(workerRow, "a.txt"));
    assert.ok(error instanceof MalformedWorkerAnswerError);
    assert.ok(isWorkerFailure(error));
    assert.equal(inProcessWorkerFileHandlesForTests(), 0);
  });

  test("(ii) a read answered EIO loses to a refused close", async () => {
    answerNextInProcessWorkerCallForTests(
      FILE_METHODS.read,
      answering(answeredFailure("EIO", "EIO: read")),
    );
    answerNextInProcessWorkerCallForTests(FILE_METHODS.close, async () => {
      throw new WorkerMethodError("unknown_handle", "No such handle.");
    });
    const error = await rejection(getWorktreeFileContent(workerRow, "a.txt"));
    assert.equal((error as Error).message, "No such handle.");
    assert.ok(isWorkerFailure(error));
    // The sweep closes the handle the refused close left; its quiescence
    // waits for the native close, which settling rounds do not.
    const quiescent = inProcessWorkerQuiescentForTests();
    writeAsInProcessWorkerForTests(INVALID_FRAME);
    await quiescent;
    assert.equal(inProcessWorkerFileHandlesForTests(), 0);
  });

  test("(iii) a good read with a close answered EIO is base's filesystem value", async () => {
    closeAnsweredEio();
    assert.deepEqual(await text(workerRow, "a.txt"), EMPTY);
    closeAnsweredEio();
    await assert.rejects(getWorktreeFileRaw(workerRow, "a.txt"), {
      message: "File not found.",
    });
  });

  test.each(SIDES)(
    "%s: (iv) a directory read loses to an unclassified close error",
    async (_side, row) => {
      for (const run of [
        () => getWorktreeFileContent(row(), "dir"),
        () => getWorktreeFileRaw(row(), "dir"),
      ]) {
        const sentinel = new TypeError("sentinel");
        throwInCheckoutReadForTests(sentinel, { at: "close" });
        assert.equal(await rejection(run()), sentinel);
      }
    },
  );
});

describe("AC13 the reader follows production base", () => {
  test.each(SIDES)("%s: no descriptor stat", async (_side, row) => {
    for (const [name, run] of [
      ["file", (path: string) => text(row(), path).then((r) => r.content)],
      [
        "raw",
        (path: string) =>
          getWorktreeFileRaw(row(), path).then((r) => r.content.toString()),
      ],
    ] as const) {
      const path = `no-stat/${name}.txt`;
      const file = fixture(row(), path, "unstatted\n");
      // Left armed on a path nothing else reads.
      failFileForTests(file, { phase: "stat", code: "EIO" });
      const stats = fileReadsCountsForTests().descriptorStats;
      assert.equal(await run(path), "unstatted\n", name);
      assert.equal(fileFaultArmedForTests(file), true, name);
      assert.equal(fileReadsCountsForTests().descriptorStats, stats, name);
    }
  });

  test.each(SIDES)(
    "%s: growth and shrink after the open",
    async (_side, row) => {
      const surfaces = [
        ["file", (path: string) => text(row(), path).then((r) => r.content)],
        [
          "raw",
          (path: string) =>
            getWorktreeFileRaw(row(), path).then((r) => r.content.toString()),
        ],
      ] as const;
      for (const [name, run] of surfaces) {
        const path = `resized/${name}-grow.txt`;
        const file = fixture(row(), path, "abc");
        const held = holdFileForTests(file, "after-open");
        const pending = run(path);
        await held.reached;
        appendFileSync(file, "def");
        held.release();
        assert.equal(await pending, "abcdef", name);
      }
      for (const [name, run] of surfaces) {
        const path = `resized/${name}-shrink.txt`;
        const file = fixture(row(), path, "abcdef");
        const held = holdFileForTests(file, "after-open");
        const pending = run(path);
        await held.reached;
        truncateSync(file, 2);
        held.release();
        assert.equal(await pending, "ab", name);
      }
    },
  );

  test.each(SIDES)(
    "%s: growth past the cap reads cap + 1",
    async (_side, row) => {
      const start = "a".repeat(MAX_TEXT_BYTES - 1);
      const file = fixture(row(), "resized/capped.txt", start);
      const held = holdFileForTests(file, "after-open");
      const pending = text(row(), "resized/capped.txt");
      await held.reached;
      appendFileSync(file, "bcd");
      held.release();
      assert.deepEqual(await pending, {
        content: `${start}b`,
        binary: false,
        truncated: true,
      });
    },
  );

  test.each(SIDES)("%s: an empty file", async (_side, row) => {
    fixture(row(), "empty.txt", "");
    assert.deepEqual(await text(row(), "empty.txt"), EMPTY);
    const raw = await getWorktreeFileRaw(row(), "empty.txt");
    assert.equal(raw.content.length, 0);
  });

  test("Node pins: readFile and readFileSync reject a directory with EISDIR", async () => {
    await assert.rejects(readFile(scratch), { code: "EISDIR" });
    assert.throws(() => readFileSync(scratch), { code: "EISDIR" });
  });

  test.each(SIDES)(
    "%s: a directory is base's filesystem value",
    async (_side, row) => {
      assert.deepEqual(await text(row(), "dir"), EMPTY);
      await assert.rejects(getWorktreeFileRaw(row(), "dir"), {
        message: "File not found.",
      });
    },
  );
});

/** Open `fifo` for writing once a reader holds it, then write `bytes`. */
async function writeOnceRead(fifo: string, bytes: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
      try {
        writeSync(fd, bytes);
      } finally {
        closeSync(fd);
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENXIO") throw error;
      if (Date.now() > deadline) throw new Error("No reader opened the FIFO.");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

describe("AC14 (2) a FIFO with a writer (E1)", () => {
  test("file text is empty and raw is not found, on an answered ESPIPE", async () => {
    const fifo = join(workerRow.path, "fifo");
    execFileSync("mkfifo", [fifo]);
    try {
      for (const [name, run, expect] of [
        [
          "file",
          () => text(workerRow, "fifo"),
          (result: unknown) => assert.deepEqual(result, EMPTY),
        ],
        [
          "raw",
          () => rejection(getWorktreeFileRaw(workerRow, "fifo")),
          (result: unknown) =>
            assert.equal((result as Error).message, "File not found."),
        ],
      ] as const) {
        let answered: unknown;
        answerNextInProcessWorkerCallForTests(
          FILE_METHODS.read,
          async (payload, signal, real) => {
            const answer = await real(payload, signal);
            answered = (answer.json as { error?: { code?: unknown } }).error
              ?.code;
            return answer;
          },
        );
        const before = inProcessWorkerServedForTests();
        const pending = run();
        await writeOnceRead(fifo, "x");
        expect(await pending);
        assert.equal(answered, "ESPIPE", name);
        assert.ok(inProcessWorkerServedForTests() > before);
      }
    } finally {
      rmSync(fifo, { force: true });
    }
  });
});
