import { adfToMarkdown, adfToText } from "./atlassian/adfToMarkdown.ts";
import {
  atlassianBaseUrl,
  atlassianFetch,
  type AtlassianQuery,
} from "./atlassian/atlassianFetch.ts";

export interface JiraApiConfig {
  jiraHost: string;
  atlassianEmail: string;
  atlassianToken: string;
}

export interface JiraIssueInfo {
  id: string;
  key: string;
  summary: string;
  projectKey: string;
  projectName: string;
  issueType: string;
  status: string;
}

interface JiraUserInfo {
  accountId: string | null;
  displayName: string | null;
  emailAddress: string | null;
  active: boolean | null;
  self: string | null;
  avatarUrl?: string | null;
}

export interface NormalizedJiraIssue {
  id: string | null;
  key: string | null;
  issueUrl: string | null;
  self: string | null;
  summary: string;
  description?: string | null;
  descriptionMarkdown?: string | null;
  project: {
    id: string | null;
    key: string | null;
    name: string | null;
  } | null;
  issueType: {
    id: string | null;
    name: string | null;
    iconUrl?: string | null;
  } | null;
  status: {
    id: string | null;
    name: string | null;
    category: string | null;
    colorName?: string | null;
  } | null;
  priority: {
    id: string | null;
    name: string | null;
    iconUrl?: string | null;
  } | null;
  assignee: JiraUserInfo | null;
  reporter: JiraUserInfo | null;
  creator: JiraUserInfo | null;
  labels: string[];
  components: Array<{ id: string | null; name: string | null }>;
  fixVersions: Array<{
    id: string | null;
    name: string | null;
    released: boolean | null;
  }>;
  created: string | null;
  updated: string | null;
  dueDate: string | null;
  parent: {
    id: string | null;
    key: string | null;
    issueUrl: string | null;
    summary: string | null;
    issueType: string | null;
    status: string | null;
  } | null;
  subtasks: Array<{
    id: string | null;
    key: string | null;
    issueUrl: string | null;
    summary: string | null;
    issueType: string | null;
    status: string | null;
  }>;
  issueLinks: NormalizedJiraIssueLink[];
}

interface NormalizedJiraIssueLink {
  /** Issue link id, required to delete the link via DELETE /rest/api/3/issueLink/{id}. */
  id: string | null;
  /** Link type name, e.g. "Blocks", "Duplicate", "Relates". */
  type: string | null;
  /** Direction from this issue's perspective: outward uses the type's outward phrase, inward the inward phrase. */
  direction: "inward" | "outward" | null;
  /** Human-readable relationship phrase from this issue's perspective, e.g. "blocks" or "is blocked by". */
  relationship: string | null;
  /** The issue on the other end of the link. */
  issue: {
    id: string | null;
    key: string | null;
    issueUrl: string | null;
    summary: string | null;
    issueType: string | null;
    status: string | null;
  } | null;
}

type JiraIssueResponse = {
  id?: string;
  key?: string;
  self?: string;
  fields?: Record<string, any>;
};

/**
 * Retry policy of one call. Only a GET retries by default: a POST that
 * created an issue, comment or link before the connection dropped must not
 * be replayed. Read-only POSTs (JQL search, bulkfetch) opt in with
 * `retry: true`.
 */
export interface JiraCallOptions {
  signal?: AbortSignal;
  retry?: boolean;
}

export async function jiraGet<T>(
  config: JiraApiConfig,
  path: string,
  query?: AtlassianQuery,
  options: JiraCallOptions = {},
): Promise<T> {
  return jiraFetch<T>(config, "GET", path, undefined, query, {
    retry: true,
    ...options,
  });
}

export async function jiraPost<T>(
  config: JiraApiConfig,
  path: string,
  body: unknown,
  query?: AtlassianQuery,
  options: JiraCallOptions = {},
): Promise<T> {
  return jiraFetch<T>(config, "POST", path, body, query, options);
}

