/**
 * Public-web tools available to every persona over the session MCP server:
 *   - `web_search`  — ranked results from the Brave Search API (needs a key).
 *   - `web_fetch`   — fetch one URL and return readable Markdown/text.
 *
 * `web_fetch` is deliberately in-house (no third-party reader): it guards
 * against SSRF (only http/https, and never a private/loopback/link-local/CGNAT
 * address — the last blocks private tailnet services), caps bytes and
 * time, follows redirects with per-hop revalidation, and extracts article text
 * with Mozilla Readability + Turndown. JSDOM runs no scripts and loads no
 * subresources, so parsing an untrusted page performs no further network I/O.
 */
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

import { getBraveToolConfig } from "../../braveSettings.ts";
import { assertPublicHost } from "../../publicNetwork.ts";
import {
  defineAgentTool,
  jsonResult,
  type ToolResult,
} from "../../mcp/tool.ts";

const USER_AGENT = "personal-assistant/1.0 (+web tools)";

// ---------------------------------------------------------------------------
// web_search
// ---------------------------------------------------------------------------

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const SEARCH_DEFAULT_COUNT = 5;
const SEARCH_MAX_COUNT = 10;

type WebSearchParams = {
  query: string;
  count?: number;
};

const webSearchParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: {
      type: "string",
      description: "The search query.",
    },
    count: {
      type: "integer",
      minimum: 1,
      maximum: SEARCH_MAX_COUNT,
      description: `Number of results to return (default ${SEARCH_DEFAULT_COUNT}, max ${SEARCH_MAX_COUNT}).`,
    },
  },
} as const;

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
  page_age?: string;
  profile?: { name?: string };
}

export const webSearchTool = defineAgentTool<WebSearchParams>({
  name: "web_search",
  label: "Web Search",
  description:
    "Search the public web via Brave Search for current events, external facts, or anything outside the Knowledge Base and the connected integrations. Returns a ranked list of results (title, URL, snippet); issue several focused searches rather than one broad one. Read-only. Use web_fetch to read a result's full page.",
  executionMode: "parallel",
  parameters: webSearchParamsSchema,
  async execute(params, ctx): Promise<ToolResult> {
    const query = params.query?.trim();
    if (!query) throw new Error("web_search requires a non-empty query.");
    const { apiKey } = getBraveToolConfig();
    const count = clampInt(
      params.count,
      SEARCH_DEFAULT_COUNT,
      1,
      SEARCH_MAX_COUNT,
    );

    const url = new URL(BRAVE_ENDPOINT);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));

    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
        "User-Agent": USER_AGENT,
      },
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 500);
      throw new Error(
        `Brave Search request failed (${res.status} ${res.statusText}). ${body}`.trim(),
      );
    }
    const data = (await res.json()) as { web?: { results?: BraveResult[] } };
    const results = (data.web?.results ?? []).slice(0, count).map((r) => ({
      title: stripTags(r.title),
      url: r.url ?? "",
      description: stripTags(r.description),
      age: r.age || r.page_age || undefined,
      source: r.profile?.name || undefined,
    }));

    const payload = { query, count: results.length, results };
    return jsonResult(payload);
  },
});

// ---------------------------------------------------------------------------
// web_fetch
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 20_000;
const FETCH_MAX_BYTES = 5 * 1024 * 1024;
const FETCH_MAX_REDIRECTS = 5;
const FETCH_DEFAULT_MAX_CHARS = 20_000;
const FETCH_HARD_MAX_CHARS = 100_000;

type WebFetchParams = {
  url: string;
  maxChars?: number;
};

const webFetchParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["url"],
  properties: {
    url: {
      type: "string",
      description: "Absolute http(s) URL to fetch.",
    },
    maxChars: {
      type: "integer",
      minimum: 1,
      maximum: FETCH_HARD_MAX_CHARS,
      description: `Maximum characters of extracted content to return (default ${FETCH_DEFAULT_MAX_CHARS}, hard max ${FETCH_HARD_MAX_CHARS}). Content beyond the limit is truncated.`,
    },
  },
} as const;

