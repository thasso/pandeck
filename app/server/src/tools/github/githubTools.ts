/**
 * GitHub integration tools (classic PAT via `githubSettings.getGithubToolConfig`,
 * gate `github`). Read-only, split into intent-based catalog groups so a
 * repository lookup does not load code/collaboration/activity schemas:
 *
 *  - `github-repositories`: github_list_repositories, github_search_repositories
 *  - `github-code`: github_search_code, github_get_content
 *  - `github-collaboration`: github_list_notifications, github_search_issues, github_get_issue
 *  - `github-activity`: github_org_activity
 *
 * Payloads are compact JSON with null/empty keys dropped, bounded by
 * conservative limits. Mirrors the Jira family conventions (see `jiraTools.ts`).
 */
import { defineAgentTool } from "../../mcp/tool.ts";
import {
  getGithubDefaultOwner,
  getGithubToolConfig,
} from "../../githubSettings.ts";
import {
  githubPaginate,
  githubRefChecks,
  githubRequest,
  resolveAuthenticatedLogin,
  type GithubApiConfig,
  type GithubResponse,
} from "../../githubClient.ts";
import { githubProvider } from "../../gitHosting.ts";
import {
  localDateForInstant,
  localDayWindow,
} from "../../dayScan/dayWindow.ts";
import { userTimeZone } from "../../userProfile.ts";
import { stageSessionAttachment } from "../../sessionAttachments.ts";
import { createPullRequestCheckWatchTool } from "../pullRequestCheckWatch.ts";

type ListNotificationsParams = {
  all?: boolean;
  participating?: boolean;
  maxResults?: number;
};

type SearchIssuesParams = {
  q: string;
  sort?: "comments" | "reactions" | "created" | "updated";
  order?: "asc" | "desc";
  maxResults?: number;
};

type GetIssueParams = {
  repo: string;
  number: number;
  includeBody?: boolean;
  includeComments?: boolean;
  maxComments?: number;
  includeDiff?: boolean;
  maxDiffChars?: number;
};

type GetPullRequestParams = {
  repo: string;
  number: number;
  includeBody?: boolean;
  includeCommits?: boolean;
  includeFiles?: boolean;
  includePatch?: boolean;
  includeComments?: boolean;
  includeReviews?: boolean;
  includeReviewThreads?: boolean;
  maxCommits?: number;
  maxFiles?: number;
  maxComments?: number;
  maxReviews?: number;
  maxPatchChars?: number;
};

type OrgActivityParams = {
  org?: string;
  date?: string;
  maxEvents?: number;
};

type ListRepositoriesParams = {
  org?: string;
  affiliation?: string;
  visibility?: "all" | "public" | "private";
  sort?: "created" | "updated" | "pushed" | "full_name";
  direction?: "asc" | "desc";
  maxResults?: number;
};

type SearchRepositoriesParams = {
  q: string;
  sort?: "stars" | "forks" | "help-wanted-issues" | "updated";
  order?: "asc" | "desc";
  maxResults?: number;
};

type SearchCodeParams = {
  q: string;
  maxResults?: number;
};

type GetContentParams = {
  repo: string;
  path?: string;
  ref?: string;
  maxChars?: number;
  maxDownloadBytes?: number;
};

type GetRefChecksParams = {
  repo: string;
  ref: string;
};

type ListActionsRunsParams = {
  repo: string;
  branch?: string;
  headSha?: string;
  event?: string;
  status?: string;
  created?: string;
  maxResults?: number;
};

type GetActionsRunParams = {
  repo: string;
  runId: number;
  includeJobs?: boolean;
  includeAnnotations?: boolean;
  maxJobs?: number;
};

type GetActionsJobLogParams = {
  repo: string;
  jobId: number;
  maxChars?: number;
  fromEnd?: boolean;
};

/** `/user/repos` affiliations that include private org/member/collaborator repos. */
const DEFAULT_REPO_AFFILIATION = "owner,collaborator,organization_member";

/** Cap directory listings so a large tree stays compact. */
const MAX_DIR_ENTRIES = 300;

/** GitHub's Events API returns at most 300 events across 10 pages of 30. */
const GITHUB_EVENTS_HARD_CAP = 300;
/** Cap notable per-repo items so the digest stays compact. */
const MAX_ITEMS_PER_REPO = 20;

/** Shallow-drop null/undefined/empty-string/empty-array keys to keep payloads compact. */
function dropNulls<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out as Partial<T>;
}

function clamp(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Resolve `owner/repo` (or bare `repo` with the configured default owner) into its parts. */
export function resolveRepo(repo: string): { owner: string; repo: string } {
  const trimmed = repo.trim().replace(/^https?:\/\/github\.com\//i, "");
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length >= 2) return { owner: parts[0]!, repo: parts[1]! };
  const owner = getGithubDefaultOwner();
  if (parts.length === 1 && owner) return { owner, repo: parts[0]! };
  throw new Error(
    `Could not resolve repository "${repo}". Pass it as "owner/repo" or set a default owner in Settings → GitHub.`,
  );
}

function compactUser(user: unknown): string | null {
  if (!user || typeof user !== "object") return null;
  const login = (user as { login?: unknown }).login;
  return typeof login === "string" ? login : null;
}

/** Highest role the token holds on a repo (admin > maintain > push > triage > pull). */
function highestPermission(perms: unknown): string | null {
  if (!perms || typeof perms !== "object") return null;
  const p = perms as Record<string, unknown>;
  for (const role of ["admin", "maintain", "push", "triage", "pull"]) {
    if (p[role] === true) return role;
  }
  return null;
}

/** Compact, normalized repository metadata shared by list/search results. */
function compactRepo(r: Record<string, any>): Partial<Record<string, unknown>> {
  return dropNulls({
    fullName: r.full_name ?? null,
    owner: compactUser(r.owner),
    private: r.private === true ? true : null,
    visibility: r.visibility ?? null,
    fork: r.fork === true ? true : null,
    archived: r.archived === true ? true : null,
    description: r.description ?? null,
    url: r.html_url ?? null,
    defaultBranch: r.default_branch ?? null,
    language: r.language ?? null,
    topics: Array.isArray(r.topics) ? r.topics : [],
    permission: highestPermission(r.permissions),
    pushedAt: r.pushed_at ?? null,
    updatedAt: r.updated_at ?? null,
    sshUrl: r.ssh_url ?? null,
    cloneUrl: r.clone_url ?? null,
  });
}

export const githubListNotificationsTool =
  defineAgentTool<ListNotificationsParams>({
    name: "github_list_notifications",
    label: "GitHub: List Notifications",
    description:
      "List the authenticated user's GitHub notifications (review requests, mentions, assignments, subscribed threads). Read-only.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        all: {
          type: "boolean",
          description:
            "Include read notifications too. Defaults to false (unread only).",
        },
        participating: {
          type: "boolean",
          description:
            "Only notifications the user directly participates in (mentions/review-requests/assignments). Defaults to false.",
        },
        maxResults: {
          type: "number",
          description:
            "Maximum notifications to return. Defaults to 30, maximum 100.",
        },
      },
    },
    async execute(params, ctx) {
      const config = getGithubToolConfig();
      const maxResults = clamp(params.maxResults, 30, 1, 100);
      const { items } = await githubPaginate<Record<string, any>>(
        config,
        "/notifications",
        {
          query: {
            all: params.all === true,
            participating: params.participating === true,
          },
          maxItems: maxResults,
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        },
      );
      const notifications = items.map((n) =>
        dropNulls({
          id: n.id ?? null,
          unread: n.unread === true,
          reason: n.reason ?? null,
          updatedAt: n.updated_at ?? null,
          repo: n.repository?.full_name ?? null,
          repoUrl: n.repository?.html_url ?? null,
          subjectType: n.subject?.type ?? null,
          subjectTitle: n.subject?.title ?? null,
          subjectUrl:
            subjectWebUrl(n.subject?.url, n.repository?.html_url) ??
            n.subject?.url ??
            null,
        }),
      );
      const payload = {
        returned: notifications.length,
        maxResults,
        notifications,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        details: payload,
      };
    },
  });

