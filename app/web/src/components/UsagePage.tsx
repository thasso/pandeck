import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Gauge, RefreshCw, Ticket } from "lucide-react";
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
import { IconButton } from "./common/IconButton.tsx";
import { Alert } from "./ui/alert.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.tsx";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from "./ui/item.tsx";
import { Progress } from "./ui/progress.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";
import { ProviderIcon } from "./common/ProviderIcon.tsx";
import {
  EmptyBox,
  ErrorNote,
  RefreshIndicator,
  Skeleton,
} from "./common/load.tsx";
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
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      <PageHeader
        back={back}
        icon={<Gauge size={16} />}
        iconTone="accent"
        title="Usage"
        subtitle="Provider account limits"
        actions={
          <IconButton
            busy={refreshing}
            label="Refresh usage"
            // The accounts themselves are not refetched here: a new list
            // identity restarts every account's cached load, which would race
            // the live one this button exists to run. Retrying the LIST is the
            // error note's job.
            onClick={() => {
              void claude.loadAll({ refresh: true });
              void openai.loadAll({ refresh: true });
            }}
          >
            <RefreshCw />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-8">
          <section className="flex flex-col gap-3">
            <div>
              <h2 className="text-lg font-semibold text-foreground">
                At a glance
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
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
                <Skeleton className="h-30" />
                <Skeleton className="h-30" />
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
  const providerName = profile.provider === "claude" ? "Claude" : "OpenAI";
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <ProviderIcon
            provider={profile.provider}
            title={providerName}
            size={15}
            className="shrink-0 text-primary"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-foreground">
              {profile.name}
            </div>
            <div className="text-sm text-muted-foreground">{providerName}</div>
          </div>
        </div>
        {/* R2: the meters below stay up while the account refetches. */}
        {snapshot && state && isPending(state) ? (
          <RefreshIndicator label={`Refreshing ${profile.name} usage`} />
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5">
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
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : null}
        {unavailable ? (
          <p className="text-sm text-muted-foreground">{unavailable}</p>
        ) : null}
        {snapshot && rows.length === 0 && !unavailable ? (
          <p className="text-sm text-muted-foreground">
            No subscription windows reported.
          </p>
        ) : null}
      </CardContent>
    </Card>
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
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-muted-foreground">{label}</span>
        <Badge
          variant={pct === null ? "outline" : usageBadgeVariant(clamped)}
          className="tabular-nums"
        >
          {pct === null ? "—" : `${Math.round(pct)}%`}
        </Badge>
      </div>
      <Progress aria-label={label} value={clamped} className="mt-1 w-full" />
      <div className="mt-0.5 text-right text-xs text-muted-foreground">
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
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-card text-primary">
          <ProviderIcon provider={provider} size={15} />
        </span>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
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
    <section className="flex flex-col gap-3 border-t border-border pt-4 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground">
            {profile.name}
          </div>
          {subtitle ? (
            <div className="text-sm text-muted-foreground">{subtitle}</div>
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
          <Skeleton className="h-38" />
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
function usageBadgeVariant(pct: number): "destructive" | "warning" | "success" {
  const level = usageLevel(pct);
  return level === "critical"
    ? "destructive"
    : level === "warn"
      ? "warning"
      : "success";
}

const severityVariant = (severity: string | null) =>
  severity === "critical"
    ? "destructive"
    : severity === "warning"
      ? "warning"
      : "outline";

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
        <span className="text-sm text-foreground">{title}</span>
        <Badge
          variant={pct === null ? "outline" : usageBadgeVariant(clamped)}
          className="tabular-nums"
        >
          {pct === null ? "—" : `${Math.round(pct)}% used`}
        </Badge>
      </div>
      <Progress aria-label={title} value={clamped} className="mt-1 w-full" />
      <div className="mt-1 flex items-baseline justify-between gap-3 text-sm text-muted-foreground">
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
      <Card>
        <CardHeader>
          <CardTitle>Plan limits used</CardTitle>
          <p className="text-sm text-muted-foreground">
            Percent consumed — 100% means the cap is reached
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3.5">
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
        </CardContent>
      </Card>

      {snapshot.extraUsage?.enabled ? (
        <ExtraUsageCard extraUsage={snapshot.extraUsage} />
      ) : null}

      {snapshot.limits.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>All reported limits</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Kind</TableHead>
                  <TableHead className="text-right">Used</TableHead>
                  <TableHead>Resets</TableHead>
                  <TableHead>Scope</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshot.limits.map((limit, index) => (
                  <TableRow key={`${limit.kind}-${index}`}>
                    <TableCell>{limit.kind}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      <Badge variant={severityVariant(limit.severity)}>
                        {limit.percent === null
                          ? "—"
                          : `${Math.round(limit.percent)}%`}
                      </Badge>
                    </TableCell>
                    <TableCell>{resetCountdown(limit.resetsAt, now)}</TableCell>
                    <TableCell>
                      {limit.scope?.modelDisplayName ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {snapshot.behaviors ? (
        <BehaviorsSection behaviors={snapshot.behaviors} />
      ) : null}

      <div className="text-sm text-muted-foreground">
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
    <Card>
      <CardTitle>Extra usage credits (this month)</CardTitle>
      <div className="text-lg font-semibold tabular-nums text-foreground">
        {used === null || limit === null ? "—" : `${used} / ${limit}`}
      </div>
      {extraUsage.utilizationPct !== null ? (
        <Badge variant={over ? "destructive" : "outline"}>
          {Math.round(extraUsage.utilizationPct)}% used
          {over ? " · spend cap reached" : ""}
        </Badge>
      ) : null}
    </Card>
  );
}

function BehaviorsSection({
  behaviors,
}: {
  behaviors: NonNullable<ClaudeUsageSnapshot["behaviors"]>;
}) {
  return (
    <Card>
      <CardTitle>Local activity (approximate, this machine only)</CardTitle>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <BehaviorWindow label="Last 24 hours" window={behaviors.day} />
        <BehaviorWindow label="Last 7 days" window={behaviors.week} />
      </div>
    </Card>
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
      <div className="text-sm font-medium text-muted-foreground">{label}</div>
      <div className="text-sm text-foreground">
        {window.requestCount.toLocaleString()} requests ·{" "}
        {window.sessionCount.toLocaleString()} sessions
      </div>
      {window.topContributors.length > 0 ? (
        <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
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
      <Card>
        <CardHeader>
          <CardTitle>Plan limits used</CardTitle>
          <p className="text-sm text-muted-foreground">
            Percent consumed — 100% means the cap is reached
          </p>
        </CardHeader>
        <CardContent>
          {snapshot.windows.length > 0 ? (
            <div className="flex flex-col gap-3.5">
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
            <div className="mt-2 text-sm text-muted-foreground">
              No active rate-limit windows reported right now.
            </div>
          )}
        </CardContent>
      </Card>

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

      <div className="text-sm text-muted-foreground">
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
    <Card>
      <CardTitle>
        Spend limit
        {spend.source ? ` · ${spend.source.replace(/_/g, " ")}` : ""}
      </CardTitle>
      <div className="text-lg font-semibold tabular-nums text-foreground">
        {fmt(spend.used)} / {fmt(spend.limit)}
      </div>
      {spend.usedPercent !== null || over ? (
        <Badge variant={over ? "destructive" : "outline"}>
          {spend.usedPercent !== null
            ? `${Math.round(spend.usedPercent)}% used`
            : "Spend cap reached"}
          {over && spend.usedPercent !== null ? " · spend cap reached" : ""}
          {spend.resetsAt ? ` · ${resetCountdown(spend.resetsAt, now)}` : ""}
        </Badge>
      ) : null}
      <div className="mt-1 text-sm text-muted-foreground">
        Amounts as reported by OpenAI (currency not specified; typically USD).
      </div>
    </Card>
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

const expiryBadgeVariant = (level: ResetCreditExpiryLevel) =>
  level === "soon"
    ? "warning"
    : level === "imminent" || level === "pending"
      ? "destructive"
      : level === "ok"
        ? "success"
        : "outline";

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
    <Card>
      <CardHeader className="flex flex-row items-baseline justify-between gap-3">
        <CardTitle>Credits</CardTitle>
        {resetCredits && (resetCredits.availableCount ?? 0) > 0 ? (
          <div className="text-sm text-muted-foreground">
            {resetCredits.availableCount} reset
            {resetCredits.availableCount === 1 ? "" : "s"} banked
            {applicable > 0 ? ` · ${applicable} usable now` : ""}
          </div>
        ) : null}
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2">
          <Badge
            variant={
              credits.overageLimitReached
                ? "warning"
                : credits.hasCredits || credits.unlimited
                  ? "success"
                  : "outline"
            }
          >
            {status}
          </Badge>
          {credits.balance !== null ? (
            <span className="text-sm text-muted-foreground">
              Balance {credits.balance.toLocaleString()}
            </span>
          ) : null}
        </div>

        {available.length + redeemed.length > 0 ? (
          <div className="mt-2">
            <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
              <Ticket aria-hidden="true" /> Banked rate-limit resets
            </div>
            <ItemGroup>
              {available.map((credit) => {
                const expiry = expiryLabel(credit.expiresAt, now);
                return (
                  <Item key={credit.id} variant="outline" size="sm">
                    <ItemContent>
                      <ItemTitle>
                        <span className="truncate">
                          {credit.title ?? "Full reset"}
                        </span>
                      </ItemTitle>
                    </ItemContent>
                    <ItemActions>
                      <Badge
                        variant={expiryBadgeVariant(expiry.level)}
                        title={credit.expiresAt ?? undefined}
                      >
                        {expiry.text}
                      </Badge>
                    </ItemActions>
                  </Item>
                );
              })}
              {redeemed.map((credit) => (
                <Item key={credit.id} variant="outline" size="sm">
                  <ItemContent>
                    <ItemTitle>
                      <span className="truncate">
                        {credit.title ?? "Full reset"}
                      </span>
                    </ItemTitle>
                  </ItemContent>
                  <ItemActions>
                    <Badge
                      variant="outline"
                      title={credit.redeemedAt ?? undefined}
                    >
                      {redeemedLabel(credit.redeemedAt, now)}
                    </Badge>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>

            {available.length > 0 ? (
              <>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    disabled={!canRedeem}
                    onClick={() => setConfirming(true)}
                    title="Redeem the soonest-expiring reset"
                  >
                    Redeem a reset
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    {applicable > 0
                      ? "Resets one currently-hit window. This is irreversible."
                      : "No limit is hit right now, so OpenAI may spend the reset for nothing. You will be asked to confirm."}
                  </span>
                </div>
                <div className="mt-1.5 text-sm text-muted-foreground">
                  An unspent reset is redeemed automatically{" "}
                  {OPENAI_RESET_AUTO_REDEEM_LEAD_MS / 3_600_000}h before it
                  expires rather than lost.
                </div>
              </>
            ) : null}
            {done ? (
              <Alert variant="success" role="status" className="mt-2">
                {done}
              </Alert>
            ) : null}
            {error ? <ErrorNote message={error} className="mt-2" /> : null}
          </div>
        ) : resetCredits && (resetCredits.availableCount ?? 0) > 0 ? (
          <div className="mt-1 text-sm text-muted-foreground">
            {resetCredits.availableCount} rate-limit reset{" "}
            {resetCredits.availableCount === 1 ? "credit" : "credits"}{" "}
            available.
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
      </CardContent>
    </Card>
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
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-md" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Redeem a rate-limit reset?</DialogTitle>
          <DialogDescription>
            This immediately spends one banked reset to clear a currently-hit
            limit window. It is irreversible. There is no undo.
          </DialogDescription>
        </DialogHeader>
        {!applicable ? (
          <Alert variant="warning" role="note" className="mt-2">
            OpenAI reports no limit is hit right now, so this reset may be spent
            without clearing anything. Redeem anyway only if you would rather
            use it than let it expire.
          </Alert>
        ) : null}
        <ItemGroup className="mt-2">
          <Item variant="outline" size="sm">
            <ItemContent>
              <ItemTitle>Credit</ItemTitle>
            </ItemContent>
            <ItemActions>
              <span className="truncate">{credit.title ?? "Full reset"}</span>
            </ItemActions>
          </Item>
          <Item variant="outline" size="sm">
            <ItemContent>
              <ItemTitle>Expires</ItemTitle>
            </ItemContent>
            <ItemActions>
              <Badge
                variant={expiryBadgeVariant(expiry.level)}
                title={credit.expiresAt ?? undefined}
              >
                {expiry.text}
              </Badge>
            </ItemActions>
          </Item>
        </ItemGroup>
        {error ? <ErrorNote message={error} className="mt-2" /> : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" busy={busy} onClick={onConfirm}>
            {applicable ? "Redeem now" : "Redeem anyway"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
