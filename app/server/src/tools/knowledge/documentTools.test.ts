import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import type { ToolCallContext } from "../../mcp/tool.ts";
import { buildTestPdf } from "../../test/pdfFixtures.ts";
import { setPdfClaudeFallback } from "../../documentConversion.ts";
import {
  persistUploadedAttachment,
  stageSessionAttachment,
} from "../../sessionAttachments.ts";
import {
  addKnowledgeAsset,
  readKnowledgeGeneratedExtract,
} from "../../knowledgeBaseAssets.ts";
import { commitValidatedKnowledgeChanges } from "../../knowledgeBaseEntry.ts";
import { KnowledgeBaseStore } from "../../knowledgeBaseStore.ts";
import {
  convertPdfTool,
  setDocumentToolsStoreFactoryForTests,
} from "./documentTools.ts";

const BORN_DIGITAL_TEXT =
  "Quarterly Report Summary for the 2026 fiscal year covering revenue and outlook details";

const ctx: ToolCallContext = {
  toolCallId: "tool-test",
  session: {
    sessionId: "doc-tools-test",
    harness: "pi",
    agentType: "assistant",
    title: "Doc test",
  },
};

function details<T>(result: { details?: unknown }): T {
  return result.details as T;
}

function pdfB64(text?: string, pages = 1): string {
  return Buffer.from(
    buildTestPdf({
      pages,
      ...(text !== undefined ? { firstPageText: text } : {}),
    }),
  ).toString("base64");
}

describe("convert_pdf tool", () => {
  afterEach(() => {
    setPdfClaudeFallback(null);
  });

  test("converts a PDF attachment to Markdown", async () => {
    persistUploadedAttachment(ctx.session.sessionId, {
      id: "att-pdf",
      name: "report.pdf",
      mimeType: "application/pdf",
      data: pdfB64(BORN_DIGITAL_TEXT),
    });
    const result = await convertPdfTool.execute(
      { attachmentId: "att-pdf" },
      ctx,
    );
    const d = details<{
      engine: string;
      markdown: string;
      persisted: boolean;
      source: { kind: string };
    }>(result);
    assert.equal(d.engine, "pdf2md");
    assert.equal(d.source.kind, "attachment");
    assert.equal(d.persisted, false);
    assert.match(d.markdown, /Quarterly Report Summary/);
  });

  test("rejects a non-PDF attachment", async () => {
    persistUploadedAttachment(ctx.session.sessionId, {
      id: "att-txt",
      name: "notes.txt",
      mimeType: "text/plain",
      data: Buffer.from("hi").toString("base64"),
    });
    await assert.rejects(
      convertPdfTool.execute({ attachmentId: "att-txt" }, ctx),
      /not a PDF/,
    );
  });

  test("rejects persistToExtract on an attachment source", async () => {
    stageSessionAttachment(ctx.session.sessionId, {
      id: "att-p",
      name: "a.pdf",
      mimeType: "application/pdf",
      bytes: buildTestPdf({ pages: 1, firstPageText: BORN_DIGITAL_TEXT }),
      source: "upload",
    });
    await assert.rejects(
      convertPdfTool.execute(
        { attachmentId: "att-p", persistToExtract: true },
        ctx,
      ),
      /persistToExtract applies only to a KB asset/,
    );
  });

  test("requires exactly one source", async () => {
    await assert.rejects(convertPdfTool.execute({}, ctx), /exactly one source/);
    await assert.rejects(
      convertPdfTool.execute(
        { attachmentId: "x", assetPath: "assets/a.pdf" },
        ctx,
      ),
      /exactly one source/,
    );
  });

  test("truncates Markdown to maxChars", async () => {
    persistUploadedAttachment(ctx.session.sessionId, {
      id: "att-trunc",
      name: "r.pdf",
      mimeType: "application/pdf",
      data: pdfB64(BORN_DIGITAL_TEXT),
    });
    const result = await convertPdfTool.execute(
      { attachmentId: "att-trunc", maxChars: 10 },
      ctx,
    );
    const d = details<{ markdown: string; truncated: boolean }>(result);
    assert.equal(d.truncated, true);
    assert.equal(d.markdown.length, 10);
    assert.match(d.markdown, /…$/);
  });

  test("persists converted Markdown into a KB asset extract", async () => {
    const root = mkdtempSync(join(tmpdir(), "doc-tools-kb-"));
    const store = new KnowledgeBaseStore(root);
    setDocumentToolsStoreFactoryForTests(() => store);
    try {
      const meta = {
        actor: { kind: "system" as const, name: "test" },
        reason: "seed",
      };
      await commitValidatedKnowledgeChanges(
        store,
        [
          {
            op: "write",
            path: "docs/report/index.md",
            content: entryMarkdown("kb-report", "Report"),
          },
        ],
        meta,
      );
      await addKnowledgeAsset(
        store,
        {
          entryId: "kb-report",
          assetPath: "assets/report.pdf",
          content: buildTestPdf({ pages: 1, firstPageText: BORN_DIGITAL_TEXT }),
          mimeType: "application/pdf",
        },
        meta,
      );

      const result = await convertPdfTool.execute(
        {
          entryId: "kb-report",
          assetPath: "assets/report.pdf",
          persistToExtract: true,
          reason: "Store extract",
        },
        ctx,
      );
      const d = details<{
        engine: string;
        persisted: boolean;
        extractPath: string;
        source: { kind: string };
      }>(result);
      assert.equal(d.source.kind, "kb_asset");
      assert.equal(d.persisted, true);
      assert.ok(d.extractPath);

      const extract = await readKnowledgeGeneratedExtract(store, d.extractPath);
      assert.ok(extract);
      assert.match(extract!.text, /Quarterly Report Summary/);
    } finally {
      setDocumentToolsStoreFactoryForTests(null);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function entryMarkdown(id: string, title: string): string {
  return `---
kb:
  schema: 1
  id: ${id}
  type: reference
  title: ${title}
  status: active
  createdAt: "2026-07-08T09:00:00.000Z"
  updatedAt: "2026-07-08T10:00:00.000Z"
---
# ${title}
`;
}
