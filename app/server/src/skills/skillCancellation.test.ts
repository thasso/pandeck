/**
 * What a mutation owes a caller who STOPS it ([Task-633](pa://task/633)).
 *
 * A mutation is not a read. Its long stretch of work is proving what is on disk
 * before it destroys anything — hashing every committed file under a folder, and
 * the library is the user's, so nothing bounds how big one of those files is. A
 * tool that cannot be stopped through that is a tool that hangs; a tool that can
 * be stopped ANYWHERE is worse, because a removal cut in the middle leaves a
 * skill under a private name with no rollback having run.
 *
 * So cancellation is honoured at named points — before the first write, and
 * inside the read-only proofs — and ignored past the point of no return. These
 * pin all three halves of that: it is noticed while hashing, everything is put
 * back when it is, and a stop that arrives too late does not break the undo.
 *
 * The stop is fired from inside the hash, because that is the window under test
 * and no wall-clock timer lands in it reliably.
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/** The chunk `blobId` hashes with; the one read length that identifies it. */
const HASH_CHUNK = 64 * 1024;
/** Fired on the first hash chunk once armed, so the stop lands mid-proof. */
let stopOnHashChunk: (() => void) | undefined;
/** How many hash chunks were read, which says whether it stopped EARLY. */
let hashChunks = 0;
/** Fired on the first unlink, so the stop lands inside the removal itself. */
let stopOnUnlink: (() => void) | undefined;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    unlink: (path: string) => {
      const stop = stopOnUnlink;
      stopOnUnlink = undefined;
      stop?.();
      return actual.unlink(path);
    },
    open: async (path: string, flags?: number | string, mode?: number) => {
      const handle = await actual.open(path, flags, mode);
      const read = handle.read.bind(handle);
      return Object.assign(handle, {
        read: (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number | null,
        ) => {
          if (length === HASH_CHUNK) {
            hashChunks += 1;
            const stop = stopOnHashChunk;
            stopOnHashChunk = undefined;
            stop?.();
          }
          return read(buffer, offset, length, position);
        },
      });
    },
  };
});

const { git } = await import("../gitExec.ts");
const { createSkill, deleteSkill, renameSkill } =
  await import("./skillAuthoring.ts");
const { setSkillLibraryBroadcaster } = await import("./skillLibraryEvents.ts");
const { SkillLibraryStore } = await import("./skillLibraryStore.ts");

let root: string;
let library: InstanceType<typeof SkillLibraryStore>;

const meta = {
  actor: { id: "pi:workshop:sess-1", name: "Workshop test" },
  reason: "Change the skill",
  sessionId: "sess-1",
};

/**
 * A supporting file bigger than several hash chunks, written and committed BY
 * HAND: this is the file nothing in the tool bounds, and the reason a proof can
 * run long enough to be worth stopping.
 */
const BIG_FILE_BYTES = 8 * HASH_CHUNK;

async function headCommit(): Promise<string> {
  return (await git(["rev-parse", "HEAD"], root)).stdout.trim();
}

async function statusPorcelain(): Promise<string> {
  return (await git(["status", "--porcelain"], root)).stdout.trim();
}

beforeEach(async () => {
  hashChunks = 0;
  stopOnHashChunk = undefined;
  stopOnUnlink = undefined;
  root = mkdtempSync(join(tmpdir(), "skills-cancel-test-"));
  library = new SkillLibraryStore(root);
  await library.ensureInitialized();
  setSkillLibraryBroadcaster({ broadcast: () => undefined });
  await createSkill(
    {
      name: "release-notes",
      description: "How to write release notes",
      body: "## Steps\n\nWrite them down.",
    },
    { ...meta, reason: "Add release-notes" },
    library,
  );
  await writeFile(
    join(root, "release-notes", "corpus.txt"),
    Buffer.alloc(BIG_FILE_BYTES, 7),
  );
  await git(["add", "-A"], root);
  await git(["commit", "-m", "Add a corpus by hand"], root);
});

afterEach(() => {
  hashChunks = 0;
  stopOnHashChunk = undefined;
  stopOnUnlink = undefined;
  setSkillLibraryBroadcaster({ broadcast: () => undefined });
  rmSync(root, { recursive: true, force: true });
});

