/**
 * Logins in the gateway (plan Task-1385, M11): an enrolled client starts a
 * Claude or Codex login for its user's account, or for a new one, and the
 * gateway runs today's driver for it, injected through `startGateway`'s
 * `loginDrivers` so this module imports no package.
 *
 * Each login gets a fresh directory under `<stateDir>/login-tmp/` (0700); the
 * driver writes its credential there and nowhere else, so the interaction
 * never touches an account's live token file and needs no login hold. On
 * success one item in the account's writer lane checks the credential, moves
 * it into the token file by a same-directory rename (0600), registers or
 * updates the account and re-reads it for renewal. The directory is deleted
 * whatever the outcome. Only events (output, URL, code, state) leave the
 * gateway; the credential never does.
 *
 * A new account is registered at start, needing a login while its first one
 * runs, so a client has an account to show; it is removed again when that
 * login does not succeed. One login per account: a second start answers the
 * running one.
 */
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  LOGIN_UNAVAILABLE,
  UNKNOWN_ACCOUNT,
  UNKNOWN_LOGIN,
} from "./clientMethods.ts";
import type { WriterLane } from "./holds.ts";
import type { LeaseProvider } from "./leases.ts";
import { readCredential } from "./profileCredential.ts";
import {
  isLoginProfile,
  type LoginProfile,
  type ProfileRegistry,
} from "./profiles.ts";

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_CHARS = 64_000;
const MAX_INPUT_CHARS = 8_192;

/** The file a driver leaves its credential in, inside its directory. */
const LOGIN_CREDENTIAL_FILE: Record<LeaseProvider, string> = {
  claude: ".credentials.json",
  "openai-codex": "auth.json",
};

const DEFAULT_NAME: Record<LeaseProvider, string> = {
  claude: "Claude",
  "openai-codex": "Codex",
};

interface LoginDriverEvents {
  output(text: string): void;
  url(url: string): void;
  code(code: string): void;
}

interface LoginDriverRun {
  /** A line the user typed, such as Claude's pasted code. */
  input(text: string): void;
  /** Stops the login; `done` still settles. */
  cancel(): void;
  /** Resolves once the driver finished and its credential is in place. */
  done: Promise<void>;
}

/** Runs one login whose credential lands in `configDir`. */
type LoginDriver = (
  configDir: string,
  events: LoginDriverEvents,
) => LoginDriverRun;

export type LoginDrivers = Partial<Record<LeaseProvider, LoginDriver>>;

type LoginState = "running" | "ready" | "error" | "cancelled";

export type LoginEvent =
  | { type: "output"; text: string }
  | { type: "url"; url: string }
  | { type: "code"; code: string }
  | { type: "state"; state: LoginState; error?: string };

export interface LoginStart {
  kind: LeaseProvider;
  accountId?: string;
  name?: string;
}

/** Why a start is refused; the listener turns it into its method error. */
export class LoginRefusal extends Error {
  constructor(
    readonly code:
      typeof UNKNOWN_ACCOUNT | typeof LOGIN_UNAVAILABLE | typeof UNKNOWN_LOGIN,
    message: string,
  ) {
    super(message);
  }
}

interface ActiveLogin {
  loginId: string;
  accountId: string;
  clientId: string;
  isNew: boolean;
  run?: LoginDriverRun;
  cancelled: boolean;
  timedOut?: boolean;
  output: number;
}

export interface LoginManagerDeps {
  stateDir: string;
  drivers: LoginDrivers;
  profiles: Pick<ProfileRegistry, "get">;
  lane: Pick<WriterLane, "run">;
  ownerOf(profileId: string): string | undefined;
  putAccount(account: LoginProfile & { userId: string }): void;
  removeAccount(profileId: string): void;
  /** Re-reads the account's token file, as when a hold ends. */
  recheck(profileId: string): void;
  /** Sends `event` to the client's connections. */
  send(
    clientId: string,
    loginId: string,
    accountId: string,
    event: LoginEvent,
  ): void;
  log(line: string): void;
  timeoutMs?: number;
}

export interface LoginManager {
  start(
    client: { clientId: string; userId: string },
    start: LoginStart,
  ): {
    loginId: string;
    accountId: string;
  };
  input(clientId: string, loginId: string, text: string): void;
  cancel(clientId: string, loginId: string): void;
  /** Accounts whose first login is still running. */
  pendingAccounts(): Set<string>;
  close(): void;
}

