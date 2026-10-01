import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import type { ToolCallContext } from "../../mcp/tool.ts";
import { KnowledgeBaseStore } from "../../knowledgeBaseStore.ts";
import { stageSessionAttachment } from "../../sessionAttachments.ts";
import {
  kbAddAssetTool,
  kbDiffTool,
  kbEditEntryTool,
  kbGetEntryTool,
  kbHistoryTool,
  kbListAssetsTool,
  kbMoveEntryTool,
  kbSearchTool,
  kbShowEntryTool,
  kbTreeTool,
  kbWriteEntryTool,
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

function entryMarkdown(
  id: string,
  title: string,
  body: string,
  updated = "2026-07-08T10:00:00.000Z",
): string {
  return `---
kb:
  schema: 1
  id: ${id}
  type: note
  title: ${title}
  status: active
  summary: Summary for ${title}
  tags:
    - test
  createdAt: "2026-07-08T09:00:00.000Z"
  updatedAt: "${updated}"
---
${body}
`;
}

function jsonText(
  result: Awaited<ReturnType<typeof kbWriteEntryTool.execute>>,
): string {
  return result.content[0]?.type === "text" ? result.content[0].text : "";
}

function details<T>(result: { details?: unknown }): T {
  return result.details as T;
}

describe("first-class KB tools", () => {
  test("write/search/get/tree/edit/asset/move/history/diff success paths are compact by default", async () => {
    const write = await kbWriteEntryTool.execute(
      {
        path: "notes/alpha",
        content: entryMarkdown(
          "kb-alpha",
          "Alpha Entry",
          "# Alpha\n\nSecret full body prose that should not leak into compact tree output.\n",
        ),
        reason: "Add alpha entry",
      },
      ctx,
    );
    assert.match(jsonText(write), /"action":"write_entry"/);

    const compactEntry = await kbGetEntryTool.execute(
      { entryId: "kb-alpha" },
      ctx,
    );
    assert.doesNotMatch(
      jsonText(compactEntry),
      /Secret full body prose/,
      "compact get does not include entry body",
    );

    const fullEntry = await kbGetEntryTool.execute(
      { entryId: "kb-alpha", detail: "full", maxChars: 5000 },
      ctx,
    );
    assert.match(
      jsonText(fullEntry),
      /Secret full body prose/,
      "full get explicitly includes bounded content",
    );

    const tree = await kbTreeTool.execute({}, ctx);
    const treePayload = JSON.parse(jsonText(tree)) as {
      items: unknown[];
      counts: { entries: number };
    };
    assert.equal(treePayload.counts.entries, 1);
    assert.doesNotMatch(
      jsonText(tree),
      /Secret full body prose/,
      "tree output excludes entry bodies",
    );

    const search = await kbSearchTool.execute(
      { query: "Alpha", maxResults: 5 },
      ctx,
    );
    const searchPayload = details<{ results: { id: string }[] }>(search);
    assert.equal(searchPayload.results[0]?.id, "kb-alpha");
    assert.doesNotMatch(
      jsonText(search),
      /Secret full body prose/,
      "compact search returns snippets, not full entry bodies",
    );

    const edited = await kbEditEntryTool.execute(
      {
        entryId: "kb-alpha",
        edits: [
          { oldText: "Secret full body prose", newText: "Updated body prose" },
        ],
        reason: "Update alpha body",
      },
      ctx,
    );
    assert.equal(details<{ replacements: number }>(edited).replacements, 1);

    const asset = await kbAddAssetTool.execute(
      {
        entryId: "kb-alpha",
        assetPath: "assets/source.txt",
        contentText: "asset text",
        mimeType: "text/plain",
        reason: "Add source asset",
      },
      ctx,
    );
    assert.equal(
      details<{ asset: { path: string; exists: boolean } }>(asset).asset.path,
      "assets/source.txt",
    );

    const assets = await kbListAssetsTool.execute({ entryId: "kb-alpha" }, ctx);
    assert.match(jsonText(assets), /source.txt/);
    assert.doesNotMatch(
      jsonText(assets),
      /asset text/,
      "asset list does not dump file content",
    );

    const moved = await kbMoveEntryTool.execute(
      { entryId: "kb-alpha", toPath: "archive/alpha", reason: "Move alpha" },
      ctx,
    );
    assert.equal(
      details<{ entry: { path: string } }>(moved).entry.path,
      "archive/alpha/index.md",
    );

    const history = await kbHistoryTool.execute(
      { entryId: "kb-alpha", limit: 10 },
      ctx,
    );
    const historyPayload = details<{ history: { subject: string }[] }>(history);
    assert.ok(
      historyPayload.history.some((row) => row.subject === "Move alpha"),
    );
    assert.ok(
      historyPayload.history.some((row) => row.subject === "Update alpha body"),
    );
    assert.ok(
      historyPayload.history.some((row) => row.subject === "Add alpha entry"),
    );

    const firstCommit = details<{ commit: { commit: string } }>(write).commit
      .commit;
    const diff = await kbDiffTool.execute(
      { from: firstCommit, entryId: "kb-alpha", maxChars: 10_000 },
      ctx,
    );
    const diffPayload = details<{ patch: string; truncated: boolean }>(diff);
    assert.match(diffPayload.patch, /archive\/alpha/);
    assert.equal(diffPayload.truncated, false);
  });

  test("kb_show_entry cards the entry from the index and refuses an unknown one", async () => {
    await kbWriteEntryTool.execute(
      {
        path: "notes/alpha",
        content: entryMarkdown(
          "kb-alpha",
          "Alpha Entry",
          "# Alpha\n\nSecret full body prose that never belongs on a card.\n",
        ),
        reason: "Add alpha entry",
      },
      ctx,
    );

    const shown = await kbShowEntryTool.execute(
      { entryPath: "notes/alpha", note: "  Rewrote   the summary\n" },
      ctx,
    );
    const payload = details<{
      renderKind: string;
      card: {
        entryId: string;
        title: string;
        path: string;
        summary?: string;
        note?: string;
      };
    }>(shown);
    assert.equal(payload.renderKind, "knowledgeEntry");
    // Identity is re-spelled from the index, so a path-addressed call still
    // cards the durable id the web surfaces open.
    assert.equal(payload.card.entryId, "kb-alpha");
    assert.equal(payload.card.title, "Alpha Entry");
    assert.equal(payload.card.path, "notes/alpha");
    assert.equal(payload.card.summary, "Summary for Alpha Entry");
    assert.equal(payload.card.note, "Rewrote the summary");
    assert.doesNotMatch(
      jsonText(shown),
      /Secret full body prose/,
      "the card carries no entry content",
    );

    await assert.rejects(
      () => kbShowEntryTool.execute({ entryId: "kb-missing" }, ctx),
      /not found/,
    );
  });

  test("kb_add_asset copies a raw session attachment by id without inlining bytes", async () => {
    await kbWriteEntryTool.execute(
      {
        path: "notes/att",
        content: entryMarkdown("kb-att", "Attachment Entry", "# Att\n\nBody\n"),
        reason: "Add att entry",
      },
      ctx,
    );
    // A binary file staged in the calling session's attachment store.
    const bytes = Buffer.from("%PDF-1.7 raw pdf bytes");
    stageSessionAttachment(ctx.session.sessionId, {
      id: "up-1",
      name: "spec.pdf",
      mimeType: "application/pdf",
      bytes,
      source: "upload",
    });

    const added = await kbAddAssetTool.execute(
      {
        entryId: "kb-att",
        assetPath: "assets/spec.pdf",
        sourceAttachmentId: "up-1",
        reason: "Copy uploaded PDF",
      },
      ctx,
    );
    const asset = details<{
      asset: { path: string; sizeBytes?: number; mimeType?: string };
    }>(added).asset;
    assert.equal(asset.path, "assets/spec.pdf");
    assert.equal(asset.sizeBytes, bytes.byteLength);
    assert.equal(asset.mimeType, "application/pdf");

    await assert.rejects(
      kbAddAssetTool.execute(
        {
          entryId: "kb-att",
          assetPath: "assets/x.pdf",
          sourceAttachmentId: "missing",
          reason: "x",
        },
        ctx,
      ),
      /No session attachment/,
    );
    await assert.rejects(
      kbAddAssetTool.execute(
        {
          entryId: "kb-att",
          assetPath: "assets/y.pdf",
          sourceAttachmentId: "up-1",
          contentText: "z",
          reason: "x",
        },
        ctx,
      ),
      /exactly one of/,
    );
  });

  test("rejects invalid entry frontmatter before writing", async () => {
    await assert.rejects(
      () =>
        kbWriteEntryTool.execute(
          {
            path: "bad",
            content: "# Missing frontmatter\n",
            reason: "Bad write",
          },
          ctx,
        ),
      /frontmatter/,
    );
  });

  test("rejects invalid paths before writing", async () => {
    await assert.rejects(
      () =>
        kbWriteEntryTool.execute(
          {
            path: "../escape",
            content: entryMarkdown("kb-escape", "Escape", "body"),
            reason: "Bad path",
          },
          ctx,
        ),
      /relative.*traversal/,
    );
  });

  test("rejects duplicate KB ids across entries", async () => {
    await kbWriteEntryTool.execute(
      {
        path: "one",
        content: entryMarkdown("kb-dupe", "One", "one"),
        reason: "Add one",
      },
      ctx,
    );
    await assert.rejects(
      () =>
        kbWriteEntryTool.execute(
          {
            path: "two",
            content: entryMarkdown("kb-dupe", "Two", "two"),
            reason: "Add duplicate",
          },
          ctx,
        ),
      /Duplicate KB entry id/,
    );
  });
});
