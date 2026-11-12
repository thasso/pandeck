/**
 * Logins in the gateway, the edge's side (plan Task-1385, M11; Task-1402 B2):
 * an actor (an enrolled client, or a signed-in session of the gateway's page)
 * starts a Claude or Codex login for its user's account, or for a new one;
 * the vault runs the driver and takes the credential in (`vaultLogins.ts`,
 * through `VaultPort.login`), and this module relays the interaction to the
 * actor that started it: `logins.event`s to a client, a readable view to a
 * session. The credential never passes here.
 *
 * Per account it keeps three things, apart from any view:
 *
 * - `driver`: the account's driver that has not settled. Only its `done`
 *   settling clears it; a cancel or a deadline only asks it to stop.
 * - `current`: the account's login that is not terminal, `waiting` for the
 *   driver before it or `started`.
 * - `registration`: for a new account not yet logged in, the login that owns
 *   its fate. It is removed again when that login ends other than ready, and
 *   only once the account has no driver left.
 *
 * An account holds a slot while it has a `current` or a `driver`: at most 2
 * per user and `MAX_VAULT_LOGINS` in all. A start by another actor of the same
 * user takes over the account's login: the old one ends at once, cancelled
 * and unable to commit, and the new one starts its driver only after the old
 * driver settled, or gives up after 30 s. The same actor's second start
 * answers its running login. A driver is cancelled after 10 minutes.
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
import { MAX_VAULT_LOGINS } from "./vaultMethods.ts";
import type { LoginRun, VaultPort } from "./vaultPort.ts";

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_CHARS = 64_000;
const MAX_INPUT_CHARS = 8_192;
/** How long a successor waits for the account's earlier driver to settle. */
const SUCCESSOR_WAIT_MS = 30_000;
/** Logins with a slot: per user, and in all (the remote vault's own bound). */
const MAX_USER_LOGINS = 2;
const MAX_EDGE_LOGINS = MAX_VAULT_LOGINS;
/**
 * How long an account's driver counts as running after the vault link broke
 * under it: past the vault's own 10-minute deadline plus a minute for the
 * driver to settle. The vault's hello names no running logins, so nothing
 * shorter is known to be safe; its own admission still answers last.
 */
const UNCERTAIN_HOLD_MS = LOGIN_TIMEOUT_MS + 60_000;
/** How long, and how many, finished logins stay readable. */
const FINISHED_TTL_MS = 2 * 60_000;
const MAX_FINISHED = 64;

const SUPERSEDED_TEXT = "This login was started again elsewhere.";
const STALLED_TEXT = "The earlier login did not stop in time. Try again.";
const TIMED_OUT_TEXT = "The login timed out after 10 minutes.";
const ACCOUNT_WRITE_TEXT =
  "The login succeeded but the gateway could not record the account.";

const DEFAULT_NAME: Record<LeaseProvider, string> = {
  claude: "Claude",
  "openai-codex": "Codex",
};

type LoginState = "running" | "ready" | "error" | "cancelled";

/** Why a login ended other than ready, as fixed codes a browser may see. */
type LoginReason =
  "failed" | "timed_out" | "superseded" | "unavailable" | "session_ended";

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

/**
 * Who runs a login: a client or a session, told apart by `kind`, never by
 * the id's shape. `active()` false means it may no longer commit.
 */
export interface LoginActor {
  kind: "client" | "session";
  id: string;
  userId: string;
  active(): boolean;
}

