import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  mkdir,
  readdir,
  readlink,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import type { ServerMessage, SkillFileTreeEntry } from "@assistant/shared";
import { git, gitOptional } from "../gitExec.ts";
import {
  createSkill,
  deleteSkill,
  editSkillSource,
  manageSkillFiles,
  MAX_SKILL_IMPORT_BYTES,
  MAX_SKILL_TEXT_FILE_BYTES,
  readSkillLibraryOverview,
  readSkillSource,
  renameSkill,
  resolveSkillSource,
  type SkillFileOperation,
} from "./skillAuthoring.ts";
import { setSkillLibraryBroadcaster } from "./skillLibraryEvents.ts";
import { scanSkillLibrary } from "./skillLibraryScanner.ts";
import {
  SkillLibraryStore,
  type SkillMutationContext,
} from "./skillLibraryStore.ts";

let root: string;
let library: SkillLibraryStore;
let broadcasts: ServerMessage[];

const meta = {
  actor: { id: "pi:workshop:sess-1", name: "Workshop test" },
  reason: "Add a skill",
  sessionId: "sess-1",
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "skills-authoring-test-"));
  library = new SkillLibraryStore(root);
  await library.ensureInitialized();
  broadcasts = [];
  setSkillLibraryBroadcaster({
    broadcast: (message) => broadcasts.push(message),
  });
});

afterEach(() => {
  setSkillLibraryBroadcaster({ broadcast: () => undefined });
  rmSync(root, { recursive: true, force: true });
});

async function head(): Promise<string> {
  const result = await gitOptional(["rev-parse", "HEAD"], root);
  return result.code === 0 ? result.stdout.trim() : "";
}

async function porcelain(): Promise<string> {
  return (
    await git(["status", "--porcelain=v1", "--untracked-files=all"], root)
  ).stdout.trim();
}

async function commitCount(): Promise<number> {
  const result = await gitOptional(["rev-list", "--count", "HEAD"], root);
  return result.code === 0 ? Number(result.stdout.trim()) : 0;
}

/**
 * One import operation over bytes held in the test, in the shape the tool
 * produces: a size the plan can check, and a bounded read it only reaches once
 * the budgets allow it.
 */
function importing(
  path: string,
  bytes: Uint8Array,
  attachmentId: string,
): SkillFileOperation {
  return {
    op: "import",
    path,
    size: bytes.byteLength,
    read: (limit) => Promise.resolve(bytes.subarray(0, limit + 1)),
    attachmentId,
  };
}

async function seedSkill(name = "release-notes"): Promise<void> {
  await createSkill(
    {
      name,
      description: `How to write ${name}`,
      body: "## Steps\n\nWrite them down.",
    },
    { ...meta, reason: `Add ${name}` },
    library,
  );
}

function treePaths(entries: SkillFileTreeEntry[]): string[] {
  return entries.flatMap((entry) => [
    entry.path,
    ...treePaths(entry.children ?? []),
  ]);
}

/** State a failed mutation must leave exactly as it found it. */
async function snapshot(): Promise<string> {
  return `${await head()}|${await porcelain()}|${
    (await git(["diff", "--cached", "--name-only"], root)).stdout
  }`;
}

async function assertUnchanged(
  before: string,
  operation: () => Promise<unknown>,
): Promise<Error> {
  const error = await operation().then(
    () => {
      throw new Error("expected the mutation to fail");
    },
    (caught: Error) => caught,
  );
  assert.equal(await snapshot(), before, "the library must be untouched");
  return error;
}

describe("skill authoring: create", () => {
  test("creates the first commit in a fresh library and scans as valid", async () => {
    const outcome = await createSkill(
      {
        name: "release-notes",
        description: "How to write release notes",
        body: "## Steps\n\nWrite them down.",
      },
      { ...meta, taskId: "633" },
      library,
    );

    assert.equal(outcome.skill?.name, "release-notes");
    assert.equal(outcome.skill?.path, "release-notes/SKILL.md");
    assert.deepEqual(outcome.commit.changedPaths, ["release-notes/SKILL.md"]);
    assert.equal(outcome.commit.commit.length, 40);
    assert.equal(await commitCount(), 1);
    assert.equal(await porcelain(), "");

    const scan = await scanSkillLibrary(root);
    assert.deepEqual(scan.diagnostics, []);
    assert.deepEqual(scan.skills, [
      {
        name: "release-notes",
        description: "How to write release notes",
        path: "release-notes/SKILL.md",
      },
    ]);

    const source = await readFile(join(root, "release-notes/SKILL.md"), "utf8");
    assert.match(source, /^---\nname: release-notes\n/);
    assert.match(source, /description: "How to write release notes"/);
  });

  test("preserves indentation on the first non-blank body line", async () => {
    await createSkill(
      {
        name: "shell-example",
        description: "An indented Markdown example",
        body: "\n   \n    echo hi\n",
      },
      meta,
      library,
    );

    const source = await readFile(join(root, "shell-example/SKILL.md"), "utf8");
    assert.ok(source.endsWith("---\n\n    echo hi\n"));
  });

  test("records actor, session, task and path provenance on the commit", async () => {
    await createSkill(
      { name: "release-notes", description: "Notes", body: "Body" },
      { ...meta, taskId: "633" },
      library,
    );

    const message = (await git(["log", "-1", "--format=%B%n%an%n%ae"], root))
      .stdout;
    assert.match(message, /^Add a skill\n/);
    assert.match(message, /Skill-Actor: pi:workshop:sess-1 \(Workshop test\)/);
    assert.match(message, /Skill-Session: sess-1/);
    assert.match(message, /Skill-Task: 633/);
    assert.match(message, /Skill-Names: release-notes/);
    assert.match(message, /Skill-Paths: \["release-notes\/SKILL\.md"\]/);
    assert.match(message, /Workshop test\npi-workshop-sess-1@skills\.local/);
  });

  test("publishes exactly one authoritative list after a successful mutation", async () => {
    await seedSkill();

    assert.equal(broadcasts.length, 1);
    const [message] = broadcasts;
    assert.equal(message?.type, "skillList");
    assert.equal(
      message?.type === "skillList" ? message.list?.skills[0]?.name : undefined,
      "release-notes",
    );
  });

  test("refuses unsafe names, invalid descriptions and duplicate declared names", async () => {
    const before = await snapshot();
    for (const name of ["Release Notes", "-bad", "a".repeat(65), "bad/name"]) {
      await assertUnchanged(before, () =>
        createSkill(
          { name, description: "Valid", body: "Body" },
          meta,
          library,
        ),
      );
    }
    for (const description of ["", "   ", "d".repeat(1025)]) {
      await assertUnchanged(before, () =>
        createSkill(
          { name: "release-notes", description, body: "Body" },
          meta,
          library,
        ),
      );
    }
    assert.equal(await commitCount(), 0);

    await seedSkill();
    const seeded = await snapshot();
    const duplicate = await assertUnchanged(seeded, () =>
      createSkill(
        { name: "release-notes", description: "Second", body: "Body" },
        meta,
        library,
      ),
    );
    assert.match(duplicate.message, /already declares the name/);
    assert.equal(broadcasts.length, 1);
  });

  test("preserves a pre-existing empty folder when create refuses its name", async () => {
    const folder = join(root, "release-notes");
    await mkdir(folder);
    const before = await snapshot();

    const error = await assertUnchanged(before, () =>
      createSkill(
        { name: "release-notes", description: "Notes", body: "Body" },
        meta,
        library,
      ),
    );

    assert.match(error.message, /already contains a top-level entry/);
    assert.ok(existsSync(folder));
  });

  test("refuses a name whose folder already exists on disk", async () => {
    await mkdir(join(root, "release-notes"), { recursive: true });
    await writeFile(join(root, "release-notes/README.md"), "hand written\n");
    await git(["add", "-A"], root);
    await git(
      [
        "-c",
        "user.name=User",
        "-c",
        "user.email=user@example.com",
        "commit",
        "-m",
        "user content",
      ],
      root,
    );
    const before = await snapshot();

    const error = await assertUnchanged(before, () =>
      createSkill(
        { name: "release-notes", description: "Notes", body: "Body" },
        meta,
        library,
      ),
    );
    assert.match(error.message, /already contains a top-level entry/);
  });
});

