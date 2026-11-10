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
  type MethodHandler,
} from "../workerProtocol/connection.ts";
import { socketEndpoint } from "../workerProtocol/unixSocketTransport.ts";
import type { LeaseProvider, LoginBinding } from "./leases.ts";
import type { GatewayProfile } from "./profiles.ts";
import {
  GATEWAY_VAULT_PROTOCOL,
  OUTSIDE_ACCOUNTS,
  VAULT_METHODS,
  accountTokenFile,
  vaultBody,
  vaultMessage,
  type VaultLinkTls,
} from "./vaultMethods.ts";
import type {
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

const UNAVAILABLE: VaultCredential = {
  ok: false,
  refusal: { case: "vault-unavailable" },
};

/** Where the edge reaches the vault, and the pinned link TLS. */
export interface RemoteVaultOptions {
  host: string;
  port: number;
  tls: VaultLinkTls;
}

interface RemoteVaultDeps {
  /** The edge's whole profile registry, as `inputs.profiles` sends it. */
  profiles(): GatewayProfile[];
  /** The profiles with a live lease. */
  liveLeases(): string[];
  /** A profile's needs-login changed, as the vault told. */
  report(profileId: string, needsLogin: boolean): void;
  log(line: string): void;
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
  settle(error?: Error): void;
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
                typeof error === "string" ? error : "The login failed.",
              ),
        );
      return Promise.resolve(vaultMessage({}));
    },
  };

  const schedule = (): void => {
    if (closing || redial) return;
    redial = setTimeout(() => void connect(), backoff);
    redial.unref();
    backoff = Math.min(backoff * 2, REDIAL_MAX_MS);
  };

  const dial = (): Promise<tls.TLSSocket> =>
    new Promise((resolveSocket, reject) => {
      const socket = tls.connect({
        host: options.host,
        port: options.port,
        key: options.tls.keyPem,
        cert: options.tls.certPem,
        ca: options.tls.peerCertPem,
        // Pinned: the vault's certificate itself, whatever name it holds.
        checkServerIdentity: (_host, cert) =>
          cert.fingerprint256 === pinned
            ? undefined
            : new Error("the vault's certificate is not the pinned one"),
      });
      socket.once("secureConnect", () => resolveSocket(socket));
      socket.on("error", reject);
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
        onEnd: (reason) => {
          if (connection === opened) {
            connection = undefined;
            for (const login of logins.values())
              login.settle(new Error("The vault became unavailable."));
            logins.clear();
            log(`vault link ended: ${reason}`);
          }
          schedule();
        },
      });
      const hello = vaultBody(
        await opened.request(VAULT_METHODS.hello, vaultMessage({})),
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
      log(`vault link up at ${options.host}:${options.port}`);
    } catch (err) {
      opened?.end("the vault hello failed");
      log(
        `vault unreachable: ${err instanceof Error && "code" in err ? String(err.code) : "connection failed"}`,
      );
      schedule();
    }
  };

  const request = (method: string, json: unknown) => {
    if (!connection) return Promise.reject(new Error("no vault link"));
    return connection.request(method, vaultMessage(json));
  };

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
          request(VAULT_METHODS.credentialFor, { binding }).then(
            (payload) => vaultBody(payload).credential as VaultCredential,
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
      logins.set(loginId, { events, settle });
      request(VAULT_METHODS.loginStart, {
        loginId,
        kind: login.kind,
        accountId: login.accountId,
        tokenFile: login.tokenFile,
      }).catch(() =>
        settle(new Error("This gateway cannot run that login now.")),
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
      connection?.end("the vault link closed");
    },
  };
}
