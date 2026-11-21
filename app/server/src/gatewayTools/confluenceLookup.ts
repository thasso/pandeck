/**
 * `confluence_lookup` on the edge (Task-1439 P2): spaces, page trees and a
 * page's labels, attachments, comments or a comment's replies, with the same
 * schema, description and payload as Pandeck's local tool, run with the
 * calling user's Atlassian credential. Read-only, no approval.
 */
import {
  CONFLUENCE_LOOKUP_DESCRIPTION,
  CONFLUENCE_LOOKUP_SCHEMA,
  runConfluenceLookup,
  type ConfluenceLookupParams,
} from "../confluenceRead.ts";
import { confluenceConfigOf, confluenceFailure } from "./atlassian.ts";
import type { ToolDescriptor } from "./descriptor.ts";

export const confluenceLookup: ToolDescriptor = {
  name: "confluence_lookup",
  description: CONFLUENCE_LOOKUP_DESCRIPTION,
  inputSchema: CONFLUENCE_LOOKUP_SCHEMA,
  effect: "read",
  actionKey: "confluence:read",
  integration: "atlassian",
  async execute(params, ctx) {
    // Nothing goes upstream before the credential is here.
    const credential = await ctx.credential();
    try {
      return await runConfluenceLookup(
        confluenceConfigOf(credential),
        params as ConfluenceLookupParams,
        { signal: ctx.signal },
      );
    } catch (err) {
      confluenceFailure(err, credential);
    }
  },
};
