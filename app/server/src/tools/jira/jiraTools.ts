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
  registerApprovalExecutor,
} from "../../pendingApprovals.ts";
import {
  jiraBaseUrl,
  jiraDelete,
  jiraGet,
  jiraPost,
  jiraPut,
  normalizeAvatarUrls,
  normalizeJiraIssue,
  pickAvatarUrl,
  type JiraApiConfig,
} from "../../jiraClient.ts";
import {
  getJiraIssueLinkTypes,
  resolveIssueLinkType,
  type JiraIssueLinkType,
} from "../../jiraIssueLinkTypeCache.ts";
import {
  getCustomFieldProfile,
  getJiraFieldMap,
  resolveFieldName,
  updateCustomFieldProfile,
  type JiraCustomFieldProfile,
  type JiraFieldMeta,
} from "../../jiraFieldCache.ts";
import { errorText } from "../../errors.ts";
import { assertIssuePermission } from "./jiraPermissions.ts";
import {
  buildJiraRankItem,
  executeJiraRankItem,
  type JiraRankItemInput,
} from "./jiraRank.ts";
import { markdownToAdf } from "../../atlassian/adfFromMarkdown.ts";
import { adfToText } from "../../atlassian/adfToMarkdown.ts";

type CustomFieldMode = "none" | "known" | "selected" | "discoverNonEmpty";
type DetailLevel = "compact" | "standard" | "full";

type GetIssueParams = {
  issue: string;
  includeDescription?: boolean;
  includeComments?: boolean;
  maxComments?: number;
  customFields?: CustomFieldMode;
  customFieldNames?: string[];
  includeRawCustomFieldValues?: boolean;
};

type SearchIssuesParams = {
  jql: string;
  maxResults?: number;
  startAt?: number;
  fields?: string[];
  detailLevel?: DetailLevel;
  render?: boolean;
  renderFields?: string[];
  includeDescription?: boolean;
};

type LookupKind = "fields" | "projects" | "users" | "issueLinkTypes";

/** Unified discovery params for jira_lookup; each field applies to specific kinds. */
type LookupParams = {
  kind: LookupKind;
  query?: string;
  maxResults?: number;
  startAt?: number;
  // kind=fields
  custom?: boolean;
  orderable?: boolean;
  searchable?: boolean;
  // kind=projects
  orderBy?: string;
  // kind=users
  projectKey?: string;
  assignableOnly?: boolean;
  // kind=projects | users
  fields?: string[];
  render?: boolean;
};

type JiraMutationParams = {
  render?: boolean;
  items?: JiraMutationItemInput[];
};

