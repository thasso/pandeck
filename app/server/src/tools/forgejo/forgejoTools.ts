/**
 * Forgejo read tools (gate `forgejo`, Gitea-compatible API v1 against the
 * configured self-hosted instance via `forgejoSettings.getForgejoToolConfig`).
 * Read-only twins of `../github/githubTools.ts`, split into intent-based
 * catalog groups so a repository lookup does not load collaboration/content
 * schemas:
 *
 *  - `forgejo-repositories`: forgejo_list_repositories, forgejo_search_repositories
 *  - `forgejo-collaboration`: forgejo_list_notifications, forgejo_search_issues,
 *    forgejo_get_issue, forgejo_get_pull_request
 *  - `forgejo-content`: forgejo_get_content
 *
 * Payloads are compact JSON with null/empty keys dropped and conservative
 * bounded limits, the same conventions as the GitHub family.
 *
 * Where Forgejo's API differs, these tools follow FORGEJO rather than imitating
 * GitHub, because a schema that promises GitHub behaviour the instance cannot
 * deliver is worse than no tool:
 *
 *  - Forgejo has NO code-search API, so there is no `forgejo_search_code`
 *    (discovery is `forgejo_search_repositories` + `forgejo_get_content`);
 *  - issue search takes STRUCTURED parameters (`state`/`labels`/`owner`/…), not
 *    GitHub's `is:pr review-requested:@me` query syntax, and narrows to a single
 *    repository through a different endpoint;
 *  - `/pulls/{index}/files` carries no per-file patch, so a diff is the whole
 *    PR's `.diff`/`.patch`;
 *  - inline review comments hang off the review that owns them
 *    (`/pulls/{index}/reviews/{id}/comments`), not one flat per-PR list.
 */
import { defineAgentTool } from "../../mcp/tool.ts";
import {
  getForgejoBaseUrl,
  getForgejoDefaultOwner,
  getForgejoToolConfig,
} from "../../forgejoSettings.ts";
import {
  forgejoPaginate,
  forgejoRequest,
  normalizeForgejoBaseUrl,
  resolveForgejoLogin,
  type ForgejoApiConfig,
} from "../../forgejoClient.ts";
import { stageSessionAttachment } from "../../sessionAttachments.ts";

type ListRepositoriesParams = {
  org?: string;
  user?: string;
  maxResults?: number;
};

type SearchRepositoriesParams = {
  q: string;
  topic?: boolean;
  includeDesc?: boolean;
  private?: boolean;
  archived?: boolean;
  mode?: "fork" | "source" | "mirror" | "collaborative";
  sort?: "alpha" | "created" | "updated" | "size" | "id";
  order?: "asc" | "desc";
  maxResults?: number;
};

type ListNotificationsParams = {
  all?: boolean;
  statusTypes?: Array<"unread" | "read" | "pinned">;
  subjectTypes?: Array<"issue" | "pull" | "commit" | "repository">;
  since?: string;
  before?: string;
  maxResults?: number;
};

type SearchIssuesParams = {
  repo?: string;
  owner?: string;
  team?: string;
  state?: "open" | "closed" | "all";
  type?: "issues" | "pulls";
  q?: string;
  labels?: string[];
  milestones?: string[];
  since?: string;
  before?: string;
  assigned?: boolean;
  created?: boolean;
  mentioned?: boolean;
  reviewRequested?: boolean;
  reviewed?: boolean;
  sort?: string;
  maxResults?: number;
};

type GetIssueParams = {
  repo: string;
  number: number;
  includeBody?: boolean;
  includeComments?: boolean;
  maxComments?: number;
  includeTimeline?: boolean;
  maxTimelineEvents?: number;
};

type GetPullRequestParams = {
  repo: string;
  number: number;
  includeBody?: boolean;
  includeCommits?: boolean;
  includeFiles?: boolean;
  includeDiff?: boolean;
  diffFormat?: "diff" | "patch";
  includeComments?: boolean;
  includeReviews?: boolean;
  includeReviewComments?: boolean;
  maxCommits?: number;
  maxFiles?: number;
  maxComments?: number;
  maxReviews?: number;
  maxDiffChars?: number;
};

type GetContentParams = {
  repo: string;
  path?: string;
  ref?: string;
  maxChars?: number;
  maxDownloadBytes?: number;
};

/** Cap directory listings so a large tree stays compact. */
const MAX_DIR_ENTRIES = 300;

/** Reviews whose inline comments are fetched (one request each) per PR read. */
const MAX_REVIEW_COMMENT_FETCHES = 20;

/** Inline comments kept per review thread. */
const MAX_COMMENTS_PER_REVIEW = 50;

/** Shallow-drop null/undefined/empty-string/empty-array keys to keep payloads compact. */
export function dropNulls<T extends Record<string, unknown>>(
  obj: T,
): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out as Partial<T>;
}

