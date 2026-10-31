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
import { Buffer } from "node:buffer";
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { checkoutGitOn } from "../gitExec.ts";
import { resolveEntryDetail } from "./entryDetail.ts";
import {
  EntryFileTooLargeError,
  readEntryFilePreview,
  readEntryRawFile,
  readEntryTextWindow,
} from "./entryFiles.ts";
import {
  assertManifest,
  formatManifest,
  parseManifestWith,
} from "./entryManifest.ts";
import {
  createEntry,
  deleteEntry,
  editEntrySource,
  manageEntryFiles,
  renameEntry,
  resolveEntrySource,
} from "./libraryAuthoring.ts";
import type { LibraryKind } from "./libraryKind.ts";
import { scanLibrary } from "./libraryScanner.ts";
import { LibraryStore } from "./libraryStore.ts";
import { DEFAULT_WORKER_SIDE } from "../workers/placement.ts";

const { git } = checkoutGitOn(DEFAULT_WORKER_SIDE);

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
  // Far below the core's own read bounds, so the kind's bound is what refuses.
  maxManifestBytes: 512,
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
    // The one place `plural` reaches commit identity: author AND committer.
    const emails = await git(["log", "-1", "--format=%ae %ce", "HEAD"], root);
    assert.match(
      emails.stdout.trim(),
      /^\S+@widgets\.local \S+@widgets\.local$/,
    );
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

  test("the kind's size bound is judged from the real file size everywhere", async () => {
    const big = "x".repeat(600);
    await mkdir(join(root, "huge"));
    await writeFile(
      join(root, "huge", "WIDGET.md"),
      widgetSource("huge").replace("Widget instructions.", big),
    );
    await mkdir(join(root, "gear"));
    const path = join(root, "gear", "WIDGET.md");
    await writeFile(path, widgetSource("gear"));

    const scan = await scanLibrary(widgetKind, root);
    assert.deepEqual(
      scan.entries.map((entry) => entry.name),
      ["gear"],
    );
    assert.deepEqual(
      scan.diagnostics.map(({ code, declaredName }) => ({
        code,
        declaredName,
      })),
      [{ code: "manifest-too-large", declaredName: "huge" }],
    );

    // Valid content, same inode, but now past the bound: the content rule
    // alone would accept it, so only the real size can refuse it.
    const inode = statSync(path).ino;
    await writeFile(
      path,
      widgetSource("gear").replace("Widget instructions.", big),
    );
    assert.equal(statSync(path).ino, inode);
    assert.equal(
      (await resolveEntryDetail(library, scan, "gear"))?.kind,
      "invalid",
    );
    await assert.rejects(
      resolveEntrySource(library, scan, "gear"),
      /above the 512-byte limit for a widget manifest/,
    );

    await assert.rejects(
      createEntry(
        {
          name: "large",
          source: widgetSource("large").replace("Widget instructions.", big),
        },
        meta,
        library,
      ),
      /above the 512-byte limit for a widget manifest/,
    );
  });

  test("an edit or a rename that would carry the manifest past the bound is refused", async () => {
    await createEntry(
      { name: "gear", source: widgetSource("gear") },
      meta,
      library,
    );
    await assert.rejects(
      editEntrySource(
        {
          name: "gear",
          edits: [
            { oldText: "Widget instructions.", newText: "x".repeat(600) },
          ],
        },
        { ...meta, reason: "Grow gear" },
        library,
      ),
      /would be \d+ bytes, above the 512-byte limit for a widget manifest/,
    );

    // Just inside the bound with a one-letter name; a long new name tips it.
    const base = widgetSource("a");
    const padded = base.replace(
      "Widget instructions.",
      "z".repeat(505 - Buffer.byteLength(base, "utf8") + 20),
    );
    assert.equal(Buffer.byteLength(padded, "utf8"), 505);
    await createEntry({ name: "a", source: padded }, meta, library);
    await assert.rejects(
      renameEntry(
        { name: "a", newName: "a-much-longer-widget-name-than-before" },
        { ...meta, reason: "Rename a" },
        library,
      ),
      /would be \d+ bytes, above the 512-byte limit for a widget manifest/,
    );
    assert.ok(existsSync(join(root, "a", "WIDGET.md")));
  });

  test("reading the manifest as a file applies the bound to the handle it opens", async () => {
    await mkdir(join(root, "gear"));
    const path = join(root, "gear", "WIDGET.md");
    const valid = widgetSource("gear");
    // Grows the manifest in place right after the scan has parsed it: the
    // scan saw a valid, small file, and only the reread can see the growth.
    let armed = false;
    const growingKind: LibraryKind<WidgetManifest> = {
      ...widgetKind,
      parseManifest: (content, at) => {
        const parsed = widgetKind.parseManifest(content, at);
        if (armed) {
          armed = false;
          appendFileSync(path, "x".repeat(600));
        }
        return parsed;
      },
    };
    const growing = new LibraryStore(growingKind, root);
    const reads: Array<() => Promise<unknown>> = [
      () => readEntryRawFile("gear", "WIDGET.md", growing),
      () => readEntryFilePreview("gear", "WIDGET.md", growing),
      () => readEntryTextWindow("gear", "WIDGET.md", {}, growing),
    ];
    for (const read of reads) {
      writeFileSync(path, valid);
      const inode = statSync(path).ino;
      armed = true;
      await assert.rejects(read(), EntryFileTooLargeError);
      assert.equal(statSync(path).ino, inode);
      assert.equal(armed, false, "the growth happened between scan and read");
    }

    // Hard links are the same inode under another name or path: they are the
    // manifest, and are held to its bound too.
    await mkdir(join(root, "gear", "nested"));
    linkSync(path, join(root, "gear", "nested", "WIDGET.md"));
    linkSync(path, join(root, "gear", "widget.md"));
    for (const alias of ["nested/WIDGET.md", "widget.md"]) {
      const aliasReads: Array<() => Promise<unknown>> = [
        () => readEntryRawFile("gear", alias, growing),
        () => readEntryFilePreview("gear", alias, growing),
        () => readEntryTextWindow("gear", alias, {}, growing),
      ];
      for (const read of aliasReads) {
        writeFileSync(path, valid);
        armed = true;
        await assert.rejects(read(), EntryFileTooLargeError, alias);
        assert.equal(armed, false);
      }
    }
    rmSync(join(root, "gear", "nested"), { recursive: true });
    rmSync(join(root, "gear", "widget.md"));

    // A supporting file is not the manifest and is not held to its bound.
    writeFileSync(path, valid);
    await writeFile(join(root, "gear", "notes.md"), "y".repeat(2000));
    assert.equal(
      (await readEntryRawFile("gear", "notes.md", library))?.bytes,
      2000,
    );
  });

  test("delete refuses a manifest that grew past the bound between its scan and its pin", async () => {
    await createEntry(
      { name: "gear", source: widgetSource("gear") },
      meta,
      library,
    );
    const path = join(root, "gear", "WIDGET.md");
    let armed = false;
    const growingKind: LibraryKind<WidgetManifest> = {
      ...widgetKind,
      parseManifest: (content, at) => {
        const parsed = widgetKind.parseManifest(content, at);
        if (armed && at === "gear/WIDGET.md") {
          armed = false;
          appendFileSync(path, "x".repeat(600));
        }
        return parsed;
      },
    };
    const growing = new LibraryStore(growingKind, root);
    armed = true;
    await assert.rejects(
      deleteEntry(
        { name: "gear" },
        { ...meta, reason: "Remove gear" },
        growing,
      ),
      /above the 512-byte limit for a widget manifest/,
    );
    assert.equal(armed, false, "the growth happened between scan and pin");
    assert.ok(existsSync(path), "nothing was deleted");
  });

  test("nothing is rewritten in place through a hard link, so no linked manifest changes", async () => {
    await createEntry(
      { name: "gear", source: widgetSource("gear") },
      meta,
      library,
    );
    await createEntry(
      { name: "cog", source: widgetSource("cog") },
      meta,
      library,
    );
    const gear = join(root, "gear", "WIDGET.md");
    const cog = join(root, "cog", "WIDGET.md");
    // Its own manifest under another name, and ANOTHER entry's manifest.
    linkSync(gear, join(root, "gear", "alias.md"));
    linkSync(cog, join(root, "gear", "other.md"));
    await git(["add", "gear"], root);
    await git(
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Link aliases",
      ],
      root,
    );
    const before = {
      gear: readFileSync(gear, "utf8"),
      cog: readFileSync(cog, "utf8"),
    };
    const clean = async () =>
      assert.equal(
        (await git(["status", "--porcelain"], root)).stdout.trim(),
        "",
      );

    for (const path of ["alias.md", "other.md"]) {
      for (const operation of [
        {
          op: "edit" as const,
          path,
          edits: [{ oldText: "Widget instructions.", newText: "Hijacked." }],
        },
        { op: "write" as const, path, content: widgetSource("cog") },
      ]) {
        await assert.rejects(
          manageEntryFiles(
            { name: "gear", operations: [operation] },
            { ...meta, reason: `Change ${path} (${operation.op})` },
            library,
          ),
          /has 2 hard links/,
        );
        assert.deepEqual(
          { gear: readFileSync(gear, "utf8"), cog: readFileSync(cog, "utf8") },
          before,
        );
        await clean();
      }
    }

    // The manifest itself is linked, so the manifest edit refuses too.
    await assert.rejects(
      editEntrySource(
        {
          name: "gear",
          edits: [{ oldText: "Widget instructions.", newText: "Changed." }],
        },
        { ...meta, reason: "Edit linked gear" },
        library,
      ),
      /has 2 hard links/,
    );
    assert.equal(readFileSync(gear, "utf8"), before.gear);
    await clean();

    // An ordinary supporting file is still written as before.
    await manageEntryFiles(
      {
        name: "gear",
        operations: [{ op: "write", path: "notes.md", content: "Notes.\n" }],
      },
      { ...meta, reason: "Add notes" },
      library,
    );
    assert.equal(
      readFileSync(join(root, "gear", "notes.md"), "utf8"),
      "Notes.\n",
    );
  });
});
