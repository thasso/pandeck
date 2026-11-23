/**
 * The rules a write tool's projected answer is built with (Task-1463 P4b2,
 * lifted for P5b), shared so both write tools vet the same way: capped
 * caller-visible text, identifiers and links vetted for the call's secret on
 * their raw values before any other check, a shrink guard that runs a
 * product's ordered stages only while the answer is over its budget, and a
 * last check of the answer as it is sent.
 */
import { ToolError, type AtlassianCredential } from "./descriptor.ts";
import { holdsSecret, leaks, vettedText } from "./upstreamText.ts";

/** The projected result's serialized ceiling, under `maxResultChars`. */
export const RESULT_BUDGET = 55_000;

const URL_MAX = 300;
/** Printable ASCII without space; `"` and `\` are refused separately. */
const URL_CHARS_RE = /^[\x21-\x7e]+$/;
const URL_DECODE_ROUNDS = 3;

/**
 * Caller-visible text (`vettedText`): each secret piece as `[redacted]`,
 * controls as spaces, lone surrogates replaced, cut to `max`, and the result
 * itself checked. Its JSON form is at most 2 × max + 2.
 */
export function projectText(
  text: string,
  credential: AtlassianCredential,
  max: number,
  fallback: string,
): string {
  return vettedText(text, credential, { max, fallback });
}

/**
 * An identifier as the product returned it, kept only whole: a string that
 * holds no secret (checked first, on the raw value) and is `wellFormed`.
 */
export function vettedIdentifier(
  raw: unknown,
  credential: AtlassianCredential,
  wellFormed: (value: string) => boolean,
): string | undefined {
  if (typeof raw !== "string" || holdsSecret(raw, credential)) return undefined;
  return wellFormed(raw) ? raw : undefined;
}

/**
 * A link, kept only when its backing identifier passed, it lies on the
 * credential's site, its raw form is short printable ASCII without `"` or
 * `\`, and neither it nor any of up to three successive percent-decodings
 * holds the secret. A decoding error, or a form still changing after the
 * third decoding, omits it.
 */
export function vettedUrl(
  raw: unknown,
  backing: string | undefined,
  credential: AtlassianCredential,
): string | undefined {
  if (backing === undefined || typeof raw !== "string") return undefined;
  if (holdsSecret(raw, credential)) return undefined;
  if (
    !raw.startsWith(`https://${credential.site}/`) ||
    raw.length > URL_MAX ||
    !URL_CHARS_RE.test(raw) ||
    raw.includes('"') ||
    raw.includes("\\")
  )
    return undefined;
  let form = raw;
  for (let round = 0; round <= URL_DECODE_ROUNDS; round += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(form);
    } catch {
      return undefined;
    }
    if (decoded === form) return raw;
    // Past the third decoding the form is still changing: not vetted.
    if (round === URL_DECODE_ROUNDS) return undefined;
    if (holdsSecret(decoded, credential)) return undefined;
    form = decoded;
  }
  return undefined;
}

/**
 * The shrink guard: each of the product's `stages`, in order, only while the
 * serialized result is still over `budget`. A stage that cuts a text cuts it
 * through `projectText`, so a cut never splits a placeholder or makes a
 * secret.
 */
export function shrunkToBudget<T>(
  result: T,
  budget: number,
  stages: readonly ((result: T) => void)[],
): T {
  for (const stage of stages)
    if (JSON.stringify(result).length > budget) stage(result);
  return result;
}

/**
 * The answer as it is sent, and as the `/mcp` body or `tools.call` frame
 * escapes it once more (fix-2, fix-4): should joining its strings into JSON
 * make a secret, only the rows' outcomes remain; should even those (R3), the
 * product's fixed `withheld` text.
 */
export function sentResult<T>(
  kept: T,
  credential: AtlassianCredential,
  outcomesOf: (kept: T) => T,
  withheld: string,
): T {
  if (!leaks(JSON.stringify(kept), credential, 1)) return kept;
  const outcomes = outcomesOf(kept);
  if (!leaks(JSON.stringify(outcomes), credential, 1)) return outcomes;
  throw new ToolError(withheld);
}
