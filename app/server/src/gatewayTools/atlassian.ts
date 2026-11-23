/**
 * The Atlassian credential on the edge (Task-1397): a site, an email and an
 * API token, checked here when it is set and again whenever it is decoded,
 * and stored by the gateway only as the opaque JSON `encodeAtlassianCredential`
 * makes. The site is a bare `<name>.atlassian.net` host, so a stored
 * credential can only ever be sent to Atlassian (SSRF guard). Errors become
 * fixed texts; no upstream body or credential reaches a caller. Two
 * exceptions (ADR-0005), never with credential material, sanitized and
 * capped: a rejected `jira_search_issues` (HTTP 400) may show Jira's own
 * `errorMessages`/`errors` reasons (D4-yes, `jiraSearchIssues.ts`), and
 * `jira_mutate_issue` its shared code's messages and Jira's reasons for a
 * write call's 4xx (D-W2, `writeFailure.ts`).
 *
 * Or the vault's OAuth access view (Task-1411), `{kind: "atlassian-oauth",
 * site, cloudId, accessToken, expiresAt}`, decoded and checked per call and
 * never stored here: Jira calls go with Bearer to the fixed
 * `api.atlassian.com/ex/jira/<cloudId>` base, the site only makes browse URLs.
 * Any other `kind` is refused.
 *
 * Confluence reads (Task-1439 P2) go the same way to
 * `api.atlassian.com/ex/confluence/<cloudId>`; their failures are fixed texts
 * too, with no Confluence-read exception.
 */
import { AtlassianHttpError } from "../atlassian/atlassianFetch.ts";
import {
  ConfluenceReadRefusal,
  type ConfluenceConfig,
  type ConfluenceReadRefusalCode,
} from "../atlassian/confluenceClient.ts";
import { deadlineSignal } from "../httpRetry.ts";
import { jiraGet, type JiraConfig } from "../jiraClient.ts";
import {
  ToolError,
  type AtlassianCredential,
  type AtlassianTokenCredential,
} from "./descriptor.ts";

const SITE_RE = /^[a-z0-9][a-z0-9-]{0,62}\.atlassian\.net$/;
const CLOUD_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OAUTH_KIND = "atlassian-oauth";
const MAX_ACCESS_TOKEN_CHARS = 8192;
/** Printable ASCII without space: what fits an `Authorization` header. */
const TOKEN_RE = /^[\x21-\x7e]+$/;
const CHECK_TIMEOUT_MS = 15_000;
const MAX_NAME_CHARS = 200;

/** The checked credential, or undefined. */
export function parseAtlassianCredential(
  input: unknown,
): AtlassianTokenCredential | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const { site, email, token } = input as Record<string, unknown>;
  if (
    typeof site !== "string" ||
    typeof email !== "string" ||
    typeof token !== "string"
  )
    return undefined;
  const host = site.toLowerCase();
  if (!SITE_RE.test(host)) return undefined;
  if (
    email.length < 3 ||
    email.length > 254 ||
    email.split("@").length !== 2 ||
    /\s/.test(email)
  )
    return undefined;
  if (token.length < 1 || token.length > 512) return undefined;
  return { site: host, email, token };
}

export function encodeAtlassianCredential(
  credential: AtlassianTokenCredential,
): string {
  return JSON.stringify({
    site: credential.site,
    email: credential.email,
    token: credential.token,
  });
}

/**
 * The vault's answer, checked again: an API token or an OAuth access view;
 * undefined on any failure, an unknown `kind` included.
 */
export function decodeAtlassianCredential(
  text: string,
): AtlassianCredential | undefined {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof input !== "object" || input === null) return undefined;
  const { kind, site, cloudId, accessToken } = input as Record<string, unknown>;
  if (kind === undefined) return parseAtlassianCredential(input);
  if (kind !== OAUTH_KIND) return undefined;
  if (
    typeof site !== "string" ||
    !SITE_RE.test(site) ||
    typeof cloudId !== "string" ||
    !CLOUD_ID_RE.test(cloudId) ||
    typeof accessToken !== "string" ||
    accessToken.length > MAX_ACCESS_TOKEN_CHARS ||
    !TOKEN_RE.test(accessToken)
  )
    return undefined;
  return { site, cloudId, accessToken };
}

export function jiraConfigOf(credential: AtlassianCredential): JiraConfig {
  return "accessToken" in credential
    ? {
        jiraHost: credential.site,
        cloudId: credential.cloudId,
        bearerToken: credential.accessToken,
      }
    : {
        jiraHost: credential.site,
        atlassianEmail: credential.email,
        atlassianToken: credential.token,
      };
}

/** The Confluence config: Bearer to the API base, or Basic to the site. */
export function confluenceConfigOf(
  credential: AtlassianCredential,
): ConfluenceConfig {
  return "accessToken" in credential
    ? {
        host: credential.site,
        cloudId: credential.cloudId,
        bearerToken: credential.accessToken,
      }
    : {
        host: credential.site,
        atlassianEmail: credential.email,
        atlassianToken: credential.token,
      };
}