describe("skill authoring: clean-repository requirement", () => {
  test("any staged, tracked or untracked change blocks every mutation", async () => {
    await seedSkill();
    const cases: Array<[string, () => Promise<unknown>]> = [
      [
        "untracked",
        async () => writeFile(join(root, "scratch.md"), "in progress\n"),
      ],
      [
        "tracked edit",
        async () => writeFile(join(root, "release-notes/SKILL.md"), "broken\n"),
      ],
      [
        "staged",
        async () => {
          await writeFile(join(root, "staged.md"), "staged\n");
          await git(["add", "staged.md"], root);
        },
      ],
    ];

    for (const [label, dirty] of cases) {
      await dirty();
      const before = await snapshot();
      const error = await assertUnchanged(before, () =>
        createSkill(
          { name: "another-skill", description: "Another", body: "Body" },
          meta,
          library,
        ),
      );
      assert.match(
        error.message,
        /uncommitted change/,
        `${label} must be refused with actionable status`,
      );

      // Reads stay available while the user's own work is in the tree.
      const overview = await readSkillLibraryOverview(library);
      assert.equal(overview.repository.clean, false);
      assert.ok(overview.repository.changeCount >= 1);
      assert.ok((await library.history({ limit: 5 })).entries.length >= 1);

      await git(["reset", "--hard", "HEAD"], root);
      await git(["clean", "-fd"], root);
    }
    assert.equal(broadcasts.length, 1);
  });
});

describe("skill authoring: edit", () => {
  test("applies exact replacements and revalidates the whole manifest", async () => {
    await seedSkill();
    const outcome = await editSkillSource(
      {
        name: "release-notes",
        edits: [
          { oldText: "Write them down.", newText: "Write them clearly." },
        ],
      },
      { ...meta, reason: "Clarify the steps" },
      library,
    );

    assert.equal(outcome.replacements, 1);
    assert.equal(await commitCount(), 2);
    assert.deepEqual(outcome.commit.changedPaths, ["release-notes/SKILL.md"]);
    const read = await readSkillSource("release-notes", library);
    assert.match(read!.source, /Write them clearly\./);
    assert.match(read!.source, /^---\nname: release-notes/);
  });

  test("refuses missing, ambiguous, no-op edits and declared-name changes", async () => {
    await seedSkill();
    const before = await snapshot();

    const missing = await assertUnchanged(before, () =>
      editSkillSource(
        { name: "release-notes", edits: [{ oldText: "absent", newText: "x" }] },
        meta,
        library,
      ),
    );
    assert.match(missing.message, /oldText not found/);

    const ambiguous = await assertUnchanged(before, () =>
      editSkillSource(
        { name: "release-notes", edits: [{ oldText: "e", newText: "x" }] },
        meta,
        library,
      ),
    );
    assert.match(ambiguous.message, /not unique/);

    const noop = await assertUnchanged(before, () =>
      editSkillSource(
        {
          name: "release-notes",
          edits: [{ oldText: "## Steps", newText: "## Steps" }],
        },
        meta,
        library,
      ),
    );
    assert.match(noop.message, /unchanged/);

    const renamed = await assertUnchanged(before, () =>
      editSkillSource(
        {
          name: "release-notes",
          edits: [
            { oldText: "name: release-notes", newText: "name: other-name" },
          ],
        },
        meta,
        library,
      ),
    );
    assert.match(renamed.message, /may not change the declared name/);

    const broken = await assertUnchanged(before, () =>
      editSkillSource(
        {
          name: "release-notes",
          edits: [{ oldText: "description:", newText: "desc:" }],
        },
        meta,
        library,
      ),
    );
    assert.match(broken.message, /description/i);
    assert.equal(await commitCount(), 1);
  });

  test("refuses to change a skill the scanner does not report as valid", async () => {
    await seedSkill();
    // A folder the scanner still recognizes by name, but cannot serve.
    await writeFile(
      join(root, "release-notes/SKILL.md"),
      '---\nname: release-notes\ndescription: ""\n---\n\nBody\n',
    );
    await git(["add", "-A"], root);
    await git(
      [
        "-c",
        "user.name=User",
        "-c",
        "user.email=user@example.com",
        "commit",
        "-m",
        "break it",
      ],
      root,
    );
    const before = await snapshot();

    const error = await assertUnchanged(before, () =>
      editSkillSource(
        { name: "release-notes", edits: [{ oldText: "no", newText: "yes" }] },
        meta,
        library,
      ),
    );
    assert.match(error.message, /not currently valid/);
  });
});

