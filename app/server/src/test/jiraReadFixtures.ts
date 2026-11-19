/**
 * Jira read fixtures (Task-1439) shared by the local `jira_search_issues` /
 * `jira_lookup` characterization tests and the edge's parity tests: one
 * responder answering the search, field, project and user requests both
 * sides send, and the payloads they must produce, written out by hand.
 * Every value is fake.
 */

/** `GET /rest/api/3/field`, as Jira answers it. */
export const JIRA_FIELDS = [
  {
    id: "summary",
    key: "summary",
    name: "Summary",
    custom: false,
    orderable: true,
    navigable: true,
    searchable: true,
    clauseNames: ["summary"],
    schema: { type: "string", system: "summary" },
  },
  {
    id: "status",
    key: "status",
    name: "Status",
    custom: false,
    orderable: false,
    navigable: true,
    searchable: true,
    clauseNames: ["status"],
    schema: { type: "status", system: "status" },
  },
  {
    id: "description",
    key: "description",
    name: "Description",
    custom: false,
    orderable: true,
    navigable: true,
    searchable: true,
    clauseNames: ["description"],
    schema: { type: "string", system: "description" },
  },
  {
    id: "customfield_10016",
    key: "customfield_10016",
    name: "Story Points",
    custom: true,
    orderable: true,
    navigable: true,
    searchable: true,
    clauseNames: ["cf[10016]", "Story Points"],
    schema: {
      type: "number",
      custom: "com.atlassian.jira.plugin.system.customfieldtypes:float",
      customId: 10016,
    },
  },
  {
    id: "customfield_10020",
    key: "customfield_10020",
    name: "Sprint",
    custom: true,
    orderable: true,
    navigable: true,
    searchable: false,
    clauseNames: ["cf[10020]", "Sprint"],
    schema: {
      type: "array",
      items: "json",
      custom: "com.pyxis.greenhopper.jira:gh-sprint",
      customId: 10020,
    },
  },
] as const;

type FixtureField = (typeof JIRA_FIELDS)[number];

/** The field map Pandeck's cache builds from `JIRA_FIELDS`. */
export function fixtureFieldMap(fetchedAt: number): {
  fetchedAt: number;
  byId: Map<string, FixtureField>;
  byNameLower: Map<string, FixtureField[]>;
} {
  const byId = new Map<string, FixtureField>();
  const byNameLower = new Map<string, FixtureField[]>();
  for (const field of JIRA_FIELDS) {
    byId.set(field.id, field);
    const name = field.name.toLowerCase();
    byNameLower.set(name, [...(byNameLower.get(name) ?? []), field]);
  }
  return { fetchedAt, byId, byNameLower };
}

/** Default compact search, two pages, `startAt` skipping into page one. */
export const JQL_PAGED = "project = OPS ORDER BY key";
/** `render: true` over one issue with a description and a custom field. */
export const JQL_RENDER = "key = OPS-9";
/** Named `fields`, custom ones resolved through the field map. */
export const JQL_FIELDS = "key = OPS-10";
/** A thousand compact rows: above the edge's 60,000-character ceiling. */
export const JQL_BIG = "project = BIG";
export const BIG_ISSUES = 1000;

const NAMES = {
  summary: "Summary",
  status: "Status",
  assignee: "Assignee",
  updated: "Updated",
  description: "Description",
  customfield_10016: "Story Points",
  customfield_10020: "Sprint",
};
const SCHEMA = {
  summary: { type: "string", system: "summary" },
  status: { type: "status", system: "status" },
  assignee: { type: "user", system: "assignee" },
  updated: { type: "datetime", system: "updated" },
  description: { type: "doc", system: "description" },
  customfield_10016: {
    type: "number",
    custom: "com.atlassian.jira.plugin.system.customfieldtypes:float",
    customId: 10016,
  },
  customfield_10020: {
    type: "array",
    items: "json",
    custom: "com.pyxis.greenhopper.jira:gh-sprint",
    customId: 10020,
  },
};

