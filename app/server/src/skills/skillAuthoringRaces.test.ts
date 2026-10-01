/**
 * What a hand edit racing an agent may cost ([Task-633](pa://task/633)).
 *
 * The repository lock serializes the app against itself; it says nothing about
 * the user editing the same working tree. These tests act at the two moments
 * the ordinary seams cannot reach — just after a destination name is reserved,
 * and immediately before the one pathname operation that follows every check —
 * by wrapping the anchored source module itself.
 *
 * The invariant under test is never "the mutation succeeds". It is that content
 * belonging to somebody else is still there afterwards, and that the failure
 * says what happened. The single documented exception is an EMPTY directory
 * raced into the destination name inside the final syscall pair: the kernel
 * bounds a directory rename to replacing an empty directory, and one test below
 * pins exactly that ceiling so it cannot widen unnoticed.
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";

// Every test here commits a real git repository: seconds locally, but a
// starved CI runner has stretched the file past the 30 s default while every
// assertion is about bytes and counts, never about time.
vi.setConfig({ testTimeout: 120_000 });
import { git } from "../gitExec.ts";
import {
  createSkill,
  deleteSkill,
  manageSkillFiles,
  renameSkill,
  setMaxPlacedEntriesForTests,
} from "./skillAuthoring.ts";
import { setSkillLibraryBroadcaster } from "./skillLibraryEvents.ts";
import { SkillLibraryStore } from "./skillLibraryStore.ts";

/** How many directory entries the source seam has handed out since the reset. */
let entriesRead = 0;
/** Runs once, just after a destination name has been reserved and opened. */
let afterReservation: (() => void) | undefined;
/** Runs once, immediately before the next child is linked into a destination. */
let beforeChildLink: (() => void) | undefined;
/** Runs on every child open, with the name, while a tree is being checked. */
let onChildOpen: ((name: string) => void) | undefined;
/** Runs once, immediately before the next verified tree removal. */
let beforeTreeRemoval: (() => void) | undefined;
/** Runs once, immediately before the next single-file removal. */
let beforeChildRemoval: (() => void) | undefined;

vi.mock("./skillSource.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./skillSource.ts")>();
  return {
    ...actual,
    withReservedSkillFolder: async (
      ...args: Parameters<typeof actual.withReservedSkillFolder>
    ) => {
      const [rootHandle, folder, use] = args;
      return actual.withReservedSkillFolder(rootHandle, folder, (reserved) => {
        const hook = afterReservation;
        afterReservation = undefined;
        hook?.();
        return use(reserved);
      });
    },
    iterateSkillDirectory: (
      ...args: Parameters<typeof actual.iterateSkillDirectory>
    ) => {
      const inner = actual.iterateSkillDirectory(...args);
      return {
        async *[Symbol.asyncIterator]() {
          for await (const entry of inner) {
            entriesRead += 1;
            yield entry;
          }
        },
      };
    },
    withSkillChild: (...args: Parameters<typeof actual.withSkillChild>) => {
      const [, name] = args;
      onChildOpen?.(name);
      return actual.withSkillChild(...args);
    },
    linkSkillChild: async (
      ...args: Parameters<typeof actual.linkSkillChild>
    ) => {
      const hook = beforeChildLink;
      beforeChildLink = undefined;
      hook?.();
      return actual.linkSkillChild(...args);
    },
    removeSkillChildFile: async (
      ...args: Parameters<typeof actual.removeSkillChildFile>
    ) => {
      const hook = beforeChildRemoval;
      beforeChildRemoval = undefined;
      hook?.();
      return actual.removeSkillChildFile(...args);
    },
    removeVerifiedSkillTree: async (
      ...args: Parameters<typeof actual.removeVerifiedSkillTree>
    ) => {
      const hook = beforeTreeRemoval;
      beforeTreeRemoval = undefined;
      beforeChildRemoval = undefined;
      hook?.();
      return actual.removeVerifiedSkillTree(...args);
    },
  };
});

let root: string;
let library: SkillLibraryStore;

const meta = {
  actor: { id: "pi:workshop:sess-1", name: "Workshop test" },
  reason: "Change the skill",
  sessionId: "sess-1",
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "skills-race-test-"));
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
});

afterEach(() => {
  onChildOpen = undefined;
  afterReservation = undefined;
  beforeChildLink = undefined;
  beforeTreeRemoval = undefined;
  setSkillLibraryBroadcaster({ broadcast: () => undefined });
  rmSync(root, { recursive: true, force: true });
});

/** `O_RDONLY|O_DIRECTORY`, for holding a directory the way a hand author would. */
const O_RDONLY_DIR = constants.O_RDONLY | constants.O_DIRECTORY;

