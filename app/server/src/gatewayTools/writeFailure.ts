/**
 * What a failed write step tells an edge caller (Task-1463 D-W2, ADR-0005):
 * the second scoped exception to fixed edge texts, for the write tools only.
 * The shared prepare/apply code's own messages pass, and so do the product's
 * `errorMessages`/`errors` reasons for a 4xx on the write call itself, vetted
 * and capped (`upstreamText.ts`), never with credential material. 401/403
 * keep the fixed sign-in-again text; a read's 4xx, any 5xx, network errors
 * and timeouts stay fixed. Jira and Confluence run the same rules; only the
 * product's name, its error types and its read refusals differ.
 */
import {
  AtlassianHttpError,
  type AtlassianProduct,
} from "../atlassian/atlassianFetch.ts";
import { ConfluenceReadRefusal } from "../atlassian/confluenceClient.ts";
import {
  ConfluenceMutationError,
  ConfluenceWriteHttpError,
} from "../confluenceMutationErrors.ts";
import {
  JiraMutationError,
  JiraWriteHttpError,
} from "../jiraMutationErrors.ts";
import { JiraReadRefusal } from "../jiraRead.ts";
import {
  CONFLUENCE_REFUSAL_TEXT,
  credentialRejectedText,
} from "./atlassian.ts";
import type { AtlassianCredential } from "./descriptor.ts";
import { REFUSAL_TEXT } from "./jiraRead.ts";
import { vettedText } from "./upstreamText.ts";

const OWN_TEXT_MAX = 1_000;
const REASONS_MAX = 500;

/** What differs between the products' mappers. */
interface FailureProduct {
  name: AtlassianProduct;
  isOwnText(err: unknown): err is Error;
  isWriteHttp(err: unknown): err is AtlassianHttpError;
  /** A read refusal's fixed text, or `undefined` when `err` is none. */
  refusalText(err: unknown): string | undefined;
}

const JIRA: FailureProduct = {
  name: "Jira",
  isOwnText: (err) => err instanceof JiraMutationError,
  isWriteHttp: (err) => err instanceof JiraWriteHttpError,
  refusalText: (err) =>
    err instanceof JiraReadRefusal ? REFUSAL_TEXT[err.code] : undefined,
};

const CONFLUENCE: FailureProduct = {
  name: "Confluence",
  isOwnText: (err) => err instanceof ConfluenceMutationError,
  isWriteHttp: (err) => err instanceof ConfluenceWriteHttpError,
  refusalText: (err) =>
    err instanceof ConfluenceReadRefusal
      ? CONFLUENCE_REFUSAL_TEXT[err.code]
      : undefined,
};

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
 * credential; a write's 4xx with the product's reasons when present and safe;
 * any other HTTP status by number; a read refusal by its code; else a fixed
 * text.
 */
function describeFailure(
  product: FailureProduct,
  err: unknown,
  credential: AtlassianCredential,
  signals: readonly AbortSignal[],
): string {
  if (isAbort(err) || signals.some((signal) => signal.aborted)) throw err;
  if (product.isOwnText(err))
    return vettedText(err.message, credential, {
      max: OWN_TEXT_MAX,
      fallback: `${product.name} refused the change.`,
    });
  if (
    err instanceof AtlassianHttpError &&
    (err.status === 401 || err.status === 403)
  )
    return credentialRejectedText(credential);
  if (product.isWriteHttp(err) && err.status >= 400 && err.status < 500)
    return writeRefusedText(product, err, credential);
  if (err instanceof AtlassianHttpError)
    return `${product.name} answered HTTP ${err.status}.`;
  const refusal = product.refusalText(err);
  if (refusal !== undefined) return refusal;
  return `The request to ${product.name} failed; the change may or may not have been applied.`;
}

/** D-W2 for `jira_mutate_issue`. */
export function describeWriteFailure(
  err: unknown,
  credential: AtlassianCredential,
  signals: readonly AbortSignal[] = [],
): string {
  return describeFailure(JIRA, err, credential, signals);
}

/**
 * D-W2 for `confluence_mutate_page`. Reasons are only what `atlassianFetch`
 * extracts (`errorMessages` strings, string values of an `errors` object), so
 * Confluence v2's `errors` array of objects gives the status form.
 */
export function describeConfluenceWriteFailure(
  err: unknown,
  credential: AtlassianCredential,
  signals: readonly AbortSignal[] = [],
): string {
  return describeFailure(CONFLUENCE, err, credential, signals);
}

/**
 * A write's 4xx: the product's reasons, each piece of the secret in them
 * shown as `[redacted]` (`vettedText`); without reasons, the status.
 */
function writeRefusedText(
  product: FailureProduct,
  err: AtlassianHttpError,
  credential: AtlassianCredential,
): string {
  const plain = `${product.name} refused the change (HTTP ${err.status}).`;
  const reasons = (err.reasons ?? []).filter((reason) => reason.trim() !== "");
  if (reasons.length === 0) return plain;
  return vettedText(
    `${product.name} refused the change (HTTP ${err.status}): ${reasons.join("; ")}`,
    credential,
    { max: REASONS_MAX, fallback: plain },
  );
}
