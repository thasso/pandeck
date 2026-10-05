/**
 * What the Knowledge Base tools know about its files without reading them
 * again: each file's title, tags, summary, headings and (bounded) prose, for
 * `kb_search`, `kb_list` and link titles.
 *
 * The folder is the source of truth and is edited outside the app, so this is
 * a CACHE of the working tree, not of a commit: every call re-walks the folder
 * and re-reads only the files whose size or mtime moved. It lives in memory;
 * nothing is written to the folder.
 */
import { extname } from "node:path";
import {
  parseYamlSubset,
  splitYamlFrontmatter,
} from "@assistant/shared/frontmatter";
import type { KnowledgeBaseStore, KbTreeNode } from "./knowledgeBaseStore.ts";

/** Files whose text is indexed; every other file is found by its path only. */
const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".txt"]);
/** A larger text file is indexed by its path only. */
const MAX_INDEXED_FILE_BYTES = 2_000_000;
/** Prose kept per file for body search. */
const MAX_BODY_CHARS = 50_000;
const SNIPPET_CHARS = 160;
const DEFAULT_SEARCH_LIMIT = 20;

/** One file as the tools describe it. */
export interface KbFileInfo {
  path: string;
  /** Frontmatter `title`, else the first heading, else the file name. */
  title: string;
  tags: string[];
  summary?: string;
  /**
   * The `kb.id` an entry written under the retired schema carries, so a
   * `pa://knowledge/<id>` link written before links became paths still finds it.
   */
  legacyId?: string;
  headings: string[];
  /** Bounded whitespace-normalized prose; not source of truth. */
  body: string;
}

export interface KbSearchHit {
  path: string;
  title: string;
  score: number;
  snippet: string;
  tags?: string[];
}

interface CachedFile {
  sizeBytes: number;
  mtimeMs: number;
  info: KbFileInfo;
}

const caches = new Map<string, Map<string, CachedFile>>();

/** Every visible file of the KB, described; uncommitted edits included. */
export async function knowledgeFiles(
  store: KnowledgeBaseStore,
): Promise<KbFileInfo[]> {
  const nodes = (await store.listTree()).filter((node) => node.type === "file");
  const previous = caches.get(store.root) ?? new Map<string, CachedFile>();
  const next = new Map<string, CachedFile>();
  for (const node of nodes) {
    const cached = previous.get(node.path);
    next.set(
      node.path,
      cached &&
        cached.sizeBytes === node.sizeBytes &&
        cached.mtimeMs === node.mtimeMs
        ? cached
        : {
            sizeBytes: node.sizeBytes,
            mtimeMs: node.mtimeMs,
            info: await describeFile(store, node),
          },
    );
  }
  caches.set(store.root, next);
  return [...next.values()].map((file) => file.info);
}

/** One file's description, or null when it is not there. */
export async function knowledgeFile(
  store: KnowledgeBaseStore,
  path: string,
): Promise<KbFileInfo | null> {
  return (
    (await knowledgeFiles(store)).find((file) => file.path === path) ?? null
  );
}

async function describeFile(
  store: KnowledgeBaseStore,
  node: KbTreeNode,
): Promise<KbFileInfo> {
  const name = node.path.split("/").pop() ?? node.path;
  const fallback = name.replace(/\.[^.]+$/, "") || name;
  const ext = extname(node.path).toLowerCase();
  if (!TEXT_EXTENSIONS.has(ext) || node.sizeBytes > MAX_INDEXED_FILE_BYTES)
    return { path: node.path, title: name, tags: [], headings: [], body: "" };
  const text = await store.readText(node.path);
  const { meta, body } = frontmatterOf(text, node.path);
  const { headings, prose } = analyzeBody(body);
  const kb = record(meta.kb);
  const title =
    stringField(meta.title) ?? stringField(kb?.title) ?? headings[0];
  const summary =
    stringField(meta.summary) ??
    stringField(kb?.summary) ??
    stringField(meta.description);
  const legacyId = stringField(kb?.id);
  return {
    path: node.path,
    title: title ?? fallback,
    tags: listField(meta.tags ?? kb?.tags),
    ...(summary ? { summary } : {}),
    ...(legacyId ? { legacyId } : {}),
    headings,
    body: prose,
  };
}

