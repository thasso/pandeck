/**
 * The vault as its own process (plan Task-1394, ADR-0005): today's
 * `createVault` (renewal, token files, the writer lane, login runs) served to
 * one edge over `gateway-vault/1.0` (`vaultMethods.ts`) on mutual TLS. Each
 * side trusts exactly the other's self-signed certificate, also checked by
 * fingerprint. A newer edge connection replaces the older one.
 *
 * The vault's inputs are the edge's: the profile registry and the set of
 * profiles with a live lease, mirrored here and saved to
 * `<stateDir>/vault-inputs.json`, so it keeps renewing across its own restart
 * and while the edge is away. It keeps only login profiles whose token file is
 * under `<stateDir>/accounts/`, and refuses any binding outside it.
 *
 * It answers access tokens only: never a refresh token or a token file's
 * content. No log line holds a token, a login's input or its output.
 */
import { X509Certificate } from "node:crypto";
import type net from "node:net";
import { join, relative, resolve, isAbsolute } from "node:path";
import tls from "node:tls";
import { createPrivateJsonFile } from "../privateJsonFile.ts";
import type { Payload } from "../workerProtocol/codec.ts";
import {
  WorkerConnection,
  WorkerMethodError,
  type MethodHandler,
} from "../workerProtocol/connection.ts";
import { socketEndpoint } from "../workerProtocol/unixSocketTransport.ts";
import type { LoginBinding } from "./leases.ts";
import {
  ProfileRegistry,
  isLeaseProvider,
  isLoginProfile,
  isProfileId,
  parseProfile,
  type GatewayProfile,
  type LoginProfile,
} from "./profiles.ts";
import { RENEW_TICK_MS, type CodexRenewPort } from "./renewal.ts";
import { createVault } from "./vault.ts";
import {
  GATEWAY_VAULT_PROTOCOL,
  GATEWAY_VAULT_VERSION,
  LOGIN_UNAVAILABLE,
  MAX_VAULT_LOGINS,
  OUTSIDE_ACCOUNTS,
  VAULT_LIMITS,
  VAULT_INVALID_PARAMS,
  VAULT_METHODS,
  accountTokenFile,
  vaultBody,
  vaultMessage,
  type LoginFailure,
  type VaultLinkTls,
} from "./vaultMethods.ts";
import type { LoginDrivers, LoginRun } from "./vaultPort.ts";

const HANDSHAKE_TIMEOUT_MS = 10_000;
const KEEPALIVE_MS = 15_000;
const LOGIN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_INPUT_CHARS = 8_192;
/** A login ends after this long, as the edge's do (`logins.ts`). */
const LOGIN_TIMEOUT_MS = 10 * 60_000;
/** How long the edge has to answer `logins.commit`. */
const COMMIT_TIMEOUT_MS = 10_000;

export interface VaultServerOptions {
  stateDir: string;
  /** Where the link listens; `127.0.0.1` and a free port unless given. */
  host?: string;
  port?: number;
  tls: VaultLinkTls;
  /** pi's Codex refresh; without it a Codex renewal fails (`no_port`). */
  renewCodex?: CodexRenewPort;
  loginDrivers?: LoginDrivers;
  log?: (line: string) => void;
  /** Test seam: the login deadline, 10 minutes. */
  loginTimeoutMs?: number;
}

export interface RunningVaultServer {
  readonly port: number;
  /** Runs one renewal tick now, as the timer does. */
  renewDue(): Promise<void>;
  close(): Promise<void>;
}

interface MirroredInputs {
  v: 1;
  profiles: GatewayProfile[];
  liveLeases: string[];
}

interface ServedLogin {
  connection: WorkerConnection;
  accountId: string;
  run: LoginRun;
  withdrawn: boolean;
}

function invalid(what: string): WorkerMethodError {
  return new WorkerMethodError(VAULT_INVALID_PARAMS, `Invalid ${what}.`);
}

