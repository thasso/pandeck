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

/** How an upstream is named to the user. */
export type UpstreamLabel =
  "Anthropic" | "ChatGPT" | "the OpenAI-compatible endpoint";

export type Refusal =
  | { case: "unknown-lease" }
  | { case: "revoked-lease"; reason: RevokeReason }
  | { case: "forbidden" }
  | { case: "unknown-prefix" }
  | { case: "websocket" }
  | { case: "credential"; problem: CredentialProblem }
  /** The profile's login is dead or absent; `name` is the registry's. */
  | { case: "needs-login"; name: string }
  /** No OpenAI-compatible endpoint was pushed since the last hello or clear. */
  | { case: "compat-unset" }
  /** `reason` is an error code or "connection failed", never peer text. */
  | { case: "unreachable"; upstream: UpstreamLabel; reason: string };

/** Which provider's error shape a refusal takes. */
export type RefusalShape = "claude" | "codex";

const STATUS: Record<Refusal["case"], number> = {
  "unknown-lease": 401,
  "revoked-lease": 401,
  forbidden: 403,
  "unknown-prefix": 404,
  websocket: 403,
  credential: 401,
  "needs-login": 401,
  "compat-unset": 503,
  unreachable: 502,
};

/** Anthropic's error type names, which both shapes use. */
const ERROR_TYPE: Record<number, string> = {
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
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
    case "websocket":
      return `${GATEWAY_REFUSAL_MARKER} WebSocket transport is not supported; use SSE.`;
    case "credential":
      return `${GATEWAY_REFUSAL_MARKER} the credential for this session's account could not be read (${refusal.problem}).`;
    case "needs-login":
      return `${GATEWAY_REFUSAL_MARKER} the account ${refusal.name} needs a new login (Settings → Accounts).`;
    case "compat-unset":
      return `${GATEWAY_REFUSAL_MARKER} the OpenAI-compatible endpoint's settings have not reached the gateway yet. Try again shortly.`;
    case "unreachable":
      return `${GATEWAY_REFUSAL_MARKER} ${refusal.upstream} could not be reached: ${refusal.reason}.`;
  }
}

/** The status and provider-shaped JSON body of a refusal. */
export function refusalResponse(
  refusal: Refusal,
  shape: RefusalShape,
): { status: number; body: string } {
  const status = STATUS[refusal.case];
  const type = ERROR_TYPE[status] ?? "api_error";
  const message = refusalText(refusal);
  const body =
    shape === "claude"
      ? { type: "error", error: { type, message } }
      : { error: { type, code: type, message } };
  return { status, body: JSON.stringify(body) };
}
