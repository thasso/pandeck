/**
 * Gateway control 1.4: the methods the server and the credential gateway send
 * each other over the worker protocol's codec and `WorkerConnection` framing,
 * under a version of its own (`docs/workers.md` "Credentials"). Its handshake
 * refuses a Worker, and a Worker refuses it; any 1.x peer is admitted.
 *
 * Every server → gateway method is answered only once its effect is applied
 * and saved. `control.hello` comes first on each connection; anything before
 * it fails with `hello_required`.
 *
 * - `control.hello {serverBootId, pid, startTime}` names the server's boot and
 *   answers the server leases of other boots it revoked.
 * - `profiles.sync {profiles}`, `profiles.upsert {profile}` and
 *   `profiles.remove {profileId}` change the registry and answer the leases
 *   the removal of a profile revoked. `enabled` is metadata only. A login
 *   profile names its token file; (1.4) an OpenAI-compatible one names none.
 * - `leases.grant` binds a lease to a registered profile and answers its id
 *   and token: the only place a token appears.
 * - `leases.bindSession {leaseId, sessionId}` completes an engine lease's
 *   owner once the engine's open names its session.
 * - `leases.revoke {leaseId, reason}` answers whether it revoked the lease.
 * - `leases.reconcileWorker {workerId, live}` revokes that Worker's engine
 *   leases not in `live`.
 * - `profiles.loginHold {profileId, holdId}` takes the profile's writer lane
 *   for a login and answers `held` once the hold is saved, or a refusal naming
 *   the hold that stands (`holds.ts`).
 * - `profiles.loginWriter {holdId, pid, startTime}` names a Claude hold's
 *   writer, `profiles.loginRelease {holdId}` ends a hold of this boot and
 *   `profiles.loginForceRelease {holdId}` ends any hold (the operator's
 *   assertion).
 * - (1.4) `compat.set {profileId, baseUrl, apiKey}` holds a registered
 *   OpenAI-compatible profile's endpoint and key in memory only
 *   (`compatUpstream.ts`); a URL or key it refuses clears that profile's
 *   pair. `compat.clear {profileId}` drops one pair. Every hello drops them
 *   all, and the removal of a profile, by `profiles.remove` or a sync that
 *   omits it, drops its own.
 *
 * Gateway → server: `profiles.status {profileId, loginStuck, holdId}` reports
 * a hold that became login-stuck or a stuck one that ended, and (1.3)
 * `profiles.credential {profileId, needsLogin}` a profile whose login renewal
 * found dead or absent, or alive again; each is answered `{}`.
 */
import type { Payload } from "../workerProtocol/codec.ts";
import {
  WorkerMethodError,
  type ConnectionProtocol,
} from "../workerProtocol/connection.ts";
import {
  openAiCompatibleBaseUrlError,
  openAiCompatibleApiKeyError,
} from "../../../shared/openAiCompatibleValidation.ts";
import { isHoldId, type HoldAcquired, type HoldStatus } from "./holds.ts";
import { isLeaseId } from "./leases.ts";
import { isPid, isStartTime } from "./processIdentity.ts";
import { isProfileId, parseProfile, type GatewayProfile } from "./profiles.ts";
import type { RevokeReason } from "./refusals.ts";
import { isOwnerId } from "./state.ts";

export const GATEWAY_CONTROL_VERSION = "gateway-control/1.4";

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
  loginHold: "profiles.loginHold",
  loginWriter: "profiles.loginWriter",
  loginRelease: "profiles.loginRelease",
  loginForceRelease: "profiles.loginForceRelease",
  compatSet: "compat.set",
  compatClear: "compat.clear",
  /** Gateway → server. */
  status: "profiles.status",
  credential: "profiles.credential",
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
/** The gateway holds no login hold by this id. */
export const UNKNOWN_HOLD = "unknown_hold";
/** The login hold belongs to another server boot, or to none. */
export const NOT_HOLD_OWNER = "not_hold_owner";
/** The login hold already names another writer. */
export const WRITER_CONFLICT = "writer_conflict";

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

export interface LoginHoldRequest {
  profileId: string;
  holdId: string;
}

export interface LoginWriterRequest {
  holdId: string;
  pid: number;
  /** As in {@link ControlHello}. */
  startTime: string | null;
}

/** An OpenAI-compatible profile's endpoint and key, as `compat.set` pushes them. */
export interface CompatConfig {
  profileId: string;
  baseUrl: string;
  apiKey: string;
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
    | WorkerReconcile
    | LoginHoldRequest
    | LoginWriterRequest
    | { holdId: string }
    | CompatConfig
    | Record<string, never>,
): Payload {
  return { json: { ...request } };
}

