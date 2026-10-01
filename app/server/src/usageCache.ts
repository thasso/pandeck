/**
 * Server-owned cache of provider subscription-usage snapshots (`docs/usage.md`).
 *
 * It lives here and not in the browser because the credentials do: both
 * fetchers already run against files under `DATA_DIR`, the Claude fetch spawns
 * a CLI subprocess and so must be single-flighted GLOBALLY, and several tabs
 * plus the Usage page share one snapshot. Reads are always served from memory
 * and revalidated in the background — a fetch never blocks a render.
 *
 * Best-effort persistence to `DATA_DIR/cache/usage/<profileId>.json` (tmp+rename,
 * tolerant of corrupt files, mirroring `jiraFieldCache.ts`) so a restart does
 * not blank every card. Nothing here is fetched while no client is connected:
 * a finished turn only marks the account dirty, and the next page open pays for
 * the refresh. The one headless reader is the OpenAI reset-credit auto-redeem
 * sweep (`openaiResetAutoRedeem.ts`), which decides for itself, and only for
 * the sub-second OpenAI GET, when a fetch is worth it.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  CredentialProfileProvider,
  CredentialProfileSummary,
  ServerMessage,
} from "@assistant/shared";
import type {
  ClaudeUsageSnapshot,
  OpenAiUsageSnapshot,
  UsageIndicator,
  UsageIndicatorWindow,
} from "@assistant/shared/usage";
import { USAGE_HARD_INVALID_MS } from "@assistant/shared/usage";
import { DATA_DIR } from "./config.ts";
import {
  listCredentialProfiles,
  subscribeCredentialProfileDeleted,
} from "./credentialProfiles.ts";
import { fetchClaudeSdkUsage } from "./claudeSdk/usageQuery.ts";
import { fetchOpenAiUsageForProfile } from "./piSdk/openaiUsageQuery.ts";
import { errorText } from "./errors.ts";

const CACHE_DIR = join(DATA_DIR, "cache", "usage");
const CACHE_FILE_VERSION = 1;

export type UsageSnapshot = ClaudeUsageSnapshot | OpenAiUsageSnapshot;

/**
 * Per-provider refresh policy. The two differ because the fetches differ: the
 * OpenAI call is one sub-second HTTPS GET, the Claude one spawns a CLI
 * subprocess that can take seconds and can hang to its timeout when the account
 * is logged out.
 */
interface UsagePolicy {
  /** Serve without revalidating below this age. */
  freshMs: number;
  /** Never fetch the same account more often than this (force excepted). */
  minIntervalMs: number;
  /** Beyond this age a read no longer serves the cache, it fetches. */
  hardInvalidMs: number;
  fetchTimeoutMs: number;
  /** Concurrent fetches allowed across ALL accounts of this provider. */
  concurrency: number;
}

/**
 * The fetch half of the policy; the DISPLAY half (stale/hard-invalid ages) is
 * shared with the client in `@assistant/shared/usage`, because the browser
 * derives those from `fetchedAt` itself.
 */
const USAGE_POLICY: Record<CredentialProfileProvider, UsagePolicy> = {
  claude: {
    freshMs: 5 * 60_000,
    minIntervalMs: 60_000,
    hardInvalidMs: USAGE_HARD_INVALID_MS.claude,
    fetchTimeoutMs: 20_000,
    concurrency: 1,
  },
  "openai-codex": {
    freshMs: 2 * 60_000,
    minIntervalMs: 20_000,
    hardInvalidMs: USAGE_HARD_INVALID_MS["openai-codex"],
    fetchTimeoutMs: 10_000,
    concurrency: 2,
  },
};

/** Failure backoff, indexed by consecutive-failure count and then capped. */
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];

/** Debounce between a finished run and its refresh, so a burst costs one fetch. */
export const TURN_END_DEBOUNCE_MS = 30_000;

/** One pending turn-end refresh per account at a time. */
const dirtyTimers = new Map<string, ReturnType<typeof setTimeout>>();

interface CacheEntry {
  profileId: string;
  provider: CredentialProfileProvider;
  snapshot: UsageSnapshot | null;
  /** Epoch ms of `snapshot`, or 0 when nothing has ever been fetched. */
  fetchedAt: number;
  /** Consecutive failures, driving the backoff. Reset by any success. */
  failures: number;
  /** Epoch ms before which no non-forced fetch may start. */
  nextAttemptAt: number;
  /** Last failure text, kept for the HTTP routes; never broadcast to cards. */
  lastError: string | null;
  /** A turn finished on this account, so the next client-driven refresh must run. */
  dirty: boolean;
  inFlight: Promise<UsageSnapshot> | null;
}

