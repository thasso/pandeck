/**
 * The anchored, no-follow source seam ([Task-614](pa://task/614)).
 *
 * These pin the property both the scan and the single-skill read depend on: a
 * path is resolved ONCE, and everything after that — the identity, the bytes —
 * comes from the open file description. Swapping the entry afterwards is the
 * defect this seam exists to make impossible, and it is exercised here
 * deterministically, by swapping while the handle is held. Run:
 *   pnpm --filter @assistant/server test src/skills/skillSource.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import {
  link,
  lstat,
  open,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
  createSkillChildDirectory,
  createSkillChildFile,
  linkSkillChild,
  readSkillDirectory,
  removeVerifiedSkillTree,
  skillChildIdentity,
  SymlinkedSkillSourceError,
  unlinkSkillChildIfSame,
  withLibraryRoot,
  withSkillChild,
  withSkillSource,
} from "./skillSource.ts";

let root: string;
let outside: string;

const REAL = "---\nname: real\ndescription: The scanned file.\n---\n# Real\n";
const OUTSIDE = "---\nname: outside\ndescription: Not ours.\n---\n# Outside\n";

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "skill-source-test-"));
  outside = mkdtempSync(join(tmpdir(), "skill-source-outside-"));
  await writeFile(join(outside, "SKILL.md"), OUTSIDE, "utf8");
  await mkdir(join(root, "folder"), { recursive: true });
  await writeFile(join(root, "folder", "SKILL.md"), REAL, "utf8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("withSkillSource", () => {
  test("keeps reading the opened inode after the path is swapped for a link", async () => {
    const read = await withLibraryRoot(root, (rootHandle) =>
      withSkillSource(rootHandle, "folder", async (source) => {
        // The pathname now answers with an outside file. The handle does not.
        await rm(join(root, "folder", "SKILL.md"));
        await symlink(
          join(outside, "SKILL.md"),
          join(root, "folder", "SKILL.md"),
        );
        return {
          content: await source.file.readFile("utf8"),
          identity: source.identity,
        };
      }),
    );

    assert.equal(read.content, REAL);
    assert.equal(read.identity.file.ino > 0, true);
  });

  test("reports the identity of the very handle it hands over", async () => {
    const folderStat = await stat(join(root, "folder"));
    const fileStat = await stat(join(root, "folder", "SKILL.md"));

    const identity = await withLibraryRoot(root, (rootHandle) =>
      withSkillSource(rootHandle, "folder", async (source) => source.identity),
    );

    assert.deepEqual(identity, {
      folder: { dev: folderStat.dev, ino: folderStat.ino },
      file: { dev: fileStat.dev, ino: fileStat.ino },
    });
  });

  test("refuses a symlinked SKILL.md rather than following it", async () => {
    await rm(join(root, "folder", "SKILL.md"));
    await symlink(join(outside, "SKILL.md"), join(root, "folder", "SKILL.md"));

    await assert.rejects(
      withLibraryRoot(root, (rootHandle) =>
        withSkillSource(rootHandle, "folder", async (source) =>
          source.file.readFile("utf8"),
        ),
      ),
      SymlinkedSkillSourceError,
    );
  });

  test("refuses a symlinked source folder rather than following it", async () => {
    await symlink(outside, join(root, "linked"));

    await assert.rejects(
      withLibraryRoot(root, (rootHandle) =>
        withSkillSource(rootHandle, "linked", async (source) =>
          source.file.readFile("utf8"),
        ),
      ),
      SymlinkedSkillSourceError,
    );
  });

  test("does not block on a named pipe left where SKILL.md belongs", async () => {
    const { execFileSync } = await import("node:child_process");
    await rm(join(root, "folder", "SKILL.md"));
    execFileSync("mkfifo", [join(root, "folder", "SKILL.md")]);

    // Without O_NONBLOCK this open would wait for a writer forever, hanging a
    // scan and every HTTP read behind it.
    await assert.rejects(
      withLibraryRoot(root, (rootHandle) =>
        withSkillSource(rootHandle, "folder", async (source) =>
          source.file.readFile("utf8"),
        ),
      ),
      /not a regular file/,
    );
  });
});

/**
 * Removal is bound to an INODE, not to a name.
 *
 * `unlink` and `rmdir` take names, and nothing stops another writer rebinding a
 * name between a check and the call that acts on it. Two mechanisms answer
 * that, and these tests pin both. A file is moved to a private name before it
 * is examined and destroyed, and its identity is only meaningful because the
 * caller PINS it — an inode number on its own is reused the instant its file is
 * deleted, which the second test demonstrates as the reason the pin exists. A
 * whole tree is moved out of reach first, so the recursive removal below it has
 * no windows in it at all.
 */
