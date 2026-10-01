/**
 * What a create-or-fail primitive owes when it cannot PIN what it just made
 * ([Task-633](pa://task/633)).
 *
 * Every primitive here mutates first and takes its pin second, because no
 * syscall creates an entry and hands back a second descriptor for it. That
 * second open can fail on its own — `EMFILE` under descriptor pressure is the
 * realistic one — and a created name nobody can prove ownership of is the worst
 * outcome available: no undo may remove it later, so a failed mutation would
 * leave it behind for good. These pin the opposite: the creation is taken back,
 * and the caller sees the failure.
 *
 * The failure is injected at the descriptor itself. `O_PATH` is the flag every
 * pin uses and nothing else does, so refusing exactly those opens reproduces
 * descriptor exhaustion deterministically, without depending on the process
 * limit of whatever machine runs the tests.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/** Linux `O_PATH`, which Node does not export; the pins use it and nothing else. */
const O_PATH = 0o010000000;
let refusePins = false;
/** Arms one EMFILE on the next ordinary (non-pin) open, then disarms. */
let refuseNextOpen = false;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: (path: string, flags?: number | string, mode?: number) => {
      const isPin = typeof flags === "number" && (flags & O_PATH) !== 0;
      if ((refusePins && isPin) || (refuseNextOpen && !isPin)) {
        refuseNextOpen = false;
        return Promise.reject(
          Object.assign(new Error("EMFILE: too many open files"), {
            code: "EMFILE",
          }),
        );
      }
      return actual.open(path, flags, mode);
    },
  };
});

const {
  createSkillChildDirectory,
  createSkillChildFile,
  ensureSkillChildDirectory,
  linkSkillChild,
  withLibraryRoot,
  withReservedSkillFolder,
  withSkillChild,
  writeSkillChildFile,
} = await import("./skillSource.ts");

let root: string;

beforeEach(async () => {
  refuseNextOpen = false;
  root = mkdtempSync(join(tmpdir(), "skill-pin-test-"));
  await mkdir(join(root, "folder"));
  await writeFile(join(root, "folder", "SKILL.md"), "# Real\n", "utf8");
  refusePins = false;
});

afterEach(() => {
  refusePins = false;
  refuseNextOpen = false;
  rmSync(root, { recursive: true, force: true });
});

/** Run one primitive against the seeded folder, with pins refused. */
async function withPinsRefused<T>(
  use: (folder: import("node:fs/promises").FileHandle) => Promise<T>,
): Promise<unknown> {
  return withLibraryRoot(root, (rootHandle) =>
    withSkillChild(rootHandle, "folder", async (child) => {
      refusePins = true;
      return use(child.handle).catch((error: unknown) => error);
    }),
  );
}

describe("a create-or-fail primitive that cannot pin what it created", () => {
  test("createSkillChildFile leaves no file behind", async () => {
    const error = await withPinsRefused((folder) =>
      createSkillChildFile(
        folder,
        "orphan.txt",
        new TextEncoder().encode("agent\n"),
      ),
    );

    expect(error).toBeInstanceOf(Error);
    assert.equal((error as NodeJS.ErrnoException).code, "EMFILE");
    assert.ok(
      !existsSync(join(root, "folder", "orphan.txt")),
      "a file no pin could be taken for must not be left behind",
    );
  });

  test("writeSkillChildFile leaves no file it created behind", async () => {
    const error = await withPinsRefused((folder) =>
      writeSkillChildFile(
        folder,
        "orphan.txt",
        new TextEncoder().encode("agent\n"),
      ),
    );

    expect(error).toBeInstanceOf(Error);
    assert.ok(!existsSync(join(root, "folder", "orphan.txt")));
  });

  test("writeSkillChildFile still REPLACES an existing file, which needs no pin", async () => {
    await writeFile(join(root, "folder", "existing.txt"), "old\n", "utf8");

    const created = await withPinsRefused((folder) =>
      writeSkillChildFile(
        folder,
        "existing.txt",
        new TextEncoder().encode("new\n"),
      ),
    );

    // Nothing was created, so nothing needed pinning: the file was already in
    // HEAD's world and is Git's to restore.
    assert.equal(created, undefined);
  });

  test("createSkillChildDirectory leaves no directory behind", async () => {
    const error = await withPinsRefused((folder) =>
      createSkillChildDirectory(folder, "orphan"),
    );

    expect(error).toBeInstanceOf(Error);
    assert.ok(!existsSync(join(root, "folder", "orphan")));
  });

  test("ensureSkillChildDirectory leaves no directory it created behind", async () => {
    const error = await withPinsRefused((folder) =>
      ensureSkillChildDirectory(folder, "orphan"),
    );

    expect(error).toBeInstanceOf(Error);
    assert.equal((error as NodeJS.ErrnoException).code, "EMFILE");
    assert.ok(!existsSync(join(root, "folder", "orphan")));
  });

  test("withReservedSkillFolder leaves no reservation behind", async () => {
    // The failure lands between the `mkdir` and the callback, so the caller has
    // registered neither the path nor an undo — and an empty directory is
    // invisible to `git status`, so nothing downstream would ever notice it.
    let reached = false;
    const error = await withLibraryRoot(root, async (rootHandle) => {
      refuseNextOpen = true;
      return withReservedSkillFolder(rootHandle, "reserved", async () => {
        reached = true;
        return true;
      }).catch((error: unknown) => error);
    });

    expect(error).toBeInstanceOf(Error);
    assert.equal(reached, false);
    assert.ok(!existsSync(join(root, "reserved")));
  });

  test("a reservation the caller DID receive is the caller's to undo", async () => {
    // The mirror of the case above: once the callback has run, it knows what it
    // put in the folder and holds the pins that prove it, so the reservation
    // must NOT be pulled out from under its own undo.
    const error = await withLibraryRoot(root, (rootHandle) =>
      withReservedSkillFolder(rootHandle, "reserved", async () => {
        await writeFile(join(root, "reserved", "ours.md"), "ours\n", "utf8");
        throw new Error("the mutation failed after reserving");
      }).catch((error: unknown) => error),
    );

    expect(error).toBeInstanceOf(Error);
    assert.ok(existsSync(join(root, "reserved", "ours.md")));
  });

  test("linkSkillChild leaves no link behind", async () => {
    await mkdir(join(root, "destination"));

    const error = await withLibraryRoot(root, (rootHandle) =>
      withSkillChild(rootHandle, "folder", (source) =>
        withSkillChild(rootHandle, "destination", async (destination) => {
          refusePins = true;
          return linkSkillChild(
            source.handle,
            "SKILL.md",
            destination.handle,
          ).catch((error: unknown) => error);
        }),
      ),
    );

    expect(error).toBeInstanceOf(Error);
    assert.deepEqual(await readdir(join(root, "destination")), []);
    // And the source it linked FROM is untouched, which is the whole point of
    // taking the link back by inode rather than by name.
    assert.ok(existsSync(join(root, "folder", "SKILL.md")));
  });
});
