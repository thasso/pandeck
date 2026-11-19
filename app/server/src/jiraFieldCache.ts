import type { JiraApiConfig } from "./jiraClient.ts";
import {
  buildFieldMap,
  fetchJiraFields,
  type JiraFieldMap,
  type JiraFieldMeta,
} from "./jiraFields.ts";
import {
  jiraCachePath,
  readJsonCacheFile as readJson,
  writeJsonCacheFile as writeJson,
} from "./jiraCacheFile.ts";
const FIELD_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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

  const fields = await fetchJiraFields(config);
  const file = { fetchedAt: Date.now(), fields };
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

function profileKey(projectKey: string, issueTypeId: string): string {
  return `${projectKey}:${issueTypeId}`;
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
