import type { GithubLinkedIssuesResponse } from "@assistant/shared";
import { authHeaders, serverHttpOrigin } from "./serverOrigin.ts";

/** Resolve live title/state for the GitHub issue refs linked to a Task. */
export async function fetchGithubLinkedIssues(
  refs: string[],
  signal?: AbortSignal,
): Promise<GithubLinkedIssuesResponse> {
  if (refs.length === 0) return { issues: [] };
  const params = new URLSearchParams({ refs: refs.join(",") });
  const res = await fetch(`${serverHttpOrigin()}/api/github/issues?${params}`, {
    headers: { ...authHeaders() },
    ...(signal !== undefined ? { signal } : {}),
  });
  const text = await res.text();
  const body = text
    ? (JSON.parse(text) as GithubLinkedIssuesResponse & { error?: string })
    : { issues: [] };
  if (!res.ok)
    throw new Error(body.error ?? `Request failed (HTTP ${res.status}).`);
  return body;
}
