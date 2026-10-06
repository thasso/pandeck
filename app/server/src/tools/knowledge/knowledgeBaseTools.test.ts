import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import type { ToolCallContext, ToolResult } from "../../mcp/tool.ts";
import { KnowledgeBaseStore } from "../../knowledgeBaseStore.ts";
import { stageSessionAttachment } from "../../sessionAttachments.ts";
import { knowledgeLinkStore } from "../../db/knowledgeLinkStore.ts";
import { knowledgeLegacyPath } from "../../knowledgeLegacyLinks.ts";
import {
  kbEditTool,
  kbHistoryTool,
  kbListTool,
  kbMoveTool,
  kbReadTool,
  kbSearchTool,
  kbShowTool,
  kbWriteTool,
  setKnowledgeBaseToolStoreFactoryForTests,
} from "./knowledgeBaseTools.ts";

let root: string;
let store: KnowledgeBaseStore;

const ctx: ToolCallContext = {
  toolCallId: "tool-test",
  session: {
    sessionId: "sess-test",
    harness: "pi",
    agentType: "workshop",
    title: "Workshop test",
  },
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kb-tools-test-"));
  store = new KnowledgeBaseStore(root);
  setKnowledgeBaseToolStoreFactoryForTests(() => store);
});

afterEach(() => {
  setKnowledgeBaseToolStoreFactoryForTests(null);
  rmSync(root, { recursive: true, force: true });
});

function payload(result: ToolResult): Record<string, unknown> {
  return result.details as Record<string, unknown>;
}

async function write(path: string, content: string): Promise<void> {
  await kbWriteTool.execute({ path, content, reason: `write ${path}` }, ctx);
}

describe("reading", () => {
  test("lists, searches and reads files with their titles", async () => {
    await write(
      "projects/acme/plan.md",
      "---\ntitle: Acme plan\n---\n# Plan\n\nMove billing first.\n",
    );
    await write("notes.md", "# Notes\n");

    const listed = payload(await kbListTool.execute({}, ctx));
    assert.deepEqual(listed.items, [
      { path: "notes.md", type: "file", sizeBytes: 8, title: "Notes" },
      { path: "projects", type: "dir" },
      { path: "projects/acme", type: "dir" },
    ]);
    // Deeper files are below the depth limit, not cut: their folders are listed.
    assert.equal(listed.truncated, false);

    const found = payload(
      await kbSearchTool.execute({ query: "billing" }, ctx),
    );
    assert.deepEqual(
      (found.results as { path: string; title: string }[]).map((hit) => [
        hit.path,
        hit.title,
      ]),
      [["projects/acme/plan.md", "Acme plan"]],
    );

    const read = payload(
      await kbReadTool.execute({ path: "projects/acme/plan.md" }, ctx),
    );
    assert.equal(read.title, "Acme plan");
    assert.equal(read.link, "pa://knowledge/projects/acme/plan.md");
    assert.equal(read.absolutePath, join(root, "projects/acme/plan.md"));
    assert.match(read.content as string, /Move billing first/);
  });

  test("reads a long file in windows and a binary file not at all", async () => {
    await write(
      "long.md",
      Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n"),
    );
    const first = payload(
      await kbReadTool.execute({ path: "long.md", maxChars: 40 }, ctx),
    );
    assert.equal(first.startLine, 1);
    assert.equal(first.endLine, 5);
    const next = payload(
      await kbReadTool.execute(
        { path: "long.md", startLine: first.nextStartLine as number },
        ctx,
      ),
    );
    assert.match(next.content as string, /^line 6\n/);
    assert.equal(next.nextStartLine, undefined);

    await kbWriteTool.execute(
      {
        path: "files/scan.pdf",
        contentBase64: Buffer.from([37, 80, 0, 1]).toString("base64"),
        reason: "add scan",
      },
      ctx,
    );
    const binary = payload(
      await kbReadTool.execute({ path: "files/scan.pdf" }, ctx),
    );
    assert.equal(binary.binary, true);
    assert.equal(binary.content, undefined);
  });
});