/** Enough bytes that hashing them takes long enough for a writer to act. */
function largeFiller(): Buffer {
  return Buffer.alloc(48 * 1024 * 1024, 7);
}

async function expectFailure(
  operation: () => Promise<unknown>,
): Promise<Error> {
  return operation().then(
    () => {
      throw new Error("expected the mutation to be refused");
    },
    (error: Error) => error,
  );
}

/** Give the seeded skill one supporting file, so a placement has real work. */
async function withSupportingFile(): Promise<void> {
  await manageSkillFiles(
    {
      name: "release-notes",
      operations: [
        { op: "write", path: "references/tone.md", content: "Be brief.\n" },
      ],
    },
    meta,
    library,
  );
}

/** Replace the entry at `name` with a folder the user owns. */
function userFolderAt(name: string, file = "mine.txt"): void {
  rmSync(join(root, name), { recursive: true, force: true });
  mkdirSync(join(root, name));
  writeFileSync(join(root, name, file), "user data\n");
}

/**
 * Put supporting files in the skill folder BY HAND and commit them, the way the
 * user does: a delete's whole expectation comes from what the repository has
 * committed, and only a hand author can commit a symlink or an executable here,
 * because no tool in this module makes one.
 */
async function committedByHand(make: () => void): Promise<void> {
  make();
  await git(["add", "-A"], root);
  await git(["commit", "-m", "Hand-authored supporting files"], root);
}

async function headCommit(): Promise<string> {
  return (await git(["rev-parse", "HEAD"], root)).stdout.trim();
}

/** Every path a `git clean` would be entitled to remove, for leak checks. */
function untracked(): string[] {
  return readdirSync(root).filter((entry) => entry !== ".git");
}

