import type { ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const STATIC_CACHE = {
  /** Hashed Vite chunks are content-addressed, so repeat PWA launches should never re-download them. */
  immutable: "public, max-age=31536000, immutable",
  /** The SPA shell decides which hashed chunks to load; always revalidate it. */
  shell: "no-cache",
  /** PWA metadata and non-fingerprinted public assets can be reused briefly but must update quickly. */
  revalidate: "public, max-age=300, stale-while-revalidate=86400",
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

/** Content type for a served file, by extension. */
export function contentTypeFor(path: string): string {
  return MIME[extname(path)] ?? "application/octet-stream";
}

/**
 * Serve the built SPA from `webDist` with history fallback. Vite fingerprints
 * files under /assets, so those get a long immutable cache. The HTML shell is
 * always revalidated so a newly deployed index can point at new hashes.
 */
export async function serveWebStatic(
  urlPath: string,
  res: ServerResponse,
  { webDist, authToken }: { webDist: string; authToken: string },
): Promise<void> {
  const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(webDist, rel === "/" ? "index.html" : rel);
  let servedPath = rel === "/" ? "/index.html" : rel;
  let usedHistoryFallback = false;
  try {
    let body: Buffer;
    try {
      body = await readFile(filePath);
    } catch (err) {
      if (!shouldUseSpaFallback(servedPath)) throw err;
      filePath = join(webDist, "index.html");
      servedPath = "/index.html";
      usedHistoryFallback = true;
      body = await readFile(filePath);
    }
    // Inject the runtime auth token into the SPA shell. The build leaves a
    // literal `"%ASSISTANT_TOKEN%"` placeholder (never a secret in the bundle);
    // we replace it here with the JSON-encoded token the server resolved.
    if (servedPath === "/index.html") {
      const html = body
        .toString("utf8")
        .replaceAll('"%ASSISTANT_TOKEN%"', JSON.stringify(authToken));
      body = Buffer.from(html, "utf8");
    }
    res.writeHead(200, {
      "content-type": contentTypeFor(filePath),
      "cache-control": staticCacheControl(
        servedPath,
        extname(filePath),
        usedHistoryFallback,
      ),
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "cache-control": "no-store" });
    res.end("Not found");
  }
}

/** Namespaces the server owns: a miss there is a real 404, never an app route. */
const SERVER_OWNED_PREFIXES = ["/assets/", "/api/", "/mcp/", "/.well-known/"];

/**
 * Whether a path missing from the build is a client route that gets the shell.
 *
 * Decided by the build's SHAPE, not by the route table or request headers. The
 * web root holds exactly two kinds of file: Vite's hashed `/assets/*` and the
 * flat top-level files copied from `app/web/public` (index, sw.js, manifest,
 * icons). So a missing top-level file with an extension (`/favicon.xyz`) is a
 * genuine 404, while anything NESTED outside the server-owned namespaces can
 * only be a client route — and those end in a user-chosen last segment
 * (`/files/<abs path>`, `/artifacts/<session>/<path>`, `/knowledge/~file/…`,
 * `/tasks/<id>`, `/worktrees/<id>`), which may carry any extension. A copy of
 * the router's prefixes would drift when a route family is added; sniffing
 * `Sec-Fetch-Mode: navigate` would miss curl and hand an iframe probing a
 * missing file the whole app. `webStatic.test.ts` pins `public/` flat.
 */
function shouldUseSpaFallback(servedPath: string): boolean {
  if (SERVER_OWNED_PREFIXES.some((prefix) => servedPath.startsWith(prefix)))
    return false;
  if (extname(servedPath) === "") return true;
  return servedPath.indexOf("/", 1) > 0;
}

function staticCacheControl(
  servedPath: string,
  ext: string,
  historyFallback: boolean,
): string {
  if (
    historyFallback ||
    servedPath === "/index.html" ||
    servedPath === "/sw.js"
  )
    return STATIC_CACHE.shell;
  if (servedPath.startsWith("/assets/")) return STATIC_CACHE.immutable;
  if (
    ext === ".webmanifest" ||
    ext === ".svg" ||
    ext === ".png" ||
    ext === ".ico" ||
    ext === ".css"
  )
    return STATIC_CACHE.revalidate;
  return STATIC_CACHE.revalidate;
}