export function clamp(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function parsedUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Resolve `owner/repo` for the configured instance, the twin of
 * `github/githubTools.ts` `resolveRepo`.
 *
 * The twin strips one fixed host; here the host is user config, so an absolute
 * URL is accepted only when it belongs to the CONFIGURED instance. Reading any
 * host's first two path segments would silently retarget a pasted
 * `https://github.com/owner/repo` at the same-named repo on this instance —
 * plausibly a different repository — so a foreign host is an error, not a hint.
 */
export function resolveForgejoRepo(repo: string): {
  owner: string;
  repo: string;
} {
  let trimmed = repo.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const url = parsedUrl(trimmed);
    const instanceHost = parsedUrl(getForgejoBaseUrl())?.host;
    if (!url || !instanceHost || url.host !== instanceHost)
      throw new Error(
        `"${repo}" is not a URL on the configured Forgejo instance${
          instanceHost ? ` (${instanceHost})` : ""
        }. Pass the repository as "owner/repo".`,
      );
    trimmed = url.pathname;
  }
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length >= 2) return { owner: parts[0]!, repo: parts[1]! };
  const owner = getForgejoDefaultOwner();
  if (parts.length === 1 && owner) return { owner, repo: parts[0]! };
  throw new Error(
    `Could not resolve repository "${repo}". Pass it as "owner/repo" or set a default owner in Settings → Forgejo.`,
  );
}

/** API path prefix for one repository. */
function repoBase(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/**
 * Endpoints that speak for the authenticated user have no anonymous answer;
 * saying so beats letting the instance reply with a bare HTTP 401. `what` opens
 * the sentence, so it is capitalized.
 */
function requireToken(config: ForgejoApiConfig, what: string): void {
  if (!config.token)
    throw new Error(
      `${what} needs a Forgejo access token; add one in Settings → Forgejo.`,
    );
}

/**
 * The authenticated login, for filters that mean "mine". Forgejo answers those
 * per-repository with a USERNAME (`assigned_by=…`) where the instance-wide
 * search takes a boolean, so an anonymous token cannot express them at all.
 */
async function requireLogin(
  config: ForgejoApiConfig,
  signal?: AbortSignal,
): Promise<string> {
  const login = await resolveForgejoLogin(config, signal);
  if (!login)
    throw new Error(
      "Filtering by the authenticated user needs a Forgejo access token; add one in Settings → Forgejo.",
    );
  return login;
}

export function compactUser(user: unknown): string | null {
  if (!user || typeof user !== "object") return null;
  const record = user as { login?: unknown; username?: unknown };
  if (typeof record.login === "string" && record.login) return record.login;
  return typeof record.username === "string" && record.username
    ? record.username
    : null;
}

function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label: any) => (typeof label === "string" ? label : label?.name))
    .filter(Boolean);
}

/** Highest role the token holds on a repo (Gitea grants admin > push > pull). */
function highestPermission(perms: unknown): string | null {
  if (!perms || typeof perms !== "object") return null;
  const record = perms as Record<string, unknown>;
  for (const role of ["admin", "push", "pull"]) {
    if (record[role] === true) return role;
  }
  return null;
}

/** Compact, normalized repository metadata shared by list/search results. */
function compactRepo(r: Record<string, any>): Partial<Record<string, unknown>> {
  return dropNulls({
    fullName: r.full_name ?? null,
    owner: compactUser(r.owner),
    private: r.private === true ? true : null,
    fork: r.fork === true ? true : null,
    mirror: r.mirror === true ? true : null,
    template: r.template === true ? true : null,
    archived: r.archived === true ? true : null,
    empty: r.empty === true ? true : null,
    description: r.description ?? null,
    url: r.html_url ?? null,
    defaultBranch: r.default_branch ?? null,
    language: r.language ?? null,
    topics: Array.isArray(r.topics) ? r.topics : [],
    permission: highestPermission(r.permissions),
    stars: typeof r.stars_count === "number" ? r.stars_count || null : null,
    openIssues:
      typeof r.open_issues_count === "number"
        ? r.open_issues_count || null
        : null,
    openPulls:
      typeof r.open_pr_counter === "number" ? r.open_pr_counter || null : null,
    updatedAt: r.updated_at ?? null,
    sshUrl: r.ssh_url ?? null,
    cloneUrl: r.clone_url ?? null,
  });
}

/** Compact issue/PR row shared by both issue-search endpoints. */
function compactIssueRow(
  item: Record<string, any>,
): Partial<Record<string, unknown>> {
  return dropNulls({
    number: item.number ?? null,
    title: item.title ?? null,
    state: item.state ?? null,
    isPullRequest: Boolean(item.pull_request),
    draft: item.pull_request?.draft === true ? true : null,
    merged: item.pull_request?.merged === true ? true : null,
    repo: item.repository?.full_name ?? null,
    url: item.html_url ?? null,
    author: compactUser(item.user),
    assignees: Array.isArray(item.assignees)
      ? item.assignees.map(compactUser).filter(Boolean)
      : [],
    labels: labelNames(item.labels),
    milestone: item.milestone?.title ?? null,
    comments: typeof item.comments === "number" ? item.comments : null,
    createdAt: item.created_at ?? null,
    updatedAt: item.updated_at ?? null,
    closedAt: item.closed_at ?? null,
  });
}

