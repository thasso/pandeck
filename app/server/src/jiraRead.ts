/**
 * What Jira's read tools share (Task-1439): `jira_search_issues` and
 * `jira_lookup` run here (`jiraSearch.ts`, `jiraLookup.ts`,
 * `jiraSprintLookup.ts`) for Pandeck's local tools and the gateway edge
 * alike. These modules import only `node:`, the Jira client, its helpers and
 * each other, never server state (`workerBoundary.test.ts`): the caller
 * hands in the config, the call's signal and the field/link-type loaders.
 */
import { adfToText } from "./atlassian/adfToMarkdown.ts";
import {
  jiraBaseUrl,
  normalizeAvatarUrls,
  pickAvatarUrl,
  type JiraCallOptions,
} from "./jiraClient.ts";
import type { JiraFieldMap, JiraIssueLinkType } from "./jiraFields.ts";

/** Why a read refused its input before (or instead of) asking Jira. */
export type JiraReadRefusalCode =
  | "jql_empty"
  | "jql_too_long"
  | "assignable_without_project"
  | "sprint_board_invalid"
  | "sprint_scope_missing"
  | "sprint_state_unknown"
  | "project_without_board";

/**
 * An input refusal. `message` is the local tool's text and may name the
 * caller's input; the edge answers by `code` with its own text.
 */
export class JiraReadRefusal extends Error {
  constructor(
    readonly code: JiraReadRefusalCode,
    message: string,
  ) {
    super(message);
  }
}

/** What a read needs besides the config and its parameters. */
export interface JiraReadDeps {
  /** Every Jira request carries it; paging stops once it aborts. */
  signal?: AbortSignal | undefined;
  fieldMap(): Promise<JiraFieldMap>;
  issueLinkTypes(): Promise<JiraIssueLinkType[]>;
}

/** The call options carrying `signal`, when there is one. */
export function withSignal(
  signal: AbortSignal | undefined,
  options: JiraCallOptions = {},
): JiraCallOptions {
  return signal ? { ...options, signal } : options;
}

/**
 * The trailing `query, options` arguments of a call that has no query: none
 * without a signal, so the call keeps its exact argument list.
 */
export function signalTail(
  signal: AbortSignal | undefined,
): [query?: undefined, options?: JiraCallOptions] {
  return signal ? [undefined, { signal }] : [];
}

/** The trailing `options` argument: none without a signal. */
export function signalOptions(
  signal: AbortSignal | undefined,
): [options?: JiraCallOptions] {
  return signal ? [{ signal }] : [];
}

/** Throws before a next page or request once the call is aborted. */
export function stopIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

export type JiraFieldSchema = {
  type?: string;
  items?: string;
  system?: string;
  custom?: string;
  customId?: number;
};

export type JiraIssueResponse = {
  id?: string;
  key?: string;
  self?: string;
  fields?: Record<string, any>;
  names?: Record<string, string>;
  schema?: Record<string, JiraFieldSchema>;
};

export type JiraProjectResponse = {
  id?: string;
  key?: string;
  name?: string;
  self?: string;
  description?: string;
  projectTypeKey?: string;
  simplified?: boolean;
  style?: string;
  isPrivate?: boolean;
  url?: string;
  lead?: any;
  avatarUrls?: Record<string, string>;
  issueTypes?: Array<{
    id?: string;
    name?: string;
    description?: string;
    iconUrl?: string;
    subtask?: boolean;
  }>;
  projectCategory?: { id?: string; name?: string; description?: string };
};

export function normalizeProject(
  project: JiraProjectResponse,
  jiraHost: string,
) {
  const avatarUrls = normalizeAvatarUrls(project.avatarUrls);
  const key = project.key ?? null;
  const base = jiraHost ? jiraBaseUrl(jiraHost) : null;
  return {
    id: project.id ?? null,
    key,
    name: project.name ?? null,
    self: project.self ?? null,
    projectUrl:
      key && base ? `${base}/browse/${encodeURIComponent(key)}` : null,
    description: project.description ?? null,
    projectTypeKey: project.projectTypeKey ?? null,
    simplified:
      typeof project.simplified === "boolean" ? project.simplified : null,
    style: project.style ?? null,
    isPrivate:
      typeof project.isPrivate === "boolean" ? project.isPrivate : null,
    url: project.url ?? null,
    category: project.projectCategory
      ? {
          id: project.projectCategory.id ?? null,
          name: project.projectCategory.name ?? null,
          description: project.projectCategory.description ?? null,
        }
      : null,
    lead: project.lead ? normalizeJiraUser(project.lead, jiraHost) : null,
    avatarUrl: pickAvatarUrl(avatarUrls),
    issueTypes: (project.issueTypes ?? []).map((issueType) => ({
      id: issueType.id ?? null,
      name: issueType.name ?? null,
      description: issueType.description ?? null,
      iconUrl: issueType.iconUrl ?? null,
      subtask:
        typeof issueType.subtask === "boolean" ? issueType.subtask : null,
    })),
  };
}

export function normalizeJiraUser(user: any, jiraHost: string) {
  const avatarUrls = normalizeAvatarUrls(user?.avatarUrls);
  const accountId = user?.accountId ?? null;
  const base = jiraHost ? jiraBaseUrl(jiraHost) : null;
  return {
    accountId,
    accountType: user?.accountType ?? null,
    displayName: user?.displayName ?? null,
    emailAddress: user?.emailAddress ?? null,
    active: typeof user?.active === "boolean" ? user.active : null,
    timeZone: user?.timeZone ?? null,
    locale: user?.locale ?? null,
    self: user?.self ?? null,
    userUrl:
      accountId && base
        ? `${base}/jira/people/${encodeURIComponent(accountId)}`
        : null,
    avatarUrl: pickAvatarUrl(avatarUrls),
  };
}

export function normalizeOptionalString(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function normalizeStringList(
  values: string[] | undefined | readonly string[],
): string[] {
  return unique(
    (values ?? []).map((value) => String(value).trim()).filter(Boolean),
  );
}

export function clampDesiredResults(
  value: number | undefined,
  defaultValue: number,
  maxValue: number,
): number {
  if (value === undefined) return defaultValue;
  if (!Number.isFinite(value) || value <= 0) return defaultValue;
  return Math.min(maxValue, Math.floor(value));
}

export function clampStartAt(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

export function valueToText(value: unknown): string | null {
  if (isEmptyValue(value)) return null;
  if (typeof value === "string") return truncate(value);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) {
    const parts = value
      .map(valueToText)
      .filter((item): item is string => Boolean(item));
    return parts.length > 0 ? truncate(parts.join(", ")) : null;
  }
  if (typeof value === "object") {
    const docText = adfToText(value);
    if (docText) return truncate(docText);
    const obj = value as Record<string, unknown>;
    for (const key of ["value", "name", "title", "displayName", "key", "id"]) {
      if (typeof obj[key] === "string" && obj[key]) return truncate(obj[key]);
    }
    return truncate(JSON.stringify(value));
  }
  return null;
}

export function isEmptyValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

export function truncate(value: string): string {
  return value.length > 1000 ? `${value.slice(0, 997)}…` : value;
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
