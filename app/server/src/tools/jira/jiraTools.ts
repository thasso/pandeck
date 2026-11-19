import type {
  ApprovalCard,
  JiraIssueLinkChangeDisplay,
  JiraIssueMutationFieldChangeDisplay,
  JiraIssueMutationItemDisplay,
} from "@assistant/shared";
import { defineAgentTool } from "../../mcp/tool.ts";
import { getJiraToolConfig } from "../../jiraSettings.ts";
import {
  approvalCardReference,
  createApproval,
  proposalSnapshot,
  registerApprovalExecutor,
} from "../../pendingApprovals.ts";
import {
  JIRA_ISSUE_BASE_FIELDS,
  clampMaxComments,
  fetchJiraComments,
  jiraBaseUrl,
  jiraDelete,
  jiraGet,
  jiraPost,
  jiraPut,
  normalizeIssueInput,
  normalizeJiraIssue,
} from "../../jiraClient.ts";
import {
  resolveFieldName,
  resolveIssueLinkType,
  type JiraIssueLinkType,
} from "../../jiraFields.ts";
import { getJiraIssueLinkTypes } from "../../jiraIssueLinkTypeCache.ts";
import {
  getCustomFieldProfile,
  getJiraFieldMap,
  updateCustomFieldProfile,
  type JiraCustomFieldProfile,
} from "../../jiraFieldCache.ts";
import {
  JIRA_LOOKUP_DESCRIPTION,
  lookupParamsSchema,
  runJiraLookup,
  type LookupParams,
} from "../../jiraLookup.ts";
import {
  isEmptyValue,
  normalizeStringList,
  truncate,
  unique,
  valueToText,
  type JiraFieldSchema,
  type JiraIssueResponse,
} from "../../jiraRead.ts";
import {
  JIRA_SEARCH_ISSUES_DESCRIPTION,
  normalizeJql,
  resolveJiraFieldInputs,
  runJiraSearchIssues,
  searchIssuesParamsSchema,
  type SearchIssuesParams,
} from "../../jiraSearch.ts";
import { errorText } from "../../errors.ts";
import { resolveUserNames } from "../../jiraUsers.ts";
import { assertIssuePermission } from "./jiraPermissions.ts";
import {
  buildJiraRankItem,
  executeJiraRankItem,
  type JiraRankItemInput,
} from "./jiraRank.ts";
import {
  buildJiraSprintItem,
  executeJiraSprintItem,
  jiraSprintItemLabel,
  jiraSprintResultText,
  type JiraSprintItemInput,
} from "./jiraSprint.ts";
import { markdownToAdf } from "../../atlassian/adfFromMarkdown.ts";

type CustomFieldMode = "none" | "known" | "selected" | "discoverNonEmpty";

type GetIssueParams = {
  issue: string;
  includeDescription?: boolean;
  includeComments?: boolean;
  maxComments?: number;
  customFields?: CustomFieldMode;
  customFieldNames?: string[];
  includeRawCustomFieldValues?: boolean;
};

/** Unified discovery params for jira_lookup; each field applies to specific kinds. */

type JiraMutationParams = {
  render?: boolean;
  items?: JiraMutationItemInput[];
};

type JiraMutationItemInput = JiraRankItemInput &
  JiraSprintItemInput & {
    clientId?: string;
    /** edit (default) = mutate an existing issue; create = new issue; comment = add a comment; rank = reorder a backlog; sprint = edit a sprint. */
    operation?: "edit" | "create" | "comment" | "rank" | "sprint";
    issue?: string;
    // create:
    projectKey?: string;
    issueType?: string;
    summary?: string;
    description?: string | null;
    // comment:
    commentBody?: string;
    transitionId?: string;
    transitionName?: string;
    targetStatus?: string;
    resolutionName?: string;
    assigneeAccountId?: string | null;
    clearAssignee?: boolean;
    parentIssue?: string | null;
    epicIssue?: string | null;
    labels?: { set?: string[]; add?: string[]; remove?: string[] };
    components?: { set?: string[]; add?: string[]; remove?: string[] };
    fields?: Record<string, unknown>;
    linkChanges?: JiraLinkChangeInput[];
  };

type JiraLinkChangeInput = {
  op: "add" | "remove";
  /** Link type name or id, e.g. "Blocks". Required for op=add; ignored for op=remove (linkId identifies the link). */
  type?: string;
  /** Direction from this issue: outward uses the type's outward phrase (e.g. "blocks"), inward the inward phrase (e.g. "is blocked by"). Required for op=add. */
  direction?: "inward" | "outward";
  /** The other issue's key or id. Required for op=add. */
  issue?: string;
  /** Existing issue link id to remove. Required for op=remove (get it from jira_get_issue issueLinks[].id). */
  linkId?: string;
};

type JiraTransition = {
  id?: string;
  name?: string;
  to?: { id?: string; name?: string; statusCategory?: { name?: string } };
  fallbackResolutionName?: string;
};

type JiraTransitionsResponse = {
  transitions?: JiraTransition[];
};

type JiraEditMetaResponse = {
  fields?: Record<string, { name?: string; required?: boolean }>;
};

type JiraCreateMetaResponse = {
  projects?: Array<{
    key?: string;
    issuetypes?: Array<{
      id?: string;
      name?: string;
      fields?: Record<string, { name?: string; required?: boolean }>;
    }>;
  }>;
};

type NormalizedCustomField = {
  id: string;
  name: string;
  schemaType: string | null;
  customType: string | null;
  valueText: string | null;
  rawValue?: unknown;
};

const TECHNICAL_FIELD_NAME_RE =
  /^(Rank|Development|\[CHART\] Time in Status)$/i;
const TECHNICAL_CUSTOM_TYPES = new Set([
  "com.pyxis.greenhopper.jira:gh-lexo-rank",
  "com.atlassian.jira.plugins.jira-development-integration-plugin:devsummarycf",
  "com.atlassian.jira.ext.charting:timeinstatus",
]);

const getIssueParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["issue"],
  properties: {
    issue: {
      type: "string",
      description: "Jira issue key or id, for example OPS-73.",
    },
    includeDescription: {
      type: "boolean",
      description:
        "Include the issue description as plain text. Defaults to true.",
    },
    includeComments: {
      type: "boolean",
      description: "Include recent issue comments. Defaults to false.",
    },
    maxComments: {
      type: "number",
      description:
        "Maximum comments to return when includeComments is true. Defaults to 10, maximum 50.",
    },
    customFields: {
      type: "string",
      enum: ["none", "known", "selected", "discoverNonEmpty"],
      description:
        "Custom-field retrieval mode. none is lean. known uses a cached project/issue-type profile. selected fetches customFieldNames. discoverNonEmpty intentionally fetches all fields once, returns non-empty useful custom fields, and updates the profile cache.",
    },
    customFieldNames: {
      type: "array",
      items: { type: "string" },
      description:
        "Custom field names or ids to fetch when customFields is selected, for example Story Points, Team, or customfield_10004.",
    },
    includeRawCustomFieldValues: {
      type: "boolean",
      description:
        "Include raw custom-field JSON values. Defaults to false to keep output small.",
    },
  },
} as const;

const mutateIssueParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      description:
        "Jira issue mutation proposals. No writes happen until explicit user approval in the UI.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          clientId: { type: "string" },
          operation: {
            type: "string",
            enum: ["edit", "create", "comment", "rank", "sprint"],
            description:
              "edit (default): transition/field/link an existing issue. create: create a new issue. comment: add a comment to an issue. rank: reorder issues in a backlog using Jira's Agile ranking API. sprint: change a sprint's name, start/end dates or goal (never its state).",
          },
          issue: {
            type: "string",
            description:
              "Jira issue key or id, for example NEB-441. Required for edit and comment.",
          },
          projectKey: {
            type: "string",
            description:
              "create: project key for the new issue, e.g. OPS. Consider the Project Registry to align with our own projects.",
          },
          issueType: {
            type: "string",
            description:
              "create: issue type name for the new issue, e.g. Task.",
          },
          summary: {
            type: "string",
            description:
              "create: required summary/title. edit: set a new summary.",
          },
          description: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description:
              "create/edit: Markdown description converted to Atlassian Document Format. Set null on edit to clear it. Supports CommonMark/GFM headings, emphasis, links, lists/tasks, quotes, code, rules, tables, images-as-linked-alt-text, and footnotes.",
          },
          commentBody: {
            type: "string",
            description:
              "comment: Markdown body converted to Atlassian Document Format (same CommonMark/GFM support as description).",
          },
          transitionId: {
            type: "string",
            description: "Exact Jira transition id if already known.",
          },
          transitionName: {
            type: "string",
            description:
              "Transition name to apply, for example Discontinued or Done.",
          },
          targetStatus: {
            type: "string",
            description:
              "Desired target status name; matched against available transition target statuses.",
          },
          resolutionName: {
            type: "string",
            description:
              "Resolution to set while transitioning, for example Discontinued. Useful for requests like close as Discontinued.",
          },
          assigneeAccountId: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "Set assignee by Jira accountId, or null to unassign.",
          },
          clearAssignee: {
            type: "boolean",
            description: "Unassign the issue.",
          },
          parentIssue: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description:
              "Set parent issue key/id, or null to clear parent where Jira permits.",
          },
          epicIssue: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description:
              "Set epic using the Epic Link field when available, or null to clear it.",
          },
          labels: {
            type: "object",
            additionalProperties: false,
            properties: {
              set: { type: "array", items: { type: "string" } },
              add: { type: "array", items: { type: "string" } },
              remove: { type: "array", items: { type: "string" } },
            },
          },
          components: {
            type: "object",
            additionalProperties: false,
            properties: {
              set: { type: "array", items: { type: "string" } },
              add: { type: "array", items: { type: "string" } },
              remove: { type: "array", items: { type: "string" } },
            },
          },
          fields: {
            type: "object",
            description:
              "Advanced field updates keyed by Jira field id or name. Values are sent as Jira REST field values after approval.",
          },
          rankIssues: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 50,
            description:
              "rank: issue keys to move, listed in the order they should end up. They must share one project and one hierarchy level (epics rank apart from stories, stories apart from sub-tasks).",
          },
          rankPosition: {
            type: "string",
            enum: ["before", "after", "top", "bottom"],
            description:
              "rank: where the issues land. before/after need rankTargetIssue; top/bottom need rankBoardId or rankParentIssue to bound the backlog they move within.",
          },
          rankTargetIssue: {
            type: "string",
            description:
              "rank: the issue rankPosition=before/after places the first ranked issue against.",
          },
          rankBoardId: {
            type: "integer",
            description:
              "rank: Jira Agile board id. Bounds top/bottom (the board's backlog, or its epic list when ranking epics) and, with before/after, checks the board covers the issues.",
          },
          rankParentIssue: {
            type: "string",
            description:
              "rank: parent issue key whose children bound top/bottom. Every ranked issue must already be a child of it.",
          },
          sprintId: {
            type: "integer",
            description:
              "sprint: Jira sprint id, from jira_lookup kind=sprints or an issue's sprint field.",
          },
          sprintName: {
            type: "string",
            description: "sprint: new sprint name.",
          },
          sprintStartDate: {
            type: "string",
            description:
              "sprint: new start as an ISO 8601 date-time with offset, e.g. 2026-10-13T09:00:00+02:00.",
          },
          sprintEndDate: {
            type: "string",
            description:
              "sprint: new end as an ISO 8601 date-time with offset; must be after the start.",
          },
          sprintGoal: {
            type: "string",
            description: "sprint: new sprint goal; an empty string clears it.",
          },
          linkChanges: {
            type: "array",
            description:
              "Issue link relationships to add or remove for this issue. Use jira_lookup (kind=issueLinkTypes) for exact type names, and jira_get_issue issueLinks[].id for removals.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["op"],
              properties: {
                op: {
                  type: "string",
                  enum: ["add", "remove"],
                  description:
                    "add creates a link; remove deletes an existing link by linkId.",
                },
                type: {
                  type: "string",
                  description:
                    "Link type name or id, e.g. Blocks. Required for op=add.",
                },
                direction: {
                  type: "string",
                  enum: ["inward", "outward"],
                  description:
                    "Direction from this issue: outward uses the type's outward phrase (e.g. 'blocks'); inward uses the inward phrase (e.g. 'is blocked by'). Required for op=add.",
                },
                issue: {
                  type: "string",
                  description:
                    "The other issue's key or id. Required for op=add.",
                },
                linkId: {
                  type: "string",
                  description:
                    "Existing issue link id to remove (from jira_get_issue issueLinks[].id). Required for op=remove.",
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

export const jiraGetIssueTool = defineAgentTool<GetIssueParams>({
  name: "jira_get_issue",
  label: "Jira: Get Issue",
  description:
    "Fetch one Jira issue by key or id from the Atlassian API. Read-only. When you mention the issue, render its key as a Markdown link using the returned issueUrl.",
  parameters: getIssueParamsSchema,
  async execute(params) {
    const issue = normalizeIssueInput(params.issue);
    const includeDescription = params.includeDescription !== false;
    const includeComments = params.includeComments === true;
    const maxComments = clampMaxComments(params.maxComments);
    const customFieldMode = normalizeCustomFieldMode(params.customFields);
    const includeRawCustomFieldValues =
      params.includeRawCustomFieldValues === true;
    const config = getJiraToolConfig();

    const baseFields = [
      ...JIRA_ISSUE_BASE_FIELDS,
      ...(includeDescription ? ["description"] : []),
    ];
    const customResult = await fetchIssueWithCustomFields({
      config,
      issue,
      baseFields,
      mode: customFieldMode,
      customFieldNames: params.customFieldNames ?? [],
      includeRawCustomFieldValues,
    });

    const normalized = normalizeJiraIssue(
      customResult.rawIssue,
      config.jiraHost,
      { includeDescription },
    );
    const comments =
      includeComments && normalized.key
        ? await fetchJiraComments(config, normalized.key, maxComments)
        : null;

    const payload = {
      jiraHost: config.jiraHost,
      issue: {
        ...normalized,
        customFieldMode,
        customFieldProfile: customResult.profileSummary,
        customFields: customResult.customFields,
        ...(customResult.suppressedTechnicalCustomFields.length > 0
          ? {
              suppressedTechnicalCustomFields:
                customResult.suppressedTechnicalCustomFields,
            }
          : {}),
        ...(comments ? { comments } : {}),
      },
    };

    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      details: payload,
    };
  },
});

const jiraSearchIssuesTool = defineAgentTool<SearchIssuesParams>({
  name: "jira_search_issues",
  label: "Jira: Search Issues",
  description: JIRA_SEARCH_ISSUES_DESCRIPTION,
  parameters: searchIssuesParamsSchema,
  async execute(params, ctx) {
    // An empty or overlong JQL is refused before the settings are read.
    normalizeJql(params.jql);
    const config = getJiraToolConfig();
    const payload = await runJiraSearchIssues(config, params, {
      signal: ctx.signal,
      fieldMap: () => getJiraFieldMap(config),
    });
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      details: payload,
    };
  },
});

export const jiraLookupTool = defineAgentTool<LookupParams>({
  name: "jira_lookup",
  label: "Jira: Lookup",
  description: JIRA_LOOKUP_DESCRIPTION,
  parameters: lookupParamsSchema,
  async execute(params, ctx) {
    const config = getJiraToolConfig();
    const payload = await runJiraLookup(config, params, {
      signal: ctx.signal,
      fieldMap: () => getJiraFieldMap(config),
      issueLinkTypes: () => getJiraIssueLinkTypes(config),
    });
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      details: payload,
    };
  },
});

