/**
 * The HTTP call both Atlassian products share, with an API token (Basic) or
 * an OAuth access token (Bearer).
 *
 * Jira and Confluence are the same site, the same Atlassian account and the
 * same API token; only the path prefix differs (`/rest/api/3` vs `/wiki`). The
 * retry policy is the part that matters and must not drift between them:
 * reads back off through `fetchWithRetry` because Atlassian answers bulk work
 * with 429, while a write gets ONE attempt unless the caller opts in, so an
 * issue, comment or page the server already committed is never replayed.
 *
 * A `MultipartUpload` body (`multipartUpload.ts`; attachment uploads are the
 * only caller) goes out as a streamed request with its own Content-Type and
 * exact Content-Length, and the XSRF opt-out header Confluence requires on that
 * route. Its private signal joins the call's own, so retiring the body aborts
 * the request. A stream is single-use, so such a body never takes `retry` and
 * never follows a redirect: it is sent with `redirect: "error"`, without which
 * fetch keeps a tee of the whole body for a replay.
 *
 * A Bearer config (Task-1411) never goes to the site: its destination is
 * fixed to `https://api.atlassian.com/ex/<jira|confluence>/<cloudId>`, the
 * path must be site-relative, and the final URL's origin and product/cloudId
 * prefix are checked before any request. Its `host` is the site for browse
 * URLs only.
 */
import { fetchWithRetry } from "../httpRetry.ts";
import { MultipartUpload } from "./multipartUpload.ts";

export interface AtlassianApiConfig {
  /** Atlassian site host, e.g. `example.atlassian.net`. */
  host: string;
  atlassianEmail: string;
  atlassianToken: string;
}

interface AtlassianBearerConfig {
  /** The site, for browse URLs; never the destination. */
  host: string;
  /** The site's Atlassian cloud id, a UUID. */
  cloudId: string;
  bearerToken: string;
}

/** What the calls below take: an API token (Basic) or an access token (Bearer). */
export type AtlassianConfig = AtlassianApiConfig | AtlassianBearerConfig;

/** Which product a call belongs to; only shapes error text and settings hints. */
export type AtlassianProduct = "Jira" | "Confluence";

export interface AtlassianCallOptions {
  signal?: AbortSignal;
  retry?: boolean;
}

/**
 * A non-2xx answer. The message is the one callers always saw; `status` lets
 * a caller that must not repeat upstream text (the gateway's tools) decide by
 * code alone. `reasons` are the string entries of Atlassian's error body
 * (`errorMessages` items, then `errors` values, field names dropped), raw and
 * whole: a caller that shows any must vet them itself (Task-1439 D4).
 */
export class AtlassianHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reasons?: readonly string[],
  ) {
    super(message);
  }
}

/**
 * The reasons in an Atlassian error body, or none when it is not a JSON
 * object or holds no string reason. Malformed containers and non-string
 * entries are skipped.
 */
function upstreamReasons(text: string): readonly string[] | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isPlainObject(body)) return undefined;
  const reasons: string[] = [];
  const { errorMessages, errors } = body;
  if (Array.isArray(errorMessages))
    for (const entry of errorMessages)
      if (typeof entry === "string") reasons.push(entry);
  if (isPlainObject(errors))
    for (const value of Object.values(errors))
      if (typeof value === "string") reasons.push(value);
  return reasons.length > 0 ? reasons : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type AtlassianQuery = Record<
  string,
  string | number | boolean | undefined
>;

const ATLASSIAN_API_ORIGIN = "https://api.atlassian.com";
const CLOUD_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Site base URL. A host that already names its scheme keeps it. */
export function atlassianBaseUrl(host: string): string {
  const base = host.match(/^https?:\/\//i) ? host : `https://${host}`;
  return base.replace(/\/$/, "");
}

export async function atlassianFetch<T>(
  config: AtlassianConfig,
  product: AtlassianProduct,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  query?: AtlassianQuery,
  options: AtlassianCallOptions = {},
): Promise<T> {
  requireCredentials(config, product);
  const url =
    "bearerToken" in config
      ? bearerUrl(config, product, path)
      : new URL(
          path.startsWith("http")
            ? path
            : `${atlassianBaseUrl(config.host)}${path.startsWith("/") ? "" : "/"}${path}`,
        );
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const upload = body instanceof MultipartUpload ? body : undefined;
  if (upload && options.retry)
    throw new TypeError(
      "A streamed upload body is single-use; it never retries.",
    );
  const signal = upload
    ? options.signal
      ? AbortSignal.any([options.signal, upload.signal])
      : upload.signal
    : options.signal;
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: {
      Authorization: authorization(config),
      Accept: "application/json",
      ...(body === undefined
        ? {}
        : upload
          ? {
              "X-Atlassian-Token": "no-check",
              "Content-Type": upload.contentType,
              "Content-Length": String(upload.contentLength),
            }
          : { "Content-Type": "application/json" }),
    },
    ...(body === undefined
      ? {}
      : upload
        ? // `redirect: "error"`: under any other mode fetch tees the body
          // to replay it on a redirect, and the unread branch buffers every
          // byte sent. A stream cannot be replayed anyway.
          { body: upload.stream, duplex: "half", redirect: "error" }
        : { body: JSON.stringify(body) }),
  };
  const res = await fetchWithRetry(url, init, {
    ...(options.retry ? {} : { attempts: 1 }),
    ...(signal ? { signal } : {}),
  });
  const text = await res.text();
  if (!res.ok)
    throw new AtlassianHttpError(
      `${product} API returned HTTP ${res.status} for ${method} ${url.pathname}: ${text.slice(0, 400)}`,
      res.status,
      upstreamReasons(text),
    );
  return text ? (JSON.parse(text) as T) : ({} as T);
}