/** Moves the verified credential into `tokenFile` by a same-directory rename. */
function install(source: string, tokenFile: string): void {
  const directory = dirname(tokenFile);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = join(
    directory,
    `.${basename(tokenFile)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    copyFileSync(source, temp);
    chmodSync(temp, 0o600);
    renameSync(temp, tokenFile);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

export function createLoginManager(deps: LoginManagerDeps): LoginManager {
  const { log } = deps;
  const byId = new Map<string, ActiveLogin>();
  const byAccount = new Map<string, ActiveLogin>();
  const tempRoot = join(deps.stateDir, "login-tmp");
  const accountsRoot = join(deps.stateDir, "accounts");

  const emit = (login: ActiveLogin, event: LoginEvent): void =>
    deps.send(login.clientId, login.loginId, login.accountId, event);

  const owned = (clientId: string, loginId: string): ActiveLogin => {
    const login = byId.get(loginId);
    if (!login || login.clientId !== clientId)
      throw new LoginRefusal(UNKNOWN_LOGIN, "No such login for this client.");
    return login;
  };

  /** Checks the driver's credential and moves it into the account's file. */
  const ingest = async (
    login: ActiveLogin,
    kind: LeaseProvider,
    configDir: string,
    account: LoginProfile & { userId: string },
  ): Promise<void> => {
    const source = join(configDir, LOGIN_CREDENTIAL_FILE[kind]);
    const read = await readCredential(kind, source);
    if (!read.ok) throw new Error("The login left no usable credential.");
    await deps.lane.run(login.accountId, async () => {
      if (login.cancelled || byAccount.get(login.accountId) !== login)
        throw new Error("cancelled");
      install(source, account.tokenFile);
    });
  };

  /** Ends the login; a ready one registers its account, no longer pending. */
  const finish = (
    login: ActiveLogin,
    state: Exclude<LoginState, "running">,
    error?: string,
    account?: LoginProfile & { userId: string },
  ): void => {
    byId.delete(login.loginId);
    if (byAccount.get(login.accountId) === login)
      byAccount.delete(login.accountId);
    if (state === "ready" && account) {
      deps.putAccount(account);
      deps.recheck(login.accountId);
    } else if (login.isNew) deps.removeAccount(login.accountId);
    log(`login ${login.loginId} (account ${login.accountId}): ${state}`);
    emit(login, { type: "state", state, ...(error ? { error } : {}) });
  };

  return {
    start(client, { kind, accountId, name }) {
      const driver = deps.drivers[kind];
      if (!driver)
        throw new LoginRefusal(
          LOGIN_UNAVAILABLE,
          "This gateway runs no such login.",
        );
      let account: LoginProfile & { userId: string };
      if (accountId !== undefined) {
        const running = byAccount.get(accountId);
        if (running && running.clientId === client.clientId)
          return { loginId: running.loginId, accountId };
        const profile = deps.profiles.get(accountId);
        if (
          !profile ||
          !isLoginProfile(profile) ||
          profile.provider !== kind ||
          deps.ownerOf(accountId) !== client.userId ||
          running
        )
          throw new LoginRefusal(
            UNKNOWN_ACCOUNT,
            "The gateway holds no such account for this user.",
          );
        account = { ...profile, userId: client.userId };
      } else {
        const id = `${kind === "claude" ? "claude" : "codex"}-${randomBytes(6).toString("hex")}`;
        account = {
          id,
          provider: kind,
          name: (name?.trim() || DEFAULT_NAME[kind]).slice(0, 80),
          enabled: true,
          tokenFile: join(accountsRoot, id, LOGIN_CREDENTIAL_FILE[kind]),
          userId: client.userId,
        };
      }
      const login: ActiveLogin = {
        loginId: randomBytes(12).toString("base64url"),
        accountId: account.id,
        clientId: client.clientId,
        isNew: accountId === undefined,
        cancelled: false,
        output: 0,
      };
      byId.set(login.loginId, login);
      byAccount.set(login.accountId, login);
      if (login.isNew) deps.putAccount(account);

      mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
      const configDir = mkdtempSync(join(tempRoot, `${kind}-`));
      log(`login ${login.loginId} (account ${login.accountId}): started`);
      setImmediate(() => {
        if (!byId.has(login.loginId)) {
          rmSync(configDir, { recursive: true, force: true });
          return;
        }
        emit(login, { type: "state", state: "running" });
        let run: LoginDriverRun;
        try {
          run = driver(configDir, {
            output: (text) => {
              const room = MAX_OUTPUT_CHARS - login.output;
              if (room <= 0 || !byId.has(login.loginId)) return;
              const chunk = text.slice(0, room);
              login.output += chunk.length;
              emit(login, { type: "output", text: chunk });
            },
            url: (url) => emit(login, { type: "url", url }),
            code: (code) => emit(login, { type: "code", code }),
          });
        } catch {
          rmSync(configDir, { recursive: true, force: true });
          finish(login, "error", "The login could not start.");
          return;
        }
        login.run = run;
        const timeout = setTimeout(() => {
          login.cancelled = true;
          login.timedOut = true;
          run.cancel();
        }, deps.timeoutMs ?? LOGIN_TIMEOUT_MS);
        timeout.unref();
        void run.done
          .then(async () => {
            if (login.cancelled) throw new Error("cancelled");
            await ingest(login, kind, configDir, account);
            finish(login, "ready", undefined, account);
          })
          .catch((err: unknown) => {
            if (login.timedOut)
              finish(login, "error", "The login timed out after 10 minutes.");
            else if (login.cancelled) finish(login, "cancelled");
            else
              finish(
                login,
                "error",
                err instanceof Error
                  ? err.message.slice(0, 180)
                  : "The login failed.",
              );
          })
          .finally(() => {
            clearTimeout(timeout);
            rmSync(configDir, { recursive: true, force: true });
          });
      });
      return { loginId: login.loginId, accountId: login.accountId };
    },
    input(clientId, loginId, text) {
      const login = owned(clientId, loginId);
      const line = text.trim();
      // Never logged: it may be an authorization code.
      if (line && line.length <= MAX_INPUT_CHARS) login.run?.input(line);
    },
    cancel(clientId, loginId) {
      const login = owned(clientId, loginId);
      login.cancelled = true;
      if (login.run) login.run.cancel();
      else finish(login, "cancelled");
    },
    pendingAccounts: () =>
      new Set(
        [...byAccount.values()]
          .filter((login) => login.isNew)
          .map((login) => login.accountId),
      ),
    close() {
      for (const login of byId.values()) {
        login.cancelled = true;
        login.run?.cancel();
      }
    },
  };
}
