import type { IncomingMessage, ServerResponse } from "node:http";
import { createGoogleOAuthStartUrl } from "./googleSettings.ts";

/** Authenticated consent-URL preparation for native shells without popup support. */
export function handleGoogleOAuthPrepare(
  req: IncomingMessage,
  res: ServerResponse,
  headers: Record<string, string>,
  publicBaseUrl?: string,
): void {
  const responseHeaders = { ...headers, "cache-control": "no-store" };
  if (req.method !== "POST") {
    res.writeHead(405, { ...responseHeaders, allow: "POST" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }
  try {
    const url = createGoogleOAuthStartUrl(publicBaseUrl);
    res.writeHead(200, responseHeaders);
    res.end(JSON.stringify({ url }));
  } catch {
    res.writeHead(400, responseHeaders);
    res.end(JSON.stringify({ error: "Could not start Google sign-in." }));
  }
}
