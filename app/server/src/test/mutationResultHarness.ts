/**
 * What the result-contract tests (`jiraMutationResult.test.ts`,
 * `confluenceMutationResult.test.ts`, Task-1463 P6a) share: a fake vetting
 * that refuses a sentinel secret and checks the real formats, and the diff
 * that lists every path apply changed on an item. Every value is fake.
 */
import {
  IDENTIFIER_FORMATS,
  siteUrl,
  type ResultVetting,
} from "../mutationResultCodec.ts";

export const SITE = "acme.atlassian.net";
/** What the fake vetting treats as the call's secret: a plain marker. */
export const SENTINEL = "MARKER-0042";
export const REDACTED = "[redacted]";

/**
 * A vetting as the edge's will be, minus the credential oracle: the secret
 * check on the raw value first, then the format; a link only when its
 * backing identifier passed and appears in it.
 */
export const fakeVetting: ResultVetting = {
  identifier(raw, kind) {
    if (typeof raw !== "string" || raw.includes(SENTINEL)) return undefined;
    return IDENTIFIER_FORMATS[kind](raw) ? raw : undefined;
  },
  url(raw, backing) {
    if (backing === undefined || typeof raw !== "string") return undefined;
    if (raw.includes(SENTINEL) || !raw.includes(backing)) return undefined;
    return siteUrl(SITE)(raw, 0) ? raw : undefined;
  },
  text(raw, max, fallback) {
    const text = raw.replaceAll(SENTINEL, REDACTED);
    return text.length === 0 ? fallback : text.slice(0, max);
  },
};

/** `value` as it arrives over the wire. */
export function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Every path whose value differs between `before` and `after`: object keys
 * joined by `.`, an entry of a same-length array as `[]`, any other change
 * at the path where it starts.
 */
export function changedPaths(
  before: unknown,
  after: unknown,
  path = "",
): string[] {
  if (Object.is(before, after)) return [];
  if (
    Array.isArray(before) &&
    Array.isArray(after) &&
    before.length === after.length
  )
    return before.flatMap((entry, index) =>
      changedPaths(entry, after[index], `${path}[]`),
    );
  if (isRecord(before) && isRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((key) =>
      changedPaths(before[key], after[key], path ? `${path}.${key}` : key),
    );
  }
  return [path];
}
