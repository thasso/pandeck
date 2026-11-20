/**
 * `slack_thread_read` on the edge (Task-1454): Pandeck's own thread read, with the same schema,
 * description and payload, run as the calling user with the Slack access
 * view the vault hands the edge. Read-only, no approval.
 */
import {
  SLACK_THREAD_READ_DESCRIPTION,
  slackThreadReadParamsSchema,
  runSlackThreadRead,
  type SlackThreadReadParams,
} from "../slackRead.ts";
import type { ToolDescriptor } from "./descriptor.ts";
import { runEdgeSlackRead } from "./slackRead.ts";

export const slackThreadRead: ToolDescriptor = {
  name: "slack_thread_read",
  description: SLACK_THREAD_READ_DESCRIPTION,
  inputSchema: slackThreadReadParamsSchema,
  effect: "read",
  actionKey: "slack:read",
  integration: "slack",
  execute: (params, ctx) =>
    runEdgeSlackRead(ctx, (config, deps) =>
      runSlackThreadRead(params as SlackThreadReadParams, config, deps),
    ),
};
