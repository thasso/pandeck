/**
 * The Confluence read tools' shared half (Task-1439 P2): the schemas,
 * descriptions and runs of `confluence_search`, `confluence_get_page` and
 * `confluence_lookup`, used by Pandeck's local tools and the gateway edge
 * alike, plus the page-input, paging and attachment-row helpers the write and
 * download code share with them.
 *
 * This module imports only the Confluence client and its helpers, never
 * server state (`workerBoundary.test.ts`): the caller hands in the config and
 * the call's signal. A run returns the payload object; the local tool prints
 * it pretty (`jsonResult`), the edge compact, so key order here is part of
 * both contracts (`confluenceReadBaseline.test.ts`).
 */
import {
  atlassianBaseUrl,
  type AtlassianQuery,
} from "./atlassian/atlassianFetch.ts";
import { adfToMarkdown } from "./atlassian/adfToMarkdown.ts";
import {
  ConfluenceReadRefusal,
  confluenceGet,
  confluencePageUrl,
  confluenceWebUrl,
  fetchPageWithBody,
  normalizeConfluenceSpace,
  resolveSpaceId,
  type ConfluenceConfig,
  type ConfluenceSpaceResponse,
} from "./atlassian/confluenceClient.ts";

export type ConfluenceSearchParams = {
  text?: string;
  title?: string;
  spaceKeys?: string[];
  label?: string;
  type?: string;
  updatedSince?: string;
  cql?: string;
  maxResults?: number;
  start?: number;
};

export type ConfluenceGetPageParams = {
  page: string;
  maxChars?: number;
  includeComments?: boolean;
  maxComments?: number;
  includeLabels?: boolean;
  includeChildren?: boolean;
  includeAttachments?: boolean;
};

type LookupKind =
  "spaces" | "pageTree" | "labels" | "attachments" | "comments" | "replies";

export type ConfluenceLookupParams = {
  kind: LookupKind;
  spaceKey?: string;
  page?: string;
  commentId?: string;
  query?: string;
  maxResults?: number;
  cursor?: string;
};

/** What a read needs besides the config and its parameters. */
export interface ConfluenceReadDeps {
  /** Every Confluence request of the read, retries included, carries it. */
  signal?: AbortSignal | undefined;
}

/** Rows per page for the optional page sections and the lookup listings. */
const LIST_PAGE_LIMIT = 100;
const REPLY_PAGE_LIMIT = 50;

// --------------------------------------------------------------------------
// Shared helpers
// --------------------------------------------------------------------------

export function clamp(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Accept a page id or any Confluence URL that names one. Users paste URLs, and
 * the two URL shapes Confluence hands out (`/pages/<id>/Title` and
 * `?pageId=<id>`) both carry the id.
 */
export function normalizePageInput(value: string | undefined): string {
  const raw = (value ?? "").trim();
  if (!raw)
    throw new ConfluenceReadRefusal(
      "page_missing",
      "A Confluence page id or URL is required.",
    );
  if (/^\d+$/.test(raw)) return raw;
  const fromQuery = raw.match(/[?&]pageId=(\d+)/i);
  if (fromQuery?.[1]) return fromQuery[1];
  const fromPath = raw.match(/\/pages\/(?:viewpage\.action\?pageId=)?(\d+)/i);
  if (fromPath?.[1]) return fromPath[1];
  throw new ConfluenceReadRefusal(
    "page_unparsable",
    `Could not read a page id from "${raw}". Pass the numeric page id or a Confluence page URL.`,
  );
}

export function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
}

/** CQL string literal. A quote inside a title would otherwise end the clause. */
function cqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Confluence highlights search excerpts with its own markers; strip them. */
function stripHighlight(value: string | undefined): string | null {
  if (!value) return null;
  return value.replace(/@@@(?:end)?hl@@@/g, "").trim() || null;
}

export async function resolveSpaceSummary(
  config: ConfluenceConfig,
  spaceId: string | null,
  signal: AbortSignal | undefined,
): Promise<{ key: string; name: string } | null> {
  if (!spaceId) return null;
  try {
    const space = await confluenceGet<ConfluenceSpaceResponse>(
      config,
      `/wiki/api/v2/spaces/${encodeURIComponent(spaceId)}`,
      undefined,
      signal ? { signal } : {},
    );
    return { key: space.key ?? "", name: space.name ?? "" };
  } catch {
    // A space the account cannot read does not make the page unreadable.
    return null;
  }
}

// --------------------------------------------------------------------------
// Attachment rows
// --------------------------------------------------------------------------

