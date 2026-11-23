/**
 * The port between the gateway's two tiers (ADR-0005). The edge (listener,
 * forwarding, leases, compatible endpoints, control) reaches the vault
 * (renewal, credential reads, the writer lane and the login holds) only
 * through `VaultPort`, and the vault reads the edge only through
 * `VaultInputs`. The tiers run in one process (`vault.ts`) or apart, the edge
 * reaching a vault process over `gateway-vault/1.3` (`remoteVault.ts`,
 * `vaultServer.ts`). This module holds types only, so neither tier's code
 * crosses it (`workerBoundary.test.ts`).
 */
import type { HoldTable, WriterLane } from "./holds.ts";
import type { LeaseProvider, LoginBinding } from "./leases.ts";
import type { ProfileRegistry } from "./profiles.ts";
import type { Refusal } from "./refusals.ts";

/** What the edge asks of the vault (ADR-0005), in process or remote. */
export interface VaultPort {
  /** The credential for one forwarded request; renews first when nearly due. */
  credentialFor(binding: LoginBinding): Promise<VaultCredential>;
  /** The upstream answered 401 to a request that sent `sentToken`. */
  upstream401(binding: LoginBinding, sentToken: string): void;
  /** The login profiles that need a login now (resent on every hello). */
  needsLogin(): string[];
  /**
   * Runs one login (M11, `vaultLogins.ts`): the driver in a fresh directory,
   * then, in the writer lane and only while `commit()` says so, the credential
   * moved into `tokenFile` and re-read. `done` settles after that. Undefined
   * when the vault runs no such login.
   */
  login(request: VaultLogin, events: LoginDriverEvents): LoginRun | undefined;
  /** Where the vault keeps a new account's token file. */
  newTokenFile(kind: LeaseProvider, accountId: string): string;
  /**
   * Deletes the token files the vault made for the account, if any, after
   * any ingest already in its writer lane.
   */
  discardCredential(accountId: string): void | Promise<void>;
  /**
   * A user's integration credential (Task-1397): an opaque JSON string the
   * vault stores, sealed when it has recipients. The vault parses only the
   * OAuth records it writes itself (Atlassian, Task-1411; Slack, Task-1452;
   * GitHub, Task-1444): for those a get answers the access view, refreshing
   * first when due. A Slack or GitHub credential is only ever such a record:
   * a put of one is refused.
   * None of these rejects; a remote vault bounds each call.
   */
  integrationPut(
    userId: string,
    integration: Integration,
    credential: string,
  ): Promise<IntegrationWrite>;
  integrationGet(
    userId: string,
    integration: Integration,
    options?: { signal?: AbortSignal },
  ): Promise<IntegrationRecord>;
  integrationClear(
    userId: string,
    integration: Integration,
  ): Promise<IntegrationWrite>;
  /**
   * Turns an authorization code into the user's sealed OAuth record
   * (Task-1411, Task-1452, Task-1444), with the vault's own OAuth client: the exchange,
   * the site or workspace check and the write all run in the record's lane,
   * and a caller that stops waiting cancels none of it.
   */
  integrationConnect<I extends Integration>(
    userId: string,
    integration: I,
    request: IntegrationConnectRequests[I],
  ): Promise<IntegrationConnect<I>>;
  /**
   * A READ installation token for one repository the user's GitHub record
   * can pull (Task-1444): `{contents: "read", metadata: "read"}` and that
   * repository's id, both proven on GitHub's answer, else no token. A request
   * with any member but `owner` and `repo` is `invalid` before any call. A
   * caller that stops waiting stops only its own wait; never rejects.
   */
  githubToken(
    userId: string,
    request: GithubTokenRequest,
    options?: { signal?: AbortSignal },
  ): Promise<GithubToken>;
}

/** The repository a `githubToken` asks for; nothing else. */
export interface GithubTokenRequest {
  owner: string;
  repo: string;
}

/**
 * A `githubToken`'s answer. `expiresAt` is epoch milliseconds. `denied` is
 * GitHub not granting this user, or the App, that repository; `absent`,
 * `rejected` and `locked` are the user's record as a get answers it.
 */
export type GithubToken =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; absent: true }
  | { ok: false; rejected: true }
  | { ok: false; denied: true }
  | { ok: false; invalid: true }
  | { ok: false; locked: true }
  | { ok: false; unavailable: true };

/** The integrations whose credentials the vault keeps. */
export type Integration = "atlassian" | "slack" | "github";