describe("a hand edit racing a rename", () => {
  test("a populated folder swapped into the destination is never written into", async () => {
    // The reservation exists and the user replaces it with a folder of their
    // own. Nothing may be written into that folder: a same-named file inside it
    // would be replaced silently, which is what moving content into a reserved
    // name — rather than moving the folder itself — used to allow.
    afterReservation = () => userFolderAt("changelog-notes", "SKILL.md");

    const error = await expectFailure(() =>
      renameSkill(
        { name: "release-notes", newName: "changelog-notes" },
        meta,
        library,
      ),
    );

    assert.equal(
      await readFile(join(root, "changelog-notes", "SKILL.md"), "utf8"),
      "user data\n",
      "the user's file must not be replaced by the skill's own manifest",
    );
    assert.match(error.message, /taken over|could not be undone/);
    assert.ok(existsSync(join(root, "release-notes", "SKILL.md")));
  });

  test("an empty folder swapped into the destination is not replaced", async () => {
    // The case this whole thread turned on. A `rename` onto the destination
    // would have consumed this directory; the skill is assembled with
    // create-or-fail calls instead, so the directory the user made is still the
    // same inode afterwards and the mutation refuses rather than proceeding
    // into something it does not own.
    await manageSkillFiles(
      {
        name: "release-notes",
        operations: [
          { op: "write", path: "references/tone.md", content: "Be brief.\n" },
        ],
      },
      meta,
      library,
    );
    let userInode = 0n;
    afterReservation = () => {
      rmSync(join(root, "changelog-notes"), { recursive: true, force: true });
      mkdirSync(join(root, "changelog-notes"));
      userInode = statSync(join(root, "changelog-notes"), {
        bigint: true,
      }).ino;
    };

    const error = await expectFailure(() =>
      renameSkill(
        { name: "release-notes", newName: "changelog-notes" },
        meta,
        library,
      ),
    );

    assert.equal(
      statSync(join(root, "changelog-notes"), { bigint: true }).ino,
      userInode,
      "the user's directory must be the same one, not a replacement",
    );
    assert.match(error.message, /taken over|could not be undone/);
    // The skill itself is untouched: nothing was removed from the source.
    assert.equal(
      await readFile(join(root, "release-notes/references/tone.md"), "utf8"),
      "Be brief.\n",
    );
    assert.ok(existsSync(join(root, "release-notes", "SKILL.md")));
  });

  test("a file appearing inside the destination mid-placement is never overwritten", async () => {
    await manageSkillFiles(
      {
        name: "release-notes",
        operations: [
          { op: "write", path: "references/tone.md", content: "Be brief.\n" },
        ],
      },
      meta,
      library,
    );
    // The destination exists and is this mutation's own; the user writes a file
    // into it under a name the placement is about to use.
    beforeChildLink = () => {
      mkdirSync(join(root, "changelog-notes", "references"), {
        recursive: true,
      });
      writeFileSync(
        join(root, "changelog-notes", "references", "tone.md"),
        "user data\n",
      );
    };

    const error = await expectFailure(() =>
      renameSkill(
        { name: "release-notes", newName: "changelog-notes" },
        meta,
        library,
      ),
    );

    assert.equal(
      await readFile(
        join(root, "changelog-notes", "references", "tone.md"),
        "utf8",
      ),
      "user data\n",
      "a name already taken must make the placement fail, not overwrite it",
    );
    assert.match(error.message, /already exists|could not be undone/);
    assert.equal(
      await readFile(join(root, "release-notes/references/tone.md"), "utf8"),
      "Be brief.\n",
      "the source keeps everything the placement could not move",
    );
  });

  test("a source name taken over mid-rename leaves the user's folder alone", async () => {
    await manageSkillFiles(
      {
        name: "release-notes",
        operations: [
          { op: "write", path: "references/tone.md", content: "Be brief.\n" },
        ],
      },
      meta,
      library,
    );
    beforeChildLink = () => {
      renameSync(join(root, "release-notes"), join(root, "moved-away"));
      mkdirSync(join(root, "release-notes"));
      writeFileSync(join(root, "release-notes", "mine.txt"), "user data\n");
    };

    const error = await expectFailure(() =>
      renameSkill(
        { name: "release-notes", newName: "changelog-notes" },
        meta,
        library,
      ),
    );

    assert.equal(
      await readFile(join(root, "release-notes", "mine.txt"), "utf8"),
      "user data\n",
      "the old name now belongs to the user and may not be removed",
    );
    assert.match(error.message, /could not be undone|not empty|ENOTEMPTY/);
  });

  test("a file replaced in the source just before its removal is not deleted", async () => {
    // The last check-to-use window. Everything is at the new name and the old
    // folder is about to go; a hand edit replaces one of its files with a new
    // inode under the same name — an editor's atomic save.
    await withSupportingFile();
    const sourceFile = join(root, "release-notes", "references", "tone.md");
    beforeTreeRemoval = () => {
      writeFileSync(`${sourceFile}.new`, "user rewrote this\n");
      renameSync(`${sourceFile}.new`, sourceFile);
    };

    const error = await expectFailure(() =>
      renameSkill(
        { name: "release-notes", newName: "changelog-notes" },
        meta,
        library,
      ),
    );

    // Two things must hold, and they used to conflict. The removal refuses, so
    // nothing is unlinked in the replacement's place — and the rollback then
    // leaves the file alone, because this mutation never changed that path.
    // Reverting it to HEAD would discard the hand author's bytes to undo work
    // that was never done to it.
    assert.match(error.message, /gained content|no longer|could not be undone/);
    assert.equal(
      await readFile(sourceFile, "utf8"),
      "user rewrote this\n",
      "the hand author's bytes survive a mutation that refused",
    );
    // The state is reported rather than hidden: the tree is dirty because of
    // that edit, and the post-rollback check names the path.
    assert.match(error.message, /could not be undone/);
    assert.match(
      (await git(["status", "--porcelain"], root)).stdout,
      /release-notes\/references\/tone\.md/,
    );
  });

  test("a file ADDED to the source before its removal stops the rename", async () => {
    await withSupportingFile();
    beforeTreeRemoval = () => {
      writeFileSync(
        join(root, "release-notes", "references", "draft.md"),
        "user data\n",
      );
    };

    const error = await expectFailure(() =>
      renameSkill(
        { name: "release-notes", newName: "changelog-notes" },
        meta,
        library,
      ),
    );

    assert.equal(
      await readFile(
        join(root, "release-notes", "references", "draft.md"),
        "utf8",
      ),
      "user data\n",
      "a file written into the old folder must not go with it",
    );
    assert.match(error.message, /gained content|could not be undone/);
  });

  test("a source folder REMOVED and recreated before its removal is not deleted", async () => {
    // The same inode-reuse case on the rename's source cleanup: the old folder
    // is not renamed away but DELETED, so its number is free for the folder the
    // hand author creates in its place.
    await withSupportingFile();
    beforeTreeRemoval = () => {
      rmSync(join(root, "release-notes"), { recursive: true, force: true });
      mkdirSync(join(root, "release-notes"));
      writeFileSync(
        join(root, "release-notes", "SKILL.md"),
        "---\nname: release-notes\ndescription: Mine now.\n---\n# Mine\n",
      );
      writeFileSync(join(root, "release-notes", "mine.txt"), "user data\n");
    };

    const error = await expectFailure(() =>
      renameSkill(
        { name: "release-notes", newName: "changelog-notes" },
        meta,
        library,
      ),
    );

    assert.equal(
      await readFile(join(root, "release-notes", "mine.txt"), "utf8"),
      "user data\n",
      "the folder that took the source name is not this rename's to remove",
    );
    assert.match(
      await readFile(join(root, "release-notes", "SKILL.md"), "utf8"),
      /Mine now/,
    );
    assert.ok(error.message.length > 0);
  });

  test("a source folder replaced just before its removal is not deleted", async () => {
    await withSupportingFile();
    beforeTreeRemoval = () => {
      renameSync(join(root, "release-notes"), join(root, "moved-away"));
      mkdirSync(join(root, "release-notes"));
      writeFileSync(join(root, "release-notes", "mine.txt"), "user data\n");
    };

    const error = await expectFailure(() =>
      renameSkill(
        { name: "release-notes", newName: "changelog-notes" },
        meta,
        library,
      ),
    );

    assert.equal(
      await readFile(join(root, "release-notes", "mine.txt"), "utf8"),
      "user data\n",
      "a folder this mutation did not assemble may not be removed",
    );
    assert.match(error.message, /no longer|could not be undone/);
  });

  test("an undisturbed rename still commits normally", async () => {
    await manageSkillFiles(
      {
        name: "release-notes",
        operations: [
          { op: "write", path: "references/tone.md", content: "Be brief.\n" },
        ],
      },
      meta,
      library,
    );

    const outcome = await renameSkill(
      { name: "release-notes", newName: "changelog-notes" },
      meta,
      library,
    );

    assert.equal(outcome.skill?.name, "changelog-notes");
    assert.equal(
      (await git(["status", "--porcelain"], root)).stdout.trim(),
      "",
    );
    assert.equal(
      await readFile(join(root, "changelog-notes/references/tone.md"), "utf8"),
      "Be brief.\n",
      "supporting files move with the skill",
    );
    assert.ok(!existsSync(join(root, "release-notes")));
    assert.deepEqual(untracked(), ["changelog-notes"]);
  });
});