describe("skill authoring: supporting files", () => {
  test("writes, imports, deletes and mixes operations in one commit", async () => {
    await seedSkill();
    const write = await manageSkillFiles(
      {
        name: "release-notes",
        operations: [
          { op: "write", path: "references/tone.md", content: "Be brief.\n" },
          importing("assets/logo.bin", new Uint8Array([0, 1, 2, 3]), "att-1"),
        ],
      },
      { ...meta, reason: "Add references" },
      library,
    );

    assert.equal(await commitCount(), 2);
    assert.deepEqual(write.commit.changedPaths, [
      "release-notes/assets/logo.bin",
      "release-notes/references/tone.md",
    ]);
    assert.equal(
      await readFile(join(root, "release-notes/references/tone.md"), "utf8"),
      "Be brief.\n",
    );

    const mixed = await manageSkillFiles(
      {
        name: "release-notes",
        operations: [
          { op: "delete", path: "assets/logo.bin" },
          {
            op: "write",
            path: "references/tone.md",
            content: "Be brief and kind.\n",
          },
        ],
      },
      { ...meta, reason: "Replace the asset with guidance" },
      library,
    );

    assert.equal(await commitCount(), 3);
    assert.deepEqual(mixed.commit.changedPaths, [
      "release-notes/assets/logo.bin",
      "release-notes/references/tone.md",
    ]);
    assert.ok(!existsSync(join(root, "release-notes/assets/logo.bin")));
    const scan = await scanSkillLibrary(root);
    assert.equal(scan.skills.length, 1);
    assert.deepEqual(scan.diagnostics, []);
    assert.equal(await porcelain(), "");
  });

  test("refuses unsafe paths, SKILL.md, oversized content and missing targets", async () => {
    await seedSkill();
    const before = await snapshot();
    const unsafe: SkillFileOperation[][] = [
      [{ op: "write", path: "/etc/passwd", content: "x" }],
      [{ op: "write", path: "../escape.md", content: "x" }],
      [{ op: "write", path: "nested/../../escape.md", content: "x" }],
      [{ op: "write", path: "windows\\path.md", content: "x" }],
      [{ op: "write", path: "nul\0.md", content: "x" }],
      [{ op: "write", path: ".git/config", content: "x" }],
      [{ op: "write", path: "nested/.GIT/config", content: "x" }],
      [{ op: "write", path: "SKILL.md", content: "x" }],
      [{ op: "write", path: "", content: "x" }],
      [{ op: "delete", path: "references/missing.md" }],
      [
        { op: "write", path: "a.md", content: "x" },
        { op: "write", path: "a.md", content: "y" },
      ],
      [
        {
          op: "write",
          path: "big.md",
          content: "x".repeat(MAX_SKILL_TEXT_FILE_BYTES + 1),
        },
      ],
      [
        importing(
          "big.bin",
          new Uint8Array(MAX_SKILL_IMPORT_BYTES + 1),
          "att-big",
        ),
      ],
      [],
    ];

    for (const operations of unsafe) {
      await assertUnchanged(before, () =>
        manageSkillFiles({ name: "release-notes", operations }, meta, library),
      );
    }
    assert.equal(await commitCount(), 1);
    assert.equal(broadcasts.length, 1);
  });

  test("refuses to write through a supporting symlink", async () => {
    await seedSkill();
    const outside = join(root, "..", "outside.md");
    await writeFile(outside, "outside\n");
    await mkdir(join(root, "release-notes/references"), { recursive: true });
    await symlink(outside, join(root, "release-notes/references/link.md"));
    await git(["add", "-A"], root);
    await git(
      [
        "-c",
        "user.name=User",
        "-c",
        "user.email=user@example.com",
        "commit",
        "-m",
        "user link",
      ],
      root,
    );
    const before = await snapshot();

    await assertUnchanged(before, () =>
      manageSkillFiles(
        {
          name: "release-notes",
          operations: [
            { op: "write", path: "references/link.md", content: "changed\n" },
          ],
        },
        meta,
        library,
      ),
    );
    await assertUnchanged(before, () =>
      manageSkillFiles(
        {
          name: "release-notes",
          operations: [{ op: "delete", path: "references/link.md" }],
        },
        meta,
        library,
      ),
    );
    assert.equal(await readFile(outside, "utf8"), "outside\n");
    await rm(outside, { force: true });
  });

  test("rolls a partially applied batch back completely", async () => {
    await seedSkill();
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
    const before = await snapshot();

    await assertUnchanged(before, () =>
      manageSkillFiles(
        {
          name: "release-notes",
          operations: [
            { op: "write", path: "references/tone.md", content: "Changed.\n" },
            { op: "delete", path: "references/absent.md" },
          ],
        },
        meta,
        library,
      ),
    );
    assert.equal(
      await readFile(join(root, "release-notes/references/tone.md"), "utf8"),
      "Be brief.\n",
    );
  });
});

describe("skill authoring: editing supporting files", () => {
  /** Seed one skill with `references/tone.md` already committed. */
  async function seedReference(content = "Be brief.\nUse Sea.\n") {
    await seedSkill();
    await manageSkillFiles(
      {
        name: "release-notes",
        operations: [{ op: "write", path: "references/tone.md", content }],
      },
      { ...meta, reason: "Add a reference" },
      library,
    );
  }

  test("rewrites an existing file in place and reports its replacements", async () => {
    await seedReference();

    const edited = await manageSkillFiles(
      {
        name: "release-notes",
        operations: [
          {
            op: "edit",
            path: "references/tone.md",
            edits: [
              { oldText: "Be brief.", newText: "Be brief and kind." },
              { oldText: "Sea", newText: "Night" },
            ],
          },
        ],
      },
      { ...meta, reason: "Correct the reference" },
      library,
    );

    assert.deepEqual(edited.applied, [
      { op: "edit", path: "references/tone.md", replacements: 2 },
    ]);
    assert.deepEqual(edited.commit.changedPaths, [
      "release-notes/references/tone.md",
    ]);
    assert.equal(
      await readFile(join(root, "release-notes/references/tone.md"), "utf8"),
      "Be brief and kind.\nUse Night.\n",
    );
    assert.equal(await commitCount(), 3);
    assert.equal(await porcelain(), "");
  });

  test("shares one commit with the batch's other operations", async () => {
    await seedReference();

    const batch = await manageSkillFiles(
      {
        name: "release-notes",
        operations: [
          {
            op: "edit",
            path: "references/tone.md",
            edits: [{ oldText: "Sea", newText: "Night" }],
          },
          { op: "write", path: "references/colors.md", content: "Night.\n" },
        ],
      },
      { ...meta, reason: "Split the color guidance out" },
      library,
    );

    assert.deepEqual(batch.commit.changedPaths, [
      "release-notes/references/colors.md",
      "release-notes/references/tone.md",
    ]);
    assert.equal(await commitCount(), 3);
  });

  test("changes only what a replacement matched, byte-order mark included", async () => {
    // The default UTF-8 decoder EATS a leading BOM, and the edited string is
    // re-encoded whole: a file would lose three bytes no edit addressed.
    await seedSkill();
    await manageSkillFiles(
      {
        name: "release-notes",
        operations: [
          {
            op: "write",
            path: "references/tone.md",
            content: "\ufeff# Tone\n\nUse Sea.\n",
          },
        ],
      },
      { ...meta, reason: "Add a reference" },
      library,
    );

    await manageSkillFiles(
      {
        name: "release-notes",
        operations: [
          {
            op: "edit",
            path: "references/tone.md",
            edits: [{ oldText: "Sea", newText: "Night" }],
          },
        ],
      },
      { ...meta, reason: "Correct the color" },
      library,
    );

    const written = await readFile(
      join(root, "release-notes/references/tone.md"),
    );
    assert.deepEqual(
      [...written.subarray(0, 3)],
      [0xef, 0xbb, 0xbf],
      "the byte-order mark survived an edit that never matched it",
    );
    assert.equal(written.toString("utf8"), "\ufeff# Tone\n\nUse Night.\n");
  });

  test("an edit is undone completely when a later operation fails", async () => {
    await seedReference();
    const before = await snapshot();

    await assertUnchanged(before, () =>
      manageSkillFiles(
        {
          name: "release-notes",
          operations: [
            {
              op: "edit",
              path: "references/tone.md",
              edits: [{ oldText: "Sea", newText: "Night" }],
            },
            { op: "delete", path: "references/absent.md" },
          ],
        },
        meta,
        library,
      ),
    );

    assert.equal(
      await readFile(join(root, "release-notes/references/tone.md"), "utf8"),
      "Be brief.\nUse Sea.\n",
    );
  });

  test("never creates, and never edits what it may not rewrite", async () => {
    await seedReference();
    await mkdir(join(root, "release-notes/scripts"), { recursive: true });
    await writeFile(
      join(root, "release-notes/assets.bin"),
      Buffer.from([0xff, 0xfe, 0x00, 0x41]),
    );
    await writeFile(
      join(root, "release-notes/big.md"),
      "x".repeat(MAX_SKILL_TEXT_FILE_BYTES + 1),
    );
    const outside = join(root, "..", "outside-edit.md");
    await writeFile(outside, "outside\n");
    await symlink(outside, join(root, "release-notes/link.md"));
    await git(["add", "-A"], root);
    await git(
      [
        "-c",
        "user.name=User",
        "-c",
        "user.email=user@example.com",
        "commit",
        "-m",
        "user content",
      ],
      root,
    );
    const before = await snapshot();

    const refused: [SkillFileOperation, RegExp][] = [
      // An edit addresses content that already exists; it is not a create.
      [
        {
          op: "edit",
          path: "references/absent.md",
          edits: [{ oldText: "a", newText: "b" }],
        },
        /Cannot edit/,
      ],
      [
        {
          op: "edit",
          path: "scripts",
          edits: [{ oldText: "a", newText: "b" }],
        },
        /Cannot edit/,
      ],
      [
        {
          op: "edit",
          path: "link.md",
          edits: [{ oldText: "a", newText: "b" }],
        },
        /Cannot edit/,
      ],
      [
        {
          op: "edit",
          path: "SKILL.md",
          edits: [{ oldText: "Steps", newText: "Stages" }],
        },
        /skill manifest/,
      ],
      [
        {
          op: "edit",
          path: "assets.bin",
          edits: [{ oldText: "A", newText: "B" }],
        },
        /not valid UTF-8/,
      ],
      [
        { op: "edit", path: "big.md", edits: [{ oldText: "x", newText: "y" }] },
        /above the .* limit for an edit/,
      ],
      [
        {
          op: "edit",
          path: "references/tone.md",
          edits: [{ oldText: "Missing.", newText: "b" }],
        },
        /oldText not found/,
      ],
      [
        {
          op: "edit",
          path: "references/tone.md",
          edits: [{ oldText: "e", newText: "E" }],
        },
        /not unique/,
      ],
      [
        {
          op: "edit",
          path: "references/tone.md",
          edits: [{ oldText: "Sea", newText: "Sea" }],
        },
        /leave .* unchanged/,
      ],
      [
        { op: "edit", path: "references/tone.md", edits: [] },
        /at least one edit/,
      ],
    ];

    for (const [operation, expected] of refused) {
      const error = await assertUnchanged(before, () =>
        manageSkillFiles(
          { name: "release-notes", operations: [operation] },
          meta,
          library,
        ),
      );
      assert.match(error.message, expected);
    }
    assert.equal(await readFile(outside, "utf8"), "outside\n");
    await rm(outside, { force: true });
  });
});

