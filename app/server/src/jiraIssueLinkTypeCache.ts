import type { JiraApiConfig } from "./jiraClient.ts";
import { jiraGet } from "./jiraClient.ts";
import {
  jiraCachePath,
  readJsonCacheFile as readJson,
  writeJsonCacheFile as writeJson,
} from "./jiraCacheFile.ts";
const LINK_TYPE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Jira issue link types are global to the whole site (not per-project), so a single
 * per-host cache mirrors the field cache in jiraFieldCache.ts.
 */
export interface JiraIssueLinkType {
  id: string;
  name: string;
  /** Phrase describing the link from the outward issue, e.g. "blocks". */
  outward: string;
  /** Phrase describing the link from the inward issue, e.g. "is blocked by". */
  inward: string;
}

interface LinkTypeCacheFile {
  fetchedAt: number;
  linkTypes: JiraIssueLinkType[];
}

type JiraIssueLinkTypeResponse = {
  issueLinkTypes?: Array<{
    id?: string;
    name?: string;
    inward?: string;
    outward?: string;
  }>;
};

export async function getJiraIssueLinkTypes(
  config: JiraApiConfig,
  options: { maxAgeMs?: number } = {},
): Promise<JiraIssueLinkType[]> {
  const path = linkTypeCachePath(config.jiraHost);
  const maxAgeMs = options.maxAgeMs ?? LINK_TYPE_CACHE_MAX_AGE_MS;
  const cached = readJson<LinkTypeCacheFile>(path);
  if (cached && Date.now() - cached.fetchedAt < maxAgeMs)
    return cached.linkTypes;

  const response = await jiraGet<JiraIssueLinkTypeResponse>(
    config,
    "/rest/api/3/issueLinkType",
  );
  const linkTypes = (response.issueLinkTypes ?? [])
    .map(normalizeLinkType)
    .filter((type): type is JiraIssueLinkType => type !== null);
  writeJson(path, {
    fetchedAt: Date.now(),
    linkTypes,
  } satisfies LinkTypeCacheFile);
  return linkTypes;
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

function linkTypeCachePath(jiraHost: string): string {
  return jiraCachePath(jiraHost, "issue-link-types");
}
