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
  error:
    | "signed_out"
    | "forbidden"
    | "unavailable"
    | "unknown_account"
    | "unknown_login"
    | "login_unavailable"
    | "bad_request"
    | "unknown_client"
    | "limit_reached"
    | "integration_invalid"
    | "integration_rejected"
    | "integration_unreachable"
    | "vault_locked"
    | "vault_unavailable"
    | "tools_unavailable";
}

export type GatewayUiProvider = "claude" | "openai-codex";

/** One of the signed-in user's accounts, as `GET /api/accounts` lists it. */
export interface GatewayUiAccount {
  id: string;
  provider: GatewayUiProvider;
  name: string;
  /** Its first login has not succeeded, or renewal found it logged out. */
  needsLogin: boolean;
}

export interface GatewayUiAccounts {
  accounts: GatewayUiAccount[];
}

/**
 * `POST /api/logins/start`: a login for the user's account `accountId`, or,
 * without it, for a new account named `name` (the provider's name if empty).
 */
export interface GatewayUiLoginStartRequest {
  kind: GatewayUiProvider;
  accountId?: string;
  name?: string;
}

/** What a start answers: the login to read, and its account. */
export interface GatewayUiLoginStart {
  loginId: string;
  accountId: string;
}

export type GatewayUiLoginState = "running" | "ready" | "error" | "cancelled";

/**
 * Why a login ended other than ready, a fixed code the page turns into its
 * own text: the login failed, ran past its deadline, was started again from
 * elsewhere, could not run now, or its session ended. Never provider text.
 */
export const GATEWAY_UI_LOGIN_REASONS = [
  "failed",
  "timed_out",
  "superseded",
  "unavailable",
  "session_ended",
] as const;
export type GatewayUiLoginReason = (typeof GATEWAY_UI_LOGIN_REASONS)[number];

/**
 * `GET /api/logins/read?login=<id>&cursor=<n>`: the login's state, its
 * output from `cursor` on and the cursor to read from next. A ChatGPT login's
 * `device` appears once both its link and code are known.
 */
