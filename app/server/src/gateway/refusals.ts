/**
 * The credential gateway's local refusals (`docs/workers.md` "Credentials").
 *
 * Every refusal the gateway answers itself carries the marker, and its body is
 * shaped like the provider's own error, so an engine passes the text through to
 * the failed turn. The server's error classifier reads the marker: a local
 * refusal never classifies as a dead login (`providerErrors.ts`).
 *
 * No text holds a string from a request or an upstream: a path, User-Agent or
 * bearer is never echoed. A profile's name comes only from the registry the
 * server syncs. This module imports nothing, because the classifier ships it.
 */

export const GATEWAY_REFUSAL_MARKER = "Pandeck gateway:";

/** Whether a provider error text came from the gateway itself. */
export function isGatewayRefusal(text: string): boolean {
  return text.includes(GATEWAY_REFUSAL_MARKER);
}

/** The needs-login refusal around the account's name. */
const NEEDS_LOGIN_BEFORE = `${GATEWAY_REFUSAL_MARKER} the account `;
const NEEDS_LOGIN_AFTER = " needs a new login (Settings → Accounts).";
const NEEDS_LOGIN_RE = new RegExp(
  `${escapeRegExp(NEEDS_LOGIN_BEFORE)}[\\s\\S]*?${escapeRegExp(NEEDS_LOGIN_AFTER)}`,
);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether a provider error text holds the gateway's needs-login refusal: the
 * only local refusal that says something about the login, which the
 * classifier reads for a gateway-served account (`providerErrors.ts`
 * `loginEnded`).
 */
export function isNeedsLoginRefusal(text: string): boolean {
  return NEEDS_LOGIN_RE.test(text);
}

/** Why a lease was revoked; the refusal names it. */
export type RevokeReason =
  "profile-removed" | "account-switch" | "session-ended";

const REVOKE_WORDING: Record<RevokeReason, string> = {
  "profile-removed": "the account was removed",
  "account-switch": "the session moved to another account",
  "session-ended": "the session ended",
};

/** Why a token file gave no usable credential. */
export type CredentialProblem = "missing" | "unreadable" | "malformed";

/** How a machine pool's provider is named to the user, from the route. */
type PoolLabel = "Claude" | "OpenAI";

/** How an upstream is named to the user. */
export type UpstreamLabel =
  "Anthropic" | "Anthropic MCP" | "ChatGPT" | "the OpenAI-compatible endpoint";

export type Refusal =
  | { case: "unknown-lease" }
  | { case: "revoked-lease"; reason: RevokeReason }
  | { case: "forbidden" }
  | { case: "unknown-prefix" }
  | { case: "duplicate-rid" }
  | { case: "websocket" }
  | { case: "credential"; problem: CredentialProblem }
  /** The profile's login is dead or absent; `name` is the registry's. */
  | { case: "needs-login"; name: string }
  /** No OpenAI-compatible endpoint was pushed since the last hello or clear. */
  | { case: "compat-unset" }
  /** `reason` is an error code or "connection failed", never peer text. */
  | { case: "unreachable"; upstream: UpstreamLabel; reason: string }
  /**
   * The edge's link to a remote vault is down or did not answer: no verdict
   * on the login, so never read as needs-login (`remoteVault.ts`).
   */
  | { case: "vault-unavailable" }
  /**
   * A sealing vault that no human has unlocked since it started (Task-1395):
   * no verdict on the login either.
   */
  | { case: "vault-locked" }
  /** A machine request (Task-1424): the user has no usable account. */
  | { case: "machine-pool-empty"; provider: PoolLabel }
  /**
   * Every account a machine session can use is tried and benched;
   * `retryAfterSeconds` comes from the gateway's own benches.
   */
  | {
      case: "machine-session-limited";
      provider: PoolLabel;
      retryAfterSeconds: number;
    }
  /** A machine request with an `Origin` or a non-loopback `Host`. */
  | { case: "machine-origin" }
  /** A machine request's selection changed twice while it waited. */
  | { case: "machine-retry" }
  /**
   * A machine request a token route's floors refuse (Task-1430 PR3): `id` is
   * a deny-floor entry's id or `method`, never request text.
   */
  | { case: "denied"; id: string }
  /** A machine request on a token route whose path is not canonical. */
  | { case: "non-canonical-path" };

