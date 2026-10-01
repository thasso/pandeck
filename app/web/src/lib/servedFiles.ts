/**
 * Classifies the two URL families this app serves file bytes from, so a chat
 * transcript can render a card for either:
 *
 * - `/api/session-artifacts/<session>/<path>` — bytes a tool captured into
 *   `DATA_DIR`.
 * - `/api/files/<absolute path>` — any file on the host, addressed where it
 *   already lives (see `app/server/src/directFileHttp.ts`).
 *
 * The kind itself comes from `@assistant/shared/servedFiles`, the same table the
 * server derives its delivery from: a card that offered a download for a file
 * the server serves as readable text is the drift that table exists to prevent.
 *
 * Kept framework-free and free of `window`: these tests run DOM-free, and a
 * transcript row asks the same question about a link and about an image.
 */

import {
  servedFileKindOf,
  type ServedFileKind as SharedServedFileKind,
} from "@assistant/shared/servedFiles";

const SERVED_PREFIXES = ["/api/session-artifacts/", "/api/files/"];

/** What the web renders. `other` is the shared kind's name for "download". */
export type ServedFileKind = SharedServedFileKind;

/** Pathname of a served-file URL, or undefined when it is not one. */
function servedFilePathname(href: string | undefined): string | undefined {
  if (!href) return undefined;
  // Absolute app URLs and bare `/api/...` paths both occur: an agent writes the
  // path, the client later prefixes origin + token.
  const pathname = /^https?:\/\//.test(href)
    ? tryPathname(href)
    : href.split(/[?#]/)[0];
  if (!pathname) return undefined;
  return SERVED_PREFIXES.some((prefix) => pathname.startsWith(prefix))
    ? pathname
    : undefined;
}

/** The `/api/files/...` path serving one absolute host path. */
export function directFileApiPath(absolutePath: string): string {
  const segments = absolutePath
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent);
  return `/api/files/${segments.join("/")}`;
}

/** A document-relative reference: no scheme, no authority, not root-anchored. */
export function isDocumentRelativeUrl(url: string): boolean {
  return (
    !/^[a-z][a-z0-9+.-]*:/i.test(url) &&
    !url.startsWith("/") &&
    !url.startsWith("#")
  );
}

/**
 * Resolve a document-relative reference against the directory holding the
 * document, folding `.` and `..` — how a browser would resolve it, so a served
 * document's own links and images point where its author meant.
 */
export function resolveDocumentRelative(
  directory: string,
  url: string,
): string {
  const out: string[] = [];
  for (const segment of `${directory}/${url.split(/[?#]/)[0]}`.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return `/${out.join("/")}`;
}

/** File name for display: the last path segment, percent-decoded. */
export function servedFileName(href: string | undefined): string | undefined {
  const pathname = servedFilePathname(href) ?? href?.split(/[?#]/)[0];
  const segment = pathname?.split("/").filter(Boolean).pop();
  if (!segment) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * How the card should present the file. Extension-derived like the server's own
 * disposition, because a card renders before any metadata request answers; an
 * explicit MIME type (a session artifact carries one) wins where it is decisive.
 */
export function servedFileKind(
  href: string | undefined,
  mimeType?: string,
): ServedFileKind {
  if (mimeType?.startsWith("image/")) return "image";
  if (
    mimeType?.startsWith("video/") ||
    mimeType?.startsWith("audio/") ||
    mimeType === "application/pdf"
  )
    return "media";
  if (mimeType === "text/markdown") return "markdown";
  if (mimeType === "text/html") return "html";
  return servedFileKindOf(servedFileName(href) ?? "");
}

/** A file size as a reader reads it: three significant figures at most. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function tryPathname(href: string): string | undefined {
  try {
    return new URL(href).pathname;
  } catch {
    return undefined;
  }
}
