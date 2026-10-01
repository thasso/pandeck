/**
 * Centralizes how the web client reaches the API/WS server and authenticates to
 * it. In dev the UI is served by Vite (e.g. :5173) while the API/WS server runs
 * separately (:8787), so requests are cross-origin and need the shared secret;
 * in prod the server serves the page itself and same-origin requests apply.
 *
 * The server gates `/api/*` and the WS upgrade on a token (see
 * app/server/src/authToken.ts). Header-capable contexts (`fetch`) send it as a
 * header; header-less contexts (`<img>`, downloads, WebSocket) must put it in
 * the `token=` query.
 */

/** http(s) origin of the API/WS server. */
export function serverHttpOrigin(): string {
  if (import.meta.env.DEV) {
    const origin =
      import.meta.env.VITE_SERVER_ORIGIN ?? `${location.hostname}:8787`;
    return `${location.protocol}//${origin}`;
  }
  return location.origin;
}

declare global {
  interface Window {
    __ASSISTANT_TOKEN__?: string;
  }
}

/**
 * The shared secret, injected into index.html at serve time (Node server in
 * prod, Vite dev plugin in dev) rather than baked into the JS bundle. The
 * unreplaced placeholder is treated as "no token".
 */
export function assistantToken(): string {
  const raw = window.__ASSISTANT_TOKEN__;
  return typeof raw === "string" && raw !== "%ASSISTANT_TOKEN%" ? raw : "";
}

/** Auth header to spread into `fetch` calls to the server; empty when no token. */
export function authHeaders(): Record<string, string> {
  const token = assistantToken();
  return token ? { "x-assistant-token": token } : {};
}

/**
 * Append the `token=` query for header-less contexts (`<img src>`, anchor
 * downloads, EventSource, WebSocket). No-op when there is no token.
 */
export function withToken(url: string): string {
  const token = assistantToken();
  if (!token) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

/**
 * The authenticated URL for one session artifact. External URLs are used as-is;
 * a server-hosted artifact gets the origin plus the token, so header-less
 * contexts (`<img>`, anchor downloads, blob fetches) authenticate.
 */
export function artifactHttpUrl(pathOrUrl: string): string {
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
  return withToken(`${serverHttpOrigin()}${pathOrUrl}`);
}
