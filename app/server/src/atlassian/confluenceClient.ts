/**
 * Confluence Cloud REST client.
 *
 * Two API versions are in play and neither is optional. Pages, spaces and
 * comments live on v2 (`/wiki/api/v2`), but CQL search never moved there, so
 * search stays on v1 (`/wiki/rest/api/search`). Bodies travel as ADF
 * (`atlas_doc_format`), which on the wire is a JSON STRING inside
 * `body.value`, not a nested object — sending the object is the usual cause of
 * `400 Invalid`.
 */
import {
  atlassianBaseUrl,
  atlassianFetch,
  type AtlassianApiConfig,
  type AtlassianCallOptions,
  type AtlassianQuery,
} from "./atlassianFetch.ts";
import { adfToMarkdown } from "./adfToMarkdown.ts";
import { storageToMarkdown } from "./storageToMarkdown.ts";
import type { AdfNode } from "./adfFromMarkdown.ts";

export type ConfluenceApiConfig = AtlassianApiConfig;

/** Body representations this client reads and writes. */
type ConfluenceBodyFormat = "atlas_doc_format" | "storage";

export async function confluenceGet<T>(
  config: ConfluenceApiConfig,
  path: string,
  query?: AtlassianQuery,
  options: AtlassianCallOptions = {},
): Promise<T> {
  return atlassianFetch<T>(
    config,
    "Confluence",
    "GET",
    path,
    undefined,
    query,
    {
      retry: true,
      ...options,
    },
  );
}

export async function confluencePost<T>(
  config: ConfluenceApiConfig,
  path: string,
  body: unknown,
  query?: AtlassianQuery,
  options: AtlassianCallOptions = {},
): Promise<T> {
  return atlassianFetch<T>(
    config,
    "Confluence",
    "POST",
    path,
    body,
    query,
    options,
  );
}

export async function confluencePut<T>(
  config: ConfluenceApiConfig,
  path: string,
  body: unknown,
): Promise<T> {
  return atlassianFetch<T>(config, "Confluence", "PUT", path, body);
}

export async function confluenceDelete<T>(
  config: ConfluenceApiConfig,
  path: string,
  query?: AtlassianQuery,
): Promise<T> {
  return atlassianFetch<T>(
    config,
    "Confluence",
    "DELETE",
    path,
    undefined,
    query,
  );
}

/** Confluence's own base, one level under the Atlassian site. */
function confluenceBaseUrl(host: string): string {
  return `${atlassianBaseUrl(host)}/wiki`;
}

/**
 * Absolute URL for a `_links.webui` or search `url` path. Both are normally
 * relative to `/wiki`, but a path that already names it is taken as
 * site-relative rather than prefixed into `/wiki/wiki/...`.
 */
export function confluenceWebUrl(
  host: string,
  webui: string | undefined | null,
): string | null {
  if (!webui) return null;
  if (/^https?:\/\//i.test(webui)) return webui;
  const path = webui.startsWith("/") ? webui : `/${webui}`;
  if (path === "/wiki" || path.startsWith("/wiki/"))
    return `${atlassianBaseUrl(host)}${path}`;
  return `${confluenceBaseUrl(host)}${path}`;
}

/** Fallback page URL for a response that carried no `_links.webui`. */
export function confluencePageUrl(host: string, pageId: string): string {
  return `${confluenceBaseUrl(host)}/pages/viewpage.action?pageId=${encodeURIComponent(pageId)}`;
}

export interface ConfluencePageResponse {
  id?: string;
  status?: string;
  title?: string;
  spaceId?: string;
  parentId?: string | null;
  authorId?: string;
  createdAt?: string;
  version?: {
    number?: number;
    createdAt?: string;
    message?: string;
    authorId?: string;
  };
  body?: {
    atlas_doc_format?: { value?: string; representation?: string };
    storage?: { value?: string; representation?: string };
  };
  _links?: { webui?: string; editui?: string; tinyui?: string };
}

export interface NormalizedConfluencePage {
  id: string;
  title: string;
  status: string | null;
  spaceId: string | null;
  parentId: string | null;
  version: number | null;
  versionMessage: string | null;
  updatedAt: string | null;
  authorId: string | null;
  url: string | null;
  /** Page body as Markdown, when a body was requested and returned. */
  markdown: string | null;
  /** Which representation the Markdown came from; `storage` means the ADF fallback ran. */
  bodySource: ConfluenceBodyFormat | null;
  /**
   * ADF node types in the page that Markdown cannot represent. A body rewrite
   * built from Markdown would drop them, so both the tool and the approval
   * card carry this forward.
   */
  lossyNodes: string[];
}

/**
 * ADF node types `markdownToAdf` can produce. Anything a page contains beyond
 * this set survives reading (the reader names it) but cannot come back through
 * Markdown, which is exactly what makes a full-body rewrite destructive.
 */
const MARKDOWN_REPRESENTABLE_NODES = new Set([
  "doc",
  "paragraph",
  "heading",
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
  "codeBlock",
  "rule",
  "table",
  "tableRow",
  "tableHeader",
  "tableCell",
  "text",
  "hardBreak",
]);

/**
 * A parsed ADF body: the root document with its block list. The type exists so
 * a splice target cannot be "some JSON that parsed" — see {@link parseAdfBody}.
 */
export type AdfDocument = AdfNode & { type: "doc"; content: AdfNode[] };

/**
 * Parse the ADF body, which Confluence delivers as a JSON string.
 *
 * The shape is CHECKED, not assumed. `JSON.parse` accepts `"text"`, `{}` and
 * `[]` just as happily as a document, and any of them would reach `spliceAdf`
 * with no `content` to splice into — which writes the addition alone and wipes
 * the page. Anything that is not a real `doc` with a block array is treated as
 * no ADF at all, which routes the read to the storage fallback and makes the
 * write path refuse.
 */
export function parseAdfBody(page: ConfluencePageResponse): AdfDocument | null {
  const value = page.body?.atlas_doc_format?.value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const node = parsed as AdfNode;
    if (node.type !== "doc" || !Array.isArray(node.content)) return null;
    return node as AdfDocument;
  } catch {
    return null;
  }
}

