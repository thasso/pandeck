/**
 * The edge's listeners for enrolled clients (plan Task-1384 §1-2, M13):
 *
 * - the enrollment port, HTTPS with the edge's server certificate and no
 *   client certificate: `POST /enroll {code, publicKeyPem}` uses up a
 *   one-time code and answers `{clientId, certificatePem, caPem, modelPort,
 *   clientPort}`; an optional `mcpTokenHash` becomes the client's MCP token.
 *   With `approvalOrigin` (Task-1410), `POST /enroll/start` opens a request
 *   for the page to approve and `POST /enroll/poll {requestId}` collects it,
 *   answering the same fields (`enrollmentApproval.ts`). With
 *   `devboxApproval` (Task-1410 PR2), a start carrying a devbox's proof of
 *   its owner is approved without a click when the proof holds
 *   (`devboxProof.ts`, `ClientRegistry.approveAutomatically`);
 * - the model port, HTTP over mutual TLS, the same routes as the loopback
 *   listener through a forwarder that spends only the calling client's
 *   leases, and serves its requests without a lease token from its user's
 *   machine pool (Task-1424, `machinePool.ts`), whose pins a client
 *   revocation drops;
 * - the client port, TLS with mutual TLS, serving gateway client 1.0
 *   (`clientMethods.ts`).
 *
 * The model port is a TLS server that hands each admitted socket to an
 * unlistened HTTP parser, not an `https.Server`: Bun 1.4.2 verifies client
 * certificates on an `https.Server` but its sockets have no
 * `getPeerCertificate()`, so the client could not be named (Task-1401). Its
 * request deadlines are ours (`modelConnection`), the same on both runtimes:
 * Node enforces an HTTP server's header and request timeouts only once that
 * server listens, and Bun's parser enforces none on a handed-in socket.
 *
 * With tools (Task-1397, `edgeTools.ts`), `/mcp` on the model port is the
 * edge's MCP endpoint and never reaches the forwarder. It needs the client's
 * certificate, no `Origin` header, and that client's MCP token, kept only as
 * its hash (`clientRegistry.ts`); each tool call reads the user's credential
 * from the vault and keeps nothing. Gateway client 1.0's `tools.list` and
 * `tools.call` (Task-1398) run the same host, with the same per-call vault
 * read for the client's user from the registry.
 *
 * The gateway's CA is the only trust root on both mutual-TLS ports. The
 * client is the common name of its certificate, matched by fingerprint, and
 * is checked on every connection and again on every request and method, so a
 * revocation takes effect at once. The CA and the edge's server certificate
 * live in `edge-tls.json`, the clients in `clients.json` (`clientRegistry.ts`),
 * both under the state directory.
 */
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type net from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import type { Payload } from "../workerProtocol/codec.ts";
import {
  WorkerConnection,
  WorkerMethodError,
  type MethodHandler,
} from "../workerProtocol/connection.ts";
import { createPrivateJsonFile } from "../privateJsonFile.ts";
import {
  CLIENT_METHODS,
  CLIENT_REVOKED,
  GATEWAY_CLIENT_PROTOCOL,
  GATEWAY_CLIENT_VERSION,
  UNKNOWN_ACCOUNT,
  decodeAccountId,
  decodeClientGrant,
  decodeIntegration,
  decodeIntegrationSet,
  decodeIntegrationStatusRequest,
  decodeToolCall,
  integrationFailure,
  isIntegrationFailure,
  decodeLoginId,
  decodeLoginInput,
  decodeLoginStart,
  encodeClientMessage,
  type ClientAccount,
} from "./clientMethods.ts";
import {
  ClientRegistry,
  ClientRegistryLockedError,
  ENROLLMENT_REQUEST_TTL_MS,
  isHash,
  mcpTokenMatches,
  newClientId,
  type GatewayClient,
} from "./clientRegistry.ts";
import type { DevboxApproval } from "./devboxProof.ts";
import type { CredentialOutcome, EdgeTools } from "./edgeTools.ts";
import type {
  AdmittedClient,
  ConnectRefusal,
  LocalAnswer,
  MachineAccess,
} from "./forward.ts";
import { createRelayDedup, RELAY_RID } from "./relayDedup.ts";
import {
  createRelayObservations,
  type ObservationsCommitted,
} from "./relayObservations.ts";
import type { RequestLog } from "./requestLog.ts";
import { MachinePool, type MachinePinRecord } from "./machinePool.ts";
import { LoginRefusal, type LoginActor } from "./logins.ts";
import {
  createUserOperations,
  PAGE_ENROLLMENT_LIMITS,
  UserOperationRefusal,
  type UserAccountRecord,
  type UserOperations,
} from "./userOperations.ts";
import type { VaultPort } from "./vaultPort.ts";
import {
  INVALID_PARAMS,
  OWNER_CONFLICT,
  STATE_WRITE_FAILED,
  UNKNOWN_LEASE,
  decodeLeaseRevoke,
  decodeLeaseSessionBind,
  decodeWorkerReconcile,
  encodeControlDone,
  encodeLeaseGranted,
  encodeLeaseRevoked,
  encodeLeasesRevoked,
} from "./controlMethods.ts";
import type { LeaseTable } from "./leases.ts";
import {
  isLoginProfile,
  type LoginProfile,
  type ProfileRegistry,
} from "./profiles.ts";
import { refusalResponse } from "./refusals.ts";
import { socketEndpoint } from "../workerProtocol/unixSocketTransport.ts";
import { StateWriteError } from "./state.ts";
import {
  POLL_ADVICE_SECONDS,
  PollLimiter,
  decodePoll,
  decodeStart,
  registryRefused,
  type AutomaticRefused,
} from "./enrollmentApproval.ts";
import {
  clientPublicKey,
  edgeTlsFor,
  issueClientCertificate,
  type EdgeTls,
} from "./x509.ts";

const MAX_ENROLL_BYTES = 16 * 1024;
const MAX_CONNECTIONS = 64;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const ENROLL_WINDOW_MS = 60_000;
const ENROLL_ATTEMPTS = 30;
const MAX_ENROLL_SOURCES = 4_096;
/** How long `integrations.set` and a checked status wait for Atlassian. */
const INTEGRATION_CHECK_MS = 15_000;

