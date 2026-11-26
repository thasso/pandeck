/**
 * The attachment half of `confluence_mutate_page` (Task-1463): resolving the
 * attachment an item targets, staging an upload or delete against the live
 * site, and applying the approved change.
 *
 * Boundary-clean, so the gateway's edge may import it
 * (`workerBoundary.test.ts`): the bytes never pass through here as files.
 * Staging freezes an upload through `freezeUpload` and apply reads the frozen
 * bytes back through `stagedBytes`; the local tool supplies both from the
 * session attachment store (`tools/confluence/confluenceAttachments.ts`). A
 * caller without them gets a refusal, and nothing is sent for that item.
 *
 * A delete moves the attachment to the trash, and only one that both staging's
 * read and apply's verify read report as `current` (`requireCurrentForDelete`).
 *
 * Two guarantees follow from an attachment carrying bytes:
 *
 * - What uploads is exactly what was approved: `freezeUpload` pins the bytes
 *   and their SHA-256 when the proposal is staged, and `stagedBytes` must
 *   prove them unchanged.
 * - A new version never lands on top of someone else's. Confluence versions an
 *   attachment separately from its page, so the proposal records the version
 *   it replaces and apply refuses when that moved.
 *
 * v2 has no upload endpoint, so uploads use v1
 * (`/wiki/rest/api/content/{pageId}/child/attachment`); reads and deletes are
 * v2. An upload's body is streamed (`atlassian/multipartUpload.ts`): its
 * pieces are copies, its digest is checked before the closing boundary, it is
 * retired once the request settles, and only a `completed` body counts as
 * sent (Task-1441 P8a).
 */
import type {
  ConfluenceAttachmentMutationDisplay,
  ConfluencePageMutationItemDisplay,
} from "@assistant/shared/confluenceMutation";
import {
  confluenceDelete,
  confluenceGet,
  confluencePost,
  type ConfluenceConfig,
  type ConfluencePageResponse,
} from "./atlassian/confluenceClient.ts";
import { multipartUpload } from "./atlassian/multipartUpload.ts";
import {
  versionOf,
  type ConfluenceAttachmentResponse,
} from "./confluenceRead.ts";
import {
  ConfluenceMutationError,
  confluenceWrite,
  requireCurrentForDelete,
  signalTail,
} from "./confluenceMutationErrors.ts";
import type { WriteScope } from "./writeScope.ts";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * An upload Confluence answered before its whole body was sent (P8a v05 W1,
 * v06 X4): fixed, with no name, path or upstream text.
 */
export const BODY_NOT_COMPLETED =
  "Confluence answered before the whole file was sent, so this upload may be incomplete. Check the page before trying again.";

/** Attachment ids are `att<digits>`; a bare number is taken as the same id. */
export function normalizeAttachmentId(value: string): string {
  const raw = value.trim();
  if (/^att\d+$/i.test(raw)) return `att${raw.slice(3)}`;
  if (/^\d+$/.test(raw)) return `att${raw}`;
  throw new ConfluenceMutationError(
    `"${raw}" is not a Confluence attachment id. Use the id confluence_lookup kind=attachments returns, e.g. att123456.`,
  );
}

