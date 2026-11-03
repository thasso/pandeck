/**
 * The gateway's control endpoint (`docs/workers.md` "Credentials"): the
 * listener side of gateway control 1.0. Only a control connection grants a
 * lease, and a grant binds the lease from the registry, never from the
 * request (C5).
 *
 * Each method runs to completion synchronously, saving included, so methods
 * apply one at a time in arrival order across every connection. A hello on a
 * newer connection ends the older one. Lease tokens appear only in the grant
 * answer; a log line names the method, the profile and lease ids and the
 * outcome, never a token, secret, hash or credential.
 */
import type { Payload } from "../workerProtocol/codec.ts";
import {
  WorkerConnection,
  WorkerMethodError,
  type MethodHandler,
} from "../workerProtocol/connection.ts";
import type { ByteEndpoint } from "../workerProtocol/inProcessTransport.ts";
import {
  CONTROL_METHODS,
  GATEWAY_CONTROL_PROTOCOL,
  GATEWAY_CONTROL_VERSION,
  HELLO_REQUIRED,
  INVALID_PARAMS,
  OWNER_CONFLICT,
  STATE_WRITE_FAILED,
  UNKNOWN_LEASE,
  UNKNOWN_PROFILE,
  decodeControlHello,
  decodeLeaseGrant,
  decodeLeaseRevoke,
  decodeLeaseSessionBind,
  decodeProfileRemove,
  decodeProfileSync,
  decodeProfileUpsert,
  decodeWorkerReconcile,
  encodeControlDone,
  encodeLeaseGranted,
  encodeLeaseRevoked,
  encodeLeasesRevoked,
  type ControlHello,
} from "./controlMethods.ts";
import type { LeaseTable } from "./leases.ts";
import type { ProfileRegistry } from "./profiles.ts";
import { StateWriteError } from "./state.ts";

interface ControlContext {
  leases: LeaseTable;
  profiles: ProfileRegistry;
  log: (line: string) => void;
}

/** What a method's log line names besides the method and outcome. */
interface Subject {
  profileId?: string;
  leaseId?: string;
}

/** A control method body; it runs synchronously with the connection's boot id. */
type ControlMethod = (
  payload: Payload,
  connection: { bootId: string | undefined },
  subject: Subject,
) => Payload;

function fail(code: string, message: string): never {
  throw new WorkerMethodError(code, message);
}

export interface ControlEndpoint {
  /** Serves gateway control on `endpoint`, the listener side. */
  attach(endpoint: ByteEndpoint): void;
  /** The last hello a connection said, as recorded. */
  hello(): ControlHello | undefined;
  /** Ends every attached connection. */
  close(): void;
}

export function createControlEndpoint({
  leases,
  profiles,
  log,
}: ControlContext): ControlEndpoint {
  const connections = new Set<WorkerConnection>();
  /** The connection whose hello came last; an older one is ended. */
  let current: WorkerConnection | undefined;
  let lastHello: ControlHello | undefined;

  /** Revokes every live lease of a profile `kept` does not hold. */
  const revokeRemoved = (kept: (profileId: string) => boolean): string[] =>
    leases.revokeWhere((record) => !kept(record.profileId), "profile-removed");

  /**
   * Applies a registry change, then revokes for it. Both take effect in memory
   * even when a save fails; the failure answers `state_write_failed`.
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
    const revoked = revokeRemoved(kept);
    if (failed !== undefined) throw failed;
    return encodeLeasesRevoked(revoked);
  };

  const methods: Record<string, ControlMethod> = {
    [CONTROL_METHODS.syncProfiles]: (payload) => {
      const next = decodeProfileSync(payload);
      const ids = new Set(next.map((profile) => profile.id));
      return changeProfiles(
        () => profiles.sync(next),
        (id) => ids.has(id),
      );
    },
    [CONTROL_METHODS.upsertProfile]: (payload, _connection, subject) => {
      const profile = decodeProfileUpsert(payload);
      subject.profileId = profile.id;
      // Metadata only, `enabled` included: nothing is revoked (RD-G2-1).
      profiles.upsert(profile);
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
      const binding = {
        profileId: profile.id,
        provider: profile.provider,
        tokenFile: profile.tokenFile,
      };
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
  };

  const attach = (endpoint: ByteEndpoint): void => {
    const state: { bootId: string | undefined } = { bootId: undefined };
    const handlers: Record<string, MethodHandler> = {};
    // Not async: the body runs in the handler's own synchronous span.
    const run =
      (method: string, body: ControlMethod): MethodHandler =>
      (payload) => {
        const subject: Subject = {};
        try {
          const answer = body(payload, state, subject);
          logOutcome(method, subject, "ok");
          return Promise.resolve(answer);
        } catch (err) {
          const failure =
            err instanceof StateWriteError
              ? new WorkerMethodError(STATE_WRITE_FAILED, err.message)
              : err;
          logOutcome(
            method,
            subject,
            failure instanceof WorkerMethodError ? failure.code : "failed",
          );
          return Promise.reject(failure);
        }
      };
    handlers[CONTROL_METHODS.hello] = run(CONTROL_METHODS.hello, (payload) => {
      const hello = decodeControlHello(payload);
      state.bootId = hello.serverBootId;
      lastHello = hello;
      if (current !== connection) {
        current?.end("a newer control connection said hello");
        current = connection;
      }
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
      handlers[method] = run(method, (payload, connection, subject) => {
        if (connection.bootId === undefined)
          fail(HELLO_REQUIRED, "Send control.hello first.");
        return body(payload, connection, subject);
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
    ].filter(Boolean);
    log(
      `control ${method}${names.length ? ` (${names.join(", ")})` : ""}: ${outcome}`,
    );
  };

  return {
    attach,
    hello: () => lastHello,
    close() {
      for (const connection of [...connections])
        connection.end("the gateway closed");
    },
  };
}
