/**
 * The Basic-auth HTTP call both Atlassian products share.
 *
 * Jira and Confluence are the same site, the same Atlassian account and the
 * same API token; only the path prefix differs (`/rest/api/3` vs `/wiki`). The
 * retry policy is the part that matters and must not drift between them:
 * reads back off through `fetchWithRetry` because Atlassian answers bulk work
 * with 429, while a write gets ONE attempt unless the caller opts in, so an
 * issue, comment or page the server already committed is never replayed.
 *
 * A `FormData` body goes out as multipart — attachment uploads are the only
 * caller — with the XSRF opt-out header Confluence requires on that route;
 * fetch writes the boundary, so no Content-Type is set by hand.
 */
import { fetchWithRetry } from "../httpRetry.ts";

export interface AtlassianApiConfig {
  /** Atlassian site host, e.g. `example.atlassian.net`. */
  host: string;
  atlassianEmail: string;
  atlassianToken: string;
}

/** Which product a call belongs to; only shapes error text and settings hints. */
export type AtlassianProduct = "Jira" | "Confluence";

export interface AtlassianCallOptions {
  signal?: AbortSignal;
  retry?: boolean;
}

export type AtlassianQuery = Record<
  string,
  string | number | boolean | undefined
>;

/** Site base URL. A host that already names its scheme keeps it. */
export function atlassianBaseUrl(host: string): string {
  const base = host.match(/^https?:\/\//i) ? host : `https://${host}`;
  return base.replace(/\/$/, "");
}

export async function atlassianFetch<T>(
  config: AtlassianApiConfig,
  product: AtlassianProduct,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  query?: AtlassianQuery,
  options: AtlassianCallOptions = {},
): Promise<T> {
  requireCredentials(config, product);
  const url = new URL(
    path.startsWith("http")
      ? path
      : `${atlassianBaseUrl(config.host)}${path.startsWith("/") ? "" : "/"}${path}`,
  );
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const multipart = body instanceof FormData;
  const res = await fetchWithRetry(
    url,
    {
      method,
      headers: {
        Authorization: basicAuth(config),
        Accept: "application/json",
        ...(body === undefined
          ? {}
          : multipart
            ? { "X-Atlassian-Token": "no-check" }
            : { "Content-Type": "application/json" }),
      },
      ...(body === undefined
        ? {}
        : { body: multipart ? body : JSON.stringify(body) }),
    },
    {
      ...(options.retry ? {} : { attempts: 1 }),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  const text = await res.text();
  if (!res.ok)
    throw new Error(
      `${product} API returned HTTP ${res.status} for ${method} ${url.pathname}: ${text.slice(0, 400)}`,
    );
  return text ? (JSON.parse(text) as T) : ({} as T);
}

/**
 * GET a binary resource from the site, holding at most `maxBytes` in memory.
 * A file that turns out larger is an error rather than a truncated copy: a
 * clipped PDF or image is not a smaller version of the file, it is a broken
 * one.
 *
 * `path` must be site-relative, so the credential can only be sent to the
 * configured host. Attachment downloads answer with a redirect to Atlassian's
 * media host; fetch drops `Authorization` on that cross-origin hop and the
 * signed URL it lands on needs none.
 */
export async function atlassianDownload(
  config: AtlassianApiConfig,
  product: AtlassianProduct,
  path: string,
  maxBytes: number,
  options: AtlassianCallOptions = {},
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  requireCredentials(config, product);
  if (!path.startsWith("/") || path.startsWith("//"))
    throw new Error(`${product} download path must be site-relative: ${path}`);
  const url = new URL(`${atlassianBaseUrl(config.host)}${path}`);
  const res = await fetchWithRetry(
    url,
    { method: "GET", headers: { Authorization: basicAuth(config) } },
    options.signal ? { signal: options.signal } : {},
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `${product} download returned HTTP ${res.status} for ${url.pathname}: ${text.slice(0, 400)}`,
    );
  }
  const tooLarge = () =>
    new Error(
      `${product} download exceeds the ${maxBytes}-byte limit; raise maxBytes to fetch it.`,
    );
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  while (reader) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, contentType: res.headers.get("content-type") };
}

function requireCredentials(
  config: AtlassianApiConfig,
  product: AtlassianProduct,
): void {
  if (!config.atlassianEmail || !config.atlassianToken)
    throw new Error(
      `Missing Atlassian email or API token. Configure them in Settings → ${product}.`,
    );
}

function basicAuth(config: AtlassianApiConfig): string {
  const token = Buffer.from(
    `${config.atlassianEmail}:${config.atlassianToken}`,
  ).toString("base64");
  return `Basic ${token}`;
}
