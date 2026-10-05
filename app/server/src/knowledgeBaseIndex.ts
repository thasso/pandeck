/**
 * Knowledge Base tree indexing, search, and sparse summaries (KB 05).
 *
 * Builds a rebuildable index over the KB source tree
 * ({@link KnowledgeBaseStore.listTree}) and validated entry frontmatter
 * ({@link parseKbEntryMarkdown}). The index represents folders, entries, their
 * assets (including generated-extract references), and broken/invalid entries,
 * and powers token-sparse discovery: a hierarchical tree the object browser can
 * consume, plus ranked search over titles, aliases, tags, headings, prose
 * snippets, and asset (extract) metadata.
 *
 * Outputs are compact by default; callers opt into richer rows via an explicit
 * {@link KbDetailLevel}. The index itself is a rebuildable generated artifact
 * under `.kb/generated/` — never source of truth — and rebuilds are
 * deterministic so re-running at the same repo state does not rewrite the file.
 */
import { parseKbEntryMarkdown } from "./knowledgeBaseEntry.ts";
import { KnowledgeBaseStore, type KbTreeNode } from "./knowledgeBaseStore.ts";
import type { KbEntryStatus, KbEntryType } from "./knowledgeBaseContract.ts";
/** One heading of an entry body, in document order. */
interface KnowledgeEntryHeading {
  text: string;
  level: number;
}

/** Persisted generated artifact for the built index (rebuildable, gitignored). */
export const KB_INDEX_ARTIFACT = "index/kb-index.json";
const KB_INDEX_VERSION = 1;
/** Prose kept per entry for body search; caps generated-index size. */
const MAX_BODY_CHARS = 4000;
const EXCERPT_CHARS = 200;
const SNIPPET_CHARS = 160;
const DEFAULT_SEARCH_LIMIT = 20;

export type KbDetailLevel = "compact" | "standard" | "full";

/** Kinds of node the object browser renders in the KB tree. */
type KbTreeItemType = "folder" | "entry" | "invalid-entry" | "asset" | "file";

/** One asset (or generated-extract reference) attached to an entry. */
interface KbIndexAsset {
  path: string;
  title?: string;
  mimeType?: string;
  kind: "source" | "generated-extract";
  extractPath?: string;
}

/** A fully indexed, valid KB entry. */
export interface KbIndexEntry {
  id: string;
  /** Canonical `index.md` path of the entry. */
  path: string;
  /** Entry folder (parent of `index.md`). */
  folder: string;
  /** Last folder segment; a human-readable, non-durable slug. */
  slug: string;
  title: string;
  type: KbEntryType;
  status: KbEntryStatus;
  summary: string | null;
  tags: string[];
  aliases: string[];
  links: string[];
  headings: string[];
  assets: KbIndexAsset[];
  createdAt: string;
  updatedAt: string;
  /** Bounded normalized prose used for body search; not source of truth. */
  body: string;
  /** Short display excerpt derived from the body/summary. */
  excerpt: string;
}

/** An entry whose `index.md` frontmatter failed to parse/validate. */
interface KbIndexInvalidEntry {
  path: string;
  folder: string;
  slug: string;
  error: string;
}

/** A node in the hierarchical browsable tree. */
export interface KbTreeItem {
  path: string;
  name: string;
  type: KbTreeItemType;
  entryId?: string;
  title?: string;
  entryType?: KbEntryType;
  status?: KbEntryStatus;
  error?: string;
  children: KbTreeItem[];
}

/** The full rebuildable index. */
export interface KbIndex {
  version: number;
  /** KB HEAD commit the index was built from; used for cheap staleness checks. */
  head: string | null;
  entries: KbIndexEntry[];
  invalid: KbIndexInvalidEntry[];
  tree: KbTreeItem[];
}

/** A single ranked search hit, projected to the requested detail level. */
export interface KbSearchHit {
  id: string;
  path: string;
  title: string;
  type: KbEntryType;
  status: KbEntryStatus;
  score: number;
  snippet: string;
  matchedFields?: string[];
  summary?: string | null;
  tags?: string[];
  updatedAt?: string;
  aliases?: string[];
  headings?: string[];
  folder?: string;
  createdAt?: string;
}

export interface KbSearchOptions {
  limit?: number;
  detail?: KbDetailLevel;
  types?: KbEntryType[];
  statuses?: KbEntryStatus[];
}

// ---------------------------------------------------------------------------
// Index building
// ---------------------------------------------------------------------------

