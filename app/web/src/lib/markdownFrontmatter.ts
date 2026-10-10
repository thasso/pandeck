import {
  parseYamlSubset,
  splitYamlFrontmatter,
} from "@assistant/shared/frontmatter";
import {
  dateFieldLabel,
  parsePropertyDate,
  type PropertyDateValue,
} from "./propertyDates.ts";

/** One frontmatter field shown as a label and a one-line value. */
export interface FrontmatterField {
  key: string;
  /** The key as a label: as written, or read as words for a date field. */
  label: string;
  /** Set when the value is one ISO date: the header formats it as a date. */
  date?: PropertyDateValue;
  /** Set when every value is a link (`links:`): the header lists them. */
  links?: FrontmatterRef[];
  /** The value as shown, clipped to one readable line. */
  value: string;
  /** The whole value when `value` had to be clipped. */
  full?: string;
}

/** A Markdown document's frontmatter, projected for a compact header. */
export interface MarkdownFrontmatter {
  /** The YAML between the fences, exactly as written. */
  raw: string;
  /** `title`, when the frontmatter names one. */
  title?: string;
  /** `tags`, from a list or a comma-separated string. */
  tags: string[];
  /** Every other non-empty field, in document order. */
  fields: FrontmatterField[];
  /** Fields a reader rarely needs (`HIDDEN_KEYS`), shown folded away. */
  hiddenFields: FrontmatterField[];
  /**
   * `source: { kind, refs }` — where the document came from, its references
   * named the way a reader knows them rather than as raw URLs.
   */
  source?: FrontmatterSource;
  /**
   * False when the YAML is outside the subset the shared parser reads (block
   * scalars, anchors, flow maps). The header then shows `raw` instead.
   */
  parsed: boolean;
}

/** A link, named the way a reader knows it (`sourceRefLabel`). */
export interface FrontmatterRef {
  href: string;
  label: string;
}

interface FrontmatterSource {
  /** `agent`, `slack`, `meeting`… as written; the header names it. */
  kind?: string;
  refs: FrontmatterRef[];
}

const LINK_RE = /^(?:pa|https?):\/\/\S+$/;

/** The value as links when it is one link or a list of only links. */
function linkList(value: unknown): FrontmatterRef[] | null {
  const items = typeof value === "string" ? [value] : value;
  if (!Array.isArray(items) || items.length === 0) return null;
  const refs: FrontmatterRef[] = [];
  for (const item of items) {
    if (typeof item !== "string" || !LINK_RE.test(item.trim())) return null;
    refs.push({ href: item.trim(), label: sourceRefLabel(item.trim()) });
  }
  return refs;
}

/**
 * The rows a reader looks for first, in this order, by their shown label;
 * every other row follows alphabetically, so two files with the same keys
 * always list them the same way whatever order they were written in.
 */
const LEADING_LABELS = [
  "Title",
  "Type",
  "Status",
  "Created",
  "Updated",
  "Source",
  "Links",
];