function pagedIssue(n: number) {
  return {
    id: `1000${n}`,
    key: `OPS-${n}`,
    fields: {
      summary: `Issue ${n}`,
      status: { name: "Open", statusCategory: { name: "To Do" } },
      assignee: { displayName: "Ada Lovelace", accountId: "acc-ada" },
      updated: `2026-11-0${n}T10:00:00.000+0000`,
    },
  };
}

function bigIssue(n: number) {
  return {
    id: `${20000 + n}`,
    key: `BIG-${n}`,
    fields: {
      summary: `Big issue number ${n} with a reasonably long summary`,
      status: { name: "Open", statusCategory: { name: "To Do" } },
      updated: "2026-11-01T10:00:00.000+0000",
    },
  };
}

/** One `POST /rest/api/3/search/jql` page for a request body. */
function searchPage(body: Record<string, unknown>): unknown {
  const token =
    typeof body.nextPageToken === "string" ? body.nextPageToken : "";
  const size = Number(body.maxResults);
  switch (body.jql) {
    case JQL_PAGED:
      // Jira serves fewer rows than asked; the second page is not the last.
      return token === ""
        ? {
            issues: [1, 2, 3].map(pagedIssue),
            nextPageToken: "page-2",
            isLast: false,
            names: NAMES,
            schema: SCHEMA,
          }
        : {
            issues: [4, 5].map(pagedIssue),
            nextPageToken: "page-3",
            isLast: false,
            names: NAMES,
            schema: SCHEMA,
          };
    case JQL_RENDER:
      return {
        issues: [
          {
            id: "10009",
            key: "OPS-9",
            fields: {
              summary: "Render me",
              description: {
                type: "doc",
                version: 1,
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "Hello render" }],
                  },
                ],
              },
              customfield_10016: 5,
            },
          },
        ],
        isLast: true,
        names: NAMES,
        schema: SCHEMA,
      };
    case JQL_FIELDS:
      return {
        issues: [
          {
            id: "10010",
            key: "OPS-10",
            fields: {
              summary: "Fields",
              customfield_10016: 3,
              customfield_10020: [{ id: 7, name: "Sprint 7", state: "active" }],
            },
          },
        ],
        isLast: true,
        names: NAMES,
        schema: SCHEMA,
      };
    case JQL_BIG: {
      const from = token === "" ? 0 : Number(token.slice("big-".length));
      const to = Math.min(BIG_ISSUES, from + size);
      const issues = [];
      for (let n = from + 1; n <= to; n += 1) issues.push(bigIssue(n));
      return to < BIG_ISSUES
        ? { issues, nextPageToken: `big-${to}`, isLast: false }
        : { issues, isLast: true };
    }
    default:
      return { issues: [], isLast: true };
  }
}

const PROJECTS = [
  {
    id: "10000",
    key: "OPS",
    name: "Operations",
    projectTypeKey: "software",
    projectCategory: { id: "1", name: "Core" },
  },
  {
    id: "10001",
    key: "OPSX",
    name: "Ops Extra",
    projectTypeKey: "business",
  },
  { id: "10002", key: "OPSY", name: "Ops Why", projectTypeKey: "business" },
];

const USERS = [
  {
    accountId: "acc-ada",
    accountType: "atlassian",
    displayName: "Ada Lovelace",
    emailAddress: "ada@example.test",
    active: true,
    timeZone: "Europe/London",
  },
  {
    accountId: "acc-adam",
    accountType: "app",
    displayName: "Adam Bot",
    active: false,
  },
  {
    accountId: "acc-adele",
    accountType: "atlassian",
    displayName: "Adele",
    active: true,
  },
];

/**
 * Jira's answer to one read request: `path` without any OAuth
 * `/ex/jira/<cloudId>` prefix, `query` values as sent (numbers or strings).
 * Undefined for a request the fixtures do not know.
 */
