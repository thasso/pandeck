/**
 * A stubbed global `fetch` acting as a Confluence site for the edge's
 * `confluence_mutate_page` (Task-1463 P5b): it records every request with its
 * body and signal as the request starts, and answers page, space, attachment,
 * create, comment, label, update and delete requests the way the shared
 * core's transport tests do, unless a test answers otherwise. An OAuth path is
 * matched without its `/ex/confluence/<cloudId>` prefix. Every value is fake.
 */
import { vi } from "vitest";

export interface SeenConfluenceWrite {
  url: URL;
  method: string;
  /** The Confluence path, without an OAuth `/ex/confluence/<cloudId>` prefix. */
  path: string;
  query: Record<string, string>;
  /** The JSON body, or `null` when the request sent none. */
  body: unknown;
  signal: AbortSignal | undefined;
}

export type ConfluenceWriteResponder = (
  seen: SeenConfluenceWrite,
) => Response | Promise<Response | undefined> | undefined;

/** How the fake site answers by default. */
export interface FakeConfluenceOptions {
  /** A page's `status`; `null` omits the field. Default `"current"`. */
  pageStatus?: string | null;
  /** An attachment's `status`; `null` omits the field. Default `"current"`. */
  attachmentStatus?: string | null;
  /** The id a create answers. Default `"456"`. */
  createdId?: unknown;
  /** The `_links.webui` a create answers. Default `/spaces/ENG/pages/<id>/New+page`. */
  createdWebui?: string;
  /** The version a create answers. Default 1. */
  createdVersion?: unknown;
  /** A read page's title. Default `Page <id>`. */
  pageTitle?: string;
  /** A read page's `_links.webui`. Default `/spaces/ENG/pages/<id>`. */
  pageWebui?: (id: string) => string;
}

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

export const PAGE_ADF = JSON.stringify({
  type: "doc",
  version: 1,
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Body" }] },
    { type: "extension", attrs: { extensionKey: "toc" } },
  ],
});

const withStatus = (status: string | null | undefined) =>
  status === null ? {} : { status: status ?? "current" };

/** The attachment `att1`, `diagram.png`, on page 123. */
export function attachmentRow(
  options: FakeConfluenceOptions = {},
): Record<string, unknown> {
  return {
    id: "att1",
    title: "diagram.png",
    pageId: "123",
    ...withStatus(options.attachmentStatus),
    mediaType: "image/png",
    fileSize: 4,
    version: { number: 2 },
  };
}

/** The fake site's answer to `request`. */
export function fakeConfluenceAnswer(
  request: SeenConfluenceWrite,
  options: FakeConfluenceOptions = {},
): Response {
  const { method, path, url } = request;
  const pageMatch = /^\/wiki\/api\/v2\/pages\/(\d+)$/.exec(path);
  if (method === "GET" && pageMatch) {
    const id = pageMatch[1]!;
    return json({
      id,
      title: options.pageTitle ?? `Page ${id}`,
      ...withStatus(options.pageStatus),
      spaceId: "900",
      version: { number: 7 },
      body: { atlas_doc_format: { value: PAGE_ADF } },
      _links: {
        webui: options.pageWebui?.(id) ?? `/spaces/ENG/pages/${id}`,
      },
    });
  }
  if (method === "GET" && /^\/wiki\/api\/v2\/spaces\/\d+$/.test(path))
    return json({ id: "900", key: "ENG", name: "Engineering" });
  if (method === "GET" && path === "/wiki/api/v2/spaces")
    return json({ results: [{ id: "900", key: "ENG", name: "Engineering" }] });
  if (
    method === "GET" &&
    /^\/wiki\/api\/v2\/pages\/\d+\/attachments$/.test(path)
  )
    return json({
      results:
        url.searchParams.get("filename") === "diagram.png"
          ? [attachmentRow(options)]
          : [],
    });
  if (method === "GET" && path === "/wiki/api/v2/attachments/att1")
    return json(attachmentRow(options));
  if (method === "POST" && path === "/wiki/api/v2/pages") {
    const id = options.createdId ?? "456";
    return json({
      id,
      title: "New page",
      version: { number: options.createdVersion ?? 1 },
      _links: {
        webui:
          options.createdWebui ?? `/spaces/ENG/pages/${String(id)}/New+page`,
      },
    });
  }
  if (method === "POST" && path === "/wiki/api/v2/footer-comments")
    return json({ id: "c1", _links: { webui: "/spaces/ENG/pages/123?c1" } });
  if (method === "DELETE") return new Response(null, { status: 204 });
  if (method === "PUT" || (method === "POST" && /\/label$/.test(path)))
    return json({});
  return json({ message: `unexpected ${method} ${path}` }, 404);
}

/** Whether a request changes the site. */
export const isWrite = (request: SeenConfluenceWrite): boolean =>
  request.method !== "GET";

/**
 * Stubs `fetch`; `answer` goes first, the fake site answers what it leaves
 * undefined.
 */
export function stubConfluenceWriteFetch(
  answer?: ConfluenceWriteResponder,
  options: FakeConfluenceOptions = {},
): SeenConfluenceWrite[] {
  const seen: SeenConfluenceWrite[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      const request: SeenConfluenceWrite = {
        url,
        method: init?.method ?? "GET",
        path: url.pathname.replace(/^\/ex\/confluence\/[^/]+/, ""),
        query: Object.fromEntries(url.searchParams),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        signal: init?.signal ?? undefined,
      };
      seen.push(request);
      return (
        (await answer?.(request)) ?? fakeConfluenceAnswer(request, options)
      );
    }),
  );
  return seen;
}
