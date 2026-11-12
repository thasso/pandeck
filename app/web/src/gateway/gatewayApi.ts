/**
 * The gateway page's API calls (Task-1402 B2): its own origin only, with its
 * session cookie and, on every POST, the CSRF header. No Pandeck token and no
 * `serverOrigin`. Answers are checked with the shared decoders; any other
 * answer is a `GatewayApiError` carrying the status and the fixed code.
 */
import {
  decodeGatewayUiAccounts,
  decodeGatewayUiLogin,
  decodeGatewayUiLoginStart,
  GATEWAY_UI_CSRF_HEADER,
  type GatewayUiAccount,
  type GatewayUiError,
  type GatewayUiLogin,
  type GatewayUiLoginStart,
  type GatewayUiLoginStartRequest,
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
