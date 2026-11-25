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
    | "tools_unavailable"
    | "integration_busy"
    | "integration_sign_in_required"
    | "integration_site_missing"
    | "integration_site_ambiguous"
    | "integration_not_configured"
    | "integration_team_mismatch"
    | "integration_denied"
    | "unknown_request"
    | "rate_limited";
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

/**
 * Why a stored Atlassian credential cannot be used now; `rejected` is
 * Atlassian refusing the vault's refresh of an OAuth record.
 */
export const GATEWAY_UI_ATLASSIAN_PROBLEMS = [
  "vault_locked",
  "vault_unavailable",
  "invalid",
  "rejected",
] as const;
export type GatewayUiAtlassianProblem =
  (typeof GATEWAY_UI_ATLASSIAN_PROBLEMS)[number];

/**
 * How an Atlassian credential was made: an API token, or "Sign in with
 * Atlassian" (OAuth 2.0 3LO, Task-1411).
 */
export type GatewayUiAtlassianKind = "token" | "oauth";

/**
 * `GET /api/integrations/atlassian` and what a set answers: whether the
 * user's Atlassian credential is stored, with its kind, site and email. Never
 * a token, which the edge does not answer.
 */
export interface GatewayUiAtlassian {
  connected: boolean;
  /** Whenever a record was read, and `oauth` on `problem: "rejected"`. */
  kind?: GatewayUiAtlassianKind;
  /**
   * How a new connection is made on this gateway: `oauth` where it has an
   * Atlassian OAuth client (a set is then refused
   * `integration_sign_in_required`), else `token`.
   */
  connectWith: GatewayUiAtlassianKind;
  site?: string;
  email?: string;
  /** Atlassian's name for the account, from the check a set ran. */
  displayName?: string;
  problem?: GatewayUiAtlassianProblem;
  /**
   * What the deployment fixes ahead of time: its Atlassian site, and the
   * signed-in email when the deployment binds the credential to it. A set
   * uses these whatever the request says; the page shows no field for them.
   */
  preset?: GatewayUiAtlassianPreset;
}

export interface GatewayUiAtlassianPreset {
  site?: string;
  email?: string;
}

/** `POST /api/integrations/atlassian/set`: checked, then stored. */
export interface GatewayUiAtlassianSetRequest {
  site: string;
  email: string;
  token: string;
}

/**
 * `POST /api/integrations/atlassian/connect`: where the browser goes to sign
 * in with Atlassian. The URL carries this start's state, and only it does.
 */
export interface GatewayUiAtlassianConnectStart {
  authorizeUrl: string;
}

/** Atlassian's authorization endpoint, the only place a start sends to. */
export const ATLASSIAN_AUTHORIZE_URL = "https://auth.atlassian.com/authorize";

/**
 * Why "Sign in with Atlassian" did not connect, as `/?atlassian=<code>` after
 * `/auth/atlassian/callback` (a success goes to `/` with no code). The page
 * shows only these and ignores any other value.
 */
export const GATEWAY_UI_ATLASSIAN_CONNECT_CODES = [
  "rejected",
  "unreachable",
  "site_missing",
  "site_ambiguous",
  "not_configured",
  "vault_locked",
  "vault_unavailable",
  "busy",
  "tools_unavailable",
  "signed_out",
  "expired",
  "failed",
  "denied",
] as const;
export type GatewayUiAtlassianConnectCode =
  (typeof GATEWAY_UI_ATLASSIAN_CONNECT_CODES)[number];

/**
 * Why a stored Slack record cannot be used now; `rejected` is Slack refusing
 * the vault's refresh (Task-1453).
 */
export const GATEWAY_UI_SLACK_PROBLEMS = [
  "vault_locked",
  "vault_unavailable",
  "invalid",
  "rejected",
] as const;
export type GatewayUiSlackProblem = (typeof GATEWAY_UI_SLACK_PROBLEMS)[number];

