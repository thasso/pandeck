import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  constants,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, test, vi } from "vitest";
import { throwInCheckoutReadForTests } from "../checkoutFileAccess.ts";
import { setCommentChangeNotifier } from "../comments/commentChanges.ts";
import { projectStore } from "../db/projectStore.ts";
import {
  getComment,
  insertComment,
  listComments,
  setCommentRetentionFieldsForTests,
} from "../db/worktreeStore.ts";
import {
  failFileForTests,
  fileFaultArmedForTests,
  fileReadsCountsForTests,
  holdFileForTests,
} from "../fileReads.ts";
import { countGitExecutionsForTests } from "../gitExec.ts";
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
  FILE_METHODS,
  MalformedWorkerAnswerError,
} from "../workerProtocol/fileMethods.ts";
import { isWorkerFailure } from "../workers/fileClient.ts";
import {
  answerNextInProcessWorkerCallForTests,
  inProcessWorkerFileHandlesForTests,
  inProcessWorkerServedMethodForTests,
  writeAsInProcessWorkerForTests,
} from "../workers/inProcessWorker.ts";
import {
  MAIN_COMMENT_RETENTION_DAYS,
  addWorktreeComment,
  lastReanchorHeadForTests,
  listWorktreeComments,
  sweepMainWorktreeCommentRetention,
} from "./worktreeComments.ts";
import { getWorktreeFileContent } from "./worktreeDiff.ts";
import { mainWorktreeId, resolveWorktreeRow } from "./worktreeResolve.ts";

/**
 * A comment's working source read through the checkout-file access, and the
 * failures that must reach the comment surfaces' public results
 * (`docs/workers.md`, "Checkout files"). Each scenario has its own project main
 * checkout, which nothing watches, so no background pass takes a one-shot seam.
 */

const INVALID_FRAME = new Uint8Array(8);
const MIB = 1024 * 1024;
const CODE = ["one", "two", "three", "four", "five", ""].join("\n");
const NO_LINE = "Cannot anchor the comment: the line no longer exists.";

let scratch: string;
let kbRoot: string;

