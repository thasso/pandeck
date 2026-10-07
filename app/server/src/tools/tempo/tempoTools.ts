import type {
  ApprovalCard,
  TempoWorklogMutationItemDisplay,
} from "@assistant/shared";
import { defineAgentTool } from "../../mcp/tool.ts";
import {
  jiraGet,
  jiraIssueUrl,
  resolveJiraIssueInfos,
  type JiraApiConfig,
  type JiraIssueInfo,
} from "../../jiraClient.ts";
import {
  getTempoToolConfig,
  resolveTempoAuthorAccountId,
  type TempoToolConfig,
} from "../../tempoSettings.ts";
import {
  approvalCardReference,
  createApproval,
  registerApprovalExecutor,
} from "../../pendingApprovals.ts";
import { errorText } from "../../errors.ts";
import {
  extractActivity,
  fetchWorklogs,
  tempoJson,
  TEMPO_PAGE_LIMIT,
  type TempoWorklog,
} from "./tempoWorklogFetch.ts";
import { resolveTempoFilterIds } from "./tempoJiraJoin.ts";
import {
  aggregateRows,
  formatDuration,
  parseGroupBy,
  type TempoReportRow,
} from "./tempoReportRows.ts";

const MAX_MUTATION_ITEMS = 50;

type JiraIssueResponse = {
  id?: string;
  key?: string;
  fields?: { summary?: string };
};

type JiraEditmetaResponse = {
  fields?: Record<
    string,
    { allowedValues?: Array<{ id?: string | number; value?: string }> }
  >;
};

type TempoAccount = {
  id?: string | number;
  key?: string;
  name?: string;
  value?: string;
};
type TempoAccountsPage = {
  results?: TempoAccount[];
  metadata?: { next?: string };
};

type ListWorklogsParams = {
  from: string;
  to?: string;
  includeAllAuthors?: boolean;
  maxResults?: number;
  offset?: number;
  projectKeys?: string[];
  issueKeys?: string[];
  jiraEnrichment?: boolean;
  output?: "worklogs" | "totals";
  groupBy?: string[];
};

type TempoMutationParams = {
  items?: TempoMutationItemInput[];
};

type TempoMutationItemInput = {
  clientId?: string;
  action?: "create" | "update";
  worklogId?: string | number;
  issueKey?: string;
  date?: string;
  startTime?: string;
  duration?: string | number;
  timeSpentSeconds?: number;
  activityKey?: string;
  description?: string;
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// TypeBox is not a direct dependency of the web assistant package; AgentTool
// parameters are plain JSON Schema. Keep these schemas local so we don't add
// another dependency just for dedicated tools.
const listWorklogsParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["from"],
  properties: {
    from: {
      type: "string",
      description: "Start date in YYYY-MM-DD format, inclusive.",
    },
    to: {
      type: "string",
      description:
        "End date in YYYY-MM-DD format, inclusive. Defaults to from.",
    },
    includeAllAuthors: {
      type: "boolean",
      description:
        "Return all visible authors instead of only the configured Jira user. Defaults to false.",
    },
    maxResults: {
      type: "number",
      description:
        "Maximum worklogs to return after filtering (page size). Defaults to 100, maximum 1000. When more remain the result carries nextOffset; pass it as offset to continue.",
    },
    offset: {
      type: "number",
      description:
        "Tempo offset to continue from (the nextOffset of the previous page). Defaults to 0.",
    },
    projectKeys: {
      type: "array",
      items: { type: "string" },
      description:
        "Only worklogs on issues in these Jira projects (keys such as WEB; numeric project ids also accepted). Applied server-side by Tempo; keys need the Jira integration.",
    },
    issueKeys: {
      type: "array",
      items: { type: "string" },
      description:
        "Only worklogs on these issues (keys or numeric ids). Applied server-side by Tempo; keys need the Jira integration.",
    },
    jiraEnrichment: {
      type: "boolean",
      description:
        "Resolve issue keys/summaries/links through Jira (default true). false returns raw Tempo issue ids only and never touches Jira — use it when Jira rate-limits.",
    },
    output: {
      type: "string",
      enum: ["worklogs", "totals"],
      description:
        "worklogs (default) returns each worklog; totals returns only aggregate rows for groupBy and no raw worklogs — use it for hours by issue, project, author, date or activity.",
    },
    groupBy: {
      type: "array",
      items: { type: "string" },
      description:
        'Dimensions for output=totals, in order: issue, project, author, date, month, activity, issueType. Defaults to ["issue"].',
    },
  },
} as const;

const mutateWorklogsParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      minItems: 1,
      maxItems: MAX_MUTATION_ITEMS,
      description:
        "Bulk create/update proposal. No writes happen until the user approves the rendered proposal.",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "action",
          "issueKey",
          "date",
          "startTime",
          "activityKey",
          "description",
        ],
        properties: {
          clientId: {
            type: "string",
            description: "Optional caller-stable id for this proposed row.",
          },
          action: {
            type: "string",
            enum: ["create", "update"],
            description:
              "Whether to create a new worklog or update an existing one.",
          },
          worklogId: {
            anyOf: [{ type: "string" }, { type: "number" }],
            description:
              "Required for action=update: Tempo worklog id to update.",
          },
          issueKey: {
            type: "string",
            description: "Jira issue key to log against, e.g. OPS-73.",
          },
          date: {
            type: "string",
            description: "Worklog start date in YYYY-MM-DD format.",
          },
          startTime: {
            type: "string",
            description: "Worklog start time as HH:mm or HH:mm:ss.",
          },
          duration: {
            anyOf: [{ type: "string" }, { type: "number" }],
            description: "Duration as seconds, 30m, 1h, 1h30m, or 1h 30m.",
          },
          timeSpentSeconds: {
            type: "number",
            description: "Alternative to duration: exact duration in seconds.",
          },
          activityKey: {
            type: "string",
            description: "Tempo Activity (_Account_) key, e.g. MEETING or ADM.",
          },
          description: {
            type: "string",
            description: "Concise factual worklog description.",
          },
        },
      },
    },
  },
} as const;

