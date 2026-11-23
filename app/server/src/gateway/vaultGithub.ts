/**
 * The vault's GitHub App client (Task-1444, Task-1440 plan v06 PR1). The
 * user's OAuth code exchange and every refresh go only to
 * `https://github.com/login/oauth/access_token` as form bodies with the
 * client in the body and `Accept: application/json`; the identity check only
 * to `https://api.github.com/user` with the new user token. All through
 * `vaultHttps.ts`: fixed host, no redirect followed, 8 s, 64 KiB.
 *
 * GitHub answers a refused grant with HTTP 200 `{error}`, so any `error`
 * member is `rejected` whatever the status, as are 400, 401 and 403. Other
 * statuses, network failures, the deadline and bodies that are no JSON
 * object are `unreachable`. An exchange must hand back an access token, a
 * refresh token and both lifetimes, else `rejected`. A refresh must hand back
 * a new refresh token (GitHub rotates it on every use, so the stored one is
 * spent): an answer without a usable replacement is `unusable`, never a
 * success that keeps the old one.
 *
 * Nothing here keeps a token across calls or logs anything; results hold
 * only fixed words, never GitHub's text.
 */
import type { OAuthClient } from "./integrationClients.ts";
import {
  MAX_EXPIRES_IN_S,
  isToken,
  vaultCall,
  type HttpAnswer,
  type VaultEndpoint,
} from "./vaultHttps.ts";
import { isGithubLogin } from "./vaultMethods.ts";

const WEB_HOST = "github.com";
const API_HOST = "api.github.com";
const ACCESS_TOKEN_PATH = "/login/oauth/access_token";
const USER_AGENT = "pandeck-gateway-vault";
/** The REST API version every `api.github.com` call names. */
const API_VERSION = "2022-11-28";

/** Where to connect instead of GitHub's hosts (tests): never the URL. */
export type GithubEndpoint = VaultEndpoint;

/** A validated user-token answer; held in memory only. */
interface GithubTokens {
  accessToken: string;
  refreshToken: string;
  expiresInS: number;
  refreshExpiresInS: number;
}

type Failure = { kind: "rejected" } | { kind: "unreachable"; code: string };

export type GithubExchangeResult =
  { kind: "ok"; tokens: GithubTokens } | Failure;

export type GithubRefreshResult =
  { kind: "ok"; tokens: GithubTokens } | { kind: "unusable" } | Failure;

export type GithubUserResult =
  | { kind: "ok"; login: string; githubUserId: number }
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

/** A GitHub numeric id: a positive safe integer. */
export function isGithubId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** `text`'s JSON object, if it is one. */
function jsonObjectOf(text: string): Record<string, unknown> | undefined {
  try {
    return objectOf(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** An OAuth token-endpoint answer's body, or its classified failure. */
function classifyOAuth(
  answer: HttpAnswer,
): { kind: "ok"; body: Record<string, unknown> } | Failure {
  if (answer.kind === "unreachable") return answer;
  const body = jsonObjectOf(answer.body);
  if (body?.error !== undefined) return { kind: "rejected" };
  const { status } = answer;
  if (status === 400 || status === 401 || status === 403)
    return { kind: "rejected" };
  if (status < 200 || status >= 300)
    return { kind: "unreachable", code: String(status) };
  return body
    ? { kind: "ok", body }
    : { kind: "unreachable", code: "bad_response" };
}

function tokensOf(body: Record<string, unknown>): GithubTokens | undefined {
  const {
    access_token: access,
    refresh_token: refresh,
    expires_in: expiresIn,
    refresh_token_expires_in: refreshExpiresIn,
  } = body;
  return isToken(access) &&
    isToken(refresh) &&
    isExpiresIn(expiresIn) &&
    isExpiresIn(refreshExpiresIn)
    ? {
        accessToken: access,
        refreshToken: refresh,
        expiresInS: expiresIn,
        refreshExpiresInS: refreshExpiresIn,
      }
    : undefined;
}

function postToken(
  fields: Record<string, string>,
  endpoint: GithubEndpoint | undefined,
): Promise<HttpAnswer> {
  const body = new URLSearchParams(fields).toString();
  return vaultCall(
    WEB_HOST,
    {
      method: "POST",
      path: ACCESS_TOKEN_PATH,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": USER_AGENT,
      },
      body,
    },
    endpoint,
  );
}

/**
 * One `api.github.com` request with `bearer` (a user token, the App's JWT or
 * an installation token) and the REST API's headers.
 */
function githubApi(
  request: {
    method: "GET" | "POST" | "DELETE";
    path: string;
    bearer: string;
    json?: unknown;
  },
  endpoint: GithubEndpoint | undefined,
): Promise<HttpAnswer> {
  const body =
    request.json === undefined ? undefined : JSON.stringify(request.json);
  return vaultCall(
    API_HOST,
    {
      method: request.method,
      path: request.path,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${request.bearer}`,
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": API_VERSION,
        ...(body !== undefined
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            }
          : {}),
      },
      ...(body !== undefined ? { body } : {}),
    },
    endpoint,
  );
}

/** The authorization-code exchange for the user's tokens. */
export async function exchangeGithubCode(
  client: OAuthClient,
  grant: { code: string; redirectUri: string },
  endpoint: GithubEndpoint | undefined,
): Promise<GithubExchangeResult> {
  const answer = classifyOAuth(
    await postToken(
      {
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code: grant.code,
        redirect_uri: grant.redirectUri,
      },
      endpoint,
    ),
  );
  if (answer.kind !== "ok") return answer;
  const tokens = tokensOf(answer.body);
  return tokens ? { kind: "ok", tokens } : { kind: "rejected" };
}

/** One refresh; success needs a new refresh token unlike `refreshToken`. */
export async function refreshGithub(
  client: OAuthClient,
  refreshToken: string,
  endpoint: GithubEndpoint | undefined,
): Promise<GithubRefreshResult> {
  const answer = classifyOAuth(
    await postToken(
      {
        client_id: client.clientId,
        client_secret: client.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      },
      endpoint,
    ),
  );
  if (answer.kind !== "ok") return answer;
  const tokens = tokensOf(answer.body);
  return tokens && tokens.refreshToken !== refreshToken
    ? { kind: "ok", tokens }
    : { kind: "unusable" };
}

/** Whose token `accessToken` is, per `GET /user`. */
export async function githubUser(
  accessToken: string,
  endpoint: GithubEndpoint | undefined,
): Promise<GithubUserResult> {
  const answer = await githubApi(
    { method: "GET", path: "/user", bearer: accessToken },
    endpoint,
  );
  if (answer.kind === "unreachable") return answer;
  if (answer.status === 401 || answer.status === 403)
    return { kind: "rejected" };
  if (answer.status !== 200)
    return { kind: "unreachable", code: String(answer.status) };
  const body = jsonObjectOf(answer.body);
  return isGithubLogin(body?.login) && isGithubId(body.id)
    ? { kind: "ok", login: body.login, githubUserId: body.id }
    : { kind: "unusable" };
}
