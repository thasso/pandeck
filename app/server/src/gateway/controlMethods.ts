/**
 * Gateway control 1.0: the methods the server sends the credential gateway
 * over the worker protocol's codec and `WorkerConnection` framing, under a
 * version of its own (`docs/workers.md` "Credentials"). Its handshake refuses
 * a Worker, and a Worker refuses it.
 *
 * Every method is server → gateway and is answered only once its effect is
 * applied and saved. `control.hello` comes first on each connection; anything
 * before it fails with `hello_required`.
 *
 * - `control.hello {serverBootId, pid, startTime}` names the server's boot and
 *   answers the server leases of other boots it revoked.
 * - `profiles.sync {profiles}`, `profiles.upsert {profile}` and
 *   `profiles.remove {profileId}` change the registry and answer the leases
 *   the removal of a profile revoked. `enabled` is metadata only.
 * - `leases.grant` binds a lease to a registered profile and answers its id
 *   and token: the only place a token appears.
 * - `leases.bindSession {leaseId, sessionId}` completes an engine lease's
 *   owner once the engine's open names its session.
 * - `leases.revoke {leaseId, reason}` answers whether it revoked the lease.
 * - `leases.reconcileWorker {workerId, live}` revokes that Worker's engine
 *   leases not in `live`.
 */
import type { Payload } from "../workerProtocol/codec.ts";
import {
  WorkerMethodError,
  type ConnectionProtocol,
} from "../workerProtocol/connection.ts";
import { isLeaseId } from "./leases.ts";
import { isProfileId, parseProfile, type GatewayProfile } from "./profiles.ts";
import type { RevokeReason } from "./refusals.ts";
import { isOwnerId } from "./state.ts";

export const GATEWAY_CONTROL_VERSION = "gateway-control/1.0";

