/**
 * `confluence_search` on the edge (Task-1439 P2): Pandeck's own CQL search,
 * with the same schema, description and payload, run with the calling user's
 * Atlassian credential. Read-only, no approval.
 */
import {
  CONFLUENCE_SEARCH_DESCRIPTION,
  CONFLUENCE_SEARCH_SCHEMA,
  runConfluenceSearch,
  type ConfluenceSearchParams,
} from "../confluenceRead.ts";
import { confluenceConfigOf, confluenceFailure } from "./atlassian.ts";
import type { ToolDescriptor } from "./descriptor.ts";

export const confluenceSearch: ToolDescriptor = {
  name: "confluence_search",
  description: CONFLUENCE_SEARCH_DESCRIPTION,
  inputSchema: CONFLUENCE_SEARCH_SCHEMA,
  effect: "read",
  actionKey: "confluence:read",
  integration: "atlassian",
  async execute(params, ctx) {
    // Nothing goes upstream before the credential is here.
    const credential = await ctx.credential();
    try {
      return await runConfluenceSearch(
        confluenceConfigOf(credential),
        params as ConfluenceSearchParams,
        { signal: ctx.signal },
      );
    } catch (err) {
      confluenceFailure(err, credential);
    }
  },
};
