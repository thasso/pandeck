/**
 * What kind of credential a client sent, for the request log (Task-1430 C3):
 * a class, never a value. Pure, so the relay's reporting (PR2a) and the edge
 * classify alike; the relay may not import it and keeps its own copy.
 *
 * Every value of `authorization`, `x-api-key` and `proxy-authorization`
 * counts, repeats included and names in any case. The most sensitive class
 * wins: `other` > `mcp-token` > `lease` > `placeholder` > `none`. A bearer
 * (or an `x-api-key` value) equal to the public machine placeholder is
 * `placeholder`, a lease-shaped one `lease`, one shaped like a client's MCP
 * token `mcp-token` (Task-1437); anything else, an empty or malformed value
 * included, is `other`. Shapes only: whether a token is valid is not read.
 */
import { isLeaseShaped } from "./leases.ts";

export type ClientCredentialClass =
  "none" | "placeholder" | "lease" | "mcp-token" | "other";

/**
 * The fixed, public placeholder a standalone harness sends as its key
 * (`docs/workers.md` "Standalone harnesses"). It names no lease and grants
 * nothing on its own.
 */
export const MACHINE_PLACEHOLDER =
  "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoicGFuZGVjay1nYXRld2F5In0sInBhbmRlY2siOnsidiI6MSwibWFjaGluZSI6dHJ1ZX19.pandeck";

const RANK: Record<ClientCredentialClass, number> = {
  none: 0,
  placeholder: 1,
  lease: 2,
  "mcp-token": 3,
  other: 4,
};

/**
 * A client's MCP token as minted (`clientRegistry.ts`, the relay's
 * enrollment): `pgmcp_` and 32 random bytes, base64url.
 */
const MCP_TOKEN_RE = /^pgmcp_[A-Za-z0-9_-]{43}$/;

/** A bearer's token, or undefined when the value is not `Bearer <token>`. */
const BEARER_RE = /^Bearer +(\S+)$/i;

function tokenClass(token: string | undefined): ClientCredentialClass {
  if (!token) return "other";
  if (token === MACHINE_PLACEHOLDER) return "placeholder";
  if (MCP_TOKEN_RE.test(token)) return "mcp-token";
  return isLeaseShaped(token) ? "lease" : "other";
}

function valueClass(name: string, value: string): ClientCredentialClass {
  const trimmed = value.trim();
  return name === "x-api-key"
    ? tokenClass(trimmed)
    : tokenClass(BEARER_RE.exec(trimmed)?.[1]);
}

/** The class of every credential header in Node's flat `rawHeaders`. */
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
    const found = valueClass(name, rawHeaders[i + 1]!);
    if (RANK[found] > RANK[worst]) worst = found;
  }
  return worst;
}

/** Whether any `cookie` field was sent; never its value. */
export function hasClientCookie(rawHeaders: readonly string[]): boolean {
  for (let i = 0; i + 1 < rawHeaders.length; i += 2)
    if (rawHeaders[i]!.toLowerCase() === "cookie") return true;
  return false;
}
