import type { PaObjectLinkResolution } from "./objectLinks.ts";

type KnowledgeEntryType =
  | "note"
  | "brief"
  | "workflow"
  | "plan"
  | "reference"
  | "project"
  | "daily-summary"
  | "decision";
type KnowledgeEntryStatus = "draft" | "active" | "archived";

/** Kinds of nodes the Knowledge sidebar tree can render. */
type KnowledgeTreeNodeType =
  "folder" | "entry" | "invalid-entry" | "asset" | "file";

/** Compact hierarchical KB tree node returned by the server HTTP read surface. */
export interface KnowledgeTreeNode {
  path: string;
  name: string;
  type: KnowledgeTreeNodeType;
  entryId?: string;
  title?: string;
  entryType?: KnowledgeEntryType;
  status?: KnowledgeEntryStatus;
  error?: string;
  children: KnowledgeTreeNode[];
}

/** Token-sparse payload for the app-shell Knowledge browser. */
export interface KnowledgeTreeResponse {
  tree: KnowledgeTreeNode[];
  entriesCount: number;
  invalidCount: number;
  head: string | null;
}

/** One entry-local asset surfaced to the main-pane Knowledge viewer/inspector. */
export interface KnowledgeEntryAsset {
  /** Entry-local path stored in frontmatter, e.g. `assets/source.pdf`. */
  path: string;
  title?: string;
  mimeType?: string;
  kind: "source" | "generated-extract";
  exists: boolean;
  sizeBytes?: number;
  /** True when the asset is an image the viewer can inline. */
  isImage: boolean;
}

/** One heading of an entry's body: its text and its Markdown level (1-6). */
export interface KnowledgeEntryHeading {
  text: string;
  level: number;
}

/**
 * A readable, linkable KB entry document for the main-pane Markdown viewer.
 *
 * The body Markdown is source-of-truth text with frontmatter stripped; titles,
 * assets, and `pa://` references are resolved server-side so the browser can
 * render inferred link titles without re-fetching each object.
 */
export interface KnowledgeEntryDocument {
  kind: "entry";
  id: string;
  /** Canonical `index.md` path. */
  path: string;
  /** Entry folder (parent of `index.md`). */
  folder: string;
  /** Last folder segment; a human-readable, non-durable slug. */
  slug: string;
  /** Durable `pa://knowledge/<id>` reference for this entry. */
  uri: string;
  title: string;
  type: KnowledgeEntryType;
  status: KnowledgeEntryStatus;
  summary: string | null;
  tags: string[];
  aliases: string[];
  /** Declared `pa://` links from frontmatter. */
  links: string[];
  /** Declared source references (http(s) URLs or `pa://` links). */
  sourceRefs: string[];
  /**
   * Heading outline, top to bottom, WITH levels so the contents can be rendered
   * as the document's actual structure rather than a flat list. The search index
   * keeps its own flat heading text; this is the document view's outline.
   */
  outline: KnowledgeEntryHeading[];
  assets: KnowledgeEntryAsset[];
  createdAt: string;
  updatedAt: string;
  /** Entry body Markdown without frontmatter. */
  markdown: string;
  /** Resolved `pa://` references found in the body, links, and source refs. */
  paObjectReferences: PaObjectLinkResolution[];
}

/** An entry whose `index.md` frontmatter failed to parse/validate. */
export interface KnowledgeEntryInvalid {
  kind: "invalid";
  path: string;
  folder: string;
  slug: string;
  error: string;
  /** Raw file content when readable, so the viewer can still show the source. */
  markdown: string | null;
}

/** Main-pane entry viewer payload: a rendered document or an invalid-entry state. */
export type KnowledgeEntryResponse =
  KnowledgeEntryDocument | KnowledgeEntryInvalid;

/** Compact Git history row for a KB entry/path. */
export interface KnowledgeHistoryRow {
  commit: string;
  fullCommit: string;
  date: string;
  author: string;
  subject: string;
  entryIds?: string;
  paths?: string;
}

/** One changed source file within a commit, with bounded old/new text. */
export interface KnowledgeDiffFile {
  /** Repo-relative source path on the new side (or old side for deletes). */
  path: string;
  /** Previous path when the file was renamed. */
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  /** Contents at the parent commit; null when the file was added or is binary. */
  oldText: string | null;
  /** Contents at this commit; null when the file was deleted or is binary. */
  newText: string | null;
  /** Non-text file whose contents are not rendered. */
  binary: boolean;
  /** Either side was clipped to the per-file character cap. */
  truncated: boolean;
}

/** Bounded diff preview for a KB entry/path history row. */
export interface KnowledgeDiffPreview {
  commit: string;
  /** Raw `git show` patch text; a fallback/source-of-record for the diff. */
  patch: string;
  truncated: boolean;
  totalChars: number;
  /**
   * Structured per-file old/new text for rich rendering (Pierre source diff and
   * the rendered-Markdown diff). Empty when no source files changed in the scope.
   */
  files: KnowledgeDiffFile[];
}

/** Frontmatter metadata projected for the Knowledge inspector without body text. */
interface KnowledgeFrontmatterSummary {
  schema: 1;
  id: string;
  type: KnowledgeEntryType;
  title: string;
  status: KnowledgeEntryStatus;
  summary: string | null;
  tags: string[];
  aliases: string[];
  links: string[];
  sourceRefs: string[];
  createdAt: string;
  updatedAt: string;
}

/** Compact right-inspector payload for one valid KB entry. */
export interface KnowledgeEntryInspect {
  kind: "entry";
  id: string;
  path: string;
  folder: string;
  slug: string;
  uri: string;
  title: string;
  type: KnowledgeEntryType;
  status: KnowledgeEntryStatus;
  summary: string | null;
  tags: string[];
  aliases: string[];
  links: string[];
  sourceRefs: string[];
  assets: KnowledgeEntryAsset[];
  createdAt: string;
  updatedAt: string;
  frontmatter: KnowledgeFrontmatterSummary;
  /** Resolved related objects from frontmatter refs and bounded body link scan. */
  paObjectReferences: PaObjectLinkResolution[];
  history: KnowledgeHistoryRow[];
  latestDiff: KnowledgeDiffPreview | null;
}

/** Compact inspector payload for an invalid/path-addressed KB entry. */
interface KnowledgeInvalidInspect {
  kind: "invalid";
  path: string;
  folder: string;
  slug: string;
  error: string;
  history: KnowledgeHistoryRow[];
  latestDiff: KnowledgeDiffPreview | null;
}

/** Right-inspector payload: body Markdown is intentionally omitted. */
export type KnowledgeInspectResponse =
  KnowledgeEntryInspect | KnowledgeInvalidInspect;
