/**
 * Gateway client 1.0 (plan Task-1384 §2): what an enrolled client (a Pandeck
 * server, through its relay) and the gateway edge send each other over the
 * worker protocol's framing, on the edge's mutual-TLS client port. The client
 * is who its certificate names; every method acts on that client's leases and
 * its user's accounts only.
 *
 * - `client.hello {}` answers `{clientId, userId}`.
 * - `accounts.list {}` answers `{accounts}`: the user's Claude and Codex
 *   accounts, `{id, provider, name, enabled, needsLogin}`.
 * - `leases.grant {accountId, workerId, sessionId?}` answers `{leaseId,
 *   token}`, an engine lease owned by this client.
 * - `leases.client {accountId}` answers `{leaseId, token}`: the client's
 *   lease for its own one-shots and usage, revoking its earlier one for that
 *   account.
 * - `leases.bindSession`, `leases.revoke` and `leases.reconcileWorker` as in
 *   gateway control 1.x, on this client's leases only.
 *
 * - `accounts.remove {accountId}` answers `{}`: removes the user's account,
 *   its leases and any login it has running, and the token file the gateway
 *   made for it.
 * - `logins.start {kind, accountId?, name?}` answers `{loginId, accountId}`:
 *   a login for the user's account, or for a new one (`logins.ts`).
 * - `logins.input {loginId, text}` and `logins.cancel {loginId}` answer `{}`,
 *   for this client's logins only.
 *
 * The user's integration credentials (Task-1397), the user always the
 * client's from the registry; a `userId` in a payload is ignored:
 *
 * - `integrations.set {integration, site, email, token}` checks the
 *   credential with the integration and stores it in the vault; answers
 *   `{connected: true, site, email, displayName?, accountId?}`.
 * - `integrations.clear {integration}` answers `{}`.
 * - `integrations.status {integration, check?}` answers `{connected, site?,
 *   email?, displayName?, accountId?, problem?}`: `site` and `email` whenever
 *   a credential is stored, and with `check` whether it works. Never a token.
 *
 * The edge's tools (Task-1398), run with the client's user's credential:
 *
 * - `tools.list {}` answers `{tools}`: each `{name, description,
 *   inputSchema, effect, actionKey}`.
 * - `tools.call {name, args}` answers the tool's outcome, `{ok: true, text}`
 *   or `{ok: false, code, message}`; only a malformed request fails the call.
 *   A `cancel` aborts it.
 *
 * Gateway → client: `accounts.changed {accounts}`, the full list after any
 * change, and `logins.event {loginId, accountId, event}`, each answered `{}`.
 */
import type { Payload } from "../workerProtocol/codec.ts";
import {
  WorkerMethodError,
  type ConnectionProtocol,
} from "../workerProtocol/connection.ts";
import type { LeaseProvider } from "./leases.ts";
import type { LoginEvent, LoginStart } from "./logins.ts";
import { isLeaseProvider, isProfileId } from "./profiles.ts";
import { isOwnerId } from "./state.ts";
import { INVALID_PARAMS } from "./controlMethods.ts";
import type { ToolAnswer, ToolFailureCode } from "./edgeTools.ts";

export const GATEWAY_CLIENT_VERSION = "gateway-client/1.0";

