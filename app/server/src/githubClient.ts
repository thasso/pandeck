import {
  isFailedGitCheckStatus,
  isTerminalGitCheckStatus,
} from "./gitCheckStatus.ts";

/**
 * Minimal hand-rolled GitHub REST client (no Octokit), mirroring `jiraClient.ts`.
 * Authenticates with the user's classic PAT as a Bearer token and pins the REST
 * API version. Callers pass API-root-relative paths (e.g. `/notifications`) or
 * absolute `https://api.github.com/...` URLs.
 */
export interface GithubApiConfig {
  token: string;
  /** API root, e.g. https://api.github.com (fixed for github.com). */
  apiBaseUrl: string;
}

export const GITHUB_API_BASE = "https://api.github.com";
export const GITHUB_WEB_BASE = "https://github.com";
const GITHUB_API_VERSION = "2022-11-28";

export interface GithubResponse<T> {
  data: T;
  status: number;
  /** Parsed `Link` rel="next" URL when the response is paginated. */
  nextUrl: string | null;
  /** Requests remaining in the current rate-limit window, when reported. */
  rateRemaining: number | null;
  /** OAuth scopes reported for the token, when reported (classic PATs only). */
  scopes: string[] | null;
}

/**
 * ETag cache for GETs. GitHub does not charge a conditional request answered
 * `304 Not Modified` against the REST budget, so every poll that repeats an
 * unchanged read (check watches, background loops) is free after the first.
 * Keyed by token, Accept and full URL; bounded by entries and body size.
 */
const CONDITIONAL_CACHE_MAX_ENTRIES = 256;
const CONDITIONAL_CACHE_MAX_BODY_CHARS = 256 * 1024;
const conditionalCache = new Map<
  string,
  { etag: string; text: string; link: string | null; scopes: string | null }
>();

/**
 * The core REST budget per token, for callers that pace work. Only `core`
 * responses count: GraphQL and search draw from budgets of their own.
 */
const rateLimits = new Map<string, { remaining: number; resetAt: number }>();

/**
 * REST requests left for this token and when the window resets (epoch ms), as
 * of its most recent response; `null` before any response reported them.
 */
export function githubRateLimit(
  config: GithubApiConfig,
): { remaining: number; resetAt: number } | null {
  const entry = rateLimits.get(config.token);
  if (!entry) return null;
  // A window that has reset is a full budget again, not the stale remainder.
  return entry.resetAt <= Date.now() ? null : entry;
}

