/**
 * Logins in the gateway, the edge's side (plan Task-1385, M11): an enrolled
 * client starts a Claude or Codex login for its user's account, or for a new
 * one; the vault runs the driver and takes the credential in
 * (`vaultLogins.ts`, through `VaultPort.login`), and this module relays the
 * interaction to the client that started it as `logins.event`s. The
 * credential never passes here.
 *
 * A new account is registered at start, needing a login while its first one
 * runs, so a client has an account to show; it is removed again when that
 * login does not succeed. One login per account: a second start by the same
 * client answers the running one. A login ends after 10 minutes.
 */
import { randomBytes } from "node:crypto";
import {
  LOGIN_UNAVAILABLE,
  UNKNOWN_ACCOUNT,
  UNKNOWN_LOGIN,
} from "./clientMethods.ts";
import type { LeaseProvider } from "./leases.ts";
import {
  isLoginProfile,
  type LoginProfile,
  type ProfileRegistry,
} from "./profiles.ts";
import type { LoginRun, VaultPort } from "./vaultPort.ts";

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_CHARS = 64_000;
const MAX_INPUT_CHARS = 8_192;

const DEFAULT_NAME: Record<LeaseProvider, string> = {
  claude: "Claude",
  "openai-codex": "Codex",
};

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

/** Why a call is refused; the listener turns it into its method error. */
export class LoginRefusal extends Error {
  constructor(
    readonly code:
      typeof UNKNOWN_ACCOUNT | typeof LOGIN_UNAVAILABLE | typeof UNKNOWN_LOGIN,
    message: string,
  ) {
    super(message);
  }
}

type Account = LoginProfile & { userId: string };

interface ActiveLogin {
  loginId: string;
  accountId: string;
  clientId: string;
  isNew: boolean;
  run?: LoginRun;
  cancelled: boolean;
  timedOut: boolean;
  output: number;
}

interface LoginManagerDeps {
  vault: Pick<VaultPort, "login" | "newTokenFile">;
  profiles: Pick<ProfileRegistry, "get">;
  ownerOf(profileId: string): string | undefined;
  putAccount(account: Account): void;
  removeAccount(profileId: string): void;
  /** Sends `event` to the client's connections. */
  send(
    clientId: string,
    loginId: string,
    accountId: string,
    event: LoginEvent,
  ): void;
  log(line: string): void;
}

interface LoginManager {
  start(
    client: { clientId: string; userId: string },
    start: LoginStart,
  ): { loginId: string; accountId: string };
  input(clientId: string, loginId: string, text: string): void;
  cancel(clientId: string, loginId: string): void;
  /** Accounts whose first login is still running. */
  pendingAccounts(): Set<string>;
  /** Cancels the account's login, which then never registers it. */
  forget(accountId: string): void;
  close(): void;
}

export function createLoginManager(deps: LoginManagerDeps): LoginManager {
  const { log, vault } = deps;
  const byId = new Map<string, ActiveLogin>();
  const byAccount = new Map<string, ActiveLogin>();

  const emit = (login: ActiveLogin, event: LoginEvent): void =>
    deps.send(login.clientId, login.loginId, login.accountId, event);

  const owned = (clientId: string, loginId: string): ActiveLogin => {
    const login = byId.get(loginId);
    if (!login || login.clientId !== clientId)
      throw new LoginRefusal(UNKNOWN_LOGIN, "No such login for this client.");
    return login;
  };

  const current = (login: ActiveLogin): boolean =>
    !login.cancelled && byAccount.get(login.accountId) === login;

  /** Ends the login; a ready one registers its account, no longer pending. */
  const finish = (
    login: ActiveLogin,
    state: Exclude<LoginState, "running">,
    error?: string,
    account?: Account,
  ): void => {
    byId.delete(login.loginId);
    if (byAccount.get(login.accountId) === login)
      byAccount.delete(login.accountId);
    if (state === "ready" && account) deps.putAccount(account);
    else if (login.isNew) deps.removeAccount(login.accountId);
    log(`login ${login.loginId} (account ${login.accountId}): ${state}`);
    emit(login, { type: "state", state, ...(error ? { error } : {}) });
  };

  /** The user's account to log in again, or a new one. */
  const accountFor = (
    userId: string,
    { kind, accountId, name }: LoginStart,
  ): Account => {
    if (accountId === undefined) {
      const id = `${kind === "claude" ? "claude" : "codex"}-${randomBytes(6).toString("hex")}`;
      return {
        id,
        provider: kind,
        name: (name?.trim() || DEFAULT_NAME[kind]).slice(0, 80),
        enabled: true,
        tokenFile: vault.newTokenFile(kind, id),
        userId,
      };
    }
    const profile = deps.profiles.get(accountId);
    if (
      !profile ||
      !isLoginProfile(profile) ||
      profile.provider !== kind ||
      deps.ownerOf(accountId) !== userId ||
      byAccount.has(accountId)
    )
      throw new LoginRefusal(
        UNKNOWN_ACCOUNT,
        "The gateway holds no such account for this user.",
      );
    return { ...profile, userId };
  };

  return {
    start(client, start) {
      if (start.accountId !== undefined) {
        const running = byAccount.get(start.accountId);
        if (running?.clientId === client.clientId)
          return { loginId: running.loginId, accountId: start.accountId };
      }
      const account = accountFor(client.userId, start);
      const login: ActiveLogin = {
        loginId: randomBytes(12).toString("base64url"),
        accountId: account.id,
        clientId: client.clientId,
        isNew: start.accountId === undefined,
        cancelled: false,
        timedOut: false,
        output: 0,
      };
      byId.set(login.loginId, login);
      byAccount.set(login.accountId, login);
      let run: LoginRun | undefined;
      try {
        run = vault.login(
          {
            kind: start.kind,
            accountId: account.id,
            tokenFile: account.tokenFile,
            commit: () => current(login),
          },
          {
            output: (text) => {
              const room = MAX_OUTPUT_CHARS - login.output;
              if (room <= 0 || !byId.has(login.loginId)) return;
              const chunk = text.slice(0, room);
              login.output += chunk.length;
              emit(login, { type: "output", text: chunk });
            },
            url: (url) => emit(login, { type: "url", url }),
            code: (code) => emit(login, { type: "code", code }),
          },
        );
      } catch {
        run = undefined;
      }
      if (!run) {
        byId.delete(login.loginId);
        byAccount.delete(login.accountId);
        throw new LoginRefusal(
          LOGIN_UNAVAILABLE,
          "This gateway cannot run that login now.",
        );
      }
      login.run = run;
      if (login.isNew) deps.putAccount(account);
      log(`login ${login.loginId} (account ${login.accountId}): started`);
      emit(login, { type: "state", state: "running" });
      const timeout = setTimeout(() => {
        login.cancelled = true;
        login.timedOut = true;
        run.cancel();
      }, LOGIN_TIMEOUT_MS);
      timeout.unref();
      void run.done
        .then(() => {
          if (!current(login)) throw new Error("cancelled");
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
        .finally(() => clearTimeout(timeout));
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
      login.run?.cancel();
    },
    forget(accountId) {
      const login = byAccount.get(accountId);
      if (!login) return;
      login.cancelled = true;
      byAccount.delete(accountId);
      login.run?.cancel();
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