/**
 * @payload JiraIssueMutationDisplay
 * @purpose Structured approval proposal/result for Jira creates, Markdown content, fields, transitions, comments, and native links.
 * @renderWhen The tool always returns a bounded approval payload; agents should use it only after explicit user intent to prepare Jira writes.
 * @bounds Up to 10 issue updates; Jira execution is deferred until the user approves in the client UI.
 * @client Render as a mutation-capable approval card with clear pending/executed/failed state and persisted result entry ids.
 */
export const jiraMutateIssueTool = defineAgentTool<JiraMutationParams>({
  name: "jira_mutate_issue",
  label: "Jira: Prepare Issue Changes",
  description:
    "Prepare Jira proposals — create tickets/sub-tasks, edit fields and Markdown-formatted content, add Markdown comments, and add/remove native issue links. CommonMark/GFM is converted to Atlassian Document Format. This tool never writes immediately: it validates and persists a pending approval record with an approval button. Set item.operation to edit (default), create, comment, rank, or sprint; rank reorders a backlog through Jira's Agile ranking API (before/after another issue, or top/bottom of a board backlog or a parent's children) instead of writing the opaque rank field; sprint edits a sprint's name, dates or goal, which no issue field reaches. Use it only when the user explicitly asks to change, transition, assign, label, link, create, comment on, or reorder an issue, or to edit a sprint, and ask rather than prepare a proposal when the target issue or value is ambiguous. On create, prefer a project that aligns with our own work — consult the Project Registry when unsure and confirm project and issue type with the user; never set the Cost Center, which Jira automation derives from the ticket.",
  parameters: mutateIssueParamsSchema,
  async execute(params, ctx) {
    const config = getJiraToolConfig();
    const { items, warnings } = await buildJiraMutationItems(
      config,
      params.items ?? [],
      ctx.signal,
    );
    const title = jiraMutationTitle(items);
    const labels = items.map(jiraMutationItemLabel);
    const summary = [
      labels.join(", "),
      warnings.length ? `${warnings.length} warning(s)` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const card = createApproval({
      sessionId: ctx.session.sessionId,
      kind: "jiraIssue",
      title,
      ...(summary ? { summary: summary } : {}),
      sourceToolCallId: ctx.toolCallId,
      body: { kind: "jiraIssue", jiraHost: config.jiraHost, items },
    });
    const warnLine = warnings.length
      ? ` Warnings: ${warnings.join("; ")}.`
      : "";
    const text = `Prepared a Jira edit proposal for ${items.length} issue(s) pending your approval.${warnLine} Do not claim Jira changed until the approved result appears. ${approvalCardReference(card)}`;
    return { content: [{ type: "text", text }], terminate: true };
  },
});

/** Short human label for one mutation item (edit/create/comment). */
function jiraMutationItemLabel(item: JiraIssueMutationItemDisplay): string {
  if (item.operation === "create")
    return `create ${item.createProjectKey ?? "?"} ${item.createIssueType ?? ""}`.trim();
  if (item.operation === "comment") return `comment ${item.issueKey}`;
  if (item.operation === "rank")
    return `rank ${(item.rankIssueKeys ?? []).join(", ")} ${item.rankPosition ?? ""}`.trim();
  if (item.operation === "sprint") return jiraSprintItemLabel(item);
  return item.issueKey;
}

/** Approval-card title reflecting the mix of operations. */
function jiraMutationTitle(items: JiraIssueMutationItemDisplay[]): string {
  if (items.length === 1) {
    const item = items[0]!;
    if (item.operation === "create")
      return `Create ${item.createProjectKey ?? ""} issue`
        .replace(/\s+/g, " ")
        .trim();
    if (item.operation === "comment") return `Comment on ${item.issueKey}`;
    if (item.operation === "rank") {
      const count = item.rankIssueKeys?.length ?? 0;
      return count === 1
        ? `Rank ${item.rankIssueKeys?.[0]} ${item.rankPosition ?? ""}`.trim()
        : `Rank ${count} Jira issues`;
    }
    if (item.operation === "sprint")
      return `Edit sprint ${item.sprint?.name ?? ""}`.trim();
    return `Edit ${item.issueKey}`;
  }
  const kinds = new Set(items.map((item) => item.operation ?? "edit"));
  if (kinds.size === 1) {
    const only = [...kinds][0];
    if (only === "create") return `Create ${items.length} Jira issues`;
    if (only === "comment") return `Comment on ${items.length} Jira issues`;
    if (only === "rank") return `Rank ${items.length} Jira backlogs`;
    if (only === "sprint") return `Edit ${items.length} Jira sprints`;
  }
  return `${items.length} Jira changes`;
}

/** Execute an approved Jira issue mutation: apply each item, recording per-item results. */
registerApprovalExecutor("jiraIssue", {
  async execute(card: ApprovalCard) {
    if (card.body.kind !== "jiraIssue")
      throw new Error("Mismatched approval body for jiraIssue.");
    const items = card.body.items;
    const config = getJiraToolConfig();
    let succeeded = 0;
    for (const item of items) {
      try {
        await executeJiraMutationItem(config, item);
        // executeJiraMutationItem sets resultIssueUrl for create/comment; for edit fill it in here.
        if (!item.resultIssueUrl)
          item.resultIssueUrl =
            item.issueUrl ?? jiraIssueUrlFromHost(item.issueKey);
        delete item.error;
        succeeded += 1;
      } catch (err) {
        item.error = errorText(err);
      }
    }
    if (succeeded === 0)
      throw new Error(
        `All ${items.length} Jira change(s) failed: ${items
          .map((item) => item.error)
          .filter(Boolean)
          .join("; ")}`,
      );
    const failed = items.length - succeeded;
    const warned = items.filter((item) => item.warning).length;
    const created = items
      .filter((item) => item.operation === "create" && item.resultIssueKey)
      .map((item) => item.resultIssueKey);
    const base = created.length
      ? `Applied ${succeeded} change(s) (created ${created.join(", ")})`
      : `Applied ${succeeded} change(s)`;
    // Ranking's whole point is the resulting sequence, so report what Jira shows now.
    const orderings = items
      .filter(
        (item) => item.operation === "rank" && item.rankResultOrder?.length,
      )
      .map((item) => `order now ${item.rankResultOrder!.join(" → ")}`);
    // Sprint dates are the point of a sprint edit, so report what Jira holds now.
    const sprints = items.map(jiraSprintResultText).filter(Boolean);
    const diagnostics = [
      failed ? `${failed} failed` : "",
      warned ? `${warned} warning(s)` : "",
      ...orderings,
      ...sprints,
    ].filter(Boolean);
    const resultIssueUrl = items.find(
      (item) => item.resultIssueUrl,
    )?.resultIssueUrl;
    return {
      resultSummary: diagnostics.length
        ? `${base}; ${diagnostics.join("; ")}`
        : base,
      ...(resultIssueUrl != null ? { resultUrl: resultIssueUrl } : {}),
    };
  },
});

export const assistantJiraTools = [
  jiraGetIssueTool,
  jiraSearchIssuesTool,
  jiraLookupTool,
  jiraMutateIssueTool,
];

async function fetchIssueWithCustomFields({
  config,
  issue,
  baseFields,
  mode,
  customFieldNames,
  includeRawCustomFieldValues,
}: {
  config: ReturnType<typeof getJiraToolConfig>;
  issue: string;
  baseFields: string[];
  mode: CustomFieldMode;
  customFieldNames: string[];
  includeRawCustomFieldValues: boolean;
}): Promise<{
  rawIssue: JiraIssueResponse;
  customFields: NormalizedCustomField[];
  suppressedTechnicalCustomFields: NormalizedCustomField[];
  profileSummary: Record<string, unknown> | null;
}> {
  if (mode === "discoverNonEmpty") {
    const rawIssue = await jiraGet<JiraIssueResponse>(
      config,
      `/rest/api/3/issue/${encodeURIComponent(issue)}`,
      {
        fields: "*all",
        expand: "names,schema",
      },
    );
    const normalized = normalizeCustomFields(rawIssue, {
      includeEmpty: false,
      includeRaw: includeRawCustomFieldValues,
      suppressTechnical: !includeRawCustomFieldValues,
    });
    const profile = learnProfile(
      config.jiraHost,
      rawIssue,
      normalized.customFields,
    );
    return {
      rawIssue,
      customFields: normalized.customFields,
      suppressedTechnicalCustomFields:
        normalized.suppressedTechnicalCustomFields,
      profileSummary: profile ? summarizeProfile(profile, "updated") : null,
    };
  }

  if (mode === "selected") {
    const selectedIds = await resolveSelectedCustomFieldIds(
      config,
      customFieldNames,
    );
    const rawIssue = await jiraGet<JiraIssueResponse>(
      config,
      `/rest/api/3/issue/${encodeURIComponent(issue)}`,
      {
        fields: [...baseFields, ...selectedIds].join(","),
        expand: "names,schema",
      },
    );
    const normalized = normalizeCustomFields(rawIssue, {
      includeEmpty: true,
      includeRaw: includeRawCustomFieldValues,
      onlyFieldIds: new Set(selectedIds),
      suppressTechnical: false,
    });
    return {
      rawIssue,
      customFields: normalized.customFields,
      suppressedTechnicalCustomFields: [],
      profileSummary: {
        mode: "selected",
        requested: customFieldNames,
        resolvedFieldIds: selectedIds,
      },
    };
  }

  const rawIssue = await jiraGet<JiraIssueResponse>(
    config,
    `/rest/api/3/issue/${encodeURIComponent(issue)}`,
    {
      fields: baseFields.join(","),
    },
  );

  if (mode === "known") {
    const projectKey = rawIssue.fields?.project?.key ?? null;
    const issueTypeId = rawIssue.fields?.issuetype?.id ?? null;
    const profile = getCustomFieldProfile(
      config.jiraHost,
      projectKey,
      issueTypeId,
    );
    if (!profile || profile.fields.length === 0) {
      return {
        rawIssue,
        customFields: [],
        suppressedTechnicalCustomFields: [],
        profileSummary: {
          mode: "known",
          found: false,
          projectKey,
          issueTypeId,
          guidance:
            "Use customFields=discoverNonEmpty once for a representative issue to learn this project/issue-type profile.",
        },
      };
    }

    const fieldIds = profile.fields.map((field) => field.id);
    const rawCustom = await jiraGet<JiraIssueResponse>(
      config,
      `/rest/api/3/issue/${encodeURIComponent(rawIssue.key ?? issue)}`,
      {
        fields: fieldIds.join(","),
        expand: "names,schema",
      },
    );
    const normalized = normalizeCustomFields(rawCustom, {
      includeEmpty: false,
      includeRaw: includeRawCustomFieldValues,
      onlyFieldIds: new Set(fieldIds),
      suppressTechnical: true,
    });
    return {
      rawIssue,
      customFields: normalized.customFields,
      suppressedTechnicalCustomFields:
        normalized.suppressedTechnicalCustomFields,
      profileSummary: summarizeProfile(profile, "used"),
    };
  }

  return {
    rawIssue,
    customFields: [],
    suppressedTechnicalCustomFields: [],
    profileSummary: null,
  };
}

async function resolveSelectedCustomFieldIds(
  config: ReturnType<typeof getJiraToolConfig>,
  customFieldNames: string[],
): Promise<string[]> {
  const names = customFieldNames.map((name) => name.trim()).filter(Boolean);
  if (names.length === 0)
    throw new Error(
      "customFieldNames must contain at least one custom field name or id when customFields is selected.",
    );
  const directIds = names.filter((name) => /^customfield_\d+$/.test(name));
  const nameLookups = names.filter((name) => !/^customfield_\d+$/.test(name));
  if (nameLookups.length === 0) return unique(directIds);

  const fieldMap = await getJiraFieldMap(config);
  const resolved = [...directIds];
  const missing: string[] = [];
  for (const name of nameLookups) {
    const field = resolveFieldName(fieldMap, name);
    if (!field?.id || !field.custom) missing.push(name);
    else resolved.push(field.id);
  }
  if (missing.length > 0)
    throw new Error(
      `Could not resolve custom field name(s): ${missing.join(", ")}. Try using customfield_ ids or run discovery first.`,
    );
  return unique(resolved);
}

function normalizeCustomFields(
  issue: JiraIssueResponse,
  options: {
    includeEmpty: boolean;
    includeRaw: boolean;
    suppressTechnical: boolean;
    onlyFieldIds?: Set<string>;
  },
): {
  customFields: NormalizedCustomField[];
  suppressedTechnicalCustomFields: NormalizedCustomField[];
} {
  const out: NormalizedCustomField[] = [];
  const suppressed: NormalizedCustomField[] = [];
  const fields = issue.fields ?? {};
  for (const [id, value] of Object.entries(fields)) {
    if (!id.startsWith("customfield_")) continue;
    if (options.onlyFieldIds && !options.onlyFieldIds.has(id)) continue;
    if (!options.includeEmpty && isEmptyValue(value)) continue;
    const item = normalizeCustomField(
      id,
      value,
      issue.names,
      issue.schema,
      options.includeRaw,
    );
    if (options.suppressTechnical && isTechnicalCustomField(item))
      suppressed.push(item);
    else out.push(item);
  }
  return {
    customFields: out.sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    ),
    suppressedTechnicalCustomFields: suppressed.sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    ),
  };
}

