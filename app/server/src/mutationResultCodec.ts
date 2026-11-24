/**
 * What the two result contracts share (`jiraMutationResult.ts`,
 * `confluenceMutationResult.ts`, Task-1463 P6a, P6-F1): the effects a record
 * certifies, the identifier formats, the caps, the compact form of nested
 * results, and the vetting seam.
 *
 * The edge never returns whole applied items. It returns one result record
 * per sent item, holding only pure result fields, each vetted on its raw
 * value for the call's secret before its format is checked. The vetting is
 * injected ({@link ResultVetting}): these modules never see a credential, and
 * the edge builds a fresh vetting per call (`gatewayTools/`).
 *
 * Boundary-clean: only the rule kit (`workerBoundary.test.ts`).
 */
import {
  arrayOf,
  closed,
  oneOf,
  req,
  str,
  type Check,
} from "./mutationCheckRules.ts";

/** Whether an item's writes may have reached the product. */
export type Effects = "none" | "possible";
export const effects = oneOf<Effects>()(["none", "possible"]);

export const ITEM_WARNING_MAX = 400;
export const ITEM_ERROR_MAX = 600;
const NESTED_ERROR_MAX = 300;
/** Shrink stage 1's cut of nested error texts. */
export const SHRUNK_NESTED_ERROR_MAX = 120;
const URL_MAX = 300;
const VERSION_MAX = 999_999_999;
const JIRA_KEY_MAX = 64;
const SPRINT_NAME_MAX = 255;

export const WARNING_FALLBACK = "A warning was withheld.";
export const ERROR_FALLBACK = "The change failed.";
/** What a nested error emptied by shrink stage 2 reads as on the card. */
export const NESTED_ERROR_OMITTED =
  "Failed; the details were too long to return.";

const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/;
const PAGE_ID_RE = /^[0-9]{1,20}$/;
const ATTACHMENT_ID_RE = /^att[0-9]{1,20}$/;
const INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;
/** Printable ASCII without space; `"` and `\` are refused separately. */
const URL_CHARS_RE = /^[\x21-\x7e]+$/;

export type IdentifierKind =
  "jiraKey" | "pageId" | "attachmentId" | "instant" | "sprintName";

/** A name with no control character and no lone surrogate. */
function isPlainName(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0x20 || unit === 0x7f) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

/**
 * An ISO 8601 instant that names a real moment (Task-1463 P6b, L-b): the
 * shape, then the calendar and the clock, leap years included; no leap
 * second.
 */
