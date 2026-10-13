/**
 * The library core with a kind that is NOT a skill
 * (`docs/agent-definitions.md#shared-library-core`).
 *
 * Every other core test runs the skill kind, so a `SKILL.md` or `Skill-`
 * hard-coded anywhere in the core would pass them all. A fixture kind —
 * `WIDGET.md`, a required extra `color` field, `Widget-*` trailers — proves
 * the manifest file, the extended rule, the nouns and the trailers really come
 * from the descriptor.
 *
 * Run with:
 *   pnpm --filter @assistant/server test src/library/libraryKind.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { git } from "../gitExec.ts";
import { resolveEntryDetail } from "./entryDetail.ts";
import {
  assertManifest,
  formatManifest,
  parseManifestWith,
} from "./entryManifest.ts";
import {
  createEntry,
  deleteEntry,
  editEntrySource,
  renameEntry,
} from "./libraryAuthoring.ts";
import type { LibraryKind } from "./libraryKind.ts";
import { scanLibrary } from "./libraryScanner.ts";
import { LibraryStore } from "./libraryStore.ts";

interface WidgetManifest {
  name: string;
  description: string;
  body: string;
  color: string;
}

const widgetKind: LibraryKind<WidgetManifest> = {
  noun: "widget",
  plural: "widgets",
  manifestFile: "WIDGET.md",
  trailerPrefix: "Widget",
  parseManifest: (content, path) =>
    parseManifestWith(content, path, (fields, issues) => {
      if (typeof fields.color === "string" && fields.color.trim() !== "")
        return { color: fields.color };
      issues.push({
        code: "invalid-field",
        error: "Frontmatter color must be a non-empty string.",
      });
      return { color: "" };
    }),
  publish: async () => undefined,
};

const meta = {
  actor: { id: "pi:workshop:sess-1", name: "Widget test" },
  reason: "Add a widget",
  sessionId: "sess-1",
};

let root: string;
let library: LibraryStore;

function widgetSource(name: string, color = "blue"): string {
  return formatManifest(
    [
      `name: ${name}`,
      `description: ${JSON.stringify(`The ${name} widget.`)}`,
      `color: ${color}`,
    ],
    "Widget instructions.",
  );
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "library-kind-test-"));
  library = new LibraryStore(widgetKind, root);
  await library.ensureInitialized();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a non-skill library kind", () => {
  test("the extended rule types the extra field and reports it when wrong", async () => {
    assert.equal(
      assertManifest(widgetKind, widgetSource("gear", "red"), "gear/WIDGET.md")
        .color,
      "red",
    );

    await mkdir(join(root, "broken"));
    await writeFile(
      join(root, "broken", "WIDGET.md"),
      "---\nname: broken\ndescription: No color.\n---\n\nBody.\n",
    );
    await mkdir(join(root, "skill-shaped"));
    await writeFile(
      join(root, "skill-shaped", "SKILL.md"),
      "---\nname: skill-shaped\ndescription: Wrong kind.\n---\n",
    );
    const scan = await scanLibrary(widgetKind, root);
    assert.deepEqual(scan.entries, []);
    assert.deepEqual(
      scan.diagnostics.map(({ path, code, declaredName }) => ({
        path,
        code,
        declaredName,
      })),
      [
        {
          path: "broken/WIDGET.md",
          code: "invalid-field",
          declaredName: "broken",
        },
        {
          path: "skill-shaped/WIDGET.md",
          code: "missing-manifest",
          declaredName: undefined,
        },
      ],
    );
  });

  test("create, edit, rename and delete use the kind's file, nouns and trailers", async () => {
    const created = await createEntry(
      { name: "gear", source: widgetSource("gear") },
      meta,
      library,
    );
    assert.equal(created.entry?.path, "gear/WIDGET.md");
    assert.ok(existsSync(join(root, "gear", "WIDGET.md")));

    await assert.rejects(
      editEntrySource(
        {
          name: "gear",
          edits: [{ oldText: "color: blue", newText: "color: " }],
        },
        { ...meta, reason: "Break the color" },
        library,
      ),
      /color must be a non-empty string/,
    );

    const renamed = await renameEntry(
      { name: "gear", newName: "cog" },
      { ...meta, reason: "Rename gear" },
      library,
    );
    assert.equal(renamed.entry?.path, "cog/WIDGET.md");

    await assert.rejects(
      renameEntry(
        { name: "missing", newName: "other" },
        { ...meta, reason: "Rename nothing" },
        library,
      ),
      /No valid widget declares the name "missing"/,
    );

    await deleteEntry(
      { name: "cog" },
      { ...meta, reason: "Remove cog" },
      library,
    );
    assert.ok(!existsSync(join(root, "cog")));

    const history = await library.history();
    assert.deepEqual(
      history.entries.map((entry) => entry.subject),
      ["Remove cog", "Rename gear", "Add a widget"],
    );
    const added = history.entries[2]!;
    assert.equal(added.trailers["Widget-Names"], "gear");
    assert.equal(added.trailers["Widget-Paths"], '["gear/WIDGET.md"]');
    assert.equal(
      Object.keys(added.trailers).some((key) => key.startsWith("Skill-")),
      false,
    );
    assert.match(added.author, /^Widget test$/);
    // The one place `plural` reaches commit identity.
    const email = await git(["log", "-1", "--format=%ae", "HEAD"], root);
    assert.match(email.stdout.trim(), /@widgets\.local$/);
  });

  test("a detail read refuses a same-inode rewrite that breaks the kind's own field", async () => {
    await mkdir(join(root, "gear"));
    const path = join(root, "gear", "WIDGET.md");
    await writeFile(path, widgetSource("gear"));
    const scan = await scanLibrary(widgetKind, root);
    assert.deepEqual(
      scan.entries.map((entry) => entry.name),
      ["gear"],
    );

    // Same inode, same name and description: only the kind-specific field
    // goes, which the scan would now report as `invalid-field`.
    const inode = statSync(path).ino;
    await writeFile(
      path,
      '---\nname: gear\ndescription: "The gear widget."\n---\n\nWidget instructions.\n',
    );
    assert.equal(statSync(path).ino, inode);

    const detail = await resolveEntryDetail(library, scan, "gear");
    assert.equal(detail?.kind, "invalid");
  });
});