/**
 * `GET /api/integrations/slack`: whether this gateway offers "Sign in with
 * Slack" (its UI config names `slack.clientId`) and whether the user's Slack
 * record is stored, with the workspace's name when it passes
 * `isGatewayUiDisplayText`. Never a token.
 */
export interface GatewayUiSlack {
  offered: boolean;
  connected: boolean;
  teamName?: string;
  problem?: GatewayUiSlackProblem;
}

/**
 * `POST /api/integrations/slack/connect`: where the browser goes to sign in
 * with Slack. The URL carries this start's state, and only it does.
 */
export interface GatewayUiSlackConnectStart {
  authorizeUrl: string;
}

/** Slack's authorization endpoint, the only place a start sends to. */
export const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";

/**
 * Why "Sign in with Slack" did not connect, as `/?slack=<code>` after
 * `/auth/slack/callback` (a success goes to `/` with no code). The page shows
 * only these and ignores any other value.
 */
export const GATEWAY_UI_SLACK_CONNECT_CODES = [
  "rejected",
  "unreachable",
  "team_mismatch",
  "not_configured",
  "vault_locked",
  "vault_unavailable",
  "busy",
  "tools_unavailable",
  "signed_out",
  "expired",
  "failed",
  "denied",
] as const;
export type GatewayUiSlackConnectCode =
  (typeof GATEWAY_UI_SLACK_CONNECT_CODES)[number];

/**
 * Why a stored GitHub record cannot be used now; `rejected` is GitHub
 * refusing the vault's refresh (Task-1445).
 */
export const GATEWAY_UI_GITHUB_PROBLEMS = [
  "vault_locked",
  "vault_unavailable",
  "invalid",
  "rejected",
] as const;
export type GatewayUiGithubProblem =
  (typeof GATEWAY_UI_GITHUB_PROBLEMS)[number];

/**
 * `GET /api/integrations/github`: whether this gateway offers "Connect
 * GitHub" (its UI config names `github.clientId`) and whether the user's
 * GitHub record is stored, with the GitHub login when it passes
 * `isGatewayUiGithubLogin`. Never a token.
 */
export interface GatewayUiGithub {
  offered: boolean;
  connected: boolean;
  login?: string;
  problem?: GatewayUiGithubProblem;
}

/**
 * `POST /api/integrations/github/connect`: where the browser goes to
 * authorize the gateway's GitHub App. The URL carries this start's state,
 * and only it does.
 */
export interface GatewayUiGithubConnectStart {
  authorizeUrl: string;
}

/** GitHub's authorization endpoint, the only place a start sends to. */
export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";

/**
 * Why "Connect GitHub" did not connect, as `/?github=<code>` after
 * `/auth/github/callback` (a success goes to `/` with no code). The page
 * shows only these and ignores any other value.
 */
export const GATEWAY_UI_GITHUB_CONNECT_CODES = [
  "rejected",
  "unreachable",
  "not_configured",
  "vault_locked",
  "vault_unavailable",
  "busy",
  "signed_out",
  "expired",
  "failed",
  "denied",
] as const;
export type GatewayUiGithubConnectCode =
  (typeof GATEWAY_UI_GITHUB_CONNECT_CODES)[number];

/**
 * `POST /api/integrations/github/check`: the repository whose read access
 * the user checks, both names passing `isGatewayUiGithubRepoName`, and no
 * other member.
 */
export interface GatewayUiGithubCheckRequest {
  owner: string;
  repo: string;
}

/**
 * The check's answer: the repository as checked (`owner/repo`) and when the
 * read token the vault would hand out expires, epoch milliseconds. Never the
 * token. A refusal is a `GatewayUiError`.
 */
export interface GatewayUiGithubCheck {
  repository: string;
  expiresAt: number;
}

/**
 * The gateway's GitHub name rules, the same as the vault's (`isGithubLogin`
 * and `isGithubTokenRequest` in the server's `gateway/vaultMethods.ts`,
 * which the page cannot import; a server test runs both over one table).
 */