/**
 * Append repeated query parameters to a path. Gitea reads its array parameters
 * as REPEATED keys (`status-types=unread&status-types=pinned`), which the
 * client's flat query map cannot express, so they ride on the path instead.
 */
function withRepeatedQuery(
  path: string,
  params: Record<string, string[] | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, values] of Object.entries(params))
    for (const value of values ?? []) search.append(key, value);
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Best-effort web URL for a notification subject (API URLs are not clickable). */
function subjectWebUrl(
  subject: Record<string, any> | undefined,
  repoHtmlUrl: unknown,
): string | null {
  if (typeof subject?.html_url === "string" && subject.html_url)
    return subject.html_url;
  if (typeof subject?.url !== "string" || typeof repoHtmlUrl !== "string")
    return null;
  const match = subject.url.match(/\/(issues|pulls)\/(\d+)$/);
  return match ? `${repoHtmlUrl}/${match[1]}/${match[2]}` : null;
}

export const forgejoListRepositoriesTool =
  defineAgentTool<ListRepositoriesParams>({
    name: "forgejo_list_repositories",
    label: "Forgejo: List Repositories",
    description:
      "Enumerate repositories on the configured Forgejo instance: everything the authenticated token can see, one organization's repositories, or one user account's. Read-only. Use to discover repos without already knowing an owner/name; `exhausted: false` means more repositories exist beyond the ones returned.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        org: {
          type: "string",
          description:
            "Limit to one ORGANIZATION (GET /orgs/{org}/repos). A personal account is not an organization here and fails — pass it as user instead.",
        },
        user: {
          type: "string",
          description:
            "Limit to one user account's repositories (GET /users/{username}/repos). Mutually exclusive with org.",
        },
        maxResults: {
          type: "number",
          description:
            "Maximum repositories to return (paginated). Defaults to 50, maximum 200.",
        },
      },
    },
    async execute(params, ctx) {
      const config = getForgejoToolConfig();
      const maxResults = clamp(params.maxResults, 50, 1, 200);
      const org = params.org?.trim();
      const user = params.user?.trim();
      if (org && user)
        throw new Error(
          "Pass either org or user, not both: they are different Forgejo endpoints.",
        );
      // The token's own inventory is the only arm that cannot work anonymously.
      if (!org && !user) requireToken(config, "Listing your own repositories");
      const path = org
        ? `/orgs/${encodeURIComponent(org)}/repos`
        : user
          ? `/users/${encodeURIComponent(user)}/repos`
          : "/user/repos";
      const { items, exhausted, totalCount } = await forgejoPaginate<
        Record<string, any>
      >(config, path, {
        maxItems: maxResults,
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      });
      const repositories = items.map(compactRepo);
      const payload = dropNulls({
        source: org ? `org:${org}` : user ? `user:${user}` : "token",
        totalCount,
        returned: repositories.length,
        maxResults,
        exhausted,
        repositories,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        details: payload,
      };
    },
  });

export const forgejoSearchRepositoriesTool =
  defineAgentTool<SearchRepositoriesParams>({
    name: "forgejo_search_repositories",
    label: "Forgejo: Search Repositories",
    description:
      "Search repositories on the configured Forgejo instance by keyword (GET /repos/search). Read-only. The keyword matches repository names, optionally descriptions or topics — Forgejo has no code-search API, so this cannot find file contents; read files with forgejo_get_content instead. Only repositories the token can see are returned.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["q"],
      properties: {
        q: {
          type: "string",
          description:
            "Keyword matched against repository names (plain text, not a query language).",
        },
        topic: {
          type: "boolean",
          description:
            "Match the keyword against repository TOPICS instead of names. Defaults to false.",
        },
        includeDesc: {
          type: "boolean",
          description:
            "Also match the keyword against repository descriptions. Defaults to false.",
        },
        private: {
          type: "boolean",
          description:
            "Include private repositories the token can see. Defaults to the instance default.",
        },
        archived: {
          type: "boolean",
          description:
            "Filter by archived state; omit to include both archived and active repositories.",
        },
        mode: {
          type: "string",
          enum: ["fork", "source", "mirror", "collaborative"],
          description: "Filter by repository kind.",
        },
        sort: {
          type: "string",
          enum: ["alpha", "created", "updated", "size", "id"],
          description: "Sort field. Defaults to the instance default.",
        },
        order: {
          type: "string",
          enum: ["asc", "desc"],
          description: "Sort order.",
        },
        maxResults: {
          type: "number",
          description:
            "Maximum results to return (paginated). Defaults to 30, maximum 200.",
        },
      },
    },
    async execute(params, ctx) {
      const config = getForgejoToolConfig();
      const q = params.q.trim();
      if (!q) throw new Error("q must be a non-empty search keyword.");
      const maxResults = clamp(params.maxResults, 30, 1, 200);
      const { items, exhausted, totalCount } = await paginateRepoSearch(
        config,
        {
          q,
          topic: params.topic,
          includeDesc: params.includeDesc,
          private: params.private,
          archived: params.archived,
          mode: params.mode,
          sort: params.sort,
          order: params.order,
        },
        maxResults,
        ctx.signal,
      );
      const payload = dropNulls({
        q,
        totalCount,
        returned: items.length,
        maxResults,
        exhausted,
        items: items.map(compactRepo),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        details: payload,
      };
    },
  });

