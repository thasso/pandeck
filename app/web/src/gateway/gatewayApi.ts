/**
 * The gateway page's API calls (Task-1402 B2): its own origin only, with its
 * session cookie and, on every POST, the CSRF header. No Pandeck token and no
 * `serverOrigin`. Answers are checked with the shared decoders; any other
 * answer is a `GatewayApiError` carrying the status and the fixed code.
 * Secrets (the Atlassian token, enrollment codes, MCP tokens) and a machine's
 * user code travel only in POST bodies and their answers, never in a URL.
 */
import {
  decodeGatewayUiAccounts,
  decodeGatewayUiAtlassian,
  decodeGatewayUiAtlassianConnectStart,
  decodeGatewayUiClients,
  decodeGatewayUiEnrollmentCode,
  decodeGatewayUiEnrollmentRequest,
  decodeGatewayUiGithub,
  decodeGatewayUiGithubCheck,
  decodeGatewayUiGithubConnectStart,
  decodeGatewayUiLogin,
  decodeGatewayUiLoginStart,
  decodeGatewayUiMcpToken,
  decodeGatewayUiRequests,
  decodeGatewayUiSlack,
  decodeGatewayUiSlackConnectStart,
  GATEWAY_UI_CSRF_HEADER,
  type GatewayUiAccount,
  type GatewayUiAtlassian,
  type GatewayUiAtlassianSetRequest,
  type GatewayUiClient,
  type GatewayUiEnrollmentCode,
  type GatewayUiEnrollmentRequest,
  type GatewayUiError,
  type GatewayUiGithub,
  type GatewayUiGithubCheck,
  type GatewayUiGithubCheckRequest,
  type GatewayUiLogin,
  type GatewayUiLoginStart,
  type GatewayUiLoginStartRequest,
  type GatewayUiMcpToken,
  type GatewayUiRequests,
  type GatewayUiSlack,
} from "@assistant/shared/gatewayUi";

export class GatewayApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: GatewayUiError["error"] | undefined,
  ) {
    super(code ?? `status ${status}`);
  }
}

async function errorOf(response: Response): Promise<GatewayApiError> {
  let code: GatewayUiError["error"] | undefined;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string")
      code = body.error as GatewayUiError["error"];
  } catch {
    // Not a refusal body.
  }
  return new GatewayApiError(response.status, code);
}

async function get(path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw await errorOf(response);
  return response.json();
}

async function post(path: string, body: unknown): Promise<Response> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      [GATEWAY_UI_CSRF_HEADER]: "1",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await errorOf(response);
  return response;
}

function decoded<T>(value: T | undefined): T {
  if (value === undefined) throw new GatewayApiError(200, undefined);
  return value;
}

export async function fetchAccounts(
  _key: string,
  signal: AbortSignal,
): Promise<GatewayUiAccount[]> {
  return decoded(decodeGatewayUiAccounts(await get("/api/accounts", signal)))
    .accounts;
}

export async function startLogin(
  request: GatewayUiLoginStartRequest,
): Promise<GatewayUiLoginStart> {
  const response = await post("/api/logins/start", request);
  return decoded(decodeGatewayUiLoginStart(await response.json()));
}

export async function readLogin(
  loginId: string,
  cursor: number,
): Promise<GatewayUiLogin> {
  const query = new URLSearchParams({
    login: loginId,
    cursor: String(cursor),
  });
  return decoded(decodeGatewayUiLogin(await get(`/api/logins/read?${query}`)));
}

/** Whether the pasted code reached the gateway. */
export async function inputLogin(
  loginId: string,
  text: string,
): Promise<boolean> {
  try {
    await post("/api/logins/input", { loginId, text });
    return true;
  } catch {
    return false;
  }
}

export async function cancelLogin(loginId: string): Promise<void> {
  await post("/api/logins/cancel", { loginId });
}

export async function removeAccount(accountId: string): Promise<void> {
  await post("/api/accounts/remove", { accountId });
}

export async function fetchAtlassian(
  _key: string,
  signal: AbortSignal,
): Promise<GatewayUiAtlassian> {
  return decoded(
    decodeGatewayUiAtlassian(await get("/api/integrations/atlassian", signal)),
  );
}

/** Checks the credential with Atlassian, then stores it. */
export async function setAtlassian(
  request: GatewayUiAtlassianSetRequest,
): Promise<GatewayUiAtlassian> {
  const response = await post("/api/integrations/atlassian/set", request);
  return decoded(decodeGatewayUiAtlassian(await response.json()));
}

