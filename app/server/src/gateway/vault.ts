/**
 * The gateway's vault tier (ADR-0005): renewal, credential reads, the writer
 * lane and the login holds, behind `VaultPort`. It reads the edge only
 * through `VaultInputs`: the profile registry, the live-lease demand signal
 * and the needs-login report. Both tiers run in one process today.
 *
 * Every hold that ends here, by release, force release, evidence or a fence,
 * has its profile's file re-read (`renewal.recheck`) before the call returns,
 * even when saving failed; the edge reports the statuses. With restored
 * records the holds are restored, then fenced from the registry, which the
 * edge restores first.
 */
import {
  HoldTable,
  WriterLane,
  type HoldRecord,
  type HoldTableOptions,
  type HoldUpdate,
} from "./holds.ts";
import { isLoginProfile } from "./profiles.ts";
import { createRenewal, type RenewalOptions } from "./renewal.ts";
import {
  createVaultIntegrations,
  type VaultIntegrationOptions,
} from "./vaultIntegrations.ts";
import { createVaultLogins, type VaultLoginOptions } from "./vaultLogins.ts";
import type {
  LocalVaultPort,
  VaultCredential,
  VaultHolds,
  VaultInputs,
} from "./vaultPort.ts";

export interface VaultOptions {
  inputs: VaultInputs;
  log: (line: string) => void;
  now?: (() => number) | undefined;
  holds: Omit<HoldTableOptions, "now"> & {
    /** The saved holds; given only with a state directory. */
    restored?: readonly HoldRecord[] | undefined;
  };
  /** Renewal's own seams, passed through as given. */
  renewal: Omit<
    RenewalOptions,
    "profiles" | "leases" | "lane" | "log" | "now" | "report"
  >;
  /** Clients' logins (`vaultLogins.ts`); without it none runs. */
  logins?: VaultLoginOptions | undefined;
  /** Users' integration credentials (`vaultIntegrations.ts`); without it none. */
  integrations?: VaultIntegrationOptions | undefined;
}

export interface Vault extends LocalVaultPort {
  /** The profiles' writer lane, for in-gateway writers (G4, G5). */
  readonly lane: Pick<WriterLane, "run">;
  /** The login holds, as records. */
  holdRecords(): HoldRecord[];
  /** Re-reads one profile's file and renews it when due; never rejects. */
  recheck(profileId: string): Promise<void>;
  /** One renewal tick: renews every leased profile inside its margin. */
  renewDue(): Promise<void>;
  /** Aborts renewals in flight. */
  close(): void;
}

export function createVault(options: VaultOptions): Vault {
  const { inputs, log, now } = options;
  const { restored, ...holdOptions } = options.holds;
  const table = new HoldTable({ ...holdOptions, now });
  if (restored) {
    table.restore(restored);
    // Fence holds are stuck: the next hello reports them.
    if (table.fence(inputs.profiles.loginIds()).saveError !== undefined)
      log("hold fence: holds.json not saved; the change stands in memory");
  }
  // A profile without a login has no lane: `undefined` is unknown there.
  const lane = new WriterLane(table, (id) => {
    const profile = inputs.profiles.get(id);
    return profile && isLoginProfile(profile) ? profile.provider : undefined;
  });
  const renewal = createRenewal({
    ...options.renewal,
    profiles: inputs.profiles,
    leases: { hasLiveLease: (profileId) => inputs.hasLiveLease(profileId) },
    lane,
    log,
    now,
    report: (profileId, needsLogin) => inputs.report(profileId, needsLogin),
  });

  /** Re-reads every profile whose hold `update` ended, then hands it back. */
  const recheckEnded = <T extends HoldUpdate | undefined>(update: T): T => {
    for (const profileId of update?.ended ?? [])
      void renewal.recheck(profileId);
    return update;
  };

  const holds: VaultHolds = {
    get: (holdId) => table.get(holdId),
    get fencing() {
      return table.fencing;
    },
    fence: (profileIds) => recheckEnded(table.fence(profileIds)),
    registerWriter: (holdId, serverBootId, writer) =>
      table.registerWriter(holdId, serverBootId, writer),
    release: (holdId, serverBootId) => {
      const outcome = table.release(holdId, serverBootId);
      return outcome.released ? recheckEnded(outcome) : outcome;
    },
    forceRelease: (holdId) => recheckEnded(table.forceRelease(holdId)),
    check: (currentBootId) => recheckEnded(table.check(currentBootId)),
    stuck: () => table.stuck(),
    acquire: (profileId, holdId, owner, signal) =>
      lane.acquire(profileId, holdId, owner, signal),
  };

  return {
    async credentialFor(binding): Promise<VaultCredential> {
      const credential = await renewal.credentialFor(binding);
      if (!credential.ok) return credential;
      const { headers, token } = credential.read;
      return { ok: true, headers, token };
    },
    upstream401: (binding, sentToken) =>
      renewal.upstream401(binding, sentToken),
    needsLogin: () => renewal.needsLogin(),
    holds,
    ...createVaultLogins(
      options.logins ?? { stateDir: undefined, drivers: {} },
      lane,
      (profileId) => void renewal.recheck(profileId),
    ),
    ...createVaultIntegrations(options.integrations ?? { stateDir: undefined }),
    lane,
    holdRecords: () => table.records(),
    recheck: (profileId) => renewal.recheck(profileId),
    renewDue: () => renewal.tick(),
    close: () => renewal.close(),
  };
}
