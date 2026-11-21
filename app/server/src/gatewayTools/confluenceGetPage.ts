/**
 * `confluence_get_page` on the edge (Task-1439 P2): one page as Markdown with
 * its optional sections, with the same schema, description and payload as
 * Pandeck's local tool, run with the calling user's Atlassian credential.
 * Read-only, no approval. A payload above the edge's 60,000-character
 * ceiling answers `result_too_large` (D5); a smaller `maxChars`, fewer
 * sections or a lower `maxComments` fits.
 */
import {
  CONFLUENCE_GET_PAGE_DESCRIPTION,
  CONFLUENCE_GET_PAGE_SCHEMA,
  runConfluenceGetPage,
  type ConfluenceGetPageParams,
} from "../confluenceRead.ts";
import { confluenceConfigOf, confluenceFailure } from "./atlassian.ts";
import type { ToolDescriptor } from "./descriptor.ts";

export const confluenceGetPage: ToolDescriptor = {
  name: "confluence_get_page",
  description: CONFLUENCE_GET_PAGE_DESCRIPTION,
  inputSchema: CONFLUENCE_GET_PAGE_SCHEMA,
  effect: "read",
  actionKey: "confluence:read",
  integration: "atlassian",
  async execute(params, ctx) {
    // Nothing goes upstream before the credential is here.
    const credential = await ctx.credential();
    try {
      return await runConfluenceGetPage(
        confluenceConfigOf(credential),
        params as ConfluenceGetPageParams,
        { signal: ctx.signal },
      );
    } catch (err) {
      confluenceFailure(err, credential);
    }
  },
};
