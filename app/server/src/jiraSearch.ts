/**
 * `jira_search_issues` (Task-1439): its schema, description and run, shared by
 * Pandeck's local tool and the gateway edge's (`jiraRead.ts`).
 */
import {
  jiraBaseUrl,
  jiraIssueUrl,
  jiraPost,
  normalizeJiraIssue,
  type JiraConfig,
} from "./jiraClient.ts";
import { resolveFieldName, type JiraFieldMap } from "./jiraFields.ts";
import {
  JiraReadRefusal,
  clampDesiredResults,
  clampStartAt,
  normalizeJiraUser,
  normalizeProject,
  normalizeStringList,
  stopIfAborted,
  unique,
  valueToText,
  withSignal,
  type JiraFieldSchema,
  type JiraIssueResponse,
  type JiraProjectResponse,
  type JiraReadDeps,
} from "./jiraRead.ts";

type DetailLevel = "compact" | "standard" | "full";

export type SearchIssuesParams = {
  jql: string;
  maxResults?: number;
  startAt?: number;
  fields?: string[];
  detailLevel?: DetailLevel;
  render?: boolean;
  renderFields?: string[];
  includeDescription?: boolean;
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

type RenderField = {
  id: string;
  name: string;
  type: string | null;
  valueText: string | null;
  value?: unknown;
};

export const JIRA_SEARCH_ISSUES_DESCRIPTION =
  "Run a read-only Jira JQL search and return normalized issue rows. Supports an optional rendered table with agent-selected columns. Pass precise JQL and never invent a project, user, or field key — resolve it with jira_lookup first, preferring candidate keys from the session's Project context.";

export const searchIssuesParamsSchema = {
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

const JIRA_ISSUE_PAGE_SIZE = 100;
const DEFAULT_ISSUE_FIELDS = [
  "key",
  "summary",
  "status",
  "assignee",
  "updated",
];

/** The search's payload, as the local tool stringifies it. */
export async function runJiraSearchIssues(
  config: JiraConfig,
  params: SearchIssuesParams,
  deps: Pick<JiraReadDeps, "signal" | "fieldMap">,
) {
  const jql = normalizeJql(params.jql);
  const maxResults = clampDesiredResults(params.maxResults, 25, 1000);
  const startAt = clampStartAt(params.startAt);
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
  const fieldResolution = resolveJiraFieldInputs(
    await deps.fieldMap(),
    requestedFields,
  );

  const search = await fetchAllIssuePages(
    config,
    {
      jql,
      startAt,
      maxResults,
      fields: fieldResolution.apiFieldIds,
      expand: "names,schema",
    },
    deps.signal,
  );
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
      fields: normalizeIssueRenderFields(issue, config.jiraHost, names, schema),
    };
  });

  return {
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
}

/** The trimmed JQL, or a refusal. */
export function normalizeJql(value: string): string {
  const trimmed = value.trim();
  if (!trimmed)
    throw new JiraReadRefusal("jql_empty", "jql must not be empty.");
  if (trimmed.length > 5000)
    throw new JiraReadRefusal("jql_too_long", "jql is too long.");
  return trimmed;
}

async function fetchAllIssuePages(
  config: JiraConfig,
  args: {
    jql: string;
    startAt: number;
    maxResults: number;
    fields: string[];
    expand: string;
  },
  signal: AbortSignal | undefined,
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
    stopIfAborted(signal);
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
      withSignal(signal, { retry: true }),
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

/** Names or ids as Jira field ids, and the names no field answers to. */
export function resolveJiraFieldInputs(
  fieldMap: JiraFieldMap,
  fieldNames: string[],
): {
  requested: string[];
  apiFieldIds: string[];
  unresolved: string[];
} {
  const requested = normalizeStringList(fieldNames).map(normalizeFieldAlias);
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

function normalizeIssueRenderFields(
  issue: JiraIssueResponse,
  jiraHost: string,
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
        issueUrl: issue.key ? jiraIssueUrl(jiraHost, issue.key) : null,
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

function jiraSearchUrl(jiraHost: string, jql: string): string {
  return `${jiraBaseUrl(jiraHost)}/issues/?jql=${encodeURIComponent(jql)}`;
}
