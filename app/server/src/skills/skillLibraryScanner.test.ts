import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, test } from "vitest";
import { git } from "../gitExec.ts";
import type {
  SkillDiagnostic,
  SkillDiagnosticCode,
  SkillSummary,
} from "@assistant/shared";
import {
  scanSkillLibrary,
  type SkillLibraryScan,
} from "./skillLibraryScanner.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skill-scanner-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function writeSkill(
  folder: string,
  frontmatter: string,
  body = "# Instructions\n",
): Promise<void> {
  const skillRoot = join(root, folder);
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    `---\n${frontmatter}\n---\n${body}`,
    "utf8",
  );
}

function diagnosticCodes(
  scan: SkillLibraryScan,
): Array<`${string}:${SkillDiagnosticCode}`> {
  return scan.diagnostics.map(
    (diagnostic: SkillDiagnostic) =>
      `${diagnostic.path}:${diagnostic.code}` as const,
  );
}

function skillNames(skills: SkillSummary[]): string[] {
  return skills.map(({ name }) => name);
}

describe("scanSkillLibrary", () => {
  test("returns deterministic summaries while preserving source path identity", async () => {
    await writeSkill(
      "z-source-folder",
      "name: alpha-skill\ndescription: First declared skill",
    );
    await writeSkill(
      "a-source-folder",
      "name: zeta-skill\ndescription: Last declared skill",
    );
    await mkdir(join(root, ".git"));
    await mkdir(join(root, ".repository-metadata"));
    await writeFile(join(root, "README.md"), "not a skill folder\n", "utf8");

    assert.deepEqual(await scanSkillLibrary(root), {
      skills: [
        {
          name: "alpha-skill",
          description: "First declared skill",
          path: "z-source-folder/SKILL.md",
        },
        {
          name: "zeta-skill",
          description: "Last declared skill",
          path: "a-source-folder/SKILL.md",
        },
      ],
      diagnostics: [],
    });
  });

  test("reports missing and unreadable SKILL.md files without hiding their folders", async () => {
    await mkdir(join(root, "missing"));
    await mkdir(join(root, "unreadable", "SKILL.md"), { recursive: true });

    const scan = await scanSkillLibrary(root);

    assert.deepEqual(scan.skills, []);
    assert.deepEqual(diagnosticCodes(scan), [
      "missing/SKILL.md:missing-skill-file",
      "unreadable/SKILL.md:unreadable-skill-file",
    ]);
    assert.deepEqual(
      scan.diagnostics.map(({ folder, error }) => ({ folder, error })),
      [
        { folder: "missing", error: "Missing missing/SKILL.md." },
        {
          folder: "unreadable",
          error: "Cannot read unreadable/SKILL.md as a UTF-8 file.",
        },
      ],
    );
  });

  test("reports symlinked source folders and SKILL.md files distinctly", async () => {
    await writeSkill(
      "folder-target",
      "name: linked-folder\ndescription: Linked folder",
    );
    await symlink(
      join(root, "folder-target"),
      join(root, "linked-folder"),
      "dir",
    );

    await mkdir(join(root, "file-link"));
    await writeFile(
      join(root, "file-target.md"),
      "---\nname: linked-file\ndescription: Linked file\n---\n",
      "utf8",
    );
    await symlink(
      join(root, "file-target.md"),
      join(root, "file-link", "SKILL.md"),
    );

    const scan = await scanSkillLibrary(root);

    assert.deepEqual(scan.skills, [
      {
        name: "linked-folder",
        description: "Linked folder",
        path: "folder-target/SKILL.md",
      },
    ]);
    assert.deepEqual(diagnosticCodes(scan), [
      "file-link/SKILL.md:symlinked-skill-source",
      "linked-folder/SKILL.md:symlinked-skill-source",
    ]);
    assert.deepEqual(
      scan.diagnostics.map(({ path, error }) => ({ path, error })),
      [
        {
          path: "file-link/SKILL.md",
          error:
            "Refusing symlinked skill source file-link/SKILL.md; source folders and SKILL.md files must be regular filesystem entries.",
        },
        {
          path: "linked-folder/SKILL.md",
          error:
            "Refusing symlinked skill source linked-folder/SKILL.md; source folders and SKILL.md files must be regular filesystem entries.",
        },
      ],
    );
  });

  test("ignores a top-level link to an ordinary file, like the file itself", async () => {
    await writeSkill("real-skill", "name: real\ndescription: A real one");
    await writeFile(join(root, "README.md"), "not a skill\n", "utf8");
    await symlink(join(root, "README.md"), join(root, "README-link"));
    await symlink(join(root, "nowhere.md"), join(root, "dangling-link"));

    const scan = await scanSkillLibrary(root);

    // A link standing where a FILE would is a top-level file by another name,
    // and top-level files are not library entries: it must not be dressed up as
    // a folder that needs a fix.
    assert.deepEqual(skillNames(scan.skills), ["real"]);
    assert.deepEqual(diagnosticCodes(scan), []);
  });

  test("orders diagnostics by source path across mixed kinds of entry", async () => {
    await writeSkill("a-valid", "name: valid-one\ndescription: Fine");
    await mkdir(join(root, "m-broken"));
    await writeFile(
      join(root, "m-broken", "SKILL.md"),
      "---\ndescription: No name\n---\n",
      "utf8",
    );
    await mkdir(join(root, "b-empty"));
    await writeSkill("z-target", "name: linked-one\ndescription: Linked");
    await symlink(join(root, "z-target"), join(root, "c-linked-folder"), "dir");
    await writeFile(join(root, "d-loose.md"), "loose\n", "utf8");
    await symlink(join(root, "d-loose.md"), join(root, "e-file-link"));
    await mkdir(join(root, ".hidden"));

    const scan = await scanSkillLibrary(root);

    assert.deepEqual(skillNames(scan.skills), ["linked-one", "valid-one"]);
    // Only the entries that stand where a folder would: the loose file and the
    // link to it contribute nothing at all.
    assert.deepEqual(diagnosticCodes(scan), [
      "b-empty/SKILL.md:missing-skill-file",
      "c-linked-folder/SKILL.md:symlinked-skill-source",
      "m-broken/SKILL.md:missing-name",
    ]);
  });

  test("distinguishes invalid frontmatter, invalid YAML, and a non-mapping YAML value", async () => {
    await mkdir(join(root, "no-frontmatter"));
    await writeFile(
      join(root, "no-frontmatter", "SKILL.md"),
      "name: no-fence\n",
      "utf8",
    );
    await writeSkill(
      "bad-yaml",
      "name: first\nname: second\ndescription: duplicate key",
    );
    await writeSkill("yaml-sequence", "- item");

    const scan = await scanSkillLibrary(root);

    assert.deepEqual(diagnosticCodes(scan), [
      "bad-yaml/SKILL.md:invalid-yaml",
      "no-frontmatter/SKILL.md:invalid-frontmatter",
      "yaml-sequence/SKILL.md:invalid-yaml",
    ]);
    assert.match(scan.diagnostics[0]?.error ?? "", /duplicate key "name"/);
    assert.match(
      scan.diagnostics[1]?.error ?? "",
      /document must start with YAML frontmatter/,
    );
    assert.match(scan.diagnostics[2]?.error ?? "", /expected a mapping/);
  });

  test("reports missing, non-string, and unsafe declared names exactly", async () => {
    await writeSkill("missing", "description: Missing name");
    await writeSkill("non-string", "name: 42\ndescription: Numeric name");
    await writeSkill("unsafe-empty", 'name: ""\ndescription: Empty name');
    await writeSkill(
      "unsafe-path",
      "name: ../escape\ndescription: Path-like name",
    );
    await writeSkill(
      "unsafe-uppercase",
      "name: Uppercase\ndescription: Uppercase name",
    );
    await writeSkill(
      "unsafe-double-hyphen",
      "name: two--children\ndescription: Consecutive hyphens",
    );
    await writeSkill(
      "unsafe-long",
      `name: ${"a".repeat(65)}\ndescription: Too long`,
    );
    await writeSkill(
      "safe-boundary",
      `name: ${"a".repeat(64)}\ndescription: At the limit`,
    );

    const scan = await scanSkillLibrary(root);

    assert.deepEqual(scan.skills, [
      {
        name: "a".repeat(64),
        description: "At the limit",
        path: "safe-boundary/SKILL.md",
      },
    ]);
    assert.deepEqual(diagnosticCodes(scan), [
      "missing/SKILL.md:missing-name",
      "non-string/SKILL.md:non-string-name",
      "unsafe-double-hyphen/SKILL.md:unsafe-name",
      "unsafe-empty/SKILL.md:unsafe-name",
      "unsafe-long/SKILL.md:unsafe-name",
      "unsafe-path/SKILL.md:unsafe-name",
      "unsafe-uppercase/SKILL.md:unsafe-name",
    ]);
  });

  test("reports descriptions pi will reject instead of advertising them", async () => {
    await writeSkill("missing", "name: missing-description");
    await writeSkill(
      "non-string",
      "name: numeric-description\ndescription: 42",
    );
    await writeSkill(
      "empty-string",
      'name: empty-description\ndescription: ""',
    );
    await writeSkill(
      "whitespace-only",
      'name: whitespace-description\ndescription: "   \\t"',
    );
    await writeSkill(
      "too-long",
      `name: long-description\ndescription: ${"x".repeat(1025)}`,
    );
    await writeSkill(
      "boundary",
      `name: boundary-description\ndescription: ${"x".repeat(1024)}`,
    );

    const scan = await scanSkillLibrary(root);

    assert.deepEqual(scan.skills, [
      {
        name: "boundary-description",
        description: "x".repeat(1024),
        path: "boundary/SKILL.md",
      },
    ]);
    assert.deepEqual(diagnosticCodes(scan), [
      "empty-string/SKILL.md:empty-description",
      "missing/SKILL.md:missing-description",
      "non-string/SKILL.md:non-string-description",
      "too-long/SKILL.md:description-too-long",
      "whitespace-only/SKILL.md:empty-description",
    ]);
    assert.deepEqual(
      scan.diagnostics.map(({ declaredName }) => declaredName),
      [
        "empty-description",
        "missing-description",
        "numeric-description",
        "long-description",
        "whitespace-description",
      ],
    );
    assert.equal(
      scan.diagnostics.find(({ code }) => code === "description-too-long")
        ?.error,
      "Frontmatter description must be at most 1024 characters.",
    );
  });

  test("makes every duplicate declared name non-injectable and visible", async () => {
    await writeSkill("first-folder", "name: shared\ndescription: First");
    await writeSkill("second-folder", "name: shared\ndescription: Second");
    await writeSkill("also-malformed", "name: shared");
    await writeSkill("unique-folder", "name: unique\ndescription: Unique");

    const scan = await scanSkillLibrary(root);

    assert.deepEqual(scan.skills, [
      {
        name: "unique",
        description: "Unique",
        path: "unique-folder/SKILL.md",
      },
    ]);
    assert.deepEqual(diagnosticCodes(scan), [
      "also-malformed/SKILL.md:duplicate-name",
      "also-malformed/SKILL.md:missing-description",
      "first-folder/SKILL.md:duplicate-name",
      "second-folder/SKILL.md:duplicate-name",
    ]);
    for (const diagnostic of scan.diagnostics.filter(
      ({ code }) => code === "duplicate-name",
    )) {
      assert.equal(diagnostic.declaredName, "shared");
      assert.equal(
        diagnostic.error,
        'Duplicate declared skill name "shared" in folders: also-malformed, first-folder, second-folder.',
      );
    }
  });

  test("rescans uncommitted working-tree edits, additions, and removals instead of Git HEAD", async () => {
    await git(["init", "-b", "main"], root);
    await writeSkill("existing", "name: existing\ndescription: Committed");
    await git(["add", "existing/SKILL.md"], root);
    await git(
      [
        "-c",
        "user.name=Scanner Test",
        "-c",
        "user.email=scanner@example.test",
        "commit",
        "-m",
        "Committed skill",
      ],
      root,
    );
    const head = (await git(["rev-parse", "HEAD"], root)).stdout.trim();

    assert.equal(
      (await scanSkillLibrary(root)).skills[0]?.description,
      "Committed",
    );

    await writeSkill("existing", "name: existing\ndescription: Edited");
    assert.equal(
      (await scanSkillLibrary(root)).skills[0]?.description,
      "Edited",
    );

    await writeSkill("added", "name: added\ndescription: Uncommitted addition");
    assert.deepEqual(skillNames((await scanSkillLibrary(root)).skills), [
      "added",
      "existing",
    ]);

    await rm(join(root, "existing"), { recursive: true });
    assert.deepEqual((await scanSkillLibrary(root)).skills, [
      {
        name: "added",
        description: "Uncommitted addition",
        path: "added/SKILL.md",
      },
    ]);
    assert.equal((await git(["rev-parse", "HEAD"], root)).stdout.trim(), head);
  });

  /**
   * The scan used to check a path and then read it, so a `SKILL.md` swapped for
   * a symlink in between was read through the link: a stress run put an OUTSIDE
   * file's name and description into Settings as a valid skill, with no
   * diagnostic. Reproducing that needs real concurrency — the swaps run in
   * worker threads, atomically, while the scan runs — and the invariant is
   * absolute: whatever a scan catches the folder in the middle of, it may only
   * ever report the library's own file.
   *
   * `sawSwap` keeps the test honest. Without it a run where the swaps never
   * interleaved would pass while proving nothing.
   */
  test("never turns a mid-scan symlink swap into an outside skill", async () => {
    const outside = mkdtempSync(join(tmpdir(), "skill-scanner-outside-"));
    const swappers: Worker[] = [];
    try {
      await writeFile(
        join(outside, "outside.md"),
        "---\nname: outside-skill\ndescription: Outside metadata\n---\n# Leaked\n",
        "utf8",
      );

      const folders = Array.from(
        { length: 8 },
        (_, index) => `victim-${index}`,
      );
      for (const folder of folders) {
        await writeSkill(folder, `name: ${folder}\ndescription: Real one`);
        const spare = join(root, folder, ".spare");
        const link = join(root, folder, ".link");
        await writeFile(spare, "placeholder", "utf8");
        await symlink(join(outside, "outside.md"), link);
        swappers.push(
          new Worker(SWAP_LOOP, {
            eval: true,
            workerData: {
              target: join(root, folder, "SKILL.md"),
              spare,
              link,
            },
          }),
        );
      }

      let scans = 0;
      let sawSwap = false;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !(sawSwap && scans >= 25)) {
        const scan = await scanSkillLibrary(root);
        scans++;
        assert.equal(
          scan.skills.some((skill) => skill.name === "outside-skill"),
          false,
          "an outside file was reported as a library skill",
        );
        assert.equal(
          scan.diagnostics.some(
            (diagnostic) => diagnostic.code === "unsafe-name",
          ),
          false,
        );
        if (scan.diagnostics.length > 0) sawSwap = true;
      }

      assert.equal(sawSwap, true, "the swap window was never exercised");
    } finally {
      for (const worker of swappers) await worker.terminate();
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

/**
 * Atomic renames, so the path always resolves to either the library's own file
 * or a symlink pointing outside it — never to a half-written state that would
 * make the invariant above trivially true.
 */
const SWAP_LOOP = `
const { renameSync } = require("node:fs");
const { workerData } = require("node:worker_threads");
const { target, spare, link } = workerData;
(function loop() {
  for (let i = 0; i < 2000; i++) {
    try {
      renameSync(link, target);
      renameSync(target, link);
      renameSync(spare, target);
      renameSync(target, spare);
    } catch {
      return;
    }
  }
  setImmediate(loop);
})();
`;
