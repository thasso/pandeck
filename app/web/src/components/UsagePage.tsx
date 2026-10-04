import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle, Gauge, RefreshCw, Ticket, X } from "lucide-react";
import type {
  ClaudeUsageSnapshot,
  OpenAiResetCredit,
  OpenAiUsageSnapshot,
  ResetCreditExpiryLevel,
  UsageLimitWindow,
} from "@assistant/shared/usage";
import {
  OPENAI_RESET_AUTO_REDEEM_LEAD_MS,
  formatUsageReset,
  resetCreditExpiryLevel,
  usageLevel,
} from "@assistant/shared/usage";
import type { CredentialProfileSummary } from "@assistant/shared";
import {
  fetchClaudeUsage,
  fetchOpenAiUsage,
  redeemOpenAiResetCredit,
  type RedeemRefusedError,
} from "../lib/usage.ts";
import {
  fetchCredentialProfiles,
  orderCredentialProfilesByProvider,
} from "../lib/credentialProfiles.ts";
import { PageHeader, type PageHeaderBack } from "./PageHeader.tsx";
import { GhostIconButton } from "./ui/GhostIconButton.tsx";
import { ProviderIcon } from "./ui/ProviderIcon.tsx";
import {
  EmptyBox,
  ErrorNote,
  RefreshIndicator,
  Skeleton,
  Spinner,
} from "./ui/load.tsx";
import { useFetchState } from "../hooks/useFetchState.ts";
import { useNow } from "../hooks/useNow.ts";
import {
  beginLoad,
  dataOf,
  errorOf,
  failFrom,
  isInitialLoad,
  isPending,
  ready,
  type LoadState,
} from "../lib/loadState.ts";

/**
 * @component UsagePage
 * @purpose Main-pane surface for provider account usage/rate-limit data —
 * Claude (the SDK's experimental `/usage`-equivalent control request) and
 * OpenAI/ChatGPT+Codex (the ChatGPT backend `/wham/usage` endpoint, authed with
 * the credentials pi logged in with). Rate-limit windows render as horizontal
 * "% used" meters with live reset countdowns; utilization is always CONSUMED,
 * never remaining. Each provider loads/refreshes and fails independently.
 */
