/**
 * A fake Jira for `jira_mutate_issue`'s prepare and apply (Task-1463), for
 * `stubJiraFetch` (`jiraEdgeFetch.ts`): every read the core makes for the
 * five operations answers here, and every write succeeds unless a test
 * answers it first. Every value is fake.
 */
import { json, type SeenJiraRequest } from "./jiraEdgeFetch.ts";

export interface FakeJiraOptions {
  /** The key Jira's create answer carries. */
  createdKey?: string;
  /** The key an issue read answers for the requested one. */
  keyOf?: (requested: string) => string;
  /** Fields the field list holds besides the usual ones. */
  extraFields?: ReadonlyArray<{ id: string; name: string; custom: boolean }>;
}

const FIELDS = [
  { id: "summary", name: "Summary", custom: false },
  { id: "labels", name: "Labels", custom: false },
  {
    id: "customfield_10004",
    name: "Story Points",
    custom: true,
    schema: { type: "number" },
  },
  { id: "customfield_10014", name: "Epic Link", custom: true },
  { id: "customfield_1", name: "One", custom: true },
];

const SPRINT = {
  id: 5,
  name: "Sprint 5",
  state: "future",
  originBoardId: 7,
  startDate: "2026-11-23T09:00:00.000Z",
  endDate: "2026-12-04T17:00:00.000Z",
  goal: "",
};

/** No content: what Jira answers to most writes. */
export const noContent = (): Response => new Response(null, { status: 204 });

/** Whether `seen` sends something to Jira (a search is a read). */
export function isWrite(seen: SeenJiraRequest): boolean {
  return seen.method !== "GET" && seen.path !== "/rest/api/3/search/jql";
}

/** The fake Jira's answer to `seen`; an unknown request is a 404. */
export function fakeJiraAnswer(
  seen: SeenJiraRequest,
  options: FakeJiraOptions = {},
): Response {
  const { method, path } = seen;
  if (method === "GET") {
    if (path === "/rest/api/3/field")
      return json([...FIELDS, ...(options.extraFields ?? [])]);
    if (path === "/rest/api/3/issueLinkType")
      return json({
        issueLinkTypes: [
          {
            id: "1010",
            name: "Blocks",
            inward: "is blocked by",
            outward: "blocks",
          },
        ],
      });
    if (path === "/rest/api/3/mypermissions") {
      const wanted = (seen.query.permissions ?? "").split(",");
      return json({
        permissions: Object.fromEntries(
          wanted.map((key) => [key, { havePermission: true }]),
        ),
      });
    }
    if (path === "/rest/api/3/issue/createmeta")
      return json({
        projects: [
          {
            key: seen.query.projectKeys ?? "STAR",
            issuetypes: [
              {
                id: "3",
                name: seen.query.issuetypeNames ?? "Task",
                fields: {
                  summary: { name: "Summary", required: true },
                  description: { name: "Description" },
                  parent: { name: "Parent" },
                  labels: { name: "Labels" },
                },
              },
            ],
          },
        ],
      });
    if (path.endsWith("/editmeta"))
      return json({
        fields: {
          summary: { name: "Summary" },
          description: { name: "Description" },
          labels: { name: "Labels" },
          customfield_10004: { name: "Story Points" },
        },
      });
    if (path.endsWith("/transitions"))
      return json({
        transitions: [
          { id: "31", name: "Done", to: { name: "Done" } },
          { id: "21", name: "In Progress", to: { name: "In Progress" } },
        ],
      });
    if (/^\/rest\/agile\/1\.0\/board\/\d+\/project$/.test(path))
      return json({ values: [{ key: "STAR" }] });
    if (/^\/rest\/agile\/1\.0\/board\/\d+\/backlog$/.test(path))
      return json({ issues: [{ key: "STAR-9" }, { key: "STAR-8" }] });
    const sprint = /^\/rest\/agile\/1\.0\/sprint\/(\d+)$/.exec(path);
    if (sprint) return json({ ...SPRINT, id: Number(sprint[1]) });
    const issue = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(path);
    if (issue) {
      const requested = decodeURIComponent(issue[1]!);
      const key = options.keyOf?.(requested) ?? requested;
      return json({
        id: "10001",
        key,
        fields: {
          summary: "Subject",
          description: null,
          status: { name: "Open" },
          labels: ["old"],
          components: [],
          project: { key: "STAR" },
          issuetype: { name: "Story", hierarchyLevel: 0 },
        },
      });
    }
    return json({}, 404);
  }
  if (path === "/rest/api/3/search/jql") {
    const jql = String((seen.body as { jql?: unknown } | null)?.jql ?? "");
    const keys = [...jql.matchAll(/"([A-Z][A-Z0-9_]*-\d+)"/g)].map(
      (match) => match[1]!,
    );
    return json({ issues: keys.map((key) => ({ key })) });
  }
  if (method === "POST" && path === "/rest/api/3/issue")
    return json({ id: "10200", key: options.createdKey ?? "STAR-200" }, 201);
  if (method === "POST" && path.endsWith("/comment"))
    return json({ id: "1" }, 201);
  if (method === "POST" && path === "/rest/api/3/issueLink")
    return new Response(null, { status: 201 });
  const sprint = /^\/rest\/agile\/1\.0\/sprint\/(\d+)$/.exec(path);
  if (method === "POST" && sprint) {
    const changes = (seen.body ?? {}) as Record<string, string>;
    return json({ ...SPRINT, ...changes, id: Number(sprint[1]) });
  }
  if (
    (method === "POST" && path.endsWith("/transitions")) ||
    (method === "PUT" && /^\/rest\/api\/3\/issue\/[^/]+$/.test(path)) ||
    (method === "DELETE" && path.startsWith("/rest/api/3/issueLink/")) ||
    (method === "PUT" && path === "/rest/agile/1.0/issue/rank")
  )
    return noContent();
  return json({}, 404);
}