/** A file's frontmatter mapping (empty when it has none or it does not parse). */
function frontmatterOf(
  text: string,
  path: string,
): { meta: Record<string, unknown>; body: string } {
  if (!/^---\r?\n/.test(text)) return { meta: {}, body: text };
  try {
    const { yaml, body } = splitYamlFrontmatter(text, path);
    return { meta: record(parseYamlSubset(yaml, path)) ?? {}, body };
  } catch {
    return { meta: {}, body: text };
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(value: unknown): string | undefined {
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function listField(value: unknown): string[] {
  if (Array.isArray(value))
    return value.map(stringField).filter((v): v is string => Boolean(v));
  const single = stringField(value);
  return single
    ? single
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
    : [];
}

/**
 * The heading outline and a bounded, whitespace-normalized prose blob. Fenced
 * code is kept as searchable text; fence and heading markup are stripped.
 */
function analyzeBody(body: string): { headings: string[]; prose: string } {
  const headings: string[] = [];
  const prose: string[] = [];
  let inFence = false;
  for (const raw of body.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    const heading = inFence ? null : /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      const text = (heading[1] ?? "").replace(/\s+#+\s*$/, "").trim();
      if (text) headings.push(text);
    } else if (line) prose.push(line);
  }
  return {
    headings,
    prose: prose.join(" ").replace(/\s+/g, " ").slice(0, MAX_BODY_CHARS),
  };
}

const FIELD_WEIGHTS = {
  title: 10,
  path: 6,
  tags: 6,
  headings: 4,
  summary: 4,
  body: 1,
} as const;

/** Rank files for a query: every term counts, titles and paths most. */
export function searchKnowledgeFiles(
  files: KbFileInfo[],
  query: string,
  options: { limit?: number; under?: string } = {},
): KbSearchHit[] {
  const phrase = query.trim().toLowerCase();
  const terms = [...new Set(phrase.split(/\s+/).filter(Boolean))];
  if (terms.length === 0) return [];
  const prefix = options.under ? `${options.under}/` : "";
  const scored: { file: KbFileInfo; score: number }[] = [];
  for (const file of files) {
    if (prefix && !file.path.startsWith(prefix)) continue;
    const score = scoreFile(file, terms, phrase);
    if (score > 0) scored.push({ file, score });
  }
  scored.sort(
    (a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path),
  );
  return scored
    .slice(0, options.limit ?? DEFAULT_SEARCH_LIMIT)
    .map(({ file, score }) => ({
      path: file.path,
      title: file.title,
      score: Math.round(score * 1000) / 1000,
      snippet: snippet(file, terms),
      ...(file.tags.length ? { tags: file.tags } : {}),
    }));
}

function scoreFile(file: KbFileInfo, terms: string[], phrase: string): number {
  const fields: [string, number][] = [
    [file.title, FIELD_WEIGHTS.title],
    [file.path, FIELD_WEIGHTS.path],
    [file.tags.join(" "), FIELD_WEIGHTS.tags],
    [file.headings.join(" "), FIELD_WEIGHTS.headings],
    [file.summary ?? "", FIELD_WEIGHTS.summary],
    [file.body, FIELD_WEIGHTS.body],
  ];
  let score = 0;
  for (const [raw, weight] of fields) {
    const text = raw.toLowerCase();
    if (!text) continue;
    const hits = terms.filter((term) => text.includes(term)).length;
    if (hits === 0) continue;
    score += weight * (hits / terms.length);
    // Reward the whole phrase, contiguously (multi-term queries only).
    if (terms.length > 1 && text.includes(phrase)) score += weight * 0.5;
  }
  const title = file.title.toLowerCase();
  if (title === phrase) score += 8;
  else if (title.startsWith(phrase)) score += 3;
  return score;
}

/** A short snippet around the first matching term, else the summary. */
function snippet(file: KbFileInfo, terms: string[]): string {
  for (const text of [file.summary ?? "", file.body]) {
    const lower = text.toLowerCase();
    const at = terms
      .map((term) => lower.indexOf(term))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0];
    if (at === undefined) continue;
    const start = Math.max(0, at - Math.floor(SNIPPET_CHARS / 3));
    const slice = text.slice(start, start + SNIPPET_CHARS).trim();
    return `${start > 0 ? "…" : ""}${slice}${start + SNIPPET_CHARS < text.length ? "…" : ""}`;
  }
  return file.summary ?? file.body.slice(0, SNIPPET_CHARS);
}