/**
 * Page `/repos/search` the way `forgejoPaginate` pages a list endpoint. It
 * cannot use that helper: repo search answers with a `{ok,data}` envelope
 * rather than a bare array, so the batch has to be unwrapped per page.
 */
async function paginateRepoSearch(
  config: ForgejoApiConfig,
  query: Record<string, string | number | boolean | undefined>,
  maxItems: number,
  signal?: AbortSignal,
): Promise<{
  items: Record<string, any>[];
  exhausted: boolean;
  totalCount: number | null;
}> {
  const limit = Math.min(50, maxItems);
  const items: Record<string, any>[] = [];
  let page = 1;
  let exhausted = false;
  let totalCount: number | null = null;
  while (items.length < maxItems) {
    const res = await forgejoRequest<{
      ok?: boolean;
      data?: Record<string, any>[];
    }>(config, "GET", "/repos/search", {
      query: { ...query, page, limit },
      ...(signal !== undefined ? { signal } : {}),
    });
    if (page === 1) totalCount = res.totalCount;
    const batch = Array.isArray(res.data.data) ? res.data.data : [];
    items.push(...batch);
    if (batch.length < limit) {
      exhausted = true;
      break;
    }
    page += 1;
  }
  return { items: items.slice(0, maxItems), exhausted, totalCount };
}

export const forgejoListNotificationsTool =
  defineAgentTool<ListNotificationsParams>({
    name: "forgejo_list_notifications",
    label: "Forgejo: List Notifications",
    description:
      "List the authenticated user's Forgejo notification threads (review requests, mentions, assignments, subscribed issues/PRs). Read-only. Requires a configured access token.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        all: {
          type: "boolean",
          description:
            "Include read and pinned notifications too. Defaults to false (unread only).",
        },
        statusTypes: {
          type: "array",
          items: { type: "string", enum: ["unread", "read", "pinned"] },
          description:
            "Explicit status filter, e.g. ['unread','pinned']. Overrides the unread-only default; ignored when all is true.",
        },
        subjectTypes: {
          type: "array",
          items: {
            type: "string",
            enum: ["issue", "pull", "commit", "repository"],
          },
          description: "Limit to these subject kinds.",
        },
        since: {
          type: "string",
          description: "Only threads updated at or after this RFC 3339 time.",
        },
        before: {
          type: "string",
          description: "Only threads updated before this RFC 3339 time.",
        },
        maxResults: {
          type: "number",
          description:
            "Maximum notifications to return. Defaults to 30, maximum 100.",
        },
      },
    },
    async execute(params, ctx) {
      const config = getForgejoToolConfig();
      requireToken(config, "Reading your notifications");
      const maxResults = clamp(params.maxResults, 30, 1, 100);
      const path = withRepeatedQuery("/notifications", {
        "status-types": params.statusTypes,
        "subject-type": params.subjectTypes,
      });
      const { items, exhausted, totalCount } = await forgejoPaginate<
        Record<string, any>
      >(config, path, {
        query: {
          all: params.all === true ? true : undefined,
          since: params.since,
          before: params.before,
        },
        maxItems: maxResults,
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      });
      const notifications = items.map((n) =>
        dropNulls({
          id: n.id ?? null,
          unread: n.unread === true,
          pinned: n.pinned === true ? true : null,
          updatedAt: n.updated_at ?? null,
          repo: n.repository?.full_name ?? null,
          repoUrl: n.repository?.html_url ?? null,
          subjectType: n.subject?.type ?? null,
          subjectTitle: n.subject?.title ?? null,
          subjectState: n.subject?.state ?? null,
          subjectUrl:
            subjectWebUrl(n.subject, n.repository?.html_url) ??
            n.subject?.url ??
            null,
        }),
      );
      const payload = dropNulls({
        totalCount,
        returned: notifications.length,
        maxResults,
        exhausted,
        notifications,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        details: payload,
      };
    },
  });

