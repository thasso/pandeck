/**
 * Confluence agent tools: CQL search, page reads, discovery lookups,
 * attachment downloads, and approval-gated page and attachment writes.
 *
 * The write path deliberately does NOT round-trip a page through Markdown.
 * `markdownToAdf` can only produce the nodes Markdown has, so rebuilding a
 * whole page from its Markdown rendering would delete every macro, layout and
 * embedded image on it. Append and prepend therefore splice new ADF into the
 * page's existing ADF, and `replace` — the only destructive placement — has to
 * be asked for by name and says on the approval card what it would drop.
 */
import type {
  ApprovalCard,
  ConfluenceBodyPlacement,
  ConfluencePageMutationItemDisplay,
  ConfluencePageMutationOperation,
} from "@assistant/shared";
import { defineAgentTool, jsonResult } from "../../mcp/tool.ts";
import { getConfluenceToolConfig } from "../../confluenceSettings.ts";
import {
  approvalCardReference,
  createApproval,
  registerApprovalExecutor,
} from "../../pendingApprovals.ts";
import {
  markdownToAdf,
  type AdfNode,
} from "../../atlassian/adfFromMarkdown.ts";
import { adfToMarkdown } from "../../atlassian/adfToMarkdown.ts";
import type { AtlassianQuery } from "../../atlassian/atlassianFetch.ts";
import {
  adfBodyPayload,
  confluenceDelete,
  confluenceGet,
  confluencePageUrl,
  confluencePost,
  confluencePut,
  confluenceWebUrl,
  fetchPageWithBody,
  normalizeConfluencePage,
  normalizeConfluenceSpace,
  parseAdfBody,
  resolveSpaceId,
  type AdfDocument,
  type ConfluenceApiConfig,
  type ConfluencePageResponse,
  type ConfluenceSpaceResponse,
} from "../../atlassian/confluenceClient.ts";
import { errorText } from "../../errors.ts";
import { stageSessionAttachment } from "../../sessionAttachments.ts";
import {
  MAX_ATTACHMENT_BYTES,
  downloadAttachment,
  executeAttachmentChange,
  fetchAttachment,
  findAttachmentByName,
  normalizeAttachment,
  normalizeAttachmentId,
  stageAttachmentChange,
  type ConfluenceAttachmentResponse,
  type ConfluenceAttachmentRow,
} from "./confluenceAttachments.ts";

