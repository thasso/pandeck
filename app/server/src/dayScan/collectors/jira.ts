import {
  getJiraCredsIfAvailable,
  isJiraConfigured,
} from "../../jiraSettings.ts";
import { jiraGet, jiraPost, type JiraApiConfig } from "../../jiraClient.ts";
import { getSettings } from "../../settings.ts";
import type { DayWindow } from "../dayWindow.ts";
import type {
  CollectorOutput,
  DayCollectContext,
  DaySourceCollector,
  DaySourceFact,
} from "../types.ts";

const PAGE_SIZE = 100;
const ACTIVITY_CAP = 250;
const CHANGELOG_PAGE_SIZE = 100;
const CHANGELOG_MAX_PAGES_PER_ISSUE = 10;

/** Changelog fields worth narrating as transitions (plan § Jira semantics). */
const TRANSITION_FIELDS = new Set([
  "status",
  "assignee",
  "priority",
  "duedate",
  "Sprint",
  "Fix Version",
]);

type SearchIssue = {
  id?: string;
  key?: string;
  fields?: {
    summary?: string;
    updated?: string;
    duedate?: string | null;
    status?: { name?: string; statusCategory?: { name?: string } };
    issuetype?: { name?: string };
    project?: { key?: string; name?: string };
    assignee?: {
      accountId?: string;
      displayName?: string;
      emailAddress?: string;
    } | null;
    reporter?: { accountId?: string; emailAddress?: string } | null;
    priority?: { name?: string } | null;
  };
};

type SearchResponse = {
  issues?: SearchIssue[];
  nextPageToken?: string;
  isLast?: boolean;
};

type ChangelogPage = {
  values?: Array<{
    id?: string;
    created?: string;
    author?: { accountId?: string; displayName?: string };
    items?: Array<{
      field?: string;
      fieldtype?: string;
      fromString?: string | null;
      toString?: string | null;
    }>;
  }>;
  isLast?: boolean;
  nextPage?: string;
  startAt?: number;
  total?: number;
  maxResults?: number;
};

async function searchIssues(
  config: JiraApiConfig,
  jql: string,
  cap: number,
): Promise<{ issues: SearchIssue[]; complete: boolean }> {
  const issues: SearchIssue[] = [];
  let nextPageToken: string | undefined;
  while (issues.length < cap) {
    const page = await jiraPost<SearchResponse>(
      config,
      "/rest/api/3/search/jql",
      {
        jql,
        nextPageToken,
        maxResults: Math.min(PAGE_SIZE, cap - issues.length),
        fields: [
          "summary",
          "updated",
          "duedate",
          "status",
          "issuetype",
          "project",
          "assignee",
          "reporter",
          "priority",
        ],
      },
    );
    issues.push(...(page.issues ?? []));
    nextPageToken = page.nextPageToken;
    if (
      page.isLast === true ||
      !nextPageToken ||
      (page.issues ?? []).length === 0
    )
      return { issues, complete: true };
  }
  return { issues, complete: nextPageToken === undefined };
}