/**
 * The enrollment port's socket idle bounds: `baseMs` always, `proofMs`
 * while a start's devbox proof runs (at most 6 s plus two registry locks of
 * at most 1 s each), restored before the answer.
 */
interface EnrollIdle {
  baseMs: number;
  proofMs: number;
}

const ENROLL_IDLE: EnrollIdle = { baseMs: 10_000, proofMs: 15_000 };

/**
 * The model port's request deadlines, each a separate phase of a
 * connection:
 *
 * - `headersMs`: while the connection awaits a request (after the handshake,
 *   and whenever its last open request's response has ended), the next
 *   request's headers must be complete within this;
 * - `requestMs`: each request's body must be complete within this, counted
 *   from its headers, by its own timer;
 * - `idleMs`: while awaiting a request, the socket may stay silent this long.
 *
 * Nothing bounds a response: a long, quiet model stream is never cut.
 */
export interface ModelDeadlines {
  headersMs: number;
  requestMs: number;
  idleMs: number;
}

/** The values of Node's `https.Server` defaults the port had before. */
const MODEL_DEADLINES: ModelDeadlines = {
  headersMs: 60_000,
  requestMs: 300_000,
  idleMs: 5_000,
};

export interface ClientListenerOptions {
  /** Where the three ports bind; `127.0.0.1` unless given. */
  bindHost?: string;
  /** DNS names and IPs in the edge's server certificate; the first is its CN. */
  hosts?: string[];
  /** 0 (the default) picks a free port. */
  modelPort?: number;
  clientPort?: number;
  enrollPort?: number;
  /**
   * The gateway page's public origin. With it the enrollment port also
   * serves approval enrollment (`/enroll/start`, `/enroll/poll`), whose link
   * points there; without it both are unknown paths.
   */
  approvalOrigin?: string;
  /**
   * The gateway page offers "Sign in with Atlassian" (Task-1411 D2): on page
   * and client alike, a new API token is refused
   * `integration_sign_in_required` (`userOperations.ts`).
   */
  atlassianSignIn?: boolean;
  /**
   * Zero-click enrollment (Task-1410 PR2), only with `approvalOrigin`: a
   * start's devbox proof is checked and, when it holds, the request approved
   * at once. Without it a proof is ignored (`not_configured`).
   */
  devboxApproval?: DevboxApproval;
}

interface ClientListenerDeps {
  stateDir: string;
  requests?: Pick<RequestLog, "record">;
  onObservationsCommitted?:
    ((event: ObservationsCommitted) => void) | undefined;
  relayDedupIntervals?: number | undefined;
  leases: LeaseTable;
  profiles: ProfileRegistry;
  /** The profiles renewal found needing a login. */
  needsLogin: () => string[];
  /**
   * Builds the model forwarder, with `clientOf: peerClientId` and the
   * listener's machine path.
   */
  forwarder: (machine: MachineAccess) => {
    handleRequest: (
      req: http.IncomingMessage,
      res: http.ServerResponse,
      admitted: AdmittedClient,
    ) => void;
    observeLocal: (
      req: http.IncomingMessage,
      res: http.ServerResponse,
      admitted?: AdmittedClient,
    ) => LocalAnswer;
    refuseConnect: (
      req: http.IncomingMessage,
      socket: Duplex,
      head: Buffer,
      admitted: AdmittedClient | undefined,
      refusal: ConnectRefusal,
    ) => void;
  };
  /** The saved machine pins and their writer; without them, memory only. */
  machinePins?:
    | {
        restored: readonly MachinePinRecord[];
        persist: (records: MachinePinRecord[]) => void;
      }
    | undefined;
  log: (line: string) => void;
  now?: () => number;
  /** The vault's side of logins and integration credentials. */
  vault: Pick<
    VaultPort,
    | "login"
    | "newTokenFile"
    | "discardCredential"
    | "integrationPut"
    | "integrationGet"
    | "integrationClear"
    | "integrationConnect"
  >;
  /** The edge's tools; without them `/mcp` is 404 and integrations refuse. */
  tools?: EdgeTools | undefined;
  /** Test seam: shorter model-port deadlines; no entry passes it. */
  modelDeadlines?: ModelDeadlines | undefined;
  /**
   * Test seam: a shorter Atlassian check deadline than
   * `INTEGRATION_CHECK_MS`; no entry passes it.
   */
  integrationCheckMs?: number | undefined;
  /** Test seam: shorter enrollment-port idle bounds; no entry passes it. */
  enrollIdle?: EnrollIdle | undefined;
}

export interface RunningClientListener {
  readonly modelPort: number;
  readonly clientPort: number;
  readonly enrollPort: number;
  /** The gateway's CA, PEM: what a relay trusts the edge with. */
  readonly caPem: string;
  /** The model port's deadlines in force. */
  readonly modelDeadlines: Readonly<ModelDeadlines>;
  readonly registry: ClientRegistry;
  /** The clients' machine pools: pins, benches and machine leases. */
  readonly machinePool: MachinePool;
  /**
   * The user-scoped account and login operations, which the client methods
   * and the gateway page both use.
   */
  readonly userOperations: UserOperations;
  /** Adds or replaces a user's account and tells its clients. */
  putAccount(account: UserAccountRecord): void;
  /** Removes an account, revokes its leases and tells its clients. */
  removeAccount(profileId: string): void;
  /** Sends every connected client its user's accounts again. */
  accountsChanged(): void;
  close(): Promise<void>;
}

/** The peer's certificate identity on an authorized mutual-TLS socket. */
function peerIdentity(
  socket: net.Socket,
): { clientId: string; fingerprint: string } | undefined {
  const tlsSocket = socket as tls.TLSSocket;
  if (!tlsSocket.authorized || !tlsSocket.getPeerCertificate) return undefined;
  const cert = tlsSocket.getPeerCertificate();
  const cn = cert?.subject?.CN;
  const clientId = Array.isArray(cn) ? undefined : cn;
  return clientId && cert.fingerprint256
    ? { clientId, fingerprint: cert.fingerprint256 }
    : undefined;
}

/** The client id the request's certificate names, for the forwarder. */
export function peerClientId(req: http.IncomingMessage): string | undefined {
  return peerIdentity(req.socket)?.clientId;
}