/**
 * A get's answer. For an OAuth record `credential` is the access view, never
 * the refresh token: JSON `{kind: "atlassian-oauth", site, cloudId,
 * accessToken, expiresAt}`, `{kind: "slack-oauth", teamId, teamName?,
 * workspaceHost, userId, scope, accessToken, expiresAt}` or `{kind:
 * "github-oauth", login, accessToken, expiresAt}`. `rejected` is the
 * provider refusing its refresh.
 */
export type IntegrationRecord =
  | { ok: true; credential: string }
  | { ok: false; absent: true }
  | { ok: false; rejected: true }
  | { ok: false; locked: true }
  | { ok: false; unavailable: true };

/** A connect's request, by integration. */
export interface IntegrationConnectRequests {
  atlassian: {
    code: string;
    redirectUri: string;
    /** The deployment's site preset; without it the only site is taken. */
    site?: string | undefined;
  };
  slack: {
    code: string;
    redirectUri: string;
    /** The deployment's workspace (team id); without it any is taken. */
    team?: string | undefined;
  };
  github: { code: string; redirectUri: string };
}

/**
 * Why a connect stored nothing, for every integration. `rejected` is the
 * provider refusing the code (or granting no refresh token, or an answer of
 * an unexpected shape); `unreachable` any other failure to talk to it;
 * `notConfigured` a vault without that OAuth client.
 */
export type ConnectFailure =
  | { ok: false; rejected: true }
  | { ok: false; unreachable: true }
  | { ok: false; notConfigured: true }
  | { ok: false; locked: true }
  | { ok: false; unavailable: true };

/**
 * A connect's answer, by integration: Atlassian's chosen site and its cloud
 * id, Slack's workspace (`team` naming another one is `mismatch`), the
 * GitHub user's login, or why not.
 */
interface IntegrationConnects {
  atlassian:
    | { ok: true; site: string; cloudId: string }
    | { ok: false; site: "missing" | "ambiguous" }
    | ConnectFailure;
  slack:
    | { ok: true; teamId: string; teamName?: string }
    | { ok: false; team: "mismatch" }
    | ConnectFailure;
  github: { ok: true; login: string } | ConnectFailure;
}

export type IntegrationConnect<I extends Integration> = IntegrationConnects[I];

export type IntegrationWrite =
  { ok: true } | { ok: false; locked: true } | { ok: false; unavailable: true };

/** The in-process vault, which also serves gateway control 1.4's holds. */
export interface LocalVaultPort extends VaultPort {
  /**
   * Login holds and the writer lane, for gateway control 1.4 only. A hold
   * that ends here is re-read by the vault itself. A client's login is a lane
   * item instead (`login`).
   */
  readonly holds: VaultHolds;
}

interface VaultLogin {
  kind: LeaseProvider;
  accountId: string;
  tokenFile: string;
  /**
   * Asked in the writer lane right before the credential is moved in; only
   * `true` moves it. A remote vault asks the edge, which answers this.
   */
  commit(): boolean | Promise<boolean>;
}

/** What a login driver tells its user; never the credential. */
export interface LoginDriverEvents {
  output(text: string): void;
  url(url: string): void;
  code(code: string): void;
}

export interface LoginRun {
  /** A line the user typed, such as Claude's pasted code. */
  input(text: string): void;
  /** Stops the login; `done` still settles. */
  cancel(): void;
  done: Promise<void>;
}

/** Runs one login whose credential lands in `configDir` and nowhere else. */
export type LoginDriver = (
  configDir: string,
  events: LoginDriverEvents,
) => LoginRun;

/** The drivers the gateway's process is given (`startGateway`). */
export type LoginDrivers = Partial<Record<LeaseProvider, LoginDriver>>;

export type VaultCredential =
  | { ok: true; headers: Record<string, string>; token: string }
  | { ok: false; refusal: Refusal }
  /**
   * A sealing vault no human has unlocked since it started (Task-1395); later
   * also G10's per-user unlock.
   */
  | { ok: false; locked: true };

export type VaultHolds = Pick<
  HoldTable,
  | "get"
  | "fencing"
  | "fence"
  | "registerWriter"
  | "release"
  | "forceRelease"
  | "check"
  | "stuck"
> &
  Pick<WriterLane, "acquire">;

/** What the vault reads from, and tells, the edge. */
export interface VaultInputs {
  /** Control-fed registry, read only. */
  profiles: Pick<ProfileRegistry, "get" | "ids" | "loginIds">;
  /** Demand signal: a login profile is renewed only while a live lease uses it. */
  hasLiveLease(profileId: string): boolean;
  /** A profile's needs-login changed; the edge sends `profiles.credential`. */
  report(profileId: string, needsLogin: boolean): void;
}
