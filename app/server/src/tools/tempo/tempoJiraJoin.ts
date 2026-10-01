/**
 * Jira-side lookups the Tempo tools need: bulk issue metadata (key, summary,
 * type, labels, project, any custom field), project key → id, issue key → id,
 * and account id → display name. Everything is batched and retried on 429
 * (`jiraClient` → `fetchWithRetry`); the callers persist results so a Jira
 * hiccup never forces a Tempo re-extraction.
 */
import {
  jiraCachePath,
  readJsonCacheFile,
  writeJsonCacheFile,
} from "../../jiraCacheFile.ts";
import { jiraGet, jiraPost, type JiraApiConfig } from "../../jiraClient.ts";

/** Jira's `POST /rest/api/3/issue/bulkfetch` ceiling. */
const BULK_FETCH_SIZE = 100;
/** `GET /rest/api/3/user/bulk` ceiling. */
const USER_BULK_SIZE = 100;
const PROJECT_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const BASE_FIELDS = ["summary", "issuetype", "status", "project", "labels"];

export interface TempoIssueMeta {
  id: string;
  key: string;
  summary: string;
  projectKey: string | null;
  projectName: string | null;
  issueType: string | null;
  status: string | null;
  labels: string[];
  /** Extra Jira fields by id, flattened to display strings. */
  fields: Record<string, string>;
}

type BulkFetchResponse = {
  issues?: Array<{
    id?: string;
    key?: string;
    fields?: Record<string, unknown>;
  }>;
  issueErrors?: Array<{ id?: string; key?: string; errorMessage?: string }>;
};

/**
 * Metadata for issue ids and/or keys. Missing/inaccessible issues are simply
 * absent from the map (the caller decides how to label them).
 */
export async function fetchIssueMetadata(
  jira: JiraApiConfig,
  idsOrKeys: string[],
  extraFields: string[] = [],
  signal?: AbortSignal,
): Promise<Map<string, TempoIssueMeta>> {
  const out = new Map<string, TempoIssueMeta>();
  const wanted = [...new Set(idsOrKeys.map((v) => v.trim()).filter(Boolean))];
  const fields = [...new Set([...BASE_FIELDS, ...extraFields])];
  for (let index = 0; index < wanted.length; index += BULK_FETCH_SIZE) {
    const batch = wanted.slice(index, index + BULK_FETCH_SIZE);
    const page = await jiraPost<BulkFetchResponse>(
      jira,
      "/rest/api/3/issue/bulkfetch",
      { issueIdsOrKeys: batch, fields },
      undefined,
      { retry: true, ...(signal ? { signal } : {}) },
    );
    for (const issue of page.issues ?? []) {
      if (!issue.id || !issue.key) continue;
      const raw = issue.fields ?? {};
      const meta: TempoIssueMeta = {
        id: String(issue.id),
        key: issue.key,
        summary: stringOf(raw.summary),
        projectKey: nullableString(objectField(raw.project, "key")),
        projectName: nullableString(objectField(raw.project, "name")),
        issueType: nullableString(objectField(raw.issuetype, "name")),
        status: nullableString(objectField(raw.status, "name")),
        labels: Array.isArray(raw.labels)
          ? raw.labels.filter((l): l is string => typeof l === "string")
          : [],
        fields: Object.fromEntries(
          extraFields.map((id) => [id, flattenFieldValue(raw[id])]),
        ),
      };
      out.set(meta.id, meta);
      out.set(meta.key, meta);
    }
  }
  return out;
}

/** Jira issue ids for keys (bulkfetch, so an unknown key is reported, not fatal). */
async function resolveIssueIds(
  jira: JiraApiConfig,
  keys: string[],
  signal?: AbortSignal,
): Promise<{ ids: string[]; unknown: string[] }> {
  const metas = await fetchIssueMetadata(jira, keys, [], signal);
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const key of keys) {
    const meta = metas.get(key);
    if (meta) ids.push(meta.id);
    else unknown.push(key);
  }
  return { ids: [...new Set(ids)], unknown };
}

interface ProjectCacheFile {
  projects: Record<
    string,
    { id: string; key: string; name: string; fetchedAt: number }
  >;
}

