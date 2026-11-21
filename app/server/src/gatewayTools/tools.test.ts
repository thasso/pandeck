/**
 * The edge's tool descriptors stay within what Pandeck accepts from a
 * listing (`remoteTools.ts`, Task-1398): the gateway's CI owns their prompt
 * budget, so a descriptor beyond these bounds fails here, not on a client.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { JIRA_LOOKUP_DESCRIPTION, lookupParamsSchema } from "../jiraLookup.ts";
import {
  JIRA_SEARCH_ISSUES_DESCRIPTION,
  searchIssuesParamsSchema,
} from "../jiraSearch.ts";
import {
  JIRA_MUTATE_ISSUE_DESCRIPTION,
  mutateIssueParamsSchema,
} from "../jiraMutate.ts";
import { createEdgeTools } from "./index.ts";
import { jiraLookup } from "./jiraLookup.ts";
import { WRITE_DEADLINE_MS, jiraMutateIssue } from "./jiraMutateIssue.ts";
import { jiraSearchIssues } from "./jiraSearchIssues.ts";
import {
  SLACK_CONVERSATION_READ_DESCRIPTION,
  SLACK_SEARCH_DESCRIPTION,
  SLACK_THREAD_READ_DESCRIPTION,
  SLACK_UNREAD_DESCRIPTION,
  slackConversationReadParamsSchema,
  slackSearchParamsSchema,
  slackThreadReadParamsSchema,
  slackUnreadParamsSchema,
} from "../slackRead.ts";
import { slackConversationRead } from "./slackConversationRead.ts";
import { slackSearch } from "./slackSearch.ts";
import { slackThreadRead } from "./slackThreadRead.ts";
import { slackUnread } from "./slackUnread.ts";
import { EDGE_TOOLS } from "./tools.ts";

test("every edge tool's descriptor is within the client's bounds", () => {
  assert.ok(EDGE_TOOLS.length <= 64);
  assert.equal(
    new Set(EDGE_TOOLS.map((tool) => tool.name)).size,
    EDGE_TOOLS.length,
  );
  for (const tool of EDGE_TOOLS) {
    assert.match(tool.name, /^[a-z][a-z0-9_]{0,63}$/);
    assert.ok(
      tool.description.length >= 1 && tool.description.length <= 1_024,
      tool.name,
    );
    assert.equal(tool.inputSchema.type, "object");
    // Write tools carry the local write schemas (Task-1463): up to 8,192.
    assert.ok(
      JSON.stringify(tool.inputSchema).length <=
        (tool.effect === "write" ? 8_192 : 4_096),
      tool.name,
    );
    // The prefix names the product Pandeck maps the tool to.
    assert.match(tool.actionKey, /^(jira|slack):[a-z_]{1,32}$/, tool.name);
  }
});

test("the edge's tools offer the host's listing", () => {
  const listed = createEdgeTools({ log: () => {} }).host.list();
  assert.deepEqual(
    listed.map((tool) => tool.name),
    [
      "jira_get_issue",
      "jira_search_issues",
      "jira_lookup",
      "slack_search",
      "slack_conversation_read",
      "slack_thread_read",
      "slack_unread",
      "jira_mutate_issue",
    ],
  );
  assert.deepEqual(
    listed.map((tool) => tool.name),
    EDGE_TOOLS.map((tool) => tool.name),
  );
  const jira = listed.find((tool) => tool.name === "jira_get_issue");
  assert.ok(jira);
  assert.equal(jira.effect, "read");
  assert.equal(jira.actionKey, "jira:read");
  assert.equal(jira.inputSchema.additionalProperties, false);
});

test("search and lookup share the local tools' schema and description objects", () => {
  // Identity, not equality: one constant serves both, so they cannot drift.
  assert.ok(jiraSearchIssues.inputSchema === searchIssuesParamsSchema);
  assert.ok(jiraSearchIssues.description === JIRA_SEARCH_ISSUES_DESCRIPTION);
  assert.ok(jiraLookup.inputSchema === lookupParamsSchema);
  assert.ok(jiraLookup.description === JIRA_LOOKUP_DESCRIPTION);
});

test("the Slack tools share the local tools' schema and description objects", () => {
  const pairs = [
    [slackSearch, slackSearchParamsSchema, SLACK_SEARCH_DESCRIPTION],
    [
      slackConversationRead,
      slackConversationReadParamsSchema,
      SLACK_CONVERSATION_READ_DESCRIPTION,
    ],
    [
      slackThreadRead,
      slackThreadReadParamsSchema,
      SLACK_THREAD_READ_DESCRIPTION,
    ],
    [slackUnread, slackUnreadParamsSchema, SLACK_UNREAD_DESCRIPTION],
  ] as const;
  for (const [tool, schema, description] of pairs) {
    assert.ok(tool.inputSchema === schema, tool.name);
    assert.ok(tool.description === description, tool.name);
    assert.equal(tool.effect, "read");
    assert.equal(tool.actionKey, "slack:read");
    assert.equal(tool.integration, "slack");
  }
});

/** `value` with every `description` removed, at any depth. */
function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "description")
      .map(([key, entry]) => [key, withoutDescriptions(entry)]),
  );
}

