import {
  parseYamlSubset,
  splitYamlFrontmatter,
} from "@assistant/shared/frontmatter";

/** One frontmatter field shown as a label and a one-line value. */
interface FrontmatterField {
  key: string;
  value: string;
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
  /**
   * False when the YAML is outside the subset the shared parser reads (block
   * scalars, anchors, flow maps). The header then shows `raw` instead.
   */
  parsed: boolean;
}

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
    return { raw, tags: [], fields: [], parsed: false };
  }
  const root = unwrapNamespace(value);
  if (!isRecord(root)) return { raw, tags: [], fields: [], parsed: false };
  const out: MarkdownFrontmatter = { raw, tags: [], fields: [], parsed: true };
  for (const [key, field] of Object.entries(root)) {
    if (key === "title" && typeof field === "string" && field.trim()) {
      out.title = field.trim();
      continue;
    }
    if (key === "tags") {
      const tags = tagList(field);
      if (tags) {
        out.tags = tags;
        continue;
      }
    }
    const shown = displayValue(field);
    if (shown) out.fields.push({ key, value: shown });
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
  if (isScalar(value)) return clip(String(value).trim());
  if (Array.isArray(value) && value.every((item) => isScalar(item)))
    return clip(
      value
        .map((item) => String(item).trim())
        .filter(Boolean)
        .join(", "),
    );
  if (Array.isArray(value) && value.length === 0) return "";
  if (isRecord(value) && Object.keys(value).length === 0) return "";
  return clip(JSON.stringify(value));
}

function clip(text: string): string {
  return text.length > MAX_VALUE_CHARS
    ? `${text.slice(0, MAX_VALUE_CHARS - 1)}…`
    : text;
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