describe("skill authoring: symlinked sources", () => {
  test("a source folder swapped for a symlink can no longer be mutated", async () => {
    await seedSkill();
    const elsewhere = join(root, "..", "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(
      join(elsewhere, "SKILL.md"),
      '---\nname: release-notes\ndescription: "Outside"\n---\n\nOutside\n',
    );
    await rm(join(root, "release-notes"), { recursive: true, force: true });
    await symlink(elsewhere, join(root, "release-notes"));
    await git(["add", "-A"], root);
    await git(
      [
        "-c",
        "user.name=User",
        "-c",
        "user.email=user@example.com",
        "commit",
        "-m",
        "link a skill in",
      ],
      root,
    );
    const before = await snapshot();

    for (const mutate of [
      () =>
        editSkillSource(
          {
            name: "release-notes",
            edits: [{ oldText: "Outside", newText: "Inside" }],
          },
          meta,
          library,
        ),
      () => deleteSkill({ name: "release-notes" }, meta, library),
      () =>
        renameSkill(
          { name: "release-notes", newName: "linked-notes" },
          meta,
          library,
        ),
    ]) {
      await assertUnchanged(before, mutate);
    }
    assert.equal(
      await readFile(join(elsewhere, "SKILL.md"), "utf8"),
      '---\nname: release-notes\ndescription: "Outside"\n---\n\nOutside\n',
    );
    await rm(elsewhere, { recursive: true, force: true });
  });
});

describe("skill authoring: rename and delete", () => {
  test("rename moves the folder and the declared name in one commit", async () => {
    await seedSkill();
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
      { ...meta, reason: "Rename to changelog-notes" },
      library,
    );

    assert.equal(outcome.previousName, "release-notes");
    assert.equal(outcome.skill?.name, "changelog-notes");
    assert.equal(await commitCount(), 3);
    assert.ok(!existsSync(join(root, "release-notes")));
    assert.equal(
      await readFile(join(root, "changelog-notes/references/tone.md"), "utf8"),
      "Be brief.\n",
    );
    const source = await readFile(
      join(root, "changelog-notes/SKILL.md"),
      "utf8",
    );
    assert.match(source, /name: changelog-notes/);
    assert.equal(await porcelain(), "");
  });

  test("rename refuses a declared-name or folder collision", async () => {
    await seedSkill();
    await seedSkill("changelog-notes");
    const before = await snapshot();

    const declared = await assertUnchanged(before, () =>
      renameSkill(
        { name: "release-notes", newName: "changelog-notes" },
        meta,
        library,
      ),
    );
    assert.match(declared.message, /already declares the name/);

    await mkdir(join(root, "occupied"), { recursive: true });
    await writeFile(join(root, "occupied/notes.md"), "hand written\n");
    await git(["add", "-A"], root);
    await git(
      [
        "-c",
        "user.name=User",
        "-c",
        "user.email=user@example.com",
        "commit",
        "-m",
        "user folder",
      ],
      root,
    );
    const withFolder = await snapshot();
    const folder = await assertUnchanged(withFolder, () =>
      renameSkill(
        { name: "release-notes", newName: "occupied" },
        meta,
        library,
      ),
    );
    assert.match(folder.message, /already contains a top-level entry/);
  });

  test("delete removes the whole folder and stays visible in history", async () => {
    await seedSkill();
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

    const outcome = await deleteSkill(
      { name: "release-notes" },
      { ...meta, reason: "Remove the release-notes skill" },
      library,
    );

    assert.equal(outcome.skill, undefined);
    assert.equal(outcome.folder, "release-notes");
    assert.deepEqual(outcome.commit.changedPaths, [
      "release-notes/SKILL.md",
      "release-notes/references/tone.md",
    ]);
    assert.ok(!existsSync(join(root, "release-notes")));
    assert.deepEqual((await scanSkillLibrary(root)).skills, []);

    const { entries: history } = await library.history({ limit: 10 });
    assert.equal(history.length, 3);
    assert.equal(history[0]?.subject, "Remove the release-notes skill");
    const { entries: scoped } = await library.history({
      path: "release-notes",
      limit: 10,
    });
    assert.equal(scoped.length, 3);
    const diff = await library.diff({
      from: `${history[0]?.commit}~1`,
      to: history[0]?.commit ?? "HEAD",
      maxChars: 10_000,
    });
    assert.match(diff.patch, /-name: release-notes/);
    assert.equal(diff.truncated, false);
  });
});

