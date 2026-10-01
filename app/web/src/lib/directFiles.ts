/**
 * Reads host files through `/api/files/...` and mints typed source-scoped
 * grants for every internal document (`app/server/src/directFileGrants.ts`).
 */
import type { DocumentTarget } from "@assistant/shared/documentTargets";
import type {
  FileGrantDeliveryMode,
  FileGrantScope,
  MintFileGrantRequest,
  MintFileGrantResponse,
} from "@assistant/shared/servedFiles";
import { authHeaders, serverHttpOrigin } from "./serverOrigin.ts";
import { directFileApiPath } from "./servedFiles.ts";

export interface DirectFileMeta {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedMs: number;
  disposition: "image" | "text" | "media" | "download";
  contentType: string;
}

/** Enough of a document to read in the viewer without holding a huge file. */
const VIEWER_TEXT_MAX_BYTES = 2 * 1024 * 1024;

export async function fetchDirectFileMeta(
  path: string,
  signal?: AbortSignal,
): Promise<DirectFileMeta> {
  const response = await fetch(
    `${serverHttpOrigin()}${directFileApiPath(path)}?meta=1`,
    { headers: authHeaders(), ...(signal ? { signal } : {}) },
  );
  if (!response.ok) throw new Error(await errorTextOf(response));
  return (await response.json()) as DirectFileMeta;
}

export interface DirectFileText {
  text: string;
  truncated: boolean;
}

/**
 * The document's text, bounded. A file larger than the cap is read to it and
 * reported as truncated rather than refused: the top of a 40 MB log is what the
 * reader wants, and silently showing part of a file is the one thing the viewer
 * may not do.
 */
export async function fetchDirectFileText(
  path: string,
  signal?: AbortSignal,
): Promise<DirectFileText> {
  const response = await fetch(
    `${serverHttpOrigin()}${directFileApiPath(path)}`,
    {
      headers: {
        ...authHeaders(),
        range: `bytes=0-${VIEWER_TEXT_MAX_BYTES - 1}`,
      },
      ...(signal ? { signal } : {}),
    },
  );
  // An EMPTY file: the server answers every range over zero bytes with 416
  // (there is no satisfiable range), and this asks for one unconditionally. An
  // empty document is an empty document, not a failure to open one.
  if (response.status === 416) return { text: "", truncated: false };
  if (!response.ok && response.status !== 206)
    throw new Error(await errorTextOf(response));
  // BYTES, not characters: `text.length` counts UTF-16 units, so any file with
  // one non-ASCII character read whole would report itself truncated. Decoding
  // the buffer as a non-final chunk also drops a multi-byte character the range
  // cut in half, rather than showing its replacement glyph.
  const bytes = await response.arrayBuffer();
  const total = totalSizeFromContentRange(
    response.headers.get("content-range"),
  );
  const truncated = total !== undefined && total > bytes.byteLength;
  const text = new TextDecoder("utf-8").decode(bytes, { stream: truncated });
  return { text, truncated };
}

/** A minted grant: where the document is served from, and until when. */
export type FileGrantUrl = MintFileGrantResponse;

/**
 * The sandboxed URL one document is served from. Minted at VIEW time by this
 * trusted client, never written into a transcript: the server never extends a
 * grant on a read, so a long-lived card renews it here instead.
 */
export async function mintFileGrantUrl(
  target: DocumentTarget,
  signal?: AbortSignal,
  scope: FileGrantScope = "directory",
  delivery: FileGrantDeliveryMode = "inline",
  fresh = false,
): Promise<FileGrantUrl> {
  const request: MintFileGrantRequest = {
    target,
    scope,
    delivery,
    ...(fresh ? { fresh: true } : {}),
  };
  const response = await fetch(`${serverHttpOrigin()}/api/file-grants`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify(request),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(await errorTextOf(response));
  const payload = (await response.json()) as Partial<MintFileGrantResponse>;
  if (!payload.url) throw new Error("The server returned no document URL.");
  if (payload.delivery !== delivery)
    throw new Error("The server returned the wrong file delivery mode.");
  return {
    url: `${serverHttpOrigin()}${payload.url}`,
    expiresAt:
      typeof payload.expiresAt === "number"
        ? payload.expiresAt
        : Date.now() + 60_000,
    delivery,
  };
}

function totalSizeFromContentRange(header: string | null): number | undefined {
  const total = header?.split("/")[1];
  const parsed = total ? Number(total) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function errorTextOf(response: Response): Promise<string> {
  const body = (await response.text().catch(() => "")).trim();
  return body || `${response.status} ${response.statusText}`;
}
