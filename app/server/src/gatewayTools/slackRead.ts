/**
 * What the edge's Slack reads (`slack_search`, `slack_conversation_read`,
 * `slack_thread_read`, `slack_unread`, Task-1454) share: the core's config
 * from the vault's access view, and the core's failures as fixed texts.
 *
 * Metadata is cached per `teamId:userId` from the view, never from input, so
 * one user's lists never answer another's call. The timezone is the calling
 * user's Slack profile zone, UTC when Slack has none. A caller sees only the
 * texts below: never a Slack error code, body, header, input or the token.
 */
import {
  SlackAnswerError,
  SlackApiError,
  SlackHttpError,
  SlackReadRefusal,
  slackProfileTimeZone,
  type SlackReadConfig,
  type SlackReadDeps,
  type SlackReadRefusalCode,
} from "../slackRead.ts";
import { ToolError, type SlackToolDescriptor } from "./descriptor.ts";
import type { SlackAccessView } from "./slack.ts";
import { SLACK_REJECTED_TEXT } from "./toolCredential.ts";

/** The edge's text for each refusal: the local wording without the input. */
const REFUSAL_TEXT: Record<SlackReadRefusalCode, string> = {
  query_empty: "query must not be empty.",
  conversation_empty: "conversation must not be empty.",
  person_empty: "person must not be empty.",
  conversation_ambiguous:
    "That conversation name matches more than one conversation; use a conversation id.",
  conversation_not_found:
    "No accessible Slack conversation matches; use a channel or DM id, an accessible channel name, or an unambiguous person name.",
  person_ambiguous:
    "That name matches more than one Slack user; use a user id.",
  person_deleted: "That name matches only deactivated Slack users.",
  person_not_found: "No Slack user matches that name.",
  ts_invalid: "threadTs must be a Slack timestamp such as 1717426730.123456.",
  date_invalid: "date must be YYYY-MM-DD.",
  time_invalid:
    "oldest and latest must be a Slack timestamp, epoch seconds or RFC3339.",
};

/** Slack's error codes for a token that no longer works. */
const REJECTED_CODES: ReadonlySet<string> = new Set([
  "not_authed",
  "invalid_auth",
  "token_revoked",
  "token_expired",
  "account_inactive",
]);

/** Re-listing within a minute is what spends Slack's per-app list budget. */
const EDGE_UNREAD_LIST_MAX_AGE_MS = 60_000;

/**
 * A core failure as its fixed text. `method` is always one of the core's
 * literals and `retryAfterS`/`status` integers; anything else, an abort
 * included, is thrown on for the host to classify.
 */
export function slackReadFailure(err: unknown): never {
  if (err instanceof SlackReadRefusal)
    throw new ToolError(REFUSAL_TEXT[err.code]);
  if (err instanceof SlackApiError) {
    if (REJECTED_CODES.has(err.code)) throw new ToolError(SLACK_REJECTED_TEXT);
    if (err.code === "missing_scope")
      throw new ToolError(
        "Slack refused: the connection lacks a permission this read needs; reconnect Slack on the gateway's page.",
      );
    if (err.code === "channel_not_found" || err.code === "not_in_channel")
      throw new ToolError("Slack found no such conversation for this user.");
    if (err.code === "thread_not_found")
      throw new ToolError("Slack found no such thread in that conversation.");
    if (err.code === "ratelimited")
      throw new ToolError(
        `Slack is rate-limiting ${err.method}; try again in a minute.`,
      );
    throw new ToolError(`Slack refused ${err.method}.`);
  }
  if (err instanceof SlackHttpError) {
    if (err.status === 429)
      throw new ToolError(
        err.retryAfterS !== undefined
          ? `Slack is rate-limiting ${err.method}; retry after ${err.retryAfterS} seconds.`
          : `Slack is rate-limiting ${err.method}; try again in a minute.`,
      );
    throw new ToolError(`Slack answered HTTP ${err.status}.`);
  }
  if (err instanceof SlackAnswerError)
    throw new ToolError("Slack's answer could not be read.");
  throw err;
}

/** The core's config for the calling user's view. */
async function edgeConfig(
  view: SlackAccessView,
  deps: SlackReadDeps,
): Promise<SlackReadConfig> {
  const cacheKey = `${view.teamId}:${view.userId}`;
  const timezone = await slackProfileTimeZone(
    { token: view.accessToken, cacheKey },
    view.userId,
    deps,
  );
  return {
    token: view.accessToken,
    teamId: view.teamId,
    workspaceHost: view.workspaceHost,
    timezone,
    defaultMaxResults: 20,
    grantedUserScopes: view.scope
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
    source: "gateway-user-oauth",
    cacheKey,
    unreadListMaxAgeMs: EDGE_UNREAD_LIST_MAX_AGE_MS,
  };
}

/**
 * Runs one core read as the calling user: the vault's view first, before any
 * Slack request, then the read; failures become fixed texts.
 */
export async function runEdgeSlackRead(
  ctx: Parameters<SlackToolDescriptor["execute"]>[1],
  read: (
    config: SlackReadConfig,
    deps: SlackReadDeps,
  ) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const view = await ctx.credential();
  const deps = { signal: ctx.signal };
  try {
    return await read(await edgeConfig(view, deps), deps);
  } catch (err) {
    slackReadFailure(err);
  }
}
