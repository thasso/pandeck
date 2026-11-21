/**
 * Upstream text an edge caller may see (Task-1439 D4, Task-1463 D-W2,
 * ADR-0005): the checks that keep the call's credential out of it.
 *
 * D4, Jira's own reasons for a rejected search (`jiraSearchIssues.ts`), checks
 * for an auth marker or a whole secret form (`hasAuthMarker`, `secretForms`).
 * The write tool's texts, identifiers and links (`writeFailure.ts`,
 * `jiraMutateIssue.ts`) pass the stricter `holdsSecret`, which also refuses
 * any 16-character piece of a secret form anywhere in the text.
 *
 * A text that fails is dropped whole for a fixed fallback: redacting would
 * leave a partial secret across a cut or an overlap.
 */
import type { AtlassianCredential } from "./descriptor.ts";

/**
 * Words that mark a header or scheme; a text holding one is never shown.
 * `bearer`/`basic` count when any whitespace or control character (C0, DEL,
 * C1) follows, so `Bearer\tX` or `Bearer\u0085X` cannot slip past once the
 * controls are sanitized.
 */
const AUTH_MARKER = /authorization|(?:bearer|basic)[\s\p{Cc}]/iu;
/** A piece of a secret form this long counts as the secret (A1). */
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

/** Whether `value` holds a word that marks a header or scheme. */
export function hasAuthMarker(value: string): boolean {
  return AUTH_MARKER.test(value);
}

/**
 * Whether `value` carries credential material (Task-1463 A1, D-W2): an auth
 * marker, any secret form, or any piece of 16 or more characters of one,
 * anywhere in it or in its control-stripped form.
 */
export function holdsSecret(
  value: string,
  credential: AtlassianCredential,
): boolean {
  const secrets = secretForms(credential);
  const pieces = new Set<string>();
  for (const secret of secrets)
    for (let at = 0; at + MIN_SECRET_FRAGMENT <= secret.length; at += 1)
      pieces.add(secret.slice(at, at + MIN_SECRET_FRAGMENT));
  for (const form of [value, withoutControls(value)]) {
    if (AUTH_MARKER.test(form)) return true;
    // A secret shorter than a piece counts whole.
    if (secrets.some((secret) => form.includes(secret))) return true;
    for (let at = 0; at + MIN_SECRET_FRAGMENT <= form.length; at += 1)
      if (pieces.has(form.slice(at, at + MIN_SECRET_FRAGMENT))) return true;
  }
  return false;
}

/**
 * `text` with controls as spaces, cut to `max` characters, never on half a
 * surrogate pair, an ellipsis marking a cut.
 */
export function cappedText(text: string, max: number): string {
  const clean = withoutControls(text);
  if (clean.length <= max) return clean;
  const cut = /[\ud800-\udbff]$/.test(clean.slice(0, max - 1))
    ? max - 2
    : max - 1;
  return `${clean.slice(0, cut)}…`;
}

/**
 * `text` for a caller of the write tool: the fallback when it carries
 * credential material (`holdsSecret`, checked on the whole raw text first),
 * else `cappedText`.
 */
export function vettedText(
  text: string,
  credential: AtlassianCredential,
  options: { max: number; fallback: string },
): string {
  if (holdsSecret(text, credential)) return options.fallback;
  return cappedText(text, options.max);
}
