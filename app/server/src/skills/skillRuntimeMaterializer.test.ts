import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rename,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
  materializeSkillRuntime,
  SkillRuntimeMaterializationError,
  type SkillRuntimeScan,
  skillSetHash,
} from "./skillRuntimeMaterializer.ts";

let root: string;
let libraryDir: string;
let runtimeDir: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "skill-runtime-test-"));
  libraryDir = join(root, "skills");
  runtimeDir = join(root, "skills-runtime");
  await mkdir(libraryDir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function addSkill(
  folder: string,
  name: string,
  description = `${name} description`,
): Promise<SkillRuntimeScan["skills"][number]> {
  const source = join(libraryDir, folder);
  await mkdir(join(source, "references"), { recursive: true });
  await writeFile(
    join(source, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
    "utf8",
  );
  await writeFile(
    join(source, "references", "proof.txt"),
    `${name} whole-folder proof\n`,
    "utf8",
  );
  return { name, path: `${folder}/SKILL.md` };
}

function scan(
  skills: SkillRuntimeScan["skills"],
  diagnostics: SkillRuntimeScan["diagnostics"] = [],
): SkillRuntimeScan {
  return { skills, diagnostics };
}

function options(): { libraryDir: string; runtimeDir: string } {
  return { libraryDir, runtimeDir };
}

describe("skillSetHash", () => {
  test("hashes the sorted unique name set independently of input order", () => {
    const expected = createHash("sha256")
      .update(JSON.stringify(["alpha", "zeta"]))
      .digest("hex");

    assert.equal(skillSetHash(["zeta", "alpha"]), expected);
    assert.equal(skillSetHash(["alpha", "zeta", "alpha"]), expected);
    assert.match(expected, /^[a-f0-9]{64}$/);
  });
});

describe("materializeSkillRuntime", () => {
  test("materializes the empty set as a valid deterministic plugin", async () => {
    const result = await materializeSkillRuntime([], scan([]), options());

    assert.equal(result.hash, skillSetHash([]));
    assert.equal(result.root, join(runtimeDir, result.hash));
    assert.deepEqual(await readdir(result.skillsDir), []);
    const manifest = JSON.parse(
      await readFile(
        join(result.root, ".claude-plugin", "plugin.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    assert.equal(manifest.name, `pa-skills-${result.hash.slice(0, 16)}`);
    assert.equal(manifest.version, "1.0.0");
    assert.deepEqual(manifest.author, { name: "Pandeck" });
  });

  test("reuses the sorted set and links each whole source folder", async () => {
    const alpha = await addSkill("source-alpha", "alpha");
    const zeta = await addSkill("different-source", "zeta");

    const first = await materializeSkillRuntime(
      ["zeta", "alpha"],
      scan([zeta, alpha]),
      options(),
    );
    const rootBefore = await stat(first.root);
    const second = await materializeSkillRuntime(
      ["alpha", "zeta"],
      scan([alpha, zeta]),
      options(),
    );
    const rootAfter = await stat(second.root);

    assert.equal(second.root, first.root);
    assert.equal(rootAfter.ino, rootBefore.ino);
    assert.deepEqual(await readdir(first.skillsDir), ["alpha", "zeta"]);
    assert.equal(
      await readlink(join(first.skillsDir, "zeta")),
      resolve(libraryDir, "different-source"),
    );
    assert.equal(
      await readFile(
        join(first.skillsDir, "alpha", "references", "proof.txt"),
        "utf8",
      ),
      "alpha whole-folder proof\n",
    );

    await writeFile(
      join(libraryDir, "source-alpha", "references", "proof.txt"),
      "uncommitted edit\n",
      "utf8",
    );
    assert.equal(
      await readFile(
        join(first.skillsDir, "alpha", "references", "proof.txt"),
        "utf8",
      ),
      "uncommitted edit\n",
    );
  });

  test("serializes concurrent calls and leaves no stage directories", async () => {
    const summary = await addSkill("concurrent-source", "concurrent");

    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        materializeSkillRuntime(["concurrent"], scan([summary]), options()),
      ),
    );

    assert.equal(new Set(results.map(({ root }) => root)).size, 1);
    assert.deepEqual(await readdir(runtimeDir), [results[0]?.hash]);
    assert.equal(
      (
        await lstat(join(results[0]?.skillsDir ?? "", "concurrent"))
      ).isSymbolicLink(),
      true,
    );
  });

  test("replaces a partial target through staged atomic publication", async () => {
    const summary = await addSkill("recovery-source", "recovery");
    const hash = skillSetHash(["recovery"]);
    const partial = join(runtimeDir, hash);
    await mkdir(join(partial, "skills"), { recursive: true });
    await writeFile(join(partial, "partial.txt"), "interrupted\n", "utf8");

    const result = await materializeSkillRuntime(
      ["recovery"],
      scan([summary]),
      options(),
    );

    assert.deepEqual((await readdir(result.root)).sort(), [
      ".claude-plugin",
      ".pa-skills-runtime.json",
      "skills",
    ]);
    assert.equal(
      await readFile(join(result.skillsDir, "recovery", "SKILL.md"), "utf8"),
      "---\nname: recovery\ndescription: recovery description\n---\n# recovery\n",
    );
    assert.equal(
      (await readdir(runtimeDir)).some(
        (name) => name.includes(".tmp-") || name.includes(".partial-"),
      ),
      false,
    );
  });

  test("refreshes a same-name runtime when its scanner source folder moves", async () => {
    const oldSummary = await addSkill("old-folder", "movable");
    const first = await materializeSkillRuntime(
      ["movable"],
      scan([oldSummary]),
      options(),
    );
    await rename(
      join(libraryDir, "old-folder"),
      join(libraryDir, "new-folder"),
    );
    const newSummary = { ...oldSummary, path: "new-folder/SKILL.md" };

    const second = await materializeSkillRuntime(
      ["movable"],
      scan([newSummary]),
      options(),
    );

    assert.equal(second.root, first.root);
    assert.equal(
      await readlink(join(second.skillsDir, "movable")),
      resolve(libraryDir, "new-folder"),
    );
  });

  test("rejects missing and invalid frozen names with scanner diagnostics", async () => {
    await assert.rejects(
      materializeSkillRuntime(
        ["broken"],
        scan(
          [],
          [
            {
              declaredName: "broken",
              error: "Missing frontmatter description.",
            },
          ],
        ),
        options(),
      ),
      (error: unknown) =>
        error instanceof SkillRuntimeMaterializationError &&
        /missing or invalid/.test(error.message) &&
        /Missing frontmatter description/.test(error.message),
    );
    await assert.rejects(
      materializeSkillRuntime(["../escape"], scan([]), options()),
      /Invalid frozen skill name/,
    );
    assert.equal(await pathExists(runtimeDir), false);
  });

  test("rejects unsafe scanner paths and sources missing after the scan", async () => {
    await assert.rejects(
      materializeSkillRuntime(
        ["escape"],
        scan([
          {
            name: "escape",
            path: "../outside/SKILL.md",
          },
        ]),
        options(),
      ),
      /not one top-level SKILL\.md path/,
    );
    await assert.rejects(
      materializeSkillRuntime(
        ["vanished"],
        scan([
          {
            name: "vanished",
            path: "vanished/SKILL.md",
          },
        ]),
        options(),
      ),
      /missing or unreadable/,
    );
    assert.equal(await pathExists(runtimeDir), false);
  });

  test("rejects a source folder replaced by an arbitrary symlink", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "SKILL.md"), "outside\n", "utf8");
    await symlink(outside, join(libraryDir, "linked-source"), "dir");

    await assert.rejects(
      materializeSkillRuntime(
        ["linked"],
        scan([
          {
            name: "linked",
            path: "linked-source/SKILL.md",
          },
        ]),
        options(),
      ),
      /not a regular directory/,
    );
  });
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}
