/**
 * The port between the gateway's two tiers (ADR-0005). The edge (listener,
 * forwarding, leases, compatible endpoints, control) reaches the vault
 * (renewal, credential reads, the writer lane and the login holds) only
 * through `VaultPort`, and the vault reads the edge only through
 * `VaultInputs`. The tiers run in one process (`vault.ts`) or apart, the edge
 * reaching a vault process over `gateway-vault/1.0` (`remoteVault.ts`,
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
  /** Deletes the token files the vault made for the account, if any. */
  discardCredential(accountId: string): void;
}

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
type LoginDriver = (configDir: string, events: LoginDriverEvents) => LoginRun;

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
