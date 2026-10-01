/**
 * Executable pieces of the first-class Knowledge Base v1 contract.
 *
 * The product/storage contract is documented in docs/knowledge-base.md. This
 * module intentionally stays pure so early KB slices can depend on shared
 * constants and path/schema shapes before the Git storage layer exists.
 */

export const KB_REPO_DIR_NAME = "knowledge";
const KB_CONTROL_DIR = ".kb";
export const KB_COMMENTS_DIR = `${KB_CONTROL_DIR}/comments`;
export const KB_GENERATED_DIR = `${KB_CONTROL_DIR}/generated`;
export const KB_ENTRY_INDEX_FILE = "index.md";
export const KB_ENTRY_ASSETS_DIR = "assets";
export const KB_SCHEMA_VERSION = 1;

export const KB_ENTRY_TYPES = [
  "note",
  "brief",
  "workflow",
  "plan",
  "reference",
  "project",
  "daily-summary",
  "decision",
] as const;
export const KB_ENTRY_STATUSES = ["draft", "active", "archived"] as const;
export const KB_SOURCE_KINDS = [
  "manual",
  "import",
  "meeting",
  "email",
  "slack",
  "jira",
  "project",
  "agent",
] as const;

export type KbEntryType = (typeof KB_ENTRY_TYPES)[number];
export type KbEntryStatus = (typeof KB_ENTRY_STATUSES)[number];
type KbSourceKind = (typeof KB_SOURCE_KINDS)[number];

/**
 * Canonical, always-valid entry frontmatter skeleton for agents/humans, built
 * from the v1 constants so the enums and schema literal can never drift from
 * validation. Surfaced in the KB agent prompt and the write/edit tool schemas
 * so authors get the exact shape (and valid values) up front instead of
 * rediscovering it through validation errors.
 */
export function knowledgeEntryFrontmatterHelp(): string {
  // Two parts: a clean, valid, copy-pasteable example (no inline `#` comments —
  // the KB YAML subset does not strip them), followed by field rules. Enums come
  // straight from the constants so guidance can never drift from validation.
  return [
    "Author entries from this exact shape — a valid example; fill in real values and keep the field names/enums. Frontmatter is a single top-level `kb:` map, then the Markdown body.",
    "",
    "---",
    "kb:",
    `  schema: ${KB_SCHEMA_VERSION}`,
    "  id: license-service-token-binding",
    "  type: reference",
    "  title: DRM/CDN Token Binding",
    "  status: active",
    "  createdAt: 2026-07-13T14:20:00.000Z",
    "  updatedAt: 2026-07-13T14:20:00.000Z",
    "  tags: [project:license-service, drm]",
    "  source:",
    "    kind: slack",
    "    refs: [pa://task/62]",
    "  links: [pa://task/62]",
    "---",
    "",
    "# Body Markdown here",
    "",
    "Field rules (unknown fields are rejected):",
    `- schema: the number ${KB_SCHEMA_VERSION} (not "v${KB_SCHEMA_VERSION}" or a string).`,
    "- id: stable lowercase [a-z0-9._-], 2-128 chars; survives moves/renames.",
    `- type (required): one of ${KB_ENTRY_TYPES.join(", ")}.`,
    `- status (required): one of ${KB_ENTRY_STATUSES.join(", ")}.`,
    "- createdAt/updatedAt (required): ISO-8601 UTC, e.g. 2026-07-13T14:20:00.000Z; updatedAt must be >= createdAt.",
    `- source (optional): ONLY \`kind\` (one of ${KB_SOURCE_KINDS.join(", ")}) and \`refs\` (list of pa:// links or urls/ids). No url/title/name fields.`,
    "- tags/aliases (optional): string lists. links (optional): pa:// object links only.",
  ].join("\n");
}

export interface KbAssetRefV1 {
  path: string;
  title?: string;
  mimeType?: string;
  kind?: "source" | "generated-extract";
  extractPath?: string;
}

export interface KbSourceRefV1 {
  kind: KbSourceKind;
  refs?: string[];
}

export interface KbEntryMetadataV1 {
  schema: typeof KB_SCHEMA_VERSION;
  id: string;
  type: KbEntryType;
  title: string;
  status: KbEntryStatus;
  createdAt: string;
  updatedAt: string;
  summary?: string;
  tags?: string[];
  aliases?: string[];
  links?: string[];
  source?: KbSourceRefV1;
  assets?: KbAssetRefV1[];
}

export interface KbEntryFrontmatterV1 {
  kb: KbEntryMetadataV1;
}

export type KbPathKind =
  "entry-index" | "asset" | "comment" | "generated" | "reserved" | "other";

const DIACRITIC_RE = /\p{Diacritic}/gu;
const NON_SLUG_RE = /[^a-z0-9]+/g;
const SLUG_EDGE_RE = /^-+|-+$/g;
const MAX_ENTRY_SLUG_LENGTH = 80;

export function knowledgeEntrySlug(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(DIACRITIC_RE, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(NON_SLUG_RE, "-")
    .replace(SLUG_EDGE_RE, "")
    .slice(0, MAX_ENTRY_SLUG_LENGTH)
    .replace(SLUG_EDGE_RE, "");
  return slug || "entry";
}

export function knowledgeEntryIndexPath(entryFolder: string): string {
  const folder = normalizeKnowledgeRelativePath(entryFolder);
  if (!folder) throw new Error("Knowledge entry folder is required.");
  if (folder.split("/").includes(KB_ENTRY_ASSETS_DIR))
    throw new Error(
      "Knowledge entry folders cannot be inside an assets directory.",
    );
  return `${folder}/${KB_ENTRY_INDEX_FILE}`;
}

export function normalizeKnowledgeRelativePath(input: string): string {
  const raw = input.trim();
  if (/^\/|^[A-Za-z]:[\\/]/.test(raw))
    throw new Error(
      "Knowledge paths must be relative and must not contain traversal segments.",
    );
  const parts = raw.replace(/\\/g, "/").split("/").filter(Boolean);
  if (
    parts.some((part) => part === "." || part === ".." || part.includes("\0"))
  ) {
    throw new Error(
      "Knowledge paths must be relative and must not contain traversal segments.",
    );
  }
  return parts.join("/");
}

export function isGeneratedKnowledgePath(input: string): boolean {
  const path = normalizeKnowledgeRelativePath(input);
  return path === KB_GENERATED_DIR || path.startsWith(`${KB_GENERATED_DIR}/`);
}

export function classifyKnowledgePath(input: string): KbPathKind {
  const path = normalizeKnowledgeRelativePath(input);
  if (!path) return "other";
  const segments = path.split("/");
  if (segments[0] === ".git") return "reserved";
  if (isGeneratedKnowledgePath(path)) return "generated";
  if (path.startsWith(`${KB_COMMENTS_DIR}/`) && path.endsWith(".jsonl"))
    return "comment";
  if (segments.includes(KB_ENTRY_ASSETS_DIR)) return "asset";
  if (segments.at(-1) === KB_ENTRY_INDEX_FILE) return "entry-index";
  if (segments[0]?.startsWith(".")) return "reserved";
  return "other";
}

export function isSourceKnowledgePath(input: string): boolean {
  const kind = classifyKnowledgePath(input);
  return (
    kind === "entry-index" ||
    kind === "asset" ||
    kind === "comment" ||
    kind === "other"
  );
}
