/**
 * What the gateway UI needs of the user's integration credentials (Task-1405),
 * defined here as `accounts.ts` defines accounts: the edge's composition
 * adapts its user-scoped operations (`gateway/userOperations.ts`) to it. The
 * Atlassian credential, the Slack record "Sign in with Slack" makes
 * (Task-1453), and the GitHub record "Connect GitHub" makes with its
 * repository check (Task-1445).
 *
 * The user always comes from the session. The API token is write-only: it
 * reaches `set` and nothing answers it; an authorization code reaches only
 * `connect`, `connectSlack` or `connectGithub`; the check answers a token's
 * expiry, never the token. A refusal is an `IntegrationsRefusal` with a
 * fixed code; anything else thrown means the gateway is unavailable.
 */
import {
  ATLASSIAN_AUTHORIZE_URL,
  GITHUB_AUTHORIZE_URL,
  SLACK_AUTHORIZE_URL,
  type GatewayUiAtlassian,
  type GatewayUiAtlassianSetRequest,
  type GatewayUiGithub,
  type GatewayUiGithubCheckRequest,
  type GatewayUiSlack,
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
  | "integration_not_configured"
  | "integration_team_mismatch"
  | "integration_denied";

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
  /**
   * The user's Slack record: whether it is stored and its workspace's name
   * as the vault holds it (the page's display rule is the route's), or why
   * it cannot be used. A read may refresh the record in the vault.
   */
  slackStatus(userId: string): Promise<Omit<GatewayUiSlack, "offered">>;
  /**
   * Hands the Slack callback's authorization code to the vault, which
   * exchanges it with the same `redirectUri` the authorize URL named, checks
   * the workspace against `team` (the deployment's) and stores the record;
   * refused `integration_team_mismatch` for another workspace.
   */
  connectSlack(
    userId: string,
    request: { code: string; redirectUri: string; team?: string },
  ): Promise<void>;
  clearSlack(userId: string): Promise<void>;
  /**
   * The user's GitHub record: whether it is stored and its GitHub login as
   * the vault holds it (the page's display rule is the route's), or why it
   * cannot be used. A read may refresh the record in the vault.
   */
  githubStatus(userId: string): Promise<Omit<GatewayUiGithub, "offered">>;
  /**
   * Hands the GitHub callback's authorization code to the vault, which
   * exchanges it with the App's client and the same `redirectUri` the
   * authorize URL named, and stores the record.
   */
  connectGithub(
    userId: string,
    request: { code: string; redirectUri: string },
  ): Promise<void>;
  clearGithub(userId: string): Promise<void>;
  /**
   * Whether the vault hands the user a read installation token for the
   * repository: the token's expiry only, the token dropped on the edge.
   * `integration_denied` when GitHub grants this user, or the App, no read.
   */
  checkGithub(
    userId: string,
    request: GatewayUiGithubCheckRequest,
  ): Promise<{ expiresAt: number }>;
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

/**
 * Where "Sign in with Slack" sends the browser (Slack OAuth v2, Task-1453):
 * the client id, the comma-joined user scopes (`user_scope`, never a bot
 * `scope`), the callback on the public origin, this start's state, and the
 * deployment's workspace as the `team` hint when it names one. No PKCE: the
 * vault exchanges the code with its client secret.
 */
export function slackAuthorizeUrl(request: {
  clientId: string;
  userScopes: readonly string[];
  redirectUri: string;
  state: string;
  team?: string | undefined;
}): string {
  const url = new URL(SLACK_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: request.clientId,
    user_scope: request.userScopes.join(","),
    redirect_uri: request.redirectUri,
    state: request.state,
    ...(request.team !== undefined ? { team: request.team } : {}),
  }).toString();
  return url.href;
}

/**
 * Where "Connect GitHub" sends the browser (a GitHub App's user
 * authorization, Task-1445): exactly the App's client id, the callback on
 * the public origin and this start's state, the set measured in spike S1a.
 * No PKCE and no scope: the App's permissions decide, and the vault
 * exchanges the code with the App's client secret.
 */
export function githubAuthorizeUrl(request: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    state: request.state,
  }).toString();
  return url.href;
}