interface PersistedEntry {
  version: number;
  profileId: string;
  provider: CredentialProfileProvider;
  fetchedAt: number;
  snapshot: UsageSnapshot;
}

/** Injectable so tests never spawn a subprocess or touch the network. */
export interface UsageCacheDeps {
  fetchClaude: (
    profileId: string,
    timeoutMs: number,
  ) => Promise<ClaudeUsageSnapshot>;
  fetchOpenAi: (profileId: string) => Promise<OpenAiUsageSnapshot>;
  listProfiles: () => CredentialProfileSummary[];
  now: () => number;
}

const realDeps: UsageCacheDeps = {
  fetchClaude: (profileId, timeoutMs) =>
    fetchClaudeSdkUsage(timeoutMs, profileId),
  fetchOpenAi: (profileId) => fetchOpenAiUsageForProfile(profileId),
  listProfiles: () => listCredentialProfiles(),
  now: () => Date.now(),
};

let deps: UsageCacheDeps = realDeps;

/**
 * How the cache reaches browsers, and whether any is even attached. The
 * presence check is what keeps this from ever doing headless work.
 */
export interface UsageBroadcaster {
  broadcast: (message: ServerMessage) => void;
  hasClients: () => boolean;
}

let broadcaster: UsageBroadcaster | undefined;

export function setUsageBroadcaster(next: UsageBroadcaster): void {
  broadcaster = next;
}

const entries = new Map<string, CacheEntry>();
const loadedFromDisk = new Set<string>();

