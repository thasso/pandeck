import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { describe, test } from "vitest";
import type { ShowFilesCard } from "@assistant/shared";
import { showFilesTool } from "./showFilesTool.ts";
import { DATA_DIR } from "../../config.ts";
import type { ToolCallContext } from "../../mcp/tool.ts";

const dir = mkdtempSync(join(tmpdir(), "pa-show-files-"));
writeFileSync(join(dir, "plot.png"), Buffer.alloc(2048, 1));
writeFileSync(join(dir, "report.md"), "# Report\n");
writeFileSync(join(dir, "My Notes.md"), "notes\n");

const ctx = { session: { cwd: dir } } as unknown as ToolCallContext;

/** The tool's answer is its card: the text output IS the payload the chat parses. */
async function run(
  params: Parameters<typeof showFilesTool.execute>[0],
): Promise<ShowFilesCard["files"]> {
  const result = await showFilesTool.execute(params, ctx);
  const [block] = result.content;
  const text = block && "text" in block ? block.text : "";
  const payload = JSON.parse(text) as {
    renderKind: string;
    card: ShowFilesCard;
  };
  assert.equal(payload.renderKind, "showFiles");
  return payload.card.files;
}

describe("show_files", () => {
  test("cards an image with its size, kind and inline snippet", async () => {
    const [file] = await run({ paths: [join(dir, "plot.png")] });
    // No mime and no kind: the card classifies the same address itself, so a
    // row has nothing to declare about how the file is presented.
    assert.deepEqual(file, {
      url: `/api/files${dir}/plot.png`,
      name: "plot.png",
      label: "plot.png",
      size: 2048,
      snippet: `![plot.png](/api/files${dir}/plot.png)`,
    });
  });

  test("gives a document a link snippet, and honors one label", async () => {
    const [file] = await run({
      paths: [join(dir, "report.md")],
      label: "Q3 report",
    });
    assert.equal(file?.label, "Q3 report");
    assert.equal(file?.snippet, `[Q3 report](/api/files${dir}/report.md)`);
  });

  test("escapes a path a reader would otherwise break", async () => {
    const [file] = await run({ paths: [join(dir, "My Notes.md")] });
    assert.match(file?.url ?? "", /My%20Notes\.md/);
    assert.doesNotMatch(file?.snippet ?? "", /\(\/api\/files.*My Notes/);
  });

  test("escapes link text that would close the snippet early", async () => {
    // A `]` in the label would end the link at the label; a newline would end
    // it outright. Both reach here from a file name, not just from a caption.
    const [file] = await run({
      paths: [join(dir, "report.md")],
      label: "Q3 [draft] \\ notes\nsecond line",
    });
    const link = /\[(.*)\]\(/.exec(file?.snippet ?? "")?.[1];
    assert.equal(link, "Q3 \\[draft\\] \\\\ notes second line");
    // The CARD is not Markdown: it shows the label the caller actually wrote.
    assert.equal(file?.label, "Q3 [draft] \\ notes\nsecond line");
  });

  test("keeps a captured artifact's own source identity", async () => {
    const session = "s1";
    const root = join(DATA_DIR, "session-artifacts", session, "files");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "shot.png"), Buffer.alloc(10, 1));
    const [file] = await run({
      paths: [`/api/session-artifacts/${session}/files/shot.png`],
    });
    assert.equal(file?.url, `/api/session-artifacts/${session}/files/shot.png`);
    assert.equal(file?.name, "shot.png");
    assert.equal(file?.size, 10);
  });

  test("refuses an artifact path that climbs out of its session", async () => {
    await assert.rejects(
      () => run({ paths: ["/api/session-artifacts/s1/../s2/secret.png"] }),
      /Not a session artifact|File not found/,
    );
  });

  // Containment is decided on the CANONICAL path: a symlink inside the session
  // directory needs no `..` at all, so a lexical check alone would hand out a
  // card — and the bytes — for any file the service can read.
  test("refuses an artifact symlink pointing out of its session", async () => {
    const session = "s-links";
    const root = join(DATA_DIR, "session-artifacts", session);
    mkdirSync(root, { recursive: true });
    const outside = join(dir, "outside.png");
    writeFileSync(outside, Buffer.alloc(4, 1));
    symlinkSync(outside, join(root, "escape.png"));
    await assert.rejects(
      () => run({ paths: [`/api/session-artifacts/${session}/escape.png`] }),
      /Not a session artifact/,
    );
  });

  // A session id NAMES one direct child of `session-artifacts`. POSIX
  // `dirname`/`basename` read a backslash as an ordinary character, so the
  // identity check alone would accept `s\alias`; the shared guard the grant
  // resolver uses is what refuses both slash styles.
  test("refuses a session id that is not a plain name", async () => {
    const aliased = join(DATA_DIR, "session-artifacts", "s\\alias");
    mkdirSync(aliased, { recursive: true });
    writeFileSync(join(aliased, "file.png"), Buffer.alloc(4, 1));
    await assert.rejects(
      () => run({ paths: ["/api/session-artifacts/s%5Calias/file.png"] }),
      /Invalid session id/,
    );
  });

  test("refuses a session root that is itself a link elsewhere", async () => {
    const outsideRoot = join(dir, "elsewhere");
    mkdirSync(outsideRoot, { recursive: true });
    writeFileSync(join(outsideRoot, "secret.png"), Buffer.alloc(4, 1));
    mkdirSync(join(DATA_DIR, "session-artifacts"), { recursive: true });
    symlinkSync(outsideRoot, join(DATA_DIR, "session-artifacts", "s-aliased"));
    await assert.rejects(
      () => run({ paths: ["/api/session-artifacts/s-aliased/secret.png"] }),
      /Not a session artifact/,
    );
  });

  test("keeps a symlink that stays inside its own session", async () => {
    const session = "s-inside";
    const root = join(DATA_DIR, "session-artifacts", session);
    mkdirSync(join(root, "files"), { recursive: true });
    writeFileSync(join(root, "files", "real.png"), Buffer.alloc(6, 1));
    symlinkSync(join(root, "files", "real.png"), join(root, "latest.png"));
    const [file] = await run({
      paths: [`/api/session-artifacts/${session}/latest.png`],
    });
    // The CANONICAL spelling is what the reader gets, exactly as a grant does.
    assert.equal(file?.url, `/api/session-artifacts/${session}/files/real.png`);
    assert.equal(file?.name, "real.png");
  });

  test("refuses a path that is not a regular file", async () => {
    await assert.rejects(() => run({ paths: [dir] }), /is a directory/);

    // A socket is a real path that stats fine and cannot be shown: the branch
    // the directory case above never reaches.
    const socketPath = join(dir, "live.sock");
    const server = createServer();
    await new Promise<void>((done) => server.listen(socketPath, done));
    try {
      await assert.rejects(
        () => run({ paths: [socketPath] }),
        /Not a regular file/,
      );
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  test("accepts a working-directory-relative path", async () => {
    const [file] = await run({ paths: ["report.md"] });
    assert.equal(file?.url, `/api/files${dir}/report.md`);
  });

  test("names the label only on a single file", async () => {
    const files = await run({
      paths: [join(dir, "report.md"), join(dir, "plot.png")],
      label: "ignored",
    });
    assert.deepEqual(
      files.map((file) => file.label),
      ["report.md", "plot.png"],
    );
  });

  test("throws on a missing file and on a directory", async () => {
    await assert.rejects(
      () => run({ paths: [join(dir, "gone.md")] }),
      /File not found/,
    );
    await assert.rejects(() => run({ paths: [dir] }), /is a directory/);
  });
});
