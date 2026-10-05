import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  persistUploadedAttachment,
  stageSessionAttachment,
} from "../../sessionAttachments.ts";
import { listAttachmentsTool, readAttachmentTool } from "./attachmentTools.ts";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const ctxFor = (sessionId: string) => ({
  toolCallId: "call",
  session: {
    sessionId,
    harness: "pi" as const,
    agentType: "assistant" as const,
  },
  signal: new AbortController().signal,
});

describe("session attachment tools", () => {
  test("list_attachments returns metadata only", async () => {
    const sessionId = "tool-list";
    persistUploadedAttachment(sessionId, {
      id: "a-1",
      name: "notes.txt",
      mimeType: "text/plain",
      data: b64("secret text"),
    });
    const result = await listAttachmentsTool.execute({}, ctxFor(sessionId));
    const details = result.details as any;
    assert.equal(details.count, 1);
    assert.equal(details.attachments[0].id, "a-1");
    assert.equal(details.attachments[0].mimeType, "text/plain");
    assert.doesNotMatch(
      JSON.stringify(details),
      /secret text/,
      "content is never inlined in a listing",
    );
  });

  test("read_attachment returns bounded text for text-like files", async () => {
    const sessionId = "tool-read-text";
    persistUploadedAttachment(sessionId, {
      id: "t-1",
      name: "a.txt",
      mimeType: "text/plain",
      data: b64("abcdef"),
    });
    const result = await readAttachmentTool.execute(
      { attachmentId: "t-1", maxCharacters: 3 },
      ctxFor(sessionId),
    );
    const details = result.details as any;
    assert.equal(details.status, "content");
    assert.equal(details.content, "ab…");
    assert.equal(details.contentTruncated, true);
  });

  test("read_attachment refuses raw binary bytes and points at the KB", async () => {
    const sessionId = "tool-read-bin";
    stageSessionAttachment(sessionId, {
      id: "b-1",
      name: "doc.pdf",
      mimeType: "application/pdf",
      bytes: Buffer.from("%PDF-1.7 binary"),
      source: "slack",
    });
    const result = await readAttachmentTool.execute(
      { attachmentId: "b-1" },
      ctxFor(sessionId),
    );
    const details = result.details as any;
    assert.equal(details.status, "binary");
    assert.match(details.hint, /kb_write/);
    assert.doesNotMatch(
      JSON.stringify(details),
      /%PDF/,
      "raw bytes are not returned",
    );
  });

  test("read_attachment throws on an unknown id", async () => {
    await assert.rejects(
      readAttachmentTool.execute(
        { attachmentId: "missing" },
        ctxFor("tool-missing"),
      ),
      /No session attachment/,
    );
  });
});