export function jiraReadAnswer(
  method: string,
  path: string,
  query: Record<string, unknown>,
  body: unknown,
): unknown {
  if (method === "POST" && path === "/rest/api/3/search/jql")
    return searchPage((body ?? {}) as Record<string, unknown>);
  if (method !== "GET") return undefined;
  const startAt = Number(query.startAt ?? 0);
  const maxResults = Number(query.maxResults ?? 50);
  if (path === "/rest/api/3/field") return JIRA_FIELDS;
  if (path === "/rest/api/3/project/search")
    return {
      values: PROJECTS.slice(startAt, startAt + maxResults),
      total: PROJECTS.length,
      startAt,
      maxResults,
      isLast: startAt + maxResults >= PROJECTS.length,
    };
  if (path === "/rest/api/3/user/search")
    return USERS.slice(startAt, startAt + maxResults);
  return undefined;
}

const HOST_URL = (host: string) => `https://${host}`;

/** `jira_search_issues {jql: JQL_PAGED, maxResults: 3, startAt: 2}`. */
export function pagedSearchPayload(host: string) {
  const row = (n: number) => ({
    key: `OPS-${n}`,
    issueUrl: `${HOST_URL(host)}/browse/OPS-${n}`,
    summary: `Issue ${n}`,
    status: "Open",
    statusCategory: "To Do",
    assignee: "Ada Lovelace",
    updated: `2026-11-0${n}T10:00:00.000+0000`,
  });
  return {
    jiraHost: host,
    jql: JQL_PAGED,
    jiraSearchUrl: `${HOST_URL(host)}/issues/?jql=project%20%3D%20OPS%20ORDER%20BY%20key`,
    startAt: 2,
    maxResults: 3,
    total: 3,
    returned: 3,
    pagesFetched: 2,
    exhausted: false,
    nextStartAt: 5,
    renderRequested: false,
    detailLevel: "compact",
    renderColumns: [],
    fieldResolution: {
      requested: ["key", "summary", "status", "assignee", "updated"],
      apiFieldIds: ["summary", "status", "assignee", "updated"],
      unresolved: [],
    },
    issues: [row(3), row(4), row(5)],
  };
}

/** The two search requests `pagedSearchPayload` takes. */
export const PAGED_SEARCH_BODIES = [
  {
    jql: JQL_PAGED,
    maxResults: 5,
    fields: ["summary", "status", "assignee", "updated"],
    expand: "names,schema",
  },
  {
    jql: JQL_PAGED,
    nextPageToken: "page-2",
    maxResults: 2,
    fields: ["summary", "status", "assignee", "updated"],
    expand: "names,schema",
  },
];

/**
 * `jira_search_issues {jql: JQL_RENDER, maxResults: 1, render: true,
 * renderFields: ["key", "summary", "Story Points"]}`.
 */
export function renderSearchPayload(host: string) {
  const description = {
    type: "doc",
    version: 1,
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Hello render" }] },
    ],
  };
  return {
    jiraHost: host,
    jql: JQL_RENDER,
    jiraSearchUrl: `${HOST_URL(host)}/issues/?jql=key%20%3D%20OPS-9`,
    startAt: 0,
    maxResults: 1,
    total: 1,
    returned: 1,
    pagesFetched: 1,
    exhausted: true,
    nextStartAt: null,
    renderRequested: true,
    detailLevel: "full",
    renderColumns: [
      { id: "key", name: "Key", type: "issueKey" },
      { id: "summary", name: "Summary", type: "string" },
      { id: "customfield_10016", name: "Story Points", type: "number" },
    ],
    fieldResolution: {
      requested: ["key", "summary", "Story Points", "description"],
      apiFieldIds: ["summary", "customfield_10016", "description"],
      unresolved: [],
    },
    issues: [
      {
        id: "10009",
        key: "OPS-9",
        issueUrl: `${HOST_URL(host)}/browse/OPS-9`,
        self: null,
        summary: "Render me",
        description: "Hello render",
        descriptionMarkdown: "Hello render",
        project: null,
        issueType: null,
        status: null,
        priority: null,
        assignee: null,
        reporter: null,
        creator: null,
        labels: [],
        components: [],
        fixVersions: [],
        created: null,
        updated: null,
        dueDate: null,
        parent: null,
        subtasks: [],
        issueLinks: [],
        fields: [
          {
            id: "description",
            name: "Description",
            type: "doc",
            valueText: "Hello render",
            value: description,
          },
          {
            id: "key",
            name: "Key",
            type: "issueKey",
            valueText: "OPS-9",
            value: { key: "OPS-9", issueUrl: `${HOST_URL(host)}/browse/OPS-9` },
          },
          {
            id: "customfield_10016",
            name: "Story Points",
            type: "number",
            valueText: "5",
            value: 5,
          },
          {
            id: "summary",
            name: "Summary",
            type: "string",
            valueText: "Render me",
            value: "Render me",
          },
        ],
      },
    ],
  };
}