export const forgejoSearchIssuesTool = defineAgentTool<SearchIssuesParams>({
  name: "forgejo_search_issues",
  label: "Forgejo: Search Issues",
  description:
    "Search issues and pull requests on the configured Forgejo instance with STRUCTURED filters. Read-only. Forgejo has no GitHub-style query syntax: state, kind, labels, milestones, owner and 'involves me' filters are separate parameters, and the free-text keyword only matches title/body. Set repo to search inside one repository (a different, better-targeted endpoint), or owner to scope the instance-wide search to one user/organization.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      repo: {
        type: "string",
        description:
          "Search inside this repository only, as 'owner/repo'. Uses the per-repository endpoint, which rejects owner, team, reviewRequested and reviewed rather than ignoring them.",
      },
      owner: {
        type: "string",
        description:
          "Scope the instance-wide search to repositories owned by this user or organization.",
      },
      team: {
        type: "string",
        description:
          "Scope the instance-wide search to this team's repositories (requires owner to be the organization).",
      },
      state: {
        type: "string",
        enum: ["open", "closed", "all"],
        description: "Issue state. Defaults to open.",
      },
      type: {
        type: "string",
        enum: ["issues", "pulls"],
        description:
          "Limit to plain issues or to pull requests. Omit for both.",
      },
      q: {
        type: "string",
        description: "Free-text keyword matched against title and body.",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Label names that must be present.",
      },
      milestones: {
        type: "array",
        items: { type: "string" },
        description: "Milestone names to filter by.",
      },
      since: {
        type: "string",
        description: "Only items updated at or after this RFC 3339 time.",
      },
      before: {
        type: "string",
        description: "Only items updated before this RFC 3339 time.",
      },
      assigned: {
        type: "boolean",
        description: "Only items assigned to the authenticated user.",
      },
      created: {
        type: "boolean",
        description: "Only items created by the authenticated user.",
      },
      mentioned: {
        type: "boolean",
        description: "Only items mentioning the authenticated user.",
      },
      reviewRequested: {
        type: "boolean",
        description:
          "Only pull requests awaiting the authenticated user's review. Instance-wide search only — leave repo unset.",
      },
      reviewed: {
        type: "boolean",
        description:
          "Only pull requests the authenticated user has already reviewed. Instance-wide search only — leave repo unset.",
      },
      sort: {
        type: "string",
        description:
          "Sort key, e.g. oldest, recentupdate, leastupdate, mostcomment, nearduedate. Older instances ignore it and answer newest-first.",
      },
      maxResults: {
        type: "number",
        description: "Maximum results to return. Defaults to 30, maximum 100.",
      },
    },
  },
  async execute(params, ctx) {
    const config = getForgejoToolConfig();
    const maxResults = clamp(params.maxResults, 30, 1, 100);
    const scoped = params.repo?.trim();
    const shared = {
      state: params.state ?? "open",
      type: params.type,
      q: params.q?.trim() || undefined,
      labels: params.labels?.length ? params.labels.join(",") : undefined,
      milestones: params.milestones?.length
        ? params.milestones.join(",")
        : undefined,
      since: params.since,
      before: params.before,
      sort: params.sort,
    };

    let path: string;
    let query: Record<string, string | number | boolean | undefined>;
    let scope: string;
    if (scoped) {
      // Parameters the per-repository endpoint cannot express are an ERROR, not
      // a silently dropped filter that would answer a question nobody asked.
      const unsupported = [
        params.owner?.trim() ? "owner" : null,
        params.team?.trim() ? "team" : null,
        params.reviewRequested === true ? "reviewRequested" : null,
        params.reviewed === true ? "reviewed" : null,
      ].filter(Boolean);
      if (unsupported.length)
        throw new Error(
          `Forgejo's per-repository issue list does not support ${unsupported.join(", ")}. Drop repo to use the instance-wide search (which takes owner/team and the review filters).`,
        );
      const { owner, repo } = resolveForgejoRepo(scoped);
      // The per-repo endpoint names a USER for each involvement filter, where
      // the instance-wide one takes a boolean about the caller.
      const login =
        params.assigned === true ||
        params.created === true ||
        params.mentioned === true
          ? await requireLogin(config, ctx.signal)
          : undefined;
      path = `${repoBase(owner, repo)}/issues`;
      query = {
        ...shared,
        created_by: params.created === true ? login : undefined,
        assigned_by: params.assigned === true ? login : undefined,
        mentioned_by: params.mentioned === true ? login : undefined,
      };
      scope = `${owner}/${repo}`;
    } else {
      path = "/repos/issues/search";
      query = {
        ...shared,
        owner: params.owner?.trim() || undefined,
        team: params.team?.trim() || undefined,
        assigned: params.assigned === true ? true : undefined,
        created: params.created === true ? true : undefined,
        mentioned: params.mentioned === true ? true : undefined,
        review_requested: params.reviewRequested === true ? true : undefined,
        reviewed: params.reviewed === true ? true : undefined,
      };
      scope = params.owner?.trim()
        ? `owner:${params.owner.trim()}`
        : "instance";
    }

    const { items, exhausted, totalCount } = await forgejoPaginate<
      Record<string, any>
    >(config, path, {
      query,
      maxItems: maxResults,
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    const rows = items.map(compactIssueRow);
    const payload = dropNulls({
      scope,
      state: shared.state,
      totalCount,
      returned: rows.length,
      maxResults,
      exhausted,
      items: rows,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      details: payload,
    };
  },
});

export const forgejoGetIssueTool = defineAgentTool<GetIssueParams>({
  name: "forgejo_get_issue",
  label: "Forgejo: Get Issue or PR",
  description:
    "Fetch one Forgejo issue (or a pull request's issue view) by repo and number, with opt-in comments and timeline events. Read-only. For PR-specific detail — head/base refs and SHAs, changed files, the diff, reviews and inline review comments — use forgejo_get_pull_request instead.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["repo", "number"],
    properties: {
      repo: {
        type: "string",
        description: "Repository as 'owner/repo'.",
      },
      number: {
        type: "number",
        description: "Issue or pull-request index/number.",
      },
      includeBody: {
        type: "boolean",
        description: "Include the issue body Markdown. Defaults to true.",
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
      includeTimeline: {
        type: "boolean",
        description:
          "Include timeline events (label/milestone/assignee/state changes, review requests). Defaults to false.",
      },
      maxTimelineEvents: {
        type: "number",
        description:
          "Maximum timeline events when includeTimeline is true. Defaults to 30, maximum 100.",
      },
    },
  },
  async execute(params, ctx) {
    const config = getForgejoToolConfig();
    const { owner, repo } = resolveForgejoRepo(params.repo);
    const number = clamp(params.number, 0, 1, Number.MAX_SAFE_INTEGER);
    const base = `${repoBase(owner, repo)}/issues/${number}`;

    const issueRes = await forgejoRequest<Record<string, any>>(
      config,
      "GET",
      base,
      { ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}) },
    );
    const issue = issueRes.data;

    const [comments, timeline] = await Promise.all([
      params.includeComments === true
        ? fetchIssueComments(
            config,
            base,
            clamp(params.maxComments, 10, 1, 50),
            ctx.signal,
          )
        : Promise.resolve(null),
      params.includeTimeline === true
        ? fetchIssueTimeline(
            config,
            base,
            clamp(params.maxTimelineEvents, 30, 1, 100),
            ctx.signal,
          )
        : Promise.resolve(null),
    ]);

    const payload = {
      repo: `${owner}/${repo}`,
      issue: dropNulls({
        ...compactIssueRow({ ...issue, repository: undefined }),
        number: issue.number ?? number,
        ...(params.includeBody !== false
          ? { body: typeof issue.body === "string" ? issue.body : null }
          : {}),
        ...(comments ? { commentList: comments } : {}),
        ...(timeline ? { timeline } : {}),
      }),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      details: payload,
    };
  },
});

