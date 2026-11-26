import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "vitest";
import { DATA_DIR } from "./config.ts";
import {
  discardStagedAttachment,
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

  test("stages exactly the bytes of a view into a larger buffer, and a later change to them does not reach the file", () => {
    // A pooled Buffer or a subarray: only its own window is written.
    const backing = new Uint8Array(64).fill(0x2a);
    backing.set(Buffer.from("inside"), 10);
    const view = backing.subarray(10, 16);
    const record = stageSessionAttachment("s-stage-view", {
      name: "view.bin",
      mimeType: "application/octet-stream",
      bytes: view,
      source: "confluence",
    });
    assert.equal(record.size, 6);
    view.fill(0);
    backing.fill(0);
    const read = readSessionAttachmentBytes("s-stage-view", record.id);
    assert.equal(read!.bytes.toString("utf8"), "inside");
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

  test("discarding a staging id removes its index entry and every file holding its segment, and nothing else", () => {
    const sessionId = "s-discard";
    const owned = stageSessionAttachment(sessionId, {
      name: "a.bin",
      mimeType: "",
      bytes: Buffer.from("owned"),
      source: "agent",
      id: "p8a-0123456789abcdef",
    });
    const other = stageSessionAttachment(sessionId, {
      name: "b.bin",
      mimeType: "",
      bytes: Buffer.from("other"),
      source: "agent",
      id: "p8a-fedcba9876543210",
    });
    const dir = sessionAttachmentsDir(sessionId);
    // A partial write the index never recorded, and a directory that merely
    // carries the segment.
    writeFileSync(join(dir, "1-p8a-0123456789abcdef-partial.bin"), "half");
    mkdirSync(join(dir, "2-p8a-0123456789abcdef-dir"));

    discardStagedAttachment(sessionId, "p8a-0123456789abcdef");

    assert.equal(existsSync(owned.path), false);
    assert.equal(
      existsSync(join(dir, "1-p8a-0123456789abcdef-partial.bin")),
      false,
    );
    assert.equal(existsSync(join(dir, "2-p8a-0123456789abcdef-dir")), true);
    assert.equal(resolveSessionAttachment(sessionId, owned.id), null);
    assert.equal(resolveSessionAttachment(sessionId, other.id)?.size, 5);
    // Only regular files are listed, so the directory does not appear.
    assert.deepEqual(
      listSessionAttachments(sessionId).map((record) => record.id),
      [other.id],
    );
  });

  test("discarding matches only the staged naming rule: another attachment whose name holds the segment survives", () => {
    const sessionId = "s-discard-anchored";
    const stageId = "p8a-0123456789abcdef";
    const owned = stageSessionAttachment(sessionId, {
      name: "a.bin",
      mimeType: "",
      bytes: Buffer.from("owned"),
      source: "agent",
      id: stageId,
    });
    // Pre-existing: an indexed attachment whose name carries `-<stageId>-`,
    // and an unindexed file with the segment after another id.
    const named = stageSessionAttachment(sessionId, {
      name: `report-${stageId}-final.pdf`,
      mimeType: "",
      bytes: Buffer.from("named"),
      source: "agent",
      id: "att-other",
    });
    const dir = sessionAttachmentsDir(sessionId);
    const orphan = join(dir, `3-att-x-${stageId}-copy.bin`);
    writeFileSync(orphan, "orphan");

    discardStagedAttachment(sessionId, stageId);

    assert.equal(existsSync(owned.path), false);
    assert.equal(existsSync(named.path), true);
    assert.equal(existsSync(orphan), true);
    assert.equal(resolveSessionAttachment(sessionId, named.id)?.size, 5);
  });

  test("discarding refuses an id that is not its own safe file name, and tolerates a session with nothing staged", () => {
    for (const id of ["", "a/b", "../x", "with space"])
      assert.throws(
        () => discardStagedAttachment("s-discard-bad", id),
        TypeError,
      );
    discardStagedAttachment("s-never-staged", "p8a-0000000000000000");
  });
});