describe("identity-bound removal", () => {
  test("a pinned file replaced at its name is restored, not unlinked", async () => {
    const folder = join(root, "skill");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "tone.md"), "agent bytes\n", "utf8");
    // The rename pins every file it is about to remove by linking it to the new
    // name first; this stands in for that link.
    await link(join(folder, "tone.md"), join(root, "pinned"));

    const removed = await withLibraryRoot(root, (rootHandle) =>
      withSkillChild(rootHandle, "skill", async (child) => {
        const pinned = await skillChildIdentity(child.handle, "tone.md");
        assert.ok(pinned);
        await rm(join(folder, "tone.md"));
        await writeFile(join(folder, "tone.md"), "user bytes\n", "utf8");
        return unlinkSkillChildIfSame(child.handle, "tone.md", pinned);
      }),
    );

    assert.equal(removed, false);
    assert.equal(
      await readFile(join(folder, "tone.md"), "utf8"),
      "user bytes\n",
      "the replacement must be put back, not deleted in the original's place",
    );
    assert.deepEqual(
      (await readdir(folder)).sort(),
      ["tone.md"],
      "and no private aside name may be left behind",
    );
  });

  test("a file that is still the pinned inode is removed", async () => {
    const folder = join(root, "skill");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "tone.md"), "agent bytes\n", "utf8");

    const removed = await withLibraryRoot(root, (rootHandle) =>
      withSkillChild(rootHandle, "skill", async (child) => {
        const identity = await skillChildIdentity(child.handle, "tone.md");
        assert.ok(identity);
        return unlinkSkillChildIfSame(child.handle, "tone.md", identity);
      }),
    );

    assert.equal(removed, true);
    assert.deepEqual(await readdir(folder), []);
  });
});