export const tempoListWorklogsTool = defineAgentTool<ListWorklogsParams>({
  name: "tempo_list_worklogs",
  label: "Tempo: List Worklogs",
  description:
    "List Tempo worklogs for a date range and enrich their Jira issue keys, summaries, and links. Read-only. Read the relevant range here before planning or proposing new entries, so you do not duplicate existing time, and render any issue you mention as a Markdown link from the returned issueUrl. Paged: a non-null nextOffset means more worklogs exist — continue with offset, never treat a page as the whole range. Filter server-side with projectKeys/issueKeys, ask for output=totals when you need hours rather than entries, and use tempo_export_worklogs for months or a whole year.",
  parameters: listWorklogsParamsSchema,
  async execute(params, ctx) {
    const from = normalizeDate(params.from, "from");
    const to = normalizeDate(params.to ?? params.from, "to");
    if (to < from)
      throw new Error(`to (${to}) must be on or after from (${from}).`);

    const includeAllAuthors = params.includeAllAuthors === true;
    const maxResults = clampMax(params.maxResults);
    const offset = clampOffset(params.offset);
    const output = params.output === "totals" ? "totals" : "worklogs";
    const groupBy = parseGroupBy(params.groupBy);
    const config = await getTempoToolConfig();
    // jiraEnrichment=false must never call Jira: the caller opted out to dodge rate limits.
    const jira = params.jiraEnrichment === false ? null : config.jira;
    const signal = ctx?.signal;
    // Degrade when Jira is off: we cannot resolve the author id unless it is cached, so
    // fall back to all-authors instead of failing. A cached authorAccountId still filters.
    const jiraNote: string[] = [];
    let authorAccountId: string | undefined;
    if (!includeAllAuthors) {
      if (config.authorAccountId) authorAccountId = config.authorAccountId;
      else if (jira)
        authorAccountId = await resolveTempoAuthorAccountId(config);
      else
        jiraNote.push(
          "Jira integration is off, so worklogs are not filtered to your account. Enable Jira in Settings → Jira to filter by author.",
        );
    }
    const filter = {
      projectIds: await resolveTempoFilterIds(
        jira,
        params.projectKeys,
        "project",
        signal,
        jiraNote,
      ),
      issueIds: await resolveTempoFilterIds(
        jira,
        params.issueKeys,
        "issue",
        signal,
        jiraNote,
      ),
    };
    const page = await fetchWorklogs({
      apiBaseUrl: config.apiBaseUrl,
      accessToken: config.accessToken,
      from,
      to,
      maxResults,
      offset,
      filter,
      ...(authorAccountId !== undefined ? { authorAccountId } : {}),
      ...(signal ? { signal } : {}),
    });
    const worklogs = page.worklogs;
    const issues = jira
      ? await resolveJiraIssues(jira, worklogs)
      : new Map<string, JiraIssueInfo>();
    if (!jira)
      jiraNote.push(
        params.jiraEnrichment === false
          ? "Jira enrichment was disabled for this call (raw Tempo issue ids only)."
          : "Jira integration is off, so issue keys/summaries/links are not enriched (raw Tempo issue ids only). Enable Jira in Settings → Jira for enrichment.",
      );
    if (page.nextOffset !== null)
      jiraNote.push(
        `More worklogs remain in ${from}..${to}: call again with offset=${page.nextOffset} (or use tempo_export_worklogs for the whole range).`,
      );
    const jiraHost = jira?.jiraHost ?? null;

    const normalized = worklogs.map((worklog) =>
      normalizeWorklog(worklog, issues, jiraHost),
    );
    const totalSeconds = normalized.reduce(
      (sum, worklog) => sum + worklog.timeSpentSeconds,
      0,
    );
    const base = {
      from,
      to,
      jiraHost,
      jiraEnrichment: jira ? "on" : "off",
      notes: jiraNote,
      filteredToAuthorAccountId: authorAccountId ?? null,
      includeAllAuthors:
        includeAllAuthors || (!authorAccountId && !includeAllAuthors),
      projectKeys: params.projectKeys ?? [],
      issueKeys: params.issueKeys ?? [],
      offset,
      nextOffset: page.nextOffset,
      exhausted: page.nextOffset === null,
      worklogCount: worklogs.length,
      totalSeconds,
      total: formatDuration(totalSeconds),
    };
    const payload =
      output === "totals"
        ? {
            ...base,
            output,
            groupBy,
            totals: aggregateRows(
              normalized.map((worklog) => reportRowOf(worklog)),
              groupBy,
            ),
          }
        : {
            ...base,
            output,
            byIssue: aggregateRows(
              normalized.map((worklog) => reportRowOf(worklog)),
              ["issue"],
            ),
            worklogs: normalized,
          };

    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      details: payload,
    };
  },
});

/** The flat report row of a normalized list worklog, for grouping. */
function reportRowOf(
  worklog: ReturnType<typeof normalizeWorklog>,
): TempoReportRow {
  return {
    worklogId: String(worklog.id ?? ""),
    issueId:
      worklog.issue?.id !== undefined && worklog.issue?.id !== null
        ? String(worklog.issue.id)
        : "",
    issueKey: worklog.issue?.key ?? null,
    issueSummary: worklog.issue?.summary ?? null,
    issueType: worklog.issue?.issueType ?? null,
    issueUrl: worklog.issue?.issueUrl ?? null,
    projectKey: worklog.issue?.projectKey ?? null,
    labels: [],
    fields: {},
    date: worklog.startDate ?? "",
    startTime: worklog.startTime,
    seconds: worklog.timeSpentSeconds,
    billableSeconds: worklog.billableSeconds,
    authorAccountId: worklog.author?.accountId ?? null,
    authorName: worklog.author?.displayName ?? null,
    description: worklog.description,
    activity: worklog.activity,
    createdAt: worklog.createdAt,
    updatedAt: worklog.updatedAt,
  };
}

