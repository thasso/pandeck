/**
 * Confluence page attachments: reading one into the session attachment store,
 * and staging and executing approved uploads and deletes.
 *
 * An attachment is the one Confluence write that carries bytes instead of
 * Markdown, and two guarantees follow from that:
 *
 * - What uploads is exactly what was approved. The bytes are frozen in the
 *   session attachment store when the proposal is staged, and execution checks
 *   their SHA-256, so a host file edited while the card waited is not what
 *   lands on the page.
 * - A new version never lands on top of someone else's. Confluence versions an
 *   attachment separately from its page, so the proposal records the version
 *   it replaces and execution refuses when that moved — the attachment
 *   counterpart of the page write's `baseVersion` guard.
 *
 * v2 has no upload endpoint, so uploads use v1
 * (`/wiki/rest/api/content/{pageId}/child/attachment`); reads and deletes are
 * v2.
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import type {
  ConfluenceAttachmentMutationDisplay,
  ConfluencePageMutationItemDisplay,
} from "@assistant/shared";
import {
  atlassianBaseUrl,
  atlassianDownload,
} from "../../atlassian/atlassianFetch.ts";
import {
  confluenceDelete,
  confluenceGet,
  confluencePost,
  type ConfluenceApiConfig,
  type ConfluencePageResponse,
} from "../../atlassian/confluenceClient.ts";
import {
  resolveSessionAttachment,
  stageSessionAttachment,
  type SessionAttachmentRecord,
} from "../../sessionAttachments.ts";

/** Upper bound for one attachment moved in either direction. */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

export interface ConfluenceAttachmentResponse {
  id?: string;
  title?: string;
  pageId?: string;
  mediaType?: string;
  fileSize?: number;
  comment?: string;
  downloadLink?: string;
  version?: { number?: number };
  _links?: { download?: string };
}

export interface ConfluenceAttachmentRow {
  id: string;
  title: string;
  mediaType: string | null;
  fileSize: number | null;
  version: number | null;
  downloadUrl: string | null;
}

export function normalizeAttachment(
  raw: ConfluenceAttachmentResponse,
  host: string,
): ConfluenceAttachmentRow {
  const path = downloadPathOf(raw);
  return {
    id: raw.id ?? "",
    title: raw.title ?? "",
    mediaType: raw.mediaType ?? null,
    fileSize: typeof raw.fileSize === "number" ? raw.fileSize : null,
    version: versionOf(raw),
    downloadUrl: path ? `${atlassianBaseUrl(host)}${path}` : null,
  };
}

function versionOf(raw: ConfluenceAttachmentResponse): number | null {
  return typeof raw.version?.number === "number" ? raw.version.number : null;
}

/**
 * The site-relative path an attachment downloads from. v2 answers it relative
 * to `/wiki`; a link that already names `/wiki` is kept as is.
 */
function downloadPathOf(raw: ConfluenceAttachmentResponse): string | null {
  const link = raw.downloadLink ?? raw._links?.download;
  if (!link || /^[a-z]+:/i.test(link) || link.startsWith("//")) return null;
  const path = link.startsWith("/") ? link : `/${link}`;
  return path === "/wiki" || path.startsWith("/wiki/") ? path : `/wiki${path}`;
}

/** Attachment ids are `att<digits>`; a bare number is taken as the same id. */
export function normalizeAttachmentId(value: string): string {
  const raw = value.trim();
  if (/^att\d+$/i.test(raw)) return `att${raw.slice(3)}`;
  if (/^\d+$/.test(raw)) return `att${raw}`;
  throw new Error(
    `"${raw}" is not a Confluence attachment id. Use the id confluence_lookup kind=attachments returns, e.g. att123456.`,
  );
}

export async function fetchAttachment(
  config: ConfluenceApiConfig,
  attachmentId: string,
  signal?: AbortSignal,
): Promise<ConfluenceAttachmentResponse> {
  return confluenceGet<ConfluenceAttachmentResponse>(
    config,
    `/wiki/api/v2/attachments/${encodeURIComponent(attachmentId)}`,
    undefined,
    signal ? { signal } : {},
  );
}