type JiraMutationItemInput = JiraRankItemInput & {
  clientId?: string;
  /** edit (default) = mutate an existing issue; create = new issue; comment = add a comment; rank = reorder a backlog. */
  operation?: "edit" | "create" | "comment" | "rank";
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

type JiraIssueResponse = {
  id?: string;
  key?: string;
  self?: string;
  fields?: Record<string, any>;
  names?: Record<string, string>;
  schema?: Record<string, JiraFieldSchema>;
};

type JiraFieldSchema = {
  type?: string;
  items?: string;
  system?: string;
  custom?: string;
  customId?: number;
};

type JiraCommentsResponse = {
  comments?: Array<{
    id?: string;
    self?: string;
    author?: any;
    body?: unknown;
    created?: string;
    updated?: string;
  }>;
  total?: number;
  maxResults?: number;
  startAt?: number;
};

type JiraSearchResponse = {
  issues?: JiraIssueResponse[];
  total?: number;
  maxResults?: number;
  startAt?: number;
  nextPageToken?: string;
  isLast?: boolean;
  names?: Record<string, string>;
  schema?: Record<string, JiraFieldSchema>;
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

type JiraProjectSearchResponse = {
  values?: JiraProjectResponse[];
  total?: number;
  maxResults?: number;
  startAt?: number;
  isLast?: boolean;
};

type JiraProjectResponse = {
  id?: string;
  key?: string;
  name?: string;
  self?: string;
  description?: string;
  projectTypeKey?: string;
  simplified?: boolean;
  style?: string;
  isPrivate?: boolean;
  url?: string;
  lead?: any;
  avatarUrls?: Record<string, string>;
  issueTypes?: Array<{
    id?: string;
    name?: string;
    description?: string;
    iconUrl?: string;
    subtask?: boolean;
  }>;
  projectCategory?: { id?: string; name?: string; description?: string };
};

type NormalizedCustomField = {
  id: string;
  name: string;
  schemaType: string | null;
  customType: string | null;
  valueText: string | null;
  rawValue?: unknown;
};

type RenderField = {
  id: string;
  name: string;
  type: string | null;
  valueText: string | null;
  value?: unknown;
};

const BASE_FIELDS = [
  "summary",
  "project",
  "issuetype",
  "status",
  "priority",
  "assignee",
  "reporter",
  "creator",
  "labels",
  "components",
  "fixVersions",
  "created",
  "updated",
  "duedate",
  "parent",
  "subtasks",
  "issuelinks",
] as const;

const TECHNICAL_FIELD_NAME_RE =
  /^(Rank|Development|\[CHART\] Time in Status)$/i;
const TECHNICAL_CUSTOM_TYPES = new Set([
  "com.pyxis.greenhopper.jira:gh-lexo-rank",
  "com.atlassian.jira.plugins.jira-development-integration-plugin:devsummarycf",
  "com.atlassian.jira.ext.charting:timeinstatus",
]);

const JIRA_ISSUE_PAGE_SIZE = 100;
const JIRA_PROJECT_PAGE_SIZE = 100;
const JIRA_USER_PAGE_SIZE = 100;
const DEFAULT_ISSUE_FIELDS = [
  "key",
  "summary",
  "status",
  "assignee",
  "updated",
];
const DEFAULT_PROJECT_FIELDS = [
  "id",
  "key",
  "name",
  "projectUrl",
  "projectTypeKey",
  "category",
];
const RENDER_PROJECT_FIELDS = [
  "id",
  "key",
  "name",
  "projectUrl",
  "description",
  "projectTypeKey",
  "category",
  "lead",
  "avatarUrl",
  "issueTypes",
];
const DEFAULT_USER_FIELDS = [
  "accountId",
  "displayName",
  "emailAddress",
  "active",
  "accountType",
];
const RENDER_USER_FIELDS = [
  "accountId",
  "displayName",
  "emailAddress",
  "active",
  "accountType",
  "timeZone",
  "userUrl",
  "avatarUrl",
];

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

const searchIssuesParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["jql", "maxResults"],
  properties: {
    jql: {
      type: "string",
      description:
        "Jira Query Language expression, for example project = OPS AND statusCategory != Done ORDER BY updated DESC.",
    },
    maxResults: {
      type: "number",
      description:
        "Total issues desired across all pages. The tool paginates internally. Defaults to 25, maximum 1000.",
    },
    startAt: {
      type: "number",
      description: "Zero-based result offset. Defaults to 0.",
    },
    fields: {
      type: "array",
      items: { type: "string" },
      description:
        "Jira fields to fetch/return by name or id. Keep this minimal. For counts use [key]; for tables include only columns/details needed, for example summary,status,assignee,updated,Sprint. Use jira_lookup (kind=fields) to discover exact custom-field names/ids.",
    },
    detailLevel: {
      type: "string",
      enum: ["compact", "standard", "full"],
      description:
        "How much issue detail to return when render=false. compact is the default and returns concise rows plus text-only requested fieldValues. standard includes more common normalized fields. full returns verbose render/detail fields and should be used only for small targeted searches.",
    },
    render: {
      type: "boolean",
      description:
        "Set true when the user explicitly asks for a visual Jira search results table. The UI renders a responsive expandable table and receives full row details.",
    },
    renderFields: {
      type: "array",
      items: { type: "string" },
      description:
        "Columns the UI should render, chosen by the agent. Accepts key, summary, status, issueType, assignee, reporter, priority, project, created, updated, labels, components, or Jira field names/ids.",
    },
    includeDescription: {
      type: "boolean",
      description:
        "Include issue descriptions for expanded table details. Defaults to false unless render=true.",
    },
  },
} as const;

const lookupParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: {
      type: "string",
      enum: ["fields", "projects", "users", "issueLinkTypes"],
      description:
        "What to look up: Jira fields (incl. custom fields/JQL clause names), projects, users/accountIds, or issueLinkTypes (site-global issue link relationship types).",
    },
    query: {
      type: "string",
      description:
        "fields: substring over field id/key/name/clauseNames. projects: project key/name. users: user name/email. issueLinkTypes: substring over type name/inward/outward phrases.",
    },
    maxResults: {
      type: "number",
      description:
        "Total results desired; the tool paginates internally. Defaults to 50 (max: fields 500, projects 1000, users 10000).",
    },
    startAt: {
      type: "number",
      description: "projects|users: zero-based result offset. Defaults to 0.",
    },
    custom: {
      type: "boolean",
      description:
        "fields: true=only custom fields, false=only system fields; omit for both.",
    },
    orderable: {
      type: "boolean",
      description: "fields: filter to fields Jira marks orderable.",
    },
    searchable: {
      type: "boolean",
      description:
        "fields: filter to fields Jira marks searchable/JQL-addressable.",
    },
    orderBy: {
      type: "string",
      description:
        "projects: orderBy e.g. key, name, category, lead, issueCount, lastIssueUpdatedTime. Defaults to key.",
    },
    projectKey: {
      type: "string",
      description:
        "users: project key; with assignableOnly limits to users assignable in it.",
    },
    assignableOnly: {
      type: "boolean",
      description:
        "users: use Jira's assignable-user search for projectKey. Requires projectKey. Defaults to false.",
    },
    fields: {
      type: "array",
      items: { type: "string" },
      description:
        "projects|users: fields to return, kept minimal. projects: id,key,name,projectUrl,description,projectTypeKey,category,lead,avatarUrl,issueTypes. users: accountId,accountType,displayName,emailAddress,active,timeZone,userUrl,avatarUrl (use [accountId] for counts).",
    },
    render: {
      type: "boolean",
      description:
        "projects|users: set true only when the user asks for a visual table.",
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
            enum: ["edit", "create", "comment", "rank"],
            description:
              "edit (default): transition/field/link an existing issue. create: create a new issue. comment: add a comment to an issue. rank: reorder issues in a backlog using Jira's Agile ranking API.",
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
      ...BASE_FIELDS,
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
        ? await fetchComments(config, normalized.key, maxComments)
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
  description:
    "Run a read-only Jira JQL search and return normalized issue rows. Supports an optional rendered table with agent-selected columns. Pass precise JQL and never invent a project, user, or field key — resolve it with jira_lookup first, preferring candidate keys from the session's Project context.",
  parameters: searchIssuesParamsSchema,
  async execute(params) {
    const jql = normalizeJql(params.jql);
    const maxResults = clampDesiredResults(params.maxResults, 25, 1000);
    const startAt = clampStartAt(params.startAt);
    const config = getJiraToolConfig();
    const renderRequested = params.render === true;
    const detailLevel = normalizeDetailLevel(
      params.detailLevel,
      renderRequested ? "full" : "compact",
    );
    const verboseRows = renderRequested || detailLevel === "full";
    const includeDescription =
      params.includeDescription === true || renderRequested;
    const renderFieldNames = renderRequested
      ? normalizeStringList(params.renderFields).length > 0
        ? normalizeStringList(params.renderFields)
        : DEFAULT_ISSUE_FIELDS
      : normalizeStringList(params.renderFields);
    const explicitFields = normalizeStringList(params.fields);
    const requestedFields = unique([
      ...(explicitFields.length > 0
        ? explicitFields
        : renderRequested
          ? renderFieldNames
          : DEFAULT_ISSUE_FIELDS),
      ...(includeDescription ? ["description"] : []),
      ...(renderRequested
        ? renderFieldNames.filter((field) => !isVirtualIssueField(field))
        : []),
    ]);
    const fieldResolution = await resolveJiraFieldInputs(
      config,
      requestedFields,
    );

    const search = await fetchAllIssuePages(config, {
      jql,
      startAt,
      maxResults,
      fields: fieldResolution.apiFieldIds,
      expand: "names,schema",
    });
    const names = mergeSearchNames(search.pages);
    const schema = mergeSearchSchema(search.pages);
    const renderColumns = buildIssueRenderColumns(
      renderFieldNames,
      names,
      schema,
    );
    const issues = search.issues.map((issue) => {
      if (!verboseRows)
        return compactSearchIssue(
          issue,
          config.jiraHost,
          names,
          schema,
          fieldResolution.requested,
          detailLevel,
        );
      const normalized = normalizeJiraIssue(issue, config.jiraHost, {
        includeDescription,
      });
      return {
        ...normalized,
        fields: normalizeIssueRenderFields(issue, names, schema),
      };
    });

    const payload = {
      jiraHost: config.jiraHost,
      jql,
      jiraSearchUrl: jiraSearchUrl(config.jiraHost, jql),
      startAt,
      maxResults,
      total: search.total ?? issues.length,
      returned: issues.length,
      pagesFetched: search.pagesFetched,
      exhausted: search.exhausted,
      nextStartAt: search.nextStartAt,
      renderRequested,
      detailLevel,
      renderColumns,
      fieldResolution,
      issues,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      details: payload,
    };
  },
});