/** Bounded concurrency per provider; the Claude gate is a global queue of one. */
class FetchGate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    // A loop, not an `if`: a caller arriving between a release and the woken
    // waiter's resume would otherwise slip past the limit, and this gate is
    // what guarantees "at most one Claude subprocess globally".
    while (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

const gates: Record<CredentialProfileProvider, FetchGate> = {
  claude: new FetchGate(USAGE_POLICY.claude.concurrency),
  "openai-codex": new FetchGate(USAGE_POLICY["openai-codex"].concurrency),
};

/**
 * Cache file for an account, or null for an id that could escape the directory.
 * Registry ids are already constrained to this alphabet; the guard keeps a
 * caller-supplied id from ever reaching the filesystem.
 */
function cachePath(profileId: string): string | null {
  return /^[A-Za-z0-9_-]+$/.test(profileId)
    ? join(CACHE_DIR, `${profileId}.json`)
    : null;
}

function readPersisted(profileId: string): PersistedEntry | null {
  const path = cachePath(profileId);
  if (!path || !existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PersistedEntry;
    if (parsed?.version !== CACHE_FILE_VERSION || !parsed.snapshot) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writePersisted(entry: CacheEntry): void {
  const path = entry.snapshot ? cachePath(entry.profileId) : null;
  if (!path || !entry.snapshot) return;
  const payload: PersistedEntry = {
    version: CACHE_FILE_VERSION,
    profileId: entry.profileId,
    provider: entry.provider,
    fetchedAt: entry.fetchedAt,
    snapshot: entry.snapshot,
  };
  try {
    // The files hold raw provider snapshots (an OpenAI one names the account),
    // so the directory is private too, not just the files.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmp, path);
  } catch (err) {
    console.warn("[usage-cache] failed to persist snapshot:", errorText(err));
  }
}

function entryFor(
  profileId: string,
  provider: CredentialProfileProvider,
): CacheEntry {
  const existing = entries.get(profileId);
  if (existing) return existing;
  const entry: CacheEntry = {
    profileId,
    provider,
    snapshot: null,
    fetchedAt: 0,
    failures: 0,
    nextAttemptAt: 0,
    lastError: null,
    dirty: false,
    inFlight: null,
  };
  if (!loadedFromDisk.has(profileId)) {
    loadedFromDisk.add(profileId);
    const persisted = readPersisted(profileId);
    // A profile whose provider changed identity would make the stored snapshot
    // meaningless; ignore rather than mis-project it.
    if (persisted && persisted.provider === provider) {
      entry.snapshot = persisted.snapshot;
      entry.fetchedAt = persisted.fetchedAt;
    }
  }
  entries.set(profileId, entry);
  return entry;
}

function enabledProfiles(): CredentialProfileSummary[] {
  return deps.listProfiles().filter((profile) => profile.enabled);
}

function ageOf(entry: CacheEntry, now: number): number {
  return entry.fetchedAt > 0 ? now - entry.fetchedAt : Number.POSITIVE_INFINITY;
}

/** Whether a non-forced fetch may start right now (freshness, min interval, backoff). */
function shouldRevalidate(entry: CacheEntry, now: number): boolean {
  if (entry.inFlight) return false;
  if (now < entry.nextAttemptAt) return false;
  const policy = USAGE_POLICY[entry.provider];
  const age = ageOf(entry, now);
  if (age < policy.minIntervalMs) return false;
  if (entry.dirty) return true;
  return age >= policy.freshMs;
}

async function runFetch(entry: CacheEntry): Promise<UsageSnapshot> {
  const policy = USAGE_POLICY[entry.provider];
  const started = deps.now();
  entry.nextAttemptAt = Math.max(
    entry.nextAttemptAt,
    started + policy.minIntervalMs,
  );
  const task = async (): Promise<UsageSnapshot> =>
    entry.provider === "claude"
      ? await deps.fetchClaude(entry.profileId, policy.fetchTimeoutMs)
      : await deps.fetchOpenAi(entry.profileId);
  const promise = gates[entry.provider]
    .run(task)
    .then((snapshot) => {
      entry.snapshot = snapshot;
      entry.fetchedAt = deps.now();
      entry.failures = 0;
      entry.nextAttemptAt = entry.fetchedAt + policy.minIntervalMs;
      entry.lastError = null;
      entry.dirty = false;
      writePersisted(entry);
      return snapshot;
    })
    .catch((err: unknown) => {
      // Keep the last good snapshot and back off — a logged-out Claude account
      // hangs to its timeout, so timeouts must back off exactly like errors.
      // `dirty` deliberately SURVIVES: a failed attempt learned nothing, so the
      // turn that moved these numbers is still unaccounted for.
      entry.failures += 1;
      entry.lastError = errorText(err);
      entry.nextAttemptAt =
        deps.now() +
        (BACKOFF_MS[entry.failures - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!);
      throw err;
    })
    .finally(() => {
      entry.inFlight = null;
      broadcastIndicators();
    });
  entry.inFlight = promise;
  broadcastIndicators();
  return promise;
}

function broadcastIndicators(): void {
  if (!broadcaster) return;
  broadcaster.broadcast({
    type: "usageIndicators",
    indicators: usageIndicators(),
  });
}

/**
 * Kick a background revalidation of every enabled account that needs one, and
 * of nothing else. Fire-and-forget: failures live in the entry's backoff, and
 * the cards keep showing the last good numbers.
 */
export function revalidateUsage(
  options: { force?: boolean; profileIds?: string[] } = {},
): void {
  const now = deps.now();
  const wanted = options.profileIds ? new Set(options.profileIds) : null;
  for (const profile of enabledProfiles()) {
    if (wanted && !wanted.has(profile.id)) continue;
    const entry = entryFor(profile.id, profile.provider);
    if (options.force) {
      if (entry.inFlight) continue;
      void runFetch(entry).catch(() => {});
      continue;
    }
    if (shouldRevalidate(entry, now)) void runFetch(entry).catch(() => {});
  }
}

/**
 * A run finished on this account, so its numbers moved. Deliberately does NOT
 * fetch: with no client attached nothing is fetched for any provider, and the
 * next page open pays for the refresh. When a client IS attached the entry
 * refreshes after a debounce, still respecting the min interval and backoff.
 */
export function markUsageProfileDirty(profileId: string): void {
  const profile = enabledProfiles().find((item) => item.id === profileId);
  if (!profile) return;
  entryFor(profile.id, profile.provider).dirty = true;
  if (!broadcaster?.hasClients()) return;
  if (dirtyTimers.has(profileId)) return;
  const timer = setTimeout(() => {
    dirtyTimers.delete(profileId);
    if (!broadcaster?.hasClients()) return;
    revalidateUsage({ profileIds: [profileId] });
  }, TURN_END_DEBOUNCE_MS);
  timer.unref?.();
  dirtyTimers.set(profileId, timer);
}

/**
 * The read behind `GET /api/usage/*`: serve the cache when it holds anything
 * usable and revalidate behind the request, await a fetch only when there is
 * nothing to show (or the caller forced one). A forced read joins an in-flight
 * fetch rather than starting a second subprocess.
 */
export async function readUsageSnapshot(
  profileId: string,
  provider: CredentialProfileProvider,
  options: { force?: boolean } = {},
): Promise<UsageSnapshot> {
  const entry = entryFor(profileId, provider);
  const now = deps.now();
  const policy = USAGE_POLICY[provider];
  if (
    !options.force &&
    entry.snapshot &&
    ageOf(entry, now) < policy.hardInvalidMs
  ) {
    if (shouldRevalidate(entry, now)) void runFetch(entry).catch(() => {});
    return entry.snapshot;
  }
  if (entry.inFlight) return entry.inFlight;
  try {
    return await runFetch(entry);
  } catch (err) {
    // A FORCED read is a user pressing Refresh: answering 200 with the numbers
    // they already saw would make the button look like it did nothing. The
    // failure is theirs to see (the page keeps the old snapshot on error
    // anyway). An unforced read only fetched because it had nothing fresh, so
    // an older snapshot is still the better answer than an error.
    if (!options.force && entry.snapshot) return entry.snapshot;
    throw err;
  }
}

/**
 * What the cache holds for an account WITHOUT fetching: the snapshot and its
 * age, or null when nothing was ever cached. For a reader that decides on its
 * own whether a fetch is worth it (`openaiResetAutoRedeem.ts`).
 */
export function peekUsageSnapshot(
  profileId: string,
  provider: CredentialProfileProvider,
): { snapshot: UsageSnapshot; fetchedAt: number } | null {
  const entry = entryFor(profileId, provider);
  return entry.snapshot
    ? { snapshot: entry.snapshot, fetchedAt: entry.fetchedAt }
    : null;
}

/** Drop a deleted account's cached numbers (and its file) immediately. */
export function forgetUsageProfile(profileId: string): void {
  entries.delete(profileId);
  loadedFromDisk.delete(profileId);
  clearTimeout(dirtyTimers.get(profileId));
  dirtyTimers.delete(profileId);
  const path = cachePath(profileId);
  try {
    if (path) rmSync(path, { force: true });
  } catch {
    // Best-effort: a stale file is ignored on read anyway.
  }
  broadcastIndicators();
}

// A deleted account's numbers must not outlive it, on disk or in memory.
subscribeCredentialProfileDeleted((profileId) => forgetUsageProfile(profileId));

interface ProviderProjection {
  limitsAvailable: boolean;
  short: UsageIndicatorWindow | null;
  long: UsageIndicatorWindow | null;
}

function projectClaude(snapshot: ClaudeUsageSnapshot): ProviderProjection {
  if (!snapshot.rateLimitsAvailable)
    return { limitsAvailable: false, short: null, long: null };
  return {
    limitsAvailable: true,
    short: snapshot.fiveHour
      ? {
          usedPct: snapshot.fiveHour.utilizationPct,
          resetsAt: snapshot.fiveHour.resetsAt,
        }
      : null,
    long: snapshot.weekly
      ? {
          usedPct: snapshot.weekly.utilizationPct,
          resetsAt: snapshot.weekly.resetsAt,
        }
      : null,
  };
}

function projectOpenAi(snapshot: OpenAiUsageSnapshot): ProviderProjection {
  if (!snapshot.available)
    return { limitsAvailable: false, short: null, long: null };
  // The plain plan windows carry no label; named model caps (e.g. "Codex
  // Spark") belong to the Usage page's detail, not to a two-row card.
  const pick = (kind: "five_hour" | "weekly") => {
    const matches = snapshot.windows.filter((window) => window.kind === kind);
    const window = matches.find((item) => !item.label) ?? matches[0];
    return window
      ? { usedPct: window.usedPercent, resetsAt: window.resetsAt }
      : null;
  };
  return {
    limitsAvailable: true,
    short: pick("five_hour"),
    long: pick("weekly"),
  };
}

/**
 * The wire projection carries FACTS (when it was fetched, what the windows
 * said); how old is too old is derived by every reader from `fetchedAt` with
 * the shared thresholds, so a card degrades on its own clock even when nothing
 * pushes.
 */
function indicatorFor(profile: CredentialProfileSummary): UsageIndicator {
  const entry = entryFor(profile.id, profile.provider);
  const projection = entry.snapshot
    ? entry.provider === "claude"
      ? projectClaude(entry.snapshot as ClaudeUsageSnapshot)
      : projectOpenAi(entry.snapshot as OpenAiUsageSnapshot)
    : null;
  return {
    profileId: profile.id,
    provider: profile.provider,
    refreshing: entry.inFlight !== null,
    fetchedAt: entry.fetchedAt > 0 ? entry.fetchedAt : null,
    // Nothing cached yet is not a claim that the account has no limits.
    limitsAvailable: projection ? projection.limitsAvailable : true,
    short: projection?.short ?? null,
    long: projection?.long ?? null,
  };
}

/** The `usage` topic's whole snapshot: one indicator per ENABLED account. */
export function usageIndicators(): UsageIndicator[] {
  return enabledProfiles().map((profile) => indicatorFor(profile));
}

/** Test seam: swap the fetchers/clock/registry. */
export function setUsageCacheDepsForTests(next: Partial<UsageCacheDeps>): void {
  deps = { ...realDeps, ...next };
}

/** Test seam: forget every cached entry (and the broadcaster). */
export function resetUsageCacheForTests(): void {
  entries.clear();
  loadedFromDisk.clear();
  for (const timer of dirtyTimers.values()) clearTimeout(timer);
  dirtyTimers.clear();
  broadcaster = undefined;
  deps = realDeps;
}
