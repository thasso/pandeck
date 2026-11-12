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
 * login-hold calls refuse here. A lost connection marks the running logins
 * interrupted, and every connect has them reconciled with the gateway. The user's Atlassian credential is the
 * gateway's too (Task-1397): `remoteIntegrations.ts` sets, clears and reads
 * its status through `integrations.*`; after every connect the link reads
 * the status and announces the Jira section, so Settings shows it. The
 * gateway's tools (Task-1398) are listed on every connect before the
 * connection is published (`remoteTools.ts`), and the agents' calls go out
 * as `tools.call`, each bounded at 40 s.
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
  decodeIntegrationStatus,
  decodeLoginEvent,
  decodeLoginStarted,
  decodeToolAnswer,
  decodeToolListing,
  encodeClientMessage,
  UNKNOWN_LOGIN,
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
import {
  IntegrationRefusal,
  installRemoteIntegrationPort,
  isIntegrationRefusalCode,
  rememberAtlassianStatus,
} from "./remoteIntegrations.ts";
import {
  installRemoteLoginPort,
  remoteLoginEvent,
  remoteLoginsDisconnected,
  remoteLoginsReconnected,
} from "./remoteLogins.ts";
import {
  RemoteToolRefusal,
  acceptRemoteTools,
  applyListing,
  installRemoteToolPort,
  markDisconnected,
  type RemoteToolAnswer,
  type RemoteToolDescriptor,
} from "./remoteTools.ts";
import type { Payload } from "./workerProtocol/codec.ts";
import {
  UNKNOWN_METHOD,
  WorkerConnection,
  WorkerRequestError,
  WorkerRequestNotSentError,
} from "./workerProtocol/connection.ts";
import type { EngineGatewayAccess } from "./workerProtocol/engineMethods.ts";
import { dialUnixSocket } from "./workerProtocol/unixSocketTransport.ts";

const READY_TIMEOUT_MS = 10_000;
/** The in-process Worker's id, as `gatewayLink.ts` names it. */
const IN_PROCESS_WORKER_ID = "local";
const REDIAL_MS = 2_000;
/** Bounds an agent's gateway tool call beyond the edge's own 30 s. */
const TOOL_CALL_MS = 40_000;

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
          markDisconnected();
          // Login events sent meanwhile are lost (the gateway keeps none).
          remoteLoginsDisconnected();
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
    let opened: WorkerConnection | undefined;
    try {
      opened = await dial();
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
      const tools = await listTools(opened);
      // A dial that ended meanwhile has scheduled its redial; it publishes
      // nothing, nor does a closing link.
      if (closing || opened.isEnded) {
        opened.end("the server link closed");
        return;
      }
      applyListing(tools);
      connection = opened;
      stateChanged();
      log(`ready as client ${clientId} of user ${userId}`);
      remoteLoginsReconnected();
      resolveReady(true);
      void readIntegrationStatus(opened);
    } catch (err) {
      log(`unavailable: ${failure(err)}`);
      // An unpublished dial goes with its failed connect; the redial replaces it.
      if (opened && connection !== opened) opened.end("the connect failed");
      schedule();
    }
  };

  /** The gateway's tools; a gateway without tools lists none. */
  const listTools = async (
    opened: WorkerConnection,
  ): Promise<RemoteToolDescriptor[]> => {
    try {
      return acceptRemoteTools(
        decodeToolListing(
          await opened.request(
            CLIENT_METHODS.toolsList,
            encodeClientMessage({}),
          ),
        ),
      );
    } catch (err) {
      if (
        err instanceof WorkerRequestError &&
        (err.code === "tools_unavailable" || err.code === UNKNOWN_METHOD)
      )
        return [];
      throw err;
    }
  };

  /** The stored credential's status, so a restarted server shows it. */
  const readIntegrationStatus = async (
    opened: WorkerConnection,
  ): Promise<void> => {
    try {
      rememberAtlassianStatus(
        decodeIntegrationStatus(
          await opened.request(
            CLIENT_METHODS.integrationStatus,
            encodeClientMessage({ integration: "atlassian", check: false }),
          ),
        ),
      );
    } catch (err) {
      log(`${CLIENT_METHODS.integrationStatus}: ${failure(err)}`);
      return;
    }
    try {
      const { announceSettingsWritten } = await import("./settingsService.ts");
      await announceSettingsWritten(["jira"]);
    } catch (err) {
      log(`announcing the Jira status failed: ${errorText(err)}`);
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
      try {
        await request(
          CLIENT_METHODS.loginCancel,
          encodeClientMessage({ loginId }),
        );
        return "cancelled";
      } catch (err) {
        if (err instanceof WorkerRequestError && err.code === UNKNOWN_LOGIN)
          return "unknown";
        throw err;
      }
    },
  });
  const integrationRequest = async (
    method: string,
    json: object,
  ): Promise<Payload> => {
    if (!(await readyWithin(READY_TIMEOUT_MS)))
      throw new IntegrationRefusal("gateway_unavailable");
    try {
      return await request(
        method,
        encodeClientMessage({ integration: "atlassian", ...json }),
      );
    } catch (err) {
      log(`${method}: ${failure(err)}`);
      throw new IntegrationRefusal(
        err instanceof WorkerRequestError && isIntegrationRefusalCode(err.code)
          ? err.code
          : "gateway_unavailable",
      );
    }
  };
  const uninstallIntegrations = installRemoteIntegrationPort({
    async set(input) {
      return decodeIntegrationStatus(
        await integrationRequest(CLIENT_METHODS.integrationSet, input),
      );
    },
    async clear() {
      await integrationRequest(CLIENT_METHODS.integrationClear, {});
    },
    async status(check) {
      return decodeIntegrationStatus(
        await integrationRequest(CLIENT_METHODS.integrationStatus, { check }),
      );
    },
  });
  const uninstallTools = installRemoteToolPort({
    async call(name, args, signal) {
      const opened = connection;
      if (!opened) throw new RemoteToolRefusal("gateway_unavailable");
      // One controller for the caller's abort and the local bound: either
      // settles the call now and sends a cancel; the edge's late answer
      // retires the request and is dropped unread.
      const controller = new AbortController();
      let timedOut = false;
      let stop = (): void => {};
      const stopped = new Promise<RemoteToolAnswer>((resolve) => {
        stop = () =>
          resolve({
            ok: false,
            code: timedOut ? "timeout" : "cancelled",
            message: "",
          });
        controller.signal.addEventListener("abort", stop, { once: true });
      });
      const cancel = (): void => controller.abort();
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, TOOL_CALL_MS);
      try {
        return await Promise.race([
          opened
            .request(
              CLIENT_METHODS.toolsCall,
              encodeClientMessage({ name, args }),
              controller.signal,
            )
            .then(decodeToolAnswer),
          stopped,
        ]);
      } catch (err) {
        if (err instanceof WorkerRequestNotSentError)
          return { ok: false, code: "cancelled", message: "" };
        log(`${CLIENT_METHODS.toolsCall}: ${failure(err)}`);
        throw new RemoteToolRefusal(
          err instanceof WorkerRequestError && err.code === "tools_unavailable"
            ? "tools_unavailable"
            : "gateway_unavailable",
        );
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        controller.signal.removeEventListener("abort", stop);
      }
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
      uninstallIntegrations();
      uninstallTools();
      if (redial) clearTimeout(redial);
      connection?.end("the server link closed");
      mirrorRemoteCredentialProfiles(undefined);
    },
  };
  uninstall = installGatewayLink(link);
  void connect();
  return link;
}