/** Shallow-drop null/undefined/empty-string/empty-array keys to keep discovery payloads compact. */
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

async function lookupFields(
  config: JiraApiConfig,
  params: LookupParams,
): Promise<Record<string, unknown>> {
  const fieldMap = await getJiraFieldMap(config);
  const query = params.query?.trim().toLowerCase() ?? "";
  const maxResults = clampDesiredResults(params.maxResults, 50, 500);
  const fields = [...fieldMap.byId.values()]
    .filter(
      (field) => params.custom === undefined || field.custom === params.custom,
    )
    .filter(
      (field) =>
        params.orderable === undefined || field.orderable === params.orderable,
    )
    .filter(
      (field) =>
        params.searchable === undefined ||
        field.searchable === params.searchable,
    )
    .filter((field) => !query || fieldMatchesQuery(field, query))
    .sort(
      (a, b) =>
        Number(b.custom) - Number(a.custom) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
  const selected = fields.slice(0, maxResults).map((field) =>
    dropNulls({
      id: field.id,
      key: field.key ?? null,
      name: field.name,
      custom: field.custom,
      orderable: field.orderable ?? null,
      navigable: field.navigable ?? null,
      searchable: field.searchable ?? null,
      clauseNames: field.clauseNames ?? [],
      schemaType: field.schema?.type ?? null,
      schemaItems: field.schema?.items ?? null,
      system: field.schema?.system ?? null,
      customType: field.schema?.custom ?? null,
      customId: field.schema?.customId ?? null,
    }),
  );
  const meta = dropNulls({
    kind: "fields",
    jiraHost: config.jiraHost,
    query: params.query ?? null,
    custom: params.custom ?? null,
    orderable: params.orderable ?? null,
    searchable: params.searchable ?? null,
    returned: selected.length,
    totalMatched: fields.length,
    exhausted: selected.length >= fields.length,
    fetchedAt: new Date(fieldMap.fetchedAt).toISOString(),
  });
  return { ...meta, fields: selected };
}

async function lookupProjects(
  config: JiraApiConfig,
  params: LookupParams,
): Promise<Record<string, unknown>> {
  const maxResults = clampDesiredResults(params.maxResults, 50, 1000);
  const startAt = clampStartAt(params.startAt);
  const projectFields = normalizeProjectFields(
    params.fields,
    params.render === true,
  );
  const queryValue = normalizeOptionalString(params.query);
  const search = await fetchAllProjectPages(config, {
    ...(queryValue !== undefined ? { query: queryValue } : {}),
    startAt,
    maxResults,
    orderBy: normalizeOptionalString(params.orderBy) ?? "key",
    expand: projectExpandForFields(projectFields),
  });
  const projects = search.projects.map((project) =>
    selectFields(normalizeProject(project, config.jiraHost), projectFields),
  );
  const meta = dropNulls({
    kind: "projects",
    jiraHost: config.jiraHost,
    query: normalizeOptionalString(params.query) ?? null,
    startAt,
    maxResults,
    total: search.total ?? projects.length,
    returned: projects.length,
    pagesFetched: search.pagesFetched,
    exhausted: search.exhausted,
    nextStartAt: search.nextStartAt,
    fields: projectFields,
  });
  return { ...meta, projects };
}

async function lookupUsers(
  config: JiraApiConfig,
  params: LookupParams,
): Promise<Record<string, unknown>> {
  const maxResults = clampDesiredResults(params.maxResults, 50, 10000);
  const startAt = clampStartAt(params.startAt);
  const query = normalizeOptionalString(params.query) ?? "";
  const projectKey = normalizeOptionalString(params.projectKey);
  const assignableOnly = params.assignableOnly === true;
  if (assignableOnly && !projectKey)
    throw new Error("projectKey is required when assignableOnly=true.");
  const userFields = normalizeUserFields(params.fields, params.render === true);
  const search = await fetchAllUserPages(config, {
    query,
    ...(projectKey !== undefined ? { projectKey } : {}),
    assignableOnly,
    startAt,
    maxResults,
  });
  const users = search.users.map((user) =>
    selectFields(normalizeJiraUser(user, config.jiraHost), userFields),
  );
  const meta = dropNulls({
    kind: "users",
    jiraHost: config.jiraHost,
    query: query || null,
    projectKey: projectKey ?? null,
    assignableOnly,
    startAt,
    maxResults,
    returned: users.length,
    pagesFetched: search.pagesFetched,
    exhausted: search.exhausted,
    nextStartAt: search.nextStartAt,
    fields: userFields,
  });
  return { ...meta, users };
}

async function lookupIssueLinkTypes(
  config: JiraApiConfig,
  params: LookupParams,
): Promise<Record<string, unknown>> {
  const maxResults = clampDesiredResults(params.maxResults, 50, 500);
  const query = normalizeOptionalString(params.query)?.toLowerCase() ?? "";
  const all = await getJiraIssueLinkTypes(config);
  const matched = all
    .filter(
      (type) =>
        !query ||
        `${type.name}\n${type.inward}\n${type.outward}`
          .toLowerCase()
          .includes(query),
    )
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const linkTypes = matched.slice(0, maxResults).map((type) => ({
    id: type.id,
    name: type.name,
    inward: type.inward,
    outward: type.outward,
  }));
  const meta = dropNulls({
    kind: "issueLinkTypes",
    jiraHost: config.jiraHost,
    query: normalizeOptionalString(params.query) ?? null,
    returned: linkTypes.length,
    totalMatched: matched.length,
    exhausted: linkTypes.length >= matched.length,
  });
  return { ...meta, linkTypes };
}

export const jiraLookupTool = defineAgentTool<LookupParams>({
  name: "jira_lookup",
  label: "Jira: Lookup",
  description:
    "Read-only Jira discovery in one tool: kind=fields (system/custom fields + JQL clause names), kind=projects (visible projects), kind=users (users/accountIds), or kind=issueLinkTypes (site-global issue link relationship types).",
  parameters: lookupParamsSchema,
  async execute(params) {
    const config = getJiraToolConfig();
    const payload =
      params.kind === "projects"
        ? await lookupProjects(config, params)
        : params.kind === "users"
          ? await lookupUsers(config, params)
          : params.kind === "issueLinkTypes"
            ? await lookupIssueLinkTypes(config, params)
            : await lookupFields(config, params);
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
    "Prepare Jira proposals — create tickets/sub-tasks, edit fields and Markdown-formatted content, add Markdown comments, and add/remove native issue links. CommonMark/GFM is converted to Atlassian Document Format. This tool never writes immediately: it validates and persists a pending approval record with an approval button. Set item.operation to edit (default), create, comment, or rank; rank reorders a backlog through Jira's Agile ranking API (before/after another issue, or top/bottom of a board backlog or a parent's children) instead of writing the opaque rank field. Use it only when the user explicitly asks to change, transition, assign, label, link, create, comment on, or reorder an issue, and ask rather than prepare a proposal when the target issue or value is ambiguous. On create, prefer a project that aligns with our own work — consult the Project Registry when unsure and confirm project and issue type with the user; never set the Cost Center, which Jira automation derives from the ticket.",
  parameters: mutateIssueParamsSchema,
  async execute(params, ctx) {
    const config = getJiraToolConfig();
    const { items, warnings } = await buildJiraMutationItems(
      config,
      params.items ?? [],
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
    return `Edit ${item.issueKey}`;
  }
  const kinds = new Set(items.map((item) => item.operation ?? "edit"));
  if (kinds.size === 1) {
    const only = [...kinds][0];
    if (only === "create") return `Create ${items.length} Jira issues`;
    if (only === "comment") return `Comment on ${items.length} Jira issues`;
    if (only === "rank") return `Rank ${items.length} Jira backlogs`;
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
    const diagnostics = [
      failed ? `${failed} failed` : "",
      warned ? `${warned} warning(s)` : "",
      ...orderings,
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

async function fetchComments(
  config: ReturnType<typeof getJiraToolConfig>,
  issueKey: string,
  maxComments: number,
) {
  const page = await jiraGet<JiraCommentsResponse>(
    config,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
    {
      orderBy: "-created",
      maxResults: maxComments,
    },
  );
  return {
    total: page.total ?? null,
    returned: page.comments?.length ?? 0,
    comments: (page.comments ?? []).map((comment) => ({
      id: comment.id ?? null,
      self: comment.self ?? null,
      author: comment.author
        ? {
            accountId: comment.author.accountId ?? null,
            displayName: comment.author.displayName ?? null,
            emailAddress: comment.author.emailAddress ?? null,
          }
        : null,
      body: adfToText(comment.body),
      created: comment.created ?? null,
      updated: comment.updated ?? null,
    })),
  };
}

async function fetchAllIssuePages(
  config: ReturnType<typeof getJiraToolConfig>,
  args: {
    jql: string;
    startAt: number;
    maxResults: number;
    fields: string[];
    expand: string;
  },
): Promise<{
  issues: JiraIssueResponse[];
  pages: JiraSearchResponse[];
  total: number | null;
  pagesFetched: number;
  exhausted: boolean;
  nextStartAt: number | null;
}> {
  const issues: JiraIssueResponse[] = [];
  const pages: JiraSearchResponse[] = [];
  let nextPageToken: string | undefined;
  let skipped = 0;

  while (issues.length < args.maxResults) {
    const remainingToSkip = Math.max(0, args.startAt - skipped);
    const pageSize = Math.min(
      JIRA_ISSUE_PAGE_SIZE,
      remainingToSkip + (args.maxResults - issues.length),
    );
    const page = await jiraPost<JiraSearchResponse>(
      config,
      "/rest/api/3/search/jql",
      {
        jql: args.jql,
        nextPageToken,
        maxResults: pageSize,
        fields: args.fields.length > 0 ? args.fields : undefined,
        expand: args.expand,
      },
      undefined,
      { retry: true },
    );
    const batch = page.issues ?? [];
    pages.push(page);

    if (remainingToSkip > 0) {
      const keepFrom = Math.min(remainingToSkip, batch.length);
      skipped += keepFrom;
      issues.push(...batch.slice(keepFrom));
    } else {
      issues.push(...batch);
    }

    nextPageToken = page.nextPageToken;
    if (page.isLast === true || !nextPageToken || batch.length === 0) break;
  }

  const exhausted = !nextPageToken || pages[pages.length - 1]?.isLast === true;
  return {
    issues: issues.slice(0, args.maxResults),
    pages,
    total: null,
    pagesFetched: pages.length,
    exhausted,
    nextStartAt: exhausted
      ? null
      : args.startAt + Math.min(issues.length, args.maxResults),
  };
}

async function fetchAllProjectPages(
  config: ReturnType<typeof getJiraToolConfig>,
  args: {
    query?: string;
    startAt: number;
    maxResults: number;
    orderBy: string;
    expand: string | undefined;
  },
): Promise<{
  projects: JiraProjectResponse[];
  total: number | null;
  pagesFetched: number;
  exhausted: boolean;
  nextStartAt: number | null;
}> {
  const projects: JiraProjectResponse[] = [];
  let cursor = args.startAt;
  let total: number | null = null;
  let pagesFetched = 0;
  while (projects.length < args.maxResults) {
    const pageSize = Math.min(
      JIRA_PROJECT_PAGE_SIZE,
      args.maxResults - projects.length,
    );
    const page = await jiraGet<JiraProjectSearchResponse>(
      config,
      "/rest/api/3/project/search",
      {
        query: args.query,
        startAt: cursor,
        maxResults: pageSize,
        orderBy: args.orderBy,
        expand: args.expand,
      },
    );
    const batch = page.values ?? [];
    pagesFetched += 1;
    total = typeof page.total === "number" ? page.total : total;
    projects.push(...batch);
    cursor = (page.startAt ?? cursor) + batch.length;
    if (
      page.isLast === true ||
      batch.length < pageSize ||
      (total !== null && cursor >= total)
    )
      break;
  }
  return {
    projects,
    total,
    pagesFetched,
    exhausted:
      total !== null
        ? args.startAt + projects.length >= total
        : projects.length < args.maxResults,
    nextStartAt:
      total !== null && args.startAt + projects.length < total
        ? args.startAt + projects.length
        : null,
  };
}

async function fetchAllUserPages(
  config: ReturnType<typeof getJiraToolConfig>,
  args: {
    query: string;
    projectKey?: string;
    assignableOnly: boolean;
    startAt: number;
    maxResults: number;
  },
): Promise<{
  users: any[];
  pagesFetched: number;
  exhausted: boolean;
  nextStartAt: number | null;
}> {
  const users: any[] = [];
  let cursor = args.startAt;
  let pagesFetched = 0;
  const path = args.assignableOnly
    ? "/rest/api/3/user/assignable/search"
    : "/rest/api/3/user/search";
  while (users.length < args.maxResults) {
    const pageSize = Math.min(
      JIRA_USER_PAGE_SIZE,
      args.maxResults - users.length,
    );
    const batch = await jiraGet<any[]>(config, path, {
      query: args.query,
      project: args.assignableOnly ? args.projectKey : undefined,
      startAt: cursor,
      maxResults: pageSize,
    });
    pagesFetched += 1;
    users.push(...batch);
    cursor += batch.length;
    if (batch.length < pageSize) break;
  }
  const exhausted = users.length < args.maxResults;
  return {
    users,
    pagesFetched,
    exhausted,
    nextStartAt: exhausted ? null : args.startAt + users.length,
  };
}

async function resolveJiraFieldInputs(
  config: ReturnType<typeof getJiraToolConfig>,
  fieldNames: string[],
): Promise<{
  requested: string[];
  apiFieldIds: string[];
  unresolved: string[];
}> {
  const requested = normalizeStringList(fieldNames).map(normalizeFieldAlias);
  const fieldMap = await getJiraFieldMap(config);
  const apiFieldIds: string[] = [];
  const unresolved: string[] = [];
  for (const name of requested) {
    if (isVirtualIssueField(name)) continue;
    const direct = fieldMap.byId.get(name);
    if (direct) {
      apiFieldIds.push(direct.id);
      continue;
    }
    const resolved = resolveFieldName(fieldMap, name);
    if (resolved?.id) apiFieldIds.push(resolved.id);
    else if (
      /^[a-z][a-zA-Z0-9_]*$/.test(name) ||
      /^customfield_\d+$/.test(name)
    )
      apiFieldIds.push(name);
    else unresolved.push(name);
  }
  return { requested, apiFieldIds: unique(apiFieldIds), unresolved };
}

function buildIssueRenderColumns(
  fieldNames: string[],
  names: Record<string, string>,
  schema: Record<string, JiraFieldSchema>,
) {
  return normalizeStringList(fieldNames).map((field) => {
    const id = resolveReturnedFieldId(normalizeFieldAlias(field), names);
    return {
      id,
      name: issueFieldLabel(id, names),
      type: schema[id]?.type ?? virtualIssueFieldType(id),
    };
  });
}

function resolveReturnedFieldId(
  field: string,
  names: Record<string, string>,
): string {
  if (field === "key" || names[field]) return field;
  const match = Object.entries(names).find(
    ([, name]) => name.toLowerCase() === field.toLowerCase(),
  );
  return match?.[0] ?? field;
}

const COMPACT_BASE_FIELD_IDS = new Set([
  "summary",
  "project",
  "issuetype",
  "status",
  "priority",
  "assignee",
  "reporter",
  "creator",
  "labels",
  "components",
  "fixVersions",
  "created",
  "updated",
  "duedate",
  "parent",
  "subtasks",
  "issuelinks",
  "description",
]);

function normalizeDetailLevel(
  value: DetailLevel | undefined,
  fallback: DetailLevel,
): DetailLevel {
  return value === "compact" || value === "standard" || value === "full"
    ? value
    : fallback;
}

function compactSearchIssue(
  issue: JiraIssueResponse,
  jiraHost: string,
  names: Record<string, string>,
  schema: Record<string, JiraFieldSchema>,
  requestedFields: string[],
  detailLevel: DetailLevel,
): Record<string, unknown> {
  const fields = issue.fields ?? {};
  const key = issue.key ?? null;
  const row: Record<string, unknown> = {
    ...(detailLevel === "standard" ? { id: issue.id ?? null } : {}),
    key,
    issueUrl: key
      ? `${jiraBaseUrl(jiraHost)}/browse/${encodeURIComponent(key)}`
      : null,
    summary: stringOrNull(fields.summary),
    project: fields.project ? compactProjectRef(fields.project) : null,
    issueType: fields.issuetype?.name ?? null,
    status: fields.status?.name ?? null,
    statusCategory: fields.status?.statusCategory?.name ?? null,
    priority: fields.priority?.name ?? null,
    assignee: compactUserText(fields.assignee),
    reporter:
      detailLevel === "standard" ? compactUserText(fields.reporter) : null,
    updated: fields.updated ?? null,
    created: detailLevel === "standard" ? (fields.created ?? null) : null,
    dueDate: fields.duedate ?? null,
    parent: compactIssueRef(fields.parent),
    labels:
      Array.isArray(fields.labels) && fields.labels.length
        ? fields.labels
        : null,
    components: compactNamedArray(fields.components),
    fixVersions:
      detailLevel === "standard" ? compactNamedArray(fields.fixVersions) : null,
    subtasks:
      detailLevel === "standard" &&
      Array.isArray(fields.subtasks) &&
      fields.subtasks.length
        ? fields.subtasks.map(compactIssueRef).filter(Boolean)
        : null,
  };

  const requested = new Set(
    requestedFields.map((field) => resolveReturnedFieldId(field, names)),
  );
  const fieldValues = Object.entries(fields)
    .filter(
      ([id]) =>
        !COMPACT_BASE_FIELD_IDS.has(id) &&
        (requested.size === 0 || requested.has(id)),
    )
    .map(([id, value]) => ({
      id,
      name: issueFieldLabel(id, names),
      type: schema[id]?.type ?? inferJiraValueType(id, value),
      valueText: valueToText(value),
    }))
    .filter((field) => field.valueText !== null);
  if (fieldValues.length > 0) row.fieldValues = fieldValues;

  return compactObject(row);
}

function compactProjectRef(value: any): Record<string, unknown> | null {
  if (!value) return null;
  return compactObject({ key: value.key ?? null, name: value.name ?? null });
}

function compactIssueRef(value: any): Record<string, unknown> | null {
  if (!value) return null;
  return compactObject({
    key: value.key ?? null,
    summary: value.fields?.summary ?? null,
    status: value.fields?.status?.name ?? null,
  });
}

function compactUserText(value: any): string | null {
  if (!value) return null;
  return value.displayName ?? value.emailAddress ?? value.accountId ?? null;
}

function compactNamedArray(value: any): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value
    .map((item) => item?.name ?? item?.value ?? item?.key ?? null)
    .filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined) continue;
    if (Array.isArray(item) && item.length === 0) continue;
    if (typeof item === "object" && !Array.isArray(item)) {
      const nested = compactObject(item as Record<string, unknown>);
      if (Object.keys(nested).length === 0) continue;
      out[key] = nested;
      continue;
    }
    out[key] = item;
  }
  return out as T;
}

function fieldMatchesQuery(field: JiraFieldMeta, query: string): boolean {
  return [
    field.id,
    field.key,
    field.name,
    ...(field.clauseNames ?? []),
    field.schema?.type,
    field.schema?.system,
    field.schema?.custom,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase()
    .includes(query);
}

function normalizeIssueRenderFields(
  issue: JiraIssueResponse,
  names: Record<string, string>,
  schema: Record<string, JiraFieldSchema>,
): RenderField[] {
  const fields = issue.fields ?? {};
  const out: RenderField[] = [
    {
      id: "key",
      name: "Key",
      type: "issueKey",
      valueText: issue.key ?? null,
      value: {
        key: issue.key ?? null,
        issueUrl: issue.key ? jiraIssueUrlFromHost(issue.key) : null,
      },
    },
  ];
  for (const [id, value] of Object.entries(fields)) {
    out.push({
      id,
      name: issueFieldLabel(id, names),
      type: schema[id]?.type ?? inferJiraValueType(id, value),
      valueText: valueToText(value),
      value: normalizeRenderValue(id, value),
    });
  }
  return out.sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

function mergeSearchNames(pages: JiraSearchResponse[]): Record<string, string> {
  return Object.assign(
    {},
    ...pages.map((page) => page.names ?? {}),
    ...pages
      .flatMap((page) => page.issues ?? [])
      .map((issue) => issue.names ?? {}),
  );
}

function mergeSearchSchema(
  pages: JiraSearchResponse[],
): Record<string, JiraFieldSchema> {
  return Object.assign(
    {},
    ...pages.map((page) => page.schema ?? {}),
    ...pages
      .flatMap((page) => page.issues ?? [])
      .map((issue) => issue.schema ?? {}),
  );
}

function normalizeRenderValue(id: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (id === "assignee" || id === "reporter" || id === "creator")
    return normalizeJiraUser(value, "");
  if (id === "project" && typeof value === "object")
    return normalizeProject(value as JiraProjectResponse, "");
  if (id === "status" && typeof value === "object") {
    const item = value as any;
    return {
      id: item.id ?? null,
      name: item.name ?? null,
      category: item.statusCategory?.name ?? null,
      colorName: item.statusCategory?.colorName ?? null,
    };
  }
  if ((id === "issuetype" || id === "priority") && typeof value === "object") {
    const item = value as any;
    return {
      id: item.id ?? null,
      name: item.name ?? null,
      iconUrl: item.iconUrl ?? null,
    };
  }
  if (Array.isArray(value))
    return value.map((item) => normalizeRenderArrayItem(item));
  return value;
}

function normalizeRenderArrayItem(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const item = value as any;
  return {
    id: item.id ?? null,
    key: item.key ?? null,
    name: item.name ?? item.value ?? item.displayName ?? null,
    self: item.self ?? null,
  };
}

function normalizeProject(project: JiraProjectResponse, jiraHost: string) {
  const avatarUrls = normalizeAvatarUrls(project.avatarUrls);
  const key = project.key ?? null;
  const base = jiraHost ? jiraBaseUrl(jiraHost) : null;
  return {
    id: project.id ?? null,
    key,
    name: project.name ?? null,
    self: project.self ?? null,
    projectUrl:
      key && base ? `${base}/browse/${encodeURIComponent(key)}` : null,
    description: project.description ?? null,
    projectTypeKey: project.projectTypeKey ?? null,
    simplified:
      typeof project.simplified === "boolean" ? project.simplified : null,
    style: project.style ?? null,
    isPrivate:
      typeof project.isPrivate === "boolean" ? project.isPrivate : null,
    url: project.url ?? null,
    category: project.projectCategory
      ? {
          id: project.projectCategory.id ?? null,
          name: project.projectCategory.name ?? null,
          description: project.projectCategory.description ?? null,
        }
      : null,
    lead: project.lead ? normalizeJiraUser(project.lead, jiraHost) : null,
    avatarUrl: pickAvatarUrl(avatarUrls),
    issueTypes: (project.issueTypes ?? []).map((issueType) => ({
      id: issueType.id ?? null,
      name: issueType.name ?? null,
      description: issueType.description ?? null,
      iconUrl: issueType.iconUrl ?? null,
      subtask:
        typeof issueType.subtask === "boolean" ? issueType.subtask : null,
    })),
  };
}

function normalizeJiraUser(user: any, jiraHost: string) {
  const avatarUrls = normalizeAvatarUrls(user?.avatarUrls);
  const accountId = user?.accountId ?? null;
  const base = jiraHost ? jiraBaseUrl(jiraHost) : null;
  return {
    accountId,
    accountType: user?.accountType ?? null,
    displayName: user?.displayName ?? null,
    emailAddress: user?.emailAddress ?? null,
    active: typeof user?.active === "boolean" ? user.active : null,
    timeZone: user?.timeZone ?? null,
    locale: user?.locale ?? null,
    self: user?.self ?? null,
    userUrl:
      accountId && base
        ? `${base}/jira/people/${encodeURIComponent(accountId)}`
        : null,
    avatarUrl: pickAvatarUrl(avatarUrls),
  };
}

function normalizeProjectFields(
  fields: string[] | undefined,
  render: boolean,
): string[] {
  const requested = normalizeStringList(fields);
  const base = requested.length > 0 ? requested : DEFAULT_PROJECT_FIELDS;
  return unique([...(render ? RENDER_PROJECT_FIELDS : []), ...base]).filter(
    (field) => PROJECT_FIELD_ALLOWLIST.has(field),
  );
}

function normalizeUserFields(
  fields: string[] | undefined,
  render: boolean,
): string[] {
  const requested = normalizeStringList(fields);
  const base = requested.length > 0 ? requested : DEFAULT_USER_FIELDS;
  return unique([...(render ? RENDER_USER_FIELDS : []), ...base]).filter(
    (field) => USER_FIELD_ALLOWLIST.has(field),
  );
}

const PROJECT_FIELD_ALLOWLIST = new Set([
  "id",
  "key",
  "name",
  "self",
  "projectUrl",
  "description",
  "projectTypeKey",
  "simplified",
  "style",
  "isPrivate",
  "url",
  "category",
  "lead",
  "avatarUrl",
  "issueTypes",
]);

const USER_FIELD_ALLOWLIST = new Set([
  "accountId",
  "accountType",
  "displayName",
  "emailAddress",
  "active",
  "timeZone",
  "locale",
  "self",
  "userUrl",
  "avatarUrl",
]);

function projectExpandForFields(fields: string[]): string | undefined {
  const expand = [];
  if (fields.includes("description")) expand.push("description");
  if (fields.includes("lead")) expand.push("lead");
  if (fields.includes("issueTypes")) expand.push("issueTypes");
  return expand.length > 0 ? expand.join(",") : undefined;
}

function selectFields<T extends Record<string, unknown>>(
  value: T,
  fields: string[],
): Partial<T> {
  const out: Partial<T> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(value, field))
      out[field as keyof T] = value[field] as T[keyof T];
  }
  return out;
}

function isVirtualIssueField(field: string): boolean {
  return ["key", "issueKey", "issueUrl"].includes(field.trim());
}

function normalizeFieldAlias(field: string): string {
  const trimmed = field.trim();
  if (/^issueKey$/i.test(trimmed)) return "key";
  if (/^issueType$/i.test(trimmed)) return "issuetype";
  if (/^dueDate$/i.test(trimmed)) return "duedate";
  return trimmed;
}

function issueFieldLabel(id: string, names: Record<string, string>): string {
  if (id === "key") return "Key";
  if (id === "issuetype") return "Type";
  if (id === "duedate") return "Due";
  return (
    names[id] ??
    id.replace(/_/g, " ").replace(/\b\w/g, (value) => value.toUpperCase())
  );
}

function virtualIssueFieldType(id: string): string | null {
  if (id === "key") return "issueKey";
  return null;
}

function inferJiraValueType(id: string, value: unknown): string | null {
  if (id === "assignee" || id === "reporter" || id === "creator") return "user";
  if (id === "project") return "project";
  if (id === "status") return "status";
  if (id === "issuetype") return "issuetype";
  if (id === "priority") return "priority";
  if (id === "created" || id === "updated" || id === "duedate") return "date";
  if (Array.isArray(value)) return "array";
  return typeof value === "object" ? "object" : typeof value;
}

function jiraIssueUrlFromHost(issueKey: string): string | null {
  const config = getJiraToolConfig();
  return `${jiraBaseUrl(config.jiraHost)}/browse/${encodeURIComponent(issueKey)}`;
}

function jiraSearchUrl(jiraHost: string, jql: string): string {
  return `${jiraBaseUrl(jiraHost)}/issues/?jql=${encodeURIComponent(jql)}`;
}

async function buildJiraMutationItems(
  config: ReturnType<typeof getJiraToolConfig>,
  input: JiraMutationItemInput[],
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
  return { items, warnings: unique(warnings) };
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
  )
    changes.push({
      fieldId: "assignee",
      label: "Assignee",
      from: valueToText(fields.assignee),
      to:
        raw.clearAssignee || raw.assigneeAccountId === null
          ? "Unassigned"
          : (raw.assigneeAccountId ?? null),
      operation: "set",
    });
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
  const resolution = await resolveJiraFieldInputs(config, rawFieldNames);
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
      fields.assignee =
        change.to === "Unassigned" ? null : { accountId: change.to };
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

function normalizeJql(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("jql must not be empty.");
  if (trimmed.length > 5000) throw new Error("jql is too long.");
  return trimmed;
}

function normalizeOptionalString(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
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

function normalizeStringList(
  values: string[] | undefined | readonly string[],
): string[] {
  return unique(
    (values ?? []).map((value) => String(value).trim()).filter(Boolean),
  );
}

function clampDesiredResults(
  value: number | undefined,
  defaultValue: number,
  maxValue: number,
): number {
  if (value === undefined) return defaultValue;
  if (!Number.isFinite(value) || value <= 0) return defaultValue;
  return Math.min(maxValue, Math.floor(value));
}

function clampStartAt(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function isTechnicalCustomField(field: NormalizedCustomField): boolean {
  return (
    TECHNICAL_FIELD_NAME_RE.test(field.name) ||
    Boolean(field.customType && TECHNICAL_CUSTOM_TYPES.has(field.customType))
  );
}

function valueToText(value: unknown): string | null {
  if (isEmptyValue(value)) return null;
  if (typeof value === "string") return truncate(value);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) {
    const parts = value
      .map(valueToText)
      .filter((item): item is string => Boolean(item));
    return parts.length > 0 ? truncate(parts.join(", ")) : null;
  }
  if (typeof value === "object") {
    const docText = adfToText(value);
    if (docText) return truncate(docText);
    const obj = value as Record<string, unknown>;
    for (const key of ["value", "name", "title", "displayName", "key", "id"]) {
      if (typeof obj[key] === "string" && obj[key]) return truncate(obj[key]);
    }
    return truncate(JSON.stringify(value));
  }
  return null;
}

function isEmptyValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

function truncate(value: string): string {
  return value.length > 1000 ? `${value.slice(0, 997)}…` : value;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
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

function normalizeIssueInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("issue must be a Jira issue key or id.");
  if (trimmed.length > 120)
    throw new Error("issue is too long to be a Jira issue key or id.");
  return trimmed;
}

function clampMaxComments(value: number | undefined): number {
  if (value === undefined) return 10;
  if (!Number.isFinite(value) || value <= 0) return 10;
  return Math.min(50, Math.floor(value));
}