function normalizeCustomField(
  id: string,
  value: unknown,
  names: Record<string, string> | undefined,
  schema: Record<string, JiraFieldSchema> | undefined,
  includeRaw: boolean,
): NormalizedCustomField {
  const fieldSchema = schema?.[id];
  return {
    id,
    name: names?.[id] ?? id,
    schemaType: fieldSchema?.type ?? null,
    customType: fieldSchema?.custom ?? null,
    valueText: valueToText(value),
    ...(includeRaw ? { rawValue: value } : {}),
  };
}

function learnProfile(
  jiraHost: string,
  issue: JiraIssueResponse,
  customFields: NormalizedCustomField[],
): JiraCustomFieldProfile | null {
  const projectKey = issue.fields?.project?.key;
  const issueTypeId = issue.fields?.issuetype?.id;
  if (!projectKey || !issueTypeId) return null;
  return updateCustomFieldProfile(jiraHost, {
    projectKey,
    issueTypeId,
    issueTypeName: issue.fields?.issuetype?.name ?? null,
    learnedFromIssue: issue.key ?? null,
    fields: customFields
      .filter((field) => !isTechnicalCustomField(field))
      .map((field) => ({
        id: field.id,
        name: field.name,
        schemaType: field.schemaType,
        customType: field.customType,
      })),
  });
}

