/**
 * `slack_conversation_read` on the edge (Task-1454): Pandeck's own conversation read, with the same schema,
 * description and payload, run as the calling user with the Slack access
 * view the vault hands the edge. Read-only, no approval.
 */
import {
  SLACK_CONVERSATION_READ_DESCRIPTION,
  slackConversationReadParamsSchema,
  runSlackConversationRead,
  type SlackConversationReadParams,
} from "../slackRead.ts";
import type { ToolDescriptor } from "./descriptor.ts";
import { runEdgeSlackRead } from "./slackRead.ts";

export const slackConversationRead: ToolDescriptor = {
  name: "slack_conversation_read",
  description: SLACK_CONVERSATION_READ_DESCRIPTION,
  inputSchema: slackConversationReadParamsSchema,
  effect: "read",
  actionKey: "slack:read",
  integration: "slack",
  execute: (params, ctx) =>
    runEdgeSlackRead(ctx, (config, deps) =>
      runSlackConversationRead(
        params as SlackConversationReadParams,
        config,
        deps,
      ),
    ),
};
