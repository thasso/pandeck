/**
 * Upstream text an edge caller may see (Task-1439 D4, Task-1463 D-W2,
 * ADR-0005): the checks that keep the call's credential out of it. Jira's own
 * reasons for a rejected search (`jiraSearchIssues.ts`) and the write tool's
 * texts, identifiers and links (`writeFailure.ts`, `jiraMutateIssue.ts`) pass
 * only through here.
 *
 * A text that holds any form of the secret, or an auth marker, is dropped
 * whole for a fixed fallback: redacting would leave a partial secret across a
 * cut or an overlap.
 */
import type { AtlassianCredential } from "./descriptor.ts";

/**
 * Words that mark a header or scheme; a text holding one is never shown.
 * `bearer`/`basic` count when any whitespace or control character (C0, DEL,
 * C1) follows, so `Bearer\tX` or `Bearer\u0085X` cannot slip past once the
 * controls are sanitized.
 */
const AUTH_MARKER = /authorization|(?:bearer|basic)[\s\p{Cc}]/iu;
/** A fragment this long that sits inside a secret form counts as secret. */
const MIN_SECRET_FRAGMENT = 16;

/** C0 and C1 control characters (DEL included) as spaces. */
export function withoutControls(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : char;
  }
  return out;
}

/** Every form the call's secret could take in a text. */
export function secretForms(credential: AtlassianCredential): string[] {
  if ("accessToken" in credential) return [credential.accessToken];
  const basic = Buffer.from(`${credential.email}:${credential.token}`).toString(
    "base64",
  );
  return [credential.token, basic, basic.replace(/=+$/, "")].filter(
    (form) => form.length > 0,
  );
}

/**
 * Whether `value`, whole and untransformed, holds the call's secret: an auth
 * marker in it or in its control-stripped form, any secret form inside it, or
 * a fragment of 16 or more characters that sits inside a secret form.
 */
export function holdsSecret(
  value: string,
  credential: AtlassianCredential,
): boolean {
  if (AUTH_MARKER.test(value) || AUTH_MARKER.test(withoutControls(value)))
    return true;
  const secrets = secretForms(credential);
  return secrets.some(
    (secret) =>
      value.includes(secret) ||
      (value.length >= MIN_SECRET_FRAGMENT && secret.includes(value)),
  );
}

/**
 * `text` for a caller: the fallback when it holds the secret (checked on the
 * whole raw text first), else with controls as spaces and cut to `max`
 * characters, never on half a surrogate pair, an ellipsis marking a cut.
 */
export function vettedText(
  text: string,
  credential: AtlassianCredential,
  options: { max: number; fallback: string },
): string {
  if (holdsSecret(text, credential)) return options.fallback;
  const clean = withoutControls(text);
  if (clean.length <= options.max) return clean;
  const cut = /[\ud800-\udbff]$/.test(clean.slice(0, options.max - 1))
    ? options.max - 2
    : options.max - 1;
  return `${clean.slice(0, cut)}…`;
}