export async function startVaultServer(
  options: VaultServerOptions,
): Promise<RunningVaultServer> {
  const log = options.log ?? ((line: string) => console.log(`[vault] ${line}`));
  const loginTimeoutMs = options.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
  const accountsDir = join(resolve(options.stateDir), "accounts");
  const pinned = new X509Certificate(options.tls.peerCertPem).fingerprint256;

  const underAccounts = (file: string): boolean => {
    const rel = relative(accountsDir, resolve(file));
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  /** Only login profiles whose token file is the vault's to keep. */
  const admitted = (value: unknown): LoginProfile | undefined => {
    const profile = parseProfile(value);
    return profile &&
      isLoginProfile(profile) &&
      underAccounts(profile.tokenFile)
      ? profile
      : undefined;
  };

  // --- mirrored inputs ----------------------------------------------------

  const inputsFile = createPrivateJsonFile(
    join(options.stateDir, "vault-inputs.json"),
    "vault inputs",
    { privateDirectory: "enforce" },
  );
  let liveLeases = new Set<string>();
  const persistInputs = (): void => {
    try {
      inputsFile.write({
        v: 1,
        profiles: profiles.ids().map((id) => profiles.get(id)!),
        liveLeases: [...liveLeases],
      } satisfies MirroredInputs);
    } catch {
      log("vault-inputs.json not saved; the inputs stand in memory");
    }
  };
  const profiles = new ProfileRegistry(() => persistInputs());
  try {
    const saved = inputsFile.read<MirroredInputs, MirroredInputs | undefined>(
      (value) => (value?.v === 1 ? value : undefined),
    );
    if (saved) {
      profiles.restore(
        (Array.isArray(saved.profiles) ? saved.profiles : []).flatMap(
          (value) => admitted(value) ?? [],
        ),
      );
      liveLeases = new Set(
        (Array.isArray(saved.liveLeases) ? saved.liveLeases : []).filter(
          isProfileId,
        ),
      );
    }
  } catch {
    log("vault-inputs.json unreadable; starting with no inputs");
  }

  // --- the vault ----------------------------------------------------------

  let current: WorkerConnection | undefined;
  const logins = new Map<string, ServedLogin>();
  const tell = (method: string, json: unknown): void => {
    current?.request(method, vaultMessage(json)).catch(() => {});
  };
  const vault = createVault({
    inputs: {
      profiles,
      hasLiveLease: (profileId) => liveLeases.has(profileId),
      report: (profileId, needsLogin) =>
        tell(VAULT_METHODS.report, { profileId, needsLogin }),
    },
    log,
    holds: {},
    renewal: { renewCodex: options.renewCodex },
    logins: { stateDir: options.stateDir, drivers: options.loginDrivers ?? {} },
  });

  /** The request's binding when it is the mirrored profile's own. */
  const bindingOf = (value: unknown): LoginBinding => {
    if (typeof value !== "object" || value === null) throw invalid("binding");
    const { profileId, provider, tokenFile } = value as Record<string, unknown>;
    if (
      !isProfileId(profileId) ||
      !isLeaseProvider(provider) ||
      typeof tokenFile !== "string"
    )
      throw invalid("binding");
    const profile = profiles.get(profileId);
    if (
      !underAccounts(tokenFile) ||
      !profile ||
      !isLoginProfile(profile) ||
      profile.provider !== provider ||
      resolve(profile.tokenFile) !== resolve(tokenFile)
    )
      throw new WorkerMethodError(
        OUTSIDE_ACCOUNTS,
        "The vault keeps no such credential.",
      );
    return { profileId, provider, tokenFile: profile.tokenFile };
  };

  const withdraw = (login: ServedLogin): void => {
    login.withdrawn = true;
    login.run.cancel();
  };

  /**
   * In the account's writer lane: the edge's own commit check, asked over the
   * link. Anything but its explicit `true` in time, from the connection that
   * started the login, fails closed.
   */
  const commitLogin = async (
    login: ServedLogin,
    loginId: string,
  ): Promise<boolean> => {
    if (login.withdrawn || current !== login.connection) {
      login.withdrawn = true;
      return false;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answer = await Promise.race([
        login.connection.request(
          VAULT_METHODS.loginCommit,
          vaultMessage({ loginId }),
        ),
        new Promise<undefined>((resolveLate) => {
          timer = setTimeout(() => resolveLate(undefined), COMMIT_TIMEOUT_MS);
        }),
      ]);
      const commit =
        answer !== undefined &&
        vaultBody(answer).commit === true &&
        !login.withdrawn &&
        current === login.connection;
      // A refused commit is a withdrawal: the login ends cancelled.
      if (!commit) login.withdrawn = true;
      return commit;
    } catch {
      login.withdrawn = true;
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  const ownedLogin = (
    connection: WorkerConnection,
    loginId: unknown,
  ): ServedLogin | undefined => {
    const login = typeof loginId === "string" ? logins.get(loginId) : undefined;
    return login?.connection === connection ? login : undefined;
  };

  const handlersFor = (
    connection: WorkerConnection,
  ): Record<string, (body: Record<string, unknown>) => unknown> => ({
    [VAULT_METHODS.hello]: () => ({
      version: GATEWAY_VAULT_VERSION,
      needsLogin: vault.needsLogin(),
      accountsDir,
      loginKinds: Object.keys(options.loginDrivers ?? {}),
    }),
    [VAULT_METHODS.profiles]: (body) => {
      if (!Array.isArray(body.profiles)) throw invalid("profiles");
      const kept = body.profiles.flatMap((value) => admitted(value) ?? []);
      if (kept.length < body.profiles.length)
        log(
          `inputs: ${body.profiles.length - kept.length} profiles not kept (no login or outside the accounts directory)`,
        );
      profiles.sync(kept);
      return {};
    },
    [VAULT_METHODS.liveLeases]: (body) => {
      if (!Array.isArray(body.profileIds)) throw invalid("live leases");
      liveLeases = new Set(body.profileIds.filter(isProfileId));
      persistInputs();
      return {};
    },
    [VAULT_METHODS.credentialFor]: async (body) => ({
      credential: await vault.credentialFor(bindingOf(body.binding)),
    }),
    [VAULT_METHODS.upstream401]: (body) => {
      if (typeof body.sentToken !== "string") throw invalid("token");
      vault.upstream401(bindingOf(body.binding), body.sentToken);
      return {};
    },
    [VAULT_METHODS.discard]: (body) => {
      if (!isProfileId(body.accountId)) throw invalid("account");
      vault.discardCredential(body.accountId);
      return {};
    },
    [VAULT_METHODS.loginStart]: (body) => {
      const { loginId, kind, accountId, tokenFile } = body;
      if (
        typeof loginId !== "string" ||
        !LOGIN_ID_RE.test(loginId) ||
        logins.has(loginId) ||
        !isLeaseProvider(kind) ||
        typeof accountId !== "string"
      )
        throw invalid("login");
      const own = accountTokenFile(accountsDir, kind, accountId);
      if (!own || tokenFile !== own)
        throw new WorkerMethodError(
          OUTSIDE_ACCOUNTS,
          "The vault keeps no such credential.",
        );
      // The vault's own admission: the edge's is not trusted.
      const running = [...logins.values()];
      if (
        running.length >= MAX_VAULT_LOGINS ||
        running.some((login) => login.accountId === accountId)
      )
        throw new WorkerMethodError(
          LOGIN_UNAVAILABLE,
          "The vault runs no more logins now.",
        );
      const served = {
        connection,
        accountId,
        withdrawn: false,
      } as ServedLogin;
      const event = (type: string) => (text: string) =>
        tell(VAULT_METHODS.loginEvent, { loginId, type, text });
      const run = vault.login(
        {
          kind,
          accountId,
          tokenFile: own,
          commit: () => commitLogin(served, loginId),
        },
        { output: event("output"), url: event("url"), code: event("code") },
      );
      if (!run)
        throw new WorkerMethodError(
          LOGIN_UNAVAILABLE,
          "The vault runs no such login.",
        );
      served.run = run;
      logins.set(loginId, served);
      log(`login ${loginId} (account ${accountId}): started`);
      const deadline = setTimeout(() => {
        log(`login ${loginId} (account ${accountId}): timed out`);
        withdraw(served);
      }, loginTimeoutMs);
      deadline.unref();
      void run.done
        .then(
          (): { ok: true } | { ok: false; error: LoginFailure } => ({
            ok: true,
          }),
          () => ({
            ok: false,
            error: served.withdrawn ? "cancelled" : "failed",
          }),
        )
        .then((outcome) => {
          clearTimeout(deadline);
          logins.delete(loginId);
          log(
            `login ${loginId} (account ${accountId}): ${outcome.ok ? "done" : outcome.error}`,
          );
          if (current === connection)
            tell(VAULT_METHODS.loginDone, { loginId, ...outcome });
        });
      return {};
    },
    [VAULT_METHODS.loginInput]: (body) => {
      const login = ownedLogin(connection, body.loginId);
      // Never logged: it may be an authorization code.
      if (
        login &&
        typeof body.text === "string" &&
        body.text.length <= MAX_INPUT_CHARS
      )
        login.run.input(body.text);
      return {};
    },
    [VAULT_METHODS.loginCancel]: (body) => {
      const login = ownedLogin(connection, body.loginId);
      if (login) withdraw(login);
      return {};
    },
  });

  const attach = (socket: tls.TLSSocket): void => {
    socket.setKeepAlive(true, KEEPALIVE_MS);
    const handlers: Record<string, MethodHandler> = {};
    const connection: WorkerConnection = new WorkerConnection(
      socketEndpoint(socket),
      {
        protocol: GATEWAY_VAULT_PROTOCOL,
        handshake: {
          role: "server",
          admit: (hello) =>
            GATEWAY_VAULT_PROTOCOL.compatible(hello.version)
              ? undefined
              : `this vault speaks ${GATEWAY_VAULT_VERSION} only`,
        },
        handlers,
        limits: VAULT_LIMITS,
        onEnd: (_reason, { cause }) => {
          // The edge that started them is gone: none of its logins commits.
          // Each stays counted until its driver has ended.
          for (const login of logins.values())
            if (login.connection === connection) withdraw(login);
          if (current === connection) {
            current = undefined;
            // The cause only: the reason may carry the peer's words.
            log(`edge disconnected (${cause})`);
          }
        },
      },
    );
    for (const [method, body] of Object.entries(handlersFor(connection)))
      handlers[method] = async (payload: Payload) => {
        try {
          return vaultMessage(await body(vaultBody(payload)));
        } catch (err) {
          if (err instanceof WorkerMethodError) {
            log(`${method}: ${err.code}`);
            throw err;
          }
          log(`${method}: failed`);
          throw new WorkerMethodError("failed", "The vault request failed.");
        }
      };
    const older = current;
    current = connection;
    older?.end("replaced by a newer edge connection");
    log("edge connected");
  };

  const sockets = new Set<net.Socket>();
  const server = tls.createServer(
    {
      key: options.tls.keyPem,
      cert: options.tls.certPem,
      ca: options.tls.peerCertPem,
      requestCert: true,
      rejectUnauthorized: true,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    },
    (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      if (socket.getPeerCertificate().fingerprint256 !== pinned) {
        log("edge connection refused: unpinned certificate");
        socket.destroy();
        return;
      }
      attach(socket);
    },
  );
  server.on("tlsClientError", (_err, socket) => {
    log("edge connection refused: TLS handshake failed");
    socket.destroy();
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  log(`listening on ${options.host ?? "127.0.0.1"}:${port}`);

  const renewTick = setInterval(() => {
    vault.renewDue().catch(() => log("renewal tick failed"));
  }, RENEW_TICK_MS);
  renewTick.unref();

  return {
    port,
    renewDue: vault.renewDue,
    async close() {
      clearInterval(renewTick);
      current?.end("the vault is stopping");
      const closed = new Promise<void>((done) => server.close(() => done()));
      for (const socket of sockets) socket.destroy();
      vault.close();
      await closed;
    },
  };
}
