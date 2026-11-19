/**
 * The vault's Slack OAuth v2 client for user tokens with token rotation
 * (Task-1452, Task-1420 plan v03 PR1). The code exchange and every refresh go
 * only to `https://slack.com/api/oauth.v2.access` as form bodies with the
 * client in the body; the identity check only to
 * `https://slack.com/api/auth.test` with the new access token as Bearer. All
 * through `vaultHttps.ts`: fixed host, no redirect followed, bounded.
 *
 * Slack answers most failures with HTTP 200 `{ok: false, error}`. Both calls
 * classify alike: `ok: false` with a transient error (rate limit, Slack's own
 * failure) and HTTP 3xx, 429, 5xx, network, deadline, oversize or a body that
 * is no Slack answer are `unreachable`; any other `ok: false` and any other
 * 4xx are `rejected`.
 *
 * The protocol is documented, not yet observed against the app (owner
 * decision, 2026-11-19), so every `ok: true` answer outside the documented
 * user-token shape fails closed as `unusable`: a token at the top level of the
 * exchange (a bot token), one nested under `authed_user` in a refresh, a
 * `token_type` other than `user`, a refresh that hands back no new refresh
 * token. An exchange without a refresh token is `noRefreshToken`: rotation is
 * off on the app. Nothing here keeps a token across calls or logs anything;
 * results hold only fixed words, never Slack's text.
 */
import type { OAuthClient } from "./integrationClients.ts";
import {
  MAX_EXPIRES_IN_S,
  isToken,
  vaultCall,
  type HttpAnswer,
  type VaultEndpoint,
} from "./vaultHttps.ts";
import { isSlackTeamId } from "./vaultMethods.ts";

const SLACK_HOST = "slack.com";
const ACCESS_PATH = "/api/oauth.v2.access";
const AUTH_TEST_PATH = "/api/auth.test";
const MAX_SCOPE_CHARS = 2_048;
const MAX_TEAM_NAME_CHARS = 256;
/** Slack's `error` words that mean "try again later", not "refused". */
const TRANSIENT_ERRORS = [
  "ratelimited",
  "internal_error",
  "fatal_error",
  "service_unavailable",
  "request_timeout",
] as const;
const USER_ID_RE = /^[UW][A-Z0-9]{2,30}$/;
/** `<workspace>.slack.com`, or an Enterprise Grid org's `.enterprise.` host. */
const WORKSPACE_HOST_RE =
  /^[a-z0-9][a-z0-9-]{0,62}(\.enterprise)?\.slack\.com$/;

/** Where to connect instead of `slack.com` (tests): never the URL. */
export type SlackEndpoint = VaultEndpoint;

/** A Slack user id. */
export function isSlackUserId(value: unknown): value is string {
  return typeof value === "string" && USER_ID_RE.test(value);
}

/** A workspace's host as `auth.test` names it, lowercase. */
export function isSlackWorkspaceHost(value: unknown): value is string {
  return typeof value === "string" && WORKSPACE_HOST_RE.test(value);
}

/** A validated user-token answer; held in memory only. */
interface SlackTokens {
  accessToken: string;
  refreshToken: string;
  expiresInS: number;
  scope: string | undefined;
}

/** A code exchange's user tokens and whose they are. */
interface SlackGrant {
  tokens: SlackTokens;
  userId: string;
  teamId: string;
  teamName: string | undefined;
}

type Failure = { kind: "rejected" } | { kind: "unreachable"; code: string };

export type SlackExchangeResult =
  | { kind: "ok"; grant: SlackGrant }
  | { kind: "noRefreshToken" }
  | { kind: "unusable" }
  | Failure;

export type SlackRefreshResult =
  { kind: "ok"; tokens: SlackTokens } | { kind: "unusable" } | Failure;

export type SlackIdentityResult =
  | { kind: "ok"; teamId: string; userId: string; workspaceHost: string }
  | { kind: "unusable" }
  | Failure;

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isExpiresIn(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_EXPIRES_IN_S
  );
}

function isScope(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === "string" && value.length <= MAX_SCOPE_CHARS)
  );
}

/** A Slack Web API answer's `ok: true` body, or its classified failure. */
function classify(
  answer: HttpAnswer,
): { kind: "ok"; body: Record<string, unknown> } | Failure {
  if (answer.kind === "unreachable") return answer;
  const { status } = answer;
  if (status === 429 || status >= 500)
    return { kind: "unreachable", code: String(status) };
  if (status >= 400) return { kind: "rejected" };
  if (status < 200 || status >= 300)
    return { kind: "unreachable", code: String(status) };
  let body: Record<string, unknown> | undefined;
  try {
    body = objectOf(JSON.parse(answer.body));
  } catch {
    body = undefined;
  }
  if (body?.ok === true) return { kind: "ok", body };
  if (body?.ok !== false) return { kind: "unreachable", code: "bad_response" };
  const transient = TRANSIENT_ERRORS.find((word) => word === body.error);
  return transient
    ? { kind: "unreachable", code: transient }
    : { kind: "rejected" };
}