/** Order of the header's rows: `LEADING_LABELS` first, then by label. */
export function compareFrontmatterLabels(a: string, b: string): number {
  const rank = (label: string) => {
    const index = LEADING_LABELS.indexOf(label);
    return index < 0 ? LEADING_LABELS.length : index;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}

/** Bookkeeping keys the header folds under "more" rather than lists up front. */
const HIDDEN_KEYS = new Set(["schema", "id"]);

const OPENING_FENCE_RE = /^---\r?\n/;
const MAX_VALUE_CHARS = 240;

/**
 * Splits leading YAML frontmatter off a Markdown document. The returned body
 * keeps every remaining line on its original line number — the frontmatter's
 * lines become blank lines — so `#L` anchors and source-line comments still
 * address the file as written. A document without frontmatter is returned as
 * is with `frontmatter: null`.
 */
export function splitMarkdownFrontmatter(text: string): {
  frontmatter: MarkdownFrontmatter | null;
  body: string;
} {
  if (!OPENING_FENCE_RE.test(text)) return { frontmatter: null, body: text };
  let yaml: string;
  let rest: string;
  try {
    ({ yaml, body: rest } = splitYamlFrontmatter(text, "document"));
  } catch {
    // An opening fence with no closing one is a thematic break, not frontmatter.
    return { frontmatter: null, body: text };
  }
  const consumed = text.slice(0, text.length - rest.length);
  const body = "\n".repeat(consumed.split("\n").length - 1) + rest;
  return { frontmatter: projectFrontmatter(yaml), body };
}

function projectFrontmatter(raw: string): MarkdownFrontmatter {
  let value: unknown;
  try {
    value = parseYamlSubset(raw, "frontmatter");
  } catch {
    return { raw, tags: [], fields: [], hiddenFields: [], parsed: false };
  }
  const root = unwrapNamespace(value);
  if (!isRecord(root))
    return { raw, tags: [], fields: [], hiddenFields: [], parsed: false };
  const out: MarkdownFrontmatter = {
    raw,
    tags: [],
    fields: [],
    hiddenFields: [],
    parsed: true,
  };
  for (const [key, field] of Object.entries(root)) {
    if (key === "title" && typeof field === "string" && field.trim()) {
      out.title = field.trim();
      continue;
    }
    if (key === "source") {
      const source = sourceOf(field);
      if (source) {
        out.source = source;
        continue;
      }
    }
    if (key === "tags") {
      const tags = tagList(field);
      if (tags) {
        out.tags = tags;
        continue;
      }
    }
    const shown = displayValue(field);
    if (!shown) continue;
    const date =
      typeof field === "string" || typeof field === "number"
        ? parsePropertyDate(field)
        : null;
    if (date) {
      (HIDDEN_KEYS.has(key) ? out.hiddenFields : out.fields).push({
        key,
        label: dateFieldLabel(key),
        value: shown,
        date,
      });
      continue;
    }
    const links = linkList(field);
    if (links) {
      (HIDDEN_KEYS.has(key) ? out.hiddenFields : out.fields).push({
        key,
        label: fieldLabel(key),
        value: shown,
        links,
      });
      continue;
    }
    (HIDDEN_KEYS.has(key) ? out.hiddenFields : out.fields).push(
      shown.length > MAX_VALUE_CHARS
        ? {
            key,
            label: fieldLabel(key),
            value: `${shown.slice(0, MAX_VALUE_CHARS - 1)}…`,
            full: shown,
          }
        : { key, label: fieldLabel(key), value: shown },
    );
  }
  return out;
}

/**
 * A frontmatter block that is one namespace (`kb: {...}`) reads as that
 * namespace's fields: the wrapper says who owns the keys, not what they are.
 */
function unwrapNamespace(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const entries = Object.entries(value);
  if (entries.length !== 1) return value;
  const inner = entries[0]![1];
  return isRecord(inner) ? inner : value;
}

function sourceOf(value: unknown): FrontmatterSource | null {
  if (typeof value === "string" && value.trim())
    return { kind: value.trim(), refs: [] };
  if (!isRecord(value)) return null;
  const { kind, refs, ...rest } = value;
  // Anything beyond kind and refs is not a shape this header knows: leave the
  // whole field to the generic row rather than drop part of it.
  if (Object.keys(rest).length > 0) return null;
  if (kind !== undefined && typeof kind !== "string") return null;
  const list = refs === undefined ? [] : refs;
  if (!Array.isArray(list) || !list.every((ref) => typeof ref === "string"))
    return null;
  return {
    ...(typeof kind === "string" && kind.trim() ? { kind: kind.trim() } : {}),
    refs: list
      .map((ref) => ref.trim())
      .filter(Boolean)
      .map((href) => ({ href, label: sourceRefLabel(href) })),
  };
}

/** A key read as words: `relatedTo` → "Related to", `next_step` → "Next step". */
function fieldLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}

/**
 * A reference named the way a reader knows it: `percival#102` for a GitHub
 * issue or pull request, "Google Doc", "Slack message"; a `pa://` link keeps
 * its URI, which the Markdown renderer replaces with the object's title.
 */
export function sourceRefLabel(href: string): string {
  if (href.startsWith("pa://")) return href;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  const host = url.hostname.replace(/^www\./, "");
  const parts = url.pathname.split("/").filter(Boolean);
  if (host === "github.com" && parts.length >= 2) {
    const [, repo, type, number] = parts;
    if ((type === "issues" || type === "pull") && number)
      return `${repo}#${number}`;
    return parts.slice(0, 2).join("/");
  }
  if (host === "docs.google.com") {
    const kind = {
      document: "Google Doc",
      spreadsheets: "Google Sheet",
      presentation: "Google Slides",
      forms: "Google Form",
    }[parts[0] ?? ""];
    if (kind) return kind;
  }
  if (host === "drive.google.com") return "Google Drive file";
  if (host === "google.com" && parts[0] === "calendar") return "Calendar event";
  if (host === "calendar.google.com") return "Calendar event";
  if (host.endsWith(".slack.com") && parts[0] === "archives")
    return "Slack message";
  if (host.endsWith(".atlassian.net")) {
    const issue = parts.indexOf("browse");
    if (issue >= 0 && parts[issue + 1]) return parts[issue + 1]!;
    if (parts[0] === "wiki") return "Confluence page";
  }
  const path = parts.join("/");
  return path
    ? `${host}/${path.length > 32 ? `${path.slice(0, 31)}…` : path}`
    : host;
}

function tagList(value: unknown): string[] | null {
  if (typeof value === "string")
    return value
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
  if (Array.isArray(value) && value.every((tag) => isScalar(tag)))
    return value.map((tag) => String(tag).trim()).filter(Boolean);
  return null;
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (isScalar(value)) return String(value).trim();
  if (Array.isArray(value) && value.every((item) => isScalar(item)))
    return value
      .map((item) => String(item).trim())
      .filter(Boolean)
      .join(", ");
  if (Array.isArray(value) && value.length === 0) return "";
  if (isRecord(value) && Object.keys(value).length === 0) return "";
  return JSON.stringify(value);
}

function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
