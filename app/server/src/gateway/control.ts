/**
 * The gateway's control endpoint (`docs/workers.md` "Credentials"): the
 * listener side of gateway control 1.4. Only a control connection grants a
 * lease or takes, names or ends a login hold, and a grant binds the lease from
 * the registry, never from the request (C5).
 *
 * Each method runs to completion synchronously, saving included, so methods
 * apply one at a time in arrival order across every connection. The one
 * exception is `profiles.loginHold`: its checks and refusal run so, then it
 * waits for the profile's writer lane and saves the hold at its turn. A hello
 * on a newer connection ends the older one. Lease tokens appear only in the
 * grant answer; a log line names the method, the profile, lease and hold ids
 * and the outcome, never a token, secret, hash or credential.
 *
 * Every hold is rechecked on each hello, before its answer, and when the
 * gateway's timer calls `checkHolds`. Each change, and after a hello every
 * login-stuck hold, is sent to the current connection as `profiles.status`
 * once the answer that caused it has gone out; a failure is logged, never
 * retried. Renewal's needs-login changes go out as `profiles.credential` the
 * same way, and each hello resends every profile that needs a login. The
 * holds, the writer lane and the needs-login list are the vault's
 * (`vaultPort.ts`): a hold that ends there is re-read by the vault itself.
 *
 * Every hello also clears every pushed OpenAI-compatible endpoint: its key
 * belongs to the boot that pushed it, which the next push replaces. A
 * connection that ends without a new hello leaves them held. Removing a
 * profile clears its pair before its leases are revoked, so a failed save
 * leaves no pair behind. Only login profiles are fenced, held or renewed: an
 * OpenAI-compatible profile has no login.
 */
import type { Payload } from "../workerProtocol/codec.ts";
import {
  WorkerConnection,
  WorkerMethodError,
  WorkerRequestError,
  type MethodHandler,
} from "../workerProtocol/connection.ts";
import type { ByteEndpoint } from "../workerProtocol/inProcessTransport.ts";
import {
  CONTROL_METHODS,
  GATEWAY_CONTROL_PROTOCOL,
  GATEWAY_CONTROL_VERSION,
  HELLO_REQUIRED,
  INVALID_PARAMS,
  NOT_HOLD_OWNER,
  OWNER_CONFLICT,
  STATE_WRITE_FAILED,
  UNKNOWN_HOLD,
  UNKNOWN_LEASE,
  UNKNOWN_PROFILE,
  WRITER_CONFLICT,
  decodeCompatPair,
  decodeCompatProfile,
  decodeControlHello,
  decodeHoldId,
  decodeLeaseGrant,
  decodeLeaseRevoke,
  decodeLeaseSessionBind,
  decodeLoginHold,
  decodeLoginWriter,
  decodeProfileRemove,
  decodeProfileSync,
  decodeProfileUpsert,
  decodeWorkerReconcile,
  encodeControlDone,
  encodeCredentialStatus,
  encodeHoldReleased,
  encodeHoldStatus,
  encodeLeaseGranted,
  encodeLeaseRevoked,
  encodeLeasesRevoked,
  encodeLoginHold,
  type ControlHello,
  type CredentialStatus,
} from "./controlMethods.ts";
import type { CompatUpstream } from "./compatUpstream.ts";
import type { HoldStatus, HoldUpdate } from "./holds.ts";
import type { LeaseBinding, LeaseTable } from "./leases.ts";
import { isLoginProfile, type ProfileRegistry } from "./profiles.ts";
import { StateWriteError } from "./state.ts";
import type { VaultPort } from "./vaultPort.ts";

interface ControlContext {
  leases: LeaseTable;
  profiles: ProfileRegistry;
  compat: CompatUpstream;
  log: (line: string) => void;
  /** The holds, the writer lane and the profiles that need a login now. */
  vault: Pick<VaultPort, "needsLogin" | "holds">;
}