/** The page's attachment with exactly this file name, or null. */
export async function findAttachmentByName(
  config: ConfluenceApiConfig,
  pageId: string,
  fileName: string,
  signal?: AbortSignal,
): Promise<ConfluenceAttachmentResponse | null> {
  const result = await confluenceGet<{
    results?: ConfluenceAttachmentResponse[];
  }>(
    config,
    `/wiki/api/v2/pages/${encodeURIComponent(pageId)}/attachments`,
    { filename: fileName, limit: 25 },
    signal ? { signal } : {},
  );
  return (
    (result.results ?? []).find(
      (attachment) => attachment.title === fileName,
    ) ?? null
  );
}

/** Download one attachment's current bytes, refusing past `maxBytes`. */
export async function downloadAttachment(
  config: ConfluenceApiConfig,
  raw: ConfluenceAttachmentResponse,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  if (typeof raw.fileSize === "number" && raw.fileSize > maxBytes)
    throw new Error(
      `${raw.title ?? raw.id} is ${raw.fileSize} bytes, above the ${maxBytes}-byte limit; raise maxBytes to fetch it.`,
    );
  const path = downloadPathOf(raw);
  if (!path)
    throw new Error(
      `Confluence returned no download link for attachment ${raw.id ?? ""}.`,
    );
  return atlassianDownload(
    config,
    "Confluence",
    path,
    maxBytes,
    signal ? { signal } : {},
  );
}

// --------------------------------------------------------------------------
// Staging
// --------------------------------------------------------------------------

export type AttachmentOperation = "uploadAttachment" | "deleteAttachment";

export interface AttachmentChangeRequest {
  /** Normalized page id, when the caller named one. */
  pageId?: string;
  attachmentId?: string;
  fileName?: string;
  sourceAttachmentId?: string;
  sourcePath?: string;
}

/**
 * Validate one attachment change against the live site and freeze what it
 * will write. The page is read before any bytes are copied, so a bad target
 * fails without leaving a staged file behind.
 */
export async function stageAttachmentChange(
  config: ConfluenceApiConfig,
  sessionId: string,
  operation: AttachmentOperation,
  request: AttachmentChangeRequest,
  signal?: AbortSignal,
): Promise<{
  page: ConfluencePageResponse;
  attachment: ConfluenceAttachmentMutationDisplay;
  warning?: string;
}> {
  const byId = request.attachmentId?.trim()
    ? await fetchAttachment(
        config,
        normalizeAttachmentId(request.attachmentId),
        signal,
      )
    : null;
  if (byId && !byId.pageId)
    throw new Error(
      `Attachment ${byId.id ?? request.attachmentId} does not belong to a page.`,
    );
  if (byId && request.pageId && byId.pageId !== request.pageId)
    throw new Error(
      `Attachment ${byId.id} belongs to page ${byId.pageId}, not ${request.pageId}.`,
    );
  const fileName = request.fileName?.trim();
  if (byId && fileName && fileName !== byId.title)
    throw new Error(
      `Attachment ${byId.id} is named "${byId.title ?? ""}", not "${fileName}". Pass one or the other.`,
    );
  const pageId = byId?.pageId ?? request.pageId;
  if (!pageId)
    throw new Error(
      `${operation} needs a page, or the attachmentId it targets.`,
    );
  const page = await confluenceGet<ConfluencePageResponse>(
    config,
    `/wiki/api/v2/pages/${encodeURIComponent(pageId)}`,
    undefined,
    signal ? { signal } : {},
  );

  if (operation === "deleteAttachment") {
    if (!byId && !fileName)
      throw new Error("deleteAttachment needs an attachmentId or a fileName.");
    const existing =
      byId ??
      (await findAttachmentByName(config, pageId, fileName ?? "", signal));
    if (!existing)
      throw new Error(`Page ${pageId} has no attachment named "${fileName}".`);
    const title = existing.title ?? fileName ?? "";
    return {
      page,
      attachment: {
        fileName: title,
        ...existingTarget(existing),
        mediaType: existing.mediaType ?? null,
        size: typeof existing.fileSize === "number" ? existing.fileSize : null,
      },
      warning: `${title} would be moved to the trash; a page embedding it shows it as missing`,
    };
  }

  const frozen = await freezeUploadSource(sessionId, request);
  const target = byId?.title ?? (fileName || frozen.record.name);
  const existing =
    byId ?? (await findAttachmentByName(config, pageId, target, signal));
  return {
    page,
    attachment: {
      fileName: target,
      ...(existing ? existingTarget(existing) : {}),
      mediaType: frozen.record.mimeType,
      size: frozen.record.size,
      source: frozen.source,
      stagedAttachmentId: frozen.record.id,
      sha256: frozen.sha256,
    },
    ...(existing
      ? {
          warning: `${target} already exists on the page; the upload becomes version ${(versionOf(existing) ?? 0) + 1}`,
        }
      : {}),
  };
}