async function fetchIssueComments(
  config: ForgejoApiConfig,
  issueBase: string,
  maxComments: number,
  signal?: AbortSignal,
) {
  const { items } = await forgejoPaginate<Record<string, any>>(
    config,
    `${issueBase}/comments`,
    { maxItems: maxComments, ...(signal !== undefined ? { signal } : {}) },
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

async function fetchIssueTimeline(
  config: ForgejoApiConfig,
  issueBase: string,
  maxEvents: number,
  signal?: AbortSignal,
) {
  const { items } = await forgejoPaginate<Record<string, any>>(
    config,
    `${issueBase}/timeline`,
    { maxItems: maxEvents, ...(signal !== undefined ? { signal } : {}) },
  );
  return items.map((event) =>
    dropNulls({
      type: event.type ?? null,
      actor: compactUser(event.user),
      createdAt: event.created_at ?? null,
      body: typeof event.body === "string" ? event.body.slice(0, 500) : null,
      label: event.label?.name ?? null,
      milestone: event.milestone?.title ?? null,
      assignee: compactUser(event.assignee),
      removedAssignee: event.removed_assignee === true ? true : null,
      resolvedBy: compactUser(event.resolve_doer),
      oldTitle: event.old_title ?? null,
      newTitle: event.new_title ?? null,
      oldRef: event.old_ref ?? null,
      newRef: event.new_ref ?? null,
      refIssue: event.ref_issue?.number ?? null,
      refCommit:
        typeof event.ref_commit_sha === "string"
          ? event.ref_commit_sha.slice(0, 12)
          : null,
    }),
  );
}

export const forgejoGetPullRequestTool = defineAgentTool<GetPullRequestParams>({
  name: "forgejo_get_pull_request",
  label: "Forgejo: Get Pull Request",
  description:
    "Fetch one Forgejo pull request's rich read model by repo and number: core metadata plus opt-in commits, changed files, the unified diff/patch, timeline comments, submitted reviews and their inline comments. Read-only. Use this rather than forgejo_get_issue whenever you need PR-specific detail. Forgejo returns no per-file patch, so file-level changes come as counts and the actual hunks come from includeDiff.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["repo", "number"],
    properties: {
      repo: { type: "string", description: "Repository as 'owner/repo'." },
      number: { type: "number", description: "Pull-request index/number." },
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
      includeDiff: {
        type: "boolean",
        description:
          "Include the whole PR's unified diff (bounded). Defaults to false.",
      },
      diffFormat: {
        type: "string",
        enum: ["diff", "patch"],
        description:
          "Diff flavour when includeDiff is true: 'diff' (default) or 'patch' (per-commit, with commit messages).",
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
      includeReviewComments: {
        type: "boolean",
        description:
          "Include each review's inline comments (path, diff hunk, and `line` on the post-change side or `originalLine` on the pre-change side). Implies includeReviews and costs one request per review that has comments. Defaults to false.",
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
          "Maximum reviews when includeReviews. Defaults to 30, maximum 100.",
      },
      maxDiffChars: {
        type: "number",
        description:
          "Maximum diff characters when includeDiff. Defaults to 20000, maximum 100000.",
      },
    },
  },
  async execute(params, ctx) {
    const config = getForgejoToolConfig();
    const { owner, repo } = resolveForgejoRepo(params.repo);
    const number = clamp(params.number, 0, 1, Number.MAX_SAFE_INTEGER);
    const base = repoBase(owner, repo);
    const prBase = `${base}/pulls/${number}`;
    const withReviews =
      params.includeReviews === true || params.includeReviewComments === true;

    const prRes = await forgejoRequest<Record<string, any>>(
      config,
      "GET",
      prBase,
      { ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}) },
    );
    const pr = prRes.data;

    const [commits, files, diff, comments, reviews] = await Promise.all([
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
            ctx.signal,
          )
        : Promise.resolve(null),
      params.includeDiff === true
        ? fetchPrDiff(
            config,
            base,
            number,
            params.diffFormat === "patch" ? "patch" : "diff",
            clamp(params.maxDiffChars, 20_000, 1000, 100_000),
            ctx.signal,
          )
        : Promise.resolve(null),
      params.includeComments === true
        ? fetchIssueComments(
            config,
            `${base}/issues/${number}`,
            clamp(params.maxComments, 20, 1, 100),
            ctx.signal,
          )
        : Promise.resolve(null),
      withReviews
        ? fetchPrReviews(
            config,
            prBase,
            clamp(params.maxReviews, 30, 1, 100),
            params.includeReviewComments === true,
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
        labels: labelNames(pr.labels),
        milestone: pr.milestone?.title ?? null,
        changedFiles:
          typeof pr.changed_files === "number" ? pr.changed_files : null,
        additions: typeof pr.additions === "number" ? pr.additions : null,
        deletions: typeof pr.deletions === "number" ? pr.deletions : null,
        comments: typeof pr.comments === "number" ? pr.comments : null,
        reviewComments:
          typeof pr.review_comments === "number" ? pr.review_comments : null,
        createdAt: pr.created_at ?? null,
        updatedAt: pr.updated_at ?? null,
        closedAt: pr.closed_at ?? null,
        mergedAt: pr.merged_at ?? null,
        ...(params.includeBody !== false
          ? { body: typeof pr.body === "string" ? pr.body : null }
          : {}),
        ...(commits ? { commits } : {}),
        ...(files ? { files } : {}),
        ...(comments ? { commentList: comments } : {}),
        ...(reviews ? { reviews } : {}),
        ...(diff
          ? {
              diffFormat: diff.format,
              diff: diff.text,
              diffTruncated: diff.truncated ? true : null,
            }
          : {}),
      }),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      details: payload,
    };
  },
});