describe("skill authoring: concurrency and diagnostics", () => {
  test("concurrent mutations serialize into separate commits", async () => {
    await seedSkill();
    const results = await Promise.allSettled([
      createSkill(
        { name: "skill-one", description: "One", body: "Body one" },
        { ...meta, reason: "Add skill-one" },
        library,
      ),
      createSkill(
        { name: "skill-two", description: "Two", body: "Body two" },
        { ...meta, reason: "Add skill-two" },
        library,
      ),
    ]);

    assert.deepEqual(
      results.map((result) => result.status),
      ["fulfilled", "fulfilled"],
    );
    assert.equal(await commitCount(), 3);
    assert.equal(await porcelain(), "");
    assert.equal((await scanSkillLibrary(root)).skills.length, 3);
    assert.equal(broadcasts.length, 3);
  });

  test("a pre-existing unrelated diagnostic neither blocks nor gets committed", async () => {
    await mkdir(join(root, "broken"), { recursive: true });
    await writeFile(join(root, "broken/SKILL.md"), "not a manifest\n");
    await git(["add", "-A"], root);
    await git(
      [
        "-c",
        "user.name=User",
        "-c",
        "user.email=user@example.com",
        "commit",
        "-m",
        "user content",
      ],
      root,
    );

    const outcome = await createSkill(
      { name: "release-notes", description: "Notes", body: "Body" },
      meta,
      library,
    );

    assert.deepEqual(outcome.commit.changedPaths, ["release-notes/SKILL.md"]);
    const scan = await scanSkillLibrary(root);
    assert.equal(scan.skills.length, 1);
    assert.equal(scan.diagnostics.length, 1);
    assert.equal(scan.diagnostics[0]?.folder, "broken");
  });
});

describe("skill authoring: bounded reads", () => {
  test("skill_get-style read returns full source and a bounded tree", async () => {
    await seedSkill();
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

    const read = await readSkillSource("release-notes", library);
    assert.ok(read);
    assert.match(read.source, /^---\nname: release-notes\n/);
    assert.equal(read.truncated, false);
    assert.deepEqual(treePaths(read.files.entries).sort(), [
      "SKILL.md",
      "references",
      "references/tone.md",
    ]);
    assert.equal(await readSkillSource("../escape", library), null);
    assert.equal(await readSkillSource("absent-skill", library), null);
  });

  test("refuses a source whose file identity changed after the scan", async () => {
    await seedSkill();
    const scan = await scanSkillLibrary(root);
    const path = join(root, "release-notes/SKILL.md");
    await rm(path);
    await writeFile(
      path,
      "---\nname: another-skill\ndescription: Wrong source\n---\n\nWrong.\n",
    );

    await assert.rejects(
      resolveSkillSource(root, scan, "release-notes"),
      /changed (?:identity|frontmatter) since it was scanned/,
    );
  });

  test("the overview carries repository cleanliness and HEAD", async () => {
    await seedSkill();
    const overview = await readSkillLibraryOverview(library);

    assert.equal(overview.libraryPath, root);
    assert.equal(overview.repository.clean, true);
    assert.equal(overview.repository.branch, "main");
    assert.equal(overview.repository.head?.subject, "Add release-notes");
    assert.equal(overview.skills.length, 1);
  });
});

/**
 * A store that lets a test act on the working tree at a known point INSIDE a
 * mutation — the moment the mutation registers its paths, which is after it has
 * scanned and resolved its target and before it writes anything. That is
 * exactly where a hand edit racing an agent lands, and it is otherwise
 * unreachable from outside the repository lock.
 */
class RacingSkillLibraryStore extends SkillLibraryStore {
  constructor(
    root: string,
    private readonly race: () => void,
  ) {
    super(root);
  }

  override async commitMutation<T>(
    meta: Parameters<SkillLibraryStore["commitMutation"]>[0],
    run: (context: SkillMutationContext) => Promise<T>,
    options: Parameters<SkillLibraryStore["commitMutation"]>[2] = {},
  ) {
    let raced = false;
    return super.commitMutation(
      meta,
      (ctx) =>
        run({
          ...ctx,
          touch: (...paths: string[]) => {
            ctx.touch(...paths);
            if (!raced) {
              raced = true;
              this.race();
            }
          },
        }),
      options,
    );
  }
}

describe("skill authoring: destruction is bound to the scanned source", () => {
  test("a folder replaced after the scan is refused, not deleted", async () => {
    await seedSkill();
    const swap = (): void => {
      // The user moves their skill away and puts a different folder in its
      // place while the agent's delete is between resolving and removing.
      renameSync(join(root, "release-notes"), join(root, "moved-away"));
      mkdirSync(join(root, "release-notes"));
      writeFileSync(join(root, "release-notes", "keepme.txt"), "user data\n");
    };
    const racing = new RacingSkillLibraryStore(root, swap);

    const error = await deleteSkill(
      { name: "release-notes" },
      { ...meta, reason: "Remove it" },
      racing,
    ).then(
      () => {
        throw new Error("expected the delete to be refused");
      },
      (caught: Error) => caught,
    );

    // The delete identifies the folder after moving it out of reach, so the
    // refusal names that step; either way the raced-in folder is not deleted.
    assert.match(
      error.message,
      /no longer the folder that was scanned|was replaced while it was being deleted/,
    );
    assert.equal(
      await readFile(join(root, "release-notes", "keepme.txt"), "utf8"),
      "user data\n",
      "the folder that raced in must survive untouched",
    );
    assert.ok(existsSync(join(root, "moved-away", "SKILL.md")));
  });

  test("a folder replaced after the scan is refused by every other mutation", async () => {
    for (const mutate of [
      (store: SkillLibraryStore) =>
        editSkillSource(
          {
            name: "release-notes",
            edits: [{ oldText: "Write them down.", newText: "Changed." }],
          },
          meta,
          store,
        ),
      (store: SkillLibraryStore) =>
        manageSkillFiles(
          {
            name: "release-notes",
            operations: [{ op: "write", path: "a.md", content: "a" }],
          },
          meta,
          store,
        ),
      (store: SkillLibraryStore) =>
        renameSkill(
          { name: "release-notes", newName: "changelog-notes" },
          meta,
          store,
        ),
    ]) {
      rmSync(root, { recursive: true, force: true });
      library = new SkillLibraryStore(root);
      await library.ensureInitialized();
      await seedSkill();
      const racing = new RacingSkillLibraryStore(root, () => {
        renameSync(join(root, "release-notes"), join(root, "moved-away"));
        mkdirSync(join(root, "release-notes"));
        writeFileSync(join(root, "release-notes", "keepme.txt"), "user data\n");
      });

      const error = await mutate(racing).then(
        () => {
          throw new Error("expected the mutation to be refused");
        },
        (caught: Error) => caught,
      );

      assert.match(error.message, /no longer the folder that was scanned/);
      assert.equal(
        await readFile(join(root, "release-notes", "keepme.txt"), "utf8"),
        "user data\n",
      );
      assert.ok(
        !existsSync(join(root, "release-notes", "a.md")),
        "nothing may be written into a folder that is not the scanned one",
      );
    }
  });

  test("a rename never takes over a destination name, even an empty directory", async () => {
    await seedSkill();
    // An empty directory is invisible to `git status`, so the repository is
    // still clean and the mutation still must not consume the name.
    await mkdir(join(root, "changelog-notes"));
    const before = await snapshot();

    const error = await assertUnchanged(before, () =>
      renameSkill(
        { name: "release-notes", newName: "changelog-notes" },
        meta,
        library,
      ),
    );

    assert.match(error.message, /already contains a top-level entry/);
    assert.ok(existsSync(join(root, "changelog-notes")));
    assert.ok(existsSync(join(root, "release-notes", "SKILL.md")));
  });

  test("removing a supporting file leaves no aside-name debris", async () => {
    await seedSkill();
    await manageSkillFiles(
      {
        name: "release-notes",
        operations: [
          { op: "write", path: "references/tone.md", content: "Be brief.\n" },
          { op: "write", path: "references/voice.md", content: "Be kind.\n" },
        ],
      },
      meta,
      library,
    );

    // The removal moves the verified inode to a private name before unlinking
    // it, so the only proof that the dance completed is that nothing is left
    // under that name and the repository is clean again.
    await manageSkillFiles(
      {
        name: "release-notes",
        operations: [
          { op: "delete", path: "references/tone.md" },
          { op: "delete", path: "references/voice.md" },
        ],
      },
      { ...meta, reason: "Remove the references" },
      library,
    );

    assert.deepEqual(
      (await readdir(join(root, "release-notes", "references"))).sort(),
      [],
    );
    assert.equal(await porcelain(), "");
    assert.equal((await scanSkillLibrary(root)).skills.length, 1);
  });
});