export function UsagePage({ back }: { back?: PageHeaderBack | undefined }) {
  // One query, one key: the enabled-account list is what every section below
  // is keyed on, so an empty state may only be drawn once it has answered (R1).
  const { state: profileState, reload: reloadProfiles } = useFetchState(
    PROFILES_KEY,
    fetchEnabledProfiles,
  );
  const profiles = useMemo(() => dataOf(profileState) ?? [], [profileState]);
  const profilesLoaded = dataOf(profileState) !== undefined;
  const profileError = errorOf(profileState);
  const orderedProfiles = useMemo(
    () => orderCredentialProfilesByProvider(profiles),
    [profiles],
  );
  const claudeProfiles = useMemo(
    () => orderedProfiles.filter((profile) => profile.provider === "claude"),
    [orderedProfiles],
  );
  const openAiProfiles = useMemo(
    () =>
      orderedProfiles.filter((profile) => profile.provider === "openai-codex"),
    [orderedProfiles],
  );
  // Mount reads the shared server cache (instant, and no CLI subprocess per
  // page open); the refresh button forces a live provider fetch that writes
  // through for every other open surface — see `docs/usage.md`.
  const claude = useProfileUsage(claudeProfiles, fetchClaudeUsage);
  const openai = useProfileUsage(openAiProfiles, fetchOpenAiUsage);
  // Ticks every 30s so reset countdowns stay live without re-fetching.
  const now = useNow(30_000);
  const refreshing =
    claude.pending || openai.pending || isPending(profileState);

  return (
    <div className="flex h-full w-full flex-col bg-surface text-fg">
      <PageHeader
        back={back}
        icon={<Gauge size={16} />}
        iconTone="accent"
        title="Usage"
        subtitle="Provider account limits"
        actions={
          <GhostIconButton
            icon={refreshing ? <Spinner size="md" /> : <RefreshCw size={15} />}
            label="Refresh usage"
            // The accounts themselves are not refetched here: a new list
            // identity restarts every account's cached load, which would race
            // the live one this button exists to run. Retrying the LIST is the
            // error note's job.
            onClick={() => {
              void claude.loadAll({ refresh: true });
              void openai.loadAll({ refresh: true });
            }}
          />
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-8">
          <section className="flex flex-col gap-3">
            <div>
              <h2 className="text-heading font-semibold text-fg">
                At a glance
              </h2>
              <p className="mt-0.5 text-caption text-muted">
                Current subscription limits across every enabled account.
              </p>
            </div>
            {/* R2: a failed refresh keeps the accounts it already listed and
                says so above them, retryable from where it failed. */}
            {profileError ? (
              <ErrorNote message={profileError} onRetry={reloadProfiles} />
            ) : null}
            {/* R1: "no accounts" is an answer, not the absence of one. */}
            {isInitialLoad(profileState) ? (
              <div
                role="status"
                aria-label="Loading provider accounts"
                className="grid grid-cols-1 gap-3 sm:grid-cols-2"
              >
                <Skeleton className="h-[7.5rem]" />
                <Skeleton className="h-[7.5rem]" />
              </div>
            ) : profilesLoaded && orderedProfiles.length === 0 ? (
              <EmptyBox>No enabled provider accounts.</EmptyBox>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {orderedProfiles.map((profile) =>
                  profile.provider === "claude" ? (
                    <UsageOverviewCard
                      key={profile.id}
                      profile={profile}
                      state={claude.states[profile.id]}
                      now={now}
                    />
                  ) : (
                    <UsageOverviewCard
                      key={profile.id}
                      profile={profile}
                      state={openai.states[profile.id]}
                      now={now}
                    />
                  ),
                )}
              </div>
            )}
          </section>

          <UsageProviderSection
            title="Claude"
            provider="claude-sdk"
            loading={isInitialLoad(profileState)}
            empty={profilesLoaded && claudeProfiles.length === 0}
          >
            {claudeProfiles.map((profile) => {
              const state = claude.states[profile.id];
              const snapshot = state ? dataOf(state) : undefined;
              return (
                <UsageAccountSection
                  key={profile.id}
                  profile={profile}
                  subtitle={
                    snapshot
                      ? subscriptionLabel(snapshot.subscriptionType)
                      : undefined
                  }
                  state={state}
                  onRetry={() => void claude.loadProfile(profile.id)}
                  fetchingLabel="Fetching Claude usage…"
                >
                  {snapshot ? (
                    <ClaudeUsageContent snapshot={snapshot} now={now} />
                  ) : null}
                </UsageAccountSection>
              );
            })}
          </UsageProviderSection>

          <UsageProviderSection
            title="OpenAI"
            provider="openai-codex"
            loading={isInitialLoad(profileState)}
            empty={profilesLoaded && openAiProfiles.length === 0}
          >
            {openAiProfiles.map((profile) => {
              const state = openai.states[profile.id];
              const snapshot = state ? dataOf(state) : undefined;
              return (
                <UsageAccountSection
                  key={profile.id}
                  profile={profile}
                  subtitle={
                    snapshot?.planType
                      ? `${snapshot.planType} plan`
                      : "ChatGPT · Codex"
                  }
                  state={state}
                  onRetry={() => void openai.loadProfile(profile.id)}
                  fetchingLabel="Fetching OpenAI usage…"
                >
                  {snapshot ? (
                    <OpenAiUsageContent
                      snapshot={snapshot}
                      now={now}
                      // A redeemed reset credit changes the windows, so this
                      // reload must bypass the cache rather than re-read it.
                      onReload={() =>
                        openai.loadProfile(profile.id, { refresh: true })
                      }
                      profileId={profile.id}
                    />
                  ) : null}
                </UsageAccountSection>
              );
            })}
          </UsageProviderSection>
        </div>
      </div>
    </div>
  );
}

/** The page's only fetch key: the enabled-account list itself. */
const PROFILES_KEY = "credential-profiles";

function fetchEnabledProfiles(): Promise<CredentialProfileSummary[]> {
  return fetchCredentialProfiles().then((items) =>
    items.filter((profile) => profile.enabled),
  );
}

/**
 * One `LoadState` per account, not one for the provider: accounts load, refresh
 * and fail INDEPENDENTLY, so a second account's failure may not blank the first
 * one's meters. Each slot follows R2 — a re-fetch keeps the snapshot it has and
 * an error keeps it too, under an `ErrorNote`.
 */
function useProfileUsage<T>(
  profiles: CredentialProfileSummary[],
  fetcher: (profileId?: string, options?: { refresh?: boolean }) => Promise<T>,
): {
  states: Record<string, LoadState<T>>;
  /** A fetch is in flight for at least one of this provider's accounts. */
  pending: boolean;
  loadProfile: (
    profileId: string,
    options?: { refresh?: boolean },
  ) => Promise<void>;
  loadAll: (options?: { refresh?: boolean }) => Promise<void>;
} {
  const [states, setStates] = useState<Record<string, LoadState<T>>>({});
  const generations = useRef(new Map<string, number>());
  const loadProfile = useCallback(
    async (profileId: string, options: { refresh?: boolean } = {}) => {
      const generation = (generations.current.get(profileId) ?? 0) + 1;
      generations.current.set(profileId, generation);
      setStates((current) => ({
        ...current,
        [profileId]: beginLoad<T>(current[profileId] ?? { status: "loading" }),
      }));
      try {
        const snapshot = await fetcher(profileId, options);
        if (generations.current.get(profileId) === generation) {
          setStates((current) => ({
            ...current,
            [profileId]: ready(snapshot),
          }));
        }
      } catch (error) {
        if (generations.current.get(profileId) === generation) {
          setStates((current) => ({
            ...current,
            [profileId]: failFrom(
              current[profileId] ?? { status: "loading" },
              error instanceof Error ? error.message : String(error),
            ),
          }));
        }
      }
    },
    [fetcher],
  );
  const loadAll = useCallback(
    async (options: { refresh?: boolean } = {}) => {
      await Promise.all(
        profiles.map((profile) => loadProfile(profile.id, options)),
      );
    },
    [loadProfile, profiles],
  );
  useEffect(() => {
    const ids = new Set(profiles.map((profile) => profile.id));
    setStates((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))),
    );
    void loadAll();
  }, [loadAll, profiles]);
  return {
    states,
    pending: profiles.some((profile) => {
      const state = states[profile.id];
      return state !== undefined && isPending(state);
    }),
    loadProfile,
    loadAll,
  };
}