/** Which provider's error shape a refusal takes. */
export type RefusalShape = "claude" | "codex";

const STATUS: Record<Refusal["case"], number> = {
  "unknown-lease": 401,
  "revoked-lease": 401,
  forbidden: 403,
  "unknown-prefix": 404,
  "duplicate-rid": 409,
  websocket: 403,
  credential: 401,
  "needs-login": 401,
  "compat-unset": 503,
  unreachable: 502,
  "vault-unavailable": 503,
  "vault-locked": 503,
  "machine-pool-empty": 403,
  "machine-session-limited": 429,
  "machine-origin": 403,
  "machine-retry": 503,
  denied: 403,
  "non-canonical-path": 403,
};

/** Anthropic's error type names, which both shapes use. */
const ERROR_TYPE: Record<number, string> = {
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  409: "invalid_request_error",
  429: "rate_limit_error",
  502: "api_error",
  503: "api_error",
};

function accessEnded(reason: string): string {
  return `${GATEWAY_REFUSAL_MARKER} this session's model access ended (${reason}). Send your message again to continue.`;
}

export function refusalText(refusal: Refusal): string {
  switch (refusal.case) {
    case "unknown-lease":
      return accessEnded("the gateway does not know this session");
    case "revoked-lease":
      return accessEnded(REVOKE_WORDING[refusal.reason]);
    case "forbidden":
      return `${GATEWAY_REFUSAL_MARKER} this session's model access does not cover this request.`;
    case "unknown-prefix":
      return `${GATEWAY_REFUSAL_MARKER} no model upstream at this path.`;
    case "duplicate-rid":
      return `${GATEWAY_REFUSAL_MARKER} this relay request was already recorded.`;
    case "websocket":
      return `${GATEWAY_REFUSAL_MARKER} WebSocket transport is not supported; use SSE.`;
    case "credential":
      return `${GATEWAY_REFUSAL_MARKER} the credential for this session's account could not be read (${refusal.problem}).`;
    case "needs-login":
      return `${NEEDS_LOGIN_BEFORE}${refusal.name}${NEEDS_LOGIN_AFTER}`;
    case "compat-unset":
      return `${GATEWAY_REFUSAL_MARKER} the OpenAI-compatible endpoint's settings have not reached the gateway yet. Try again shortly.`;
    case "unreachable":
      return `${GATEWAY_REFUSAL_MARKER} ${refusal.upstream} could not be reached: ${refusal.reason}.`;
    case "vault-unavailable":
      return `${GATEWAY_REFUSAL_MARKER} the credential vault is unavailable. Try again shortly.`;
    case "vault-locked":
      return `${GATEWAY_REFUSAL_MARKER} the credential vault is locked until its operator unlocks it. Try again later.`;
    case "machine-pool-empty":
      return `${GATEWAY_REFUSAL_MARKER} no ${refusal.provider} account is available to this machine's user. Add or log in to one on the gateway's page.`;
    case "machine-session-limited":
      return `${GATEWAY_REFUSAL_MARKER} every ${refusal.provider} account this session can use is rate-limited; retry later.`;
    case "machine-origin":
      return `${GATEWAY_REFUSAL_MARKER} model access from this machine is for local tools only.`;
    case "machine-retry":
      return `${GATEWAY_REFUSAL_MARKER} this machine's account changed while the request waited; retry.`;
    case "denied":
      return `${GATEWAY_REFUSAL_MARKER} model access from this machine never covers this request.`;
    case "non-canonical-path":
      return `${GATEWAY_REFUSAL_MARKER} model access from this machine needs a canonical path (no empty, dot or encoded-unreserved segments).`;
  }
}

/**
 * The status and provider-shaped JSON body of a refusal, and its
 * `retry-after` in whole seconds when it has one.
 */
export function refusalResponse(
  refusal: Refusal,
  shape: RefusalShape,
): { status: number; body: string; retryAfter?: number } {
  const status = STATUS[refusal.case];
  const type = ERROR_TYPE[status] ?? "api_error";
  const message = refusalText(refusal);
  const body =
    shape === "claude"
      ? { type: "error", error: { type, message } }
      : { error: { type, code: type, message } };
  return {
    status,
    body: JSON.stringify(body),
    ...(refusal.case === "machine-session-limited"
      ? { retryAfter: refusal.retryAfterSeconds }
      : {}),
  };
}
