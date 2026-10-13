import { jiraGet, type JiraApiConfig } from "./jiraClient.ts";

/** `GET /rest/api/3/user/bulk` ceiling. */
const USER_BULK_SIZE = 100;

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