export interface ConfluenceAttachmentResponse {
  id?: string;
  title?: string;
  pageId?: string;
  mediaType?: string;
  fileSize?: number;
  comment?: string;
  downloadLink?: string;
  version?: { number?: number };
  _links?: { download?: string };
}

export interface ConfluenceAttachmentRow {
  id: string;
  title: string;
  mediaType: string | null;
  fileSize: number | null;
  version: number | null;
  downloadUrl: string | null;
}

export function normalizeAttachment(
  raw: ConfluenceAttachmentResponse,
  host: string,
): ConfluenceAttachmentRow {
  const path = downloadPathOf(raw);
  return {
    id: raw.id ?? "",
    title: raw.title ?? "",
    mediaType: raw.mediaType ?? null,
    fileSize: typeof raw.fileSize === "number" ? raw.fileSize : null,
    version: versionOf(raw),
    downloadUrl: path ? `${atlassianBaseUrl(host)}${path}` : null,
  };
}

export function versionOf(raw: ConfluenceAttachmentResponse): number | null {
  return typeof raw.version?.number === "number" ? raw.version.number : null;
}

/**
 * The site-relative path an attachment downloads from. v2 answers it relative
 * to `/wiki`; a link that already names `/wiki` is kept as is.
 */
export function downloadPathOf(
  raw: ConfluenceAttachmentResponse,
): string | null {
  const link = raw.downloadLink ?? raw._links?.download;
  if (!link || /^[a-z]+:/i.test(link) || link.startsWith("//")) return null;
  const path = link.startsWith("/") ? link : `/${link}`;
  return path === "/wiki" || path.startsWith("/wiki/") ? path : `/wiki${path}`;
}

// --------------------------------------------------------------------------
// confluence_search
// --------------------------------------------------------------------------

/** Build CQL from the convenience filters, or pass the caller's own through. */
export function buildSearchCql(params: ConfluenceSearchParams): string {
  const raw = params.cql?.trim();
  if (raw) return raw;
  const clauses: string[] = [];
  const type = params.type?.trim() || "page";
  clauses.push(`type = ${cqlString(type)}`);
  const spaceKeys = stringList(params.spaceKeys);
  if (spaceKeys.length === 1)
    clauses.push(`space = ${cqlString(spaceKeys[0] as string)}`);
  else if (spaceKeys.length > 1)
    clauses.push(`space in (${spaceKeys.map(cqlString).join(", ")})`);
  if (params.label?.trim())
    clauses.push(`label = ${cqlString(params.label.trim())}`);
  if (params.title?.trim())
    clauses.push(`title ~ ${cqlString(params.title.trim())}`);
  if (params.text?.trim())
    clauses.push(`text ~ ${cqlString(params.text.trim())}`);
  if (params.updatedSince?.trim()) {
    const since = params.updatedSince.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since))
      throw new ConfluenceReadRefusal(
        "updated_since_format",
        "updatedSince must be a YYYY-MM-DD date.",
      );
    clauses.push(`lastmodified >= ${cqlString(since)}`);
  }
  if (clauses.length === 1 && !params.text && !params.title && !params.label)
    throw new ConfluenceReadRefusal(
      "search_filters_missing",
      "Give at least one of text, title, label, spaceKeys or updatedSince, or pass a raw cql query.",
    );
  return `${clauses.join(" AND ")} order by lastmodified desc`;
}

export const CONFLUENCE_SEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: {
      type: "string",
      description:
        "Free-text match against page content and title (CQL `text ~`).",
    },
    title: {
      type: "string",
      description: "Match against the title only (CQL `title ~`).",
    },
    spaceKeys: {
      type: "array",
      items: { type: "string" },
      description:
        'Restrict to these space keys, e.g. ["ENG"]. Discover keys with confluence_lookup kind=spaces.',
    },
    label: {
      type: "string",
      description: "Restrict to pages carrying this label.",
    },
    type: {
      type: "string",
      enum: ["page", "blogpost", "comment", "attachment"],
      description: "Content type to search. Defaults to page.",
    },
    updatedSince: {
      type: "string",
      description: "Only content modified on or after this YYYY-MM-DD date.",
    },
    cql: {
      type: "string",
      description:
        "Raw CQL, used verbatim and ignoring every other filter. Use it only for queries the filters cannot express; a malformed query is rejected by Confluence, not repaired here.",
    },
    maxResults: {
      type: "number",
      description:
        "Results in this page of output. Defaults to 15, maximum 100.",
    },
    start: {
      type: "number",
      description:
        "Offset to continue from, taken from a previous call's nextStart.",
    },
  },
} as const;