describe("a hand edit racing a supporting-file removal", () => {
  test("a file replaced before its removal keeps the hand author's bytes", async () => {
    // The removal is inode-bound, so it refuses and puts the replacement back.
    // What used to undo that safety was the rollback: the path had already been
    // reported as changed before the attempt, so `checkout HEAD --` reverted
    // the replacement to its committed content.
    await withSupportingFile();
    const target = join(root, "release-notes", "references", "tone.md");
    beforeChildRemoval = () => {
      // Whatever the hand author put there, the removal refuses it without
      // changing anything — a directory is simply the variant this seam can
      // produce deterministically.
      rmSync(target);
      mkdirSync(target);
      writeFileSync(join(target, "mine.txt"), "user data\n");
    };

    const error = await expectFailure(() =>
      manageSkillFiles(
        {
          name: "release-notes",
          operations: [{ op: "delete", path: "references/tone.md" }],
        },
        meta,
        library,
      ),
    );

    assert.equal(
      await readFile(join(target, "mine.txt"), "utf8"),
      "user data\n",
      "a removal that refused may not have its path reverted by the rollback",
    );
    assert.match(error.message, /directory|changed|could not be undone/);
  });

  test("a removal that goes through is still undone by a refused commit", async () => {
    await withSupportingFile();
    const hooks = join(root, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });

    await expectFailure(() =>
      manageSkillFiles(
        {
          name: "release-notes",
          operations: [{ op: "delete", path: "references/tone.md" }],
        },
        meta,
        library,
      ),
    );

    assert.equal(
      await readFile(
        join(root, "release-notes", "references", "tone.md"),
        "utf8",
      ),
      "Be brief.\n",
      "a path this mutation really did remove comes back",
    );
    assert.equal(
      (await git(["status", "--porcelain"], root)).stdout.trim(),
      "",
    );
  });
});

describe("a hand edit racing a create", () => {
  test("a populated folder swapped into a reserved new name is never written into", async () => {
    afterReservation = () => userFolderAt("triage-notes", "SKILL.md");

    const error = await expectFailure(() =>
      createSkill(
        { name: "triage-notes", description: "Triage", body: "Body" },
        meta,
        library,
      ),
    );

    assert.equal(
      await readFile(join(root, "triage-notes", "SKILL.md"), "utf8"),
      "user data\n",
      "a manifest goes into the folder this mutation created, or nowhere",
    );
    assert.ok(error.message.length > 0);
  });
});