/** A login as its own actor may read it. */
export interface LoginView {
  kind: LeaseProvider;
  state: LoginState;
  reason?: LoginReason;
  output: string;
  cursor: number;
  url?: string;
  code?: string;
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

/**
 * A `done` rejected with this means the vault refused to run the login (its
 * own admission), so the driver never ran.
 */
export class LoginNotRun extends Error {}

/**
 * A `done` rejected with this means the link to the vault broke: the driver
 * may still run there, so its account's slot stays held (`UNCERTAIN_HOLD_MS`).
 */
export class LoginOutcomeUnknown extends Error {}

type Account = LoginProfile & { userId: string };

interface Login {
  loginId: string;
  accountId: string;
  actor: LoginActor;
  account: Account;
  phase: "waiting" | "started";
  run?: LoginRun;
  cancelled: boolean;
  timedOut: boolean;
  /**
   * The vault was told to move the credential in: from then on nothing takes
   * the login over or stops it, and its own outcome stands.
   */
  committing: boolean;
  /** Its account was removed: a late success registers nothing. */
  forgotten: boolean;
  /** Set once terminal for its actor: the event sent, the view finished. */
  ended?: { state: Exclude<LoginState, "running">; reason?: LoginReason };
  /** Why it was cancelled, when not by its own actor's cancel. */
  cancelReason?: LoginReason;
  output: string;
  url?: string;
  code?: string;
  waitTimer?: ReturnType<typeof setTimeout>;
}

interface AccountState {
  userId: string;
  driver?: Promise<void> | undefined;
  current?: Login | undefined;
  registration?: Login | undefined;
}

interface LoginManagerDeps {
  vault: Pick<VaultPort, "login" | "newTokenFile">;
  profiles: Pick<ProfileRegistry, "get">;
  ownerOf(profileId: string): string | undefined;
  putAccount(account: Account): void;
  removeAccount(profileId: string): void;
  /** Sends `event` to the actor's connections, if it has any. */
  send(
    actor: LoginActor,
    loginId: string,
    accountId: string,
    event: LoginEvent,
  ): void;
  log(line: string): void;
  now?: () => number;
  /** Test seam: a shorter successor wait. */
  successorWaitMs?: number;
  /** Test seam: a shorter hold after a lost vault link. */
  uncertainHoldMs?: number;
}

export interface LoginManager {
  start(
    actor: LoginActor,
    start: LoginStart,
  ): { loginId: string; accountId: string };
  input(actor: LoginActor, loginId: string, text: string): void;
  cancel(actor: LoginActor, loginId: string): void;
  /** The login from `cursor` on, for its own actor only. */
  read(actor: LoginActor, loginId: string, cursor: number): LoginView;
  /**
   * Cancels every running login of an actor that ended (a revoked client, a
   * session signed out or expired), even one without connections.
   */
  endActor(actor: Pick<LoginActor, "kind" | "id">): void;
  /** Accounts whose first login has not succeeded yet. */
  pendingAccounts(): Set<string>;
  /** Cancels the account's login, which then never registers it. */
  forget(accountId: string): void;
  close(): void;
}

const sameActor = (
  a: Pick<LoginActor, "kind" | "id">,
  b: Pick<LoginActor, "kind" | "id">,
): boolean => a.kind === b.kind && a.id === b.id;

export function createLoginManager(deps: LoginManagerDeps): LoginManager {
  const { log, vault } = deps;
  const now = deps.now ?? Date.now;
  const waitMs = deps.successorWaitMs ?? SUCCESSOR_WAIT_MS;
  const uncertainHoldMs = deps.uncertainHoldMs ?? UNCERTAIN_HOLD_MS;
  /** Logins not yet terminal for their actor. */
  const active = new Map<string, Login>();
  /** Terminal logins still readable, oldest first. */
  const finished = new Map<string, { login: Login; at: number }>();
  const accounts = new Map<string, AccountState>();
  let closed = false;

  const emit = (login: Login, event: LoginEvent): void =>
    deps.send(login.actor, login.loginId, login.accountId, event);

  const pruneFinished = (): void => {
    const at = now();
    for (const [id, entry] of finished) {
      if (finished.size <= MAX_FINISHED && at - entry.at < FINISHED_TTL_MS)
        break;
      finished.delete(id);
    }
  };

  const owned = (actor: LoginActor, loginId: string): Login => {
    const login = active.get(loginId);
    if (!login || !sameActor(login.actor, actor))
      throw new LoginRefusal(UNKNOWN_LOGIN, "No such login for this client.");
    return login;
  };

  /** The vault's commit check: only the account's live, uncancelled login. */
  const current = (login: Login): boolean =>
    !closed &&
    !login.cancelled &&
    login.ended === undefined &&
    accounts.get(login.accountId)?.current === login &&
    login.actor.active();

  const holdsSlot = (state: AccountState): boolean =>
    state.current !== undefined || state.driver !== undefined;

  /** Drops the account's state once nothing holds it. */
  const release = (accountId: string): void => {
    const state = accounts.get(accountId);
    if (state && !holdsSlot(state) && !state.registration)
      accounts.delete(accountId);
  };

  /**
   * Removes a new account whose owning login ended other than ready, once
   * no driver of it is left; a newer owner keeps it. A login that started
   * while the owner was committing takes the account over only now.
   */
  const cleanup = (accountId: string): void => {
    const state = accounts.get(accountId);
    const owner = state?.registration;
    if (!state || !owner || state.driver) return;
    if (owner.ended === undefined || owner.ended.state === "ready") return;
    if (state.current && !state.current.ended) {
      state.registration = state.current;
      return;
    }
    state.registration = undefined;
    try {
      deps.removeAccount(accountId);
    } catch {
      log(`login ${owner.loginId}: account update failed`);
    }
  };

  /** Whether a takeover may move the registration off its current owner. */
  const ownerYields = (state: AccountState): boolean =>
    !state.registration?.committing || state.registration.ended !== undefined;

  /** Makes the login terminal for its actor: its event, its view finished. */
  const end = (
    login: Login,
    state: Exclude<LoginState, "running">,
    reason?: LoginReason,
    error?: string,
  ): void => {
    if (login.ended) return;
    login.ended = { state, ...(reason ? { reason } : {}) };
    if (login.waitTimer) clearTimeout(login.waitTimer);
    active.delete(login.loginId);
    const account = accounts.get(login.accountId);
    if (account?.current === login) account.current = undefined;
    finished.set(login.loginId, { login, at: now() });
    pruneFinished();
    log(`login ${login.loginId} (account ${login.accountId}): ${state}`);
    // The text is gateway client 1.0's, unchanged, and only a client's: a
    // session (the browser) reads the fixed `reason` from its view only.
    emit(login, {
      type: "state",
      state,
      ...(error && login.actor.kind === "client" ? { error } : {}),
    });
  };

  /** The text and reason a cancelled login ends with. */
  const cancelledEnd = (login: Login): void => {
    if (login.timedOut) end(login, "error", "timed_out", TIMED_OUT_TEXT);
    else if (login.cancelReason === "superseded")
      end(login, "cancelled", "superseded", SUPERSEDED_TEXT);
    else end(login, "cancelled", login.cancelReason);
  };

  /**
   * Asks the login to stop. A waiting one, or one taken over (`endNow`),
   * ends for its actor at once; a started one's driver keeps the account's
   * slot until it settled.
   */
  const stop = (login: Login, reason?: LoginReason, endNow = false): void => {
    // Once committing, the vault's answer is the outcome.
    if (login.ended || login.committing) return;
    if (!login.cancelled && reason) login.cancelReason = reason;
    login.cancelled = true;
    if (login.phase === "started") login.run?.cancel();
    if (login.phase === "waiting" || endNow) {
      cancelledEnd(login);
      cleanup(login.accountId);
      release(login.accountId);
    }
  };

  /** Runs the account's driver for `login`; false when the vault refuses. */
  const launch = (login: Login): boolean => {
    const state = accounts.get(login.accountId)!;
    let run: LoginRun | undefined;
    try {
      run = vault.login(
        {
          kind: login.account.provider,
          accountId: login.accountId,
          tokenFile: login.account.tokenFile,
          commit: () => {
            const granted = current(login);
            if (granted) login.committing = true;
            return granted;
          },
        },
        {
          output: (text) => {
            const room = MAX_OUTPUT_CHARS - login.output.length;
            if (room <= 0 || login.ended) return;
            const chunk = text.slice(0, room);
            login.output += chunk;
            emit(login, { type: "output", text: chunk });
          },
          url: (url) => {
            if (login.ended) return;
            login.url = url;
            emit(login, { type: "url", url });
          },
          code: (code) => {
            if (login.ended) return;
            login.code = code;
            emit(login, { type: "code", code });
          },
        },
      );
    } catch {
      run = undefined;
    }
    if (!run) return false;
    login.phase = "started";
    login.run = run;
    const timeout = setTimeout(() => {
      if (login.committing) return;
      login.cancelled = true;
      login.timedOut = true;
      run.cancel();
    }, LOGIN_TIMEOUT_MS);
    timeout.unref();
    const driver: Promise<void> = run.done.then(
      () => {
        settled(login, driver, undefined);
      },
      (err: unknown) => {
        if (!(err instanceof LoginOutcomeUnknown))
          return settled(login, driver, err);
        // The link broke: the driver may still run on the vault. The login
        // ends for its actor now; the slot and any cleanup wait.
        // A granted commit may have saved the credential: keep the account.
        const held = accounts.get(login.accountId);
        if (login.committing && held?.registration === login)
          held.registration = undefined;
        try {
          end(login, "error", "unavailable", err.message);
        } catch {
          log(`login ${login.loginId}: state update failed`);
        }
        return new Promise<void>((resolve) => {
          setTimeout(resolve, uncertainHoldMs).unref();
        }).then(() => settled(login, driver, err));
      },
    );
    state.driver = driver;
    void driver
      .finally(() => clearTimeout(timeout))
      .catch(() => log(`login ${login.loginId}: state update failed`));
    return true;
  };

  /** The login's own outcome once its driver settled. */
  const outcome = (
    login: Login,
    state: AccountState | undefined,
    err: unknown,
  ): void => {
    if (login.ended) return;
    {
      // An actor that ended before its cancel arrived: the vault's commit
      // was refused, which is that actor's cancel, not a failure.
      if (!login.cancelled && !login.committing && !login.actor.active()) {
        login.cancelled = true;
        if (login.actor.kind === "session")
          login.cancelReason = "session_ended";
      }
      const saved = err === undefined && (login.committing || current(login));
      if (saved && !login.forgotten) {
        // The credential is in: the account stays, whatever comes next.
        if (state?.registration === login) state.registration = undefined;
        try {
          deps.putAccount(login.account);
        } catch {
          end(login, "error", "unavailable", ACCOUNT_WRITE_TEXT);
          return;
        }
        end(login, "ready");
      } else if (login.cancelled || err === undefined) cancelledEnd(login);
      else if (err instanceof LoginNotRun)
        end(login, "error", "unavailable", err.message);
      else
        end(
          login,
          "error",
          "failed",
          err instanceof Error
            ? err.message.slice(0, 180)
            : "The login failed.",
        );
    }
  };

  /**
   * The driver of `login` settled: its outcome, the account freed, then its
   * successor. Every step runs even when an earlier one threw.
   */
  const settled = (login: Login, driver: Promise<void>, err: unknown): void => {
    const state = accounts.get(login.accountId);
    if (state?.driver === driver) state.driver = undefined;
    try {
      outcome(login, state, err);
    } catch {
      log(`login ${login.loginId}: state update failed`);
    }
    // Whatever failed above, the login is terminal and frees the account.
    if (!login.ended) login.ended = { state: "error", reason: "unavailable" };
    if (active.delete(login.loginId))
      finished.set(login.loginId, { login, at: now() });
    if (state?.current === login) state.current = undefined;
    cleanup(login.accountId);
    const next = state?.current;
    if (next && next.phase === "waiting" && !next.ended && !state.driver) {
      if (next.waitTimer) clearTimeout(next.waitTimer);
      if (!launch(next)) {
        try {
          end(
            next,
            "error",
            "unavailable",
            "This gateway cannot run that login now.",
          );
        } catch {
          log(`login ${next.loginId}: state update failed`);
        }
        cleanup(login.accountId);
      }
    }
    release(login.accountId);
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
      deps.ownerOf(accountId) !== userId
    )
      throw new LoginRefusal(
        UNKNOWN_ACCOUNT,
        "The gateway holds no such account for this user.",
      );
    return { ...profile, userId };
  };