export const CONFLUENCE_SEARCH_DESCRIPTION =
  "Search Confluence content with CQL and return compact rows (id, title, space, url, excerpt). Read-only, and bodies are never included: pick a result and read it with confluence_get_page. Prefer the named filters over raw cql, and never invent a space key — resolve it with confluence_lookup kind=spaces first. Results are one page; follow nextStart for the rest. Cite a page with its returned url.";

/** The search's payload, as the local tool prints it. */
export async function runConfluenceSearch(
  config: ConfluenceConfig,
  params: ConfluenceSearchParams,
  { signal }: ConfluenceReadDeps,
) {
  const cql = buildSearchCql(params);
  const limit = clamp(params.maxResults, 15, 1, 100);
  const start = clamp(params.start, 0, 0, 100_000);
  const result = await confluenceGet<{
    results?: Array<{
      content?: {
        id?: string;
        type?: string;
        title?: string;
        status?: string;
      };
      title?: string;
      excerpt?: string;
      url?: string;
      lastModified?: string;
      resultGlobalContainer?: { title?: string; displayUrl?: string };
    }>;
    totalSize?: number;
    _links?: { base?: string };
  }>(
    config,
    "/wiki/rest/api/search",
    { cql, limit, start, excerpt: "highlight" },
    signal ? { signal } : {},
  );
  const rows = (result.results ?? []).map((row) => ({
    id: row.content?.id ?? null,
    type: row.content?.type ?? null,
    title: stripHighlight(row.title) ?? row.content?.title ?? "",
    space: row.resultGlobalContainer?.title ?? null,
    lastModified: row.lastModified ?? null,
    url: confluenceWebUrl(config.host, row.url),
    excerpt: stripHighlight(row.excerpt),
  }));
  const nextStart = rows.length === limit ? start + rows.length : null;
  return {
    confluenceHost: config.host,
    cql,
    start,
    resultCount: rows.length,
    totalSize: result.totalSize ?? null,
    nextStart,
    presentationGuidance:
      "Read a chosen page with confluence_get_page before summarizing it; an excerpt is not the page. Cite pages with the returned url.",
    results: rows,
  };
}

// --------------------------------------------------------------------------
// confluence_get_page
// --------------------------------------------------------------------------

export const CONFLUENCE_GET_PAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    page: {
      type: "string",
      description: "Page id, or any Confluence page URL that contains one.",
    },
    maxChars: {
      type: "number",
      description:
        "Maximum characters of page Markdown returned. Defaults to 12000, maximum 100000; the reply reports whether it truncated.",
    },
    includeComments: {
      type: "boolean",
      description:
        "Include footer comments and their replies. Costs one extra call per comment, so leave it off unless the discussion matters.",
    },
    maxComments: {
      type: "number",
      description:
        "Top-level comments to fetch when includeComments is set. Defaults to 20, maximum 50.",
    },
    includeLabels: {
      type: "boolean",
      description: "Include the page's labels.",
    },
    includeChildren: {
      type: "boolean",
      description: "Include direct child pages (id and title).",
    },
    includeAttachments: {
      type: "boolean",
      description: "Include attachment metadata and download URLs.",
    },
  },
  required: ["page"],
} as const;

export const CONFLUENCE_GET_PAGE_DESCRIPTION =
  "Read one Confluence page as Markdown, with optional comments, labels, children and attachments. Read-only. Macros, layouts and embedded images have no Markdown form: they appear as [macro: name] and [attachment: name] markers, so treat such a page as partially rendered rather than assuming the marker is all there is. lossyNodes lists exactly what a Markdown-built rewrite of this page would destroy. Cite the page with its returned url.";