describe("a hand edit racing the Git handoff", () => {
  test("content rewritten IN PLACE at a placed name is never committed", async () => {
    // The placement is a hard link, so this rewrite goes through the very inode
    // the rename put at the new name: `dev`/`ino` do not move, and every check
    // that asks "is this still my entry?" says yes over somebody else's bytes.
    // The hook fires just before the source cleanup, which is still before the
    // handoff to Git.
    await withSupportingFile();
    beforeTreeRemoval = () => {
      const placed = join(root, "changelog-notes", "references", "tone.md");
      const fd = openSync(placed, "r+");
      ftruncateSync(fd, 0);
      writeSync(fd, "user rewrote this\n");
      closeSync(fd);
    };

    const error = await expectFailure(() =>
      renameSkill(
        { name: "release-notes", newName: "changelog-notes" },
        meta,
        library,
      ),
    );

    assert.match(
      error.message,
      /gained content|did not make|could not be undone/,
    );
    assert.equal(
      (await git(["rev-list", "--count", "HEAD"], root)).stdout.trim(),
      "2",
      "the seed and its supporting file, and nothing this rename committed",
    );
    // Their bytes are not destroyed, at either name. The source removal is
    // refused because the tree no longer holds what the repository committed,
    // so the file they edited is still the file they edited — and the placed
    // link, being the same inode, is no longer what this rename placed either,
    // so the undo leaves it too. Both are leftovers the status check reports.
    assert.equal(
      await readFile(
        join(root, "changelog-notes", "references", "tone.md"),
        "utf8",
      ),
      "user rewrote this\n",
    );
    assert.equal(
      await readFile(
        join(root, "release-notes", "references", "tone.md"),
        "utf8",
      ),
      "user rewrote this\n",
    );
  });

  test("an in-place edit of the SOURCE manifest is not deleted with the old tree", async () => {
    // The manifest is the one file a rename reads and does NOT carry across: it
    // rewrites the declared name into a new file at the destination and deletes
    // the original with the old tree. So a hand author editing the source
    // manifest after that read keeps its inode, passes every identity check,
    // and would have their edit deleted while the commit describes the version
    // this mutation read — with a clean tree afterwards to say nothing happened.
    await withSupportingFile();
    const manifest = join(root, "release-notes", "SKILL.md");
    const committed = (await git(["rev-parse", "HEAD"], root)).stdout.trim();
    beforeTreeRemoval = () => {
      const before = statSync(manifest);
      const fd = openSync(manifest, "r+");
      ftruncateSync(fd, 0);
      writeSync(
        fd,
        "---\nname: release-notes\ndescription: How to write release notes\n---\n# Mine\n",
      );
      closeSync(fd);
      assert.equal(
        statSync(manifest).ino,
        before.ino,
        "the reproduction requires the inode to be unchanged",
      );
    };

    const error = await expectFailure(() =>
      renameSkill(
        { name: "release-notes", newName: "changelog-notes" },
        meta,
        library,
      ),
    );

    assert.match(error.message, /gained content|could not be undone/);
    assert.equal(
      (await git(["rev-parse", "HEAD"], root)).stdout.trim(),
      committed,
      "nothing may be committed over an edit this rename did not read",
    );
    assert.match(
      await readFile(manifest, "utf8"),
      /# Mine/,
      "the hand author's manifest must still be there",
    );
  });

  test("an edit landing AFTER its proof, while a large sibling is still being checked, is not deleted", async () => {
    // Proving a tree and emptying it are two walks, and the first has no bound:
    // one large sibling stretches it as long as the writer needs. A hand author
    // holding the manifest open can therefore rewrite it after its own hash and
    // before the walk that unlinks reaches it — and every check the removal had
    // already done still says yes.
    const manifest = join(root, "release-notes", "SKILL.md");
    // The sibling that widens the window. `zzz` sorts after `SKILL.md`, so it
    // is hashed second and the manifest's proof is long finished by then.
    writeFileSync(join(root, "release-notes", "zzz-large.bin"), largeFiller());
    await git(["add", "-A"], root);
    await git(["commit", "-m", "large sibling"], root);
    const committed = (await git(["rev-parse", "HEAD"], root)).stdout.trim();

    const writer = openSync(manifest, "r+");
    try {
      const before = statSync(manifest);
      let manifestProved = false;
      let landedAfterProof = false;
      onChildOpen = (name) => {
        if (name === "SKILL.md") {
          manifestProved = true;
          return;
        }
        // The big sibling's turn: the manifest's proof is behind us and its
        // unlink is still ahead. The write goes through the descriptor opened
        // above, so no inode changes and no name is rebound — nothing the
        // earlier checks looked at is disturbed.
        if (!manifestProved || landedAfterProof || name !== "zzz-large.bin") {
          return;
        }
        landedAfterProof = true;
        ftruncateSync(writer, 0);
        writeSync(
          writer,
          "---\nname: release-notes\ndescription: How to write release notes\n---\n# Mine\n",
        );
      };

      const error = await expectFailure(() =>
        renameSkill(
          { name: "release-notes", newName: "changelog-notes" },
          meta,
          library,
        ),
      );

      assert.ok(
        landedAfterProof,
        "the write must land AFTER the manifest's own proof, or this test proves nothing",
      );
      assert.equal(
        statSync(manifest).ino,
        before.ino,
        "the reproduction requires the inode to be unchanged",
      );
      assert.match(error.message, /gained content|could not be undone/);
      assert.equal(
        (await git(["rev-parse", "HEAD"], root)).stdout.trim(),
        committed,
        "nothing may be committed over an edit this rename never read",
      );
      assert.match(
        await readFile(manifest, "utf8"),
        /# Mine/,
        "the hand author's manifest must still be there",
      );
    } finally {
      closeSync(writer);
    }
  });

  test("a file CREATED through a held directory descriptor after the proof is not deleted", async () => {
    // The other half of the same window, and the one an entry-by-entry check
    // cannot see by itself: the hand author does not touch anything the proof
    // walk looked at, they ADD to the folder — through a descriptor taken
    // before the detach, so the private name stops nothing. With no reading
    // recorded for that name, "nothing to check" would mean "unlink it".
    const folder = openSync(join(root, "release-notes"), O_RDONLY_DIR);
    try {
      writeFileSync(
        join(root, "release-notes", "zzz-large.bin"),
        largeFiller(),
      );
      await git(["add", "-A"], root);
      await git(["commit", "-m", "large sibling"], root);
      const committed = (await git(["rev-parse", "HEAD"], root)).stdout.trim();

      let created = false;
      onChildOpen = (name) => {
        // The big sibling's proof is starting: the listing is long done and the
        // walk that removes has not begun.
        if (created || name !== "zzz-large.bin") return;
        created = true;
        writeFileSync(`/proc/self/fd/${folder}/mine.txt`, "user data\n");
      };

      const error = await expectFailure(() =>
        renameSkill(
          { name: "release-notes", newName: "changelog-notes" },
          meta,
          library,
        ),
      );

      assert.ok(
        created,
        "the file must be created INSIDE the proof window, or this proves nothing",
      );
      assert.match(error.message, /gained content|could not be undone/);
      assert.equal(
        (await git(["rev-parse", "HEAD"], root)).stdout.trim(),
        committed,
        "nothing may be committed while the old folder still holds their file",
      );
      assert.equal(
        await readFile(join(root, "release-notes", "mine.txt"), "utf8"),
        "user data\n",
        "a file this rename never saw is not this rename's to delete",
      );
    } finally {
      closeSync(folder);
    }
  });

  test("content rewritten in place with size and mtime RESTORED is still not deleted", async () => {
    // The sharper form of the case above, and the reason metadata cannot stand
    // in for content: the rewrite keeps the same inode, writes exactly as many
    // bytes, and puts the modification time back with `utimes`. Size, mtime and
    // inode all match what was placed; only the bytes are somebody else's.
    await withSupportingFile();
    beforeTreeRemoval = () => {
      const placed = join(root, "changelog-notes", "references", "tone.md");
      const before = statSync(placed);
      const fd = openSync(placed, "r+");
      writeSync(fd, "Be BRIEF.\n", 0);
      closeSync(fd);
      utimesSync(placed, before.atime, before.mtime);
      const after = statSync(placed);
      assert.equal(after.ino, before.ino, "the inode must not have changed");
      assert.equal(after.size, before.size, "the size must not have changed");
      assert.equal(
        after.mtimeMs,
        before.mtimeMs,
        "the modification time must have been put back",
      );
    };

    const error = await expectFailure(() =>
      renameSkill(
        { name: "release-notes", newName: "changelog-notes" },
        meta,
        library,
      ),
    );

    assert.match(error.message, /did not make|could not be undone/);
    assert.equal(
      await readFile(
        join(root, "changelog-notes", "references", "tone.md"),
        "utf8",
      ),
      "Be BRIEF.\n",
      "their bytes are not this rename's to delete, whatever the metadata says",
    );
  });
});

