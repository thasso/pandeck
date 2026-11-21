/**
 * A test oracle for credential material in an edge answer (Task-1463 A1,
 * fix-1), written apart from `gatewayTools/upstreamText.ts` so a test never
 * checks the production predicate with itself. Every string of the answer,
 * object keys included, at any depth, must hold no full secret form, no
 * 16-character window of one, and no authorization marker (fix-2).
 */
import assert from "node:assert/strict";

/** Either credential kind; other fields are ignored. */
interface Credential {
  email?: string;
  token?: string;
  accessToken?: string;
}

const WINDOW = 16;

/** The credential's forms, derived here: the token and its Basic values, or the access token. */
export function oracleForms(credential: Credential): string[] {
  if (credential.accessToken !== undefined) return [credential.accessToken];
  assert.ok(credential.email !== undefined && credential.token !== undefined);
  const basic = Buffer.from(
    `${credential.email}:${credential.token}`,
    "utf8",
  ).toString("base64");
  const unpadded = basic.endsWith("==")
    ? basic.slice(0, -2)
    : basic.endsWith("=")
      ? basic.slice(0, -1)
      : basic;
  return [credential.token, basic, unpadded];
}

/** Every string in `value`, keys included. */
function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value))
    for (const entry of value) stringsIn(entry, out);
  else if (value !== null && typeof value === "object")
    for (const [key, entry] of Object.entries(value)) {
      out.push(key);
      stringsIn(entry, out);
    }
  return out;
}

/** The schemes that mark a credential when whitespace or a control follows. */
const SCHEMES = ["bearer", "basic"];

/** Whether `char` is whitespace or a C0, DEL or C1 control. */
function isGap(char: string): boolean {
  const code = char.codePointAt(0)!;
  return char.trim() === "" || code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/** The first authorization marker in `text`: the header name, or a scheme word before a gap. */
function markerIn(text: string): string | undefined {
  const lower = text.toLowerCase();
  if (lower.includes("authorization")) return "authorization";
  for (const scheme of SCHEMES)
    for (
      let at = lower.indexOf(scheme);
      at !== -1;
      at = lower.indexOf(scheme, at + 1)
    ) {
      const next = text.charAt(at + scheme.length);
      if (next !== "" && isGap(next))
        return text.slice(at, at + scheme.length + 1);
    }
  return undefined;
}

/** The first secret form, 16-character window of one, or marker inside `text`. */
function leakIn(text: string, forms: readonly string[]): string | undefined {
  const marker = markerIn(text);
  if (marker !== undefined) return marker;
  for (const form of forms) {
    if (form.length > 0 && text.includes(form)) return form;
    for (let at = 0; at + WINDOW <= form.length; at += 1) {
      const window = form.slice(at, at + WINDOW);
      if (text.includes(window)) return window;
    }
  }
  return undefined;
}

/** Whether `text` holds a secret form, a 16-character window of one, or a marker. */
export function carriesMaterial(text: string, credential: Credential): boolean {
  return leakIn(text, oracleForms(credential)) !== undefined;
}

/**
 * Asserts that `answer` (a serialized answer, a plain text, or a value)
 * carries no credential material: checked on the raw text and on every
 * string of its parsed JSON.
 */
export function assertNoCredential(
  answer: unknown,
  credential: Credential,
): void {
  const forms = oracleForms(credential);
  const strings = stringsIn(answer);
  if (typeof answer === "string") {
    try {
      stringsIn(JSON.parse(answer), strings);
    } catch {
      // A plain text: checked whole above.
    }
  }
  for (const text of strings) {
    const leak = leakIn(text, forms);
    assert.equal(
      leak,
      undefined,
      `credential material ${JSON.stringify(leak)} in ${JSON.stringify(text.slice(0, 200))}`,
    );
  }
}