const GITHUB_LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/;
const GITHUB_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** A GitHub user or organization name: a login, or a repository's owner. */
export function isGatewayUiGithubLogin(value: unknown): value is string {
  return typeof value === "string" && GITHUB_LOGIN_RE.test(value);
}

/**
 * A repository a check may name: `owner` a GitHub login and `repo` 1-100 of
 * `A-Za-z0-9._-`, never `.` or `..`.
 */
export function isGatewayUiGithubRepoName(
  owner: unknown,
  repo: unknown,
): boolean {
  return (
    isGatewayUiGithubLogin(owner) &&
    typeof repo === "string" &&
    GITHUB_REPO_RE.test(repo) &&
    repo !== "." &&
    repo !== ".."
  );
}

const MAX_DISPLAY_TEXT_UNITS = 256;
/** Unicode category C (Cc, Cf, Cs, Co, Cn) and the line/paragraph separators. */
const UNDISPLAYABLE = /[\p{C}\p{Zl}\p{Zp}]/u;

/**
 * A provider's name the page may show and a log never holds (a Slack
 * workspace's, Task-1453): 1-256 UTF-16 units, not only whitespace, and no
 * control, format (bidi and zero-width included), surrogate, private-use or
 * unassigned character, nor a line or paragraph separator.
 */
export function isGatewayUiDisplayText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_DISPLAY_TEXT_UNITS &&
    value.trim() !== "" &&
    !UNDISPLAYABLE.test(value)
  );
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

/** What a machine says it is; shown, never trusted (Task-1410). */
export type GatewayUiEnrollmentKind = "devbox" | "laptop" | "other";

/**
 * `POST /api/enrollments/lookup`: a machine's pending enrollment request, as
 * the machine reported it. Name and kind are the machine's own claims; `from`
 * is the address its request came from. Epoch milliseconds.
 */