export async function clearAtlassian(): Promise<void> {
  await post("/api/integrations/atlassian/clear", {});
}

/**
 * Starts "Sign in with Atlassian": the URL the browser goes to next, accepted
 * only on Atlassian's authorize endpoint.
 */
export async function startAtlassianConnect(): Promise<string> {
  const response = await post("/api/integrations/atlassian/connect", {});
  return decoded(decodeGatewayUiAtlassianConnectStart(await response.json()))
    .authorizeUrl;
}

/** The user's Slack connection, and whether this gateway offers it. */
export async function fetchSlack(
  _key: string,
  signal: AbortSignal,
): Promise<GatewayUiSlack> {
  return decoded(
    decodeGatewayUiSlack(await get("/api/integrations/slack", signal)),
  );
}

/**
 * Starts "Sign in with Slack": the URL the browser goes to next, accepted only
 * on Slack's authorize endpoint.
 */
export async function startSlackConnect(): Promise<string> {
  const response = await post("/api/integrations/slack/connect", {});
  return decoded(decodeGatewayUiSlackConnectStart(await response.json()))
    .authorizeUrl;
}

export async function clearSlack(): Promise<void> {
  await post("/api/integrations/slack/clear", {});
}

/** The user's GitHub connection, and whether this gateway offers it. */
export async function fetchGithub(
  _key: string,
  signal: AbortSignal,
): Promise<GatewayUiGithub> {
  return decoded(
    decodeGatewayUiGithub(await get("/api/integrations/github", signal)),
  );
}

/**
 * Starts "Connect GitHub": the URL the browser goes to next, accepted only on
 * GitHub's authorize endpoint.
 */
export async function startGithubConnect(): Promise<string> {
  const response = await post("/api/integrations/github/connect", {});
  return decoded(decodeGatewayUiGithubConnectStart(await response.json()))
    .authorizeUrl;
}

export async function clearGithub(): Promise<void> {
  await post("/api/integrations/github/clear", {});
}

/**
 * Whether the vault hands the user read access to `owner/repo`: the
 * repository and the token's expiry, never the token.
 */
export async function checkGithub(
  request: GatewayUiGithubCheckRequest,
): Promise<GatewayUiGithubCheck> {
  const response = await post("/api/integrations/github/check", request);
  return decoded(decodeGatewayUiGithubCheck(await response.json()));
}

export async function fetchClients(
  _key: string,
  signal: AbortSignal,
): Promise<GatewayUiClient[]> {
  return decoded(decodeGatewayUiClients(await get("/api/clients", signal)))
    .clients;
}

export async function createEnrollmentCode(
  label: string,
): Promise<GatewayUiEnrollmentCode> {
  const response = await post("/api/clients/code", { label });
  return decoded(decodeGatewayUiEnrollmentCode(await response.json()));
}

export async function revokeClient(clientId: string): Promise<void> {
  await post("/api/clients/revoke", { clientId });
}

export async function mintMcpToken(
  clientId: string,
): Promise<GatewayUiMcpToken> {
  const response = await post("/api/clients/mcp-token", { clientId });
  return decoded(decodeGatewayUiMcpToken(await response.json()));
}

export async function revokeMcpToken(clientId: string): Promise<void> {
  await post("/api/clients/mcp-token/revoke", { clientId });
}

/** The machine's pending request for this user code (Task-1410). */
export async function lookupEnrollment(
  userCode: string,
): Promise<GatewayUiEnrollmentRequest> {
  const response = await post("/api/enrollments/lookup", { userCode });
  return decoded(decodeGatewayUiEnrollmentRequest(await response.json()));
}

/** Approves or denies it for the signed-in user; the first decision wins. */
export async function decideEnrollment(
  userCode: string,
  approve: boolean,
): Promise<void> {
  await post("/api/enrollments/decide", { userCode, approve });
}

/**
 * The signed-in user's request records after `after` in `epoch` (Task-1430),
 * oldest first, at most 500. Without an epoch, or with another one, the
 * answer starts from the oldest kept and names the current epoch.
 */
export async function fetchRequests(
  epoch: string | undefined,
  after: number,
  signal: AbortSignal,
): Promise<GatewayUiRequests> {
  const query = new URLSearchParams({ after: String(after) });
  if (epoch !== undefined) query.set("epoch", epoch);
  return decoded(
    decodeGatewayUiRequests(await get(`/api/requests?${query}`, signal)),
  );
}
