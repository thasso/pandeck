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
 * `github.token`'s steps (`vaultGithubTokens.ts` orders, caches and bounds
 * them) are here too, all on `api.github.com`: the user's repository check,
 * the App's JWT, the installation lookup, the read mint and its proof, and
 * the revoke of a token that failed it. The mint asks for exactly one
 * repository id and `{contents: "read", metadata: "read"}`; nothing here can
 * ask for more (R-ME).
 *
 * Nothing here keeps a token across calls or logs anything; results hold
 * only fixed words, never GitHub's text.
 */
import type { GithubAppClient, OAuthClient } from "./integrationClients.ts";
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

/**
 * An OAuth token-endpoint answer's body, or its classified failure. The status
 * comes first: 400, 401 and 403 are GitHub's refusals; any other non-2xx is
 * unreachable whatever its body holds. An `error` member counts only on a 2xx,
 * which is how GitHub refuses a code or refresh token (`bad_refresh_token`).
 */
function classifyOAuth(
  answer: HttpAnswer,
): { kind: "ok"; body: Record<string, unknown> } | Failure {
  if (answer.kind === "unreachable") return answer;
  const { status } = answer;
  if (status === 400 || status === 401 || status === 403)
    return { kind: "rejected" };
  if (status < 200 || status >= 300)
    return { kind: "unreachable", code: String(status) };
  const body = jsonObjectOf(answer.body);
  if (body?.error !== undefined) return { kind: "rejected" };
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

/** What the user's repository check found (AC5 step 3). */
export type GithubRepoResult =
  | { kind: "ok"; rid: number }
  | { kind: "denied" }
  | { kind: "unauthorized" }
  | { kind: "unavailable"; code: string };

/**
 * `GET /repos/{owner}/{repo}` with the user's token: the repository's id when
 * GitHub names it exactly `owner/repo` (any case) and grants the user `pull`.
 * A redirect (renamed or moved), 404 or 403 is `denied`, as is any other
 * name, id or permission; a 401 is `unauthorized` (GitHub refused the token,
 * the cue for one refresh, Task-1508 O1); every other failure is `unavailable`.
 */
export async function githubRepo(
  accessToken: string,
  name: { owner: string; repo: string },
  endpoint: GithubEndpoint | undefined,
): Promise<GithubRepoResult> {
  const answer = await githubApi(
    {
      method: "GET",
      path: `/repos/${name.owner}/${name.repo}`,
      bearer: accessToken,
    },
    endpoint,
  );
  if (answer.kind === "unreachable")
    return answer.code === "redirect"
      ? { kind: "denied" }
      : { kind: "unavailable", code: answer.code };
  if (answer.status === 404 || answer.status === 403) return { kind: "denied" };
  if (answer.status === 401) return { kind: "unauthorized" };
  if (answer.status !== 200)
    return { kind: "unavailable", code: String(answer.status) };
  const body = jsonObjectOf(answer.body);
  if (!body) return { kind: "unavailable", code: "bad_response" };
  const { full_name: fullName, id } = body;
  return typeof fullName === "string" &&
    fullName.toLowerCase() === `${name.owner}/${name.repo}`.toLowerCase() &&
    isGithubId(id) &&
    objectOf(body.permissions)?.pull === true
    ? { kind: "ok", rid: id }
    : { kind: "denied" };
}

/** The App's JWT lifetime and how much earlier it is replaced. */
const JWT_BACKDATE_S = 60;
const JWT_LIFETIME_S = 9 * 60;
export const JWT_RENEW_MARGIN_MS = 60_000;

const base64url = (text: string): string =>
  Buffer.from(text, "utf8").toString("base64url");

/**
 * The App's JWT (RS256): `iat` a minute back for clock drift, `exp` nine
 * minutes ahead, `iss` the client id. `expiresAt` is epoch milliseconds.
 */
export function githubAppJwt(
  client: GithubAppClient,
  nowMs: number,
): { jwt: string; expiresAt: number } {
  const nowS = Math.floor(nowMs / 1000);
  const exp = nowS + JWT_LIFETIME_S;
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    JSON.stringify({ iat: nowS - JWT_BACKDATE_S, exp, iss: client.clientId }),
  )}`;
  return {
    jwt: `${unsigned}.${client.sign(unsigned).toString("base64url")}`,
    expiresAt: exp * 1000,
  };
}

/** `GET /repos/{owner}/{repo}/installation` with the App's JWT. */
export async function githubInstallation(
  jwt: string,
  name: { owner: string; repo: string },
  endpoint: GithubEndpoint | undefined,
): Promise<
  | { kind: "ok"; installationId: number }
  | { kind: "denied" }
  | { kind: "unavailable"; code: string }
> {
  const answer = await githubApi(
    {
      method: "GET",
      path: `/repos/${name.owner}/${name.repo}/installation`,
      bearer: jwt,
    },
    endpoint,
  );
  if (answer.kind === "unreachable")
    return { kind: "unavailable", code: answer.code };
  if (answer.status === 404) return { kind: "denied" };
  if (answer.status !== 200)
    return { kind: "unavailable", code: String(answer.status) };
  const id = jsonObjectOf(answer.body)?.id;
  return isGithubId(id)
    ? { kind: "ok", installationId: id }
    : { kind: "unavailable", code: "bad_response" };
}

/** The only permissions a mint asks for, and the only ones it may answer. */
const READ_PERMISSIONS = { contents: "read", metadata: "read" } as const;

/**
 * `POST /app/installations/{id}/access_tokens` asking for exactly the one
 * repository id and read permissions; the body is built here and nowhere
 * else. A 2xx answers its JSON object for the proof.
 */
export async function mintReadToken(
  jwt: string,
  installationId: number,
  rid: number,
  endpoint: GithubEndpoint | undefined,
): Promise<
  | { kind: "ok"; body: Record<string, unknown> }
  | { kind: "unavailable"; code: string }
> {
  const answer = await githubApi(
    {
      method: "POST",
      path: `/app/installations/${installationId}/access_tokens`,
      bearer: jwt,
      json: { repository_ids: [rid], permissions: { ...READ_PERMISSIONS } },
    },
    endpoint,
  );
  if (answer.kind === "unreachable")
    return { kind: "unavailable", code: answer.code };
  if (answer.status < 200 || answer.status >= 300)
    return { kind: "unavailable", code: String(answer.status) };
  const body = jsonObjectOf(answer.body);
  return body
    ? { kind: "ok", body }
    : { kind: "unavailable", code: "bad_response" };
}

const GITHUB_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|\+00:00)$/;

/** An ISO 8601 UTC time (`Z` or `+00:00`, optional fraction) in epoch ms. */
function githubTimeOf(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = GITHUB_TIME_RE.exec(value);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number) as [number, number, number, number, number, number];
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const back = new Date(ms);
  // Rejects a day, hour or minute out of range rather than rolling it over.
  return back.getUTCFullYear() === year &&
    back.getUTCMonth() === month - 1 &&
    back.getUTCDate() === day &&
    back.getUTCHours() === hour &&
    back.getUTCMinutes() === minute &&
    back.getUTCSeconds() === second
    ? ms
    : undefined;
}

function isReadPermissions(value: unknown): boolean {
  const permissions = objectOf(value);
  if (!permissions) return false;
  const keys = Object.keys(permissions);
  return (
    keys.length === 2 &&
    permissions.contents === READ_PERMISSIONS.contents &&
    permissions.metadata === READ_PERMISSIONS.metadata
  );
}

/** Whether `value` lists exactly one repository, `rid`. */
function onlyRepository(value: unknown, rid: number): boolean {
  return (
    Array.isArray(value) && value.length === 1 && objectOf(value[0])?.id === rid
  );
}

/**
 * Proves a mint's answer (AC5 step 7), in this order: the token is one the
 * vault may hand on, the permissions are exactly read, `expires_at` is a UTC
 * time after `nowMs`, and the token reaches exactly `rid`, by its
 * `repositories` or else by `GET /installation/repositories` with it. A
 * failure carries the token only when it passed the first check, so only such
 * a token is ever revoked (F13).
 */
export async function proveReadToken(
  body: Record<string, unknown>,
  rid: number,
  now: () => number,
  endpoint: GithubEndpoint | undefined,
): Promise<
  | { kind: "ok"; token: string; expiresAt: number }
  | { kind: "failed"; reason: string; token?: string }
> {
  const { token } = body;
  if (!isToken(token)) return { kind: "failed", reason: "token" };
  if (!isReadPermissions(body.permissions))
    return { kind: "failed", reason: "permissions", token };
  const expiresAt = githubTimeOf(body.expires_at);
  if (expiresAt === undefined || expiresAt <= now())
    return { kind: "failed", reason: "expiry", token };
  if (body.repositories !== undefined) {
    return onlyRepository(body.repositories, rid)
      ? { kind: "ok", token, expiresAt }
      : { kind: "failed", reason: "repositories", token };
  }
  const answer = await githubApi(
    { method: "GET", path: "/installation/repositories", bearer: token },
    endpoint,
  );
  const listed =
    answer.kind === "answer" && answer.status === 200
      ? jsonObjectOf(answer.body)
      : undefined;
  return listed?.total_count === 1 && onlyRepository(listed.repositories, rid)
    ? { kind: "ok", token, expiresAt }
    : { kind: "failed", reason: "repository list", token };
}

/** `DELETE /installation/token`: best-effort; the outcome is not read. */
export async function revokeInstallationToken(
  token: string,
  endpoint: GithubEndpoint | undefined,
): Promise<void> {
  await githubApi(
    { method: "DELETE", path: "/installation/token", bearer: token },
    endpoint,
  );
}
