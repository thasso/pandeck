/**
 * A removal that fails HALFWAY ([Task-633](pa://task/633)).
 *
 * Emptying a tree is many syscalls, and the ones after the first are not
 * guaranteed to happen: a descriptor limit or an I/O error can stop the walk
 * with some children already unlinked. That state is not "the folder was not
 * mine after all" — committed files are missing from the working tree, and Git
 * holds the only intact copy. These pin that it is reported as its own outcome
 * and that a rollback puts the tree back.
 *
 * The failure is injected at `unlink`, which is the only way to reach the
 * middle of the walk from outside.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";

/**
 * Unlinks left to allow before ONE of them fails with EIO. A single transient
 * failure, not a broken filesystem: the point is a walk that stops in the
 * middle, while everything the recovery needs still works.
 */
let unlinksBeforeFailure = Number.POSITIVE_INFINITY;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    unlink: (path: string) => {
      if (unlinksBeforeFailure === 0) {
        unlinksBeforeFailure = Number.POSITIVE_INFINITY;
        return Promise.reject(
          Object.assign(new Error("EIO: i/o error, unlink"), { code: "EIO" }),
        );
      }
      unlinksBeforeFailure -= 1;
      return actual.unlink(path);
    },
  };
});

const { git } = await import("../gitExec.ts");
const { deleteSkill, createSkill, manageSkillFiles } =
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

beforeEach(async () => {
  unlinksBeforeFailure = Number.POSITIVE_INFINITY;
  root = mkdtempSync(join(tmpdir(), "skills-partial-test-"));
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
  await manageSkillFiles(
    {
      name: "release-notes",
      operations: [
        { op: "write", path: "references/tone.md", content: "Be brief.\n" },
        { op: "write", path: "references/style.md", content: "Be clear.\n" },
      ],
    },
    meta,
    library,
  );
});

afterEach(() => {
  unlinksBeforeFailure = Number.POSITIVE_INFINITY;
  setSkillLibraryBroadcaster({ broadcast: () => undefined });
  rmSync(root, { recursive: true, force: true });
});

describe("a delete that fails once it has already removed something", () => {
  test("is reported as a partial removal and put back from HEAD", async () => {
    // One child goes, the next cannot. Swallowing that as "not ours" would tell
    // the caller the folder was untouched while its committed files were gone.
    unlinksBeforeFailure = 1;

    const error = await deleteSkill(
      { name: "release-notes" },
      meta,
      library,
    ).then(
      () => undefined,
      (error: Error) => error,
    );

    assert.ok(error, "the delete must fail");
    assert.match(error.message, /partly removed|could not be undone/);
    // Everything the skill had is back, because HEAD still had it.
    assert.equal(
      await readFile(join(root, "release-notes", "SKILL.md"), "utf8"),
      (await git(["show", "HEAD:release-notes/SKILL.md"], root)).stdout,
    );
    assert.equal(
      await readFile(
        join(root, "release-notes", "references", "tone.md"),
        "utf8",
      ),
      "Be brief.\n",
    );
    assert.equal(
      await readFile(
        join(root, "release-notes", "references", "style.md"),
        "utf8",
      ),
      "Be clear.\n",
    );
    assert.equal(
      (await git(["status", "--porcelain"], root)).stdout.trim(),
      "",
      "a partial removal must leave the repository clean again",
    );
    assert.ok(!existsSync(join(root, ".pa-skill-removing")));
  });
});
