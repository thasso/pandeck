import {
  normalizeGithubIssueRef,
  parseJiraIssueKey,
  type TicketSearchResponse,
  type TicketSearchResult,
} from "@assistant/shared";
import { jiraIssueUrl, jiraPost, type JiraApiConfig } from "./jiraClient.ts";
import { githubRequest, type GithubApiConfig } from "./githubClient.ts";
import { resolveGithubLinkedIssues } from "./githubLinkedIssues.ts";

/** How many results each source offers: a picker, not a search page. */
const LIMIT = 10;

export interface TicketSearchQuery {
  /** Free text, a Jira key, a GitHub `owner/repo#123`, or a pasted link. */
  q: string;
  /** Jira project keys to search in (the Task's Project's Jira projects). */
  jiraProjects: string[];
  /** `owner/repo` repositories to search in (the Task's Project's repo). */
  repos: string[];
}

/**
 * The Task inspector's ticket search: Jira and GitHub in parallel, each
 * skipped when it is not configured. An exact key, ref or link resolves to
 * that one ticket; anything else is a text search scoped to the Project's Jira
 * projects and repository when it has them, and to the user's own work when
 * it does not. An empty query lists recent tickets in the same scope.
 */
export async function searchTickets(
  query: TicketSearchQuery,
  jira: JiraApiConfig | null,
  github: GithubApiConfig | null,
): Promise<TicketSearchResponse> {
  const q = query.q.trim();
  const jiraKey = parseJiraIssueKey(q);
  const githubRef = normalizeGithubIssueRef(q);
  const errors: TicketSearchResponse["errors"] = [];
  const settle = async (
    source: "jira" | "github",
    run: () => Promise<TicketSearchResult[]>,
  ): Promise<TicketSearchResult[]> => {
    try {
      return await run();
    } catch (error) {
      errors.push({
        source,
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  };
  const [jiraResults, githubResults] = await Promise.all([
    // A GitHub ref is not a Jira search, and the reverse.
    jira && !githubRef
      ? settle("jira", () =>
          searchJira(jira, q, jiraKey, validJiraProjects(query.jiraProjects)),
        )
      : Promise.resolve([]),
    github && !jiraKey
      ? settle("github", () =>
          searchGithub(github, q, githubRef, validRepos(query.repos)),
        )
      : Promise.resolve([]),
  ]);
  return { results: [...jiraResults, ...githubResults], errors };
}

type JiraSearchPage = {
  issues?: Array<{
    key?: string;
    fields?: { summary?: unknown; status?: { name?: unknown } };
  }>;
};

async function searchJira(
  config: JiraApiConfig,
  q: string,
  key: string | null,
  projects: string[],
): Promise<TicketSearchResult[]> {
  const scope = projects.length ? `project in (${projects.join(", ")})` : "";
  // A query of nothing but operators is no text at all.
  const text = jqlString(q);
  const jql = key
    ? `key = "${key}"`
    : text
      ? `${scope ? `${scope} AND ` : ""}text ~ "${text}*" ORDER BY updated DESC`
      : `${scope || "(assignee = currentUser() OR reporter = currentUser())"} ORDER BY updated DESC`;
  const page = await jiraPost<JiraSearchPage>(
    config,
    "/rest/api/3/search/jql",
    {
      jql,
      maxResults: LIMIT,
      fields: ["summary", "status"],
    },
  );
  return (page.issues ?? []).flatMap((issue) =>
    issue.key
      ? [
          {
            source: "jira" as const,
            ref: issue.key,
            title: String(issue.fields?.summary ?? ""),
            status: String(issue.fields?.status?.name ?? ""),
            url: jiraIssueUrl(config.jiraHost, issue.key),
          },
        ]
      : [],
  );
}

type GithubSearchPage = {
  items?: Array<{
    number?: number;
    title?: string;
    state?: string;
    html_url?: string;
    repository_url?: string;
    pull_request?: { merged_at?: string | null };
  }>;
};

async function searchGithub(
  config: GithubApiConfig,
  q: string,
  ref: string | null,
  repos: string[],
): Promise<TicketSearchResult[]> {
  if (ref) {
    const issues = await resolveGithubLinkedIssues(config, [ref]);
    return issues.map((issue) => ({
      source: "github",
      ref: issue.ref,
      title: issue.title,
      status: issue.state,
      url: issue.url,
      isPullRequest: issue.isPullRequest,
    }));
  }
  const scope = repos.length
    ? repos.map((repo) => `repo:${repo}`).join(" ")
    : "involves:@me";
  const { data } = await githubRequest<GithubSearchPage>(
    config,
    "GET",
    "/search/issues",
    {
      query: {
        q: `${q ? `${q} ` : ""}${scope}${q ? "" : " is:open"}`,
        sort: "updated",
        order: "desc",
        per_page: LIMIT,
      },
    },
  );
  return (data.items ?? []).flatMap((item) => {
    // `repository_url` is `…/repos/owner/repo`; the ref is built from it.
    const repo = /\/repos\/([^/]+\/[^/]+)$/.exec(item.repository_url ?? "");
    if (!repo || !item.number) return [];
    return [
      {
        source: "github" as const,
        ref: `${repo[1]}#${item.number}`,
        title: item.title ?? "",
        status: item.pull_request?.merged_at
          ? "merged"
          : item.state === "closed"
            ? "closed"
            : "open",
        url:
          item.html_url ??
          `https://github.com/${repo[1]}/issues/${item.number}`,
        isPullRequest: item.pull_request !== undefined,
      },
    ];
  });
}

/** Text inside a JQL string literal: quotes and backslashes escaped, and the
 *  characters Lucene treats as operators dropped. */
function jqlString(value: string): string {
  return value
    .replace(/[+\-&|!(){}[\]^~*?:\\/"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function validJiraProjects(values: string[]): string[] {
  return values
    .map((value) => value.trim().toUpperCase())
    .filter((value) => /^[A-Z][A-Z0-9_]+$/.test(value))
    .slice(0, 10);
}

function validRepos(values: string[]): string[] {
  return values
    .map((value) => value.trim())
    .filter((value) => /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(value))
    .slice(0, 5);
}