function summarizeProfile(
  profile: JiraCustomFieldProfile,
  action: "used" | "updated",
) {
  return {
    mode: "known",
    action,
    found: true,
    projectKey: profile.projectKey,
    issueTypeId: profile.issueTypeId,
    issueTypeName: profile.issueTypeName,
    learnedAt: profile.learnedAt,
    learnedFromIssue: profile.learnedFromIssue,
    fieldCount: profile.fields.length,
  };
}

function jiraIssueUrlFromHost(issueKey: string): string | null {
  const config = getJiraToolConfig();
  return `${jiraBaseUrl(config.jiraHost)}/browse/${encodeURIComponent(issueKey)}`;
}

async function buildJiraMutationItems(
  config: ReturnType<typeof getJiraToolConfig>,
  input: JiraMutationItemInput[],
  signal?: AbortSignal,
): Promise<{ items: JiraIssueMutationItemDisplay[]; warnings: string[] }> {
  if (!Array.isArray(input) || input.length === 0)
    throw new Error("At least one Jira issue mutation item is required.");
  if (input.length > 10)
    throw new Error(
      "At most 10 Jira issue mutation items are supported per approval.",
    );
  const warnings: string[] = [];
  const items: JiraIssueMutationItemDisplay[] = [];
  let linkTypesPromise: Promise<JiraIssueLinkType[]> | undefined;
  const loadLinkTypes = () =>
    (linkTypesPromise ??= getJiraIssueLinkTypes(config));
  for (let index = 0; index < input.length; index += 1) {
    const raw = input[index]!;
    const operation = raw.operation ?? "edit";
    const clientId = raw.clientId?.trim() || `item-${index + 1}`;

    if (operation === "create") {
      const projectKey = raw.projectKey?.trim();
      const issueType = raw.issueType?.trim();
      const summary = raw.summary?.trim();
      if (!projectKey)
        throw new Error(`create item ${clientId} requires projectKey.`);
      if (!issueType)
        throw new Error(`create item ${clientId} requires issueType.`);
      if (!summary)
        throw new Error(`create item ${clientId} requires summary.`);
      const description = normalizeOptionalMarkdown(raw.description);
      const fieldChanges: JiraIssueMutationFieldChangeDisplay[] = [];
      addKnownFieldChange(fieldChanges, raw, { fields: {} });
      await addAdvancedFieldChanges(config, fieldChanges, raw.fields, {});
      await assertCreateFieldsAvailable(
        config,
        projectKey,
        issueType,
        description,
        fieldChanges,
      );
      const linkChanges = await buildLinkChanges(
        "new issue",
        raw.linkChanges ?? [],
        loadLinkTypes,
      );
      await assertLinkPermissions(config, null, linkChanges);
      const parentIssue = raw.parentIssue
        ? normalizeIssueInput(raw.parentIssue).toUpperCase()
        : null;
      items.push({
        clientId,
        issueKey: "",
        operation: "create",
        createProjectKey: projectKey.toUpperCase(),
        createIssueType: issueType,
        createSummary: summary,
        ...(description ? { createDescription: description } : {}),
        ...(parentIssue ? { createParentIssue: parentIssue } : {}),
        fieldChanges,
        ...(linkChanges.length > 0 ? { linkChanges } : {}),
      });
      continue;
    }

    if (operation === "rank") {
      const built = await buildJiraRankItem(config, clientId, raw);
      items.push(built.item);
      warnings.push(...built.warnings);
      continue;
    }

    if (operation === "sprint") {
      items.push(await buildJiraSprintItem(config, clientId, raw));
      continue;
    }

    if (operation === "comment") {
      if (!raw.issue?.trim())
        throw new Error(`comment item ${clientId} requires issue.`);
      const body = normalizeOptionalMarkdown(raw.commentBody);
      if (!body)
        throw new Error(`comment item ${clientId} requires commentBody.`);
      const key = normalizeIssueInput(raw.issue).toUpperCase();
      await assertIssuePermission(config, key, "ADD_COMMENTS", "comment on");
      items.push({
        clientId,
        issueKey: key,
        operation: "comment",
        issueUrl: jiraIssueUrlFromHost(key),
        commentBody: body,
        fieldChanges: [],
      });
      continue;
    }

    if (!raw.issue?.trim())
      throw new Error(`edit item ${clientId} requires issue.`);
    const issue = normalizeIssueInput(raw.issue).toUpperCase();
    const current = await jiraGet<JiraIssueResponse>(
      config,
      `/rest/api/3/issue/${encodeURIComponent(issue)}`,
      {
        fields: "summary,description,status,assignee,labels,components,parent",
        expand: "names",
      },
    );
    const key = current.key ?? issue;
    const fieldChanges: JiraIssueMutationFieldChangeDisplay[] = [];
    const transition = await resolveRequestedTransition(config, key, raw);
    if (transition) {
      fieldChanges.push({
        fieldId: "status",
        label: "Status",
        from: current.fields?.status?.name ?? null,
        to: transition.to?.name ?? transition.name ?? null,
        operation: "transition",
      });
      const resolutionName =
        raw.resolutionName?.trim() || transition.fallbackResolutionName;
      if (resolutionName)
        fieldChanges.push({
          fieldId: "resolution",
          label: "Resolution",
          from: valueToText(current.fields?.resolution),
          to: resolutionName,
          operation: "set",
          value: { name: resolutionName },
        });
    }
    addKnownFieldChange(fieldChanges, raw, current);
    if (Object.prototype.hasOwnProperty.call(raw, "summary")) {
      const summary = raw.summary?.trim();
      if (!summary)
        throw new Error(`edit item ${clientId} summary must not be empty.`);
      fieldChanges.push({
        fieldId: "summary",
        label: "Summary",
        from: valueToText(current.fields?.summary),
        to: summary,
        operation: "set",
        value: summary,
      });
    }
    if (Object.prototype.hasOwnProperty.call(raw, "description")) {
      const description = normalizeOptionalMarkdown(raw.description);
      fieldChanges.push({
        fieldId: "description",
        label: "Description",
        from: valueToText(current.fields?.description),
        to: description ? truncate(description) : null,
        operation: "set",
        value: description ?? null,
      });
    }
    await addAdvancedFieldChanges(
      config,
      fieldChanges,
      raw.fields,
      current.fields ?? {},
    );
    await assertEditableContentFields(config, key, fieldChanges);
    const linkChanges = await buildLinkChanges(
      key,
      raw.linkChanges ?? [],
      loadLinkTypes,
    );
    await assertLinkPermissions(config, key, linkChanges);
    if (!transition && fieldChanges.length === 0 && linkChanges.length === 0)
      throw new Error(
        `No transition, field update, or link change was requested for ${key}.`,
      );
    items.push({
      clientId,
      issueKey: key,
      operation: "edit",
      issueId: current.id ?? null,
      issueUrl: jiraIssueUrlFromHost(key),
      issueSummary: current.fields?.summary ?? null,
      currentStatus: current.fields?.status?.name ?? null,
      targetTransitionId: transition?.id ?? null,
      targetTransitionName: transition?.name ?? null,
      targetStatus: transition?.to?.name ?? null,
      fieldChanges,
      ...(linkChanges.length > 0 ? { linkChanges } : {}),
    });
  }
  await nameUserFieldChanges(config, items, signal);
  return { items, warnings: unique(warnings) };
}

