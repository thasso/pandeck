/**
 * Upstream text an edge caller may see (Task-1439 D4, Task-1463 D-W2,
 * ADR-0005): the checks that keep the call's credential out of it.
 *
 * D4, Jira's own reasons for a rejected search (`jiraSearchIssues.ts`), checks
 * for an auth marker or a whole secret form (`hasAuthMarker`, `secretForms`).
 * The write tool is stricter (`holdsSecret`): it also finds any 16-character
 * piece of a secret form anywhere in a text. Its texts (`writeFailure.ts`,
 * `jiraMutateIssue.ts`) show each such span, and each auth marker, as the
 * fixed placeholder `[redacted]`, so the reader sees that something was
 * removed (`vettedText`); its identifiers and links are dropped whole.
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
/** What a redacted span of a write tool's text reads as (Task-1463 fix-1). */
export const REDACTED = "[redacted]";

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
  return [value, withoutControls(value)].some(
    (form) => secretSpans(form, credential).length > 0,
  );
}

/**
 * The spans of `text` that carry credential material, as `[start, end)`
 * pairs in order and possibly overlapping: each auth marker, each whole
 * secret form, and each 16-character window that is a piece of one.
 */
function secretSpans(
  text: string,
  credential: AtlassianCredential,
): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const match of text.matchAll(new RegExp(AUTH_MARKER, "giu")))
    spans.push([match.index, match.index + match[0].length]);
  const secrets = secretForms(credential);
  for (const secret of secrets)
    for (
      let at = text.indexOf(secret);
      at !== -1;
      at = text.indexOf(secret, at + 1)
    )
      spans.push([at, at + secret.length]);
  const pieces = new Set<string>();
  for (const secret of secrets)
    for (let at = 0; at + MIN_SECRET_FRAGMENT <= secret.length; at += 1)
      pieces.add(secret.slice(at, at + MIN_SECRET_FRAGMENT));
  for (let at = 0; at + MIN_SECRET_FRAGMENT <= text.length; at += 1)
    if (pieces.has(text.slice(at, at + MIN_SECRET_FRAGMENT)))
      spans.push([at, at + MIN_SECRET_FRAGMENT]);
  return spans.sort((a, b) => a[0] - b[0]);
}

/** `text` with each run of overlapping or touching secret spans as `REDACTED`. */
function redacted(text: string, credential: AtlassianCredential): string {
  let out = "";
  let from = 0;
  let end = -1;
  for (const [start, stop] of secretSpans(text, credential)) {
    if (start > end) {
      if (end >= 0) out += REDACTED;
      out += text.slice(from, start);
    }
    end = Math.max(end, stop);
    from = end;
  }
  if (end >= 0) out += REDACTED;
  return out + text.slice(from);
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

/** Lone surrogates as U+FFFD, keeping the length. */
function wellFormed(text: string): string {
  return text.replace(
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
    "\ufffd",
  );
}

/** `text` cut at `at` or just before, never on half a surrogate pair. */
function headOf(text: string, at: number): string {
  return text.slice(
    0,
    /[\ud800-\udbff]$/.test(text.slice(0, at)) ? at - 1 : at,
  );
}

/**
 * `text` (already redacted) cut to `max` characters with an ellipsis, never
 * through a `REDACTED` placeholder (Task-1463 fix-2). When the cut would split
 * a placeholder or drop one with the tail, the text is cut earlier and ends
 * `[redacted]…`, so a redaction never disappears from view.
 */
function cappedRedacted(text: string, max: number): string {
  if (text.length <= max) return text;
  const at = max - 1;
  // A placeholder the cut splits, or any in the tail it drops.
  const split = text.lastIndexOf(REDACTED, at - 1);
  const splits = split !== -1 && split + REDACTED.length > at;
  if (!splits && !text.includes(REDACTED, at)) return `${headOf(text, at)}…`;
  let head = headOf(text, Math.max(0, at - REDACTED.length));
  // A placeholder the shorter head would split: cut before it.
  const inside = text.lastIndexOf(REDACTED, head.length - 1);
  if (inside !== -1 && inside + REDACTED.length > head.length)
    head = head.slice(0, inside);
  return `${head}${REDACTED}…`;
}

/** Whether a text, as given or as a JSON string, carries credential material. */
function leaks(text: string, credential: AtlassianCredential): boolean {
  return (
    holdsSecret(text, credential) ||
    holdsSecret(JSON.stringify(text), credential)
  );
}

/**
 * `text` for a caller of the write tool, in this order: controls as spaces;
 * each span that carries credential material as `REDACTED`, never silently
 * removed; lone surrogates as U+FFFD; cut to `max` (`cappedRedacted`). The
 * string that results is what is checked (fix-2): should it still carry
 * material, raw or JSON-escaped (a cut, an ellipsis or a placeholder joining
 * characters into a secret), the fallback, and should that carry it too,
 * `REDACTED` alone.
 */
export function vettedText(
  text: string,
  credential: AtlassianCredential,
  options: { max: number; fallback: string },
): string {
  const shown = cappedRedacted(
    wellFormed(redacted(withoutControls(text), credential)),
    options.max,
  );
  if (!leaks(shown, credential)) return shown;
  return leaks(options.fallback, credential) ? REDACTED : options.fallback;
}