function isInstant(value: string): boolean {
  const parts = INSTANT_RE.exec(value);
  if (!parts) return false;
  const [year, month, day, hour, minute, second] = parts
    .slice(1, 7)
    .map(Number) as [number, number, number, number, number, number];
  const offsetHour = Number(parts[7] ?? 0);
  const offsetMinute = Number(parts[8] ?? 0);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysIn(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

function daysIn(year: number, month: number): number {
  if (month !== 2) return [4, 6, 9, 11].includes(month) ? 30 : 31;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return leap ? 29 : 28;
}

/** Each identifier kind's format, checked only after the secret check. */
export const IDENTIFIER_FORMATS: Readonly<
  Record<IdentifierKind, (value: string) => boolean>
> = {
  jiraKey: (value) => value.length <= JIRA_KEY_MAX && JIRA_KEY_RE.test(value),
  pageId: (value) => PAGE_ID_RE.test(value),
  attachmentId: (value) => ATTACHMENT_ID_RE.test(value),
  instant: isInstant,
  sprintName: (value) => value.length <= SPRINT_NAME_MAX && isPlainName(value),
};

/**
 * One call's vetting, closed over its credential and site (the edge's
 * `gatewayTools/mutationResultVetting.ts`).
 */
export interface ResultVetting {
  /** `raw` whole when it holds no secret (checked first) and has `kind`'s format. */
  identifier(raw: unknown, kind: IdentifierKind): string | undefined;
  /** `raw` whole when `backing` passed and the link is clean and on the site. */
  url(raw: unknown, backing: string | undefined): string | undefined;
  /** Caller-visible text: secret pieces redacted, cut to `max`, else `fallback`. */
  text(raw: string, max: number, fallback: string): string;
}

/** An identifier of `kind` as a structural check, for a received record. */
export function formatted(kind: IdentifierKind): Check<string> {
  const format = IDENTIFIER_FORMATS[kind];
  return (value): value is string => typeof value === "string" && format(value);
}

/** A string of at most `max` UTF-16 code units. */
export function boundedText(max: number): Check<string> {
  return (value): value is string =>
    typeof value === "string" && value.length <= max;
}

/** A link as the edge's URL rule leaves it, on `site`. */
export function siteUrl(site: string): Check<string> {
  const prefix = `https://${site}/`;
  return (value): value is string =>
    typeof value === "string" &&
    value.length <= URL_MAX &&
    value.startsWith(prefix) &&
    URL_CHARS_RE.test(value) &&
    !value.includes('"') &&
    !value.includes("\\");
}

/** A written version: an integer 0-999,999,999. */
export const version: Check<number> = (value): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= VERSION_MAX;

/** A raw version as a record keeps it: `null` as is, else only a valid one. */
export function vettedVersion(raw: unknown): number | null | undefined {
  if (raw === null) return null;
  return version(raw, 0) ? raw : undefined;
}

/**
 * A nested array's results in compact form: `ok` holds one character per
 * entry (`1` resultOk true, `0` false, `-` absent), and `errors` every entry
 * with an error, as `[index, text]` in ascending index order.
 */
export interface NestedResults {
  ok: string;
  errors: [number, string][];
}

interface NestedEntry {
  resultOk?: boolean;
  error?: string;
}

/** The entries' results, aligned with them; texts vetted and capped at 300. */
export function encodeNested(
  entries: readonly NestedEntry[],
  vet: ResultVetting,
): NestedResults {
  let ok = "";
  const errors: [number, string][] = [];
  for (const [index, entry] of entries.entries()) {
    ok += entry.resultOk === true ? "1" : entry.resultOk === false ? "0" : "-";
    if (typeof entry.error === "string")
      errors.push([
        index,
        vet.text(entry.error, NESTED_ERROR_MAX, ERROR_FALLBACK),
      ]);
  }
  return { ok, errors };
}

const nestedError: Check<[number, string]> = (
  value,
): value is [number, string] =>
  Array.isArray(value) &&
  value.length === 2 &&
  typeof value[0] === "number" &&
  Number.isSafeInteger(value[0]) &&
  boundedText(NESTED_ERROR_MAX)(value[1], 0);

const nestedShape = closed<NestedResults>({
  ok: req(str),
  errors: req(arrayOf(nestedError, Number.MAX_SAFE_INTEGER)),
});

/**
 * Whether `value` is the compact results of a `length`-entry array: one
 * `1`, `0` or `-` per entry, and error indices unique, ascending and within
 * the array.
 */
export function isNestedResults(
  value: unknown,
  length: number,
): value is NestedResults {
  if (!nestedShape(value, 0)) return false;
  if (value.ok.length !== length || !/^[10-]*$/.test(value.ok)) return false;
  let previous = -1;
  for (const [index] of value.errors) {
    if (index <= previous || index >= length) return false;
    previous = index;
  }
  return true;
}

/**
 * Writes compact results onto the card's entries: a present result is set,
 * an absent one deleted. An empty error from a trimmed answer reads
 * {@link NESTED_ERROR_OMITTED}.
 */
export function mergeNested(
  entries: NestedEntry[],
  nested: NestedResults,
  trimmed: boolean,
): void {
  const errors = new Map(nested.errors);
  for (const [index, entry] of entries.entries()) {
    const ok = nested.ok[index];
    if (ok === "1") entry.resultOk = true;
    else if (ok === "0") entry.resultOk = false;
    else delete entry.resultOk;
    const error = errors.get(index);
    if (error === undefined) delete entry.error;
    else entry.error = error === "" && trimmed ? NESTED_ERROR_OMITTED : error;
  }
}

/** Shrink stage 1: every nested error text cut to {@link SHRUNK_NESTED_ERROR_MAX}. */
export function cutNestedErrors(
  nested: NestedResults,
  vet: ResultVetting,
): void {
  for (const entry of nested.errors)
    entry[1] = vet.text(entry[1], SHRUNK_NESTED_ERROR_MAX, ERROR_FALLBACK);
}

/** Shrink stage 2: every nested error text emptied; its presence stays. */
export function blankNestedErrors(nested: NestedResults): void {
  for (const entry of nested.errors) entry[1] = "";
}