/** What a method's log line names besides the method, and its outcome. */
interface Subject {
  profileId?: string;
  leaseId?: string;
  holdId?: string;
  /** What an answer that is not a failure says; "ok" when unset. */
  outcome?: string;
}

/** A connection's hello, once it said one. */
interface ConnectionState {
  bootId: string | undefined;
  hello: ControlHello | undefined;
}

/**
 * A control method body; it runs synchronously with the connection's hello.
 * Only `profiles.loginHold` answers a promise, once the lane gives its turn.
 */
type ControlMethod = (
  payload: Payload,
  connection: ConnectionState,
  subject: Subject,
  signal: AbortSignal,
) => Payload | Promise<Payload>;

function fail(code: string, message: string): never {
  throw new WorkerMethodError(code, message);
}

export interface ControlEndpoint {
  /** Serves gateway control on `endpoint`, the listener side. */
  attach(endpoint: ByteEndpoint): void;
  /** The last hello a connection said, as recorded. */
  hello(): ControlHello | undefined;
  /** Rechecks every hold whose owner is not the current connection's boot. */
  checkHolds(): void;
  /** Sends a profile's needs-login change to the current connection. */
  reportCredential(status: CredentialStatus): void;
  /** Ends every attached connection. */
  close(): void;
}

export function createControlEndpoint({
  leases,
  profiles,
  compat,
  log,
  vault,
}: ControlContext): ControlEndpoint {
  const { holds } = vault;
  const connections = new Set<WorkerConnection>();
  /** The connection whose hello came last; an older one is ended. */
  let current: WorkerConnection | undefined;
  let lastHello: ControlHello | undefined;
  /**
   * Statuses waiting for the answer that caused them to go out, each to the
   * connection that was current then: a newer hello resends what is stuck.
   */
  let unsent: {
    method: string;
    payload: Payload;
    subject: Subject;
    to: WorkerConnection | undefined;
  }[] = [];

  const sendStatuses = (): void => {
    const statuses = unsent;
    unsent = [];
    for (const { method, payload, subject, to } of statuses) {
      if (!to) {
        logOutcome(method, subject, "not connected");
        continue;
      }
      to.request(method, payload).then(
        () => logOutcome(method, subject, "ok"),
        (err: unknown) =>
          logOutcome(
            method,
            subject,
            err instanceof WorkerRequestError ? err.code : "failed",
          ),
      );
    }
  };

  const enqueue = (
    method: string,
    payload: Payload,
    subject: Subject,
  ): void => {
    if (unsent.length === 0) setImmediate(sendStatuses);
    unsent.push({ method, payload, subject, to: current });
  };

  /** Sends `statuses` to the current connection after this turn's answers. */
  const report = (statuses: HoldStatus[]): void => {
    for (const status of statuses)
      enqueue(CONTROL_METHODS.status, encodeHoldStatus(status), {
        profileId: status.profileId,
        holdId: status.holdId,
      });
  };

  const reportCredential = (status: CredentialStatus): void =>
    enqueue(CONTROL_METHODS.credential, encodeCredentialStatus(status), {
      profileId: status.profileId,
    });

  /** Reports a memory-first hold change; a failed save is only logged. */
  const settle = (update: HoldUpdate, context: string): void => {
    report(update.statuses);
    if (update.saveError !== undefined)
      log(`${context}: holds.json not saved; the change stands in memory`);
  };

  /** A hold method's log subject: the hold, and its profile when known. */
  const holdSubject = (holdId: string): Subject => {
    const profileId = holds.get(holdId)?.profileId;
    return profileId !== undefined ? { profileId, holdId } : { holdId };
  };

  /** After a registry change: an unreadable `holds.json` fences what it names. */
  const fenceRegistry = (): void => {
    if (holds.fencing) settle(holds.fence(profiles.loginIds()), "hold fence");
  };

  /** Revokes every live lease of a profile `kept` does not hold. */
  const revokeRemoved = (kept: (profileId: string) => boolean): string[] =>
    leases.revokeWhere((record) => !kept(record.profileId), "profile-removed");

  /**
   * Applies a registry change, then drops the removed profiles' pushed pairs
   * and revokes their leases. All take effect in memory even when a save
   * fails; the failure answers `state_write_failed`. The pairs go first: that
   * cannot throw, so neither save's failure can leave one behind.
   */
  const changeProfiles = (
    change: () => void,
    kept: (profileId: string) => boolean,
  ): Payload => {
    let failed: StateWriteError | undefined;
    try {
      change();
    } catch (err) {
      if (!(err instanceof StateWriteError)) throw err;
      failed = err;
    }
    compat.retain(kept);
    const revoked = revokeRemoved(kept);
    if (failed !== undefined) throw failed;
    return encodeLeasesRevoked(revoked);
  };

  const methods: Record<string, ControlMethod> = {
    [CONTROL_METHODS.syncProfiles]: (payload) => {
      const next = decodeProfileSync(payload);
      const ids = new Set(next.map((profile) => profile.id));
      try {
        return changeProfiles(
          () => profiles.sync(next),
          (id) => ids.has(id),
        );
      } finally {
        fenceRegistry();
      }
    },
    [CONTROL_METHODS.upsertProfile]: (payload, _connection, subject) => {
      const profile = decodeProfileUpsert(payload);
      subject.profileId = profile.id;
      // Metadata only, `enabled` included: nothing is revoked (RD-G2-1).
      try {
        profiles.upsert(profile);
      } finally {
        fenceRegistry();
      }
      return encodeLeasesRevoked([]);
    },
    [CONTROL_METHODS.removeProfile]: (payload, _connection, subject) => {
      const profileId = decodeProfileRemove(payload);
      subject.profileId = profileId;
      return changeProfiles(
        () => profiles.remove(profileId),
        (id) => id !== profileId,
      );
    },
    [CONTROL_METHODS.grant]: (payload, connection, subject) => {
      const grant = decodeLeaseGrant(payload);
      subject.profileId = grant.profileId;
      const profile = profiles.get(grant.profileId);
      if (!profile)
        fail(UNKNOWN_PROFILE, "The gateway does not know this profile.");
      const binding: LeaseBinding = isLoginProfile(profile)
        ? {
            profileId: profile.id,
            provider: profile.provider,
            tokenFile: profile.tokenFile,
          }
        : { profileId: profile.id, provider: profile.provider };
      const granted =
        grant.kind === "server"
          ? leases.grant(binding, {
              kind: "server",
              owner: { serverBootId: connection.bootId! },
            })
          : leases.grant(binding, {
              kind: "engine",
              owner: {
                workerId: grant.workerId,
                ...(grant.sessionId !== undefined
                  ? { sessionId: grant.sessionId }
                  : {}),
              },
            });
      subject.leaseId = granted.leaseId;
      return encodeLeaseGranted(granted);
    },
    [CONTROL_METHODS.bindSession]: (payload, _connection, subject) => {
      const { leaseId, sessionId } = decodeLeaseSessionBind(payload);
      subject.leaseId = leaseId;
      const outcome = leases.bindSession(leaseId, sessionId);
      if (outcome === "unknown")
        fail(UNKNOWN_LEASE, "The gateway holds no live lease by this id.");
      if (outcome === "server")
        fail(INVALID_PARAMS, "A server lease has no session.");
      if (outcome === "conflict")
        fail(OWNER_CONFLICT, "The lease is bound to another session.");
      return encodeControlDone();
    },
    [CONTROL_METHODS.revoke]: (payload, _connection, subject) => {
      const { leaseId, reason } = decodeLeaseRevoke(payload);
      subject.leaseId = leaseId;
      return encodeLeaseRevoked(leases.revoke(leaseId, reason));
    },
    [CONTROL_METHODS.reconcileWorker]: (payload) => {
      const { workerId, live } = decodeWorkerReconcile(payload);
      const keep = new Set(live);
      return encodeLeasesRevoked(
        leases.revokeWhere(
          (record) =>
            record.kind === "engine" &&
            record.owner.workerId === workerId &&
            !keep.has(record.leaseId),
          "session-ended",
        ),
      );
    },
    [CONTROL_METHODS.loginHold]: (payload, connection, subject, signal) => {
      const { profileId, holdId } = decodeLoginHold(payload);
      subject.profileId = profileId;
      subject.holdId = holdId;
      // An OpenAI-compatible profile has no login to hold, fence or not.
      const registered = profiles.get(profileId);
      if (registered && !isLoginProfile(registered))
        fail(UNKNOWN_PROFILE, "The gateway does not know this profile.");
      // A pending fence covers every profile, known or not (`holds.ts`).
      if (!registered && !holds.fencing)
        fail(UNKNOWN_PROFILE, "The gateway does not know this profile.");
      const { serverBootId, pid, startTime } = connection.hello!;
      return holds
        .acquire(profileId, holdId, { serverBootId, pid, startTime }, signal)
        .then((acquired) => {
          if (!acquired)
            fail(UNKNOWN_PROFILE, "The gateway does not know this profile.");
          if (!acquired.held) subject.outcome = acquired.refusal;
          return encodeLoginHold(acquired);
        });
    },
    [CONTROL_METHODS.loginWriter]: (payload, connection, subject) => {
      const { holdId, pid, startTime } = decodeLoginWriter(payload);
      Object.assign(subject, holdSubject(holdId));
      const outcome = holds.registerWriter(holdId, connection.bootId!, {
        pid,
        startTime,
      });
      if (outcome === "unknown")
        fail(UNKNOWN_HOLD, "The gateway holds no login hold by this id.");
      if (outcome === "not_owner")
        fail(NOT_HOLD_OWNER, "The login hold belongs to another server boot.");
      if (outcome === "not_claude")
        fail(INVALID_PARAMS, "Only a Claude login hold has a writer.");
      if (outcome === "conflict")
        fail(WRITER_CONFLICT, "The login hold names another writer.");
      return encodeControlDone();
    },
    [CONTROL_METHODS.loginRelease]: (payload, connection, subject) => {
      const holdId = decodeHoldId(payload);
      Object.assign(subject, holdSubject(holdId));
      const outcome = holds.release(holdId, connection.bootId!);
      if (!outcome.released) {
        if (outcome.reason === "not_owner")
          fail(
            NOT_HOLD_OWNER,
            "The login hold belongs to another server boot.",
          );
        subject.outcome = "unknown";
        return encodeHoldReleased(false);
      }
      report(outcome.statuses);
      if (outcome.saveError !== undefined) throw outcome.saveError;
      return encodeHoldReleased(true);
    },
    [CONTROL_METHODS.loginForceRelease]: (payload, _connection, subject) => {
      const holdId = decodeHoldId(payload);
      Object.assign(subject, holdSubject(holdId));
      // The operator's assertion that no login runs: from any boot.
      const update = holds.forceRelease(holdId);
      if (!update)
        fail(UNKNOWN_HOLD, "The gateway holds no login hold by this id.");
      report(update.statuses);
      if (update.saveError !== undefined) throw update.saveError;
      return encodeHoldReleased(true);
    },
    // The subject names the profile only: no log line names the URL or key.
    [CONTROL_METHODS.compatSet]: (payload, _connection, subject) => {
      const profileId = decodeCompatProfile(payload);
      subject.profileId = profileId;
      const profile = profiles.get(profileId);
      if (!profile)
        fail(UNKNOWN_PROFILE, "The gateway does not know this profile.");
      if (isLoginProfile(profile))
        fail(INVALID_PARAMS, "Only an OpenAI-compatible profile has a pair.");
      let pushed;
      try {
        pushed = decodeCompatPair(payload);
      } catch (err) {
        // Its held pair is no longer the server's: 503 until a push.
        compat.clear(profileId);
        throw err;
      }
      compat.set(profileId, pushed.baseUrl, pushed.apiKey);
      return encodeControlDone();
    },
    [CONTROL_METHODS.compatClear]: (payload, _connection, subject) => {
      const profileId = decodeCompatProfile(payload);
      subject.profileId = profileId;
      compat.clear(profileId);
      return encodeControlDone();
    },
  };

  const attach = (endpoint: ByteEndpoint): void => {
    const state: ConnectionState = { bootId: undefined, hello: undefined };
    const handlers: Record<string, MethodHandler> = {};
    // Not async: the body runs in the handler's own synchronous span.
    const run =
      (method: string, body: ControlMethod): MethodHandler =>
      (payload, signal) => {
        const subject: Subject = {};
        const answered = (answer: Payload): Payload => {
          logOutcome(method, subject, subject.outcome ?? "ok");
          return answer;
        };
        const failed = (err: unknown): Promise<never> => {
          const failure =
            err instanceof StateWriteError
              ? new WorkerMethodError(STATE_WRITE_FAILED, err.message)
              : err;
          logOutcome(
            method,
            subject,
            failure instanceof WorkerMethodError
              ? failure.code
              : signal.aborted
                ? "cancelled"
                : "failed",
          );
          return Promise.reject(failure);
        };
        try {
          const answer = body(payload, state, subject, signal);
          return answer instanceof Promise
            ? answer.then(answered, failed)
            : Promise.resolve(answered(answer));
        } catch (err) {
          return failed(err);
        }
      };
    handlers[CONTROL_METHODS.hello] = run(CONTROL_METHODS.hello, (payload) => {
      const hello = decodeControlHello(payload);
      state.bootId = hello.serverBootId;
      state.hello = hello;
      lastHello = hello;
      compat.clearAll();
      if (current !== connection) {
        current?.end("a newer control connection said hello");
        current = connection;
      }
      // Evidence for every other boot's hold (RD-G2b-1); then this boot hears
      // of every stuck hold.
      const update = holds.check(hello.serverBootId);
      settle(
        {
          ...update,
          statuses: [
            ...update.statuses.filter((status) => !status.loginStuck),
            ...holds.stuck(),
          ],
        },
        "control.hello hold check",
      );
      for (const profileId of vault.needsLogin())
        reportCredential({ profileId, needsLogin: true });
      return encodeLeasesRevoked(
        leases.revokeWhere(
          (record) =>
            record.kind === "server" &&
            record.owner.serverBootId !== hello.serverBootId,
          "session-ended",
        ),
      );
    });
    for (const [method, body] of Object.entries(methods))
      handlers[method] = run(method, (payload, connection, subject, signal) => {
        if (connection.bootId === undefined)
          fail(HELLO_REQUIRED, "Send control.hello first.");
        return body(payload, connection, subject, signal);
      });
    const connection: WorkerConnection = new WorkerConnection(endpoint, {
      protocol: GATEWAY_CONTROL_PROTOCOL,
      handshake: {
        role: "server",
        admit: (hello) =>
          GATEWAY_CONTROL_PROTOCOL.compatible(hello.version)
            ? undefined
            : `this endpoint speaks ${GATEWAY_CONTROL_VERSION} only`,
      },
      handlers,
      onEnd: () => {
        connections.delete(connection);
        if (current === connection) current = undefined;
      },
    });
    connections.add(connection);
  };

  const logOutcome = (
    method: string,
    subject: Subject,
    outcome: string,
  ): void => {
    const names = [
      subject.profileId !== undefined ? `profile ${subject.profileId}` : "",
      subject.leaseId !== undefined ? `lease ${subject.leaseId}` : "",
      subject.holdId !== undefined ? `hold ${subject.holdId}` : "",
    ].filter(Boolean);
    log(
      `control ${method}${names.length ? ` (${names.join(", ")})` : ""}: ${outcome}`,
    );
  };

  return {
    attach,
    hello: () => lastHello,
    reportCredential,
    checkHolds() {
      // `current` said the last hello: a newer one ends the older connection.
      settle(holds.check(current && lastHello?.serverBootId), "hold check");
    },
    close() {
      for (const connection of [...connections])
        connection.end("the gateway closed");
    },
  };
}
