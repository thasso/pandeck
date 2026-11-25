/**
 * Confluence page attachments on this host: reading one into the session
 * attachment store, and the two upload seams the shared mutation core
 * (`../../confluenceAttachmentChange.ts`) takes from the local tool.
 *
 * What uploads is exactly what was approved. The bytes are frozen in the
 * session attachment store when the proposal is staged (`freezeUploadSource`),
 * and apply checks their SHA-256 (`readStagedBytes`), so a host file edited
 * while the card waited is not what lands on the page.
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

/**
 * Copy the upload's bytes into the session attachment store (a host path) or
 * pin the ones already there (a session attachment), with their digest: the
 * local `freezeUpload` seam.
 */
export async function freezeUploadSource(
  sessionId: string,
  request: AttachmentChangeRequest,
): Promise<FrozenUpload> {
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
    const bytes = await readUploadBytes(record.path, record.name);
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
  const bytes = await readUploadBytes(path, path);
  const record = stageSessionAttachment(sessionId, {
    name: basename(path),
    mimeType: "",
    bytes,
    source: "agent",
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
 * Read a file for upload, holding at most `MAX_ATTACHMENT_BYTES` plus one
 * chunk. The bound is applied to the bytes actually read, not to a size
 * recorded or stat-ed earlier: a file that grew since would otherwise be read
 * whole into memory before anything noticed.
 */
async function readUploadBytes(path: string, name: string): Promise<Buffer> {
  const handle = await open(path, "r");
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = Buffer.alloc(1024 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_ATTACHMENT_BYTES)
        throw new Error(
          `"${name}" is larger than ${MAX_ATTACHMENT_BYTES} bytes; attachments above that are not uploaded.`,
        );
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