export const webFetchTool = defineAgentTool<WebFetchParams>({
  name: "web_fetch",
  label: "Web Fetch",
  description:
    "Fetch a single public http(s) URL and return its main content as Markdown (HTML pages) or raw text. Read-only. Private/loopback/tailnet addresses are refused.",
  executionMode: "parallel",
  parameters: webFetchParamsSchema,
  async execute(params, ctx): Promise<ToolResult> {
    const requestedUrl = params.url?.trim();
    if (!requestedUrl) throw new Error("web_fetch requires a url.");
    let target: URL;
    try {
      target = new URL(requestedUrl);
    } catch {
      throw new Error(`web_fetch received an invalid URL: ${requestedUrl}`);
    }
    const maxChars = clampInt(
      params.maxChars,
      FETCH_DEFAULT_MAX_CHARS,
      1,
      FETCH_HARD_MAX_CHARS,
    );

    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const signal = ctx.signal
      ? AbortSignal.any([ctx.signal, timeout])
      : timeout;

    const { response, finalUrl } = await fetchFollowingRedirects(
      target,
      signal,
    );
    const contentType = (
      response.headers.get("content-type") ?? ""
    ).toLowerCase();
    const declaredLength = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > FETCH_MAX_BYTES) {
      throw new Error(
        `web_fetch: response is too large (${declaredLength} bytes > ${FETCH_MAX_BYTES}).`,
      );
    }
    const bytes = await readBodyCapped(response, FETCH_MAX_BYTES);
    const rawText = new TextDecoder("utf-8").decode(bytes);

    let title: string | undefined;
    let content: string;
    if (isHtml(contentType) || (!contentType && looksLikeHtml(rawText))) {
      const extracted = await htmlToMarkdown(rawText, finalUrl.toString());
      title = extracted.title;
      content = extracted.markdown;
    } else if (isTextLike(contentType)) {
      content = rawText;
    } else {
      throw new Error(
        `web_fetch: unsupported content type "${contentType || "unknown"}" at ${finalUrl}. Only HTML and text-like responses are readable.`,
      );
    }

    content = content.trim();
    const truncated = content.length > maxChars;
    if (truncated) content = content.slice(0, maxChars);

    const payload = {
      url: finalUrl.toString(),
      requestedUrl:
        finalUrl.toString() === requestedUrl ? undefined : requestedUrl,
      contentType: contentType || undefined,
      status: response.status,
      title,
      truncated,
      chars: content.length,
      content,
    };
    return jsonResult(payload);
  },
});

export const webTools = [webSearchTool, webFetchTool];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function clampInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function stripTags(value: string | undefined): string {
  return (value ?? "").replace(/<[^>]*>/g, "").trim();
}

function isHtml(contentType: string): boolean {
  return (
    contentType.includes("text/html") ||
    contentType.includes("application/xhtml")
  );
}

function looksLikeHtml(text: string): boolean {
  return /<html[\s>]|<!doctype html/i.test(text.slice(0, 2000));
}

function isTextLike(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType.includes("application/json") ||
    contentType.includes("+json") ||
    contentType.includes("application/xml") ||
    contentType.includes("+xml") ||
    contentType.includes("application/javascript")
  );
}

async function htmlToMarkdown(
  html: string,
  url: string,
): Promise<{ title?: string; markdown: string }> {
  // Loaded on first use: jsdom costs ~0.5s to import, and everything that
  // reaches the tool catalog would otherwise pay it at startup.
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  try {
    const article = new Readability(doc).parse();
    if (article?.content) {
      const titleValue = article.title || doc.title || undefined;
      return {
        ...(titleValue !== undefined ? { title: titleValue } : {}),
        markdown: turndown.turndown(article.content),
      };
    }
  } catch {
    // Readability can throw on malformed documents; fall back to the body below.
  }
  const bodyHtml = doc.body?.innerHTML ?? html;
  return {
    ...(doc.title ? { title: doc.title } : {}),
    markdown: turndown.turndown(bodyHtml),
  };
}

/** Follow redirects manually so every hop's host is revalidated against SSRF rules. */
async function fetchFollowingRedirects(
  start: URL,
  signal: AbortSignal,
): Promise<{ response: Response; finalUrl: URL }> {
  let current = start;
  for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new Error(
        `web_fetch only supports http/https URLs (got ${current.protocol}).`,
      );
    }
    await assertPublicHost(current.hostname, "web_fetch");
    const response = await fetch(current, {
      redirect: "manual",
      signal,
      headers: {
        Accept:
          "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate",
        "User-Agent": USER_AGENT,
      },
    });
    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.has("location")
    ) {
      const location = response.headers.get("location")!;
      await response.body?.cancel().catch(() => {});
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(
        `web_fetch failed: ${response.status} ${response.statusText} for ${current}.`,
      );
    }
    return { response, finalUrl: current };
  }
  throw new Error(`web_fetch: too many redirects (> ${FETCH_MAX_REDIRECTS}).`);
}

async function readBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(
        `web_fetch: response exceeds the ${maxBytes} byte limit.`,
      );
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