async function fetchPrCommits(
  config: ForgejoApiConfig,
  prBase: string,
  maxCommits: number,
  signal?: AbortSignal,
) {
  const { items } = await forgejoPaginate<Record<string, any>>(
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
      author: compactUser(c.author) ?? c.commit?.author?.name ?? null,
      createdAt: c.commit?.author?.date ?? c.created ?? null,
    }),
  );
}

async function fetchPrFiles(
  config: ForgejoApiConfig,
  prBase: string,
  maxFiles: number,
  signal?: AbortSignal,
) {
  const { items } = await forgejoPaginate<Record<string, any>>(
    config,
    `${prBase}/files`,
    { maxItems: maxFiles, ...(signal !== undefined ? { signal } : {}) },
  );
  return items.map((f) =>
    dropNulls({
      filename: f.filename ?? null,
      previousFilename: f.previous_filename ?? null,
      status: f.status ?? null,
      additions: typeof f.additions === "number" ? f.additions : null,
      deletions: typeof f.deletions === "number" ? f.deletions : null,
    }),
  );
}

/** The PR's whole diff: Forgejo serves it as raw text from `/pulls/{index}.diff`. */
async function fetchPrDiff(
  config: ForgejoApiConfig,
  base: string,
  number: number,
  format: "diff" | "patch",
  maxDiffChars: number,
  signal?: AbortSignal,
): Promise<{ format: string; text: string; truncated: boolean }> {
  const res = await forgejoRequest<string>(
    config,
    "GET",
    `${base}/pulls/${number}.${format}`,
    { raw: true, ...(signal !== undefined ? { signal } : {}) },
  );
  const full = typeof res.data === "string" ? res.data : "";
  return {
    format,
    text: full.slice(0, maxDiffChars),
    truncated: full.length > maxDiffChars,
  };
}

/**
 * Submitted reviews, each optionally carrying its own inline comments. Forgejo
 * has no flat per-PR review-comment list: a comment belongs to the review that
 * created it, so the thread structure IS the review grouping.
 */
