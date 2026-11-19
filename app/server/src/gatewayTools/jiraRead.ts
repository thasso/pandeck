/**
 * What the edge's shared Jira reads (`jira_search_issues`, `jira_lookup`,
 * Task-1439) have in common: uncached field and link-type loaders, and their
 * failures as fixed texts.
 *
 * Nothing is cached: a per-site file on the multi-user edge would mix users
 * who see different fields, so each call reads what it needs with its own
 * credential and signal.
 */
import { AtlassianHttpError } from "../atlassian/atlassianFetch.ts";
import type { JiraConfig } from "../jiraClient.ts";
import {
  buildFieldMap,
  fetchJiraFields,
  fetchJiraIssueLinkTypes,
} from "../jiraFields.ts";
import {
  JiraReadRefusal,
  type JiraReadDeps,
  type JiraReadRefusalCode,
} from "../jiraRead.ts";
import { credentialRejectedText } from "./atlassian.ts";
import { ToolError, type AtlassianCredential } from "./descriptor.ts";

/**
 * The edge's text for each input refusal: the local wording, without the
 * caller's own values.
 */
const REFUSAL_TEXT: Record<JiraReadRefusalCode, string> = {
  jql_empty: "jql must not be empty.",
  jql_too_long: "jql is too long.",
  assignable_without_project:
    "projectKey is required when assignableOnly=true.",
  sprint_board_invalid: "kind=sprints boardId must be a positive integer.",
  sprint_scope_missing: "kind=sprints requires boardId or projectKey.",
  sprint_state_unknown: "Unknown sprint state; use future, active, closed.",
  project_without_board: "No Jira board shows that project.",
};

/** The read's loaders and signal, nothing cached. */
export function edgeReadDeps(
  config: JiraConfig,
  signal: AbortSignal,
): JiraReadDeps {
  return {
    signal,
    fieldMap: async () => {
      const fields = await fetchJiraFields(config, signal);
      return buildFieldMap({ fetchedAt: Date.now(), fields });
    },
    issueLinkTypes: () => fetchJiraIssueLinkTypes(config, signal),
  };
}

/**
 * A shared read's failure as its fixed text: an input refusal by its code, a
 * 401/403 as the credential's remedy, any other HTTP status by number alone
 * (never the error's message, which quotes Jira's body). Anything else, an
 * abort included, is thrown on for the host to classify.
 */
export function jiraReadFailure(
  err: unknown,
  credential: AtlassianCredential,
): never {
  if (err instanceof JiraReadRefusal)
    throw new ToolError(REFUSAL_TEXT[err.code]);
  if (err instanceof AtlassianHttpError) {
    if (err.status === 401 || err.status === 403)
      throw new ToolError(credentialRejectedText(credential));
    throw new ToolError(`Jira answered HTTP ${err.status}.`);
  }
  throw err;
}
