/**
 * Serves an agent-authored DOCUMENT — HTML today — that must run as a real page
 * with its own subresources, without ever executing on the API origin.
 *
 * `/api/files/...` (directFileHttp.ts) cannot do this: it carries the app token
 * in `?token=`, so a page served from it could read its own URL and steal the
 * token, which on this app is remote code execution. Force-downloading HTML is
 * why that route stays safe.
 *
 * A GRANT is the way out. `documentGrantTargets.ts` first resolves a typed
 * internal source; minting its resolved `/home/alice/report.html` returns an
 * opaque id standing for its directory (runnable HTML) or that exact file
 * (external open/download), served from `/api/file-grants/<id>/report.html`:
 *
 *  - The grant id IS the credential, so the URL carries no app token. A script
 *    in the page can read it, and gains nothing it did not already have: the
 *    grant reaches only its declared directory or file, and never
 *    `DATA_DIR/.assistant-token`.
 *  - Relative subresources (`./chart.js`, `./style.css`) resolve inside the
 *    grant on their own, so the same URL works in a sandboxed iframe in chat
 *    and in a full browser tab.
 *  - The document is served under a sandbox CSP with no `allow-same-origin`, so
 *    it lives in an opaque origin: no app storage, no app DOM, no cookies.
 *
 * A grant is a capability over ONE directory or ONE file, so its limits are
 * the whole security model and are enforced against reality rather than spelling:
 * containment is decided on the CANONICAL path (a symlink inside the directory
 * would otherwise reach the entire host) and re-checked against the opened
 * descriptor, and `expiresAt` is fixed at mint — an unauthenticated read never
 * moves it, or a leaked id would renew itself forever.
 *
 * Grants are in-memory and re-mintable by the trusted web client at view time,
 * so an old transcript's link keeps working without persisting anything.
 */
