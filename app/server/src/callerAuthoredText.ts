/**
 * Bounds and the credential refusal for text a managed-delivery caller writes
 * and Pandeck publishes as written: a commit message, a pull-request title or
 * body. Nothing reviews this text after the caller, so a suspected credential
 * refuses with no override — unlike session prompts and caller `context`,
 * which only a helper model reads and which are masked instead.
 */
import { textLooksLikeCredential } from "./credentialRedaction.ts";

export const MAX_COMMIT_MESSAGE_CHARS = 8_000;
/** GitHub's own cap on a pull-request description. */
export const MAX_PULL_REQUEST_BODY_CHARS = 65_536;

/** Throw when caller-written `field` text looks like it holds a credential. */
export function refuseCredentialInCallerText(
  field: string,
  text: string,
): void {
  if (textLooksLikeCredential(text))
    throw new Error(
      `${field} looks like it contains a credential (a private key, a token, or a quoted secret assignment). It would be published as written, so this cannot be overridden: remove it and retry.`,
    );
}

function normalizeCallerText(field: string, value: string, max: number) {
  const text = value.trim();
  if (!text)
    throw new Error(`${field} must not be blank after trimming whitespace.`);
  if (text.length > max)
    throw new Error(
      `${field} exceeds ${max} characters after trimming whitespace.`,
    );
  refuseCredentialInCallerText(field, text);
  return text;
}

/** Validate a caller-written commit message without rewriting it. */
export function normalizeCallerCommitMessage(value: string): string {
  return normalizeCallerText("message", value, MAX_COMMIT_MESSAGE_CHARS);
}

/** Validate a caller-written pull-request body without rewriting it. */
export function normalizeCallerPullRequestBody(value: string): string {
  return normalizeCallerText("body", value, MAX_PULL_REQUEST_BODY_CHARS);
}
