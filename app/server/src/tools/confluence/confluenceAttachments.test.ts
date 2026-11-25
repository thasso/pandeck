/**
 * The freeze options and the chunked staged reader a client-mode upload
 * builds on (Task-1441 P8a, v03 K4 and v02 AC5 step 4). The local tool's
 * defaults are pinned by the upload oracle; these cover what is new.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { patterned } from "../../test/forcedGc.ts";
import {
  resolveSessionAttachment,
  sessionAttachmentsDir,
  stageSessionAttachment,
} from "../../sessionAttachments.ts";
import {
  MAX_ATTACHMENT_BYTES,
  UploadOverLimitError,
  freezeUploadSource,
  readStagedChunks,
} from "./confluenceAttachments.ts";

const MIB = 1024 * 1024;
const dir = mkdtempSync(join(tmpdir(), "confluence-attachments-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

function hostFile(name: string, bytes: Uint8Array): string {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

describe("freezeUploadSource's options", () => {
  test("a host path is staged under the caller's id, and its file carries that segment", async () => {
    const bytes = patterned(3 * MIB + 7, 3);
    const path = hostFile("owned.bin", bytes);
    const frozen = await freezeUploadSource(
      "s-freeze-owned",
      { sourcePath: path },
      { stageId: "p8a-00112233445566aa", limitBytes: 4 * MIB },
    );
    expect(frozen).toMatchObject({
      stagedAttachmentId: "p8a-00112233445566aa",
      size: bytes.byteLength,
      sha256: sha256(bytes),
      source: path,
    });
    expect(
      readdirSync(sessionAttachmentsDir("s-freeze-owned")).filter((name) =>
        name.includes("-p8a-00112233445566aa-"),
      ),
    ).toHaveLength(1);
  });

  test("reading past the budget left is a typed refusal, and nothing is staged", async () => {
    const path = hostFile("over.bin", patterned(2 * MIB + 1, 4));
    await expect(
      freezeUploadSource(
        "s-freeze-over",
        { sourcePath: path },
        { stageId: "p8a-00112233445566bb", limitBytes: 2 * MIB },
      ),
    ).rejects.toBeInstanceOf(UploadOverLimitError);
    expect(
      resolveSessionAttachment("s-freeze-over", "p8a-00112233445566bb"),
    ).toBeNull();
  });

  test("the budget bounds a session attachment's read too", async () => {
    const record = stageSessionAttachment("s-freeze-session", {
      name: "kept.bin",
      mimeType: "",
      bytes: patterned(MIB + 1, 5),
      source: "upload",
    });
    await expect(
      freezeUploadSource(
        "s-freeze-session",
        { sourceAttachmentId: record.id },
        { limitBytes: MIB },
      ),
    ).rejects.toBeInstanceOf(UploadOverLimitError);
    const frozen = await freezeUploadSource(
      "s-freeze-session",
      { sourceAttachmentId: record.id },
      { limitBytes: MIB + 1 },
    );
    expect(frozen.stagedAttachmentId).toBe(record.id);
  });

  test("without options a file past the per-file cap keeps the local text", async () => {
    const path = join(dir, "sparse.bin");
    writeFileSync(path, "");
    truncateSync(path, MAX_ATTACHMENT_BYTES + 1);
    await expect(
      freezeUploadSource("s-freeze-cap", { sourcePath: path }),
    ).rejects.toThrow(
      `is larger than ${MAX_ATTACHMENT_BYTES} bytes; attachments above that are not uploaded.`,
    );
  }, 30_000);
});

describe("readStagedChunks", () => {
  function staged(sessionId: string, bytes: Uint8Array) {
    return stageSessionAttachment(sessionId, {
      name: "src.bin",
      mimeType: "",
      bytes,
      source: "agent",
    });
  }

  test("sends fresh chunks of at most 1 MiB in order and reports the length and digest", async () => {
    const bytes = patterned(2 * MIB + MIB / 2, 6);
    const record = staged("s-chunks", bytes);
    const sent: { chunk: Uint8Array; offset: number }[] = [];
    const read = await readStagedChunks(
      "s-chunks",
      { stagedAttachmentId: record.id, size: bytes.byteLength },
      async (chunk, offset) => {
        sent.push({ chunk, offset });
      },
    );
    expect(read).toEqual({ size: bytes.byteLength, sha256: sha256(bytes) });
    expect(sent.map(({ offset }) => offset)).toEqual([0, MIB, 2 * MIB]);
    expect(sent.map(({ chunk }) => chunk.byteLength)).toEqual([
      MIB,
      MIB,
      MIB / 2,
    ]);
    expect(new Set(sent.map(({ chunk }) => chunk.buffer)).size).toBe(3);
    expect(Buffer.concat(sent.map(({ chunk }) => chunk))).toEqual(
      Buffer.from(bytes),
    );
  });

  test("awaits each send before reading the next chunk", async () => {
    const bytes = patterned(3 * MIB, 7);
    const record = staged("s-chunks-await", bytes);
    let inFlight = 0;
    let most = 0;
    await readStagedChunks(
      "s-chunks-await",
      { stagedAttachmentId: record.id, size: bytes.byteLength },
      async () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
      },
    );
    expect(most).toBe(1);
  });

  test("a file that grew reads one byte more than approved and never sends it", async () => {
    const bytes = patterned(MIB, 8);
    const record = staged("s-chunks-grew", bytes);
    appendFileSync(record.path, Buffer.alloc(5 * MIB, 1));
    let sentBytes = 0;
    const read = await readStagedChunks(
      "s-chunks-grew",
      { stagedAttachmentId: record.id, size: bytes.byteLength },
      async (chunk) => {
        sentBytes += chunk.byteLength;
      },
    );
    expect(read?.size).toBe(MIB + 1);
    expect(sentBytes).toBe(MIB);
  });

  test("a file that shrank or changed reports what it read, for the caller to refuse", async () => {
    const bytes = patterned(2 * MIB, 9);
    const record = staged("s-chunks-shrank", bytes);
    truncateSync(record.path, MIB + 3);
    const read = await readStagedChunks(
      "s-chunks-shrank",
      { stagedAttachmentId: record.id, size: bytes.byteLength },
      async () => {},
    );
    expect(read).toEqual({
      size: MIB + 3,
      sha256: sha256(bytes.subarray(0, MIB + 3)),
    });
  });

  test("a staged record that is gone reads as null and sends nothing", async () => {
    let sends = 0;
    const read = await readStagedChunks(
      "s-chunks-gone",
      { stagedAttachmentId: "p8a-ffffffffffffffff", size: 10 },
      async () => {
        sends += 1;
      },
    );
    expect(read).toBeNull();
    expect(sends).toBe(0);
  });

  test("a failing send stops the read and propagates", async () => {
    const bytes = patterned(3 * MIB, 10);
    const record = staged("s-chunks-fail", bytes);
    let sends = 0;
    await expect(
      readStagedChunks(
        "s-chunks-fail",
        { stagedAttachmentId: record.id, size: bytes.byteLength },
        async () => {
          sends += 1;
          throw new Error("the put timed out");
        },
      ),
    ).rejects.toThrow("the put timed out");
    expect(sends).toBe(1);
  });
});