export interface GatewayUiEnrollmentRequest {
  name: string;
  kind: GatewayUiEnrollmentKind;
  from: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * The bodies of `POST /api/enrollments/lookup` and `/decide`. The user code
 * travels only in a POST body, never in a URL; a decision answers 204.
 */
export interface GatewayUiEnrollmentLookupRequest {
  userCode: string;
}

export interface GatewayUiEnrollmentDecideRequest {
  userCode: string;
  approve: boolean;
}

/** How a logged request ended (`docs/workers.md` "Request log"). */
export const GATEWAY_UI_REQUEST_OUTCOMES = [
  "forwarded",
  "refused",
  "observed",
  "failed",
  "overflow",
] as const;
export type GatewayUiRequestOutcome =
  (typeof GATEWAY_UI_REQUEST_OUTCOMES)[number];

/** The class of the credential a client sent; never a value. */
const GATEWAY_UI_CLIENT_CREDENTIALS = [
  "none",
  "placeholder",
  "lease",
  "mcp-token",
  "other",
] as const;
type GatewayUiClientCredential = (typeof GATEWAY_UI_CLIENT_CREDENTIALS)[number];

/**
 * One request a client of the user sent the gateway (Task-1430 C3). Never a
 * header value, query, body, token, lease id or raw session key.
 */
export interface GatewayUiRequest {
  /** Increasing within one `epoch`. */
  seq: number;
  /** The edge's start: when it changes, earlier cursors mean nothing. */
  epoch: string;
  /** Epoch milliseconds the request started. */
  at: number;
  client: { id: string; label: string };
  via: "gateway" | "relay";
  /** The relay's request id. */
  rid?: string;
  /** The logical upstream host; `""` when no route matched. */
  host: string;
  method: string;
  /** Pathname only, at most 200 characters. */
  path: string;
  /** The matched template, else the path; first-seen is keyed on it. */
  pathKey: string;
  /** What the client was answered, or null when it got no status. */
  status: number | null;
  outcome: GatewayUiRequestOutcome;
  /** A fixed code: a refusal case, an error code or a fixed word. */
  reason?: string;
  /** Only on `overflow` and `relay-restarted` notes. */
  count?: number;
  /** Machine requests on token routes only: whether evidence lists it. */
  listed?: boolean;
  /** The account's registry name. */
  account?: string;
  /** The first 12 hex of the session key's SHA-256. */
  session?: string;
  clientCredential: GatewayUiClientCredential;
  clientCookie: boolean;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
  /** The first request with this host, method and `pathKey`. */
  firstSeen: boolean;
}

/**
 * `GET /api/requests?epoch=&after=`: the session user's requests after the
 * cursor, oldest first, at most 500. A cursor from another epoch reads from
 * the oldest kept.
 */
export interface GatewayUiRequests {
  epoch: string;
  requests: GatewayUiRequest[];
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

const isAtlassianKind = (value: unknown): value is GatewayUiAtlassianKind =>
  value === "token" || value === "oauth";

/**
 * A well-formed `GatewayUiAtlassian`, or undefined; an unknown problem or
 * kind drops, a missing or unknown `connectWith` refuses.
 */
export function decodeGatewayUiAtlassian(
  value: unknown,
): GatewayUiAtlassian | undefined {
  if (!isRecord(value)) return undefined;
  const {
    connected,
    kind,
    connectWith,
    site,
    email,
    displayName,
    problem,
    preset,
  } = value;
  if (
    typeof connected !== "boolean" ||
    !isAtlassianKind(connectWith) ||
    !optionalText(site) ||
    !optionalText(email) ||
    !optionalText(displayName)
  )
    return undefined;
  let fixed: GatewayUiAtlassianPreset | undefined;
  if (preset !== undefined) {
    if (!isRecord(preset)) return undefined;
    const presetSite = preset.site;
    const presetEmail = preset.email;
    if (!optionalText(presetSite) || !optionalText(presetEmail))
      return undefined;
    fixed = {
      ...(presetSite !== undefined ? { site: presetSite } : {}),
      ...(presetEmail !== undefined ? { email: presetEmail } : {}),
    };
  }
  return {
    connected,
    ...(isAtlassianKind(kind) ? { kind } : {}),
    connectWith,
    ...(site !== undefined ? { site } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
    ...((GATEWAY_UI_ATLASSIAN_PROBLEMS as readonly unknown[]).includes(problem)
      ? { problem: problem as GatewayUiAtlassianProblem }
      : {}),
    ...(fixed ? { preset: fixed } : {}),
  };
}

/**
 * A well-formed `GatewayUiAtlassianConnectStart`, or undefined: the URL must
 * be Atlassian's authorization endpoint, so the page never navigates
 * anywhere else.
 */
export function decodeGatewayUiAtlassianConnectStart(
  value: unknown,
): GatewayUiAtlassianConnectStart | undefined {
  if (!isRecord(value) || typeof value.authorizeUrl !== "string")
    return undefined;
  let url: URL;
  try {
    url = new URL(value.authorizeUrl);
  } catch {
    return undefined;
  }
  return `${url.origin}${url.pathname}` === ATLASSIAN_AUTHORIZE_URL &&
    url.username === "" &&
    url.password === "" &&
    url.hash === ""
    ? { authorizeUrl: url.href }
    : undefined;
}

/**
 * A well-formed `GatewayUiSlack`, or undefined: both booleans required, an
 * unknown problem and a `teamName` failing `isGatewayUiDisplayText` dropped.
 */
export function decodeGatewayUiSlack(
  value: unknown,
): GatewayUiSlack | undefined {
  if (!isRecord(value)) return undefined;
  const { offered, connected, teamName, problem } = value;
  if (typeof offered !== "boolean" || typeof connected !== "boolean")
    return undefined;
  return {
    offered,
    connected,
    ...(isGatewayUiDisplayText(teamName) ? { teamName } : {}),
    ...((GATEWAY_UI_SLACK_PROBLEMS as readonly unknown[]).includes(problem)
      ? { problem: problem as GatewayUiSlackProblem }
      : {}),
  };
}

/**
 * A well-formed `GatewayUiSlackConnectStart`, or undefined: the URL must be
 * Slack's authorization endpoint, so the page never navigates anywhere else.
 */
export function decodeGatewayUiSlackConnectStart(
  value: unknown,
): GatewayUiSlackConnectStart | undefined {
  if (!isRecord(value) || typeof value.authorizeUrl !== "string")
    return undefined;
  let url: URL;
  try {
    url = new URL(value.authorizeUrl);
  } catch {
    return undefined;
  }
  return `${url.origin}${url.pathname}` === SLACK_AUTHORIZE_URL &&
    url.username === "" &&
    url.password === "" &&
    url.hash === ""
    ? { authorizeUrl: url.href }
    : undefined;
}

/**
 * A well-formed `GatewayUiGithub`, or undefined: both booleans required, an
 * unknown problem and a `login` failing `isGatewayUiGithubLogin` dropped, and
 * any other member (a `token`) never kept.
 */
export function decodeGatewayUiGithub(
  value: unknown,
): GatewayUiGithub | undefined {
  if (!isRecord(value)) return undefined;
  const { offered, connected, login, problem } = value;
  if (typeof offered !== "boolean" || typeof connected !== "boolean")
    return undefined;
  return {
    offered,
    connected,
    ...(isGatewayUiGithubLogin(login) ? { login } : {}),
    ...((GATEWAY_UI_GITHUB_PROBLEMS as readonly unknown[]).includes(problem)
      ? { problem: problem as GatewayUiGithubProblem }
      : {}),
  };
}

/**
 * A well-formed `GatewayUiGithubConnectStart`, or undefined: the URL must be
 * GitHub's authorization endpoint, so the page never navigates anywhere else.
 */
export function decodeGatewayUiGithubConnectStart(
  value: unknown,
): GatewayUiGithubConnectStart | undefined {
  if (!isRecord(value) || typeof value.authorizeUrl !== "string")
    return undefined;
  let url: URL;
  try {
    url = new URL(value.authorizeUrl);
  } catch {
    return undefined;
  }
  return `${url.origin}${url.pathname}` === GITHUB_AUTHORIZE_URL &&
    url.username === "" &&
    url.password === "" &&
    url.hash === ""
    ? { authorizeUrl: url.href }
    : undefined;
}

/**
 * A check request: exactly `owner` and `repo` passing
 * `isGatewayUiGithubRepoName`, or undefined, so a request carrying any other
 * member (an `access`, `token` or `userId`) is refused whole.
 */
export function decodeGatewayUiGithubCheckRequest(
  value: unknown,
): GatewayUiGithubCheckRequest | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("owner") || !keys.includes("repo"))
    return undefined;
  const { owner, repo } = value;
  return isGatewayUiGithubRepoName(owner, repo)
    ? { owner: owner as string, repo: repo as string }
    : undefined;
}

/**
 * A well-formed `GatewayUiGithubCheck`, or undefined: the repository as
 * `owner/repo` GitHub names and a finite, positive `expiresAt`; any other
 * member (a `token`) never kept.
 */
export function decodeGatewayUiGithubCheck(
  value: unknown,
): GatewayUiGithubCheck | undefined {
  if (!isRecord(value)) return undefined;
  const { repository, expiresAt } = value;
  if (typeof repository !== "string") return undefined;
  const slash = repository.indexOf("/");
  if (
    slash < 0 ||
    !isGatewayUiGithubRepoName(
      repository.slice(0, slash),
      repository.slice(slash + 1),
    )
  )
    return undefined;
  return typeof expiresAt === "number" &&
    Number.isFinite(expiresAt) &&
    expiresAt > 0
    ? { repository, expiresAt }
    : undefined;
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

const ENROLLMENT_KINDS: readonly GatewayUiEnrollmentKind[] = [
  "devbox",
  "laptop",
  "other",
];

/** A well-formed `GatewayUiEnrollmentRequest`, or undefined. */
export function decodeGatewayUiEnrollmentRequest(
  value: unknown,
): GatewayUiEnrollmentRequest | undefined {
  if (!isRecord(value)) return undefined;
  const { name, kind, from, createdAt, expiresAt } = value;
  if (
    typeof name !== "string" ||
    name === "" ||
    !ENROLLMENT_KINDS.includes(kind as GatewayUiEnrollmentKind) ||
    typeof from !== "string" ||
    typeof createdAt !== "number" ||
    !Number.isFinite(createdAt) ||
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt)
  )
    return undefined;
  return {
    name,
    kind: kind as GatewayUiEnrollmentKind,
    from,
    createdAt,
    expiresAt,
  };
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isText = (value: unknown): value is string => typeof value === "string";

const isBoolean = (value: unknown): value is boolean =>
  typeof value === "boolean";

/** Absent, or passes `check`. */
const optional = <T>(
  value: unknown,
  check: (value: unknown) => value is T,
): value is T | undefined => value === undefined || check(value);

/** A well-formed `GatewayUiRequest`, or undefined. */
function decodeGatewayUiRequest(value: unknown): GatewayUiRequest | undefined {
  if (!isRecord(value) || !isRecord(value.client)) return undefined;
  const v = value;
  const client = value.client;
  if (
    !isCount(v.seq) ||
    !isText(v.epoch) ||
    typeof v.at !== "number" ||
    !Number.isFinite(v.at) ||
    !isText(client.id) ||
    !isText(client.label) ||
    (v.via !== "gateway" && v.via !== "relay") ||
    !optional(v.rid, isText) ||
    !isText(v.host) ||
    !isText(v.method) ||
    !isText(v.path) ||
    !isText(v.pathKey) ||
    (v.status !== null && !isCount(v.status)) ||
    !GATEWAY_UI_REQUEST_OUTCOMES.includes(
      v.outcome as GatewayUiRequestOutcome,
    ) ||
    !optional(v.reason, isText) ||
    !optional(v.count, isCount) ||
    !optional(v.listed, isBoolean) ||
    !optional(v.account, isText) ||
    !optional(v.session, isText) ||
    !GATEWAY_UI_CLIENT_CREDENTIALS.includes(
      v.clientCredential as GatewayUiClientCredential,
    ) ||
    !isBoolean(v.clientCookie) ||
    !isCount(v.requestBytes) ||
    !isCount(v.responseBytes) ||
    !isCount(v.durationMs) ||
    !isBoolean(v.firstSeen)
  )
    return undefined;
  return {
    seq: v.seq,
    epoch: v.epoch,
    at: v.at,
    client: { id: client.id, label: client.label },
    via: v.via,
    ...(v.rid === undefined ? {} : { rid: v.rid }),
    host: v.host,
    method: v.method,
    path: v.path,
    pathKey: v.pathKey,
    status: v.status,
    outcome: v.outcome as GatewayUiRequestOutcome,
    ...(v.reason === undefined ? {} : { reason: v.reason }),
    ...(v.count === undefined ? {} : { count: v.count }),
    ...(v.listed === undefined ? {} : { listed: v.listed }),
    ...(v.account === undefined ? {} : { account: v.account }),
    ...(v.session === undefined ? {} : { session: v.session }),
    clientCredential: v.clientCredential as GatewayUiClientCredential,
    clientCookie: v.clientCookie,
    requestBytes: v.requestBytes,
    responseBytes: v.responseBytes,
    durationMs: v.durationMs,
    firstSeen: v.firstSeen,
  };
}

/** A well-formed `GatewayUiRequests`, or undefined. */
export function decodeGatewayUiRequests(
  value: unknown,
): GatewayUiRequests | undefined {
  if (
    !isRecord(value) ||
    typeof value.epoch !== "string" ||
    !Array.isArray(value.requests)
  )
    return undefined;
  const requests: GatewayUiRequest[] = [];
  for (const entry of value.requests as unknown[]) {
    const request = decodeGatewayUiRequest(entry);
    if (!request) return undefined;
    requests.push(request);
  }
  return { epoch: value.epoch, requests };
}
