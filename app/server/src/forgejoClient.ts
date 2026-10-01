import { isFailedGitCheckStatus } from "./gitCheckStatus.ts";

/**
 * Minimal hand-rolled Forgejo (Gitea-compatible API v1) client, mirroring
 * `githubClient.ts`. Forgejo is self-hosted, so the API root is derived from the
 * user-configured instance base URL (`<baseUrl>/api/v1`) rather than a fixed
 * host. Authenticates with a Forgejo access token via the Gitea `Authorization:
 * token …` header; without a token, public read endpoints may still work but
 * write endpoints (PR creation) fail with a clear message.
 *
 * Callers pass API-root-relative paths (e.g. `/user`, `/repos/{owner}/{repo}`).
 */
export interface ForgejoApiConfig {
  /** Instance base URL, e.g. https://git.example.com (no trailing slash, no /api/v1). */
  baseUrl: string;
  /** Forgejo access token, or empty for anonymous public reads. */
  token: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Normalize an instance base URL: trim, drop trailing slash, and strip a trailing /api/v1. */
export function normalizeForgejoBaseUrl(value: string): string {
  const trimmed = (value ?? "").trim().replace(/\/+$/, "");
  return trimmed.replace(/\/api\/v1$/i, "");
}

/**
 * A non-2xx answer, carrying the STATUS as data rather than only in its message.
 * Callers that must tell "the thing is not there" (404) from "the question could
 * not be asked" (401/500/timeout) — the merge path's branch-deletion check does
 * — cannot get that from prose without pattern-matching on wording.
 */
export class ForgejoHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ForgejoHttpError";
  }
}

export interface ForgejoResponse<T> {
  data: T;
  status: number;
  /** Total item count reported by the `X-Total-Count` header, when present. */
  totalCount: number | null;
}