describe("writing", () => {
  test("writes, edits and moves files, each one commit", async () => {
    await write("draft.md", "# Draft\n\nFirst take.\n");
    const edited = payload(
      await kbEditTool.execute(
        {
          path: "draft.md",
          edits: [{ oldText: "First take.", newText: "Second take." }],
          reason: "revise",
        },
        ctx,
      ),
    );
    assert.equal(edited.replacements, 1);
    await kbMoveTool.execute(
      { from: "draft.md", to: "final/plan.md", reason: "file it" },
      ctx,
    );
    assert.equal(
      await readFile(join(root, "final/plan.md"), "utf8"),
      "# Draft\n\nSecond take.\n",
    );
    const history = payload(
      await kbHistoryTool.execute({ path: "final/plan.md" }, ctx),
    ).history as { subject: string; sessionId?: string }[];
    assert.deepEqual(
      history.map((row) => row.subject),
      ["file it", "revise", "write draft.md"],
    );
    assert.equal(history[0]?.sessionId, "sess-test");
  });

  test("returns one commit's patch, bounded", async () => {
    await write("a.md", "alpha\n");
    const [head] = await store.history({ limit: 1 });
    const patch = payload(
      await kbHistoryTool.execute({ commit: head!.shortCommit }, ctx),
    );
    assert.match(patch.patch as string, /\+alpha/);
    assert.equal(patch.truncated, false);
  });

  test("copies a session attachment without its bytes passing through", async () => {
    stageSessionAttachment(ctx.session.sessionId, {
      id: "up-1",
      name: "spec.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array([37, 80, 68, 70, 0]),
      source: "upload",
    });
    await kbWriteTool.execute(
      {
        path: "specs/spec.pdf",
        sourceAttachmentId: "up-1",
        reason: "keep spec",
      },
      ctx,
    );
    assert.deepEqual(
      [...(await readFile(join(root, "specs/spec.pdf")))],
      [37, 80, 68, 70, 0],
    );
  });

  test("refuses a file the user is editing, and an ambiguous edit", async () => {
    await write("shared.md", "one\none\n");
    await assert.rejects(
      kbEditTool.execute(
        {
          path: "shared.md",
          edits: [{ oldText: "one", newText: "two" }],
          reason: "x",
        },
        ctx,
      ),
      /not unique/,
    );
    await writeFile(join(root, "shared.md"), "the user's edit\n");
    await assert.rejects(
      write("shared.md", "agent\n"),
      /Uncommitted changes[^]*commit or discard/,
    );
    assert.equal(
      await readFile(join(root, "shared.md"), "utf8"),
      "the user's edit\n",
    );
  });

  test("requires exactly one content source and a reason", async () => {
    await assert.rejects(
      kbWriteTool.execute({ path: "x.md", reason: "r" }, ctx),
      /exactly one/,
    );
    await assert.rejects(
      kbWriteTool.execute({ path: "x.md", content: "x", reason: " " }, ctx),
      /reason is required/,
    );
  });
});

describe("links", () => {
  test("takes a pa://knowledge link, old id links included, and follows moves", async () => {
    await write("old/plan.md", "# Plan\n");
    knowledgeLinkStore.putLegacyLinks(
      new Map([["kb-tools-plan", "old/plan.md"]]),
    );
    for (const path of [
      "pa://knowledge/old/plan.md",
      "pa://knowledge/kb-tools-plan",
    ])
      assert.equal(
        payload(await kbReadTool.execute({ path }, ctx)).path,
        "old/plan.md",
      );
    await assert.rejects(
      kbReadTool.execute({ path: "pa://task/1" }, ctx),
      /not a pa:\/\/knowledge link/,
    );
    await kbMoveTool.execute(
      { from: "old", to: "archive", reason: "archive" },
      ctx,
    );
    assert.equal(knowledgeLegacyPath("kb-tools-plan"), "archive/plan.md");
  });
});

describe("showing", () => {
  test("cards an existing file under the title the folder gives it", async () => {
    await write(
      "brief.md",
      "---\ntitle: Launch brief\nsummary: What ships when.\n---\nBody\n",
    );
    const shown = payload(
      await kbShowTool.execute(
        { path: "brief.md", note: "  Updated   the dates  " },
        ctx,
      ),
    );
    assert.deepEqual(shown, {
      renderKind: "knowledgeEntry",
      version: 2,
      card: {
        path: "brief.md",
        title: "Launch brief",
        summary: "What ships when.",
        note: "Updated the dates",
      },
    });
    await assert.rejects(
      kbShowTool.execute({ path: "missing.md" }, ctx),
      /No file/,
    );
  });
});
