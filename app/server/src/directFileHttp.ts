/**
 * Serves any file on the host by its ABSOLUTE PATH, so an agent can point at a
 * file it already wrote — in a worktree, a temp dir, anywhere — instead of
 * copying bytes into `DATA_DIR/session-artifacts/` first.
 *
 * The absolute path is the route path (`/api/files/tmp/example/x/report.html`),
 * not a query parameter: relative subresources inside a served document — a
 * Markdown `./diagram.png`, an HTML `./chart.js` — then resolve against the
 * file's real directory without any rewriting.
 *
 * There is deliberately NO path allow-list: an agent can already read what the
 * service can read, so one would restrict where a link may POINT without
 * restricting what the agent may SEE. The token gate on `/api/*` is the access
 * control. What this module does own is DELIVERY: nothing served here may
 * execute on the API origin, because the token travels in `?token=` for
 * header-less contexts and a script that can read its own URL can steal it.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, resolve } from "node:path";
import {
  servedFileDeliveryOf,
  servedFileInlineContentTypeOf,
  servedFileKindOf,
  type ServedFileDelivery,
} from "@assistant/shared/servedFiles";
import { errorText } from "./errors.ts";

type Headers = Record<string, string>;

export const DIRECT_FILE_PREFIX = "/api/files/";

/** How a served file reaches the browser; see the shared classification. */
export function directFileDisposition(path: string): ServedFileDelivery {
  return servedFileDeliveryOf(servedFileKindOf(path));
}

/**
 * The absolute path a `/api/files/...` URL addresses, or undefined when the
 * pathname is not one. `resolve` folds away `.`/`..` and duplicate separators;
 * with no allow-list there is nothing to escape, so normalization is all this
 * needs — but it keeps one path from having many spellings.
 */
export function directFilePath(pathname: string): string | undefined {
  if (!pathname.startsWith(DIRECT_FILE_PREFIX)) return undefined;
  return normalizeAbsoluteFilePath(pathname.slice(DIRECT_FILE_PREFIX.length));
}

/**
 * One absolute path from a percent-encoded, possibly relative-looking spelling
 * — the shared step behind a `/api/files/...` URL and a grant request naming a
 * path directly.
 */
function normalizeAbsoluteFilePath(raw: string): string | undefined {
  const trimmed = raw.replace(/^\/+/, "");
  if (!trimmed) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  return resolve(`/${decoded}`);
}

/** The `/api/files/...` pathname (unauthenticated, no origin) for one path. */
export function directFileUrlPath(absolutePath: string): string {
  const segments = resolve(absolutePath)
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent);
  return `${DIRECT_FILE_PREFIX}${segments.join("/")}`;
}

/**
 * Content type and disposition headers. Active content NEVER executes here:
 * HTML is force-downloaded (the sandboxed viewer serves it instead) and SVG
 * carries a sandbox CSP, which is inert while it loads as an `<img>` and turns
 * a direct navigation into an opaque origin that runs no script.
 */
export function directFileDeliveryHeaders(
  path: string,
  requestUrl: URL,
): Headers {
  const ext = extname(path).toLowerCase();
  const disposition = directFileDisposition(path);
  const forceDownload =
    requestUrl.searchParams.get("download") === "1" ||
    disposition === "download";

  const headers: Headers = { "x-content-type-options": "nosniff" };

  if (forceDownload) {
    headers["content-type"] = "application/octet-stream";
    headers["content-security-policy"] = "sandbox; default-src 'none'";
    headers["content-disposition"] = attachmentContentDisposition(
      requestUrl.searchParams.get("name")?.trim() || basename(path),
    );
    return headers;
  }

  headers["content-type"] = servedFileInlineContentTypeOf(path);
  if (ext === ".svg") headers["content-security-policy"] = "sandbox";
  return headers;
}

function attachmentContentDisposition(name: string): string {
  const clean = name.replace(/[\r\n\0]/g, "_").slice(0, 255) || "download";
  const fallback = clean.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(clean).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** A single `bytes=` range against a known size, per RFC 9110. */
export function parseByteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  // Every range over a zero-length file is unsatisfiable (RFC 9110 §14.1.1);
  // treating a suffix range as one would answer `bytes 0--1/0`.
  if (size === 0) return "unsatisfiable";
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return undefined;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!suffix) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  if (start >= size) return "unsatisfiable";
  const end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1;
  if (end < start) return "unsatisfiable";
  return { start, end };
}

/** Metadata a chat card needs to show a file without reading its bytes. */
interface DirectFileMeta {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedMs: number;
  disposition: ServedFileDelivery;
  contentType: string;
}

/**
 * Serve one absolute path: `?meta=1` answers JSON metadata, everything else
 * streams the bytes with range support (a 2 GB capture must not be buffered).
 */
export async function handleDirectFileRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestUrl: URL,
  corsHeaders: Headers,
): Promise<void> {
  const path = directFilePath(requestUrl.pathname);
  const fail = (status: number, message: string) => {
    res.writeHead(status, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders,
    });
    res.end(message);
  };

  if (!path) {
    fail(400, "A file path is required.");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    fail(405, "Method not allowed.");
    return;
  }

  let size: number;
  let modifiedMs: number;
  try {
    // `stat`, not `lstat`: a symlink to a readable file is a readable file, and
    // with no allow-list there is no containment for it to escape.
    const stats = await stat(path);
    if (stats.isDirectory()) {
      fail(400, `Not a file: ${path}`);
      return;
    }
    if (!stats.isFile()) {
      fail(400, `Not a regular file: ${path}`);
      return;
    }
    size = stats.size;
    modifiedMs = stats.mtimeMs;
  } catch (err) {
    // The path, not the errno text: this message is what the viewer shows the
    // reader, and "no such file" about a path they cannot see explains nothing.
    fail(
      404,
      (err as NodeJS.ErrnoException).code === "ENOENT"
        ? `No such file: ${path}`
        : `Cannot read ${path}: ${errorText(err)}`,
    );
    return;
  }

  const delivery = directFileDeliveryHeaders(path, requestUrl);

  if (requestUrl.searchParams.get("meta") === "1") {
    const meta: DirectFileMeta = {
      path,
      name: basename(path),
      sizeBytes: size,
      modifiedMs,
      disposition: directFileDisposition(path),
      contentType: delivery["content-type"] ?? "application/octet-stream",
    };
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders,
    });
    res.end(JSON.stringify(meta));
    return;
  }

  const base: Headers = {
    ...delivery,
    // Files mutate under us; a cached copy would show a stale document with no
    // way for the reader to tell.
    "cache-control": "no-store",
    "accept-ranges": "bytes",
    "last-modified": new Date(modifiedMs).toUTCString(),
    ...corsHeaders,
  };

  const range = parseByteRange(req.headers.range, size);
  if (range === "unsatisfiable") {
    res.writeHead(416, { ...base, "content-range": `bytes */${size}` });
    res.end();
    return;
  }

  const status = range ? 206 : 200;
  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, size - 1);
  const length = size === 0 ? 0 : end - start + 1;

  res.writeHead(status, {
    ...base,
    "content-length": String(length),
    ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
  });

  if (req.method === "HEAD" || size === 0) {
    res.end();
    return;
  }

  await new Promise<void>((done) => {
    const stream = createReadStream(path, { start, end });
    stream.on("error", () => {
      res.destroy();
      done();
    });
    res.on("close", () => {
      stream.destroy();
      done();
    });
    stream.pipe(res);
    stream.on("end", done);
  });
}
