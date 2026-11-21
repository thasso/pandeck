/**
 * Typed errors of the shared Jira mutation core (`jiraMutate.ts`,
 * `jiraMutateApply.ts`, `jiraRank.ts`, `jiraSprint.ts`, Task-1463). A caller
 * decides what to show by type and status alone, never by parsing a message:
 * the local tool shows every message as it always did, while the gateway's
 * edge must not repeat raw upstream text.
 */
import { AtlassianHttpError } from "./atlassian/atlassianFetch.ts";

/**
 * The core's own refusal or failure text. It may embed what the caller's
 * `describeError` made of another error, but no raw upstream text of its own.
 */
export class JiraMutationError extends Error {}

/**
 * Jira rejected a request that changes it (create, comment, transition, edit,
 * link, rank, sprint). Same message, status and reasons as the transport's
 * error; a failed read stays a plain `AtlassianHttpError`.
 */
export class JiraWriteHttpError extends AtlassianHttpError {}

/** Runs one write request, retyping Jira's rejection as `JiraWriteHttpError`. */
export async function jiraWrite<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (
      err instanceof AtlassianHttpError &&
      !(err instanceof JiraWriteHttpError)
    )
      throw new JiraWriteHttpError(err.message, err.status, err.reasons);
    throw err;
  }
}
