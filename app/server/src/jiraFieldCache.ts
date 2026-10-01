import type { JiraApiConfig } from "./jiraClient.ts";
import { jiraGet } from "./jiraClient.ts";
import {
  jiraCachePath,
  readJsonCacheFile as readJson,
  writeJsonCacheFile as writeJson,
} from "./jiraCacheFile.ts";
const FIELD_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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

interface FieldCacheFile {
  fetchedAt: number;
  fields: JiraFieldMeta[];
}

interface JiraCustomFieldProfileField {
  id: string;
  name: string;
  schemaType: string | null;
  customType: string | null;
}

export interface JiraCustomFieldProfile {
  projectKey: string;
  issueTypeId: string;
  issueTypeName: string | null;
  learnedAt: number;
  learnedFromIssue: string | null;
  fields: JiraCustomFieldProfileField[];
}

interface ProfileCacheFile {
  profiles: Record<string, JiraCustomFieldProfile>;
}

export async function getJiraFieldMap(
  config: JiraApiConfig,
  options: { maxAgeMs?: number } = {},
): Promise<JiraFieldMap> {
  const path = fieldCachePath(config.jiraHost);
  const maxAgeMs = options.maxAgeMs ?? FIELD_CACHE_MAX_AGE_MS;
  const cached = readJson<FieldCacheFile>(path);
  if (cached && Date.now() - cached.fetchedAt < maxAgeMs)
    return buildFieldMap(cached);

  const fields = await jiraGet<JiraFieldMeta[]>(config, "/rest/api/3/field");
  const file = {
    fetchedAt: Date.now(),
    fields: fields.map(normalizeFieldMeta),
  };
  writeJson(path, file);
  return buildFieldMap(file);
}

export function getCustomFieldProfile(
  jiraHost: string,
  projectKey: string | null | undefined,
  issueTypeId: string | null | undefined,
): JiraCustomFieldProfile | null {
  if (!projectKey || !issueTypeId) return null;
  const cache = readProfileCache(jiraHost);
  return cache.profiles[profileKey(projectKey, issueTypeId)] ?? null;
}

export function updateCustomFieldProfile(
  jiraHost: string,
  profile: Omit<JiraCustomFieldProfile, "learnedAt"> & { learnedAt?: number },
): JiraCustomFieldProfile {
  const cache = readProfileCache(jiraHost);
  const next: JiraCustomFieldProfile = {
    ...profile,
    learnedAt: profile.learnedAt ?? Date.now(),
  };
  cache.profiles[profileKey(next.projectKey, next.issueTypeId)] = next;
  writeJson(profileCachePath(jiraHost), cache);
  return next;
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

function profileKey(projectKey: string, issueTypeId: string): string {
  return `${projectKey}:${issueTypeId}`;
}

function normalizeFieldMeta(field: JiraFieldMeta): JiraFieldMeta {
  return {
    ...field,
    id: field.id,
    name: field.name,
    custom: Boolean(field.custom || field.id.startsWith("customfield_")),
  };
}

function buildFieldMap(file: FieldCacheFile): JiraFieldMap {
  const byId = new Map<string, JiraFieldMeta>();
  const byNameLower = new Map<string, JiraFieldMeta[]>();
  for (const field of file.fields) {
    byId.set(field.id, field);
    const name = field.name.toLowerCase();
    byNameLower.set(name, [...(byNameLower.get(name) ?? []), field]);
  }
  return { fetchedAt: file.fetchedAt, byId, byNameLower };
}

function readProfileCache(jiraHost: string): ProfileCacheFile {
  return (
    readJson<ProfileCacheFile>(profileCachePath(jiraHost)) ?? { profiles: {} }
  );
}

function fieldCachePath(jiraHost: string): string {
  return jiraCachePath(jiraHost, "fields");
}

function profileCachePath(jiraHost: string): string {
  return jiraCachePath(jiraHost, "custom-field-profiles");
}