/** Account ids a user-valued change writes: `{ accountId }` or a list of them. */
function userAccountIds(value: unknown): string[] | null {
  const values = Array.isArray(value) ? value : [value];
  const ids = values.map((entry) =>
    entry && typeof entry === "object" && "accountId" in entry
      ? (entry as { accountId?: unknown }).accountId
      : undefined,
  );
  return ids.length > 0 && ids.every((id) => typeof id === "string" && id)
    ? (ids as string[])
    : null;
}

/** Shows user-valued changes by display name; the account ids stay in `value` for the write. */
async function nameUserFieldChanges(
  config: ReturnType<typeof getJiraToolConfig>,
  items: JiraIssueMutationItemDisplay[],
  signal: AbortSignal | undefined,
): Promise<void> {
  const changes = items
    .flatMap((item) => item.fieldChanges)
    .map((change) => ({ change, ids: userAccountIds(change.value) }))
    .filter(
      (
        entry,
      ): entry is {
        change: JiraIssueMutationFieldChangeDisplay;
        ids: string[];
      } => entry.ids !== null,
    );
  if (changes.length === 0) return;
  // A name is presentation only: an unresolvable id still stages, shown as itself.
  const names = await proposalSnapshot(
    () =>
      resolveUserNames(
        config,
        changes.flatMap((entry) => entry.ids),
        signal,
      ),
    signal,
  );
  for (const { change, ids } of changes)
    change.to = ids.map((id) => names?.get(id) ?? id).join(", ");
}

async function buildLinkChanges(
  subjectKey: string,
  input: JiraLinkChangeInput[],
  loadLinkTypes: () => Promise<JiraIssueLinkType[]>,
): Promise<JiraIssueLinkChangeDisplay[]> {
  if (!Array.isArray(input) || input.length === 0) return [];
  const changes: JiraIssueLinkChangeDisplay[] = [];
  for (const raw of input) {
    if (raw.op !== "add" && raw.op !== "remove")
      throw new Error(
        `Link change op must be "add" or "remove" for ${subjectKey}.`,
      );
    if (raw.op === "remove") {
      const linkId = raw.linkId?.trim();
      if (!linkId)
        throw new Error(
          `Link removal for ${subjectKey} requires linkId (from jira_get_issue issueLinks[].id).`,
        );
      changes.push({
        op: "remove",
        type: raw.type?.trim() || "link",
        direction: raw.direction === "inward" ? "inward" : "outward",
        relationship: "unlink",
        targetIssueKey: raw.issue
          ? normalizeIssueInput(raw.issue).toUpperCase()
          : "",
        targetIssueUrl: raw.issue
          ? jiraIssueUrlFromHost(normalizeIssueInput(raw.issue).toUpperCase())
          : null,
        linkId,
      });
      continue;
    }
    const typeName = raw.type?.trim();
    if (!typeName)
      throw new Error(
        `Link creation for ${subjectKey} requires a link type (see jira_lookup kind=issueLinkTypes).`,
      );
    if (raw.direction !== "inward" && raw.direction !== "outward")
      throw new Error(
        `Link creation for ${subjectKey} requires direction "inward" or "outward".`,
      );
    if (!raw.issue?.trim())
      throw new Error(
        `Link creation for ${subjectKey} requires the other issue key or id.`,
      );
    const linkType = resolveIssueLinkType(await loadLinkTypes(), typeName);
    if (!linkType)
      throw new Error(
        `Unknown Jira issue link type "${typeName}". Use jira_lookup (kind=issueLinkTypes) for exact names.`,
      );
    const target = normalizeIssueInput(raw.issue).toUpperCase();
    changes.push({
      op: "add",
      type: linkType.name,
      direction: raw.direction,
      relationship:
        raw.direction === "outward" ? linkType.outward : linkType.inward,
      targetIssueKey: target,
      targetIssueUrl: jiraIssueUrlFromHost(target),
    });
  }
  return changes;
}

async function assertCreateFieldsAvailable(
  config: ReturnType<typeof getJiraToolConfig>,
  projectKey: string,
  issueType: string,
  description: string | undefined,
  changes: JiraIssueMutationFieldChangeDisplay[],
): Promise<void> {
  const requested = [
    ...(description ? [{ fieldId: "description", label: "Description" }] : []),
    ...changes.filter(
      (change) => change.fieldId !== "parent" && change.fieldId !== "Epic Link",
    ),
  ];
  if (requested.length === 0) return;
  const meta = await jiraGet<JiraCreateMetaResponse>(
    config,
    "/rest/api/3/issue/createmeta",
    {
      projectKeys: projectKey,
      issuetypeNames: issueType,
      expand: "projects.issuetypes.fields",
    },
  );
  const type = meta.projects
    ?.flatMap((project) => project.issuetypes ?? [])
    .find(
      (candidate) => candidate.name?.toLowerCase() === issueType.toLowerCase(),
    );
  if (!type)
    throw new Error(
      `Jira did not return create-screen metadata for ${projectKey} ${issueType}.`,
    );
  const unavailable = requested
    .filter((change) => !type.fields?.[change.fieldId])
    .map((change) => change.label);
  if (unavailable.length > 0) {
    throw new Error(
      `${unavailable.join(", ")} cannot be set while creating ${projectKey} ${issueType}: ${unavailable.length === 1 ? "the field is" : "the fields are"} not available on this Jira create screen.`,
    );
  }
}

async function assertEditableContentFields(
  config: ReturnType<typeof getJiraToolConfig>,
  issueKey: string,
  changes: JiraIssueMutationFieldChangeDisplay[],
): Promise<void> {
  const requested = changes.filter(
    (change) =>
      change.fieldId === "summary" || change.fieldId === "description",
  );
  if (requested.length === 0) return;
  const meta = await jiraGet<JiraEditMetaResponse>(
    config,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/editmeta`,
  );
  const unavailable = requested
    .filter((change) => !meta.fields?.[change.fieldId])
    .map((change) => change.label);
  if (unavailable.length > 0) {
    throw new Error(
      `${unavailable.join(", ")} cannot be edited on ${issueKey}: ${unavailable.length === 1 ? "the field is" : "the fields are"} not available on this issue's Jira edit screen.`,
    );
  }
}

