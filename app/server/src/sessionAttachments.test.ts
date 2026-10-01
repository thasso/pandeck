import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "vitest";
import { DATA_DIR } from "./config.ts";
import {
  listSessionAttachments,
  persistUploadedAttachment,
  readSessionAttachmentBytes,
  resolveSessionAttachment,
  sessionAttachmentsDir,
  stageSessionAttachment,
} from "./sessionAttachments.ts";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("session attachment store", () => {
  test("persists an uploaded attachment and reads it back by id", () => {
    const sessionId = "s-upload";
    const record = persistUploadedAttachment(sessionId, {
      id: "att-1",
      name: "notes.txt",
      mimeType: "text/plain",
      data: b64("hello world"),
    });
    assert.equal(record.source, "upload");
    assert.equal(record.size, 11);
    assert.ok(record.path.startsWith(join(DATA_DIR, "attachments", sessionId)));

    const read = readSessionAttachmentBytes(sessionId, "att-1");
    assert.ok(read);
    assert.equal(read!.bytes.toString("utf8"), "hello world");
    assert.equal(read!.record.name, "notes.txt");
  });

  test("infers a MIME type from the file name when none is supplied", () => {
    const record = persistUploadedAttachment("s-mime", {
      id: "att-pdf",
      name: "report.pdf",
      mimeType: "",
      data: b64("%PDF-"),
    });
    assert.equal(record.mimeType, "application/pdf");
  });

  test("stages server-fetched bytes with a generated id", () => {
    const record = stageSessionAttachment("s-stage", {
      name: "summary.pdf",
      mimeType: "application/pdf",
      bytes: Buffer.from("%PDF-1"),
      source: "slack",
    });
    assert.equal(record.source, "slack");
    assert.ok(record.id.length > 0);
    const read = readSessionAttachmentBytes("s-stage", record.id);
    assert.equal(read!.bytes.toString("utf8"), "%PDF-1");
  });

  test("lists indexed attachments and orphan files written without an index", () => {
    const sessionId = "s-list";
    persistUploadedAttachment(sessionId, {
      id: "att-a",
      name: "a.txt",
      mimeType: "text/plain",
      data: b64("a"),
    });
    // A pre-existing file with no index entry (older code path / raw upload).
    const dir = sessionAttachmentsDir(sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "999-legacy-old.pdf"), Buffer.from("%PDF"));

    const listed = listSessionAttachments(sessionId);
    assert.equal(listed.length, 2);
    assert.ok(listed.some((r) => r.id === "att-a" && r.name === "a.txt"));
    const legacy = listed.find((r) => r.file === "999-legacy-old.pdf");
    assert.ok(legacy);
    assert.equal(legacy!.mimeType, "application/pdf");
    // The orphan is resolvable by its on-disk basename.
    assert.ok(resolveSessionAttachment(sessionId, "999-legacy-old.pdf"));
  });

  test("rejects path traversal and unknown ids", () => {
    const sessionId = "s-safe";
    persistUploadedAttachment(sessionId, {
      id: "att-x",
      name: "x.txt",
      mimeType: "text/plain",
      data: b64("x"),
    });
    assert.equal(resolveSessionAttachment(sessionId, "../../etc/passwd"), null);
    assert.equal(resolveSessionAttachment(sessionId, "index.json"), null);
    assert.equal(resolveSessionAttachment(sessionId, "does-not-exist"), null);
    assert.equal(readSessionAttachmentBytes(sessionId, "nope"), null);
  });

  test("returns an empty list for a session with no attachments", () => {
    assert.deepEqual(listSessionAttachments("s-empty"), []);
    assert.equal(existsSync(sessionAttachmentsDir("s-empty")), false);
  });
});
