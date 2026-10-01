import type { JiraLinkedIssuesResponse } from "@assistant/shared";
import { authHeaders, serverHttpOrigin } from "./serverOrigin.ts";

/** Resolve the display summaries for Jira issue keys linked to a Task. */
export async function fetchJiraLinkedIssues(
  keys: string[],
  signal?: AbortSignal,
): Promise<JiraLinkedIssuesResponse> {
  if (keys.length === 0) return { issues: [] };
  const params = new URLSearchParams({ keys: keys.join(",") });
  const res = await fetch(`${serverHttpOrigin()}/api/jira/issues?${params}`, {
    headers: { ...authHeaders() },
    ...(signal !== undefined ? { signal } : {}),
  });
  const text = await res.text();
  const body = text
    ? (JSON.parse(text) as JiraLinkedIssuesResponse & { error?: string })
    : { issues: [] };
  if (!res.ok)
    throw new Error(body.error ?? `Request failed (HTTP ${res.status}).`);
  return body;
}