/**
 * The credential's kind and site, and the email an API token was set with;
 * never a token.
 */
export function describeAtlassianCredential(credential: AtlassianCredential): {
  site: string;
  email?: string;
  kind: "token" | "oauth";
} {
  return "accessToken" in credential
    ? { site: credential.site, kind: "oauth" }
    : { site: credential.site, email: credential.email, kind: "token" };
}

export type AtlassianCheck =
  | { ok: true; displayName?: string; accountId?: string }
  | { ok: false; problem: "rejected" | "unreachable" | "failed" };

const named = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0
    ? value.slice(0, MAX_NAME_CHARS)
    : undefined;

/**
 * Asks Atlassian who the credential is (`/rest/api/3/myself`, on the site or,
 * with Bearer, on the fixed API base).
 */
export async function checkAtlassian(
  credential: AtlassianCredential,
  signal: AbortSignal,
): Promise<AtlassianCheck> {
  try {
    const me = await jiraGet<Record<string, unknown>>(
      jiraConfigOf(credential),
      "/rest/api/3/myself",
      undefined,
      { signal: deadlineSignal(CHECK_TIMEOUT_MS, signal), retry: false },
    );
    const displayName = named(me.displayName);
    const accountId = named(me.accountId);
    return {
      ok: true,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(accountId !== undefined ? { accountId } : {}),
    };
  } catch (err) {
    if (err instanceof AtlassianHttpError)
      return {
        ok: false,
        problem:
          err.status === 401 || err.status === 403 ? "rejected" : "failed",
      };
    return { ok: false, problem: "unreachable" };
  }
}

/**
 * A Jira HTTP failure as its fixed tool text, the 401/403 remedy by the
 * credential's kind: an OAuth one is renewed on the gateway's page, an API
 * token in Pandeck's Settings. Anything else, an abort included, is thrown on
 * for the host to classify.
 */
export function jiraFailure(
  err: unknown,
  credential: AtlassianCredential,
): never {
  if (err instanceof AtlassianHttpError) {
    if (err.status === 401 || err.status === 403)
      throw new ToolError(credentialRejectedText(credential));
    if (err.status === 404)
      throw new ToolError("Jira has no such issue, or the user can't see it.");
    throw new ToolError(`Jira answered HTTP ${err.status}.`);
  }
  throw err;
}

/** The 401/403 remedy, by the credential's kind. */
export function credentialRejectedText(
  credential: AtlassianCredential,
): string {
  return "accessToken" in credential
    ? "Atlassian rejected the credential; sign in with Atlassian again on the gateway's page."
    : "Atlassian rejected the credential; reconnect Jira in Pandeck's Settings.";
}

/**
 * The edge's text for each Confluence input refusal: the local wording,
 * without the caller's own values.
 */
const CONFLUENCE_REFUSAL_TEXT: Record<ConfluenceReadRefusalCode, string> = {
  page_missing: "A Confluence page id or URL is required.",
  page_unparsable:
    "Could not read a page id; pass the numeric page id or a Confluence page URL.",
  updated_since_format: "updatedSince must be a YYYY-MM-DD date.",
  search_filters_missing:
    "Give at least one of text, title, label, spaceKeys or updatedSince, or pass a raw cql query.",
  page_tree_scope_missing:
    "kind=pageTree needs either page (children of it) or spaceKey.",
  replies_comment_missing:
    "kind=replies needs the commentId to read replies of.",
  space_not_found:
    "That Confluence space was not found, or the Atlassian account cannot see it.",
};

/**
 * A Confluence read's failure as its fixed text: an input refusal by its
 * code, a 401/403 as the credential's remedy, 404 and 400 by their own fixed
 * texts, any other HTTP status by number alone (never the error's message,
 * which quotes Confluence's body). Anything else, an abort included, is
 * thrown on for the host to classify.
 */
export function confluenceFailure(
  err: unknown,
  credential: AtlassianCredential,
): never {
  if (err instanceof ConfluenceReadRefusal)
    throw new ToolError(CONFLUENCE_REFUSAL_TEXT[err.code]);
  if (err instanceof AtlassianHttpError) {
    if (err.status === 401 || err.status === 403)
      throw new ToolError(credentialRejectedText(credential));
    if (err.status === 404)
      throw new ToolError(
        "Confluence has no such page, space or comment, or the user can't see it.",
      );
    if (err.status === 400)
      throw new ToolError(
        "Confluence refused the request (HTTP 400); check the CQL or filters, and resolve space keys with confluence_lookup kind=spaces.",
      );
    throw new ToolError(`Confluence answered HTTP ${err.status}.`);
  }
  throw err;
}