describe("removeVerifiedSkillTree", () => {
  async function skillTree(): Promise<{ dev: number; ino: number }> {
    await mkdir(join(root, "skill", "references"), { recursive: true });
    await writeFile(join(root, "skill", "SKILL.md"), "manifest\n", "utf8");
    const stats = await stat(join(root, "skill"));
    return { dev: stats.dev, ino: stats.ino };
  }

  test("removes the tree it was given, leaving nothing behind", async () => {
    const identity = await skillTree();

    const outcome = await withLibraryRoot(root, (rootHandle) =>
      removeVerifiedSkillTree(rootHandle, "skill", identity),
    );

    assert.equal(outcome, "removed");
    assert.ok(!(await readdir(root)).includes("skill"));
    assert.ok(
      !(await readdir(root)).some((entry) => entry.startsWith(".pa-skill-")),
      "no private aside name may be left behind",
    );
  });

  test("refuses and restores a tree that is not the recorded one", async () => {
    const identity = await skillTree();
    await rm(join(root, "skill"), { recursive: true });
    await mkdir(join(root, "skill"));
    await writeFile(join(root, "skill", "mine.txt"), "user data\n", "utf8");

    const outcome = await withLibraryRoot(root, (rootHandle) =>
      removeVerifiedSkillTree(rootHandle, "skill", { ...identity, ino: 1 }),
    );

    assert.equal(outcome, "not-ours");
    assert.equal(
      await readFile(join(root, "skill", "mine.txt"), "utf8"),
      "user data\n",
      "a tree this call did not recognise must be put back untouched",
    );
  });

  test("a rejected tree is restored without replacing a raced-in directory", async () => {
    // The reproduction from review: the expectation callback runs while the
    // tree is already moved aside, and creates an empty directory at the public
    // name in that moment. Restoring with `rename` would have replaced it. The
    // restore reassembles instead, so that directory is either still the one
    // the hand author made, or the restore refused and said where the tree is.
    const identity = await skillTree();
    let racedInode = 0n;

    const outcome = await withLibraryRoot(root, (rootHandle) =>
      removeVerifiedSkillTree(rootHandle, "skill", identity, async () => {
        await mkdir(join(root, "skill"));
        racedInode = (await stat(join(root, "skill"), { bigint: true })).ino;
        return { holds: false };
      }),
    ).catch((error: Error) => error);

    if (outcome instanceof Error) {
      // Refused to force the name; the tree is named in the message.
      assert.match(outcome.message, /could not be put back/);
      assert.equal(
        (await stat(join(root, "skill"), { bigint: true })).ino,
        racedInode,
        "the directory the hand author made must not be replaced",
      );
      return;
    }
    assert.equal(outcome, "unexpected-content");
    assert.equal(
      (await stat(join(root, "skill"), { bigint: true })).ino,
      racedInode,
      "the directory the hand author made must not be replaced",
    );
  });

  test("refuses and restores a tree that gained content", async () => {
    const identity = await skillTree();
    await writeFile(join(root, "skill", "mine.txt"), "user data\n", "utf8");

    const outcome = await withLibraryRoot(root, (rootHandle) =>
      removeVerifiedSkillTree(rootHandle, "skill", identity, async (tree) => ({
        holds: (await readSkillDirectory(tree)).every(
          (entry) => entry.name !== "mine.txt",
        ),
      })),
    );

    assert.equal(outcome, "unexpected-content");
    assert.equal(
      await readFile(join(root, "skill", "mine.txt"), "utf8"),
      "user data\n",
      "a file added to the tree stops the removal instead of going with it",
    );
    assert.ok((await readdir(join(root, "skill"))).includes("SKILL.md"));
  });
});

describe("a removal racing a writer that already holds the inode open", () => {
  /**
   * Detaching an entry to a private name stops anything from OPENING it by
   * name. It does not stop a writer who took a descriptor before that, and a
   * hash is many reads: an append that lands during one leaves the prefix
   * matching what was expected while the file on disk is longer. Unlinking on
   * the strength of that prefix destroys bytes nobody proved were ours.
   */
  test("an append during the content check refuses the unlink", async () => {
    const path = join(root, "folder", "tone.md");
    await writeFile(path, "ours\n", "utf8");
    const expected = await readFile(path);
    const writer = await open(path, "a");
    try {
      const removed = await withLibraryRoot(root, (rootHandle) =>
        withSkillChild(rootHandle, "folder", (folder) =>
          unlinkSkillChildIfSame(
            folder.handle,
            "tone.md",
            statSync(path),
            async (handle) => {
              // The writer lands in the middle of the check, through the
              // descriptor it already had.
              await writer.write("user appended\n");
              const read = await handle.readFile();
              return read.subarray(0, expected.byteLength).equals(expected);
            },
          ),
        ),
      );

      assert.equal(removed, false, "a prefix match may not authorise a delete");
      assert.equal(
        await readFile(path, "utf8"),
        "ours\nuser appended\n",
        "their bytes must still be there, under the original name",
      );
    } finally {
      await writer.close();
    }
  });
});

