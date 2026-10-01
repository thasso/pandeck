/**
 * What a bounded attachment read owes when the descriptor answers in pieces
 * ([Task-633](pa://task/633)).
 *
 * `FileHandle.read` may return fewer bytes than it was asked for, and nothing
 * about a successful call says it reached EOF. Treating the first answer as the
 * whole file is how a silently truncated prefix of somebody's binary attachment
 * ends up inside a commit — so the read loops, and the caller checks what it got
 * against the size it budgeted for.
 *
 * The short read is forced here, because a real filesystem rarely obliges.
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, test, vi } from "vitest";

/** How many bytes each `read` is allowed to answer with. */
const CHUNK = 7;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (path: string, flags?: number | string, mode?: number) => {
      const handle = await actual.open(path, flags, mode);
      const read = handle.read.bind(handle);
      return Object.assign(handle, {
        read: (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number | null,
        ) => read(buffer, offset, Math.min(length, CHUNK), position),
      });
    },
  };
});

const { persistUploadedAttachment, readSessionAttachmentUpTo } =
  await import("./sessionAttachments.ts");

describe("a bounded attachment read against a descriptor that short-reads", () => {
  test("returns the whole file, not the first chunk", async () => {
    const content = Buffer.alloc(1_000, 3);
    const record = persistUploadedAttachment("s-chunked", {
      id: "att-chunked",
      name: "chunked.bin",
      mimeType: "application/octet-stream",
      data: content.toString("base64"),
    });

    const read = await readSessionAttachmentUpTo(record, content.byteLength);

    assert.equal(read.byteLength, content.byteLength);
    assert.ok(read.equals(content));
  });

  test("still stops at one byte past the limit", async () => {
    const record = persistUploadedAttachment("s-chunked", {
      id: "att-chunked-big",
      name: "big.bin",
      mimeType: "application/octet-stream",
      data: Buffer.alloc(1_000, 3).toString("base64"),
    });

    const read = await readSessionAttachmentUpTo(record, 100);

    assert.equal(read.byteLength, 101);
  });
});