export const githubSearchIssuesTool = defineAgentTool<SearchIssuesParams>({
  name: "github_search_issues",
  label: "GitHub: Search Issues",
  description:
    "Search GitHub issues and pull requests with GitHub's issue search syntax (is:issue/is:pr, is:open, org:/repo:, author:/assignee:/mentions:/review-requested:@me, label:, created:/updated:>=YYYY-MM-DD). Read-only. For 'what happened in an org today' this covers issues/PRs only — github_org_activity also has pushes and releases.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["q"],
    properties: {
      q: {
        type: "string",
        description:
          "GitHub issue/PR search query, e.g. 'org:acme is:pr is:open review-requested:@me'.",
      },
      sort: {
        type: "string",
        enum: ["comments", "reactions", "created", "updated"],
        description: "Sort field. Defaults to best match.",
      },
      order: {
        type: "string",
        enum: ["asc", "desc"],
        description: "Sort order. Defaults to desc.",
      },
      maxResults: {
        type: "number",
        description: "Maximum results to return. Defaults to 30, maximum 100.",
      },
    },
  },
  async execute(params, ctx) {
    const config = getGithubToolConfig();
    const q = params.q.trim();
    if (!q) throw new Error("q must be a non-empty GitHub search query.");
    const maxResults = clamp(params.maxResults, 30, 1, 100);
    const res = await githubRequest<{
      total_count?: number;
      incomplete_results?: boolean;
      items?: Record<string, any>[];
    }>(config, "GET", "/search/issues", {
      query: {
        q,
        sort: params.sort,
        order: params.order,
        per_page: maxResults,
      },
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    const items = (res.data.items ?? []).slice(0, maxResults).map((item) =>
      dropNulls({
        number: item.number ?? null,
        title: item.title ?? null,
        state: item.state ?? null,
        isPullRequest: Boolean(item.pull_request),
        draft: item.draft === true ? true : null,
        repo: repoFromIssueUrl(item.repository_url),
        url: item.html_url ?? null,
        author: compactUser(item.user),
        assignees: Array.isArray(item.assignees)
          ? item.assignees.map(compactUser).filter(Boolean)
          : [],
        labels: Array.isArray(item.labels)
          ? item.labels
              .map((l: any) => (typeof l === "string" ? l : l?.name))
              .filter(Boolean)
          : [],
        comments: typeof item.comments === "number" ? item.comments : null,
        createdAt: item.created_at ?? null,
        updatedAt: item.updated_at ?? null,
      }),
    );
    const payload = {
      q,
      totalCount: res.data.total_count ?? items.length,
      incompleteResults: res.data.incomplete_results === true,
      returned: items.length,
      maxResults,
      items,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      details: payload,
    };
  },
});

export const githubGetIssueTool = defineAgentTool<GetIssueParams>({
  name: "github_get_issue",
  label: "GitHub: Get Issue or PR",
  description:
    "Fetch one GitHub issue or pull request by repo and number. Read-only. Optionally include comments and (for PRs) the diff.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["repo", "number"],
    properties: {
      repo: {
        type: "string",
        description: "Repository as 'owner/repo', e.g. acme/dashboard.",
      },
      number: { type: "number", description: "Issue or pull-request number." },
      includeBody: {
        type: "boolean",
        description: "Include the issue/PR body Markdown. Defaults to true.",
      },
      includeComments: {
        type: "boolean",
        description: "Include recent comments. Defaults to false.",
      },
      maxComments: {
        type: "number",
        description:
          "Maximum comments when includeComments is true. Defaults to 10, maximum 50.",
      },
      includeDiff: {
        type: "boolean",
        description:
          "For pull requests, include the unified diff (bounded). Defaults to false.",
      },
      maxDiffChars: {
        type: "number",
        description:
          "Maximum diff characters when includeDiff is true. Defaults to 20000, maximum 100000.",
      },
    },
  },
  async execute(params, ctx) {
    const config = getGithubToolConfig();
    const { owner, repo } = resolveRepo(params.repo);
    const number = clamp(params.number, 0, 1, Number.MAX_SAFE_INTEGER);
    const includeBody = params.includeBody !== false;
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`;

    const issueRes = await githubRequest<Record<string, any>>(
      config,
      "GET",
      base,
      { ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}) },
    );
    const issue = issueRes.data;
    const isPr = Boolean(issue.pull_request);

    const comments =
      params.includeComments === true
        ? await fetchComments(
            config,
            owner,
            repo,
            number,
            clamp(params.maxComments, 10, 1, 50),
            ctx.signal,
          )
        : null;

    const diff =
      isPr && params.includeDiff === true
        ? await fetchPrDiff(
            config,
            owner,
            repo,
            number,
            clamp(params.maxDiffChars, 20000, 1000, 100000),
            ctx.signal,
          )
        : null;

    const payload = {
      repo: `${owner}/${repo}`,
      issue: dropNulls({
        number: issue.number ?? number,
        title: issue.title ?? null,
        state: issue.state ?? null,
        isPullRequest: isPr,
        draft: issue.draft === true ? true : null,
        url: issue.html_url ?? null,
        author: compactUser(issue.user),
        assignees: Array.isArray(issue.assignees)
          ? issue.assignees.map(compactUser).filter(Boolean)
          : [],
        labels: Array.isArray(issue.labels)
          ? issue.labels
              .map((l: any) => (typeof l === "string" ? l : l?.name))
              .filter(Boolean)
          : [],
        milestone: issue.milestone?.title ?? null,
        comments: typeof issue.comments === "number" ? issue.comments : null,
        createdAt: issue.created_at ?? null,
        updatedAt: issue.updated_at ?? null,
        closedAt: issue.closed_at ?? null,
        ...(includeBody
          ? { body: typeof issue.body === "string" ? issue.body : null }
          : {}),
        ...(comments ? { commentList: comments } : {}),
        ...(diff ? { diff: diff.text, diffTruncated: diff.truncated } : {}),
      }),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      details: payload,
    };
  },
});

async function fetchComments(
  config: GithubApiConfig,
  owner: string,
  repo: string,
  number: number,
  maxComments: number,
  signal?: AbortSignal,
) {
  const { items } = await githubPaginate<Record<string, any>>(
    config,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`,
    {
      maxItems: maxComments,
      ...(signal !== undefined ? { signal } : {}),
    },
  );
  return items.map((comment) =>
    dropNulls({
      author: compactUser(comment.user),
      createdAt: comment.created_at ?? null,
      body: typeof comment.body === "string" ? comment.body : null,
      url: comment.html_url ?? null,
    }),
  );
}

async function fetchPrDiff(
  config: GithubApiConfig,
  owner: string,
  repo: string,
  number: number,
  maxDiffChars: number,
  signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  const res = await githubRequest<string>(
    config,
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
    {
      accept: "application/vnd.github.diff",
      ...(signal !== undefined ? { signal } : {}),
    },
  );
  const full = typeof res.data === "string" ? res.data : "";
  return {
    text: full.slice(0, maxDiffChars),
    truncated: full.length > maxDiffChars,
  };
}

export const githubGetPullRequestTool = defineAgentTool<GetPullRequestParams>({
  name: "github_get_pull_request",
  label: "GitHub: Get Pull Request",
  description:
    "Fetch one pull request's rich read model by repo and number: core metadata plus opt-in commits, changed files/patches, timeline comments, submitted reviews, and inline review-comment threads. Use this rather than github_get_issue whenever you need PR-specific detail — head/base refs and SHAs, requested reviewers, changed files, reviews, or inline threads. Read-only.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["repo", "number"],
    properties: {
      repo: {
        type: "string",
        description: "Repository as 'owner/repo', e.g. acme/app.",
      },
      number: { type: "number", description: "Pull-request number." },
      includeBody: {
        type: "boolean",
        description: "Include the PR body Markdown. Defaults to true.",
      },
      includeCommits: {
        type: "boolean",
        description:
          "Include the PR's commits (sha + first message line + author). Defaults to false.",
      },
      includeFiles: {
        type: "boolean",
        description:
          "Include changed files with per-file additions/deletions/status. Defaults to false.",
      },
      includePatch: {
        type: "boolean",
        description:
          "Include each changed file's unified patch (bounded). Requires includeFiles. Defaults to false.",
      },
      includeComments: {
        type: "boolean",
        description: "Include timeline (issue) comments. Defaults to false.",
      },
      includeReviews: {
        type: "boolean",
        description:
          "Include submitted reviews (verdict + summary body). Defaults to false.",
      },
      includeReviewThreads: {
        type: "boolean",
        description:
          "Include inline review comments grouped into per-file reply threads. Defaults to false.",
      },
      maxCommits: {
        type: "number",
        description:
          "Maximum commits when includeCommits. Defaults to 30, maximum 100.",
      },
      maxFiles: {
        type: "number",
        description:
          "Maximum files when includeFiles. Defaults to 50, maximum 300.",
      },
      maxComments: {
        type: "number",
        description:
          "Maximum timeline comments when includeComments. Defaults to 20, maximum 100.",
      },
      maxReviews: {
        type: "number",
        description:
          "Maximum reviews/threads when includeReviews/includeReviewThreads. Defaults to 30, maximum 100.",
      },
      maxPatchChars: {
        type: "number",
        description:
          "Maximum characters per file patch when includePatch. Defaults to 6000, maximum 40000.",
      },
    },
  },
  async execute(params, ctx) {
    const config = getGithubToolConfig();
    const { owner, repo } = resolveRepo(params.repo);
    const number = clamp(params.number, 0, 1, Number.MAX_SAFE_INTEGER);
    const includeBody = params.includeBody !== false;
    const prBase = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`;

    const prRes = await githubRequest<Record<string, any>>(
      config,
      "GET",
      prBase,
      { ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}) },
    );
    const pr = prRes.data;

    const [commits, files, comments, reviews, reviewThreads] =
      await Promise.all([
        params.includeCommits === true
          ? fetchPrCommits(
              config,
              prBase,
              clamp(params.maxCommits, 30, 1, 100),
              ctx.signal,
            )
          : Promise.resolve(null),
        params.includeFiles === true
          ? fetchPrFiles(
              config,
              prBase,
              clamp(params.maxFiles, 50, 1, 300),
              params.includePatch === true,
              clamp(params.maxPatchChars, 6000, 500, 40_000),
              ctx.signal,
            )
          : Promise.resolve(null),
        params.includeComments === true
          ? fetchComments(
              config,
              owner,
              repo,
              number,
              clamp(params.maxComments, 20, 1, 100),
              ctx.signal,
            )
          : Promise.resolve(null),
        params.includeReviews === true
          ? fetchPrReviews(
              config,
              prBase,
              clamp(params.maxReviews, 30, 1, 100),
              ctx.signal,
            )
          : Promise.resolve(null),
        params.includeReviewThreads === true
          ? fetchPrReviewThreads(
              config,
              prBase,
              clamp(params.maxReviews, 30, 1, 100),
              ctx.signal,
            )
          : Promise.resolve(null),
      ]);

    const payload = {
      repo: `${owner}/${repo}`,
      pullRequest: dropNulls({
        number: pr.number ?? number,
        title: pr.title ?? null,
        state: pr.merged === true ? "merged" : (pr.state ?? null),
        draft: pr.draft === true ? true : null,
        merged: pr.merged === true ? true : null,
        mergeable: typeof pr.mergeable === "boolean" ? pr.mergeable : null,
        url: pr.html_url ?? null,
        author: compactUser(pr.user),
        head: dropNulls({
          ref: pr.head?.ref ?? null,
          sha: pr.head?.sha ?? null,
          repo: pr.head?.repo?.full_name ?? null,
        }),
        base: dropNulls({
          ref: pr.base?.ref ?? null,
          sha: pr.base?.sha ?? null,
          repo: pr.base?.repo?.full_name ?? null,
        }),
        requestedReviewers: Array.isArray(pr.requested_reviewers)
          ? pr.requested_reviewers.map(compactUser).filter(Boolean)
          : [],
        assignees: Array.isArray(pr.assignees)
          ? pr.assignees.map(compactUser).filter(Boolean)
          : [],
        labels: Array.isArray(pr.labels)
          ? pr.labels
              .map((l: any) => (typeof l === "string" ? l : l?.name))
              .filter(Boolean)
          : [],
        milestone: pr.milestone?.title ?? null,
        commitCount: typeof pr.commits === "number" ? pr.commits : null,
        changedFiles:
          typeof pr.changed_files === "number" ? pr.changed_files : null,
        additions: typeof pr.additions === "number" ? pr.additions : null,
        deletions: typeof pr.deletions === "number" ? pr.deletions : null,
        createdAt: pr.created_at ?? null,
        updatedAt: pr.updated_at ?? null,
        closedAt: pr.closed_at ?? null,
        mergedAt: pr.merged_at ?? null,
        ...(includeBody
          ? { body: typeof pr.body === "string" ? pr.body : null }
          : {}),
        ...(commits ? { commits } : {}),
        ...(files ? { files } : {}),
        ...(comments ? { commentList: comments } : {}),
        ...(reviews ? { reviews } : {}),
        ...(reviewThreads ? { reviewThreads } : {}),
      }),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      details: payload,
    };
  },
});

async function fetchPrCommits(
  config: GithubApiConfig,
  prBase: string,
  maxCommits: number,
  signal?: AbortSignal,
) {
  const { items } = await githubPaginate<Record<string, any>>(
    config,
    `${prBase}/commits`,
    { maxItems: maxCommits, ...(signal !== undefined ? { signal } : {}) },
  );
  return items.map((c) =>
    dropNulls({
      sha: typeof c.sha === "string" ? c.sha.slice(0, 12) : null,
      message:
        typeof c.commit?.message === "string"
          ? c.commit.message.split("\n", 1)[0]
          : null,
      author: c.author
        ? compactUser(c.author)
        : (c.commit?.author?.name ?? null),
    }),
  );
}

async function fetchPrFiles(
  config: GithubApiConfig,
  prBase: string,
  maxFiles: number,
  includePatch: boolean,
  maxPatchChars: number,
  signal?: AbortSignal,
) {
  const { items } = await githubPaginate<Record<string, any>>(
    config,
    `${prBase}/files`,
    { maxItems: maxFiles, ...(signal !== undefined ? { signal } : {}) },
  );
  return items.map((f) =>
    dropNulls({
      filename: f.filename ?? null,
      status: f.status ?? null,
      additions: typeof f.additions === "number" ? f.additions : null,
      deletions: typeof f.deletions === "number" ? f.deletions : null,
      ...(includePatch && typeof f.patch === "string"
        ? {
            patch: f.patch.slice(0, maxPatchChars),
            patchTruncated: f.patch.length > maxPatchChars ? true : null,
          }
        : {}),
    }),
  );
}

async function fetchPrReviews(
  config: GithubApiConfig,
  prBase: string,
  maxReviews: number,
  signal?: AbortSignal,
) {
  const { items } = await githubPaginate<Record<string, any>>(
    config,
    `${prBase}/reviews`,
    { maxItems: maxReviews, ...(signal !== undefined ? { signal } : {}) },
  );
  return items
    .filter((r) => r.state !== "PENDING")
    .map((r) =>
      dropNulls({
        author: compactUser(r.user),
        state: r.state ?? null,
        body: typeof r.body === "string" && r.body ? r.body : null,
        submittedAt: r.submitted_at ?? null,
        url: r.html_url ?? null,
      }),
    );
}

/** Inline PR review comments grouped into per-file reply threads (root + replies via in_reply_to_id). */
async function fetchPrReviewThreads(
  config: GithubApiConfig,
  prBase: string,
  maxThreads: number,
  signal?: AbortSignal,
) {
  const { items } = await githubPaginate<Record<string, any>>(
    config,
    `${prBase}/comments`,
    { maxItems: 100, ...(signal !== undefined ? { signal } : {}) },
  );
  const byId = new Map<number, Record<string, any>>();
  for (const c of items) if (typeof c.id === "number") byId.set(c.id, c);
  const threads = new Map<number, Array<Record<string, unknown>>>();
  const rootOf = (c: Record<string, any>): number => {
    let cur = c;
    const seen = new Set<number>();
    while (
      typeof cur.in_reply_to_id === "number" &&
      byId.has(cur.in_reply_to_id) &&
      !seen.has(cur.in_reply_to_id)
    ) {
      seen.add(cur.in_reply_to_id);
      cur = byId.get(cur.in_reply_to_id)!;
    }
    return typeof cur.id === "number" ? cur.id : (c.id as number);
  };
  const order: number[] = [];
  for (const c of items) {
    const root = rootOf(c);
    if (!threads.has(root)) {
      threads.set(root, []);
      order.push(root);
    }
    threads.get(root)!.push(
      dropNulls({
        author: compactUser(c.user),
        body: typeof c.body === "string" ? c.body : null,
        createdAt: c.created_at ?? null,
      }),
    );
  }
  return order.slice(0, maxThreads).map((root) => {
    const head = byId.get(root) ?? {};
    return dropNulls({
      path: head.path ?? null,
      line:
        typeof head.line === "number"
          ? head.line
          : typeof head.original_line === "number"
            ? head.original_line
            : null,
      diffHunk:
        typeof head.diff_hunk === "string"
          ? head.diff_hunk.slice(0, 500)
          : null,
      url: head.html_url ?? null,
      resolved: head.resolved === true ? true : null,
      comments: threads.get(root) ?? [],
    });
  });
}

type RepoAggregate = {
  repo: string;
  events: number;
  actors: Set<string>;
  pushes: number;
  commits: number;
  prsOpened: number;
  prsMerged: number;
  prsClosed: number;
  issuesOpened: number;
  issuesClosed: number;
  comments: number;
  reviews: number;
  branchesCreated: number;
  tagsCreated: number;
  releases: number;
  items: Array<Record<string, unknown>>;
  itemsTruncated: boolean;
};

export const githubOrgActivityTool = defineAgentTool<OrgActivityParams>({
  name: "github_org_activity",
  label: "GitHub: Org Activity",
  description:
    "Summarize what happened in a GitHub org on a given day from the org Events API (pushes, PRs, issues, releases, branches) — the tool for org-wide 'what happened' questions, where github_search_issues answers issue/PR-specific ones. Read-only. The Events API lags by seconds to hours, is capped at ~300 events / 90 days, and only returns events the token can see, so `exhausted: false` means the day was bigger than the scan budget and older events are missing.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      org: {
        type: "string",
        description:
          "Organization login, e.g. acme. Defaults to the configured default owner.",
      },
      date: {
        type: "string",
        description: "User-local day as YYYY-MM-DD. Defaults to today.",
      },
      maxEvents: {
        type: "number",
        description:
          "Maximum events to scan (newest first). Defaults to 300, maximum 300.",
      },
    },
  },
  async execute(params, ctx) {
    const config = getGithubToolConfig();
    const org = (params.org?.trim() || getGithubDefaultOwner()).trim();
    if (!org)
      throw new Error(
        "Provide an org, or set a default owner in Settings → GitHub.",
      );
    const timeZone = userTimeZone();
    const date = normalizeDate(params.date, timeZone);
    const maxEvents = clamp(
      params.maxEvents,
      GITHUB_EVENTS_HARD_CAP,
      1,
      GITHUB_EVENTS_HARD_CAP,
    );
    const window = localDayWindow(date, timeZone);
    const fromMs = window.startMs;
    const toMs = window.endMs;

    const scan = await scanOrgEvents(config, org, {
      fromMs,
      toMs,
      maxEvents,
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    const repos = new Map<string, RepoAggregate>();
    const byType: Record<string, number> = {};
    const actorTotals = new Map<string, number>();

    for (const event of scan.inWindow) {
      const type = event.type ?? "UnknownEvent";
      byType[type] = (byType[type] ?? 0) + 1;
      const actor = event.actor?.login ?? null;
      if (actor) actorTotals.set(actor, (actorTotals.get(actor) ?? 0) + 1);
      const repoName = event.repo?.name;
      if (!repoName) continue;
      aggregateEvent(getRepoAggregate(repos, repoName), event, actor);
    }

    const repoList = [...repos.values()]
      .sort((a, b) => b.events - a.events || a.repo.localeCompare(b.repo))
      .map((repo) =>
        dropNulls({
          repo: repo.repo,
          events: repo.events,
          actors: [...repo.actors].sort(),
          pushes: repo.pushes || null,
          commits: repo.commits || null,
          prsOpened: repo.prsOpened || null,
          prsMerged: repo.prsMerged || null,
          prsClosed: repo.prsClosed || null,
          issuesOpened: repo.issuesOpened || null,
          issuesClosed: repo.issuesClosed || null,
          comments: repo.comments || null,
          reviews: repo.reviews || null,
          branchesCreated: repo.branchesCreated || null,
          tagsCreated: repo.tagsCreated || null,
          releases: repo.releases || null,
          items: repo.items,
          itemsTruncated: repo.itemsTruncated ? true : null,
        }),
      );

    const notes = [
      "The Events API is delayed (seconds to hours) and capped at ~300 events / 90 days.",
      "Only events visible to the authenticated user are included; repos the user cannot access are omitted.",
    ];
    if (scan.source === "public-org") {
      notes.push(
        `Falling back to the org's PUBLIC events feed (${scan.fallbackReason ?? "user dashboard unavailable"}); private-repo activity is not included. This is usually sparse/stale.`,
      );
    }
    if (!scan.exhausted) {
      notes.push(
        `Scan budget (${maxEvents} events) was reached before the start of the day, so older ${date} activity is missing (a busy day can exceed the API's 300-event cap).`,
      );
    }

    const payload = {
      org,
      date,
      timeZone,
      source: scan.source,
      window: { from: window.startIso, to: window.endIso },
      eventsScanned: scan.scanned,
      eventsInWindow: scan.inWindow.length,
      exhausted: scan.exhausted,
      byType,
      topActors: [...actorTotals.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 15)
        .map(([login, events]) => ({ login, events })),
      repos: repoList,
      notes,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      details: payload,
    };
  },
});

