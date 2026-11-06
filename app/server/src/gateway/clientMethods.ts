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
 * Gateway → client: `accounts.changed {accounts}`, the full list after any
 * change, answered `{}`.
 */
import type { Payload } from "../workerProtocol/codec.ts";
import {
  WorkerMethodError,
  type ConnectionProtocol,
} from "../workerProtocol/connection.ts";
import type { LeaseProvider } from "./leases.ts";
import { isLeaseProvider, isProfileId } from "./profiles.ts";
import { isOwnerId } from "./state.ts";
import { INVALID_PARAMS } from "./controlMethods.ts";

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
  /** Gateway → client. */
  accountsChanged: "accounts.changed",
} as const;

/** The client's certificate is unknown or revoked: the connection ends. */
export const CLIENT_REVOKED = "client_revoked";
/** The account is not the client's user's, or not a login. */
export const UNKNOWN_ACCOUNT = "unknown_account";

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