describe("pinning", () => {
  /**
   * The property every mutation-owned undo rests on. An inode NUMBER is not an
   * identity: the kernel hands a freed one straight back to the next entry
   * created, so a recorded number matches an entry somebody else put at the
   * same name just as well as the one it was taken from. A held descriptor is
   * what makes the number mean something, and these pin exactly that
   * difference — measured, not assumed.
   */
  test("an unpinned inode number is handed to the entry that replaces it", async () => {
    // Reuse is the ALLOCATOR's behaviour, not a filesystem contract, so this
    // does not demand it on the first try: it repeats the cycle and asserts
    // that a number this process let go of comes back at least once. That is
    // all the premise needs — an unpinned number can be somebody else's entry.
    // The contract itself, that a PINNED number never comes back, is asserted
    // on every single round and by the tests below.
    const path = join(root, "folder", "gone.txt");
    const held: FileHandle[] = [];
    let reused = 0;
    try {
      for (let round = 0; round < 50 && reused === 0; round += 1) {
        await writeFile(path, "ours\n", "utf8");
        const unpinned = (await stat(path)).ino;
        // The same cycle, one file along, with the inode held open throughout.
        await writeFile(`${path}.pinned`, "ours\n", "utf8");
        const pin = await open(`${path}.pinned`, "r");
        held.push(pin);
        const pinned = (await pin.stat()).ino;

        await rm(path);
        await rm(`${path}.pinned`);
        await writeFile(path, "theirs\n", "utf8");
        await writeFile(`${path}.pinned`, "theirs\n", "utf8");

        if ((await stat(path)).ino === unpinned) reused += 1;
        assert.notEqual(
          (await stat(`${path}.pinned`)).ino,
          pinned,
          "a held inode may never be handed to the entry that replaces it",
        );
        await rm(path);
        await rm(`${path}.pinned`);
      }
    } finally {
      for (const pin of held) await pin.close();
    }

    assert.ok(
      reused > 0,
      "no unpinned number was reused in 50 rounds, so the premise that a recorded number can name somebody else's entry was never exercised",
    );
  });

  test("a pinned file keeps its number away from its replacement", async () => {
    const pin = await withLibraryRoot(root, (rootHandle) =>
      withSkillChild(rootHandle, "folder", (child) =>
        createSkillChildFile(
          child.handle,
          "ours.txt",
          new TextEncoder().encode("ours\n"),
        ),
      ),
    );
    try {
      await rm(join(root, "folder", "ours.txt"));
      await writeFile(join(root, "folder", "ours.txt"), "theirs\n", "utf8");

      const replacement = await stat(join(root, "folder", "ours.txt"));
      assert.notEqual(replacement.ino, pin.identity.ino);
    } finally {
      await pin.handle.close();
    }
  });

  test("a pinned directory keeps its number away from its replacement", async () => {
    const pin = await withLibraryRoot(root, (rootHandle) =>
      withSkillChild(rootHandle, "folder", (child) =>
        createSkillChildDirectory(child.handle, "sub"),
      ),
    );
    try {
      await rm(join(root, "folder", "sub"), { recursive: true });
      await mkdir(join(root, "folder", "sub"));

      const replacement = await stat(join(root, "folder", "sub"));
      assert.notEqual(replacement.ino, pin.identity.ino);
    } finally {
      await pin.handle.close();
    }
  });

  test("a symlink can be pinned, which no ordinary open can do", async () => {
    await symlink("SKILL.md", join(root, "folder", "self.md"));
    const pin = await withLibraryRoot(root, (rootHandle) =>
      withSkillChild(rootHandle, "folder", async (child) => {
        await mkdir(join(root, "destination"));
        return withSkillChild(rootHandle, "destination", (destination) =>
          linkSkillChild(child.handle, "self.md", destination.handle),
        );
      }),
    );
    try {
      // Linked as the symlink it is, and pinned without being followed.
      const placed = await lstat(join(root, "destination", "self.md"));
      assert.ok(placed.isSymbolicLink());
      assert.equal(placed.ino, pin.identity.ino);
    } finally {
      await pin.handle.close();
    }
  });
});
