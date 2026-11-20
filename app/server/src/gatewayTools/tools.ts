/** The edge's tools (Task-1397): adding one is its module plus one line. */
import type { ToolDescriptor } from "./descriptor.ts";
import { jiraGetIssue } from "./jiraGetIssue.ts";
import { jiraLookup } from "./jiraLookup.ts";
import { jiraSearchIssues } from "./jiraSearchIssues.ts";
import { slackConversationRead } from "./slackConversationRead.ts";
import { slackSearch } from "./slackSearch.ts";
import { slackThreadRead } from "./slackThreadRead.ts";
import { slackUnread } from "./slackUnread.ts";

export const EDGE_TOOLS: readonly ToolDescriptor[] = [
  jiraGetIssue,
  jiraSearchIssues,
  jiraLookup,
  slackSearch,
  slackConversationRead,
  slackThreadRead,
  slackUnread,
];