/** The page's payload, as the local tool prints it. */
export async function runConfluenceGetPage(
  config: ConfluenceConfig,
  params: ConfluenceGetPageParams,
  { signal }: ConfluenceReadDeps,
) {
  const pageId = normalizePageInput(params.page);
  const maxChars = clamp(params.maxChars, 12_000, 1_000, 100_000);
  const signalOptions = signal ? { signal } : {};
  const page = await fetchPageWithBody(config, pageId, signalOptions);
  const space = await resolveSpaceSummary(config, page.spaceId, signal);

  const markdown = page.markdown ?? "";
  const truncated = markdown.length > maxChars;
  const comments =
    params.includeComments === true
      ? await fetchFooterComments(
          config,
          pageId,
          clamp(params.maxComments, 20, 1, 50),
          undefined,
          signal,
        )
      : null;
  const labels =
    params.includeLabels === true
      ? await fetchLabels(config, pageId, LIST_PAGE_LIMIT, undefined, signal)
      : null;
  const children =
    params.includeChildren === true
      ? await fetchChildren(config, pageId, LIST_PAGE_LIMIT, undefined, signal)
      : null;
  const attachments =
    params.includeAttachments === true
      ? await fetchAttachments(
          config,
          pageId,
          LIST_PAGE_LIMIT,
          undefined,
          signal,
        )
      : null;

  return {
    confluenceHost: config.host,
    page: {
      id: page.id,
      title: page.title,
      status: page.status,
      url: page.url,
      spaceKey: space?.key ?? null,
      spaceName: space?.name ?? null,
      parentId: page.parentId,
      version: page.version,
      updatedAt: page.updatedAt,
      bodySource: page.bodySource,
      lossyNodes: page.lossyNodes,
      truncated,
      charCount: truncated ? maxChars : markdown.length,
      markdown: truncated ? `${markdown.slice(0, maxChars)}…` : markdown,
      // Each optional section reports its own continuation cursor: a page
      // with more comments than one listing holds must not read as if the
      // discussion ended there. Every cursor here is continuable through a
      // confluence_lookup kind — comments and replies included.
      ...(comments
        ? { comments: comments.items, moreComments: comments.nextCursor }
        : {}),
      ...(labels
        ? { labels: labels.items, moreLabels: labels.nextCursor }
        : {}),
      ...(children
        ? { children: children.items, moreChildren: children.nextCursor }
        : {}),
      ...(attachments
        ? {
            attachments: attachments.items,
            moreAttachments: attachments.nextCursor,
          }
        : {}),
    },
  };
}

interface FooterComment {
  id: string;
  authorId: string | null;
  version: number | null;
  markdown: string | null;
  replies?: FooterComment[];
  /** Cursor for the rest of this comment's replies, null when the thread is complete. */
  moreReplies?: string | null;
}

function normalizeComment(raw: {
  id?: string;
  version?: { number?: number; authorId?: string };
  body?: { atlas_doc_format?: { value?: string } };
}): FooterComment {
  const value = raw.body?.atlas_doc_format?.value;
  let markdown: string | null = null;
  if (typeof value === "string" && value.trim()) {
    try {
      markdown = adfToMarkdown(JSON.parse(value));
    } catch {
      markdown = null;
    }
  }
  return {
    id: raw.id ?? "",
    authorId: raw.version?.authorId ?? null,
    version:
      typeof raw.version?.number === "number" ? raw.version.number : null,
    markdown,
  };
}

/**
 * One page of a v2 listing. Every read that can have more behind it answers in
 * this shape: a caller must be able to tell a complete list from a first page,
 * and a silently truncated read is the failure mode these endpoints invite.
 */
interface Paged<T> {
  items: T[];
  nextCursor: string | null;
}

/** Read one v2 listing page, returning its rows and the cursor to continue at. */
async function pagedGet<Raw, Item>(
  config: ConfluenceConfig,
  path: string,
  query: AtlassianQuery,
  map: (raw: Raw) => Item,
  signal: AbortSignal | undefined,
): Promise<Paged<Item>> {
  const result = await confluenceGet<{
    results?: Raw[];
    _links?: { next?: string };
  }>(config, path, query, signal ? { signal } : {});
  return {
    items: (result.results ?? []).map(map),
    nextCursor: nextCursorOf(result._links?.next),
  };
}

/**
 * Footer comments with their replies. `/pages/{id}/footer-comments` returns
 * only top-level comments, so each one's children are fetched separately —
 * without that, a discussion reads as if nobody answered. A comment with more
 * replies than one page holds says so rather than looking answered in full.
 */
async function fetchFooterComments(
  config: ConfluenceConfig,
  pageId: string,
  limit: number,
  cursor: string | undefined,
  signal: AbortSignal | undefined,
): Promise<Paged<FooterComment>> {
  const top = await pagedGet<
    Parameters<typeof normalizeComment>[0],
    FooterComment
  >(
    config,
    `/wiki/api/v2/pages/${encodeURIComponent(pageId)}/footer-comments`,
    {
      "body-format": "atlas_doc_format",
      limit,
      ...(cursor ? { cursor } : {}),
    },
    normalizeComment,
    signal,
  );
  for (const comment of top.items) {
    if (!comment.id) continue;
    const children = await fetchCommentReplies(
      config,
      comment.id,
      REPLY_PAGE_LIMIT,
      undefined,
      signal,
    );
    if (children.items.length > 0) comment.replies = children.items;
    // The CURSOR, not a boolean: a thread that ran past one page has to be
    // continuable, or reporting it only tells the reader what they cannot see.
    comment.moreReplies = children.nextCursor;
  }
  return top;
}