export interface GatewayUiLogin {
  state: GatewayUiLoginState;
  reason?: GatewayUiLoginReason;
  output: string;
  cursor: number;
  device?: { verificationUri: string; userCode: string };
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

/** Why a stored Atlassian credential cannot be used now. */
export const GATEWAY_UI_ATLASSIAN_PROBLEMS = [
  "vault_locked",
  "vault_unavailable",
  "invalid",
] as const;
export type GatewayUiAtlassianProblem =
  (typeof GATEWAY_UI_ATLASSIAN_PROBLEMS)[number];

/**
 * `GET /api/integrations/atlassian` and what a set answers: whether the
 * user's Atlassian credential is stored, with its site and email. Never the
 * API token, which is write-only.
 */
export interface GatewayUiAtlassian {
  connected: boolean;
  site?: string;
  email?: string;
  /** Atlassian's name for the account, from the check a set ran. */
  displayName?: string;
  problem?: GatewayUiAtlassianProblem;
}

/** `POST /api/integrations/atlassian/set`: checked, then stored. */
export interface GatewayUiAtlassianSetRequest {
  site: string;
  email: string;
  token: string;
}

/** One of the user's active clients, as `GET /api/clients` lists it. */
export interface GatewayUiClient {
  id: string;
  label: string;
  /** Epoch milliseconds of its enrollment. */
  createdAt: number;
  /** Whether it has an MCP token; never the token. */
  mcpToken: boolean;
}

export interface GatewayUiClients {
  clients: GatewayUiClient[];
}

/** `POST /api/clients/code`: a one-time code, shown once, then gone. */
export interface GatewayUiEnrollmentCode {
  code: string;
  validForSeconds: number;
}

/** `POST /api/clients/mcp-token`: the client's new MCP token, shown once. */
export interface GatewayUiMcpToken {
  token: string;
}

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isProvider = (value: unknown): value is GatewayUiProvider =>
  value === "claude" || value === "openai-codex";

/** A well-formed `GatewayUiAccounts`, or undefined. */
export function decodeGatewayUiAccounts(
  value: unknown,
): GatewayUiAccounts | undefined {
  if (!isRecord(value) || !Array.isArray(value.accounts)) return undefined;
  const accounts: GatewayUiAccount[] = [];
  for (const entry of value.accounts as unknown[]) {
    if (!isRecord(entry)) return undefined;
    const { id, provider, name, needsLogin } = entry;
    if (
      typeof id !== "string" ||
      id === "" ||
      !isProvider(provider) ||
      typeof name !== "string" ||
      typeof needsLogin !== "boolean"
    )
      return undefined;
    accounts.push({ id, provider, name, needsLogin });
  }
  return { accounts };
}

/** A well-formed `GatewayUiLoginStart`, or undefined. */
export function decodeGatewayUiLoginStart(
  value: unknown,
): GatewayUiLoginStart | undefined {
  if (!isRecord(value)) return undefined;
  const { loginId, accountId } = value;
  if (
    typeof loginId !== "string" ||
    loginId === "" ||
    typeof accountId !== "string" ||
    accountId === ""
  )
    return undefined;
  return { loginId, accountId };
}

/** A well-formed `GatewayUiLogin`, or undefined; an unknown reason drops. */
export function decodeGatewayUiLogin(
  value: unknown,
): GatewayUiLogin | undefined {
  if (!isRecord(value)) return undefined;
  const { state, reason, output, cursor, device } = value;
  if (
    state !== "running" &&
    state !== "ready" &&
    state !== "error" &&
    state !== "cancelled"
  )
    return undefined;
  if (
    typeof output !== "string" ||
    typeof cursor !== "number" ||
    !Number.isInteger(cursor) ||
    cursor < 0
  )
    return undefined;
  const login: GatewayUiLogin = { state, output, cursor };
  if ((GATEWAY_UI_LOGIN_REASONS as readonly unknown[]).includes(reason))
    login.reason = reason as GatewayUiLoginReason;
  if (device !== undefined) {
    if (
      !isRecord(device) ||
      typeof device.verificationUri !== "string" ||
      typeof device.userCode !== "string"
    )
      return undefined;
    login.device = {
      verificationUri: device.verificationUri,
      userCode: device.userCode,
    };
  }
  return login;
}

const optionalText = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string";

/** A well-formed `GatewayUiAtlassian`, or undefined; an unknown problem drops. */
export function decodeGatewayUiAtlassian(
  value: unknown,
): GatewayUiAtlassian | undefined {
  if (!isRecord(value)) return undefined;
  const { connected, site, email, displayName, problem } = value;
  if (
    typeof connected !== "boolean" ||
    !optionalText(site) ||
    !optionalText(email) ||
    !optionalText(displayName)
  )
    return undefined;
  return {
    connected,
    ...(site !== undefined ? { site } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
    ...((GATEWAY_UI_ATLASSIAN_PROBLEMS as readonly unknown[]).includes(problem)
      ? { problem: problem as GatewayUiAtlassianProblem }
      : {}),
  };
}

/** A well-formed `GatewayUiClients`, or undefined. */
export function decodeGatewayUiClients(
  value: unknown,
): GatewayUiClients | undefined {
  if (!isRecord(value) || !Array.isArray(value.clients)) return undefined;
  const clients: GatewayUiClient[] = [];
  for (const entry of value.clients as unknown[]) {
    if (!isRecord(entry)) return undefined;
    const { id, label, createdAt, mcpToken } = entry;
    if (
      typeof id !== "string" ||
      id === "" ||
      typeof label !== "string" ||
      typeof createdAt !== "number" ||
      !Number.isFinite(createdAt) ||
      typeof mcpToken !== "boolean"
    )
      return undefined;
    clients.push({ id, label, createdAt, mcpToken });
  }
  return { clients };
}

/** A well-formed `GatewayUiEnrollmentCode`, or undefined. */
export function decodeGatewayUiEnrollmentCode(
  value: unknown,
): GatewayUiEnrollmentCode | undefined {
  if (!isRecord(value)) return undefined;
  const { code, validForSeconds } = value;
  if (
    typeof code !== "string" ||
    code === "" ||
    typeof validForSeconds !== "number" ||
    !Number.isInteger(validForSeconds) ||
    validForSeconds <= 0
  )
    return undefined;
  return { code, validForSeconds };
}

/** A well-formed `GatewayUiMcpToken`, or undefined. */
export function decodeGatewayUiMcpToken(
  value: unknown,
): GatewayUiMcpToken | undefined {
  if (!isRecord(value)) return undefined;
  const { token } = value;
  return typeof token === "string" && token !== "" ? { token } : undefined;
}
