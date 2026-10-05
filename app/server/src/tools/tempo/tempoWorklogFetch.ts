/**
 * Tempo worklog retrieval shared by `tempo_list_worklogs` and the full-range
 * export: one paged fetch that never stops early
 * without saying so, server-side issue/project/author filters through Tempo's
 * worklog search, and 429/5xx retry with backoff.
 */
import { fetchWithRetry } from "../../httpRetry.ts";

/** Raw Tempo v4 worklog. `issue` carries only the Jira issue id; keys need Jira. */
export type TempoWorklog = {
  tempoWorklogId?: number | string;
  id?: number | string;
  self?: string;
  issue?: {
    id?: number | string;
    key?: string;
    summary?: string;
    self?: string;
  };
  startDate?: string;
  startTime?: string;
  timeSpentSeconds?: number;
  billableSeconds?: number;
  description?: string;
  author?: { accountId?: string; displayName?: string; self?: string };
  attributes?:
    | { values?: Array<{ key?: string; value?: string }> }
    | Array<{ key?: string; value?: string }>;
  [key: string]: unknown;
};

type TempoWorklogsPage = {
  results?: TempoWorklog[];
  metadata?: { next?: string; count?: number; offset?: number; limit?: number };
};

/** Tempo's documented page ceiling for the worklog endpoints. */
export const TEMPO_PAGE_LIMIT = 1000;

/** Server-side worklog search filters (Tempo `POST /worklogs/search`). */
export interface TempoWorklogFilter {
  issueIds?: string[];
  projectIds?: string[];
}

export interface TempoFetchOptions {
  apiBaseUrl: string;
  accessToken: string;
  from: string;
  to: string;
  signal?: AbortSignal;
  onRetry?: (info: {
    attempt: number;
    delayMs: number;
    status: number;
  }) => void;
}

export interface TempoWorklogsResult {
  worklogs: TempoWorklog[];
  /** Raw Tempo offset of the first worklog NOT consumed; null when exhausted. */
  nextOffset: number | null;
  /** Raw worklogs read from Tempo (before any client-side author filter). */
  scanned: number;
}

/**
 * Read worklogs from `offset` until `maxResults` matches or the range is
 * exhausted. A client-side `authorAccountId` filter keeps working when Jira is
 * off (cached id); `filter` goes to the server. Callers MUST surface a non-null
 * `nextOffset` — that is the "never silently truncate" contract.
 */
export async function fetchWorklogs({
  maxResults,
  offset = 0,
  authorAccountId,
  filter,
  ...options
}: TempoFetchOptions & {
  maxResults: number;
  offset?: number;
  authorAccountId?: string;
  filter?: TempoWorklogFilter;
}): Promise<TempoWorklogsResult> {
  const out: TempoWorklog[] = [];
  let scanned = 0;
  let cursor = Math.max(0, Math.floor(offset));
  for (;;) {
    // A client-side author filter may drop most of a page, so read full pages
    // then; otherwise ask only for what is still missing.
    const limit = authorAccountId
      ? TEMPO_PAGE_LIMIT
      : Math.min(TEMPO_PAGE_LIMIT, Math.max(1, maxResults - out.length));
    const page = await fetchWorklogsPage({
      ...options,
      offset: cursor,
      limit,
      ...(filter ? { filter } : {}),
    });
    const results = page.results ?? [];
    const more = Boolean(page.metadata?.next) && results.length > 0;
    for (let index = 0; index < results.length; index += 1) {
      const worklog = results[index]!;
      if (authorAccountId && worklog.author?.accountId !== authorAccountId)
        continue;
      out.push(worklog);
      if (out.length >= maxResults) {
        const consumed = index + 1;
        scanned += consumed;
        cursor += consumed;
        const remaining = consumed < results.length || more;
        return {
          worklogs: out,
          nextOffset: remaining ? cursor : null,
          scanned,
        };
      }
    }
    scanned += results.length;
    cursor += results.length;
    if (!more) return { worklogs: out, nextOffset: null, scanned };
  }
}

/** Every worklog in the range (all pages), for exports of one bounded window. */
export async function fetchAllWorklogs(
  options: TempoFetchOptions & { filter?: TempoWorklogFilter },
): Promise<TempoWorklog[]> {
  const out: TempoWorklog[] = [];
  let offset = 0;
  for (;;) {
    const page = await fetchWorklogsPage({
      ...options,
      offset,
      limit: TEMPO_PAGE_LIMIT,
    });
    const results = page.results ?? [];
    out.push(...results);
    offset += results.length;
    if (!page.metadata?.next || results.length === 0) return out;
  }
}

async function fetchWorklogsPage({
  apiBaseUrl,
  accessToken,
  from,
  to,
  offset,
  limit,
  filter,
  signal,
  onRetry,
}: TempoFetchOptions & {
  offset: number;
  limit: number;
  filter?: TempoWorklogFilter;
}): Promise<TempoWorklogsPage> {
  const filtered = Boolean(
    filter?.issueIds?.length || filter?.projectIds?.length,
  );
  const url = new URL(
    `${apiBaseUrl.replace(/\/$/, "")}/worklogs${filtered ? "/search" : ""}`,
  );
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("limit", String(limit));
  if (!filtered) {
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);
    return tempoJson<TempoWorklogsPage>(url, accessToken, "GET", undefined, {
      ...(signal ? { signal } : {}),
      ...(onRetry ? { onRetry } : {}),
    });
  }
  return tempoJson<TempoWorklogsPage>(
    url,
    accessToken,
    "POST",
    {
      from,
      to,
      ...(filter?.issueIds?.length
        ? { issueIds: filter.issueIds.map(numericId) }
        : {}),
      ...(filter?.projectIds?.length
        ? { projectIds: filter.projectIds.map(numericId) }
        : {}),
    },
    {
      retry: true,
      ...(signal ? { signal } : {}),
      ...(onRetry ? { onRetry } : {}),
    },
  );
}

function numericId(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(
      `Tempo search filters need numeric Jira ids; got "${value}".`,
    );
  return n;
}

/** Retry policy of one Tempo call; see {@link tempoJson}. */
export interface TempoCallOptions {
  signal?: AbortSignal;
  onRetry?: (info: {
    attempt: number;
    delayMs: number;
    status: number;
  }) => void;
  /** Retry 429/5xx. Defaults to true for GET and false otherwise — a worklog POST is never replayed. */
  retry?: boolean;
}

export async function tempoJson<T>(
  url: URL,
  token: string,
  method: "GET" | "POST" | "PUT",
  body?: unknown,
  options: TempoCallOptions = {},
): Promise<T> {
  const retry = options.retry ?? method === "GET";
  const res = await fetchWithRetry(
    url,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(!(body === undefined) ? { body: JSON.stringify(body) } : {}),
    },
    {
      ...(retry ? {} : { attempts: 1 }),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onRetry ? { onRetry: options.onRetry } : {}),
    },
  );
  const text = await res.text();
  if (!res.ok)
    throw new Error(
      `Tempo API returned HTTP ${res.status}: ${text.slice(0, 400)}`,
    );
  return text ? (JSON.parse(text) as T) : ({} as T);
}

/** The Tempo `_Account_` attribute (the activity/account key) of a worklog. */
export function extractActivity(worklog: TempoWorklog): string | null {
  const attrs = Array.isArray(worklog.attributes)
    ? worklog.attributes
    : worklog.attributes?.values;
  const activity = attrs?.find((attr) => attr.key === "_Account_");
  return activity?.value ?? null;
}

export function worklogIdOf(worklog: TempoWorklog): string {
  return String(worklog.tempoWorklogId ?? worklog.id ?? "");
}