/** All in-window changelog entries for one issue; paginates fully per issue. */
async function fetchChangelogInWindow(
  config: JiraApiConfig,
  issueKey: string,
  window: { startMs: number; endMs: number },
): Promise<{
  entries: NonNullable<ChangelogPage["values"]>;
  paginationComplete: boolean;
}> {
  const entries: NonNullable<ChangelogPage["values"]> = [];
  let startAt = 0;
  for (let page = 0; page < CHANGELOG_MAX_PAGES_PER_ISSUE; page += 1) {
    const res = await jiraGet<ChangelogPage>(
      config,
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/changelog`,
      {
        startAt,
        maxResults: CHANGELOG_PAGE_SIZE,
      },
    );
    const values = res.values ?? [];
    entries.push(...values.filter((v) => inMsWindow(v.created, window)));
    startAt += values.length;
    if (res.isLast === true || values.length === 0)
      return { entries, paginationComplete: true };
    if (res.total !== undefined && startAt >= res.total)
      return { entries, paginationComplete: true };
  }
  return { entries, paginationComplete: false };
}

function inMsWindow(
  at: string | undefined,
  window: { startMs: number; endMs: number },
): boolean {
  if (!at) return false;
  const ms = Date.parse(at);
  return Number.isFinite(ms) && ms >= window.startMs && ms < window.endMs;
}

function jqlDay(window: DayWindow): { from: string; to: string } {
  // JQL datetimes are interpreted in the searching user's Jira timezone, which
  // is expected to match the day-window zone; minute precision is enough.
  const fmt = (ms: number) => {
    const d = new Date(ms);
    const parts = new Intl.DateTimeFormat("sv-SE", {
      timeZone: window.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(d);
    return parts.replace("T", " ");
  };
  return { from: fmt(window.startMs), to: fmt(window.endMs) };
}

function issueUrl(config: JiraApiConfig, key: string): string {
  return `https://${config.jiraHost}/browse/${key}`;
}

/**
 * Jira source facts. Semantics: `updated in window` yields CURRENT issue state
 * (kind "issue-activity", tag "activity"); only changelog-backed items (kind
 * "issue-transition", tag "transition") may be narrated as movement.
 * Changelog candidates = status-changed JQL ∪ own-involvement, capped;
 * completeness is tracked at three levels (JQL result sets, selection
 * coverage, per-issue pagination) — any truncation ⇒ partial.
 */
export const jiraCollector: DaySourceCollector = {
  key: "jira",
  label: "Jira",
  readiness() {
    return isJiraConfigured()
      ? { ready: true }
      : {
          ready: false,
          reason: "unconfigured",
          detail: "Jira is not configured",
        };
  },
  async collect(ctx: DayCollectContext): Promise<CollectorOutput> {
    const config = getJiraCredsIfAvailable();
    if (!config) throw new Error("Jira credentials unavailable");
    const cap = Math.max(1, getSettings().dayScan.changelogIssueCap);
    const { from, to } = jqlDay(ctx.window);
    const observedAt = new Date().toISOString();

    const activity = await searchIssues(
      config,
      `updated >= "${from}" AND updated < "${to}" ORDER BY updated DESC`,
      ACTIVITY_CAP,
    );
    const statusChanged = await searchIssues(
      config,
      `status changed DURING ("${from}", "${to}") ORDER BY updated DESC`,
      cap,
    );
    ctx.cache.writeJson(ctx.date, "jira-raw", {
      activity: activity.issues.length,
      statusChanged: statusChanged.issues.length,
    });

    const identity = ctx.identities;
    const isOwn = (issue: SearchIssue): boolean => {
      const ids = [
        issue.fields?.assignee?.accountId,
        issue.fields?.reporter?.accountId,
      ].filter(Boolean);
      const emails = [
        issue.fields?.assignee?.emailAddress,
        issue.fields?.reporter?.emailAddress,
      ].filter(Boolean);
      return Boolean(
        (identity.jiraAccountId && ids.includes(identity.jiraAccountId)) ||
        (identity.jiraEmail && emails.includes(identity.jiraEmail)),
      );
    };

    // Deterministic changelog candidate selection: status-changed ∪ own-involvement, capped.
    const candidates = new Map<string, SearchIssue>();
    for (const issue of statusChanged.issues)
      if (issue.key) candidates.set(issue.key, issue);
    for (const issue of activity.issues)
      if (issue.key && isOwn(issue) && !candidates.has(issue.key))
        candidates.set(issue.key, issue);
    const selected = [...candidates.entries()].slice(0, cap);
    const selectionComplete = candidates.size <= cap;

    const facts: DaySourceFact[] = [];
    for (const issue of activity.issues) {
      if (!issue.key) continue;
      facts.push({
        id: `jira:${issue.key}`,
        kind: "issue-activity",
        occurredAt: issue.fields?.updated ?? null,
        observedAt,
        actor: issue.fields?.assignee?.displayName ?? null,
        ...(issue.fields?.summary !== undefined
          ? { title: issue.fields?.summary }
          : {}),
        links: [issueUrl(config, issue.key)],
        data: {
          status: issue.fields?.status?.name ?? null,
          statusCategory: issue.fields?.status?.statusCategory?.name ?? null,
          issueType: issue.fields?.issuetype?.name ?? null,
          projectKey: issue.fields?.project?.key ?? null,
          priority: issue.fields?.priority?.name ?? null,
          dueDate: issue.fields?.duedate ?? null,
        },
        tags: ["activity", ...(isOwn(issue) ? ["own"] : [])],
      });
    }

    let paginationComplete = true;
    for (const [key, issue] of selected) {
      const changelog = await fetchChangelogInWindow(config, key, ctx.window);
      if (!changelog.paginationComplete) paginationComplete = false;
      for (const entry of changelog.entries) {
        const items = (entry.items ?? []).filter(
          (item) => item.field && TRANSITION_FIELDS.has(item.field),
        );
        for (const item of items) {
          facts.push({
            id: `jira:${key}:cl:${entry.id ?? entry.created}:${item.field}`,
            kind: "issue-transition",
            occurredAt: entry.created ?? null,
            observedAt,
            actor: entry.author?.displayName ?? null,
            ...(issue.fields?.summary !== undefined
              ? { title: issue.fields?.summary }
              : {}),
            links: [issueUrl(config, key)],
            data: {
              issueKey: key,
              field: item.field,
              from: item.fromString ?? null,
              to: item.toString ?? null,
            },
            tags: ["transition"],
          });
        }
      }
    }

    const complete =
      activity.complete &&
      statusChanged.complete &&
      selectionComplete &&
      paginationComplete;
    return {
      result: complete ? "complete" : "partial",
      facts,
      completeness: {
        activityJqlComplete: activity.complete,
        statusChangedJqlComplete: statusChanged.complete,
        changelogSelectionComplete: selectionComplete,
        changelogPaginationComplete: paginationComplete,
        changelogCandidates: candidates.size,
        changelogSelected: selected.length,
      },
      ...(complete
        ? {}
        : {
            notes: [
              "Jira changelog coverage is sampled; movement claims limited to fetched transitions.",
            ],
          }),
    };
  },
};