type SearchParams = {
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

type GetPageParams = {
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

type LookupParams = {
  kind: LookupKind;
  spaceKey?: string;
  page?: string;
  commentId?: string;
  query?: string;
  maxResults?: number;
  cursor?: string;
};

type MutateItemParams = {
  operation?: ConfluencePageMutationOperation;
  page?: string;
  spaceKey?: string;
  title?: string;
  newTitle?: string;
  parentPage?: string;
  body?: string;
  placement?: ConfluenceBodyPlacement;
  addLabels?: string[];
  removeLabels?: string[];
  versionMessage?: string;
  attachmentId?: string;
  fileName?: string;
  sourceAttachmentId?: string;
  sourcePath?: string;
};

type MutateParams = { items?: MutateItemParams[] };

const MAX_MUTATION_ITEMS = 10;
/** Rows per page for the optional page sections and the lookup listings. */
const LIST_PAGE_LIMIT = 100;
const REPLY_PAGE_LIMIT = 50;
/** How much of the current page travels to the card purely as edit context. */
const CURRENT_BODY_PREVIEW_CHARS = 4000;

// --------------------------------------------------------------------------
// Shared helpers
// --------------------------------------------------------------------------

function clamp(
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
  if (!raw) throw new Error("A Confluence page id or URL is required.");
  if (/^\d+$/.test(raw)) return raw;
  const fromQuery = raw.match(/[?&]pageId=(\d+)/i);
  if (fromQuery?.[1]) return fromQuery[1];
  const fromPath = raw.match(/\/pages\/(?:viewpage\.action\?pageId=)?(\d+)/i);
  if (fromPath?.[1]) return fromPath[1];
  throw new Error(
    `Could not read a page id from "${raw}". Pass the numeric page id or a Confluence page URL.`,
  );
}

function stringList(value: unknown): string[] {
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

async function resolveSpaceSummary(
  config: ConfluenceApiConfig,
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
// confluence_search
// --------------------------------------------------------------------------

/** Build CQL from the convenience filters, or pass the caller's own through. */
export function buildSearchCql(params: SearchParams): string {
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
      throw new Error("updatedSince must be a YYYY-MM-DD date.");
    clauses.push(`lastmodified >= ${cqlString(since)}`);
  }
  if (clauses.length === 1 && !params.text && !params.title && !params.label)
    throw new Error(
      "Give at least one of text, title, label, spaceKeys or updatedSince, or pass a raw cql query.",
    );
  return `${clauses.join(" AND ")} order by lastmodified desc`;
}

const searchParamsSchema = {
  type: "object",
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

export const confluenceSearchTool = defineAgentTool<SearchParams>({
  name: "confluence_search",
  label: "Confluence: Search",
  description:
    "Search Confluence content with CQL and return compact rows (id, title, space, url, excerpt). Read-only, and bodies are never included: pick a result and read it with confluence_get_page. Prefer the named filters over raw cql, and never invent a space key — resolve it with confluence_lookup kind=spaces first. Results are one page; follow nextStart for the rest. Cite a page with its returned url.",
  searchHint:
    "confluence wiki page search cql space documentation runbook notes",
  parameters: searchParamsSchema,
  async execute(params, ctx) {
    const config = getConfluenceToolConfig();
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
      ctx.signal ? { signal: ctx.signal } : {},
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
    return jsonResult({
      confluenceHost: config.host,
      cql,
      start,
      resultCount: rows.length,
      totalSize: result.totalSize ?? null,
      nextStart,
      presentationGuidance:
        "Read a chosen page with confluence_get_page before summarizing it; an excerpt is not the page. Cite pages with the returned url.",
      results: rows,
    });
  },
});

// --------------------------------------------------------------------------
// confluence_get_page
// --------------------------------------------------------------------------

const getPageParamsSchema = {
  type: "object",
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

export const confluenceGetPageTool = defineAgentTool<GetPageParams>({
  name: "confluence_get_page",
  label: "Confluence: Get Page",
  description:
    "Read one Confluence page as Markdown, with optional comments, labels, children and attachments. Read-only. Macros, layouts and embedded images have no Markdown form: they appear as [macro: name] and [attachment: name] markers, so treat such a page as partially rendered rather than assuming the marker is all there is. lossyNodes lists exactly what a Markdown-built rewrite of this page would destroy. Cite the page with its returned url.",
  searchHint:
    "confluence wiki page read body markdown comments labels attachments",
  parameters: getPageParamsSchema,
  async execute(params, ctx) {
    const config = getConfluenceToolConfig();
    const pageId = normalizePageInput(params.page);
    const maxChars = clamp(params.maxChars, 12_000, 1_000, 100_000);
    const signalOptions = ctx.signal ? { signal: ctx.signal } : {};
    const page = await fetchPageWithBody(config, pageId, signalOptions);
    const space = await resolveSpaceSummary(config, page.spaceId, ctx.signal);

    const markdown = page.markdown ?? "";
    const truncated = markdown.length > maxChars;
    const comments =
      params.includeComments === true
        ? await fetchFooterComments(
            config,
            pageId,
            clamp(params.maxComments, 20, 1, 50),
            undefined,
            ctx.signal,
          )
        : null;
    const labels =
      params.includeLabels === true
        ? await fetchLabels(
            config,
            pageId,
            LIST_PAGE_LIMIT,
            undefined,
            ctx.signal,
          )
        : null;
    const children =
      params.includeChildren === true
        ? await fetchChildren(
            config,
            pageId,
            LIST_PAGE_LIMIT,
            undefined,
            ctx.signal,
          )
        : null;
    const attachments =
      params.includeAttachments === true
        ? await fetchAttachments(
            config,
            pageId,
            LIST_PAGE_LIMIT,
            undefined,
            ctx.signal,
          )
        : null;

    return jsonResult({
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
    });
  },
});

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
  config: ConfluenceApiConfig,
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
  config: ConfluenceApiConfig,
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
  config: ConfluenceApiConfig,
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
  config: ConfluenceApiConfig,
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
  config: ConfluenceApiConfig,
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
  config: ConfluenceApiConfig,
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

const lookupParamsSchema = {
  type: "object",
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

export const confluenceLookupTool = defineAgentTool<LookupParams>({
  name: "confluence_lookup",
  label: "Confluence: Lookup",
  description:
    "Discovery and continuation for Confluence: space keys and names, a page's direct children or every page in a space, and a page's labels, attachments, comments or a comment's replies. Read-only and compact. Resolve a space key here before using it in confluence_search or confluence_mutate_page rather than guessing one. Each kind returns one page of results: a non-null nextCursor means more exist, and passing it back as cursor continues the listing. This is also where a confluence_get_page section that reported more (moreComments, moreReplies, moreLabels, moreChildren, moreAttachments) is read to the end.",
  searchHint:
    "confluence spaces space key page tree children labels attachments comments replies discovery paging cursor",
  parameters: lookupParamsSchema,
  async execute(params, ctx) {
    const config = getConfluenceToolConfig();
    const limit = clamp(params.maxResults, 25, 1, 100);
    const options = ctx.signal ? { signal: ctx.signal } : {};
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
      return jsonResult({
        kind: params.kind,
        confluenceHost: config.host,
        count: spaces.length,
        nextCursor: nextCursorOf(result._links?.next),
        spaces,
      });
    }

    if (params.kind === "pageTree") {
      const spaceKey = params.spaceKey?.trim();
      if (!params.page && !spaceKey)
        throw new Error(
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
      return jsonResult({
        kind: params.kind,
        confluenceHost: config.host,
        count: pages.length,
        nextCursor: nextCursorOf(result._links?.next),
        pages,
      });
    }

    if (params.kind === "replies") {
      const commentId = params.commentId?.trim();
      if (!commentId)
        throw new Error("kind=replies needs the commentId to read replies of.");
      const replies = await fetchCommentReplies(
        config,
        commentId,
        limit,
        cursor,
        ctx.signal,
      );
      return jsonResult({
        kind: params.kind,
        commentId,
        count: replies.items.length,
        nextCursor: replies.nextCursor,
        replies: replies.items,
      });
    }

    const pageId = normalizePageInput(params.page);
    if (params.kind === "comments") {
      const comments = await fetchFooterComments(
        config,
        pageId,
        limit,
        cursor,
        ctx.signal,
      );
      return jsonResult({
        kind: params.kind,
        pageId,
        count: comments.items.length,
        nextCursor: comments.nextCursor,
        comments: comments.items,
      });
    }
    if (params.kind === "labels") {
      const labels = await fetchLabels(
        config,
        pageId,
        limit,
        cursor,
        ctx.signal,
      );
      return jsonResult({
        kind: params.kind,
        pageId,
        count: labels.items.length,
        nextCursor: labels.nextCursor,
        labels: labels.items,
      });
    }
    const attachments = await fetchAttachments(
      config,
      pageId,
      limit,
      cursor,
      ctx.signal,
    );
    return jsonResult({
      kind: params.kind,
      pageId,
      count: attachments.items.length,
      nextCursor: attachments.nextCursor,
      attachments: attachments.items,
    });
  },
});

/** v2 paging hands back a whole relative URL; the cursor is the part we resend. */
function nextCursorOf(next: string | undefined): string | null {
  if (!next) return null;
  const match = next.match(/[?&]cursor=([^&]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

// --------------------------------------------------------------------------
// confluence_download_attachment
// --------------------------------------------------------------------------

type DownloadParams = {
  attachmentId?: string;
  page?: string;
  fileName?: string;
  maxBytes?: number;
};

const DEFAULT_DOWNLOAD_BYTES = 50 * 1024 * 1024;

export const confluenceDownloadAttachmentTool = defineAgentTool<DownloadParams>(
  {
    name: "confluence_download_attachment",
    label: "Confluence: Download Attachment",
    description:
      "Download one Confluence page attachment into this session's attachment store. The bytes never enter your context: the result names a session attachment id and its path on this host. Inspect it with read_attachment, convert_pdf or convert_xlsx, copy it into the KB with kb_write (sourceAttachmentId), or change the file and upload it back with confluence_mutate_page operation=uploadAttachment.",
    searchHint:
      "confluence attachment download file image pdf spreadsheet fetch",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        attachmentId: {
          type: "string",
          description:
            "Attachment id from confluence_lookup kind=attachments, e.g. att123456.",
        },
        page: {
          type: "string",
          description: "Page id or URL, with fileName instead of attachmentId.",
        },
        fileName: {
          type: "string",
          description: "Exact attachment file name on page.",
        },
        maxBytes: {
          type: "number",
          description: `Largest file downloaded. Defaults to ${DEFAULT_DOWNLOAD_BYTES} bytes, at most ${MAX_ATTACHMENT_BYTES}.`,
        },
      },
    },
    async execute(params, ctx) {
      const config = getConfluenceToolConfig();
      const raw = await resolveAttachmentInput(config, params, ctx.signal);
      const maxBytes = clamp(
        params.maxBytes,
        DEFAULT_DOWNLOAD_BYTES,
        1,
        MAX_ATTACHMENT_BYTES,
      );
      const downloaded = await downloadAttachment(
        config,
        raw,
        maxBytes,
        ctx.signal,
      );
      const staged = stageSessionAttachment(ctx.session.sessionId, {
        name: raw.title || raw.id || "attachment",
        mimeType: raw.mediaType ?? downloaded.contentType ?? "",
        bytes: downloaded.bytes,
        source: "confluence",
      });
      return jsonResult({
        status: "saved_attachment",
        pageId: raw.pageId ?? null,
        attachment: normalizeAttachment(raw, config.host),
        sessionAttachment: {
          id: staged.id,
          name: staged.name,
          mimeType: staged.mimeType,
          size: staged.size,
          path: staged.path,
        },
      });
    },
  },
);

async function resolveAttachmentInput(
  config: ConfluenceApiConfig,
  params: DownloadParams,
  signal: AbortSignal | undefined,
): Promise<ConfluenceAttachmentResponse> {
  if (params.attachmentId?.trim())
    return fetchAttachment(
      config,
      normalizeAttachmentId(params.attachmentId),
      signal,
    );
  const fileName = params.fileName?.trim();
  if (!fileName)
    throw new Error("Pass an attachmentId, or a page with its fileName.");
  const pageId = normalizePageInput(params.page);
  const found = await findAttachmentByName(config, pageId, fileName, signal);
  if (!found)
    throw new Error(
      `Page ${pageId} has no attachment named "${fileName}". List them with confluence_lookup kind=attachments.`,
    );
  return found;
}

// --------------------------------------------------------------------------
// confluence_mutate_page
// --------------------------------------------------------------------------

const mutateParamsSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      description:
        "Confluence page proposals. Nothing is written until the user approves the card.",
      items: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: [
              "create",
              "edit",
              "comment",
              "delete",
              "uploadAttachment",
              "deleteAttachment",
            ],
            description:
              "Defaults to edit. uploadAttachment adds a file to the page, or a new version when the page already has one with that file name; deleteAttachment moves one to the trash.",
          },
          page: {
            type: "string",
            description:
              "Page id or URL. Required for edit, comment and delete, and for an attachment operation that names no attachmentId.",
          },
          spaceKey: { type: "string", description: "Space key for a create." },
          title: {
            type: "string",
            description: "Title of the page to create.",
          },
          newTitle: {
            type: "string",
            description: "edit: rename the page to this title.",
          },
          parentPage: {
            type: "string",
            description:
              "create: parent page id or URL. Omit to create at the space root.",
          },
          body: {
            type: "string",
            description:
              "CommonMark/GFM content, converted to Atlassian Document Format. The page body for create and edit, the comment text for comment. Images become linked alt text: a body cannot embed an attachment.",
          },
          placement: {
            type: "string",
            enum: ["replace", "append", "prepend"],
            description:
              "edit only, defaults to append. append/prepend splice the new content into the existing page and keep its macros, layouts and images. replace rewrites the whole body from Markdown and DESTROYS every macro, layout and image on the page — ask for it only when the user asked to rewrite the page, and tell them what the proposal reports under lossyNodes.",
          },
          addLabels: {
            type: "array",
            items: { type: "string" },
            description: "Labels to add after the page write.",
          },
          removeLabels: {
            type: "array",
            items: { type: "string" },
            description: "Labels to remove after the page write.",
          },
          versionMessage: {
            type: "string",
            description:
              "edit and uploadAttachment: the version comment Confluence records for this change.",
          },
          attachmentId: {
            type: "string",
            description:
              "Attachment operations: the existing attachment to replace with a new version or to delete, from confluence_lookup kind=attachments.",
          },
          fileName: {
            type: "string",
            description:
              "Attachment operations: the file name on the page. uploadAttachment defaults it to the source's name.",
          },
          sourceAttachmentId: {
            type: "string",
            description:
              "uploadAttachment: session attachment id (list_attachments, confluence_download_attachment) whose bytes to upload.",
          },
          sourcePath: {
            type: "string",
            description:
              "uploadAttachment: absolute path of a file on this host to upload, instead of sourceAttachmentId.",
          },
        },
      },
    },
  },
  required: ["items"],
} as const;

/**
 * @purpose Structured approval proposal/result for Confluence page creates, edits, comments and deletes.
 * @renderWhen The tool always returns a bounded approval payload; agents should use it only after explicit user intent to write to Confluence.
 * @client Render as a mutation-capable approval card showing the Markdown body, the placement, and what a replace would drop.
 */
export const confluenceMutatePageTool = defineAgentTool<MutateParams>({
  name: "confluence_mutate_page",
  label: "Confluence: Prepare Page Changes",
  description:
    "Prepare Confluence proposals — create a page, edit one (append, prepend or replace its body, rename it, relabel it), add a comment, delete a page, or upload, version or delete a page attachment. The file to upload is copied when the proposal is made, so later changes to it are not uploaded. CommonMark/GFM is converted to Atlassian Document Format. This tool never writes immediately: it validates against the live page and persists a pending approval with an approval button. Use it only when the user explicitly asks to write to Confluence, and ask rather than propose when the target page, space or content is ambiguous. Prefer append over replace: replace rebuilds the body from Markdown and destroys the macros, layouts and images the proposal lists under lossyNodes.",
  searchHint:
    "confluence create page edit page write comment delete label wiki upload attachment file",
  parameters: mutateParamsSchema,
  async execute(params, ctx) {
    const config = getConfluenceToolConfig();
    const { items, warnings } = await buildMutationItems(
      config,
      ctx.session.sessionId,
      params.items ?? [],
      ctx.signal,
    );
    const title = mutationTitle(items);
    const summary = [
      items.map(itemLabel).join(", "),
      warnings.length ? `${warnings.length} warning(s)` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const card = createApproval({
      sessionId: ctx.session.sessionId,
      kind: "confluencePage",
      title,
      ...(summary ? { summary } : {}),
      sourceToolCallId: ctx.toolCallId,
      body: { kind: "confluencePage", confluenceHost: config.host, items },
    });
    const warnLine = warnings.length
      ? ` Warnings: ${warnings.join("; ")}.`
      : "";
    const text = `Prepared a Confluence proposal for ${items.length} page(s) pending your approval.${warnLine} Do not claim Confluence changed until the approved result appears. ${approvalCardReference(card)}`;
    return { content: [{ type: "text", text }], terminate: true };
  },
});

function itemLabel(item: ConfluencePageMutationItemDisplay): string {
  const fileName = item.attachment?.fileName ?? "?";
  if (item.operation === "uploadAttachment")
    return `upload ${fileName} to ${item.title ?? item.pageId}`;
  if (item.operation === "deleteAttachment")
    return `delete ${fileName} from ${item.title ?? item.pageId}`;
  if (item.operation === "create")
    return `create ${item.spaceKey ?? "?"}/${item.title ?? "?"}`;
  if (item.operation === "comment")
    return `comment ${item.title ?? item.pageId}`;
  if (item.operation === "delete") return `delete ${item.title ?? item.pageId}`;
  return `${item.placement ?? "append"} ${item.title ?? item.pageId}`;
}

function mutationTitle(items: ConfluencePageMutationItemDisplay[]): string {
  if (items.length === 1) {
    const item = items[0] as ConfluencePageMutationItemDisplay;
    if (item.operation === "create")
      return `Create page ${item.title ?? ""}`.trim();
    if (item.operation === "comment")
      return `Comment on ${item.title ?? "page"}`;
    if (item.operation === "delete") return `Delete ${item.title ?? "page"}`;
    if (item.operation === "uploadAttachment")
      return `Upload ${item.attachment?.fileName ?? "attachment"}`;
    if (item.operation === "deleteAttachment")
      return `Delete attachment ${item.attachment?.fileName ?? ""}`.trim();
    return `Edit ${item.title ?? "page"}`;
  }
  const kinds = new Set(items.map((item) => item.operation));
  if (kinds.size === 1) {
    const only = [...kinds][0];
    if (only === "create") return `Create ${items.length} Confluence pages`;
    if (only === "comment")
      return `Comment on ${items.length} Confluence pages`;
    if (only === "delete") return `Delete ${items.length} Confluence pages`;
    if (only === "uploadAttachment")
      return `Upload ${items.length} Confluence attachments`;
    if (only === "deleteAttachment")
      return `Delete ${items.length} Confluence attachments`;
  }
  return `${items.length} Confluence changes`;
}

/**
 * Validate every item against the live site before anything is staged: a
 * missing space, an unreadable page or a placement the page cannot support
 * becomes a tool error now, rather than an approval that can only fail.
 */
async function buildMutationItems(
  config: ConfluenceApiConfig,
  sessionId: string,
  requested: MutateItemParams[],
  signal: AbortSignal | undefined,
): Promise<{ items: ConfluencePageMutationItemDisplay[]; warnings: string[] }> {
  if (requested.length === 0)
    throw new Error("At least one Confluence mutation item is required.");
  if (requested.length > MAX_MUTATION_ITEMS)
    throw new Error(
      `At most ${MAX_MUTATION_ITEMS} Confluence mutation items are supported per approval.`,
    );
  const items: ConfluencePageMutationItemDisplay[] = [];
  const warnings: string[] = [];
  for (const [index, raw] of requested.entries()) {
    const operation = raw.operation ?? "edit";
    const clientId = `cfl_${index}`;
    const addLabels = stringList(raw.addLabels);
    const removeLabels = stringList(raw.removeLabels);
    const labels = {
      ...(addLabels.length ? { labelsAdded: addLabels } : {}),
      ...(removeLabels.length ? { labelsRemoved: removeLabels } : {}),
    };

    if (operation === "create") {
      const spaceKey = raw.spaceKey?.trim();
      if (!spaceKey) throw new Error("create needs a spaceKey.");
      if (!raw.title?.trim()) throw new Error("create needs a title.");
      if (!raw.body?.trim()) throw new Error("create needs a body.");
      const space = await resolveSpaceId(
        config,
        spaceKey,
        signal ? { signal } : {},
      );
      let parentId: string | null = null;
      let parentTitle: string | null = null;
      if (raw.parentPage?.trim()) {
        const parent = await confluenceGet<ConfluencePageResponse>(
          config,
          `/wiki/api/v2/pages/${encodeURIComponent(normalizePageInput(raw.parentPage))}`,
          undefined,
          signal ? { signal } : {},
        );
        parentId = parent.id ?? null;
        parentTitle = parent.title ?? null;
      }
      items.push({
        clientId,
        operation,
        title: raw.title.trim(),
        spaceKey: space.key,
        spaceName: space.name,
        parentId,
        parentTitle,
        body: raw.body,
        ...labels,
      });
      continue;
    }

    if (operation === "uploadAttachment" || operation === "deleteAttachment") {
      if (addLabels.length || removeLabels.length)
        throw new Error(
          `${operation} does not change labels; propose them as a separate edit.`,
        );
      const staged = await stageAttachmentChange(
        config,
        sessionId,
        operation,
        {
          ...(raw.page?.trim() ? { pageId: normalizePageInput(raw.page) } : {}),
          ...(raw.attachmentId ? { attachmentId: raw.attachmentId } : {}),
          ...(raw.fileName ? { fileName: raw.fileName } : {}),
          ...(raw.sourceAttachmentId
            ? { sourceAttachmentId: raw.sourceAttachmentId }
            : {}),
          ...(raw.sourcePath ? { sourcePath: raw.sourcePath } : {}),
        },
        signal,
      );
      const page = normalizeConfluencePage(staged.page, config.host);
      const space = await resolveSpaceSummary(config, page.spaceId, signal);
      items.push({
        clientId,
        operation,
        pageId: page.id,
        pageUrl: page.url,
        title: page.title,
        spaceKey: space?.key ?? null,
        spaceName: space?.name ?? null,
        attachment: staged.attachment,
        ...(operation === "uploadAttachment" && raw.versionMessage?.trim()
          ? { versionMessage: raw.versionMessage.trim() }
          : {}),
      });
      if (staged.warning) warnings.push(staged.warning);
      continue;
    }

    const pageId = normalizePageInput(raw.page);
    const page = await fetchPageWithBody(
      config,
      pageId,
      signal ? { signal } : {},
    );
    const space = await resolveSpaceSummary(config, page.spaceId, signal);
    // A proposal against an existing page is only safe because it can be
    // compared to the version it was built from. Without one there is nothing
    // to compare at execution, so refuse here rather than stage a write that
    // would silently overwrite whatever the page became.
    if (operation !== "comment" && page.version === null)
      throw new Error(
        `Confluence reported no version for page ${pageId}, so a ${operation} cannot be proposed safely. Re-read the page with confluence_get_page and try again.`,
      );
    const base: ConfluencePageMutationItemDisplay = {
      clientId,
      operation,
      pageId: page.id,
      pageUrl: page.url,
      title: page.title,
      spaceKey: space?.key ?? null,
      spaceName: space?.name ?? null,
      ...(page.version !== null ? { baseVersion: page.version } : {}),
      ...labels,
    };

    if (operation === "comment") {
      if (!raw.body?.trim()) throw new Error("comment needs a body.");
      items.push({ ...base, body: raw.body });
      continue;
    }
    if (operation === "delete") {
      items.push(base);
      warnings.push(
        `${page.title || pageId} would be moved to the trash, along with its comments`,
      );
      continue;
    }

    const placement = raw.placement ?? "append";
    const hasBody = Boolean(raw.body?.trim());
    if (
      !hasBody &&
      !raw.newTitle?.trim() &&
      addLabels.length === 0 &&
      removeLabels.length === 0
    )
      throw new Error(
        "edit needs a body, a newTitle, or a label change; nothing was requested.",
      );
    if (
      hasBody &&
      placement !== "replace" &&
      page.bodySource !== "atlas_doc_format"
    )
      throw new Error(
        `${page.title || pageId} stores its body in the legacy storage format, which cannot be spliced. Re-read it with confluence_get_page and propose placement="replace" with the full intended body, after confirming the rewrite with the user.`,
      );
    if (hasBody && placement === "replace" && page.lossyNodes.length > 0)
      warnings.push(
        `replacing ${page.title || pageId} drops its ${page.lossyNodes.join(", ")} node(s)`,
      );
    items.push({
      ...base,
      ...(raw.newTitle?.trim() ? { newTitle: raw.newTitle.trim() } : {}),
      ...(hasBody ? { body: raw.body, placement } : {}),
      ...(page.markdown
        ? {
            currentBody:
              page.markdown.length > CURRENT_BODY_PREVIEW_CHARS
                ? `${page.markdown.slice(0, CURRENT_BODY_PREVIEW_CHARS)}…`
                : page.markdown,
          }
        : {}),
      ...(page.lossyNodes.length ? { lossyNodes: page.lossyNodes } : {}),
      ...(raw.versionMessage?.trim()
        ? { versionMessage: raw.versionMessage.trim() }
        : {}),
    });
  }
  return { items, warnings };
}

/** Execute an approved Confluence proposal: apply each item, recording per-item results. */
registerApprovalExecutor("confluencePage", {
  async execute(card: ApprovalCard) {
    if (card.body.kind !== "confluencePage")
      throw new Error("Mismatched approval body for confluencePage.");
    const items = card.body.items;
    const config = getConfluenceToolConfig();
    let succeeded = 0;
    for (const item of items) {
      try {
        await executeMutationItem(config, card.sessionId, item);
        delete item.error;
        succeeded += 1;
      } catch (err) {
        item.error = errorText(err);
      }
    }
    if (succeeded === 0)
      throw new Error(
        `All ${items.length} Confluence change(s) failed: ${items
          .map((item) => item.error)
          .filter(Boolean)
          .join("; ")}`,
      );
    const failed = items.length - succeeded;
    const warned = items.filter((item) => item.warning).length;
    const diagnostics = [
      failed ? `${failed} failed` : "",
      warned ? `${warned} warning(s)` : "",
    ].filter(Boolean);
    const base = `Applied ${succeeded} Confluence change(s)`;
    const resultUrl = items.find((item) => item.resultPageUrl)?.resultPageUrl;
    return {
      resultSummary: diagnostics.length
        ? `${base}; ${diagnostics.join("; ")}`
        : base,
      ...(resultUrl ? { resultUrl } : {}),
    };
  },
});

async function executeMutationItem(
  config: ConfluenceApiConfig,
  sessionId: string,
  item: ConfluencePageMutationItemDisplay,
): Promise<void> {
  if (
    item.operation === "uploadAttachment" ||
    item.operation === "deleteAttachment"
  )
    return executeAttachmentChange(config, sessionId, item);
  if (item.operation === "create") return executeCreate(config, item);
  if (item.operation === "comment") return executeComment(config, item);
  if (item.operation === "delete") return executeDelete(config, item);
  return executeEdit(config, item);
}

async function executeCreate(
  config: ConfluenceApiConfig,
  item: ConfluencePageMutationItemDisplay,
): Promise<void> {
  const space = await resolveSpaceId(config, item.spaceKey ?? "");
  const created = await confluencePost<ConfluencePageResponse>(
    config,
    "/wiki/api/v2/pages",
    {
      spaceId: space.id,
      status: "current",
      title: item.title ?? "",
      ...(item.parentId ? { parentId: item.parentId } : {}),
      body: adfBodyPayload(markdownToAdf(item.body ?? "")),
    },
  );
  const page = normalizeConfluencePage(created, config.host);
  item.resultPageId = page.id;
  item.resultPageUrl = page.url;
  item.resultVersion = page.version;
  await applyLabels(config, page.id, item);
}

async function executeComment(
  config: ConfluenceApiConfig,
  item: ConfluencePageMutationItemDisplay,
): Promise<void> {
  const created = await confluencePost<{
    id?: string;
    _links?: { webui?: string };
  }>(config, "/wiki/api/v2/footer-comments", {
    pageId: item.pageId,
    body: adfBodyPayload(markdownToAdf(item.body ?? "")),
  });
  item.resultPageId = item.pageId ?? null;
  item.resultPageUrl =
    confluenceWebUrl(config.host, created._links?.webui) ??
    item.pageUrl ??
    null;
}

/**
 * Re-read the page an approval targets and prove it is still the page that was
 * proposed. An approval can sit for minutes, so this runs for every write to
 * an existing page — including a delete, where there is no version precondition
 * to fall back on and nothing to undo afterwards.
 *
 * A missing `baseVersion` is a refusal, not a skipped check: an unverifiable
 * write to somebody's wiki page is exactly what the approval was meant to
 * prevent.
 */
async function readVerifiedPage(
  config: ConfluenceApiConfig,
  item: ConfluencePageMutationItemDisplay,
): Promise<{ page: ConfluencePageResponse; version: number }> {
  if (typeof item.baseVersion !== "number")
    throw new Error(
      `This proposal for page ${item.pageId} recorded no base version, so it cannot be applied safely. Re-read the page and propose the change again.`,
    );
  const page = await confluenceGet<ConfluencePageResponse>(
    config,
    `/wiki/api/v2/pages/${encodeURIComponent(item.pageId ?? "")}`,
    { "body-format": "atlas_doc_format" },
  );
  const version = page.version?.number;
  if (typeof version !== "number")
    throw new Error(
      `Confluence did not report a version for page ${item.pageId}.`,
    );
  if (version !== item.baseVersion)
    throw new Error(
      `Page ${item.pageId} changed since this proposal was prepared (version ${item.baseVersion} → ${version}). Re-read it and propose the change again.`,
    );
  return { page, version };
}

/**
 * Delete an approved page. The version is verified first; Confluence's v2
 * DELETE takes no version precondition, so an edit landing between that check
 * and this call is a race the API cannot close — the check narrows the window
 * from the whole approval wait to a single round trip.
 */
async function executeDelete(
  config: ConfluenceApiConfig,
  item: ConfluencePageMutationItemDisplay,
): Promise<void> {
  await readVerifiedPage(config, item);
  await confluenceDelete(
    config,
    `/wiki/api/v2/pages/${encodeURIComponent(item.pageId ?? "")}`,
  );
  item.resultPageId = item.pageId ?? null;
  item.resultPageUrl = null;
}

/**
 * Apply an approved edit. Writing over a version that changed in between would
 * silently discard whoever edited the page meanwhile, and Confluence's own
 * version check would not catch it either, since we would be sending the newer
 * number.
 */
async function executeEdit(
  config: ConfluenceApiConfig,
  item: ConfluencePageMutationItemDisplay,
): Promise<void> {
  const { page: current, version } = await readVerifiedPage(config, item);
  const title = item.newTitle?.trim() || current.title || "";
  if (item.body?.trim()) {
    const addition = markdownToAdf(item.body);
    let body = addition;
    if (item.placement !== "replace") {
      // Re-checked here and not only at staging: splicing into a body that
      // came back unreadable would write the addition ALONE, which is a
      // silent full-page wipe rather than the append that was approved.
      const currentAdf = parseAdfBody(current);
      if (!currentAdf)
        throw new Error(
          `Confluence returned no readable body for page ${item.pageId}, so the approved ${item.placement ?? "append"} cannot be spliced without losing the page. Re-read it and propose the change again.`,
        );
      body = spliceAdf(currentAdf, addition, item.placement ?? "append");
    }
    await confluencePut(
      config,
      `/wiki/api/v2/pages/${encodeURIComponent(item.pageId ?? "")}`,
      {
        id: item.pageId,
        status: "current",
        title,
        body: adfBodyPayload(body),
        version: {
          number: version + 1,
          ...(item.versionMessage ? { message: item.versionMessage } : {}),
        },
      },
    );
  } else if (item.newTitle?.trim()) {
    await confluencePut(
      config,
      `/wiki/api/v2/pages/${encodeURIComponent(item.pageId ?? "")}/title`,
      {
        id: item.pageId,
        status: "current",
        title,
      },
    );
  }
  item.resultPageId = item.pageId ?? null;
  item.resultPageUrl = item.pageUrl ?? null;
  item.resultVersion = item.body?.trim() ? version + 1 : version;
  await applyLabels(config, item.pageId ?? "", item);
}

/**
 * Splice new content into the page's existing ADF rather than rebuilding the
 * page from Markdown. This is what keeps an append from deleting the macros
 * and layouts Markdown cannot express.
 */
export function spliceAdf(
  current: AdfDocument,
  addition: AdfNode,
  placement: ConfluenceBodyPlacement,
): AdfNode {
  // `current` is an AdfDocument, not a nullable node: a splice target that
  // defaulted its blocks to [] would turn an append into a full-page wipe, so
  // the type makes the caller resolve that BEFORE reaching here.
  const existing = current.content;
  const added = addition.content ?? [];
  return {
    version: 1,
    type: "doc",
    content:
      placement === "prepend"
        ? [...added, ...existing]
        : [...existing, ...added],
  };
}

/**
 * Labels are a v1-only write and are secondary to the page itself: a failed
 * label must not turn a successful page write into a failed item, so it lands
 * as a warning on the card.
 */
async function applyLabels(
  config: ConfluenceApiConfig,
  pageId: string,
  item: ConfluencePageMutationItemDisplay,
): Promise<void> {
  if (!pageId) return;
  const failures: string[] = [];
  for (const name of item.labelsAdded ?? []) {
    try {
      await confluencePost(
        config,
        `/wiki/rest/api/content/${encodeURIComponent(pageId)}/label`,
        [{ prefix: "global", name }],
      );
    } catch (err) {
      failures.push(`add ${name}: ${errorText(err)}`);
    }
  }
  for (const name of item.labelsRemoved ?? []) {
    try {
      await confluenceDelete(
        config,
        `/wiki/rest/api/content/${encodeURIComponent(pageId)}/label/${encodeURIComponent(name)}`,
      );
    } catch (err) {
      failures.push(`remove ${name}: ${errorText(err)}`);
    }
  }
  if (failures.length > 0)
    item.warning = `label changes failed: ${failures.join("; ")}`;
}

export const assistantConfluenceTools = [
  confluenceSearchTool,
  confluenceGetPageTool,
  confluenceLookupTool,
  confluenceDownloadAttachmentTool,
  confluenceMutatePageTool,
];