async function assertLinkPermissions(
  config: ReturnType<typeof getJiraToolConfig>,
  subjectKey: string | null,
  changes: JiraIssueLinkChangeDisplay[],
): Promise<void> {
  if (changes.length === 0) return;
  const issues = unique([
    ...(subjectKey ? [subjectKey] : []),
    ...changes
      .filter((change) => change.op === "add")
      .map((change) => change.targetIssueKey)
      .filter(Boolean),
  ]);
  for (const issue of issues)
    await assertIssuePermission(config, issue, "LINK_ISSUES", "link");
}

async function resolveRequestedTransition(
  config: ReturnType<typeof getJiraToolConfig>,
  issueKey: string,
  raw: JiraMutationItemInput,
): Promise<JiraTransition | null> {
  const wantedId = raw.transitionId?.trim();
  const wantedName = raw.transitionName?.trim();
  const wantedStatus = raw.targetStatus?.trim();
  if (!wantedId && !wantedName && !wantedStatus && !raw.resolutionName?.trim())
    return null;
  const response = await jiraGet<JiraTransitionsResponse>(
    config,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
    { expand: "transitions.fields" },
  );
  const transitions = response.transitions ?? [];
  const normalizedName = (wantedName ?? "").toLowerCase();
  const normalizedStatus = (wantedStatus ?? "").toLowerCase();
  const match =
    transitions.find((transition) => wantedId && transition.id === wantedId) ??
    transitions.find(
      (transition) =>
        normalizedName && transition.name?.toLowerCase() === normalizedName,
    ) ??
    transitions.find(
      (transition) =>
        normalizedStatus &&
        transition.to?.name?.toLowerCase() === normalizedStatus,
    ) ??
    (raw.resolutionName?.trim()
      ? findClosedTransition(transitions)
      : undefined);
  if (match?.id) return match;

  const closedFallback =
    wantedName && !wantedStatus && !wantedId
      ? findClosedTransition(transitions)
      : undefined;
  if (closedFallback?.id)
    return {
      ...closedFallback,
      ...(wantedName !== undefined
        ? { fallbackResolutionName: wantedName }
        : {}),
    };

  const choices = transitions
    .map(
      (transition) =>
        `${transition.id ?? "?"}:${transition.name ?? "?"}${transition.to?.name ? ` -> ${transition.to.name}` : ""}`,
    )
    .join(", ");
  throw new Error(
    `Requested transition is not available for ${issueKey}. Available transitions: ${choices || "none"}`,
  );
}

function findClosedTransition(
  transitions: JiraTransition[],
): JiraTransition | undefined {
  return transitions.find(
    (transition) =>
      /^(closed|done)$/i.test(transition.to?.name ?? "") ||
      /^(closed|done)$/i.test(transition.name ?? ""),
  );
}

function addKnownFieldChange(
  changes: JiraIssueMutationFieldChangeDisplay[],
  raw: JiraMutationItemInput,
  current: JiraIssueResponse,
): void {
  const fields = current.fields ?? {};
  if (
    raw.clearAssignee ||
    Object.prototype.hasOwnProperty.call(raw, "assigneeAccountId")
  ) {
    const accountId =
      raw.clearAssignee || raw.assigneeAccountId === null
        ? null
        : raw.assigneeAccountId?.trim();
    if (accountId === "" || accountId === undefined)
      throw new Error(
        "assigneeAccountId must be a Jira accountId; use null to unassign.",
      );
    changes.push({
      fieldId: "assignee",
      label: "Assignee",
      from: valueToText(fields.assignee),
      to: accountId ?? "Unassigned",
      operation: "set",
      value: accountId ? { accountId } : null,
    });
  }
  if (Object.prototype.hasOwnProperty.call(raw, "parentIssue"))
    changes.push({
      fieldId: "parent",
      label: "Parent",
      from: valueToText(fields.parent),
      to: normalizeOptionalIssue(raw.parentIssue),
      operation: "set",
    });
  if (Object.prototype.hasOwnProperty.call(raw, "epicIssue"))
    changes.push({
      fieldId: "Epic Link",
      label: "Epic",
      from: null,
      to: normalizeOptionalIssue(raw.epicIssue),
      operation: "set",
    });
  addCollectionChange(changes, "labels", "Labels", fields.labels, raw.labels);
  addCollectionChange(
    changes,
    "components",
    "Components",
    fields.components,
    raw.components,
  );
}

async function addAdvancedFieldChanges(
  config: ReturnType<typeof getJiraToolConfig>,
  changes: JiraIssueMutationFieldChangeDisplay[],
  fields: Record<string, unknown> | undefined,
  currentFields: Record<string, unknown>,
): Promise<void> {
  const rawFieldNames = Object.keys(fields ?? {});
  if (rawFieldNames.length === 0) return;
  const resolution = resolveJiraFieldInputs(
    await getJiraFieldMap(config),
    rawFieldNames,
  );
  if (resolution.unresolved.length > 0)
    throw new Error(
      `Could not resolve Jira field(s): ${resolution.unresolved.join(", ")}`,
    );
  for (
    let fieldIndex = 0;
    fieldIndex < resolution.requested.length;
    fieldIndex += 1
  ) {
    const requested = resolution.requested[fieldIndex]!;
    const fieldId = resolution.apiFieldIds[fieldIndex] ?? requested;
    const rawValue = fields?.[rawFieldNames[fieldIndex]!];
    changes.push({
      fieldId,
      label: requested,
      from: valueToText(currentFields[fieldId]) ?? null,
      to: valueToText(rawValue) ?? null,
      operation: "set",
      value: rawValue,
    });
  }
}

function addCollectionChange(
  changes: JiraIssueMutationFieldChangeDisplay[],
  fieldId: string,
  label: string,
  current: unknown,
  patch: { set?: string[]; add?: string[]; remove?: string[] } | undefined,
): void {
  if (!patch) return;
  const set = normalizeStringList(patch.set);
  const add = normalizeStringList(patch.add);
  const remove = normalizeStringList(patch.remove);
  if (set.length === 0 && add.length === 0 && remove.length === 0) return;
  const parts = [
    set.length ? `set ${set.join(", ")}` : "",
    add.length ? `add ${add.join(", ")}` : "",
    remove.length ? `remove ${remove.join(", ")}` : "",
  ].filter(Boolean);
  changes.push({
    fieldId,
    label,
    from: valueToText(current),
    to: parts.join("; "),
    operation: set.length ? "set" : "update",
  });
}