const CONTROL_VERSION_RE =
  /^gateway-control\/(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

/** Compatible exactly when the prefix matches and the major is 1. */
export const GATEWAY_CONTROL_PROTOCOL: ConnectionProtocol = {
  version: GATEWAY_CONTROL_VERSION,
  compatible: (version) => CONTROL_VERSION_RE.exec(version)?.[1] === "1",
};

export const CONTROL_METHODS = {
  hello: "control.hello",
  syncProfiles: "profiles.sync",
  upsertProfile: "profiles.upsert",
  removeProfile: "profiles.remove",
  grant: "leases.grant",
  bindSession: "leases.bindSession",
  revoke: "leases.revoke",
  reconcileWorker: "leases.reconcileWorker",
} as const;

/** A method other than `control.hello` came before it. */
export const HELLO_REQUIRED = "hello_required";
/** The grant names a profile the registry does not hold. */
export const UNKNOWN_PROFILE = "unknown_profile";
/** The lease is unknown, pruned or revoked. */
export const UNKNOWN_LEASE = "unknown_lease";
/** The engine lease's owner already names another session. */
export const OWNER_CONFLICT = "owner_conflict";
/** The params do not decode. */
export const INVALID_PARAMS = "invalid_params";
/** The gateway could not save its state; see the method for what stands. */
export const STATE_WRITE_FAILED = "state_write_failed";

export interface ControlHello {
  serverBootId: string;
  pid: number;
  /** Field 22 of `/proc/<pid>/stat`, or null where `/proc` is absent. */
  startTime: string | null;
}

export type LeaseGrant =
  | { kind: "engine"; workerId: string; sessionId?: string; profileId: string }
  | { kind: "server"; profileId: string };

export interface LeaseGranted {
  leaseId: string;
  token: string;
}

export interface LeaseSessionBind {
  leaseId: string;
  sessionId: string;
}

export interface LeaseRevoke {
  leaseId: string;
  reason: RevokeReason;
}

export interface WorkerReconcile {
  workerId: string;
  live: string[];
}

/** What `control.hello`, the profile methods and the reconcile answer. */
export interface LeasesRevoked {
  revoked: string[];
}

/** The gateway answered something these decoders cannot read. */
class MalformedControlAnswerError extends Error {}

function invalid(what: string): never {
  throw new WorkerMethodError(INVALID_PARAMS, `Invalid ${what}.`);
}

function malformed(what: string): never {
  throw new MalformedControlAnswerError(
    `The gateway answered a malformed ${what}.`,
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function json(payload: Payload): Record<string, unknown> {
  return record(payload.json) ?? invalid("params");
}

const isLeaseIds = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isLeaseId);

function profile(value: unknown): GatewayProfile {
  return parseProfile(value) ?? invalid("profile");
}

/** Any request: the server encodes its fields as they are. */
export function encodeControlRequest(
  request:
    | ControlHello
    | { profiles: GatewayProfile[] }
    | { profile: GatewayProfile }
    | { profileId: string }
    | LeaseGrant
    | LeaseSessionBind
    | LeaseRevoke
    | WorkerReconcile,
): Payload {
  return { json: { ...request } };
}

export function decodeControlHello(payload: Payload): ControlHello {
  const { serverBootId, pid, startTime } = json(payload);
  if (!isOwnerId(serverBootId)) invalid("server boot id");
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)
    invalid("pid");
  if (
    startTime !== null &&
    !(typeof startTime === "string" && /^\d{1,20}$/.test(startTime))
  )
    invalid("start time");
  return { serverBootId, pid, startTime };
}

export function decodeProfileSync(payload: Payload): GatewayProfile[] {
  const { profiles } = json(payload);
  if (!Array.isArray(profiles)) invalid("profiles");
  const decoded = profiles.map(profile);
  if (new Set(decoded.map((p) => p.id)).size !== decoded.length)
    invalid("profiles: an id appears twice");
  return decoded;
}

export function decodeProfileUpsert(payload: Payload): GatewayProfile {
  return profile(json(payload).profile);
}

export function decodeProfileRemove(payload: Payload): string {
  const { profileId } = json(payload);
  if (!isProfileId(profileId)) invalid("profile id");
  return profileId;
}

/** Fields the request names besides these, `provider` and `tokenFile` included, are ignored. */
export function decodeLeaseGrant(payload: Payload): LeaseGrant {
  const { kind, workerId, sessionId, profileId } = json(payload);
  if (!isProfileId(profileId)) invalid("profile id");
  if (kind === "server") return { kind, profileId };
  if (kind !== "engine") invalid("lease kind");
  if (!isOwnerId(workerId)) invalid("Worker id");
  if (sessionId === undefined) return { kind, workerId, profileId };
  if (!isOwnerId(sessionId)) invalid("session id");
  return { kind, workerId, sessionId, profileId };
}

export function decodeLeaseSessionBind(payload: Payload): LeaseSessionBind {
  const { leaseId, sessionId } = json(payload);
  if (!isLeaseId(leaseId)) invalid("lease id");
  if (!isOwnerId(sessionId)) invalid("session id");
  return { leaseId, sessionId };
}

export function decodeLeaseRevoke(payload: Payload): LeaseRevoke {
  const { leaseId, reason } = json(payload);
  if (!isLeaseId(leaseId)) invalid("lease id");
  if (
    reason !== "profile-removed" &&
    reason !== "account-switch" &&
    reason !== "session-ended"
  )
    invalid("revoke reason");
  return { leaseId, reason };
}

export function decodeWorkerReconcile(payload: Payload): WorkerReconcile {
  const { workerId, live } = json(payload);
  if (!isOwnerId(workerId)) invalid("Worker id");
  if (!isLeaseIds(live)) invalid("live lease ids");
  return { workerId, live: [...live] };
}

export function encodeLeasesRevoked(revoked: string[]): Payload {
  return { json: { revoked } };
}

export function decodeLeasesRevoked(payload: Payload): LeasesRevoked {
  const answer = record(payload.json);
  if (!answer || !isLeaseIds(answer.revoked)) malformed("revocation answer");
  return { revoked: answer.revoked };
}

export function encodeLeaseGranted(granted: LeaseGranted): Payload {
  return { json: { leaseId: granted.leaseId, token: granted.token } };
}

export function decodeLeaseGranted(payload: Payload): LeaseGranted {
  const answer = record(payload.json);
  if (!answer || !isLeaseId(answer.leaseId) || typeof answer.token !== "string")
    malformed("lease grant answer");
  return { leaseId: answer.leaseId, token: answer.token };
}

export function encodeLeaseRevoked(revoked: boolean): Payload {
  return { json: { revoked } };
}

export function decodeLeaseRevoked(payload: Payload): boolean {
  const answer = record(payload.json);
  if (!answer || typeof answer.revoked !== "boolean")
    malformed("lease revoke answer");
  return answer.revoked;
}

/** What `leases.bindSession` answers. */
export function encodeControlDone(): Payload {
  return { json: {} };
}
