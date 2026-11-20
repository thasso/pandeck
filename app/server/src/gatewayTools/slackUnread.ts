/**
 * `slack_unread` on the edge (Task-1454): Pandeck's own personal unread aggregation, with the same schema,
 * description and payload, run as the calling user with the Slack access
 * view the vault hands the edge. Read-only, no approval.
 */
import {
  SLACK_UNREAD_DESCRIPTION,
  slackUnreadParamsSchema,
  runSlackUnread,
  type SlackUnreadParams,
} from "../slackRead.ts";
import type { ToolDescriptor } from "./descriptor.ts";
import { runEdgeSlackRead } from "./slackRead.ts";

export const slackUnread: ToolDescriptor = {
  name: "slack_unread",
  description: SLACK_UNREAD_DESCRIPTION,
  inputSchema: slackUnreadParamsSchema,
  effect: "read",
  actionKey: "slack:read",
  integration: "slack",
  execute: (params, ctx) =>
    runEdgeSlackRead(ctx, (config, deps) =>
      runSlackUnread(params as SlackUnreadParams, config, deps),
    ),
};