async function fetchPrReviews(
  config: ForgejoApiConfig,
  prBase: string,
  maxReviews: number,
  includeComments: boolean,
  signal?: AbortSignal,
) {
  const { items } = await forgejoPaginate<Record<string, any>>(
    config,
    `${prBase}/reviews`,
    { maxItems: maxReviews, ...(signal !== undefined ? { signal } : {}) },
  );
  const submitted = items.filter((r) => r.state !== "PENDING");
  let fetches = 0;
  const reviews: Array<Record<string, unknown>> = [];
  for (const review of submitted) {
    const commentCount =
      typeof review.comments_count === "number" ? review.comments_count : 0;
    const wantsComments =
      includeComments && commentCount > 0 && typeof review.id === "number";
    const overBudget = wantsComments && fetches >= MAX_REVIEW_COMMENT_FETCHES;
    let comments: Array<Record<string, unknown>> | null = null;
    if (wantsComments && !overBudget) {
      fetches += 1;
      comments = await fetchReviewComments(config, prBase, review.id, signal);
    }
    reviews.push(
      dropNulls({
        id: review.id ?? null,
        author: compactUser(review.user),
        state: review.state ?? null,
        body:
          typeof review.body === "string" && review.body ? review.body : null,
        commentCount: commentCount || null,
        stale: review.stale === true ? true : null,
        official: review.official === true ? true : null,
        submittedAt: review.submitted_at ?? null,
        url: review.html_url ?? null,
        ...(comments ? { comments } : {}),
        commentsOmitted: overBudget ? true : null,
      }),
    );
  }
  return reviews;
}

async function fetchReviewComments(
  config: ForgejoApiConfig,
  prBase: string,
  reviewId: number,
  signal?: AbortSignal,
) {
  const res = await forgejoRequest<Record<string, any>[]>(
    config,
    "GET",
    `${prBase}/reviews/${reviewId}/comments`,
    { ...(signal !== undefined ? { signal } : {}) },
  );
  const items = Array.isArray(res.data) ? res.data : [];
  return items.slice(0, MAX_COMMENTS_PER_REVIEW).map((c) =>
    dropNulls({
      author: compactUser(c.user),
      path: c.path ?? null,
      // The two sides stay APART: `position` is the post-change line and is 0
      // for a comment on a removed line, whose line lives in
      // `original_position`. Collapsing them would report a deleted line as if
      // it were current, and a quote of "path:line" would point at other text.
      line:
        typeof c.position === "number" && c.position > 0 ? c.position : null,
      originalLine:
        typeof c.original_position === "number" && c.original_position > 0
          ? c.original_position
          : null,
      diffHunk:
        typeof c.diff_hunk === "string" ? c.diff_hunk.slice(0, 500) : null,
      body: typeof c.body === "string" ? c.body : null,
      resolvedBy: compactUser(c.resolver),
      createdAt: c.created_at ?? null,
      url: c.html_url ?? null,
    }),
  );
}

export const forgejoGetContentTool = defineAgentTool<GetContentParams>({
  name: "forgejo_get_content",
  label: "Forgejo: Get Content",
  description:
    "Read a file or list a directory in a Forgejo repository at an optional ref. Read-only. Text files return bounded UTF-8 content with `contentTruncated`; binary files return status 'saved_attachment' plus an id for read_attachment/kb_add_asset (bytes stay off-context); oversized files return status 'too_large'. Forgejo has no code search, so browse from the repository root or a known path.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["repo"],
    properties: {
      repo: { type: "string", description: "Repository as 'owner/repo'." },
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
    const config = getForgejoToolConfig();
    const { owner, repo } = resolveForgejoRepo(params.repo);
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
    const repoFull = `${owner}/${repo}`;

    const res = await forgejoRequest<any>(
      config,
      "GET",
      `${repoBase(owner, repo)}/contents/${encodedPath}`,
      {
        query: { ref },
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      },
    );
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
        config,
        ctx.signal,
      );
    } else {
      const payload = dropNulls({
        ...fileMeta,
        status: "unavailable",
        note: "Forgejo returned no inline content or download URL for this file.",
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

/**
 * Stream a raw-content URL up to a byte cap. Unlike GitHub's pre-signed
 * download URLs, Forgejo's `download_url` points back at the instance and needs
 * the token for a private repository — sent only when the URL really is on the
 * configured instance, so a redirect elsewhere never leaks it.
 */
async function downloadBounded(
  url: string,
  maxBytes: number,
  config: ForgejoApiConfig,
  signal?: AbortSignal,
): Promise<Buffer> {
  const instance = normalizeForgejoBaseUrl(config.baseUrl);
  const onInstance = Boolean(instance) && url.startsWith(`${instance}/`);
  const res = await fetch(url, {
    ...(signal !== undefined ? { signal } : {}),
    headers:
      onInstance && config.token
        ? { Authorization: `token ${config.token}` }
        : {},
  });
  if (!res.ok || !res.body)
    throw new Error(`Forgejo raw download failed with HTTP ${res.status}.`);
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

/** Repository enumeration and keyword search (catalog group `forgejo-repositories`). */
export const forgejoRepositoryTools = [
  forgejoListRepositoriesTool,
  forgejoSearchRepositoriesTool,
];

/** Notifications, issue/PR search, and issue/PR reads (catalog group `forgejo-collaboration`). */
export const forgejoCollaborationTools = [
  forgejoListNotificationsTool,
  forgejoSearchIssuesTool,
  forgejoGetIssueTool,
  forgejoGetPullRequestTool,
];

/** Bounded file/directory reads (catalog group `forgejo-content`). */
export const forgejoContentTools = [forgejoGetContentTool];
