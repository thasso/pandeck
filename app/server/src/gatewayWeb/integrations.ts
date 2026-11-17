/**
 * What the gateway UI needs of the user's integration credentials (Task-1405),
 * defined here as `accounts.ts` defines accounts: the edge's composition
 * adapts its user-scoped operations (`gateway/userOperations.ts`) to it.
 *
 * The user always comes from the session. The API token is write-only: it
 * reaches `set` and nothing answers it; an authorization code reaches only
 * `connect`. A refusal is an `IntegrationsRefusal` with a fixed code;
 * anything else thrown means the gateway is unavailable.
 */
import {
  ATLASSIAN_AUTHORIZE_URL,
  type GatewayUiAtlassian,
  type GatewayUiAtlassianSetRequest,
} from "@assistant/shared/gatewayUi";
import { isRecord } from "./accounts.ts";

export type IntegrationsRefusalCode =
  | "integration_invalid"
  | "integration_rejected"
  | "integration_unreachable"
  | "vault_locked"
  | "vault_unavailable"
  | "tools_unavailable"
  | "integration_busy"
  | "integration_sign_in_required"
  | "integration_site_missing"
  | "integration_site_ambiguous"
  | "integration_not_configured";

export class IntegrationsRefusal extends Error {
  constructor(readonly code: IntegrationsRefusalCode) {
    super(code);
  }
}

export interface GatewayWebIntegrations {
  /** The stored credential's site and email; no live check. */
  status(userId: string): Promise<GatewayUiAtlassian>;
  /**
   * Checks the credential with Atlassian, then stores it; refused
   * `integration_sign_in_required` where the page signs in with Atlassian.
   */
  set(
    userId: string,
    input: GatewayUiAtlassianSetRequest,
  ): Promise<GatewayUiAtlassian>;
  clear(userId: string): Promise<void>;
  /**
   * Hands the Atlassian callback's authorization code to the vault, which
   * exchanges it with the same `redirectUri` the authorize URL named and
   * stores the user's OAuth record for `site` (the deployment's preset), or
   * the only site the grant covers.
   */
  connect(
    userId: string,
    request: { code: string; redirectUri: string; site?: string },
  ): Promise<GatewayUiAtlassian>;
}

/** Above the parser's own bounds, so it, not this, decides validity. */
const MAX_SITE_CHARS = 300;
const MAX_EMAIL_CHARS = 300;
const MAX_TOKEN_CHARS = 600;

const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;

/** `{site, email, token}`; any other field (a `userId`) is ignored. */
export function decodeAtlassianSet(
  value: unknown,
): GatewayUiAtlassianSetRequest | undefined {
  if (!isRecord(value)) return undefined;
  const { site, email, token } = value;
  return text(site, MAX_SITE_CHARS) &&
    text(email, MAX_EMAIL_CHARS) &&
    text(token, MAX_TOKEN_CHARS)
    ? { site, email, token }
    : undefined;
}

/**
 * Where "Sign in with Atlassian" sends the browser (OAuth 2.0 3LO): the
 * client id, the space-joined scopes, the callback on the public origin and
 * this start's state, with `prompt=consent`. No PKCE: the vault exchanges the
 * code with its client secret.
 */
export function atlassianAuthorizeUrl(request: {
  clientId: string;
  scopes: readonly string[];
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(ATLASSIAN_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: request.clientId,
    scope: request.scopes.join(" "),
    redirect_uri: request.redirectUri,
    state: request.state,
    response_type: "code",
    prompt: "consent",
  }).toString();
  return url.href;
}
