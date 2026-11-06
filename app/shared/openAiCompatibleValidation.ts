/** Endpoint rules shared by account edits and the credential gateway. */
const MAX_BASE_URL_BYTES = 2048;
/** A key can never end a header or start another. */
const API_KEY_RE = /^[\x21-\x7e]{1,8192}$/;

/** Existing account normalization, applied before comparing an edit. */
export function normalizeOpenAiCompatibleBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/** Parse exactly the URL forms the gateway can forward. Empty ? and # are allowed. */
export function openAiCompatibleBaseUrl(baseUrl: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  return url;
}

/** Errors contain only fixed text, never the URL or a key. No normalization here. */
export function openAiCompatibleBaseUrlError(
  baseUrl: unknown,
): string | undefined {
  if (typeof baseUrl !== "string" || !openAiCompatibleBaseUrl(baseUrl))
    return "Base URL must be an http or https URL without userinfo, a query or a fragment.";
  if (new TextEncoder().encode(baseUrl).byteLength > MAX_BASE_URL_BYTES)
    return "Base URL must be at most 2048 bytes.";
  return undefined;
}

export function openAiCompatibleApiKeyError(
  apiKey: unknown,
): string | undefined {
  return typeof apiKey === "string" && API_KEY_RE.test(apiKey)
    ? undefined
    : "API key must contain 1 to 8192 visible ASCII characters (0x21 to 0x7e), without spaces or control characters.";
}