export async function jiraPut<T>(
  config: JiraApiConfig,
  path: string,
  body: unknown,
  query?: AtlassianQuery,
): Promise<T> {
  return jiraFetch<T>(config, "PUT", path, body, query);
}

export async function jiraDelete<T>(
  config: JiraApiConfig,
  path: string,
  query?: AtlassianQuery,
): Promise<T> {
  return jiraFetch<T>(config, "DELETE", path, undefined, query);
}

/** Jira's Basic-auth call, delegating transport and retry policy to the shared Atlassian client. */
async function jiraFetch<T>(
  config: JiraApiConfig,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  query?: AtlassianQuery,
  options: JiraCallOptions = {},
): Promise<T> {
  return atlassianFetch<T>(
    {
      host: config.jiraHost,
      atlassianEmail: config.atlassianEmail,
      atlassianToken: config.atlassianToken,
    },
    "Jira",
    method,
    path,
    body,
    query,
    options,
  );
}

export async function resolveJiraIssueInfos(
  config: JiraApiConfig,
  issueIds: string[],
): Promise<Map<string, JiraIssueInfo>> {
  const ids = [...new Set(issueIds.filter(Boolean).map(String))];
  const out = new Map<string, JiraIssueInfo>();
  if (ids.length === 0) return out;
  if (!config.atlassianEmail || !config.atlassianToken) return out;

  await mapLimit(ids, 6, async (id) => {
    const json = await jiraGet<JiraIssueResponse>(
      config,
      `/rest/api/3/issue/${encodeURIComponent(id)}`,
      {
        fields: "summary,project,issuetype,status",
      },
    );
    if (!json.id) return;
    out.set(String(json.id), {
      id: String(json.id),
      key: json.key ?? String(json.id),
      summary: stringField(json.fields?.summary),
      projectKey: stringField(json.fields?.project?.key),
      projectName: stringField(json.fields?.project?.name),
      issueType: stringField(json.fields?.issuetype?.name),
      status: stringField(json.fields?.status?.name),
    });
  });
  return out;
}

export function normalizeJiraIssue(
  issue: JiraIssueResponse,
  jiraHost: string,
  options: { includeDescription?: boolean } = {},
): NormalizedJiraIssue {
  const fields = issue.fields ?? {};
  const key = issue.key ?? null;
  return {
    id: issue.id ?? null,
    key,
    issueUrl: key ? jiraIssueUrl(jiraHost, key) : null,
    self: issue.self ?? null,
    summary: stringField(fields.summary),
    ...(options.includeDescription
      ? {
          description: adfToText(fields.description),
          descriptionMarkdown: adfToMarkdown(fields.description),
        }
      : {}),
    project: fields.project
      ? {
          id: fields.project.id ?? null,
          key: fields.project.key ?? null,
          name: fields.project.name ?? null,
        }
      : null,
    issueType: fields.issuetype
      ? {
          id: fields.issuetype.id ?? null,
          name: fields.issuetype.name ?? null,
          iconUrl: fields.issuetype.iconUrl ?? null,
        }
      : null,
    status: fields.status
      ? {
          id: fields.status.id ?? null,
          name: fields.status.name ?? null,
          category: fields.status.statusCategory?.name ?? null,
          colorName: fields.status.statusCategory?.colorName ?? null,
        }
      : null,
    priority: fields.priority
      ? {
          id: fields.priority.id ?? null,
          name: fields.priority.name ?? null,
          iconUrl: fields.priority.iconUrl ?? null,
        }
      : null,
    assignee: normalizeUser(fields.assignee),
    reporter: normalizeUser(fields.reporter),
    creator: normalizeUser(fields.creator),
    labels: Array.isArray(fields.labels)
      ? fields.labels.filter(
          (label: unknown): label is string => typeof label === "string",
        )
      : [],
    components: Array.isArray(fields.components)
      ? fields.components.map((item: any) => ({
          id: item?.id ?? null,
          name: item?.name ?? null,
        }))
      : [],
    fixVersions: Array.isArray(fields.fixVersions)
      ? fields.fixVersions.map((item: any) => ({
          id: item?.id ?? null,
          name: item?.name ?? null,
          released: typeof item?.released === "boolean" ? item.released : null,
        }))
      : [],
    created: fields.created ?? null,
    updated: fields.updated ?? null,
    dueDate: fields.duedate ?? null,
    parent: normalizeIssueRef(fields.parent, jiraHost),
    subtasks: Array.isArray(fields.subtasks)
      ? fields.subtasks
          .map((item: any) => normalizeIssueRef(item, jiraHost))
          .filter(isIssueRef)
      : [],
    issueLinks: Array.isArray(fields.issuelinks)
      ? fields.issuelinks
          .map((item: any) => normalizeIssueLink(item, jiraHost))
          .filter(isIssueLink)
      : [],
  };
}