describe("skill authoring: a failed mutation leaves nothing behind", () => {
  test("a Git index lock is refused before anything is written", async () => {
    await seedSkill();
    const lock = join(root, ".git", "index.lock");
    await writeFile(lock, "");
    const before = await snapshot();

    const error = await assertUnchanged(before, () =>
      createSkill(
        { name: "other-skill", description: "Other", body: "Body" },
        meta,
        library,
      ),
    );

    assert.match(error.message, /index lock/);
    assert.ok(!existsSync(join(root, "other-skill")));
    // Reads are unaffected by a lock that only blocks writes.
    assert.equal((await readSkillLibraryOverview(library)).skills.length, 1);
    await rm(lock);
  });

  test("a rollback that cannot restore the tree says so instead of reporting the original failure alone", async () => {
    await seedSkill();
    const lock = join(root, ".git", "index.lock");
    // The lock appears AFTER the pre-flight check, so staging and both restore
    // commands fail on it: exactly the case that used to leave the tool's write
    // in the working tree behind an ordinary-looking error.
    const racing = new RacingSkillLibraryStore(root, () => {
      writeFileSync(lock, "");
    });

    const error = await editSkillSource(
      {
        name: "release-notes",
        edits: [{ oldText: "Write them down.", newText: "Write them now." }],
      },
      meta,
      racing,
    ).then(
      () => {
        throw new Error("expected the edit to fail");
      },
      (caught: Error) => caught,
    );

    assert.match(error.message, /could not be undone/);
    assert.match(error.message, /release-notes\/SKILL\.md/);
    assert.match(error.message, /The original failure was/);
    await rm(lock);
  });

  test("a failed batch removes the parent directories it created", async () => {
    await seedSkill();
    const before = await snapshot();

    const error = await assertUnchanged(before, () =>
      manageSkillFiles(
        {
          name: "release-notes",
          operations: [
            {
              op: "write",
              path: "new/deep/file.txt",
              content: "created by this batch\n",
            },
            { op: "delete", path: "references/absent.md" },
          ],
        },
        meta,
        library,
      ),
    );

    assert.match(error.message, /Cannot delete/);
    assert.ok(
      !existsSync(join(root, "release-notes", "new")),
      "a directory this batch created must not outlive it — Git tracks no empty directory, so only the rollback can remove it",
    );
  });

  test("directories that already existed survive a failed batch", async () => {
    await seedSkill();
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
    const before = await snapshot();

    await assertUnchanged(before, () =>
      manageSkillFiles(
        {
          name: "release-notes",
          operations: [
            { op: "write", path: "references/voice.md", content: "Be kind.\n" },
            { op: "delete", path: "references/absent.md" },
          ],
        },
        meta,
        library,
      ),
    );

    assert.equal(
      await readFile(join(root, "release-notes/references/tone.md"), "utf8"),
      "Be brief.\n",
    );
    assert.ok(!existsSync(join(root, "release-notes/references/voice.md")));
  });
});

describe("skill authoring: the publish describes the committed state", () => {
  test("each mutation's broadcast is its own commit, never the next one's writes", async () => {
    await seedSkill();
    const seen: string[][] = [];
    setSkillLibraryBroadcaster({
      broadcast: (message) => {
        broadcasts.push(message);
        if (message.type === "skillList" && message.list) {
          seen.push(message.list.skills.map((skill) => skill.name));
        }
      },
    });

    await Promise.all([
      createSkill(
        { name: "skill-one", description: "One", body: "One" },
        { ...meta, reason: "Add skill-one" },
        library,
      ),
      createSkill(
        { name: "skill-two", description: "Two", body: "Two" },
        { ...meta, reason: "Add skill-two" },
        library,
      ),
    ]);

    // Two publishes, each taken while its own mutation still held the lock, so
    // the first can never contain the second mutation's folder.
    assert.equal(seen.length, 2);
    assert.equal(seen[0]?.length, 2);
    assert.equal(seen[1]?.length, 3);
    assert.deepEqual(seen[1]?.slice().sort(), [
      "release-notes",
      "skill-one",
      "skill-two",
    ]);
  });

  test("a broadcaster failure does not turn a committed mutation into an error", async () => {
    setSkillLibraryBroadcaster({
      broadcast: () => {
        throw new Error("no listener");
      },
    });

    const outcome = await createSkill(
      { name: "release-notes", description: "Notes", body: "Body" },
      meta,
      library,
    );

    assert.equal(outcome.skill?.name, "release-notes");
    assert.equal(await commitCount(), 1);
    assert.equal(await porcelain(), "");
  });
});

