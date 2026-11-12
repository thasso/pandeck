/**
 * The edge's `VaultPort` over `gateway-vault/1.0` (plan Task-1394,
 * `vaultMethods.ts`): a vault in its own process, dialed over mutual TLS
 * with each side's self-signed certificate pinned. The edge then holds no
 * refresh token. It dials at once and again with backoff whenever the link
 * ends; on every connect it reads the vault's needs-login set and sends both
 * inputs, the profile registry and the live-lease set, which it sends again on
 * every change.
 *
 * With the link down, a credential read answers the marked "vault
 * unavailable" refusal, never needs-login, so no account is marked logged
 * out; `needsLogin()` answers the last set the vault told. No access token is
 * cached here: one round trip per forwarded request.
 */
import { randomBytes, X509Certificate } from "node:crypto";
import tls from "node:tls";
import {
  WorkerConnection,
  WorkerRequestError,
  WorkerRequestNotSentError,
  type MethodHandler,
} from "../workerProtocol/connection.ts";
import { socketEndpoint } from "../workerProtocol/unixSocketTransport.ts";
import type { LeaseProvider, LoginBinding } from "./leases.ts";
import { LoginNotRun, LoginOutcomeUnknown } from "./logins.ts";
import type { GatewayProfile } from "./profiles.ts";
import {
  GATEWAY_VAULT_PROTOCOL,
  OUTSIDE_ACCOUNTS,
  VAULT_LIMITS,
  VAULT_LOCKED,
  VAULT_METHODS,
  accountTokenFile,
  isPinnedPeer,
  vaultBody,
  vaultMessage,
  type LoginFailure,
  type VaultLinkTls,
} from "./vaultMethods.ts";
import type { CredentialProblem } from "./refusals.ts";
import type {
  IntegrationRecord,
  IntegrationWrite,
  LoginDriverEvents,
  LoginRun,
  VaultCredential,
  VaultPort,
} from "./vaultPort.ts";

const REDIAL_MIN_MS = 500;
const REDIAL_MAX_MS = 10_000;
/** A credential read the vault has not answered by then is refused. */
const CREDENTIAL_TIMEOUT_MS = 30_000;
const KEEPALIVE_MS = 15_000;
/** Dial, TLS handshake and `vault.hello` each get this long. */
const CONNECT_TIMEOUT_MS = 10_000;
/** An integration call the vault has not answered by then is unavailable. */
const INTEGRATION_TIMEOUT_MS = 10_000;

const UNAVAILABLE: VaultCredential = {
  ok: false,
  refusal: { case: "vault-unavailable" },
};

/** Where the edge reaches the vault, and the pinned link TLS. */
export interface RemoteVaultOptions {
  host: string;
  port: number;
  tls: VaultLinkTls;
  /** Test seam: the integration calls' deadline; 10 s. */
  integrationTimeoutMs?: number;
}

interface RemoteVaultDeps {
  /** The edge's whole profile registry, as `inputs.profiles` sends it. */
  profiles(): GatewayProfile[];
  /** The profiles with a live lease. */
  liveLeases(): string[];
  /** A profile's needs-login changed, as the vault told. */
  report(profileId: string, needsLogin: boolean): void;
  log(line: string): void;
  /** Test seam: the dial, TLS and hello deadline; 10 s. */
  connectTimeoutMs?: number;
}

export interface RemoteVault extends VaultPort {
  /** The edge's registry or leases changed: the inputs are sent again. */
  inputsChanged(): void;
  /** Whether the link is up; tests wait on it. */
  connected(): boolean;
  close(): void;
}

interface PendingLogin {
  events: LoginDriverEvents;
  /** The edge's own check, which the vault asks before moving it in. */
  commit(): boolean | Promise<boolean>;
  settle(error?: Error): void;
}

/** The edge's own text for a failure the vault names by code. */
const LOGIN_FAILURE_TEXT: Record<LoginFailure, string> = {
  cancelled: "The login was cancelled.",
  failed: "The login failed.",
};