interface UsageOverviewRow {
  label: string;
  pct: number | null;
  resetsAt: string | null;
}

export function usageOverviewRows(
  snapshot: ClaudeUsageSnapshot | OpenAiUsageSnapshot,
): UsageOverviewRow[] {
  if ("rateLimitsAvailable" in snapshot) {
    if (!snapshot.rateLimitsAvailable) return [];
    return [
      {
        label: "5-hour",
        pct: snapshot.fiveHour?.utilizationPct ?? null,
        resetsAt: snapshot.fiveHour?.resetsAt ?? null,
      },
      {
        label: "Weekly",
        pct: snapshot.weekly?.utilizationPct ?? null,
        resetsAt: snapshot.weekly?.resetsAt ?? null,
      },
    ];
  }
  if (!snapshot.available) return [];
  return snapshot.windows
    .filter((window) => window.kind === "five_hour" || window.kind === "weekly")
    .map((window) => ({
      label: openAiWindowTitle(window),
      pct: window.usedPercent,
      resetsAt: window.resetsAt,
    }));
}

export function UsageOverviewCard({
  profile,
  state,
  now,
}: {
  profile: CredentialProfileSummary;
  /** Undefined until this account's first fetch has even been started. */
  state: LoadState<ClaudeUsageSnapshot | OpenAiUsageSnapshot> | undefined;
  now: number;
}) {
  const snapshot = state ? dataOf(state) : undefined;
  const error = state ? errorOf(state) : undefined;
  // No slot yet is the same thing to a reader as a first fetch in flight.
  const firstLoad = !snapshot && !error;
  const rows = snapshot ? usageOverviewRows(snapshot) : [];
  const unavailable =
    snapshot && "available" in snapshot && !snapshot.available
      ? (snapshot.unavailableReason ?? "Usage unavailable")
      : snapshot &&
          "rateLimitsAvailable" in snapshot &&
          !snapshot.rateLimitsAvailable
        ? "Plan limits unavailable"
        : undefined;
  return (
    <div className="rounded-xl border border-line bg-panel p-3.5">
      <div className="flex items-center gap-2">
        <ProviderIcon
          provider={profile.provider}
          size={15}
          className="shrink-0 text-accent"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-caption font-semibold text-fg">
            {profile.name}
          </div>
          <div className="text-caption text-faint">
            {profile.provider === "claude" ? "Claude" : "OpenAI"}
          </div>
        </div>
        {/* R2: the meters below stay up while the account refetches. */}
        {snapshot && state && isPending(state) ? (
          <RefreshIndicator label={`Refreshing ${profile.name} usage`} />
        ) : null}
      </div>
      <div className="mt-3 flex flex-col gap-2.5">
        {rows.map((row) => (
          <CompactUsageMeter key={row.label} {...row} now={now} />
        ))}
        {error ? <ErrorNote message={error} /> : null}
        {/* R4: two meter-shaped rows, so the card does not resize when the
            numbers land. */}
        {firstLoad ? (
          <div
            role="status"
            aria-label={`Loading ${profile.name} usage`}
            className="flex flex-col gap-2.5"
          >
            <Skeleton className="h-[2.85rem]" />
            <Skeleton className="h-[2.85rem]" />
          </div>
        ) : null}
        {unavailable ? (
          <p className="text-caption text-muted">{unavailable}</p>
        ) : null}
        {snapshot && rows.length === 0 && !unavailable ? (
          <p className="text-caption text-muted">
            No subscription windows reported.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function CompactUsageMeter({
  label,
  pct,
  resetsAt,
  now,
}: UsageOverviewRow & { now: number }) {
  const clamped = pct === null ? 0 : Math.min(100, Math.max(0, pct));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-caption">
        <span className="text-muted">{label}</span>
        <span className="font-semibold tabular-nums text-fg">
          {pct === null ? "—" : `${Math.round(pct)}%`}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line">
        <div
          className={`h-full rounded-full ${meterColor(clamped)}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <div className="mt-0.5 text-right text-micro text-faint">
        {resetCountdown(resetsAt, now)}
      </div>
    </div>
  );
}

function UsageProviderSection({
  title,
  provider,
  loading,
  empty,
  children,
}: {
  title: string;
  provider: string;
  /** The account list itself has not answered yet — no claim either way. */
  loading: boolean;
  empty: boolean;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-panel text-accent">
          <ProviderIcon provider={provider} size={15} />
        </span>
        <h2 className="text-body font-semibold text-fg">{title}</h2>
      </div>
      {loading ? (
        <div role="status" aria-label={`Loading ${title} accounts`}>
          <Skeleton className="h-24" />
        </div>
      ) : empty ? (
        <EmptyBox>No enabled {title} accounts.</EmptyBox>
      ) : (
        children
      )}
    </section>
  );
}

function UsageAccountSection<T>({
  profile,
  subtitle,
  state,
  fetchingLabel,
  onRetry,
  children,
}: {
  profile: CredentialProfileSummary;
  subtitle?: string | undefined;
  state: LoadState<T> | undefined;
  fetchingLabel: string;
  onRetry: () => void;
  children: ReactNode;
}) {
  const snapshot = state ? dataOf(state) : undefined;
  const error = state ? errorOf(state) : undefined;
  return (
    <section className="flex flex-col gap-3 border-t border-line pt-4 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-body font-semibold text-fg">{profile.name}</div>
          {subtitle ? (
            <div className="text-caption text-muted">{subtitle}</div>
          ) : null}
        </div>
        {/* R2: the section keeps its detail while the account refetches. */}
        {snapshot && state && isPending(state) ? (
          <RefreshIndicator label={`Refreshing ${profile.name} usage`} />
        ) : null}
      </div>
      {error ? <ErrorNote message={error} onRetry={onRetry} /> : null}
      {/* R4: the meters card's silhouette, so nothing jumps when it lands. */}
      {!snapshot && !error ? (
        <div role="status" aria-label={fetchingLabel} className="space-y-3">
          <Skeleton className="h-[9.5rem]" />
        </div>
      ) : (
        children
      )}
    </section>
  );
}

function subscriptionLabel(type: string | null): string | undefined {
  if (!type) return undefined;
  return `${type.charAt(0).toUpperCase()}${type.slice(1)} plan`;
}

/** "Resets in 1d 5h" / "Resets in 5h 12m" / "Resets in 8m" / "Resetting now". */
function resetCountdown(iso: string | null, now: number): string {
  if (!iso) return "No scheduled reset";
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return "No scheduled reset";
  const ms = target - now;
  if (ms <= 0) return "Resetting now";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `Resets in ${days}d ${hours}h`;
  if (hours > 0) return `Resets in ${hours}h ${minutes}m`;
  return `Resets in ${minutes}m`;
}

/** Shared thresholds so the cards and this page never disagree (`usageLevel`). */
function meterColor(pct: number): string {
  const level = usageLevel(pct);
  if (level === "critical") return "bg-danger";
  if (level === "warn") return "bg-warning";
  return "bg-accent";
}

function severityTone(severity: string | null): string {
  if (severity === "critical") return "text-danger";
  if (severity === "warning") return "text-amber-500";
  return "text-fg";
}

/** A horizontal "% used" meter with a live reset countdown, shared across providers. */
function UsageMeter({
  title,
  pct,
  resetsAt,
  now,
}: {
  title: string;
  pct: number | null;
  resetsAt: string | null;
  now: number;
}) {
  const clamped = pct === null ? 0 : Math.min(100, Math.max(0, pct));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-caption text-fg">{title}</span>
        <span className="text-caption font-semibold tabular-nums text-fg">
          {pct === null ? "—" : `${Math.round(pct)}% used`}
        </span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-line">
        <div
          className={`h-full rounded-full transition-[width] ${meterColor(clamped)}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-3 text-caption text-faint">
        <span>
          {pct === null
            ? ""
            : `${Math.max(0, 100 - Math.round(pct))}% remaining`}
        </span>
        <span>{resetCountdown(resetsAt, now)}</span>
      </div>
    </div>
  );
}

function ClaudeUsageContent({
  snapshot,
  now,
}: {
  snapshot: ClaudeUsageSnapshot;
  now: number;
}) {
  if (!snapshot.rateLimitsAvailable) {
    return (
      <EmptyBox>
        Plan rate limits are not available for this connection
        (API-key/Bedrock/Vertex sessions have no 5-hour or weekly caps).
      </EmptyBox>
    );
  }

  const modelScoped = snapshot.modelScoped.filter((m) => m.modelDisplayName);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-line bg-panel p-3.5">
        <div className="mb-1 flex items-baseline justify-between">
          <div className="text-caption font-semibold text-fg">
            Plan limits used
          </div>
          <div className="text-caption text-faint">
            Percent consumed — 100% means the cap is reached
          </div>
        </div>
        <div className="mt-2 flex flex-col gap-3.5">
          <ClaudeMeter
            title="5-hour session"
            window={snapshot.fiveHour}
            now={now}
          />
          <ClaudeMeter title="Weekly" window={snapshot.weekly} now={now} />
          {modelScoped.map((m) => (
            <UsageMeter
              key={m.modelDisplayName}
              title={`Weekly · ${m.modelDisplayName}`}
              pct={m.utilizationPct}
              resetsAt={m.resetsAt}
              now={now}
            />
          ))}
        </div>
      </div>

      {snapshot.extraUsage?.enabled ? (
        <ExtraUsageCard extraUsage={snapshot.extraUsage} />
      ) : null}

      {snapshot.limits.length > 0 ? (
        <div className="rounded-xl border border-line bg-panel p-3">
          <div className="mb-2 text-caption font-semibold text-fg">
            All reported limits
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-caption">
              <thead>
                <tr>
                  <th className="border-b border-line px-2 py-1 text-left font-medium text-muted">
                    Kind
                  </th>
                  <th className="border-b border-line px-2 py-1 text-right font-medium text-muted">
                    Used
                  </th>
                  <th className="border-b border-line px-2 py-1 text-left font-medium text-muted">
                    Resets
                  </th>
                  <th className="border-b border-line px-2 py-1 text-left font-medium text-muted">
                    Scope
                  </th>
                </tr>
              </thead>
              <tbody>
                {snapshot.limits.map((limit, index) => (
                  <tr key={`${limit.kind}-${index}`}>
                    <td className="border-b border-line/50 px-2 py-1 text-left text-fg">
                      {limit.kind}
                    </td>
                    <td
                      className={`border-b border-line/50 px-2 py-1 text-right tabular-nums ${severityTone(limit.severity)}`}
                    >
                      {limit.percent === null
                        ? "—"
                        : `${Math.round(limit.percent)}%`}
                    </td>
                    <td className="border-b border-line/50 px-2 py-1 text-left text-muted">
                      {resetCountdown(limit.resetsAt, now)}
                    </td>
                    <td className="border-b border-line/50 px-2 py-1 text-left text-muted">
                      {limit.scope?.modelDisplayName ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {snapshot.behaviors ? (
        <BehaviorsSection behaviors={snapshot.behaviors} />
      ) : null}

      <div className="text-caption text-faint">
        Last updated {new Date(snapshot.fetchedAt).toLocaleTimeString()}
      </div>
    </div>
  );
}

/** Claude window adapter over the shared meter. */
function ClaudeMeter({
  title,
  window,
  now,
}: {
  title: string;
  window: UsageLimitWindow | null;
  now: number;
}) {
  return (
    <UsageMeter
      title={title}
      pct={window?.utilizationPct ?? null}
      resetsAt={window?.resetsAt ?? null}
      now={now}
    />
  );
}

/**
 * Overage credits. Raw `usedCredits`/`monthlyLimit` are MINOR currency units
 * (cents), so we divide by 10^decimalPlaces — a raw 5025 is €50.25, not €5025.
 */
function ExtraUsageCard({
  extraUsage,
}: {
  extraUsage: NonNullable<ClaudeUsageSnapshot["extraUsage"]>;
}) {
  const factor = 10 ** (extraUsage.decimalPlaces ?? 0);
  const currency = extraUsage.currency ?? "";
  const fmt = (minor: number | null): string | null => {
    if (minor === null) return null;
    const major = minor / factor;
    const digits = extraUsage.decimalPlaces ?? 0;
    try {
      return currency
        ? new Intl.NumberFormat(undefined, {
            style: "currency",
            currency,
          }).format(major)
        : major.toFixed(digits);
    } catch {
      return `${major.toFixed(digits)} ${currency}`.trim();
    }
  };
  const used = fmt(extraUsage.usedCredits);
  const limit = fmt(extraUsage.monthlyLimit);
  const over =
    extraUsage.utilizationPct !== null && extraUsage.utilizationPct >= 100;
  return (
    <div className="rounded-xl border border-line bg-panel p-3">
      <div className="text-caption font-medium text-muted">
        Extra usage credits (this month)
      </div>
      <div className="mt-1 text-heading font-semibold tabular-nums text-fg">
        {used === null || limit === null ? "—" : `${used} / ${limit}`}
      </div>
      {extraUsage.utilizationPct !== null ? (
        <div
          className={`mt-1 text-caption ${over ? "text-danger" : "text-faint"}`}
        >
          {Math.round(extraUsage.utilizationPct)}% used
          {over ? " · spend cap reached" : ""}
        </div>
      ) : null}
    </div>
  );
}

function BehaviorsSection({
  behaviors,
}: {
  behaviors: NonNullable<ClaudeUsageSnapshot["behaviors"]>;
}) {
  return (
    <div className="rounded-xl border border-line bg-panel p-3">
      <div className="mb-2 text-caption font-semibold text-fg">
        Local activity (approximate, this machine only)
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <BehaviorWindow label="Last 24 hours" window={behaviors.day} />
        <BehaviorWindow label="Last 7 days" window={behaviors.week} />
      </div>
    </div>
  );
}

function BehaviorWindow({
  label,
  window,
}: {
  label: string;
  window: NonNullable<ClaudeUsageSnapshot["behaviors"]>["day"];
}) {
  return (
    <div>
      <div className="text-caption font-medium text-muted">{label}</div>
      <div className="text-caption text-fg">
        {window.requestCount.toLocaleString()} requests ·{" "}
        {window.sessionCount.toLocaleString()} sessions
      </div>
      {window.topContributors.length > 0 ? (
        <ul className="mt-1 space-y-0.5 text-caption text-muted">
          {window.topContributors.slice(0, 4).map((c) => (
            <li key={`${c.kind}-${c.name}`}>
              {c.name} — {Math.round(c.pct)}%
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function openAiWindowTitle(
  window: OpenAiUsageSnapshot["windows"][number],
): string {
  if (window.label) return window.label;
  if (window.kind === "five_hour") return "5-hour session";
  if (window.kind === "weekly") return "Weekly";
  return "Rate limit";
}

function OpenAiUsageContent({
  snapshot,
  now,
  onReload,
  profileId,
}: {
  snapshot: OpenAiUsageSnapshot;
  now: number;
  onReload: () => Promise<void>;
  profileId: string;
}) {
  if (!snapshot.available) {
    return (
      <EmptyBox>
        {snapshot.unavailableReason ?? "OpenAI usage is not available."}
      </EmptyBox>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-line bg-panel p-3.5">
        <div className="mb-1 flex items-baseline justify-between">
          <div className="text-caption font-semibold text-fg">
            Plan limits used
          </div>
          <div className="text-caption text-faint">
            Percent consumed — 100% means the cap is reached
          </div>
        </div>
        {snapshot.windows.length > 0 ? (
          <div className="mt-2 flex flex-col gap-3.5">
            {snapshot.windows.map((w, index) => (
              <UsageMeter
                key={`${w.kind}-${w.label ?? index}`}
                title={openAiWindowTitle(w)}
                pct={w.usedPercent}
                resetsAt={w.resetsAt}
                now={now}
              />
            ))}
          </div>
        ) : (
          <div className="mt-2 text-caption text-muted">
            No active rate-limit windows reported right now.
          </div>
        )}
      </div>

      {snapshot.spendControl ? (
        <OpenAiSpendCard spend={snapshot.spendControl} now={now} />
      ) : null}
      {snapshot.credits ? (
        <OpenAiCreditsCard
          credits={snapshot.credits}
          resetCredits={snapshot.resetCredits}
          now={now}
          onReload={onReload}
          profileId={profileId}
        />
      ) : null}

      <div className="text-caption text-faint">
        Last updated {new Date(snapshot.fetchedAt).toLocaleTimeString()}
      </div>
    </div>
  );
}

/**
 * Spend cap ("spend_control"). OpenAI reports NO currency/exponent, so numbers
 * are shown raw (no invented symbol); the caption explains the unit is unknown.
 */
function OpenAiSpendCard({
  spend,
  now,
}: {
  spend: NonNullable<OpenAiUsageSnapshot["spendControl"]>;
  now: number;
}) {
  const fmt = (n: number | null): string =>
    n === null
      ? "—"
      : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const over =
    spend.reached || (spend.usedPercent !== null && spend.usedPercent >= 100);
  return (
    <div className="rounded-xl border border-line bg-panel p-3">
      <div className="text-caption font-medium text-muted">
        Spend limit{spend.source ? ` · ${spend.source.replace(/_/g, " ")}` : ""}
      </div>
      <div className="mt-1 text-heading font-semibold tabular-nums text-fg">
        {fmt(spend.used)} / {fmt(spend.limit)}
      </div>
      <div
        className={`mt-1 text-caption ${over ? "text-danger" : "text-faint"}`}
      >
        {spend.usedPercent !== null
          ? `${Math.round(spend.usedPercent)}% used`
          : ""}
        {over ? " · spend cap reached" : ""}
        {spend.resetsAt ? ` · ${resetCountdown(spend.resetsAt, now)}` : ""}
      </div>
      <div className="mt-1 text-caption text-faint">
        Amounts as reported by OpenAI (currency not specified; typically USD).
      </div>
    </div>
  );
}

/** Calendar-day offset of `at` from `now` in the browser's zone: 0 today, 1 tomorrow. */
function localDayOffset(at: number, now: number): number {
  const day = (ms: number) => {
    const d = new Date(ms);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  };
  return Math.round((day(at) - day(now)) / 86_400_000);
}

/**
 * When a credit lapses, in the browser's zone: `Oct 4` far out, and with the
 * clock time — `Sep 24, 04:21`, `tomorrow 04:21`, `today 04:21` — once that
 * time is the point. OpenAI expires a credit at its grant's time-of-day in UTC,
 * so a bare date reads as "sometime that day" when the truth is 04:21.
 */
function expiryMoment(at: number, now: number, withTime: boolean): string {
  const time = new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (withTime) {
    const offset = localDayOffset(at, now);
    if (offset === 0) return `today ${time}`;
    if (offset === 1) return `tomorrow ${time}`;
  }
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  const date = new Date(at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return withTime ? `${date}, ${time}` : date;
}

/**
 * The expiry line for one credit row, banded by `resetCreditExpiryLevel`. The
 * countdown is the shared banded duration (`2d 22h`, `7h 40m`) rather than a
 * rounded-up day count: "in 1d" for a credit with eight hours left is what
 * loses a credit overnight.
 */
function expiryLabel(
  iso: string | null,
  now: number,
): { text: string; level: ResetCreditExpiryLevel } {
  const level = resetCreditExpiryLevel(iso, now);
  if (level === "unknown") return { text: "expiry unknown", level };
  const at = Date.parse(iso!);
  if (level === "expired")
    return { text: `expired ${expiryMoment(at, now, true)}`, level };
  const withTime = level !== "ok";
  const moment = expiryMoment(at, now, withTime);
  const countdown = formatUsageReset(iso, now);
  if (level === "pending")
    return {
      text: `expires ${moment} · in ${countdown} · auto-redeem due`,
      level,
    };
  if (level === "imminent") {
    const autoAt = new Date(
      at - OPENAI_RESET_AUTO_REDEEM_LEAD_MS,
    ).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return {
      text: `expires ${moment} · in ${countdown} · auto-redeems ${autoAt}`,
      level,
    };
  }
  return { text: `expires ${moment} · in ${countdown}`, level };
}

const EXPIRY_TONE: Record<ResetCreditExpiryLevel, string> = {
  ok: "text-faint",
  soon: "text-warning",
  imminent: "text-danger",
  pending: "text-danger",
  expired: "text-faint line-through",
  unknown: "text-faint",
};

/** "redeemed Sep 21, 22:06" for a spent row the provider still lists. */
function redeemedLabel(iso: string | null, now: number): string {
  if (!iso) return "redeemed";
  const at = Date.parse(iso);
  return Number.isFinite(at)
    ? `redeemed ${expiryMoment(at, now, true)}`
    : "redeemed";
}

export function OpenAiCreditsCard({
  credits,
  resetCredits,
  now,
  onReload,
  profileId,
}: {
  credits: NonNullable<OpenAiUsageSnapshot["credits"]>;
  resetCredits: OpenAiUsageSnapshot["resetCredits"];
  now: number;
  onReload: () => Promise<void>;
  profileId: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // The server's guard said the snapshot's "usable now" was stale: from here
  // on the dialog is the "redeem anyway" one, rather than a 409 loop.
  const [guardRefused, setGuardRefused] = useState(false);

  const status = credits.unlimited
    ? "Unlimited"
    : credits.hasCredits
      ? credits.overageLimitReached
        ? "Available · overage limit reached"
        : "Available"
      : "None";

  const rows = resetCredits?.credits ?? [];
  const available = rows.filter((c) => c.status === "available");
  const redeemed = rows.filter((c) => c.status === "redeemed");
  const applicable = guardRefused ? 0 : (resetCredits?.applicableCount ?? 0);
  // Redeem the soonest-expiring available credit (rows arrive soonest-first).
  const target: OpenAiResetCredit | null = available[0] ?? null;
  // Always clickable while a credit is banked: the dialog carries the warning,
  // and a not-applicable redemption is the user's call, not the button's.
  const canRedeem = !!target && !busy;

  const redeem = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const result = await redeemOpenAiResetCredit(target.id, profileId, {
        force: applicable <= 0,
      });
      setDone(
        result.ok
          ? `Reset applied — ${result.windowsReset ?? 0} window${result.windowsReset === 1 ? "" : "s"} reset.`
          : "Redeem completed, but no window was reset.",
      );
      setConfirming(false);
      await onReload();
    } catch (err) {
      if ((err as RedeemRefusedError).notApplicable) setGuardRefused(true);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-line bg-panel p-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-caption font-medium text-muted">Credits</div>
        {resetCredits && (resetCredits.availableCount ?? 0) > 0 ? (
          <div className="text-caption text-faint">
            {resetCredits.availableCount} reset
            {resetCredits.availableCount === 1 ? "" : "s"} banked
            {applicable > 0 ? ` · ${applicable} usable now` : ""}
          </div>
        ) : null}
      </div>
      <div className="mt-1 text-body text-fg">
        {status}
        {credits.balance !== null
          ? ` · balance ${credits.balance.toLocaleString()}`
          : ""}
      </div>

      {available.length + redeemed.length > 0 ? (
        <div className="mt-2 rounded-lg border border-line bg-surface p-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-caption font-semibold text-muted">
            <Ticket size={12} /> Banked rate-limit resets
          </div>
          <ul className="space-y-1 text-caption">
            {available.map((c) => {
              const expiry = expiryLabel(c.expiresAt, now);
              return (
                <li
                  key={c.id}
                  className="flex items-baseline justify-between gap-3"
                >
                  <span className="text-fg">{c.title ?? "Full reset"}</span>
                  <span
                    className={EXPIRY_TONE[expiry.level]}
                    title={c.expiresAt ?? undefined}
                  >
                    {expiry.text}
                  </span>
                </li>
              );
            })}
            {redeemed.map((c) => (
              <li
                key={c.id}
                className="flex items-baseline justify-between gap-3 text-faint"
              >
                <span>{c.title ?? "Full reset"}</span>
                <span title={c.redeemedAt ?? undefined}>
                  {redeemedLabel(c.redeemedAt, now)}
                </span>
              </li>
            ))}
          </ul>

          {available.length > 0 ? (
            <>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={!canRedeem}
                  onClick={() => setConfirming(true)}
                  title="Redeem the soonest-expiring reset"
                  className="rounded-lg bg-accent px-3 py-1.5 text-caption font-medium text-accent-fg disabled:opacity-40"
                >
                  Redeem a reset
                </button>
                <span className="text-caption text-faint">
                  {applicable > 0
                    ? "Resets one currently-hit window. This is irreversible."
                    : "No limit is hit right now, so OpenAI may spend the reset for nothing. You will be asked to confirm."}
                </span>
              </div>
              <div className="mt-1.5 text-caption text-faint">
                An unspent reset is redeemed automatically{" "}
                {OPENAI_RESET_AUTO_REDEEM_LEAD_MS / 3_600_000}h before it
                expires rather than lost.
              </div>
            </>
          ) : null}
          {done ? (
            <div className="mt-2 text-caption text-accent">{done}</div>
          ) : null}
          {error ? <ErrorNote message={error} className="mt-2" /> : null}
        </div>
      ) : resetCredits && (resetCredits.availableCount ?? 0) > 0 ? (
        <div className="mt-1 text-caption text-faint">
          {resetCredits.availableCount} rate-limit reset{" "}
          {resetCredits.availableCount === 1 ? "credit" : "credits"} available.
        </div>
      ) : null}

      {confirming && target ? (
        <RedeemResetDialog
          credit={target}
          applicable={applicable > 0}
          now={now}
          busy={busy}
          error={error}
          onConfirm={() => void redeem()}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </div>
  );
}

/** Irreversible-action confirm dialog for redeeming one banked reset credit. */
function RedeemResetDialog({
  credit,
  applicable,
  now,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  credit: OpenAiResetCredit;
  /** Whether OpenAI currently reports a window this reset would clear. */
  applicable: boolean;
  now: number;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const expiry = expiryLabel(credit.expiresAt, now);
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-line bg-panel p-4 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-2 flex items-start justify-between gap-2">
          <p className="text-body font-semibold text-fg">
            Redeem a rate-limit reset?
          </p>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg p-1 text-muted hover:bg-raised hover:text-fg disabled:opacity-40"
          >
            <X size={14} />
          </button>
        </div>
        <div className="flex gap-2 rounded-lg border border-danger/30 bg-danger/5 p-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" />
          <p className="text-caption text-muted">
            This immediately spends{" "}
            <span className="text-fg">one banked reset</span> to clear a
            currently-hit limit window. It is{" "}
            <span className="font-semibold text-fg">irreversible</span> —
            exactly like the button in the ChatGPT app. There is no undo.
          </p>
        </div>
        {!applicable ? (
          <div className="mt-2 flex gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
            <p className="text-caption text-muted">
              OpenAI reports{" "}
              <span className="font-semibold text-fg">
                no limit is hit right now
              </span>
              , so this reset may be spent without clearing anything. Redeem
              anyway only if you would rather use it than let it expire.
            </p>
          </div>
        ) : null}
        <div className="mt-3 rounded-lg border border-line bg-surface px-3 py-2 text-caption">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-muted">Credit</span>
            <span className="text-fg">{credit.title ?? "Full reset"}</span>
          </div>
          <div className="mt-0.5 flex items-baseline justify-between gap-3">
            <span className="text-muted">Expires</span>
            <span
              className={
                expiry.level === "ok" ? "text-fg" : EXPIRY_TONE[expiry.level]
              }
              title={credit.expiresAt ?? undefined}
            >
              {expiry.text}
            </span>
          </div>
        </div>
        {error ? <ErrorNote message={error} className="mt-2" /> : null}
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-lg border border-line px-3 py-1.5 text-caption text-muted hover:bg-raised hover:text-fg disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={onConfirm}
            className="flex items-center gap-1.5 rounded-lg bg-danger px-3 py-1.5 text-caption font-medium text-white disabled:opacity-40"
          >
            {busy ? <Spinner size="sm" /> : null}{" "}
            {applicable ? "Redeem now" : "Redeem anyway"}
          </button>
        </div>
      </div>
    </div>
  );
}