/** One page of a comment's replies, continuable with its cursor. */
async function fetchCommentReplies(
  config: ConfluenceConfig,
  commentId: string,
  limit: number,
  cursor: string | undefined,
  signal: AbortSignal | undefined,
): Promise<Paged<FooterComment>> {
  return pagedGet<Parameters<typeof normalizeComment>[0], FooterComment>(
    config,
    `/wiki/api/v2/footer-comments/${encodeURIComponent(commentId)}/children`,
    {
      "body-format": "atlas_doc_format",
      limit,
      ...(cursor ? { cursor } : {}),
    },
    normalizeComment,
    signal,
  );
}

async function fetchLabels(
  config: ConfluenceConfig,
  pageId: string,
  limit: number,
  cursor: string | undefined,
  signal: AbortSignal | undefined,
): Promise<Paged<string>> {
  const page = await pagedGet<{ name?: string }, string>(
    config,
    `/wiki/api/v2/pages/${encodeURIComponent(pageId)}/labels`,
    { limit, ...(cursor ? { cursor } : {}) },
    (label) => label.name ?? "",
    signal,
  );
  return { ...page, items: page.items.filter(Boolean) };
}

async function fetchChildren(
  config: ConfluenceConfig,
  pageId: string,
  limit: number,
  cursor: string | undefined,
  signal: AbortSignal | undefined,
): Promise<Paged<{ id: string; title: string; url: string | null }>> {
  return pagedGet<
    { id?: string; title?: string },
    { id: string; title: string; url: string | null }
  >(
    config,
    `/wiki/api/v2/pages/${encodeURIComponent(pageId)}/children`,
    { limit, ...(cursor ? { cursor } : {}) },
    (child) => ({
      id: child.id ?? "",
      title: child.title ?? "",
      url: child.id ? confluencePageUrl(config.host, child.id) : null,
    }),
    signal,
  );
}

async function fetchAttachments(
  config: ConfluenceConfig,
  pageId: string,
  limit: number,
  cursor: string | undefined,
  signal: AbortSignal | undefined,
): Promise<Paged<ConfluenceAttachmentRow>> {
  return pagedGet<ConfluenceAttachmentResponse, ConfluenceAttachmentRow>(
    config,
    `/wiki/api/v2/pages/${encodeURIComponent(pageId)}/attachments`,
    { limit, ...(cursor ? { cursor } : {}) },
    (attachment) => normalizeAttachment(attachment, config.host),
    signal,
  );
}

// --------------------------------------------------------------------------
// confluence_lookup
// --------------------------------------------------------------------------

export const CONFLUENCE_LOOKUP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: {
      type: "string",
      enum: [
        "spaces",
        "pageTree",
        "labels",
        "attachments",
        "comments",
        "replies",
      ],
      description:
        "spaces = list or filter spaces; pageTree = the direct children of `page`, or EVERY page in `spaceKey` at any depth (not only its roots); labels, attachments and comments = those of `page`; replies = the replies to `commentId`. Use comments and replies with the cursor confluence_get_page returned to read past its first page.",
    },
    spaceKey: {
      type: "string",
      description:
        "Space key. Filters kind=spaces, or lists every page in that space for kind=pageTree.",
    },
    page: {
      type: "string",
      description:
        "Page id or URL. Required for kind=labels, attachments and comments.",
    },
    commentId: {
      type: "string",
      description:
        "Footer comment id, required for kind=replies. It is the id of a comment returned by confluence_get_page or kind=comments.",
    },
    query: {
      type: "string",
      description: "Case-insensitive name filter for kind=spaces.",
    },
    maxResults: {
      type: "number",
      description: "Rows to return. Defaults to 25, maximum 100.",
    },
    cursor: {
      type: "string",
      description: "Opaque cursor from a previous call's nextCursor.",
    },
  },
  required: ["kind"],
} as const;

