/**
 * Client mode (plan Task-1384 §4, M15): the server's {@link GatewayLink} to a
 * remote gateway it reaches through the relay (`relay/relay.ts`). Gateway
 * client 1.0 runs over the relay's Unix socket; engines spend their leases at
 * the relay's loopback port, which adds the client's TLS identity.
 *
 * The gateway owns the accounts: on connect and on every `accounts.changed`
 * the link mirrors them into the credential profile registry
 * (`mirrorRemoteCredentialProfiles`), metadata only, so routing, pins and
 * Automatic work on them unchanged. Nothing is pushed. The first connect
 * reconciles the in-process Worker with no live lease; a lost connection is
 * dialled again every 2 s, without a reconcile, and grants in between fail
 * with U7's text. The server's own requests spend a client lease
 * (`leases.client`), one per account for this boot. Logins are the gateway's
 * (Task-1385): `remoteLogins.ts` drives them through `logins.*`, and the
 * login-hold calls refuse here.
 */
import {
  mirrorRemoteCredentialProfiles,
  type RemoteCredentialProfile,
} from "./credentialProfiles.ts";
import { errorText } from "./errors.ts";
import {
  CLIENT_METHODS,
  GATEWAY_CLIENT_PROTOCOL,
  decodeAccounts,
  decodeClientIdentity,
  decodeLoginEvent,
  decodeLoginStarted,
  encodeClientMessage,
  type ClientAccount,
} from "./gateway/clientMethods.ts";
import {
  decodeLeaseGranted,
  decodeLeaseRevoked,
  decodeLeasesRevoked,
  encodeControlDone,
} from "./gateway/controlMethods.ts";
import {
  GATEWAY_LOGIN_UNAVAILABLE_TEXT,
  GatewayUnavailableError,
  installGatewayLink,
  type GatewayConnectionState,
  type GatewayLink,
} from "./gatewayLink.ts";
import { installRemoteLoginPort, remoteLoginEvent } from "./remoteLogins.ts";
import type { Payload } from "./workerProtocol/codec.ts";
import {
  WorkerConnection,
  WorkerRequestError,
} from "./workerProtocol/connection.ts";
import type { EngineGatewayAccess } from "./workerProtocol/engineMethods.ts";
import { dialUnixSocket } from "./workerProtocol/unixSocketTransport.ts";

const READY_TIMEOUT_MS = 10_000;
/** The in-process Worker's id, as `gatewayLink.ts` names it. */
const IN_PROCESS_WORKER_ID = "local";
const REDIAL_MS = 2_000;

export interface GatewayClientLinkOptions {
  /** The relay's client-protocol socket. */
  socketPath: string;
  /** The relay's loopback model port. */
  relayPort: number;
  log?: (line: string) => void;
}

function failure(err: unknown): string {
  return err instanceof WorkerRequestError ? err.code : errorText(err);
}

function loginUnavailable(): Error {
  return new Error(GATEWAY_LOGIN_UNAVAILABLE_TEXT);
}

