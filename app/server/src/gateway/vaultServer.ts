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
 *
 * With recipients (plan Task-1395, `sealedStore.ts`) the disk holds only
 * sealed records and the vault starts locked: until a human unlocks it over
 * the control socket (`vaultControl.ts`), a credential read answers locked,
 * renewal and the sweep skip, `upstream401` is dropped and logins are
 * refused. `vault.hello` tells the edge.
 */
import { X509Certificate } from "node:crypto";
import type net from "node:net";
import { basename, join, relative, resolve, isAbsolute } from "node:path";
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
import type { PivHelperCommand } from "./pivChild.ts";
import { RENEW_TICK_MS, type CodexRenewPort } from "./renewal.ts";
import { createSealedStore } from "./sealedStore.ts";
import { createVault } from "./vault.ts";
import { startVaultControl, type VaultControl } from "./vaultControl.ts";
import {
  GATEWAY_VAULT_PROTOCOL,
  GATEWAY_VAULT_VERSION,
  LOGIN_CREDENTIAL_FILE,
  LOGIN_UNAVAILABLE,
  MAX_INTEGRATION_CREDENTIAL,
  LOGIN_COMMIT_TIMEOUT_MS,
  MAX_VAULT_LOGINS,
  VAULT_LOGIN_SETTLE_GRACE_MS,
  VAULT_LOGIN_TIMEOUT_MS,
  OUTSIDE_ACCOUNTS,
  VAULT_LIMITS,
  VAULT_INVALID_PARAMS,
  VAULT_LOCKED,
  VAULT_METHODS,
  accountTokenFile,
  isIntegration,
  isPinnedPeer,
  isVaultId,
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
/** A login is withdrawn after this long, as the edge's are (`logins.ts`). */
const LOGIN_TIMEOUT_MS = VAULT_LOGIN_TIMEOUT_MS;
/** How long the edge has to answer `logins.commit`. */
const COMMIT_TIMEOUT_MS = LOGIN_COMMIT_TIMEOUT_MS;

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
  /** Test seam: past the deadline, how long until a run reports done anyway. */
  loginSettleGraceMs?: number;
  /** A sealing vault's control socket; without it nothing can unlock it. */
  controlSocket?: string;
  /** A sealing vault refuses to start unless `accounts/` is a tmpfs. */
  requireTmpfs?: boolean;
  /** Test seam: the YubiKey helper (`pivChild.ts`). */
  pivHelper?: PivHelperCommand;
}

export interface RunningVaultServer {
  readonly port: number;
  /** Runs one renewal tick now, as the timer does. */
  renewDue(): Promise<void>;
  /**
   * Stops admitting at once, then resolves once every login and renewal has
   * ended and every credential is sealed. It rejects with a fixed text,
   * naming only the record directories (ID-checked), when one could not be
   * sealed. Once.
   */
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
  /** The edge's commit exchange, while it runs. */
  committing?: Promise<boolean> | undefined;
}

function invalid(what: string): WorkerMethodError {
  return new WorkerMethodError(VAULT_INVALID_PARAMS, `Invalid ${what}.`);
}