function normalizeIssueLink(
  link: any,
  jiraHost: string,
): NormalizedJiraIssueLink | null {
  if (!link || typeof link !== "object") return null;
  const type = link.type ?? {};
  const outward = link.outwardIssue
    ? normalizeIssueRef(link.outwardIssue, jiraHost)
    : null;
  const inward = link.inwardIssue
    ? normalizeIssueRef(link.inwardIssue, jiraHost)
    : null;
  // A single link entry references the other issue via exactly one of outwardIssue/inwardIssue.
  const direction: "inward" | "outward" | null = outward
    ? "outward"
    : inward
      ? "inward"
      : null;
  const other = outward ?? inward;
  if (!other) return null;
  return {
    id: link.id ?? null,
    type: type.name ?? null,
    direction,
    relationship:
      direction === "outward"
        ? (type.outward ?? null)
        : direction === "inward"
          ? (type.inward ?? null)
          : null,
    issue: other,
  };
}

function isIssueLink(
  value: NormalizedJiraIssueLink | null,
): value is NormalizedJiraIssueLink {
  return value !== null;
}

export function jiraIssueUrl(jiraHost: string, issueKey: string): string {
  return `${jiraBaseUrl(jiraHost)}/browse/${encodeURIComponent(issueKey)}`;
}

export function jiraBaseUrl(jiraHost: string): string {
  return atlassianBaseUrl(jiraHost);
}

function normalizeUser(user: any): JiraUserInfo | null {
  if (!user) return null;
  const avatarUrls = normalizeAvatarUrls(user.avatarUrls);
  return {
    accountId: user.accountId ?? null,
    displayName: user.displayName ?? null,
    emailAddress: user.emailAddress ?? null,
    active: typeof user.active === "boolean" ? user.active : null,
    self: user.self ?? null,
    avatarUrl: pickAvatarUrl(avatarUrls),
  };
}

function normalizeIssueRef(
  issue: any,
  jiraHost: string,
): NormalizedJiraIssue["parent"] {
  if (!issue) return null;
  const key = issue.key ?? null;
  const fields = issue.fields ?? {};
  return {
    id: issue.id ?? null,
    key,
    issueUrl: key ? jiraIssueUrl(jiraHost, key) : null,
    summary: fields.summary ?? null,
    issueType: fields.issuetype?.name ?? null,
    status: fields.status?.name ?? null,
  };
}

function isIssueRef(
  value: NormalizedJiraIssue["parent"],
): value is NonNullable<NormalizedJiraIssue["parent"]> {
  return value !== null;
}

export function normalizeAvatarUrls(
  value: unknown,
): Record<string, string> | null {
  if (!value || typeof value !== "object") return null;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[1].length > 0,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

export function pickAvatarUrl(
  avatarUrls: Record<string, string> | null | undefined,
): string | null {
  if (!avatarUrls) return null;
  return (
    avatarUrls["48x48"] ??
    avatarUrls["32x32"] ??
    avatarUrls["24x24"] ??
    avatarUrls["16x16"] ??
    Object.values(avatarUrls)[0] ??
    null
  );
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const item = items[index++];
      if (item !== undefined) await fn(item);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}