/** Starts the remote link and installs it; it never throws on a dial. */
export function startGatewayClientLink(
  options: GatewayClientLinkOptions,
): GatewayLink {
  const log =
    options.log ??
    ((line: string) => console.log(`[gateway-client-link] ${line}`));
  const baseUrl = `http://127.0.0.1:${options.relayPort}`;
  let connection: WorkerConnection | undefined;
  let closing = false;
  let reconciled = false;
  let redial: ReturnType<typeof setTimeout> | undefined;
  const needsLogin = new Map<string, boolean>();
  const serverLeases = new Map<string, Promise<EngineGatewayAccess>>();
  const stateListeners = new Set<(state: GatewayConnectionState) => void>();
  /** Connected or connecting only: client mode reports no unreachable yet. */
  const stateNow = (): GatewayConnectionState =>
    connection ? "connected" : "connecting";
  const stateChanged = (): void => {
    const state = stateNow();
    for (const listener of [...stateListeners]) listener(state);
  };
  let resolveReady!: (ok: boolean) => void;
  const ready = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });

  // Client mode from the start: no local account shows before the mirror.
  mirrorRemoteCredentialProfiles([]);

  const mirror = (accounts: ClientAccount[]): void => {
    needsLogin.clear();
    for (const account of accounts)
      needsLogin.set(account.id, account.needsLogin);
    for (const id of serverLeases.keys())
      if (!needsLogin.has(id)) serverLeases.delete(id);
    mirrorRemoteCredentialProfiles(
      accounts.map((account): RemoteCredentialProfile => ({ ...account })),
    );
  };

  const dial = async (): Promise<WorkerConnection> => {
    const endpoint = await dialUnixSocket(options.socketPath);
    const opened: WorkerConnection = new WorkerConnection(endpoint, {
      handshake: { role: "worker", workerId: "pandeck-server" },
      protocol: GATEWAY_CLIENT_PROTOCOL,
      handlers: {
        [CLIENT_METHODS.accountsChanged]: (payload) => {
          mirror(decodeAccounts(payload));
          return Promise.resolve(encodeControlDone());
        },
        [CLIENT_METHODS.loginEvent]: (payload) => {
          const decoded = decodeLoginEvent(payload);
          if (decoded) remoteLoginEvent(decoded.loginId, decoded.event);
          return Promise.resolve(encodeControlDone());
        },
      },
      onEnd: (reason) => {
        if (connection === opened) {
          connection = undefined;
          stateChanged();
        }
        if (closing) return;
        log(`connection ended: ${reason}`);
        schedule();
      },
    });
    return opened;
  };

  const connect = async (): Promise<void> => {
    redial = undefined;
    try {
      const opened = await dial();
      const { clientId, userId } = decodeClientIdentity(
        await opened.request(CLIENT_METHODS.hello, encodeClientMessage({})),
      );
      mirror(
        decodeAccounts(
          await opened.request(
            CLIENT_METHODS.listAccounts,
            encodeClientMessage({}),
          ),
        ),
      );
      if (!reconciled) {
        // This boot holds no lease yet: an earlier boot's engines died with it.
        const { revoked } = decodeLeasesRevoked(
          await opened.request(
            CLIENT_METHODS.reconcileWorker,
            encodeClientMessage({ workerId: IN_PROCESS_WORKER_ID, live: [] }),
          ),
        );
        reconciled = true;
        log(`revoked ${revoked.length} engine leases of earlier boots`);
      }
      if (closing) {
        opened.end("the server link closed");
        return;
      }
      connection = opened;
      stateChanged();
      log(`ready as client ${clientId} of user ${userId}`);
      resolveReady(true);
    } catch (err) {
      log(`unavailable: ${failure(err)}`);
      schedule();
    }
  };

  const schedule = (): void => {
    if (closing || redial) return;
    redial = setTimeout(() => void connect(), REDIAL_MS);
    redial.unref();
  };

  const readyWithin = (ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      void ready.then((ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
    });

  const request = async (
    method: string,
    payload: Payload,
  ): Promise<Payload> => {
    if (!connection) throw new Error("the relay is not connected");
    return connection.request(method, payload);
  };

  const grantClientLease = async (
    accountId: string,
  ): Promise<EngineGatewayAccess> => {
    if (!(await readyWithin(READY_TIMEOUT_MS)))
      throw new GatewayUnavailableError();
    try {
      const granted = decodeLeaseGranted(
        await request(
          CLIENT_METHODS.clientLease,
          encodeClientMessage({ accountId }),
        ),
      );
      return { baseUrl, leaseToken: granted.token };
    } catch (err) {
      log(
        `${CLIENT_METHODS.clientLease} (account ${accountId}): ${failure(err)}`,
      );
      throw new GatewayUnavailableError();
    }
  };

  const uninstallLogins = installRemoteLoginPort({
    async start(start) {
      if (!(await readyWithin(READY_TIMEOUT_MS)))
        throw new Error(GATEWAY_LOGIN_UNAVAILABLE_TEXT);
      const started = decodeLoginStarted(
        await request(CLIENT_METHODS.loginStart, encodeClientMessage(start)),
      );
      // A new account is in the mirror before its login is answered.
      if (!needsLogin.has(started.accountId))
        mirror(
          decodeAccounts(
            await request(CLIENT_METHODS.listAccounts, encodeClientMessage({})),
          ),
        );
      log(`logins.start (account ${started.accountId}): ok`);
      return started;
    },
    async input(loginId, text) {
      await request(
        CLIENT_METHODS.loginInput,
        encodeClientMessage({ loginId, text }),
      );
    },
    async remove(accountId) {
      await request(
        CLIENT_METHODS.removeAccount,
        encodeClientMessage({ accountId }),
      );
      // The mirror drops it now, not only at the next `accounts.changed`.
      mirror(
        decodeAccounts(
          await request(CLIENT_METHODS.listAccounts, encodeClientMessage({})),
        ),
      );
    },
    async cancel(loginId) {
      await request(
        CLIENT_METHODS.loginCancel,
        encodeClientMessage({ loginId }),
      );
    },
  });
  let uninstall: () => void = () => {};
  const link: GatewayLink = {
    ready,
    connectionState: stateNow,
    onConnectionState(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    gateway: undefined,
    baseUrl,
    async grantEngineLease({ workerId, sessionId, profileId }) {
      if (!(await readyWithin(READY_TIMEOUT_MS))) {
        log(`${CLIENT_METHODS.grant} (account ${profileId}): not ready`);
        throw new GatewayUnavailableError();
      }
      try {
        return decodeLeaseGranted(
          await request(
            CLIENT_METHODS.grant,
            encodeClientMessage({
              accountId: profileId,
              workerId: workerId ?? IN_PROCESS_WORKER_ID,
              ...(sessionId !== undefined ? { sessionId } : {}),
            }),
          ),
        );
      } catch (err) {
        log(`${CLIENT_METHODS.grant} (account ${profileId}): ${failure(err)}`);
        throw new GatewayUnavailableError();
      }
    },
    serverAccess(profileId) {
      const known = serverLeases.get(profileId);
      if (known) return known;
      const granting = grantClientLease(profileId);
      serverLeases.set(profileId, granting);
      granting.catch(() => {
        if (serverLeases.get(profileId) === granting)
          serverLeases.delete(profileId);
      });
      return granting;
    },
    async bindLeaseSession(leaseId, sessionId) {
      try {
        await request(
          CLIENT_METHODS.bindSession,
          encodeClientMessage({ leaseId, sessionId }),
        );
      } catch (err) {
        log(
          `${CLIENT_METHODS.bindSession} (lease ${leaseId}): ${failure(err)}`,
        );
      }
    },
    async revokeLease(leaseId, reason) {
      try {
        decodeLeaseRevoked(
          await request(
            CLIENT_METHODS.revoke,
            encodeClientMessage({ leaseId, reason }),
          ),
        );
      } catch (err) {
        log(`${CLIENT_METHODS.revoke} (lease ${leaseId}): ${failure(err)}`);
      }
    },
    // Logins move into the gateway with slice 4 (Task-1385).
    acquireLoginHold: () => Promise.reject(loginUnavailable()),
    registerLoginWriter: () => Promise.reject(loginUnavailable()),
    releaseLoginHold: () => Promise.resolve(),
    forceReleaseLoginHold: () => Promise.resolve(),
    loginStatus: () => undefined,
    onLoginStatus: () => () => {},
    credentialStatus(profileId) {
      const value = needsLogin.get(profileId);
      return value === undefined ? undefined : { needsLogin: value };
    },
    // The remote gateway's needs-login arrives only on its account list, and
    // health keeps the error classifier for these accounts.
    reportsCredentialStatus: false,
    onCredentialStatus: () => () => {},
    needsLoginProfiles: () => [],
    async close() {
      if (closing) return;
      closing = true;
      uninstall();
      uninstallLogins();
      if (redial) clearTimeout(redial);
      connection?.end("the server link closed");
      mirrorRemoteCredentialProfiles(undefined);
    },
  };
  uninstall = installGatewayLink(link);
  void connect();
  return link;
}
