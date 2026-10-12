import type { TaskTicket } from "@assistant/shared";

const JIRA_ISSUE_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

function gitSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface TaskNamingSource {
  id: string;
  ticket?: TaskTicket | undefined;
}

export type TaskNamingReference =
  | { kind: "jira"; display: string; slug: string }
  | { kind: "task"; display: string; slug: string };

/**
 * Stable human/Git naming reference for work created from a Task. A Jira ticket
 * names it; the internal Task id is the fallback, also for a GitHub ticket.
 */
export function taskNamingReference(
  task: TaskNamingSource,
): TaskNamingReference {
  const jiraKey =
    task.ticket?.source === "jira"
      ? task.ticket.ref.trim().toUpperCase()
      : undefined;
  if (jiraKey && JIRA_ISSUE_KEY_RE.test(jiraKey)) {
    return { kind: "jira", display: jiraKey, slug: jiraKey.toLowerCase() };
  }
  const id = task.id.trim();
  const slug = gitSlug(`t${id}`) || "task";
  return { kind: "task", display: `Task-${id}`, slug };
}