export async function startVaultServer(
  options: VaultServerOptions,
): Promise<RunningVaultServer> {
  const log = options.log ?? ((line: string) => console.log(`[vault] ${line}`));
  const loginTimeoutMs = options.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
  const loginSettleGraceMs =
    options.loginSettleGraceMs ?? VAULT_LOGIN_SETTLE_GRACE_MS;
  const accountsDir = join(resolve(options.stateDir), "accounts");
  const pinned = new X509Certificate(options.tls.peerCertPem).fingerprint256;

  const underAccounts = (file: string): boolean => {
    const rel = relative(accountsDir, resolve(file));
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  const loginFiles = new Set(Object.values(LOGIN_CREDENTIAL_FILE));
  /**
   * Only login profiles whose token file is the vault's to keep, and a login
   * credential file: no profile points renewal at an integration record.
   */
  const admitted = (value: unknown): LoginProfile | undefined => {
    const profile = parseProfile(value);
    return profile &&
      isLoginProfile(profile) &&
      underAccounts(profile.tokenFile) &&
      loginFiles.has(basename(profile.tokenFile))
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

  const sealed = createSealedStore({
    stateDir: options.stateDir,
    log,
    pivHelper: options.pivHelper,
    requireTmpfs: options.requireTmpfs,
  });
  const locked = (): boolean => sealed?.locked() ?? false;
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
    renewal: { renewCodex: options.renewCodex, written: sealed?.written },
    logins: {
      stateDir: options.stateDir,
      drivers: options.loginDrivers ?? {},
      tempDir: sealed?.loginTempDir,
      written: sealed?.written,
      discarded: sealed?.discarded,
    },
    integrations: {
      stateDir: options.stateDir,
      written: sealed?.written,
      discarded: sealed?.discarded,
    },
  });

  /** An integration request's user and integration, decoded. */
  const integrationOf = (
    body: Record<string, unknown>,
  ): { userId: string; integration: "atlassian" } => {
    const { userId, integration } = body;
    if (!isVaultId(userId) || !isIntegration(integration))
      throw invalid("integration");
    return { userId, integration };
  };
  const refuseLocked = (): void => {
    if (locked())
      throw new WorkerMethodError(VAULT_LOCKED, "The vault is locked.");
  };
  /** A write's outcome on the wire: `{}`, or the locked or failed code. */
  const wrote = (
    outcome: Awaited<ReturnType<typeof vault.integrationPut>>,
  ): Record<string, never> => {
    if (outcome.ok) return {};
    if ("locked" in outcome)
      throw new WorkerMethodError(VAULT_LOCKED, "The vault is locked.");
    throw new WorkerMethodError("failed", "The vault request failed.");
  };

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
  const commitLogin = (
    login: ServedLogin,
    loginId: string,
  ): Promise<boolean> => {
    const asked = askCommit(login, loginId);
    login.committing = asked;
    const clear = (): void => {
      if (login.committing === asked) login.committing = undefined;
    };
    void asked.then(clear, clear);
    return asked;
  };
  const askCommit = async (
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
      locked: locked(),
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
    [VAULT_METHODS.credentialFor]: async (body) => {
      const binding = bindingOf(body.binding);
      return {
        credential: locked()
          ? { ok: false, locked: true }
          : await vault.credentialFor(binding),
      };
    },
    [VAULT_METHODS.upstream401]: (body) => {
      if (typeof body.sentToken !== "string") throw invalid("token");
      const binding = bindingOf(body.binding);
      if (!locked()) vault.upstream401(binding, body.sentToken);
      return {};
    },
    [VAULT_METHODS.discard]: async (body) => {
      if (!isProfileId(body.accountId)) throw invalid("account");
      await vault.discardCredential(body.accountId);
      return {};
    },
    [VAULT_METHODS.integrationPut]: async (body) => {
      const { userId, integration } = integrationOf(body);
      const { credential } = body;
      if (
        typeof credential !== "string" ||
        credential.length === 0 ||
        credential.length > MAX_INTEGRATION_CREDENTIAL
      )
        throw invalid("integration credential");
      refuseLocked();
      return wrote(await vault.integrationPut(userId, integration, credential));
    },
    [VAULT_METHODS.integrationGet]: async (body) => {
      const { userId, integration } = integrationOf(body);
      return {
        record: locked()
          ? { ok: false, locked: true }
          : await vault.integrationGet(userId, integration),
      };
    },
    [VAULT_METHODS.integrationClear]: async (body) => {
      const { userId, integration } = integrationOf(body);
      refuseLocked();
      return wrote(await vault.integrationClear(userId, integration));
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
      if (locked())
        throw new WorkerMethodError(LOGIN_UNAVAILABLE, "The vault is locked.");
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
      let reported = false;
      const report = (
        outcome: { ok: true } | { ok: false; error: LoginFailure },
        state: string,
      ): void => {
        if (reported) return;
        reported = true;
        clearTimeout(deadline);
        clearTimeout(backstop);
        logins.delete(loginId);
        log(`login ${loginId} (account ${accountId}): ${state}`);
        if (current === connection)
          tell(VAULT_METHODS.loginDone, { loginId, ...outcome });
      };
      // The vault's own bound: past the deadline and its grace the run
      // reports done whatever its driver does (the child is killed by then);
      // only a commit already in flight, itself bounded, is waited for.
      const backstop = setTimeout(() => {
        if (!served.withdrawn) withdraw(served);
        void (served.committing ?? Promise.resolve(false))
          .catch(() => false)
          .then(() => report({ ok: false, error: "cancelled" }, "abandoned"));
      }, loginTimeoutMs + loginSettleGraceMs);
      backstop.unref();
      void run.done
        .then(
          (): { ok: true } | { ok: false; error: LoginFailure } => ({
            ok: true,
          }),
          (): { ok: false; error: LoginFailure } => ({
            ok: false,
            error: served.withdrawn ? "cancelled" : "failed",
          }),
        )
        .then((outcome) =>
          report(outcome, outcome.ok ? "done" : outcome.error),
        );
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

  /** Set at the first moment of a stop: nothing attaches or is served. */
  let halted = false;

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
        if (halted)
          throw new WorkerMethodError("failed", "The vault is stopping.");
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

  let control: VaultControl | undefined;
  if (sealed) {
    log("sealed store: locked until unlocked");
    if (options.controlSocket)
      control = await startVaultControl(options.controlSocket, {
        store: sealed,
        log,
        unlocked: () => {
          // Every profile's file is read now: needs-login goes out at once.
          for (const profileId of profiles.ids()) void vault.recheck(profileId);
        },
      });
  }

  /** Every accepted connection, from before its handshake to its close. */
  const sockets = new Set<net.Socket>();
  const server = tls.createServer(
    {
      key: options.tls.keyPem,
      cert: options.tls.certPem,
      ca: options.tls.peerCertPem,
      requestCert: true,
      // The pin below (`isPinnedPeer`) is the check, before any frame.
      rejectUnauthorized: false,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    },
    (socket) => {
      if (halted) {
        socket.destroy();
        return;
      }
      if (!isPinnedPeer(socket, pinned)) {
        log("edge connection refused: unpinned certificate");
        socket.destroy();
        return;
      }
      attach(socket);
    },
  );
  server.on("connection", (socket: net.Socket) => {
    if (halted) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
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

  let stopping: Promise<void> | undefined;
  const renewTick = setInterval(() => {
    if (locked()) return;
    sealed?.sweep();
    vault.renewDue().catch(() => log("renewal tick failed"));
  }, RENEW_TICK_MS);
  renewTick.unref();

  return {
    port,
    renewDue: () => (locked() ? Promise.resolve() : vault.renewDue()),
    close() {
      stopping ??= (async () => {
        // All before the first await, so nothing starts once a stop began:
        // no login commits (each running one ends cancelled), the vault
        // admits no login or renewal, and no edge links.
        halted = true;
        clearInterval(renewTick);
        for (const login of logins.values()) withdraw(login);
        const vaultClosed = vault.close();
        current?.end("the vault is stopping");
        const closed = new Promise<void>((done) => server.close(() => done()));
        for (const socket of sockets) socket.destroy();
        await Promise.all([control?.close(), vaultClosed, closed]);
        // Every login and renewal has ended; each file must match its record.
        // Fixed texts only: the names are ID_RE-checked directory names.
        let unsealed: string[];
        try {
          unsealed = (await sealed?.flush()) ?? [];
        } catch {
          throw new Error("not sealed at stop: the accounts could not be read");
        }
        if (unsealed.length > 0)
          throw new Error(`not sealed at stop: ${unsealed.join(", ")}`);
      })();
      return stopping;
    },
  };
}