export function decodeControlHello(payload: Payload): ControlHello {
  const { serverBootId, pid, startTime } = json(payload);
  if (!isOwnerId(serverBootId)) invalid("server boot id");
  if (!isPid(pid)) invalid("pid");
  if (!isStartTime(startTime)) invalid("start time");
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

export function decodeLoginHold(payload: Payload): LoginHoldRequest {
  const { profileId, holdId } = json(payload);
  if (!isProfileId(profileId)) invalid("profile id");
  if (!isHoldId(holdId)) invalid("hold id");
  return { profileId, holdId };
}

export function decodeLoginWriter(payload: Payload): LoginWriterRequest {
  const { holdId, pid, startTime } = json(payload);
  if (!isHoldId(holdId)) invalid("hold id");
  if (!isPid(pid)) invalid("pid");
  if (!isStartTime(startTime)) invalid("start time");
  return { holdId, pid, startTime };
}

/** `profiles.loginRelease` and `profiles.loginForceRelease`. */
export function decodeHoldId(payload: Payload): string {
  const { holdId } = json(payload);
  if (!isHoldId(holdId)) invalid("hold id");
  return holdId;
}

/** The profile `compat.set` and `compat.clear` name. */
export function decodeCompatProfile(payload: Payload): string {
  const { profileId } = json(payload);
  if (!isProfileId(profileId)) invalid("profile id");
  return profileId;
}

/**
 * `compat.set`'s endpoint and key. No error message names the URL or key: a
 * refusal holds no peer text.
 */
export function decodeCompatPair(
  payload: Payload,
): Omit<CompatConfig, "profileId"> {
  const { baseUrl, apiKey } = json(payload);
  if (typeof baseUrl !== "string" || openAiCompatibleBaseUrlError(baseUrl))
    invalid("base URL");
  if (typeof apiKey !== "string" || openAiCompatibleApiKeyError(apiKey))
    invalid("API key");
  return { baseUrl, apiKey };
}

export function encodeLoginHold(acquired: HoldAcquired): Payload {
  return { json: { ...acquired } };
}

export function decodeLoginHeld(payload: Payload): HoldAcquired {
  const answer = record(payload.json);
  if (answer?.held === true) return { held: true };
  if (
    answer?.held !== false ||
    (answer.refusal !== "hold_exists" && answer.refusal !== "login_stuck") ||
    (answer.holdId !== undefined && !isHoldId(answer.holdId))
  )
    malformed("login hold answer");
  return {
    held: false,
    refusal: answer.refusal,
    ...(answer.holdId !== undefined ? { holdId: answer.holdId } : {}),
  };
}

export function encodeHoldReleased(released: boolean): Payload {
  return { json: { released } };
}

export function decodeHoldReleased(payload: Payload): boolean {
  const answer = record(payload.json);
  if (!answer || typeof answer.released !== "boolean")
    malformed("login release answer");
  return answer.released;
}

export function encodeHoldStatus(status: HoldStatus): Payload {
  return { json: { ...status } };
}

/** The server side of `profiles.status`. */
export function decodeHoldStatus(payload: Payload): HoldStatus {
  const { profileId, loginStuck, holdId } = json(payload);
  if (!isProfileId(profileId)) invalid("profile id");
  if (typeof loginStuck !== "boolean") invalid("login stuck flag");
  if (!isHoldId(holdId)) invalid("hold id");
  return { profileId, loginStuck, holdId };
}

/** A profile's needs-login, as renewal reports it (`renewal.ts`). */
export interface CredentialStatus {
  profileId: string;
  needsLogin: boolean;
}

export function encodeCredentialStatus(status: CredentialStatus): Payload {
  return {
    json: { profileId: status.profileId, needsLogin: status.needsLogin },
  };
}

/** The server side of `profiles.credential`. */
export function decodeCredentialStatus(payload: Payload): CredentialStatus {
  const { profileId, needsLogin } = json(payload);
  if (!isProfileId(profileId)) invalid("profile id");
  if (typeof needsLogin !== "boolean") invalid("needs-login flag");
  return { profileId, needsLogin };
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

/**
 * What `leases.bindSession`, `profiles.loginWriter`, `profiles.status` and
 * `profiles.credential` answer.
 */
export function encodeControlDone(): Payload {
  return { json: {} };
}
