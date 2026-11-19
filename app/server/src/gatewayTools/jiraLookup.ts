/**
 * `jira_lookup` on the edge (Task-1439): Pandeck's own discovery (fields,
 * projects, users, issue link types, sprints), with the same schema,
 * description and payload, run with the calling user's Atlassian credential.
 * Read-only, no approval.
 */
import {
  JIRA_LOOKUP_DESCRIPTION,
  lookupParamsSchema,
  runJiraLookup,
  type LookupParams,
} from "../jiraLookup.ts";
import { jiraConfigOf } from "./atlassian.ts";
import type { ToolDescriptor } from "./descriptor.ts";
import { edgeReadDeps, jiraReadFailure } from "./jiraRead.ts";

export const jiraLookup: ToolDescriptor = {
  name: "jira_lookup",
  description: JIRA_LOOKUP_DESCRIPTION,
  inputSchema: lookupParamsSchema,
  effect: "read",
  actionKey: "jira:read",
  integration: "atlassian",
  async execute(params, ctx) {
    // Nothing goes upstream before the credential is here.
    const credential = await ctx.credential();
    const config = jiraConfigOf(credential);
    try {
      return await runJiraLookup(
        config,
        params as LookupParams,
        edgeReadDeps(config, ctx.signal),
      );
    } catch (err) {
      jiraReadFailure(err, credential);
    }
  },
};
