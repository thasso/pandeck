/** The edge's tools (Task-1397): adding one is its module plus one line. */
import { confluenceDownloadAttachment } from "./confluenceDownload.ts";
import { confluenceGetPage } from "./confluenceGetPage.ts";
import { confluenceLookup } from "./confluenceLookup.ts";
import {
  confluenceDeleteSwitchFor,
  confluenceMutatePageTool,
  type ConfluenceDeleteSwitch,
} from "./confluenceMutatePage.ts";
import { confluenceSearch } from "./confluenceSearch.ts";
import type { ToolDescriptor } from "./descriptor.ts";
import { jiraGetIssue } from "./jiraGetIssue.ts";
import { jiraLookup } from "./jiraLookup.ts";
import { jiraMutateIssue } from "./jiraMutateIssue.ts";
import { jiraSearchIssues } from "./jiraSearchIssues.ts";
import { slackConversationRead } from "./slackConversationRead.ts";
import { slackSearch } from "./slackSearch.ts";
import { slackThreadRead } from "./slackThreadRead.ts";
import { slackUnread } from "./slackUnread.ts";

/**
 * The edge's tools for a start's options: `confluenceDeletes` reaches
 * `confluence_mutate_page`'s gate and nothing else, both off when absent.
 */
export function edgeTools(
  options: { confluenceDeletes?: ConfluenceDeleteSwitch } = {},
): readonly ToolDescriptor[] {
  return [
    jiraGetIssue,
    jiraSearchIssues,
    jiraLookup,
    confluenceSearch,
    confluenceGetPage,
    confluenceLookup,
    confluenceDownloadAttachment,
    slackSearch,
    slackConversationRead,
    slackThreadRead,
    slackUnread,
    jiraMutateIssue,
    confluenceMutatePageTool(
      options.confluenceDeletes ?? confluenceDeleteSwitchFor(undefined),
    ),
  ];
}

/** The tools with every switch at its default (deletes off). */
export const EDGE_TOOLS: readonly ToolDescriptor[] = edgeTools();