describe("skill authoring: a rejected commit leaves the tree as it was", () => {
  /**
   * A hook that refuses every commit. It is the cheapest way to fail a mutation
   * AFTER its filesystem work is complete, which is the only window in which
   * the rollback's restore has anything to do.
   */
  async function rejectCommits(): Promise<void> {
    const hooks = join(root, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    await writeFile(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
  }

  test("an edit that cannot be committed puts the manifest back", async () => {
    await seedSkill();
    const before = await readFile(join(root, "release-notes/SKILL.md"), "utf8");
    await rejectCommits();

    await assert.rejects(
      editSkillSource(
        {
          name: "release-notes",
          edits: [
            { oldText: "Write them down.", newText: "Write them clearly." },
          ],
        },
        meta,
        library,
      ),
    );

    assert.equal(
      await readFile(join(root, "release-notes/SKILL.md"), "utf8"),
      before,
      "the committed manifest must come back when the commit is refused",
    );
    assert.equal(await porcelain(), "");
    assert.equal(await commitCount(), 1);
  });

  test("a delete that cannot be committed puts the folder back", async () => {
    await seedSkill();
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
    await rejectCommits();

    await assert.rejects(deleteSkill({ name: "release-notes" }, meta, library));

    assert.equal(
      await readFile(join(root, "release-notes/references/tone.md"), "utf8"),
      "Be brief.\n",
      "a deleted skill must be restored when the commit is refused",
    );
    assert.ok(existsSync(join(root, "release-notes/SKILL.md")));
    assert.equal(await porcelain(), "");
  });

  test("a rename that cannot be committed puts both names back", async () => {
    await seedSkill();
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
    await rejectCommits();

    await assert.rejects(
      renameSkill(
        { name: "release-notes", newName: "changelog-notes" },
        meta,
        library,
      ),
    );

    assert.equal(
      await readFile(join(root, "release-notes/references/tone.md"), "utf8"),
      "Be brief.\n",
      "the old name is restored",
    );
    assert.ok(
      !existsSync(join(root, "changelog-notes")),
      "and the new name is taken away again",
    );
    assert.equal(await porcelain(), "");
  });

  /** A hook that refuses the commit AND writes a file of its own first. */
  async function rejectCommitsAfterWriting(path: string): Promise<void> {
    const hooks = join(root, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    await writeFile(
      join(hooks, "pre-commit"),
      `#!/bin/sh\nmkdir -p "$(dirname '${path}')"\nprintf 'user data\\n' > '${path}'\nexit 1\n`,
      { mode: 0o755 },
    );
  }

  test("a rejected rename does not delete content a hand author put in the new folder", async () => {
    await seedSkill();
    // The hand author writes into the assembled destination in the window
    // between staging and the commit failing. Undoing the rename must take back
    // what the rename made and nothing else.
    await rejectCommitsAfterWriting(join(root, "changelog-notes", "user.txt"));

    await assert.rejects(
      renameSkill(
        { name: "release-notes", newName: "changelog-notes" },
        meta,
        library,
      ),
    );

    assert.equal(
      await readFile(join(root, "changelog-notes", "user.txt"), "utf8"),
      "user data\n",
      "the hand author's file must survive the rollback",
    );
    // The old name is back, and the skill's own assembled files are gone from
    // the new one: the undo removed what it made, and stopped there.
    assert.ok(existsSync(join(root, "release-notes", "SKILL.md")));
    assert.ok(!existsSync(join(root, "changelog-notes", "SKILL.md")));
  });

  test("a rejected create does not delete content a hand author put in the new folder", async () => {
    await seedSkill();
    await rejectCommitsAfterWriting(join(root, "triage-notes", "user.txt"));

    await assert.rejects(
      createSkill(
        { name: "triage-notes", description: "Triage", body: "Body" },
        meta,
        library,
      ),
    );

    assert.equal(
      await readFile(join(root, "triage-notes", "user.txt"), "utf8"),
      "user data\n",
    );
    assert.ok(!existsSync(join(root, "triage-notes", "SKILL.md")));
  });

  test("a rejected batch does not delete content a hand author put in a created folder", async () => {
    await seedSkill();
    await rejectCommitsAfterWriting(
      join(root, "release-notes", "new", "user.txt"),
    );

    await assert.rejects(
      manageSkillFiles(
        {
          name: "release-notes",
          operations: [
            { op: "write", path: "new/deep/file.txt", content: "agent\n" },
          ],
        },
        meta,
        library,
      ),
    );

    assert.equal(
      await readFile(join(root, "release-notes", "new", "user.txt"), "utf8"),
      "user data\n",
      "a directory the batch created may only be removed while it is empty",
    );
    assert.ok(!existsSync(join(root, "release-notes", "new", "deep")));
  });

  /**
   * A hook that refuses the commit after REPLACING the whole folder: the entries
   * this mutation made are unlinked and the hand author's own take their names.
   * The freed inode numbers are handed straight back to the replacements, so an
   * undo comparing recorded numbers alone sees its own work where the user's
   * content now is.
   */
  async function rejectCommitsAfterReplacing(folder: string): Promise<void> {
    const hooks = join(root, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    await writeFile(
      join(hooks, "pre-commit"),
      `#!/bin/sh\nrm -rf '${folder}'\nmkdir '${folder}'\nprintf 'user manifest\\n' > '${folder}/SKILL.md'\nprintf 'user data\\n' > '${folder}/user.txt'\nexit 1\n`,
      { mode: 0o755 },
    );
  }

  test("a rejected create does not delete a folder a hand author put in its place", async () => {
    await seedSkill();
    await rejectCommitsAfterReplacing(join(root, "triage-notes"));

    await assert.rejects(
      createSkill(
        { name: "triage-notes", description: "Triage", body: "Body" },
        meta,
        library,
      ),
    );

    // Nothing under the name belongs to this mutation any more: its folder and
    // its manifest were both unlinked, and what stands there now is the user's.
    assert.equal(
      await readFile(join(root, "triage-notes", "SKILL.md"), "utf8"),
      "user manifest\n",
    );
    assert.equal(
      await readFile(join(root, "triage-notes", "user.txt"), "utf8"),
      "user data\n",
    );
  });

  test("a rejected rename does not delete a folder a hand author put in its place", async () => {
    await seedSkill();
    await rejectCommitsAfterReplacing(join(root, "changelog-notes"));

    await assert.rejects(
      renameSkill(
        { name: "release-notes", newName: "changelog-notes" },
        meta,
        library,
      ),
    );

    assert.equal(
      await readFile(join(root, "changelog-notes", "SKILL.md"), "utf8"),
      "user manifest\n",
    );
    assert.equal(
      await readFile(join(root, "changelog-notes", "user.txt"), "utf8"),
      "user data\n",
    );
    assert.ok(existsSync(join(root, "release-notes", "SKILL.md")));
  });

  test("a rejected create does not delete a manifest a hand author put in its place", async () => {
    await seedSkill();
    const hooks = join(root, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    // Only the manifest is replaced this time: the folder stays, so its
    // identity still matches and the undo reaches the file inside it.
    await writeFile(
      join(hooks, "pre-commit"),
      `#!/bin/sh\nrm -f '${root}/triage-notes/SKILL.md'\nprintf 'user manifest\\n' > '${root}/triage-notes/SKILL.md'\nexit 1\n`,
      { mode: 0o755 },
    );

    await assert.rejects(
      createSkill(
        { name: "triage-notes", description: "Triage", body: "Body" },
        meta,
        library,
      ),
    );

    assert.equal(
      await readFile(join(root, "triage-notes", "SKILL.md"), "utf8"),
      "user manifest\n",
    );
  });

  test("a rejected create does not delete a manifest rewritten IN PLACE", async () => {
    await seedSkill();
    const hooks = join(root, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    // The sharper form of the case above: the hook does not replace the file,
    // it writes THROUGH it. The inode never changes, so an undo that goes by
    // identity takes their bytes for its own and deletes them.
    await writeFile(
      join(hooks, "pre-commit"),
      `#!/bin/sh\nprintf 'user manifest\\n' 1<> '${root}/triage-notes/SKILL.md'\nexit 1\n`,
      { mode: 0o755 },
    );

    await assert.rejects(
      createSkill(
        { name: "triage-notes", description: "Triage", body: "Body" },
        meta,
        library,
      ),
    );

    assert.match(
      await readFile(join(root, "triage-notes", "SKILL.md"), "utf8"),
      /^user manifest/,
      "content the mutation did not write is not the mutation's to remove",
    );
  });

  test("a rejected rename does not delete a rewritten manifest at the new name", async () => {
    await seedSkill();
    const hooks = join(root, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    // The same, for the manifest a rename WRITES at the destination: it is not
    // moved content, so its expectation is the bytes the rename wrote, and a
    // rewrite through its inode is somebody else's.
    await writeFile(
      join(hooks, "pre-commit"),
      `#!/bin/sh\nprintf 'user manifest\\n' 1<> '${root}/changelog-notes/SKILL.md'\nexit 1\n`,
      { mode: 0o755 },
    );

    await assert.rejects(
      renameSkill(
        { name: "release-notes", newName: "changelog-notes" },
        meta,
        library,
      ),
    );

    assert.match(
      await readFile(join(root, "changelog-notes", "SKILL.md"), "utf8"),
      /^user manifest/,
    );
    // And the skill is back where it was, from the copy Git had committed.
    assert.ok(existsSync(join(root, "release-notes", "SKILL.md")));
  });

  test("a rename carries a supporting symlink across and can take it back", async () => {
    await seedSkill();
    // A symlink cannot be opened for reading, so pinning it is the one case
    // that needs a descriptor which refers to an inode without opening it. If
    // that broke, the rename below would fail outright.
    await symlink("SKILL.md", join(root, "release-notes", "self.md"));
    await git(["add", "-A"], root);
    await git(["commit", "-m", "link"], root);
    await rejectCommitsAfterWriting(join(root, "changelog-notes", "user.txt"));

    await assert.rejects(
      renameSkill(
        { name: "release-notes", newName: "changelog-notes" },
        meta,
        library,
      ),
    );

    // The user's file stops its own parent from going, and the symlink this
    // rename placed is taken back with the rest of the placement.
    assert.equal(
      await readFile(join(root, "changelog-notes", "user.txt"), "utf8"),
      "user data\n",
    );
    assert.ok(!existsSync(join(root, "changelog-notes", "self.md")));
    assert.equal(
      await readlink(join(root, "release-notes", "self.md")),
      "SKILL.md",
    );
  });

  test("a rejected commit does not revert an edit made after the mutation wrote", async () => {
    await seedSkill();
    // The other half: the hook rewrites the tracked manifest and THEN refuses.
    // Those bytes are the hand author's, and `checkout HEAD --` would put the
    // committed ones back over them to undo work this mutation no longer owns.
    const hooks = join(root, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    await writeFile(
      join(hooks, "pre-commit"),
      `#!/bin/sh\nprintf 'user\\n' > '${root}/release-notes/SKILL.md'\nexit 1\n`,
      { mode: 0o755 },
    );

    await assert.rejects(
      editSkillSource(
        {
          name: "release-notes",
          edits: [{ oldText: "Write them down.", newText: "Write them well." }],
        },
        meta,
        library,
      ),
    );

    assert.equal(
      await readFile(join(root, "release-notes", "SKILL.md"), "utf8"),
      "user\n",
      "the hand author's bytes must survive the rollback",
    );
  });

  test("a rejected batch does not delete a replacement of the file it created", async () => {
    await seedSkill();
    const created = join(root, "release-notes", "notes", "new.txt");
    const hooks = join(root, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    // The file this batch creates is not in HEAD, so no generic restore can
    // bring it back — and by rollback time the name may hold a file somebody
    // else wrote. Removing it by name would destroy that; removing it by the
    // pinned inode leaves it alone.
    await writeFile(
      join(hooks, "pre-commit"),
      `#!/bin/sh\nrm -f '${created}'\nprintf 'user data\\n' > '${created}'\nexit 1\n`,
      { mode: 0o755 },
    );

    await assert.rejects(
      manageSkillFiles(
        {
          name: "release-notes",
          operations: [
            { op: "write", path: "notes/new.txt", content: "agent\n" },
          ],
        },
        meta,
        library,
      ),
    );

    assert.equal(await readFile(created, "utf8"), "user data\n");
  });

  test("an import that does not deliver its recorded size is refused", async () => {
    await seedSkill();
    // The budgets were spent on the recorded size, so anything shorter means
    // the attachment changed after it was resolved — and committing what did
    // arrive would put a silent prefix of somebody's file in the library.
    await assert.rejects(
      manageSkillFiles(
        {
          name: "release-notes",
          operations: [
            {
              op: "import",
              path: "assets/short.bin",
              size: 64,
              read: () => Promise.resolve(new Uint8Array(40)),
              attachmentId: "att-short",
            },
          ],
        },
        meta,
        library,
      ),
      /changed while it was being imported/,
    );

    assert.ok(!existsSync(join(root, "release-notes", "assets")));
    assert.equal(await porcelain(), "");
  });

  test("an import too big for the batch is refused before its bytes are read", async () => {
    await seedSkill();
    // Twenty individually valid imports, together far over the batch budget.
    // Resolving them all up front costs their bytes before the refusal — the
    // budget has to be spent on the recorded SIZE first.
    let readBytes = 0;
    const huge = 2 * 1024 * 1024;
    const operations: SkillFileOperation[] = Array.from(
      { length: 20 },
      (_, index) => ({
        op: "import",
        path: `assets/file-${index}.bin`,
        size: huge,
        read: (limit: number) => {
          readBytes += Math.min(huge, limit);
          return Promise.resolve(new Uint8Array(Math.min(huge, limit)));
        },
        attachmentId: `att-${index}`,
      }),
    );

    await assert.rejects(
      manageSkillFiles({ name: "release-notes", operations }, meta, library),
      /at most 16777216 bytes in total/,
    );

    assert.ok(
      readBytes <= 16 * 1024 * 1024,
      `the refusal read ${readBytes} bytes, more than the batch could ever hold`,
    );
    assert.equal(await porcelain(), "");
  });

  test("refuses to delete a folder with more committed files than it bounds", async () => {
    await seedSkill();
    // A delete proves the whole folder against what the repository committed.
    // That work is bounded on purpose: the size of a hand-authored folder may
    // not decide how much a mutation reads, hashes or holds open.
    for (let index = 0; index < 513; index += 1) {
      await writeFile(join(root, "release-notes", `file-${index}.txt`), "x");
    }
    await git(["add", "-A"], root);
    await git(["commit", "-m", "many files"], root);

    await assert.rejects(
      deleteSkill({ name: "release-notes" }, meta, library),
      /more than 512 committed files/,
    );
    assert.equal(await porcelain(), "");
    assert.ok(existsSync(join(root, "release-notes", "SKILL.md")));
  });

  test("a mutation leaves no descriptor of its own open", async () => {
    await seedSkill();
    // Every pin a mutation takes is held until the commit attempt settles and
    // closed afterwards, on the failing path as well as the succeeding one.
    const open = async () => (await readdir("/proc/self/fd")).length;
    const before = await open();
    for (let round = 0; round < 5; round += 1) {
      await createSkill(
        { name: `note-${round}`, description: "Notes", body: "Body" },
        meta,
        library,
      );
      await renameSkill(
        { name: `note-${round}`, newName: `memo-${round}` },
        meta,
        library,
      );
      await manageSkillFiles(
        {
          name: `memo-${round}`,
          operations: [
            {
              op: "write",
              path: `deep/nested/file-${round}.txt`,
              content: "x",
            },
          ],
        },
        meta,
        library,
      );
    }
    await rejectCommits();
    await assert.rejects(
      createSkill(
        { name: "refused", description: "Refused", body: "Body" },
        meta,
        library,
      ),
    );
    assert.ok(
      (await open()) <= before + 2,
      `descriptors grew from ${before} to ${await open()}`,
    );
  });

  test("a create that cannot be committed leaves no folder behind", async () => {
    await seedSkill();
    await rejectCommits();

    await assert.rejects(
      createSkill(
        { name: "triage-notes", description: "Triage", body: "Body" },
        meta,
        library,
      ),
    );

    assert.ok(!existsSync(join(root, "triage-notes")));
    assert.equal(await porcelain(), "");
  });
});