const CREDENTIAL_PROBLEMS: readonly CredentialProblem[] = [
  "missing",
  "unreadable",
  "malformed",
];

/** A Node socket error's code, the only error text logged here. */
function socketErrorCode(err: unknown): string {
  const code =
    err instanceof Error && "code" in err ? String(err.code) : undefined;
  return code && /^E[A-Z_]{1,40}$/.test(code) ? code : "connection failed";
}

export function createRemoteVault(
  options: RemoteVaultOptions,
  deps: RemoteVaultDeps,
): RemoteVault {
  const { log } = deps;
  const pinned = new X509Certificate(options.tls.peerCertPem).fingerprint256;
  let connection: WorkerConnection | undefined;
  let accountsDir: string | undefined;
  let loginKinds = new Set<string>();
  const needing = new Set<string>();
  let closing = false;
  let redial: ReturnType<typeof setTimeout> | undefined;
  let backoff = REDIAL_MIN_MS;
  let lastSent: { profiles: string; liveLeases: string } | undefined;
  let sendQueued = false;
  const logins = new Map<string, PendingLogin>();
  const connectTimeoutMs = deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  /** The socket being dialed, so `close` can stop it. */
  let dialing: tls.TLSSocket | undefined;
  /** The connection waiting for its hello answer, likewise. */
  let opening: WorkerConnection | undefined;

  /**
   * The vault's answer as the edge's own value: a needs-login refusal names
   * the edge's registry entry, any other refusal is one this side knows, and
   * anything else is unavailable.
   */
  const decodeCredential = (
    binding: LoginBinding,
    value: unknown,
  ): VaultCredential => {
    if (typeof value !== "object" || value === null) return UNAVAILABLE;
    const answer = value as Record<string, unknown>;
    if (answer.ok === true) {
      const { headers, token } = answer;
      if (
        typeof token !== "string" ||
        typeof headers !== "object" ||
        headers === null ||
        Object.values(headers).some((v) => typeof v !== "string")
      )
        return UNAVAILABLE;
      return { ok: true, headers: headers as Record<string, string>, token };
    }
    if (answer.locked === true) return { ok: false, locked: true };
    const refusal = answer.refusal as Record<string, unknown> | undefined;
    if (refusal?.case === "needs-login") {
      const profile = deps
        .profiles()
        .find((candidate) => candidate.id === binding.profileId);
      return profile
        ? { ok: false, refusal: { case: "needs-login", name: profile.name } }
        : UNAVAILABLE;
    }
    const problem = CREDENTIAL_PROBLEMS.find((p) => p === refusal?.problem);
    return refusal?.case === "credential" && problem
      ? { ok: false, refusal: { case: "credential", problem } }
      : UNAVAILABLE;
  };

  const setNeedsLogin = (profileId: string, needsLogin: boolean): void => {
    if (needing.has(profileId) === needsLogin) return;
    if (needsLogin) needing.add(profileId);
    else needing.delete(profileId);
    deps.report(profileId, needsLogin);
  };

  const sendInputs = (open: WorkerConnection, force: boolean): void => {
    const profiles = JSON.stringify(deps.profiles());
    const liveLeases = JSON.stringify([...new Set(deps.liveLeases())].sort());
    const failed = (): void => log("vault inputs not sent");
    if (force || lastSent?.profiles !== profiles)
      open
        .request(
          VAULT_METHODS.profiles,
          vaultMessage({ profiles: JSON.parse(profiles) as unknown }),
        )
        .catch(failed);
    if (force || lastSent?.liveLeases !== liveLeases)
      open
        .request(
          VAULT_METHODS.liveLeases,
          vaultMessage({ profileIds: JSON.parse(liveLeases) as unknown }),
        )
        .catch(failed);
    lastSent = { profiles, liveLeases };
  };

  const handlers: Record<string, MethodHandler> = {
    [VAULT_METHODS.report]: (payload) => {
      const { profileId, needsLogin } = vaultBody(payload);
      if (typeof profileId === "string" && typeof needsLogin === "boolean")
        setNeedsLogin(profileId, needsLogin);
      return Promise.resolve(vaultMessage({}));
    },
    [VAULT_METHODS.loginEvent]: (payload) => {
      const { loginId, type, text } = vaultBody(payload);
      const login =
        typeof loginId === "string" ? logins.get(loginId) : undefined;
      if (login && typeof text === "string") {
        if (type === "output") login.events.output(text);
        else if (type === "url") login.events.url(text);
        else if (type === "code") login.events.code(text);
      }
      return Promise.resolve(vaultMessage({}));
    },
    [VAULT_METHODS.loginDone]: (payload) => {
      const { loginId, ok, error } = vaultBody(payload);
      const login =
        typeof loginId === "string" ? logins.get(loginId) : undefined;
      if (login)
        login.settle(
          ok === true
            ? undefined
            : new Error(
                LOGIN_FAILURE_TEXT[
                  error === "cancelled" ? "cancelled" : "failed"
                ],
              ),
        );
      return Promise.resolve(vaultMessage({}));
    },
    // Asked in the vault's writer lane: the edge's own check decides.
    [VAULT_METHODS.loginCommit]: async (payload) => {
      const { loginId } = vaultBody(payload);
      const login =
        typeof loginId === "string" ? logins.get(loginId) : undefined;
      let commit = false;
      try {
        commit = login ? (await login.commit()) === true : false;
      } catch {
        commit = false;
      }
      return vaultMessage({ commit });
    },
  };

  const schedule = (): void => {
    if (closing || redial) return;
    redial = setTimeout(() => void connect(), backoff);
    redial.unref();
    backoff = Math.min(backoff * 2, REDIAL_MAX_MS);
  };

  /** Dials and completes TLS within the deadline, or destroys the socket. */
  const dial = (): Promise<tls.TLSSocket> =>
    new Promise((resolveSocket, reject) => {
      const socket = tls.connect({
        host: options.host,
        port: options.port,
        key: options.tls.keyPem,
        cert: options.tls.certPem,
        ca: options.tls.peerCertPem,
        // Pinned on `secureConnect` (`isPinnedPeer`): the vault's certificate
        // itself, whatever name it holds, before any frame.
        rejectUnauthorized: false,
      });
      dialing = socket;
      const timer = setTimeout(() => {
        const err = Object.assign(new Error("dial timed out"), {
          code: "ETIMEDOUT",
        });
        socket.destroy(err);
      }, connectTimeoutMs);
      const settle = (): void => {
        clearTimeout(timer);
        if (dialing === socket) dialing = undefined;
      };
      socket.once("secureConnect", () => {
        if (!isPinnedPeer(socket, pinned)) {
          socket.destroy(
            new Error("the vault's certificate is not the pinned one"),
          );
          return;
        }
        settle();
        resolveSocket(socket);
      });
      socket.on("error", (err: Error) => {
        settle();
        reject(err);
      });
      socket.once("close", () => {
        settle();
        reject(new Error("closed while dialing"));
      });
    });

  const connect = async (): Promise<void> => {
    redial = undefined;
    let opened: WorkerConnection | undefined;
    try {
      const socket = await dial();
      socket.setKeepAlive(true, KEEPALIVE_MS);
      opened = new WorkerConnection(socketEndpoint(socket), {
        handshake: { role: "worker", workerId: "pandeck-gateway-edge" },
        protocol: GATEWAY_VAULT_PROTOCOL,
        handlers,
        limits: VAULT_LIMITS,
        onEnd: (_reason, { cause }) => {
          if (connection === opened) {
            connection = undefined;
            // Not a settlement: the vault may still run them.
            for (const login of logins.values())
              login.settle(
                new LoginOutcomeUnknown("The vault became unavailable."),
              );
            logins.clear();
            // The cause only: the reason may carry the vault's words.
            log(`vault link ended (${cause})`);
          }
          schedule();
        },
      });
      opening = opened;
      let helloTimer: ReturnType<typeof setTimeout> | undefined;
      const hello = vaultBody(
        await Promise.race([
          opened.request(VAULT_METHODS.hello, vaultMessage({})),
          new Promise<never>((_resolve, reject) => {
            helloTimer = setTimeout(
              () =>
                reject(
                  Object.assign(new Error("hello timed out"), {
                    code: "ETIMEDOUT",
                  }),
                ),
              connectTimeoutMs,
            );
          }),
        ]).finally(() => {
          clearTimeout(helloTimer);
          opening = undefined;
        }),
      );
      if (closing) {
        opened.end("the vault link closed");
        return;
      }
      accountsDir =
        typeof hello.accountsDir === "string" ? hello.accountsDir : undefined;
      loginKinds = new Set(
        Array.isArray(hello.loginKinds)
          ? hello.loginKinds.filter((kind) => typeof kind === "string")
          : [],
      );
      const told = new Set(
        Array.isArray(hello.needsLogin)
          ? hello.needsLogin.filter((id) => typeof id === "string")
          : [],
      );
      for (const id of needing) if (!told.has(id)) setNeedsLogin(id, false);
      for (const id of told) setNeedsLogin(id, true);
      connection = opened;
      backoff = REDIAL_MIN_MS;
      sendInputs(opened, true);
      log(
        `vault link up at ${options.host}:${options.port}${hello.locked === true ? " (vault locked)" : ""}`,
      );
    } catch (err) {
      opened?.end("the vault hello failed");
      log(`vault unreachable: ${socketErrorCode(err)}`);
      schedule();
    }
  };

  const request = (method: string, json: unknown) => {
    if (!connection) return Promise.reject(new Error("no vault link"));
    return connection.request(method, vaultMessage(json));
  };

  const integrationTimeoutMs =
    options.integrationTimeoutMs ?? INTEGRATION_TIMEOUT_MS;
  /**
   * One integration request, bounded (Task-1397): no link, the deadline or
   * `signal` first, or any request error answers unavailable; `VAULT_LOCKED`
   * answers locked. A late reply settles a promise nobody reads.
   */
  const integrationCall = async <T>(
    method: string,
    json: unknown,
    decode: (body: Record<string, unknown>) => T,
    signal?: AbortSignal,
  ): Promise<
    T | { ok: false; locked: true } | { ok: false; unavailable: true }
  > => {
    const unavailable = { ok: false, unavailable: true } as const;
    if (!connection || signal?.aborted) return unavailable;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = (): void => {};
    const giveUp = new Promise<typeof unavailable>((resolveGiveUp) => {
      timer = setTimeout(
        () => resolveGiveUp(unavailable),
        integrationTimeoutMs,
      );
      onAbort = () => resolveGiveUp(unavailable);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    const sent = request(method, json);
    sent.catch(() => {});
    try {
      return await Promise.race([
        sent.then((payload) => decode(vaultBody(payload))),
        giveUp,
      ]);
    } catch (err) {
      return err instanceof WorkerRequestError && err.code === VAULT_LOCKED
        ? { ok: false, locked: true }
        : unavailable;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
  const decodeRecord = (body: Record<string, unknown>): IntegrationRecord => {
    const record = body.record;
    if (typeof record !== "object" || record === null)
      return { ok: false, unavailable: true };
    const r = record as Record<string, unknown>;
    if (r.ok === true && typeof r.credential === "string")
      return { ok: true, credential: r.credential };
    if (r.absent === true) return { ok: false, absent: true };
    if (r.locked === true) return { ok: false, locked: true };
    return { ok: false, unavailable: true };
  };
  const written = (): IntegrationWrite => ({ ok: true });

  void connect();

  return {
    async credentialFor(binding: LoginBinding): Promise<VaultCredential> {
      if (!connection) return UNAVAILABLE;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<VaultCredential>((resolveTimeout) => {
        timer = setTimeout(
          () => resolveTimeout(UNAVAILABLE),
          CREDENTIAL_TIMEOUT_MS,
        );
      });
      try {
        return await Promise.race([
          request(VAULT_METHODS.credentialFor, { binding }).then((payload) =>
            decodeCredential(binding, vaultBody(payload).credential),
          ),
          timeout,
        ]);
      } catch (err) {
        // A binding the vault does not keep is refused like any other.
        if (err instanceof WorkerRequestError && err.code === OUTSIDE_ACCOUNTS)
          return { ok: false, refusal: { case: "forbidden" } };
        return UNAVAILABLE;
      } finally {
        clearTimeout(timer);
      }
    },
    upstream401(binding, sentToken) {
      request(VAULT_METHODS.upstream401, { binding, sentToken }).catch(() =>
        log("vault upstream401 not delivered"),
      );
    },
    needsLogin: () => [...needing],
    login(login, events): LoginRun | undefined {
      if (!connection || !loginKinds.has(login.kind)) return undefined;
      const loginId = randomBytes(12).toString("base64url");
      let settle!: (error?: Error) => void;
      const done = new Promise<void>((resolveDone, reject) => {
        settle = (error) => {
          logins.delete(loginId);
          if (error) reject(error);
          else resolveDone();
        };
      });
      logins.set(loginId, { events, commit: login.commit, settle });
      request(VAULT_METHODS.loginStart, {
        loginId,
        kind: login.kind,
        accountId: login.accountId,
        tokenFile: login.tokenFile,
      }).catch((err: unknown) =>
        settle(
          // Only the vault's own answer, or a start never sent, proves the
          // driver never ran; a lost link leaves it unknown.
          err instanceof WorkerRequestError ||
            err instanceof WorkerRequestNotSentError
            ? new LoginNotRun("This gateway cannot run that login now.")
            : new LoginOutcomeUnknown("The vault became unavailable."),
        ),
      );
      return {
        input: (text) => {
          request(VAULT_METHODS.loginInput, { loginId, text }).catch(() => {});
        },
        // The vault withdraws the run too: its credential is never moved in.
        cancel: () => {
          request(VAULT_METHODS.loginCancel, { loginId }).catch(() => {});
        },
        done,
      };
    },
    newTokenFile(kind: LeaseProvider, accountId: string): string {
      const file =
        accountsDir && accountTokenFile(accountsDir, kind, accountId);
      if (!file) throw new Error("The vault is unavailable.");
      return file;
    },
    discardCredential(accountId) {
      request(VAULT_METHODS.discard, { accountId }).catch(() =>
        log(`vault discard of account ${accountId} not delivered`),
      );
    },
    integrationPut: (userId, integration, credential) =>
      integrationCall(
        VAULT_METHODS.integrationPut,
        { userId, integration, credential },
        written,
      ),
    integrationGet: (userId, integration, { signal } = {}) =>
      integrationCall(
        VAULT_METHODS.integrationGet,
        { userId, integration },
        decodeRecord,
        signal,
      ),
    integrationClear: (userId, integration) =>
      integrationCall(
        VAULT_METHODS.integrationClear,
        { userId, integration },
        written,
      ),
    inputsChanged() {
      if (sendQueued) return;
      sendQueued = true;
      queueMicrotask(() => {
        sendQueued = false;
        if (connection) sendInputs(connection, false);
      });
    },
    connected: () => connection !== undefined,
    close() {
      closing = true;
      if (redial) clearTimeout(redial);
      dialing?.destroy();
      opening?.end("the vault link closed");
      connection?.end("the vault link closed");
    },
  };
}