type OrgEventSource = "user-dashboard" | "public-org";

/** Raw org-feed event; exported for the day-scan GitHub collector (shared fetch core). */
export type OrgEvent = {
  id?: string;
  type?: string;
  actor?: { login?: string };
  repo?: { name?: string };
  payload?: Record<string, any>;
  created_at?: string;
};

/**
 * Scan org events newest-first, keeping those inside [fromMs, toMs); stop once older.
 *
 * Prefers the authenticated user's org dashboard (`/users/{login}/events/orgs/{org}`),
 * which includes PRIVATE activity the user can see (pushes, PR reviews, etc.) and is
 * near-real-time. The public `/orgs/{org}/events` feed is only used as a fallback for
 * orgs the user is not a member of — it omits pushes and private repos and is stale.
 *
 * Exported as the shared fetch core for the day-scan GitHub collector.
 */
export async function scanOrgEvents(
  config: GithubApiConfig,
  org: string,
  opts: {
    fromMs: number;
    toMs: number;
    maxEvents: number;
    signal?: AbortSignal;
  },
): Promise<{
  inWindow: OrgEvent[];
  scanned: number;
  exhausted: boolean;
  source: OrgEventSource;
  fallbackReason?: string;
}> {
  const login = await resolveAuthenticatedLogin(config, opts.signal);
  if (login) {
    try {
      const scan = await pageEvents(
        config,
        `/users/${encodeURIComponent(login)}/events/orgs/${encodeURIComponent(org)}`,
        opts,
      );
      return { ...scan, source: "user-dashboard" };
    } catch (err) {
      // Not a member of the org (403/404) or dashboard unavailable — fall back to public.
      const scan = await pageEvents(
        config,
        `/orgs/${encodeURIComponent(org)}/events`,
        opts,
      );
      return { ...scan, source: "public-org", fallbackReason: shortError(err) };
    }
  }
  const scan = await pageEvents(
    config,
    `/orgs/${encodeURIComponent(org)}/events`,
    opts,
  );
  return {
    ...scan,
    source: "public-org",
    fallbackReason: "could not resolve the authenticated user",
  };
}