const CLIENT_VERSION_RE =
  /^gateway-client\/(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

export const GATEWAY_CLIENT_PROTOCOL: ConnectionProtocol = {
  version: GATEWAY_CLIENT_VERSION,
  compatible: (version) => CLIENT_VERSION_RE.exec(version)?.[1] === "1",
};

export const CLIENT_METHODS = {
  hello: "client.hello",
  listAccounts: "accounts.list",
  grant: "leases.grant",
  clientLease: "leases.client",
  bindSession: "leases.bindSession",
  revoke: "leases.revoke",
  reconcileWorker: "leases.reconcileWorker",
  removeAccount: "accounts.remove",
  loginStart: "logins.start",
  loginInput: "logins.input",
  loginCancel: "logins.cancel",
  integrationSet: "integrations.set",
  integrationClear: "integrations.clear",
  integrationStatus: "integrations.status",
  toolsList: "tools.list",
  toolsCall: "tools.call",
  /** Gateway → client. */
  accountsChanged: "accounts.changed",
  loginEvent: "logins.event",
} as const;

/** The client's certificate is unknown or revoked: the connection ends. */
export const CLIENT_REVOKED = "client_revoked";
/** The account is not the client's user's, or not a login. */
export const UNKNOWN_ACCOUNT = "unknown_account";
/** No login by this id for this client. */
export const UNKNOWN_LOGIN = "unknown_login";
/** The gateway runs no driver for this kind of login. */
export const LOGIN_UNAVAILABLE = "login_unavailable";

/**
 * The integration methods' failures (Task-1397), each with one fixed text
 * the gateway sends and the client may show.
 */
const INTEGRATION_FAILURES = {
  integration_invalid: "The site, email or API token is not valid.",
  integration_rejected: "Atlassian rejected the email and API token.",
  integration_unreachable: "Atlassian could not check the credential.",
  vault_locked: "The vault is locked.",
  vault_unavailable: "The vault did not answer; check the Jira status.",
  tools_unavailable: "This gateway runs no tools.",
  integration_busy:
    "Another change to this credential is still running. Try again.",
} as const;
export type IntegrationFailure = keyof typeof INTEGRATION_FAILURES;

export function isIntegrationFailure(code: string): code is IntegrationFailure {
  return Object.hasOwn(INTEGRATION_FAILURES, code);
}

export function integrationFailure(code: IntegrationFailure): never {
  throw new WorkerMethodError(code, INTEGRATION_FAILURES[code]);
}

/** Why a status answer is not connected. */
type IntegrationProblem =
  | "vault_locked"
  | "vault_unavailable"
  | "invalid"
  | "rejected"
  | "unreachable"
  | "failed";
const INTEGRATION_PROBLEMS = new Set<string>([
  "vault_locked",
  "vault_unavailable",
  "invalid",
  "rejected",
  "unreachable",
  "failed",
]);

export interface IntegrationStatus {
  connected: boolean;
  site?: string;
  email?: string;
  displayName?: string;
  accountId?: string;
  problem?: IntegrationProblem;
}

export interface ClientAccount {
  id: string;
  provider: LeaseProvider;
  name: string;
  enabled: boolean;
  needsLogin: boolean;
}

export interface ClientIdentity {
  clientId: string;
  userId: string;
}

export interface ClientGrant {
  accountId: string;
  workerId: string;
  sessionId?: string;
}

function invalid(what: string): never {
  throw new WorkerMethodError(INVALID_PARAMS, `Invalid ${what}.`);
}

function malformed(what: string): never {
  throw new Error(`The gateway's ${what} is malformed.`);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function encodeClientMessage(value: object): Payload {
  return { json: { ...value } };
}

export function decodeClientIdentity(payload: Payload): ClientIdentity {
  const answer = record(payload.json);
  if (
    !answer ||
    typeof answer.clientId !== "string" ||
    typeof answer.userId !== "string"
  )
    malformed("hello answer");
  return { clientId: answer.clientId, userId: answer.userId };
}

export function decodeAccounts(payload: Payload): ClientAccount[] {
  const accounts = record(payload.json)?.accounts;
  if (!Array.isArray(accounts)) malformed("account list");
  return accounts.map((value: unknown) => {
    const a = record(value);
    if (
      !a ||
      !isProfileId(a.id) ||
      !isLeaseProvider(a.provider) ||
      typeof a.name !== "string" ||
      typeof a.enabled !== "boolean" ||
      typeof a.needsLogin !== "boolean"
    )
      malformed("account list");
    return {
      id: a.id,
      provider: a.provider,
      name: a.name,
      enabled: a.enabled,
      needsLogin: a.needsLogin,
    };
  });
}

export function decodeClientGrant(payload: Payload): ClientGrant {
  const { accountId, workerId, sessionId } = record(payload.json) ?? {};
  if (!isProfileId(accountId)) invalid("account id");
  if (!isOwnerId(workerId)) invalid("Worker id");
  if (sessionId === undefined) return { accountId, workerId };
  if (!isOwnerId(sessionId)) invalid("session id");
  return { accountId, workerId, sessionId };
}

export function decodeAccountId(payload: Payload): string {
  const accountId = record(payload.json)?.accountId;
  if (!isProfileId(accountId)) invalid("account id");
  return accountId;
}

export function decodeLoginStart(payload: Payload): LoginStart {
  const { kind, accountId, name } = record(payload.json) ?? {};
  if (!isLeaseProvider(kind)) invalid("login kind");
  if (accountId !== undefined && !isProfileId(accountId)) invalid("account id");
  if (name !== undefined && (typeof name !== "string" || name.length > 200))
    invalid("account name");
  return {
    kind,
    ...(accountId !== undefined ? { accountId } : {}),
    ...(name !== undefined ? { name } : {}),
  };
}

export function decodeLoginStarted(payload: Payload): {
  loginId: string;
  accountId: string;
} {
  const { loginId, accountId } = record(payload.json) ?? {};
  if (typeof loginId !== "string" || !isProfileId(accountId))
    malformed("login start answer");
  return { loginId, accountId };
}

export function decodeLoginId(payload: Payload): string {
  const loginId = record(payload.json)?.loginId;
  if (typeof loginId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(loginId))
    invalid("login id");
  return loginId;
}

export function decodeLoginInput(payload: Payload): {
  loginId: string;
  text: string;
} {
  const text = record(payload.json)?.text;
  if (typeof text !== "string") invalid("login input");
  return { loginId: decodeLoginId(payload), text };
}

function integrationOf(value: unknown): "atlassian" {
  if (value !== "atlassian") invalid("integration");
  return value;
}

/** `integrations.set`: the integration and the raw fields its parser checks. */
export function decodeIntegrationSet(payload: Payload): {
  integration: "atlassian";
  input: { site: unknown; email: unknown; token: unknown };
} {
  const { integration, site, email, token } = record(payload.json) ?? {};
  return {
    integration: integrationOf(integration),
    input: { site, email, token },
  };
}

export function decodeIntegration(payload: Payload): "atlassian" {
  return integrationOf(record(payload.json)?.integration);
}

export function decodeIntegrationStatusRequest(payload: Payload): {
  integration: "atlassian";
  check: boolean;
} {
  const body = record(payload.json) ?? {};
  if (body.check !== undefined && typeof body.check !== "boolean")
    invalid("check");
  return {
    integration: integrationOf(body.integration),
    check: body.check === true,
  };
}

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length <= max ? value : undefined;

/** A `integrations.set` or `integrations.status` answer, on the client. */
export function decodeIntegrationStatus(payload: Payload): IntegrationStatus {
  const answer = record(payload.json);
  if (!answer || typeof answer.connected !== "boolean")
    malformed("integration status");
  const site = text(answer.site, 255);
  const email = text(answer.email, 254);
  const displayName = text(answer.displayName, 200);
  const accountId = text(answer.accountId, 200);
  const problem =
    typeof answer.problem === "string" &&
    INTEGRATION_PROBLEMS.has(answer.problem)
      ? (answer.problem as IntegrationProblem)
      : undefined;
  return {
    connected: answer.connected,
    ...(site !== undefined ? { site } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
    ...(accountId !== undefined ? { accountId } : {}),
    ...(problem !== undefined ? { problem } : {}),
  };
}

const LOGIN_STATES = new Set(["running", "ready", "error", "cancelled"]);

/** A `logins.event` from the gateway, or undefined when malformed. */
export function decodeLoginEvent(
  payload: Payload,
): { loginId: string; accountId: string; event: LoginEvent } | undefined {
  const { loginId, accountId, event } = record(payload.json) ?? {};
  const e = record(event);
  if (typeof loginId !== "string" || !isProfileId(accountId) || !e)
    return undefined;
  const at = { loginId, accountId };
  if (e.type === "output" && typeof e.text === "string")
    return { ...at, event: { type: "output", text: e.text } };
  if (e.type === "url" && typeof e.url === "string")
    return { ...at, event: { type: "url", url: e.url } };
  if (e.type === "code" && typeof e.code === "string")
    return { ...at, event: { type: "code", code: e.code } };
  if (
    e.type === "state" &&
    typeof e.state === "string" &&
    LOGIN_STATES.has(e.state) &&
    (e.error === undefined || typeof e.error === "string")
  )
    return {
      ...at,
      event: {
        type: "state",
        state: e.state as Extract<LoginEvent, { type: "state" }>["state"],
        ...(typeof e.error === "string" ? { error: e.error } : {}),
      },
    };
  return undefined;
}

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** `tools.call`: the tool's name and its arguments, a plain object. */
export function decodeToolCall(payload: Payload): {
  name: string;
  args: Record<string, unknown>;
} {
  const { name, args } = record(payload.json) ?? {};
  if (typeof name !== "string" || !TOOL_NAME_RE.test(name))
    invalid("tool name");
  if (args === undefined) return { name, args: {} };
  const object = record(args);
  if (!object) invalid("tool arguments");
  return { name, args: object };
}

/** A `tools.list` answer's entries, unchecked: the client accepts them. */
export function decodeToolListing(payload: Payload): unknown[] {
  const tools = record(payload.json)?.tools;
  if (!Array.isArray(tools)) malformed("tool list");
  return tools;
}

const TOOL_FAILURE_CODES = new Set<string>([
  "unknown_tool",
  "invalid_params",
  "tool_error",
  "result_too_large",
  "timeout",
  "cancelled",
  "failed",
] satisfies ToolFailureCode[]);
const TOOL_MESSAGE_MAX = 500;

/** A `tools.call` answer, on the client: an unknown code reads as `failed`. */
export function decodeToolAnswer(payload: Payload): ToolAnswer {
  const answer = record(payload.json);
  if (answer?.ok === true && typeof answer.text === "string")
    return { ok: true, text: answer.text };
  if (answer?.ok !== false) malformed("tool answer");
  const message =
    typeof answer.message === "string"
      ? answer.message.slice(0, TOOL_MESSAGE_MAX)
      : "";
  return {
    ok: false,
    code:
      typeof answer.code === "string" && TOOL_FAILURE_CODES.has(answer.code)
        ? (answer.code as ToolFailureCode)
        : "failed",
    message,
  };
}
