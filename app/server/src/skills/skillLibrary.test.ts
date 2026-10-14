import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import type { ServerMessage } from "@assistant/shared";
import { publishSkillLibrary, skillKind } from "./skillLibrary.ts";
import {
  libraryBroadcaster,
  libraryListMessage,
  setLibraryBroadcaster,
} from "../library/libraryPublish.ts";
import { LibraryStore } from "../library/libraryStore.ts";

let tempRoot: string;
let libraryRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "skill-library-test-"));
  libraryRoot = join(tempRoot, "skills");
});

afterEach(() => {
  setLibraryBroadcaster({ broadcast: () => {} });
  rmSync(tempRoot, { recursive: true, force: true });
});

async function writeSkill(
  folder: string,
  frontmatter: string,
  body = "Body.\n",
): Promise<void> {
  await mkdir(join(libraryRoot, folder), { recursive: true });
  await writeFile(
    join(libraryRoot, folder, "SKILL.md"),
    `---\n${frontmatter}---\n\n${body}`,
    "utf8",
  );
}

/** Collect what the single topic seam actually delivered. */
function captureBroadcasts(): ServerMessage[] {
  const sent: ServerMessage[] = [];
  setLibraryBroadcaster({ broadcast: (message) => sent.push(message) });
  return sent;
}

function listOf(message: ServerMessage | undefined) {
  assert.ok(message && message.type === "libraryList");
  assert.equal(message.error, undefined);
  assert.ok(message.list);
  return message.list;
}

describe("skills library read model", () => {
  test("publishes valid summaries and diagnostics through one topic message", async () => {
    await writeSkill(
      "release-notes",
      "name: release-notes\ndescription: Draft release notes.\n",
    );
    await writeSkill("broken", "description: No name here.\n");
    const store = new LibraryStore(skillKind, libraryRoot);
    const sent = captureBroadcasts();

    await publishSkillLibrary(store);

    assert.equal(sent.length, 1, "exactly one list message per publish");
    const list = listOf(sent[0]);
    assert.equal(list.libraryPath, libraryRoot);
    assert.deepEqual(list.entries, [
      {
        name: "release-notes",
        description: "Draft release notes.",
        path: "release-notes/SKILL.md",
      },
    ]);
    // A malformed folder stays VISIBLE with its reason instead of vanishing.
    assert.deepEqual(
      list.diagnostics.map((diagnostic) => [
        diagnostic.folder,
        diagnostic.code,
      ]),
      [["broken", "missing-name"]],
    );
  });

  test("bootstraps a missing library instead of failing the read", async () => {
    assert.ok(!existsSync(libraryRoot));
    const store = new LibraryStore(skillKind, libraryRoot);

    const list = listOf(await libraryListMessage("skills", store));

    assert.ok(existsSync(join(libraryRoot, ".git")));
    assert.deepEqual(list.entries, []);
    assert.deepEqual(list.diagnostics, []);
  });

  test("serializes overlapping authoritative publishes", async () => {
    await writeSkill("notes", "name: notes\ndescription: First.\n");
    let releaseFirst!: () => void;
    const firstMayScan = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let readsStarted = 0;
    class DelayedFirstStore extends LibraryStore {
      override async ensureInitialized(): Promise<void> {
        readsStarted += 1;
        if (readsStarted === 1) await firstMayScan;
      }
    }
    const sent = captureBroadcasts();
    setLibraryBroadcaster({
      broadcast: (message) => {
        sent.push(message);
        if (sent.length === 1) {
          writeFileSync(
            join(libraryRoot, "notes", "SKILL.md"),
            "---\nname: notes\ndescription: Second.\n---\n\nBody.\n",
            "utf8",
          );
        }
      },
    });
    const store = new DelayedFirstStore(skillKind, libraryRoot);

    // Two windows may subscribe before the first scan finishes. The second
    // authoritative read must not begin until the first result is published.
    const first = publishSkillLibrary(store);
    const second = publishSkillLibrary(store);
    await Promise.resolve();
    const readsBeforeRelease = readsStarted;
    releaseFirst();
    await Promise.all([first, second]);

    assert.equal(readsBeforeRelease, 1);
    assert.deepEqual(
      sent.map((message) => listOf(message).entries[0]?.description),
      ["First.", "Second."],
    );
  });

  test("rescans the working tree on every publish", async () => {
    await writeSkill("notes", "name: notes\ndescription: First.\n");
    const store = new LibraryStore(skillKind, libraryRoot);
    const sent = captureBroadcasts();
    await publishSkillLibrary(store);

    // Uncommitted edits, additions and removals are authoritative: the second
    // publish must not answer from anything the first one remembered.
    await writeSkill("notes", "name: notes\ndescription: Second.\n");
    await writeSkill("extra", "name: extra\ndescription: Added.\n");
    await publishSkillLibrary(store);
    await rm(join(libraryRoot, "extra"), { recursive: true });
    await publishSkillLibrary(store);

    assert.equal(sent.length, 3);
    assert.deepEqual(
      listOf(sent[0]).entries.map(
        (skill) => `${skill.name}:${skill.description}`,
      ),
      ["notes:First."],
    );
    assert.deepEqual(
      listOf(sent[1]).entries.map(
        (skill) => `${skill.name}:${skill.description}`,
      ),
      ["extra:Added.", "notes:Second."],
    );
    assert.deepEqual(
      listOf(sent[2]).entries.map(
        (skill) => `${skill.name}:${skill.description}`,
      ),
      ["notes:Second."],
    );
  });

  test("answers an unreadable library with an error, never an empty list", async () => {
    // A plain file where the library belongs: bootstrap cannot create it.
    await writeFile(libraryRoot, "not a directory\n", "utf8");
    const store = new LibraryStore(skillKind, libraryRoot);

    const message = await libraryListMessage("skills", store);

    assert.ok(message.type === "libraryList");
    assert.equal(message.list, undefined);
    assert.match(message.error ?? "", /Failed to read the skills library/);
  });

  test("has no broadcaster of its own until the hub installs one", async () => {
    await writeSkill("notes", "name: notes\ndescription: Only.\n");

    // The default seam swallows the message rather than reaching every
    // connection; nothing in the domain may broadcast app-wide.
    await assert.doesNotReject(
      publishSkillLibrary(new LibraryStore(skillKind, libraryRoot)),
    );
    assert.equal(typeof libraryBroadcaster().broadcast, "function");
  });
});
