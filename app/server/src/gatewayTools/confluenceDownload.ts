/**
 * `confluence_download_attachment` on the edge (Task-1441 P7a, G3): one
 * attachment's bytes as a file answer, with the local tool's schema,
 * description and result fields, run with the calling user's Atlassian
 * credential. Pandeck stages the bytes; the edge keeps nothing.
 *
 * File-capable (`file`), one at a time per edge (`host.ts`): on a client
 * connection under `file`, and on `/mcp` (Task-1441 P7b) under `file.mcp`,
 * with its own description and limit, the metadata as the closed projection
 * below and the bytes as the answer's file part (`mcp.ts`). The input is checked in
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
  type McpFileSpec,
  type ToolDescriptor,
} from "./descriptor.ts";
import {
  MCP_FILE_MAX_BYTES,
  MCP_IMAGE_INLINE_MAX,
  MCP_IMAGE_MAX_DIM,
  MCP_TEXT_INLINE_MAX,
} from "./mcpFileResult.ts";

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
  /** `cap` is the spec in effect's (`ctx.maxFileCap`, v09 U1). */
  tooLarge: (limit: number, cap: number) =>
    `The attachment is larger than the ${limit}-byte limit; nothing was saved. Raise maxBytes (at most ${cap}) to fetch it.`,
} as const;

/** The download's `/mcp` description (P7b AC1, v04 W5, v05 V3b). */
const MCP_DOWNLOAD_DESCRIPTION = `Download one Confluence page attachment and return its bytes in this result, after a JSON part with the attachment's metadata and the file's name, type, size and SHA-256. A UTF-8 text file up to ${MCP_TEXT_INLINE_MAX} bytes comes back as text, and a PNG, JPEG, GIF or WebP image up to ${MCP_IMAGE_INLINE_MAX} bytes and ${MCP_IMAGE_MAX_DIM} pixels a side as an image; larger images and other files arrive as saved files within ${MCP_FILE_MAX_BYTES} bytes. A file over the limit is refused and nothing is sent. Find attachment ids with confluence_lookup kind=attachments.`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The `/mcp` metadata (v02 Z4): exactly these fields of the tool's JSON.
 * Never `downloadUrl`, a path or a session field.
 */
function projectDownload(json: unknown): Record<string, unknown> {
  const source = isRecord(json) ? json : {};
  const attachment = isRecord(source.attachment) ? source.attachment : {};
  return {
    status: "downloaded_attachment",
    pageId: source.pageId ?? null,
    attachment: {
      id: attachment.id ?? null,
      title: attachment.title ?? null,
      mediaType: attachment.mediaType ?? null,
      fileSize: attachment.fileSize ?? null,
      version: attachment.version ?? null,
    },
  };
}

/** The file part's URI: the attachment id only, without an extension. */
function downloadUri(json: unknown): string {
  const attachment =
    isRecord(json) && isRecord(json.attachment) ? json.attachment : {};
  const id = typeof attachment.id === "string" ? attachment.id : "";
  return `pandeck-gateway://confluence/attachment/${encodeURIComponent(id)}`;
}

const MCP_DOWNLOAD: McpFileSpec = {
  description: MCP_DOWNLOAD_DESCRIPTION,
  limitDescription: `Largest file downloaded. Defaults to ${MCP_FILE_MAX_BYTES} bytes, at most ${MCP_FILE_MAX_BYTES}.`,
  maxBytes: MCP_FILE_MAX_BYTES,
  defaultBytes: MCP_FILE_MAX_BYTES,
  project: projectDownload,
  uri: downloadUri,
};

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
  cap: number,
  signal: AbortSignal,
): never {
  // An abort is the host's to classify, by its signal.
  if (signal.aborted) throw err;
  if (err instanceof ConfluenceDownloadError)
    throw new ToolError(
      err.reason === "metadata_too_large"
        ? DOWNLOAD_TEXT.tooLarge(limit, cap)
        : DOWNLOAD_TEXT.noDownloadLink,
    );
  if (err instanceof AtlassianDownloadError)
    throw new ToolError(
      err.reason === "http"
        ? statusText(err.status ?? 0, credential)
        : DOWNLOAD_TEXT.tooLarge(limit, cap),
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
    mcp: MCP_DOWNLOAD,
  },
  async execute(params, ctx) {
    const target = targetOf(params as ConfluenceDownloadParams);
    const limit = ctx.maxFileBytes;
    const cap = ctx.maxFileCap;
    if (limit === undefined || cap === undefined)
      throw new Error("no file limit");
    // Nothing goes upstream before the credential is here.
    const credential = await ctx.credential();
    const config = confluenceConfigOf(credential);
    const fail = (err: unknown) =>
      downloadFailure(err, credential, limit, cap, ctx.signal);
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