beforeAll(() => {
  scratch = mkdtempSync(join(realpathSync(tmpdir()), "comment-reads-"));
  kbRoot = join(scratch, "kb");
  mkdirSync(kbRoot);
  mkdirSync(join(scratch, "outside"));
  writeFileSync(join(scratch, "outside", "secret.ts"), "SECRET\n");
  updateSettings({
    knowledgeBase: { enabled: true, path: kbRoot, effectivePath: "ignored" },
  });
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

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

interface Checkout {
  id: string;
  path: string;
  file: string;
  /** The first commit, where `code.ts` is {@link CODE}. */
  first: string;
}

let projects = 0;

/**
 * A project's main checkout holding `code.ts`, inside the Knowledge Base root
 * on `KB root`. Either way a checkout: its reads run on the Worker (RD-W3-1).
 */
function checkout(place: "elsewhere" | "KB root" = "elsewhere"): Checkout {
  projects += 1;
  const projectId = `reads-${projects}`;
  const path = join(place === "KB root" ? kbRoot : scratch, projectId);
  mkdirSync(path);
  sh(path, "init", "-q", "-b", "main");
  writeFileSync(join(path, "code.ts"), CODE);
  symlinkSync(join(scratch, "outside", "secret.ts"), join(path, "escape.ts"));
  sh(path, "add", "code.ts");
  sh(path, "commit", "-qm", "init");
  const now = new Date().toISOString();
  projectStore.put({
    id: projectId,
    name: projectId,
    key: `R${projects}`,
    description: "",
    status: "active",
    localPaths: [{ path, kind: "repo", match: "prefix" }],
    worktreeRoot: join(scratch, `${projectId}-worktrees`),
    createdAt: now,
    updatedAt: now,
  });
  return {
    id: mainWorktreeId(projectId),
    path,
    file: join(path, "code.ts"),
    first: sh(path, "rev-parse", "HEAD").trim(),
  };
}

/** Move HEAD with two lines above everything, so every anchor moves down two. */
function prependTwoLines(at: Checkout): string {
  writeFileSync(at.file, `zero\nzero\n${CODE}`);
  sh(at.path, "commit", "-qam", "prepend");
  return sh(at.path, "rev-parse", "HEAD").trim();
}

const PLACES = [["elsewhere"], ["KB root"]] as const;

const add = (at: Checkout, line: number, path = "code.ts", ref?: string) =>
  addWorktreeComment({
    worktreeId: at.id,
    body: `line ${line}`,
    author: { kind: "user" },
    anchor: {
      path,
      side: "new",
      line,
      ...(ref !== undefined ? { ref } : {}),
    },
  });

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected a rejection");
}

const malformedOpen = (path: string) =>
  answerForPathForTests(
    FILE_METHODS.open,
    path,
    answering(MALFORMED_ANSWERS[FILE_METHODS.open]!),
  );

function assertMalformed(error: unknown): void {
  assert.ok(error instanceof MalformedWorkerAnswerError, String(error));
  assert.ok(isWorkerFailure(error));
}

/** The ids the comment change notifier reports while `run` runs. */
async function reported<T>(
  run: () => Promise<T>,
): Promise<{ result: T | undefined; error: unknown; ids: string[] }> {
  const ids: string[] = [];
  setCommentChangeNotifier((_target, touched) => {
    ids.push(...touched);
  });
  try {
    return { result: await run(), error: undefined, ids };
  } catch (error) {
    return { result: undefined, error, ids };
  } finally {
    setCommentChangeNotifier(() => undefined);
  }
}

// First in the file: the sweep visits every main checkout holding comments,
// and the sentinel is taken by whichever read comes next.
describe("AC7f retention", () => {
  test("a failed read in the pass counts the checkout failed, deletes nothing and broadcasts what it wrote", async () => {
    const at = checkout();
    const now = Date.now();
    const old = now - (MAIN_COMMENT_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000;
    // An old-side root on a path the base never had: the pass writes its
    // verdict without a working read, and a written verdict makes it
    // eligible. It comes first, so it is written before the failing root.
    insertComment({
      id: "retained-old-side",
      worktreeId: at.id,
      parentId: null,
      authorKind: "user",
      authorSessionId: null,
      body: "old side",
      resolvedAt: null,
      resolvedBy: null,
      anchorPath: "gone.ts",
      anchorSide: "old",
      anchorLine: 1,
      anchorCommit: at.first,
      anchorBlob: null,
      anchorDirty: false,
      anchorContextJson: null,
      anchorQuoteExact: "gone",
      anchorQuotePrefix: null,
      anchorQuoteSuffix: null,
      anchorPositionStart: null,
      anchorPositionEnd: null,
      anchorBlockId: null,
      anchorBlockOccurrence: null,
      currentPath: "gone.ts",
      currentLine: 1,
      anchorState: "anchored",
      attachedSessionId: null,
      ownerWorktreeId: null,
      ownerBranch: null,
      ownerSource: null,
      createdAt: 1,
      updatedAt: 1,
    });
    const failing = await add(at, 2);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (const arm of [
        () => malformedOpen(at.file),
        () =>
          throwInCheckoutReadForTests(new TypeError("sentinel"), {
            at: "read",
          }),
      ]) {
        setCommentRetentionFieldsForTests("retained-old-side", {
          resolvedAt: old,
          anchorState: "anchored",
          updatedAt: old,
        });
        arm();
        const { result, ids } = await reported(() =>
          sweepMainWorktreeCommentRetention(now),
        );
        assert.deepEqual(result, {
          checkedWorktrees: 0,
          purgedRoots: 0,
          purgedComments: 0,
          failedWorktrees: 1,
        });
        assert.deepEqual(ids, ["retained-old-side"], "written roots broadcast");
        assert.equal(getComment("retained-old-side")?.anchorState, "orphaned");
        assert.equal(listComments(at.id).length, 2, "nothing deleted");
        assert.equal(lastReanchorHeadForTests(at.id), undefined);
      }
      // The control: the same sweep with nothing failing deletes the root.
      const swept = await sweepMainWorktreeCommentRetention(now);
      assert.equal(swept.failedWorktrees, 0);
      assert.equal(swept.purgedRoots, 1);
      assert.deepEqual(
        listComments(at.id).map((row) => row.id),
        [failing.id],
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("AC7b the comment source rejects on a Worker failure", () => {
  test("a malformed answer, a coded refusal, a held open ended: nothing is stored", async () => {
    const at = checkout();
    const failures: [string, () => Promise<unknown>, (e: unknown) => void][] = [
      [
        "malformed",
        async () => {
          const disarm = malformedOpen(at.file);
          try {
            return await rejection(add(at, 2));
          } finally {
            disarm();
          }
        },
        assertMalformed,
      ],
      [
        "refused",
        async () => {
          const disarm = answerForPathForTests(
            FILE_METHODS.open,
            at.file,
            async () => {
              throw new WorkerMethodError("wrong_worker", "Not here.");
            },
          );
          try {
            return await rejection(add(at, 2));
          } finally {
            disarm();
          }
        },
        (error) => {
          assert.ok(error instanceof WorkerRequestError);
          assert.equal(error.code, "wrong_worker");
          assert.ok(isWorkerFailure(error));
        },
      ],
      [
        "ended",
        async () => {
          const held = holdFileForTests(at.file, "before-open");
          const pending = rejection(add(at, 2));
          await held.reached;
          writeAsInProcessWorkerForTests(INVALID_FRAME);
          held.release();
          const error = await pending;
          // Had the open started, the end would orphan it, outside quiescence.
          await held.disposed;
          return error;
        },
        (error) => {
          assert.match(String(error), /The Worker connection ended/);
          assert.ok(isWorkerFailure(error));
        },
      ],
    ];
    for (const [name, run, check] of failures) {
      check(await run());
      assert.equal(listComments(at.id).length, 0, name);
    }
  });
});

describe("AC7c and AC7d the comment source maps as base", () => {
  test.each([
    ["ENOENT", "ENOENT: no such file or directory"],
    [null, "an uncoded failure"],
  ] as const)("an answered %s is no source", async (code, message) => {
    const at = checkout();
    answerForPathForTests(
      FILE_METHODS.open,
      at.file,
      answering(answeredFailure(code, message, "open")),
    );
    await assert.rejects(add(at, 2), { message: NO_LINE });

    // In the pass, no source orphans the root.
    const root = await add(at, 2);
    prependTwoLines(at);
    answerForPathForTests(
      FILE_METHODS.open,
      at.file,
      answering(answeredFailure(code, message, "open")),
    );
    const [listed] = await listWorktreeComments(at.id);
    assert.equal(listed?.id, root.id);
    assert.equal(listed?.anchorState, "orphaned");
  });

  test.each(PLACES)("%s: an escaping link is no source", async (place) => {
    const at = checkout(place);
    await assert.rejects(add(at, 1, "escape.ts"), { message: NO_LINE });
  });
});

describe("AC7e unclassified errors at the comment source", () => {
  test.each(PLACES)(
    "%s: the reader's own error rejects the add",
    async (place) => {
      const at = checkout(place);
      const sentinel = new TypeError("sentinel");
      throwInCheckoutReadForTests(sentinel, { at: "read" });
      assert.equal(await rejection(add(at, 2)), sentinel);
      assert.equal(listComments(at.id).length, 0);
    },
  );

  test.each(PLACES)(
    "%s: (iv) a directory read loses to an unclassified close error",
    async (place) => {
      const at = checkout(place);
      mkdirSync(join(at.path, "dir"));
      const sentinel = new TypeError("sentinel");
      throwInCheckoutReadForTests(sentinel, { at: "close" });
      assert.equal(await rejection(add(at, 1, "dir")), sentinel);
    },
  );

  test("(iii) a good read with a close answered EIO is no source", async () => {
    const at = checkout();
    answerNextInProcessWorkerCallForTests(
      FILE_METHODS.close,
      async (payload, signal, real) => {
        await real(payload, signal);
        return answeredFailure("EIO", "EIO: close");
      },
    );
    await assert.rejects(add(at, 2), { message: NO_LINE });
  });
});

describe("AC7f the listing", () => {
  test("a Worker failure in the pass rejects it and forgets the HEAD", async () => {
    const at = checkout();
    const root = await add(at, 2);
    assert.ok(getComment(root.id)?.anchorPositionStart !== null);
    const head = prependTwoLines(at);

    const disarm = malformedOpen(at.file);
    try {
      assertMalformed(await rejection(listWorktreeComments(at.id)));
    } finally {
      disarm();
    }
    assert.notEqual(lastReanchorHeadForTests(at.id), head);
    assert.equal(getComment(root.id)?.currentLine, 2, "nothing written");

    // The next listing runs the pass again and answers.
    const again = await countGitExecutionsForTests(() =>
      listWorktreeComments(at.id),
    );
    assert.ok(again.executions > 1, "the pass ran git");
    assert.equal(again.result[0]?.current?.line, 4);
    assert.equal(lastReanchorHeadForTests(at.id), head);
    const quiet = await countGitExecutionsForTests(() =>
      listWorktreeComments(at.id),
    );
    assert.equal(quiet.executions, 1, "HEAD only, once the pass held");
  });

  test("an unclassified error in the pass rejects it and forgets the HEAD", async () => {
    const at = checkout();
    await add(at, 2);
    const head = prependTwoLines(at);
    const sentinel = new TypeError("sentinel");
    throwInCheckoutReadForTests(sentinel, { at: "read" });
    assert.equal(await rejection(listWorktreeComments(at.id)), sentinel);
    assert.notEqual(lastReanchorHeadForTests(at.id), head);
    const [listed] = await listWorktreeComments(at.id);
    assert.equal(listed?.current?.line, 4);
  });

  test("a legacy dirty row's selector completion rejects on a Worker failure", async () => {
    const at = checkout();
    // The pass has run for this HEAD, so the listing reads only for the row.
    await listWorktreeComments(at.id);
    writeFileSync(at.file, `${CODE}dirty\n`);
    const unwritten = execFileSync("git", ["hash-object", at.file], {
      encoding: "utf8",
    }).trim();
    insertComment({
      id: "legacy-dirty",
      worktreeId: at.id,
      parentId: null,
      authorKind: "user",
      authorSessionId: null,
      body: "legacy",
      resolvedAt: null,
      resolvedBy: null,
      anchorPath: "code.ts",
      anchorSide: "new",
      anchorLine: 2,
      anchorCommit: at.first,
      anchorBlob: unwritten,
      anchorDirty: true,
      anchorContextJson: null,
      anchorQuoteExact: "two",
      anchorQuotePrefix: null,
      anchorQuoteSuffix: null,
      anchorPositionStart: null,
      anchorPositionEnd: null,
      anchorBlockId: null,
      anchorBlockOccurrence: null,
      currentPath: "code.ts",
      currentLine: 2,
      anchorState: "anchored",
      attachedSessionId: null,
      ownerWorktreeId: null,
      ownerBranch: null,
      ownerSource: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const disarm = malformedOpen(at.file);
    try {
      assertMalformed(await rejection(listWorktreeComments(at.id)));
    } finally {
      disarm();
    }
    // The working file still hashes to the snapshot: completion recovers.
    const [listed] = await listWorktreeComments(at.id);
    assert.deepEqual(listed?.anchor?.selectors.position, {
      start: CODE.indexOf("two"),
      end: CODE.indexOf("two") + 3,
    });
  });
});

describe("AC7f a ref anchor's post-insert pass", () => {
  test("E3: a Worker failure keeps the add, with its seeded position", async () => {
    const at = checkout();
    const head = prependTwoLines(at);
    const disarm = malformedOpen(at.file);
    let created;
    try {
      created = await add(at, 2, "code.ts", at.first);
    } finally {
      disarm();
    }
    assert.deepEqual(created.current, { path: "code.ts", line: 2 });
    const stored = getComment(created.id);
    assert.equal(stored?.anchorState, "anchored", "no verdict written");
    assert.equal(stored?.currentLine, 2);
    assert.notEqual(lastReanchorHeadForTests(at.id), head);

    const again = malformedOpen(at.file);
    try {
      assertMalformed(await rejection(listWorktreeComments(at.id)));
    } finally {
      again();
    }
  });

  test("RD-W3-7: an unclassified error reports the stored comment, then rejects", async () => {
    const at = checkout();
    const head = prependTwoLines(at);
    const sentinel = new TypeError("sentinel");
    throwInCheckoutReadForTests(sentinel, { at: "read" });
    const { error, ids } = await reported(() =>
      add(at, 2, "code.ts", at.first),
    );
    assert.equal(error, sentinel);
    const [stored] = listComments(at.id);
    assert.ok(stored, "the row is stored");
    assert.deepEqual(ids, [stored.id], "its change was reported");
    assert.equal(stored.anchorState, "anchored", "no verdict written");
    assert.equal(stored.currentLine, 2);
    assert.notEqual(lastReanchorHeadForTests(at.id), head);
    const listed = await listWorktreeComments(at.id);
    assert.deepEqual(
      listed.map((comment) => [comment.id, comment.current?.line]),
      [[stored.id, 4]],
    );
  });
});

describe("AC13 the comment source follows production base", () => {
  test.each(PLACES)("%s: no descriptor stat", async (place) => {
    const at = checkout(place);
    failFileForTests(at.file, { phase: "stat", code: "EIO" });
    const stats = fileReadsCountsForTests().descriptorStats;
    await add(at, 2);
    assert.equal(fileFaultArmedForTests(at.file), true);
    assert.equal(fileReadsCountsForTests().descriptorStats, stats);
  });

  test.each(PLACES)("%s: growth and shrink after the open", async (place) => {
    const at = checkout(place);
    writeFileSync(at.file, "one\n");
    let held = holdFileForTests(at.file, "after-open");
    let pending = add(at, 3);
    await held.reached;
    appendFileSync(at.file, "two\nthree\n");
    held.release();
    assert.equal((await pending).anchor?.selectors.quote.exact, "three");

    held = holdFileForTests(at.file, "after-open");
    pending = add(at, 3);
    await held.reached;
    truncateSync(at.file, 4);
    held.release();
    await assert.rejects(pending, { message: NO_LINE });
  });

  test.each(PLACES)("%s: an empty file is a source", async (place) => {
    const at = checkout(place);
    writeFileSync(at.file, "");
    // No source at all is refused (above); an empty one has a first line.
    const created = await add(at, 1);
    assert.equal(created.anchor?.line, 1);
  });

  test.each(PLACES)("%s: a directory is no source", async (place) => {
    const at = checkout(place);
    mkdirSync(join(at.path, "dir"));
    await assert.rejects(add(at, 1, "dir"), { message: NO_LINE });
  });

  test.each(PLACES)(
    "%s: an uncapped 20 MiB + 3 source is read whole",
    async (place) => {
      const at = checkout(place);
      const line = `${"x".repeat(1023)}\n`;
      const bytes = Buffer.from(line.repeat(20 * 1024) + "end");
      assert.equal(bytes.length, 20 * MIB + 3);
      writeFileSync(at.file, bytes);
      const reads = inProcessWorkerServedMethodForTests(FILE_METHODS.read);
      const created = await add(at, 20 * 1024 + 1);
      assert.equal(created.anchor?.selectors.quote.exact, "end");
      // The snapshot blob hashes exactly the bytes read.
      const expected = execFileSync("git", ["hash-object", at.file], {
        encoding: "utf8",
      }).trim();
      assert.equal(getComment(created.id)?.anchorBlob, expected);
      assert.equal(
        inProcessWorkerServedMethodForTests(FILE_METHODS.read) - reads,
        3,
        "8 MiB, 8 MiB, then the short answer, on the Worker",
      );
    },
  );
});

describe("AC14 (1) a FIFO without a writer (E1)", () => {
  test("the anchor read stays pending, the server serves, and the end rejects it", async () => {
    const at = checkout();
    const fifo = join(at.path, "fifo");
    execFileSync("mkfifo", [fifo]);
    const row = await resolveWorktreeRow(at.id);
    assert.ok(row);
    const held = holdFileForTests(fifo, "before-open");
    let settled = false;
    const pending = rejection(add(at, 1, "fifo")).finally(() => {
      settled = true;
    });
    await held.reached;
    held.release();
    await settle();
    const other = await getWorktreeFileContent(row, "code.ts");
    assert.equal(other.content, CODE);
    assert.equal(settled, false, "still waiting for a writer");

    writeAsInProcessWorkerForTests(INVALID_FRAME);
    const error = await pending;
    assert.match(String(error), /The Worker connection ended/);
    assert.ok(isWorkerFailure(error));
    assert.equal(listComments(at.id).length, 0);

    // The end orphaned the native open, which the Worker's quiescence does not
    // wait for. It has no descriptor yet, so a zero count is no receipt: only
    // the barrier's disposal follows the late descriptor's close.
    let disposed = false;
    void held.disposed.then(() => (disposed = true));
    await settle();
    assert.equal(fileReadsCountsForTests().liveDescriptors, 0);
    assert.equal(disposed, false, "disposed before the orphan settled");

    // A writer lets the orphaned open finish; its descriptor is closed.
    const writer = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
    closeSync(writer);
    await held.disposed;
    assert.equal(fileReadsCountsForTests().liveDescriptors, 0);
  });
});
