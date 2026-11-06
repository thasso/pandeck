/**
 * The edge's listeners for enrolled clients (plan Task-1384 §1-2, M13):
 *
 * - the enrollment port, HTTPS with the edge's server certificate and no
 *   client certificate: `POST /enroll {code, publicKeyPem}` uses up a
 *   one-time code and answers `{clientId, certificatePem, caPem, modelPort,
 *   clientPort}`;
 * - the model port, HTTPS with mutual TLS, the same routes as the loopback
 *   listener through a forwarder that spends only the calling client's
 *   leases;
 * - the client port, TLS with mutual TLS, serving gateway client 1.0
 *   (`clientMethods.ts`).
 *
 * The gateway's CA is the only trust root on both mutual-TLS ports. The
 * client is the common name of its certificate, matched by fingerprint, and
 * is checked on every connection and again on every request and method, so a
 * revocation takes effect at once. The CA and the edge's server certificate
 * live in `edge-tls.json`, the clients in `clients.json` (`clientRegistry.ts`),
 * both under the state directory.
 */
import { randomBytes } from "node:crypto";
import https from "node:https";
import type http from "node:http";
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
  decodeLoginId,
  decodeLoginInput,
  decodeLoginStart,
  encodeClientMessage,
  type ClientAccount,
} from "./clientMethods.ts";
import {
  ClientRegistry,
  ClientRegistryLockedError,
  type GatewayClient,
} from "./clientRegistry.ts";
import { createLoginManager, LoginRefusal } from "./logins.ts";
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
  /** The vault's side of logins (`logins.ts`, `vaultLogins.ts`). */
  vault: Pick<VaultPort, "login" | "newTokenFile" | "discardCredential">;
}

/** An account of a user, as logins and tests create it. */
type ClientAccountRecord = LoginProfile & { userId: string };

export interface RunningClientListener {
  readonly modelPort: number;
  readonly clientPort: number;
  readonly enrollPort: number;
  /** The gateway's CA, PEM: what a relay trusts the edge with. */
  readonly caPem: string;
  readonly registry: ClientRegistry;
  /** Adds or replaces a user's account and tells its clients. */
  putAccount(account: ClientAccountRecord): void;
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

  const accountsOf = (userId: string): ClientAccount[] => {
    const needing = new Set(deps.needsLogin());
    for (const id of logins.pendingAccounts()) needing.add(id);
    return registry.accountsOf(userId).flatMap((id): ClientAccount[] => {
      const profile = profiles.get(id);
      return profile && isLoginProfile(profile)
        ? [
            {
              id,
              provider: profile.provider,
              name: profile.name,
              enabled: profile.enabled,
              needsLogin: needing.has(id),
            },
          ]
        : [];
    });
  };

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
    logins.cancelClient(clientId);
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

  const putAccount = ({ userId, ...profile }: ClientAccountRecord): void => {
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

  const logins = createLoginManager({
    vault: deps.vault,
    profiles,
    ownerOf: (profileId) => registry.ownerOf(profileId),
    isClientActive: (clientId) => {
      try {
        return registry
          .clients()
          .some(
            (client) =>
              client.id === clientId && client.revokedAt === undefined,
          );
      } catch {
        return false;
      }
    },
    putAccount,
    removeAccount,
    send: (clientId, loginId, accountId, event) => {
      for (const [connection, client] of connections)
        if (client.id === clientId && canPush(connection, client))
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

  type ClientMethod = (payload: Payload, client: GatewayClient) => Payload;

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
        loginCall(() =>
          logins.start({ clientId: client.id, userId: client.userId }, start),
        ),
      );
    },
    [CLIENT_METHODS.loginInput]: (payload, client) => {
      const { loginId, text } = decodeLoginInput(payload);
      loginCall(() => logins.input(client.id, loginId, text));
      return encodeControlDone();
    },
    [CLIENT_METHODS.loginCancel]: (payload, client) => {
      const loginId = decodeLoginId(payload);
      loginCall(() => logins.cancel(client.id, loginId));
      return encodeControlDone();
    },
    [CLIENT_METHODS.removeAccount]: (payload, client) => {
      const profile = ownedAccount(client.userId, decodeAccountId(payload));
      logins.forget(profile.id);
      removeAccount(profile.id);
      // Only a token file the vault made for the account goes with it.
      deps.vault.discardCredential(profile.id);
      return encodeControlDone();
    },
  };

  const attachClient = (socket: tls.TLSSocket, client: GatewayClient): void => {
    const identity = peerIdentity(socket)!;
    const handlers: Record<string, MethodHandler> = {};
    for (const [method, body] of Object.entries(methods))
      handlers[method] = (payload) => {
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
        try {
          const answer = body(payload, client);
          log(`client ${client.id} ${method}: ok`);
          return Promise.resolve(answer);
        } catch (err) {
          const failure =
            err instanceof StateWriteError
              ? new WorkerMethodError(STATE_WRITE_FAILED, err.message)
              : err;
          if (!(err instanceof ClientRegistryLockedError))
            log(
              `client ${client.id} ${method}: ${failure instanceof WorkerMethodError ? failure.code : "failed"}`,
            );
          return Promise.reject(failure);
        }
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

  const model = https.createServer(mutualTls, (req, res) => {
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
    deps.forwarder.handleRequest(req, res);
  });
  model.on("secureConnection", (socket: tls.TLSSocket) => {
    track(socket);
    try {
      if (!activeClient(socket)) refuseClient(socket);
    } catch {
      socket.destroy();
    }
  });
  model.on("tlsClientError", () => {});

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
    registry,
    putAccount,
    removeAccount,
    accountsChanged,
    async close() {
      clearInterval(revocations);
      logins.close();
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
