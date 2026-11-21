/**
 * `jira_search_issues` on the edge (Task-1439): Pandeck's own search, with the
 * same schema, description and payload, run with the calling user's
 * Atlassian credential. Read-only, no approval. A payload above the edge's
 * 60,000-character ceiling answers `result_too_large` (D5).
 *
 * A search Jira rejects (HTTP 400 on the search request itself) answers
 * Jira's own reasons, vetted and capped (D4-yes, `upstreamText.ts`). The only
 * other upstream text an edge caller sees is the write tool's (D-W2,
 * `writeFailure.ts`).
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
import { cappedText, hasAuthMarker, secretForms } from "./upstreamText.ts";

const SEARCH_REFUSED =
  "Jira refused the search (HTTP 400); check the JQL, and resolve project, user and field names with jira_lookup.";
const REASONS_PREFIX = "Jira refused the search (HTTP 400): ";
const MAX_TEXT = 500;

/**
 * What a search Jira rejects answers. Jira's reasons pass only when none of
 * them, whole and unsanitized, holds a form of the credential or an auth
 * marker; otherwise, or without reasons, the fixed text. Falling back rather
 * than redacting leaves no partial secret across a cut or an overlap. This is
 * D4 exactly; the write tool's stricter check (`holdsSecret`) is not applied
 * here.
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
      hasAuthMarker(reason) ||
      secrets.some((secret) => reason.includes(secret)),
  );
  if (unsafe) return SEARCH_REFUSED;
  return cappedText(REASONS_PREFIX + shown.join("; "), MAX_TEXT);
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