async function pageEvents(
  config: GithubApiConfig,
  path: string,
  opts: {
    fromMs: number;
    toMs: number;
    maxEvents: number;
    signal?: AbortSignal;
  },
): Promise<{ inWindow: OrgEvent[]; scanned: number; exhausted: boolean }> {
  const inWindow: OrgEvent[] = [];
  let nextUrl: string | null = path;
  let query: Record<string, string | number | boolean | undefined> | undefined =
    { per_page: 100 };
  let scanned = 0;
  let reachedOlder = false;
  while (nextUrl && scanned < opts.maxEvents && !reachedOlder) {
    const res: GithubResponse<OrgEvent[]> = await githubRequest<OrgEvent[]>(
      config,
      "GET",
      nextUrl,
      {
        ...(query !== undefined ? { query } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      },
    );
    query = undefined;
    const batch = Array.isArray(res.data) ? res.data : [];
    if (batch.length === 0) {
      nextUrl = null;
      break;
    }
    for (const event of batch) {
      scanned += 1;
      const created = event.created_at ? Date.parse(event.created_at) : NaN;
      if (!Number.isFinite(created)) continue;
      if (created < opts.fromMs) {
        reachedOlder = true;
        break;
      }
      if (created >= opts.toMs) continue; // newer than the requested day
      inWindow.push(event);
      if (scanned >= opts.maxEvents) break;
    }
    nextUrl = res.nextUrl;
  }
  // Full day coverage when we saw an event older than the window or ran out of events.
  return { inWindow, scanned, exhausted: reachedOlder || !nextUrl };
}

function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const status = msg.match(/HTTP (\d{3})/);
  return status ? `HTTP ${status[1]}` : msg.slice(0, 80);
}