/** Every node type in the document that a Markdown round-trip would lose. */
function lossyAdfNodes(adf: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const item = node as { type?: string; content?: unknown };
    if (item.type && !MARKDOWN_REPRESENTABLE_NODES.has(item.type))
      found.add(item.type);
    if (Array.isArray(item.content))
      for (const child of item.content) walk(child);
  };
  walk(adf);
  return [...found].sort();
}

export function normalizeConfluencePage(
  page: ConfluencePageResponse,
  host: string,
): NormalizedConfluencePage {
  const adf = parseAdfBody(page);
  const adfMarkdown = adf ? adfToMarkdown(adf) : null;
  const storage = page.body?.storage?.value;
  // An older page can answer ADF with an empty document; storage always has
  // the content, so it is the fallback rather than an empty body.
  const useStorage =
    !adfMarkdown && typeof storage === "string" && storage.trim() !== "";
  const id = page.id ?? "";
  return {
    id,
    title: page.title ?? "",
    status: page.status ?? null,
    spaceId: page.spaceId ?? null,
    parentId: page.parentId ?? null,
    version:
      typeof page.version?.number === "number" ? page.version.number : null,
    versionMessage: page.version?.message || null,
    updatedAt: page.version?.createdAt ?? page.createdAt ?? null,
    authorId: page.version?.authorId ?? page.authorId ?? null,
    url:
      confluenceWebUrl(host, page._links?.webui) ??
      (id ? confluencePageUrl(host, id) : null),
    markdown: useStorage ? storageToMarkdown(storage as string) : adfMarkdown,
    bodySource: useStorage
      ? "storage"
      : adfMarkdown
        ? "atlas_doc_format"
        : null,
    lossyNodes: adf ? lossyAdfNodes(adf) : [],
  };
}

/** The `body` payload for a page or comment write. */
export function adfBodyPayload(adf: AdfNode): {
  representation: "atlas_doc_format";
  value: string;
} {
  return { representation: "atlas_doc_format", value: JSON.stringify(adf) };
}

export interface ConfluenceSpaceResponse {
  id?: string;
  key?: string;
  name?: string;
  type?: string;
  status?: string;
  description?: { plain?: { value?: string } };
  _links?: { webui?: string };
}

export interface NormalizedConfluenceSpace {
  id: string;
  key: string;
  name: string;
  type: string | null;
  status: string | null;
  url: string | null;
}

export function normalizeConfluenceSpace(
  space: ConfluenceSpaceResponse,
  host: string,
): NormalizedConfluenceSpace {
  return {
    id: space.id ?? "",
    key: space.key ?? "",
    name: space.name ?? "",
    type: space.type ?? null,
    status: space.status ?? null,
    url: confluenceWebUrl(host, space._links?.webui),
  };
}

/** Resolve a space key (what users type) to the numeric id v2 writes need. */
export async function resolveSpaceId(
  config: ConfluenceApiConfig,
  spaceKey: string,
  options: AtlassianCallOptions = {},
): Promise<{ id: string; key: string; name: string }> {
  const result = await confluenceGet<{ results?: ConfluenceSpaceResponse[] }>(
    config,
    "/wiki/api/v2/spaces",
    { keys: spaceKey, limit: 1 },
    options,
  );
  const space = result.results?.[0];
  if (!space?.id)
    throw new Error(
      `Confluence space "${spaceKey}" was not found, or the Atlassian account cannot see it.`,
    );
  return {
    id: space.id,
    key: space.key ?? spaceKey,
    name: space.name ?? spaceKey,
  };
}

/** Fetch one page with its ADF body, falling back to storage for legacy content. */
export async function fetchPageWithBody(
  config: ConfluenceApiConfig,
  pageId: string,
  options: AtlassianCallOptions = {},
): Promise<NormalizedConfluencePage> {
  const page = await confluenceGet<ConfluencePageResponse>(
    config,
    `/wiki/api/v2/pages/${encodeURIComponent(pageId)}`,
    { "body-format": "atlas_doc_format" },
    options,
  );
  const normalized = normalizeConfluencePage(page, config.host);
  if (normalized.markdown !== null) return normalized;
  const legacy = await confluenceGet<ConfluencePageResponse>(
    config,
    `/wiki/api/v2/pages/${encodeURIComponent(pageId)}`,
    { "body-format": "storage" },
    options,
  );
  return normalizeConfluencePage(
    { ...legacy, ...(page._links ? { _links: page._links } : {}) },
    config.host,
  );
}
