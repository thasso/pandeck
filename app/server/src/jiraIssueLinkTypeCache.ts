import type { JiraApiConfig } from "./jiraClient.ts";
import {
  fetchJiraIssueLinkTypes,
  type JiraIssueLinkType,
} from "./jiraFields.ts";
import {
  jiraCachePath,
  readJsonCacheFile as readJson,
  writeJsonCacheFile as writeJson,
} from "./jiraCacheFile.ts";
const LINK_TYPE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** A per-host cache of the site-global link types, like the field cache. */
interface LinkTypeCacheFile {
  fetchedAt: number;
  linkTypes: JiraIssueLinkType[];
}

export async function getJiraIssueLinkTypes(
  config: JiraApiConfig,
  options: { maxAgeMs?: number } = {},
): Promise<JiraIssueLinkType[]> {
  const path = linkTypeCachePath(config.jiraHost);
  const maxAgeMs = options.maxAgeMs ?? LINK_TYPE_CACHE_MAX_AGE_MS;
  const cached = readJson<LinkTypeCacheFile>(path);
  if (cached && Date.now() - cached.fetchedAt < maxAgeMs)
    return cached.linkTypes;

  const linkTypes = await fetchJiraIssueLinkTypes(config);
  writeJson(path, {
    fetchedAt: Date.now(),
    linkTypes,
  } satisfies LinkTypeCacheFile);
  return linkTypes;
}

function linkTypeCachePath(jiraHost: string): string {
  return jiraCachePath(jiraHost, "issue-link-types");
}