describe("a mutation the caller cancels", () => {
  test("is not started at all when the signal is already aborted", async () => {
    const head = await headCommit();

    const error = await createSkill(
      { name: "another", description: "Another skill", body: "Body." },
      { ...meta, reason: "Add another" },
      library,
      { signal: AbortSignal.abort() },
    ).then(
      () => undefined,
      (error: Error) => error,
    );

    assert.ok(error, "an aborted call must not succeed");
    assert.match(error.message, /cancelled/);
    assert.ok(
      !existsSync(join(root, "another")),
      "nothing may be created for a call that was cancelled before it ran",
    );
    assert.equal(await headCommit(), head);
    assert.equal(await statusPorcelain(), "");
  });

  test("stops a delete while it is hashing, and puts the folder back", async () => {
    const head = await headCommit();
    const controller = new AbortController();
    // Mid-proof: the folder is already detached under its private name and the
    // first chunk of the corpus has been read. Stopping HERE is the case the
    // restore has to answer for.
    stopOnHashChunk = () => controller.abort();

    const error = await deleteSkill({ name: "release-notes" }, meta, library, {
      signal: controller.signal,
    }).then(
      () => undefined,
      (error: Error) => error,
    );

    assert.ok(error, "a cancelled delete must not report success");
    assert.match(error.message, /cancelled/);
    assert.ok(controller.signal.aborted, "the stop must have been fired");
    // Stopped, not merely noticed at the end: the corpus is eight chunks and
    // the hash may not have run through them after the caller gave up.
    assert.ok(
      hashChunks < BIG_FILE_BYTES / HASH_CHUNK,
      `the hash read ${hashChunks} chunks after the stop rather than abandoning the file`,
    );
    // And the skill is exactly where it was, at its PUBLIC name.
    assert.match(
      await readFile(join(root, "release-notes", "SKILL.md"), "utf8"),
      /name: release-notes/,
    );
    assert.equal(
      (await readFile(join(root, "release-notes", "corpus.txt"))).byteLength,
      BIG_FILE_BYTES,
    );
    assert.equal(await headCommit(), head);
    assert.equal(
      await statusPorcelain(),
      "",
      "a cancelled delete must leave the repository clean",
    );
  });

  test("stops a rename while it is proving the source, and undoes the new folder", async () => {
    const head = await headCommit();
    const controller = new AbortController();
    // A rename has already written the destination by the time it proves the
    // source, so this stop lands AFTER the mutation's own writes: the undo has
    // to take them back, and it does its own hashing to decide what is its to
    // remove. A cancelled signal that reached that hashing would abandon the
    // undo halfway and leave the new folder behind.
    stopOnHashChunk = () => controller.abort();

    const error = await renameSkill(
      { name: "release-notes", newName: "release-notes-v2" },
      meta,
      library,
      { signal: controller.signal },
    ).then(
      () => undefined,
      (error: Error) => error,
    );

    assert.ok(error, "a cancelled rename must not report success");
    assert.match(error.message, /cancelled/);
    assert.ok(
      !existsSync(join(root, "release-notes-v2")),
      "the destination a cancelled rename assembled must be taken back",
    );
    assert.match(
      await readFile(join(root, "release-notes", "SKILL.md"), "utf8"),
      /name: release-notes\n/,
    );
    assert.equal(
      (await readFile(join(root, "release-notes", "corpus.txt"))).byteLength,
      BIG_FILE_BYTES,
    );
    assert.equal(await headCommit(), head);
    assert.equal(
      await statusPorcelain(),
      "",
      "a cancelled rename must leave the repository clean",
    );
  });

  test("is ignored once the removal has started, so the delete completes", async () => {
    const controller = new AbortController();
    // Past the proof: the tree is detached and its first child is going. There
    // is nothing to save by stopping now — only a half-emptied folder to strand
    // — so the stop is deliberately not honoured.
    stopOnUnlink = () => controller.abort();

    const outcome = await deleteSkill(
      { name: "release-notes" },
      meta,
      library,
      {
        signal: controller.signal,
      },
    );

    assert.ok(controller.signal.aborted, "the stop must have been fired");
    expect(outcome.commit.changedPaths).toContain("release-notes/SKILL.md");
    assert.ok(!existsSync(join(root, "release-notes")));
    assert.equal(
      await statusPorcelain(),
      "",
      "the completed delete must leave the repository clean",
    );
  });
});
