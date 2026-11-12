/**
 * The gateway's own browser page and its API (Task-1402, `docs/workers.md`
 * "The gateway's sign-in and UI"). The edge serves both from one origin; the
 * page reaches the API with its session cookie only, never a Pandeck token.
 * Import-free: the edge's `gatewayWeb/` and the page's entry both load it.
 */

/** `GET /api/me`: the signed-in user. The id comes only from the session. */
export interface GatewayUiMe {
  userId: string;
  email: string;
  label: string;
}

/** Every refusal body of the page's API, a fixed code and nothing else. */
export interface GatewayUiError {
  error: "signed_out" | "forbidden" | "unavailable";
}

/**
 * Why a sign-in did not create a session, as `/?signin=<code>` after the
 * callback: the account is not admitted, the sign-in took too long or was not
 * started in this browser, the provider exchange or the ID token failed, or
 * the gateway holds too many sign-ins or sessions.
 */
export const GATEWAY_UI_SIGNIN_CODES = [
  "denied",
  "expired",
  "failed",
  "busy",
] as const;
export type GatewayUiSigninCode = (typeof GATEWAY_UI_SIGNIN_CODES)[number];

/** Every mutation sends this header with the value `1` (and its Origin). */
export const GATEWAY_UI_CSRF_HEADER = "x-gateway-ui";

/** A well-formed `GatewayUiMe`, or undefined. */
export function decodeGatewayUiMe(value: unknown): GatewayUiMe | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { userId, email, label } = value as Record<string, unknown>;
  if (
    typeof userId !== "string" ||
    userId === "" ||
    typeof email !== "string" ||
    typeof label !== "string"
  )
    return undefined;
  return { userId, email, label };
}