export async function forgejoRequest<T>(
  config: ForgejoApiConfig,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  options: {
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    /** Read the response as raw TEXT (Gitea's `.diff`/`.patch` endpoints) instead of JSON. */
    raw?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<ForgejoResponse<T>> {
  const base = normalizeForgejoBaseUrl(config.baseUrl);
  if (!base) {
    throw new Error(
      "Missing Forgejo base URL. Configure it in Settings → Forgejo.",
    );
  }
  const url = new URL(
    path.startsWith("http")
      ? path
      : `${base}/api/v1${path.startsWith("/") ? "" : "/"}${path}`,
  );
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = {
    Accept: options.raw ? "text/plain" : "application/json",
    "User-Agent": "personal-assistant",
  };
  if (config.token) headers.Authorization = `token ${config.token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers,
    ...(!(options.body === undefined)
      ? { body: JSON.stringify(options.body) }
      : {}),
    signal: options.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    const detail = parseErrorMessage(text);
    throw new ForgejoHttpError(
      `Forgejo API returned HTTP ${res.status} for ${method} ${url.pathname}${detail ? `: ${detail}` : ""}`,
      res.status,
    );
  }
  const data = (options.raw ? text : text ? JSON.parse(text) : {}) as T;
  return {
    data,
    status: res.status,
    totalCount: numberOrNull(res.headers.get("x-total-count")),
  };
}

/** Page through a Gitea list endpoint (`?page=&limit=`) up to `maxItems`. */
let cachedLogin: { key: string; login: string } | null = null;

/**
 * The login the configured token belongs to, cached per base URL + token so a
 * list that has to ask "is this mine?" for every pull request costs one probe.
 * `null` when anonymous or unreachable — callers must degrade rather than
 * treating an unknown identity as "everything is mine".
 */
export async function resolveForgejoLogin(
  config: ForgejoApiConfig,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!config.token) return null;
  const key = `${normalizeForgejoBaseUrl(config.baseUrl)}::${config.token}`;
  if (cachedLogin && cachedLogin.key === key) return cachedLogin.login;
  try {
    const res = await forgejoRequest<{ login?: string }>(
      config,
      "GET",
      "/user",
      { ...(signal !== undefined ? { signal } : {}) },
    );
    const login = typeof res.data?.login === "string" ? res.data.login : null;
    if (login) cachedLogin = { key, login };
    return login;
  } catch {
    return null;
  }
}

export async function forgejoPaginate<T>(
  config: ForgejoApiConfig,
  path: string,
  options: {
    query?: Record<string, string | number | boolean | undefined>;
    maxItems: number;
    signal?: AbortSignal;
  },
): Promise<{ items: T[]; exhausted: boolean; totalCount: number | null }> {
  const limit = Math.min(50, options.maxItems);
  const items: T[] = [];
  let page = 1;
  let exhausted = false;
  // `X-Total-Count` from the FIRST page: it counts the whole result set, so a
  // later page cannot change it, and pages past the cap are never fetched.
  let totalCount: number | null = null;
  while (items.length < options.maxItems) {
    const res = await forgejoRequest<T[]>(config, "GET", path, {
      query: { ...options.query, page, limit },
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    if (page === 1) totalCount = res.totalCount;
    const batch = Array.isArray(res.data) ? res.data : [];
    items.push(...batch);
    if (batch.length < limit) {
      exhausted = true;
      break;
    }
    page += 1;
  }
  return { items: items.slice(0, options.maxItems), exhausted, totalCount };
}

/**
 * Aggregate CI state for a ref, shared by the `forgejo_get_ref_checks` tool and
 * the git-hosting provider — the twin of `githubClient.githubRefChecks`.
 *
 * Forgejo has no check-runs concept: Actions jobs report as ordinary commit
 * statuses, so ONE endpoint (the combined `/commits/{ref}/status`) is the whole
 * answer rather than GitHub's two halves.
 */
export interface ForgejoRefChecksSummary {
  /** Forgejo's own state vocabulary; `neutral` means the ref carries no status at all. */
  state: "success" | "failure" | "error" | "warning" | "pending" | "neutral";
  /** TRUE number of status contexts on the ref (see `truncated`). */
  total: number;
  /** Commit the statuses hang off, as Forgejo resolved `ref`. */
  sha: string | null;
  /** `total` exceeds the contexts actually read, so `state` covers only one page. */
  truncated: boolean;
  /** Absolute web URL of the first failing status, else of the first one. */
  url: string | null;
  statuses: Array<{
    context: string | null;
    state: string | null;
    url: string | null;
    description: string | null;
  }>;
}

/** Status contexts read in one combined-status request. */
const REF_STATUS_LIMIT = 100;

/**
 * Gitea's own rollup order (`CalcCommitStatus`): the worst state present wins,
 * so a green context never hides a red one next to it.
 */
const FORGEJO_STATE_PRECEDENCE = [
  "error",
  "failure",
  "warning",
  "pending",
  "success",
] as const;

interface ForgejoCombinedStatusPayload {
  state?: string;
  sha?: string;
  total_count?: number;
  statuses?: Array<{
    context?: string;
    status?: string;
    target_url?: string;
    description?: string;
  }> | null;
}

/**
 * Combined CI for a ref (a branch, tag, or SHA) as one summary.
 *
 * Two Forgejo quirks are absorbed here rather than at each call site:
 *
 *  - the body's `total_count` is the PAGE length, not the context count — asking
 *    with `limit=1` answers `total_count: 1` on a ref carrying five statuses,
 *    and the body `state` is likewise computed over that page. `X-Total-Count`
 *    is the true total, so it is what `total` reports, and `truncated` says
 *    outright when `state` was decided on less than all of it;
 *  - `target_url` on an Actions-generated status is instance-RELATIVE
 *    (`/owner/repo/actions/runs/…`), which is not a link anything outside the
 *    instance's own pages can follow, so it is resolved against the base URL.
 */
export async function forgejoRefChecks(
  config: ForgejoApiConfig,
  owner: string,
  repo: string,
  ref: string,
  signal?: AbortSignal,
): Promise<ForgejoRefChecksSummary> {
  const res = await forgejoRequest<ForgejoCombinedStatusPayload>(
    config,
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}/status`,
    {
      query: { limit: REF_STATUS_LIMIT },
      ...(signal !== undefined ? { signal } : {}),
    },
  );
  const combined = res.data ?? {};
  const statuses = (combined.statuses ?? []).map((status) => ({
    context: status.context ?? null,
    state: status.status ?? null,
    url: absoluteForgejoUrl(config.baseUrl, status.target_url),
    description: status.description ?? null,
  }));
  // The header counts the whole set; fall back to what we actually read when the
  // instance does not send it, which under-reports rather than inventing a total.
  const total = res.totalCount ?? statuses.length;
  const state =
    total === 0
      ? "neutral"
      : (FORGEJO_STATE_PRECEDENCE.find((candidate) =>
          statuses.some((status) => status.state === candidate),
        ) ?? "pending");
  const failing = statuses.find((status) =>
    isFailedGitCheckStatus(status.state),
  );
  return {
    state,
    total,
    sha: combined.sha ?? null,
    truncated: total > statuses.length,
    url: failing?.url ?? statuses[0]?.url ?? null,
    statuses,
  };
}

/** Resolve an instance-relative Forgejo URL (`/owner/repo/…`) against the base URL. */
export function absoluteForgejoUrl(
  baseUrl: string,
  value: string | undefined | null,
): string | null {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  const base = normalizeForgejoBaseUrl(baseUrl);
  if (!base) return value;
  return `${base}${value.startsWith("/") ? "" : "/"}${value}`;
}

function parseErrorMessage(text: string): string {
  if (!text) return "";
  try {
    const payload = JSON.parse(text) as { message?: string };
    return payload?.message ?? text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

function numberOrNull(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
