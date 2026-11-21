/**
 * What a failed Jira write step tells an edge caller (Task-1463 D-W2,
 * ADR-0005): the second scoped exception to fixed edge texts, for the write
 * tools only. The shared prepare/apply code's own messages pass, and so do
 * Jira's `errorMessages`/`errors` reasons for a 4xx on the write call itself,
 * vetted and capped (`upstreamText.ts`), never with credential material.
 * 401/403 keep the fixed sign-in-again text; a read's 4xx, any 5xx, network
 * errors and timeouts stay fixed. P5 reuses this with Confluence wording.
 */
import { AtlassianHttpError } from "../atlassian/atlassianFetch.ts";
import {
  JiraMutationError,
  JiraWriteHttpError,
} from "../jiraMutationErrors.ts";
import { JiraReadRefusal } from "../jiraRead.ts";
import { credentialRejectedText } from "./atlassian.ts";
import type { AtlassianCredential } from "./descriptor.ts";
import { REFUSAL_TEXT } from "./jiraRead.ts";
import { vettedText } from "./upstreamText.ts";

const OWN_TEXT_MAX = 1_000;
const REASONS_MAX = 500;
const OWN_TEXT_FALLBACK = "Jira refused the change.";
const UNKNOWN_FAILURE =
  "The request to Jira failed; the change may or may not have been applied.";

function isAbort(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

/**
 * `err` as the text a caller sees, by type and status alone, in this order:
 * an abort (by its name, or because one of the phase's `signals` aborted) is
 * rethrown for the caller to classify; the code's own text; a rejected
 * credential; a write's 4xx with Jira's reasons when present and safe; any
 * other HTTP status by number; a read refusal by its code; else a fixed text.
 */
export function describeWriteFailure(
  err: unknown,
  credential: AtlassianCredential,
  signals: readonly AbortSignal[] = [],
): string {
  if (isAbort(err) || signals.some((signal) => signal.aborted)) throw err;
  if (err instanceof JiraMutationError)
    return vettedText(err.message, credential, {
      max: OWN_TEXT_MAX,
      fallback: OWN_TEXT_FALLBACK,
    });
  if (
    err instanceof AtlassianHttpError &&
    (err.status === 401 || err.status === 403)
  )
    return credentialRejectedText(credential);
  if (
    err instanceof JiraWriteHttpError &&
    err.status >= 400 &&
    err.status < 500
  )
    return writeRefusedText(err, credential);
  if (err instanceof AtlassianHttpError)
    return `Jira answered HTTP ${err.status}.`;
  if (err instanceof JiraReadRefusal) return REFUSAL_TEXT[err.code];
  return UNKNOWN_FAILURE;
}

/**
 * A write's 4xx: Jira's reasons, each piece of the secret in them shown as
 * `[redacted]` (`vettedText`); without reasons, the status.
 */
function writeRefusedText(
  err: JiraWriteHttpError,
  credential: AtlassianCredential,
): string {
  const plain = `Jira refused the change (HTTP ${err.status}).`;
  const reasons = (err.reasons ?? []).filter((reason) => reason.trim() !== "");
  if (reasons.length === 0) return plain;
  return vettedText(
    `Jira refused the change (HTTP ${err.status}): ${reasons.join("; ")}`,
    credential,
    { max: REASONS_MAX, fallback: plain },
  );
}
