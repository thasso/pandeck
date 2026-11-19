/** Relay-local C3 classifier. The closed node-only boundary requires this copy. */
export type ClientCredentialClass =
  "none" | "placeholder" | "lease" | "mcp-token" | "other";

export const MACHINE_PLACEHOLDER =
  "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoicGFuZGVjay1nYXRld2F5In0sInBhbmRlY2siOnsidiI6MSwibWFjaGluZSI6dHJ1ZX19.pandeck";

const RANK: Record<ClientCredentialClass, number> = {
  none: 0,
  placeholder: 1,
  lease: 2,
  "mcp-token": 3,
  other: 4,
};

/** Same MCP token shape as gateway/requestCredential.ts. */
const MCP_TOKEN_RE = /^pgmcp_[A-Za-z0-9_-]{43}$/;

/** Same lease shape as gateway/leases.ts, without checking authenticity. */
function leaseShaped(token: string): boolean {
  const segments = token.split(".");
  if (
    segments.length !== 3 ||
    !segments.every((s) => /^[A-Za-z0-9_-]+$/.test(s))
  )
    return false;
  let payload: unknown;
  try {
    payload = JSON.parse(
      Buffer.from(segments[1]!, "base64url").toString("utf8"),
    );
  } catch {
    return false;
  }
  const pandeck =
    typeof payload === "object" && payload !== null
      ? (payload as { pandeck?: unknown }).pandeck
      : undefined;
  if (typeof pandeck !== "object" || pandeck === null) return false;
  const { v, lease } = pandeck as { v?: unknown; lease?: unknown };
  return (
    v === 1 && typeof lease === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(lease)
  );
}

export function classifyClientCredential(
  rawHeaders: readonly string[],
): ClientCredentialClass {
  let worst: ClientCredentialClass = "none";
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]!.toLowerCase();
    if (
      name !== "authorization" &&
      name !== "x-api-key" &&
      name !== "proxy-authorization"
    )
      continue;
    const value = rawHeaders[i + 1]!.trim();
    const token =
      name === "x-api-key" ? value : /^Bearer +(\S+)$/i.exec(value)?.[1];
    const found = !token
      ? "other"
      : token === MACHINE_PLACEHOLDER
        ? "placeholder"
        : MCP_TOKEN_RE.test(token)
          ? "mcp-token"
          : leaseShaped(token)
            ? "lease"
            : "other";
    if (RANK[found] > RANK[worst]) worst = found;
  }
  return worst;
}

export function hasClientCookie(rawHeaders: readonly string[]): boolean {
  for (let i = 0; i + 1 < rawHeaders.length; i += 2)
    if (rawHeaders[i]!.toLowerCase() === "cookie") return true;
  return false;
}