import { open, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { extname, join, resolve, sep } from "node:path";
import {
  servedFileInlineContentTypeOf,
  servedFileKindOf,
  type FileGrantDeliveryMode,
  type FileGrantScope,
} from "@assistant/shared/servedFiles";
import { parseByteRange } from "./directFileHttp.ts";

type Headers = Record<string, string>;

export const FILE_GRANT_PREFIX = "/api/file-grants/";

/** Long enough to read a document, short enough that a leaked id goes stale. */
const GRANT_TTL_MS = 60 * 60 * 1000;
/**
 * Below this, a re-mint gets a FRESH id instead of the live grant: the trusted
 * client asking again is what renews access, and handing back an id that is
 * about to die would make its own answer useless.
 */
const GRANT_REUSE_FLOOR_MS = 5 * 60 * 1000;
const MAX_GRANTS = 200;

interface FileGrant {
  id: string;
  /** Typed authority identity; grants from different sources never coalesce. */
  sourceKey: string;
  /** Canonical (symlink-resolved) directory this grant reaches. */
  directory: string;
  /** A browser-open/download grant may address only its original file. */
  fileName?: string;
  /** Response behavior is part of the capability, never a URL toggle. */
  delivery: FileGrantDeliveryMode;
  /**
   * Fixed at mint and never moved. A read must not extend it: the reader is
   * unauthenticated, so a sliding window would let anyone holding a leaked id
   * keep it alive forever — exactly the case the TTL exists for.
   */
  expiresAt: number;
}

const grants = new Map<string, FileGrant>();

/** One minted document: where it is served from, and until when. */
export interface MintedDocument {
  /** Opaque id of the directory grant behind the URL. */
  grantId: string;
  /** `/api/file-grants/<id>/<name>` for the document itself. */
  url: string;
  /** The canonical file the URL resolves to. */
  documentPath: string;
  expiresAt: number;
  delivery: FileGrantDeliveryMode;
}

/**
 * Mint a grant for `filePath` itself or its containing directory — the path
 * must be an existing file — and return the URL of that document under it.
 *
 * The path is canonicalized ONCE and everything downstream uses the result: the
 * grant's directory, the containment checks, and the document's own name in the
 * URL. Mixing the two spellings is a real failure and not a theoretical one: a
 * grant minted through `/links/alias.html` would be scoped to the canonical
 * `/real` while the URL still said `alias.html`, so the page 404d inside the
 * frame. A live grant for the same directory is reused while it has time left,
 * so re-opening a document does not multiply ids or invalidate a page still
 * loading its subresources.
 */
export async function mintDocumentGrant(
  filePath: string,
  scope: FileGrantScope = "directory",
  delivery: FileGrantDeliveryMode = "inline",
  authority: { root: string; sourceKey: string; fresh?: boolean } = {
    root: sep,
    sourceKey: "host",
  },
): Promise<MintedDocument> {
  if (delivery === "attachment" && scope !== "file")
    throw new Error("Attachment grants must be scoped to one file.");
  sweepExpiredGrants();
  // The DOCUMENT has to exist, not just its directory: a grant is minted to
  // show one file, and an iframe pointed at a missing one would 404 inside the
  // frame with nothing on the page to say why.
  const [documentPath, authorityRoot] = await Promise.all([
    realpath(resolve(filePath)),
    realpath(resolve(authority.root)),
  ]);
  if (documentPath !== authorityRoot && !isInside(authorityRoot, documentPath))
    throw new Error("Document is outside its source authority.");
  if (!(await stat(documentPath)).isFile())
    throw new Error(`Not a file: ${documentPath}`);
  // Directory scope grants every sibling under the canonical parent. Only a
  // canonical runnable HTML document can justify that authority: checking the
  // client spelling would let `page.html -> notes.txt` acquire it.
  if (scope === "directory" && servedFileKindOf(documentPath) !== "html")
    throw new Error("Directory grants require a canonical HTML document.");
  const segments = documentPath.split(sep);
  const name = segments.pop() ?? "";
  const directory = segments.join(sep) || sep;
  const grant = grantForDirectory(
    authority.sourceKey,
    directory,
    scope === "file" ? name : undefined,
    delivery,
    authority.fresh === true,
  );
  return {
    grantId: grant.id,
    url: `${FILE_GRANT_PREFIX}${grant.id}/${encodeURIComponent(name)}`,
    documentPath,
    expiresAt: grant.expiresAt,
    delivery: grant.delivery,
  };
}

function grantForDirectory(
  sourceKey: string,
  directory: string,
  fileName: string | undefined,
  delivery: FileGrantDeliveryMode,
  fresh: boolean,
): FileGrant {
  const now = Date.now();
  if (!fresh)
    for (const grant of grants.values()) {
      if (
        grant.sourceKey === sourceKey &&
        grant.directory === directory &&
        grant.fileName === fileName &&
        grant.delivery === delivery &&
        grant.expiresAt - now > GRANT_REUSE_FLOOR_MS
      )
        return grant;
    }
  if (grants.size >= MAX_GRANTS) {
    const oldest = [...grants.values()].sort(
      (a, b) => a.expiresAt - b.expiresAt,
    )[0];
    if (oldest) grants.delete(oldest.id);
  }
  const grant: FileGrant = {
    id: randomBytes(24).toString("base64url"),
    sourceKey,
    directory,
    ...(fileName ? { fileName } : {}),
    delivery,
    expiresAt: now + GRANT_TTL_MS,
  };
  grants.set(grant.id, grant);
  return grant;
}

function sweepExpiredGrants(): void {
  const now = Date.now();
  for (const [id, grant] of grants)
    if (grant.expiresAt <= now) grants.delete(id);
}

/** A grant target that passed containment, with the identity it passed AS. */
export interface FileGrantTarget {
  /** Canonical path, inside the grant's canonical directory. */
  path: string;
  size: number;
  /** Filesystem identity, re-checked against the opened descriptor. */
  dev: number;
  ino: number;
  delivery: FileGrantDeliveryMode;
  scope: FileGrantScope;
  /** Canonical basename used only when delivery is attachment. */
  fileName: string;
}

/**
 * The file a grant URL addresses, or undefined when the URL reaches nothing the
 * grant may serve. Containment is decided TWICE, and both are load-bearing:
 *
 *  - lexically, so no `..` or encoded spelling names a path outside the
 *    directory;
 *  - then on the CANONICAL path, because `..` is not the only way out. A
 *    symlink inside the granted directory pointing anywhere on the host reads
 *    as a contained path and resolves to an uncontained file, which would turn
 *    a one-directory capability into a whole-filesystem one.
 *
 * The identity returned here is re-checked against the descriptor the caller
 * opens, so replacing the file with a symlink after this check does not win the
 * race either.
 */
export async function resolveFileGrantTarget(
  pathname: string,
): Promise<FileGrantTarget | undefined> {
  if (!pathname.startsWith(FILE_GRANT_PREFIX)) return undefined;
  const rest = pathname.slice(FILE_GRANT_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return undefined;
  const grant = grants.get(rest.slice(0, slash));
  if (!grant || grant.expiresAt <= Date.now()) return undefined;

  let relative: string;
  try {
    relative = rest
      .slice(slash + 1)
      .split("/")
      .map(decodeURIComponent)
      .join("/");
  } catch {
    return undefined;
  }
  if (!relative || relative.includes("\0")) return undefined;
  if (grant.fileName !== undefined && relative !== grant.fileName)
    return undefined;

  const lexical = resolve(join(grant.directory, relative));
  if (!isInside(grant.directory, lexical)) return undefined;

  try {
    const canonical = await realpath(lexical);
    if (!isInside(grant.directory, canonical)) return undefined;
    const stats = await stat(canonical);
    if (!stats.isFile()) return undefined;
    return {
      path: canonical,
      size: stats.size,
      dev: stats.dev,
      ino: stats.ino,
      delivery: grant.delivery,
      scope: grant.fileName === undefined ? "directory" : "file",
      fileName: canonical.split(sep).pop() ?? "download",
    };
  } catch {
    return undefined;
  }
}

function isInside(directory: string, path: string): boolean {
  const root = directory.endsWith(sep) ? directory : `${directory}${sep}`;
  return path.startsWith(root);
}

/**
 * Directory-only overrides for executable/loadable subresources the shared
 * top-level contract intentionally treats as inert text or unknown bytes.
 * Shared image/media MIME remains authoritative below.
 */
const RUNNABLE_DIRECTORY_CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

function grantInlineContentType(path: string, scope: FileGrantScope): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".html" || ext === ".htm") return "text/html; charset=utf-8";
  if (scope === "directory" && RUNNABLE_DIRECTORY_CONTENT_TYPES[ext])
    return RUNNABLE_DIRECTORY_CONTENT_TYPES[ext];
  return servedFileInlineContentTypeOf(path);
}