export const CONFLUENCE_LOOKUP_DESCRIPTION =
  "Discovery and continuation for Confluence: space keys and names, a page's direct children or every page in a space, and a page's labels, attachments, comments or a comment's replies. Read-only and compact. Resolve a space key here before using it in confluence_search or confluence_mutate_page rather than guessing one. Each kind returns one page of results: a non-null nextCursor means more exist, and passing it back as cursor continues the listing. This is also where a confluence_get_page section that reported more (moreComments, moreReplies, moreLabels, moreChildren, moreAttachments) is read to the end.";

/** The lookup's payload (by kind), as the local tool prints it. */
export async function runConfluenceLookup(
  config: ConfluenceConfig,
  params: ConfluenceLookupParams,
  { signal }: ConfluenceReadDeps,
) {
  const limit = clamp(params.maxResults, 25, 1, 100);
  const options = signal ? { signal } : {};
  const cursor = params.cursor?.trim() || undefined;

  if (params.kind === "spaces") {
    const result = await confluenceGet<{
      results?: ConfluenceSpaceResponse[];
      _links?: { next?: string };
    }>(
      config,
      "/wiki/api/v2/spaces",
      {
        limit,
        ...(params.spaceKey?.trim() ? { keys: params.spaceKey.trim() } : {}),
        ...(cursor ? { cursor } : {}),
      },
      options,
    );
    const query = params.query?.trim().toLowerCase();
    const spaces = (result.results ?? [])
      .map((space) => normalizeConfluenceSpace(space, config.host))
      .filter((space) =>
        query
          ? `${space.key} ${space.name}`.toLowerCase().includes(query)
          : true,
      );
    return {
      kind: params.kind,
      confluenceHost: config.host,
      count: spaces.length,
      nextCursor: nextCursorOf(result._links?.next),
      spaces,
    };
  }

  if (params.kind === "pageTree") {
    const spaceKey = params.spaceKey?.trim();
    if (!params.page && !spaceKey)
      throw new ConfluenceReadRefusal(
        "page_tree_scope_missing",
        "kind=pageTree needs either page (children of it) or spaceKey.",
      );
    const path = params.page
      ? `/wiki/api/v2/pages/${encodeURIComponent(normalizePageInput(params.page))}/children`
      : `/wiki/api/v2/spaces/${encodeURIComponent((await resolveSpaceId(config, spaceKey as string, options)).id)}/pages`;
    const result = await confluenceGet<{
      results?: Array<{
        id?: string;
        title?: string;
        status?: string;
        parentId?: string;
      }>;
      _links?: { next?: string };
    }>(config, path, { limit, ...(cursor ? { cursor } : {}) }, options);
    const pages = (result.results ?? []).map((page) => ({
      id: page.id ?? "",
      title: page.title ?? "",
      status: page.status ?? null,
      parentId: page.parentId ?? null,
      url: page.id ? confluencePageUrl(config.host, page.id) : null,
    }));
    return {
      kind: params.kind,
      confluenceHost: config.host,
      count: pages.length,
      nextCursor: nextCursorOf(result._links?.next),
      pages,
    };
  }

  if (params.kind === "replies") {
    const commentId = params.commentId?.trim();
    if (!commentId)
      throw new ConfluenceReadRefusal(
        "replies_comment_missing",
        "kind=replies needs the commentId to read replies of.",
      );
    const replies = await fetchCommentReplies(
      config,
      commentId,
      limit,
      cursor,
      signal,
    );
    return {
      kind: params.kind,
      commentId,
      count: replies.items.length,
      nextCursor: replies.nextCursor,
      replies: replies.items,
    };
  }

  const pageId = normalizePageInput(params.page);
  if (params.kind === "comments") {
    const comments = await fetchFooterComments(
      config,
      pageId,
      limit,
      cursor,
      signal,
    );
    return {
      kind: params.kind,
      pageId,
      count: comments.items.length,
      nextCursor: comments.nextCursor,
      comments: comments.items,
    };
  }
  if (params.kind === "labels") {
    const labels = await fetchLabels(config, pageId, limit, cursor, signal);
    return {
      kind: params.kind,
      pageId,
      count: labels.items.length,
      nextCursor: labels.nextCursor,
      labels: labels.items,
    };
  }
  const attachments = await fetchAttachments(
    config,
    pageId,
    limit,
    cursor,
    signal,
  );
  return {
    kind: params.kind,
    pageId,
    count: attachments.items.length,
    nextCursor: attachments.nextCursor,
    attachments: attachments.items,
  };
}

/** v2 paging hands back a whole relative URL; the cursor is the part we resend. */
function nextCursorOf(next: string | undefined): string | null {
  if (!next) return null;
  const match = next.match(/[?&]cursor=([^&]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}