describe("what a rename reads", () => {
  afterEach(() => setMaxPlacedEntriesForTests(null));

  test("stops reading the source folder at the entry it refuses on", async () => {
    // The placed-entry ceiling (512 in production) is a bound on the READ as
    // much as on the descriptors it protects. Listing a folder eagerly would
    // build every one of a hand-authored million siblings into an array before
    // the refusal — so the ceiling would bound nothing that matters for a
    // folder big enough to be the problem. The claim does not depend on the
    // number, so a small ceiling keeps the fixture small.
    const ceiling = 8;
    const files = 40;
    setMaxPlacedEntriesForTests(ceiling);
    for (let index = 0; index < files; index += 1) {
      writeFileSync(join(root, "release-notes", `file-${index}.txt`), "x");
    }
    await git(["add", "-A"], root);
    await git(["commit", "-m", "many files"], root);
    entriesRead = 0;

    const error = await expectFailure(() =>
      renameSkill(
        { name: "release-notes", newName: "changelog-notes" },
        meta,
        library,
      ),
    );

    assert.match(
      error.message,
      new RegExp(`more than ${ceiling} files and directories`),
    );
    assert.ok(
      entriesRead > ceiling && entriesRead < files,
      `the refusal must come from a bounded read, not after all ${files + 1} entries (read ${entriesRead})`,
    );
    assert.ok(!existsSync(join(root, "changelog-notes")));
    assert.ok(existsSync(join(root, "release-notes", `file-${files - 1}.txt`)));
    assert.equal(
      (await git(["status", "--porcelain"], root)).stdout.trim(),
      "",
    );
  });
});