/**
 * Build the in-memory index from the current KB working tree. Pure read: never
 * writes. Invalid entries are captured rather than thrown so one bad entry
 * cannot hide the rest of the tree.
 */
export async function buildKnowledgeIndex(
  store: KnowledgeBaseStore,
): Promise<KbIndex> {
  const nodes = await store.listTree();
  const head = (await store.history({ limit: 1 }))[0]?.commit ?? null;

  const entriesByFolder = new Map<string, KbIndexEntry>();
  const invalidByFolder = new Map<string, KbIndexInvalidEntry>();

  for (const node of nodes) {
    if (node.type !== "file" || node.kind !== "entry-index") continue;
    const folder = parentPath(node.path);
    try {
      const doc = parseKbEntryMarkdown(
        await store.readEntryFile(node.path),
        node.path,
      );
      entriesByFolder.set(folder, toIndexEntry(node.path, folder, doc));
    } catch (err) {
      invalidByFolder.set(folder, {
        path: node.path,
        folder,
        slug: lastSegment(folder),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const tree = buildTree(nodes, entriesByFolder, invalidByFolder);

  const entries = [...entriesByFolder.values()].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  const invalid = [...invalidByFolder.values()].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  return { version: KB_INDEX_VERSION, head, entries, invalid, tree };
}

function toIndexEntry(
  indexPath: string,
  folder: string,
  doc: ReturnType<typeof parseKbEntryMarkdown>,
): KbIndexEntry {
  const kb = doc.frontmatter.kb;
  const { headings, body } = analyzeBody(doc.body);
  return {
    id: kb.id,
    path: indexPath,
    folder,
    slug: lastSegment(folder),
    title: kb.title,
    type: kb.type,
    status: kb.status,
    summary: kb.summary ?? null,
    tags: kb.tags ?? [],
    aliases: kb.aliases ?? [],
    links: kb.links ?? [],
    headings,
    assets: (kb.assets ?? []).map((asset) => ({
      path: asset.path,
      ...(asset.title !== undefined ? { title: asset.title } : {}),
      ...(asset.mimeType !== undefined ? { mimeType: asset.mimeType } : {}),
      kind: asset.kind ?? "source",
      ...(asset.extractPath !== undefined
        ? { extractPath: asset.extractPath }
        : {}),
    })),
    createdAt: kb.createdAt,
    updatedAt: kb.updatedAt,
    body,
    excerpt: makeExcerpt(kb.summary ?? body),
  };
}

/**
 * Reduce entry body Markdown to searchable/displayable text: the heading outline
 * and a bounded, whitespace-normalized prose blob. Fenced code content is kept
 * (still searchable) but fence markers and heading markup are stripped.
 */
function analyzeBody(body: string): {
  headings: string[];
  outline: KnowledgeEntryHeading[];
  body: string;
} {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const outline: KnowledgeEntryHeading[] = [];
  const prose: string[] = [];
  let inFence = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      if (line) prose.push(line);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const text = (heading[2] ?? "").replace(/\s+#+\s*$/, "").trim();
      if (text) outline.push({ text, level: (heading[1] ?? "#").length });
      continue;
    }
    if (line) prose.push(line);
  }
  return {
    headings: outline.map((entry) => entry.text),
    outline,
    body: prose.join(" ").replace(/\s+/g, " ").trim().slice(0, MAX_BODY_CHARS),
  };
}

function makeExcerpt(source: string): string {
  const text = source.replace(/\s+/g, " ").trim();
  if (text.length <= EXCERPT_CHARS) return text;
  const cut = text.slice(0, EXCERPT_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > EXCERPT_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Assemble the hierarchical tree from the flat, DFS-ordered store node list.
 * The store emits each directory immediately before its descendants, so a
 * parent node always exists by the time its children are processed. Comment
 * logs and `index.md` files are folded into their entry rather than shown as
 * standalone nodes; generated artifacts are already excluded by the store.
 */
function buildTree(
  nodes: KbTreeNode[],
  entriesByFolder: Map<string, KbIndexEntry>,
  invalidByFolder: Map<string, KbIndexInvalidEntry>,
): KbTreeItem[] {
  const byPath = new Map<string, KbTreeItem>();
  const roots: KbTreeItem[] = [];

  for (const node of nodes) {
    if (node.kind === "comment") continue;
    // The entry body is represented by its folder node, not as its own leaf.
    if (node.type === "file" && node.kind === "entry-index") continue;

    const item: KbTreeItem = {
      path: node.path,
      name: lastSegment(node.path),
      type:
        node.type === "dir"
          ? "folder"
          : node.kind === "asset"
            ? "asset"
            : "file",
      children: [],
    };
    byPath.set(node.path, item);
    const parent = parentPath(node.path);
    if (parent && byPath.has(parent)) byPath.get(parent)!.children.push(item);
    else roots.push(item);
  }

  // Upgrade folders that hold an entry index into entry/invalid-entry nodes.
  for (const [folder, entry] of entriesByFolder) {
    const item = byPath.get(folder);
    if (!item) continue;
    item.type = "entry";
    item.entryId = entry.id;
    item.title = entry.title;
    item.entryType = entry.type;
    item.status = entry.status;
  }
  for (const [folder, invalid] of invalidByFolder) {
    const item = byPath.get(folder);
    if (!item) continue;
    item.type = "invalid-entry";
    item.error = invalid.error;
  }

  const pruned = pruneEmptyFolders(roots);
  sortTree(pruned);
  return pruned;
}

/**
 * Drop plain folder nodes that hold nothing indexable. Git does not track empty
 * directories across clones, but the local working tree can retain empty
 * folders after a delete/move; excluding them keeps the tree deterministic and
 * free of orphan noise. Entries (even childless) and non-folder leaves stay.
 */
function pruneEmptyFolders(items: KbTreeItem[]): KbTreeItem[] {
  const kept: KbTreeItem[] = [];
  for (const item of items) {
    item.children = pruneEmptyFolders(item.children);
    if (item.type === "folder" && item.children.length === 0) continue;
    kept.push(item);
  }
  return kept;
}

/** Containers (folders/entries) sort before leaves; then alphabetical by name. */
function sortTree(items: KbTreeItem[]): void {
  items.sort(
    (a, b) =>
      containerRank(b) - containerRank(a) || a.name.localeCompare(b.name),
  );
  for (const item of items) sortTree(item.children);
}

function containerRank(item: KbTreeItem): number {
  return item.type === "folder" ||
    item.type === "entry" ||
    item.type === "invalid-entry"
    ? 1
    : 0;
}

// ---------------------------------------------------------------------------
// Persistence (rebuildable generated artifact)
// ---------------------------------------------------------------------------

/**
 * Rebuild the index and persist it under `.kb/generated/`, writing only when
 * the serialized content actually changed. Returns whether a write occurred so
 * callers can avoid redundant IO.
 */
export async function rebuildKnowledgeIndex(
  store: KnowledgeBaseStore,
): Promise<{ index: KbIndex; written: boolean }> {
  const index = await buildKnowledgeIndex(store);
  const serialized = `${JSON.stringify(index, null, 2)}\n`;
  const existing = await store.readGeneratedFile(KB_INDEX_ARTIFACT);
  if (existing === serialized) return { index, written: false };
  await store.writeGeneratedFile(KB_INDEX_ARTIFACT, serialized);
  return { index, written: true };
}

/** Load the persisted index, or null when it is missing/unreadable/stale-shaped. */
export async function loadKnowledgeIndex(
  store: KnowledgeBaseStore,
): Promise<KbIndex | null> {
  const raw = await store.readGeneratedFile(KB_INDEX_ARTIFACT);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as KbIndex;
    return parsed.version === KB_INDEX_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Return a fresh index, reusing the persisted artifact when it matches the
 * current KB HEAD and rebuilding (and repersisting) otherwise.
 */
export async function getKnowledgeIndex(
  store: KnowledgeBaseStore,
): Promise<KbIndex> {
  const head = (await store.history({ limit: 1 }))[0]?.commit ?? null;
  const cached = await loadKnowledgeIndex(store);
  if (cached && cached.head === head) return cached;
  return (await rebuildKnowledgeIndex(store)).index;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

interface SearchField {
  name: string;
  text: string;
  weight: number;
}

/** Field weights for ranking; higher-signal fields dominate. */
const FIELD_WEIGHTS = {
  title: 10,
  aliases: 8,
  tags: 6,
  headings: 4,
  summary: 3,
  body: 2,
  assets: 1,
} as const;

/** Search a built index. Pure and synchronous over the in-memory index. */
export function searchKnowledgeIndex(
  index: KbIndex,
  query: string,
  options: KbSearchOptions = {},
): KbSearchHit[] {
  const phrase = query.trim().toLowerCase();
  const terms = [...new Set(phrase.split(/\s+/).filter(Boolean))];
  if (terms.length === 0) return [];

  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  const detail = options.detail ?? "compact";
  const typeFilter =
    options.types && options.types.length ? new Set(options.types) : null;
  const statusFilter =
    options.statuses && options.statuses.length
      ? new Set(options.statuses)
      : null;

  const scored: { entry: KbIndexEntry; score: number; matched: string[] }[] =
    [];
  for (const entry of index.entries) {
    if (typeFilter && !typeFilter.has(entry.type)) continue;
    if (statusFilter && !statusFilter.has(entry.status)) continue;
    const result = scoreEntry(entry, terms, phrase);
    if (result.score > 0) scored.push({ entry, ...result });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.entry.updatedAt.localeCompare(a.entry.updatedAt) ||
      a.entry.path.localeCompare(b.entry.path),
  );

  return scored
    .slice(0, limit)
    .map(({ entry, score, matched }) =>
      projectHit(entry, score, matched, terms, detail),
    );
}

function scoreEntry(
  entry: KbIndexEntry,
  terms: string[],
  phrase: string,
): { score: number; matched: string[] } {
  const fields: SearchField[] = [
    { name: "title", text: entry.title, weight: FIELD_WEIGHTS.title },
    {
      name: "aliases",
      text: entry.aliases.join(" "),
      weight: FIELD_WEIGHTS.aliases,
    },
    { name: "tags", text: entry.tags.join(" "), weight: FIELD_WEIGHTS.tags },
    {
      name: "headings",
      text: entry.headings.join(" "),
      weight: FIELD_WEIGHTS.headings,
    },
    {
      name: "summary",
      text: entry.summary ?? "",
      weight: FIELD_WEIGHTS.summary,
    },
    { name: "body", text: entry.body, weight: FIELD_WEIGHTS.body },
    {
      name: "assets",
      text: entry.assets
        .map((a) => [a.title, a.path].filter(Boolean).join(" "))
        .join(" "),
      weight: FIELD_WEIGHTS.assets,
    },
  ];

  let score = 0;
  const matched: string[] = [];
  for (const field of fields) {
    const text = field.text.toLowerCase();
    if (!text) continue;
    let hits = 0;
    for (const term of terms) if (text.includes(term)) hits++;
    if (hits === 0) continue;
    matched.push(field.name);
    score += field.weight * (hits / terms.length);
    // Reward matching the whole phrase contiguously (multi-term queries only).
    if (terms.length > 1 && text.includes(phrase)) score += field.weight * 0.5;
  }

  // Title precision bonuses so exact/prefix title matches float to the top.
  const title = entry.title.toLowerCase();
  if (title === phrase) score += 8;
  else if (title.startsWith(phrase)) score += 3;

  return { score: round(score), matched };
}

function projectHit(
  entry: KbIndexEntry,
  score: number,
  matched: string[],
  terms: string[],
  detail: KbDetailLevel,
): KbSearchHit {
  const hit: KbSearchHit = {
    id: entry.id,
    path: entry.path,
    title: entry.title,
    type: entry.type,
    status: entry.status,
    score,
    snippet: makeSnippet(entry, terms),
  };
  if (detail === "compact") return hit;

  hit.matchedFields = matched;
  hit.summary = entry.summary;
  hit.tags = entry.tags;
  hit.updatedAt = entry.updatedAt;
  if (detail === "full") {
    hit.aliases = entry.aliases;
    hit.headings = entry.headings;
    hit.folder = entry.folder;
    hit.createdAt = entry.createdAt;
  }
  return hit;
}

/** A short snippet centered on the first matching term, else the excerpt. */
function makeSnippet(entry: KbIndexEntry, terms: string[]): string {
  const haystacks = [entry.summary ?? "", entry.headings.join(" "), entry.body];
  for (const text of haystacks) {
    if (!text) continue;
    const lower = text.toLowerCase();
    const at = terms
      .map((t) => lower.indexOf(t))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)[0];
    if (at === undefined) continue;
    const start = Math.max(0, at - Math.floor(SNIPPET_CHARS / 3));
    const slice = text
      .slice(start, start + SNIPPET_CHARS)
      .replace(/\s+/g, " ")
      .trim();
    return `${start > 0 ? "…" : ""}${slice}${start + SNIPPET_CHARS < text.length ? "…" : ""}`;
  }
  return entry.excerpt;
}

/** Convenience: get (or build) the index and search it in one call. */
export async function searchKnowledge(
  store: KnowledgeBaseStore,
  query: string,
  options: KbSearchOptions = {},
): Promise<KbSearchHit[]> {
  return searchKnowledgeIndex(await getKnowledgeIndex(store), query, options);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parentPath(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

function lastSegment(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? path : path.slice(at + 1);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
