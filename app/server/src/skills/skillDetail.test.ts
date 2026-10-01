/**
 * The bounded single-skill read ([Task-614](pa://task/614)).
 *
 * The cases that matter are the ones a hand-authored library actually produces:
 * a name is the only address a caller has, the library moves between the scan
 * and the read, and a file is bigger than the app will serve. Run:
 *   pnpm --filter @assistant/server test src/skills/skillDetail.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { MAX_SKILL_BODY_BYTES } from "@assistant/shared";
import { readSkillDetail, resolveSkillDetail } from "./skillDetail.ts";
import { scanSkillLibrary } from "./skillLibraryScanner.ts";
import { SkillLibraryStore } from "./skillLibraryStore.ts";

let root: string;
let library: SkillLibraryStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skill-detail-test-"));
  library = new SkillLibraryStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function writeSkill(
  folder: string,
  frontmatter: string,
  body = "# Instructions\n\nDo the thing.\n",
): Promise<void> {
  await mkdir(join(root, folder), { recursive: true });
  await writeFile(
    join(root, folder, "SKILL.md"),
    `---\n${frontmatter}\n---\n${body}`,
    "utf8",
  );
}

describe("readSkillDetail", () => {
  test("serves the body below the frontmatter with compact metadata", async () => {
    await writeSkill(
      "release-notes-folder",
      "name: release-notes\ndescription: Draft release notes.",
      "# Release notes\n\nSteps here.\n",
    );

    const detail = await readSkillDetail("release-notes", library);
    const { size } = await stat(join(root, "release-notes-folder", "SKILL.md"));

    assert.deepEqual(detail, {
      kind: "skill",
      name: "release-notes",
      description: "Draft release notes.",
      folder: "release-notes-folder",
      path: "release-notes-folder/SKILL.md",
      // The frontmatter's own two fields travel as metadata, not as YAML text.
      markdown: "# Release notes\n\nSteps here.",
      bytes: size,
      truncated: false,
      files: {
        entries: [
          {
            type: "file",
            name: "SKILL.md",
            path: "SKILL.md",
            bytes: size,
            mimeType: "text/markdown; charset=utf-8",
          },
        ],
        entryCount: 1,
        metadataBytes: 16,
        truncated: false,
        limits: [],
        diagnostics: [],
      },
    });
  });

  test("resolves the declared name, never the source folder name", async () => {
    await writeSkill(
      "some-folder",
      "name: declared-name\ndescription: Named differently from its folder.",
    );

    assert.equal(
      (await readSkillDetail("declared-name", library))?.kind,
      "skill",
    );
    // The folder is identity for diagnostics only; it is not an address.
    assert.equal(await readSkillDetail("some-folder", library), null);
  });

  test("refuses a path-shaped name before touching the filesystem", async () => {
    await writeSkill("ok", "name: ok\ndescription: Fine.");

    for (const name of [
      "../ok",
      "ok/SKILL.md",
      "/etc/passwd",
      "..",
      "Ok",
      "",
    ]) {
      assert.equal(await readSkillDetail(name, library), null, name);
    }
  });

  test("answers null for a name no folder declares", async () => {
    await writeSkill("ok", "name: ok\ndescription: Fine.");

    assert.equal(await readSkillDetail("missing-skill", library), null);
  });

  test("answers a malformed folder's own diagnostic instead of a body", async () => {
    await writeSkill(
      "broken",
      "name: broken-skill\ndescription: ''",
      "# Body\n",
    );

    const detail = await readSkillDetail("broken-skill", library);

    assert.equal(detail?.kind, "invalid");
    assert.equal(detail?.kind === "invalid" && detail.name, "broken-skill");
    assert.equal(detail?.kind === "invalid" && detail.folder, "broken");
    assert.match(
      detail?.kind === "invalid" ? detail.error : "",
      /must not be empty/,
    );
  });

  test("answers an ambiguous name with the duplicate reason, never one folder's body", async () => {
    await writeSkill("first", "name: shared\ndescription: One.", "# First\n");
    await writeSkill("second", "name: shared\ndescription: Two.", "# Second\n");

    const detail = await readSkillDetail("shared", library);

    assert.equal(detail?.kind, "invalid");
    assert.match(
      detail?.kind === "invalid" ? detail.error : "",
      /Duplicate declared skill name "shared"/,
    );
    assert.equal(
      JSON.stringify(detail).includes("# First") ||
        JSON.stringify(detail).includes("# Second"),
      false,
    );
  });

  test("truncates a body past the byte bound and says so", async () => {
    const body = `# Big\n\n${"x".repeat(MAX_SKILL_BODY_BYTES)}\n`;
    await writeSkill("big", "name: big\ndescription: Large.", body);

    const detail = await readSkillDetail("big", library);

    assert.equal(detail?.kind, "skill");
    if (detail?.kind !== "skill") return;
    assert.equal(detail.truncated, true);
    assert.equal(detail.bytes > MAX_SKILL_BODY_BYTES, true);
    assert.equal(
      Buffer.byteLength(detail.markdown, "utf8") <= MAX_SKILL_BODY_BYTES,
      true,
    );
    assert.match(detail.markdown, /^# Big/);
  });

  test("never cuts a multi-byte character in half at the bound", async () => {
    const body = `# Wide\n\n${"é".repeat(MAX_SKILL_BODY_BYTES)}\n`;
    await writeSkill("wide", "name: wide\ndescription: Multi-byte.", body);

    const detail = await readSkillDetail("wide", library);

    assert.equal(detail?.kind === "skill" && detail.truncated, true);
    assert.equal(
      detail?.kind === "skill" && detail.markdown.includes("�"),
      false,
    );
  });

  test("applies the bound below frontmatter, not to the whole file", async () => {
    await writeSkill(
      "large-frontmatter",
      `name: large-frontmatter\ndescription: Large metadata\nextra: ${"x".repeat(MAX_SKILL_BODY_BYTES)}`,
      "# Small body\n",
    );

    const detail = await readSkillDetail("large-frontmatter", library);

    assert.equal(detail?.kind, "skill");
    if (detail?.kind !== "skill") return;
    assert.equal(detail.markdown, "# Small body");
    assert.equal(detail.truncated, false);
    assert.equal(detail.bytes > MAX_SKILL_BODY_BYTES, true);
  });
});

describe("resolveSkillDetail", () => {
  test("reports a skill deleted between the scan and the read", async () => {
    await writeSkill("gone", "name: gone\ndescription: About to vanish.");
    const scan = await scanSkillLibrary(root);
    await rm(join(root, "gone"), { recursive: true, force: true });

    const detail = await resolveSkillDetail(root, scan, "gone");

    assert.equal(detail?.kind, "invalid");
    if (detail?.kind !== "invalid") return;
    assert.equal(detail.name, "gone");
    assert.equal(detail.path, "gone/SKILL.md");
    assert.match(detail.error, /no longer exists/);
    // The reason names the library-relative path, never the absolute one.
    assert.equal(detail.error.includes(root), false);
    assert.equal(/ENOENT/.test(detail.error), false);
  });

  test("reports frontmatter removed between the scan and the read", async () => {
    await writeSkill("edited", "name: edited\ndescription: Being edited.");
    const scan = await scanSkillLibrary(root);
    await writeFile(
      join(root, "edited", "SKILL.md"),
      "no frontmatter any more\n",
      "utf8",
    );

    const detail = await resolveSkillDetail(root, scan, "edited");

    assert.equal(detail?.kind, "invalid");
    assert.match(
      detail?.kind === "invalid" ? detail.error : "",
      /no longer starts with valid frontmatter/,
    );
  });

  test("revalidates reread YAML and metadata against the scan", async () => {
    await writeSkill("edited", "name: edited\ndescription: Being edited.");
    const scan = await scanSkillLibrary(root);
    await writeFile(
      join(root, "edited", "SKILL.md"),
      "---\nname: edited\ndescription: [malformed\n---\n# Body\n",
      "utf8",
    );

    const malformed = await resolveSkillDetail(root, scan, "edited");
    assert.equal(malformed?.kind, "invalid");

    await writeFile(
      join(root, "edited", "SKILL.md"),
      "---\nname: other\ndescription: Being edited.\n---\n# Body\n",
      "utf8",
    );
    const renamed = await resolveSkillDetail(root, scan, "edited");
    assert.equal(renamed?.kind, "invalid");
  });

  test("rejects a source-folder symlink installed after the scan", async () => {
    await writeSkill("swapped", "name: swapped\ndescription: Replaced.");
    const scan = await scanSkillLibrary(root);
    const outside = mkdtempSync(join(tmpdir(), "skill-detail-outside-"));
    try {
      await writeFile(
        join(outside, "SKILL.md"),
        "---\nname: swapped\ndescription: Outside.\n---\n# Outside\n",
        "utf8",
      );
      await rm(join(root, "swapped"), { recursive: true, force: true });
      await symlink(outside, join(root, "swapped"));

      const detail = await resolveSkillDetail(root, scan, "swapped");

      assert.equal(detail?.kind, "invalid");
      assert.equal(JSON.stringify(detail).includes("# Outside"), false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("reports a source folder replaced by a file between scan and read", async () => {
    await writeSkill("swapped", "name: swapped\ndescription: Replaced.");
    const scan = await scanSkillLibrary(root);
    await rm(join(root, "swapped"), { recursive: true, force: true });
    await writeFile(join(root, "swapped"), "not a folder\n", "utf8");

    const detail = await resolveSkillDetail(root, scan, "swapped");

    assert.equal(detail?.kind, "invalid");
    assert.equal(detail?.kind === "invalid" && detail.name, "swapped");
    assert.equal(
      /ENOTDIR|ENOENT/.test(detail?.kind === "invalid" ? detail.error : ""),
      false,
    );
  });
});
