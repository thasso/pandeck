/**
 * `jira_search_issues` on the edge (Task-1439): Pandeck's own search, with the
 * same schema, description and payload, run with the calling user's
 * Atlassian credential. Read-only, no approval. A payload above the edge's
 * 60,000-character ceiling answers `result_too_large` (D5).
 *
 * A search Jira rejects (HTTP 400 on the search request itself) answers
 * Jira's own reasons, vetted and capped (D4-yes): the one place an upstream
 * text reaches an edge caller.
 */
import { AtlassianHttpError } from "../atlassian/atlassianFetch.ts";
import {
  JIRA_SEARCH_ISSUES_DESCRIPTION,
  runJiraSearchIssues,
  searchIssuesParamsSchema,
  type SearchIssuesParams,
} from "../jiraSearch.ts";
import { jiraConfigOf } from "./atlassian.ts";
import {
  ToolError,
  type AtlassianCredential,
  type ToolDescriptor,
} from "./descriptor.ts";
import { edgeReadDeps, jiraReadFailure } from "./jiraRead.ts";

const SEARCH_REFUSED =
  "Jira refused the search (HTTP 400); check the JQL, and resolve project, user and field names with jira_lookup.";
const REASONS_PREFIX = "Jira refused the search (HTTP 400): ";
const MAX_TEXT = 500;
/**
 * Words that mark a header or scheme; a reason holding one is never shown.
 * `bearer`/`basic` count when any whitespace or control character (C0, DEL,
 * C1) follows, so `Bearer\tX` or `Bearer\u0085X` cannot slip past once the
 * controls are sanitized.
 */
const AUTH_MARKER = /authorization|(?:bearer|basic)[\s\p{Cc}]/iu;

/** C0 and C1 control characters (DEL included) as spaces. */
function withoutControls(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : char;
  }
  return out;
}

/** Every form the call's secret could take in a reason. */
function secretForms(credential: AtlassianCredential): string[] {
  if ("accessToken" in credential) return [credential.accessToken];
  const basic = Buffer.from(`${credential.email}:${credential.token}`).toString(
    "base64",
  );
  return [credential.token, basic, basic.replace(/=+$/, "")].filter(
    (form) => form.length > 0,
  );
}

/**
 * What a search Jira rejects answers. Jira's reasons pass only when none of
 * them, whole and unsanitized, holds a form of the credential or an auth
 * marker; otherwise, or without reasons, the fixed text. Falling back rather
 * than redacting leaves no partial secret across a cut or an overlap.
 */
function searchRefusedText(
  reasons: readonly string[] | undefined,
  credential: AtlassianCredential,
): string {
  const shown = (reasons ?? []).filter((reason) => reason.trim() !== "");
  if (shown.length === 0) return SEARCH_REFUSED;
  const secrets = secretForms(credential);
  const unsafe = shown.some(
    (reason) =>
      AUTH_MARKER.test(reason) ||
      secrets.some((secret) => reason.includes(secret)),
  );
  if (unsafe) return SEARCH_REFUSED;
  const text = withoutControls(REASONS_PREFIX + shown.join("; "));
  if (text.length <= MAX_TEXT) return text;
  // Never end on half a surrogate pair.
  const cut = /[\ud800-\udbff]$/.test(text.slice(0, MAX_TEXT - 1))
    ? MAX_TEXT - 2
    : MAX_TEXT - 1;
  return `${text.slice(0, cut)}…`;
}

export const jiraSearchIssues: ToolDescriptor = {
  name: "jira_search_issues",
  description: JIRA_SEARCH_ISSUES_DESCRIPTION,
  inputSchema: searchIssuesParamsSchema,
  effect: "read",
  actionKey: "jira:read",
  integration: "atlassian",
  async execute(params, ctx) {
    // Nothing goes upstream before the credential is here.
    const credential = await ctx.credential();
    const config = jiraConfigOf(credential);
    const deps = edgeReadDeps(config, ctx.signal);
    try {
      return await runJiraSearchIssues(config, params as SearchIssuesParams, {
        signal: deps.signal,
        // The field list's own failure keeps its fixed text: only the search
        // request's 400 may carry Jira's reasons.
        fieldMap: () =>
          deps
            .fieldMap()
            .catch((err: unknown) => jiraReadFailure(err, credential)),
      });
    } catch (err) {
      if (err instanceof AtlassianHttpError && err.status === 400)
        throw new ToolError(searchRefusedText(err.reasons, credential));
      jiraReadFailure(err, credential);
    }
  },
};
