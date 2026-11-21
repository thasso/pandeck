/**
 * The edge's tool descriptors stay within what Pandeck accepts from a
 * listing (`remoteTools.ts`, Task-1398): the gateway's CI owns their prompt
 * budget, so a descriptor beyond these bounds fails here, not on a client.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  CONFLUENCE_GET_PAGE_DESCRIPTION,
  CONFLUENCE_GET_PAGE_SCHEMA,
  CONFLUENCE_LOOKUP_DESCRIPTION,
  CONFLUENCE_LOOKUP_SCHEMA,
  CONFLUENCE_SEARCH_DESCRIPTION,
  CONFLUENCE_SEARCH_SCHEMA,
} from "../confluenceRead.ts";
import { confluenceGetPage } from "./confluenceGetPage.ts";
import { confluenceLookup } from "./confluenceLookup.ts";
import { confluenceSearch } from "./confluenceSearch.ts";
import { JIRA_LOOKUP_DESCRIPTION, lookupParamsSchema } from "../jiraLookup.ts";
import {
  JIRA_SEARCH_ISSUES_DESCRIPTION,
  searchIssuesParamsSchema,
} from "../jiraSearch.ts";
import { createEdgeTools } from "./index.ts";
import { jiraLookup } from "./jiraLookup.ts";
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
    assert.ok(JSON.stringify(tool.inputSchema).length <= 4_096, tool.name);
    // The prefix names the product Pandeck maps the tool to.
    assert.match(
      tool.actionKey,
      /^(jira|slack|confluence):[a-z_]{1,32}$/,
      tool.name,
    );
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
      "confluence_search",
      "confluence_get_page",
      "confluence_lookup",
      "slack_search",
      "slack_conversation_read",
      "slack_thread_read",
      "slack_unread",
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

test("the Confluence reads share the local tools' schema and description objects", () => {
  const triples = [
    [confluenceSearch, CONFLUENCE_SEARCH_SCHEMA, CONFLUENCE_SEARCH_DESCRIPTION],
    [
      confluenceGetPage,
      CONFLUENCE_GET_PAGE_SCHEMA,
      CONFLUENCE_GET_PAGE_DESCRIPTION,
    ],
    [confluenceLookup, CONFLUENCE_LOOKUP_SCHEMA, CONFLUENCE_LOOKUP_DESCRIPTION],
  ] as const;
  for (const [tool, schema, description] of triples) {
    // Identity, not equality: one constant serves both, so they cannot drift.
    assert.ok(tool.inputSchema === schema, tool.name);
    assert.ok(tool.description === description, tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.equal(tool.effect, "read");
    assert.equal(tool.actionKey, "confluence:read");
    assert.equal(tool.integration, "atlassian");
    assert.equal(tool.maxResultChars, undefined, `${tool.name}: 60,000`);
  }
});