function post(
  path: string,
  fields: Record<string, string>,
  bearer: string | undefined,
  endpoint: SlackEndpoint | undefined,
): Promise<HttpAnswer> {
  const body = new URLSearchParams(fields).toString();
  return vaultCall(
    SLACK_HOST,
    {
      method: "POST",
      path,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
        ...(bearer !== undefined ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body,
    },
    endpoint,
  );
}

/**
 * The authorization-code exchange for a user token. Only `authed_user`'s
 * tokens count; the answer's top-level `access_token`, if any, is a bot
 * token and is never read.
 */
export async function exchangeSlackCode(
  client: OAuthClient,
  grant: { code: string; redirectUri: string },
  endpoint: SlackEndpoint | undefined,
): Promise<SlackExchangeResult> {
  const answer = classify(
    await post(
      ACCESS_PATH,
      {
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code: grant.code,
        redirect_uri: grant.redirectUri,
      },
      undefined,
      endpoint,
    ),
  );
  if (answer.kind !== "ok") return answer;
  const user = objectOf(answer.body.authed_user);
  if (user?.token_type !== "user" || !isToken(user.access_token))
    return { kind: "unusable" };
  if (user.refresh_token === undefined) return { kind: "noRefreshToken" };
  const team = objectOf(answer.body.team);
  if (
    !isToken(user.refresh_token) ||
    !isExpiresIn(user.expires_in) ||
    !isSlackUserId(user.id) ||
    !isScope(user.scope) ||
    !isSlackTeamId(team?.id)
  )
    return { kind: "unusable" };
  const name = team.name;
  return {
    kind: "ok",
    grant: {
      tokens: {
        accessToken: user.access_token,
        refreshToken: user.refresh_token,
        expiresInS: user.expires_in,
        scope: user.scope,
      },
      userId: user.id,
      teamId: team.id,
      teamName:
        typeof name === "string" &&
        name.length > 0 &&
        name.length <= MAX_TEAM_NAME_CHARS
          ? name
          : undefined,
    },
  };
}

/**
 * One refresh of a rotating user token. Success needs a top-level user token
 * and a new refresh token unlike `refreshToken`: Slack has consumed the old
 * one, so an answer without a usable replacement is `unusable`, never a
 * success that keeps the old one.
 */
export async function refreshSlack(
  client: OAuthClient,
  refreshToken: string,
  endpoint: SlackEndpoint | undefined,
): Promise<SlackRefreshResult> {
  const answer = classify(
    await post(
      ACCESS_PATH,
      {
        client_id: client.clientId,
        client_secret: client.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      },
      undefined,
      endpoint,
    ),
  );
  if (answer.kind !== "ok") return answer;
  const {
    token_type: tokenType,
    access_token: access,
    refresh_token: refresh,
    expires_in: expiresIn,
    scope,
  } = answer.body;
  if (
    tokenType !== "user" ||
    !isToken(access) ||
    !isToken(refresh) ||
    refresh === refreshToken ||
    !isExpiresIn(expiresIn) ||
    !isScope(scope)
  )
    return { kind: "unusable" };
  return {
    kind: "ok",
    tokens: {
      accessToken: access,
      refreshToken: refresh,
      expiresInS: expiresIn,
      scope,
    },
  };
}

/** Whose token `accessToken` is, and its workspace's host, per `auth.test`. */
export async function slackAuthTest(
  accessToken: string,
  endpoint: SlackEndpoint | undefined,
): Promise<SlackIdentityResult> {
  const answer = classify(
    await post(AUTH_TEST_PATH, {}, accessToken, endpoint),
  );
  if (answer.kind !== "ok") return answer;
  const { team_id: teamId, user_id: userId, url } = answer.body;
  let host: string | undefined;
  try {
    const parsed = typeof url === "string" ? new URL(url) : undefined;
    if (parsed?.protocol === "https:") host = parsed.host;
  } catch {
    host = undefined;
  }
  return isSlackTeamId(teamId) &&
    isSlackUserId(userId) &&
    isSlackWorkspaceHost(host)
    ? { kind: "ok", teamId, userId, workspaceHost: host }
    : { kind: "unusable" };
}
