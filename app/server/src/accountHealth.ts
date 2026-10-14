import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  AccountHealth,
  AccountLoginAlert,
  CredentialProfileSummary,
  ServerMessage,
} from "@assistant/shared";
import {
  accountLoginAlerts,
  accountSettingsPath,
  isSubscriptionAccountModel,
} from "@assistant/shared/accountHealth";
import type {
  ClaudeUsageSnapshot,
  OpenAiUsageSnapshot,
} from "@assistant/shared/usage";
import type { AgentStopReason } from "@assistant/shared/session";
import { DATA_DIR } from "./config.ts";
import { AccountBenchStore } from "./accountBench.ts";
import { analyzeProviderError, runFailureFacts } from "./providerErrors.ts";
import type { RunFailureFacts } from "./session/adapters/contract.ts";
import type { RunFailureReport } from "./session/runtime/liveSession.ts";

const UNKNOWN: AccountHealth = { state: "unknown", since: null };
const DISCONNECTED: AccountHealth = {
  state: "needs-login",
  since: null,
  reason: "Not connected.",
};
const REJECTED = "Login is no longer valid. Reconnect this account.";

/** Operation-start ticket. Failure reports refresh its order, never its generation. */
export interface AccountObservation {
  order: number;
  generation: number;
}
interface EvidenceClock extends AccountObservation {
  counter: number;
}
interface HealthDeps {
  /** The registry calls summaries() after building rows with pure health lookups. */
  profiles: () => CredentialProfileSummary[];
  hasCredential: (id: string) => boolean;
  now: () => number;
  persistPath: string;
  push: (notification: {
    title: string;
    body: string;
    navigatePath: string;
  }) => Promise<void>;
}
type UsageEvidence =
  | OpenAiUsageSnapshot
  | (Pick<ClaudeUsageSnapshot, "fetchedAt" | "rateLimitsAvailable"> &
      Partial<ClaudeUsageSnapshot>);

/** Durable login evidence; ordering tickets are process-local. */
export class AccountHealthStore {
  private readonly health = new Map<string, AccountHealth>();
  private readonly clocks = new Map<string, EvidenceClock>();
  private readonly wasConnected = new Set<string>();
  private profiles = new Map<string, CredentialProfileSummary>();
  private readonly listeners = new Set<
    (accounts: AccountLoginAlert[]) => void
  >();
  private lastProjection = "[]";
  private lastAlerts: AccountLoginAlert[] = [];
  private dirty = false;
  private readonly benches: AccountBenchStore;
  private lastHealthProjection = "";
  private readonly healthListeners = new Set<() => void>();
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private expiryAt: number | undefined;