/**
 * `jira_search_issues {jql: JQL_FIELDS, maxResults: 1, fields: ["summary",
 * "Story Points", "Sprint", "No Such Field"]}`.
 */
export function fieldsSearchPayload(host: string) {
  return {
    jiraHost: host,
    jql: JQL_FIELDS,
    jiraSearchUrl: `${HOST_URL(host)}/issues/?jql=key%20%3D%20OPS-10`,
    startAt: 0,
    maxResults: 1,
    total: 1,
    returned: 1,
    pagesFetched: 1,
    exhausted: true,
    nextStartAt: null,
    renderRequested: false,
    detailLevel: "compact",
    renderColumns: [],
    fieldResolution: {
      requested: ["summary", "Story Points", "Sprint", "No Such Field"],
      apiFieldIds: ["summary", "customfield_10016", "customfield_10020"],
      unresolved: ["No Such Field"],
    },
    issues: [
      {
        key: "OPS-10",
        issueUrl: `${HOST_URL(host)}/browse/OPS-10`,
        summary: "Fields",
        fieldValues: [
          {
            id: "customfield_10016",
            name: "Story Points",
            type: "number",
            valueText: "3",
          },
          {
            id: "customfield_10020",
            name: "Sprint",
            type: "array",
            valueText: "Sprint 7",
          },
        ],
      },
    ],
  };
}

/** `jira_lookup {kind: "projects", query: "op", maxResults: 2}`. */
export function projectsLookupPayload(host: string) {
  return {
    kind: "projects",
    jiraHost: host,
    query: "op",
    startAt: 0,
    maxResults: 2,
    total: 3,
    returned: 2,
    pagesFetched: 1,
    exhausted: false,
    nextStartAt: 2,
    fields: ["id", "key", "name", "projectUrl", "projectTypeKey", "category"],
    projects: [
      {
        id: "10000",
        key: "OPS",
        name: "Operations",
        projectUrl: `${HOST_URL(host)}/browse/OPS`,
        projectTypeKey: "software",
        category: { id: "1", name: "Core", description: null },
      },
      {
        id: "10001",
        key: "OPSX",
        name: "Ops Extra",
        projectUrl: `${HOST_URL(host)}/browse/OPSX`,
        projectTypeKey: "business",
        category: null,
      },
    ],
  };
}

/** `jira_lookup {kind: "users", query: "ada", maxResults: 2}`. */
export function usersLookupPayload(host: string) {
  return {
    kind: "users",
    jiraHost: host,
    query: "ada",
    assignableOnly: false,
    startAt: 0,
    maxResults: 2,
    returned: 2,
    pagesFetched: 1,
    exhausted: false,
    nextStartAt: 2,
    fields: [
      "accountId",
      "displayName",
      "emailAddress",
      "active",
      "accountType",
    ],
    users: [
      {
        accountId: "acc-ada",
        displayName: "Ada Lovelace",
        emailAddress: "ada@example.test",
        active: true,
        accountType: "atlassian",
      },
      {
        accountId: "acc-adam",
        displayName: "Adam Bot",
        emailAddress: null,
        active: false,
        accountType: "app",
      },
    ],
  };
}