export async function fetchAttachment(
  config: ConfluenceConfig,
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
  config: ConfluenceConfig,
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

// --------------------------------------------------------------------------
// Staging
// --------------------------------------------------------------------------

type AttachmentOperation = "uploadAttachment" | "deleteAttachment";

export interface AttachmentChangeRequest {
  /** Normalized page id, when the caller named one. */
  pageId?: string;
  attachmentId?: string;
  fileName?: string;
  sourceAttachmentId?: string;
  sourcePath?: string;
}

/** An upload's bytes, pinned where apply can read them back and prove them. */
export interface FrozenUpload {
  /** The source's own file name, the default for the name on the page. */
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  /** Where the bytes came from, as the card shows it. */
  source: string;
  /** The id apply's `stagedBytes` reads them back by. */
  stagedAttachmentId: string;
}

/** What staging needs besides the config and the request. */
export interface AttachmentStagingDeps {
  /** Carried by every read; an abort propagates unwrapped. */
  signal?: AbortSignal | undefined;
  /** Pins an upload's bytes; without it an upload is refused before any request. */
  freezeUpload?(request: AttachmentChangeRequest): Promise<FrozenUpload>;
}

/**
 * Validate one attachment change against the live site and freeze what it
 * will write. The page is read before any bytes are frozen, so a bad target
 * fails without leaving a staged file behind.
 */
export async function stageAttachmentChange(
  config: ConfluenceConfig,
  operation: AttachmentOperation,
  request: AttachmentChangeRequest,
  deps: AttachmentStagingDeps,
): Promise<{
  page: ConfluencePageResponse;
  attachment: ConfluenceAttachmentMutationDisplay;
  warning?: string;
}> {
  const { signal, freezeUpload } = deps;
  if (operation === "uploadAttachment" && !freezeUpload)
    throw new ConfluenceMutationError(
      "uploadAttachment is not available here.",
    );
  const byId = request.attachmentId?.trim()
    ? await fetchAttachment(
        config,
        normalizeAttachmentId(request.attachmentId),
        signal,
      )
    : null;
  if (byId && !byId.pageId)
    throw new ConfluenceMutationError(
      `Attachment ${byId.id ?? request.attachmentId} does not belong to a page.`,
    );
  if (byId && request.pageId && byId.pageId !== request.pageId)
    throw new ConfluenceMutationError(
      `Attachment ${byId.id} belongs to page ${byId.pageId}, not ${request.pageId}.`,
    );
  const fileName = request.fileName?.trim();
  if (byId && fileName && fileName !== byId.title)
    throw new ConfluenceMutationError(
      `Attachment ${byId.id} is named "${byId.title ?? ""}", not "${fileName}". Pass one or the other.`,
    );
  const pageId = byId?.pageId ?? request.pageId;
  if (!pageId)
    throw new ConfluenceMutationError(
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
      throw new ConfluenceMutationError(
        "deleteAttachment needs an attachmentId or a fileName.",
      );
    const existing =
      byId ??
      (await findAttachmentByName(config, pageId, fileName ?? "", signal));
    if (!existing)
      throw new ConfluenceMutationError(
        `Page ${pageId} has no attachment named "${fileName}".`,
      );
    const title = existing.title ?? fileName ?? "";
    requireCurrentForDelete(existing.status, title);
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

  // Checked at the top for an upload; repeated so the type narrows.
  if (!freezeUpload)
    throw new ConfluenceMutationError(
      "uploadAttachment is not available here.",
    );
  const frozen = await freezeUpload(request);
  const target = byId?.title ?? (fileName || frozen.name);
  const existing =
    byId ?? (await findAttachmentByName(config, pageId, target, signal));
  return {
    page,
    attachment: {
      fileName: target,
      ...(existing ? existingTarget(existing) : {}),
      mediaType: frozen.mimeType,
      size: frozen.size,
      source: frozen.source,
      stagedAttachmentId: frozen.stagedAttachmentId,
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
 * Without a version there is nothing to compare at apply, so staging refuses
 * rather than proposing an unverifiable overwrite.
 */
function existingTarget(existing: ConfluenceAttachmentResponse): {
  existingId: string;
  baseVersion: number;
} {
  const version = versionOf(existing);
  if (!existing.id || version === null)
    throw new ConfluenceMutationError(
      `Confluence reported no id or version for attachment ${existing.title ?? ""}, so it cannot be changed safely.`,
    );
  return { existingId: existing.id, baseVersion: version };
}

// --------------------------------------------------------------------------
// Apply
// --------------------------------------------------------------------------

interface V1AttachmentResponse {
  id?: string;
  version?: { number?: number };
}

/** What applying an attachment item needs besides the config and the item. */
export interface AttachmentApplyDeps extends WriteScope {
  /** Carried by every request; an abort propagates unwrapped. */
  signal?: AbortSignal | undefined;
  /**
   * The approved bytes, proven unchanged since staging; it throws when they
   * are gone or changed. Without it an upload is refused before any request.
   */
  stagedBytes?(
    attachment: ConfluenceAttachmentMutationDisplay,
  ): Promise<Uint8Array>;
}

/** Apply one approved attachment item, recording the resulting version. */
export async function executeAttachmentChange(
  config: ConfluenceConfig,
  item: ConfluencePageMutationItemDisplay,
  deps: AttachmentApplyDeps,
): Promise<void> {
  const { signal } = deps;
  const attachment = item.attachment;
  const pageId = item.pageId ?? "";
  if (!attachment || !pageId)
    throw new ConfluenceMutationError(
      "This attachment proposal names no page or file.",
    );
  if (item.operation === "deleteAttachment") {
    const id = await verifiedExistingId(config, attachment, signal, {
      requireCurrent: true,
    });
    await confluenceWrite(
      () =>
        confluenceDelete(
          config,
          `/wiki/api/v2/attachments/${encodeURIComponent(id)}`,
          ...signalTail(signal),
        ),
      deps,
    );
    attachment.resultId = id;
  } else {
    if (!deps.stagedBytes)
      throw new ConfluenceMutationError(
        "uploadAttachment is not available here; nothing was uploaded.",
      );
    const bytes = await deps.stagedBytes(attachment);
    let path: string;
    if (attachment.existingId) {
      const id = await verifiedExistingId(config, attachment, signal);
      path = `/wiki/rest/api/content/${encodeURIComponent(pageId)}/child/attachment/${encodeURIComponent(id)}/data`;
    } else {
      if (
        await findAttachmentByName(config, pageId, attachment.fileName, signal)
      )
        throw new ConfluenceMutationError(
          `An attachment named ${attachment.fileName} was added to the page since this proposal. Propose the upload again to make it a new version.`,
        );
      path = `/wiki/rest/api/content/${encodeURIComponent(pageId)}/child/attachment`;
    }
    const sha256 = attachment.sha256 ?? "";
    if (!SHA256_HEX.test(sha256))
      throw new ConfluenceMutationError(
        `The proposal for ${attachment.fileName} recorded no valid file digest, so it cannot be uploaded safely. Propose the upload again.`,
      );
    const upload = multipartUpload({
      bytes,
      sha256,
      fileName: attachment.fileName,
      mediaType: attachment.mediaType,
      fields: [
        ["minorEdit", "true"],
        ...(item.versionMessage
          ? [["comment", item.versionMessage] as const]
          : []),
      ],
    });
    // Creating answers a listing, updating answers the attachment itself.
    let response: V1AttachmentResponse & { results?: V1AttachmentResponse[] };
    try {
      response = await confluenceWrite(
        () => confluencePost(config, path, upload, ...signalTail(signal)),
        deps,
      );
    } finally {
      // Every path: the body drops the bytes before this item settles.
      upload.retire();
    }
    // An answer that came before the whole body was sent is no success.
    if (upload.state !== "completed")
      throw new ConfluenceMutationError(BODY_NOT_COMPLETED);
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
 * Re-read the attachment an approval targets and prove its version has not
 * moved. `requireCurrent` (a delete only) also refuses, after the version
 * check, an attachment the read does not report as exactly `current`.
 */
async function verifiedExistingId(
  config: ConfluenceConfig,
  attachment: ConfluenceAttachmentMutationDisplay,
  signal: AbortSignal | undefined,
  options: { requireCurrent?: boolean } = {},
): Promise<string> {
  const id = attachment.existingId;
  if (!id || typeof attachment.baseVersion !== "number")
    throw new ConfluenceMutationError(
      `This proposal for ${attachment.fileName} recorded no attachment version, so it cannot be applied safely. Propose it again.`,
    );
  const record = await fetchAttachment(config, id, signal);
  const current = versionOf(record);
  if (current !== attachment.baseVersion)
    throw new ConfluenceMutationError(
      `${attachment.fileName} changed since this proposal was prepared (version ${attachment.baseVersion} → ${current ?? "unknown"}). Re-read it and propose the change again.`,
    );
  if (options.requireCurrent)
    requireCurrentForDelete(record.status, attachment.fileName);
  return id;
}
