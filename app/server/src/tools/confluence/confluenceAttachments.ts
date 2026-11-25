/**
 * Confluence page attachments on this host: reading one into the session
 * attachment store, and the two upload seams the shared mutation core
 * (`../../confluenceAttachmentChange.ts`) takes from the local tool.
 *
 * What uploads is exactly what was approved. The bytes are frozen in the
 * session attachment store when the proposal is staged (`freezeUploadSource`),
 * and apply checks their SHA-256 (`readStagedBytes`), so a host file edited
 * while the card waited is not what lands on the page.
 *
 * A client-mode proposal freezes under a work budget shared by its items
 * (Task-1441 P8a, v03 K4): `freezeUploadSource` takes the bytes still left
 * (`limitBytes`) and, for a host path, the staging id the caller chose before
 * any write (`stageId`), so it can discard a partial copy it owns. Apply then
 * streams the frozen bytes to the gateway one chunk at a time
 * (`readStagedChunks`). Without the options the local tool behaves as before.
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import type { ConfluenceAttachmentMutationDisplay } from "@assistant/shared";
import type {
  AttachmentChangeRequest,
  FrozenUpload,
} from "../../confluenceAttachmentChange.ts";
import {
  CONFLUENCE_ATTACHMENT_MAX_BYTES,
  downloadConfluenceAttachment,
} from "../../confluenceDownload.ts";
import {
  resolveSessionAttachment,
  stageSessionAttachment,
} from "../../sessionAttachments.ts";

/** Upper bound for one attachment moved in either direction. */
export const MAX_ATTACHMENT_BYTES = CONFLUENCE_ATTACHMENT_MAX_BYTES;

/** Download one attachment's current bytes, refusing past `maxBytes`. */
export const downloadAttachment = downloadConfluenceAttachment;

/** The bytes one staged chunk carries, read and sent at a time. */
const CHUNK_BYTES = 1024 * 1024;

/**
 * A freeze read more than the work budget left (`limitBytes`) but not more
 * than `MAX_ATTACHMENT_BYTES`; past that the local per-file text wins.
 */
export class UploadOverLimitError extends Error {
  constructor() {
    super("The upload is larger than the work budget left for this proposal.");
    this.name = "UploadOverLimitError";
  }
}

/** Optional freeze bounds; both default to the local tool's behaviour. */
export interface FreezeUploadOptions {
  /** The most bytes this freeze may read; at most one chunk more is read. */
  limitBytes?: number;
  /** The id a host-path copy is staged under, chosen before any write. */
  stageId?: string;
}

/**
 * Copy the upload's bytes into the session attachment store (a host path) or
 * pin the ones already there (a session attachment), with their digest: the
 * local `freezeUpload` seam.
 */
export async function freezeUploadSource(
  sessionId: string,
  request: AttachmentChangeRequest,
  options: FreezeUploadOptions = {},
): Promise<FrozenUpload> {
  const limit = options.limitBytes ?? MAX_ATTACHMENT_BYTES;
  const attachmentRef = request.sourceAttachmentId?.trim();
  const sourcePath = request.sourcePath?.trim();
  if (Boolean(attachmentRef) === Boolean(sourcePath))
    throw new Error(
      "uploadAttachment needs exactly one of sourceAttachmentId or sourcePath.",
    );
  if (attachmentRef) {
    const record = resolveSessionAttachment(sessionId, attachmentRef);
    if (!record)
      throw new Error(
        `No session attachment found for id "${attachmentRef}". Use list_attachments to see available attachments.`,
      );
    const bytes = await readUploadBytes(record.path, record.name, limit);
    return {
      name: record.name,
      mimeType: record.mimeType,
      size: bytes.byteLength,
      sha256: sha256Of(bytes),
      source: `session attachment ${record.name}`,
      stagedAttachmentId: record.id,
    };
  }
  if (!isAbsolute(sourcePath ?? ""))
    throw new Error("sourcePath must be an absolute path on this host.");
  const path = resolve(sourcePath ?? "");
  if (!statSync(path, { throwIfNoEntry: false })?.isFile())
    throw new Error(`"${path}" is not a file.`);
  const bytes = await readUploadBytes(path, path, limit);
  const record = stageSessionAttachment(sessionId, {
    name: basename(path),
    mimeType: "",
    bytes,
    source: "agent",
    ...(options.stageId === undefined ? {} : { id: options.stageId }),
  });
  return {
    name: record.name,
    mimeType: record.mimeType,
    size: record.size,
    sha256: sha256Of(bytes),
    source: path,
    stagedAttachmentId: record.id,
  };
}