function getRepoAggregate(
  repos: Map<string, RepoAggregate>,
  repo: string,
): RepoAggregate {
  let agg = repos.get(repo);
  if (!agg) {
    agg = {
      repo,
      events: 0,
      actors: new Set(),
      pushes: 0,
      commits: 0,
      prsOpened: 0,
      prsMerged: 0,
      prsClosed: 0,
      issuesOpened: 0,
      issuesClosed: 0,
      comments: 0,
      reviews: 0,
      branchesCreated: 0,
      tagsCreated: 0,
      releases: 0,
      items: [],
      itemsTruncated: false,
    };
    repos.set(repo, agg);
  }
  return agg;
}

function pushItem(agg: RepoAggregate, item: Record<string, unknown>): void {
  if (agg.items.length >= MAX_ITEMS_PER_REPO) {
    agg.itemsTruncated = true;
    return;
  }
  agg.items.push(dropNulls(item));
}

function aggregateEvent(
  agg: RepoAggregate,
  event: OrgEvent,
  actor: string | null,
): void {
  agg.events += 1;
  if (actor) agg.actors.add(actor);
  const p = event.payload ?? {};
  switch (event.type) {
    case "PushEvent": {
      agg.pushes += 1;
      const size =
        typeof p.size === "number"
          ? p.size
          : Array.isArray(p.commits)
            ? p.commits.length
            : 0;
      agg.commits += size;
      pushItem(agg, {
        kind: "push",
        ref: refName(p.ref),
        commits: size || null,
        actor,
      });
      break;
    }
    case "PullRequestEvent": {
      const merged = p.pull_request?.merged === true;
      const action =
        p.action === "closed" ? (merged ? "merged" : "closed") : p.action;
      if (action === "opened" || action === "reopened") agg.prsOpened += 1;
      else if (action === "merged") agg.prsMerged += 1;
      else if (action === "closed") agg.prsClosed += 1;
      pushItem(agg, {
        kind: "pr",
        action,
        number: p.pull_request?.number ?? p.number ?? null,
        title: p.pull_request?.title ?? null,
        url: p.pull_request?.html_url ?? null,
        actor,
      });
      break;
    }
    case "PullRequestReviewEvent":
      agg.reviews += 1;
      pushItem(agg, {
        kind: "review",
        state: p.review?.state ?? null,
        number: p.pull_request?.number ?? null,
        url: p.review?.html_url ?? p.pull_request?.html_url ?? null,
        actor,
      });
      break;
    case "PullRequestReviewCommentEvent":
    case "IssueCommentEvent":
      agg.comments += 1;
      break;
    case "IssuesEvent": {
      if (p.action === "opened" || p.action === "reopened")
        agg.issuesOpened += 1;
      else if (p.action === "closed") agg.issuesClosed += 1;
      pushItem(agg, {
        kind: "issue",
        action: p.action ?? null,
        number: p.issue?.number ?? null,
        title: p.issue?.title ?? null,
        url: p.issue?.html_url ?? null,
        actor,
      });
      break;
    }
    case "ReleaseEvent":
      agg.releases += 1;
      pushItem(agg, {
        kind: "release",
        action: p.action ?? null,
        tag: p.release?.tag_name ?? null,
        name: p.release?.name ?? null,
        url: p.release?.html_url ?? null,
        actor,
      });
      break;
    case "CreateEvent": {
      if (p.ref_type === "branch") {
        agg.branchesCreated += 1;
        pushItem(agg, { kind: "branch", ref: p.ref ?? null, actor });
      } else if (p.ref_type === "tag") {
        agg.tagsCreated += 1;
        pushItem(agg, { kind: "tag", ref: p.ref ?? null, actor });
      } else if (p.ref_type === "repository")
        pushItem(agg, { kind: "repo-created", actor });
      break;
    }
    default:
      break;
  }
}

function refName(ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  return ref.replace(/^refs\/(heads|tags)\//, "");
}

/** User-local YYYY-MM-DD; defaults to today in `timeZone`. */
function normalizeDate(date: string | undefined, timeZone: string): string {
  const trimmed = date?.trim();
  if (trimmed && /^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  if (trimmed) throw new Error(`date must be YYYY-MM-DD, got "${date}".`);
  return localDateForInstant(Date.now(), timeZone);
}

/** Derive `owner/repo` from a REST `repository_url` (…/repos/owner/repo). */
function repoFromIssueUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const match = url.match(/\/repos\/([^/]+)\/([^/]+)$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** Best-effort convert a notification subject API URL into a github.com web URL. */
function subjectWebUrl(apiUrl: unknown, repoHtmlUrl: unknown): string | null {
  if (typeof apiUrl !== "string" || typeof repoHtmlUrl !== "string")
    return null;
  const issueMatch = apiUrl.match(/\/(issues|pulls)\/(\d+)$/);
  if (issueMatch) {
    const kind = issueMatch[1] === "pulls" ? "pull" : "issues";
    return `${repoHtmlUrl}/${kind}/${issueMatch[2]}`;
  }
  return null;
}

export const githubListRepositoriesTool =
  defineAgentTool<ListRepositoriesParams>({
    name: "github_list_repositories",
    label: "GitHub: List Repositories",
    description:
      "Enumerate repositories the authenticated user can access, including PRIVATE org/member/collaborator repos. Read-only. Use to discover repos without already knowing an owner/name; `exhausted: false` means more repos exist beyond the ones returned.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        org: {
          type: "string",
          description:
            "Limit to one organization (GET /orgs/{org}/repos). Omit for the user's cross-org inventory (GET /user/repos).",
        },
        affiliation: {
          type: "string",
          description: `Comma-separated affiliations for the user inventory: owner, collaborator, organization_member. Defaults to "${DEFAULT_REPO_AFFILIATION}". Ignored when org is set.`,
        },
        visibility: {
          type: "string",
          enum: ["all", "public", "private"],
          description: "Filter by visibility. Defaults to all.",
        },
        sort: {
          type: "string",
          enum: ["created", "updated", "pushed", "full_name"],
          description: "Sort field. Defaults to the API default.",
        },
        direction: {
          type: "string",
          enum: ["asc", "desc"],
          description: "Sort direction.",
        },
        maxResults: {
          type: "number",
          description:
            "Maximum repositories to return (paginated). Defaults to 50, maximum 200.",
        },
      },
    },
    async execute(params, ctx) {
      const config = getGithubToolConfig();
      const maxResults = clamp(params.maxResults, 50, 1, 200);
      const org = params.org?.trim();
      const path = org
        ? `/orgs/${encodeURIComponent(org)}/repos`
        : "/user/repos";
      const query = org
        ? {
            type: params.visibility,
            sort: params.sort,
            direction: params.direction,
          }
        : {
            affiliation: params.affiliation?.trim() || DEFAULT_REPO_AFFILIATION,
            visibility: params.visibility ?? "all",
            sort: params.sort,
            direction: params.direction,
          };
      const { items, pagesFetched, exhausted } = await githubPaginate<
        Record<string, any>
      >(config, path, {
        query,
        maxItems: maxResults,
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      });
      const repositories = items.map(compactRepo);
      const payload = dropNulls({
        source: org ? `org:${org}` : "user",
        affiliation: org
          ? null
          : params.affiliation?.trim() || DEFAULT_REPO_AFFILIATION,
        visibility: params.visibility ?? null,
        returned: repositories.length,
        pagesFetched,
        exhausted,
        repositories,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        details: payload,
      };
    },
  });

export const githubSearchRepositoriesTool =
  defineAgentTool<SearchRepositoriesParams>({
    name: "github_search_repositories",
    label: "GitHub: Search Repositories",
    description:
      "Search repository metadata/README with GitHub's repository search syntax (org:/user:, in:name,description,readme, topic:, language:, archived:false, fork:true). Read-only. Only surfaces repositories the token can access — this is not a public-web search.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["q"],
      properties: {
        q: {
          type: "string",
          description:
            "GitHub repository search query, e.g. 'org:acme in:name,readme web-player'.",
        },
        sort: {
          type: "string",
          enum: ["stars", "forks", "help-wanted-issues", "updated"],
          description: "Sort field. Defaults to best match.",
        },
        order: {
          type: "string",
          enum: ["asc", "desc"],
          description: "Sort order. Defaults to desc.",
        },
        maxResults: {
          type: "number",
          description:
            "Maximum results to return. Defaults to 30, maximum 100.",
        },
      },
    },
    async execute(params, ctx) {
      const config = getGithubToolConfig();
      const q = params.q.trim();
      if (!q)
        throw new Error(
          "q must be a non-empty GitHub repository search query.",
        );
      const maxResults = clamp(params.maxResults, 30, 1, 100);
      const res = await githubRequest<{
        total_count?: number;
        incomplete_results?: boolean;
        items?: Record<string, any>[];
      }>(config, "GET", "/search/repositories", {
        query: {
          q,
          sort: params.sort,
          order: params.order,
          per_page: maxResults,
        },
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      });
      const items = (res.data.items ?? [])
        .slice(0, maxResults)
        .map(compactRepo);
      const payload = {
        q,
        totalCount: res.data.total_count ?? items.length,
        incompleteResults: res.data.incomplete_results === true,
        returned: items.length,
        maxResults,
        items,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        details: payload,
      };
    },
  });

