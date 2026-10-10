import type { ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolveSessionAttachment } from "./sessionAttachments.ts";

export const SESSION_ATTACHMENT_PREFIX = "/api/session-attachment/";

const SAFE_ID = /^[A-Za-z0-9._-]+$/;
// A recorded MIME type came from the uploading client: it is only trusted when
// it is a plain `image/<subtype>`, which also keeps it a valid header value.
const IMAGE_MIME = /^image\/[a-z0-9.+-]+$/;

/**
 * Serve one image attachment of a session by id, so a saved prompt whose image
 * the durable log holds only by reference still shows a picture after a reload.
 *
 * Token-gated like the rest of `/api/*`, and therefore it serves IMAGES ONLY,
 * with sniffing off: an uploaded HTML or SVG-with-script document must never
 * execute on the API origin where the token lives (`docs/served-files.md`).
 * SVG additionally gets `sandbox`, which turns a direct navigation into an
 * opaque origin and does nothing to an `<img>`.
 */
export async function handleSessionAttachmentRequest(
  res: ServerResponse,
  requestUrl: URL,
  corsHeaders: Record<string, string>,
): Promise<void> {
  const text = (status: number, message: string) => {
    res.writeHead(status, {
      "content-type": "text/plain; charset=utf-8",
      ...corsHeaders,
    });
    res.end(message);
  };
  const segments = requestUrl.pathname
    .slice(SESSION_ATTACHMENT_PREFIX.length)
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return "";
      }
    });
  const [sessionId, attachmentId] = segments;
  if (segments.length !== 2 || !isSafeSegment(sessionId)) {
    text(400, "Invalid session id.");
    return;
  }
  if (!isSafeSegment(attachmentId)) {
    text(400, "Invalid attachment id.");
    return;
  }
  const record = resolveSessionAttachment(sessionId, attachmentId);
  if (!record || !IMAGE_MIME.test(record.mimeType)) {
    text(404, "Image not found.");
    return;
  }
  let body: Buffer;
  try {
    body = await readFile(record.path);
  } catch {
    text(404, "Image not found.");
    return;
  }
  res.writeHead(200, {
    "content-type": record.mimeType,
    "content-length": String(body.byteLength),
    "x-content-type-options": "nosniff",
    ...(record.mimeType === "image/svg+xml"
      ? { "content-security-policy": "sandbox" }
      : {}),
    "cache-control": "private, max-age=31536000, immutable",
    ...corsHeaders,
  });
  res.end(body);
}

function isSafeSegment(value: string | undefined): value is string {
  return (
    value !== undefined &&
    value !== "." &&
    value !== ".." &&
    SAFE_ID.test(value)
  );
}
