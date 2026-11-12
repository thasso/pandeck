/**
 * What the gateway UI needs of the edge's accounts and logins (Task-1402
 * B2), defined here as `users.ts` defines the users: the edge's composition
 * adapts its user-scoped operations (`gateway/userOperations.ts`) to it, so
 * this directory imports nothing from `gateway/`.
 *
 * The user and the actor always come from the session. A refusal is an
 * `AccountsRefusal` with a fixed code; anything else thrown means the
 * registry is unavailable.
 */
import type {
  GatewayUiAccount,
  GatewayUiLogin,
  GatewayUiLoginReason,
  GatewayUiLoginStartRequest,
  GatewayUiLoginState,
  GatewayUiProvider,
} from "@assistant/shared/gatewayUi";

/** A signed-in session as the actor of its logins. */
export interface GatewayWebActor {
  actorId: string;
  userId: string;
  /** False once the session ended or expired: its logins cannot commit. */
  active(): boolean;
}

/** A login as the edge keeps it, before the browser projection. */
export interface GatewayWebLoginView {
  kind: GatewayUiProvider;
  state: GatewayUiLoginState;
  reason?: GatewayUiLoginReason;
  output: string;
  cursor: number;
  url?: string;
  code?: string;
}

export type AccountsRefusalCode =
  "unknown_account" | "unknown_login" | "login_unavailable";

export class AccountsRefusal extends Error {
  constructor(readonly code: AccountsRefusalCode) {
    super(code);
  }
}

export interface GatewayWebAccounts {
  list(userId: string): GatewayUiAccount[];
  remove(userId: string, accountId: string): void;
  start(
    actor: GatewayWebActor,
    start: GatewayUiLoginStartRequest,
  ): { loginId: string; accountId: string };
  input(actor: GatewayWebActor, loginId: string, text: string): void;
  cancel(actor: GatewayWebActor, loginId: string): void;
  read(
    actor: GatewayWebActor,
    loginId: string,
    cursor: number,
  ): GatewayWebLoginView;
  /** The session ended: its logins are cancelled. */
  endActor(actorId: string): void;
}

/**
 * What the page may see of a login: its state, a fixed reason, its output,
 * and a ChatGPT login's link and code only once both are known. Never the
 * driver's error text.
 */
export function browserLogin(view: GatewayWebLoginView): GatewayUiLogin {
  return {
    state: view.state,
    ...(view.reason ? { reason: view.reason } : {}),
    output: view.output,
    cursor: view.cursor,
    ...(view.kind === "openai-codex" &&
    view.url !== undefined &&
    view.code !== undefined
      ? { device: { verificationUri: view.url, userCode: view.code } }
      : {}),
  };
}

const MAX_ID_CHARS = 128;
const MAX_NAME_CHARS = 200;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is string =>
  typeof value === "string" && value !== "" && value.length <= MAX_ID_CHARS;

/** A body's JSON, or undefined when it is not JSON. */
export function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** `{kind, accountId?, name?}`; any other field (a `userId`) is ignored. */
export function decodeStartRequest(
  value: unknown,
): GatewayUiLoginStartRequest | undefined {
  if (!isRecord(value)) return undefined;
  const { kind, accountId, name } = value;
  if (kind !== "claude" && kind !== "openai-codex") return undefined;
  if (accountId !== undefined && !isId(accountId)) return undefined;
  if (
    name !== undefined &&
    (typeof name !== "string" || name.length > MAX_NAME_CHARS)
  )
    return undefined;
  return {
    kind,
    ...(accountId !== undefined ? { accountId } : {}),
    ...(name !== undefined ? { name } : {}),
  };
}

/** `{accountId}`. */
export function decodeAccountRequest(value: unknown): string | undefined {
  return isRecord(value) && isId(value.accountId) ? value.accountId : undefined;
}

/** `{loginId}`. */
export function decodeLoginRequest(value: unknown): string | undefined {
  return isRecord(value) && isId(value.loginId) ? value.loginId : undefined;
}

/** `{loginId, text}`. */
export function decodeInputRequest(
  value: unknown,
): { loginId: string; text: string } | undefined {
  if (!isRecord(value) || !isId(value.loginId)) return undefined;
  return typeof value.text === "string"
    ? { loginId: value.loginId, text: value.text }
    : undefined;
}

/** A read's `cursor`: absent is 0, otherwise a non-negative integer. */
export function decodeCursor(value: string | null): number | undefined {
  if (value === null) return 0;
  if (!/^\d{1,9}$/.test(value)) return undefined;
  return Number(value);
}
