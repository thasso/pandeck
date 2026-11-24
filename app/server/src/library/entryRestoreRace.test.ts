/**
 * What putting a detached tree BACK owes a writer who never let go of it
 * ([Task-633](pa://task/633)).
 *
 * A restore is two walks: link every entry across to the public name, then
 * empty the private one. A hand author holding the folder open from before the
 * detach can create in it between them, and that entry was linked nowhere — so
 * clearing the aside without a proof unlinks the only copy there is.
 *
 * The creation is fired from the `link` the relink walk performs, which is the
 * one place outside this module that lands in that window every time.
 */
import assert from "node:assert/strict";
import {
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";

/** Runs once, right after an entry has been linked to the public name. */
let afterRelink: (() => void) | undefined;
let denyPins = false;
let livePins = 0;
let peakPins = 0;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const flag = process.platform === "darwin" ? 0x8000 : 0o010000000;
      const isPin = typeof args[1] === "number" && (args[1] & flag) !== 0;
      if (isPin && denyPins)
        throw Object.assign(new Error("pin descriptors exhausted"), {
          code: "EMFILE",
        });
      const handle = await actual.open(...args);
      if (isPin) {
        livePins += 1;
        peakPins = Math.max(peakPins, livePins);
        const close = handle.close.bind(handle);
        let counted = true;
        handle.close = async () => {
          try {
            await close();
          } finally {
            if (counted) {
              livePins -= 1;
              counted = false;
            }
          }
        };
      }
      return handle;
    },
    link: async (from: string, to: string) => {
      const linked = await actual.link(from, to);
      const hook = afterRelink;
      afterRelink = undefined;
      hook?.();
      return linked;
    },
  };
});

const { readFile, writeFile, symlink, readlink, lstat, readdir } =
  await import("node:fs/promises");
const {
  removeVerifiedEntryTree,
  entryHandleIdentity,
  withLibraryRoot,
  withEntryChild,
  setRecreateEntrySymlinksForTests,
  unlinkEntryChildIfSame,
} = await import("./entrySource.ts");

let root: string;

beforeEach(async () => {
  setRecreateEntrySymlinksForTests(true);
  denyPins = false;
  livePins = 0;
  peakPins = 0;
  afterRelink = undefined;
  root = mkdtempSync(join(tmpdir(), "skill-restore-test-"));
  await writeFile(join(root, "keep.md"), "committed\n", "utf8");
});

afterEach(() => {
  setRecreateEntrySymlinksForTests(null);
  denyPins = false;
  afterRelink = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe("a restore racing a writer that already holds the folder open", () => {
  test("a rejected tree containing a recreated symlink is restored without stranding its source aside", async () => {
    const folder = mkdtempSync(join(root, "skill-"));
    await writeFile(join(folder, "keep.md"), "committed\n");
    await symlink("keep.md", join(folder, "alias.md"));
    const original = await lstat(join(folder, "alias.md"));
    const name = folder.slice(root.length + 1);
    const outcome = await withLibraryRoot(root, (rootHandle) =>
      withEntryChild(rootHandle, name, async (child) => {
        const identity = await entryHandleIdentity(child.handle);
        return removeVerifiedEntryTree(
          rootHandle,
          name,
          identity,
          async () => ({ holds: false }),
        );
      }),
    );
    assert.equal(outcome, "unexpected-content");
    assert.equal(await readlink(join(folder, "alias.md")), "keep.md");
    assert.notEqual((await lstat(join(folder, "alias.md"))).ino, original.ino);
    assert.ok(
      !(await readdir(root)).some((entry) => entry.startsWith(".pa-removing-")),
    );
  });

  test("restoring a wide tree keeps no per-file descriptors across the pass", async () => {
    setRecreateEntrySymlinksForTests(null);
    const folder = mkdtempSync(join(root, "skill-"));
    for (let index = 0; index < 40; index += 1) {
      await writeFile(join(folder, `file-${index}.md`), "content\n");
      await symlink(`file-${index}.md`, join(folder, `link-${index}.md`));
    }
    const name = folder.slice(root.length + 1);
    const outcome = await withLibraryRoot(root, (parent) =>
      withEntryChild(parent, name, async (child) =>
        removeVerifiedEntryTree(
          parent,
          name,
          await entryHandleIdentity(child.handle),
          async () => ({ holds: false }),
        ),
      ),
    );
    assert.equal(outcome, "unexpected-content");
    assert.equal((await readdir(folder)).length, 80);
    assert.ok(
      peakPins <= (process.platform === "darwin" ? 1 : 0),
      `restore held ${peakPins} file pins concurrently`,
    );
    assert.equal(livePins, 0);
    assert.ok(
      !(await readdir(root)).some((entry) => entry.startsWith(".pa-removing-")),
    );
  });

  test.skipIf(process.platform !== "linux")(
    "Linux restores a mismatched aside even when every pin open fails with EMFILE",
    async () => {
      setRecreateEntrySymlinksForTests(null);
      const folder = mkdtempSync(join(root, "skill-"));
      await writeFile(join(folder, "user.md"), "User content\n");
      const name = folder.slice(root.length + 1);
      const identity = await lstat(join(folder, "user.md"));
      denyPins = true;
      const removed = await withLibraryRoot(root, (parent) =>
        withEntryChild(parent, name, (child) =>
          unlinkEntryChildIfSame(child.handle, "user.md", {
            dev: identity.dev,
            ino: 0,
          }),
        ),
      );
      assert.equal(removed, false);
      assert.equal(
        await readFile(join(folder, "user.md"), "utf8"),
        "User content\n",
      );
      assert.deepEqual(await readdir(folder), ["user.md"]);
    },
  );

  test("a file created after the relink walk is not cleared with the aside", async () => {
    const folder = mkdtempSync(join(root, "skill-"));
    await writeFile(join(folder, "keep.md"), "committed\n", "utf8");
    const name = folder.slice(root.length + 1);
    const held = openSync(folder, constants.O_RDONLY | constants.O_DIRECTORY);
    let created = false;
    try {
      const identity = await withLibraryRoot(root, (rootHandle) =>
        withEntryChild(rootHandle, name, (child) =>
          entryHandleIdentity(child.handle),
        ),
      );
      // The one entry has just been carried to the public name; the walk that
      // empties the aside has not started.
      afterRelink = () => {
        const { dev, ino } = fstatSync(held);
        const anchor =
          process.platform === "darwin"
            ? `/.vol/${dev}/${ino}`
            : `/proc/self/fd/${held}`;
        writeFileSync(`${anchor}/mine.txt`, "user data\n");
        created = true;
      };

      // Refused, so the tree goes back through the restore.
      const outcome = await withLibraryRoot(root, (rootHandle) =>
        removeVerifiedEntryTree(rootHandle, name, identity, async () => ({
          holds: false,
        })),
      );

      assert.ok(created, "the write must land in the restore's own window");
      assert.equal(outcome, "unexpected-content");
      assert.equal(
        await readFile(join(folder, "mine.txt"), "utf8"),
        "user data\n",
        "a file nothing linked across is not the restore's to clear",
      );
      assert.equal(
        await readFile(join(folder, "keep.md"), "utf8"),
        "committed\n",
        "and what was detached is back at the public name",
      );
    } finally {
      closeSync(held);
    }
  });
});
