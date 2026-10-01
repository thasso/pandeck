/** Recursive skill-file listing and bounded read security ([Task-615](pa://task/615)). */
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
  MAX_SKILL_FILE_PREVIEW_BYTES,
  MAX_SKILL_RAW_FILE_BYTES,
  MAX_SKILL_TREE_DEPTH,
  MAX_SKILL_TREE_ENTRIES,
  MAX_SKILL_TREE_METADATA_BYTES,
} from "@assistant/shared";
import { readSkillDetail } from "./skillDetail.ts";
import {
  InvalidSkillFilePathError,
  MAX_SKILL_TEXT_WINDOW_BYTES,
  MAX_SKILL_TEXT_WINDOW_LINES,
  readSkillFilePreview,
  readSkillRawFile,
  readSkillTextWindow,
  SkillFileNotFoundError,
  SkillFileNotTextError,
  SkillFileTooLargeError,
} from "./skillFiles.ts";
import { SkillLibraryStore } from "./skillLibraryStore.ts";

const execFile = promisify(execFileCallback);

let root: string;
let library: SkillLibraryStore;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "skill-files-test-"));
  library = new SkillLibraryStore(root);
  await mkdir(join(root, "source"), { recursive: true });
  await writeFile(
    join(root, "source", "SKILL.md"),
    "---\nname: test-skill\ndescription: Test supporting files.\n---\n# Test\n",
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

async function detail() {
  const result = await readSkillDetail("test-skill", library);
  assert.equal(result?.kind, "skill");
  if (result?.kind !== "skill") throw new Error("skill was not readable");
  return result;
}

describe("skill file tree", () => {
  test("lists nested files recursively in deterministic lexical order", async () => {
    await mkdir(join(root, "source", "references", "nested"), {
      recursive: true,
    });
    await mkdir(join(root, "source", "scripts"));
    await writeFile(join(root, "source", "references", "z.md"), "# Z\n");
    await writeFile(join(root, "source", "references", "a.json"), "{}\n");
    await writeFile(
      join(root, "source", "references", "nested", "note.txt"),
      "note\n",
    );
    await writeFile(join(root, "source", "scripts", "run.sh"), "echo ok\n");

    const files = (await detail()).files;

    assert.deepEqual(
      files.entries.map((entry) => entry.name),
      ["SKILL.md", "references", "scripts"],
    );
    const references = files.entries[1]!;
    assert.deepEqual(
      references.children?.map((entry) => entry.name),
      ["a.json", "nested", "z.md"],
    );
    assert.equal(
      references.children?.[0]?.mimeType,
      "application/json; charset=utf-8",
    );
    assert.equal(
      references.children?.[1]?.children?.[0]?.path,
      "references/nested/note.txt",
    );
    assert.equal(files.truncated, false);
    assert.deepEqual(files.diagnostics, []);
  });

  test("reads a huge sibling set without listing all of it", async () => {
    // 20,000 names, of which at most a thousand can ever be answered. The tree
    // must be bounded and truncated — and the READ must be bounded too, which
    // is what the descriptor-and-memory bound is for: a full listing allocates
    // every Dirent before the first bound can refuse anything.
    const names = Array.from(
      { length: 20_000 },
      (_, index) => `file-${String(index).padStart(6, "0")}.txt`,
    );
    for (let start = 0; start < names.length; start += 500) {
      await execFile("touch", [
        ...names
          .slice(start, start + 500)
          .map((name) => join(root, "source", name)),
      ]);
    }

    const files = (await detail()).files;

    assert.equal(files.entryCount, MAX_SKILL_TREE_ENTRIES);
    assert.equal(files.truncated, true);
    // Deterministic despite the bound: the defining document first, then the
    // byte-lexically smallest names, not whatever readdir happened to yield.
    assert.equal(files.entries[0]?.name, "SKILL.md");
    assert.equal(files.entries[1]?.name, "file-000000.txt");
    assert.equal(
      files.entries[MAX_SKILL_TREE_ENTRIES - 1]?.name,
      "file-000998.txt",
    );
  });

  test("bounds diagnostics for irregular entries", async () => {
    const paths = Array.from({ length: 3_000 }, (_, index) =>
      join(
        root,
        "source",
        `fifo-${String(index).padStart(4, "0")}-${"x".repeat(80)}`,
      ),
    );
    for (let start = 0; start < paths.length; start += 400) {
      await execFile("mkfifo", paths.slice(start, start + 400));
    }

    const files = (await detail()).files;

    assert.equal(files.entryCount, 1);
    assert.equal(files.truncated, true);
    assert.equal(files.limits.includes("metadata-bytes"), true);
    assert.equal(files.metadataBytes <= MAX_SKILL_TREE_METADATA_BYTES, true);
    assert.equal(files.diagnostics.length < paths.length, true);
    assert.equal(
      files.diagnostics.every((diagnostic) =>
        diagnostic.endsWith("is not a regular file or directory."),
      ),
      true,
    );
  });

  test("surfaces entry, depth, and metadata-byte bounds", async () => {
    for (let index = 0; index < MAX_SKILL_TREE_ENTRIES; index += 1) {
      await writeFile(
        join(root, "source", `f-${String(index).padStart(4, "0")}.txt`),
        "x",
      );
    }
    const entryBound = (await detail()).files;
    assert.equal(entryBound.entryCount, MAX_SKILL_TREE_ENTRIES);
    assert.equal(entryBound.truncated, true);
    assert.equal(entryBound.limits.includes("entries"), true);

    await rm(join(root, "source"), { recursive: true });
    await mkdir(join(root, "source"));
    await writeFile(
      join(root, "source", "SKILL.md"),
      "---\nname: test-skill\ndescription: Test.\n---\n# Test\n",
    );
    let current = join(root, "source");
    for (let depth = 0; depth <= MAX_SKILL_TREE_DEPTH; depth += 1) {
      current = join(current, `d${depth}`);
      await mkdir(current);
    }
    const depthBound = (await detail()).files;
    assert.equal(depthBound.limits.includes("depth"), true);

    await rm(join(root, "source", "d0"), { recursive: true });
    const branchCount = 20;
    for (let branch = 0; branch < branchCount; branch += 1) {
      current = join(root, "source", `branch-${branch}`);
      await mkdir(current);
      for (let depth = 0; depth < MAX_SKILL_TREE_DEPTH; depth += 1) {
        current = join(
          current,
          `${String(depth).padStart(2, "0")}-${"x".repeat(170)}`,
        );
        await mkdir(current);
      }
    }
    const byteBound = (await detail()).files;
    assert.equal(byteBound.limits.includes("metadata-bytes"), true);
    assert.equal(byteBound.entryCount < MAX_SKILL_TREE_ENTRIES, true);
    const listedBranches = byteBound.entries
      .filter((entry) => entry.name.startsWith("branch-"))
      .map((entry) => entry.name);
    assert.equal(listedBranches.length < branchCount, true);
    assert.deepEqual(
      listedBranches,
      Array.from({ length: branchCount }, (_, index) => `branch-${index}`)
        .sort()
        .slice(0, listedBranches.length),
    );
  }, 20_000);
});

describe("skill file reads", () => {
  test("serves nested text with MIME metadata and bounded UTF-8 previews", async () => {
    await mkdir(join(root, "source", "references"));
    await writeFile(
      join(root, "source", "references", "guide.md"),
      "# Guide\n",
    );
    await writeFile(
      join(root, "source", "references", "large.txt"),
      `wide\n${"é".repeat(MAX_SKILL_FILE_PREVIEW_BYTES)}`,
    );

    const raw = await readSkillRawFile(
      "test-skill",
      "references/guide.md",
      library,
    );
    assert.equal(raw?.mimeType, "text/markdown; charset=utf-8");
    assert.equal(raw?.bytes, Buffer.byteLength("# Guide\n"));
    assert.equal(raw?.content.toString("utf8"), "# Guide\n");

    const preview = await readSkillFilePreview(
      "test-skill",
      "references/large.txt",
      library,
    );
    assert.equal(preview?.kind, "text");
    if (preview?.kind !== "text") return;
    assert.equal(preview.truncated, true);
    assert.equal(preview.text.includes("�"), false);
  });

  test("detects binary bytes even under a text extension", async () => {
    await writeFile(
      join(root, "source", "pretend.txt"),
      Buffer.from([65, 0, 66]),
    );

    const preview = await readSkillFilePreview(
      "test-skill",
      "pretend.txt",
      library,
    );

    assert.deepEqual(preview, {
      kind: "binary",
      path: "pretend.txt",
      mimeType: "text/plain; charset=utf-8",
      bytes: 3,
      truncated: false,
    });
  });

  test("rejects every traversal and absolute-path shape before reading", async () => {
    for (const path of [
      "../secret",
      "references/../secret",
      "/etc/passwd",
      "C:/Windows/file",
      "references\\guide.md",
      "references//guide.md",
      "./SKILL.md",
      " SKILL.md",
      "SKILL.md ",
      "a\0b",
    ]) {
      await assert.rejects(
        readSkillRawFile("test-skill", path, library),
        InvalidSkillFilePathError,
        path,
      );
    }

    await assert.rejects(
      readSkillRawFile("test-skill", "%2e%2e/secret", library),
      SkillFileNotFoundError,
    );
  });

  test("reads supporting files whose names contain percent signs", async () => {
    await writeFile(join(root, "source", "50%-off.md"), "half price\n");

    const raw = await readSkillRawFile("test-skill", "50%-off.md", library);

    assert.equal(raw?.content.toString("utf8"), "half price\n");
  });

  test("never follows supporting-file symlinks inside or outside the skill", async () => {
    const outside = join(root, "outside.txt");
    await writeFile(outside, "outside secret\n");
    await writeFile(join(root, "source", "inside.txt"), "inside\n");
    await symlink(outside, join(root, "source", "escape.txt"));
    await symlink("inside.txt", join(root, "source", "alias.txt"));

    await assert.rejects(
      readSkillRawFile("test-skill", "escape.txt", library),
      SkillFileNotFoundError,
    );
    await assert.rejects(
      readSkillRawFile("test-skill", "alias.txt", library),
      SkillFileNotFoundError,
    );
    const tree = (await detail()).files.entries;
    assert.equal(
      tree.find((entry) => entry.name === "escape.txt")?.type,
      "symlink",
    );
  });

  test("turns deletion into a bounded not-found result", async () => {
    await writeFile(join(root, "source", "gone.txt"), "soon gone\n");
    await rm(join(root, "source", "gone.txt"));

    await assert.rejects(
      readSkillRawFile("test-skill", "gone.txt", library),
      SkillFileNotFoundError,
    );
  });

  test("refuses a raw file larger than the download bound", async () => {
    await writeFile(
      join(root, "source", "huge.bin"),
      Buffer.alloc(MAX_SKILL_RAW_FILE_BYTES + 1),
    );

    await assert.rejects(
      readSkillRawFile("test-skill", "huge.bin", library),
      SkillFileTooLargeError,
    );
  });
});

describe("skill text windows", () => {
  const lines = (count: number, prefix = "line") =>
    Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);

  async function window(
    path: string,
    options: { offset?: number; limit?: number } = {},
  ) {
    const read = await readSkillTextWindow(
      "test-skill",
      path,
      options,
      library,
    );
    assert.ok(read, `${path} is readable`);
    return read;
  }

  test("serves a whole small file verbatim and reports its end", async () => {
    await mkdir(join(root, "source", "references"));
    await writeFile(
      join(root, "source", "references", "guide.md"),
      "# Guide\n\nUse `cl-btn`.\n",
    );

    const read = await window("references/guide.md");

    // Verbatim: the text an exact-match edit will have to reproduce.
    assert.equal(read.text, "# Guide\n\nUse `cl-btn`.");
    assert.equal(read.mimeType, "text/markdown; charset=utf-8");
    assert.equal(read.bytes, 23);
    assert.deepEqual(
      { first: read.firstLine, last: read.lastLine, count: read.lineCount },
      { first: 1, last: 3, count: 3 },
    );
    assert.equal(read.truncated, false);
  });

  test("pages a long file by line, and the last window is not truncated", async () => {
    await writeFile(
      join(root, "source", "long.md"),
      `${lines(1_000).join("\n")}\n`,
    );

    const first = await window("long.md", { limit: 400 });
    assert.equal(first.firstLine, 1);
    assert.equal(first.lastLine, 400);
    assert.equal(first.lineCount, 1_000);
    assert.equal(first.truncated, true);
    assert.equal(first.text.split("\n").at(-1), "line 400");

    const last = await window("long.md", { offset: 601, limit: 400 });
    assert.equal(last.lastLine, 1_000);
    assert.equal(last.truncated, false);
    assert.equal(last.text.split("\n")[0], "line 601");
  });

  test("caps the line count and the window's own size", async () => {
    await writeFile(
      join(root, "source", "wide.md"),
      `${lines(MAX_SKILL_TEXT_WINDOW_LINES + 100).join("\n")}\n`,
    );
    // Every line is well under the byte budget, so the LINE cap decides.
    const capped = await window("wide.md", {
      limit: MAX_SKILL_TEXT_WINDOW_LINES + 100,
    });
    assert.equal(capped.lastLine, MAX_SKILL_TEXT_WINDOW_LINES);
    assert.equal(capped.truncated, true);

    await writeFile(
      join(root, "source", "fat.md"),
      `${lines(40, "x".repeat(4_000)).join("\n")}\n`,
    );
    const bounded = await window("fat.md", { limit: 40 });
    assert.ok(
      Buffer.byteLength(bounded.text, "utf8") <= MAX_SKILL_TEXT_WINDOW_BYTES,
      "a window never exceeds its byte budget",
    );
    assert.ok(bounded.lastLine < 40, "it stopped short of the last line");
    assert.equal(bounded.truncated, true);
  });

  test("clips one over-long line at a character boundary", async () => {
    // A single line nobody can page past would otherwise be emitted whole.
    await writeFile(
      join(root, "source", "one-line.md"),
      `${"ü".repeat(MAX_SKILL_TEXT_WINDOW_BYTES)}\n`,
    );

    const read = await window("one-line.md");

    assert.equal(read.lineCount, 1);
    assert.equal(read.truncated, true);
    assert.ok(
      Buffer.byteLength(read.text, "utf8") <= MAX_SKILL_TEXT_WINDOW_BYTES,
    );
    assert.ok(!read.text.includes("�"), "never cut mid-character");
  });

  test("an offset past the end is an empty window, not a failure", async () => {
    await writeFile(join(root, "source", "short.md"), "one\ntwo\n");

    const read = await window("short.md", { offset: 99 });

    assert.equal(read.text, "");
    assert.equal(read.firstLine, 99);
    assert.equal(read.lastLine, 98);
    assert.equal(read.lineCount, 2);
    assert.equal(read.truncated, false);
  });

  test("reads only the first bounded prefix of an oversized text file", async () => {
    // The final line of the prefix may be half a line, so it is not offered.
    await writeFile(
      join(root, "source", "huge.md"),
      "x".repeat(MAX_SKILL_FILE_PREVIEW_BYTES + 10),
    );

    const read = await window("huge.md");

    assert.equal(read.bytes, MAX_SKILL_FILE_PREVIEW_BYTES + 10);
    assert.equal(read.lineCount, 0);
    assert.equal(read.truncated, true);
  });

  test("refuses a binary file instead of decoding it", async () => {
    await writeFile(join(root, "source", "logo.png"), Buffer.from([1, 2, 3]));
    await writeFile(
      join(root, "source", "pretend.txt"),
      Buffer.from([0x61, 0x00, 0x62]),
    );

    await assert.rejects(
      readSkillTextWindow("test-skill", "logo.png", {}, library),
      SkillFileNotTextError,
    );
    await assert.rejects(
      readSkillTextWindow("test-skill", "pretend.txt", {}, library),
      SkillFileNotTextError,
    );
  });

  test("refuses invalid UTF-8 that carries no NUL to scan for", async () => {
    // A Markdown file with one stray Latin-1 byte passes every binary probe.
    // Decoding it lossily would answer with a replacement character standing
    // where content is, and an edit copied out of that answer would rewrite
    // bytes nobody read.
    await writeFile(
      join(root, "source", "latin.md"),
      Buffer.from([0x23, 0x20, 0x43, 0x61, 0x66, 0xe9, 0x0a]),
    );

    await assert.rejects(
      readSkillTextWindow("test-skill", "latin.md", {}, library),
      SkillFileNotTextError,
    );
  });

  test("refuses a file that really ends mid-character", async () => {
    // Same bytes a bound cut would leave behind, but this read saw the whole
    // file: suspending judgement on the tail here would answer with text the
    // file does not contain.
    await writeFile(
      join(root, "source", "chopped.md"),
      Buffer.from([0x61, 0xe9]),
    );

    await assert.rejects(
      readSkillTextWindow("test-skill", "chopped.md", {}, library),
      SkillFileNotTextError,
    );
  });

  test("keeps a byte-order mark, and a character the read bound cuts is not one", async () => {
    await writeFile(join(root, "source", "bom.md"), "\ufeff# Title\nBody\n");
    // Valid UTF-8 whose last character straddles the 256 KiB read bound: the
    // bound is this read's own doing, not bad content.
    await writeFile(
      join(root, "source", "cut.md"),
      `${"x".repeat(MAX_SKILL_FILE_PREVIEW_BYTES - 1)}ü\n`,
    );

    const bom = await window("bom.md");
    assert.equal(bom.text, "\ufeff# Title\nBody");

    const cut = await window("cut.md");
    assert.equal(cut.lineCount, 0);
    assert.equal(cut.truncated, true);
  });

  test("keeps the path, symlink and window-argument rules of every other read", async () => {
    await writeFile(join(root, "source", "inside.txt"), "inside\n");
    await symlink("inside.txt", join(root, "source", "alias.txt"));

    await assert.rejects(
      readSkillTextWindow("test-skill", "../secret", {}, library),
      InvalidSkillFilePathError,
    );
    await assert.rejects(
      readSkillTextWindow("test-skill", "alias.txt", {}, library),
      SkillFileNotFoundError,
    );
    await assert.rejects(
      readSkillTextWindow("test-skill", "inside.txt", { offset: 0 }, library),
      InvalidSkillFilePathError,
    );
    await assert.rejects(
      readSkillTextWindow("test-skill", "inside.txt", { limit: 0 }, library),
      InvalidSkillFilePathError,
    );
    assert.equal(
      await readSkillTextWindow("no-such-skill", "inside.txt", {}, library),
      null,
    );
  });
});