export const githubSearchCodeTool = defineAgentTool<SearchCodeParams>({
  name: "github_search_code",
  label: "GitHub: Search Code",
  description:
    "Search code across repositories the token can access with GitHub's code search syntax (repo:/org:/user:, path:, filename:, extension:, language:, in:file,path). Read-only. Returns matching paths with bounded text-match fragments; read a full file with github_get_content. Only the default branch and files under 384 KB are indexed, the endpoint allows ~10 requests/minute, and results may be reported incomplete — scope the query to keep it useful.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["q"],
    properties: {
      q: {
        type: "string",
        description:
          "GitHub code search query, e.g. 'repo:acme/app path:src createPlayer'.",
      },
      maxResults: {
        type: "number",
        description: "Maximum matches to return. Defaults to 20, maximum 50.",
      },
    },
  },
  async execute(params, ctx) {
    const config = getGithubToolConfig();
    const q = params.q.trim();
    if (!q) throw new Error("q must be a non-empty GitHub code search query.");
    const maxResults = clamp(params.maxResults, 20, 1, 50);
    const res = await githubRequest<{
      total_count?: number;
      incomplete_results?: boolean;
      items?: Record<string, any>[];
    }>(config, "GET", "/search/code", {
      query: { q, per_page: maxResults },
      accept: "application/vnd.github.text-match+json",
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    const items = (res.data.items ?? []).slice(0, maxResults).map((item) =>
      dropNulls({
        repo: item.repository?.full_name ?? null,
        path: item.path ?? null,
        url: item.html_url ?? null,
        sha: item.sha ?? null,
        textMatches: Array.isArray(item.text_matches)
          ? item.text_matches.slice(0, 3).map((tm: any) =>
              dropNulls({
                fragment:
                  typeof tm.fragment === "string"
                    ? tm.fragment.slice(0, 400)
                    : null,
                matches: Array.isArray(tm.matches)
                  ? tm.matches
                      .map((m: any) => m?.text)
                      .filter(Boolean)
                      .slice(0, 5)
                  : [],
              }),
            )
          : [],
      }),
    );
    const payload = {
      q,
      totalCount: res.data.total_count ?? items.length,
      incompleteResults: res.data.incomplete_results === true,
      returned: items.length,
      maxResults,
      items,
      notes: [
        "GitHub REST code search indexes only the default branch and files under 384 KB, and is rate-limited to ~10 requests/minute.",
        "Only repositories the token can access are searched; results may be incomplete.",
      ],
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      details: payload,
    };
  },
});

export const githubGetContentTool = defineAgentTool<GetContentParams>({
  name: "github_get_content",
  label: "GitHub: Get Content",
  description:
    "Read a file or list a directory in a repository at an optional ref via the Contents API. Read-only. Text files return bounded UTF-8 content with `contentTruncated`; binary files return status 'saved_attachment' plus an id for read_attachment/kb_add_asset (bytes stay off-context); oversized files return status 'too_large'.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["repo"],
    properties: {
      repo: {
        type: "string",
        description: "Repository as 'owner/repo', e.g. acme/player-docs.",
      },
      path: {
        type: "string",
        description:
          "File or directory path within the repo. Defaults to the repository root.",
      },
      ref: {
        type: "string",
        description:
          "Branch, tag, or commit SHA. Defaults to the repository's default branch.",
      },
      maxChars: {
        type: "number",
        description:
          "Maximum text-file characters. Defaults to 20,000; maximum 200,000.",
      },
      maxDownloadBytes: {
        type: "number",
        description:
          "Maximum bytes fetched for a file. Defaults to 10 MiB; maximum 25 MiB.",
      },
    },
  },
  async execute(params, ctx) {
    const config = getGithubToolConfig();
    const { owner, repo } = resolveRepo(params.repo);
    const rawPath = (params.path ?? "").trim().replace(/^\/+/, "");
    const ref = params.ref?.trim() || undefined;
    const maxChars = clamp(params.maxChars, 20_000, 1, 200_000);
    const maxDownloadBytes = clamp(
      params.maxDownloadBytes,
      10 * 1024 * 1024,
      1,
      25 * 1024 * 1024,
    );
    const encodedPath = rawPath
      .split("/")
      .filter(Boolean)
      .map(encodeURIComponent)
      .join("/");
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`;
    const repoFull = `${owner}/${repo}`;

    const res = await githubRequest<any>(config, "GET", base, {
      query: { ref },
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    const data = res.data;

    // Directory: a bounded compact listing.
    if (Array.isArray(data)) {
      const entries = data
        .slice(0, MAX_DIR_ENTRIES)
        .map((entry: Record<string, any>) =>
          dropNulls({
            name: entry.name ?? null,
            path: entry.path ?? null,
            type: entry.type ?? null,
            size:
              entry.type === "file" && typeof entry.size === "number"
                ? entry.size
                : null,
            sha: entry.sha ?? null,
            url: entry.html_url ?? null,
          }),
        );
      const payload = dropNulls({
        repo: repoFull,
        path: rawPath,
        ref: ref ?? null,
        type: "dir",
        returned: entries.length,
        truncated: data.length > MAX_DIR_ENTRIES ? true : null,
        entries,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        details: payload,
      };
    }

    const meta = {
      repo: repoFull,
      path: typeof data.path === "string" ? data.path : rawPath,
      ref: ref ?? null,
      sha: data.sha ?? null,
      url: data.html_url ?? null,
    };

    // Symlink / submodule: metadata only.
    if (data.type && data.type !== "file") {
      const payload = dropNulls({
        ...meta,
        type: data.type,
        size: typeof data.size === "number" ? data.size : null,
        target: data.target ?? null,
        submoduleGitUrl: data.submodule_git_url ?? null,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        details: payload,
      };
    }

    // File.
    const size = typeof data.size === "number" ? data.size : 0;
    const fileMeta = { ...meta, type: "file", size };
    if (size > maxDownloadBytes) {
      const payload = dropNulls({
        ...fileMeta,
        status: "too_large",
        note: `File is ${size} bytes, above the ${maxDownloadBytes}-byte cap; raise maxDownloadBytes to fetch it.`,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        details: payload,
      };
    }

    let bytes: Buffer;
    if (typeof data.content === "string" && data.encoding === "base64") {
      bytes = Buffer.from(data.content, "base64");
    } else if (typeof data.download_url === "string" && data.download_url) {
      bytes = await downloadBounded(
        data.download_url,
        maxDownloadBytes,
        ctx.signal,
      );
    } else {
      const payload = dropNulls({
        ...fileMeta,
        status: "unavailable",
        note: "GitHub returned no inline content or download URL for this file.",
      });
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        details: payload,
      };
    }

    // Binary content stays off-context: stage it as a session attachment BY REFERENCE.
    if (looksBinary(bytes)) {
      const name = rawPath.split("/").pop() || repo;
      const staged = stageSessionAttachment(ctx.session.sessionId, {
        name,
        mimeType: "",
        bytes,
        source: "agent",
      });
      const payload = dropNulls({
        ...fileMeta,
        status: "saved_attachment",
        attachment: {
          id: staged.id,
          name: staged.name,
          mimeType: staged.mimeType,
          size: staged.size,
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        details: payload,
      };
    }

    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const payload = dropNulls({
      ...fileMeta,
      status: "content",
      encoding: "utf-8",
      contentTruncated: text.length > maxChars ? true : null,
      content: text.slice(0, maxChars),
    });
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      details: payload,
    };
  },
});

/** Stream a signed raw-content URL up to a byte cap (no auth header: the URL is pre-signed). */
async function downloadBounded(
  url: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const res = await fetch(url, { ...(signal !== undefined ? { signal } : {}) });
  if (!res.ok || !res.body)
    throw new Error(`GitHub raw download failed with HTTP ${res.status}.`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.length) {
      chunks.push(value);
      total += value.length;
    }
  }
  try {
    await reader.cancel();
  } catch {
    /* already drained */
  }
  return Buffer.concat(chunks).subarray(0, maxBytes);
}

/** Heuristic: a NUL byte in the leading bytes marks the payload as binary. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export const githubWatchPullRequestChecksTool = createPullRequestCheckWatchTool(
  {
    name: "github_watch_pull_request_checks",
    label: "GitHub: Watch Pull Request Checks",
    providerName: "GitHub",
    repoDescription: "Repository as 'owner/repo'.",
    resolve(repoInput, signal) {
      const config = getGithubToolConfig();
      const { owner, repo } = resolveRepo(repoInput);
      const canonicalRepo = `${owner}/${repo}`;
      return {
        repo: canonicalRepo,
        provider: githubProvider(
          { host: "github.com", owner, repo },
          config,
          signal,
        ),
        pullRequestUrl: (number) =>
          `https://github.com/${canonicalRepo}/pull/${number}`,
      };
    },
  },
);