/**
 * Active document responses carry this CSP as a second opaque-sandbox boundary.
 * Passive file-scoped PDF is the deliberate exception: Chromium/WebKit's PDF
 * renderer may be blocked by either an iframe sandbox or a sandbox CSP, and the
 * capability already reaches exactly one inert file.
 */
export const FILE_GRANT_SANDBOX_CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads";

export function fileGrantDeliveryHeaders(
  path: string,
  delivery: FileGrantDeliveryMode = "inline",
  fileName = path.split(sep).pop() ?? "download",
  scope: FileGrantScope = "file",
): Headers {
  const contentType =
    delivery === "attachment"
      ? "application/octet-stream"
      : grantInlineContentType(path, scope);
  const passivePdf =
    delivery === "inline" &&
    scope === "file" &&
    contentType === "application/pdf";
  return {
    "content-type": contentType,
    ...(!passivePdf
      ? { "content-security-policy": FILE_GRANT_SANDBOX_CSP }
      : {}),
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    ...(delivery === "attachment"
      ? { "content-disposition": attachmentDisposition(fileName) }
      : {}),
  };
}

function attachmentDisposition(fileName: string): string {
  const fallback =
    fileName
      .replace(/[^A-Za-z0-9._ -]/g, "_")
      .trim()
      .slice(0, 180) || "download";
  const encoded = encodeURIComponent(fileName).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Serve one file under a grant. Unauthenticated by design — the grant id in the
 * path is the credential — so this handler must stay strictly a reader: no
 * query options, no writes, nothing outside the granted directory.
 */
export async function handleFileGrantRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  const fail = (status: number, message: string) => {
    res.writeHead(status, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(message);
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    fail(405, "Method not allowed.");
    return;
  }
  const target = await resolveFileGrantTarget(requestUrl.pathname);
  if (!target) {
    fail(404, "This document link has expired. Open the file again from chat.");
    return;
  }

  // Opened, then re-identified: the bytes that go out belong to the exact file
  // containment passed, even if the name was pointed elsewhere in between.
  const handle = await open(target.path, "r").catch(() => undefined);
  if (!handle) {
    fail(404, `No such file: ${target.path}`);
    return;
  }
  const opened = await handle.stat().catch(() => undefined);
  if (
    !opened?.isFile() ||
    opened.dev !== target.dev ||
    opened.ino !== target.ino
  ) {
    await handle.close();
    fail(404, "This document link no longer resolves to the same file.");
    return;
  }

  const baseHeaders = {
    ...fileGrantDeliveryHeaders(
      target.path,
      target.delivery,
      target.fileName,
      target.scope,
    ),
    "accept-ranges": "bytes",
  };
  const range = parseByteRange(req.headers.range, opened.size);
  if (range === "unsatisfiable") {
    await handle.close();
    res.writeHead(416, {
      ...baseHeaders,
      "content-range": `bytes */${opened.size}`,
    });
    res.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, opened.size - 1);
  const length = opened.size === 0 ? 0 : end - start + 1;
  res.writeHead(range ? 206 : 200, {
    ...baseHeaders,
    "content-length": String(length),
    ...(range
      ? { "content-range": `bytes ${start}-${end}/${opened.size}` }
      : {}),
  });
  if (req.method === "HEAD" || opened.size === 0) {
    await handle.close();
    res.end();
    return;
  }
  // Read from the DESCRIPTOR, not the path, so the identity checked above is
  // the identity streamed — and stop at the length already in the headers. An
  // unbounded stream over a file being appended to sends MORE than
  // `content-length` promised, which breaks response framing on a keep-alive
  // connection. `autoClose: false` keeps the descriptor ours, so it is closed
  // exactly once, below.
  const stream = handle.createReadStream({ start, end, autoClose: false });
  await new Promise<void>((done) => {
    const finish = () => {
      stream.destroy();
      done();
    };
    stream.on("error", () => {
      res.destroy();
      finish();
    });
    res.on("close", finish);
    stream.pipe(res);
    stream.on("end", done);
  });
  await handle.close().catch(() => undefined);
}

/** Test seam: drop every live grant. */
export function resetFileGrantsForTest(): void {
  grants.clear();
}