/** One model-port connection's deadlines, from its handoff to HTTP. */
export interface ModelConnection {
  /** Called on each request's `request` event, before any handling. */
  request(req: http.IncomingMessage, res: http.ServerResponse): void;
}

/**
 * Enforces `ModelDeadlines` on a socket through public events only. A request
 * is open from its `request` event until its response finishes or closes;
 * pipelined requests can be open together. The connection awaits a request
 * (headers timer and socket idle timeout) only at the handoff and whenever
 * the count of open requests drops to zero, and any request ends that. Each
 * request's body timer is its own, cleared only by its own `end` or `close`.
 * Every expiry destroys the socket, whose `close` clears every timer.
 */
export function modelConnection(
  socket: net.Socket,
  deadlines: ModelDeadlines,
): ModelConnection {
  let open = 0;
  let headers: NodeJS.Timeout | undefined;
  const bodies = new Set<NodeJS.Timeout>();
  const expire = (): void => {
    socket.destroy();
  };
  const awaitRequest = (): void => {
    clearTimeout(headers);
    headers = setTimeout(expire, deadlines.headersMs);
    socket.setTimeout(deadlines.idleMs);
  };
  socket.on("timeout", expire);
  socket.once("close", () => {
    clearTimeout(headers);
    for (const timer of bodies) clearTimeout(timer);
    bodies.clear();
    socket.setTimeout(0);
  });
  awaitRequest();
  return {
    request(req, res) {
      open++;
      clearTimeout(headers);
      headers = undefined;
      socket.setTimeout(0);
      const body = setTimeout(expire, deadlines.requestMs);
      bodies.add(body);
      const received = (): void => {
        clearTimeout(body);
        bodies.delete(body);
      };
      req.once("end", received);
      req.once("close", received);
      let ended = false;
      const responded = (): void => {
        if (ended) return;
        ended = true;
        if (--open === 0 && !socket.destroyed) awaitRequest();
      };
      res.once("finish", responded);
      res.once("close", responded);
    },
  };
}

function loadEdgeTls(stateDir: string, hosts: string[]): EdgeTls {
  const file = createPrivateJsonFile(
    join(stateDir, "edge-tls.json"),
    "gateway edge TLS",
    { privateDirectory: "enforce" },
  );
  const existing = file.read<EdgeTls, EdgeTls | undefined>((value) => value);
  const next = edgeTlsFor(hosts, existing);
  if (next !== existing) file.write(next);
  return next;
}