/**
 * @payload TempoWorklogMutationDisplay
 * @purpose Structured approval proposal/result for creating or updating Tempo worklogs.
 * @renderWhen The tool always returns a bounded approval payload; agents should use it only after explicit user intent to prepare Tempo writes.
 * @bounds Up to 50 create/update rows; Tempo execution is deferred until the user approves in the client UI.
 * @client Render as a mutation-capable approval card with clear pending/executed/failed state and persisted result entry ids.
 */
export const tempoMutateWorklogsTool = defineAgentTool<TempoMutationParams>({
  name: "tempo_mutate_worklogs",
  label: "Tempo: Prepare Worklog Writes",
  description:
    "Prepare a bulk create/update proposal for Tempo worklogs, only when the user explicitly asks to log, backfill, or correct time. This tool never writes immediately: it validates entries, persists a pending approval record, and returns a custom UI payload with an approval button. Check tempo_list_worklogs for the same dates first to avoid duplicates. Route each entry to the right TICKET and ACTIVITY: an explicit ticket named for the work, else the user's own same-day work on a ticket, else the responsibility area of the people involved (contacts_lookup) mapped to a Team Workflow ticket — the ticket's Cost Center follows automatically. If no ticket exists for the work, propose creating one with jira_mutate_issue first and log onto the returned key. If a ticket, activity, attendance, or time range is unclear, ask instead of preparing a proposal.",
  parameters: mutateWorklogsParamsSchema,
  async execute(params, ctx) {
    const config = await getTempoToolConfig();
    // Mutation always needs live Jira: it validates each row's issue key and Tempo
    // activity through Jira, which a cached author id cannot substitute for.
    if (!config.jira) {
      throw new Error(
        "tempo_mutate_worklogs requires the Jira integration enabled and configured (it validates issue keys and activities through Jira). Enable it in Settings → Jira.",
      );
    }
    const jira = config.jira;
    await resolveTempoAuthorAccountId(config);
    const { items, warnings } = await buildMutationItems(
      config,
      jira,
      params.items ?? [],
    );
    const title =
      items.length === 1
        ? `Log time on ${items[0]!.issueKey}`
        : `Log ${items.length} Tempo worklogs`;
    const summary = [
      items.map((item) => `${item.issueKey} ${item.duration}`).join(", "),
      warnings.length ? `${warnings.length} warning(s)` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const card = createApproval({
      sessionId: ctx.session.sessionId,
      kind: "tempoWorklog",
      title,
      ...(summary ? { summary: summary } : {}),
      sourceToolCallId: ctx.toolCallId,
      body: {
        kind: "tempoWorklog",
        jiraHost: jira.jiraHost,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        items,
      },
    });
    const warnLine = warnings.length
      ? ` Warnings: ${warnings.join("; ")}.`
      : "";
    const text = `Prepared a Tempo worklog proposal for ${items.length} entr${items.length === 1 ? "y" : "ies"} pending your approval.${warnLine} Do not claim worklogs were written until the approved result appears. ${approvalCardReference(card)}`;
    return { content: [{ type: "text", text }], terminate: true };
  },
});

/** Execute an approved Tempo worklog mutation: write each row, recording per-item results. */
registerApprovalExecutor("tempoWorklog", {
  async execute(card: ApprovalCard) {
    if (card.body.kind !== "tempoWorklog")
      throw new Error("Mismatched approval body for tempoWorklog.");
    const items = card.body.items;
    const config = await getTempoToolConfig();
    const authorAccountId = await resolveTempoAuthorAccountId(config);
    let succeeded = 0;
    for (const item of items) {
      try {
        const written = await executeMutationItem(
          config,
          authorAccountId,
          item,
        );
        item.resultWorklogId = String(
          written.tempoWorklogId ?? written.id ?? item.worklogId ?? "",
        );
        item.resultSelf =
          typeof written.self === "string" ? written.self : null;
        delete item.error;
        succeeded += 1;
      } catch (err) {
        item.error = errorText(err);
      }
    }
    if (succeeded === 0)
      throw new Error(
        `All ${items.length} Tempo worklog write(s) failed: ${items
          .map((item) => item.error)
          .filter(Boolean)
          .join("; ")}`,
      );
    const failed = items.length - succeeded;
    return {
      resultSummary: failed
        ? `Wrote ${succeeded}/${items.length} worklog(s); ${failed} failed`
        : `Wrote ${succeeded} worklog(s)`,
    };
  },
});

export const assistantTempoTools = [
  tempoListWorklogsTool,
  tempoMutateWorklogsTool,
];

async function executeMutationItem(
  config: TempoToolConfig,
  authorAccountId: string,
  item: TempoWorklogMutationItemDisplay,
): Promise<TempoWorklog> {
  const body = {
    issueId: item.issueId,
    timeSpentSeconds: item.timeSpentSeconds,
    startDate: item.date,
    startTime: item.startTime,
    description: item.description || undefined,
    authorAccountId,
    attributes: [{ key: "_Account_", value: item.activityKey }],
  };
  if (item.action === "update") {
    if (!item.worklogId) throw new Error("Update item is missing worklogId.");
    const url = new URL(
      `${config.apiBaseUrl.replace(/\/$/, "")}/worklogs/${encodeURIComponent(item.worklogId)}`,
    );
    return tempoJson<TempoWorklog>(url, config.accessToken, "PUT", body);
  }
  const url = new URL(`${config.apiBaseUrl.replace(/\/$/, "")}/worklogs`);
  return tempoJson<TempoWorklog>(url, config.accessToken, "POST", body);
}

async function tempoGet<T>(url: URL, token: string): Promise<T> {
  return tempoJson<T>(url, token, "GET");
}

async function resolveJiraIssues(
  jira: JiraApiConfig,
  worklogs: TempoWorklog[],
): Promise<Map<string, JiraIssueInfo>> {
  const ids = unique(
    worklogs
      .map((worklog) => worklog.issue?.id)
      .filter(Boolean)
      .map(String),
  );
  return resolveJiraIssueInfos(jira, ids);
}

async function buildMutationItems(
  config: TempoToolConfig,
  jira: JiraApiConfig,
  input: TempoMutationItemInput[],
): Promise<{ items: TempoWorklogMutationItemDisplay[]; warnings: string[] }> {
  if (!Array.isArray(input) || input.length === 0)
    throw new Error("At least one Tempo worklog mutation item is required.");
  if (input.length > MAX_MUTATION_ITEMS)
    throw new Error(
      `At most ${MAX_MUTATION_ITEMS} Tempo worklog mutation items are supported per approval.`,
    );

  const warnings: string[] = [];
  const issueCache = new Map<string, JiraIssueResponse>();
  const activityCache = new Map<
    string,
    Array<{ key: string | null; name: string | null; id: string | null }>
  >();
  const accounts = await fetchTempoAccounts(config).catch((err: unknown) => {
    warnings.push(
      `Could not prefetch Tempo accounts for activity labels: ${errorText(err)}`,
    );
    return [] as TempoAccount[];
  });

  const items: TempoWorklogMutationItemDisplay[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const raw = input[index]!;
    const action = raw.action;
    if (action !== "create" && action !== "update")
      throw new Error(`items[${index}].action must be create or update.`);
    if (
      action === "update" &&
      (raw.worklogId === undefined ||
        raw.worklogId === null ||
        String(raw.worklogId).trim() === "")
    ) {
      throw new Error(`items[${index}].worklogId is required for update.`);
    }
    const issueKey = normalizeIssueKey(raw.issueKey, index);
    const date = normalizeDate(raw.date ?? "", `items[${index}].date`);
    const startTime = normalizeStartTime(
      raw.startTime ?? "",
      `items[${index}].startTime`,
    );
    const timeSpentSeconds = parseDurationSeconds(raw, index);
    const activityKey = normalizeRequiredString(
      raw.activityKey,
      `items[${index}].activityKey`,
    ).toUpperCase();
    const description = normalizeRequiredString(
      raw.description,
      `items[${index}].description`,
    );

    let issue = issueCache.get(issueKey);
    if (!issue) {
      issue = await jiraGet<JiraIssueResponse>(
        jira,
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
        { fields: "summary" },
      );
      if (!issue.id)
        throw new Error(`Jira issue ${issueKey} did not return an id.`);
      issueCache.set(issueKey, issue);
    }

    let allowed = activityCache.get(issueKey);
    if (!allowed) {
      allowed = await getAllowedActivities(jira, issueKey, accounts).catch(
        (err: unknown) => {
          warnings.push(
            `Could not validate Tempo activities for ${issueKey}: ${errorText(err)}`,
          );
          return [];
        },
      );
      activityCache.set(issueKey, allowed);
    }
    if (
      allowed.length > 0 &&
      !allowed.some((activity) => activity.key === activityKey)
    ) {
      const choices = allowed
        .map(
          (activity) =>
            `${activity.key ?? "?"}${activity.name ? ` (${activity.name})` : ""}`,
        )
        .join(", ");
      throw new Error(
        `Activity ${activityKey} is not allowed for ${issueKey}. Allowed: ${choices}`,
      );
    }
    if (allowed.length === 0) {
      warnings.push(
        `No allowed Tempo activities were exposed for ${issueKey}; Tempo will validate ${activityKey} during approval execution.`,
      );
    }

    items.push({
      clientId: raw.clientId?.trim() || `item-${index + 1}`,
      action,
      worklogId:
        raw.worklogId === undefined || raw.worklogId === null
          ? null
          : String(raw.worklogId),
      issueKey,
      issueId: issue.id ?? null,
      issueSummary: issue.fields?.summary ?? null,
      issueUrl: jiraIssueUrl(jira.jiraHost, issueKey),
      date,
      startTime,
      timeSpentSeconds,
      duration: formatDuration(timeSpentSeconds),
      activityKey,
      description,
    });
  }

  return { items, warnings: unique(warnings) };
}

async function fetchTempoAccounts(
  config: TempoToolConfig,
): Promise<TempoAccount[]> {
  const accounts: TempoAccount[] = [];
  for (let offset = 0; ; offset += 100) {
    const url = new URL(`${config.apiBaseUrl.replace(/\/$/, "")}/accounts`);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("limit", "100");
    const page = await tempoGet<TempoAccountsPage>(url, config.accessToken);
    accounts.push(...(page.results ?? []));
    if (!page.metadata?.next) break;
  }
  return accounts;
}

async function getAllowedActivities(
  jira: JiraApiConfig,
  issueKey: string,
  accounts: TempoAccount[],
): Promise<
  Array<{ key: string | null; name: string | null; id: string | null }>
> {
  const editmeta = await jiraGet<JiraEditmetaResponse>(
    jira,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/editmeta`,
  );
  const allowedValues = editmeta.fields?.customfield_10800?.allowedValues ?? [];
  return allowedValues.map((value) => {
    const account = accounts.find(
      (candidate) => String(candidate.id) === String(value.id),
    );
    return {
      key: account?.key ?? null,
      name: value.value ?? account?.name ?? account?.value ?? null,
      id: value.id === undefined || value.id === null ? null : String(value.id),
    };
  });
}

function normalizeWorklog(
  worklog: TempoWorklog,
  issues: Map<string, JiraIssueInfo>,
  jiraHost: string | null,
) {
  const issueId =
    worklog.issue?.id !== undefined ? String(worklog.issue.id) : null;
  const issue = issueId ? issues.get(issueId) : undefined;
  // With Jira enrichment off (jiraHost null) we return only the raw Tempo issue id;
  // key/summary/url stay null even if Tempo echoed them, per the documented degrade.
  const enriched = jiraHost != null;
  const issueKey = enriched ? (issue?.key ?? worklog.issue?.key ?? null) : null;
  return {
    id: worklog.tempoWorklogId ?? worklog.id ?? null,
    self: typeof worklog.self === "string" ? worklog.self : null,
    issue: worklog.issue
      ? {
          id: worklog.issue.id ?? null,
          key: issueKey,
          summary: enriched
            ? (issue?.summary ?? worklog.issue.summary ?? null)
            : null,
          issueUrl:
            issueKey && jiraHost ? jiraIssueUrl(jiraHost, issueKey) : null,
          projectKey: issue?.projectKey ?? null,
          issueType: issue?.issueType ?? null,
          status: issue?.status ?? null,
          self: worklog.issue.self ?? null,
        }
      : null,
    startDate: worklog.startDate ?? null,
    startTime: worklog.startTime ?? null,
    startDateTimeUtc:
      typeof worklog.startDateTimeUtc === "string"
        ? worklog.startDateTimeUtc
        : null,
    timeSpentSeconds: worklog.timeSpentSeconds ?? 0,
    duration: formatDuration(worklog.timeSpentSeconds ?? 0),
    billableSeconds: worklog.billableSeconds ?? null,
    billableDuration:
      worklog.billableSeconds !== undefined
        ? formatDuration(worklog.billableSeconds)
        : null,
    description: worklog.description ?? "",
    author: worklog.author
      ? {
          accountId: worklog.author.accountId ?? null,
          displayName: worklog.author.displayName ?? null,
          self: worklog.author.self ?? null,
        }
      : null,
    activity: extractActivity(worklog),
    createdAt: typeof worklog.createdAt === "string" ? worklog.createdAt : null,
    updatedAt: typeof worklog.updatedAt === "string" ? worklog.updatedAt : null,
  };
}

function normalizeIssueKey(value: string | undefined, index: number): string {
  const key = normalizeRequiredString(
    value,
    `items[${index}].issueKey`,
  ).toUpperCase();
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key))
    throw new Error(
      `items[${index}].issueKey is not a valid Jira issue key: ${value}`,
    );
  return key;
}

function normalizeRequiredString(
  value: string | undefined,
  name: string,
): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${name} is required.`);
  return text;
}

function normalizeStartTime(value: string, name: string): string {
  const trimmed = value.trim();
  if (/^\d{1,2}:\d{2}$/.test(trimmed)) return `${trimmed.padStart(5, "0")}:00`;
  if (/^\d{1,2}:\d{2}:\d{2}$/.test(trimmed)) return trimmed.padStart(8, "0");
  throw new Error(`${name} must be HH:mm or HH:mm:ss.`);
}

function parseDurationSeconds(
  raw: TempoMutationItemInput,
  index: number,
): number {
  const direct = raw.timeSpentSeconds;
  if (direct !== undefined) {
    if (!Number.isFinite(direct) || direct <= 0)
      throw new Error(
        `items[${index}].timeSpentSeconds must be a positive number.`,
      );
    return Math.floor(direct);
  }
  const value = raw.duration;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0)
      throw new Error(`items[${index}].duration must be positive seconds.`);
    return Math.floor(value);
  }
  if (typeof value !== "string" || !value.trim())
    throw new Error(
      `items[${index}].duration or timeSpentSeconds is required.`,
    );
  const trimmed = value.trim().toLowerCase().replace(/\s+/g, "");
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const match = trimmed.match(/^(?:(\d+)h)?(?:(\d+)m)?$/);
  if (!match || (!match[1] && !match[2]))
    throw new Error(`Cannot parse items[${index}].duration: ${value}`);
  const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60;
  if (seconds <= 0)
    throw new Error(`items[${index}].duration must be positive.`);
  return seconds;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function normalizeDate(value: string, name: string): string {
  if (!ISO_DATE_RE.test(value))
    throw new Error(`${name} must be a YYYY-MM-DD date.`);
  return value;
}

function clampMax(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isFinite(value) || value <= 0) return 100;
  return Math.min(TEMPO_PAGE_LIMIT, Math.floor(value));
}

function clampOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}