export const githubGetRefChecksTool = defineAgentTool<GetRefChecksParams>({
  name: "github_get_ref_checks",
  label: "GitHub: Ref Checks",
  description:
    "Aggregate CI for a branch/tag/SHA — 'is CI green on this branch?'. Checks API check-runs plus legacy commit statuses, with an overall state: failure if any check failed, pending while any is still running, success only when all passed. Read-only.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["repo", "ref"],
    properties: {
      repo: { type: "string", description: "Repository as 'owner/repo'." },
      ref: { type: "string", description: "Branch name, tag, or commit SHA." },
    },
  },
  async execute(params, ctx) {
    const config = getGithubToolConfig();
    const { owner, repo } = resolveRepo(params.repo);
    const ref = params.ref.trim();
    if (!ref)
      throw new Error("ref must be a non-empty branch, tag, or commit SHA.");
    const summary = await githubRefChecks(config, owner, repo, ref, ctx.signal);
    const payload = {
      repo: `${owner}/${repo}`,
      ref,
      state: summary.state,
      total: summary.total,
      ...(summary.truncated ? { truncated: true } : {}),
      url: summary.url,
      checkRuns: summary.checkRuns.map((r) => dropNulls(r)),
      statuses: summary.statuses.map((s) => dropNulls(s)),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      details: payload,
    };
  },
});