async function executeJiraMutationItem(
  config: ReturnType<typeof getJiraToolConfig>,
  item: JiraIssueMutationItemDisplay,
): Promise<void> {
  if (item.operation === "create") {
    const mutation = await buildExecutionFieldPayload(
      config,
      item.fieldChanges,
    );
    const fields: Record<string, unknown> = {
      project: { key: item.createProjectKey },
      issuetype: { name: item.createIssueType },
      summary: item.createSummary,
      ...mutation.fields,
    };
    if (item.createDescription)
      fields.description = markdownToAdf(item.createDescription);
    const created = await jiraPost<{ key?: string }>(
      config,
      "/rest/api/3/issue",
      {
        fields,
        ...(Object.keys(mutation.update).length
          ? { update: mutation.update }
          : {}),
      },
    );
    if (!created.key)
      throw new Error("Jira did not return a key for the created issue.");
    item.resultIssueKey = created.key;
    item.issueKey = created.key;
    item.resultIssueUrl = jiraIssueUrlFromHost(created.key);
    const linkErrors = await executeLinkChanges(config, item);
    // Clearing matters: a re-executed card must not keep a stale warning.
    if (linkErrors.length > 0)
      item.warning = `Issue created, but ${linkErrors.join("; ")}`;
    else delete item.warning;
    return;
  }

  if (item.operation === "rank") {
    await executeJiraRankItem(config, item);
    return;
  }

  if (item.operation === "sprint") {
    await executeJiraSprintItem(config, item);
    return;
  }

  if (item.operation === "comment") {
    if (!item.commentBody) throw new Error("Missing comment body.");
    await jiraPost(
      config,
      `/rest/api/3/issue/${encodeURIComponent(item.issueKey)}/comment`,
      { body: markdownToAdf(item.commentBody) },
    );
    item.resultIssueUrl = item.issueUrl ?? jiraIssueUrlFromHost(item.issueKey);
    return;
  }

  const linkErrors = await executeLinkChanges(config, item);
  const { fields, update } = await buildExecutionFieldPayload(
    config,
    item.fieldChanges,
  );
  if (item.targetTransitionId) {
    await jiraPost(
      config,
      `/rest/api/3/issue/${encodeURIComponent(item.issueKey)}/transitions`,
      {
        transition: { id: item.targetTransitionId },
        ...(Object.keys(fields).length ? { fields } : {}),
        ...(Object.keys(update).length ? { update } : {}),
      },
    );
  } else if (Object.keys(fields).length || Object.keys(update).length) {
    await jiraPut(
      config,
      `/rest/api/3/issue/${encodeURIComponent(item.issueKey)}`,
      { fields, update },
    );
  }

  if (linkErrors.length > 0) throw new Error(linkErrors.join("; "));
}

async function buildExecutionFieldPayload(
  config: ReturnType<typeof getJiraToolConfig>,
  changes: JiraIssueMutationFieldChangeDisplay[],
): Promise<{
  fields: Record<string, unknown>;
  update: Record<string, unknown[]>;
}> {
  const fields: Record<string, unknown> = {};
  const update: Record<string, unknown[]> = {};
  for (const change of changes) {
    if (change.fieldId === "status") continue;
    if (change.fieldId === "assignee")
      // Cards staged before `value` carried the account id in `to`.
      fields.assignee =
        change.value !== undefined
          ? change.value
          : change.to === "Unassigned"
            ? null
            : { accountId: change.to };
    else if (change.fieldId === "parent")
      fields.parent = change.to ? { key: change.to } : null;
    else if (change.fieldId === "description")
      fields.description =
        typeof change.value === "string" ? markdownToAdf(change.value) : null;
    else if (change.fieldId === "resolution")
      fields.resolution =
        change.value ?? (change.to ? { name: change.to } : null);
    else if (change.fieldId === "Epic Link") {
      const fieldMap = await getJiraFieldMap(config);
      const epic = [...fieldMap.byId.values()].find((field) =>
        /^(Epic Link|Parent Link)$/i.test(field.name),
      );
      if (!epic?.id)
        throw new Error("Could not resolve the Jira Epic Link field.");
      fields[epic.id] = change.to || null;
    } else if (change.fieldId === "labels" || change.fieldId === "components") {
      // Collection add/remove/set operations are reconstructed from the display value prepared above.
      // This keeps the approval payload complete without exposing credentials to the browser.
      applyCollectionUpdate(fields, update, change);
    } else {
      fields[change.fieldId] = change.value ?? change.to;
    }
  }
  return { fields, update };
}

async function executeLinkChanges(
  config: ReturnType<typeof getJiraToolConfig>,
  item: JiraIssueMutationItemDisplay,
): Promise<string[]> {
  const errors: string[] = [];
  for (const change of item.linkChanges ?? []) {
    try {
      await executeLinkChange(config, item.issueKey, change);
      change.resultOk = true;
      delete change.error;
    } catch (err) {
      change.resultOk = false;
      change.error = errorText(err);
      errors.push(
        `${change.op} link ${change.type} ${item.issueKey}↔${change.targetIssueKey || change.linkId}: ${change.error}`,
      );
    }
  }
  return errors;
}

async function executeLinkChange(
  config: ReturnType<typeof getJiraToolConfig>,
  subjectKey: string,
  change: JiraIssueLinkChangeDisplay,
): Promise<void> {
  if (change.op === "remove") {
    if (!change.linkId) throw new Error("Missing issue link id for removal.");
    await jiraDelete(
      config,
      `/rest/api/3/issueLink/${encodeURIComponent(change.linkId)}`,
    );
    return;
  }
  // outward: the subject issue "outward"s the target (e.g. subject blocks target).
  const outwardIssue =
    change.direction === "outward" ? subjectKey : change.targetIssueKey;
  const inwardIssue =
    change.direction === "outward" ? change.targetIssueKey : subjectKey;
  await jiraPost(config, "/rest/api/3/issueLink", {
    type: { name: change.type },
    inwardIssue: { key: inwardIssue },
    outwardIssue: { key: outwardIssue },
  });
}

function applyCollectionUpdate(
  fields: Record<string, unknown>,
  update: Record<string, unknown[]>,
  change: JiraIssueMutationFieldChangeDisplay,
): void {
  const to = change.to ?? "";
  const fieldId = change.fieldId;
  const wrap = (value: string) =>
    fieldId === "components" ? { name: value } : value;
  const setMatch = to.match(/(?:^|; )set ([^;]+)/);
  if (setMatch) {
    fields[fieldId] = setMatch[1]!.split(/,\s*/).filter(Boolean).map(wrap);
    return;
  }
  const ops: unknown[] = [];
  const addMatch = to.match(/(?:^|; )add ([^;]+)/);
  const removeMatch = to.match(/(?:^|; )remove ([^;]+)/);
  if (addMatch)
    ops.push(
      ...addMatch[1]!
        .split(/,\s*/)
        .filter(Boolean)
        .map((value) => ({ add: wrap(value) })),
    );
  if (removeMatch)
    ops.push(
      ...removeMatch[1]!
        .split(/,\s*/)
        .filter(Boolean)
        .map((value) => ({ remove: wrap(value) })),
    );
  if (ops.length) update[fieldId] = ops;
}

function normalizeOptionalMarkdown(
  value: string | null | undefined,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  const normalized = value.replace(/\r\n?/g, "\n");
  return normalized.trim() ? normalized : undefined;
}

function normalizeOptionalIssue(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  return normalizeIssueInput(value).toUpperCase();
}

function isTechnicalCustomField(field: NormalizedCustomField): boolean {
  return (
    TECHNICAL_FIELD_NAME_RE.test(field.name) ||
    Boolean(field.customType && TECHNICAL_CUSTOM_TYPES.has(field.customType))
  );
}

function normalizeCustomFieldMode(value: unknown): CustomFieldMode {
  if (value === undefined || value === null) return "none";
  if (
    value === "none" ||
    value === "known" ||
    value === "selected" ||
    value === "discoverNonEmpty"
  )
    return value;
  throw new Error(
    "customFields must be one of: none, known, selected, discoverNonEmpty.",
  );
}
