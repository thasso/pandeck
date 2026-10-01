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

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async (from: string, to: string) => {
      const linked = await actual.link(from, to);
      const hook = afterRelink;
      afterRelink = undefined;
      hook?.();
      return linked;
    },
  };
});

const { readFile, writeFile } = await import("node:fs/promises");
const {
  removeVerifiedSkillTree,
  skillHandleIdentity,
  withLibraryRoot,
  withSkillChild,
} = await import("./skillSource.ts");

let root: string;

beforeEach(async () => {
  afterRelink = undefined;
  root = mkdtempSync(join(tmpdir(), "skill-restore-test-"));
  await writeFile(join(root, "keep.md"), "committed\n", "utf8");
});

afterEach(() => {
  afterRelink = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe("a restore racing a writer that already holds the folder open", () => {
  test("a file created after the relink walk is not cleared with the aside", async () => {
    const folder = mkdtempSync(join(root, "skill-"));
    await writeFile(join(folder, "keep.md"), "committed\n", "utf8");
    const name = folder.slice(root.length + 1);
    const held = openSync(folder, constants.O_RDONLY | constants.O_DIRECTORY);
    let created = false;
    try {
      const identity = await withLibraryRoot(root, (rootHandle) =>
        withSkillChild(rootHandle, name, (child) =>
          skillHandleIdentity(child.handle),
        ),
      );
      // The one entry has just been carried to the public name; the walk that
      // empties the aside has not started.
      afterRelink = () => {
        writeFileSync(`/proc/self/fd/${held}/mine.txt`, "user data\n");
        created = true;
      };

      // Refused, so the tree goes back through the restore.
      const outcome = await withLibraryRoot(root, (rootHandle) =>
        removeVerifiedSkillTree(rootHandle, name, identity, async () => ({
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
