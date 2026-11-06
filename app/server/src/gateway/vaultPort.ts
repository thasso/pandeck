/**
 * The port between the gateway's two tiers (ADR-0005). The edge (listener,
 * forwarding, leases, compatible endpoints, control) reaches the vault
 * (renewal, credential reads, the writer lane and the login holds) only
 * through `VaultPort`, and the vault reads the edge only through
 * `VaultInputs`. Both tiers run in one process today; this module holds types
 * only, so neither tier's code crosses it (`workerBoundary.test.ts`).
 */
import type { HoldTable, WriterLane } from "./holds.ts";
import type { LoginBinding } from "./leases.ts";
import type { ProfileRegistry } from "./profiles.ts";
import type { Refusal } from "./refusals.ts";

/** What the edge asks of the vault (ADR-0005). In process today. */
export interface VaultPort {
  /** The credential for one forwarded request; renews first when nearly due. */
  credentialFor(binding: LoginBinding): Promise<VaultCredential>;
  /** The upstream answered 401 to a request that sent `sentToken`. */
  upstream401(binding: LoginBinding, sentToken: string): void;
  /** The login profiles that need a login now (resent on every hello). */
  needsLogin(): string[];
  /**
   * Login holds and the writer lane, for gateway control 1.4 only. A hold
   * that ends here is re-read by the vault itself. Goes when logins become
   * lane items (M11, slice 4).
   */
  readonly holds: VaultHolds;
}

export type VaultCredential =
  | { ok: true; headers: Record<string, string>; token: string }
  | { ok: false; refusal: Refusal }
  /** G10: a credential its user has not unlocked. Never answered yet. */
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
