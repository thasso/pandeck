/**
 * One Confluence attachment's bytes (Task-1441 P7a, G3): the download core
 * Pandeck's local `confluence_download_attachment` and the edge's share, and
 * the tool's definition both show. Boundary-clean: it imports no session
 * store, so the edge's tools may use it (`workerBoundary.test.ts`).
 *
 * The metadata's declared size is checked before any request, then
 * `atlassianDownload` checks the declared and streamed sizes. Each refusal
 * keeps the message the local tool always showed and carries a reason the
 * edge maps to its fixed text without reading the message.
 */
import {
  atlassianDownload,
  type AtlassianConfig,
} from "./atlassian/atlassianFetch.ts";
import {
  downloadPathOf,
  type ConfluenceAttachmentResponse,
} from "./confluenceRead.ts";

/** Upper bound for one attachment moved in either direction. */
export const CONFLUENCE_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;
/** A download's limit when the call names none. */
export const CONFLUENCE_DOWNLOAD_DEFAULT_BYTES = 50 * 1024 * 1024;

/** The local tool's label and search hint, which client mode's tool shares. */
export const CONFLUENCE_DOWNLOAD_LABEL = "Confluence: Download Attachment";
export const CONFLUENCE_DOWNLOAD_SEARCH_HINT =
  "confluence attachment download file image pdf spreadsheet fetch";
export const CONFLUENCE_DOWNLOAD_DESCRIPTION =
  "Download one Confluence page attachment into this session's attachment store. The bytes never enter your context: the result names a session attachment id and its path on this host. Inspect it with read_attachment, convert_pdf or convert_xlsx, copy it into the KB with kb_write (sourceAttachmentId), or change the file and upload it back with confluence_mutate_page operation=uploadAttachment.";

export const CONFLUENCE_DOWNLOAD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    attachmentId: {
      type: "string",
      description:
        "Attachment id from confluence_lookup kind=attachments, e.g. att123456.",
    },
    page: {
      type: "string",
      description: "Page id or URL, with fileName instead of attachmentId.",
    },
    fileName: {
      type: "string",
      description: "Exact attachment file name on page.",
    },
    maxBytes: {
      type: "number",
      description: `Largest file downloaded. Defaults to ${CONFLUENCE_DOWNLOAD_DEFAULT_BYTES} bytes, at most ${CONFLUENCE_ATTACHMENT_MAX_BYTES}.`,
    },
  },
} as const;

export type ConfluenceDownloadParams = {
  attachmentId?: string;
  page?: string;
  fileName?: string;
  maxBytes?: number;
};

/** Why the core refused before the download itself. */
type ConfluenceDownloadReason = "metadata_too_large" | "no_download_link";

/** A refusal before the download; the message may name the attachment. */
export class ConfluenceDownloadError extends Error {
  constructor(
    message: string,
    readonly reason: ConfluenceDownloadReason,
  ) {
    super(message);
  }
}

/** Download one attachment's current bytes, refusing past `maxBytes`. */
export async function downloadConfluenceAttachment(
  config: AtlassianConfig,
  raw: ConfluenceAttachmentResponse,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  if (typeof raw.fileSize === "number" && raw.fileSize > maxBytes)
    throw new ConfluenceDownloadError(
      `${raw.title ?? raw.id} is ${raw.fileSize} bytes, above the ${maxBytes}-byte limit; raise maxBytes to fetch it.`,
      "metadata_too_large",
    );
  const path = downloadPathOf(raw);
  if (!path)
    throw new ConfluenceDownloadError(
      `Confluence returned no download link for attachment ${raw.id ?? ""}.`,
      "no_download_link",
    );
  return atlassianDownload(
    config,
    "Confluence",
    path,
    maxBytes,
    signal ? { signal } : {},
  );
}