  constructor(private readonly deps: HealthDeps) {
    this.benches = new AccountBenchStore(
      `${deps.persistPath.replace(/\.json$/, "")}-benches.json`,
      deps.now,
    );
    try {
      const raw: unknown = JSON.parse(readFileSync(deps.persistPath, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      for (const [id, value] of Object.entries(raw)) {
        if (!/^[A-Za-z0-9_-]+$/.test(id) || !value || typeof value !== "object")
          continue;
        const h = value as AccountHealth & { wasConnected?: boolean };
        const observed =
          (h.state === "ok" || h.state === "needs-login") &&
          Number.isFinite(h.since);
        if (
          !observed &&
          !(
            h.state === "unknown" &&
            h.wasConnected === true &&
            h.since === null
          )
        )
          continue;
        if (h.reason !== undefined && h.reason !== REJECTED) continue;
        if (h.wasConnected === true) this.wasConnected.add(id);
        if (observed)
          this.health.set(id, {
            state: h.state,
            since: h.since,
            ...(h.reason ? { reason: h.reason } : {}),
          });
      }
    } catch {
      /* Missing or corrupt persistence is not a startup failure. */
    }
  }

  read(id: string, configured: boolean): AccountHealth {
    const health = configured ? (this.health.get(id) ?? UNKNOWN) : DISCONNECTED;
    const bench = this.benches.read(id);
    const result =
      health.state !== "needs-login" && bench
        ? {
            state: "limited" as const,
            since: bench.since,
            until: bench.until,
            ...(bench.model ? { model: bench.model } : {}),
          }
        : health;
    return this.benches.revision
      ? { ...result, benchRevision: this.benches.revision }
      : result;
  }

  bench(id: string, model: string) {
    return this.benches.read(id, model);
  }

  subscribeHealth(listener: () => void): () => void {
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }

  /** The single publication point, after the registry has read each credential once. */
  summaries(
    read: () => CredentialProfileSummary[],
  ): CredentialProfileSummary[] {
    this.benches.expire();
    const profiles = read();
    this.profiles = new Map(profiles.map((profile) => [profile.id, profile]));
    for (const profile of profiles)
      if (profile.health.reason !== DISCONNECTED.reason)
        this.rememberConnection(profile.id);
    for (const id of new Set([
      ...this.health.keys(),
      ...this.clocks.keys(),
      ...this.wasConnected,
      ...this.benches.ids(),
    ]))
      if (!this.profiles.has(id)) this.remove(id);
    this.persist();
    this.armExpiry();
    const healthProjection = JSON.stringify(
      profiles.map(({ id, health }) => [id, health]),
    );
    if (healthProjection !== this.lastHealthProjection) {
      this.lastHealthProjection = healthProjection;
      for (const listener of this.healthListeners) {
        try {
          listener();
        } catch {
          /* Independent invalidation listeners. */
        }
      }
    }
    const accounts = accountLoginAlerts(
      profiles.filter(
        (profile) =>
          this.wasConnected.has(profile.id) ||
          this.health.get(profile.id)?.state === "needs-login",
      ),
    );
    const projection = JSON.stringify(accounts);
    this.lastAlerts = accounts;
    if (projection !== this.lastProjection) {
      this.lastProjection = projection;
      for (const listener of this.listeners) {
        try {
          listener(accounts);
        } catch {
          /* Listeners are independent. */
        }
      }
    }
    return profiles;
  }

  dispose(): void {
    clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.expiryAt = undefined;
  }

  private armExpiry(): void {
    const until = this.benches.nextExpiry();
    if (until === this.expiryAt) return;
    this.dispose();
    if (until === undefined) return;
    this.expiryAt = until;
    this.expiryTimer = setTimeout(
      () => {
        this.expiryTimer = undefined;
        this.expiryAt = undefined;
        this.recordEvidence(() => this.deps.profiles());
      },
      Math.max(1, Math.min(until - this.deps.now(), 2_147_483_647)),
    );
    this.expiryTimer.unref();
  }

  alerts(): AccountLoginAlert[] {
    this.deps.profiles();
    return this.lastAlerts;
  }

  subscribe(listener: (accounts: AccountLoginAlert[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  observe(id: string): AccountObservation {
    const clock = this.clock(id);
    return { order: ++clock.counter, generation: clock.generation };
  }

  loginCompleted(id: string): void {
    this.recordEvidence(() => {
      if (this.profiles.has(id)) this.clock(id).generation++;
      this.update(id, "ok");
    });
  }

  runFailure(
    id: string,
    failure: RunFailureFacts | undefined,
    modelProvider: string | undefined,
    observation?: AccountObservation,
  ): void {
    this.recordEvidence(() => {
      const profile = this.profiles.get(id);
      if (
        profile &&
        isSubscriptionAccountModel(profile.provider, modelProvider) &&
        (failure?.kind === "quota" || failure?.kind === "rate_limit")
      ) {
        // Failure reports refresh order, never the start ticket's generation.
        const reported = this.observe(id);
        if (
          (observation?.generation ?? reported.generation) ===
          this.clock(id).generation
        )
          this.benches.failure(id, failure, reported.order);
      }
      if (
        profile &&
        isSubscriptionAccountModel(profile.provider, modelProvider) &&
        failure?.kind === "auth" &&
        failure.loginDeath
      ) {
        const reported = this.observe(id);
        this.update(id, "needs-login", {
          ...reported,
          generation: observation?.generation ?? reported.generation,
        });
      } else this.deps.profiles();
    });
  }

  runWorking(
    id: string,
    modelProvider: string | undefined,
    observation?: AccountObservation,
    modelId?: string,
  ): void {
    this.recordEvidence(() => {
      const profile = this.profiles.get(id);
      if (
        profile &&
        isSubscriptionAccountModel(profile.provider, modelProvider)
      ) {
        const ticket = observation ?? this.observe(id);
        if (ticket.generation === this.clock(id).generation)
          this.benches.working(id, modelId, ticket.order);
        this.update(id, "ok", ticket);
      } else this.deps.profiles();
    });
  }

  usageSnapshot(
    id: string,
    snapshot: UsageEvidence,
    observation?: AccountObservation,
  ): void {
    this.recordEvidence(() => {
      const ticket = observation ?? this.observe(id);
      this.benchUsage(id, snapshot, ticket);
      if (
        "available" in snapshot
          ? snapshot.available
          : snapshot.rateLimitsAvailable === true
      )
        this.update(id, "ok", ticket);
      else if (
        "available" in snapshot &&
        snapshot.unavailableCode === "rejected"
      )
        this.update(id, "needs-login", ticket);
      else this.deps.profiles();
    });
  }

  private benchUsage(
    id: string,
    snapshot: UsageEvidence,
    ticket: AccountObservation,
  ): void {
    const profile = this.profiles.get(id);
    if (
      profile &&
      (profile.provider === "openai-codex") === "available" in snapshot &&
      ticket.generation === this.clock(id).generation
    )
      this.benches.usage(id, snapshot, ticket.order);
  }

  usageFailure(
    id: string,
    message: string,
    observation?: AccountObservation,
  ): void {
    this.recordEvidence(() => {
      if (runFailureFacts(analyzeProviderError(message)).loginDeath)
        this.update(id, "needs-login", observation);
      else this.deps.profiles();
    });
  }

  forget(id: string): void {
    this.recordEvidence(() => {
      this.remove(id);
      this.deps.profiles();
    });
  }

  /** Health must not change the caller's outcome or log provider/credential prose. */
  private recordEvidence(record: () => void): void {
    try {
      record();
    } catch {
      console.warn("[account-health] could not record account evidence");
    }
  }

  private update(
    id: string,
    state: "ok" | "needs-login",
    observation = this.observe(id),
  ): void {
    const profile = this.profiles.get(id);
    let notify = false;
    if (
      profile &&
      (state === "ok" || this.deps.hasCredential(id)) &&
      this.accept(id, observation)
    ) {
      if (this.health.get(id)?.state !== state) {
        this.health.set(id, {
          state,
          since: this.deps.now(),
          ...(state === "needs-login" ? { reason: REJECTED } : {}),
        });
        this.dirty = true;
        notify = state === "needs-login" && profile.enabled;
      }
    }
    this.deps.profiles();
    if (notify && profile)
      void this.deps
        .push({
          title: `${profile.name} needs login`,
          body: REJECTED,
          navigatePath: accountSettingsPath(profile.provider),
        })
        .catch(() => {});
  }

  private rememberConnection(id: string): void {
    if (this.wasConnected.has(id)) return;
    this.wasConnected.add(id);
    this.dirty = true;
  }

  private remove(id: string): void {
    this.benches.forget(id);
    if (this.health.delete(id)) this.dirty = true;
    if (this.wasConnected.delete(id)) this.dirty = true;
    this.clocks.delete(id);
    this.profiles.delete(id);
  }

  private clock(id: string): EvidenceClock {
    let clock = this.clocks.get(id);
    if (!clock) {
      clock = { order: 0, counter: 0, generation: 0 };
      this.clocks.set(id, clock);
    }
    return clock;
  }

  private accept(id: string, observation: AccountObservation): boolean {
    const clock = this.clock(id);
    if (
      observation.generation !== clock.generation ||
      observation.order < clock.order
    )
      return false;
    clock.order = observation.order;
    return true;
  }

  private persist(): void {
    if (!this.dirty) return;
    try {
      mkdirSync(dirname(this.deps.persistPath), {
        recursive: true,
        mode: 0o700,
      });
      const tmp = `${this.deps.persistPath}.tmp`;
      const entries = [
        ...new Set([...this.health.keys(), ...this.wasConnected]),
      ].map((id) => [
        id,
        {
          ...(this.health.get(id) ?? UNKNOWN),
          wasConnected: this.wasConnected.has(id),
        },
      ]);
      writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(entries))}\n`, {
        mode: 0o600,
      });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.deps.persistPath);
      this.dirty = false;
    } catch {
      /* Health remains usable when persistence fails. */
    }
  }
}

let store: AccountHealthStore | undefined;
export function initializeAccountHealth(host: {
  broadcast: (message: ServerMessage) => void;
  push: HealthDeps["push"];
  profiles: HealthDeps["profiles"];
  hasCredential: HealthDeps["hasCredential"];
  subscribeChanges: (listener: (id: string) => void) => () => void;
  subscribeDeleted: (listener: (id: string) => void) => () => void;
}): void {
  if (store) return;
  store = new AccountHealthStore({
    profiles: host.profiles,
    hasCredential: host.hasCredential,
    now: Date.now,
    persistPath: join(DATA_DIR, "cache", "account-health.json"),
    push: host.push,
  });
  host.profiles();
  store.subscribeHealth(() => host.broadcast({ type: "accountHealthChanged" }));
  store.subscribe((accounts) =>
    host.broadcast({ type: "accountLoginAlerts", accounts }),
  );
  host.subscribeChanges(() => host.profiles());
  host.subscribeDeleted((id) => store!.forget(id));
}

export function withAccountHealthProfiles(
  read: () => CredentialProfileSummary[],
): CredentialProfileSummary[] {
  return store?.summaries(read) ?? read();
}
export function readAccountHealth(
  id: string,
  configured: boolean,
): AccountHealth {
  return configured ? (store?.read(id, true) ?? UNKNOWN) : DISCONNECTED;
}
export function readAccountBench(id: string, model: string) {
  return store?.bench(id, model);
}
export function sendAccountLoginAlertsTo(connection: {
  send: (message: ServerMessage) => void;
}): void {
  connection.send({
    type: "accountLoginAlerts",
    accounts: store?.alerts() ?? [],
  });
}
export function observeAccountHealth(
  id: string,
): AccountObservation | undefined {
  return store?.observe(id);
}
export function reportAccountLoginCompleted(id: string): void {
  store?.loginCompleted(id);
}
export function reportAccountRunWorking(
  id: string,
  modelProvider: string | undefined,
  observation?: AccountObservation,
  modelId?: string,
): void {
  store?.runWorking(id, modelProvider, observation, modelId);
}
export function reportAccountRunFailure(
  id: string,
  failure: RunFailureFacts | undefined,
  modelProvider: string | undefined,
  observation?: AccountObservation,
): void {
  store?.runFailure(id, failure, modelProvider, observation);
}
export function reportAccountUsageSnapshot(
  id: string,
  snapshot: UsageEvidence,
  observation?: AccountObservation,
): void {
  store?.usageSnapshot(id, snapshot, observation);
}
export function reportAccountUsageFailure(
  id: string,
  message: string,
  observation?: AccountObservation,
): void {
  store?.usageFailure(id, message, observation);
}

/** Only an explicit session binding can attribute health, never automatic selection. */
export function trackSessionRunHealth(
  host: {
    session: (
      sessionId: string,
    ) => { credentialProfileId?: string | null } | undefined;
    subscribeStarted: (
      listener: (
        sessionId: string,
        runId: string,
        modelProvider: string | undefined,
        modelId?: string,
      ) => void,
    ) => () => void;
    subscribeFailed: (
      listener: (report: RunFailureReport) => void,
    ) => () => void;
    subscribeClosed: (
      listener: (
        sessionId: string,
        runId: string,
        stopReason: AgentStopReason | undefined,
      ) => void,
    ) => () => void;
  },
  health = {
    observe: observeAccountHealth,
    failed: reportAccountRunFailure,
    working: reportAccountRunWorking,
  },
) {
  const runs = new Map<
    string,
    {
      runId: string;
      profileId: string;
      modelProvider: string | undefined;
      modelId: string | undefined;
      observation: AccountObservation | undefined;
    }
  >();
  const off = [
    host.subscribeStarted((sessionId, runId, modelProvider, modelId) => {
      runs.delete(sessionId);
      const profileId = host.session(sessionId)?.credentialProfileId;
      if (profileId)
        runs.set(sessionId, {
          runId,
          profileId,
          modelProvider,
          modelId,
          observation: health.observe(profileId),
        });
    }),
    host.subscribeFailed(({ sessionId, runId, failure }) => {
      const run = runs.get(sessionId);
      if (run?.runId !== runId) return;
      runs.delete(sessionId);
      health.failed(run.profileId, failure, run.modelProvider, run.observation);
    }),
    host.subscribeClosed((sessionId, runId, stopReason) => {
      const run = runs.get(sessionId);
      if (run?.runId !== runId) return;
      runs.delete(sessionId);
      if (stopReason === "end")
        health.working(
          run.profileId,
          run.modelProvider,
          run.observation,
          ...(run.modelId ? [run.modelId] : []),
        );
    }),
  ];
  return {
    dispose() {
      for (const unsubscribe of off) unsubscribe();
      runs.clear();
    },
  };
}