/** Why a download failed, for a caller that must not repeat its message. */
export type AtlassianDownloadReason =
  "http" | "declared_too_large" | "streamed_too_large";

/**
 * A download refusal (Task-1441 P7a, G3). The message is the one the local
 * tool always showed and may quote the product's body; the edge decides by
 * `reason` and `status` alone.
 */
export class AtlassianDownloadError extends Error {
  constructor(
    message: string,
    readonly reason: AtlassianDownloadReason,
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * The most of a non-OK download body read for its message: the message
 * quotes 400 UTF-16 code units, which take at most 1,200 UTF-8 bytes.
 */
const ERROR_BODY_MAX_BYTES = 2048;

/**
 * GET a binary resource from the site, holding at most `maxBytes` in memory.
 * A file that turns out larger is an error rather than a truncated copy: a
 * clipped PDF or image is not a smaller version of the file, it is a broken
 * one.
 *
 * `path` must be site-relative, so the credential can only be sent to the
 * configured host (with Bearer, the fixed API base). Attachment downloads
 * answer with a redirect to Atlassian's media host; fetch drops
 * `Authorization` on that cross-origin hop and the signed URL it lands on
 * needs none. Node 24 and the packaged Bun 1.4.2 both do
 * (`atlassianDownload.test.ts`, Task-1441 P7A-R1).
 *
 * Every exit but success cancels the body and drops what was read, so a
 * failed or aborted download holds no bytes once this settles (P7a, H1). A
 * retryable answer's body and a failure's body are read at most 2 KiB deep.
 */
export async function atlassianDownload(
  config: AtlassianConfig,
  product: AtlassianProduct,
  path: string,
  maxBytes: number,
  options: AtlassianCallOptions = {},
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  requireCredentials(config, product);
  let url: URL;
  if ("bearerToken" in config) url = bearerUrl(config, product, path);
  else {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new Error(
        `${product} download path must be site-relative: ${path}`,
      );
    url = new URL(`${atlassianBaseUrl(config.host)}${path}`);
  }
  const res = await fetchWithRetry(
    url,
    { method: "GET", headers: { Authorization: authorization(config) } },
    {
      retryBodyLimitBytes: ERROR_BODY_MAX_BYTES,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  const reader = res.body?.getReader();
  let chunks: Uint8Array[] = [];
  let done = false;
  try {
    if (!res.ok) {
      const text = await boundedText(reader, ERROR_BODY_MAX_BYTES);
      throw new AtlassianDownloadError(
        `${product} download returned HTTP ${res.status} for ${url.pathname}: ${text.slice(0, 400)}`,
        "http",
        res.status,
      );
    }
    const tooLarge = (reason: AtlassianDownloadReason) =>
      new AtlassianDownloadError(
        `${product} download exceeds the ${maxBytes}-byte limit; raise maxBytes to fetch it.`,
        reason,
      );
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes)
      throw tooLarge("declared_too_large");
    let total = 0;
    while (reader) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw tooLarge("streamed_too_large");
      chunks.push(next.value);
    }
    done = true;
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes, contentType: res.headers.get("content-type") };
  } finally {
    chunks = [];
    if (!done) await reader?.cancel().catch(() => undefined);
  }
}

/** Up to about `max` bytes of a body as text, the rest left unread. */
async function boundedText(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  max: number,
): Promise<string> {
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let read = 0;
  while (read < max) {
    const next = await reader.read();
    if (next.done) break;
    parts.push(next.value);
    read += next.value.byteLength;
  }
  return new TextDecoder().decode(Buffer.concat(parts).subarray(0, max));
}

/**
 * The Bearer destination: the product's fixed API base for the cloud id plus
 * a site-relative `path`. Anything else, or a URL that normalizes out of that
 * base, is refused before a request is made; the site (`host`) plays no part.
 */
function bearerUrl(
  config: AtlassianBearerConfig,
  product: AtlassianProduct,
  path: string,
): URL {
  if (!CLOUD_ID_RE.test(config.cloudId))
    throw new Error(`${product} OAuth credential has no valid cloud id.`);
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
    throw new Error(`${product} path must be site-relative.`);
  const base = `/ex/${product === "Jira" ? "jira" : "confluence"}/${config.cloudId}/`;
  const url = new URL(`${ATLASSIAN_API_ORIGIN}${base.slice(0, -1)}${path}`);
  if (url.origin !== ATLASSIAN_API_ORIGIN || !url.pathname.startsWith(base))
    throw new Error(`${product} path must be site-relative.`);
  return url;
}

function requireCredentials(
  config: AtlassianConfig,
  product: AtlassianProduct,
): void {
  if ("bearerToken" in config) {
    if (!config.bearerToken)
      throw new Error(
        `Missing Atlassian access token; reconnect ${product} on the gateway's page.`,
      );
    return;
  }
  if (!config.atlassianEmail || !config.atlassianToken)
    throw new Error(
      `Missing Atlassian email or API token. Configure them in Settings → ${product}.`,
    );
}

function authorization(config: AtlassianConfig): string {
  if ("bearerToken" in config) return `Bearer ${config.bearerToken}`;
  const token = Buffer.from(
    `${config.atlassianEmail}:${config.atlassianToken}`,
  ).toString("base64");
  return `Basic ${token}`;
}