async function listen(
  server: net.Server,
  port: number,
  host: string,
): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  return typeof address === "object" && address ? address.port : 0;
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export async function startClientListener(
  deps: ClientListenerDeps,
  options: ClientListenerOptions = {},
): Promise<RunningClientListener> {
  const { leases, profiles, log } = deps;
  const now = deps.now ?? Date.now;
  const enrollIdle = deps.enrollIdle ?? ENROLL_IDLE;
  const bindHost = options.bindHost ?? "127.0.0.1";
  const edgeTls = loadEdgeTls(
    deps.stateDir,
    options.hosts ?? ["localhost", "127.0.0.1"],
  );
  const registry = new ClientRegistry(deps.stateDir, now, log);
  const relayDedup = createRelayDedup({
    now,
    log,
    ...(deps.relayDedupIntervals === undefined
      ? {}
      : { maxIntervals: deps.relayDedupIntervals }),
  });
  const observations = deps.requests
    ? createRelayObservations({
        hosts: edgeTls.hosts,
        certificate: edgeTls.serverCertPem,
        dedup: relayDedup,
        requests: deps.requests,
        now,
        log,
        onCommitted: deps.onObservationsCommitted,
      })
    : undefined;
  // Usable accounts are read per selection, so account and login changes
  // reach the pools without a call here.
  const machinePool = new MachinePool({
    leases,
    accountsOf: (userId) => registry.accountsOf(userId),
    profile: (profileId) => profiles.get(profileId),
    needsLogin: deps.needsLogin,
    now,
    persist: deps.machinePins?.persist,
    log,
  });
  try {
    machinePool.restore(deps.machinePins?.restored ?? []);
  } catch {
    // Its pins are loaded; a lease release that failed to save is retried by
    // the next sweep.
    log("machine pins: restore sweep failed; retried by the next sweep");
  }
  const sockets = new Set<net.Socket>();
  const authenticated = new Map<net.Socket, GatewayClient>();
  const knownClients = new Set<string>();
  const track = (socket: net.Socket): void => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      authenticated.delete(socket);
    });
  };
  const mutualTls = {
    handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    key: edgeTls.serverKeyPem,
    cert: edgeTls.serverCertPem,
    ca: edgeTls.caCertPem,
    requestCert: true,
    rejectUnauthorized: true,
  };

  /** The socket's client while it is enrolled with that certificate. */
  const activeClient = (socket: net.Socket): GatewayClient | undefined => {
    const identity = peerIdentity(socket);
    const client = registry.active(identity?.clientId, identity?.fingerprint);
    if (client) {
      authenticated.set(socket, client);
      knownClients.add(client.id);
    }
    return client;
  };

  // --- accounts ---------------------------------------------------------

  const accountsOf = (userId: string): ClientAccount[] =>
    userOperations.accounts(userId);

  /** The user's login account by id, or the unknown-account failure. */
  const ownedAccount = (userId: string, accountId: string): LoginProfile => {
    const profile = profiles.get(accountId);
    if (
      !profile ||
      !isLoginProfile(profile) ||
      registry.ownerOf(accountId) !== userId
    )
      throw new WorkerMethodError(
        UNKNOWN_ACCOUNT,
        "The gateway holds no such account for this user.",
      );
    return profile;
  };

  const connections = new Map<WorkerConnection, GatewayClient>();

  const revokeClient = (clientId: string): void => {
    // Remove before cancellation: a driver's final event must not push again.
    for (const [connection, client] of connections) {
      if (client.id !== clientId) continue;
      connections.delete(connection);
      connection.end("the client is no longer active");
    }
    for (const [socket, client] of authenticated)
      if (client.id === clientId) socket.destroy();
    userOperations.endActor({ kind: "client", id: clientId });
    // Before the leases: dropping pins never throws, a failed lease save may.
    machinePool.dropClient(clientId);
    leases.revokeWhere(
      (record) => record.owner.clientId === clientId,
      "session-ended",
    );
  };

  const canPush = (
    connection: WorkerConnection,
    client: GatewayClient,
  ): boolean => {
    try {
      if (registry.active(client.id, client.fingerprint)) return true;
      revokeClient(client.id);
    } catch {
      connections.delete(connection);
      connection.end("the client registry is unavailable");
      log("client registry unavailable");
    }
    return false;
  };

  const accountsChanged = (): void => {
    for (const [connection, client] of connections) {
      if (!canPush(connection, client)) continue;
      try {
        connection
          .request(
            CLIENT_METHODS.accountsChanged,
            encodeClientMessage({ accounts: accountsOf(client.userId) }),
          )
          .catch(() => log(`client ${client.id} accounts.changed: failed`));
      } catch {
        connections.delete(connection);
        connection.end("the client registry is unavailable");
        log("client registry unavailable");
      }
    }
  };

  const putAccount = ({ userId, ...profile }: UserAccountRecord): void => {
    profiles.upsert(profile);
    registry.setAccountOwner(profile.id, userId);
    accountsChanged();
  };

  const removeAccount = (profileId: string): void => {
    profiles.remove(profileId);
    leases.revokeWhere(
      (record) => record.profileId === profileId,
      "profile-removed",
    );
    registry.removeAccount(profileId);
    accountsChanged();
  };

  const isClientActive = (clientId: string): boolean => {
    try {
      return registry
        .clients()
        .some(
          (client) => client.id === clientId && client.revokedAt === undefined,
        );
    } catch {
      return false;
    }
  };

  /** The client as a login actor: active while enrolled and not revoked. */
  const actorOf = (client: GatewayClient): LoginActor => ({
    kind: "client",
    id: client.id,
    userId: client.userId,
    active: () => isClientActive(client.id),
  });

  /** A fresh deadline, created where each check starts. */
  const checkSignal = (): AbortSignal =>
    AbortSignal.timeout(deps.integrationCheckMs ?? INTEGRATION_CHECK_MS);

  const userOperations = createUserOperations({
    vault: deps.vault,
    atlassianSignIn: options.atlassianSignIn === true,
    integrations: () => deps.tools?.integrations,
    checkSignal,
    registry,
    clientRevoked: (clientId) => revokeClient(clientId),
    profiles,
    ownerOf: (profileId) => registry.ownerOf(profileId),
    accountsOf: (userId) => registry.accountsOf(userId),
    needsLogin: deps.needsLogin,
    putAccount,
    removeAccount,
    // Only a client's connections take events; a session reads its login.
    send: (actor, loginId, accountId, event) => {
      if (actor.kind !== "client") return;
      for (const [connection, client] of connections)
        if (client.id === actor.id && canPush(connection, client))
          connection
            .request(
              CLIENT_METHODS.loginEvent,
              encodeClientMessage({ loginId, accountId, event }),
            )
            .catch(() => log(`client ${client.id} logins.event: failed`));
    },
    log,
  });

  /** A login refusal as the method error the client sees. */
  const loginCall = <T>(call: () => T): T => {
    try {
      return call();
    } catch (err) {
      if (err instanceof LoginRefusal)
        throw new WorkerMethodError(err.code, err.message);
      throw err;
    }
  };

  // --- gateway client 1.0 -----------------------------------------------

  type ClientMethod = (
    payload: Payload,
    client: GatewayClient,
    /** Aborts on the client's `cancel` or when its connection ends. */
    signal: AbortSignal,
  ) => Payload | Promise<Payload>;

  /** The user's integration credential, read from the vault on every call. */
  const vaultCredential =
    (client: GatewayClient) =>
    (
      integration: "atlassian" | "slack",
      signal: AbortSignal,
    ): Promise<CredentialOutcome> =>
      deps.vault
        .integrationGet(client.userId, integration, { signal })
        .catch(() => ({ ok: false, unavailable: true }));
  /** The edge's tool host, or the fixed refusal. */
  const toolHost = (): EdgeTools["host"] =>
    deps.tools?.host ?? integrationFailure("tools_unavailable");

  /** An integration refusal as the method error the client sees. */
  const integrationCall = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (err) {
      if (err instanceof UserOperationRefusal && isIntegrationFailure(err.code))
        integrationFailure(err.code);
      throw err;
    }
  };

  const methods: Record<string, ClientMethod> = {
    [CLIENT_METHODS.hello]: (_payload, client) =>
      encodeClientMessage({ clientId: client.id, userId: client.userId }),
    [CLIENT_METHODS.listAccounts]: (_payload, client) =>
      encodeClientMessage({ accounts: accountsOf(client.userId) }),
    [CLIENT_METHODS.grant]: (payload, client) => {
      const grant = decodeClientGrant(payload);
      const profile = ownedAccount(client.userId, grant.accountId);
      return encodeLeaseGranted(
        leases.grant(
          {
            profileId: profile.id,
            provider: profile.provider,
            tokenFile: profile.tokenFile,
          },
          {
            kind: "engine",
            owner: {
              workerId: grant.workerId,
              ...(grant.sessionId !== undefined
                ? { sessionId: grant.sessionId }
                : {}),
              clientId: client.id,
            },
          },
        ),
      );
    },
    [CLIENT_METHODS.clientLease]: (payload, client) => {
      const profile = ownedAccount(client.userId, decodeAccountId(payload));
      // One per account and client: the client asks again after a restart.
      leases.revokeWhere(
        (record) =>
          record.kind === "server" &&
          record.owner.clientId === client.id &&
          record.profileId === profile.id,
        "session-ended",
      );
      return encodeLeaseGranted(
        leases.grant(
          {
            profileId: profile.id,
            provider: profile.provider,
            tokenFile: profile.tokenFile,
          },
          {
            kind: "server",
            owner: { serverBootId: `client:${client.id}`, clientId: client.id },
          },
        ),
      );
    },
    [CLIENT_METHODS.bindSession]: (payload, client) => {
      const { leaseId, sessionId } = decodeLeaseSessionBind(payload);
      const outcome =
        leases.clientOf(leaseId) === client.id
          ? leases.bindSession(leaseId, sessionId)
          : "unknown";
      if (outcome === "unknown")
        throw new WorkerMethodError(
          UNKNOWN_LEASE,
          "The gateway holds no live lease by this id.",
        );
      if (outcome === "server")
        throw new WorkerMethodError(
          INVALID_PARAMS,
          "A client lease has no session.",
        );
      if (outcome === "conflict")
        throw new WorkerMethodError(
          OWNER_CONFLICT,
          "The lease is bound to another session.",
        );
      return encodeControlDone();
    },
    [CLIENT_METHODS.revoke]: (payload, client) => {
      const { leaseId, reason } = decodeLeaseRevoke(payload);
      return encodeLeaseRevoked(
        leases.clientOf(leaseId) === client.id &&
          leases.revoke(leaseId, reason),
      );
    },
    [CLIENT_METHODS.reconcileWorker]: (payload, client) => {
      const { workerId, live } = decodeWorkerReconcile(payload);
      const keep = new Set(live);
      return encodeLeasesRevoked(
        leases.revokeWhere(
          (record) =>
            record.kind === "engine" &&
            record.owner.clientId === client.id &&
            record.owner.workerId === workerId &&
            !keep.has(record.leaseId),
          "session-ended",
        ),
      );
    },
    [CLIENT_METHODS.loginStart]: (payload, client) => {
      const start = decodeLoginStart(payload);
      return encodeClientMessage(
        loginCall(() => userOperations.startLogin(actorOf(client), start)),
      );
    },
    [CLIENT_METHODS.loginInput]: (payload, client) => {
      const { loginId, text } = decodeLoginInput(payload);
      loginCall(() =>
        userOperations.inputLogin(actorOf(client), loginId, text),
      );
      return encodeControlDone();
    },
    [CLIENT_METHODS.loginCancel]: (payload, client) => {
      const loginId = decodeLoginId(payload);
      loginCall(() => userOperations.cancelLogin(actorOf(client), loginId));
      return encodeControlDone();
    },
    // The method's cancel signal stays unused: a set or check runs to its
    // own deadline.
    [CLIENT_METHODS.integrationSet]: async (payload, client) => {
      const { input } = decodeIntegrationSet(payload);
      return encodeClientMessage(
        await integrationCall(() =>
          userOperations.setAtlassian(client.userId, input),
        ),
      );
    },
    [CLIENT_METHODS.integrationClear]: async (payload, client) => {
      decodeIntegration(payload);
      await integrationCall(() => userOperations.clearAtlassian(client.userId));
      return encodeControlDone();
    },
    [CLIENT_METHODS.integrationStatus]: async (payload, client) => {
      const { check } = decodeIntegrationStatusRequest(payload);
      return encodeClientMessage(
        await integrationCall(() =>
          userOperations.atlassianStatus(client.userId, { check }),
        ),
      );
    },
    [CLIENT_METHODS.toolsList]: () =>
      encodeClientMessage({ tools: toolHost().list() }),
    // The tool's own failure is an answer, not a failed call; the user is
    // the registry's, never a payload's.
    [CLIENT_METHODS.toolsCall]: async (payload, client, signal) => {
      const { name, args } = decodeToolCall(payload);
      return encodeClientMessage(
        await toolHost().call(name, args, {
          clientId: client.id,
          credential: vaultCredential(client),
          signal,
        }),
      );
    },
    [CLIENT_METHODS.removeAccount]: (payload, client) => {
      const accountId = decodeAccountId(payload);
      loginCall(() => userOperations.removeAccount(client.userId, accountId));
      return encodeControlDone();
    },
  };

  const attachClient = (socket: tls.TLSSocket, client: GatewayClient): void => {
    const identity = peerIdentity(socket)!;
    const handlers: Record<string, MethodHandler> = {};
    for (const [method, body] of Object.entries(methods))
      handlers[method] = (payload, signal) => {
        try {
          if (!registry.active(identity.clientId, identity.fingerprint)) {
            setImmediate(() => {
              try {
                revokeClient(client.id);
              } catch {
                log("client revocation persistence failed");
              }
            });
            throw new WorkerMethodError(
              CLIENT_REVOKED,
              "The client is revoked.",
            );
          }
        } catch (err) {
          if (!(err instanceof WorkerMethodError))
            setImmediate(() =>
              connection.end("the client registry is unavailable"),
            );
          return Promise.reject(
            err instanceof WorkerMethodError
              ? err
              : new WorkerMethodError(
                  STATE_WRITE_FAILED,
                  "The client registry is unavailable.",
                ),
          );
        }
        return (async () => {
          try {
            const answer = await body(payload, client, signal);
            log(`client ${client.id} ${method}: ok`);
            return answer;
          } catch (err) {
            const failure =
              err instanceof StateWriteError
                ? new WorkerMethodError(STATE_WRITE_FAILED, err.message)
                : err;
            if (!(err instanceof ClientRegistryLockedError))
              log(
                `client ${client.id} ${method}: ${failure instanceof WorkerMethodError ? failure.code : "failed"}`,
              );
            throw failure;
          }
        })();
      };
    const connection: WorkerConnection = new WorkerConnection(
      socketEndpoint(socket),
      {
        protocol: GATEWAY_CLIENT_PROTOCOL,
        handshake: {
          role: "server",
          admit: (hello) =>
            GATEWAY_CLIENT_PROTOCOL.compatible(hello.version)
              ? undefined
              : `this endpoint speaks ${GATEWAY_CLIENT_VERSION} only`,
        },
        handlers,
        onEnd: () => connections.delete(connection),
      },
    );
    connections.set(connection, client);
  };

  // --- servers ----------------------------------------------------------

  const refuseClient = (socket: net.Socket): void => {
    log("client connection refused: unknown or revoked certificate");
    socket.destroy();
  };

  /**
   * `/mcp` (Task-1397), in order: no `Origin`, then the client's own MCP
   * token. It never forwards, so a lease token opens no tool and an MCP token
   * spends no lease. Refusals are fixed; no header value is logged or echoed.
   */
  const mcpGate = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    client: GatewayClient,
    tools: EdgeTools,
    answer: LocalAnswer,
  ): void => {
    const refuse = (
      status: number,
      error: string,
      headers: Record<string, string> = {},
    ): void => {
      req.resume();
      const body = JSON.stringify({ error });
      res.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        ...headers,
      });
      res.end(body);
    };
    // The request's line, written by its record, names the refusal.
    if (req.headers.origin !== undefined) {
      answer.refuse("mcp-origin");
      return refuse(403, "origin not allowed");
    }
    const bearer = /^Bearer ([A-Za-z0-9_-]{1,200})$/.exec(
      req.headers.authorization ?? "",
    )?.[1];
    if (!bearer || !mcpTokenMatches(client, bearer)) {
      answer.refuse("mcp-token");
      return refuse(401, "mcp token required", {
        "www-authenticate": "Bearer",
      });
    }
    tools.handleMcp(req, res, {
      clientId: client.id,
      credential: vaultCredential(client),
    });
  };

  const forwarder = deps.forwarder({
    pool: machinePool,
    // Checked again after the credential wait: a revocation meanwhile wins.
    userOf: (req) => activeClient(req.socket)?.userId,
  });
  const modelDeadlines = deps.modelDeadlines ?? MODEL_DEADLINES;
  const modelConnections = new WeakMap<net.Socket, ModelConnection>();
  /** Cached mTLS identity attributes refusals, never permission to route. */
  const modelAdmission = (req: http.IncomingMessage) => {
    let client: GatewayClient | undefined;
    let registryUnavailable = false;
    try {
      client = activeClient(req.socket);
    } catch {
      registryUnavailable = true;
    }
    const known = client ?? authenticated.get(req.socket);
    const admitted: AdmittedClient | undefined = known && {
      id: known.id,
      label: known.label,
      userId: known.userId,
    };
    return { client, admitted, registryUnavailable };
  };
  /** Reserve before any attributed trace, for ordinary requests and CONNECT. */
  const duplicateRelayId = (
    req: http.IncomingMessage,
    admitted: AdmittedClient | undefined,
  ): boolean => {
    const supplied: string[] = [];
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2)
      if (req.rawHeaders[i]!.toLowerCase() === "x-pandeck-relay-id")
        supplied.push(req.rawHeaders[i + 1]!);
    if (!admitted || !supplied.length) return false;
    const match = supplied.length === 1 ? RELAY_RID.exec(supplied[0]!) : null;
    if (!match) {
      admitted.ridDiagnostic = "invalid";
      return false;
    }
    admitted.rid = supplied[0]!;
    const disposition = relayDedup.enter(
      admitted.id,
      match[1]!,
      Number(match[2]),
    );
    if (disposition === "present") {
      log(
        `relay request: client=${admitted.id} rid=${admitted.rid} duplicate-rid`,
      );
      return true;
    }
    if (disposition === "below-floor") admitted.ridDiagnostic = "below-floor";
    return false;
  };
  // Never listened: only admitted sockets reach it, through `connection`.
  const modelHttp = http.createServer((req, res) => {
    const connection = modelConnections.get(req.socket);
    if (!connection) {
      req.socket.destroy();
      return;
    }
    connection.request(req, res);
    serveModel(req, res);
  });
  // Its own timeouts are off, so the socket's timeout is ours alone. Set as
  // properties: Bun 1.4.2 ignores `keepAliveTimeout` as an option.
  modelHttp.keepAliveTimeout = 0;
  modelHttp.headersTimeout = 0;
  modelHttp.requestTimeout = 0;
  // CONNECT never tunnels here, whatever the bearer: the method floor refuses
  // it marked and recorded, after the same admission as any request
  // (Task-1430 PR3). Parse errors, TRACK included, keep the runtime's own
  // 400 with no record (D-PR3-7): no `clientError` listener.
  modelHttp.on(
    "connect",
    (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      const peer = req.socket;
      if (!modelConnections.has(peer)) {
        socket.destroy();
        return;
      }
      const { client, admitted, registryUnavailable } = modelAdmission(req);
      if (duplicateRelayId(req, admitted)) {
        const { status, body } = refusalResponse(
          { case: "duplicate-rid" },
          "claude",
        );
        socket.on("error", () => socket.destroy());
        socket.end(
          `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
        );
        return;
      }
      const refusal: ConnectRefusal = registryUnavailable
        ? { case: "registry-unavailable" }
        : !client
          ? { case: "forbidden" }
          : { case: "denied", id: "method" };
      forwarder.refuseConnect(req, socket, head, admitted, refusal);
    },
  );
  const serveModel = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void => {
    // Every request is observed once: here when the listener answers it
    // itself, else by the forwarder. Without a resolved client, a line only.
    const { client, admitted, registryUnavailable } = modelAdmission(req);
    // Only an active client may ingest. The path is not parsed, so a
    // malformed target cannot throw here.
    if (
      client &&
      admitted &&
      (req.url ?? "").split("?")[0] === "/relay/observations" &&
      observations
    )
      return observations(req, res, admitted);
    if (duplicateRelayId(req, admitted)) {
      const { status, body } = refusalResponse(
        { case: "duplicate-rid" },
        "claude",
      );
      res.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      req.resume();
      return;
    }
    if (registryUnavailable) {
      forwarder.observeLocal(req, res, admitted).refuse("registry-unavailable");
      return json(res, 503, { error: "client registry unavailable" });
    }
    if (!client || !admitted) {
      forwarder.observeLocal(req, res, admitted).refuse("forbidden");
      const { status, body } = refusalResponse({ case: "forbidden" }, "claude");
      res.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        connection: "close",
      });
      res.end(body);
      return;
    }
    // Without tools `/mcp` is an unknown path to the forwarder, as before.
    if (deps.tools && (req.url ?? "").split("?")[0] === "/mcp")
      return mcpGate(
        req,
        res,
        client,
        deps.tools,
        forwarder.observeLocal(req, res, admitted),
      );
    forwarder.handleRequest(req, res, admitted);
  };
  const model = tls.createServer(mutualTls, (socket) => {
    track(socket);
    try {
      if (!activeClient(socket)) return refuseClient(socket);
    } catch {
      socket.destroy();
      return;
    }
    modelConnections.set(socket, modelConnection(socket, modelDeadlines));
    modelHttp.emit("connection", socket);
  });
  // A plain TLS server does not close timed-out handshakes (below).
  model.on("tlsClientError", (_err, socket) => socket.destroy());

  const clientServer = tls.createServer(mutualTls, (socket) => {
    track(socket);
    try {
      const client = activeClient(socket);
      if (!client) return refuseClient(socket);
      attachClient(socket, client);
    } catch {
      socket.destroy();
    }
  });
  // Unlike HTTPS, a plain TLS server does not close timed-out handshakes.
  // Release their connection slots instead of retaining silent TCP peers.
  clientServer.on("tlsClientError", (_err, socket) => socket.destroy());

  let ports = { modelPort: 0, clientPort: 0 };
  const attempts = new Map<string, { until: number; count: number }>();
  const admitEnrollment = (address: string): boolean => {
    const time = now();
    for (const [source, entry] of attempts)
      if (entry.until <= time) attempts.delete(source);
    let entry = attempts.get(address);
    if (!entry) {
      if (attempts.size >= MAX_ENROLL_SOURCES) return false;
      entry = { until: time + ENROLL_WINDOW_MS, count: 0 };
      attempts.set(address, entry);
    }
    return ++entry.count <= ENROLL_ATTEMPTS;
  };
  const approvalOrigin = options.approvalOrigin?.replace(/\/+$/, "");
  const polls = new PollLimiter();
  const sourceOf = (req: http.IncomingMessage): string =>
    req.socket.remoteAddress ?? "unknown";
  const refuseAttempts = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void => {
    res.setHeader("retry-after", "60");
    res.setHeader("connection", "close");
    req.resume();
    json(res, 429, { error: "too many enrollment attempts" });
  };
  /** The JSON body within `MAX_ENROLL_BYTES`; undefined when not JSON. */
  const readBody = (
    req: http.IncomingMessage,
    then: (body: unknown) => void,
  ): void => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_ENROLL_BYTES) req.destroy();
      else chunks.push(chunk);
    });
    req.on("end", () => {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      } catch {
        body = undefined;
      }
      then(body);
    });
  };
  const enrolled = (
    res: http.ServerResponse,
    clientId: string,
    certificatePem: string,
  ): void =>
    json(res, 200, {
      clientId,
      certificatePem,
      caPem: edgeTls.caCertPem,
      ...ports,
    });
  /** A new client id and its certificate for a request's stored key. */
  const issueFor = (publicKeyPem: string) => {
    const publicKey = clientPublicKey(publicKeyPem);
    if (!publicKey) throw new Error("The request's key is not EC P-256.");
    const clientId = newClientId();
    return {
      clientId,
      ...issueClientCertificate(edgeTls, clientId, publicKey),
    };
  };

  /** `POST /enroll`: a typed one-time code. */
  const redeemCode = (
    body: unknown,
    _req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void => {
    const fields = (body ?? {}) as Record<string, unknown>;
    const code = fields.code;
    const publicKey =
      typeof fields.publicKeyPem === "string"
        ? clientPublicKey(fields.publicKeyPem)
        : undefined;
    if (typeof code !== "string" || !publicKey)
      return json(res, 400, { error: "code and an EC P-256 key needed" });
    const mcpTokenHash = fields.mcpTokenHash;
    if (mcpTokenHash !== undefined && !isHash(mcpTokenHash))
      return json(res, 400, { error: "malformed MCP token hash" });
    let certificatePem = "";
    const client = registry.redeem(code, ({ userId, label }) => {
      const id = newClientId();
      const issued = issueClientCertificate(edgeTls, id, publicKey);
      certificatePem = issued.certificatePem;
      return {
        id,
        userId,
        label,
        fingerprint: issued.fingerprint,
        createdAt: now(),
        ...(mcpTokenHash !== undefined ? { mcpTokenHash } : {}),
      };
    });
    if (!client) {
      log("enrollment refused: unknown, used or expired code");
      return json(res, 403, { error: "unknown, used or expired code" });
    }
    log(`enrolled client ${client.id} for user ${client.userId}`);
    enrolled(res, client.id, certificatePem);
  };

  /**
   * A start's devbox proof, checked and, when it holds, the request approved:
   * undefined then, else why not. The socket keeps the raised idle bound
   * while the proof runs and has the baseline back before the answer; the
   * connection's end aborts the proof. Only the token's hash outlives this.
   */
  const approveByProof = async (
    requestId: string,
    token: string,
    req: http.IncomingMessage,
  ): Promise<AutomaticRefused | undefined> => {
    const declined = (
      reason: AutomaticRefused,
      code?: string,
    ): AutomaticRefused => {
      log(
        `automatic enrollment declined: ${reason}${code === undefined ? "" : ` (${code})`}`,
      );
      return reason;
    };
    const devbox = options.devboxApproval;
    if (!devbox) return declined("not_configured");
    const ended = new AbortController();
    const onClose = (): void => ended.abort();
    req.socket.setTimeout(enrollIdle.proofMs);
    req.socket.once("close", onClose);
    try {
      const proof = await devbox.verify(token, { now, signal: ended.signal });
      if (!proof.ok) return declined(proof.reason, proof.code);
      // Nobody would collect an approval for a connection already gone.
      if (ended.signal.aborted) return declined("unavailable");
      const tokenHash = createHash("sha256")
        .update(token, "utf8")
        .digest("hex");
      let outcome;
      try {
        outcome = registry.approveAutomatically(
          requestId,
          {
            issuer: devbox.issuer,
            subject: proof.subject,
            email: proof.email,
            tokenHash,
            notAfter: proof.notAfter,
          },
          PAGE_ENROLLMENT_LIMITS,
        );
      } catch (err) {
        // The request is open: the page can still approve it.
        if (err instanceof ClientRegistryLockedError)
          return declined("unavailable");
        throw err;
      }
      if (outcome.status !== "approved")
        return declined(registryRefused(outcome.status));
      log(
        `enrollment request approved automatically for user ${outcome.userId}${outcome.created ? ", new user" : ""}`,
      );
      return undefined;
    } finally {
      req.socket.removeListener("close", onClose);
      req.socket.setTimeout(enrollIdle.baseMs);
    }
  };

  /**
   * `POST /enroll/start`: a machine asks to be approved, a devbox maybe with
   * its proof. The request opens first, under the same admission as without
   * one; a proof that does not hold leaves it to the page.
   */
  const startRequest = async (
    body: unknown,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    const start = decodeStart(body);
    if (!start)
      return json(res, 400, {
        error: "an EC P-256 key, an MCP token hash and a name needed",
      });
    const { devboxToken, ...request } = start;
    const outcome = registry.startRequest({ ...request, from: sourceOf(req) });
    if (!outcome.ok) {
      res.setHeader("retry-after", "60");
      return outcome.reason === "source_limit"
        ? json(res, 429, { error: "too many open enrollment requests" })
        : json(res, 503, { error: "enrollment requests full" });
    }
    log("enrollment request started");
    const answer = {
      requestId: outcome.requestId,
      userCode: outcome.userCode,
      verificationUri: `${approvalOrigin}/#enroll=${outcome.userCode}`,
      expiresInSeconds: ENROLLMENT_REQUEST_TTL_MS / 1000,
      intervalSeconds: POLL_ADVICE_SECONDS,
    };
    if (devboxToken === undefined)
      return json(res, 200, { ...answer, approval: "browser" });
    const refused = await approveByProof(outcome.requestId, devboxToken, req);
    json(
      res,
      200,
      refused === undefined
        ? { ...answer, approval: "automatic" }
        : { ...answer, approval: "browser", automaticRefused: refused },
    );
  };

  /**
   * `POST /enroll/poll`: the machine collects its decision. A malformed or
   * unknown id costs a per-source attempt and allocates nothing else; a known
   * one is limited per request.
   */
  const pollRequest = (
    body: unknown,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void => {
    const requestId = decodePoll(body);
    const key =
      requestId === undefined ? undefined : registry.knownRequest(requestId);
    if (requestId === undefined || key === undefined) {
      if (!admitEnrollment(sourceOf(req))) return refuseAttempts(req, res);
      return requestId === undefined
        ? json(res, 400, { error: "requestId needed" })
        : json(res, 404, { error: "unknown request" });
    }
    if (!polls.admit(key, now())) {
      res.setHeader("retry-after", String(POLL_ADVICE_SECONDS));
      return json(res, 429, { error: "slow_down" });
    }
    const outcome = registry.collect(requestId, issueFor);
    switch (outcome.status) {
      case "approved":
        if (outcome.first)
          log(`enrolled client ${outcome.clientId} by approval`);
        return enrolled(res, outcome.clientId, outcome.certificatePem);
      case "pending":
        return json(res, 202, { status: "pending" });
      case "denied":
        return json(res, 403, { error: "denied" });
      case "expired":
        return json(res, 410, { error: "expired" });
      case "revoked":
        return json(res, 410, { error: "revoked" });
      case "unknown":
        return json(res, 404, { error: "unknown request" });
    }
  };

  const enroll = https.createServer(
    {
      key: edgeTls.serverKeyPem,
      cert: edgeTls.serverCertPem,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      headersTimeout: 5_000,
      requestTimeout: 10_000,
      connectionsCheckingInterval: 1_000,
    },
    (req, res) => {
      req.on("error", () => {});
      const route =
        req.method !== "POST"
          ? undefined
          : req.url === "/enroll"
            ? redeemCode
            : req.url === "/enroll/start"
              ? approvalOrigin === undefined
                ? undefined
                : startRequest
              : req.url === "/enroll/poll"
                ? pollRequest
                : undefined;
      if (!route) return json(res, 404, { error: "not found" });
      // A poll is limited once its id is read: per request when known.
      if (route !== pollRequest && !admitEnrollment(sourceOf(req)))
        return refuseAttempts(req, res);
      const failed = (err: unknown): void => {
        if (!(err instanceof ClientRegistryLockedError))
          log("enrollment failed: client registry unavailable");
        if (res.headersSent) res.destroy();
        else json(res, 503, { error: "client registry unavailable" });
      };
      readBody(req, (body) => {
        try {
          // The start is async; its rejection is a throw like the others'.
          void Promise.resolve(route(body, req, res)).catch(failed);
        } catch (err) {
          failed(err);
        }
      });
    },
  );
  for (const server of [model, clientServer, enroll]) {
    server.maxConnections = MAX_CONNECTIONS;
    server.on("connection", track);
  }
  enroll.setTimeout(enrollIdle.baseMs, (socket) => socket.destroy());

  const modelPort = await listen(model, options.modelPort ?? 0, bindHost);
  const clientPort = await listen(
    clientServer,
    options.clientPort ?? 0,
    bindHost,
  );
  ports = { modelPort, clientPort };
  const enrollPort = await listen(enroll, options.enrollPort ?? 0, bindHost);
  log(
    `client listener on ${bindHost}: model ${modelPort}, client ${clientPort}, enroll ${enrollPort}`,
  );

  // The admin CLI writes from another process. Also cover clients with leases
  // or running logins but no current connection. A failed read gives no new
  // revocation evidence; preserve the last successfully observed state.
  let registryReadFailed = false;
  const revocations = setInterval(() => {
    let active: Set<string>;
    try {
      active = new Set(
        registry
          .clients()
          .filter((client) => client.revokedAt === undefined)
          .map((client) => client.id),
      );
    } catch {
      if (!registryReadFailed)
        log("client revocation check deferred: client registry unavailable");
      registryReadFailed = true;
      return;
    }
    registryReadFailed = false;
    for (const record of leases.records())
      if (record.owner.clientId) knownClients.add(record.owner.clientId);
    for (const clientId of knownClients) {
      if (active.has(clientId)) continue;
      try {
        revokeClient(clientId);
      } catch {
        log("client revocation persistence failed");
      }
    }
  }, 250);
  revocations.unref();

  return {
    modelPort,
    clientPort,
    enrollPort,
    caPem: edgeTls.caCertPem,
    modelDeadlines,
    registry,
    machinePool,
    userOperations,
    putAccount,
    removeAccount,
    accountsChanged,
    async close() {
      clearInterval(revocations);
      relayDedup.close();
      userOperations.close();
      for (const connection of [...connections.keys()])
        connection.end("the gateway closed");
      const closed = Promise.all(
        [model, clientServer, enroll].map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await closed;
    },
  };
}