export const githubListActionsRunsTool = defineAgentTool<ListActionsRunsParams>(
  {
    name: "github_list_actions_runs",
    label: "GitHub: List Actions Runs",
    description:
      "List GitHub Actions workflow runs for a repository, filterable by branch, head SHA, event, status, and date. Read-only. Follow a run up with github_get_actions_run for jobs/steps, then github_get_actions_job_log for a failed job.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["repo"],
      properties: {
        repo: { type: "string", description: "Repository as 'owner/repo'." },
        branch: { type: "string", description: "Filter to a head branch." },
        headSha: {
          type: "string",
          description: "Filter to a head commit SHA.",
        },
        event: {
          type: "string",
          description:
            "Filter by triggering event, e.g. push, pull_request, schedule.",
        },
        status: {
          type: "string",
          description:
            "Filter by status (queued/in_progress/completed) or conclusion (success/failure/cancelled/...).",
        },
        created: {
          type: "string",
          description:
            "Filter by created date range, e.g. '>=2026-07-01' or '2026-07-01..2026-07-10'.",
        },
        maxResults: {
          type: "number",
          description: "Maximum runs to return. Defaults to 20, maximum 100.",
        },
      },
    },
    async execute(params, ctx) {
      const config = getGithubToolConfig();
      const { owner, repo } = resolveRepo(params.repo);
      const maxResults = clamp(params.maxResults, 20, 1, 100);
      const res = await githubRequest<{
        total_count?: number;
        workflow_runs?: Record<string, any>[];
      }>(
        config,
        "GET",
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs`,
        {
          query: {
            branch: params.branch,
            head_sha: params.headSha,
            event: params.event,
            status: params.status,
            created: params.created,
            per_page: maxResults,
          },
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        },
      );
      const runs = (res.data.workflow_runs ?? [])
        .slice(0, maxResults)
        .map((run) =>
          dropNulls({
            id: run.id ?? null,
            name: run.name ?? run.display_title ?? null,
            headBranch: run.head_branch ?? null,
            headSha:
              typeof run.head_sha === "string"
                ? run.head_sha.slice(0, 12)
                : null,
            event: run.event ?? null,
            status: run.status ?? null,
            conclusion: run.conclusion ?? null,
            runNumber: run.run_number ?? null,
            actor: compactUser(run.actor),
            url: run.html_url ?? null,
            createdAt: run.created_at ?? null,
            updatedAt: run.updated_at ?? null,
          }),
        );
      const payload = {
        repo: `${owner}/${repo}`,
        totalCount: res.data.total_count ?? runs.length,
        returned: runs.length,
        maxResults,
        runs,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        details: payload,
      };
    },
  },
);

export const githubGetActionsRunTool = defineAgentTool<GetActionsRunParams>({
  name: "github_get_actions_run",
  label: "GitHub: Get Actions Run",
  description:
    "Fetch one GitHub Actions run with its jobs/steps and, on demand, failed-job annotations — the tool for 'which jobs/steps failed'. Read a failed job's full log with github_get_actions_job_log. Read-only. Bounded.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["repo", "runId"],
    properties: {
      repo: { type: "string", description: "Repository as 'owner/repo'." },
      runId: {
        type: "number",
        description: "Actions run id (from github_list_actions_runs).",
      },
      includeJobs: {
        type: "boolean",
        description: "Include jobs with their steps. Defaults to true.",
      },
      includeAnnotations: {
        type: "boolean",
        description:
          "Include bounded error annotations for failed jobs. Defaults to false.",
      },
      maxJobs: {
        type: "number",
        description: "Maximum jobs to return. Defaults to 30, maximum 100.",
      },
    },
  },
  async execute(params, ctx) {
    const config = getGithubToolConfig();
    const { owner, repo } = resolveRepo(params.repo);
    const runId = clamp(params.runId, 0, 1, Number.MAX_SAFE_INTEGER);
    const repoBase = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const runRes = await githubRequest<Record<string, any>>(
      config,
      "GET",
      `${repoBase}/actions/runs/${runId}`,
      { ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}) },
    );
    const run = runRes.data;

    let jobs: Array<Record<string, unknown>> | null = null;
    if (params.includeJobs !== false) {
      const maxJobs = clamp(params.maxJobs, 30, 1, 100);
      const { items } = await githubPaginateEnvelope<Record<string, any>>(
        config,
        `${repoBase}/actions/runs/${runId}/jobs`,
        "jobs",
        maxJobs,
        ctx.signal,
      );
      jobs = [];
      for (const job of items.slice(0, maxJobs)) {
        const failed =
          job.conclusion && FAILING_JOB_CONCLUSIONS.has(job.conclusion);
        const annotations =
          params.includeAnnotations === true && failed
            ? await fetchJobAnnotations(config, repoBase, job.id, ctx.signal)
            : null;
        jobs.push(
          dropNulls({
            id: job.id ?? null,
            name: job.name ?? null,
            status: job.status ?? null,
            conclusion: job.conclusion ?? null,
            startedAt: job.started_at ?? null,
            completedAt: job.completed_at ?? null,
            url: job.html_url ?? null,
            steps: Array.isArray(job.steps)
              ? job.steps.slice(0, 40).map((s: any) =>
                  dropNulls({
                    name: s.name ?? null,
                    status: s.status ?? null,
                    conclusion: s.conclusion ?? null,
                    number: s.number ?? null,
                  }),
                )
              : [],
            ...(annotations && annotations.length ? { annotations } : {}),
          }),
        );
      }
    }

    const payload = {
      repo: `${owner}/${repo}`,
      run: dropNulls({
        id: run.id ?? runId,
        name: run.name ?? run.display_title ?? null,
        headBranch: run.head_branch ?? null,
        headSha:
          typeof run.head_sha === "string" ? run.head_sha.slice(0, 12) : null,
        event: run.event ?? null,
        status: run.status ?? null,
        conclusion: run.conclusion ?? null,
        runNumber: run.run_number ?? null,
        runAttempt: run.run_attempt ?? null,
        url: run.html_url ?? null,
        createdAt: run.created_at ?? null,
        updatedAt: run.updated_at ?? null,
        ...(jobs ? { jobs } : {}),
      }),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      details: payload,
    };
  },
});

const githubGetActionsJobLogTool = defineAgentTool<GetActionsJobLogParams>({
  name: "github_get_actions_job_log",
  label: "GitHub: Actions Job Log",
  description:
    "Fetch one Actions job's log as bounded text (the failing tail by default, since the failure is usually at the end). Takes a JOB id from github_get_actions_run, not a run id. Read-only. Never returns a whole run ZIP.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["repo", "jobId"],
    properties: {
      repo: { type: "string", description: "Repository as 'owner/repo'." },
      jobId: {
        type: "number",
        description: "Actions job id (from github_get_actions_run jobs).",
      },
      maxChars: {
        type: "number",
        description:
          "Maximum log characters. Defaults to 20,000; maximum 100,000.",
      },
      fromEnd: {
        type: "boolean",
        description: "Return the tail (end) of the log. Defaults to true.",
      },
    },
  },
  async execute(params, ctx) {
    const config = getGithubToolConfig();
    const { owner, repo } = resolveRepo(params.repo);
    const jobId = clamp(params.jobId, 0, 1, Number.MAX_SAFE_INTEGER);
    const maxChars = clamp(params.maxChars, 20_000, 1, 100_000);
    const fromEnd = params.fromEnd !== false;
    const log = await fetchJobLog(config, owner, repo, jobId, ctx.signal);
    // When the log was capped at the byte ceiling we only hold its beginning, so a
    // tail slice is not the true end — surface that instead of implying otherwise.
    const tailUnavailable = fromEnd && log.cappedAtCeiling;
    const text =
      tailUnavailable || !fromEnd
        ? log.text.slice(0, maxChars)
        : log.text.slice(Math.max(0, log.text.length - maxChars));
    const payload = dropNulls({
      repo: `${owner}/${repo}`,
      jobId,
      returnedFrom: !fromEnd ? "start" : tailUnavailable ? "start" : "end",
      truncated:
        log.text.length > maxChars || log.cappedAtCeiling ? true : null,
      note: tailUnavailable
        ? "Log exceeds the fetch ceiling; returned the beginning instead of the tail. Read a specific failed step or raise maxChars."
        : null,
      log: text,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      details: payload,
    };
  },
});

/** Actions job conclusions that mean the job did not succeed. */
const FAILING_JOB_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
]);

/** Page a `{ total_count, <key>: [...] }` Actions envelope up to `maxItems`. */
async function githubPaginateEnvelope<T>(
  config: GithubApiConfig,
  path: string,
  key: string,
  maxItems: number,
  signal?: AbortSignal,
): Promise<{ items: T[] }> {
  const items: T[] = [];
  let nextUrl: string | null = path;
  let query: Record<string, string | number | boolean | undefined> | undefined =
    { per_page: Math.min(100, maxItems) };
  while (nextUrl && items.length < maxItems) {
    const res: GithubResponse<Record<string, any>> = await githubRequest<
      Record<string, any>
    >(config, "GET", nextUrl, {
      ...(query !== undefined ? { query } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
    query = undefined;
    const batch = Array.isArray(res.data[key]) ? (res.data[key] as T[]) : [];
    items.push(...batch);
    nextUrl = res.nextUrl;
    if (batch.length === 0) break;
  }
  return { items: items.slice(0, maxItems) };
}

/** Bounded error annotations for a failed Actions job (its id doubles as the check-run id). */
async function fetchJobAnnotations(
  config: GithubApiConfig,
  repoBase: string,
  jobId: unknown,
  signal?: AbortSignal,
): Promise<Array<Record<string, unknown>> | null> {
  if (typeof jobId !== "number") return null;
  try {
    const res = await githubRequest<Record<string, any>[]>(
      config,
      "GET",
      `${repoBase}/check-runs/${jobId}/annotations`,
      { query: { per_page: 20 }, ...(signal !== undefined ? { signal } : {}) },
    );
    return (Array.isArray(res.data) ? res.data : []).slice(0, 20).map((a) =>
      dropNulls({
        path: a.path ?? null,
        startLine: typeof a.start_line === "number" ? a.start_line : null,
        level: a.annotation_level ?? null,
        title: a.title ?? null,
        message: typeof a.message === "string" ? a.message.slice(0, 500) : null,
      }),
    );
  } catch {
    return null;
  }
}

/** Fetch one job's log, following GitHub's redirect to signed storage; bounded at a byte ceiling. */
async function fetchJobLog(
  config: GithubApiConfig,
  owner: string,
  repo: string,
  jobId: number,
  signal?: AbortSignal,
): Promise<{ text: string; cappedAtCeiling: boolean }> {
  const CEILING = 5 * 1024 * 1024;
  const url = `${config.apiBaseUrl.replace(/\/$/, "")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/jobs/${jobId}/logs`;
  // fetch auto-follows the 302 to blob storage and drops Authorization on the
  // cross-origin hop, so credentials never reach the storage host.
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.token}`,
      "User-Agent": "personal-assistant",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!res.ok || !res.body)
    throw new Error(
      `GitHub API returned HTTP ${res.status} fetching the job log.`,
    );
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cappedAtCeiling = false;
  while (total <= CEILING) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.length) {
      chunks.push(value);
      total += value.length;
    }
    if (total > CEILING) {
      cappedAtCeiling = true;
      break;
    }
  }
  try {
    await reader.cancel();
  } catch {
    /* already drained */
  }
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(
      Buffer.concat(chunks).subarray(0, CEILING),
    ),
    cappedAtCeiling,
  };
}

/** Repository enumeration and metadata/README search (catalog group `github-repositories`). */
export const githubRepositoryTools = [
  githubListRepositoriesTool,
  githubSearchRepositoriesTool,
];

/** Code search and bounded file/directory reads (catalog group `github-code`). */
export const githubCodeTools = [githubSearchCodeTool, githubGetContentTool];

/** Notifications, issue/PR search, and issue/PR reads (catalog group `github-collaboration`). */
export const githubCollaborationTools = [
  githubListNotificationsTool,
  githubSearchIssuesTool,
  githubGetIssueTool,
  githubGetPullRequestTool,
];

/** Org/day activity digest (catalog group `github-activity`). */
export const githubActivityTools = [githubOrgActivityTool];

/** PR check watching, ref checks, Actions runs/jobs, and bounded job logs. */
export const githubCiTools = [
  githubWatchPullRequestChecksTool,
  githubGetRefChecksTool,
  githubListActionsRunsTool,
  githubGetActionsRunTool,
  githubGetActionsJobLogTool,
];
