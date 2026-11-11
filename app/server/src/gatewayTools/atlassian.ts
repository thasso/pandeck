/**
 * The Atlassian credential on the edge (Task-1397): a site, an email and an
 * API token, checked here when it is set and again whenever it is decoded,
 * and stored by the gateway only as the opaque JSON `encodeAtlassianCredential`
 * makes. The site is a bare `<name>.atlassian.net` host, so a stored
 * credential can only ever be sent to Atlassian (SSRF guard). Errors become
 * fixed texts; no upstream body or credential reaches a caller.
 */
import { AtlassianHttpError } from "../atlassian/atlassianFetch.ts";
import { deadlineSignal } from "../httpRetry.ts";
import { jiraGet, type JiraApiConfig } from "../jiraClient.ts";
import { ToolError, type AtlassianCredential } from "./descriptor.ts";

const SITE_RE = /^[a-z0-9][a-z0-9-]{0,62}\.atlassian\.net$/;
const CHECK_TIMEOUT_MS = 15_000;
const MAX_NAME_CHARS = 200;

/** The checked credential, or undefined. */
export function parseAtlassianCredential(
  input: unknown,
): AtlassianCredential | undefined {
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
  credential: AtlassianCredential,
): string {
  return JSON.stringify({
    site: credential.site,
    email: credential.email,
    token: credential.token,
  });
}

/** The stored credential, checked again; undefined on any failure. */
export function decodeAtlassianCredential(
  text: string,
): AtlassianCredential | undefined {
  try {
    return parseAtlassianCredential(JSON.parse(text));
  } catch {
    return undefined;
  }
}

export function jiraConfigOf(credential: AtlassianCredential): JiraApiConfig {
  return {
    jiraHost: credential.site,
    atlassianEmail: credential.email,
    atlassianToken: credential.token,
  };
}

export type AtlassianCheck =
  | { ok: true; displayName?: string; accountId?: string }
  | { ok: false; problem: "rejected" | "unreachable" | "failed" };

const named = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0
    ? value.slice(0, MAX_NAME_CHARS)
    : undefined;

/** Asks Atlassian who the credential is (`/rest/api/3/myself`). */
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
 * A Jira HTTP failure as its fixed tool text. Anything else, an abort
 * included, is thrown on for the host to classify.
 */
export function jiraFailure(err: unknown): never {
  if (err instanceof AtlassianHttpError) {
    if (err.status === 401 || err.status === 403)
      throw new ToolError(
        "Atlassian rejected the credential; reconnect Jira in Pandeck's Settings.",
      );
    if (err.status === 404)
      throw new ToolError("Jira has no such issue, or the user can't see it.");
    throw new ToolError(`Jira answered HTTP ${err.status}.`);
  }
  throw err;
}