describe("a hand edit racing a delete", () => {
  test("a folder swapped in before the delete moves it aside is refused", async () => {
    beforeTreeRemoval = () => {
      renameSync(join(root, "release-notes"), join(root, "moved-away"));
      mkdirSync(join(root, "release-notes"));
      writeFileSync(join(root, "release-notes", "mine.txt"), "user data\n");
    };

    const error = await expectFailure(() =>
      deleteSkill({ name: "release-notes" }, meta, library),
    );

    assert.match(error.message, /replaced while it was being deleted|undone/);
    assert.equal(
      await readFile(join(root, "release-notes", "mine.txt"), "utf8"),
      "user data\n",
      "the folder that raced in must not be deleted by name",
    );
    assert.ok(existsSync(join(root, "moved-away", "SKILL.md")));
  });

  test("a folder REMOVED and recreated before the delete is not deleted", async () => {
    // Sharper than the swap above, and the reason a recorded number is not an
    // identity: removing the folder FREES its inode, and the kernel hands that
    // very number to the directory created next. A delete bound to what the
    // scan wrote down therefore recognises the replacement as its own target.
    // Bound to a held descriptor instead, it cannot: the pinned inode is not
    // free, so the new folder is a different one, whatever it is numbered.
    beforeTreeRemoval = () => {
      rmSync(join(root, "release-notes"), { recursive: true, force: true });
      mkdirSync(join(root, "release-notes"));
      writeFileSync(
        join(root, "release-notes", "SKILL.md"),
        "---\nname: release-notes\ndescription: Mine now.\n---\n# Mine\n",
      );
      writeFileSync(join(root, "release-notes", "mine.txt"), "user data\n");
    };

    const error = await expectFailure(() =>
      deleteSkill({ name: "release-notes" }, meta, library),
    );

    assert.equal(
      await readFile(join(root, "release-notes", "mine.txt"), "utf8"),
      "user data\n",
      "a folder recreated at the name is not the one that was scanned",
    );
    assert.match(
      await readFile(join(root, "release-notes", "SKILL.md"), "utf8"),
      /Mine now/,
    );
    assert.ok(error.message.length > 0);
  });

  test("a file a hand author added is not deleted with the skill", async () => {
    // A delete had no content expectation at all: it removed whatever the
    // folder held. But "remove this skill" is not licence to remove a file
    // somebody put beside it, whether it appeared before the delete started or
    // through a descriptor held across it.
    writeFileSync(join(root, "release-notes", "mine.txt"), "user data\n");

    const error = await expectFailure(() =>
      deleteSkill({ name: "release-notes" }, meta, library),
    );

    assert.ok(error.message.length > 0);
    assert.equal(
      await readFile(join(root, "release-notes", "mine.txt"), "utf8"),
      "user data\n",
      "their file is not this delete's to take",
    );
    assert.ok(
      existsSync(join(root, "release-notes", "SKILL.md")),
      "and the skill stays, because its folder could not be emptied safely",
    );
  });

  test("a committed symlink repointed just before the detach is not deleted", async () => {
    // An object id is not an ENTRY. A symlink's content is the path it points
    // at, and repointing one is `unlink` plus `symlink` — a new inode, a new
    // target, and nothing an expectation that kept only "there is a blob here"
    // could tell apart from the link the repository committed.
    await committedByHand(() => {
      writeFileSync(join(root, "release-notes", "tone.md"), "Be brief.\n");
      writeFileSync(join(root, "release-notes", "notes.md"), "Theirs.\n");
      symlinkSync("tone.md", join(root, "release-notes", "style.md"));
    });
    const head = await headCommit();
    beforeTreeRemoval = () => {
      unlinkSync(join(root, "release-notes", "style.md"));
      symlinkSync("notes.md", join(root, "release-notes", "style.md"));
    };

    const error = await expectFailure(() =>
      deleteSkill({ name: "release-notes" }, meta, library),
    );

    assert.match(error.message, /being deleted|undone/);
    assert.equal(
      readlinkSync(join(root, "release-notes", "style.md")),
      "notes.md",
      "the link they repointed is not this delete's to remove",
    );
    assert.ok(existsSync(join(root, "release-notes", "SKILL.md")));
    assert.equal(await headCommit(), head, "nothing may be committed");
  });

  test("a committed file replaced by a symlink just before the detach is not deleted", async () => {
    // The same gap from the other side: the repository committed a FILE here,
    // and what stands at the name now is a link out of the folder entirely.
    await committedByHand(() => {
      writeFileSync(join(root, "release-notes", "tone.md"), "Be brief.\n");
    });
    const head = await headCommit();
    beforeTreeRemoval = () => {
      unlinkSync(join(root, "release-notes", "tone.md"));
      symlinkSync("../elsewhere.md", join(root, "release-notes", "tone.md"));
    };

    const error = await expectFailure(() =>
      deleteSkill({ name: "release-notes" }, meta, library),
    );

    assert.match(error.message, /being deleted|undone/);
    assert.equal(
      readlinkSync(join(root, "release-notes", "tone.md")),
      "../elsewhere.md",
    );
    assert.ok(existsSync(join(root, "release-notes", "SKILL.md")));
    assert.equal(await headCommit(), head);
  });

  test("a committed file made executable just before the detach is not deleted", async () => {
    // A mode is half of a Git entry, and a `chmod +x` is a change Git records
    // and this mutation did not make. The bytes are untouched, so a proof of
    // content alone waves it through and removes the file they just marked.
    await git(["config", "core.fileMode", "true"], root);
    await committedByHand(() => {
      writeFileSync(join(root, "release-notes", "build.sh"), "#!/bin/sh\n");
    });
    const head = await headCommit();
    beforeTreeRemoval = () => {
      chmodSync(join(root, "release-notes", "build.sh"), 0o755);
    };

    const error = await expectFailure(() =>
      deleteSkill({ name: "release-notes" }, meta, library),
    );

    assert.match(error.message, /being deleted|undone/);
    assert.ok(
      (statSync(join(root, "release-notes", "build.sh")).mode & 0o100) !== 0,
      "the bit they set must still be set",
    );
    assert.ok(existsSync(join(root, "release-notes", "SKILL.md")));
    assert.equal(await headCommit(), head);
  });

  test("a chmod is NOT a change where the repository does not track modes", async () => {
    // The deliberate boundary of the check above. With `core.fileMode` off, a
    // `chmod` is not a change Git can see — `git status` stays clean through
    // one — so refusing over it would refuse every delete in such a repository
    // over a difference the user never made.
    // `off` is a valid Git boolean spelling and must be normalized rather than
    // compared with the one literal spelling `false`.
    await git(["config", "core.fileMode", "off"], root);
    await committedByHand(() => {
      writeFileSync(join(root, "release-notes", "build.sh"), "#!/bin/sh\n");
    });
    beforeTreeRemoval = () => {
      chmodSync(join(root, "release-notes", "build.sh"), 0o755);
    };

    await deleteSkill({ name: "release-notes" }, meta, library);

    assert.ok(!existsSync(join(root, "release-notes")));
    assert.equal(
      (await git(["status", "--porcelain"], root)).stdout.trim(),
      "",
    );
  });

  test("a skill whose committed files include a symlink and an executable is still deleted", async () => {
    // The proof got stricter, so this is the half that says it did not get
    // wrong: an untouched folder holding exactly what the repository committed
    // still goes, symlink, executable bit and all.
    await committedByHand(() => {
      writeFileSync(join(root, "release-notes", "tone.md"), "Be brief.\n");
      chmodSync(join(root, "release-notes", "tone.md"), 0o644);
      writeFileSync(join(root, "release-notes", "build.sh"), "#!/bin/sh\n");
      chmodSync(join(root, "release-notes", "build.sh"), 0o755);
      mkdirSync(join(root, "release-notes", "references"));
      symlinkSync(
        "../tone.md",
        join(root, "release-notes", "references", "style.md"),
      );
    });

    await deleteSkill({ name: "release-notes" }, meta, library);

    assert.ok(!existsSync(join(root, "release-notes")));
    assert.deepEqual(untracked(), []);
    assert.equal(
      (await git(["status", "--porcelain"], root)).stdout.trim(),
      "",
    );
  });

  test("an undisturbed delete removes the folder and leaves no aside name", async () => {
    await manageSkillFiles(
      {
        name: "release-notes",
        operations: [
          { op: "write", path: "references/tone.md", content: "Be brief.\n" },
        ],
      },
      meta,
      library,
    );

    await deleteSkill({ name: "release-notes" }, meta, library);

    assert.deepEqual(untracked(), []);
    assert.equal(
      (await git(["status", "--porcelain"], root)).stdout.trim(),
      "",
    );
  });
});