/** Every `description` in `value`, by its path. */
function descriptionsOf(value: unknown, path = ""): Map<string, unknown> {
  const found = new Map<string, unknown>();
  if (typeof value !== "object" || value === null) return found;
  for (const [key, entry] of Object.entries(value)) {
    const at = path ? `${path}.${key}` : key;
    if (key === "description") found.set(at, entry);
    else for (const [p, d] of descriptionsOf(entry, at)) found.set(p, d);
  }
  return found;
}

test("jira_mutate_issue is the edge's write tool, with its own deadline", () => {
  assert.equal(jiraMutateIssue.name, "jira_mutate_issue");
  assert.equal(jiraMutateIssue.effect, "write");
  assert.equal(jiraMutateIssue.actionKey, "jira:write");
  assert.equal(jiraMutateIssue.integration, "atlassian");
  assert.equal(jiraMutateIssue.maxResultChars, 60_000);
  assert.equal(jiraMutateIssue.deadlineMs, WRITE_DEADLINE_MS);
  assert.equal(WRITE_DEADLINE_MS, 45_000);
  assert.ok(EDGE_TOOLS.includes(jiraMutateIssue));
  // Measured: the edge schema is 5,696 characters, the local one 5,819.
  assert.equal(JSON.stringify(jiraMutateIssue.inputSchema).length, 5_696);
  assert.equal(JSON.stringify(mutateIssueParamsSchema).length, 5_819);
});

test("jira_mutate_issue keeps the local schema's structure exactly", () => {
  assert.deepEqual(
    withoutDescriptions(jiraMutateIssue.inputSchema),
    withoutDescriptions(mutateIssueParamsSchema),
  );
  assert.equal(jiraMutateIssue.inputSchema.additionalProperties, false);
});

test("jira_mutate_issue differs from the local tool in exactly four prose strings", () => {
  const edge = descriptionsOf(jiraMutateIssue.inputSchema);
  const local = descriptionsOf(mutateIssueParamsSchema);
  assert.deepEqual([...edge.keys()], [...local.keys()]);
  const changed = [...edge.keys()].filter(
    (path) => edge.get(path) !== local.get(path),
  );
  assert.deepEqual(
    changed.map((path) => [path, local.get(path), edge.get(path)]),
    [
      [
        "properties.items.description",
        "Jira issue mutation proposals. No writes happen until explicit user approval in the UI.",
        "Jira issue changes, applied in this call.",
      ],
      [
        "properties.items.items.properties.projectKey.description",
        "create: project key for the new issue, e.g. OPS. Consider the Project Registry to align with our own projects.",
        "create: project key for the new issue, e.g. OPS.",
      ],
      [
        "properties.items.items.properties.fields.description",
        "Advanced field updates keyed by Jira field id or name. Values are sent as Jira REST field values after approval.",
        "Advanced field updates keyed by Jira field id or name. Values are sent as Jira REST field values.",
      ],
    ],
  );
  // The fourth: the tool description, which says the call writes at once and
  // that an interrupt neither stops it nor proves nothing changed (AC16).
  assert.notEqual(jiraMutateIssue.description, JIRA_MUTATE_ISSUE_DESCRIPTION);
  assert.ok(jiraMutateIssue.description.length <= 1_024);
  for (const clause of [
    "This tool writes in one call: the client asks the user to approve it, and Jira changes as soon as it runs.",
    "Interrupting the call does not stop it; it may still be writing.",
    "After a timeout or interrupt, wait 60 s before reading the issues and before any retry: an early unchanged read does not prove nothing will change.",
    "never set the Cost Center",
    "Use it only when the user explicitly asks for the change",
  ])
    assert.ok(jiraMutateIssue.description.includes(clause), clause);
});

test("docs/workers.md states A3's interrupt clauses for the edge write (AC16, fix-4)", () => {
  const docs = readFileSync(
    new URL("../../../../docs/workers.md", import.meta.url),
    "utf8",
  ).replace(/\s+/g, " ");
  for (const clause of [
    "An interrupted write therefore keeps running until it completes or reaches its 45 s deadline",
    "Esc never reaches the call's `ctx.signal`, because the stateless handler cannot connect that separate `notifications/cancelled` POST to the call.",
  ])
    assert.ok(docs.includes(clause), clause);
});

test("the local jira_mutate_issue schema and description stay byte-identical", () => {
  // Pinned at main 47611df4 (P4b1): the edge builds its own copy by
  // spreading and never writes into the local objects.
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  assert.equal(
    sha(JSON.stringify(mutateIssueParamsSchema)),
    "6267aecb14fdf06004aecb7f3736bc8ca201e0cc0e418e89d0e70d7aead6a511",
  );
  assert.equal(
    sha(JIRA_MUTATE_ISSUE_DESCRIPTION),
    "30ef8a697b876432041e3e23631785fae50bd3b28003c6c76d10d245694d2edd",
  );
});
