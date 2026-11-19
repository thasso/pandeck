/**
 * `jira_search_issues` on the edge (Task-1439): Pandeck's own search, with the
 * same schema, description and payload, run with the calling user's
 * Atlassian credential. Read-only, no approval. A payload above the edge's
 * 60,000-character ceiling answers `result_too_large` (D5).
 */
import { AtlassianHttpError } from "../atlassian/atlassianFetch.ts";
import {
  JIRA_SEARCH_ISSUES_DESCRIPTION,
  runJiraSearchIssues,
  searchIssuesParamsSchema,
  type SearchIssuesParams,
} from "../jiraSearch.ts";
import { jiraConfigOf } from "./atlassian.ts";
import { ToolError, type ToolDescriptor } from "./descriptor.ts";
import { edgeReadDeps, jiraReadFailure } from "./jiraRead.ts";

/**
 * What a search Jira rejects (HTTP 400) answers: a fixed text, no upstream
 * reason (D4, open). Whether Jira's own reasons may pass is decided here and
 * nowhere else.
 */
function searchRefusedText(): string {
  return "Jira refused the search (HTTP 400); check the JQL, and resolve project, user and field names with jira_lookup.";
}

export const jiraSearchIssues: ToolDescriptor = {
  name: "jira_search_issues",
  description: JIRA_SEARCH_ISSUES_DESCRIPTION,
  inputSchema: searchIssuesParamsSchema,
  effect: "read",
  actionKey: "jira:read",
  integration: "atlassian",
  async execute(params, ctx) {
    // Nothing goes upstream before the credential is here.
    const credential = await ctx.credential();
    const config = jiraConfigOf(credential);
    try {
      return await runJiraSearchIssues(
        config,
        params as SearchIssuesParams,
        edgeReadDeps(config, ctx.signal),
      );
    } catch (err) {
      if (err instanceof AtlassianHttpError && err.status === 400)
        throw new ToolError(searchRefusedText());
      jiraReadFailure(err, credential);
    }
  },
};
