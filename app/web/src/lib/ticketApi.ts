import type { TicketSearchResponse } from "@assistant/shared";
import { authHeaders, serverHttpOrigin } from "./serverOrigin.ts";

/**
 * Search Jira and GitHub for a Task's ticket (`/api/tickets/search`), scoped
 * to the Task's Project's Jira projects and repository when it has them.
 */
export async function searchTickets(
  query: { q: string; jiraProjects: string[]; repos: string[] },
  signal?: AbortSignal,
): Promise<TicketSearchResponse> {
  const params = new URLSearchParams({
    q: query.q,
    jiraProjects: query.jiraProjects.join(","),
    repos: query.repos.join(","),
  });
  const res = await fetch(
    `${serverHttpOrigin()}/api/tickets/search?${params}`,
    {
      headers: { ...authHeaders() },
      ...(signal !== undefined ? { signal } : {}),
    },
  );
  const text = await res.text();
  const body = text
    ? (JSON.parse(text) as TicketSearchResponse & { error?: string })
    : { results: [], errors: [] };
  if (!res.ok)
    throw new Error(body.error ?? `Request failed (HTTP ${res.status}).`);
  return body;
}
