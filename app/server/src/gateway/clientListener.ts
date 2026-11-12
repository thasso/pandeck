/**
 * The edge's listeners for enrolled clients (plan Task-1384 §1-2, M13):
 *
 * - the enrollment port, HTTPS with the edge's server certificate and no
 *   client certificate: `POST /enroll {code, publicKeyPem}` uses up a
 *   one-time code and answers `{clientId, certificatePem, caPem, modelPort,
 *   clientPort}`;
 * - the model port, HTTP over mutual TLS, the same routes as the loopback
 *   listener through a forwarder that spends only the calling client's
 *   leases;
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
import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type net from "node:net";
import { join } from "node:path";
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
  mcpTokenMatches,
  type GatewayClient,
} from "./clientRegistry.ts";
import type { CredentialOutcome, EdgeTools } from "./edgeTools.ts";
import { LoginRefusal, type LoginActor } from "./logins.ts";
import {
  createUserOperations,
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
}

interface ClientListenerDeps {
  stateDir: string;
  leases: LeaseTable;
  profiles: ProfileRegistry;
  /** The profiles renewal found needing a login. */
  needsLogin: () => string[];
  /** The model forwarder built with `clientOf: peerClientId`. */
  forwarder: {
    handleRequest: (
      req: http.IncomingMessage,
      res: http.ServerResponse,
    ) => void;
  };
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
  const bindHost = options.bindHost ?? "127.0.0.1";
  const edgeTls = loadEdgeTls(
    deps.stateDir,
    options.hosts ?? ["localhost", "127.0.0.1"],
  );
  const registry = new ClientRegistry(deps.stateDir, now, log);
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
      integration: "atlassian",
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
    if (req.headers.origin !== undefined) {
      log(`mcp refused for client ${client.id}: origin header`);
      return refuse(403, "origin not allowed");
    }
    const bearer = /^Bearer ([A-Za-z0-9_-]{1,200})$/.exec(
      req.headers.authorization ?? "",
    )?.[1];
    if (!bearer || !mcpTokenMatches(client, bearer)) {
      log(`mcp refused for client ${client.id}: no valid token`);
      return refuse(401, "mcp token required", {
        "www-authenticate": "Bearer",
      });
    }
    tools.handleMcp(req, res, {
      clientId: client.id,
      credential: vaultCredential(client),
    });
  };

  const modelDeadlines = deps.modelDeadlines ?? MODEL_DEADLINES;
  const modelConnections = new WeakMap<net.Socket, ModelConnection>();
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
  const serveModel = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void => {
    let client: GatewayClient | undefined;
    try {
      client = activeClient(req.socket);
    } catch {
      return json(res, 503, { error: "client registry unavailable" });
    }
    if (!client) {
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
    // The path only, without parsing: a malformed target must not throw here.
    if (deps.tools && (req.url ?? "").split("?")[0] === "/mcp")
      return mcpGate(req, res, client, deps.tools);
    deps.forwarder.handleRequest(req, res);
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
      if (req.method !== "POST" || req.url !== "/enroll")
        return json(res, 404, { error: "not found" });
      if (!admitEnrollment(req.socket.remoteAddress ?? "unknown")) {
        res.setHeader("retry-after", "60");
        res.setHeader("connection", "close");
        req.resume();
        return json(res, 429, { error: "too many enrollment attempts" });
      }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_ENROLL_BYTES) req.destroy();
        else chunks.push(chunk);
      });
      req.on("end", () => {
        try {
          let body: Record<string, unknown> | undefined;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
              string,
              unknown
            >;
          } catch {
            body = undefined;
          }
          const code = body?.code;
          const publicKey =
            typeof body?.publicKeyPem === "string"
              ? clientPublicKey(body.publicKeyPem)
              : undefined;
          if (typeof code !== "string" || !publicKey)
            return json(res, 400, { error: "code and an EC P-256 key needed" });
          let certificatePem = "";
          const client = registry.redeem(code, ({ userId, label }) => {
            const id = randomBytes(12).toString("base64url");
            const issued = issueClientCertificate(edgeTls, id, publicKey);
            certificatePem = issued.certificatePem;
            return {
              id,
              userId,
              label,
              fingerprint: issued.fingerprint,
              createdAt: now(),
            };
          });
          if (!client) {
            log("enrollment refused: unknown, used or expired code");
            return json(res, 403, { error: "unknown, used or expired code" });
          }
          log(`enrolled client ${client.id} for user ${client.userId}`);
          json(res, 200, {
            clientId: client.id,
            certificatePem,
            caPem: edgeTls.caCertPem,
            ...ports,
          });
        } catch (err) {
          if (!(err instanceof ClientRegistryLockedError))
            log("enrollment failed: client registry unavailable");
          json(res, 503, { error: "client registry unavailable" });
        }
      });
    },
  );
  for (const server of [model, clientServer, enroll]) {
    server.maxConnections = MAX_CONNECTIONS;
    server.on("connection", track);
  }
  enroll.setTimeout(10_000, (socket) => socket.destroy());

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
    userOperations,
    putAccount,
    removeAccount,
    accountsChanged,
    async close() {
      clearInterval(revocations);
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