/** Jira project ids for keys, cached per host for a week. */
async function resolveProjectIds(
  jira: JiraApiConfig,
  keys: string[],
  signal?: AbortSignal,
): Promise<{ ids: string[]; unknown: string[] }> {
  const path = jiraCachePath(jira.jiraHost, "projects");
  const cache = readJsonCacheFile<ProjectCacheFile>(path) ?? { projects: {} };
  const ids: string[] = [];
  const unknown: string[] = [];
  let dirty = false;
  for (const key of keys) {
    const cached = cache.projects[key];
    if (cached && Date.now() - cached.fetchedAt < PROJECT_CACHE_MAX_AGE_MS) {
      ids.push(cached.id);
      continue;
    }
    try {
      const project = await jiraGet<{
        id?: string;
        key?: string;
        name?: string;
      }>(
        jira,
        `/rest/api/3/project/${encodeURIComponent(key)}`,
        undefined,
        signal ? { signal } : {},
      );
      if (!project.id) throw new Error("no id");
      cache.projects[key] = {
        id: String(project.id),
        key: project.key ?? key,
        name: project.name ?? "",
        fetchedAt: Date.now(),
      };
      dirty = true;
      ids.push(String(project.id));
    } catch (error) {
      if (isAbort(error)) throw error;
      if (cached) ids.push(cached.id);
      else unknown.push(key);
    }
  }
  if (dirty) writeJsonCacheFile(path, cache);
  return { ids: [...new Set(ids)], unknown };
}

/**
 * Project/issue keys → Jira ids for Tempo's server-side worklog filter.
 * Numeric input passes through (so the filter works with Jira off); unknown
 * keys are reported in `notes`, and a filter that resolves to nothing throws
 * rather than silently exporting everything.
 */
export async function resolveTempoFilterIds(
  jira: JiraApiConfig | null,
  raw: string[] | undefined,
  kind: "project" | "issue",
  signal: AbortSignal | undefined,
  notes: string[],
): Promise<string[]> {
  const keys = [
    ...new Set(
      (raw ?? []).map((key) => key.trim().toUpperCase()).filter(Boolean),
    ),
  ];
  if (keys.length === 0) return [];
  const numeric = keys.filter((key) => /^\d+$/.test(key));
  const symbolic = keys.filter((key) => !/^\d+$/.test(key));
  if (symbolic.length && !jira)
    throw new Error(
      `Resolving ${kind} keys (${symbolic.join(", ")}) needs the Jira integration with enrichment on. Enable Jira in Settings → Jira, leave jiraEnrichment on, or pass numeric ${kind} ids.`,
    );
  if (!symbolic.length || !jira) return numeric;
  const resolved =
    kind === "project"
      ? await resolveProjectIds(jira, symbolic, signal)
      : await resolveIssueIds(jira, symbolic, signal);
  if (resolved.unknown.length)
    notes.push(
      `Unknown ${kind} key(s) ignored: ${resolved.unknown.join(", ")}.`,
    );
  if (resolved.ids.length === 0 && numeric.length === 0)
    throw new Error(
      `None of the requested ${kind} keys exist in Jira: ${symbolic.join(", ")}.`,
    );
  return [...new Set([...numeric, ...resolved.ids])];
}

type UserBulkResponse = {
  values?: Array<{ accountId?: string; displayName?: string }>;
};

/** Display names for Atlassian account ids (`GET /rest/api/3/user/bulk`). */
export async function resolveUserNames(
  jira: JiraApiConfig,
  accountIds: string[],
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = [...new Set(accountIds.filter(Boolean))];
  for (let index = 0; index < wanted.length; index += USER_BULK_SIZE) {
    const batch = wanted.slice(index, index + USER_BULK_SIZE);
    const query = batch.map((id) => `accountId=${encodeURIComponent(id)}`);
    const page = await jiraGet<UserBulkResponse>(
      jira,
      `/rest/api/3/user/bulk?maxResults=${USER_BULK_SIZE}&${query.join("&")}`,
      undefined,
      signal ? { signal } : {},
    );
    for (const user of page.values ?? []) {
      if (user.accountId && user.displayName)
        out.set(user.accountId, user.displayName);
    }
  }
  return out;
}

/** Any Jira field value as one display string (option → value, user → name, arrays joined). */
function flattenFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value))
    return value.map(flattenFieldValue).filter(Boolean).join("; ");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["value", "name", "displayName", "key"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate) {
        const child = record.child;
        return child ? `${candidate} / ${flattenFieldValue(child)}` : candidate;
      }
    }
    return JSON.stringify(value);
  }
  return String(value);
}

function objectField(value: unknown, key: string): unknown {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