export async function githubRequest<T>(
  config: GithubApiConfig,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  options: {
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    accept?: string;
    signal?: AbortSignal;
  } = {},
): Promise<GithubResponse<T>> {
  if (!config.token) {
    throw new Error("Missing GitHub token. Configure it in Settings → GitHub.");
  }
  const base = config.apiBaseUrl.replace(/\/$/, "");
  const url = new URL(
    path.startsWith("http")
      ? path
      : `${base}${path.startsWith("/") ? "" : "/"}${path}`,
  );
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const accept = options.accept ?? "application/vnd.github+json";
  const cacheKey =
    method === "GET" ? `${config.token}\n${accept}\n${url.href}` : null;
  const cached = cacheKey ? conditionalCache.get(cacheKey) : undefined;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: accept,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "personal-assistant",
      ...(cached ? { "If-None-Match": cached.etag } : {}),
      ...(options.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
    },
    ...(!(options.body === undefined)
      ? { body: JSON.stringify(options.body) }
      : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  const rateRemaining = numberOrNull(res.headers.get("x-ratelimit-remaining"));
  const rateReset = numberOrNull(res.headers.get("x-ratelimit-reset"));
  if (rateRemaining !== null && rateReset !== null)
    recordCoreRateLimit(
      config.token,
      res.headers.get("x-ratelimit-resource") ??
        (/^(\/api(\/v3)?)?\/(graphql|search)(\/|$)/.test(url.pathname)
          ? "other"
          : "core"),
      rateRemaining,
      rateReset * 1_000,
    );
  let text = await res.text();
  let link = res.headers.get("link");
  let scopes = res.headers.get("x-oauth-scopes");
  if (res.status === 304 && cached && cacheKey) {
    // Refresh recency so a hot poll is the last entry evicted.
    conditionalCache.delete(cacheKey);
    conditionalCache.set(cacheKey, cached);
    ({ text, link } = cached);
    scopes ??= cached.scopes;
  } else if (!res.ok) {
    throw new Error(
      `GitHub API returned HTTP ${res.status} for ${method} ${url.pathname}: ${text.slice(0, 400)}`,
    );
  } else if (cacheKey) {
    const etag = res.headers.get("etag");
    conditionalCache.delete(cacheKey);
    if (etag && text.length <= CONDITIONAL_CACHE_MAX_BODY_CHARS) {
      conditionalCache.set(cacheKey, { etag, text, link, scopes });
      if (conditionalCache.size > CONDITIONAL_CACHE_MAX_ENTRIES) {
        const oldest = conditionalCache.keys().next().value;
        if (oldest !== undefined) conditionalCache.delete(oldest);
      }
    }
  }
  const isRaw = accept.includes("raw") || accept.includes("diff");
  const data = (isRaw ? text : text ? JSON.parse(text) : {}) as T;
  return {
    data,
    status: res.status === 304 ? 200 : res.status,
    nextUrl: parseNextLink(link),
    rateRemaining,
    scopes: parseScopes(scopes),
  };
}

/**
 * Responses to parallel requests land in completion order, not budget order,
 * so within one window the LOWEST remainder wins; a later window replaces it
 * and a late answer from an earlier one is ignored.
 */
function recordCoreRateLimit(
  token: string,
  resource: string,
  remaining: number,
  resetAt: number,
): void {
  if (resource !== "core") return;
  const entry = rateLimits.get(token);
  if (!entry || resetAt > entry.resetAt)
    rateLimits.set(token, { remaining, resetAt });
  else if (resetAt === entry.resetAt && remaining < entry.remaining)
    entry.remaining = remaining;
}

let cachedLogin: { token: string; login: string } | null = null;

/** Resolve (and cache per token) the authenticated user's login via `/user`. */
export async function resolveAuthenticatedLogin(
  config: GithubApiConfig,
  signal?: AbortSignal,
): Promise<string | null> {
  if (cachedLogin && cachedLogin.token === config.token)
    return cachedLogin.login;
  try {
    const res = await githubRequest<{ login?: string }>(
      config,
      "GET",
      "/user",
      { ...(signal !== undefined ? { signal } : {}) },
    );
    const login = typeof res.data?.login === "string" ? res.data.login : null;
    if (login) cachedLogin = { token: config.token, login };
    return login;
  } catch {
    return null;
  }
}

/**
 * One GraphQL query. Its cost is drawn from the SEPARATE GraphQL budget (points,
 * usually 1 per query) rather than the REST one, which is why the background
 * polling paths batch many per-row REST reads into one of these.
 *
 * A response carrying `errors` THROWS even when it also carries partial data:
 * the batched callers answer many rows at once, and a row assembled from a
 * half-answered query would read as a clean one.
 */
export async function githubGraphql<T>(
  config: GithubApiConfig,
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const res = await githubRequest<{
    data?: T;
    errors?: Array<{ message?: string }>;
  }>(config, "POST", "/graphql", {
    body: { query, variables },
    ...(signal !== undefined ? { signal } : {}),
  });
  if (Array.isArray(res.data.errors) && res.data.errors.length > 0)
    throw new Error(
      `GitHub GraphQL query failed: ${
        res.data.errors
          .map((item) => item?.message)
          .filter(Boolean)
          .join("; ") || "unspecified error"
      }`,
    );
  if (!res.data.data) throw new Error("GitHub GraphQL query returned no data.");
  return res.data.data;
}

/** Follow `Link` rel="next" pagination up to `maxItems` total items. */
export async function githubPaginate<T>(
  config: GithubApiConfig,
  path: string,
  options: {
    query?: Record<string, string | number | boolean | undefined>;
    maxItems: number;
    signal?: AbortSignal;
  } = { maxItems: 100 },
): Promise<{ items: T[]; pagesFetched: number; exhausted: boolean }> {
  const items: T[] = [];
  let nextUrl: string | null = path;
  let query: Record<string, string | number | boolean | undefined> | undefined =
    { per_page: Math.min(100, options.maxItems), ...options.query };
  let pagesFetched = 0;
  while (nextUrl && items.length < options.maxItems) {
    const res: GithubResponse<T[]> = await githubRequest<T[]>(
      config,
      "GET",
      nextUrl,
      {
        ...(query !== undefined ? { query } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
    );
    query = undefined; // subsequent pages carry their params in the Link URL
    pagesFetched += 1;
    const batch = Array.isArray(res.data) ? res.data : [];
    items.push(...batch);
    nextUrl = res.nextUrl;
    if (batch.length === 0) break;
  }
  return {
    items: items.slice(0, options.maxItems),
    pagesFetched,
    exhausted: !nextUrl,
  };
}

/** Aggregate CI state for a ref, shared by the `github_get_ref_checks` tool and the git-hosting provider. */
export interface GithubRefChecksSummary {
  state: "success" | "failure" | "pending" | "neutral";
  /** True total check-runs + legacy commit statuses reported by GitHub. */
  total: number;
  /** More checks/statuses exist than the bounded first pages contain. */
  truncated: boolean;
  /** A representative web URL (first failing item, else first item). */
  url: string | null;
  checkRuns: Array<{
    id: number | null;
    name: string | null;
    status: string | null;
    conclusion: string | null;
    url: string | null;
    app: string | null;
    appSlug: string | null;
    /** Bounded by the caller before it crosses a workflow payload boundary. */
    output: string | null;
  }>;
  statuses: Array<{
    context: string | null;
    state: string | null;
    url: string | null;
    description: string | null;
  }>;
}

/**
 * Aggregate the Checks API check-runs plus the legacy combined commit status for
 * `ref` (a branch, tag, or SHA) into one CI summary. One page each (per_page=100)
 * keeps it bounded; that covers the overwhelming majority of refs.
 */
/**
 * Combined CI for a ref, from BOTH the check-runs API and the legacy commit
 * statuses. Either endpoint failing throws: the two are halves of one answer,
 * and reporting the half that succeeded is how a provider outage came to look
 * like a green build.
 */
export async function githubRefChecks(
  config: GithubApiConfig,
  owner: string,
  repo: string,
  ref: string,
  signal?: AbortSignal,
): Promise<GithubRefChecksSummary> {
  const repoBase = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`;
  const [checkRes, statusRes] = await Promise.all([
    githubRequest<{
      total_count?: number;
      check_runs?: Record<string, any>[];
    }>(config, "GET", `${repoBase}/check-runs`, {
      query: { per_page: 100 },
      ...(signal !== undefined ? { signal } : {}),
    }),
    // NOT caught. Substituting an empty status set here let check-runs report
    // `success` while the legacy commit statuses were simply unknown — a clean
    // answer assembled from half the evidence. Both endpoints must answer, or
    // the caller is told nothing and can omit the row.
    githubRequest<{
      total_count?: number;
      statuses?: Record<string, any>[];
    }>(config, "GET", `${repoBase}/status`, {
      query: { per_page: 100 },
      ...(signal !== undefined ? { signal } : {}),
    }),
  ]);

  const checkRuns = (checkRes.data.check_runs ?? []).map((run) => ({
    id: typeof run.id === "number" ? run.id : null,
    name: run.name ?? null,
    status: run.status ?? null,
    conclusion: run.conclusion ?? null,
    url: run.html_url ?? run.details_url ?? null,
    app: run.app?.name ?? null,
    appSlug: run.app?.slug ?? null,
    output:
      [run.output?.title, run.output?.summary, run.output?.text]
        .filter(
          (value): value is string =>
            typeof value === "string" && Boolean(value.trim()),
        )
        .join("\n") || null,
  }));
  const statuses = (statusRes.data.statuses ?? []).map((s) => ({
    context: s.context ?? null,
    state: s.state ?? null,
    url: s.target_url ?? null,
    description: s.description ?? null,
  }));

  const failing =
    checkRuns.some((run) => isFailedGitCheckStatus(run.conclusion)) ||
    statuses.some((status) => isFailedGitCheckStatus(status.state));
  const pending =
    checkRuns.some((run) => !isTerminalGitCheckStatus(run.status)) ||
    statuses.some((status) => !isTerminalGitCheckStatus(status.state));
  const total =
    (checkRes.data.total_count ?? checkRuns.length) +
    (statusRes.data.total_count ?? statuses.length);
  const truncated = total > checkRuns.length + statuses.length;
  const state: GithubRefChecksSummary["state"] =
    total === 0
      ? "neutral"
      : failing
        ? "failure"
        : pending
          ? "pending"
          : "success";
  const firstFailUrl =
    checkRuns.find((run) => isFailedGitCheckStatus(run.conclusion))?.url ||
    statuses.find((status) => isFailedGitCheckStatus(status.state))?.url;
  const url = firstFailUrl || checkRuns[0]?.url || statuses[0]?.url || null;

  return { state, total, truncated, url, checkRuns, statuses };
}

function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1] ?? null;
  }
  return null;
}

function parseScopes(header: string | null): string[] | null {
  if (header === null) return null;
  return header
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function numberOrNull(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
