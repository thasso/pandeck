/**
 * `confluence_download_attachment` on the edge (Task-1441 P7a, G3): one
 * attachment's bytes as a file answer, with the local tool's schema,
 * description and result fields, run with the calling user's Atlassian
 * credential. Pandeck stages the bytes; the edge keeps nothing.
 *
 * File-capable (`file`): it runs only on a client connection, one at a time
 * per edge, never on `/mcp` (`host.ts`, `mcp.ts`). The input is checked in
 * the local tool's order before the credential read. Every failure is a
 * fixed text chosen by type, status or reason, never by an error's message,
 * which may quote Confluence's body, a file name or a URL.
 */
import {
  AtlassianDownloadError,
  AtlassianHttpError,
} from "../atlassian/atlassianFetch.ts";
import { ConfluenceReadRefusal } from "../atlassian/confluenceClient.ts";
import {
  fetchAttachment,
  findAttachmentByName,
  normalizeAttachmentId,
} from "../confluenceAttachmentChange.ts";
import {
  CONFLUENCE_ATTACHMENT_MAX_BYTES,
  CONFLUENCE_DOWNLOAD_DEFAULT_BYTES,
  CONFLUENCE_DOWNLOAD_DESCRIPTION,
  CONFLUENCE_DOWNLOAD_SCHEMA,
  ConfluenceDownloadError,
  downloadConfluenceAttachment,
  type ConfluenceDownloadParams,
} from "../confluenceDownload.ts";
import { normalizeAttachment, normalizePageInput } from "../confluenceRead.ts";
import {
  CONFLUENCE_REFUSAL_TEXT,
  confluenceConfigOf,
  credentialRejectedText,
} from "./atlassian.ts";
import {
  FileResult,
  ToolError,
  type AtlassianCredential,
  type ToolDescriptor,
} from "./descriptor.ts";

/**
 * A download's own deadline: the metadata read plus up to 100 MiB from
 * Atlassian's media origin.
 */
export const FILE_DEADLINE_MS = 150_000;

export const DOWNLOAD_TEXT = {
  notFound:
    "No such attachment, or it isn't visible to your Atlassian account.",
  notOnPage:
    "The page has no attachment with that exact file name. List them with confluence_lookup kind=attachments.",
  noDownloadLink: "Confluence returned no download link for this attachment.",
  inputMissing: "Pass an attachmentId, or a page with its fileName.",
  invalidAttachmentId:
    "That is not a Confluence attachment id. Use the id confluence_lookup kind=attachments returns, e.g. att123456.",
  downloadFailed: "Confluence did not return the attachment; try again later.",
  tooLarge: (limit: number) =>
    `The attachment is larger than the ${limit}-byte limit; nothing was saved. Raise maxBytes (at most ${CONFLUENCE_ATTACHMENT_MAX_BYTES}) to fetch it.`,
} as const;

/** Where to find the attachment, checked as the local tool checks it. */
type Target = { attachmentId: string } | { pageId: string; fileName: string };

function targetOf(params: ConfluenceDownloadParams): Target {
  if (params.attachmentId?.trim()) {
    try {
      return { attachmentId: normalizeAttachmentId(params.attachmentId) };
    } catch {
      throw new ToolError(DOWNLOAD_TEXT.invalidAttachmentId);
    }
  }
  const fileName = params.fileName?.trim();
  if (!fileName) throw new ToolError(DOWNLOAD_TEXT.inputMissing);
  try {
    return { pageId: normalizePageInput(params.page), fileName };
  } catch (err) {
    if (err instanceof ConfluenceReadRefusal)
      throw new ToolError(CONFLUENCE_REFUSAL_TEXT[err.code]);
    throw err;
  }
}

/** An HTTP status's fixed text: the credential, not found, else failed. */
function statusText(status: number, credential: AtlassianCredential): string {
  if (status === 401 || status === 403)
    return credentialRejectedText(credential);
  if (status === 404) return DOWNLOAD_TEXT.notFound;
  return DOWNLOAD_TEXT.downloadFailed;
}

/** The fixed text for a failure after the credential read (G3). */
function downloadFailure(
  err: unknown,
  credential: AtlassianCredential,
  limit: number,
  signal: AbortSignal,
): never {
  // An abort is the host's to classify, by its signal.
  if (signal.aborted) throw err;
  if (err instanceof ConfluenceDownloadError)
    throw new ToolError(
      err.reason === "metadata_too_large"
        ? DOWNLOAD_TEXT.tooLarge(limit)
        : DOWNLOAD_TEXT.noDownloadLink,
    );
  if (err instanceof AtlassianDownloadError)
    throw new ToolError(
      err.reason === "http"
        ? statusText(err.status ?? 0, credential)
        : DOWNLOAD_TEXT.tooLarge(limit),
    );
  if (err instanceof AtlassianHttpError)
    throw new ToolError(statusText(err.status, credential));
  throw new ToolError(DOWNLOAD_TEXT.downloadFailed);
}

export const confluenceDownloadAttachment: ToolDescriptor = {
  name: "confluence_download_attachment",
  description: CONFLUENCE_DOWNLOAD_DESCRIPTION,
  inputSchema: CONFLUENCE_DOWNLOAD_SCHEMA,
  effect: "read",
  actionKey: "confluence:read",
  integration: "atlassian",
  deadlineMs: FILE_DEADLINE_MS,
  file: {
    limitParam: "maxBytes",
    defaultBytes: CONFLUENCE_DOWNLOAD_DEFAULT_BYTES,
    maxBytes: CONFLUENCE_ATTACHMENT_MAX_BYTES,
  },
  async execute(params, ctx) {
    const target = targetOf(params as ConfluenceDownloadParams);
    const limit = ctx.maxFileBytes;
    if (limit === undefined) throw new Error("no file limit");
    // Nothing goes upstream before the credential is here.
    const credential = await ctx.credential();
    const config = confluenceConfigOf(credential);
    const fail = (err: unknown) =>
      downloadFailure(err, credential, limit, ctx.signal);
    const raw = await (
      "attachmentId" in target
        ? fetchAttachment(config, target.attachmentId, ctx.signal)
        : findAttachmentByName(
            config,
            target.pageId,
            target.fileName,
            ctx.signal,
          )
    ).catch(fail);
    if (!raw) throw new ToolError(DOWNLOAD_TEXT.notOnPage);
    const downloaded = await downloadConfluenceAttachment(
      config,
      raw,
      limit,
      ctx.signal,
    ).catch(fail);
    return new FileResult(
      {
        status: "saved_attachment",
        pageId: raw.pageId ?? null,
        attachment: normalizeAttachment(raw, config.host),
      },
      {
        name: raw.title || raw.id || "attachment",
        mimeType: raw.mediaType ?? downloaded.contentType ?? "",
        bytes: downloaded.bytes,
      },
    );
  },
};
