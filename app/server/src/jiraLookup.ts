/**
 * `jira_lookup` (Task-1439): its schema, description and run (fields,
 * projects, users, issue link types and sprints), shared by Pandeck's local
 * tool and the gateway edge's (`jiraRead.ts`).
 */
import { jiraGet, type JiraConfig } from "./jiraClient.ts";
import type { JiraFieldMeta } from "./jiraFields.ts";
import {
  JiraReadRefusal,
  clampDesiredResults,
  clampStartAt,
  normalizeJiraUser,
  normalizeOptionalString,
  normalizeProject,
  normalizeStringList,
  stopIfAborted,
  unique,
  withSignal,
  type JiraProjectResponse,
  type JiraReadDeps,
} from "./jiraRead.ts";
import { lookupSprints } from "./jiraSprintLookup.ts";

type LookupKind =
  "fields" | "projects" | "users" | "issueLinkTypes" | "sprints";

/** Unified discovery params for jira_lookup; each field applies to specific kinds. */
export type LookupParams = {
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
  // kind=users | sprints
  projectKey?: string;
  // kind=users
  assignableOnly?: boolean;
  // kind=sprints
  boardId?: number;
  sprintStates?: string[];
  // kind=projects | users
  fields?: string[];
  render?: boolean;
};

type JiraProjectSearchResponse = {
  values?: JiraProjectResponse[];
  total?: number;
  maxResults?: number;
  startAt?: number;
  isLast?: boolean;
};

export const JIRA_LOOKUP_DESCRIPTION =
  "Read-only Jira discovery in one tool: kind=fields (system/custom fields + JQL clause names), kind=projects (visible projects), kind=users (users/accountIds), kind=issueLinkTypes (site-global issue link relationship types), or kind=sprints (sprints of a board or a project's boards, with ids and dates).";

export const lookupParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: {
      type: "string",
      enum: ["fields", "projects", "users", "issueLinkTypes", "sprints"],
      description:
        "What to look up: Jira fields (incl. custom fields/JQL clause names), projects, users/accountIds, issueLinkTypes (site-global issue link relationship types), or sprints (a board's sprints with ids, state and dates).",
    },
    query: {
      type: "string",
      description:
        "fields: substring over field id/key/name/clauseNames. projects: project key/name. users: user name/email. issueLinkTypes: substring over type name/inward/outward phrases. sprints: substring of the sprint name.",
    },
    maxResults: {
      type: "number",
      description:
        "Total results desired; the tool paginates internally. Defaults to 50 (max: fields 500, projects 1000, users 10000, sprints 200).",
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
        "users: project key; with assignableOnly limits to users assignable in it. sprints: list the sprints of the project's boards (or give boardId).",
    },
    assignableOnly: {
      type: "boolean",
      description:
        "users: use Jira's assignable-user search for projectKey. Requires projectKey. Defaults to false.",
    },
    boardId: {
      type: "integer",
      description:
        "sprints: Jira Agile board id whose sprints to list. A board is read to 500 sprints and projectKey alone to 10 boards; a capped read sets exhausted=false and a note.",
    },
    sprintStates: {
      type: "array",
      items: { type: "string", enum: ["future", "active", "closed"] },
      description:
        "sprints: states to include. Defaults to active and future; closed sprints list newest first.",
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

const JIRA_PROJECT_PAGE_SIZE = 100;
const JIRA_USER_PAGE_SIZE = 100;
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

/** The lookup's payload, as the local tool stringifies it. */
export async function runJiraLookup(
  config: JiraConfig,
  params: LookupParams,
  deps: JiraReadDeps,
): Promise<Record<string, unknown>> {
  return params.kind === "projects"
    ? await lookupProjects(config, params, deps.signal)
    : params.kind === "users"
      ? await lookupUsers(config, params, deps.signal)
      : params.kind === "issueLinkTypes"
        ? await lookupIssueLinkTypes(config, params, deps)
        : params.kind === "sprints"
          ? await lookupSprints(
              config,
              params,
              clampDesiredResults(params.maxResults, 50, 200),
              deps.signal,
            )
          : await lookupFields(config, params, deps);
}

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
  config: JiraConfig,
  params: LookupParams,
  deps: JiraReadDeps,
): Promise<Record<string, unknown>> {
  const fieldMap = await deps.fieldMap();
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
  config: JiraConfig,
  params: LookupParams,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const maxResults = clampDesiredResults(params.maxResults, 50, 1000);
  const startAt = clampStartAt(params.startAt);
  const projectFields = normalizeProjectFields(
    params.fields,
    params.render === true,
  );
  const queryValue = normalizeOptionalString(params.query);
  const search = await fetchAllProjectPages(
    config,
    {
      ...(queryValue !== undefined ? { query: queryValue } : {}),
      startAt,
      maxResults,
      orderBy: normalizeOptionalString(params.orderBy) ?? "key",
      expand: projectExpandForFields(projectFields),
    },
    signal,
  );
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
  config: JiraConfig,
  params: LookupParams,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const maxResults = clampDesiredResults(params.maxResults, 50, 10000);
  const startAt = clampStartAt(params.startAt);
  const query = normalizeOptionalString(params.query) ?? "";
  const projectKey = normalizeOptionalString(params.projectKey);
  const assignableOnly = params.assignableOnly === true;
  if (assignableOnly && !projectKey)
    throw new JiraReadRefusal(
      "assignable_without_project",
      "projectKey is required when assignableOnly=true.",
    );
  const userFields = normalizeUserFields(params.fields, params.render === true);
  const search = await fetchAllUserPages(
    config,
    {
      query,
      ...(projectKey !== undefined ? { projectKey } : {}),
      assignableOnly,
      startAt,
      maxResults,
    },
    signal,
  );
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
  config: JiraConfig,
  params: LookupParams,
  deps: JiraReadDeps,
): Promise<Record<string, unknown>> {
  const maxResults = clampDesiredResults(params.maxResults, 50, 500);
  const query = normalizeOptionalString(params.query)?.toLowerCase() ?? "";
  const all = await deps.issueLinkTypes();
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

async function fetchAllProjectPages(
  config: JiraConfig,
  args: {
    query?: string;
    startAt: number;
    maxResults: number;
    orderBy: string;
    expand: string | undefined;
  },
  signal: AbortSignal | undefined,
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
    stopIfAborted(signal);
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
      withSignal(signal),
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
  config: JiraConfig,
  args: {
    query: string;
    projectKey?: string;
    assignableOnly: boolean;
    startAt: number;
    maxResults: number;
  },
  signal: AbortSignal | undefined,
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
    stopIfAborted(signal);
    const pageSize = Math.min(
      JIRA_USER_PAGE_SIZE,
      args.maxResults - users.length,
    );
    const batch = await jiraGet<any[]>(
      config,
      path,
      {
        query: args.query,
        project: args.assignableOnly ? args.projectKey : undefined,
        startAt: cursor,
        maxResults: pageSize,
      },
      withSignal(signal),
    );
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