/**
 * The id and version a write against an existing attachment is checked by.
 * Without a version there is nothing to compare at execution, so staging
 * refuses rather than proposing an unverifiable overwrite.
 */
function existingTarget(existing: ConfluenceAttachmentResponse): {
  existingId: string;
  baseVersion: number;
} {
  const version = versionOf(existing);
  if (!existing.id || version === null)
    throw new Error(
      `Confluence reported no id or version for attachment ${existing.title ?? ""}, so it cannot be changed safely.`,
    );
  return { existingId: existing.id, baseVersion: version };
}

/**
 * Copy the upload's bytes into the session attachment store (a host path) or
 * pin the ones already there (a session attachment), with their digest.
 */
async function freezeUploadSource(
  sessionId: string,
  request: AttachmentChangeRequest,
): Promise<{
  record: SessionAttachmentRecord;
  sha256: string;
  source: string;
}> {
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
      record: { ...record, size: bytes.byteLength },
      sha256: sha256Of(bytes),
      source: `session attachment ${record.name}`,
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
  return { record, sha256: sha256Of(bytes), source: path };
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

// --------------------------------------------------------------------------
// Execution
// --------------------------------------------------------------------------

interface V1AttachmentResponse {
  id?: string;
  version?: { number?: number };
}

/** Apply one approved attachment item, recording the resulting version. */
export async function executeAttachmentChange(
  config: ConfluenceApiConfig,
  sessionId: string,
  item: ConfluencePageMutationItemDisplay,
): Promise<void> {
  const attachment = item.attachment;
  const pageId = item.pageId ?? "";
  if (!attachment || !pageId)
    throw new Error("This attachment proposal names no page or file.");
  if (item.operation === "deleteAttachment") {
    const id = await verifiedExistingId(config, attachment);
    await confluenceDelete(
      config,
      `/wiki/api/v2/attachments/${encodeURIComponent(id)}`,
    );
    attachment.resultId = id;
  } else {
    const bytes = await readStagedBytes(sessionId, attachment);
    let path: string;
    if (attachment.existingId) {
      const id = await verifiedExistingId(config, attachment);
      path = `/wiki/rest/api/content/${encodeURIComponent(pageId)}/child/attachment/${encodeURIComponent(id)}/data`;
    } else {
      if (await findAttachmentByName(config, pageId, attachment.fileName))
        throw new Error(
          `An attachment named ${attachment.fileName} was added to the page since this proposal. Propose the upload again to make it a new version.`,
        );
      path = `/wiki/rest/api/content/${encodeURIComponent(pageId)}/child/attachment`;
    }
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(bytes)], {
        type: attachment.mediaType || "application/octet-stream",
      }),
      attachment.fileName,
    );
    form.append("minorEdit", "true");
    if (item.versionMessage) form.append("comment", item.versionMessage);
    // Creating answers a listing, updating answers the attachment itself.
    const response = await confluencePost<
      V1AttachmentResponse & { results?: V1AttachmentResponse[] }
    >(config, path, form);
    const written = response.results?.[0] ?? response;
    attachment.resultId = written.id ?? attachment.existingId ?? null;
    attachment.resultVersion =
      typeof written.version?.number === "number"
        ? written.version.number
        : null;
  }
  item.resultPageId = pageId;
  item.resultPageUrl = item.pageUrl ?? null;
}

/**
 * The approved bytes, proven unchanged. A staged file that went missing or
 * changed is a refusal: uploading anything else would not be what the user
 * approved.
 */
async function readStagedBytes(
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

async function verifiedExistingId(
  config: ConfluenceApiConfig,
  attachment: ConfluenceAttachmentMutationDisplay,
): Promise<string> {
  const id = attachment.existingId;
  if (!id || typeof attachment.baseVersion !== "number")
    throw new Error(
      `This proposal for ${attachment.fileName} recorded no attachment version, so it cannot be applied safely. Propose it again.`,
    );
  const current = versionOf(await fetchAttachment(config, id));
  if (current !== attachment.baseVersion)
    throw new Error(
      `${attachment.fileName} changed since this proposal was prepared (version ${attachment.baseVersion} → ${current ?? "unknown"}). Re-read it and propose the change again.`,
    );
  return id;
}