  const unavailable = (): LoginRefusal =>
    new LoginRefusal(
      LOGIN_UNAVAILABLE,
      "This gateway cannot run that login now.",
    );

  /** Whether one more account of `userId` may hold a slot. */
  const roomFor = (userId: string): boolean => {
    let user = 0;
    let all = 0;
    for (const state of accounts.values()) {
      if (!holdsSlot(state)) continue;
      all++;
      if (state.userId === userId) user++;
    }
    return user < MAX_USER_LOGINS && all < MAX_EDGE_LOGINS;
  };

  return {
    start(actor, start) {
      if (closed) throw unavailable();
      const existing =
        start.accountId !== undefined
          ? accounts.get(start.accountId)
          : undefined;
      const running = existing?.current;
      if (running && sameActor(running.actor, actor) && !running.cancelled)
        return { loginId: running.loginId, accountId: running.accountId };
      const account = accountFor(actor.userId, start);
      if (!(existing && holdsSlot(existing)) && !roomFor(actor.userId))
        throw unavailable();
      const login: Login = {
        loginId: randomBytes(12).toString("base64url"),
        accountId: account.id,
        actor,
        account,
        phase: "waiting",
        cancelled: false,
        timedOut: false,
        committing: false,
        forgotten: false,
        output: "",
      };
      const isNew = start.accountId === undefined;
      if (isNew || !existing?.driver) {
        // No driver to wait for: run now, or refuse as before.
        let state = accounts.get(account.id);
        const created = !state;
        state ??= { userId: actor.userId };
        accounts.set(account.id, state);
        const before = state.current;
        state.current = login;
        active.set(login.loginId, login);
        if (!launch(login)) {
          active.delete(login.loginId);
          state.current = before;
          if (created) accounts.delete(account.id);
          throw unavailable();
        }
        if (before) stop(before, "superseded", true);
        if (isNew) state.registration = login;
        else if (state.registration && ownerYields(state))
          state.registration = login;
        try {
          if (isNew) deps.putAccount(account);
          log(`login ${login.loginId} (account ${login.accountId}): started`);
          emit(login, { type: "state", state: "running" });
        } catch (err) {
          stop(login);
          throw err;
        }
        return { loginId: login.loginId, accountId: login.accountId };
      }
      // The account's earlier driver has not settled: take its place and
      // wait for it, so the vault never runs two drivers for one account.
      const state = existing;
      const before = state.current;
      state.current = login;
      active.set(login.loginId, login);
      // A committing predecessor is left alone and keeps the account until
      // its own outcome; this login then waits for its driver.
      if (state.registration && ownerYields(state)) state.registration = login;
      if (before) stop(before, "superseded", true);
      login.waitTimer = setTimeout(() => {
        if (login.ended || login.phase !== "waiting") return;
        end(login, "error", "unavailable", STALLED_TEXT);
        cleanup(login.accountId);
        release(login.accountId);
      }, waitMs);
      login.waitTimer.unref();
      log(`login ${login.loginId} (account ${login.accountId}): started`);
      emit(login, { type: "state", state: "running" });
      return { loginId: login.loginId, accountId: login.accountId };
    },
    input(actor, loginId, text) {
      const login = owned(actor, loginId);
      const line = text.trim();
      // Never logged: it may be an authorization code. A waiting login has
      // no driver to take it.
      if (line && line.length <= MAX_INPUT_CHARS) login.run?.input(line);
    },
    cancel(actor, loginId) {
      stop(owned(actor, loginId));
    },
    read(actor, loginId, cursor) {
      pruneFinished();
      const login = active.get(loginId) ?? finished.get(loginId)?.login;
      if (!login || !sameActor(login.actor, actor))
        throw new LoginRefusal(UNKNOWN_LOGIN, "No such login for this client.");
      const from = Math.min(
        Math.max(0, Math.floor(cursor)),
        login.output.length,
      );
      return {
        kind: login.account.provider,
        state: login.ended?.state ?? "running",
        ...(login.ended?.reason ? { reason: login.ended.reason } : {}),
        output: login.output.slice(from),
        cursor: login.output.length,
        ...(login.url !== undefined ? { url: login.url } : {}),
        ...(login.code !== undefined ? { code: login.code } : {}),
      };
    },
    endActor(actor) {
      for (const login of [...active.values()])
        if (sameActor(login.actor, actor))
          stop(login, actor.kind === "session" ? "session_ended" : undefined);
    },
    forget(accountId) {
      const state = accounts.get(accountId);
      if (!state) return;
      // The removal is the cleanup: no deferred duty may run for it later.
      state.registration = undefined;
      // A committing predecessor may not be the current login: mark them all.
      for (const login of [...active.values()])
        if (login.accountId === accountId) login.forgotten = true;
      const login = state.current;
      if (login) {
        stop(login);
        state.current = undefined;
      }
      release(accountId);
    },
    pendingAccounts: () =>
      new Set(
        [...accounts]
          .filter(([, state]) => state.registration !== undefined)
          .map(([accountId]) => accountId),
      ),
    close() {
      closed = true;
      for (const login of [...active.values()]) stop(login);
    },
  };
}
