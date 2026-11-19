/**
 * Jira's field list and issue link types (Task-1439): their shapes, the
 * uncached reads, and name resolution. Pandeck's per-site caches
 * (`jiraFieldCache.ts`, `jiraIssueLinkTypeCache.ts`) keep them on disk; the
 * gateway edge reads them per call and stores nothing, so this module
 * imports no server state (`workerBoundary.test.ts`).
 */
import { jiraGet, type JiraConfig } from "./jiraClient.ts";

export interface JiraFieldMeta {
  id: string;
  key?: string;
  name: string;
  custom: boolean;
  orderable?: boolean;
  navigable?: boolean;
  searchable?: boolean;
  clauseNames?: string[];
  schema?: {
    type?: string;
    items?: string;
    system?: string;
    custom?: string;
    customId?: number;
    configuration?: unknown;
  };
}

export interface JiraFieldMap {
  fetchedAt: number;
  byId: Map<string, JiraFieldMeta>;
  byNameLower: Map<string, JiraFieldMeta[]>;
}

/**
 * Jira issue link types are global to the whole site (not per-project), so a
 * single per-host list serves every project.
 */
export interface JiraIssueLinkType {
  id: string;
  name: string;
  /** Phrase describing the link from the outward issue, e.g. "blocks". */
  outward: string;
  /** Phrase describing the link from the inward issue, e.g. "is blocked by". */
  inward: string;
}

type JiraIssueLinkTypeResponse = {
  issueLinkTypes?: Array<{
    id?: string;
    name?: string;
    inward?: string;
    outward?: string;
  }>;
};

/** `GET /rest/api/3/field`, normalized. */
export async function fetchJiraFields(
  config: JiraConfig,
  signal?: AbortSignal,
): Promise<JiraFieldMeta[]> {
  const fields = await jiraGet<JiraFieldMeta[]>(
    config,
    "/rest/api/3/field",
    undefined,
    signal ? { signal } : {},
  );
  return fields.map(normalizeFieldMeta);
}

/** `GET /rest/api/3/issueLinkType`, normalized. */
export async function fetchJiraIssueLinkTypes(
  config: JiraConfig,
  signal?: AbortSignal,
): Promise<JiraIssueLinkType[]> {
  const response = await jiraGet<JiraIssueLinkTypeResponse>(
    config,
    "/rest/api/3/issueLinkType",
    undefined,
    signal ? { signal } : {},
  );
  return (response.issueLinkTypes ?? [])
    .map(normalizeLinkType)
    .filter((type): type is JiraIssueLinkType => type !== null);
}

export function buildFieldMap(file: {
  fetchedAt: number;
  fields: JiraFieldMeta[];
}): JiraFieldMap {
  const byId = new Map<string, JiraFieldMeta>();
  const byNameLower = new Map<string, JiraFieldMeta[]>();
  for (const field of file.fields) {
    byId.set(field.id, field);
    const name = field.name.toLowerCase();
    byNameLower.set(name, [...(byNameLower.get(name) ?? []), field]);
  }
  return { fetchedAt: file.fetchedAt, byId, byNameLower };
}

export function resolveFieldName(
  fieldMap: JiraFieldMap,
  nameOrId: string,
): JiraFieldMeta | null {
  const trimmed = nameOrId.trim();
  if (!trimmed) return null;
  const byId = fieldMap.byId.get(trimmed);
  if (byId) return byId;
  const matches = fieldMap.byNameLower.get(trimmed.toLowerCase()) ?? [];
  return matches.find((field) => field.custom) ?? matches[0] ?? null;
}

/** Resolve a link type by exact id or case-insensitive name; returns null when not found. */
export function resolveIssueLinkType(
  linkTypes: JiraIssueLinkType[],
  nameOrId: string,
): JiraIssueLinkType | null {
  const trimmed = nameOrId.trim();
  if (!trimmed) return null;
  const byId = linkTypes.find((type) => type.id === trimmed);
  if (byId) return byId;
  const lower = trimmed.toLowerCase();
  return linkTypes.find((type) => type.name.toLowerCase() === lower) ?? null;
}

function normalizeFieldMeta(field: JiraFieldMeta): JiraFieldMeta {
  return {
    ...field,
    id: field.id,
    name: field.name,
    custom: Boolean(field.custom || field.id.startsWith("customfield_")),
  };
}

function normalizeLinkType(type: {
  id?: string;
  name?: string;
  inward?: string;
  outward?: string;
}): JiraIssueLinkType | null {
  if (!type.id || !type.name) return null;
  return {
    id: type.id,
    name: type.name,
    outward: type.outward ?? type.name,
    inward: type.inward ?? type.name,
  };
}
