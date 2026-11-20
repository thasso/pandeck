/**
 * `slack_search` on the edge (Task-1454): Pandeck's own Slack message search, with the same schema,
 * description and payload, run as the calling user with the Slack access
 * view the vault hands the edge. Read-only, no approval.
 */
import {
  SLACK_SEARCH_DESCRIPTION,
  slackSearchParamsSchema,
  runSlackSearch,
  type SlackSearchParams,
} from "../slackRead.ts";
import type { ToolDescriptor } from "./descriptor.ts";
import { runEdgeSlackRead } from "./slackRead.ts";

export const slackSearch: ToolDescriptor = {
  name: "slack_search",
  description: SLACK_SEARCH_DESCRIPTION,
  inputSchema: slackSearchParamsSchema,
  effect: "read",
  actionKey: "slack:read",
  integration: "slack",
  execute: (params, ctx) =>
    runEdgeSlackRead(ctx, (config, deps) =>
      runSlackSearch(params as SlackSearchParams, config, deps),
    ),
};
