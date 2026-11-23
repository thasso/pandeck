/**
 * The vault's one way to call an OAuth provider (Task-1411, Task-1452,
 * Task-1444): a bounded HTTPS request to a host from a closed set, with that
 * host as TLS name and `Host`. A test overrides where to connect, the CA and the
 * deadline (`VaultEndpoint`), never the host, so neither a code, a refresh
 * token, a client secret nor an access token can go anywhere else. Redirects
 * are not followed: a 3xx is `unreachable`, as is a network error, the
 * deadline or an answer over 64 KiB. The call never rejects and its result
 * holds a status, an errno code or a fixed word, never upstream text.
 */
import https from "node:https";
import type { TokenEndpoint } from "./claudeRenewal.ts";

/** The hosts the vault's OAuth and GitHub App clients reach; nothing else. */
type VaultHost =
  | "auth.atlassian.com"
  | "api.atlassian.com"
  | "slack.com"
  | "github.com"
  | "api.github.com";

/** Each call's deadline, connect to last byte. */
const VAULT_HTTP_TIMEOUT_MS = 8_000;
/** A token, site-list or identity answer is small; anything larger is not one. */
const MAX_RESPONSE_BYTES = 64 * 1024;
/** What the edge's decoders take (`gatewayTools/`). */
const MAX_TOKEN_CHARS = 8_192;
/** One year: the longest token lifetime the vault believes. */
export const MAX_EXPIRES_IN_S = 31_536_000;
const HEADER_SAFE_RE = /^[\x21-\x7e]+$/;

/** Where to connect instead of the provider's host (tests): never the URL. */
export interface VaultEndpoint extends TokenEndpoint {
  /** Test seam: each call's deadline; 8 s. */
  timeoutMs?: number;
}

export type HttpAnswer =
  | { kind: "answer"; status: number; body: string }
  | { kind: "unreachable"; code: string };

function errnoOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? code
    : "network";
}

/** A token the vault may store or hand on: non-empty, header-safe, bounded. */
export function isToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_TOKEN_CHARS &&
    HEADER_SAFE_RE.test(value)
  );
}

/** One bounded HTTPS request to `host`; never rejects. */
export function vaultCall(
  host: VaultHost,
  request: {
    /** `DELETE` only revokes a GitHub token the vault cannot hand on. */
    method: "GET" | "POST" | "DELETE";
    path: string;
    headers: Record<string, string | number>;
    body?: string;
  },
  endpoint: VaultEndpoint | undefined,
): Promise<HttpAnswer> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (answer: HttpAnswer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(answer);
    };
    const req = https.request({
      host: endpoint?.connect.host ?? host,
      port: endpoint?.connect.port ?? 443,
      servername: host,
      ...(endpoint?.ca ? { ca: endpoint.ca } : {}),
      agent: false,
      method: request.method,
      path: request.path,
      headers: { ...request.headers, Host: host },
    });
    const timer = setTimeout(
      () => settle({ kind: "unreachable", code: "timeout" }),
      endpoint?.timeoutMs ?? VAULT_HTTP_TIMEOUT_MS,
    );
    req.on("error", (err) =>
      settle({ kind: "unreachable", code: errnoOf(err) }),
    );
    req.on("response", (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        settle({ kind: "unreachable", code: "redirect" });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES)
          settle({ kind: "unreachable", code: "oversize" });
        else chunks.push(chunk);
      });
      response.on("aborted", () =>
        settle({ kind: "unreachable", code: "aborted" }),
      );
      response.on("error", (err) =>
        settle({ kind: "unreachable", code: errnoOf(err) }),
      );
      response.on("end", () =>
        settle({
          kind: "answer",
          status,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.end(request.body);
  });
}