/**
 * Read a file for upload, holding at most `min(MAX_ATTACHMENT_BYTES, limit)`
 * plus one chunk. The bound is applied to the bytes actually read, not to a
 * size recorded or stat-ed earlier: a file that grew since would otherwise be
 * read whole into memory before anything noticed.
 */
async function readUploadBytes(
  path: string,
  name: string,
  limit = MAX_ATTACHMENT_BYTES,
): Promise<Buffer> {
  const handle = await open(path, "r");
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = Buffer.alloc(CHUNK_BYTES);
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_ATTACHMENT_BYTES)
        throw new Error(
          `"${name}" is larger than ${MAX_ATTACHMENT_BYTES} bytes; attachments above that are not uploaded.`,
        );
      if (total > limit) throw new UploadOverLimitError();
      chunks.push(chunk.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  if (total === 0) throw new Error(`"${name}" is empty.`);
  return Buffer.concat(chunks, total);
}

function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The approved bytes, proven unchanged: the local `stagedBytes` seam. A staged
 * file that went missing or changed is a refusal: uploading anything else
 * would not be what the user approved.
 */
export async function readStagedBytes(
  sessionId: string,
  attachment: ConfluenceAttachmentMutationDisplay,
): Promise<Buffer> {
  const staged = attachment.stagedAttachmentId
    ? resolveSessionAttachment(sessionId, attachment.stagedAttachmentId)
    : null;
  if (!staged || !attachment.sha256)
    throw new Error(
      `The file proposed for ${attachment.fileName} is no longer available. Propose the upload again.`,
    );
  const bytes = await readUploadBytes(staged.path, attachment.fileName);
  if (sha256Of(bytes) !== attachment.sha256)
    throw new Error(
      `The file proposed for ${attachment.fileName} changed after it was approved for upload. Propose the upload again.`,
    );
  return bytes;
}

/** What `readStagedChunks` read: compare both with the approved values. */
export interface StagedRead {
  /** Bytes read; `size + 1` when the file grew past the approved size. */
  size: number;
  sha256: string;
}

/**
 * Stream one staged source in chunks of at most 1 MiB, each a fresh buffer,
 * awaiting `send` for every chunk before reading the next, so one chunk is
 * held at a time (Task-1441 P8a, v02 AC5 step 4).
 *
 * At most `size + 1` bytes are read, and only bytes within `size` are sent:
 * the extra byte is what shows a file that grew. The result is `null` when
 * the staged record is gone; otherwise the caller compares the length and
 * digest with the approved ones before anything is applied.
 */
export async function readStagedChunks(
  sessionId: string,
  source: { stagedAttachmentId: string; size: number },
  send: (chunk: Uint8Array, offset: number) => Promise<void>,
): Promise<StagedRead | null> {
  const staged = resolveSessionAttachment(sessionId, source.stagedAttachmentId);
  if (!staged) return null;
  let handle;
  try {
    handle = await open(staged.path, "r");
  } catch {
    return null;
  }
  const hash = createHash("sha256");
  let total = 0;
  try {
    while (total <= source.size) {
      const want = Math.min(CHUNK_BYTES, source.size + 1 - total);
      const chunk = new Uint8Array(want);
      let filled = 0;
      while (filled < want) {
        const { bytesRead } = await handle.read(chunk, filled, want - filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      if (filled === 0) break;
      const piece = filled === want ? chunk : chunk.subarray(0, filled);
      hash.update(piece);
      const offset = total;
      total += filled;
      if (total > source.size) break;
      await send(piece, offset);
      if (filled < want) break;
    }
  } finally {
    await handle.close();
  }
  return { size: total, sha256: hash.digest("hex") };
}
